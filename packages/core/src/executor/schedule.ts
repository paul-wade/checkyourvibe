/**
 * Choosing a lane and a model (spec 0011 Requirements 3.2, 4.3, 7.3, 8.4,
 * 9.1, 9.2).
 *
 * Every function here is pure: it takes the declared lanes, what is running on
 * them, their cooldown state, and the declaration of the dispatch being
 * scheduled, and returns a decision. Nothing is spawned, nothing is read from
 * disk, and no clock is consulted.
 *
 * Two rules decide the result. The lane is the eligible one with the most
 * declared headroom (Requirement 9.2). The model is the weakest that lane
 * declares eligible for the dispatch's task kind (Requirement 9.1); no argument
 * or setting asks for a stronger one, and moving up the ordering happens only
 * after an observed gate failure, which is the escalation layer's job.
 */
import {
  declaredHeadroom,
  offersKind,
  weakestModelFor,
  acceptsDispatch,
  type LaneCooldown,
  type LaneDeclaration,
} from './lane.js';
import { overlappingPaths } from './ownership.js';
import type {
  LaneIneligibility,
  LaneRejection,
  OwnershipConflict,
  SchedulingRefusal,
} from './dispatch.js';
import type { TaskKind } from './task-kind.js';

/**
 * The run-wide dispatch limit, and how much of it is spent (spec 0041
 * Requirement 3.1).
 *
 * Passed in rather than read, because everything here is pure. Omitting it
 * means no global limit applies, which is what every caller predating the cap
 * gets and what a configuration that sets no number resolves to — the default
 * is the sum of the dispatchable lanes' caps, which by construction can never
 * bind before the lanes' own caps do.
 */
export interface GlobalCap {
  maxConcurrentDispatches: number;
  /** Dispatches open across every lane. Computed by `openDispatchCount`. */
  openDispatches?: number;
}

/** A dispatch currently running against a lane. */
export interface InFlightDispatch {
  dispatchId: string;
  /** Its declared ownership set, for the overlap check (Requirement 4.3). */
  ownedPaths: readonly string[];
}

/** A declared lane plus everything the scheduler knows about it right now. */
export interface LaneRuntime {
  lane: LaneDeclaration;
  /** Dispatches running against this lane; its length is the in-flight count. */
  inFlight: readonly InFlightDispatch[];
  /** Present while the lane is in cooldown (Requirement 7.4). */
  cooldown?: LaneCooldown;
}

/** What is being scheduled. */
export interface ScheduleRequest {
  dispatchId: string;
  taskKind: TaskKind;
  /** Declared before the dispatch runs (Requirement 4.4). */
  ownedPaths: readonly string[];
  /**
   * Names one lane, restricting the choice to it. Required to reach a metered
   * lane, which the core never selects on its own (Requirement 1.5).
   */
  laneId?: string;
}

export type SchedulingDecision =
  | {
      decision: 'scheduled';
      laneId: string;
      agentId: string;
      /** The weakest model the lane declares for the task kind (Requirement 9.1). */
      model: string;
      /** The lane's declared headroom at the moment of the choice (Requirement 7.2). */
      declaredHeadroom: number;
      /**
       * Present when the caller named a lane that was in cooldown and it was
       * scheduled anyway (spec 0036 Requirement 10.2). The choice is recorded
       * rather than left to be inferred from the absence of a refusal.
       */
      namedDespiteCooldown?: LaneCooldown;
    }
  | { decision: 'refused'; refusal: SchedulingRefusal };

/** A lane the scheduler would accept, with what it would be asked for. */
export interface LaneCandidate {
  laneId: string;
  agentId: string;
  model: string;
  declaredHeadroom: number;
}

/**
 * Why this lane is not a candidate for this request, or `undefined` when it is.
 *
 * The checks run identity first, then per-work fit, then runtime state.
 * Cooldown is reported ahead of the concurrency cap because a cooldown survives
 * the in-flight count falling back under the cap.
 */
export function openDispatchCount(runtimes: readonly LaneRuntime[]): number {
  return runtimes.reduce((total, runtime) => total + runtime.inFlight.length, 0);
}

/**
 * Resolve a `GlobalCap` against the lanes it applies to, filling in the open
 * count when the caller did not already know it.
 */
function withOpenCount(cap: GlobalCap, runtimes: readonly LaneRuntime[]): GlobalCap {
  return cap.openDispatches === undefined
    ? { ...cap, openDispatches: openDispatchCount(runtimes) }
    : cap;
}

export function laneIneligibility(
  request: ScheduleRequest,
  runtime: LaneRuntime,
  globalCap?: GlobalCap,
): LaneIneligibility | undefined {
  const { lane } = runtime;

  if (request.laneId !== undefined && request.laneId !== lane.id) {
    return { reason: 'not-the-named-lane', namedLaneId: request.laneId };
  }

  if (lane.billing.kind === 'metered' && request.laneId !== lane.id) {
    return { reason: 'metered-not-named' };
  }

  if (!offersKind(lane, request.taskKind)) {
    return { reason: 'no-model-for-kind', taskKind: request.taskKind };
  }

  // Checked before cooldown and the cap so that a lane which never takes
  // dispatched work reads that way rather than as one that is merely busy. The
  // orchestrating lane defaults to this, and the reason it matters is that
  // every other lane being unavailable is exactly when a fallback onto the
  // session driving the run would happen (spec 0036 Requirements 1.4, 1.5).
  if (!acceptsDispatch(lane)) {
    return { reason: 'does-not-accept-dispatch', orchestrator: lane.orchestrator };
  }

  // Cooldown constrains what the scheduler chooses, not what a person may ask
  // for. Requirement 7.5 makes an observed-effect success on the lane the only
  // thing that clears it, and R7.6 calls cooldown a scheduling state rather
  // than a demotion — so refusing a named lane too leaves no route back to it
  // except an escalation from some other lane's gate failure (spec 0036 R10).
  // The metered check above already treats naming a lane as the caller taking
  // responsibility for reaching it.
  if (runtime.cooldown !== undefined && request.laneId !== lane.id) {
    return {
      reason: 'in-cooldown',
      since: runtime.cooldown.since,
      cause: runtime.cooldown.reason,
    };
  }

  // After the lane's own durable reasons and before its cap. A lane that offers
  // no model for the kind, or refuses dispatched work outright, says so even
  // while the run is full: those do not lift when a dispatch closes and this
  // does. Ahead of the lane cap because when both are true the global one is
  // what the caller has to wait for.
  if (
    globalCap !== undefined &&
    (globalCap.openDispatches ?? 0) >= globalCap.maxConcurrentDispatches
  ) {
    return {
      reason: 'at-global-cap',
      maxConcurrentDispatches: globalCap.maxConcurrentDispatches,
      openDispatches: globalCap.openDispatches ?? 0,
    };
  }

  if (runtime.inFlight.length >= lane.concurrencyCap) {
    return {
      reason: 'at-concurrency-cap',
      concurrencyCap: lane.concurrencyCap,
      inFlight: runtime.inFlight.length,
    };
  }

  return undefined;
}

/**
 * Every in-flight dispatch whose declared ownership overlaps the request's
 * (Requirement 4.3). Sorted by dispatch id so a refusal always reads the same.
 */
export function ownershipConflicts(
  request: ScheduleRequest,
  runtimes: readonly LaneRuntime[],
): OwnershipConflict[] {
  const conflicts: OwnershipConflict[] = [];
  for (const runtime of runtimes) {
    for (const running of runtime.inFlight) {
      if (running.dispatchId === request.dispatchId) continue;
      const paths = overlappingPaths(request.ownedPaths, running.ownedPaths);
      if (paths.length > 0) {
        conflicts.push({ withDispatchId: running.dispatchId, laneId: runtime.lane.id, paths });
      }
    }
  }
  return conflicts.sort((a, b) => a.withDispatchId.localeCompare(b.withDispatchId));
}

/**
 * The lanes that could take this dispatch, most declared headroom first
 * (Requirement 9.2). Lane id breaks a tie, so the same inputs always produce
 * the same order.
 */
export function eligibleLanes(
  request: ScheduleRequest,
  runtimes: readonly LaneRuntime[],
  globalCap?: GlobalCap,
): LaneCandidate[] {
  const cap = globalCap === undefined ? undefined : withOpenCount(globalCap, runtimes);
  const candidates: LaneCandidate[] = [];
  for (const runtime of runtimes) {
    if (laneIneligibility(request, runtime, cap) !== undefined) continue;
    const model = weakestModelFor(runtime.lane, request.taskKind);
    if (model === undefined) continue;
    candidates.push({
      laneId: runtime.lane.id,
      agentId: runtime.lane.agentId,
      model,
      declaredHeadroom: declaredHeadroom(runtime.lane, runtime.inFlight.length),
    });
  }
  return candidates.sort(
    (a, b) => b.declaredHeadroom - a.declaredHeadroom || a.laneId.localeCompare(b.laneId),
  );
}

/** Every lane that was not a candidate, with the reason it was not. */
export function laneRejections(
  request: ScheduleRequest,
  runtimes: readonly LaneRuntime[],
  globalCap?: GlobalCap,
): LaneRejection[] {
  const cap = globalCap === undefined ? undefined : withOpenCount(globalCap, runtimes);
  const rejections: LaneRejection[] = [];
  for (const runtime of runtimes) {
    const reason = laneIneligibility(request, runtime, cap);
    if (reason !== undefined) {
      rejections.push({ laneId: runtime.lane.id, reason });
    }
  }
  if (request.laneId !== undefined && !runtimes.some((r) => r.lane.id === request.laneId)) {
    rejections.push({ laneId: request.laneId, reason: { reason: 'lane-not-declared' } });
  }
  return rejections;
}

/**
 * Choose a lane and a model, or refuse.
 *
 * Overlapping ownership is checked before eligibility: Requirement 4.3 refuses
 * the second of two overlapping dispatches whether or not a lane had room.
 */
export function scheduleDispatch(
  request: ScheduleRequest,
  runtimes: readonly LaneRuntime[],
  globalCap?: GlobalCap,
): SchedulingDecision {
  const conflicts = ownershipConflicts(request, runtimes);
  if (conflicts.length > 0) {
    return { decision: 'refused', refusal: { reason: 'overlapping-ownership', conflicts } };
  }

  const cap = globalCap === undefined ? undefined : withOpenCount(globalCap, runtimes);
  const candidate = eligibleLanes(request, runtimes, cap)[0];
  if (candidate === undefined) {
    return {
      decision: 'refused',
      refusal: { reason: 'no-eligible-lane', rejections: laneRejections(request, runtimes, cap) },
    };
  }

  const chosen = runtimes.find((runtime) => runtime.lane.id === candidate.laneId);
  const overridden =
    chosen?.cooldown !== undefined && request.laneId === candidate.laneId
      ? chosen.cooldown
      : undefined;

  return {
    decision: 'scheduled',
    laneId: candidate.laneId,
    agentId: candidate.agentId,
    model: candidate.model,
    declaredHeadroom: candidate.declaredHeadroom,
    ...(overridden === undefined ? {} : { namedDespiteCooldown: overridden }),
  };
}
