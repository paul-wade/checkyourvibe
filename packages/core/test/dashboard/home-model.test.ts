import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildHomePage } from '../../src/dashboard/home-model.js';
import { activeSpecOf, taskIdIn } from '../../src/dashboard/motion.js';
import { addComment, AGENT_AUTHOR } from '../../src/dashboard/review/comments.js';
import { parseAllSpecs } from '../../src/dashboard/review/specs.js';
import {
  acknowledgeItem,
  closeDispatch,
  openDispatch,
  refuseDispatch,
} from '../../src/executor/store.js';
import type { DispatchAssignment, DispatchDeclaration } from '../../src/executor/dispatch.js';
import type { DispatchOutcome } from '../../src/executor/outcome.js';

/**
 * The page model built from a repository on disk: configuration, specs, the
 * dispatch log, comments and git, with nothing run. The lanes name programs
 * that do not exist on any machine, so program resolution is exercised in the
 * direction that is safe to assert on.
 */

async function copySchema(repoRoot: string): Promise<void> {
  const schemaUrl = new URL('../../../../docs/protocol/config.schema.json', import.meta.url);
  const schema = await readFile(schemaUrl, 'utf-8');
  const schemaDir = join(repoRoot, 'docs', 'protocol');
  await mkdir(schemaDir, { recursive: true });
  await writeFile(join(schemaDir, 'config.schema.json'), schema);
}

function config(): unknown {
  return {
    packs: [],
    analyzers: [],
    rules: {},
    strict: false,
    exclude: [],
    executor: {
      stallAfterMinutes: 30,
      lanes: [
        {
          id: 'orch',
          agentId: 'claude-code',
          concurrencyCap: 1,
          billing: { kind: 'subscription', permitsBilledOverage: false },
          orchestrator: true,
          models: [{ kind: 'judgment-required', ordering: ['big', 'small'] }],
        },
        {
          id: 'alpha',
          agentId: 'codex',
          concurrencyCap: 1,
          billing: { kind: 'subscription', permitsBilledOverage: false },
          orchestrator: false,
          models: [{ kind: 'mechanical-transformation', ordering: ['a-big', 'a-small'] }],
        },
        {
          id: 'beta',
          agentId: 'devin',
          concurrencyCap: 2,
          billing: { kind: 'subscription', permitsBilledOverage: false },
          orchestrator: false,
          models: [{ kind: 'mechanical-transformation', ordering: ['b-small'] }],
        },
      ],
    },
  };
}

const TASKS = `# 0099 — Fixture spec: tasks

## Open

- [x] **T99001** The seam
  _Exec: executor=alpha kind=mechanical gates=tsc files=src/seam.ts_

- [ ] **T99002** Reader one
  Depends on T99001.
  _Exec: executor=alpha kind=mechanical gates=tsc files=src/one.ts_

- [ ] **T99003** Reader two
  _Exec: executor=beta kind=mechanical gates=tsc files=src/two.ts_

- [ ] **T99004** Touches the seam again
  _Exec: executor=beta kind=mechanical gates=tsc files=src/seam.ts,src/one.ts_

- [ ] **T99005** Blocked on two
  Depends on T99003.
  _Exec: executor=alpha kind=mechanical gates=tsc files=src/five.ts_

- [ ] **T99006** A decision
  _Exec: executor=user gates=manual files=docs/x.md_
`;

async function makeRepo(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'cyv-home-model-'));
  const repo = join(parent, 'repo');
  await mkdir(join(repo, 'docs', 'specs', '0099-fixture'), { recursive: true });
  execFileSync('git', ['init'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
  await copySchema(repo);
  await writeFile(join(repo, 'checkyourvibe.json'), JSON.stringify(config(), null, 2));
  await writeFile(join(repo, 'docs', 'specs', '0099-fixture', 'requirements.md'), '# 0099\n');
  await writeFile(join(repo, 'docs', 'specs', '0099-fixture', 'tasks.md'), TASKS);
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: repo });
  return repo;
}

function declaration(task: string, owned: string): DispatchDeclaration {
  return {
    task,
    taskKind: 'mechanical-transformation',
    ownedPaths: [owned],
    expectsFileChanges: true,
    gates: ['tsc'],
  };
}

function assignment(laneId: string, agentId: string): DispatchAssignment {
  return {
    laneId,
    agentId,
    model: 'small',
    billing: 'subscription',
    permitsBilledOverage: false,
    orchestrator: false,
    declaredHeadroomAtSchedule: 1,
  };
}

function outcome(kind: DispatchOutcome['kind'], changed: string[]): DispatchOutcome {
  return { kind, summary: `${kind} summary`, changedPaths: changed, outOfScopePaths: [], failedGates: [] };
}

/** Two attempts at one unit of work: the first failed its gates, the second produced nothing. */
async function writeLog(repo: string): Promise<void> {
  await openDispatch(repo, {
    dispatchId: 'w1-attempt-1',
    workId: 'w1',
    attempt: 1,
    openedAt: '2026-09-01T10:00:00.000Z',
    declaration: declaration('T99001 The seam', 'src/seam.ts'),
    assignment: assignment('alpha', 'codex'),
  });
  await closeDispatch(repo, {
    dispatchId: 'w1-attempt-1',
    closedAt: '2026-09-01T10:05:00.000Z',
    report: { status: 'success', exitCode: 0, rateLimited: false },
    gateResults: [{ gate: 'tsc', passed: false }],
    outcome: { ...outcome('gates-failed', ['src/seam.ts']), failedGates: ['tsc'] },
  });
  await openDispatch(repo, {
    dispatchId: 'w1-attempt-2',
    workId: 'w1',
    attempt: 2,
    openedAt: '2026-09-01T10:05:00.000Z',
    declaration: declaration('T99001 The seam', 'src/seam.ts'),
    assignment: assignment('alpha', 'codex'),
  });
  await closeDispatch(repo, {
    dispatchId: 'w1-attempt-2',
    closedAt: '2026-09-01T10:09:00.000Z',
    report: { status: 'success', exitCode: 0, rateLimited: false },
    gateResults: [],
    outcome: outcome('produced-nothing', []),
  });
  await refuseDispatch(repo, {
    dispatchId: 'w2-attempt-1',
    workId: 'w2',
    refusedAt: '2026-09-01T10:10:00.000Z',
    declaration: declaration('T99003 Reader two', 'src/two.ts'),
    refusal: { reason: 'no-eligible-lane', rejections: [] },
  });
}

/** An open entry whose supervising process is this test, so it judges live on this host. */
async function openLive(repo: string): Promise<void> {
  await openDispatch(repo, {
    dispatchId: 'w3-attempt-1',
    workId: 'w3',
    attempt: 1,
    openedAt: new Date().toISOString(),
    declaration: declaration('T99003 Reader two', 'src/two.ts'),
    assignment: assignment('beta', 'devin'),
  });
}

/** An open entry from a process that is gone: a pid nothing on this machine holds. */
async function openAbandoned(repo: string): Promise<void> {
  const entry = {
    event: 'opened',
    schemaVersion: 1,
    dispatchId: 'w4-attempt-1',
    workId: 'w4',
    attempt: 1,
    openedAt: '2026-09-01T09:00:00.000Z',
    declaration: declaration('T99002 Reader one', 'src/one.ts'),
    assignment: assignment('beta', 'devin'),
    host: hostname(),
    pid: 2147483000,
    processStartedAt: '2026-09-01T08:59:00.000Z',
  };
  await mkdir(join(repo, '.cyv-review'), { recursive: true });
  const { appendFile } = await import('node:fs/promises');
  await appendFile(join(repo, '.cyv-review', 'dispatches.ndjson'), `${JSON.stringify(entry)}\n`);
}

const NOW = new Date('2026-09-01T12:00:00.000Z');

describe('buildHomePage reads a project from its own files', () => {
  it('names the active spec, groups the next wave by disjoint scope, and blocks on open dependencies', async () => {
    const repo = await makeRepo();
    await writeLog(repo);
    const page = await buildHomePage({ root: repo, registry: [repo], env: {}, now: NOW });

    expect(page.motion.spec?.id).toBe('0099-fixture');
    expect(page.motion.spec?.done).toBe(1);
    expect(page.motion.spec?.total).toBe(6);

    const byId = new Map(page.motion.next.map((task) => [task.id, task]));
    // T99002 depends on the done task, so it is unblocked.
    expect(byId.get('T99002')?.wave).toBe(1);
    expect(byId.get('T99003')?.wave).toBe(1);
    // T99004 shares src/one.ts with T99002, so it cannot share the wave.
    expect(byId.get('T99004')?.wave).toBeGreaterThan(1);
    // T99005 names an open task and is blocked.
    expect(byId.get('T99005')?.wave).toBe(0);
    expect(byId.get('T99005')?.blockedBy).toEqual(['T99003']);
  });

  it('lists only the latest attempt of a unit of work under needs-you', async () => {
    const repo = await makeRepo();
    await writeLog(repo);
    const page = await buildHomePage({ root: repo, registry: [repo], env: {}, now: NOW });

    const dispatchItems = page.needsYou.filter((item) => item.kind === 'dispatch');
    // Both attempts at w1 name T99001; only the second is listed, and it is
    // the second that the dismiss action would acknowledge.
    const seam = dispatchItems.filter((item) => item.id === 'T99001');
    expect(seam).toHaveLength(1);
    expect(seam[0]?.actions).toContainEqual({
      kind: 'dismiss',
      label: 'needs nothing',
      itemId: 'w1-attempt-2',
    });
    // The refusal for w2 was never followed by a dispatch, so it still waits.
    expect(dispatchItems.some((item) => item.id === 'T99003')).toBe(true);

    const task = page.needsYou.find((item) => item.kind === 'task');
    expect(task?.id).toBe('T99006');
  });

  it('asks each dispatch item as a question with its answers, naming the spec task', async () => {
    const repo = await makeRepo();
    await writeLog(repo);
    const page = await buildHomePage({ root: repo, registry: [repo], env: {}, now: NOW });

    const nothing = page.needsYou.find((item) => item.id === 'T99001');
    expect(nothing?.title).toContain('T99001 · The seam');
    expect(nothing?.title).toContain('produced nothing on alpha');
    expect(nothing?.question).toContain('alpha is cooling');
    expect(nothing?.actions.map((action) => action.kind)).toEqual(['tell', 'dismiss']);

    const refused = page.needsYou.find((item) => item.id === 'T99003' && item.kind === 'dispatch');
    expect(refused?.question).toContain('Nothing could take it');
    expect(refused?.actions.map((action) => action.kind)).toEqual(['tell', 'dismiss']);
  });

  it('drops a dispatch from needs-you once a person has acknowledged it', async () => {
    const repo = await makeRepo();
    await writeLog(repo);
    await acknowledgeItem(repo, {
      itemId: 'w1-attempt-2',
      acknowledgedAt: '2026-09-01T11:00:00.000Z',
      note: 'the lane was asleep',
    });
    const page = await buildHomePage({ root: repo, registry: [repo], env: {}, now: NOW });

    expect(page.needsYou.some((item) => item.kind === 'dispatch' && item.id === 'T99001')).toBe(false);
    // The record itself is untouched: the lane is still cooling from it.
    expect(page.lanes.lanes.find((lane) => lane.id === 'alpha')?.cooldown?.dispatchId).toBe('w1-attempt-2');
  });

  it('shows a lane cooling after produced-nothing, and says how it clears', async () => {
    const repo = await makeRepo();
    await writeLog(repo);
    const page = await buildHomePage({ root: repo, registry: [repo], env: {}, now: NOW });

    const alpha = page.lanes.lanes.find((lane) => lane.id === 'alpha');
    // No program named `codex` exists on the empty PATH this test supplies, so
    // the lane is unavailable before it is cooling; the cooldown is still carried.
    expect(alpha?.cooldown?.reason).toBe('produced-nothing');
    expect(alpha?.cooldown?.dispatchId).toBe('w1-attempt-2');
    expect(alpha?.state).toBe('unavailable');
    expect(alpha?.programTried).toEqual(['codex']);

    const orch = page.lanes.lanes.find((lane) => lane.id === 'orch');
    expect(orch?.orchestrator).toBe(true);
    expect(orch?.acceptsDispatch).toBe(false);
    expect(orch?.selfReport).toBeUndefined();
  });

  it('judges an open dispatch from a dead pid abandoned and one from this process live', async () => {
    const repo = await makeRepo();
    await openAbandoned(repo);
    await openLive(repo);
    const page = await buildHomePage({ root: repo, registry: [repo], env: {}, now: NOW });

    const abandoned = page.motion.running.find((running) => running.dispatchId === 'w4-attempt-1');
    expect(abandoned?.liveness).toBe('abandoned');
    expect(abandoned?.canStop).toBe(true);

    const item = page.needsYou.find((candidate) => candidate.kind === 'liveness');
    expect(item?.question).toContain('Close it and dispatch the task again?');
    expect(item?.actions[0]).toEqual({ kind: 'close', label: 'close the record', dispatchId: 'w4-attempt-1' });

    const live = page.motion.running.find((running) => running.dispatchId === 'w3-attempt-1');
    expect(live?.liveness).toBe('live');
    expect(live?.taskId).toBe('T99003');

    const liveness = page.needsYou.filter((item) => item.kind === 'liveness');
    expect(liveness.map((item) => item.id)).toEqual(['T99002']);
  });

  it('reports a stall when work is open, a lane is free, and nothing has opened within the interval', async () => {
    const repo = await makeRepo();
    await writeLog(repo);
    const page = await buildHomePage({ root: repo, registry: [repo], env: {}, now: NOW });

    // beta has two slots, no cooldown, and accepts dispatch; alpha is cooling.
    expect(page.motion.stall?.idleLanes).toEqual(['beta']);
    expect(page.motion.stall?.intervalMinutes).toBe(30);
    expect(page.needsYou.some((item) => item.kind === 'stall')).toBe(true);
  });

  it('does not report a stall while a dispatch opened within the interval', async () => {
    const repo = await makeRepo();
    await openLive(repo);
    const page = await buildHomePage({ root: repo, registry: [repo], env: {}, now: new Date() });
    expect(page.motion.stall).toBeUndefined();
  });

  it('carries the exchange with recorded authorship and counts open owner notes on the project option', async () => {
    const repo = await makeRepo();
    await addComment(repo, { body: 'please look at the seam', author: 'owner' }, 1);
    await addComment(repo, { body: 'looked; it holds', author: AGENT_AUTHOR, kind: 'turn' }, 2);
    const page = await buildHomePage({ root: repo, registry: [repo], env: {}, now: NOW });

    expect(page.exchange.entries.map((entry) => entry.isAgent)).toEqual([true, false]);
    expect(page.projects[0]?.needsCount).toBe(1);
    expect(page.needsYou.filter((item) => item.kind === 'note')).toHaveLength(1);
  });

  it('says a check has never run, and names a missing registered project without dropping it', async () => {
    const repo = await makeRepo();
    const gone = join(repo, 'not-here');
    const page = await buildHomePage({ root: repo, registry: [repo, gone], env: {}, now: NOW });

    expect(page.check).toEqual({ state: 'never' });
    expect(page.projects[1]?.reachable).toBe(false);
    expect(page.projects[1]?.unreachableReason).toBe('directory is missing');
    expect(page.lanes.unused).toEqual([]);
  });
});

describe('activeSpecOf', () => {
  it('prefers the spec the most recent dispatch names a task from', async () => {
    const repo = await makeRepo();
    await mkdir(join(repo, 'docs', 'specs', '0100-later'), { recursive: true });
    await writeFile(
      join(repo, 'docs', 'specs', '0100-later', 'tasks.md'),
      '# 0100\n\n- [ ] **T100001** Later\n  _Exec: executor=alpha gates=tsc files=src/z.ts_\n',
    );
    await writeLog(repo);
    const specs = await parseAllSpecs(repo);
    const { readDispatchLog } = await import('../../src/executor/store.js');
    const log = await readDispatchLog(repo);

    expect(activeSpecOf(specs, log.records)?.id).toBe('0099-fixture');
    expect(activeSpecOf(specs, [])?.id).toBe('0100-later');
  });

  it('reads a task id out of a dispatch task text', () => {
    expect(taskIdIn('T36011: ask each agent')).toBe('T36011');
    expect(taskIdIn('no id here')).toBeUndefined();
  });
});

describe('unread-by-the-agent (spec 0042 Requirement 3)', () => {
  const NOW = 1_756_900_000_000;

  function store(notes: { id: number; body: string; ageMinutes: number; author?: string }[]) {
    return {
      version: 1,
      nextId: notes.length + 1,
      comments: notes.map((n) => ({
        id: n.id,
        kind: 'note' as const,
        file: '',
        anchor: '',
        body: n.body,
        author: n.author ?? 'owner',
        status: 'open' as const,
        created: NOW - n.ageMinutes * 60_000,
      })),
    };
  }

  it('marks a note past the cursor unread, with how long it has waited', async () => {
    const { commentsToExchange } = await import('../../src/dashboard/review/comments.js');
    const region = commentsToExchange(store([{ id: 7, body: 'look at this', ageMinutes: 45 }]), 10, {
      cursor: 6,
      now: NOW,
    });

    expect(region.entries[0]?.readByAgent).toBe(false);
    expect(region.entries[0]?.unreadForMs).toBe(45 * 60_000);
  });

  it('marks a note the cursor has passed read, and carries no age', async () => {
    const { commentsToExchange } = await import('../../src/dashboard/review/comments.js');
    const region = commentsToExchange(store([{ id: 7, body: 'seen', ageMinutes: 45 }]), 10, {
      cursor: 7,
      now: NOW,
    });

    expect(region.entries[0]?.readByAgent).toBe(true);
    expect(region.entries[0]?.unreadForMs).toBeUndefined();
  });

  it('asks nothing about the tool\'s own turns', async () => {
    const { commentsToExchange } = await import('../../src/dashboard/review/comments.js');
    const region = commentsToExchange(
      store([{ id: 7, body: 'agent turn', ageMinutes: 45, author: 'checkyourvibe' }]),
      10,
      { cursor: 0, now: NOW },
    );

    expect(region.entries[0]?.readByAgent).toBeUndefined();
  });

  it('says nothing about read state when no cursor was supplied', async () => {
    const { commentsToExchange } = await import('../../src/dashboard/review/comments.js');
    const region = commentsToExchange(store([{ id: 7, body: 'x', ageMinutes: 45 }]), 10);

    expect(region.entries[0]?.readByAgent).toBeUndefined();
  });

  it('orders unreadByAgent longest-waiting first', async () => {
    const { unreadByAgent } = await import('../../src/dashboard/review/comments.js');
    const rows = unreadByAgent(
      store([
        { id: 1, body: 'older', ageMinutes: 90 },
        { id: 2, body: 'newer', ageMinutes: 10 },
      ]),
      { cursor: 0, now: NOW },
    );

    expect(rows.map((r) => r.comment.body)).toEqual(['older', 'newer']);
  });

  it('excludes a note the cursor has passed from unreadByAgent', async () => {
    const { unreadByAgent } = await import('../../src/dashboard/review/comments.js');
    const rows = unreadByAgent(
      store([
        { id: 1, body: 'read', ageMinutes: 90 },
        { id: 2, body: 'unread', ageMinutes: 90 },
      ]),
      { cursor: 1, now: NOW },
    );

    expect(rows.map((r) => r.comment.body)).toEqual(['unread']);
  });
});
