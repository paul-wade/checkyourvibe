import type { Command, CommandContext } from './types.js';
import type { RunMode } from '../run/modes.js';
import { runCheck } from '../run/check.js';
import { DEFAULT_MAX_PER_RULE, renderText, renderTextPlain } from '../report/text.js';
import type { ReportStyle } from '../report/text.js';
import { renderJson } from '../report/json.js';
import { renderSarif } from '../report/sarif.js';
import { exitCodeFor } from '../report/exit.js';
import { configNotice } from '../report/config-notice.js';
import type { RunReport } from '../report/types.js';
import picomatch from 'picomatch';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import {
  partitionViolations,
  readBaseline,
  loadSuppressions,
  validateSuppressionRules,
  evaluateSuppressions,
  suppressionNotice,
  toRepoRelative,
  computeEntries,
} from '../baseline/index.js';
import { CONFIG_FILENAME } from '../config/load.js';
import type {
  EntryWithSource,
  PinnedSuppression,
  Suppression,
  SuppressionEvaluation,
} from '../baseline/index.js';
import { appendRun, resolveCommit } from '../dashboard/history.js';
import { finishedRunFrom, writeLatestRun } from '../dashboard/latest.js';
import { repoRoot as findRepoRoot } from '../run/discover.js';

/**
 * What `--pin` was asked to name, before the run has happened.
 *
 * `file`, `line` and the optional `column` come from the `--pin` locator;
 * `ruleId` from `--rule`. `reason` and `expires` are the two fields a
 * suppression must carry (Requirement 3.1, 3.2) and are carried here so the
 * emitted object is complete — a pin the user still has to edit before it
 * loads is not a shortcut.
 */
interface PinRequest {
  file: string;
  line: number;
  column?: number;
  ruleId?: string;
  reason: string;
  expires: string;
  /** True when `expires` came from `DEFAULT_PIN_DAYS` rather than `--expires`. */
  expiresIsDefault: boolean;
}

interface ParsedCheckArgs {
  mode: RunMode;
  paths: string[];
  json: boolean;
  sarif: boolean;
  strict: boolean;
  noColor: boolean;
  sinceBaseline: boolean;
  recordHistory: boolean;
  reportStyle: ReportStyle;
  dedupeGuidance: boolean;
  pin?: PinRequest;
}

const REPORT_STYLES: Record<string, ReportStyle> = {
  summary: 'summary',
  compact: 'compact',
  full: 'full',
  detailed: 'detailed',
};

function parseReportStyle(value: string): ReportStyle {
  const style = REPORT_STYLES[value];
  if (style === undefined) {
    throw new Error(
      `--report takes one of ${Object.keys(REPORT_STYLES).join(', ')}, got "${value}".`,
    );
  }
  return style;
}

const MODE_FLAGS: Record<string, RunMode> = {
  '--staged': 'staged',
  '--working': 'working',
  '--branch': 'branch',
  '--all': 'all',
};

const PIN_LOCATOR_HELP =
  '--pin takes <file>:<line>, optionally <file>:<line>:<column> — for example ' +
  '--pin src/legacy/exporter.ts:42';

/** How far out a `--pin` expiry lands when `--expires` is not given. */
const DEFAULT_PIN_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function defaultExpiry(now: Date): string {
  return isoDay(new Date(now.getTime() + DEFAULT_PIN_DAYS * MS_PER_DAY));
}

interface PinLocator {
  file: string;
  line: number;
  column?: number;
}

/**
 * Split a `--pin` locator into a path and a 1-based line, plus an optional
 * column.
 *
 * The numeric parts are taken from the right rather than splitting on the
 * first colon, so a Windows path (`C:\src\a.ts:42`) keeps its drive letter.
 */
function parsePinLocator(raw: string): PinLocator {
  const parts = raw.split(':');
  const trailing: number[] = [];

  while (parts.length > 1 && trailing.length < 2) {
    const last = parts[parts.length - 1];
    if (last === undefined || !/^\d+$/.test(last)) {
      break;
    }
    trailing.unshift(Number(last));
    parts.pop();
  }

  const line = trailing[0];
  const file = parts.join(':');
  if (line === undefined || line < 1 || file === '') {
    throw new Error(`Cannot read "${raw}" as a location. ${PIN_LOCATOR_HELP}`);
  }

  const column = trailing[1];
  return column === undefined ? { file, line } : { file, line, column };
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('-')) {
    throw new Error(`${flag} needs a value.`);
  }
  return value;
}

function parseArgs(argv: string[], now: Date): ParsedCheckArgs {
  let modeFlag: RunMode | undefined;
  const paths: string[] = [];
  let json = false;
  let sarif = false;
  let strict = false;
  let noColor = false;
  let sinceBaseline = false;
  let recordHistory = false;
  let reportStyle: ReportStyle = 'compact';
  let dedupeGuidance = false;
  let locator: PinLocator | undefined;
  let ruleId: string | undefined;
  let reason: string | undefined;
  let expires: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }

    const mappedMode = MODE_FLAGS[arg];
    if (mappedMode !== undefined) {
      modeFlag = mappedMode;
      continue;
    }

    if (arg === '--json') {
      json = true;
    } else if (arg === '--sarif') {
      sarif = true;
    } else if (arg === '--strict') {
      strict = true;
    } else if (arg === '--no-color') {
      noColor = true;
    } else if (arg === '--since-baseline') {
      sinceBaseline = true;
    } else if (arg === '--record-history') {
      recordHistory = true;
    } else if (arg === '--dedupe-guidance') {
      dedupeGuidance = true;
    } else if (arg === '--report') {
      i += 1;
      reportStyle = parseReportStyle(requireValue(argv, i, '--report'));
    } else if (arg === '--pin') {
      i += 1;
      locator = parsePinLocator(requireValue(argv, i, '--pin'));
    } else if (arg === '--rule') {
      i += 1;
      ruleId = requireValue(argv, i, '--rule');
    } else if (arg === '--reason') {
      i += 1;
      reason = requireValue(argv, i, '--reason');
    } else if (arg === '--expires') {
      i += 1;
      expires = requireValue(argv, i, '--expires');
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown flag "${arg}" for cyv check.`);
    } else {
      paths.push(arg);
    }
  }

  // Two machine formats on one stdout has no sensible resolution, and quietly
  // picking one would hand a consumer a document in a format it did not ask for.
  if (json && sarif) {
    throw new Error('cyv check accepts --json or --sarif, not both: they are two formats for one stdout.');
  }

  // Refused rather than ignored: the flag changes where guidance lives in the
  // JSON document, so accepting it without --json would report a document
  // shape the caller did not receive.
  if (dedupeGuidance && !json) {
    throw new Error('--dedupe-guidance changes the shape of the --json document, so it needs --json.');
  }

  const pin = buildPinRequest(locator, { ruleId, reason, expires, json, sarif, now });

  // A `--pin` with no explicit mode or paths runs against the pinned file
  // alone. `occurrence` is assigned within a (path, ruleId, fingerprint)
  // group and path is part of that group, so numbering a single file in
  // isolation produces the same occurrence a whole-repository run would —
  // the pin does not depend on how wide the run was.
  const pinnedOnly = pin !== undefined && modeFlag === undefined && paths.length === 0;
  const effectivePaths = pinnedOnly && pin !== undefined ? [pin.file] : paths;
  const mode: RunMode = modeFlag ?? (effectivePaths.length > 0 ? 'files' : 'working');

  const base = {
    mode,
    paths: effectivePaths,
    json,
    sarif,
    strict,
    noColor,
    sinceBaseline,
    recordHistory,
    reportStyle,
    dedupeGuidance,
  };
  return pin === undefined ? base : { ...base, pin };
}

interface PinOptions {
  ruleId: string | undefined;
  reason: string | undefined;
  expires: string | undefined;
  json: boolean;
  sarif: boolean;
  now: Date;
}

function buildPinRequest(
  locator: PinLocator | undefined,
  options: PinOptions,
): PinRequest | undefined {
  if (locator === undefined) {
    if (options.ruleId !== undefined || options.reason !== undefined || options.expires !== undefined) {
      throw new Error('--rule, --reason and --expires only apply to --pin.');
    }
    return undefined;
  }

  if (options.json || options.sarif) {
    throw new Error(
      '--pin writes one suppression object to stdout, so it cannot share stdout with --json or --sarif.',
    );
  }
  if (options.reason === undefined || options.reason.trim() === '') {
    throw new Error(
      '--pin needs --reason "<why this is deferred rather than fixed>". ' +
        'A suppression must say why, and nothing but the person writing it knows that.',
    );
  }
  if (options.expires !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(options.expires)) {
    throw new Error(`--expires takes a date as YYYY-MM-DD, got "${options.expires}".`);
  }

  const request = {
    file: locator.file,
    line: locator.line,
    reason: options.reason,
    expires: options.expires ?? defaultExpiry(options.now),
    expiresIsDefault: options.expires === undefined,
  };
  const withColumn = locator.column === undefined ? request : { ...request, column: locator.column };
  return options.ruleId === undefined ? withColumn : { ...withColumn, ruleId: options.ruleId };
}

/**
 * The line that keeps a baseline honest.
 *
 * Printed whenever a baseline exists — NOT only under `--since-baseline`.
 * A team that has forgotten it is deferring four thousand findings is in a worse
 * position than one that never adopted the tool at all, because it believes a
 * green run means something. Baselined violations are deferred, never invisible.
 */
function baselineNotice(
  deferred: number,
  stale: number,
  filtered: boolean,
  repoWide: boolean,
): string {
  const parts = [
    `  ${deferred} violation${deferred === 1 ? '' : 's'} deferred by the baseline${
      filtered ? ' (hidden by --since-baseline)' : ''
    }.`,
  ];
  // Staleness is only knowable from a run that looked at the whole repository.
  // Any narrower mode leaves most of the baseline unexamined, and an entry whose
  // file was never checked has not stopped matching anything — it simply was not
  // looked for. Reporting it as stale told the user to shrink a baseline on the
  // evidence of a run that could not support the claim.
  if (stale > 0 && repoWide) {
    parts.push(
      `  ${stale} baseline entr${stale === 1 ? 'y' : 'ies'} no longer match anything — ` +
        `run \`cyv baseline\` to shrink it.`,
    );
  }
  return parts.join('\n');
}

/**
 * Build the set of rule ids known to this run.
 *
 * `runCheck` attaches `ruleCategories` and `ruleAnalyzers` for every rule in the
 * loaded catalog, so an unknown rule id in a suppression is a configuration
 * error even if that rule did not fire this run. The violation list is included
 * as a fallback in case a caller ever hands in a stripped-down report.
 */
function knownRuleIds(report: RunReport): Set<string> {
  const ids = new Set<string>();
  for (const ruleId of Object.keys(report.ruleCategories ?? {})) {
    ids.add(ruleId);
  }
  for (const ruleId of Object.keys(report.ruleAnalyzers ?? {})) {
    ids.add(ruleId);
  }
  for (const violation of report.violations) {
    ids.add(violation.ruleId);
  }
  return ids;
}

/**
 * From the set of expired suppressions, return the ones whose rule and target
 * glob match at least one violation that is being reported this run.
 *
 * An expired suppression only needs to be named when its violation actually
 * comes back (Requirement 3.3). A lapsed suppression that no longer matches
 * anything is not called out, because there is no reappearing finding to
 * explain.
 */
function expiredSuppressionsFor(
  evaluation: SuppressionEvaluation,
  repoRoot: string,
): Suppression[] {
  const matched: Suppression[] = [];

  for (const suppression of evaluation.expired) {
    const isMatch = picomatch(suppression.target, { dot: true });
    let found = false;

    for (const violation of evaluation.reported) {
      const relPath = toRepoRelative(violation.file, repoRoot);
      if (
        relPath !== undefined &&
        violation.ruleId === suppression.ruleId &&
        isMatch(relPath)
      ) {
        found = true;
        break;
      }
    }

    if (found) {
      matched.push(suppression);
    }
  }

  return matched;
}

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Turn a finding this run reported into the suppression that defers exactly
 * that finding.
 *
 * The three values a pinned suppression needs — an exact `target` path, a
 * `fingerprint` and an `occurrence` — are the identity `baseline/identity.ts`
 * computes, and this reads them from `computeEntries` rather than deriving a
 * second scheme. Before this existed the only way to obtain them was to run
 * `cyv baseline` and copy fields out of `checkyourvibe.baseline.json` by hand,
 * which left the unpinned path-glob form as the one people would actually
 * write — and a glob defers every future violation of its rule under the path.
 */
function pinnedSuppressionFor(source: EntryWithSource, pin: PinRequest): PinnedSuppression {
  return {
    ruleId: source.entry.ruleId,
    target: source.entry.path,
    reason: pin.reason,
    expires: pin.expires,
    fingerprint: source.entry.fingerprint,
    occurrence: source.entry.occurrence,
  };
}

/**
 * The findings from this run that `--pin` names: the ones in the pinned file
 * at the pinned line, narrowed further by `--pin`'s optional column and by
 * `--rule` when either was given.
 */
function pinMatches(
  entries: readonly EntryWithSource[],
  target: string,
  pin: PinRequest,
): EntryWithSource[] {
  return entries.filter(
    (source) =>
      source.entry.path === target &&
      source.violation.line === pin.line &&
      (pin.column === undefined || source.violation.column === pin.column) &&
      (pin.ruleId === undefined || source.entry.ruleId === pin.ruleId),
  );
}

function describeFinding(source: EntryWithSource): string {
  return `    ${source.entry.ruleId} at ${source.violation.line}:${source.violation.column}`;
}

/**
 * What to print when `--pin` names no finding, or more than one.
 *
 * Both are the user's location being off rather than a failure of the run, so
 * each case lists what the run did report in that file and says how to narrow
 * it. A pinned suppression names one finding; emitting a guess would defer
 * something nobody chose.
 */
function pinProblem(
  matches: readonly EntryWithSource[],
  inFile: readonly EntryWithSource[],
  target: string,
  pin: PinRequest,
): string {
  const at = pin.column === undefined ? `${target}:${pin.line}` : `${target}:${pin.line}:${pin.column}`;
  const ruleNote = pin.ruleId === undefined ? '' : ` for rule "${pin.ruleId}"`;

  if (matches.length === 0) {
    if (inFile.length === 0) {
      return (
        `This run reported no findings in ${target}, so there is nothing at ${at}${ruleNote} to pin.\n` +
        `  Run \`cyv check ${target}\` to see what it does report.`
      );
    }
    return [
      `No finding at ${at}${ruleNote}. This run reported these in ${target}:`,
      ...inFile.map(describeFinding),
    ].join('\n');
  }

  return [
    `${matches.length} findings at ${at}${ruleNote}, and a pinned suppression names exactly one:`,
    ...matches.map(describeFinding),
    '  Narrow it with a column (--pin file:line:column) or a rule (--rule <id>).',
  ].join('\n');
}

/**
 * The stderr half of a `--pin`: what the object on stdout does, where it goes,
 * and where its expiry came from. Kept off stdout so the object itself can be
 * piped or pasted without being edited first.
 */
function pinGuidance(
  suppression: PinnedSuppression,
  source: EntryWithSource,
  expiresWasGiven: boolean,
  alreadySuppressed: boolean,
): string {
  const lines = [
    `  Add this to the "suppressions" array in ${CONFIG_FILENAME}. It defers one finding —`,
    `  ${suppression.ruleId} at ${suppression.target}:${source.violation.line} — and nothing else;`,
    '  a later violation of the same rule in the same file is still reported.',
  ];
  if (!expiresWasGiven) {
    lines.push(
      `  "expires" is ${suppression.expires}, ${DEFAULT_PIN_DAYS} days out. Pass --expires YYYY-MM-DD to choose another date.`,
    );
  }
  if (alreadySuppressed) {
    lines.push('  This finding is already suppressed by an existing suppression in this run.');
  }
  return lines.join('\n');
}

/**
 * The flags `parseArgs` accepts, for `cyv check --help`.
 *
 * `cyv --help` lists commands with a one-line summary each and says nothing
 * about flags, so `--pin` and its companions had no place they could be read
 * about. They are described here, next to the parser that reads them, rather
 * than in the dispatcher's command table, which does not otherwise know what
 * any command's arguments are.
 */
function usage(): string {
  return [
    'Usage: cyv check [options] [paths...]',
    '',
    'Run the configured analyzers and report violations.',
    '',
    'What to check (default: --working, or the named paths):',
    '  --staged                     Files staged for commit.',
    '  --working                    Files changed in the working tree.',
    '  --branch                     Files changed on this branch.',
    '  --all                        Every file the analyzers claim.',
    '',
    'Output:',
    '  --report <style>             How much of the text report to print. One of:',
    '                               summary  — the per-rule and per-file tables only.',
    '                               compact  — the tables, then each rule\'s guidance once',
    `                                          above up to ${DEFAULT_MAX_PER_RULE} of its findings. Default.`,
    '                               full     — compact, listing every finding.',
    '                               detailed — one block per finding, each repeating its',
    '                                          rule\'s guidance.',
    '  --json                       Write the report to stdout as JSON.',
    '  --dedupe-guidance            With --json, write each rule\'s guidance once under',
    '                               "ruleGuidance" instead of on every violation.',
    '  --sarif                      Write the report to stdout as SARIF.',
    '  --no-color                   Write the text report without ANSI colour.',
    '  --since-baseline             Report only findings absent from the baseline.',
    '  --strict                     Exit non-zero when files were skipped, overriding',
    '                               the "strict" setting in the config.',
    '  --record-history             Append this run to the history metrics and dashboard read.',
    '',
    'Print a pinned suppression for one finding:',
    '  --pin <file>:<line>          The finding to pin. Add :<column> to narrow further.',
    '  --rule <rule-id>             Narrow the pin to one rule.',
    '  --reason <text>              Why the finding is deferred rather than fixed.',
    '                               Required with --pin.',
    `  --expires <YYYY-MM-DD>       When the suppression stops suppressing. Defaults to`,
    `                               ${DEFAULT_PIN_DAYS} days from today.`,
    '',
    `The suppression object goes to stdout and belongs in the "suppressions" array in`,
    `${CONFIG_FILENAME}. It names one finding by the same identity the baseline uses, so a`,
    'later violation of the same rule in the same file is still reported.',
  ].join('\n');
}

export const command: Command = {
  async run(ctx: CommandContext): Promise<number> {
    if (ctx.argv.includes('--help') || ctx.argv.includes('-h')) {
      console.log(usage());
      return 0;
    }

    let report: RunReport;
    let json: boolean;
    let sarif: boolean;
    let noColor: boolean;
    let reportStyle: ReportStyle;
    let dedupeGuidance: boolean;
    let notice: string | undefined;
    let repoRoot: string;

    try {
      const parsed = parseArgs(ctx.argv, new Date());
      json = parsed.json;
      sarif = parsed.sarif;
      noColor = parsed.noColor;
      reportStyle = parsed.reportStyle;
      dedupeGuidance = parsed.dedupeGuidance;
      const startedAt = new Date().toISOString();
      // `--pin` asks a question about one finding; it is not the run the
      // dashboard should show as the repository's latest, and it usually
      // covers a single file. Its bookkeeping writes are skipped for that
      // reason, not to make it faster.
      const pin = parsed.pin;

      // Marked running before any analyzer starts, so the dashboard can tell a
      // run in progress from a finished run that found nothing.
      //
      // The repository root is resolved separately because `runCheck` returns
      // it only after finishing, which is after this marker is needed.
      //
      // Failure is reported and not propagated: the marker is bookkeeping and
      // must not change the check's exit code.
      if (pin === undefined) {
        try {
          await writeLatestRun(await findRepoRoot(ctx.cwd), {
            status: 'running',
            startedAt,
            mode: parsed.mode,
          });
        } catch (err) {
          console.error(`  Could not mark the run as started: ${messageFor(err)}`);
        }
      }

      const result = await runCheck({
        cwd: ctx.cwd,
        mode: parsed.mode,
        paths: parsed.paths,
        ...(parsed.strict ? { strict: true } : {}),
      });
      report = result.report;
      repoRoot = result.repoRoot;

      const baseline = await readBaseline(result.repoRoot);
      let baselineNoticeText: string | undefined;
      let candidate = report.violations;

      if (baseline !== null) {
        const { fresh, baselined, stale } = partitionViolations(report.violations, baseline);
        if (parsed.sinceBaseline) {
          candidate = fresh;
        }
        baselineNoticeText = baselineNotice(
          baselined.length,
          stale.length,
          parsed.sinceBaseline,
          report.mode === 'all',
        );
      } else if (parsed.sinceBaseline) {
        console.error('  No baseline found. Run `cyv baseline` first.');
        return 2;
      }

      const suppressions = await loadSuppressions(result.repoRoot);
      validateSuppressionRules(suppressions, knownRuleIds(report));
      const evaluation = evaluateSuppressions(candidate, suppressions, result.repoRoot);

      report = { ...report, violations: evaluation.reported };

      const expired = expiredSuppressionsFor(evaluation, result.repoRoot);
      // The active set, derived by exclusion rather than recomputed: whatever
      // `evaluateSuppressions` decided has expired is authoritative, and a second
      // date comparison here could disagree with it across a midnight boundary.
      const expiredSet = new Set(evaluation.expired);
      const activeSuppressions = suppressions.filter((s) => !expiredSet.has(s));
      const suppressionNoticeText = suppressionNotice(evaluation, expired, activeSuppressions);

      // Three lines that each keep one thing honest, printed together and
      // unconditionally: what the configuration actually resolved to, what the
      // baseline is deferring, and what the suppressions are hiding. Each of
      // them exists because a run can otherwise report a clean result while
      // knowing it checked less than the reader believes.
      const noticeParts: string[] = [];
      const configNoticeText = configNotice(report);
      if (configNoticeText !== '') {
        noticeParts.push(configNoticeText);
      }
      if (baselineNoticeText !== undefined) {
        noticeParts.push(baselineNoticeText);
      }
      noticeParts.push(suppressionNoticeText);
      notice = noticeParts.join('\n');

      if (pin !== undefined) {
        // Identity is computed over what the run actually found, not over the
        // baseline- or suppression-filtered list: a finding that is already
        // deferred is still a finding somebody may want to pin, and refusing
        // to name it would send them back to the baseline file.
        const entries = computeEntries(result.report.violations, result.repoRoot);
        // Resolved against the repository root, not the working directory, so
        // `--pin src/a.ts:3` names the same file `cyv check src/a.ts` does
        // (see `resolveFilePaths` in run/discover.ts).
        const absolute = isAbsolute(pin.file) ? pin.file : resolvePath(result.repoRoot, pin.file);
        const target = toRepoRelative(absolute, result.repoRoot);
        if (target === undefined) {
          console.error(`"${pin.file}" is outside this repository, so it has no pinnable identity.`);
          return 2;
        }

        const matches = pinMatches(entries, target, pin);
        const first = matches[0];
        if (matches.length !== 1 || first === undefined) {
          const inFile = entries.filter((source) => source.entry.path === target);
          console.error(pinProblem(matches, inFile, target, pin));
          console.error(notice);
          return 2;
        }

        const suppression = pinnedSuppressionFor(first, pin);
        // The suppression notice still prints, on stderr, exactly as it does
        // for any other run: this command ran a real check, and what that
        // check is already hiding must not go unstated just because the
        // caller asked for something else on stdout.
        console.error(
          pinGuidance(
            suppression,
            first,
            !pin.expiresIsDefault,
            evaluation.suppressed.includes(first.violation),
          ),
        );
        console.error(notice);
        console.log(JSON.stringify(suppression, null, 2));
        return 0;
      }

      // Unconditional, unlike the history append below: this is a single file,
      // overwritten each run, so its cost does not grow with the number of runs.
      //
      // Like the history write, this is bookkeeping and must not change the
      // check's exit code.
      try {
        await writeLatestRun(
          result.repoRoot,
          finishedRunFrom(result.report, {
            startedAt,
            finishedAt: new Date().toISOString(),
            mode: parsed.mode,
            commit: await resolveCommit(result.repoRoot),
          }),
        );
      } catch (err) {
        console.error(`  Could not record the latest run: ${messageFor(err)}`);
      }

      if (parsed.recordHistory) {
        // `result.report`, not the baseline- or suppression-filtered `report`:
        // history records what the run found, so a trend does not show debt
        // dropping at the moment it is deferred.
        //
        // Failure is reported and not propagated: the write is bookkeeping and
        // must not change the check's exit code.
        try {
          await appendRun(
            result.repoRoot,
            result.report,
            await resolveCommit(result.repoRoot),
          );
        } catch (err) {
          console.error(`  Could not record run history: ${messageFor(err)}`);
        }
      }
    } catch (err) {
      console.error(messageFor(err));
      return 2;
    }

    const machineOutput = json || sarif;
    // The repository root reaches the text report so findings print as
    // repo-relative paths under a stated root, rather than as the absolute
    // paths analyzers report.
    const textOptions = { style: reportStyle, root: repoRoot };
    const output = json
      ? renderJson(report, { dedupeGuidance })
      : sarif
        ? renderSarif(report, repoRoot)
        : noColor
          ? renderTextPlain(report, textOptions)
          : renderText(report, textOptions);
    console.log(output);

    // A machine format goes to stdout alone so a consumer can parse it; the
    // notice still has to reach a human, so it goes to stderr in that mode.
    // The deferred count is the one line a baseline cannot be allowed to
    // swallow, and a SARIF consumer will not show it.
    if (notice !== undefined) {
      if (machineOutput) {
        console.error(notice);
      } else {
        console.log(notice);
      }
    }

    return exitCodeFor(report);
  },
};
