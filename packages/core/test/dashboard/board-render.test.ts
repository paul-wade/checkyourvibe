import { describe, expect, it } from 'vitest';

import { boardCss, renderBoard, renderBoardFragment } from '../../src/dashboard/board-render.js';
import { buildBoardModel } from '../../src/dashboard/board-model.js';
import type {
  BoardTodo, BoardCard, BoardLaneAlert, BoardModel, BoardNote, BoardStatus } from '../../src/dashboard/board-model.js';
import { dashboardCss } from '../../src/dashboard/styles.js';
import { classifyOutcome, type DispatchOutcomeKind } from '../../src/executor/outcome.js';
import type { DispatchAssignment, DispatchRecord } from '../../src/executor/dispatch.js';
import type { DispatchLog } from '../../src/executor/store.js';
import type { CommentStore } from '../../src/dashboard/review/comments.js';
import type { SessionView } from '../../src/dashboard/session-manager.js';
import { declaration, lane, report } from '../executor/fixtures.js';

const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const TIMESTAMP = '2026-09-01T11:00:00.000Z';

interface CardOverrides {
  taskId?: string;
  description?: string;
  laneId?: string;
  outcome?: DispatchOutcomeKind;
  timestamp?: string;
  openNotes?: number;
  summary?: string;
  ownedPaths?: string[];
  changedPaths?: string[];
  outOfScopePaths?: string[];
  writtenByOthers?: string[];
  sharedWindow?: boolean;
  failedGates?: string[];
  gateResults?: { gate: string; passed: boolean; detail?: string }[];
  blockedBy?: string;
  deadlineMs?: number;
}

function card(dispatchId: string, overrides: CardOverrides = {}): BoardCard {
  return {
    kind: 'card',
    dispatchId,
    ...(overrides.taskId === undefined ? {} : { taskId: overrides.taskId }),
    description: overrides.description ?? 'do the thing',
    laneId: overrides.laneId ?? 'alpha',
    ...(overrides.outcome === undefined ? {} : { outcome: overrides.outcome }),
    timestamp: overrides.timestamp ?? TIMESTAMP,
    openNotes: overrides.openNotes ?? 0,
    ...(overrides.summary === undefined ? {} : { summary: overrides.summary }),
    ...(overrides.ownedPaths === undefined ? {} : { ownedPaths: overrides.ownedPaths }),
    ...(overrides.changedPaths === undefined ? {} : { changedPaths: overrides.changedPaths }),
    ...(overrides.outOfScopePaths === undefined ? {} : { outOfScopePaths: overrides.outOfScopePaths }),
    ...(overrides.writtenByOthers === undefined ? {} : { writtenByOthers: overrides.writtenByOthers }),
    ...(overrides.sharedWindow === undefined ? {} : { sharedWindow: overrides.sharedWindow }),
    ...(overrides.failedGates === undefined ? {} : { failedGates: overrides.failedGates }),
    ...(overrides.gateResults === undefined ? {} : { gateResults: overrides.gateResults }),
    ...(overrides.blockedBy === undefined ? {} : { blockedBy: overrides.blockedBy }),
    deadlineMs: overrides.deadlineMs ?? 45 * 60_000,
  };
}

interface ModelOverrides {
  todo?: BoardTodo[];
  needsYou?: (BoardCard | BoardLaneAlert)[];
  inMotion?: BoardCard[];
  review?: BoardCard[];
  done?: BoardCard[];
  notes?: BoardNote[];
  status?: BoardStatus;
  projects?: string[];
}

function model(overrides: ModelOverrides = {}): BoardModel {
  return {
    todo: overrides.todo ?? [],
    alerts: overrides.needsYou ?? [],
    needsYou: overrides.needsYou ?? [],
    inMotion: overrides.inMotion ?? [],
    review: overrides.review ?? [],
    done: overrides.done ?? [],
    projects: overrides.projects ?? [],
    ...(overrides.notes === undefined ? {} : { notes: overrides.notes }),
    ...(overrides.status === undefined ? {} : { status: overrides.status }),
  };
}

function status(overrides: Partial<BoardStatus> = {}): BoardStatus {
  return {
    needsYouCount: 0,
    idle: 0,
    idleLaneIds: [],
    totalLanes: 0,
    running: 0,
    stalled: false,
    ...overrides,
  };
}

/**
 * The markup inside the first `<tag>` carrying the marker string, from its
 * start to the matching `</tag>`. The tag may be nested inside itself, so the
 * matcher counts depth rather than stopping at the first closing tag.
 */
function elementSlice(html: string, markerAt: number, tag: string, what: string): string {
  const start = html.lastIndexOf(`<${tag}`, markerAt);
  if (start < 0) throw new Error(`opening <${tag}> for ${what} not found`);

  const openTag = `<${tag}`;
  const closeTag = `</${tag}>`;
  let depth = 0;
  let i = start;

  while (i < html.length) {
    const openAt = html.indexOf(openTag, i);
    const closeAt = html.indexOf(closeTag, i);

    if (closeAt < 0) throw new Error(`closing </${tag}> for ${what} not found`);
    if (openAt >= 0 && openAt < closeAt) {
      depth += 1;
      i = openAt + openTag.length;
    } else {
      if (depth === 0) throw new Error(`unbalanced ${tag} around ${what}`);
      depth -= 1;
      if (depth === 0) return html.slice(start, closeAt + closeTag.length);
      i = closeAt + closeTag.length;
    }
  }

  throw new Error(`closing </${tag}> for ${what} not found`);
}

function idSlice(html: string, id: string, tag: string): string {
  const idAt = html.indexOf(`id="${id}"`);
  if (idAt < 0) throw new Error(`id ${id} was not rendered`);
  return elementSlice(html, idAt, tag, `id ${id}`);
}

/**
 * The things needing a person, which live behind the bell rather than in a
 * column. Same content, different home.
 */
function alertsSlice(html: string): string {
  const at = html.indexOf('id="board-alerts"');
  if (at < 0) throw new Error('the alerts panel was not rendered');
  return elementSlice(html, at, 'div', 'alerts panel');
}

function columnSlice(html: string, columnId: string): string {
  const marker = `data-column="${columnId}"`;
  const at = html.indexOf(marker);
  if (at < 0) throw new Error(`column ${columnId} was not rendered`);
  return elementSlice(html, at, 'section', `column ${columnId}`);
}

function closedDispatch(dispatchId: string, changedPaths: string[]): DispatchRecord {
  const outcome = classifyOutcome({
    expectsFileChanges: changedPaths.length > 0,
    ownedPaths: ['src/a.ts'],
    changedPaths,
    gates: [{ gate: 'cyv-check', passed: true }],
    report: report('success'),
  });
  const assignment: DispatchAssignment = {
    laneId: 'alpha',
    agentId: 'alpha-agent',
    model: 'weak',
    billing: 'subscription',
    permitsBilledOverage: false,
    orchestrator: false,
    declaredHeadroomAtSchedule: 1,
  };
  return {
    dispatchId,
    workId: dispatchId,
    attempt: 1,
    openedAt: TIMESTAMP,
    declaration: declaration({ task: 'T1234 Do the thing' }),
    assignment,
    closed: { closedAt: '2026-09-01T11:30:00.000Z', report: report('success'), gateResults: [], outcome },
  };
}

describe('renderBoard', () => {
  it('renders the workbench with a top bar, lane strip and orchestrator status', () => {
    const html = renderBoard({
      model: model({
        inMotion: [card('d-motion', { taskId: 'T1234' })],
        status: status({ needsYouCount: 1, idle: 1, totalLanes: 2, running: 1 }),
      }),
      lanes: [lane({ id: 'alpha' }), lane({ id: 'beta' })],
      now: NOW,
    });

    expect(html).toContain('checkyourvibe');
    // No session has fired a hook in this fixture, so the board is not entitled
    // to say the orchestrator is running. It used to say so on the strength of
    // the stall detector being quiet, which is not evidence that anything is
    // alive — a self-report from six days earlier read as a current state.
    expect(html).not.toContain('Orchestrator running');
    expect(html).toContain('no session seen');
    // One line carries the whole lane picture. The KPI trio beside it said the
    // same three numbers a second time, and the bell says the third.
    expect(html).toContain('1 of 2 lanes free');
    expect(html).toContain('1 running');
    expect(html).not.toContain('Lanes Idle');
    expect(html).not.toContain('Tasks Running');
    expect(html).toContain('Needs You');
    expect(html).toContain('In Progress');
    expect(html).toContain('Review');
    expect(html).toContain('Done');
    expect(html).toContain('Lane Status');
  });

  it('shows a stall signal when the model says the orchestrator is stalled', () => {
    const html = renderBoard({
      model: model({
        status: status({ stalled: true, stalledFor: '4.5h', idle: 1, running: 0 }),
      }),
      lanes: [lane({ id: 'alpha' })],
      now: NOW,
    });

    expect(html).toContain('ORCHESTRATOR STALLED (4.5h)');
    expect(html).toContain('1 of 0 lanes free');
    expect(html).toContain('0 running');
  });

  // Three columns, and a unit of work is a spec. A dispatch that failed is an
  // alert behind the bell rather than a column of its own: a column nothing can
  // leave stops being a board and becomes a list of everything that happened.
  it('renders three kanban columns left to right: To Do, In Progress, Done', () => {
    const html = renderBoard({
      model: model({
        todo: [{ kind: 'todo', specId: '0051-kanban', title: '0051 · kanban', remaining: 2, total: 5 }],
        needsYou: [card('d-needs', { outcome: 'failed' })],
        inMotion: [card('d-motion', { taskId: 'T1234' })],
        done: [card('d-done', { outcome: 'succeeded' })],
        status: status({ needsYouCount: 1, idle: 1, totalLanes: 1, running: 1 }),
      }),
      lanes: [lane({ id: 'alpha' })],
      now: NOW,
    });

    const todo = columnSlice(html, 'todo');
    const inProgress = columnSlice(html, 'in-progress');
    const done = columnSlice(html, 'done');

    expect(html.indexOf(todo)).toBeLessThan(html.indexOf(inProgress));
    expect(html.indexOf(inProgress)).toBeLessThan(html.indexOf(done));

    expect(todo).toContain('To Do');
    expect(todo).toContain('0051-kanban');
    expect(todo).toContain('2 of 5 tasks left');

    expect(inProgress).toContain('In Progress');
    expect(inProgress).toContain('d-motion');
    expect(inProgress).toContain('T1234');

    expect(done).toContain('Done');
    expect(done).toContain('d-done');

    // The failed dispatch is reachable, behind the bell.
    expect(html).toContain('board-alerts');
    expect(html).toContain('d-needs');
  });

  it('places a dispatch card in the board for later selection wiring', () => {
    const html = renderBoard({
      model: model({ inMotion: [card('d-motion', { taskId: 'T1234' })] }),
      lanes: [],
      now: NOW,
    });

    expect(html).toContain('board-kanban-card');
    expect(html).toContain('data-dispatch="d-motion"');
  });

  it('renders lane capacity, billing tier, model, and state in the compact strip', () => {
    const html = renderBoard({
      model: model({
        inMotion: [card('d-run', { laneId: 'beta' })],
        needsYou: [{ kind: 'lane', laneId: 'alpha', resetAt: '2026-09-02T03:00:00.000Z' }],
        status: status({ totalLanes: 3, idle: 1, running: 1 }),
      }),
      lanes: [lane({ id: 'alpha' }), lane({ id: 'beta', metered: true }), lane({ id: 'gamma' })],
      now: NOW,
    });

    const strip = idSlice(html, 'board-lanes', 'div');
    expect(strip).toContain('alpha');
    expect(strip).toContain('EXHAUSTED');
    expect(strip).toContain('subscription');
    expect(strip).toContain('beta');
    expect(strip).toContain('metered');
    expect(strip).toContain('RUNNING');
    expect(strip).toContain('gamma');
    expect(strip).toContain('FREE');
  });

  it('shows an in-progress card with task id, description, lane, status, owned paths and elapsed time', () => {
    const html = renderBoard({
      model: model({
        inMotion: [
          card('d-1', {
            taskId: 'T1234',
            description: 'render the board',
            laneId: 'beta',
            ownedPaths: ['packages/core/src/board.ts'],
          }),
        ],
      }),
      lanes: [lane({ id: 'beta' })],
      now: NOW,
    });

    const inProgress = columnSlice(html, 'in-progress');
    expect(inProgress).toContain('T1234');
    expect(inProgress).toContain('render the board');
    expect(inProgress).toContain('packages/core/src/board.ts');
    expect(inProgress).toContain('beta');
    expect(inProgress).toContain('running for');
    expect(inProgress).toContain('Stop');
    expect(inProgress).toContain('Abandon');
  });

  // Eleven dispatches declared fifty minutes and ended at five, and nothing on
  // the board said what the elapsed time was elapsed against.
  // The lane strip read "3 of 1 running" beside a top bar that said "0
  // running": In Progress holds finished-but-unreviewed cards too, and those
  // hold no slot.
  // "ORCHESTRATOR STALLED" beside a session that had committed four times in
  // the last hour reads as an alarm about something that is working.
  it('says a session editing directly is working, not stalled', () => {
    const stalled = status({ stalled: true, stalledFor: '39m', idle: 1, running: 0 });
    const live: SessionView[] = [
      {
        sessionId: 's1',
        projectRoot: 'R:/repo',
        agentId: 'claude-code',
        state: 'running',
        pid: 0,
        startedAt: '2026-09-01T11:00:00.000Z',
        uptimeMs: 3_480_000,
        alive: true,
        statusSource: 'hook',
        observed: true,
        activeTurns: 0,
        lastEventAt: '2026-09-01T11:58:00.000Z',
      },
    ];

    const editing = renderBoard({
      model: model({ status: stalled }),
      lanes: [],
      sessions: live,
      gate: { considered: 40, unjudged: 0, lastWriteAt: '2026-09-01T11:58:00.000Z' },
      now: NOW,
    });
    expect(editing).toContain('a session is editing directly');
    expect(editing).not.toContain('ORCHESTRATOR STALLED');

    // A live session that has written nothing for hours is the case the
    // stall badge is for, and it still says so.
    const idle = renderBoard({
      model: model({ status: stalled }),
      lanes: [],
      sessions: live,
      gate: { considered: 0, unjudged: 0, lastWriteAt: '2026-09-01T08:00:00.000Z' },
      now: NOW,
    });
    expect(idle).toContain('ORCHESTRATOR STALLED');
    expect(idle).toContain('A SESSION IS LIVE BUT NOT DISPATCHING');
  });

  it('counts only executing dispatches against a lane cap', () => {
    const finished = card('d-reviewing', { outcome: 'succeeded', laneId: 'alpha' });
    const executing = card('d-executing', { laneId: 'alpha' });
    const html = renderBoard({
      model: model({ inMotion: [finished, executing] }),
      lanes: [lane({ id: 'alpha' })],
      now: NOW,
    });

    // The lane fixture's cap is 2; what matters is that the finished card is
    // not counted against it.
    expect(html).toContain('1 of 2 running');
    expect(html).toContain('1 waiting for review');
    expect(html).not.toContain('2 of 2 running');
  });

  it('says how much of its deadline a running dispatch has used', () => {
    const html = renderBoard({
      model: model({
        inMotion: [card('d-running', { timestamp: '2026-09-01T11:45:00.000Z' })],
      }),
      lanes: [],
      now: NOW,
    });

    // Fifteen minutes in, out of forty-five.
    expect(columnSlice(html, 'in-progress')).toContain('15 of 45 min');
  });

  it('says plainly when a running dispatch has no deadline at all', () => {
    const withoutDeadline = card('d-unbounded', { timestamp: '2026-09-01T11:45:00.000Z' });
    delete withoutDeadline.deadlineMs;
    const html = renderBoard({ model: model({ inMotion: [withoutDeadline] }), lanes: [], now: NOW });

    // An unbounded run is not the same as a generous one.
    expect(columnSlice(html, 'in-progress')).toContain('no deadline');
  });

  it('renders a blocked in-progress card downstream of its dependency', () => {
    const html = renderBoard({
      model: model({
        inMotion: [
          card('d-1', { taskId: 'T1234' }),
          card('d-2', { taskId: 'T1235', blockedBy: 'T1234' }),
        ],
      }),
      lanes: [lane({ id: 'alpha' })],
      now: NOW,
    });

    const inProgress = columnSlice(html, 'in-progress');
    expect(inProgress).toContain('Blocked');
    expect(inProgress).toContain('T1235');
    expect(inProgress).toContain('waits on T1234');
  });

  it('shows a finished card with outcome, scope split, and out-of-scope state', () => {
    const html = renderBoard({
      model: model({
        done: [
          card('d-review', {
            outcome: 'succeeded',
            summary: 'changed one file',
            ownedPaths: ['src/a.ts', 'src/b.ts'],
            changedPaths: ['src/a.ts', 'src/x.ts'],
            outOfScopePaths: ['src/x.ts'],
            writtenByOthers: ['src/x.ts'],
          }),
        ],
      }),
      lanes: [lane({ id: 'alpha' })],
      now: NOW,
    });

    const review = columnSlice(html, 'done');
    expect(review).toContain('d-review');
    expect(review).toContain('succeeded');
    
    // Proving the content survives and renders before the changed paths.
    const outIndex = review.indexOf('src/x.ts out of scope');
    const changedIndex = review.indexOf('changed:');
    
    expect(outIndex).toBeGreaterThan(0);
    expect(changedIndex).toBeGreaterThan(0);
    expect(outIndex).toBeLessThan(changedIndex);
    
    // The note must be attached to the out-of-scope text
    expect(review).toContain('src/x.ts out of scope</span> <span class="board-scope-note');
    
    // A card with none renders exactly what it renders today: assert the current string.
    const cleanHtml = renderBoard({
      model: model({
        done: [
          card('d-clean', {
            outcome: 'succeeded',
            ownedPaths: ['src/a.ts'],
            changedPaths: ['src/a.ts'],
            outOfScopePaths: [],
          }),
        ],
      }),
      lanes: [lane({ id: 'alpha' })],
      now: NOW,
    });
    const cleanReview = columnSlice(cleanHtml, 'done');
    expect(cleanReview).toContain('<p class="font-mono-sm text-outline truncate board-card-scope">changed: <code>src/a.ts</code></p>');
  });

  it('shows a done card with outcome and supports older collapsing', () => {
    const html = renderBoard({
      model: model({
        done: [
          card('d-new', { outcome: 'succeeded', timestamp: '2026-08-20T11:00:00.000Z' }),
          card('d-mid', { outcome: 'succeeded', timestamp: '2026-08-19T11:00:00.000Z' }),
          card('d-old', { outcome: 'succeeded', timestamp: '2026-08-18T11:00:00.000Z' }),
          card('d-older', { outcome: 'succeeded', timestamp: '2026-08-17T11:00:00.000Z' }),
        ],
      }),
      lanes: [lane({ id: 'alpha' })],
      now: NOW,
    });

    const done = idSlice(html, 'board-done-body', 'div');
    expect(done).toContain('d-new');
    expect(done).toContain('d-old');
    expect(done).toContain('<details class="board-older">');
    expect(done).toContain('1 older dispatch');
    const collapsedAt = done.indexOf('board-older');
    expect(done.indexOf('d-older')).toBeGreaterThan(collapsedAt);
  });

  it('renders the needs-you decision card and its actions', () => {
    const html = renderBoard({
      model: model({
        needsYou: [
          card('d-needs', {
            outcome: 'produced-nothing',
            summary: 'the executor reported success and no files changed',
          }),
        ],
        done: [card('d-done', { outcome: 'succeeded' })],
        status: status({ needsYouCount: 1 }),
      }),
      lanes: [lane({ id: 'alpha' })],
      now: NOW,
    });

    const needsYou = alertsSlice(html);
    expect(needsYou).toContain('d-needs');
    expect(needsYou).toContain('The problem:');
    expect(needsYou).toContain('produced-nothing');
    expect(needsYou).toContain('Acknowledge');
    expect(needsYou).toContain('Inspect');
  });

  it('renders a retry control on gate-failed decision cards', () => {
    const html = renderBoard({
      model: model({
        needsYou: [card('d-fail', { outcome: 'gates-failed', failedGates: ['typecheck'], summary: 'gate failed' })],
      }),
      lanes: [lane({ id: 'alpha' })],
      now: NOW,
    });

    const needsYou = alertsSlice(html);
    expect(needsYou).toContain('data-action="retry"');
    expect(needsYou).toContain('data-dispatch="d-fail"');
  });

  it('renders the agent note exchange with mark-addressed and reply actions', () => {
    const html = renderBoard({
      model: model({
        notes: [
          { id: 1, author: 'owner', body: 'what about the edge case?', created: NOW - 60000, status: 'open', isAgent: false },
          { id: 2, author: 'owner', body: 'also check tests', created: NOW - 120000, task: 'T1234', status: 'open', isAgent: false },
        ],
      }),
      lanes: [],
      now: NOW,
    });

    const needsYou = alertsSlice(html);
    expect(needsYou).toContain('Agent Note Exchange');
    expect(needsYou).toContain('Note #1');
    expect(needsYou).toContain('what about the edge case?');
    expect(needsYou).toContain('data-action="note-status"');
    expect(needsYou).toContain('Mark Addressed');
    expect(needsYou).toContain('data-action="note-reply"');
    expect(needsYou).toContain('>Reply</button>');
  });

  it('shows the whole conversation: agent notes distinct, unread ones called out, statuses shown', () => {
    const html = renderBoard({
      model: model(),
      lanes: [],
      now: NOW,
      exchange: {
        entries: [
          { id: 1, author: 'owner', isAgent: false, kind: 'note', body: 'old and done', created: NOW - 120000, status: 'addressed' },
          { id: 2, author: 'owner', isAgent: false, kind: 'note', body: 'please check', created: NOW - 60000, status: 'open', readByAgent: false },
          { id: 3, author: 'checkyourvibe', isAgent: true, kind: 'turn', body: 'the agent replied', created: NOW - 30000, status: 'open' },
        ],
        omitted: 0,
        drafts: [],
      },
    });

    const needsYou = alertsSlice(html);
    expect(needsYou).toContain('owner · Note #2');
    expect(needsYou).toContain('agent · Note #3');
    expect(needsYou).toContain('board-note--agent');
    expect(needsYou).toContain('board-note--unread');
    expect(needsYou).toContain('>unread</span>');
    expect(needsYou).toContain('>unread by the agent</span>');
    expect(needsYou).toContain('>addressed</span>');
    // Newest first.
    expect(needsYou.indexOf('Note #3')).toBeLessThan(needsYou.indexOf('Note #2'));
    expect(needsYou.indexOf('Note #2')).toBeLessThan(needsYou.indexOf('Note #1'));
  });

  it('distinguishes an orchestrator message that was stored from one that was carried', () => {
    const html = renderBoard({
      model: model(),
      lanes: [],
      now: NOW,
      exchange: {
        entries: [
          {
            id: 1,
            author: 'owner',
            isAgent: false,
            kind: 'note',
            body: 'stop doing that',
            created: NOW - 60000,
            status: 'open',
            orchestrator: true,
          },
          {
            id: 2,
            author: 'owner',
            isAgent: false,
            kind: 'note',
            body: 'do this next',
            created: NOW - 30000,
            status: 'open',
            orchestrator: true,
            deliveredAt: NOW - 20000,
          },
        ],
        omitted: 0,
        drafts: [],
      },
    });

    const needsYou = alertsSlice(html);
    // Storing a message says nothing about whether the session it is for has
    // seen it, and the two must not read alike.
    expect(needsYou).toContain('>waiting for the orchestrator</span>');
    expect(needsYou).toContain('>delivered to the orchestrator</span>');
    expect(needsYou).toContain('delivered ');
  });

  it('threads a reply under its parent instead of listing it as a new note', () => {
    const html = renderBoard({
      model: model(),
      lanes: [],
      now: NOW,
      exchange: {
        entries: [
          { id: 1, author: 'owner', isAgent: false, kind: 'note', body: 'the question', created: NOW - 60000, status: 'open' },
          { id: 2, author: 'checkyourvibe', isAgent: true, kind: 'turn', body: 'the answer', created: NOW - 10000, status: 'open', replyTo: 1 },
          { id: 3, author: 'owner', isAgent: false, kind: 'note', body: 'a newer note', created: NOW - 5000, status: 'open' },
        ],
        omitted: 0,
        drafts: [],
      },
    });

    const needsYou = alertsSlice(html);
    // The newest root note leads; the reply hangs inside its parent's note.
    expect(needsYou.indexOf('Note #3')).toBeLessThan(needsYou.indexOf('Note #1'));
    const parent = elementSlice(needsYou, needsYou.indexOf('data-note="1"'), 'div', 'note 1');
    expect(parent).toContain('board-note-replies');
    expect(parent).toContain('the answer');
    expect(parent).toContain('Note #2');
  });

  it('lists unsent drafts with edit and discard controls and a counted send action', () => {
    const html = renderBoard({
      model: model(),
      lanes: [],
      now: NOW,
      exchange: {
        entries: [],
        omitted: 0,
        drafts: [
          { id: 7, kind: 'note', file: '', anchor: '', body: 'first point', author: 'owner', status: 'draft', created: NOW - 2000 },
          { id: 8, kind: 'note', file: '', anchor: '', body: 'second point', author: 'owner', status: 'draft', created: NOW - 1000, refs: { replyTo: 1 } },
        ],
      },
    });

    const needsYou = alertsSlice(html);
    expect(needsYou).toContain('Unsent review');
    expect(needsYou).toContain('2 drafts');
    expect(needsYou).toContain('Send Review (2)');
    expect(needsYou).toContain('data-action="send-review"');
    expect(needsYou).toContain('data-draft-body="7"');
    expect(needsYou).toContain('first point');
    expect(needsYou).toContain('data-action="draft-save"');
    expect(needsYou).toContain('data-action="draft-discard"');
    expect(needsYou).toContain('re #1');
    // Drafts are not notes yet: they must not appear in the conversation.
    expect(needsYou).not.toContain('Note #7');
  });

  it('disables the send action when no draft is pending but keeps the count visible', () => {
    const html = renderBoard({
      model: model(),
      lanes: [],
      now: NOW,
      exchange: { entries: [], omitted: 0, drafts: [] },
    });

    const needsYou = alertsSlice(html);
    expect(needsYou).toContain('0 drafts');
    expect(needsYou).toContain('Send Review (0)');
    expect(needsYou).toMatch(/data-action="send-review"[^>]*disabled/);
  });

  it('escapes note text and author names that contain markup', () => {
    const html = renderBoard({
      model: model(),
      lanes: [],
      now: NOW,
      exchange: {
        entries: [
          { id: 1, author: 'o<b>', isAgent: false, kind: 'note', body: '<img src=x onerror="alert(1)">', created: NOW, status: 'open' },
        ],
        omitted: 0,
        drafts: [
          { id: 2, kind: 'note', file: '', anchor: '', body: '<script>alert(2)</script>', author: 'owner', status: 'draft', created: NOW },
        ],
      },
    });

    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).toContain('o&lt;b&gt;');
    expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(2)</script>');
  });

  it('renders an exhausted lane as a needs-you item naming the lane and its reset time', () => {
    const html = renderBoard({
      model: model({
        needsYou: [{ kind: 'lane', laneId: 'alpha', resetAt: '2026-09-02T03:00:00.000Z' }],
      }),
      lanes: [lane({ id: 'alpha' })],
      now: NOW,
    });

    const needsYou = alertsSlice(html);
    expect(needsYou).toContain('alpha');
    expect(needsYou).toContain('out of quota');
    expect(needsYou).toContain('2026-09-02T03:00:00.000Z');
  });

  it('renders designed empty states when there is nothing to show', () => {
    const html = renderBoard({ model: model(), lanes: [], now: NOW });

    expect(html).toContain('No lane is declared');
    expect(html).toContain('Nothing is running');
    expect(html).toContain('Nothing is waiting on you');
    expect(html).toContain('No open notes are waiting for the agent');
    expect(html).toContain('No spec has work left');
    expect(html).toContain('No dispatch has finished and been acknowledged yet');
  });

  it('escapes markup that arrives in card data', () => {
    const html = renderBoard({
      model: model({
        inMotion: [
          card('d-x', { description: '<img src=x onerror="alert(1)">', laneId: 'a"><b>' }),
        ],
      }),
      lanes: [],
      now: NOW,
    });

    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).toContain('a&quot;&gt;&lt;b&gt;');
  });

  // A drawer the owner opened is the thing they are looking at. The chrome is
  // sticky and was stacked above both drawers, so the explorer rail slid
  // underneath the header instead of over it.
  it('stacks both drawers above the chrome', () => {
    const css = boardCss();
    const zIndexOf = (selector: string): number => {
      const at = css.indexOf(`${selector} {`);
      expect(at).toBeGreaterThanOrEqual(0);
      const block = css.slice(at, css.indexOf('}', at));
      const match = /z-index:\s*(\d+)/.exec(block);
      const digits = match?.[1] ?? '';
      expect(digits).not.toBe('');
      return Number(digits);
    };

    const chrome = zIndexOf('.board-chrome');
    expect(zIndexOf('.board-drawer')).toBeGreaterThan(chrome);
    expect(zIndexOf('.board-explorer')).toBeGreaterThan(chrome);
  });

  // The drawer's panes do not size themselves from flex, and a test that only
  // checked min-height passed while the drawer was still cut off: a <details>
  // renders its content inside an anonymous box, so the panes are not flex
  // items of the drawer and never shrink to it. Measured in a browser: 983px
  // of content in a 460px drawer, overflow visible, no scrollbar. They take
  // their height from the drawer's own variables instead.
  it('caps the drawer panes at the drawer height, in every mode', () => {
    const css = boardCss();

    for (const pane of ['.board-drawer-body', '.board-drawer-diff']) {
      const at = css.indexOf(`${pane} {`);
      expect(at).toBeGreaterThanOrEqual(0);
      const block = css.slice(at, css.indexOf('}', at));
      expect(block).toContain('max-height: calc(var(--cyv-drawer-max) - var(--cyv-drawer-head))');
    }

    // Every mode the drawer can be in defines the height the panes read.
    for (const selector of ['.board-drawer {', '.board-drawer--full {', '.board-drawer[open] {']) {
      const at = css.indexOf(selector);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(css.slice(at, css.indexOf('}', at))).toContain('--cyv-drawer-max:');
    }
  });

  // A flex child's default min-height is its content, so a scroll container
  // with `flex: 1 1 auto` and no `min-height: 0` grows past its parent and the
  // overflow rule never applies. That is a real trap and this still guards it —
  // but it is not what was cutting the drawer off; see the test above.
  it('gives every flex scroll container a min-height it can shrink to', () => {
    const css = boardCss();
    const offenders: string[] = [];

    for (const block of css.split('}')) {
      if (!/overflow(-y)?: *auto/.test(block)) continue;
      if (!/flex: *1 1 auto/.test(block)) continue;
      if (/min-height: *0/.test(block)) continue;
      const selector = (block.split('{')[0] ?? '').trim().split(String.fromCharCode(10)).at(-1) ?? '';
      offenders.push(selector);
    }

    // A guard that matches nothing passes for the wrong reason. There is at
    // least one such container on this page, and it must have been seen.
    expect(css).toMatch(/flex: *1 1 auto/);
    expect(offenders).toEqual([]);
  });

  it('renders the review drawer with its own tabs, and says what to select', () => {
    const html = renderBoard({ model: model(), lanes: [], now: NOW });

    const drawerAt = html.indexOf('id="board-drawer"');
    expect(drawerAt).toBeGreaterThanOrEqual(0);
    // Info and Diff are the drawer's own tabs, inside its always-visible
    // summary. A tab that lives in the summary cannot be closed away.
    const summaryEnd = html.indexOf('</summary>', drawerAt);
    expect(summaryEnd).toBeGreaterThan(drawerAt);
    const summary = html.slice(drawerAt, summaryEnd);
    expect(summary).toContain('data-tab="info"');
    expect(summary).toContain('data-tab="diff"');
    expect(html).toContain('id="board-drawer-diff"');
    expect(html).toContain('drawer-empty');
    expect(html).toContain('Select a dispatch card to review');
  });

  it('is a self-contained document: inline style, no script, no external resources', () => {
    const html = renderBoard({ model: model(), lanes: [], now: NOW });

    expect(html).toContain('<style>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<link');
    expect(html).not.toContain('src=');
  });

  it('renders the To Do column expanded on mobile and the other columns collapsed', () => {
    const html = renderBoard({
      model: model({
        needsYou: [card('d-needs', { outcome: 'produced-nothing' })],
        inMotion: [card('d-motion')],
      }),
      lanes: [lane({ id: 'alpha' })],
      now: NOW,
    });

    expect(html).toMatch(/id="board-todo-toggle"[^>]*checked/);
    expect(html).not.toMatch(/id="board-review-toggle"[^>]*checked/);
    expect(html).not.toMatch(/id="board-in-progress-toggle"[^>]*checked/);
    expect(html).not.toMatch(/id="board-done-toggle"[^>]*checked/);
    expect(html).toContain('data-action="ack"');
    expect(html).toContain('data-action="inspect"');
    expect(html).toContain('data-item-id="d-needs"');
    expect(html).toContain('data-dispatch="d-needs"');
  });

  it('renders a hidden dispatch form with lanes, task kinds, owned paths and gates', () => {
    const html = renderBoard({
      model: model(),
      lanes: [lane({ id: 'alpha' }), lane({ id: 'beta' })],
      now: NOW,
    });

    expect(html).toMatch(/id="board-form"[^>]*hidden/);
    expect(html).toContain('id="board-dispatch-form"');
    expect(html).toContain('name="task"');
    expect(html).toContain('name="taskFile"');
    expect(html).toContain('name="ownedPaths"');
    expect(html).toContain('name="gates"');
    expect(html).toContain('name="lane"');
    expect(html).toContain('value="alpha"');
    expect(html).toContain('value="beta"');
    expect(html).toContain('value="mechanical-transformation"');
    expect(html).toContain('value="judgment-required"');
    expect(html).toContain('cyv-check');
    expect(html).toContain('data-action="dispatch"');
  });

  it('disables at-capacity lanes in the dispatch form and marks reserved lanes unavailable', () => {
    const html = renderBoard({
      model: model({
        inMotion: [card('d-1', { laneId: 'beta' }), card('d-2', { laneId: 'beta' })],
      }),
      lanes: [
        lane({ id: 'alpha' }),
        lane({ id: 'beta', concurrencyCap: 2 }),
        lane({ id: 'gamma', orchestrator: true }),
      ],
      now: NOW,
    });

    const betaAt = html.indexOf('value="beta"');
    expect(betaAt).toBeGreaterThanOrEqual(0);
    const optionEnd = html.indexOf('</option>', betaAt);
    const betaOption = html.slice(betaAt, optionEnd);
    expect(betaOption).toContain('disabled');
    expect(betaOption).toContain('(2/2)');
    expect(betaOption).toContain('at cap');

    const gammaAt = html.indexOf('value="gamma"');
    expect(gammaAt).toBeGreaterThanOrEqual(0);
    const gammaEnd = html.indexOf('</option>', gammaAt);
    const gammaOption = html.slice(gammaAt, gammaEnd);
    expect(gammaOption).toContain('disabled');
    expect(gammaOption).toContain('reserved');
  });

  it('renders stop and abandon controls on in-progress cards', () => {
    const html = renderBoard({
      model: model({ inMotion: [card('d-1', { taskId: 'T1234' })] }),
      lanes: [lane({ id: 'alpha' })],
      now: NOW,
    });

    const inProgress = columnSlice(html, 'in-progress');
    expect(inProgress).toContain('data-action="stop"');
    expect(inProgress).toContain('data-action="abandon"');
    expect(inProgress).toContain('data-dispatch="d-1"');
  });

  it('carries the project root on the body for the client', () => {
    const html = renderBoard({
      model: model(),
      lanes: [],
      projectRoot: '/tmp/project',
      now: NOW,
    });

    expect(html).toContain('<body class="bg-surface text-on-surface font-body-md" data-project="/tmp/project">');
  });

  it('explains what belongs in each column in one line, visible on first view', () => {
    const html = renderBoard({ model: model(), lanes: [lane({ id: 'alpha' })], now: NOW });

    for (const id of ['todo', 'in-progress', 'done']) {
      const column = columnSlice(html, id);
      expect(column).toContain('board-region-note');
      const noteAt = column.indexOf('board-region-note');
      const bodyAt = column.indexOf('board-col-body');
      expect(noteAt).toBeGreaterThanOrEqual(0);
      expect(bodyAt).toBeGreaterThanOrEqual(0);
      expect(noteAt).toBeLessThan(bodyAt);
    }
  });

  it('says in one line — not an empty frame — when nothing is running', () => {
    const html = renderBoard({ model: model(), lanes: [], now: NOW });

    const inProgress = columnSlice(html, 'in-progress');
    expect(inProgress).toContain('Nothing is running');
    expect(inProgress).toContain('board-quiet');
  });

  it('leads every card with the description and keeps the dispatch id as reference', () => {
    const html = renderBoard({
      model: model({
        needsYou: [card('d-needs', { taskId: 'T9000', outcome: 'failed', description: 'unstick the runner' })],
        inMotion: [card('d-motion', { taskId: 'T1234', description: 'render the board' })],
      }),
      lanes: [lane({ id: 'alpha' })],
      now: NOW,
    });

    // The reference is the task id when the declaration names one — that is
    // what a reader recognises. The dispatch id stays reachable on the title
    // rather than taking the corner beside it.
    const inProgress = columnSlice(html, 'in-progress');
    expect(inProgress.indexOf('render the board')).toBeGreaterThanOrEqual(0);
    expect(inProgress.indexOf('render the board')).toBeLessThan(inProgress.indexOf('>T1234<'));
    expect(inProgress).toContain('title="d-motion"');

    const needsYou = alertsSlice(html);
    expect(needsYou.indexOf('unstick the runner')).toBeGreaterThanOrEqual(0);
    expect(needsYou.indexOf('unstick the runner')).toBeLessThan(needsYou.indexOf('>T9000<'));
    expect(needsYou).toContain('title="d-needs"');
  });

  // The corner used to read `w44-attempt-1` whatever had happened. An attempt
  // number carries information only when there has been more than one; on a
  // first attempt it is four characters saying nothing, and the owner said so.
  it('drops the attempt suffix on a first attempt and keeps it on a retry', () => {
    const html = renderBoard({
      model: model({
        inMotion: [card('w44-attempt-1', { description: 'first go' }), card('w44-attempt-2', { description: 'second go' })],
      }),
      lanes: [lane({ id: 'alpha' })],
      now: NOW,
    });

    expect(html).toContain('>w44<');
    expect(html).toContain('w44 · attempt 2');
    // The full id is still there for anyone who needs it.
    expect(html).toContain('title="w44-attempt-1"');
  });

  // A brief's first line is a markdown heading. Its hash is syntax, and on a
  // card it sits in the first column of the title reading as noise.
  it('strips the markdown heading marker from a card title', () => {
    const html = renderBoard({
      model: model({ inMotion: [card('d-hash', { description: '# Let a dispatch dispatch' })] }),
      lanes: [lane({ id: 'alpha' })],
      now: NOW,
    });

    expect(html).toContain('Let a dispatch dispatch');
    expect(html).not.toContain('# Let a dispatch dispatch');
  });

  it('collapses items older than a day behind a count that expands', () => {
    const old = '2026-08-20T11:00:00.000Z';
    const html = renderBoard({
      model: model({
        needsYou: [
          card('d-n1', { outcome: 'failed', timestamp: old }),
          card('d-n2', { outcome: 'failed', timestamp: old }),
          card('d-n3', { outcome: 'failed', timestamp: old }),
          card('d-n4', { outcome: 'failed', timestamp: old }),
          card('d-n5', { outcome: 'failed', timestamp: old }),
        ],
      }),
      lanes: [],
      now: NOW,
    });

    const decisions = idSlice(html, 'board-decisions', 'div');
    expect(decisions).toContain('<details class="board-older">');
    expect(decisions).toContain('2 older items');
    const collapsedAt = decisions.indexOf('board-older');
    // The newest few stay open; the rest sit inside the closed <details>.
    expect(decisions.indexOf('d-n1')).toBeLessThan(collapsedAt);
    expect(decisions.indexOf('d-n3')).toBeLessThan(collapsedAt);
    expect(decisions.indexOf('d-n4')).toBeGreaterThan(collapsedAt);
    expect(decisions.indexOf('d-n5')).toBeGreaterThan(collapsedAt);
  });

  it('never collapses items that are still current', () => {
    const html = renderBoard({
      model: model({
        needsYou: [
          card('d-n1', { outcome: 'failed' }),
          card('d-n2', { outcome: 'failed' }),
          card('d-n3', { outcome: 'failed' }),
          card('d-n4', { outcome: 'failed' }),
        ],
      }),
      lanes: [],
      now: NOW,
    });

    const decisions = idSlice(html, 'board-decisions', 'div');
    expect(decisions).not.toContain('board-older');
    expect(decisions).toContain('d-n4');
  });

  it('says what an outcome badge means in words a person can act on', () => {
    const html = renderBoard({
      model: model({
        needsYou: [card('d-scope', { outcome: 'out-of-scope-write', summary: 'wrote outside its declared ownership: x' })],
      }),
      lanes: [],
      now: NOW,
    });

    const needsYou = alertsSlice(html);
    expect(needsYou).toContain('wrote files it did not declare');
    // The record kind stays referenceable on the element but is not the text.
    expect(needsYou).toContain('data-outcome="out-of-scope-write"');
    expect(needsYou).not.toMatch(/>\s*out-of-scope-write\s*</);
  });
});

describe('accepting finished work', () => {

  // A failed dispatch used to return to Needs You whatever anyone did about it.
  // The card carried an Acknowledge button, the acknowledgement was written to
  // the log, and the card stayed — so the column only ever grew.
  it('moves an acknowledged failure out of Needs You', () => {
    const record = closedDispatch('d-failed', ['src/a.ts']);
    if (record.closed === undefined) {
      throw new Error('expected closed dispatch');
    }
    const failed: DispatchRecord = {
      ...record,
      closed: {
        ...record.closed,
        closedAt: '2026-09-01T11:30:00.000Z',
        outcome: {
          kind: 'gates-failed',
          summary: 'gates failed: run:pnpm test',
          changedPaths: ['src/a.ts'],
          outOfScopePaths: [],
          failedGates: ['run:pnpm test'],
        },
      },
    };
    const comments: CommentStore = { version: 1, nextId: 1, comments: [] };
    const log: DispatchLog = { records: [failed], refusals: [], acknowledged: [] };
    const lanes = [lane({ id: 'alpha' })];

    const before = buildBoardModel({ log, comments, lanes });
    expect(before.needsYou.map((entry) => (entry.kind === 'card' ? entry.dispatchId : entry.laneId))).toEqual([
      'd-failed',
    ]);
    expect(before.done).toEqual([]);

    const after = buildBoardModel({ log: { ...log, acknowledged: ['d-failed'] }, comments, lanes });
    expect(after.needsYou).toEqual([]);
    expect(after.done.map((entry) => entry.dispatchId)).toEqual(['d-failed']);
  });

  it('moves the card out of In Progress into Done once it is accepted', () => {
    const record = closedDispatch('d-review', ['src/a.ts']);
    const comments: CommentStore = { version: 1, nextId: 1, comments: [] };
    const log: DispatchLog = { records: [record], refusals: [], acknowledged: [] };

    const before = buildBoardModel({ log, comments, lanes: [lane({ id: 'alpha' })] });
    // Finished and unaccepted: still in progress, ready for review.
    expect(before.inMotion.map((entry) => entry.dispatchId)).toEqual(['d-review']);
    expect(before.inMotion[0]?.phase).toBe('ready-for-review');
    expect(before.done).toEqual([]);

    const after = buildBoardModel({
      log: { ...log, acknowledged: ['d-review'] },
      comments,
      lanes: [lane({ id: 'alpha' })],
    });
    expect(after.inMotion).toEqual([]);
    expect(after.done.map((entry) => entry.dispatchId)).toEqual(['d-review']);
  });
});

describe('boardCss', () => {
  it('references only declared custom properties and no literal colours', () => {
    const css = boardCss();
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\brgba?\(/i);

    // A token counts as declared wherever it is declared. Most live in the
    // shared stylesheet; a few are scoped to the element that varies them,
    // which is the point of them — the drawer's height changes with its mode
    // and the panes inside it read whatever it currently is.
    const defined = new Set([
      ...(dashboardCss().match(/--cyv-[a-z-]+(?=:)/g) ?? []),
      ...(css.match(/--cyv-[a-z-]+(?=:)/g) ?? []),
    ]);
    const used = css.match(/(?<=var\()--cyv-[a-z-]+(?=[,)])/g) ?? [];
    expect(used.length).toBeGreaterThan(0);
    for (const token of used) {
      expect(defined.has(token)).toBe(true);
    }
  });
});



describe('board layout contracts', () => {
  it('grid declares exactly as many tracks as there are columns', () => {
    // The kanban grid must have one track per rendered column. The board
    // renders To Do, In Progress, and Done — three columns — so the
    // grid-template-columns must declare exactly three tracks, not four.
    const html = renderBoard({ model: model(), lanes: [], now: NOW });
    const css = boardCss();

    // The rendered HTML has exactly three data-column sections.
    const columns = ['todo', 'in-progress', 'done'];
    for (const id of columns) {
      expect(html).toContain(`data-column="${id}"`);
    }
    const count = (html.match(/data-column="/g) ?? []).length;
    expect(count).toBe(columns.length);

    // The grid rule matches the column count: repeat(3, ...) for three columns.
    expect(css).toMatch(/\.board-kanban\s*\{[^}]*grid-template-columns:\s*repeat\(3,/s);
    // The old four-track rule must not appear.
    expect(css).not.toMatch(/\.board-kanban\s*\{[^}]*grid-template-columns:\s*repeat\(4,/s);
  });



  it('kanban columns stack vertically below 1024px wide', () => {
    // Below 1024 px the grid becomes a flex column so cards read top-to-bottom
    // on a phone rather than side-by-side in a grid that is too narrow.
    const css = boardCss();
    // The media query that stacks columns must target max-width: 1023px and
    // set flex-direction: column on the kanban container.
    expect(css).toMatch(/@media \(max-width: 1023px\)[^{]*\{[^}]*\.board-kanban[^}]*flex-direction:\s*column/s);
  });
});

describe('spec grouping in In Progress and Done columns', () => {
  // Two dispatches belonging to the same spec must appear under one group card,
  // not as two separate cards. The reader should see: one header with the spec
  // identity, and both dispatches listed inside it.
  it('groups two in-progress dispatches on the same spec under one card', () => {
    const c1 = card('d-1', { taskId: 'T0099', description: 'first task' });
    c1.specId = '0099-fixture';
    c1.specTitle = '0099 · fixture';
    const c2 = card('d-2', { taskId: 'T0099', description: 'second task' });
    c2.specId = '0099-fixture';
    c2.specTitle = '0099 · fixture';

    const html = renderBoard({
      model: model({ inMotion: [c1, c2] }),
      lanes: [lane({ id: 'alpha' })],
      now: NOW,
    });

    const inProgress = columnSlice(html, 'in-progress');
    // One spec group wraps both dispatches.
    expect(inProgress).toContain('data-spec="0099-fixture"');
    expect(inProgress).toContain('0099 · fixture');
    expect(inProgress).toContain('2 dispatches');
    // Both dispatch cards appear inside the column.
    expect(inProgress).toContain('d-1');
    expect(inProgress).toContain('d-2');
    // Both should be inside the single group — the group appears only once.
    const groupCount = (inProgress.match(/data-spec="0099-fixture"/g) ?? []).length;
    expect(groupCount).toBe(1);
  });

  // A dispatch that names no spec must not be folded under a neighboring spec's
  // group. It must render as its own standalone card after the grouped ones.
  it('does not group a no-spec dispatch under a neighboring spec group', () => {
    const withSpec = card('d-spec', { taskId: 'T0099', description: 'spec task' });
    withSpec.specId = '0099-fixture';
    withSpec.specTitle = '0099 · fixture';
    const withoutSpec = card('d-lone', { description: 'one-off brief' });

    const html = renderBoard({
      model: model({ inMotion: [withSpec, withoutSpec] }),
      lanes: [lane({ id: 'alpha' })],
      now: NOW,
    });

    const inProgress = columnSlice(html, 'in-progress');
    // The grouped card is there.
    expect(inProgress).toContain('data-spec="0099-fixture"');
    // The lone dispatch is also there.
    expect(inProgress).toContain('d-lone');
    // The lone dispatch must not appear inside the spec group.
    const groupAt = inProgress.indexOf('data-spec="0099-fixture"');
    const groupEnd = inProgress.indexOf('</div>', inProgress.lastIndexOf('board-spec-group-body', groupAt + 500));
    // d-lone must appear after the spec group card (outside it).
    const loneAt = inProgress.indexOf('d-lone');
    expect(loneAt).toBeGreaterThan(groupAt);
    // The "Not scoped to a spec" label must be visible.
    expect(inProgress).toContain('Not scoped to a spec');
    // groupEnd sanity: d-lone is after the section label, not inside the group body.
    expect(inProgress.indexOf('Not scoped to a spec')).toBeLessThan(loneAt);
  });

  // The live channel refreshes column bodies by calling renderBoardFragment for
  // a named region. Whatever the full page renders for In Progress must match
  // exactly what the fragment serves, or grouping will disappear on the first
  // live update.
  it('produces identical grouped markup from renderBoardFragment and the full-page render', () => {
    const c1 = card('d-a', { taskId: 'T0099', description: 'task a' });
    c1.specId = '0099-fixture';
    c1.specTitle = '0099 · fixture';
    const c2 = card('d-b', { taskId: 'T0099', description: 'task b' });
    c2.specId = '0099-fixture';
    c2.specTitle = '0099 · fixture';

    const m = model({ inMotion: [c1, c2] });
    const input = { model: m, lanes: [lane({ id: 'alpha' })], now: NOW };

    const fullHtml = renderBoard(input);
    const fragmentHtml = renderBoardFragment(input, 'in-progress') ?? '';

    // Extract the in-progress body from the full page.
    const bodyId = 'board-in-progress-body';
    const bodyAt = fullHtml.indexOf(`id="${bodyId}"`);
    expect(bodyAt).toBeGreaterThan(0);
    const bodyHtml = elementSlice(fullHtml, bodyAt, 'div', `id ${bodyId}`);
    // The div wrapping element itself is not in the fragment, so compare what's
    // inside it to the fragment output.
    const innerStart = bodyHtml.indexOf('>') + 1;
    const innerEnd = bodyHtml.lastIndexOf('</div>');
    const innerHtml = bodyHtml.slice(innerStart, innerEnd).trim();

    // The fragment and the inner body must contain the same spec group.
    expect(fragmentHtml).toContain('data-spec="0099-fixture"');
    expect(innerHtml).toContain('data-spec="0099-fixture"');
    // Normalise whitespace differences and compare.
    expect(fragmentHtml.replace(/\s+/g, ' ').trim()).toBe(innerHtml.replace(/\s+/g, ' ').trim());
  });

  // Every button that was clickable before grouping must still be reachable
  // after. The data-action attributes are the hooks the client delegates on.
  it('preserves all data-action attributes inside a spec group', () => {
    const running = card('d-run', { taskId: 'T0099', description: 'running task' });
    running.specId = '0099-fixture';
    running.specTitle = '0099 · fixture';
    const reviewing = card('d-rev', {
      taskId: 'T0099',
      description: 'ready for review',
      outcome: 'succeeded',
      changedPaths: ['src/a.ts'],
    });
    reviewing.specId = '0099-fixture';
    reviewing.specTitle = '0099 · fixture';
    reviewing.phase = 'ready-for-review';

    const html = renderBoard({
      model: model({ inMotion: [running, reviewing] }),
      lanes: [lane({ id: 'alpha' })],
      now: NOW,
    });

    const inProgress = columnSlice(html, 'in-progress');
    // Running card: Stop and Abandon.
    expect(inProgress).toContain('data-action="stop"');
    expect(inProgress).toContain('data-action="abandon"');
    expect(inProgress).toContain(`data-dispatch="d-run"`);
    // Reviewing card: Accept and Reply.
    expect(inProgress).toContain('data-action="ack"');
    expect(inProgress).toContain('data-action="note-dispatch"');
    expect(inProgress).toContain(`data-dispatch="d-rev"`);
  });
});
