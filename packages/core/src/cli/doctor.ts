/**
 * `cyv doctor` — re-reads what `cyv init` applied and reports drift.
 *
 * Every check here answers a question `cyv check` cannot: not "does the code
 * violate a rule" but "is the scaffolding this project depends on still
 * intact". The sharpest failure mode is a moved or deleted checkout leaving a
 * hook pointing at nothing — the agent's edit loop keeps running, the hook
 * keeps firing, and nothing ever reports a problem again. That is exactly the
 * silent-failure shape this project exists to prevent, so it gets its own
 * explicit check rather than being folded into generic drift.
 */
import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type { Command, CommandContext } from './types.js';
import { repoRoot } from '../run/discover.js';
import { CONFIG_FILENAME, loadConfig } from '../config/load.js';
import { configuredLanes } from '../config/lanes.js';
import { resolveBriefInput, type BriefInput } from '../executor/brief.js';
import { describeLane } from '../executor/lane.js';
import { findProgram, pathExtensions } from '../executor/program.js';
import { agentCommandFor, AGENT_COMMANDS } from '../executor/invocation.js';
import type { CheckYourVibeConfig } from '../config/types.js';
import { loadAnalyzerManifest, allRules } from '../registry/load.js';
import { planDiff } from '../merge/apply.js';
import type {
  AgentPlugin,
  AgentSurface,
  AnalyzerManifest,
  PlannedWrite,
  RuleManifest,
} from '../protocol/index.js';
import { agentPluginsOverride, commandResolves, fileExists, loadAllPlugins, resolveCyvCommand, resolveHomeDir } from './init.js';

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function okLine(message: string): string {
  return `[ok]    ${message}`;
}

function driftLine(message: string): string {
  return `[drift] ${message}`;
}

function setupLine(message: string): string {
  return `[setup] ${message}`;
}

function errorLine(message: string): string {
  return `[error] ${message}`;
}

function unverifiedLine(message: string): string {
  return `[unverified] ${message}`;
}

function noticeLine(message: string): string {
  return `[notice] ${message}`;
}

/**
 * The exact suffix `plan()` in the claude-code adapter appends to
 * `cyvCommand` when building the hook's command string. Stripping it back off
 * the string actually written to `~/.claude/settings.json` recovers the
 * command as it exists on disk right now — which may differ from what
 * `cyv init` would compute today if the checkout has since moved.
 */
const CLAUDE_CODE_HOOK_SUFFIX = ' hook claude-code';

/**
 * A minimal, quote-aware tokenizer for the hook command left after stripping
 * the suffix above.
 *
 * The adapter wraps a `.js`/`.mjs` `cyvCommand` in an explicit Node
 * invocation (`"<node>" <cyv-entry-point>`) so the hook is actually
 * executable on every platform, quoting each side independently only when it
 * contains a space. That leaves either one token (the entry point directly)
 * or two (the interpreter followed by the entry point) — in both shapes the
 * entry point this check cares about is the last token, so this only needs
 * to split on unquoted spaces, not replicate the adapter's own quoting rules.
 */
function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && input.charAt(i) === ' ') {
      i += 1;
    }
    if (i >= input.length) {
      break;
    }
    if (input.charAt(i) === '"') {
      const end = input.indexOf('"', i + 1);
      if (end === -1) {
        tokens.push(input.slice(i + 1));
        i = input.length;
      } else {
        tokens.push(input.slice(i + 1, end));
        i = end + 1;
      }
    } else {
      const end = input.indexOf(' ', i);
      if (end === -1) {
        tokens.push(input.slice(i));
        i = input.length;
      } else {
        tokens.push(input.slice(i, end));
        i = end;
      }
    }
  }
  return tokens;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function toUnknownArray(value: unknown): unknown[] | undefined {
  if (!isUnknownArray(value)) {
    return undefined;
  }
  const result: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i];
    result.push(item);
  }
  return result;
}

async function extractClaudeCodeCyvCommand(homeDir: string): Promise<string | undefined> {
  const settingsPath = join(homeDir, '.claude', 'settings.json');

  let raw: string;
  try {
    raw = await readFile(settingsPath, 'utf-8');
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) {
    return undefined;
  }
  const hooks = parsed.hooks;
  if (!isRecord(hooks)) {
    return undefined;
  }
  const postToolUse = toUnknownArray(hooks.PostToolUse);
  if (postToolUse === undefined) {
    return undefined;
  }

  for (let i = 0; i < postToolUse.length; i++) {
    const matcher: unknown = postToolUse[i];
    if (!isRecord(matcher)) {
      continue;
    }
    const innerHooks = toUnknownArray(matcher.hooks);
    if (innerHooks === undefined) {
      continue;
    }
    for (let j = 0; j < innerHooks.length; j++) {
      const hook: unknown = innerHooks[j];
      if (!isRecord(hook)) {
        continue;
      }
      const command = hook.command;
      if (typeof command === 'string' && command.endsWith(CLAUDE_CODE_HOOK_SUFFIX)) {
        const remainder = command.slice(0, command.length - CLAUDE_CODE_HOOK_SUFFIX.length);
        const tokens = tokenizeCommand(remainder);
        const entryPoint = tokens.at(-1);
        if (entryPoint !== undefined) {
          return entryPoint;
        }
      }
    }
  }

  return undefined;
}

interface ParsedDoctorArgs {
  verbose: boolean;
}

function parseArgs(argv: string[]): ParsedDoctorArgs {
  let verbose = false;

  for (const arg of argv) {
    if (arg === '--verbose') {
      verbose = true;
    } else {
      throw new Error(`Unknown argument "${arg}" for cyv doctor.`);
    }
  }

  return { verbose };
}

/**
 * Whether a basename is one of the generated rule guidance files, which
 * `summarizeChangedFiles` counts rather than lists.
 */
function isRuleGuidanceFile(fileName: string): boolean {
  return (
    fileName === 'checkyourvibe-rules.md' ||
    (fileName.startsWith('cyv-') && (fileName.endsWith('.md') || fileName.endsWith('.mdc')))
  );
}

function shortenDir(dir: string, repoRoot: string, homeDir: string): string {
  const relRepo = relative(repoRoot, dir);
  const relHome = relative(homeDir, dir);

  const repoOk = !relRepo.startsWith('..') && !isAbsolute(relRepo);
  const homeOk = !relHome.startsWith('..') && !isAbsolute(relHome);

  if (homeOk && (!repoOk || relHome.length <= relRepo.length)) {
    return relHome.length === 0 ? '.' : relHome;
  }
  if (repoOk) {
    return relRepo.length === 0 ? '.' : relRepo;
  }
  return dir;
}

function joinPhrases(phrases: readonly string[]): string {
  if (phrases.length === 0) {
    return '';
  }
  if (phrases.length === 1) {
    const first = phrases[0];
    return first ?? '';
  }
  if (phrases.length === 2) {
    const first = phrases[0];
    const second = phrases[1];
    return `${first} and ${second}`;
  }

  const allButLast = phrases.slice(0, -1).join(', ');
  const last = phrases.at(-1);
  if (last === undefined) {
    return allButLast;
  }
  return `${allButLast}, and ${last}`;
}

interface FileGroup {
  dir: string;
  kind: 'rule' | 'other';
  paths: string[];
}

/**
 * A generic, agent-agnostic way to talk about a collection of drifted files.
 *
 * The goal is to give the user just enough detail to act without reproducing
 * the wall of per-file drift lines the collapse is meant to prevent. Rule
 * guidance files are identified by name so they can be summarised as a count
 * rather than a long list of `cyv-*.md` basenames.
 */
function summarizeChangedFiles(
  paths: string[],
  details: string[],
  repoRoot: string,
  homeDir: string,
): string {
  if (paths.length === 0 && details.length === 0) {
    return '';
  }

  const groupsByKey = new Map<string, FileGroup>();

  for (const path of paths) {
    const dir = dirname(path);
    const name = basename(path);
    const kind = isRuleGuidanceFile(name) ? 'rule' : 'other';
    const key = `${dir}\0${kind}`;

    const existing = groupsByKey.get(key);
    if (existing === undefined) {
      groupsByKey.set(key, { dir, kind, paths: [path] });
    } else {
      existing.paths.push(path);
    }
  }

  const groups = Array.from(groupsByKey.values()).sort((a, b) => {
    const aPath = a.paths[0];
    const bPath = b.paths[0];
    if (aPath === undefined || bPath === undefined) {
      return 0;
    }
    return paths.indexOf(aPath) - paths.indexOf(bPath);
  });

  const phrases: string[] = [];

  for (const group of groups) {
    if (group.paths.length === 1) {
      const first = group.paths[0];
      if (first !== undefined) {
        phrases.push(basename(first));
      }
    } else if (group.kind === 'rule') {
      phrases.push(`${group.paths.length} rule guidance files`);
    } else if (group.paths.length === 2) {
      const first = group.paths[0];
      const second = group.paths[1];
      if (first !== undefined && second !== undefined) {
        phrases.push(`${basename(first)}, ${basename(second)}`);
      }
    } else {
      const shortDir = shortenDir(group.dir, repoRoot, homeDir);
      phrases.push(`${group.paths.length} files under ${shortDir}`);
    }
  }

  for (const detail of details) {
    phrases.push(detail);
  }

  return joinPhrases(phrases);
}

interface DriftRenderContext {
  plugin: AgentPlugin;
  changed: { path: string }[];
  embeddedMissing: string | undefined;
  verbose: boolean;
  repoRoot: string;
  homeDir: string;
}

function isPathToCyvEntryPoint(value: string): boolean {
  return (
    value.endsWith('.js') ||
    value.endsWith('.mjs') ||
    value.includes('/') ||
    value.includes('\\')
  );
}

function embeddedCyvDriftPhrase(embedded: string): string {
  if (isPathToCyvEntryPoint(embedded)) {
    return `the cyv entry point embedded in the hook no longer exists (${embedded})`;
  }
  return `the cyv command embedded in the hook does not resolve (${embedded})`;
}

function renderDrift(ctx: DriftRenderContext): string[] {
  const { plugin, changed, embeddedMissing, verbose, repoRoot, homeDir } = ctx;
  const embeddedCount = embeddedMissing !== undefined ? 1 : 0;
  const totalDrift = changed.length + embeddedCount;

  const lines: string[] = [];

  if (changed.length === 0 && embeddedMissing !== undefined) {
    lines.push(driftLine(`${plugin.id} — ${embeddedCyvDriftPhrase(embeddedMissing)}. Run \`cyv init\` to reapply.`));
  } else {
    lines.push(driftLine(`${plugin.id} — ${totalDrift} file(s) differ from what init would write. Run \`cyv init\` to reapply.`));
  }

  if (verbose) {
    for (const entry of changed) {
      lines.push(`        ${entry.path} has drifted from the applied configuration.`);
    }
    if (embeddedMissing !== undefined) {
      lines.push(`        ${embeddedCyvDriftPhrase(embeddedMissing)}. Re-run \`cyv init\` from a valid checkout.`);
    }
  } else {
    const details: string[] = [];
    if (embeddedMissing !== undefined) {
      details.push(embeddedCyvDriftPhrase(embeddedMissing));
    }

    const filePaths = changed.map((entry) => entry.path);
    const summary = summarizeChangedFiles(filePaths, details, repoRoot, homeDir);
    if (summary.length > 0) {
      lines.push(`        ${summary}.`);
    }
  }

  return lines;
}

/**
 * Agents whose hook contract can refuse to end a turn (spec 0042 Requirement
 * 1.2).
 *
 * Only Claude Code documents such an event. On every other agent a note left
 * while the session is mid-task waits for that session's next edit, and there
 * may not be one — which is a fact about that agent's contract, not a defect in
 * its adapter, so it is reported rather than fixed.
 */
const REFUSES_TO_STOP: ReadonlySet<string> = new Set(['claude-code']);

/**
 * Agents that carry no notes hook at all.
 *
 * Codex stores its hooks as a TOML array-of-tables merged by ownership marker,
 * and the notes command contains the analyzer hook's marker as a substring. A
 * second entry would be deleted by the next `cyv init` without a word, so none
 * is written and this says so instead.
 */
const NO_NOTES_HOOK: ReadonlySet<string> = new Set(['codex']);

function renderNotesDelivery(plugin: AgentPlugin): string[] {
  if (NO_NOTES_HOOK.has(plugin.id)) {
    return [
      noticeLine(
        `agent "${plugin.id}" installs no notes hook: its config format merges by ownership ` +
          "marker, and the notes command contains the analyzer hook's marker, so a second entry " +
          'would not survive an upgrade. Owner notes reach this agent only through ' +
          '`cyv comments`.',
      ),
    ];
  }
  if (REFUSES_TO_STOP.has(plugin.id)) {
    return [
      okLine(
        `agent "${plugin.id}" delivers owner notes after an edit and refuses to end a turn ` +
          'while one is unread.',
      ),
    ];
  }
  return [
    noticeLine(
      `agent "${plugin.id}" delivers owner notes after an edit, but its hook contract has no ` +
        'refuse-to-stop equivalent. A note left while this agent is mid-task waits for its next ' +
        'edit, and a session that stops first will not have seen it.',
    ),
  ];
}

function renderUnverified(plugin: AgentPlugin): string[] {
  if (plugin.unverifiedSurfaces === undefined || plugin.unverifiedSurfaces.length === 0) {
    return [];
  }

  const byReason = new Map<string, AgentSurface[]>();
  for (const entry of plugin.unverifiedSurfaces) {
    const list = byReason.get(entry.reason);
    if (list === undefined) {
      byReason.set(entry.reason, [entry.surface]);
    } else {
      list.push(entry.surface);
    }
  }

  const lines: string[] = [];
  for (const [reason, surfaces] of byReason) {
    const seen = new Set<AgentSurface>();
    const deduped: AgentSurface[] = [];
    for (const surface of surfaces) {
      if (!seen.has(surface)) {
        seen.add(surface);
        deduped.push(surface);
      }
    }
    lines.push(unverifiedLine(`${plugin.id} — ${deduped.join(', ')}: ${reason}`));
  }

  return lines;
}

function shouldReportUnverified(plugin: AgentPlugin, isConfigured: boolean, detected: boolean): boolean {
  if (plugin.unverifiedSurfaces === undefined || plugin.unverifiedSurfaces.length === 0) {
    return false;
  }
  return isConfigured || detected;
}

interface LaneReport {
  lines: string[];
  hasError: boolean;
}

function configuredAgentsPhrase(configuredAgentIds: ReadonlySet<string>): string {
  if (configuredAgentIds.size === 0) {
    return `no agent is listed in ${CONFIG_FILENAME}`;
  }
  return `agents listed in ${CONFIG_FILENAME}: ${[...configuredAgentIds].join(', ')}`;
}

/**
 * What doctor says about the executor lanes this repository declares (spec 0011
 * Requirements 1.3, 1.4 and spec 0036 Requirements 2.1, 2.2).
 *
 * `cyv init` writes no lane, so a declaration is something a person added by
 * hand and may not have read since. Each lane is named here with the agent
 * behind it and the concurrency cap it declares, and a metered lane carries its
 * billing at this point rather than only in documentation — `describeLane`
 * supplies the same label the dispatch record and the localhost view use.
 *
 * A lane naming an `agentId` the repository does not configure is reported as
 * an error: `agents` is what decides which plugin is set up here, so a lane
 * pointing outside that list has nothing to dispatch through.
 *
 * A lane whose agent is configured but whose program cannot be found on PATH is
 * reported as unavailable. That is a notice, not an error: the machine simply
 * does not have that CLI installed.
 *
 * A repository that declares no lane produces no line. An absent `executor` key
 * is a supported state, not a finding.
 */
async function laneReport(
  config: CheckYourVibeConfig,
  configuredAgentIds: ReadonlySet<string>,
  env: NodeJS.ProcessEnv,
  repoRoot: string,
): Promise<LaneReport> {
  const lanes = configuredLanes(config);
  if (lanes.length === 0) {
    return { lines: [], hasError: false };
  }

  const lines: string[] = [
    okLine(
      `${lanes.length} executor lane(s) declared in ${CONFIG_FILENAME}. Each was declared by hand; ` +
        '`cyv init` writes none.',
    ),
  ];
  let hasError = false;

  for (const lane of lanes) {
    const metered =
      lane.billing.kind === 'metered'
        ? ' A dispatch that names this lane is billed per use, and the core never selects it on its own.'
        : '';
    const cap =
      `concurrency cap ${lane.concurrencyCap} — the most simultaneous dispatches the core will ` +
      "schedule here, a self-imposed number rather than a reading of the vendor's limit";

    // Both values are resolved rather than declared, and the resolution depends
    // on how many lanes exist, so a reader cannot recover either one from this
    // lane's own entry in the config file (spec 0041 Requirement 2.2).
    const disposition = lane.acceptsDispatch
      ? `accepts dispatched work, executed as ${
          lane.executes === 'subagent' ? 'a sub-agent of the orchestrating session' : "the agent's own program"
        }`
      : 'does not accept dispatched work';

    if (!configuredAgentIds.has(lane.agentId)) {
      hasError = true;
      lines.push(
        errorLine(
          `executor lane ${describeLane(lane)} names agent "${lane.agentId}", which this repository ` +
            `does not configure (${configuredAgentsPhrase(configuredAgentIds)}). A dispatch to this ` +
            `lane has no configured agent to run it. Add "${lane.agentId}" to \`agents\` and run ` +
            '`cyv init`, or remove the lane.' +
            metered,
        ),
      );
      continue;
    }

    const spec = agentCommandFor(lane.agentId);
    if (spec === undefined) {
      // The configured agent has no command-line mapping in this build, so the
      // lane cannot be resolved against PATH.
      hasError = true;
      lines.push(
        errorLine(
          `executor lane ${describeLane(lane)} names agent "${lane.agentId}", which this build ` +
            'has no command-line mapping for. The lane cannot be resolved against PATH.'
        ),
      );
      continue;
    }

    const launcher = await findProgram(spec.program, env, repoRoot);
    if (launcher === undefined) {
      // Still a declared lane, so it is still described in full. Only its
      // capacity is zero, and the reader needs the cap and the billing to
      // judge what installing the program would give back.
      if (lane.executes === 'subagent') {
        // Nothing is spawned for this lane, so a missing program says nothing
        // about whether it can take work. Reporting it as unavailable would be
        // reporting a fact about the wrong mechanism.
        lines.push(
          okLine(
            `executor lane ${describeLane(lane)} — agent "${lane.agentId}", ${cap}${metered} — ` +
              `${disposition}. Its program "${spec.program}" is not on PATH and is not needed: ` +
              'a sub-agent lane is run by the orchestrating session itself.',
          ),
        );
        continue;
      }

      const tried = pathExtensions(env).map((suffix) => `${spec.program}${suffix}`);
      lines.push(
        noticeLine(
          `executor lane ${describeLane(lane)} — agent "${lane.agentId}", ${cap}${metered} — is ` +
            `unavailable: its program "${spec.program}" was not found on PATH. ` +
            `Tried: ${tried.join(', ')}. It contributes no capacity anywhere until it is installed.`
        ),
      );
      continue;
    }

    lines.push(
      okLine(
        `executor lane ${describeLane(lane)} — agent "${lane.agentId}", program "${spec.program}" ` +
          `found on PATH at ${launcher.path}, ${cap}. It ${disposition}.${metered}`
      ),
    );
  }

  return { lines, hasError };
}

/**
 * Adapters that ship with cyv, are present on PATH, and are not named by any
 * declared lane (spec 0036 Requirement 2.3).
 *
 * A lane is the user's own declaration; `doctor` only reports what it found,
 * and does not add or rewrite a lane because a CLI happens to be installed.
 */
async function unusedCapacityReport(
  config: CheckYourVibeConfig,
  env: NodeJS.ProcessEnv,
  repoRoot: string,
): Promise<string[]> {
  const lanes = configuredLanes(config);
  const declaredAgentIds = new Set<string>();
  for (const lane of lanes) {
    declaredAgentIds.add(lane.agentId);
  }

  const lines: string[] = [];
  for (const spec of AGENT_COMMANDS) {
    if (declaredAgentIds.has(spec.agentId)) {
      continue;
    }
    const launcher = await findProgram(spec.program, env, repoRoot);
    if (launcher !== undefined) {
      lines.push(
        noticeLine(
          `${spec.agentId} adapter ships with cyv and its program "${spec.program}" is on PATH, ` +
            `but no executor lane names it — unused capacity.`,
        ),
      );
    }
  }
  return lines;
}

async function checkAgentDrift(
  plugin: AgentPlugin,
  ctx: {
    repoRoot: string;
    homeDir: string;
    cyvCommand: string;
    rules: RuleManifest[];
    orchestration?: BriefInput;
  },
  isConfigured: boolean,
  lines: string[],
  verbose: boolean,
): Promise<{ hasError: boolean; hasDrift: boolean }> {
  let detected: boolean;
  try {
    detected = await plugin.detect({ repoRoot: ctx.repoRoot, homeDir: ctx.homeDir });
  } catch (err) {
    lines.push(errorLine(`agent "${plugin.id}" detection failed: ${messageFor(err)}`));
    return { hasError: true, hasDrift: false };
  }

  if (isConfigured && detected) {
    let planned: PlannedWrite[];
    try {
      planned = await plugin.plan(ctx);
    } catch (err) {
      lines.push(errorLine(`agent "${plugin.id}" could not be re-planned: ${messageFor(err)}`));
      return { hasError: true, hasDrift: false };
    }

    const diffs = await planDiff(planned);
    const changed = diffs.filter((d) => d.changed);
    let embeddedMissing: string | undefined;

    if (plugin.id === 'claude-code') {
      const embedded = await extractClaudeCodeCyvCommand(ctx.homeDir);
      if (embedded !== undefined && !(await commandResolves(embedded))) {
        embeddedMissing = embedded;
      }
    }

    const drifted = changed.length > 0 || embeddedMissing !== undefined;

    if (drifted) {
      lines.push(
        ...renderDrift({
          plugin,
          changed,
          embeddedMissing,
          verbose,
          repoRoot: ctx.repoRoot,
          homeDir: ctx.homeDir,
        }),
      );
    } else {
      let message = `${plugin.id} glue matches the applied configuration.`;
      if (plugin.id === 'claude-code') {
        const embedded = await extractClaudeCodeCyvCommand(ctx.homeDir);
        if (embedded !== undefined) {
          message += isPathToCyvEntryPoint(embedded)
            ? ` The embedded cyv entry point exists (${embedded}).`
            : ` The embedded cyv command resolves (${embedded}).`;
        }
      }
      lines.push(okLine(message));
    }

    if (isConfigured) {
      lines.push(...renderNotesDelivery(plugin));
    }

    if (shouldReportUnverified(plugin, isConfigured, detected)) {
      lines.push(...renderUnverified(plugin));
    }

    return { hasError: false, hasDrift: drifted };
  }

  if (isConfigured && !detected) {
    lines.push(driftLine(`${plugin.id} is configured, but this agent is no longer installed — its glue is dead weight.`));
    if (shouldReportUnverified(plugin, isConfigured, detected)) {
      lines.push(...renderUnverified(plugin));
    }
    return { hasError: false, hasDrift: true };
  }

  if (!isConfigured && detected) {
    lines.push(setupLine(`${plugin.id} is installed but not set up; run \`cyv init\`.`));
    if (shouldReportUnverified(plugin, isConfigured, detected)) {
      lines.push(...renderUnverified(plugin));
    }
    return { hasError: false, hasDrift: false };
  }

  return { hasError: false, hasDrift: false };
}

export const command: Command = {
  async run(ctx: CommandContext): Promise<number> {
    const { verbose } = parseArgs(ctx.argv);
    const lines: string[] = [];
    let hasDrift = false;
    let hasError = false;

    let root: string;
    let homeDir: string;
    try {
      root = await repoRoot(ctx.cwd);
      homeDir = resolveHomeDir(ctx.env);
    } catch (err) {
      console.error(messageFor(err));
      return 2;
    }

    let config: CheckYourVibeConfig | undefined;
    try {
      config = await loadConfig(root);
      lines.push(okLine(`${CONFIG_FILENAME} is present and schema-valid.`));
    } catch (err) {
      hasError = true;
      lines.push(errorLine(messageFor(err)));
    }

    if (config !== undefined) {
      const manifests: AnalyzerManifest[] = [];
      for (const entry of config.analyzers) {
        try {
          const manifest = await loadAnalyzerManifest(entry.package, root);
          if (manifest.id !== entry.id) {
            throw new Error(
              `configured analyzer id "${entry.id}" does not match manifest id "${manifest.id}" from "${entry.package}"`,
            );
          }
          manifests.push(manifest);
          lines.push(okLine(`analyzer "${entry.id}" resolves and its manifest is readable.`));
        } catch (err) {
          hasError = true;
          lines.push(errorLine(`analyzer "${entry.id}": ${messageFor(err)}`));
        }
      }

      let catalog: RuleManifest[] = [];
      try {
        catalog = allRules(manifests);
      } catch (err) {
        hasError = true;
        lines.push(errorLine(messageFor(err)));
      }

      const configuredAgentIds = new Set(config.agents ?? []);

      const lanes = await laneReport(config, configuredAgentIds, ctx.env, root);
      lines.push(...lanes.lines);
      hasError = hasError || lanes.hasError;

      const unused = await unusedCapacityReport(config, ctx.env, root);
      lines.push(...unused);

      try {
        const plugins = agentPluginsOverride.plugins ?? (await loadAllPlugins());
        const cyvCommand = await resolveCyvCommand();

        if (!(await commandResolves(cyvCommand))) {
          hasDrift = true;
          if (isPathToCyvEntryPoint(cyvCommand)) {
            lines.push(driftLine(`the cyv entry point (${cyvCommand}) no longer exists. Re-run \`cyv init\` from a valid checkout.`));
          } else {
            lines.push(driftLine(`the cyv command (${cyvCommand}) does not resolve on PATH. Make it available, then re-run \`cyv init\`.`));
          }
        }

        // `checkAgentDrift` compares each plugin's planned writes against the
        // files on disk, so passing the orchestration here puts the brief
        // through the same comparison as every other managed block: a block
        // that no longer matches what the configuration produces is reported as
        // drift (spec 0041 Requirement 1.3).
        const orchestration = await resolveBriefInput(config, ctx.env, root);

        for (const plugin of plugins) {
          const result = await checkAgentDrift(
            plugin,
            {
              repoRoot: root,
              homeDir,
              cyvCommand,
              rules: catalog,
              ...(orchestration === undefined ? {} : { orchestration }),
            },
            configuredAgentIds.has(plugin.id),
            lines,
            verbose,
          );
          hasError = hasError || result.hasError;
          hasDrift = hasDrift || result.hasDrift;
        }
      } catch (err) {
        hasError = true;
        lines.push(errorLine(messageFor(err)));
      }
    }

    console.log(lines.join('\n'));

    if (hasError) {
      return 2;
    }
    if (hasDrift) {
      return 1;
    }
    return 0;
  },
};
