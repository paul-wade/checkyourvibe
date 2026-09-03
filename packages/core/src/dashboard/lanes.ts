/**
 * The lanes region (spec 0040 Requirement 4): one row per declared lane, from
 * the configuration, the dispatch log replayed, and the machine.
 *
 * Three sources and nothing else. The configuration says what a lane is
 * allowed to run; the log says what is running and whether the lane is
 * cooling; `PATH` says whether the program behind it exists. No vendor account
 * is consulted, which is why a row carries `running N of cap` and never a
 * percentage of anything (0011 R7.1).
 *
 * The orchestrating lane's state is whatever it last said about itself,
 * attributed as self-reported, and unknown when it said nothing (0036 R3).
 */
import { configuredLanes } from '../config/lanes.js';
import type { CheckYourVibeConfig } from '../config/types.js';
import { AGENT_COMMANDS, agentCommandFor } from '../executor/invocation.js';
import { laneBillingLabel, type ResolvedLaneDeclaration } from '../executor/lane.js';
import { findProgram } from '../executor/program.js';
import { replayLaneRuntimes } from '../executor/replay.js';
import type { LaneRuntime } from '../executor/schedule.js';
import type { DispatchLog } from '../executor/store.js';
import type { LaneRow, LaneState, LanesRegion, UnusedAgent } from './view-model.js';

export interface LanesInput {
  config: CheckYourVibeConfig;
  log: DispatchLog;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

function laneState(
  lane: ResolvedLaneDeclaration,
  runtime: LaneRuntime,
  programFound: boolean,
): LaneState {
  if (!programFound) return 'unavailable';
  if (lane.orchestrator && !lane.acceptsDispatch) return 'reserved';
  if (runtime.cooldown !== undefined) return 'cooling';
  if (runtime.inFlight.length >= lane.concurrencyCap) return 'busy';
  return 'free';
}

async function laneRow(
  lane: ResolvedLaneDeclaration,
  runtime: LaneRuntime,
  log: DispatchLog,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<LaneRow> {
  const spec = agentCommandFor(lane.agentId);
  const tried = spec === undefined ? [] : [spec.program];
  const launcher = spec === undefined ? undefined : await findProgram(spec.program, env, cwd);
  const report = log.orchestrator;

  return {
    id: lane.id,
    agentId: lane.agentId,
    orchestrator: lane.orchestrator,
    acceptsDispatch: lane.acceptsDispatch,
    state: laneState(lane, runtime, launcher !== undefined),
    running: runtime.inFlight.length,
    cap: lane.concurrencyCap,
    billing: laneBillingLabel(lane.billing),
    ...(runtime.cooldown === undefined ? {} : { cooldown: runtime.cooldown }),
    ...(launcher === undefined ? {} : { programPath: launcher.path }),
    programTried: tried,
    ...(lane.orchestrator && report !== undefined
      ? {
          selfReport: {
            state: report.state,
            at: report.reportedAt,
            ...(report.reason === undefined ? {} : { reason: report.reason }),
            ...(report.model === undefined ? {} : { model: report.model }),
          },
        }
      : {}),
    models: lane.models,
  };
}

/**
 * Adapters that ship with the tool, whose program is on `PATH`, and that no
 * declared lane names (0036 R2.3). Reported, never declared on the user's
 * behalf.
 */
async function unusedAgents(
  lanes: readonly ResolvedLaneDeclaration[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<UnusedAgent[]> {
  const declared = new Set(lanes.map((lane) => lane.agentId));
  const unused: UnusedAgent[] = [];
  for (const spec of AGENT_COMMANDS) {
    if (declared.has(spec.agentId)) continue;
    const launcher = await findProgram(spec.program, env, cwd);
    if (launcher === undefined) continue;
    unused.push({ agentId: spec.agentId, program: spec.program, programPath: launcher.path });
  }
  return unused;
}

export async function buildLanesRegion(input: LanesInput): Promise<LanesRegion> {
  const lanes = configuredLanes(input.config);
  const runtimes = replayLaneRuntimes(lanes, input.log.records);
  const rows: LaneRow[] = [];
  for (const [index, lane] of lanes.entries()) {
    const runtime = runtimes[index];
    if (runtime === undefined) continue;
    rows.push(await laneRow(lane, runtime, input.log, input.env, input.cwd));
  }
  return {
    lanes: rows,
    unused: await unusedAgents(lanes, input.env, input.cwd),
    none: lanes.length === 0,
  };
}
