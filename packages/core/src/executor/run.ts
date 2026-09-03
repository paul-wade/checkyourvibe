/**
 * Running one dispatch end to end (spec 0011 Requirements 2.2, 2.5, 2.6, 4.1,
 * 6.4).
 *
 * The sequence is fixed: append the `opened` entry, snapshot the observed
 * scope, run the executor, snapshot again, diff the two snapshots, run the
 * gates, classify, append the `closed` entry. The dispatch is therefore
 * readable from disk while it is running and after it ends, with no dependency
 * on the session that started it (Requirement 6.4).
 *
 * The child's exit code is recorded in the report and never consulted here.
 * `classifyOutcome` reads the changed-file set the two snapshots produced, so an
 * executor that exits 0 having written nothing closes as `produced-nothing`
 * (Requirement 2.3) and an executor that writes outside its declared ownership
 * closes as `out-of-scope-write` (Requirement 2.5).
 *
 * The observed scope is wider than the declared ownership set, and defaults to
 * the repository root. A write outside the observed scope is invisible to the
 * diff, so the scope is what bounds the out-of-scope-write check.
 */
import { runChild, reportFromObservation, type ChildCommand, type ChildObservation, type RateLimitDetector } from './child.js';
import {
  classifyOutcome,
  diffSnapshots,
  type ExecutorReport,
  type GateResult,
} from './outcome.js';
import {
  discardSnapshot,
  loadSnapshot,
  persistSnapshot,
  takeSnapshot,
  type SnapshotOptions,
} from './snapshot.js';
import { splitGeneratedPaths } from './ignored.js';
import { closeDispatch, openDispatch } from './store.js';
import type {
  DispatchAssignment,
  DispatchClosed,
  DispatchDeclaration,
  DispatchOpened,
  Escalation,
} from './dispatch.js';

/** The scope snapshotted when a caller names none: the whole repository. */
export const DEFAULT_OBSERVED_SCOPE: readonly string[] = ['.'];

/** What a gate is given to judge the finished dispatch. */
export interface GateContext {
  repoRoot: string;
  dispatchId: string;
  declaration: DispatchDeclaration;
  assignment: DispatchAssignment;
  /** Observed from the two snapshots, repo-relative. */
  changedPaths: readonly string[];
  observation: ChildObservation;
}

/** Runs one named gate. Spec 0011 leaves where gate names are authored open. */
export type GateRunner = (gate: string, context: GateContext) => Promise<GateResult> | GateResult;

const NO_RUNNER_DETAIL = 'no runner was supplied for this gate, so it did not run';

export interface DispatchRunRequest {
  repoRoot: string;
  dispatchId: string;
  /** Shared by every attempt at one unit of work (Requirement 9.4). */
  workId: string;
  attempt: number;
  declaration: DispatchDeclaration;
  assignment: DispatchAssignment;
  /** Present on an attempt that followed another (Requirement 3.4). */
  escalation?: Escalation;
  command: ChildCommand;
  /** Paths snapshotted before and after. Defaults to `DEFAULT_OBSERVED_SCOPE`. */
  observedScope?: readonly string[];
  snapshot?: SnapshotOptions;
  gateRunner?: GateRunner;
  detectRateLimit?: RateLimitDetector;
  /** Supplies the two timestamps written to the log. Defaults to the wall clock. */
  now?: () => Date;
}

export interface DispatchRunResult {
  opened: DispatchOpened;
  closed: DispatchClosed;
  observation: ChildObservation;
  /**
   * The diff of the two snapshots that the repository does not ignore. This is
   * what ownership is judged against and what the gates are given.
   */
  changedPaths: readonly string[];
  /**
   * Changed paths the repository ignores — build output and caches, usually
   * written by a gate rather than by the executor. Reported rather than
   * silently dropped: a dispatch writing into a build directory is worth
   * knowing about even though it is not an ownership violation.
   */
  generatedPaths: readonly string[];
  /** Present when git could not be asked which paths are ignored. */
  generatedUndetermined?: string;
  /** The scope the two snapshots covered. */
  observedScope: readonly string[];
}

/**
 * Run every named gate in order.
 *
 * A gate with no runner and a gate whose runner throws are both recorded as
 * failed with a detail naming what happened, so a dispatch is never classified
 * as though a gate it declared had passed.
 */
async function runGates(
  gates: readonly string[],
  context: GateContext,
  runner?: GateRunner,
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const gate of gates) {
    if (runner === undefined) {
      results.push({ gate, passed: false, detail: NO_RUNNER_DETAIL });
      continue;
    }
    try {
      results.push(await runner(gate, context));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      results.push({ gate, passed: false, detail: `the gate runner threw: ${reason}` });
    }
  }
  return results;
}

/**
 * Bracket one executor run with its `opened` and `closed` entries and classify
 * what it did from the file system.
 */
export async function runDispatch(request: DispatchRunRequest): Promise<DispatchRunResult> {
  const now = request.now ?? ((): Date => new Date());
  const observedScope = request.observedScope ?? DEFAULT_OBSERVED_SCOPE;
  const snapshotOptions = request.snapshot ?? {};

  const opened = await openDispatch(request.repoRoot, {
    dispatchId: request.dispatchId,
    workId: request.workId,
    attempt: request.attempt,
    openedAt: now().toISOString(),
    declaration: request.declaration,
    assignment: request.assignment,
    ...(request.escalation === undefined ? {} : { escalation: request.escalation }),
  });

  const before = await takeSnapshot(request.repoRoot, observedScope, snapshotOptions);
  const observation = await runChild({
    ...request.command,
    cwd: request.command.cwd ?? request.repoRoot,
  });
  const after = await takeSnapshot(request.repoRoot, observedScope, snapshotOptions);
  // The raw diff includes anything a gate generated. Ownership is a claim about
  // what the executor authored, so the two are separated before it is judged.
  const split = await splitGeneratedPaths(request.repoRoot, diffSnapshots(before, after));
  const changedPaths = split.authored;

  const report = reportFromObservation(observation, request.detectRateLimit);
  const gateResults = await runGates(
    request.declaration.gates,
    {
      repoRoot: request.repoRoot,
      dispatchId: request.dispatchId,
      declaration: request.declaration,
      assignment: request.assignment,
      changedPaths,
      observation,
    },
    request.gateRunner,
  );

  const outcome = classifyOutcome({
    expectsFileChanges: request.declaration.expectsFileChanges,
    ownedPaths: request.declaration.ownedPaths,
    changedPaths,
    gates: gateResults,
    report,
  });

  const closed = await closeDispatch(request.repoRoot, {
    dispatchId: request.dispatchId,
    closedAt: now().toISOString(),
    report,
    gateResults,
    outcome,
  });

  return {
    opened,
    closed,
    observation,
    changedPaths,
    generatedPaths: split.generated,
    ...(split.undetermined === undefined ? {} : { generatedUndetermined: split.undetermined }),
    observedScope,
  };
}

/**
 * Open a dispatch the orchestrating session will execute itself, and stop
 * (spec 0041 Requirement 2.3).
 *
 * The record is opened and the before snapshot is taken and persisted, exactly
 * as `runDispatch` does. Nothing is spawned: the work is done by the caller,
 * between this call and `closeOpenedDispatch`. The dispatch is open in the log
 * from this moment, so it counts against the caps and is judged for liveness
 * like any other (Requirement 2.5) — a session that dies mid-task leaves an
 * abandoned record rather than an open one.
 */
export interface SelfDispatchOpenRequest {
  repoRoot: string;
  dispatchId: string;
  workId: string;
  attempt: number;
  declaration: DispatchDeclaration;
  assignment: DispatchAssignment;
  escalation?: Escalation;
  observedScope?: readonly string[];
  snapshot?: SnapshotOptions;
  now?: () => Date;
}

export interface SelfDispatchOpenResult {
  opened: DispatchOpened;
  observedScope: readonly string[];
  /** Where the before snapshot was written. */
  snapshotPath: string;
}

export async function openSelfDispatch(
  request: SelfDispatchOpenRequest,
): Promise<SelfDispatchOpenResult> {
  const now = request.now ?? ((): Date => new Date());
  const observedScope = request.observedScope ?? DEFAULT_OBSERVED_SCOPE;

  const opened = await openDispatch(request.repoRoot, {
    dispatchId: request.dispatchId,
    workId: request.workId,
    attempt: request.attempt,
    openedAt: now().toISOString(),
    declaration: request.declaration,
    assignment: request.assignment,
    ...(request.escalation === undefined ? {} : { escalation: request.escalation }),
  });

  const before = await takeSnapshot(request.repoRoot, observedScope, request.snapshot ?? {});
  const path = await persistSnapshot(request.repoRoot, request.dispatchId, {
    snapshot: before,
    observedScope,
  });

  return { opened, observedScope, snapshotPath: path };
}

export interface SelfDispatchCloseRequest {
  repoRoot: string;
  dispatchId: string;
  declaration: DispatchDeclaration;
  assignment: DispatchAssignment;
  snapshot?: SnapshotOptions;
  gateRunner?: GateRunner;
  now?: () => Date;
}

export type SelfDispatchCloseResult =
  | { closed: true; result: Omit<DispatchRunResult, 'opened'> & { closed: DispatchClosed } }
  | { closed: false; reason: string };

/**
 * Close a dispatch opened by `openSelfDispatch`, judging it by what changed
 * (spec 0041 Requirement 2.3).
 *
 * The after snapshot is taken against the scope the first phase recorded, so
 * the two halves compare the same ground even if the caller passes different
 * arguments. With no persisted snapshot there is nothing to diff and this
 * refuses: an outcome derived from a comparison that never happened would be a
 * fabricated finding about the run itself.
 *
 * The executor's report is `success` with no exit code, because there was no
 * child to produce one. What that records is the session's claim to have
 * finished — the same claim a CLI makes by exiting 0. Whether anything was
 * actually accomplished is decided by `classifyOutcome` from the changed files
 * and the gates, which is the observed-effect rule (0011 Requirement 2) and the
 * reason a claim of success is not taken at face value from any executor.
 */
export async function closeSelfDispatch(
  request: SelfDispatchCloseRequest,
): Promise<SelfDispatchCloseResult> {
  const now = request.now ?? ((): Date => new Date());
  const persisted = await loadSnapshot(request.repoRoot, request.dispatchId);
  if (persisted === undefined) {
    return {
      closed: false,
      reason:
        `no before-snapshot is recorded for dispatch "${request.dispatchId}". ` +
        'It was never opened for self-execution, or it has already been closed. Without the ' +
        'snapshot there is nothing to compare the repository against, so no outcome can be ' +
        'judged.',
    };
  }

  const after = await takeSnapshot(
    request.repoRoot,
    persisted.observedScope,
    request.snapshot ?? {},
  );
  const split = await splitGeneratedPaths(
    request.repoRoot,
    diffSnapshots(persisted.snapshot, after),
  );
  const changedPaths = split.authored;

  const observation: ChildObservation = {
    timedOut: false,
    stdout: '',
    stderr: '',
  };
  const report: ExecutorReport = {
    status: 'success',
    rateLimited: false,
    detail: 'run by the orchestrating session as a sub-agent; no child process was spawned',
  };

  const gateResults = await runGates(
    request.declaration.gates,
    {
      repoRoot: request.repoRoot,
      dispatchId: request.dispatchId,
      declaration: request.declaration,
      assignment: request.assignment,
      changedPaths,
      observation,
    },
    request.gateRunner,
  );

  const outcome = classifyOutcome({
    expectsFileChanges: request.declaration.expectsFileChanges,
    ownedPaths: request.declaration.ownedPaths,
    changedPaths,
    gates: gateResults,
    report,
  });

  const closed = await closeDispatch(request.repoRoot, {
    dispatchId: request.dispatchId,
    closedAt: now().toISOString(),
    report,
    gateResults,
    outcome,
  });

  await discardSnapshot(request.repoRoot, request.dispatchId);

  return {
    closed: true,
    result: {
      closed,
      observation,
      changedPaths,
      generatedPaths: split.generated,
      ...(split.undetermined === undefined ? {} : { generatedUndetermined: split.undetermined }),
      observedScope: persisted.observedScope,
    },
  };
}
