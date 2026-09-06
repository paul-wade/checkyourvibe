/**
 * Build the whole page model for one project (spec 0040 T40004).
 *
 * Reads only: the configuration, the dispatch log, the last run record, the
 * comment store, the spec files, git, and `PATH`. Runs no analyzer and no
 * executor. `HomePage` is handed to `renderHome`, which reads nothing.
 */
import { loadConfig } from '../config/load.js';
import {
  isInFlight,
  type DispatchRecord,
  type LaneRejection,
  type SchedulingRefusal,
} from '../executor/dispatch.js';
import { needsHumanAttention, type DispatchOutcome } from '../executor/outcome.js';
import { readDispatchLog, type DispatchLog, type ReadDispatchStats } from '../executor/store.js';
import { readLatestRun, type LatestRun } from './latest.js';
import { buildLanesRegion } from './lanes.js';
import { buildMotionRegion, taskIdIn } from './motion.js';
import { validateProjectPath } from './projects.js';
import {
  AGENT_AUTHOR,
  commentsToExchange,
  loadComments,
  type ReadState,
} from './review/comments.js';
import { readCursorFor } from './review/cursor.js';
import { stallIntervalMinutes } from '../executor/stall.js';
import { repoNeedsYou } from './review/needs-you.js';
import { parseAllSpecs, type SpecRollup } from './review/specs.js';
import type {
  CheckIndicator,
  Evidence,
  HomePage,
  MotionRegion,
  NeedsYouAction,
  NeedsYouItem,
  ProjectOption,
} from './view-model.js';
import { basename } from 'node:path';

/** Turns in the exchange before the page says how many older ones it is not showing. */
export const EXCHANGE_SHOWN = 12;

/** A run finished within this window is shown as measured rather than recorded. */
const FRESH_MS = 3 * 60_000;

export interface HomeModelInput {
  root: string;
  /** Every registered project root, for the selector. */
  registry: readonly string[];
  env: NodeJS.ProcessEnv;
  now?: Date;
}

/** `/view?p=<root>&f=<file>`: every page link carries the project it is about. */
export function hrefFor(root: string): (pathname: string, query?: Record<string, string>) => string {
  return (pathname, query = {}) => {
    const params = new URLSearchParams({ p: root, ...query });
    return `${pathname}?${params.toString()}`;
  };
}

function checkIndicator(latest: LatestRun | null, now: number): CheckIndicator {
  if (latest === null) return { state: 'never' };
  if (latest.status === 'running') {
    return { state: 'running', startedAt: latest.startedAt, mode: latest.mode };
  }
  const age = now - Date.parse(latest.finishedAt);
  const evidence: Evidence = Number.isNaN(age) ? 'unknown' : age < FRESH_MS ? 'measured' : 'recorded';
  return {
    state: 'finished',
    findings: latest.violationCount,
    filesChecked: latest.filesChecked,
    finishedAt: latest.finishedAt,
    mode: latest.mode,
    evidence,
  };
}

/** The spec task a dispatch's task text names, for a title a person recognises. */
function taskTitleFor(specs: SpecRollup, taskId: string | undefined): string | undefined {
  if (taskId === undefined) return undefined;
  for (const spec of specs.specs) {
    for (const section of spec.sections) {
      const task = section.tasks.find((candidate) => candidate.id === taskId);
      if (task !== undefined) return task.title;
    }
  }
  return undefined;
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim().length > 0);
  return (line ?? text).trim();
}

function subject(specs: SpecRollup, record: DispatchRecord): string {
  const taskId = taskIdIn(record.declaration.task);
  const title = taskTitleFor(specs, taskId);
  if (taskId !== undefined && title !== undefined) return `${taskId} · ${title}`;
  return firstLine(record.declaration.task).replace(/^T\d{4,}\s*[:—-]?\s*/, '');
}

/** Why a lane was not a candidate, in plain words. */
function ineligibilityLine(rejection: LaneRejection): string {
  const reason = rejection.reason;
  switch (reason.reason) {
    case 'lane-not-declared':
      return `${rejection.laneId}: no lane with this id is declared`;
    case 'not-the-named-lane':
      return `${rejection.laneId}: the dispatch named ${reason.namedLaneId}`;
    case 'metered-not-named':
      return `${rejection.laneId}: metered, and only a dispatch that names it may reach it`;
    case 'no-model-for-kind':
      return `${rejection.laneId}: declares no model for ${reason.taskKind}`;
    case 'does-not-accept-dispatch':
      return `${rejection.laneId}: ${reason.orchestrator ? 'the orchestrating lane, reserved' : 'does not accept dispatch'}`;
    case 'in-cooldown':
      return `${rejection.laneId}: cooling since ${reason.since} after ${reason.cause}`;
    case 'at-concurrency-cap':
      return `${rejection.laneId}: at its cap, ${reason.inFlight} of ${reason.concurrencyCap} running`;
    case 'at-global-cap':
      return `${rejection.laneId}: the run is at its cap, ${reason.openDispatches} of ${reason.maxConcurrentDispatches} open across every lane`;
  }
}

/** The question a closed outcome asks, and what the lane is doing about it. */
function outcomeQuestion(outcome: DispatchOutcome, laneId: string): { question: string; detail: string[] } {
  switch (outcome.kind) {
    case 'produced-nothing':
      return {
        question: `Was that a refusal, a limit, or a task with nothing left to do? ${laneId} is cooling until a dispatch to it changes files.`,
        detail: [],
      };
    case 'out-of-scope-write':
      return {
        question: 'Keep the change and widen the task’s scope, or discard it?',
        detail: outcome.outOfScopePaths.map((path) => `wrote outside scope: ${path}`),
      };
    case 'gates-failed':
      return {
        question: 'Every attempt failed its gates. Rewrite the task, or try it on another lane?',
        detail: outcome.failedGates.map((gate) => `gate failed: ${gate}`),
      };
    case 'changed-files-unexpectedly':
      return {
        question: 'It was declared to change nothing and changed files. Keep them, or revert?',
        detail: outcome.changedPaths.map((path) => `changed: ${path}`),
      };
    case 'rate-limited':
      return {
        question: `${laneId} reported its limit and is cooling. Wait it out, or send the work to another lane?`,
        detail: [],
      };
    case 'did-not-complete':
      return { question: 'It never finished. Dispatch it again, or drop it?', detail: [] };
    case 'failed':
      return {
        question: 'The executor reported failure and changed nothing. Retry, rewrite, or drop?',
        detail: [],
      };
    case 'succeeded':
      return { question: 'Nothing to decide.', detail: [] };
  }
}

function refusalDetail(refusal: SchedulingRefusal): string[] {
  if (refusal.reason === 'overlapping-ownership') {
    return refusal.conflicts.map(
      (conflict) => `overlaps ${conflict.withDispatchId} on ${conflict.laneId}: ${conflict.paths.join(', ')}`,
    );
  }
  return refusal.rejections.map(ineligibilityLine);
}

function tell(subjectLine: string, taskId?: string): NeedsYouAction {
  return {
    kind: 'tell',
    label: 'tell the agent',
    prefill: `Re ${subjectLine}: `,
    ...(taskId === undefined ? {} : { task: taskId }),
  };
}

/**
 * What the log says needs a person, each as a question with its answers:
 * closed dispatches whose outcome does (0011 R10.4), refusals, open dispatches
 * judged abandoned or undetermined (0036 R7.4), and the stall (0036 R7.3).
 * An acknowledged dispatch has been answered and is left out.
 */
function logNeedsYou(
  log: DispatchLog,
  motion: MotionRegion,
  specs: SpecRollup,
  href: (pathname: string, query?: Record<string, string>) => string,
): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  const home = `${href('/')}#motion`;
  const acknowledged = new Set(log.acknowledged);

  // Only the latest attempt at a unit of work can still be waiting on a
  // person: an earlier attempt's outcome was answered by the attempt after it.
  const latestAttempt = new Map<string, DispatchRecord>();
  for (const record of log.records) {
    const current = latestAttempt.get(record.workId);
    if (current === undefined || current.attempt < record.attempt) {
      latestAttempt.set(record.workId, record);
    }
  }

  for (const record of latestAttempt.values()) {
    const closed = record.closed;
    if (closed === undefined || !needsHumanAttention(closed.outcome)) continue;
    if (acknowledged.has(record.dispatchId)) continue;
    const what = subject(specs, record);
    const taskId = taskIdIn(record.declaration.task);
    const asked = outcomeQuestion(closed.outcome, record.assignment.laneId);
    items.push({
      kind: 'dispatch',
      id: taskId ?? record.dispatchId,
      title: `${what} — ${closed.outcome.kind.replace(/-/g, ' ')} on ${record.assignment.laneId}`,
      question: asked.question,
      detail: asked.detail.length === 0 ? [closed.outcome.summary] : asked.detail,
      where: `lane ${record.assignment.laneId}, attempt ${record.attempt}`,
      href: home,
      at: closed.closedAt,
      actions: [
        tell(taskId ?? record.dispatchId, taskId),
        { kind: 'dismiss', label: 'needs nothing', itemId: record.dispatchId },
      ],
    });
  }

  for (const refused of log.refusals) {
    // A refusal answered by a later dispatch of the same work is history.
    if (latestAttempt.has(refused.workId) || acknowledged.has(refused.dispatchId)) continue;
    const taskId = taskIdIn(refused.declaration.task);
    const title = taskTitleFor(specs, taskId);
    const what =
      taskId !== undefined && title !== undefined ? `${taskId} · ${title}` : firstLine(refused.declaration.task);
    const overlap = refused.refusal.reason === 'overlapping-ownership';
    items.push({
      kind: 'dispatch',
      id: taskId ?? refused.dispatchId,
      title: `${what} — ${overlap ? 'refused: overlaps a running dispatch' : 'refused: no lane could take it'}`,
      question: overlap
        ? 'It declares files a running dispatch owns. Wait for that one to close, or split the task?'
        : 'Nothing could take it. Free a lane, change the task’s kind, or let the orchestrator run it itself?',
      detail: refusalDetail(refused.refusal),
      where: 'scheduling',
      href: home,
      at: refused.refusedAt,
      actions: [
        tell(taskId ?? refused.dispatchId, taskId),
        { kind: 'dismiss', label: 'needs nothing', itemId: refused.dispatchId },
      ],
    });
  }

  for (const running of motion.running) {
    if (running.liveness === 'live') continue;
    const what = running.taskId === undefined ? running.task : `${running.taskId} · ${running.task}`;
    const abandoned = running.liveness === 'abandoned';
    items.push({
      kind: 'liveness',
      id: running.taskId ?? running.dispatchId,
      title: `${what} — ${abandoned ? 'its supervising process is gone' : 'cannot tell whether it is still running'}`,
      question: abandoned
        ? 'The record is still open and holds its lane. Close it and dispatch the task again?'
        : 'Leave it open, or tell the agent what you know about it?',
      detail: [running.livenessReason, `opened ${running.openedAt} on ${running.laneId}`],
      where: `lane ${running.laneId}`,
      href: home,
      at: running.openedAt,
      actions: [
        ...(abandoned
          ? [{ kind: 'close', label: 'close the record', dispatchId: running.dispatchId } satisfies NeedsYouAction]
          : []),
        tell(running.taskId ?? running.dispatchId, running.taskId),
      ],
    });
  }

  const stall = motion.stall;
  if (stall !== undefined) {
    items.push({
      kind: 'stall',
      id: 'stall',
      title: `Nothing dispatched for ${stall.intervalMinutes}m while ${stall.idleLanes.length} lane(s) sit free and work is open`,
      question:
        'Is the orchestrating session still running? If it is waiting on you, answer it below. If it is gone, start a new session in this folder and it will read the state from disk.',
      detail: [`free: ${stall.idleLanes.join(', ')}`, ...(stall.lastOpenedAt === undefined ? [] : [`last dispatch opened ${stall.lastOpenedAt}`])],
      where: 'the run',
      href: home,
      ...(stall.lastOpenedAt === undefined ? {} : { at: stall.lastOpenedAt }),
      actions: [{ kind: 'tell', label: 'tell the agent', prefill: 'Are you still there? The run has been quiet: ' }],
    });
  }

  return items;
}

/**
 * Only what decides whether to open a project: whether it is reachable, what
 * needs a person, and what is in flight. Read from that project's own files.
 */
async function projectOption(root: string): Promise<ProjectOption> {
  const check = await validateProjectPath(root);
  const name = basename(root);
  if (!check.ok) {
    return {
      root,
      name,
      reachable: false,
      unreachableReason: check.exists
        ? 'present, but has no checkyourvibe.json'
        : 'directory is missing',
    };
  }
  const [log, comments] = await Promise.all([readDispatchLog(root), loadComments(root)]);
  const inFlight = log.records.filter((record) => isInFlight(record)).length;
  const needsCount = comments.comments.filter(
    (comment) =>
      comment.status === 'open' && comment.author !== AGENT_AUTHOR && comment.kind === 'note',
  ).length;
  return { root, name, reachable: true, needsCount, inFlight };
}

export async function buildHomePage(input: HomeModelInput): Promise<HomePage> {
  const now = input.now ?? new Date();
  const root = input.root;
  const href = hrefFor(root);
  const stats: ReadDispatchStats = { unparseableLines: 0 };

  const [config, log, latest, comments, specs, projects] = await Promise.all([
    loadConfig(root),
    readDispatchLog(root, stats),
    readLatestRun(root),
    loadComments(root),
    parseAllSpecs(root),
    Promise.all(input.registry.map((candidate) => projectOption(candidate))),
  ]);

  // What the agent has read is the cursor and nothing else (spec 0042
  // Requirement 3.3). It lives in the home directory rather than the repository
  // because it is the watcher's memory, not the project's.
  const readState: ReadState = { cursor: await readCursorFor(root), now: now.getTime() };

  const [motion, lanes, repoItems] = await Promise.all([
    buildMotionRegion({
      repo: root,
      config,
      log,
      specs,
      now,
      unparseableLines: stats.unparseableLines,
    }),
    buildLanesRegion({ config, log, env: input.env, cwd: root }),
    repoNeedsYou(root, comments, href, {
      read: readState,
      thresholdMs: stallIntervalMinutes(config) * 60_000,
    }),
  ]);

  // A task or parked entry the person dismissed from the page stays dismissed
  // until its id changes; a note is cleared by marking it addressed instead.
  const acknowledged = new Set(log.acknowledged);
  const repoStillOpen = repoItems.filter((item) => !acknowledged.has(item.id));
  const needsYou = [...logNeedsYou(log, motion, specs, href), ...repoStillOpen].sort((a, b) =>
    (b.at ?? '').localeCompare(a.at ?? ''),
  );

  const executionHistory = log.records
    .flatMap((r) => {
      const closed = r.closed;
      if (closed === undefined) {
        return [];
      }
      return [
        {
          id: r.dispatchId,
          task: firstLine(r.declaration.task),
          laneId: r.assignment.laneId,
          model: r.assignment.model,
          outcome: closed.outcome.kind,
          finishedAt: closed.closedAt,
        },
      ];
    })
    .slice(-10);

  return {
    project: { root, name: basename(root) },
    projects,
    check: checkIndicator(latest, now.getTime()),
    needsYou,
    motion,
    lanes,
    exchange: commentsToExchange(comments, EXCHANGE_SHOWN, readState),
    executionHistory,
    now: now.getTime(),
  };
}
