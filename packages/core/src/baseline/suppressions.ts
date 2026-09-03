/**
 * Suppression with an expiry (Requirement 3).
 *
 * There is deliberately no bare ignore directive here. This project's own
 * rule guidance argues against exactly that pattern — a suppression with no
 * stated reason and no end date is a permanent, unexplained exemption, which
 * is precisely the failure mode `notFixes` guidance calls out elsewhere.
 * `parseSuppression` is the only constructor of a `Suppression`, and it
 * refuses to build one without both a non-empty `reason` and a valid
 * `expires` date — so there is no path through this module that produces a
 * suppression missing either.
 *
 * A suppression takes one of two forms. Without a `fingerprint` it is a path
 * glob: it matches every occurrence of its rule under `target`, including
 * violations written after it was added. With a `fingerprint` it is pinned,
 * and then `target` is an exact repo-relative path and `occurrence` is
 * required, so the four identity fields spell out one `BaselineEntry` key
 * (see `identity.ts`) and the suppression can match at most one violation per
 * run. Requirement 4.3 states that a violation added to a file that already
 * has deferred ones must still be reported; the pinned form is what makes
 * that hold, because the count of hidden findings cannot grow when new code
 * is written.
 *
 * `occurrence` is required rather than optional because the fingerprint on its
 * own carries little information: it hashes the offending snippet, and an
 * analyzer often reports the same short snippet for every finding of a rule.
 * Every `no-any` finding in this repository, for instance, has the snippet
 * `any` and therefore one fingerprint, so a fingerprint without an occurrence
 * would cover a whole file.
 *
 * The three values a pinned suppression needs — `path`, `fingerprint`,
 * `occurrence` — are the ones `cyv baseline` writes into
 * `checkyourvibe.baseline.json`, and are copied from there.
 *
 * `loadSuppressions` reads `checkyourvibe.json` directly rather than through
 * `config/load.ts`. The original reason is gone — the schema once declared
 * `additionalProperties: false` with no `suppressions` key, and both it and
 * `CheckYourVibeConfig` carry `suppressions` now — but the direct read stays,
 * because routing through `loadConfig` changes how a malformed suppression is
 * reported.
 *
 * `loadConfig` validates the whole file against `config.schema.json`, and that
 * schema already constrains suppressions: `ruleId`, `target`, `reason` and
 * `expires` are required, `expires` and `fingerprint` carry regex patterns,
 * and `dependentRequired` ties `fingerprint` and `occurrence` to each other.
 * Ajv therefore rejects a bad suppression before `parseSuppression` sees it,
 * and the caller receives `ConfigError('INVALID')` carrying a JSON pointer
 * ("Config is invalid at /suppressions/0/reason: ...") instead of the
 * `SuppressionConfigError` raised below, which names the field, quotes the
 * value, and says to copy `path`, `fingerprint` and `occurrence` from the
 * finding's entry in `checkyourvibe.baseline.json`. The messages in
 * `test/baseline/suppressions.test.ts` are assertions on that second form.
 *
 * Two further differences come with the switch. `loadConfig` throws
 * `ConfigError('MISSING')` for an absent file where this function returns
 * `[]`, and it reads the schema off disk, so a checkout without a populated
 * `dist/schema/` would begin failing suppression loading.
 *
 * That leaves two readers of one file. The checks here are a superset of the
 * schema's: `parseSuppression` also rejects an `expires` that matches the date
 * pattern but is not a date `Date.parse` accepts, and a pinned `target`
 * carrying glob syntax. Both are conditions the schema does not express, so a
 * suppression this module accepts is one ajv accepts too.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import picomatch from 'picomatch';
import { isUnknownArray } from '../guards.js';
import type { Violation } from '../protocol/index.js';
import { CONFIG_FILENAME } from '../config/load.js';
import { computeEntries, entryKey } from './identity.js';
import type { BaselineEntry } from './types.js';
import { BASELINE_FILENAME } from './format.js';


interface SuppressionFields {
  ruleId: string;
  /** Repo-relative path or glob, matched against a violation's repo-relative path. */
  target: string;
  /** Why this violation is being deferred rather than fixed. Required, non-empty. */
  reason: string;
  /** ISO date (YYYY-MM-DD) after which this suppression stops suppressing. Required. */
  expires: string;
}

/**
 * A suppression whose `target` is a path glob. It matches every occurrence of
 * its rule under that path, including violations written after it.
 *
 * `fingerprint` and `occurrence` are declared as `undefined` rather than
 * omitted so that reading either property on a `Suppression` narrows the union
 * without a type guard at every call site.
 */
export interface BroadSuppression extends SuppressionFields {
  fingerprint?: undefined;
  occurrence?: undefined;
}

/**
 * A suppression that names one finding by the baseline's durable identity:
 * `target` is the entry's `path`, and `fingerprint` and `occurrence` are the
 * entry's own values. All four fields together are a `BaselineEntry` key, so a
 * pinned suppression can match at most one violation in a run.
 */
export interface PinnedSuppression extends SuppressionFields {
  /** SHA-256 fingerprint of the normalized offending snippet (see `identity.ts`). */
  fingerprint: string;
  /** Index among violations sharing this file, rule, and fingerprint. */
  occurrence: number;
}

export type Suppression = BroadSuppression | PinnedSuppression;

export function isPinnedSuppression(suppression: Suppression): suppression is PinnedSuppression {
  return suppression.fingerprint !== undefined;
}

export class SuppressionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SuppressionConfigError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isUnknownArray(value);
}

function hasErrorCode(value: unknown): value is { code: unknown } {
  return typeof value === 'object' && value !== null && 'code' in value;
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && hasErrorCode(err) && err.code === 'ENOENT';
}

function isValidDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

function isValidHexFingerprint(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/**
 * The characters picomatch reads as pattern syntax rather than as part of a
 * name, plus a leading `!`, which negates a pattern.
 */
function looksLikeGlob(target: string): boolean {
  return /[*?[\]{}]/.test(target) || target.startsWith('!');
}

/**
 * The repo-relative, forward-slash form of a pinned suppression's `target`,
 * so it can be compared against a `BaselineEntry.path`, which `identity.ts`
 * always produces in that form.
 */
function normalizeTarget(target: string): string {
  return target.replace(/\\/g, '/').replace(/^\.\//, '');
}

function parseSuppression(raw: unknown, index: number): Suppression {
  if (!isRecord(raw)) {
    throw new SuppressionConfigError(`suppressions[${index}] must be an object.`);
  }

  const { ruleId, target, reason, expires, fingerprint, occurrence } = raw;

  if (typeof ruleId !== 'string' || ruleId.length === 0) {
    throw new SuppressionConfigError(`suppressions[${index}] is missing a string "ruleId".`);
  }
  if (typeof target !== 'string' || target.length === 0) {
    throw new SuppressionConfigError(
      `suppressions[${index}] ("${ruleId}") is missing a string "target" glob.`,
    );
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new SuppressionConfigError(
      `suppressions[${index}] ("${ruleId}") is missing a non-empty "reason". ` +
        'A suppression must say why, not just that.',
    );
  }
  if (typeof expires !== 'string' || !isValidDateString(expires)) {
    throw new SuppressionConfigError(
      `suppressions[${index}] ("${ruleId}") is missing a valid "expires" date (YYYY-MM-DD). ` +
        'A suppression must say until when, or it is a permanent exemption in disguise.',
    );
  }

  if (fingerprint === undefined) {
    if (occurrence !== undefined) {
      throw new SuppressionConfigError(
        `suppressions[${index}] ("${ruleId}") has an "occurrence" without a "fingerprint": ` +
          'occurrence only pinpoints a specific duplicate when paired with a snippet fingerprint.',
      );
    }
    return { ruleId, target, reason, expires };
  }

  if (typeof fingerprint !== 'string' || !isValidHexFingerprint(fingerprint)) {
    throw new SuppressionConfigError(
      `suppressions[${index}] ("${ruleId}") has an invalid "fingerprint": ` +
        'it must be a 64-character lowercase hex SHA-256 string.',
    );
  }
  if (occurrence === undefined) {
    throw new SuppressionConfigError(
      `suppressions[${index}] ("${ruleId}") has a "fingerprint" without an "occurrence". ` +
        'A fingerprint alone covers every identical snippet in the matched files, and many ' +
        'rules report the same short snippet everywhere, so it would defer more than one ' +
        `finding. Copy "path", "fingerprint" and "occurrence" from the entry in ${BASELINE_FILENAME}.`,
    );
  }
  if (typeof occurrence !== 'number' || !Number.isInteger(occurrence) || occurrence < 0) {
    throw new SuppressionConfigError(
      `suppressions[${index}] ("${ruleId}") has an invalid "occurrence": ` +
        'it must be a non-negative integer.',
    );
  }
  if (looksLikeGlob(target)) {
    throw new SuppressionConfigError(
      `suppressions[${index}] ("${ruleId}") pins a fingerprint but its "target" ("${target}") ` +
        'is a glob. A pinned suppression names one finding, so its target is the exact ' +
        `repo-relative path of the file holding it — the "path" of the entry in ${BASELINE_FILENAME}.`,
    );
  }

  return { ruleId, target, reason, expires, fingerprint, occurrence };
}

/**
 * Read the `suppressions` array from `checkyourvibe.json`, independent of
 * `config/load.ts` (see the module doc for why). Returns `[]` when the config
 * file has no `suppressions` key, or does not exist at all — the same
 * "nothing configured yet" state `loadConfig` treats as its own separate
 * `MISSING` error, but suppressions are optional where a whole config is not.
 */
export async function loadSuppressions(repoRoot: string): Promise<Suppression[]> {
  let raw: string;
  try {
    raw = await readFile(join(repoRoot, CONFIG_FILENAME), 'utf-8');
  } catch (err) {
    if (isEnoent(err)) {
      return [];
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SuppressionConfigError(
      `Invalid JSON in ${CONFIG_FILENAME}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!isRecord(parsed) || parsed.suppressions === undefined) {
    return [];
  }

  const { suppressions } = parsed;
  if (!isUnknownArray(suppressions)) {
    throw new SuppressionConfigError(`"suppressions" in ${CONFIG_FILENAME} must be an array.`);
  }

  return suppressions.map((entry: unknown, i: number) => parseSuppression(entry, i));
}

/**
 * A suppression naming a rule that does not exist is a configuration error
 * (Requirement 3.5) — almost always a rule rename nobody propagated, not a
 * deliberate choice, and it should stop the run rather than silently doing
 * nothing.
 */
export function validateSuppressionRules(
  suppressions: readonly Suppression[],
  knownRuleIds: ReadonlySet<string>,
): void {
  for (const suppression of suppressions) {
    if (!knownRuleIds.has(suppression.ruleId)) {
      throw new SuppressionConfigError(
        `Suppression targets unknown rule "${suppression.ruleId}" (target "${suppression.target}"). ` +
          'This usually means the rule was renamed and the suppression was not updated.',
      );
    }
  }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function expiryDate(suppression: Suppression): Date {
  return new Date(`${suppression.expires}T00:00:00Z`);
}

function daysUntil(target: Date, now: Date): number {
  return (target.getTime() - now.getTime()) / MS_PER_DAY;
}

export interface SuppressionEvaluation {
  /** Violations matched by an active (non-expired) suppression. */
  suppressed: Violation[];
  /** Violations not suppressed — either unmatched, or matched only by an expired suppression. */
  reported: Violation[];
  /** Count of suppressions that are not expired as of `now` (Requirement 3.4). */
  activeCount: number;
  /** Count of active suppressions expiring within 30 days of `now` (Requirement 3.4). */
  expiringWithin30DaysCount: number;
  /**
   * Suppressions that have expired. An expired suppression stops suppressing
   * — its violation is reported again — and is named specifically here so
   * output can call it out by rule, target, and reason (Requirement 3.3).
   */
  expired: Suppression[];
  /** Violations suppressed by a path-glob suppression that does not pin a specific finding. */
  broadSuppressed: Violation[];
  /** Violations suppressed by a suppression that pins a specific (path, rule, fingerprint, occurrence) finding. */
  pinnedSuppressed: Violation[];
}

/**
 * The line that keeps suppressions honest.
 *
 * Printed on every run, because a suppression is a deferral and a deferred
 * finding must never be invisible (Requirement 4.4). It states the active and
 * expiring counts (Requirement 3.4) and how many findings were suppressed this
 * run, so a passing exit code can never be read as "nothing to fix".
 *
 * This lives in the baseline module so the CLI and other callers share one
 * source of truth for the wording.
 */
export function suppressionNotice(
  evaluation: SuppressionEvaluation,
  expired: Suppression[],
  active: readonly Suppression[],
): string {
  const activeWord = evaluation.activeCount === 1 ? 'suppression' : 'suppressions';
  const findingWord = evaluation.suppressed.length === 1 ? 'finding' : 'findings';

  const lines: string[] = [
    `  ${evaluation.activeCount} active ${activeWord}, ` +
      `${evaluation.expiringWithin30DaysCount} expiring within 30 days. ` +
      `${evaluation.suppressed.length} ${findingWord} suppressed this run.`,
  ];

  // A suppression with a `fingerprint` names one specific finding. One without
  // is a path glob: it hides every occurrence of that rule under the path,
  // including any written tomorrow, and the person who wrote it may not have
  // meant that. Requirement 4.3 calls per-file suppression "how baselines become
  // permanent", so the two must not read alike — and the first use of this
  // feature in this repository was exactly a wholesale glob over an entire
  // source tree.
  const broad = active.filter((s) => s.fingerprint === undefined);
  if (broad.length > 0) {
    lines.push(
      `  ${broad.length} of those ${broad.length === 1 ? 'is' : 'are'} unpinned — they suppress ` +
        'every occurrence of their rule under a path, including findings not yet written:',
    );
    for (const suppression of broad) {
      lines.push(`    ${suppression.ruleId} on "${suppression.target}" — ${suppression.reason}`);
    }
  }

  if (expired.length > 0) {
    lines.push(`  ${expired.length} suppression(s) have EXPIRED and no longer suppress anything:`);
    for (const suppression of expired) {
      lines.push(
        `    ${suppression.ruleId} on "${suppression.target}" expired ${suppression.expires} — ${suppression.reason}`,
      );
    }
  }

  return lines.join('\n');
}

/** Which kind of suppression covers a finding. */
export type SuppressionCoverage = 'broad' | 'pinned';

/**
 * Compile `suppressions` into the single test applied to a finding's identity.
 *
 * A pinned suppression is matched by `entryKey` — the same key the baseline
 * compares entries with — so it matches only when the path, rule, fingerprint
 * and occurrence all agree, and therefore matches at most one finding. A broad
 * suppression has no fingerprint and is matched by its `target` glob and rule id
 * alone, so it covers every occurrence of that rule under the path, including
 * ones written later. A finding matched by both reads as pinned, since the
 * pinned suppression names it exactly.
 *
 * Returned as a closure so each `target` glob is compiled once for the whole
 * set of findings rather than once per finding. Callers pass only suppressions
 * they have already decided are active; expiry is not re-checked here.
 */
export function suppressionCoverage(
  suppressions: readonly Suppression[],
): (entry: Pick<BaselineEntry, 'path' | 'ruleId' | 'fingerprint' | 'occurrence'>) =>
  | SuppressionCoverage
  | undefined {
  const pinnedKeys = new Set<string>();
  const broadMatchers: { ruleId: string; isMatch: (path: string) => boolean }[] = [];

  for (const suppression of suppressions) {
    if (isPinnedSuppression(suppression)) {
      pinnedKeys.add(
        entryKey({
          path: normalizeTarget(suppression.target),
          ruleId: suppression.ruleId,
          fingerprint: suppression.fingerprint,
          occurrence: suppression.occurrence,
        }),
      );
    } else {
      broadMatchers.push({
        ruleId: suppression.ruleId,
        isMatch: picomatch(suppression.target, { dot: true }),
      });
    }
  }

  return (entry) => {
    if (pinnedKeys.has(entryKey(entry))) {
      return 'pinned';
    }
    const coveredBroadly = broadMatchers.some(
      (matcher) => matcher.ruleId === entry.ruleId && matcher.isMatch(entry.path),
    );
    return coveredBroadly ? 'broad' : undefined;
  };
}

/**
 * Apply `suppressions` to `violations`.
 *
 * Matching is `suppressionCoverage`'s; see it for how a pinned suppression
 * differs from a broad one.
 *
 * Path-glob suppressions remain useful for adoption, and the result splits the
 * suppressed set into `broadSuppressed` and `pinnedSuppressed` so a caller can
 * report the two differently.
 *
 * A violation whose file lies outside `repoRoot` has no repo-relative identity
 * and is never suppressed; `computeEntries` drops it and it flows through to
 * `reported`.
 *
 * Expired suppressions are excluded from matching entirely (their violations
 * flow through to `reported`) and are surfaced separately in `expired`, named,
 * so a run states specifically which suppression lapsed rather than just a
 * count going up.
 */
export function evaluateSuppressions(
  violations: readonly Violation[],
  suppressions: readonly Suppression[],
  repoRoot: string,
  now: Date = new Date(),
): SuppressionEvaluation {
  const active: Suppression[] = [];
  const expired: Suppression[] = [];

  for (const suppression of suppressions) {
    if (expiryDate(suppression).getTime() < now.getTime()) {
      expired.push(suppression);
    } else {
      active.push(suppression);
    }
  }

  const expiringWithin30DaysCount = active.filter(
    (suppression) => daysUntil(expiryDate(suppression), now) <= 30,
  ).length;

  const covers = suppressionCoverage(active);

  const suppressed = new Set<Violation>();
  const broadSuppressed: Violation[] = [];
  const pinnedSuppressed: Violation[] = [];

  for (const { entry, violation } of computeEntries(violations, repoRoot)) {
    const coverage = covers(entry);
    if (coverage === 'pinned') {
      suppressed.add(violation);
      pinnedSuppressed.push(violation);
    } else if (coverage === 'broad') {
      suppressed.add(violation);
      broadSuppressed.push(violation);
    }
  }

  const reported: Violation[] = [];
  for (const violation of violations) {
    if (!suppressed.has(violation)) {
      reported.push(violation);
    }
  }

  return {
    suppressed: [...suppressed],
    reported,
    activeCount: active.length,
    expiringWithin30DaysCount,
    expired,
    broadSuppressed,
    pinnedSuppressed,
  };
}
