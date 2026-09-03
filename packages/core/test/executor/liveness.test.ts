import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseDispatchEntry } from '../../src/executor/parse.js';
import {
  PROCESS_START_TOLERANCE_MS,
  judgeLiveness,
  thisProcessStartedAt,
  type LivenessProbe,
} from '../../src/executor/liveness.js';
import { closeDispatch, dispatchLogPath, openDispatch, readDispatchEntries, readDispatchLog } from '../../src/executor/store.js';
import { classifyOutcome } from '../../src/executor/outcome.js';
import { type DispatchAssignment } from '../../src/executor/dispatch.js';
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

describe('dispatch liveness fields', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cyv-liveness-'));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('an opened entry carries host, pid and processStartedAt', async () => {
    const opened = await openDispatch(repo, {
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      openedAt: new Date().toISOString(),
      declaration: declaration(),
      assignment,
    });

    expect(opened.host).toBe(hostname());
    expect(opened.pid).toBe(process.pid);
    expect(typeof opened.processStartedAt).toBe('string');
  });

  it('processStartedAt is at or before openedAt and within a plausible window', async () => {
    const openedAt = new Date().toISOString();
    const opened = await openDispatch(repo, {
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      openedAt,
      declaration: declaration(),
      assignment,
    });

    const processStartedAt = opened.processStartedAt;
    if (typeof processStartedAt !== 'string') {
      throw new Error('processStartedAt was not written as an ISO string');
    }
    const started = new Date(processStartedAt);
    const openedTime = new Date(openedAt);
    expect(started.getTime()).toBeLessThanOrEqual(openedTime.getTime());
    expect(started.getTime()).toBeGreaterThan(new Date('2025-01-01T00:00:00.000Z').getTime());
  });

  it('an old opened entry without the three fields still parses with missing values absent', async () => {
    const old = {
      event: 'opened',
      schemaVersion: 1,
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      openedAt: '2026-01-01T00:00:00.000Z',
      declaration: declaration(),
      assignment,
    };
    await mkdir(join(repo, '.cyv-review'), { recursive: true });
    await appendFile(dispatchLogPath(repo), `${JSON.stringify(old)}\n`, 'utf-8');

    const entries = await readDispatchEntries(repo);
    const first = entries[0];
    if (first === undefined) throw new Error('expected one entry');
    expect(first.event).toBe('opened');
    expect(first).not.toHaveProperty('host');
    expect(first).not.toHaveProperty('pid');
    expect(first).not.toHaveProperty('processStartedAt');
  });

  it('the liveness fields are unchanged by closing the dispatch', async () => {
    const openedAt = new Date().toISOString();
    await openDispatch(repo, {
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      openedAt,
      declaration: declaration(),
      assignment,
    });

    const midRun = await readDispatchLog(repo);
    const midRecord = midRun.records[0];
    if (midRecord === undefined) throw new Error('expected a record');
    const { host, pid, processStartedAt } = midRecord;

    await closeDispatch(repo, {
      dispatchId: 'd1',
      closedAt: new Date().toISOString(),
      report: report('success', { exitCode: 0 }),
      gateResults: [{ gate: 'tsc', passed: true }],
      outcome: succeeded(),
    });

    const afterRun = await readDispatchLog(repo);
    const afterRecord = afterRun.records[0];
    if (afterRecord === undefined) throw new Error('expected a record');
    expect(afterRecord.host).toBe(host);
    expect(afterRecord.pid).toBe(pid);
    expect(afterRecord.processStartedAt).toBe(processStartedAt);
  });

  it('round-trips liveness fields through parseDispatchEntry and drops malformed values', () => {
    const withLiveness = {
      event: 'opened',
      schemaVersion: 1,
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      openedAt: '2026-01-01T00:00:00.000Z',
      declaration: declaration(),
      assignment,
      host: hostname(),
      pid: process.pid,
      processStartedAt: new Date().toISOString(),
    };

    const parsed = parseDispatchEntry(withLiveness);
    expect(parsed).toEqual(withLiveness);

    const malformed = { ...withLiveness, host: '', pid: 'not a number', processStartedAt: 123 };
    const parsedMalformed = parseDispatchEntry(malformed);
    expect(parsedMalformed).toEqual({
      event: 'opened',
      schemaVersion: 1,
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      openedAt: '2026-01-01T00:00:00.000Z',
      declaration: declaration(),
      assignment,
    });
  });
});

const OPENED_AT = '2026-09-01T11:00:00.000Z';
const STARTED_AT = '2026-09-01T10:59:30.000Z';

function probe(overrides: Partial<LivenessProbe> = {}): LivenessProbe {
  return {
    thisHost: 'box',
    processExists: () => true,
    processStartedAt: () => Promise.resolve(STARTED_AT),
    ...overrides,
  };
}

describe('judgeLiveness (spec 0036 Requirement 5, Decision 2)', () => {
  it('is undetermined when the entry carries no pid, and says so', async () => {
    const judgement = await judgeLiveness({ host: 'box', openedAt: OPENED_AT }, probe());
    expect(judgement.liveness).toBe('undetermined');
    expect(judgement.reason).toBe('entry carries no pid');
  });

  it('is undetermined when the entry carries no host', async () => {
    const judgement = await judgeLiveness({ pid: 4120, openedAt: OPENED_AT }, probe());
    expect(judgement.liveness).toBe('undetermined');
    expect(judgement.reason).toContain('host');
  });

  it('is undetermined for a dispatch opened on another host, naming both hosts', async () => {
    const judgement = await judgeLiveness(
      { host: 'elsewhere', pid: 4120, processStartedAt: STARTED_AT, openedAt: OPENED_AT },
      probe(),
    );
    expect(judgement.liveness).toBe('undetermined');
    expect(judgement.reason).toContain('elsewhere');
    expect(judgement.reason).toContain('box');
  });

  it('is abandoned when no process with that pid exists on this host', async () => {
    const judgement = await judgeLiveness(
      { host: 'box', pid: 4120, processStartedAt: STARTED_AT, openedAt: OPENED_AT },
      probe({ processExists: () => false }),
    );
    expect(judgement).toEqual({
      liveness: 'abandoned',
      reason: 'pid 4120 on this host is not running',
    });
  });

  it('is live when the process exists and its start time matches the entry', async () => {
    const judgement = await judgeLiveness(
      { host: 'box', pid: 4120, processStartedAt: STARTED_AT, openedAt: OPENED_AT },
      probe(),
    );
    expect(judgement.liveness).toBe('live');
    expect(judgement.reason).toContain('4120');
    expect(judgement.reason).toContain(STARTED_AT);
  });

  it('tolerates a start time within the tolerance window', async () => {
    const nearby = new Date(Date.parse(STARTED_AT) + PROCESS_START_TOLERANCE_MS).toISOString();
    const judgement = await judgeLiveness(
      { host: 'box', pid: 4120, processStartedAt: STARTED_AT, openedAt: OPENED_AT },
      probe({ processStartedAt: () => Promise.resolve(nearby) }),
    );
    expect(judgement.liveness).toBe('live');
  });

  it('is abandoned when the pid has been reused: the process started after the entry says it did', async () => {
    const reused = new Date(Date.parse(STARTED_AT) + PROCESS_START_TOLERANCE_MS + 1).toISOString();
    const judgement = await judgeLiveness(
      { host: 'box', pid: 4120, processStartedAt: STARTED_AT, openedAt: OPENED_AT },
      probe({ processStartedAt: () => Promise.resolve(reused) }),
    );
    expect(judgement.liveness).toBe('abandoned');
    expect(judgement.reason).toContain('reused');
    expect(judgement.reason).toContain(reused);
    expect(judgement.reason).toContain(STARTED_AT);
  });

  it('is undetermined when the process exists but its start time cannot be read', async () => {
    const judgement = await judgeLiveness(
      { host: 'box', pid: 4120, processStartedAt: STARTED_AT, openedAt: OPENED_AT },
      probe({ processStartedAt: () => Promise.resolve(undefined) }),
    );
    expect(judgement.liveness).toBe('undetermined');
    expect(judgement.reason).toContain('start time could not be read');
  });

  it('is undetermined when the entry did not record a start time to compare against', async () => {
    const judgement = await judgeLiveness({ host: 'box', pid: 4120, openedAt: OPENED_AT }, probe());
    expect(judgement.liveness).toBe('undetermined');
    expect(judgement.reason).toContain('does not record');
  });

  it('is undetermined when a start time on either side is not a date', async () => {
    const judgement = await judgeLiveness(
      { host: 'box', pid: 4120, processStartedAt: 'yesterday', openedAt: OPENED_AT },
      probe(),
    );
    expect(judgement.liveness).toBe('undetermined');
    expect(judgement.reason).toContain('yesterday');
  });

  it('is undetermined when the process started before the entry says it did, which reuse cannot produce', async () => {
    const earlier = new Date(Date.parse(STARTED_AT) - PROCESS_START_TOLERANCE_MS - 1).toISOString();
    const judgement = await judgeLiveness(
      { host: 'box', pid: 4120, processStartedAt: STARTED_AT, openedAt: OPENED_AT },
      probe({ processStartedAt: () => Promise.resolve(earlier) }),
    );
    expect(judgement.liveness).toBe('undetermined');
  });

  it('judges this very process live using the real probes', async () => {
    const processStartedAt = thisProcessStartedAt();
    if (processStartedAt === undefined) throw new Error('this process has no start time');
    const judgement = await judgeLiveness({
      host: hostname(),
      pid: process.pid,
      processStartedAt,
      openedAt: new Date().toISOString(),
    });
    expect(judgement.liveness, judgement.reason).toBe('live');
  });
});
