/**
 * A pure projection from the dispatch log, comment store, and lane declarations
 * into the dashboard workbench (spec 0051 Requirement 2).
 *
 * The workbench is three columns: agent lanes and capacity on the left, work in
 * motion and its diff in the centre, and what needs a human on the right. The
 * model keeps the four legacy regions (Needs You, In Motion, Review, Done) as
 * the source of those columns, and adds the status, note exchange, and lane
 * state needed for the top bar and the three-column view.
 */
import { specDisplayName, type ParsedSpec } from './review/specs.js';
import type { DispatchRecord, OrchestratorReported } from '../executor/dispatch.js';
import { isInFlight } from '../executor/dispatch.js';
import type { DispatchLog } from '../executor/store.js';
import type { DispatchOutcomeKind, GateResult } from '../executor/outcome.js';
import { replayLaneRuntimes } from '../executor/replay.js';
import type { LaneDeclaration } from '../executor/lane.js';

import { detectStall, idleLanes, DEFAULT_STALL_INTERVAL_MINUTES } from '../executor/stall.js';
import { AGENT_AUTHOR, type CommentStore } from './review/comments.js';
import { taskIdIn } from './motion.js';
import type { LifecycleEvent, HookDecisionRecord } from '../cli/hook.js';
import { pathsWrittenByOutsideSessions } from './attribution.js';

export interface BoardModelInput {
  log: DispatchLog;
  comments: CommentStore;
  lanes: readonly LaneDeclaration[];
  /**
   * The specs the repository holds. To Do is drawn from these: a unit of work
   * is a spec with tasks left, not a dispatch that failed. Without them the
   * column is empty rather than wrong.
   */
  specs?: readonly ParsedSpec[];
  /** Epoch milliseconds the projection is built at. Defaults to `Date.now()`. */
  now?: number;
  /** Minutes without a new dispatch before a run is reported stalled. */
  stallAfterMinutes?: number;
  /** Optional project filter to hide cards not belonging to the project. */
  projectFilter?: string;
  lifecycleEvents?: readonly LifecycleEvent[];
  decisions?: readonly HookDecisionRecord[];
}

export interface BoardCard {
  kind: 'card';
  dispatchId: string;
  taskId?: string;
  description: string;
  laneId: string;
  outcome?: DispatchOutcomeKind;
  timestamp: string;
  openNotes: number;
  /** The outcome's one-line summary, when the dispatch has closed. */
  summary?: string;
  /** Paths the dispatch observed to have changed. */
  changedPaths?: string[];
  /** Paths the dispatch wrote outside its declared ownership. */
  outOfScopePaths?: string[];
  /**
   * The full spec id this dispatch belongs to (e.g. `"0051-kanban"`), when the
   * dispatch's task text names a spec that exists in the model. Absent when the
   * dispatch is a one-off brief not scoped to any spec.
   */
  specId?: string;
  /** Human-readable title for the spec, e.g. `"0051 · kanban"`. */
  specTitle?: string;
  /** What an In Progress card says it is doing. */
  phase?: CardPhase;
  /** The declaration claimed the repository root, so no write could be out of
   *  scope. An empty `outOfScopePaths` here means unchecked, not clean. */
  scopeUnchecked?: boolean;
  /** Paths the dispatch declared it could write. */
  ownedPaths?: string[];
  /** Gates that did not pass. */
  failedGates?: string[];
  /** Every gate result recorded for the dispatch. */
  gateResults?: GateResult[];
  /** The task id or dispatch id this open dispatch is waiting on, if it escalated. */
  blockedBy?: string;
  /** The project declared by the spec this card belongs to. */
  project?: string;
  /**
   * How long the dispatch was given, in milliseconds, when it was bounded.
   * Elapsed time on a running card means nothing without it.
   */
  deadlineMs?: number;
  /** Another session was active in this dispatch's window. */
  sharedWindow?: boolean;
  /** Paths written by sessions other than the dispatch's own. */
  writtenByOthers?: string[];
}

export interface BoardLaneAlert {
  kind: 'lane';
  laneId: string;
  resetAt?: string;
}

export interface BoardNote {
  id: number;
  author: string;
  body: string;
  /** Epoch milliseconds. */
  created: number;
  task?: string;
  status: 'open' | 'addressed';
  isAgent: boolean;
  orchestrator?: boolean;
  deliveredAt?: number;
}

export interface BoardStatus {
  needsYouCount: number;
  idle: number;
  idleLaneIds: readonly string[];
  totalLanes: number;
  running: number;
  stalled: boolean;
  stalledFor?: string;
  lastOpenedAt?: string;
}

/** A spec with work left and nothing running against it. */
export interface BoardTodo {
  kind: 'todo';
  specId: string;
  title: string;
  remaining: number;
  total: number;
  /** The next unfinished task, so the card says what would happen next. */
  nextTask?: { id: string; title: string };
  /** The project declared by the spec this todo belongs to. */
  project?: string;
}

export interface BoardModel {
  /**
   * Work with nothing running against it. Cards are specs, because a unit of
   * work is scoped by spec; a dispatch that failed is an alert, not a column.
   */
  todo: BoardTodo[];
  /**
   * Things wanting a person — failed dispatches, open notes, lanes out of
   * quota. Not a column: a column a card can only accumulate in stops being a
   * board and becomes a list of everything that ever happened.
   */
  alerts: (BoardCard | BoardLaneAlert)[];
  needsYou: (BoardCard | BoardLaneAlert)[];
  inMotion: BoardCard[];
  review: BoardCard[];
  done: BoardCard[];
  /** Open owner notes for the agent note exchange. */
  notes?: BoardNote[];
  /** Engine status for the orchestrator status bar. */
  status?: BoardStatus;
  /** The orchestrator's most recent self-report, when one exists. */
  orchestrator?: OrchestratorReported;
  /** All projects present across cards. */
  projects: string[];
  /** The active project filter, if any. */
  projectFilter?: string;
}

function oneLineDescription(task: string): string {
  const line = task.split(/\r?\n/).find((candidate) => candidate.trim().length > 0);
  return (line ?? task).trim().replace(/^T\d{4,}\s*[:—-]?\s*/, '');
}

function openNotesFor(taskId: string | undefined, comments: CommentStore): number {
  if (taskId === undefined) return 0;
  let count = 0;
  for (const comment of comments.comments) {
    if (
      comment.status === 'open' &&
      comment.author !== AGENT_AUTHOR &&
      comment.kind === 'note' &&
      comment.refs?.task === taskId
    ) {
      count += 1;
    }
  }
  return count;
}

function dispatchCard(
  record: DispatchRecord,
  comments: CommentStore,
  byDispatchId: ReadonlyMap<string, DispatchRecord>,
  decisions?: readonly HookDecisionRecord[],
  lifecycleEvents?: readonly LifecycleEvent[],
): BoardCard {
  const taskId = taskIdIn(record.declaration.task);
  const closed = record.closed;
  const openNotes = openNotesFor(taskId, comments);
  const description = oneLineDescription(record.declaration.task);

  let blockedBy: string | undefined;
  if (record.escalation !== undefined) {
    const prior = byDispatchId.get(record.escalation.priorDispatchId);
    const priorId = prior === undefined ? record.escalation.priorDispatchId : taskIdIn(prior.declaration.task);
    blockedBy = priorId ?? record.escalation.priorDispatchId;
  }

  const card: BoardCard = {
    kind: 'card',
    dispatchId: record.dispatchId,
    ...(taskId === undefined ? {} : { taskId }),
    description,
    laneId: record.assignment.laneId,
    ...(closed === undefined ? {} : { outcome: closed.outcome.kind }),
    timestamp: closed === undefined ? record.openedAt : closed.closedAt,
    openNotes,
    ownedPaths: [...record.declaration.ownedPaths],
    ...(blockedBy === undefined ? {} : { blockedBy }),
    ...(record.declaration.deadlineMs === undefined
      ? {}
      : { deadlineMs: record.declaration.deadlineMs }),
  };

  if (closed !== undefined) {
    card.summary = closed.outcome.summary;
    card.changedPaths = [...closed.outcome.changedPaths];
    card.outOfScopePaths = [...closed.outcome.outOfScopePaths];
    if (closed.outcome.scopeUnchecked === true) card.scopeUnchecked = true;
    card.failedGates = [...closed.outcome.failedGates];
    card.gateResults = [...closed.gateResults];

    if (card.outOfScopePaths.length > 0) {
      if (decisions) {
        const attributed = pathsWrittenByOutsideSessions({
          openedAt: record.openedAt,
          closedAt: closed.closedAt,
          paths: card.outOfScopePaths,
          decisions,
        });
        if (attributed.length > 0) {
          card.writtenByOthers = attributed.map((a) => a.path);
        }
      }

      if (lifecycleEvents) {
        const openedMs = Date.parse(record.openedAt);
        const closedMs = Date.parse(closed.closedAt);
        let shared = false;
        if (!Number.isNaN(openedMs) && !Number.isNaN(closedMs)) {
          const spans = new Map<string, { first: number; last: number }>();
          for (const ev of lifecycleEvents) {
            if (ev.sessionId === undefined || ev.sessionId === '') continue;
            const at = Date.parse(ev.at);
            if (Number.isNaN(at)) continue;
            const span = spans.get(ev.sessionId);
            if (span === undefined) {
              spans.set(ev.sessionId, { first: at, last: at });
            } else {
              if (at < span.first) span.first = at;
              if (at > span.last) span.last = at;
            }
          }
          for (const span of spans.values()) {
            if (span.first < openedMs && span.last > closedMs) {
              shared = true;
              break;
            }
          }
        }
        if (shared) {
          card.sharedWindow = true;
        }
      }
    }
  }

  return card;
}

/** How many finished items the Done column keeps. */
const DONE_LIMIT = 10;

/**
 * The four-digit spec numbers a dispatch names, from its work id and its task
 * text. A dispatch is tied to a spec by what it was asked to do; nothing else
 * records the link.
 */
export function specNumbersIn(record: DispatchRecord): string[] {
  const text = `${record.workId} ${record.declaration.task}`;
  const found = new Set<string>();
  for (const match of text.matchAll(/\b(\d{4})[-\s]/g)) {
    const id = match[1];
    if (id !== undefined) found.add(id);
  }
  return [...found];
}

/**
 * Where a dispatch sits, and what its card says about itself.
 *
 * Work that has finished and not been accepted stays In Progress and says
 * "ready for review". It is not a column of its own: the agent that produced it
 * is still the one to talk to about it, and a card that moved somewhere else
 * would have left that conversation behind.
 *
 * A failure is an alert rather than a column. A column whose cards cannot leave
 * accumulates, which is what a thousand-item Needs You was.
 */
function boardRegion(
  record: DispatchRecord,
  openNotes: number,
  acknowledged: ReadonlySet<string>,
): 'needs-you' | 'in-motion' | 'review' | 'done' {
  if (record.closed === undefined) return 'in-motion';
  const { outcome } = record.closed;
  const accepted = acknowledged.has(record.dispatchId);

  if (outcome.kind === 'succeeded') {
    if (accepted) return 'done';
    // Nothing changed, so there is nothing to review.
    if (outcome.changedPaths.length === 0) return 'done';
    // Finished, waiting on a person: still in motion, and the card says so.
    return 'in-motion';
  }

  // A failure a person has acknowledged is one they have dealt with.
  return accepted ? 'done' : 'needs-you';
}

/** What an In Progress card says it is doing. */
export type CardPhase = 'running' | 'ready-for-review';

function cardPhase(record: DispatchRecord, openNotes: number): CardPhase {
  if (record.closed !== undefined) return 'ready-for-review';
  return openNotes === 0 ? 'running' : 'ready-for-review';
}

function sortByTimestamp<T extends { timestamp: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

function sortNeedsYou(items: readonly (BoardCard | BoardLaneAlert)[]): (BoardCard | BoardLaneAlert)[] {
  return [...items].sort((a, b) => {
    const aTime = a.kind === 'card' ? a.timestamp : a.resetAt ?? '';
    const bTime = b.kind === 'card' ? b.timestamp : b.resetAt ?? '';
    return bTime.localeCompare(aTime);
  });
}

function buildNotes(comments: CommentStore): BoardNote[] {
  const notes: BoardNote[] = [];
  for (const comment of comments.comments) {
    if (comment.kind !== 'note' || comment.status !== 'open' || comment.author === AGENT_AUTHOR) continue;
    notes.push({
      id: comment.id,
      author: comment.author,
      body: comment.body,
      created: comment.created,
      status: comment.status,
      isAgent: comment.author === AGENT_AUTHOR,
      ...(comment.refs?.task === undefined ? {} : { task: comment.refs.task }),
      ...(comment.refs?.orchestrator === undefined ? {} : { orchestrator: comment.refs.orchestrator }),
      ...(comment.refs?.deliveredAt === undefined ? {} : { deliveredAt: comment.refs.deliveredAt }),
    });
  }
  return notes.sort((a, b) => b.created - a.created);
}

function formatDurationShort(ms: number): string {
  const minutes = ms / 60000;
  if (minutes < 60) {
    const rounded = Math.round(minutes);
    return `${rounded}m`;
  }
  const hours = minutes / 60;
  if (hours < 24) {
    return `${Number.isInteger(hours) ? String(Math.round(hours)) : hours.toFixed(1)}h`;
  }
  const days = Math.round(hours / 24);
  return `${days}d`;
}


export function buildBoardModel(input: BoardModelInput): BoardModel {
  const acknowledged = new Set(input.log.acknowledged);
  const needsYou: (BoardCard | BoardLaneAlert)[] = [];
  const inMotion: BoardCard[] = [];
  const review: BoardCard[] = [];
  const done: BoardCard[] = [];

  const byDispatchId = new Map<string, DispatchRecord>();
  for (const record of input.log.records) {
    byDispatchId.set(record.dispatchId, record);
  }

  const specById = new Map<string, ParsedSpec>();
  for (const spec of input.specs ?? []) {
    const numeric = spec.id.match(/^(\d{4})/)?.[1];
    if (numeric !== undefined) specById.set(numeric, spec);
  }

  for (const record of input.log.records) {
    const card = dispatchCard(record, input.comments, byDispatchId, input.decisions, input.lifecycleEvents);
    const [firstNumber] = specNumbersIn(record);
    if (firstNumber !== undefined) {
      const spec = specById.get(firstNumber);
      if (spec !== undefined) {
        if (spec.project !== undefined && spec.project !== '') card.project = spec.project;
        card.specId = spec.id;
        card.specTitle = specDisplayName(spec.id);
      }
    }

    card.phase = cardPhase(record, card.openNotes);
    const region = boardRegion(record, card.openNotes, acknowledged);
    switch (region) {
      case 'needs-you':
        needsYou.push(card);
        break;
      case 'in-motion':
        inMotion.push(card);
        break;
      case 'review':
        review.push(card);
        break;
      case 'done':
        done.push(card);
        break;
    }
  }

  const runtimes = replayLaneRuntimes(input.lanes, input.log.records);
  for (const runtime of runtimes) {
    if (runtime.cooldown !== undefined) {
      needsYou.push({ kind: 'lane', laneId: runtime.lane.id, resetAt: runtime.cooldown.since });
    }
  }

  // To Do is the specs with work left that nothing is running against. A spec
  // whose id appears in an open dispatch is in motion, not waiting.
  const inMotionSpecIds = new Set<string>();
  for (const record of input.log.records) {
    if (record.closed !== undefined) continue;
    for (const id of specNumbersIn(record)) inMotionSpecIds.add(id);
  }

  const todo: BoardTodo[] = [];
  for (const spec of input.specs ?? []) {
    const tasks = spec.sections.flatMap((section) => section.tasks);
    if (tasks.length === 0) continue;
    const remaining = tasks.filter((task) => !task.done);
    if (remaining.length === 0) continue;
    const numeric = spec.id.match(/^(\d{4})/)?.[1];
    if (numeric !== undefined && inMotionSpecIds.has(numeric)) continue;
    const next = remaining[0];
    todo.push({
      kind: 'todo',
      specId: spec.id,
      title: specDisplayName(spec.id),
      remaining: remaining.length,
      total: tasks.length,
      ...(spec.project !== undefined ? { project: spec.project } : {}),
      ...(next === undefined ? {} : { nextTask: { id: next.id, title: next.title } }),
    });
  }

  const notes = buildNotes(input.comments);

  const now = input.now ?? Date.now();
  const intervalMinutes = input.stallAfterMinutes ?? DEFAULT_STALL_INTERVAL_MINUTES;
  const idleLaneIds = idleLanes(runtimes);
  const running = input.log.records.filter((record) => isInFlight(record)).length;

  const openWorkExists = inMotion.length > 0 || needsYou.length > 0;
  const stall =
    openWorkExists
      ? detectStall({
          runtimes,
          records: input.log.records,
          openWorkExists,
          now: new Date(now),
          intervalMinutes,
        })
      : undefined;

  const status: BoardStatus = {
    needsYouCount: needsYou.length,
    idle: idleLaneIds.length,
    idleLaneIds,
    totalLanes: input.lanes.length,
    running,
    stalled: stall !== undefined,
    ...(stall === undefined
      ? {}
      : {
          stalledFor:
            stall.lastOpenedAt === undefined
              ? 'ever'
              : formatDurationShort(now - Date.parse(stall.lastOpenedAt)),
          lastOpenedAt: stall.lastOpenedAt,
        }),
  };

  const projectSet = new Set<string>();
  for (const card of todo) {
    if (card.project !== undefined) projectSet.add(card.project);
  }
  for (const card of [...inMotion, ...review, ...done, ...needsYou]) {
    if (card.kind === 'card' && card.project !== undefined) projectSet.add(card.project);
  }
  const projects = Array.from(projectSet).sort();

  let finalTodo = todo;
  let finalInMotion = inMotion;
  let finalReview = review;
  let finalDone = done;
  let finalNeedsYou = needsYou;

  if (input.projectFilter !== undefined && input.projectFilter !== '') {
    const p = input.projectFilter;
    finalTodo = todo.filter((c) => c.project === p);
    finalInMotion = inMotion.filter((c) => c.project === p);
    finalReview = review.filter((c) => c.project === p);
    finalDone = done.filter((c) => c.project === p);
    finalNeedsYou = needsYou.filter((c) => c.kind !== 'card' || c.project === p);
  }

  const sortedNeedsYou = sortNeedsYou(finalNeedsYou);
  return {
    todo: finalTodo,
    alerts: sortedNeedsYou,
    needsYou: sortedNeedsYou,
    inMotion: sortByTimestamp(finalInMotion),
    review: sortByTimestamp(finalReview),
    // Newest first, capped: the right-hand column is the last things to finish,
    // not a ledger of everything that ever did.
    done: sortByTimestamp(finalDone).slice(0, DONE_LIMIT),
    ...(notes.length > 0 ? { notes } : {}),
    status: {
      ...status,
      needsYouCount: finalNeedsYou.length,
    },
    ...(input.log.orchestrator === undefined ? {} : { orchestrator: input.log.orchestrator }),
    projects,
    ...(input.projectFilter !== undefined && input.projectFilter !== '' ? { projectFilter: input.projectFilter } : {}),
  };
}
