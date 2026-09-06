import { describe, expect, it } from 'vitest';

import { buildBoardModel, type BoardCard, type BoardLaneAlert } from '../../src/dashboard/board-model.js';
import { AGENT_AUTHOR, type Comment, type CommentStore } from '../../src/dashboard/review/comments.js';
import { classifyOutcome, type DispatchOutcome } from '../../src/executor/outcome.js';
import type { DispatchRecord, DispatchAssignment } from '../../src/executor/dispatch.js';
import type { DispatchLog } from '../../src/executor/store.js';
import { declaration, lane, report } from '../executor/fixtures.js';

function assignmentOn(laneId: string): DispatchAssignment {
  return {
    laneId,
    agentId: `${laneId}-agent`,
    model: 'weak',
    billing: 'subscription',
    permitsBilledOverage: false,
    orchestrator: false,
    declaredHeadroomAtSchedule: 1,
  };
}

function record(
  dispatchId: string,
  laneId: string,
  task: string,
  openedAt: string,
  outcome?: DispatchOutcome,
  closedAt?: string,
): DispatchRecord {
  return {
    dispatchId,
    workId: dispatchId,
    attempt: 1,
    openedAt,
    declaration: declaration({ task }),
    assignment: assignmentOn(laneId),
    ...(outcome === undefined || closedAt === undefined
      ? {}
      : { closed: { closedAt, report: report('success'), gateResults: [], outcome } }),
  };
}

function succeeded(changed: string[] = ['src/a.ts']): DispatchOutcome {
  return classifyOutcome({
    expectsFileChanges: changed.length > 0,
    ownedPaths: ['src/a.ts'],
    changedPaths: changed,
    gates: [{ gate: 'tsc', passed: true }],
    report: report('success'),
  });
}

function producedNothing(): DispatchOutcome {
  return classifyOutcome({
    expectsFileChanges: true,
    ownedPaths: ['src/a.ts'],
    changedPaths: [],
    gates: [],
    report: report('success'),
  });
}

function log(records: DispatchRecord[], acknowledged: string[] = []): DispatchLog {
  return { records, refusals: [], acknowledged };
}

function emptyComments(): CommentStore {
  return { version: 1, nextId: 1, comments: [] };
}

function comments(...items: Comment[]): CommentStore {
  return { version: 1, nextId: items.length + 1, comments: items };
}

function note(taskId: string, author = 'owner'): Comment {
  return {
    id: 1,
    kind: 'note',
    file: '',
    anchor: '',
    body: 'look at this',
    author,
    status: 'open',
    created: 1,
    refs: { task: taskId },
  };
}

function findCard(items: readonly (BoardCard | BoardLaneAlert)[], dispatchId: string): BoardCard {
  const card = items.find((item): item is BoardCard => item.kind === 'card' && item.dispatchId === dispatchId);
  if (card === undefined) throw new Error(`Expected card ${dispatchId}`);
  return card;
}

describe('buildBoardModel', () => {
  it('produces four empty regions for an empty log', () => {
    const model = buildBoardModel({ log: log([]), comments: emptyComments(), lanes: [] });

    expect(model.needsYou).toEqual([]);
    expect(model.inMotion).toEqual([]);
    expect(model.review).toEqual([]);
    expect(model.done).toEqual([]);
    expect(model.status).toEqual({
      needsYouCount: 0,
      idle: 0,
      idleLaneIds: [],
      totalLanes: 0,
      running: 0,
      stalled: false,
    });
  });

  it('places an open dispatch in In Motion', () => {
    const records = [record('d-open', 'alpha', 'T1234 Do the thing', '2026-09-01T10:00:00.000Z')];
    const model = buildBoardModel({
      log: log(records),
      comments: emptyComments(),
      lanes: [lane({ id: 'alpha' })],
    });

    expect(model.inMotion).toHaveLength(1);
    expect(model.needsYou).toHaveLength(0);
    expect(model.review).toHaveLength(0);
    expect(model.done).toHaveLength(0);

    const card = model.inMotion[0];
    if (card === undefined) throw new Error('missing in-motion card');
    expect(card.dispatchId).toBe('d-open');
    expect(card.taskId).toBe('T1234');
    expect(card.outcome).toBeUndefined();
    expect(card.openNotes).toBe(0);
  });

  // Finished and not yet accepted stays In Progress, saying "ready for review".
  // It is not a column of its own: the agent that produced it is still the one
  // to talk to about it, and moving the card would leave that behind.
  it('keeps a succeeded dispatch in progress, ready for review, until it is accepted', () => {
    const records = [
      record(
        'd-review',
        'alpha',
        'T1234 Do the thing',
        '2026-09-01T10:00:00.000Z',
        succeeded(['src/a.ts']),
        '2026-09-01T10:05:00.000Z',
      ),
    ];
    const model = buildBoardModel({
      log: log(records),
      comments: emptyComments(),
      lanes: [lane({ id: 'alpha' })],
    });

    expect(model.inMotion).toHaveLength(1);
    expect(model.needsYou).toHaveLength(0);
    expect(model.done).toHaveLength(0);

    const card = model.inMotion[0];
    if (card === undefined) throw new Error('missing in-progress card');
    expect(card.dispatchId).toBe('d-review');
    expect(card.outcome).toBe('succeeded');
    expect(card.phase).toBe('ready-for-review');
    expect(card.openNotes).toBe(0);
  });

  it('places an acknowledged succeeded dispatch with changes in Done', () => {
    const records = [
      record(
        'd-done',
        'alpha',
        'T1234 Do the thing',
        '2026-09-01T10:00:00.000Z',
        succeeded(['src/a.ts']),
        '2026-09-01T10:05:00.000Z',
      ),
    ];
    const model = buildBoardModel({
      log: log(records, ['d-done']),
      comments: emptyComments(),
      lanes: [lane({ id: 'alpha' })],
    });

    expect(model.done).toHaveLength(1);
    expect(model.review).toHaveLength(0);
    expect(model.needsYou).toHaveLength(0);
    expect(model.inMotion).toHaveLength(0);

    const card = model.done[0];
    if (card === undefined) throw new Error('missing done card');
    expect(card.dispatchId).toBe('d-done');
  });

  it('places a produced-nothing dispatch in Needs You', () => {
    const records = [
      record(
        'd-needs',
        'alpha',
        'T1234 Do the thing',
        '2026-09-01T10:00:00.000Z',
        producedNothing(),
        '2026-09-01T10:05:00.000Z',
      ),
    ];
    const model = buildBoardModel({
      log: log(records),
      comments: emptyComments(),
      lanes: [],
    });

    const cards = model.needsYou.filter((item): item is BoardCard => item.kind === 'card');
    expect(cards).toHaveLength(1);
    expect(model.inMotion).toHaveLength(0);
    expect(model.review).toHaveLength(0);
    expect(model.done).toHaveLength(0);

    const card = findCard(model.needsYou, 'd-needs');
    expect(card.outcome).toBe('produced-nothing');
  });

  it('records an open note on a completed dispatch that changed nothing', () => {
    const records = [
      record(
        'd-commented',
        'alpha',
        'T1234 Do the thing',
        '2026-09-01T10:00:00.000Z',
        succeeded([]),
        '2026-09-01T10:05:00.000Z',
      ),
    ];
    const model = buildBoardModel({
      log: log(records),
      comments: comments(note('T1234')),
      lanes: [lane({ id: 'alpha' })],
    });

    // The dispatch changed nothing, so there is nothing to review; the open
    // note is what wants a person, and it reaches them through the exchange.
    expect(model.done).toHaveLength(1);
    expect(model.needsYou).toHaveLength(0);
    expect(model.inMotion).toHaveLength(0);

    const card = findCard(model.done, 'd-commented');
    expect(card.openNotes).toBe(1);
  });

  it('does not count an agent comment as an open note', () => {
    const records = [
      record(
        'd-agent-comment',
        'alpha',
        'T1234 Do the thing',
        '2026-09-01T10:00:00.000Z',
        succeeded([]),
        '2026-09-01T10:05:00.000Z',
      ),
    ];
    const model = buildBoardModel({
      log: log(records),
      comments: comments(note('T1234', AGENT_AUTHOR)),
      lanes: [lane({ id: 'alpha' })],
    });

    expect(model.done).toHaveLength(1);
    expect(model.needsYou).toHaveLength(0);
  });

  it('adds a lane quota alert to Needs You when a lane is in cooldown', () => {
    const closedAt = '2026-09-01T10:05:00.000Z';
    const records = [
      record('d-cooldown', 'alpha', 'T1234 Do the thing', '2026-09-01T10:00:00.000Z', producedNothing(), closedAt),
    ];
    const model = buildBoardModel({
      log: log(records),
      comments: emptyComments(),
      lanes: [lane({ id: 'alpha' })],
    });

    const laneAlert = model.needsYou.find((item): item is BoardLaneAlert => item.kind === 'lane');
    if (laneAlert === undefined) throw new Error('missing lane alert');
    expect(laneAlert.laneId).toBe('alpha');
    expect(laneAlert.resetAt).toBe(closedAt);

    const card = findCard(model.needsYou, 'd-cooldown');
    expect(card.outcome).toBe('produced-nothing');
  });

  it('filters cards by project, leaving specs without a project or in different projects out', () => {
    const specs = [
      { id: '0001-with-proj', tasksPath: '', sections: [], done: 0, total: 0, project: 'A' },
      { id: '0002-without-proj', tasksPath: '', sections: [], done: 0, total: 0 },
      { id: '0003-other-proj', tasksPath: '', sections: [], done: 0, total: 0, project: 'B' }
    ];
    const records = [
      record('d-A', 'alpha', '0001 Do the thing', '2026-09-01T10:00:00.000Z'),
      record('d-none', 'alpha', '0002 Do the thing', '2026-09-01T10:00:00.000Z'),
      record('d-B', 'alpha', '0003 Do the thing', '2026-09-01T10:00:00.000Z'),
    ];
    const model = buildBoardModel({
      log: log(records),
      comments: emptyComments(),
      lanes: [],
      specs,
      projectFilter: 'A'
    });
    
    expect(model.inMotion).toHaveLength(1);
    expect(model.inMotion[0]?.dispatchId).toBe('d-A');
    expect(model.projects).toEqual(['A', 'B']);
  });

  it('handles a filter that matches nothing', () => {
    const specs = [
      { id: '0001-with-proj', tasksPath: '', sections: [], done: 0, total: 0, project: 'A' }
    ];
    const records = [
      record('d-A', 'alpha', '0001 Do the thing', '2026-09-01T10:00:00.000Z')
    ];
    const model = buildBoardModel({
      log: log(records),
      comments: emptyComments(),
      lanes: [],
      specs,
      projectFilter: 'Nonexistent'
    });
    
    expect(model.inMotion).toHaveLength(0);
    expect(model.projects).toEqual(['A']);
  });

  it('adds writtenByOthers to out-of-scope cards when the strong signal exists', () => {
    const closedAt = '2026-09-01T10:05:00.000Z';
    const outcome = classifyOutcome({
      expectsFileChanges: true,
      ownedPaths: ['src/a.ts'],
      changedPaths: ['src/a.ts', 'src/b.ts'],
      gates: [],
      report: report('success'),
    });
    const records = [record('d-strong', 'alpha', 'T1234', '2026-09-01T10:00:00.000Z', outcome, closedAt)];
    
    // Simulate a decision log where a session outside the window wrote src/b.ts
    const decisions = [
      { at: '2026-09-01T09:00:00.000Z', event: 'write', tool: 'write', decision: 'allow' as const, enforced: true, reason: '', session: 's1', target: 'src/b.ts' },
      { at: '2026-09-01T10:01:00.000Z', event: 'write', tool: 'write', decision: 'allow' as const, enforced: true, reason: '', session: 's1', target: 'src/b.ts' },
      { at: '2026-09-01T11:00:00.000Z', event: 'write', tool: 'write', decision: 'allow' as const, enforced: true, reason: '', session: 's1', target: 'src/b.ts' },
    ];
    
    const model = buildBoardModel({
      log: log(records),
      comments: emptyComments(),
      lanes: [],
      decisions,
      lifecycleEvents: []
    });

    const card = findCard(model.needsYou, 'd-strong');
    expect(card.writtenByOthers).toEqual(['src/b.ts']);
    expect(card.sharedWindow).toBeUndefined();
  });

  it('adds sharedWindow to out-of-scope cards when a session brackets the window', () => {
    const closedAt = '2026-09-01T10:05:00.000Z';
    const outcome = classifyOutcome({
      expectsFileChanges: true,
      ownedPaths: ['src/a.ts'],
      changedPaths: ['src/a.ts', 'src/b.ts'],
      gates: [],
      report: report('success'),
    });
    const records = [record('d-weak', 'alpha', 'T1234', '2026-09-01T10:00:00.000Z', outcome, closedAt)];
    
    // Session s1 started before and stopped after the window
    const lifecycleEvents = [
      { at: '2026-09-01T09:00:00.000Z', event: 'SessionStart', sessionId: 's1' },
      { at: '2026-09-01T11:00:00.000Z', event: 'Stop', sessionId: 's1' },
    ];
    
    const model = buildBoardModel({
      log: log(records),
      comments: emptyComments(),
      lanes: [],
      decisions: [],
      lifecycleEvents
    });

    const card = findCard(model.needsYou, 'd-weak');
    expect(card.sharedWindow).toBe(true);
    expect(card.writtenByOthers).toBeUndefined();
  });

  it('does not add sharedWindow when no session brackets the window', () => {
    const closedAt = '2026-09-01T10:05:00.000Z';
    const outcome = classifyOutcome({
      expectsFileChanges: true,
      ownedPaths: ['src/a.ts'],
      changedPaths: ['src/a.ts', 'src/b.ts'],
      gates: [],
      report: report('success'),
    });
    const records = [record('d-alone', 'alpha', 'T1234', '2026-09-01T10:00:00.000Z', outcome, closedAt)];
    
    // Session s1 starts and stops before the dispatch window
    const lifecycleEvents = [
      { at: '2026-09-01T09:00:00.000Z', event: 'SessionStart', sessionId: 's1' },
      { at: '2026-09-01T09:59:00.000Z', event: 'Stop', sessionId: 's1' },
    ];
    
    const model = buildBoardModel({
      log: log(records),
      comments: emptyComments(),
      lanes: [],
      decisions: [],
      lifecycleEvents
    });

    const card = findCard(model.needsYou, 'd-alone');
    expect(card.sharedWindow).toBeUndefined();
    expect(card.writtenByOthers).toBeUndefined();
  });

  it('says nothing when the dispatch ran alone', () => {
    const closedAt = '2026-09-01T10:05:00.000Z';
    const outcome = classifyOutcome({
      expectsFileChanges: true,
      ownedPaths: ['src/a.ts'],
      changedPaths: ['src/a.ts', 'src/b.ts'],
      gates: [],
      report: report('success'),
    });
    const records = [record('d-alone', 'alpha', 'T1234', '2026-09-01T10:00:00.000Z', outcome, closedAt)];
    
    const model = buildBoardModel({
      log: log(records),
      comments: emptyComments(),
      lanes: [],
      decisions: [],
      lifecycleEvents: []
    });

    const card = findCard(model.needsYou, 'd-alone');
    expect(card.sharedWindow).toBeUndefined();
    expect(card.writtenByOthers).toBeUndefined();
  });
});
