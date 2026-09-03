/**
 * The in-motion region (spec 0040 Requirement 3): what is running, what could
 * run next, what just finished, and whether the run has gone quiet.
 *
 * Everything is read from the dispatch log, the spec files and git. Nothing
 * here dispatches, and the wave grouping is a reading of the declared file
 * scopes rather than a scheduler (0040 Decision 4).
 */
import { configuredLanes } from '../config/lanes.js';
import type { CheckYourVibeConfig } from '../config/types.js';
import { isInFlight, type DispatchRecord } from '../executor/dispatch.js';
import { judgeLiveness } from '../executor/liveness.js';
import { needsHumanAttention } from '../executor/outcome.js';
import { replayLaneRuntimes } from '../executor/replay.js';
import { detectStall, stallIntervalMinutes } from '../executor/stall.js';
import type { DispatchLog } from '../executor/store.js';
import { uncommittedWork } from './review/progress.js';
import { planWaves, specDisplayName, type ParsedSpec, type SpecRollup, type SpecTask } from './review/specs.js';
import type {
  ActiveSpec,
  FinishedDispatch,
  MotionRegion,
  NextTask,
  RunningDispatch,
} from './view-model.js';

/** Closed dispatches listed before the region stops. */
export const FINISHED_SHOWN = 8;

export interface MotionInput {
  repo: string;
  config: CheckYourVibeConfig;
  log: DispatchLog;
  specs: SpecRollup;
  now: Date;
  unparseableLines: number;
}

/** A task id named in a dispatch's task text, where the orchestrator put one. */
export function taskIdIn(task: string): string | undefined {
  const match = /\bT\d{4,}\b/.exec(task);
  return match === undefined || match === null ? undefined : match[0];
}

/** The first non-empty line, without a leading task id the row already shows beside it. */
function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim().length > 0);
  return (line ?? text).trim().replace(/^T\d{4,}\s*[:—-]?\s*/, '');
}

function openTasksOf(spec: ParsedSpec): SpecTask[] {
  return spec.sections.flatMap((section) => section.tasks).filter((task) => !task.done);
}

function allTasksOf(spec: ParsedSpec): SpecTask[] {
  return spec.sections.flatMap((section) => section.tasks);
}

/**
 * The spec being worked: the one with open tasks that the most recent
 * dispatch names a task from, or, when no dispatch names one, the
 * highest-numbered spec with open tasks.
 */
export function activeSpecOf(
  specs: SpecRollup,
  records: readonly DispatchRecord[],
): ParsedSpec | undefined {
  const candidates = specs.specs.filter(
    (spec) => spec.tasksPath !== null && openTasksOf(spec).length > 0,
  );
  if (candidates.length === 0) return undefined;

  for (const record of [...records].reverse()) {
    const id = taskIdIn(record.declaration.task);
    if (id === undefined) continue;
    const owner = candidates.find((spec) =>
      allTasksOf(spec).some((task) => task.id === id),
    );
    if (owner !== undefined) return owner;
  }

  return [...candidates].sort((a, b) => b.id.localeCompare(a.id))[0];
}

function describeSpec(spec: ParsedSpec): ActiveSpec | undefined {
  if (spec.tasksPath === null) return undefined;
  return {
    id: spec.id,
    name: specDisplayName(spec.id),
    done: spec.done,
    total: spec.total,
    tasksPath: spec.tasksPath,
  };
}

async function runningFrom(records: readonly DispatchRecord[]): Promise<RunningDispatch[]> {
  const open = records.filter((record) => isInFlight(record)).reverse();
  const running: RunningDispatch[] = [];
  for (const record of open) {
    const judgement = await judgeLiveness(record);
    const taskId = taskIdIn(record.declaration.task);
    // The stop control is offered only when the judgement identified the
    // process; an undetermined pid may belong to another program (0036 R5.4).
    const canStop = judgement.liveness !== 'undetermined';
    running.push({
      dispatchId: record.dispatchId,
      workId: record.workId,
      attempt: record.attempt,
      task: firstLine(record.declaration.task),
      ...(taskId === undefined ? {} : { taskId }),
      taskKind: record.declaration.taskKind,
      laneId: record.assignment.laneId,
      model: record.assignment.model,
      orchestrator: record.assignment.orchestrator,
      openedAt: record.openedAt,
      liveness: judgement.liveness,
      livenessReason: judgement.reason,
      canStop,
      ...(canStop
        ? {}
        : { stopRefusal: `Not offered: ${judgement.reason}. Stopping a pid that may be another program is worse than an open record.` }),
      ownedPaths: record.declaration.ownedPaths,
    });
  }
  return running;
}

function finishedFrom(records: readonly DispatchRecord[]): FinishedDispatch[] {
  const finished: FinishedDispatch[] = [];
  for (const record of [...records].reverse()) {
    const closed = record.closed;
    if (closed === undefined) continue;
    const taskId = taskIdIn(record.declaration.task);
    finished.push({
      dispatchId: record.dispatchId,
      workId: record.workId,
      attempt: record.attempt,
      task: firstLine(record.declaration.task),
      ...(taskId === undefined ? {} : { taskId }),
      laneId: record.assignment.laneId,
      model: record.assignment.model,
      outcome: closed.outcome.kind,
      summary: closed.outcome.summary,
      failedGates: closed.outcome.failedGates,
      closedAt: closed.closedAt,
      needsPerson: needsHumanAttention(closed.outcome),
    });
  }
  return finished.sort((a, b) => b.closedAt.localeCompare(a.closedAt)).slice(0, FINISHED_SHOWN);
}

/**
 * Tasks whose latest dispatch succeeded and are still unchecked. They are shown
 * so the box gets ticked, not so the work gets started again.
 */
export function landedTaskIds(records: readonly DispatchRecord[]): Set<string> {
  const latest = new Map<string, DispatchRecord>();
  for (const record of records) {
    const taskId = taskIdIn(record.declaration.task);
    if (taskId === undefined) continue;
    const current = latest.get(taskId);
    if (current === undefined || current.openedAt <= record.openedAt) latest.set(taskId, record);
  }
  const landed = new Set<string>();
  for (const [taskId, record] of latest) {
    if (record.closed?.outcome.kind === 'succeeded') landed.add(taskId);
  }
  return landed;
}

function markLanded(tasks: readonly NextTask[], records: readonly DispatchRecord[]): NextTask[] {
  const landed = landedTaskIds(records);
  return tasks.map((task) => (landed.has(task.id) ? { ...task, landed: true } : task));
}

export async function buildMotionRegion(input: MotionInput): Promise<MotionRegion> {
  const spec = activeSpecOf(input.specs, input.log.records);
  const openWorkExists = input.specs.specs.some((candidate) => openTasksOf(candidate).length > 0);
  const runtimes = replayLaneRuntimes(configuredLanes(input.config), input.log.records);
  const stall = detectStall({
    runtimes,
    records: input.log.records,
    openWorkExists,
    now: input.now,
    intervalMinutes: stallIntervalMinutes(input.config),
  });

  const [running, uncommitted] = await Promise.all([
    runningFrom(input.log.records),
    uncommittedWork(input.repo, input.now.getTime()),
  ]);

  const described = spec === undefined ? undefined : describeSpec(spec);
  return {
    ...(described === undefined ? {} : { spec: described }),
    running,
    next: spec === undefined ? [] : markLanded(planWaves(openTasksOf(spec), allTasksOf(spec)), input.log.records),
    finished: finishedFrom(input.log.records),
    ...(stall === undefined ? {} : { stall }),
    uncommitted,
    unparseableLines: input.unparseableLines,
  };
}
