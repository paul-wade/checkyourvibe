/**
 * Bounded escalation up a lane's own ordering (spec 0011 Requirements 9.3,
 * 9.4, 9.5).
 *
 * A dispatch starts on the weakest model the lane declares for the task kind
 * (Requirement 9.1). When its gates are observed to fail, the same unit of work
 * is re-dispatched to the entry one position stronger in that lane's ordering,
 * up to a bounded number of attempts that defaults to `DEFAULT_MAX_ATTEMPTS`.
 *
 * Four things stop the loop, and each is named in the result rather than left
 * for a caller to infer: the outcome was something other than a gate failure,
 * the attempt bound was reached, the lane has nothing stronger for the kind, or
 * the lane is metered. A metered lane is refused here because re-dispatching is
 * a choice the core makes on its own, which Requirements 1.5 and 9.5 keep away
 * from a metered lane or model.
 *
 * Every attempt is its own dispatch record sharing one `workId`, and an attempt
 * that followed another carries an `Escalation` naming the model it moved from
 * and the gate failure that moved it (Requirement 9.4).
 */
import { nextStrongerModelFor, type LaneDeclaration } from './lane.js';
import { runDispatch, type DispatchRunRequest, type DispatchRunResult, type GateRunner } from './run.js';
import type { ChildCommand, RateLimitDetector } from './child.js';
import type { DispatchOutcome, DispatchOutcomeKind } from './outcome.js';
import type { DispatchAssignment, DispatchDeclaration, Escalation } from './dispatch.js';
import type { SnapshotOptions } from './snapshot.js';
import type { TaskKind } from './task-kind.js';

/**
 * Attempts at one unit of work when the caller configures no bound: the first
 * dispatch and two escalations above it. Requirement 9.3 requires the default
 * to be finite.
 */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Why no further attempt was made. */
export type EscalationBlock =
  /** Escalation is triggered by an observed gate failure and nothing else. */
  | { reason: 'outcome-is-not-a-gate-failure'; outcome: DispatchOutcomeKind }
  /** The configured bound on attempts at one unit of work was reached. */
  | { reason: 'attempt-bound-reached'; maxAttempts: number }
  /** The model that ran is the lane's strongest for the kind. */
  | { reason: 'no-stronger-model'; model: string }
  /** The core does not re-dispatch on a metered lane (Requirements 1.5, 9.5). */
  | { reason: 'metered-lane'; laneId: string };

export type EscalationDecision =
  | { escalate: true; model: string; escalation: Escalation }
  | { escalate: false; block: EscalationBlock };

export interface EscalationRequest {
  lane: LaneDeclaration;
  taskKind: TaskKind;
  /** The model the finished attempt ran on. */
  model: string;
  /** The dispatch the next attempt would follow. */
  dispatchId: string;
  outcome: DispatchOutcome;
  /** 1 for the first attempt. */
  attempt: number;
  maxAttempts?: number;
}

/**
 * Whether the finished attempt escalates, and to which model.
 *
 * The outcome is read first, so an attempt that succeeded on a metered lane is
 * reported as having succeeded rather than as having been blocked.
 */
export function decideEscalation(request: EscalationRequest): EscalationDecision {
  const maxAttempts = request.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  if (request.outcome.kind !== 'gates-failed') {
    return {
      escalate: false,
      block: { reason: 'outcome-is-not-a-gate-failure', outcome: request.outcome.kind },
    };
  }

  if (request.lane.billing.kind === 'metered') {
    return { escalate: false, block: { reason: 'metered-lane', laneId: request.lane.id } };
  }

  if (request.attempt >= maxAttempts) {
    return { escalate: false, block: { reason: 'attempt-bound-reached', maxAttempts } };
  }

  const stronger = nextStrongerModelFor(request.lane, request.taskKind, request.model);
  if (stronger === undefined) {
    return { escalate: false, block: { reason: 'no-stronger-model', model: request.model } };
  }

  return {
    escalate: true,
    model: stronger,
    escalation: {
      fromLaneId: request.lane.id,
      fromModel: request.model,
      reason: 'gate-failure',
      detail: request.outcome.summary,
      priorDispatchId: request.dispatchId,
    },
  };
}

/** What the caller is told about the attempt it is being asked to build a command for. */
export interface AttemptContext {
  attempt: number;
  model: string;
  dispatchId: string;
  /**
   * The lane the attempt runs on. A model name alone does not identify a
   * command line: `agentId` is what names the CLI the model belongs to, and a
   * caller reaching this through `dispatchWork` did not choose the lane and
   * has no other way to learn it.
   */
  lane: LaneDeclaration;
  escalation?: Escalation;
}

export interface EscalatingWorkRequest {
  repoRoot: string;
  /** Shared by every attempt at this unit of work (Requirement 9.4). */
  workId: string;
  lane: LaneDeclaration;
  declaration: DispatchDeclaration;
  /** The assignment from scheduling; its `model` is the first attempt's. */
  assignment: DispatchAssignment;
  /** Builds the command for an attempt, which is where the model is named to the CLI. */
  commandFor: (context: AttemptContext) => ChildCommand;
  /** Defaults to `DEFAULT_MAX_ATTEMPTS`. */
  maxAttempts?: number;
  /** Defaults to `<workId>-attempt-<n>`. */
  dispatchIdFor?: (attempt: number) => string;
  observedScope?: readonly string[];
  snapshot?: SnapshotOptions;
  gateRunner?: GateRunner;
  detectRateLimit?: RateLimitDetector;
  now?: () => Date;
}

export interface EscalatingWorkResult {
  workId: string;
  /** One entry per attempt, in the order they ran. */
  attempts: readonly DispatchRunResult[];
  /** The last attempt's outcome. */
  outcome: DispatchOutcome;
  /** Why no further attempt was made. */
  stoppedBecause: EscalationBlock;
}

function runRequestFor(
  request: EscalatingWorkRequest,
  context: AttemptContext,
): DispatchRunRequest {
  return {
    repoRoot: request.repoRoot,
    dispatchId: context.dispatchId,
    workId: request.workId,
    attempt: context.attempt,
    declaration: request.declaration,
    assignment: { ...request.assignment, model: context.model },
    ...(context.escalation === undefined ? {} : { escalation: context.escalation }),
    command: request.commandFor(context),
    ...(request.observedScope === undefined ? {} : { observedScope: request.observedScope }),
    ...(request.snapshot === undefined ? {} : { snapshot: request.snapshot }),
    ...(request.gateRunner === undefined ? {} : { gateRunner: request.gateRunner }),
    ...(request.detectRateLimit === undefined ? {} : { detectRateLimit: request.detectRateLimit }),
    ...(request.now === undefined ? {} : { now: request.now }),
  };
}

/**
 * Dispatch one unit of work, escalating up the lane's ordering on an observed
 * gate failure until the bound, the ordering, or the outcome stops it.
 */
export async function runWorkWithEscalation(
  request: EscalatingWorkRequest,
): Promise<EscalatingWorkResult> {
  const maxAttempts = request.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const dispatchIdFor =
    request.dispatchIdFor ?? ((attempt: number): string => `${request.workId}-attempt-${attempt}`);

  const attempts: DispatchRunResult[] = [];
  let model = request.assignment.model;
  let attempt = 1;
  let escalation: Escalation | undefined;

  for (;;) {
    const context: AttemptContext = {
      attempt,
      model,
      dispatchId: dispatchIdFor(attempt),
      lane: request.lane,
      ...(escalation === undefined ? {} : { escalation }),
    };
    const result = await runDispatch(runRequestFor(request, context));
    attempts.push(result);

    const decision = decideEscalation({
      lane: request.lane,
      taskKind: request.declaration.taskKind,
      model,
      dispatchId: context.dispatchId,
      outcome: result.closed.outcome,
      attempt,
      maxAttempts,
    });

    if (!decision.escalate) {
      return {
        workId: request.workId,
        attempts,
        outcome: result.closed.outcome,
        stoppedBecause: decision.block,
      };
    }

    escalation = decision.escalation;
    model = decision.model;
    attempt += 1;
  }
}
