/**
 * The executor surface's localhost view, as a shape to render (spec 0011
 * Requirement 10).
 *
 * Everything here is folded out of the dispatch log the executor layer already
 * wrote to disk. No executor is spawned, no vendor account is queried, and
 * nothing is derived that a record does not carry (Requirement 10.1): the
 * running count on a lane is that lane's open records, cooldown is `replay.ts`
 * replaying closed outcomes, and every model, task kind, escalation and outcome
 * is copied out of an entry. The same discipline `dashboard/model.ts` follows
 * for rule manifests — render what was recorded, never re-run the thing that
 * recorded it.
 *
 * Two numbers are absent because no source supplies them honestly. A
 * subscription's remaining quota is not observable through an authenticated CLI
 * (Requirement 7.1), so there is no field for a percentage or a fraction of an
 * account's real limit; the only capacity figure here is declared headroom
 * against a self-imposed cap, and `LaneCapSource` records where that cap came
 * from. What a dispatch cost is likewise not observable (Requirements 9.6, 9.7),
 * so no dollar figure or token count appears in this model — the lane and model
 * names are recorded instead, so the vendor's own billing surface can be read.
 *
 * Requirement 6.4: this reads from disk alone, so the state renders whole with
 * the orchestrating session that wrote it gone.
 */
import { access } from 'node:fs/promises';

import {
  describeLane,
  laneBillingLabel,
  type LaneCooldown,
  type LaneDeclaration,
} from '../executor/lane.js';
import { cooldownOn, inFlightOn, replayLaneRuntimes } from '../executor/replay.js';
import { needsHumanAttention, type DispatchOutcome } from '../executor/outcome.js';
import { isInFlight } from '../executor/dispatch.js';
import type {
  DispatchAssignment,
  DispatchRecord,
  DispatchRefused,
  SchedulingRefusal,
} from '../executor/dispatch.js';
import {
  dispatchLogPath,
  readDispatchLog,
  type DispatchLog,
  type ReadDispatchStats,
} from '../executor/store.js';
import type { TaskKind } from '../executor/task-kind.js';

/** Completed dispatches the view shows before it starts reporting a remainder. */
export const MAX_COMPLETED_SHOWN = 12;

/**
 * Where a lane's declared concurrency cap came from.
 *
 * The cap is a declared, human-tuned number (Requirement 3.1), so the view can
 * only show one it was given or one the log recorded. `unrecorded` is rendered
 * as a running count with no denominator rather than as a guess.
 */
export type LaneCapSource =
  /** A lane declaration the caller supplied. */
  | 'declaration'
  /** A scheduling refusal in the log named this lane as at its cap and carried the number. */
  | 'recorded-refusal'
  /** Neither; no cap for this lane is on hand. */
  | 'unrecorded';

/** Declared headroom's two halves, kept apart from any claim about the account (Requirement 10.5). */
export interface LaneConcurrencyView {
  /** Dispatches opened on this lane with no close entry. Counted from the log. */
  running: number;
  /** The lane's declared cap, when `source` is not `unrecorded`. */
  declaredCap?: number;
  source: LaneCapSource;
}

export interface ExecutorLaneView {
  laneId: string;
  /**
   * `describeLane` for a lane the caller declared, which already carries the
   * lane's billing. A lane known only from the log gets the bare id here and
   * the same billing fact from `billingLabel`, so neither is stated twice.
   */
  label: string;
  /** `laneBillingLabel` of the lane's last recorded assignment; absent for a declared lane. */
  billingLabel?: string;
  /** The `AgentPlugin.id` behind the lane, where a declaration or a record names it. */
  agentId?: string;
  /** True for the lane that is the agent session issuing dispatches (Requirement 6.1). */
  orchestrator: boolean;
  concurrency: LaneConcurrencyView;
  /** Present while the lane is in cooldown (Requirement 7.4). */
  cooldown?: LaneCooldown;
  /**
   * The lane is running its declared cap (Requirement 3.2). Held apart from
   * `cooldown` because the two look alike from outside and mean different
   * things (Requirement 10.3).
   */
  atCap: boolean;
  /** Whether a lane declaration was supplied for this lane. */
  declared: boolean;
  /**
   * A scheduling refusal in the log recorded this lane as passed over for being
   * metered (Requirement 1.5). It is the only billing fact available for a lane
   * that has never run a dispatch, and Requirement 1.4 requires a metered lane
   * to be labelled wherever it is named.
   */
  meteredNotNamed: boolean;
  /** Whether the log holds any dispatch that ran on this lane. */
  hasRecords: boolean;
}

/** Why one entry is on the list a person has to read (Requirement 10.4). */
export type AttentionCause =
  | { kind: 'outcome'; outcome: DispatchOutcome; assignment: DispatchAssignment }
  | { kind: 'refusal'; refusal: SchedulingRefusal };

export interface DispatchAttention {
  dispatchId: string;
  workId: string;
  /** ISO 8601: the close time for an outcome, the refusal time for a refusal. */
  at: string;
  task: string;
  taskKind: TaskKind;
  cause: AttentionCause;
}

export interface ExecutorDispatches {
  kind: 'dispatches';
  lanes: ExecutorLaneView[];
  /** Open records, newest first. */
  inFlight: DispatchRecord[];
  /** Closed records, newest first, at most `MAX_COMPLETED_SHOWN`. */
  completed: DispatchRecord[];
  /** Everything Requirement 10.4 names, newest first. */
  attention: DispatchAttention[];
  recordCount: number;
  refusalCount: number;
  /** Closed records past `MAX_COMPLETED_SHOWN` that the view is not listing. */
  omittedCompleted: number;
  /** Lines in the log that no entry shape accepted. */
  unparseableLines: number;
}

/**
 * No dispatch has been recorded.
 *
 * `logPresent` separates a repository that never dispatched anything from a log
 * that holds no readable entry — two different facts, and the page says which.
 *
 * `declaredLanes` carries the lane declarations the caller supplied, so a
 * repository that declared lanes and has not dispatched yet can be shown its
 * configuration instead of an empty page. These are declarations, not runtime
 * state: they are held apart from `ExecutorDispatches.lanes`, which is folded
 * out of records, so nothing here can be read as something having run.
 */
export interface ExecutorNoDispatches {
  kind: 'no-dispatches';
  logPresent: boolean;
  /** Present only when at least one lane was declared. */
  declaredLanes?: readonly LaneDeclaration[];
}

export type ExecutorView = ExecutorNoDispatches | ExecutorDispatches;

export interface ExecutorViewInput {
  log: DispatchLog;
  /**
   * Lane declarations, where the caller has them. Supplying one is what makes a
   * lane's declared cap exact; without any, caps come from what the log
   * recorded, or are shown as not on hand.
   */
  lanes?: readonly LaneDeclaration[];
  logPresent?: boolean;
  unparseableLines?: number;
}

/** Every lane id the log names, whether as an assignment, an escalation source, or a rejection. */
function laneIdsIn(log: DispatchLog): string[] {
  const ids = new Set<string>();
  for (const record of log.records) {
    ids.add(record.assignment.laneId);
    const escalation = record.escalation;
    if (escalation !== undefined) ids.add(escalation.fromLaneId);
  }
  for (const refused of log.refusals) {
    if (refused.refusal.reason === 'no-eligible-lane') {
      for (const rejection of refused.refusal.rejections) ids.add(rejection.laneId);
      continue;
    }
    for (const conflict of refused.refusal.conflicts) ids.add(conflict.laneId);
  }
  return [...ids];
}

/**
 * The cap the scheduler last wrote down for this lane while turning work away.
 * A refusal that names a lane as at its concurrency cap records both the cap and
 * the in-flight count, so the number is read rather than reconstructed.
 */
function recordedCap(refusals: readonly DispatchRefused[], laneId: string): number | undefined {
  let cap: number | undefined;
  for (const refused of refusals) {
    if (refused.refusal.reason !== 'no-eligible-lane') continue;
    for (const rejection of refused.refusal.rejections) {
      if (rejection.laneId !== laneId) continue;
      if (rejection.reason.reason === 'at-concurrency-cap') {
        cap = rejection.reason.concurrencyCap;
      }
    }
  }
  return cap;
}

/** Whether any refusal recorded this lane as skipped for being metered (Requirement 1.5). */
function meteredInLog(refusals: readonly DispatchRefused[], laneId: string): boolean {
  return refusals.some(
    (refused) =>
      refused.refusal.reason === 'no-eligible-lane' &&
      refused.refusal.rejections.some(
        (rejection) =>
          rejection.laneId === laneId && rejection.reason.reason === 'metered-not-named',
      ),
  );
}

/** The most recent assignment recorded against a lane, oldest-first order assumed. */
function lastAssignmentOn(
  records: readonly DispatchRecord[],
  laneId: string,
): DispatchAssignment | undefined {
  let found: DispatchAssignment | undefined;
  for (const record of records) {
    if (record.assignment.laneId === laneId) found = record.assignment;
  }
  return found;
}

function concurrencyOf(running: number, cap: number | undefined, source: LaneCapSource): LaneConcurrencyView {
  return { running, source, ...(cap === undefined ? {} : { declaredCap: cap }) };
}

function laneViewsFrom(log: DispatchLog, lanes: readonly LaneDeclaration[]): ExecutorLaneView[] {
  const views: ExecutorLaneView[] = [];
  const declaredIds = new Set<string>();

  for (const runtime of replayLaneRuntimes(lanes, log.records)) {
    const running = runtime.inFlight.length;
    declaredIds.add(runtime.lane.id);
    views.push({
      laneId: runtime.lane.id,
      label: describeLane(runtime.lane),
      agentId: runtime.lane.agentId,
      orchestrator: runtime.lane.orchestrator,
      concurrency: concurrencyOf(running, runtime.lane.concurrencyCap, 'declaration'),
      ...(runtime.cooldown === undefined ? {} : { cooldown: runtime.cooldown }),
      atCap: running >= runtime.lane.concurrencyCap,
      declared: true,
      meteredNotNamed: runtime.lane.billing.kind === 'metered',
      hasRecords: lastAssignmentOn(log.records, runtime.lane.id) !== undefined,
    });
  }

  for (const laneId of laneIdsIn(log)) {
    if (declaredIds.has(laneId)) continue;
    const running = inFlightOn(log.records, laneId).length;
    const cooldown = cooldownOn(log.records, laneId);
    const cap = recordedCap(log.refusals, laneId);
    const assignment = lastAssignmentOn(log.records, laneId);
    views.push({
      laneId,
      label: laneId,
      ...(assignment === undefined
        ? {}
        : {
            billingLabel: laneBillingLabel({
              kind: assignment.billing,
              permitsBilledOverage: assignment.permitsBilledOverage,
            }),
            agentId: assignment.agentId,
          }),
      orchestrator: assignment?.orchestrator ?? false,
      concurrency: concurrencyOf(running, cap, cap === undefined ? 'unrecorded' : 'recorded-refusal'),
      ...(cooldown === undefined ? {} : { cooldown }),
      atCap: cap !== undefined && running >= cap,
      declared: false,
      meteredNotNamed: meteredInLog(log.refusals, laneId),
      hasRecords: assignment !== undefined,
    });
  }

  return views.sort((a, b) => a.laneId.localeCompare(b.laneId));
}

/**
 * The dispatches and refusals a person has to look at without opening a record
 * (Requirement 10.4). Outcome selection is `needsHumanAttention`; every
 * scheduling refusal qualifies, because a refusal is either an overlapping
 * ownership collision (4.3) or work left with nowhere to run (3.6).
 */
function attentionFrom(log: DispatchLog): DispatchAttention[] {
  const items: DispatchAttention[] = [];

  for (const record of log.records) {
    const closed = record.closed;
    if (closed === undefined || !needsHumanAttention(closed.outcome)) continue;
    items.push({
      dispatchId: record.dispatchId,
      workId: record.workId,
      at: closed.closedAt,
      task: record.declaration.task,
      taskKind: record.declaration.taskKind,
      cause: { kind: 'outcome', outcome: closed.outcome, assignment: record.assignment },
    });
  }

  for (const refused of log.refusals) {
    items.push({
      dispatchId: refused.dispatchId,
      workId: refused.workId,
      at: refused.refusedAt,
      task: refused.declaration.task,
      taskKind: refused.declaration.taskKind,
      cause: { kind: 'refusal', refusal: refused.refusal },
    });
  }

  return items.sort((a, b) => b.at.localeCompare(a.at) || a.dispatchId.localeCompare(b.dispatchId));
}

/** Reshape a read dispatch log for rendering. Reads nothing and computes no new state. */
export function buildExecutorView(input: ExecutorViewInput): ExecutorView {
  const { log } = input;
  if (log.records.length === 0 && log.refusals.length === 0) {
    const declared = input.lanes ?? [];
    return {
      kind: 'no-dispatches',
      logPresent: input.logPresent ?? false,
      ...(declared.length === 0 ? {} : { declaredLanes: declared }),
    };
  }

  const open = log.records.filter((record) => isInFlight(record));
  const closed = log.records.filter((record) => !isInFlight(record));

  return {
    kind: 'dispatches',
    lanes: laneViewsFrom(log, input.lanes ?? []),
    inFlight: [...open].reverse(),
    completed: [...closed].reverse().slice(0, MAX_COMPLETED_SHOWN),
    attention: attentionFrom(log),
    recordCount: log.records.length,
    refusalCount: log.refusals.length,
    omittedCompleted: Math.max(0, closed.length - MAX_COMPLETED_SHOWN),
    unparseableLines: input.unparseableLines ?? 0,
  };
}

function hasErrorCode(value: unknown): value is { code: unknown } {
  return typeof value === 'object' && value !== null && 'code' in value;
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && hasErrorCode(err) && err.code === 'ENOENT';
}

/**
 * Whether a dispatch log file exists, as distinct from `readDispatchLog`
 * returning nothing — which happens both when the file is absent and when it
 * holds no readable entry. The page reports those as different states.
 */
async function logExists(repoRoot: string): Promise<boolean> {
  try {
    await access(dispatchLogPath(repoRoot));
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

/**
 * Read the dispatch log under `repoRoot` and build the view.
 *
 * `lanes` is empty until a configuration declares them; the view then shows each
 * lane's running count without a declared cap it does not have, rather than
 * inventing one.
 */
export async function readExecutorView(
  repoRoot: string,
  lanes: readonly LaneDeclaration[] = [],
): Promise<ExecutorView> {
  const stats: ReadDispatchStats = { unparseableLines: 0 };
  const [log, logPresent] = await Promise.all([
    readDispatchLog(repoRoot, stats),
    logExists(repoRoot),
  ]);
  return buildExecutorView({ log, lanes, logPresent, unparseableLines: stats.unparseableLines });
}
