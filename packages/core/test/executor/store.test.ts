import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendDispatchEntry,
  closeDispatch,
  dispatchLogPath,
  foldDispatchEntries,
  openDispatch,
  readDispatchEntries,
  readDispatchLog,
  refuseDispatch,
} from '../../src/executor/store.js';
import { classifyOutcome } from '../../src/executor/outcome.js';
import { isInFlight, type DispatchAssignment } from '../../src/executor/dispatch.js';
import { declaration, report } from './fixtures.js';

const assignment: DispatchAssignment = {
  laneId: 'alpha',
  agentId: 'alpha-agent',
  model: 'weak',
  billing: 'subscription',
  permitsBilledOverage: false,
  orchestrator: false,
  declaredHeadroomAtSchedule: 2,
};

function succeeded() {
  return classifyOutcome({
    expectsFileChanges: true,
    ownedPaths: ['src/a.ts'],
    changedPaths: ['src/a.ts'],
    gates: [{ gate: 'tsc', passed: true }],
    report: report('success', { exitCode: 0 }),
  });
}

describe('the dispatch store', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cyv-dispatch-'));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('lives beside the other .cyv-review records', () => {
    expect(dispatchLogPath(repo)).toBe(join(repo, '.cyv-review', 'dispatches.ndjson'));
  });

  it('returns an empty log when nothing has been dispatched yet', async () => {
    expect(await readDispatchEntries(repo)).toEqual([]);
    expect(await readDispatchLog(repo)).toEqual({ records: [], refusals: [], acknowledged: [] });
  });

  it('round-trips an opened dispatch, field for field', async () => {
    const written = await openDispatch(repo, {
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      openedAt: '2026-01-01T00:00:00.000Z',
      declaration: declaration(),
      assignment,
    });

    expect(await readDispatchEntries(repo)).toEqual([written]);
  });

  it('shows an opened dispatch as in flight until it closes (Requirement 6.4)', async () => {
    await openDispatch(repo, {
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      openedAt: '2026-01-01T00:00:00.000Z',
      declaration: declaration(),
      assignment,
    });

    const midRun = await readDispatchLog(repo);
    expect(midRun.records).toHaveLength(1);
    expect(midRun.records.every(isInFlight)).toBe(true);

    await closeDispatch(repo, {
      dispatchId: 'd1',
      closedAt: '2026-01-01T00:05:00.000Z',
      report: report('success', { exitCode: 0 }),
      gateResults: [{ gate: 'tsc', passed: true }],
      outcome: succeeded(),
    });

    const afterRun = await readDispatchLog(repo);
    expect(afterRun.records.some(isInFlight)).toBe(false);
    expect(afterRun.records[0]?.closed?.outcome.kind).toBe('succeeded');
  });

  it('keeps each attempt at one unit of work as its own record (Requirement 9.4)', async () => {
    await openDispatch(repo, {
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      openedAt: '2026-01-01T00:00:00.000Z',
      declaration: declaration(),
      assignment,
    });
    await closeDispatch(repo, {
      dispatchId: 'd1',
      closedAt: '2026-01-01T00:01:00.000Z',
      report: report('success', { exitCode: 0 }),
      gateResults: [{ gate: 'tsc', passed: false }],
      outcome: classifyOutcome({
        expectsFileChanges: true,
        ownedPaths: ['src/a.ts'],
        changedPaths: ['src/a.ts'],
        gates: [{ gate: 'tsc', passed: false }],
        report: report('success', { exitCode: 0 }),
      }),
    });
    await openDispatch(repo, {
      dispatchId: 'd2',
      workId: 'w1',
      attempt: 2,
      openedAt: '2026-01-01T00:02:00.000Z',
      declaration: declaration(),
      assignment: { ...assignment, model: 'middle' },
      escalation: {
        fromLaneId: 'alpha',
        fromModel: 'weak',
        reason: 'gate-failure',
        detail: 'gates failed: tsc',
        priorDispatchId: 'd1',
      },
    });

    const { records } = await readDispatchLog(repo);
    expect(records.map((r) => r.dispatchId)).toEqual(['d1', 'd2']);
    expect(records.map((r) => r.attempt)).toEqual([1, 2]);
    expect(records[1]?.assignment.model).toBe('middle');
    expect(records[1]?.escalation?.reason).toBe('gate-failure');
    expect(records[0]?.workId).toBe(records[1]?.workId);
  });

  it('records a scheduling refusal so it is not dropped (Requirement 4.3)', async () => {
    await refuseDispatch(repo, {
      dispatchId: 'd2',
      workId: 'w2',
      refusedAt: '2026-01-01T00:00:00.000Z',
      declaration: declaration({ ownedPaths: ['src/shared.ts'] }),
      refusal: {
        reason: 'overlapping-ownership',
        conflicts: [{ withDispatchId: 'd1', laneId: 'alpha', paths: ['src/shared.ts'] }],
      },
    });

    const { records, refusals } = await readDispatchLog(repo);
    expect(records).toEqual([]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.refusal).toEqual({
      reason: 'overlapping-ownership',
      conflicts: [{ withDispatchId: 'd1', laneId: 'alpha', paths: ['src/shared.ts'] }],
    });
  });

  it('round-trips a no-eligible-lane refusal with every lane reason', async () => {
    await refuseDispatch(repo, {
      dispatchId: 'd3',
      workId: 'w3',
      refusedAt: '2026-01-01T00:00:00.000Z',
      declaration: declaration(),
      refusal: {
        reason: 'no-eligible-lane',
        rejections: [
          { laneId: 'a', reason: { reason: 'at-concurrency-cap', concurrencyCap: 1, inFlight: 1 } },
          {
            laneId: 'b',
            reason: { reason: 'in-cooldown', since: '2026-01-01T00:00:00.000Z', cause: 'rate-limited' },
          },
          { laneId: 'c', reason: { reason: 'metered-not-named' } },
          {
            laneId: 'd',
            reason: { reason: 'no-model-for-kind', taskKind: 'judgment-required' },
          },
        ],
      },
    });

    const { refusals } = await readDispatchLog(repo);
    const refused = refusals[0];
    expect(refused?.refusal.reason).toBe('no-eligible-lane');
    expect(refused?.refusal).toMatchObject({
      rejections: [
        { laneId: 'a' },
        { laneId: 'b' },
        { laneId: 'c' },
        { laneId: 'd', reason: { taskKind: 'judgment-required' } },
      ],
    });
  });

  it('writes each entry as exactly one line', async () => {
    await openDispatch(repo, {
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      openedAt: '2026-01-01T00:00:00.000Z',
      declaration: declaration(),
      assignment,
    });
    await closeDispatch(repo, {
      dispatchId: 'd1',
      closedAt: '2026-01-01T00:01:00.000Z',
      report: report('success', { exitCode: 0 }),
      gateResults: [],
      outcome: succeeded(),
    });

    const raw = await readFile(dispatchLogPath(repo), 'utf-8');
    const lines = raw.split('\n').filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(2);
  });

  it('does not corrupt the log when two dispatches open concurrently', async () => {
    await Promise.all([
      openDispatch(repo, {
        dispatchId: 'd1',
        workId: 'w1',
        attempt: 1,
        openedAt: '2026-01-01T00:00:00.000Z',
        declaration: declaration(),
        assignment,
      }),
      openDispatch(repo, {
        dispatchId: 'd2',
        workId: 'w2',
        attempt: 1,
        openedAt: '2026-01-01T00:00:00.000Z',
        declaration: declaration({ ownedPaths: ['src/b.ts'] }),
        assignment,
      }),
    ]);

    const { records } = await readDispatchLog(repo);
    expect(records.map((r) => r.dispatchId).sort()).toEqual(['d1', 'd2']);
  });

  it('skips a malformed line instead of discarding the whole log', async () => {
    const opened = await openDispatch(repo, {
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      openedAt: '2026-01-01T00:00:00.000Z',
      declaration: declaration(),
      assignment,
    });
    await appendFile(dispatchLogPath(repo), 'not valid json\n{"event":"opened"}\n', 'utf-8');

    const stats = { unparseableLines: 0 };
    expect(await readDispatchEntries(repo, stats)).toEqual([opened]);
    expect(stats.unparseableLines).toBe(2);
  });

  it('rejects an entry whose declaration names a task kind the core does not define', async () => {
    await mkdir(join(repo, '.cyv-review'), { recursive: true });
    const line = JSON.stringify({
      event: 'opened',
      schemaVersion: 1,
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      openedAt: '2026-01-01T00:00:00.000Z',
      declaration: { ...declaration(), taskKind: 'opus-sized' },
      assignment,
    });
    await appendFile(dispatchLogPath(repo), `${line}\n`, 'utf-8');

    const stats = { unparseableLines: 0 };
    expect(await readDispatchEntries(repo, stats)).toEqual([]);
    expect(stats.unparseableLines).toBe(1);
  });

  it('rejects an entry missing the expected-file-change declaration', async () => {
    await mkdir(join(repo, '.cyv-review'), { recursive: true });
    const { expectsFileChanges: _dropped, ...withoutFlag } = declaration();
    const line = JSON.stringify({
      event: 'opened',
      schemaVersion: 1,
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      openedAt: '2026-01-01T00:00:00.000Z',
      declaration: withoutFlag,
      assignment,
    });
    await appendFile(dispatchLogPath(repo), `${line}\n`, 'utf-8');

    expect(await readDispatchEntries(repo)).toEqual([]);
  });
});

describe('foldDispatchEntries', () => {
  it('drops a close entry with no matching open', () => {
    const folded = foldDispatchEntries([
      {
        event: 'closed',
        schemaVersion: 1,
        dispatchId: 'orphan',
        closedAt: '2026-01-01T00:00:00.000Z',
        report: report('success', { exitCode: 0 }),
        gateResults: [],
        outcome: succeeded(),
      },
    ]);

    expect(folded.records).toEqual([]);
  });

  it('keeps records in the order they were opened', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'cyv-dispatch-order-'));
    try {
      for (const id of ['d1', 'd2', 'd3']) {
        await appendDispatchEntry(repo, {
          event: 'opened',
          schemaVersion: 1,
          dispatchId: id,
          workId: id,
          attempt: 1,
          openedAt: '2026-01-01T00:00:00.000Z',
          declaration: declaration({ ownedPaths: [`src/${id}.ts`] }),
          assignment,
        });
      }
      const { records } = await readDispatchLog(repo);
      expect(records.map((r) => r.dispatchId)).toEqual(['d1', 'd2', 'd3']);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
