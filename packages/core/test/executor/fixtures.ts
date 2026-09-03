import type { DispatchDeclaration } from '../../src/executor/dispatch.js';
import type { LaneDeclaration, LaneModelOffering } from '../../src/executor/lane.js';
import type { LaneRuntime, InFlightDispatch } from '../../src/executor/schedule.js';
import type { ExecutorReport } from '../../src/executor/outcome.js';
import type { TaskKind } from '../../src/executor/task-kind.js';

export interface LaneOptions {
  id: string;
  concurrencyCap?: number;
  models?: readonly LaneModelOffering[];
  metered?: boolean;
  permitsBilledOverage?: boolean;
  orchestrator?: boolean;
  agentId?: string;
}

/**
 * A lane offering `['strong', 'middle', 'weak']` for mechanical transformation
 * unless the test says otherwise, so the weakest-model rule has an ordering
 * with a distinguishable last entry.
 */
export function lane(options: LaneOptions): LaneDeclaration {
  const metered = options.metered ?? false;
  return {
    id: options.id,
    agentId: options.agentId ?? `${options.id}-agent`,
    concurrencyCap: options.concurrencyCap ?? 2,
    orchestrator: options.orchestrator ?? false,
    billing: {
      kind: metered ? 'metered' : 'subscription',
      permitsBilledOverage: options.permitsBilledOverage ?? false,
    },
    models: options.models ?? [
      { kind: 'mechanical-transformation', ordering: ['strong', 'middle', 'weak'] },
    ],
  };
}

export function runtime(
  declaration: LaneDeclaration,
  inFlight: readonly InFlightDispatch[] = [],
  cooldownSince?: string,
): LaneRuntime {
  if (cooldownSince === undefined) {
    return { lane: declaration, inFlight };
  }
  return {
    lane: declaration,
    inFlight,
    cooldown: { reason: 'produced-nothing', dispatchId: 'earlier', since: cooldownSince },
  };
}

export function running(dispatchId: string, ownedPaths: readonly string[]): InFlightDispatch {
  return { dispatchId, ownedPaths };
}

export function declaration(overrides: Partial<DispatchDeclaration> = {}): DispatchDeclaration {
  const taskKind: TaskKind = overrides.taskKind ?? 'mechanical-transformation';
  return {
    task: overrides.task ?? 'rename the symbol',
    taskKind,
    ownedPaths: overrides.ownedPaths ?? ['src/a.ts'],
    expectsFileChanges: overrides.expectsFileChanges ?? true,
    gates: overrides.gates ?? ['tsc'],
  };
}

export function report(
  status: ExecutorReport['status'],
  extras: { exitCode?: number; rateLimited?: boolean } = {},
): ExecutorReport {
  return {
    status,
    rateLimited: extras.rateLimited ?? false,
    ...(extras.exitCode === undefined ? {} : { exitCode: extras.exitCode }),
  };
}
