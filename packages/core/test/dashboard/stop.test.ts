import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { stopDispatch } from '../../src/dashboard/stop.js';
import type { LivenessJudgement } from '../../src/executor/liveness.js';
import { closeDispatch, openDispatch, readDispatchLog } from '../../src/executor/store.js';
import type { DispatchAssignment } from '../../src/executor/dispatch.js';
import { declaration, report } from '../executor/fixtures.js';

const assignment: DispatchAssignment = {
  laneId: 'alpha',
  agentId: 'alpha-agent',
  model: 'weak',
  billing: 'subscription',
  permitsBilledOverage: false,
  orchestrator: false,
  declaredHeadroomAtSchedule: 1,
};

const NOW = new Date('2026-09-01T12:00:00.000Z');

function judging(judgement: LivenessJudgement): () => Promise<LivenessJudgement> {
  return () => Promise.resolve(judgement);
}

describe('stopDispatch (spec 0040 Requirement 6, Decision 3)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cyv-stop-'));
    await openDispatch(repo, {
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      openedAt: '2026-09-01T11:00:00.000Z',
      declaration: declaration(),
      assignment,
    });
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('kills the supervising process by pid and closes the record as did-not-complete', async () => {
    const killed: number[] = [];
    const result = await stopDispatch(repo, 'd1', {
      kill: (pid) => {
        killed.push(pid);
        return Promise.resolve();
      },
      judge: judging({ liveness: 'live', reason: 'pid matches' }),
      now: () => NOW,
    });

    expect(result).toEqual({ stopped: true, dispatchId: 'd1', closedAt: NOW.toISOString() });
    expect(killed).toEqual([process.pid]);

    const record = (await readDispatchLog(repo)).records[0];
    expect(record?.closed?.outcome.kind).toBe('did-not-complete');
    expect(record?.closed?.outcome.summary).toBe('Stopped from the dashboard before the executor finished.');
    expect(record?.closed?.report).toEqual({
      status: 'did-not-complete',
      rateLimited: false,
      detail: 'Stopped from the dashboard.',
    });
    expect(record?.closed?.gateResults).toEqual([]);
    expect(record?.closed?.outcome.changedPaths).toEqual([]);
    expect(record?.closed?.outcome.failedGates).toEqual([]);
  });

  it('closes an abandoned dispatch without killing anything, and says the process was gone', async () => {
    const killed: number[] = [];
    const result = await stopDispatch(repo, 'd1', {
      kill: (pid) => {
        killed.push(pid);
        return Promise.resolve();
      },
      judge: judging({ liveness: 'abandoned', reason: 'pid 4120 on this host is not running' }),
      now: () => NOW,
    });

    expect(result).toEqual({ stopped: true, dispatchId: 'd1', closedAt: NOW.toISOString() });
    expect(killed).toEqual([]);

    const record = (await readDispatchLog(repo)).records[0];
    expect(record?.closed?.outcome.kind).toBe('did-not-complete');
    expect(record?.closed?.report.detail).toBe(
      'Stopped from the dashboard; the supervising process was already gone',
    );
    expect(record?.closed?.outcome.summary).toContain('pid 4120 on this host is not running');
  });

  it('refuses an undetermined dispatch with the judgement reason and leaves the record open', async () => {
    const killed: number[] = [];
    const reason = 'opened on host "elsewhere"; this is "here", which cannot see that host\'s processes';
    const result = await stopDispatch(repo, 'd1', {
      kill: (pid) => {
        killed.push(pid);
        return Promise.resolve();
      },
      judge: judging({ liveness: 'undetermined', reason }),
    });

    expect(result).toEqual({ stopped: false, dispatchId: 'd1', reason });
    expect(killed).toEqual([]);
    expect((await readDispatchLog(repo)).records[0]?.closed).toBeUndefined();
  });

  it('the default judgement refuses a dispatch opened on another host', async () => {
    await openDispatch(repo, {
      dispatchId: 'd2',
      workId: 'w2',
      attempt: 1,
      openedAt: '2026-09-01T11:00:00.000Z',
      declaration: declaration({ ownedPaths: ['src/b.ts'] }),
      assignment,
    });
    // The store stamps this host; rewriting the record is not possible through
    // the append-only API, so the judgement is exercised through its options.
    const killed: number[] = [];
    const result = await stopDispatch(repo, 'd2', {
      kill: (pid) => {
        killed.push(pid);
        return Promise.resolve();
      },
      judge: (entry) =>
        Promise.resolve({
          liveness: 'undetermined',
          reason: `opened on host "${entry.host ?? '?'}"; judged from "not-${hostname()}"`,
        }),
    });
    expect(result.stopped).toBe(false);
    expect(killed).toEqual([]);
  });

  it('refuses a dispatch that is not in the log', async () => {
    const result = await stopDispatch(repo, 'missing', {
      judge: judging({ liveness: 'live', reason: 'irrelevant' }),
    });
    expect(result.stopped).toBe(false);
    if (result.stopped) throw new Error('expected a refusal');
    expect(result.reason).toContain('missing');
  });

  it('refuses a dispatch that already closed, naming when and how', async () => {
    await closeDispatch(repo, {
      dispatchId: 'd1',
      closedAt: '2026-09-01T11:30:00.000Z',
      report: report('success', { exitCode: 0 }),
      gateResults: [],
      outcome: {
        kind: 'succeeded',
        summary: 'done',
        changedPaths: ['src/a.ts'],
        outOfScopePaths: [],
        failedGates: [],
      },
    });
    const result = await stopDispatch(repo, 'd1', {
      judge: judging({ liveness: 'live', reason: 'irrelevant' }),
    });
    expect(result.stopped).toBe(false);
    if (result.stopped) throw new Error('expected a refusal');
    expect(result.reason).toContain('2026-09-01T11:30:00.000Z');
    expect(result.reason).toContain('succeeded');
  });

  it('a kill that fails leaves the record open and says so', async () => {
    const result = await stopDispatch(repo, 'd1', {
      kill: () => Promise.reject(new Error('access denied')),
      judge: judging({ liveness: 'live', reason: 'pid matches' }),
    });
    expect(result.stopped).toBe(false);
    if (result.stopped) throw new Error('expected a refusal');
    expect(result.reason).toContain('access denied');
    expect((await readDispatchLog(repo)).records[0]?.closed).toBeUndefined();
  });
});
