import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDispatch, openDispatch, readDispatchLog } from '../../src/executor/store.js';
import { classifyOutcome, type OutcomeInput } from '../../src/executor/outcome.js';
import { cooldownOn, inFlightOn, replayLaneRuntimes } from '../../src/executor/replay.js';
import { scheduleDispatch, type ScheduleRequest } from '../../src/executor/schedule.js';
import type { DispatchAssignment } from '../../src/executor/dispatch.js';
import { declaration, lane, report } from './fixtures.js';

function assignmentOn(laneId: string, model = 'weak'): DispatchAssignment {
  return {
    laneId,
    agentId: `${laneId}-agent`,
    model,
    billing: 'subscription',
    permitsBilledOverage: false,
    orchestrator: false,
    declaredHeadroomAtSchedule: 2,
  };
}

function outcome(overrides: Partial<OutcomeInput> = {}) {
  return classifyOutcome({
    expectsFileChanges: overrides.expectsFileChanges ?? true,
    ownedPaths: overrides.ownedPaths ?? ['src/a.ts'],
    changedPaths: overrides.changedPaths ?? ['src/a.ts'],
    gates: overrides.gates ?? [{ gate: 'tsc', passed: true }],
    report: overrides.report ?? report('success', { exitCode: 0 }),
  });
}

describe('rebuilding lane state from disk (Requirement 6.4)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cyv-replay-'));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function open(dispatchId: string, laneId: string, ownedPaths: readonly string[]) {
    await openDispatch(repo, {
      dispatchId,
      workId: dispatchId,
      attempt: 1,
      openedAt: '2026-01-01T00:00:00.000Z',
      declaration: declaration({ ownedPaths: [...ownedPaths] }),
      assignment: assignmentOn(laneId),
    });
  }

  async function close(
    dispatchId: string,
    closedAt: string,
    overrides: Partial<OutcomeInput> = {},
  ) {
    await closeDispatch(repo, {
      dispatchId,
      closedAt,
      report: overrides.report ?? report('success', { exitCode: 0 }),
      gateResults: overrides.gates ?? [{ gate: 'tsc', passed: true }],
      outcome: outcome(overrides),
    });
  }

  it('counts only open dispatches against the lane in flight', async () => {
    await open('d1', 'alpha', ['src/a.ts']);
    await open('d2', 'alpha', ['src/b.ts']);
    await close('d1', '2026-01-01T00:01:00.000Z');

    const { records } = await readDispatchLog(repo);
    expect(inFlightOn(records, 'alpha')).toEqual([
      { dispatchId: 'd2', ownedPaths: ['src/b.ts'] },
    ]);
  });

  it('carries an in-flight dispatch ownership set into the overlap check', async () => {
    await open('d1', 'alpha', ['src/shared.ts']);

    const { records } = await readDispatchLog(repo);
    const runtimes = replayLaneRuntimes([lane({ id: 'alpha', concurrencyCap: 4 })], records);
    const request: ScheduleRequest = {
      dispatchId: 'd2',
      taskKind: 'mechanical-transformation',
      ownedPaths: ['src/shared.ts'],
    };

    expect(scheduleDispatch(request, runtimes)).toMatchObject({
      decision: 'refused',
      refusal: { reason: 'overlapping-ownership' },
    });
  });

  it('puts a lane into cooldown after a produced-nothing outcome (Requirement 7.4)', async () => {
    await open('d1', 'alpha', ['src/a.ts']);
    await close('d1', '2026-01-01T00:01:00.000Z', { changedPaths: [] });

    const { records } = await readDispatchLog(repo);
    expect(cooldownOn(records, 'alpha')).toEqual({
      reason: 'produced-nothing',
      dispatchId: 'd1',
      since: '2026-01-01T00:01:00.000Z',
    });
  });

  it('puts a lane into cooldown after an explicit rate-limit error', async () => {
    await open('d1', 'alpha', ['src/a.ts']);
    await close('d1', '2026-01-01T00:01:00.000Z', {
      changedPaths: [],
      report: report('failure', { rateLimited: true }),
    });

    expect(cooldownOn((await readDispatchLog(repo)).records, 'alpha')).toMatchObject({
      reason: 'rate-limited',
    });
  });

  it('clears cooldown only on a later observed-effect success (Requirement 7.5)', async () => {
    await open('d1', 'alpha', ['src/a.ts']);
    await close('d1', '2026-01-01T00:01:00.000Z', { changedPaths: [] });
    await open('d2', 'alpha', ['src/b.ts']);
    await close('d2', '2026-01-01T00:02:00.000Z', {
      ownedPaths: ['src/b.ts'],
      changedPaths: ['src/b.ts'],
    });

    expect(cooldownOn((await readDispatchLog(repo)).records, 'alpha')).toBeUndefined();
  });

  it('does not clear cooldown on a gate-only success that changed nothing', async () => {
    await open('d1', 'alpha', ['src/a.ts']);
    await close('d1', '2026-01-01T00:01:00.000Z', { changedPaths: [] });
    await open('d2', 'alpha', ['src/b.ts']);
    await close('d2', '2026-01-01T00:02:00.000Z', {
      expectsFileChanges: false,
      ownedPaths: ['src/b.ts'],
      changedPaths: [],
    });

    expect(cooldownOn((await readDispatchLog(repo)).records, 'alpha')).toMatchObject({
      reason: 'produced-nothing',
    });
  });

  it('keeps one lane cooldown from affecting another', async () => {
    await open('d1', 'alpha', ['src/a.ts']);
    await close('d1', '2026-01-01T00:01:00.000Z', { changedPaths: [] });

    const { records } = await readDispatchLog(repo);
    const runtimes = replayLaneRuntimes(
      [lane({ id: 'alpha' }), lane({ id: 'beta' })],
      records,
    );

    expect(runtimes.map((r) => r.cooldown?.reason)).toEqual(['produced-nothing', undefined]);
  });

  it('lets a session that wrote none of the records schedule against the same state', async () => {
    await open('d1', 'alpha', ['src/a.ts']);
    await close('d1', '2026-01-01T00:01:00.000Z', { changedPaths: [] });
    await open('d2', 'beta', ['src/b.ts']);

    const { records } = await readDispatchLog(repo);
    const runtimes = replayLaneRuntimes(
      [lane({ id: 'alpha', concurrencyCap: 9 }), lane({ id: 'beta', concurrencyCap: 2 })],
      records,
    );

    const decision = scheduleDispatch(
      {
        dispatchId: 'd3',
        taskKind: 'mechanical-transformation',
        ownedPaths: ['src/c.ts'],
      },
      runtimes,
    );

    expect(decision).toMatchObject({ decision: 'scheduled', laneId: 'beta', model: 'weak' });
  });

  it('reports a lane with no records as idle and out of cooldown', async () => {
    const runtimes = replayLaneRuntimes([lane({ id: 'alpha' })], []);

    expect(runtimes).toEqual([{ lane: lane({ id: 'alpha' }), inFlight: [] }]);
  });
});
