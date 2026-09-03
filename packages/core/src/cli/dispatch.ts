/**
 * `cyv dispatch` — hand one bounded unit of work to a declared executor lane
 * and judge what it did (spec 0011).
 *
 * The executor surface was built as a library and nothing invoked it. This is
 * the caller: it reads the lanes from `checkyourvibe.json` through
 * `configuredLanes`, turns each lane's `agentId` into a real command line
 * through `executor/invocation.ts`, and hands the work to `dispatchWork`, which
 * schedules with the pure functions in `executor/schedule.ts` against lane
 * state replayed off the dispatch log and then runs through
 * `runWorkWithEscalation`. Every attempt is appended to that log, so
 * `cyv dashboard` shows this run without being told about it.
 *
 * The exit code here comes from `classifyOutcome`, which reads the file system
 * and the gates. The executor's own exit code is printed beside the outcome and
 * decides nothing (Requirements 2.1, 2.6) — an executor that exits 0 having
 * written nothing exits this command non-zero.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { CONFIG_FILENAME, loadConfig } from '../config/load.js';
import { configuredLanes, laneConfigProblem, maxConcurrentDispatches } from '../config/lanes.js';
import { peekUnread, summariseNote } from './comments.js';
import { repoRoot as findRepoRoot } from '../run/discover.js';
import { HISTORY_DIR } from '../dashboard/history.js';
import {
  describeLane,
  type LaneDeclaration,
  type ResolvedLaneDeclaration,
} from '../executor/lane.js';
import { isTaskKind, TASK_KINDS, type TaskKind } from '../executor/task-kind.js';
import { agentCommandFor, knownAgentIds, type AgentCommandSpec } from '../executor/invocation.js';
import { findProgram, launchArguments, type ProgramLauncher } from '../executor/program.js';
import { executorPrompt } from '../executor/prompt.js';
import { createGateRunner, CYV_CHECK_GATE, RUN_GATE_PREFIX } from '../executor/gates.js';
import { dispatchWork, type DispatchWorkResult } from '../executor/work.js';
import { dispatchLogPath, readDispatchLog } from '../executor/store.js';
import { replayLaneRuntimes } from '../executor/replay.js';
import { scheduleDispatch } from '../executor/schedule.js';
import { DEFAULT_MAX_ATTEMPTS, type AttemptContext } from '../executor/escalate.js';
import { AGENT_COMMANDS } from '../executor/invocation.js';
import type { ChildCommand, ChildObservation } from '../executor/child.js';
import type {
  DispatchDeclaration,
  LaneIneligibility,
  SchedulingRefusal,
} from '../executor/dispatch.js';
import type { ExecutorOutput } from '../executor/outcome.js';
import {
  closeSelfDispatch,
  openSelfDispatch,
  type DispatchRunResult,
} from '../executor/run.js';
import type { Command, CommandContext } from './types.js';

/** Where a dispatch's prompt is written, beside the log that records the dispatch. */
const PROMPT_DIRECTORY = 'dispatch-prompts';

interface ParsedDispatchArgs {
  task?: string;
  taskFile?: string;
  taskKind: TaskKind;
  ownedPaths: string[];
  gates: string[];
  expectsFileChanges: boolean;
  observedScope: string[];
  laneId?: string;
  workId?: string;
  maxAttempts: number;
  timeoutMs?: number;
  json: boolean;
  dryRun: boolean;
  /** Dispatch to the orchestrating lane, run by this session (Requirement 2.4). */
  self: boolean;
  /** Close a dispatch this session opened for itself (Requirement 2.3). */
  closeId?: string;
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} needs a value.`);
  }
  return value;
}

function requirePositive(raw: string, flag: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${flag} takes a whole number of at least 1, got "${raw}".`);
  }
  return parsed;
}

function parseArgs(argv: readonly string[]): ParsedDispatchArgs {
  const parsed: ParsedDispatchArgs = {
    taskKind: 'mechanical-transformation',
    ownedPaths: [],
    gates: [],
    expectsFileChanges: true,
    observedScope: [],
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    json: false,
    dryRun: false,
    self: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === '--task') {
      i += 1;
      parsed.task = requireValue(argv, i, '--task');
    } else if (arg === '--task-file') {
      i += 1;
      parsed.taskFile = requireValue(argv, i, '--task-file');
    } else if (arg === '--kind') {
      i += 1;
      const value = requireValue(argv, i, '--kind');
      if (!isTaskKind(value)) {
        throw new Error(`--kind takes one of ${TASK_KINDS.join(', ')}, got "${value}".`);
      }
      parsed.taskKind = value;
    } else if (arg === '--own') {
      i += 1;
      parsed.ownedPaths.push(requireValue(argv, i, '--own'));
    } else if (arg === '--gate') {
      i += 1;
      parsed.gates.push(requireValue(argv, i, '--gate'));
    } else if (arg === '--observe') {
      i += 1;
      parsed.observedScope.push(requireValue(argv, i, '--observe'));
    } else if (arg === '--expects-no-file-changes') {
      parsed.expectsFileChanges = false;
    } else if (arg === '--lane') {
      i += 1;
      parsed.laneId = requireValue(argv, i, '--lane');
    } else if (arg === '--work-id') {
      i += 1;
      parsed.workId = requireValue(argv, i, '--work-id');
    } else if (arg === '--max-attempts') {
      i += 1;
      parsed.maxAttempts = requirePositive(requireValue(argv, i, '--max-attempts'), '--max-attempts');
    } else if (arg === '--timeout') {
      i += 1;
      parsed.timeoutMs = requirePositive(requireValue(argv, i, '--timeout'), '--timeout') * 1000;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--self') {
      parsed.self = true;
    } else if (arg === '--close') {
      i += 1;
      parsed.closeId = requireValue(argv, i, '--close');
    } else {
      throw new Error(`Unknown flag "${arg}" for cyv dispatch. Run \`cyv dispatch --help\`.`);
    }
  }

  if (parsed.closeId !== undefined) {
    // `--close` names a dispatch that already carries its own declaration in
    // the log, so the work is not restated here.
    return parsed;
  }

  if (parsed.task === undefined && parsed.taskFile === undefined) {
    throw new Error(
      'cyv dispatch needs the work stated: pass --task "<what to do>" or --task-file <path>.',
    );
  }
  if (parsed.task !== undefined && parsed.taskFile !== undefined) {
    throw new Error('--task and --task-file both state the work; pass one of them.');
  }
  if (parsed.ownedPaths.length === 0) {
    throw new Error(
      'cyv dispatch needs at least one --own <path>. Ownership is declared before a dispatch ' +
        'runs so an overlapping pair can be refused and an out-of-scope write can be seen ' +
        '(spec 0011 Requirements 4.2, 4.4).',
    );
  }

  return parsed;
}

/** `work-<yyyymmddhhmmss>-<6 hex>`, so two dispatches in one second do not share an id. */
function generateWorkId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `work-${stamp}-${randomBytes(3).toString('hex')}`;
}

/** One lane's agent, resolved to something spawnable on this machine. */
interface LaneExecutor {
  spec: AgentCommandSpec;
  launcher: ProgramLauncher;
}

/**
 * Resolve every declared lane's agent before anything is scheduled.
 *
 * A lane the scheduler might choose and the core cannot invoke is a
 * configuration error, and finding it after an `opened` entry is on disk would
 * leave a dispatch recorded against a lane that never ran. Both failures name
 * the lane, so a repository with several lanes is told which one to fix.
 */
async function resolveLaneExecutors(
  lanes: readonly LaneDeclaration[],
  env: NodeJS.ProcessEnv,
  repoRoot: string,
): Promise<Map<string, LaneExecutor>> {
  const resolved = new Map<string, LaneExecutor>();

  for (const lane of lanes) {
    const spec = agentCommandFor(lane.agentId);
    if (spec === undefined) {
      throw new Error(
        `Executor lane "${lane.id}" names agent "${lane.agentId}", which this build has no ` +
          `command line for. Known agents: ${knownAgentIds().join(', ')}. Add an entry to ` +
          'packages/core/src/executor/invocation.ts, or change the lane\'s agentId.',
      );
    }

    const launcher = await findProgram(spec.program, env, repoRoot);
    if (launcher === undefined) {
      throw new Error(
        `Executor lane "${lane.id}" runs agent "${lane.agentId}" through the program ` +
          `"${spec.program}", which is not on PATH. Install it and authenticate it, or remove ` +
          'the lane.',
      );
    }

    resolved.set(lane.id, { spec, launcher });
  }

  return resolved;
}

/** The id of the lane declaring itself the orchestrator, when one does. */
function orchestratorLaneId(lanes: readonly LaneDeclaration[]): string | undefined {
  return lanes.find((lane) => lane.orchestrator)?.id;
}

function readableRefusal(refusal: SchedulingRefusal, orchestratorLane?: string): string[] {
  if (refusal.reason === 'overlapping-ownership') {
    return [
      '  refused: another dispatch already in flight declares paths this one also claims.',
      ...refusal.conflicts.map(
        (conflict) =>
          `    ${conflict.withDispatchId} on lane ${conflict.laneId}: ${conflict.paths.join(', ')}`,
      ),
    ];
  }

  const lines = [
    '  refused: no declared lane was a candidate for this work.',
    ...refusal.rejections.map((rejection) => `    ${rejection.laneId}: ${describeIneligibility(rejection.reason)}`),
  ];

  // A refusal that ends on a list of exclusions leaves a user with one
  // subscription nowhere to go (spec 0036 Requirement 1.5, spec 0041
  // Requirement 2.4). Where an orchestrating lane exists there is always one
  // more option, and it is named here rather than left to be discovered.
  if (orchestratorLane !== undefined) {
    lines.push(
      `  \`--self\` runs this task on lane ${orchestratorLane} — this session, as a sub-agent ` +
        'of itself. It opens the record and prints the prompt; `cyv dispatch --close <id>` runs ' +
        'the gates and judges what changed.',
    );
  }
  return lines;
}

/**
 * Why one lane was not a candidate, in a sentence.
 *
 * Cooldown and at-cap are worded differently on purpose: the two look alike
 * from outside — no dispatch is being scheduled either way — and mean different
 * things (Requirement 10.3).
 */
function describeIneligibility(reason: LaneIneligibility): string {
  switch (reason.reason) {
    case 'lane-not-declared':
      return 'no lane with this id is declared';
    case 'not-the-named-lane':
      return `the dispatch named lane "${reason.namedLaneId}", so this one was not considered`;
    case 'metered-not-named':
      return 'metered — billed per use — and not named by the dispatch, so the core did not select it';
    case 'does-not-accept-dispatch':
      return reason.orchestrator
        ? 'does not accept dispatched work: it is the orchestrating lane, whose capacity is ' +
          'reserved for planning, review and integration. Set acceptsDispatch: true on it to ' +
          'spend that capacity on dispatched work'
        : 'does not accept dispatched work: the lane declares acceptsDispatch: false';
    case 'no-model-for-kind':
      return `declares no model for task kind "${reason.taskKind}"`;
    case 'in-cooldown':
      return (
        `in cooldown since ${reason.since}, after a dispatch that was ${reason.cause}. ` +
        'Cooldown clears on an observed-effect success on this lane, and naming it with ' +
        '--lane dispatches to it despite the cooldown so that success can happen'
      );
    case 'at-concurrency-cap':
      return (
        `running its declared cap of ${reason.concurrencyCap} (${reason.inFlight} in flight). ` +
        'That is the self-imposed cap in use, not a reading of the account'
      );
    case 'at-global-cap':
      return (
        `the run is at executor.maxConcurrentDispatches: ${reason.openDispatches} of ` +
        `${reason.maxConcurrentDispatches} open across every lane. This lane may have room; ` +
        'the run does not. Close a dispatch or raise the number'
      );
  }
}

function describeStream(label: 'stdout' | 'stderr', text: string, truncatedFrom?: number): string[] {
  const lines: string[] = [`    ${label}:`];
  for (const content of text.split('\n')) {
    lines.push(`      ${content}`);
  }
  if (truncatedFrom !== undefined) {
    lines.push(`      ... truncated from ${truncatedFrom} characters`);
  }
  return lines;
}

function describeOutput(output: ExecutorOutput): string[] {
  const lines: string[] = [];
  if (output.stderr !== undefined && output.stderr.length > 0) {
    lines.push(...describeStream('stderr', output.stderr, output.truncatedFrom?.stderr));
  }
  if (output.stdout !== undefined && output.stdout.length > 0) {
    lines.push(...describeStream('stdout', output.stdout, output.truncatedFrom?.stdout));
  }
  return lines;
}

function shouldShowOutput(closed: DispatchRunResult['closed']): boolean {
  return (
    closed.outcome.kind === 'produced-nothing' ||
    closed.outcome.kind === 'gates-failed' ||
    closed.report.status === 'failure' ||
    closed.report.status === 'did-not-complete'
  );
}

function describeAttempt(result: DispatchRunResult): string[] {
  const { closed, opened, observation, changedPaths, generatedPaths, generatedUndetermined } = result;
  const lines = [
    `  attempt ${opened.attempt} — dispatch ${opened.dispatchId}, model ${opened.assignment.model}`,
  ];

  const escalation = opened.escalation;
  if (escalation !== undefined) {
    lines.push(
      `    escalated from ${escalation.fromModel} on ${escalation.fromLaneId} after ` +
        `${escalation.reason}: ${escalation.detail}`,
    );
  }

  const exit = observation.exitCode === undefined ? 'no exit code' : `exit code ${observation.exitCode}`;
  lines.push(`    the executor reported ${closed.report.status} (${exit})`);

  lines.push(
    changedPaths.length === 0
      ? '    observed on disk: nothing changed'
      : `    observed on disk: ${changedPaths.length} path(s) changed — ${changedPaths.join(', ')}`,
  );

  // Reported separately rather than dropped: a gate that compiles the project
  // writes build output, which is not something the executor authored and not
  // an ownership violation, but is still worth a reader seeing.
  if (generatedPaths.length > 0) {
    lines.push(
      `    also touched ${generatedPaths.length} path(s) this repository ignores, ` +
        `not judged as writes — ${generatedPaths.join(', ')}`,
    );
  }
  if (generatedUndetermined !== undefined) {
    lines.push(`    generated-path split undetermined: ${generatedUndetermined}`);
  }

  for (const gate of closed.gateResults) {
    const verdict = gate.passed ? 'passed' : 'FAILED';
    lines.push(`    gate ${gate.gate} ${verdict}${gate.detail === undefined ? '' : ` — ${gate.detail}`}`);
  }

  lines.push(`    outcome ${closed.outcome.kind} — ${closed.outcome.summary}`);
  if (shouldShowOutput(closed) && closed.report.output !== undefined) {
    lines.push(...describeOutput(closed.report.output));
  }
  return lines;
}

function describeStop(work: DispatchWorkResult): string {
  if (!work.scheduled) return '';
  const block = work.work.stoppedBecause;
  switch (block.reason) {
    case 'outcome-is-not-a-gate-failure':
      return `  no further attempt: the outcome was ${block.outcome}, and only a gate failure escalates.`;
    case 'attempt-bound-reached':
      return `  no further attempt: the bound of ${block.maxAttempts} attempt(s) at this work was reached.`;
    case 'no-stronger-model':
      return `  no further attempt: "${block.model}" is the strongest model this lane declares for the kind.`;
    case 'metered-lane':
      return `  no further attempt: lane "${block.laneId}" is metered, and the core does not re-dispatch on one.`;
    default:
      return '';
  }
}

function usage(): string {
  return [
    'Usage: cyv dispatch [options]',
    '',
    'Hand one unit of work to a declared executor lane and judge what it did.',
    '',
    'The work:',
    '  --task <text>                What the executor is asked to do.',
    '  --task-file <path>           Read the task from a file instead of --task.',
    `  --kind <kind>                One of ${TASK_KINDS.join(', ')}.`,
    '                               Default: mechanical-transformation.',
    '  --own <path>                 A repo-relative path this dispatch may write.',
    '                               Repeatable, and at least one is required.',
    '  --expects-no-file-changes    Declare that this dispatch should change nothing.',
    '                               Its success then rests on its gates alone.',
    '  --gate <gate>                A gate the result is judged by. Repeatable. Either',
    `                               "${CYV_CHECK_GATE}", which runs this repository's analyzers`,
    '                               over the changed paths and passes with no error, or',
    `                               "${RUN_GATE_PREFIX}<program> [args...]", which passes on exit 0.`,
    '',
    'Where it runs:',
    '  --lane <lane-id>             Restrict the choice to one declared lane. Required to',
    '                               reach a metered lane, which the core never selects.',
    `  --max-attempts <n>           Attempts at this work. Default ${DEFAULT_MAX_ATTEMPTS}. An attempt after`,
    '                               the first runs only after an observed gate failure.',
    '  --timeout <seconds>          Kill an executor that has not finished by then. Omitted,',
    '                               the dispatch runs until the executor exits.',
    '  --observe <path>             A path snapshotted before and after. Repeatable.',
    '                               Defaults to the whole repository, which is what makes a',
    '                               write outside the declared ownership visible; narrowing',
    '                               it hides any write outside what is named.',
    '  --work-id <id>               Shared by every attempt. Defaults to a generated id.',
    '',
    'Output:',
    '  --dry-run                    Print the lane and model this work would be given, and',
    '                               write nothing. No executor runs.',
    '  --json                       Write the result to stdout as JSON.',
    '  --agents                     List the agents this build can invoke, and exit.',
    '',
    'The exit code is read from the outcome, which is computed from the file system and the',
    'gates. An executor that exits 0 having written none of its declared files exits this',
    'command non-zero (spec 0011 Requirements 2.1, 2.3, 2.6).',
  ].join('\n');
}

async function listAgents(env: NodeJS.ProcessEnv, cwd: string): Promise<number> {
  console.log('Agents this build can invoke. A lane names one in its `agentId`.\n');
  for (const spec of AGENT_COMMANDS) {
    const launcher = await findProgram(spec.program, env, cwd);
    console.log(`  ${spec.agentId}`);
    console.log(`    program     ${spec.program}`);
    console.log(`    invocation  ${spec.invocation}`);
    console.log(
      `    on PATH     ${launcher === undefined ? 'no — not found on PATH here' : launcher.path}`,
    );
    console.log('');
  }
  console.log(
    'The model a lane declares is passed through verbatim; the core neither translates nor\n' +
      'ranks a model name. Add an agent by adding one entry to\n' +
      'packages/core/src/executor/invocation.ts — the scheduler is not involved.',
  );
  return 0;
}

interface DryRunOutcome {
  lines: string[];
  code: number;
}

async function describeDryRun(
  repoRoot: string,
  lanes: readonly LaneDeclaration[],
  declaration: DispatchDeclaration,
  workId: string,
  laneId: string | undefined,
  globalCap: number,
): Promise<DryRunOutcome> {
  const { records } = await readDispatchLog(repoRoot);
  const runtimes = replayLaneRuntimes(lanes, records);
  const decision = scheduleDispatch(
    {
      dispatchId: `${workId}-attempt-1`,
      taskKind: declaration.taskKind,
      ownedPaths: declaration.ownedPaths,
      ...(laneId === undefined ? {} : { laneId }),
    },
    runtimes,
    { maxConcurrentDispatches: globalCap },
  );

  if (decision.decision === 'refused') {
    return {
      lines: [
        '  nothing was written; this is what scheduling would decide.',
        ...readableRefusal(decision.refusal, orchestratorLaneId(lanes)),
      ],
      code: 1,
    };
  }

  const lane = lanes.find((candidate) => candidate.id === decision.laneId);
  return {
    lines: [
      '  nothing was written; this is what scheduling would decide.',
      `  lane ${lane === undefined ? decision.laneId : describeLane(lane)}`,
      `  agent ${decision.agentId}, model ${decision.model} — the weakest this lane declares for ` +
        `"${declaration.taskKind}"`,
      `  declared headroom ${decision.declaredHeadroom} against this lane's self-imposed cap`,
      ...(decision.namedDespiteCooldown === undefined
        ? []
        : [
            `  this lane is in cooldown since ${decision.namedDespiteCooldown.since}, after a ` +
              `dispatch that was ${decision.namedDespiteCooldown.reason}. You named it, so it was ` +
              'not refused; an observed-effect success here clears the cooldown.',
          ]),
    ],
    code: 0,
  };
}

async function readTask(parsed: ParsedDispatchArgs, cwd: string): Promise<string> {
  if (parsed.task !== undefined) return parsed.task;
  const file = parsed.taskFile ?? '';
  const taskPath = isAbsolute(file) ? file : join(cwd, file);
  try {
    return await readFile(taskPath, 'utf-8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`--task-file "${file}" could not be read: ${reason}`);
  }
}

function jsonResultFor(work: DispatchWorkResult, workId: string, logPath: string): string {
  if (!work.scheduled) {
    return JSON.stringify(
      { workId, scheduled: false, refusal: work.refused.refusal, logPath },
      null,
      2,
    );
  }
  return JSON.stringify(
    {
      workId,
      scheduled: true,
      logPath,
      attempts: work.work.attempts.map((attempt) => ({
        dispatchId: attempt.opened.dispatchId,
        attempt: attempt.opened.attempt,
        assignment: attempt.opened.assignment,
        escalation: attempt.opened.escalation,
        executorReport: attempt.closed.report,
        changedPaths: attempt.changedPaths,
        gateResults: attempt.closed.gateResults,
        outcome: attempt.closed.outcome,
      })),
      outcome: work.work.outcome,
      stoppedBecause: work.work.stoppedBecause,
    },
    null,
    2,
  );
}

async function run(ctx: CommandContext): Promise<number> {
  if (ctx.argv.includes('--help') || ctx.argv.includes('-h')) {
    console.log(usage());
    return 0;
  }
  if (ctx.argv.includes('--agents')) {
    return listAgents(ctx.env, ctx.cwd);
  }

  let parsed: ParsedDispatchArgs;
  try {
    parsed = parseArgs(ctx.argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  const repoRoot = await findRepoRoot(ctx.cwd);
  const config = await loadConfig(repoRoot);

  const laneProblem = laneConfigProblem(config);
  if (laneProblem !== undefined) {
    console.error(laneProblem);
    return 2;
  }

  const lanes = configuredLanes(config);

  if (parsed.closeId !== undefined) {
    return closeSelfExecuted(repoRoot, parsed.closeId, ctx.env, parsed.json);
  }

  if (lanes.length === 0) {
    console.error(
      `No executor lane is declared in ${CONFIG_FILENAME}, so there is nothing to dispatch to. ` +
        'Add an `executor.lanes` entry naming an agent, a concurrency cap, and the models it ' +
        'offers per task kind. `cyv init` writes no lane: enabling an executor grants a ' +
        "third-party CLI write access to this repository under your own authenticated session, " +
        'and that is its own decision (spec 0011 Requirement 5.3).',
    );
    return 2;
  }

  // `--self` is the caller taking responsibility for spending the orchestrating
  // subscription on dispatched work, the same way naming a metered lane with
  // `--lane` is the caller taking responsibility for a bill. The reservation in
  // spec 0036 Requirement 1.2 is a default for scheduling, not a prohibition —
  // so the flag overrides it for this one dispatch rather than requiring an edit
  // to `checkyourvibe.json` that would then apply to every dispatch.
  let dispatchLanes: readonly ResolvedLaneDeclaration[] = lanes;
  if (parsed.self) {
    const orchestrating = lanes.find((lane) => lane.orchestrator);
    if (orchestrating === undefined) {
      console.error(
        `--self runs a task on the orchestrating lane, and no lane in ${CONFIG_FILENAME} ` +
          'declares `orchestrator: true`. Mark one, or name a lane with --lane.',
      );
      return 2;
    }
    parsed.laneId = orchestrating.id;
    dispatchLanes = lanes.map((lane) =>
      lane.orchestrator ? { ...lane, acceptsDispatch: true, executes: 'subagent' as const } : lane,
    );
  }

  const task = await readTask(parsed, ctx.cwd);
  const declaration: DispatchDeclaration = {
    task,
    taskKind: parsed.taskKind,
    ownedPaths: parsed.ownedPaths,
    expectsFileChanges: parsed.expectsFileChanges,
    gates: parsed.gates,
  };
  const workId = parsed.workId ?? generateWorkId(new Date());

  if (parsed.dryRun) {
    const { lines, code } = await describeDryRun(
      repoRoot,
      dispatchLanes,
      declaration,
      workId,
      parsed.laneId,
      maxConcurrentDispatches(config),
    );
    console.log([`\n  dispatch ${workId} — dry run`, ...lines, ''].join('\n'));
    return code;
  }

  // Which lane this would go to is decided before the executors are resolved,
  // because a `subagent` lane has no executor to resolve: nothing is spawned for
  // it. `dispatchWork` schedules again from the same log and the same lanes in
  // this same process, so the two decisions agree.
  const { records: scheduledAgainst } = await readDispatchLog(repoRoot);
  const preview = scheduleDispatch(
    {
      dispatchId: `${workId}-attempt-1`,
      taskKind: declaration.taskKind,
      ownedPaths: declaration.ownedPaths,
      ...(parsed.laneId === undefined ? {} : { laneId: parsed.laneId }),
    },
    replayLaneRuntimes(dispatchLanes, scheduledAgainst),
    { maxConcurrentDispatches: maxConcurrentDispatches(config) },
  );

  if (preview.decision === 'scheduled') {
    const chosen = dispatchLanes.find((lane) => lane.id === preview.laneId);
    if (chosen?.executes === 'subagent') {
      return openForSelfExecution(repoRoot, {
        workId,
        declaration,
        lane: chosen,
        model: preview.model,
        declaredHeadroom: preview.declaredHeadroom,
        observedScope: parsed.observedScope,
        json: parsed.json,
      });
    }
  }

  let executors: Map<string, LaneExecutor>;
  try {
    executors = await resolveLaneExecutors(dispatchLanes, ctx.env, repoRoot);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  const prompt = executorPrompt(declaration);
  const promptPath = join(repoRoot, HISTORY_DIR, PROMPT_DIRECTORY, `${workId}.md`);
  await mkdir(dirname(promptPath), { recursive: true });
  await writeFile(promptPath, prompt, 'utf-8');

  // The lane is chosen inside `dispatchWork`, after this request is built, and
  // both callbacks below need it: `commandFor` to name the CLI, and the
  // rate-limit detector to judge that CLI's output by its own vendor's wording
  // rather than another's. `runDispatch` calls them in a fixed order around one
  // child — the command is built, the child runs, the observation is read — so
  // the lane recorded here is always the lane the observation came from.
  let attemptLane: LaneDeclaration | undefined;

  const commandFor = (context: AttemptContext): ChildCommand => {
    attemptLane = context.lane;
    const executor = executors.get(context.lane.id);
    if (executor === undefined) {
      throw new Error(
        `Lane "${context.lane.id}" was scheduled but has no resolved executor. Every declared ` +
          'lane is resolved before scheduling, so this is a bug in cyv dispatch.',
      );
    }
    const launch = executor.spec.build({
      cwd: repoRoot,
      model: context.model,
      promptPath,
      prompt,
    });
    return {
      command: executor.launcher.command,
      args: launchArguments(executor.launcher, launch.args).args,
      windowsVerbatimArguments: launchArguments(executor.launcher, launch.args).windowsVerbatimArguments,
      cwd: repoRoot,
      env: ctx.env,
      ...(launch.stdin === undefined ? {} : { stdin: launch.stdin }),
      ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
    };
  };

  const detectRateLimit = (observation: ChildObservation): boolean => {
    const lane = attemptLane;
    if (lane === undefined) return false;
    const executor = executors.get(lane.id);
    return executor === undefined ? false : executor.spec.detectsRateLimit(observation);
  };

  const work = await dispatchWork({
    repoRoot,
    workId,
    lanes: dispatchLanes,
    declaration,
    ...(parsed.laneId === undefined ? {} : { laneId: parsed.laneId }),
    commandFor,
    detectRateLimit,
    gateRunner: createGateRunner(ctx.env),
    maxAttempts: parsed.maxAttempts,
    maxConcurrentDispatches: maxConcurrentDispatches(config),
    ...(parsed.observedScope.length === 0 ? {} : { observedScope: parsed.observedScope }),
  });

  const logPath = dispatchLogPath(repoRoot);

  if (parsed.json) {
    console.log(jsonResultFor(work, workId, logPath));
    return work.scheduled && work.work.outcome.kind === 'succeeded' ? 0 : 1;
  }

  const lines = [`\n  dispatch ${workId}`];

  if (!work.scheduled) {
    lines.push(...readableRefusal(work.refused.refusal, orchestratorLaneId(lanes)));
    lines.push(`  recorded in ${logPath}`, '');
    console.log(lines.join('\n'));
    return 1;
  }

  const first = work.work.attempts[0];
  if (first !== undefined) {
    const lane = lanes.find((candidate) => candidate.id === first.opened.assignment.laneId);
    lines.push(
      `  lane ${lane === undefined ? first.opened.assignment.laneId : describeLane(lane)}, ` +
        `agent ${first.opened.assignment.agentId}`,
    );
  }
  for (const attempt of work.work.attempts) {
    lines.push(...describeAttempt(attempt));
  }
  lines.push(describeStop(work));
  lines.push(
    '  The outcome above was read from the file system and the gates. The executor\'s own exit',
    '  code is recorded beside it and decided nothing.',
    `  recorded in ${logPath}`,
    '  run `cyv dashboard` to see it beside the lanes it ran on.',
    '',
  );
  lines.push(...(await notesArrivedLines(repoRoot)));
  console.log(lines.join('\n'));

  return work.work.outcome.kind === 'succeeded' ? 0 : 1;
}

/**
 * Notes the owner left that the agent has not read, shown after an outcome
 * (spec 0042 Requirement 2).
 *
 * This is the moment the orchestrator is already reading cyv output and about
 * to decide what to do next, which makes it the cheapest place to put a note in
 * front of it. The cursor is deliberately not advanced (Requirement 2.2): a
 * note shown twice costs a few lines, and a note marked read by a process that
 * was about to exit is a note nobody ever sees.
 */
async function notesArrivedLines(repoRoot: string): Promise<string[]> {
  const unread = await peekUnread(repoRoot);
  if (unread.length === 0) return [];

  const lines = [
    `  ${unread.length} note${unread.length === 1 ? '' : 's'} from the owner ` +
      `${unread.length === 1 ? 'arrived and has' : 'arrived and have'} not been read:`,
    '',
  ];
  for (const note of unread) lines.push(...summariseNote(note));
  lines.push(
    '',
    '  Still unread — this listing does not mark them read. `cyv comments` does.',
    '',
  );
  return lines;
}

export const command: Command = { run };

interface SelfOpenRequest {
  workId: string;
  declaration: DispatchDeclaration;
  lane: ResolvedLaneDeclaration;
  model: string;
  /** The lane's declared headroom at the moment the scheduler chose it. */
  declaredHeadroom: number;
  observedScope: readonly string[];
  json: boolean;
}

/**
 * Open a dispatch this session will execute itself, and stop (spec 0041
 * Requirement 2.3).
 *
 * The record and the before snapshot are written here; the work happens between
 * this command and `--close`. The prompt is written to the same place a CLI
 * dispatch writes one, because the session reading it needs the same statement
 * of the task, its owned paths and its gates.
 */
async function openForSelfExecution(
  repoRoot: string,
  request: SelfOpenRequest,
): Promise<number> {
  const dispatchId = `${request.workId}-attempt-1`;
  const promptPath = join(repoRoot, HISTORY_DIR, PROMPT_DIRECTORY, `${request.workId}.md`);
  await mkdir(dirname(promptPath), { recursive: true });
  await writeFile(promptPath, executorPrompt(request.declaration), 'utf-8');

  const opened = await openSelfDispatch({
    repoRoot,
    dispatchId,
    workId: request.workId,
    attempt: 1,
    declaration: request.declaration,
    assignment: {
      laneId: request.lane.id,
      agentId: request.lane.agentId,
      model: request.model,
      billing: request.lane.billing.kind,
      permitsBilledOverage: request.lane.billing.permitsBilledOverage,
      orchestrator: request.lane.orchestrator,
      declaredHeadroomAtSchedule: request.declaredHeadroom,
    },
    ...(request.observedScope.length === 0 ? {} : { observedScope: request.observedScope }),
  });

  if (request.json) {
    console.log(
      JSON.stringify(
        {
          workId: request.workId,
          dispatchId,
          scheduled: true,
          executes: 'subagent',
          laneId: request.lane.id,
          promptPath,
          observedScope: opened.observedScope,
          logPath: dispatchLogPath(repoRoot),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(
    [
      `\n  dispatch ${request.workId}`,
      `  lane ${describeLane(request.lane)} — run by this session as a sub-agent.`,
      '  nothing was spawned. The record is open and the before-snapshot is taken.',
      '',
      `  dispatch id  ${dispatchId}`,
      `  prompt       ${promptPath}`,
      '',
      '  Do the work, then close it:',
      `    cyv dispatch --close ${dispatchId}`,
      '',
      '  Until it is closed it counts against the caps and is judged for liveness like any',
      '  other dispatch: a session that stops without closing leaves an abandoned record.',
      '',
    ].join('\n'),
  );
  return 0;
}

/**
 * Close a dispatch this session opened for itself, judging it by what changed
 * (spec 0041 Requirement 2.3).
 */
async function closeSelfExecuted(
  repoRoot: string,
  dispatchId: string,
  env: NodeJS.ProcessEnv,
  json: boolean,
): Promise<number> {
  const { records } = await readDispatchLog(repoRoot);
  const openedRecord = records.find(
    (record) => record.dispatchId === dispatchId && record.closed === undefined,
  );
  if (openedRecord === undefined) {
    console.error(
      `No open dispatch "${dispatchId}" is recorded in ${dispatchLogPath(repoRoot)}. ` +
        'It was never opened, or it has already been closed.',
    );
    return 2;
  }

  const result = await closeSelfDispatch({
    repoRoot,
    dispatchId,
    declaration: openedRecord.declaration,
    assignment: openedRecord.assignment,
    gateRunner: createGateRunner(env),
  });

  if (!result.closed) {
    console.error(result.reason);
    return 2;
  }

  const { outcome } = result.result.closed;
  if (json) {
    console.log(
      JSON.stringify(
        {
          dispatchId,
          closed: true,
          outcome,
          changedPaths: result.result.changedPaths,
          gateResults: result.result.closed.gateResults,
          logPath: dispatchLogPath(repoRoot),
        },
        null,
        2,
      ),
    );
    return outcome.kind === 'succeeded' ? 0 : 1;
  }

  const lines = [
    `\n  dispatch ${dispatchId} — closed`,
    `  outcome ${outcome.kind}`,
    `  ${result.result.changedPaths.length} file(s) changed within the observed scope`,
  ];
  for (const gate of result.result.closed.gateResults) {
    lines.push(`    gate ${gate.gate}: ${gate.passed ? 'passed' : `failed — ${gate.detail ?? 'no detail'}`}`);
  }
  lines.push(`  recorded in ${dispatchLogPath(repoRoot)}`, '');
  // Requirement 2.1 is about a dispatch closing, and this is the other way one
  // closes. A sub-agent run is exactly the case where a note is most likely to
  // have arrived, because the session was doing the work rather than watching.
  lines.push(...(await notesArrivedLines(repoRoot)));
  console.log(lines.join('\n'));
  return outcome.kind === 'succeeded' ? 0 : 1;
}
