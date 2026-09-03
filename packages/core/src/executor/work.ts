/**
 * Scheduling a unit of work and then running it (spec 0011 Requirements 4.3,
 * 6.4, 9.1, 9.2).
 *
 * `scheduleDispatch` is pure and takes the lane runtimes as an argument. This
 * builds those runtimes by replaying the dispatch log off disk, so the lanes'
 * in-flight counts and cooldown state come from the records rather than from
 * the memory of the session that wrote them (Requirement 6.4).
 *
 * A refusal is appended to the log as its own entry (Requirement 4.3) and
 * returned, so a caller that ignores the return value still leaves the refusal
 * on disk. A scheduled dispatch is handed to `runWorkWithEscalation` with an
 * assignment built from the chosen lane's declaration, which is where the
 * billing label Requirement 1.4 asks for and the model Requirement 9.6 asks for
 * enter the record.
 */
import { replayLaneRuntimes } from './replay.js';
import { runWorkWithEscalation, type EscalatingWorkRequest, type EscalatingWorkResult } from './escalate.js';
import { readDispatchLog, refuseDispatch } from './store.js';
import { scheduleDispatch } from './schedule.js';
import type { DispatchAssignment, DispatchDeclaration, DispatchRefused } from './dispatch.js';
import type { LaneDeclaration } from './lane.js';

export interface DispatchWorkRequest
  extends Omit<EscalatingWorkRequest, 'lane' | 'assignment'> {
  /** Every lane the core may consider for this unit of work. */
  lanes: readonly LaneDeclaration[];
  declaration: DispatchDeclaration;
  /** Restricts the choice to one lane, and is required to reach a metered lane. */
  laneId?: string;
  /**
   * The run-wide dispatch limit (spec 0041 Requirement 3.1). Omitted, no global
   * limit applies — callers that predate the cap keep their behaviour.
   */
  maxConcurrentDispatches?: number;
}

export type DispatchWorkResult =
  | { scheduled: true; work: EscalatingWorkResult }
  | { scheduled: false; refused: DispatchRefused };

/**
 * Schedule the work against the lanes' state on disk and run it, or record why
 * it was refused.
 */
export async function dispatchWork(request: DispatchWorkRequest): Promise<DispatchWorkResult> {
  const dispatchIdFor =
    request.dispatchIdFor ?? ((attempt: number): string => `${request.workId}-attempt-${attempt}`);
  const firstDispatchId = dispatchIdFor(1);

  const { records } = await readDispatchLog(request.repoRoot);
  const runtimes = replayLaneRuntimes(request.lanes, records);

  const decision = scheduleDispatch(
    {
      dispatchId: firstDispatchId,
      taskKind: request.declaration.taskKind,
      ownedPaths: request.declaration.ownedPaths,
      ...(request.laneId === undefined ? {} : { laneId: request.laneId }),
    },
    runtimes,
    request.maxConcurrentDispatches === undefined
      ? undefined
      : { maxConcurrentDispatches: request.maxConcurrentDispatches },
  );

  if (decision.decision === 'refused') {
    const now = request.now ?? ((): Date => new Date());
    const refused = await refuseDispatch(request.repoRoot, {
      dispatchId: firstDispatchId,
      workId: request.workId,
      refusedAt: now().toISOString(),
      declaration: request.declaration,
      refusal: decision.refusal,
    });
    return { scheduled: false, refused };
  }

  const lane = request.lanes.find((candidate) => candidate.id === decision.laneId);
  if (lane === undefined) {
    throw new Error(
      `scheduleDispatch chose lane "${decision.laneId}", which is not among the lanes it was given.`,
    );
  }

  const assignment: DispatchAssignment = {
    laneId: decision.laneId,
    agentId: decision.agentId,
    model: decision.model,
    billing: lane.billing.kind,
    permitsBilledOverage: lane.billing.permitsBilledOverage,
    orchestrator: lane.orchestrator,
    declaredHeadroomAtSchedule: decision.declaredHeadroom,
  };

  const work = await runWorkWithEscalation({ ...request, lane, assignment, dispatchIdFor });
  return { scheduled: true, work };
}
