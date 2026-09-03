/**
 * What actually happened to a dispatch (spec 0011 Requirement 2).
 *
 * Success is determined by observed effect: whether the files the dispatch
 * declared it owns changed on disk, and whether the gates named for it passed
 * (Requirement 2.2). The executor's exit code and its own status output are
 * recorded but never decide the result (Requirement 2.1), and the changed-file
 * set is computed by comparing the file system before and after rather than by
 * parsing what the executor said it did (Requirement 2.6).
 *
 * One outcome exists because both other outcomes would lose information about
 * it: a dispatch that reported success and changed none of its declared files
 * is `produced-nothing` (Requirement 2.3), which says the harness failed rather
 * than the task.
 */
import { ownsPath } from './ownership.js';

/** One gate named for a dispatch, and whether it passed against the result. */
export interface GateResult {
  gate: string;
  passed: boolean;
  /** One line of context. Absent when the gate said nothing beyond pass or fail. */
  detail?: string;
}

/**
 * What the executor said about its own run.
 *
 * Recorded so a dispatch record can show it, and used for exactly two things:
 * distinguishing `produced-nothing` from an ordinary failure (Requirement 2.3
 * scopes that outcome to a dispatch the executor reported as successful), and
 * the explicit rate-limit error Requirement 3.3 names as an escalation trigger.
 * It is not evidence that files changed.
 */
export interface ExecutorReport {
  status: 'success' | 'failure' | 'did-not-complete';
  /** The child's exit code, where the executor produced one. */
  exitCode?: number;
  /** The executor surfaced an explicit rate-limit error (Requirement 3.3). */
  rateLimited: boolean;
  /** One line, for the record. */
  detail?: string;
  /**
   * What the executor wrote, truncated (spec 0036 Requirement 11).
   *
   * The child's streams are the only account of why a dispatch did what it did,
   * and `produced-nothing` — the outcome that puts a lane in cooldown — is
   * exactly the case where the record otherwise says nothing at all. Absent
   * when the executor wrote to neither stream.
   */
  output?: ExecutorOutput;
}

/** An executor's captured streams, with any truncation stated. */
export interface ExecutorOutput {
  stdout?: string;
  stderr?: string;
  /**
   * The original length of a stream that was truncated, by stream. Present only
   * for a stream that did not fit, so a reader is never left guessing whether
   * what they are looking at is the whole of it.
   */
  truncatedFrom?: { stdout?: number; stderr?: number };
}

export type DispatchOutcomeKind =
  /** Declared files changed (or none were expected) and every gate passed. */
  | 'succeeded'
  /** The executor reported success and none of its declared files changed (Requirement 2.3). */
  | 'produced-nothing'
  /** The dispatch declared it expected no file changes and changed files anyway (Requirement 2.7). */
  | 'changed-files-unexpectedly'
  /** A path outside the declared ownership set was written (Requirement 2.5). */
  | 'out-of-scope-write'
  /** Files changed as expected and at least one gate failed. */
  | 'gates-failed'
  /** The executor surfaced an explicit rate-limit error (Requirement 3.3). */
  | 'rate-limited'
  /** The executor reported failure and produced no change. */
  | 'failed'
  /** The dispatch neither completed nor reported an error. */
  | 'did-not-complete';

export interface DispatchOutcome {
  kind: DispatchOutcomeKind;
  /** One line naming what was observed. */
  summary: string;
  /** Paths observed to have changed, repo-relative. */
  changedPaths: readonly string[];
  /** Changed paths no declared owned path covers (Requirement 2.5). */
  outOfScopePaths: readonly string[];
  /** Names of the gates that did not pass. */
  failedGates: readonly string[];
}

/** The changed-file set split against the declared ownership set. */
export interface ObservedEffect {
  changedPaths: readonly string[];
  outOfScopePaths: readonly string[];
}

/**
 * Compare two file-system snapshots and return every path whose content
 * differs, including paths added and paths removed. A snapshot maps a
 * repo-relative path to a digest of its contents; taking one is the dispatch
 * layer's job, comparing two is not.
 */
export function diffSnapshots(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  const changed = new Set<string>();
  for (const [path, digest] of before) {
    if (after.get(path) !== digest) changed.add(path);
  }
  for (const [path, digest] of after) {
    if (before.get(path) !== digest) changed.add(path);
  }
  return [...changed].sort();
}

/** Split observed changes into in-scope and out-of-scope against the declaration. */
export function observeEffect(
  changedPaths: readonly string[],
  ownedPaths: readonly string[],
): ObservedEffect {
  return {
    changedPaths: [...changedPaths],
    outOfScopePaths: changedPaths.filter((path) => !ownsPath(ownedPaths, path)),
  };
}

export interface OutcomeInput {
  /**
   * Declared when the work was dispatched, never inferred afterwards from what
   * happened (Requirement 2.7).
   */
  expectsFileChanges: boolean;
  /** The declared ownership set, repo-relative (Requirement 4.2). */
  ownedPaths: readonly string[];
  /** Observed from the file system, not from the executor's output (Requirement 2.6). */
  changedPaths: readonly string[];
  gates: readonly GateResult[];
  report: ExecutorReport;
}

/**
 * Classify one finished dispatch.
 *
 * An out-of-scope write is checked first because Requirement 2.5 makes it a
 * failure regardless of the exit code or the gate results.
 */
export function classifyOutcome(input: OutcomeInput): DispatchOutcome {
  const effect = observeEffect(input.changedPaths, input.ownedPaths);
  const failedGates = input.gates.filter((gate) => !gate.passed).map((gate) => gate.gate);
  const base = {
    changedPaths: effect.changedPaths,
    outOfScopePaths: effect.outOfScopePaths,
    failedGates,
  };

  if (effect.outOfScopePaths.length > 0) {
    return {
      ...base,
      kind: 'out-of-scope-write',
      summary: `wrote outside its declared ownership: ${effect.outOfScopePaths.join(', ')}`,
    };
  }

  if (input.report.status === 'did-not-complete') {
    return {
      ...base,
      kind: 'did-not-complete',
      summary: 'the dispatch neither completed nor reported an error',
    };
  }

  if (input.report.rateLimited) {
    return {
      ...base,
      kind: 'rate-limited',
      summary: 'the executor reported an explicit rate-limit error',
    };
  }

  if (!input.expectsFileChanges) {
    if (effect.changedPaths.length > 0) {
      return {
        ...base,
        kind: 'changed-files-unexpectedly',
        summary: `declared no expected file changes and changed ${effect.changedPaths.length} file(s)`,
      };
    }
    return failedGates.length > 0
      ? { ...base, kind: 'gates-failed', summary: `gates failed: ${failedGates.join(', ')}` }
      : { ...base, kind: 'succeeded', summary: 'no file changes expected and every gate passed' };
  }

  if (effect.changedPaths.length === 0) {
    return input.report.status === 'success'
      ? {
          ...base,
          kind: 'produced-nothing',
          summary: 'the executor reported success and none of its declared files changed',
        }
      : {
          ...base,
          kind: 'failed',
          summary: 'the executor reported failure and none of its declared files changed',
        };
  }

  return failedGates.length > 0
    ? { ...base, kind: 'gates-failed', summary: `gates failed: ${failedGates.join(', ')}` }
    : {
        ...base,
        kind: 'succeeded',
        summary: `changed ${effect.changedPaths.length} declared file(s) and every gate passed`,
      };
}

/**
 * An observed-effect success as Requirement 2.2 defines it: declared files
 * changed and the gates passed. This is the only thing that clears a lane's
 * cooldown (Requirement 7.5), so a gate-only success on a dispatch that
 * expected no file changes does not qualify.
 */
export function isObservedEffectSuccess(outcome: DispatchOutcome): boolean {
  return outcome.kind === 'succeeded' && outcome.changedPaths.length > 0;
}

/**
 * Outcomes consistent with rate exhaustion, which put the lane into cooldown
 * (Requirement 7.4) and make the unit of work a candidate for escalation to a
 * second lane (Requirement 3.3).
 */
export function indicatesRateExhaustion(outcome: DispatchOutcome): boolean {
  return outcome.kind === 'produced-nothing' || outcome.kind === 'rate-limited';
}

/**
 * Outcomes a surface shows without the user opening a dispatch record
 * (Requirement 10.4).
 */
export function needsHumanAttention(outcome: DispatchOutcome): boolean {
  return (
    outcome.kind === 'produced-nothing' ||
    outcome.kind === 'out-of-scope-write' ||
    outcome.kind === 'changed-files-unexpectedly' ||
    outcome.kind === 'did-not-complete'
  );
}
