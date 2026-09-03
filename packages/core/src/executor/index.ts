/**
 * The executor surface (spec 0011).
 *
 * The foundation: the dispatch record and its append-only store, the lane
 * declaration and its per-kind model ordering, the pure scheduling functions,
 * and outcome classification.
 *
 * The dispatch layer built on it: file-system snapshotting, the child-process
 * runner that brackets an executor with `openDispatch` and `closeDispatch` and
 * classifies what it did from the two snapshots, bounded escalation up a lane's
 * ordering after an observed gate failure, and `dispatchWork`, which schedules
 * against the lane state replayed from disk before running.
 *
 * What turns a scheduled lane and model into something that runs: `invocation`
 * maps an `agentId` to one CLI's non-interactive command line, `program` finds
 * that CLI on this machine, `prompt` composes what it is handed, and `gates`
 * runs the checks the result is judged by. `cyv dispatch` is the caller that
 * assembles the four.
 *
 * What is not here, and the seam each leaves:
 *
 * - The localhost view. It reads `readDispatchLog` and `replayLaneRuntimes`
 *   and computes nothing else (Requirement 10.1).
 * - Metered lanes. `LaneBilling` carries the distinction, `laneIneligibility`
 *   keeps a metered lane out of any choice the core makes on its own
 *   (Requirement 1.5), and `decideEscalation` refuses to re-dispatch on one
 *   (Requirement 9.5); the configuration that names one is not built here.
 * - Escalation to a second lane on rate exhaustion (Requirement 3.3).
 *   `indicatesRateExhaustion` supplies the trigger and `EscalationBlock`
 *   reports the outcome that would fire it; choosing the second lane and
 *   reporting a dispatch blocked for want of one (Requirement 3.6) is not
 *   built here.
 *
 * This module is internal to the core, like `dashboard` and `report`. It is not
 * re-exported from the package's public API, which stays the plugin contract.
 */
export * from './task-kind.js';
export * from './ownership.js';
export * from './lane.js';
export * from './outcome.js';
export * from './dispatch.js';
export * from './schedule.js';
export * from './parse.js';
export * from './store.js';
export * from './replay.js';
export * from './liveness.js';
export * from './stall.js';
export * from './snapshot.js';
export * from './child.js';
export * from './program.js';
export * from './invocation.js';
export * from './prompt.js';
export * from './run.js';
export * from './gates.js';
export * from './escalate.js';
export * from './work.js';
