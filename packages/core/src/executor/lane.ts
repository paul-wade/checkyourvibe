/**
 * A lane: one executor's declared capacity and model lineup (spec 0011
 * Requirements 3.1, 8.2, 8.3, 1.3 - 1.5, 6.1).
 *
 * A lane is declared, never discovered. Its concurrency cap is a self-imposed
 * number the core will not exceed, not a reading of the vendor's real rate
 * limit — Requirement 7.1 records that no such reading is available through an
 * authenticated CLI.
 *
 * The per-kind model ordering belongs to the lane's plugin author. The core
 * reads two positions in it — the last entry (Requirement 9.1) and the entry
 * before a given one (Requirement 9.3) — and does nothing else with it: it does
 * not re-rank an ordering, merge two lanes' orderings, or compare a position in
 * one lane's ordering against a position in another's (Requirement 8.3).
 */
import type { TaskKind } from './task-kind.js';

/**
 * How the lane is paid for.
 *
 * `subscription` is a CLI authenticated against a plan the user already holds
 * (Requirement 1.2). `metered` is billed per token or per request, is opt-in,
 * and is never selected by the core on its own (Requirements 1.3, 1.5).
 */
export type LaneBillingKind = 'subscription' | 'metered';

export interface LaneBilling {
  kind: LaneBillingKind;
  /**
   * Whether the user has configured this lane as permitting billed overage past
   * its included capacity. A configuration fact the user supplied, not a live
   * reading of their account (Requirement 9.6).
   */
  permitsBilledOverage: boolean;
}

/** The models a lane offers for one task kind, strongest first. */
export interface LaneModelOffering {
  kind: TaskKind;
  /**
   * The lane's own ordering of the models it offers for this kind, strongest
   * to weakest, as the lane's plugin author judges its vendor's lineup. Opaque
   * to the core (Requirement 8.3).
   */
  ordering: readonly string[];
}

export interface LaneDeclaration {
  id: string;
  /** The `AgentPlugin.id` that backs this lane. */
  agentId: string;
  /** Maximum simultaneous dispatches the core will schedule here (Requirement 3.1). */
  concurrencyCap: number;
  billing: LaneBilling;
  models: readonly LaneModelOffering[];
  /**
   * True for the lane that is the agent session issuing dispatches. It is named
   * like any other lane wherever a dispatch is shown (Requirement 6.1) and is
   * subject to the same cap, cooldown, and escalation rules (Requirement 6.2).
   */
  orchestrator: boolean;
  /**
   * Whether the lane may receive an ordinary dispatched task. Optional: the
   * default reserves the orchestrating lane for planning, review and
   * integration unless the author says otherwise, and is resolved by
   * `configuredLanes` (spec 0036 Requirements 1.1, 1.2).
   */
  acceptsDispatch?: boolean;
  /**
   * How work reaches this lane. `cli` spawns the agent's own program, which is
   * every lane's normal case. `subagent` means the orchestrating session runs
   * the task itself, as a sub-agent of its own, and the core judges the result
   * by observed effect exactly as it judges a CLI's (spec 0041 Requirement
   * 2.1).
   *
   * Optional, and resolved by `configuredLanes`: the default depends on how
   * many lanes the repository declares, which is a fact about the
   * configuration rather than about this lane.
   */
  executes?: LaneExecutionMode;
}

/**
 * How a lane's work is actually run.
 *
 * The distinction is not about which model does the work — it is about who
 * spawns it. A `cli` lane is a separate process on a separate subscription. A
 * `subagent` lane is the orchestrating session spending its own, which is why
 * it is the default only when there is no other subscription to spend (spec
 * 0041 Requirement 2.2).
 */
export type LaneExecutionMode = 'cli' | 'subagent';

/** A `LaneDeclaration` whose default `acceptsDispatch` value has been resolved. */
/**
 * Whether a lane may receive an ordinary dispatched task, applying the default
 * the author may have left out (spec 0036 Requirements 1.1, 1.2).
 *
 * `configuredLanes` resolves this for lanes read from configuration, but a lane
 * reaches the scheduler from other places too — a test fixture, a record
 * replayed from the dispatch log — and every one of them has to reach the same
 * answer. Reading `acceptsDispatch` directly is how a lane that simply omitted
 * it gets treated as refusing all work.
 */
export function acceptsDispatch(lane: LaneDeclaration): boolean {
  return lane.acceptsDispatch ?? !lane.orchestrator;
}

/**
 * True when `lane` is the orchestrator and the repository declares no other
 * lane (spec 0041 Requirement 2.2).
 *
 * Spec 0036 Requirement 1.2 reserves the orchestrating lane for planning,
 * review and integration, which is right whenever there is somewhere else for
 * work to go. When there is not, that reservation refuses every dispatch and
 * the refusal names no alternative — a user with one subscription is told only
 * that they cannot proceed. So the reservation is conditioned on a second lane
 * existing rather than removed.
 *
 * This takes the whole lane set because the answer is not a property of the
 * lane. `acceptsDispatch(lane)` above stays a per-lane question for the callers
 * that only ever hold one — a replayed record, a test fixture — and
 * `configuredLanes` is where a lane set is known and both are resolved.
 */
export function isSoleOrchestrator(
  lane: LaneDeclaration,
  lanes: readonly LaneDeclaration[],
): boolean {
  return lane.orchestrator && lanes.length === 1;
}

/**
 * `acceptsDispatch` for a lane read in the context of every lane declared
 * beside it. An explicit declaration always wins; the sole orchestrator is the
 * only case this decides differently from `acceptsDispatch` alone.
 */
export function resolveAcceptsDispatch(
  lane: LaneDeclaration,
  lanes: readonly LaneDeclaration[],
): boolean {
  if (lane.acceptsDispatch !== undefined) return lane.acceptsDispatch;
  if (isSoleOrchestrator(lane, lanes)) return true;
  return !lane.orchestrator;
}

/**
 * How this lane executes, defaulting `subagent` for the sole orchestrating lane
 * and `cli` for every other (spec 0041 Requirements 2.1, 2.2). An explicit
 * declaration always wins, including one that puts the sole orchestrating lane
 * back on `cli`.
 */
export function resolveExecutes(
  lane: LaneDeclaration,
  lanes: readonly LaneDeclaration[],
): LaneExecutionMode {
  if (lane.executes !== undefined) return lane.executes;
  return isSoleOrchestrator(lane, lanes) ? 'subagent' : 'cli';
}

export interface ResolvedLaneDeclaration extends LaneDeclaration {
  /** Whether the lane may receive an ordinary dispatched task (Requirement 1.1). */
  acceptsDispatch: boolean;
  /** How work reaches the lane, defaulted per spec 0041 Requirement 2.2. */
  executes: LaneExecutionMode;
}

/** Why a lane is in cooldown, and since when (Requirement 7.4). */
export interface LaneCooldown {
  /**
   * The observed outcome that put the lane here: a dispatch that reported
   * success and changed nothing (Requirement 2.3), or an explicit rate-limit
   * error from the executor (Requirement 3.3).
   */
  reason: 'produced-nothing' | 'rate-limited';
  /** The dispatch whose outcome started the cooldown. */
  dispatchId: string;
  /** ISO 8601, taken from that dispatch's close time. */
  since: string;
}

/** The models this lane offers for `kind`, or an empty list when it offers none. */
export function modelsFor(lane: LaneDeclaration, kind: TaskKind): readonly string[] {
  const offering = lane.models.find((entry) => entry.kind === kind);
  return offering === undefined ? [] : offering.ordering;
}

/** True when the lane declares at least one model for `kind` (Requirement 8.4). */
export function offersKind(lane: LaneDeclaration, kind: TaskKind): boolean {
  return modelsFor(lane, kind).length > 0;
}

/**
 * The weakest model the lane declares eligible for `kind` — the last entry in
 * its ordering (Requirement 9.1). `undefined` when the lane declares none,
 * which makes it no candidate for a dispatch of that kind.
 */
export function weakestModelFor(lane: LaneDeclaration, kind: TaskKind): string | undefined {
  const ordering = modelsFor(lane, kind);
  return ordering[ordering.length - 1];
}

/**
 * The entry one position stronger than `model` in this lane's ordering for
 * `kind` (Requirement 9.3). `undefined` when `model` is already the lane's
 * strongest for the kind, or is not in the ordering at all.
 */
export function nextStrongerModelFor(
  lane: LaneDeclaration,
  kind: TaskKind,
  model: string,
): string | undefined {
  const ordering = modelsFor(lane, kind);
  const index = ordering.indexOf(model);
  if (index <= 0) return undefined;
  return ordering[index - 1];
}

/**
 * Declared headroom: the lane's cap minus the dispatches currently running
 * against it, floored at zero (Requirement 7.2). This is exact about the
 * self-imposed cap and says nothing about the vendor's real remaining quota.
 */
export function declaredHeadroom(lane: LaneDeclaration, inFlightCount: number): number {
  return Math.max(0, lane.concurrencyCap - inFlightCount);
}

/**
 * How a lane is labelled wherever it is named to the user (Requirement 1.4).
 * A metered lane says so at every such point, not only in documentation.
 */
export function laneBillingLabel(billing: LaneBilling): string {
  const base = billing.kind === 'metered' ? 'metered — billed per use' : 'subscription';
  return billing.permitsBilledOverage ? `${base}, configured to permit billed overage` : base;
}

/** `lane-id (subscription)` or `lane-id (metered — billed per use)`. */
export function describeLane(lane: LaneDeclaration): string {
  const role = lane.orchestrator ? ', orchestrator' : '';
  return `${lane.id} (${laneBillingLabel(lane.billing)}${role})`;
}
