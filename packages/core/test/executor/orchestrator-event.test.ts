import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseDispatchEntry } from '../../src/executor/parse.js';
import {
  dispatchLogPath,
  foldDispatchEntries,
  openDispatch,
  readDispatchEntries,
  readDispatchLog,
  recordOrchestratorState,
  refuseDispatch,
} from '../../src/executor/store.js';
import type { DispatchAssignment, DispatchEntry } from '../../src/executor/dispatch.js';
import { command } from '../../src/cli/orchestrator.js';
import type { CommandContext } from '../../src/cli/types.js';
import { declaration } from './fixtures.js';

const assignment: DispatchAssignment = {
  laneId: 'alpha',
  agentId: 'alpha-agent',
  model: 'weak',
  billing: 'subscription',
  permitsBilledOverage: false,
  orchestrator: false,
  declaredHeadroomAtSchedule: 2,
};

const REPORT = {
  event: 'orchestrator',
  schemaVersion: 1,
  reportedAt: '2026-09-01T10:00:00.000Z',
  state: 'degraded',
  reason: 'the vendor said the weekly limit is near',
  model: 'opus',
  host: 'box',
  pid: 4120,
};

describe('the orchestrator self-report entry (spec 0036 Requirement 3)', () => {
  it('parses a full report field for field', () => {
    expect(parseDispatchEntry(REPORT)).toEqual(REPORT);
  });

  it('parses a report with only the required fields', () => {
    const minimal = { event: 'orchestrator', schemaVersion: 1, reportedAt: REPORT.reportedAt, state: 'healthy' };
    expect(parseDispatchEntry(minimal)).toEqual(minimal);
  });

  it('rejects a state outside the three the spec names', () => {
    expect(parseDispatchEntry({ ...REPORT, state: 'fine' })).toBeUndefined();
    expect(parseDispatchEntry({ ...REPORT, state: undefined })).toBeUndefined();
  });

  it('rejects a report missing its timestamp or schema version', () => {
    expect(parseDispatchEntry({ ...REPORT, reportedAt: undefined })).toBeUndefined();
    expect(parseDispatchEntry({ ...REPORT, schemaVersion: 'one' })).toBeUndefined();
  });

  it('rejects a reason or model that is present and not a string', () => {
    expect(parseDispatchEntry({ ...REPORT, reason: 42 })).toBeUndefined();
    expect(parseDispatchEntry({ ...REPORT, model: { name: 'opus' } })).toBeUndefined();
  });

  it('drops a malformed host or pid rather than losing the report', () => {
    const parsed = parseDispatchEntry({ ...REPORT, host: '', pid: -1 });
    expect(parsed).toBeDefined();
    expect(parsed).not.toHaveProperty('host');
    expect(parsed).not.toHaveProperty('pid');
  });
});

describe('recording and folding the self-report (spec 0036 Requirements 3.2, 3.4)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cyv-orchestrator-'));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('writes the report to the dispatch log with this process identity', async () => {
    const written = await recordOrchestratorState(repo, {
      state: 'exhausted',
      reason: 'rate limited until tomorrow',
      model: 'opus',
      reportedAt: '2026-09-01T10:00:00.000Z',
    });

    expect(written.host).toBe(hostname());
    expect(written.pid).toBe(process.pid);
    expect(await readDispatchEntries(repo)).toEqual([written]);

    const raw = await readFile(dispatchLogPath(repo), 'utf-8');
    expect(raw.split('\n').filter((line) => line.length > 0)).toHaveLength(1);
  });

  it('the log carries the last report in log order, and none means unknown', async () => {
    expect(await readDispatchLog(repo)).not.toHaveProperty('orchestrator');

    await recordOrchestratorState(repo, { state: 'healthy', reportedAt: '2026-09-01T09:00:00.000Z' });
    const later = await recordOrchestratorState(repo, {
      state: 'degraded',
      reportedAt: '2026-09-01T10:00:00.000Z',
    });

    const log = await readDispatchLog(repo);
    expect(log.orchestrator).toEqual(later);
  });

  it('a report between dispatch entries changes nothing about the records or refusals', async () => {
    await openDispatch(repo, {
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      openedAt: '2026-09-01T09:00:00.000Z',
      declaration: declaration(),
      assignment,
    });
    await recordOrchestratorState(repo, { state: 'degraded', reportedAt: '2026-09-01T09:30:00.000Z' });
    await refuseDispatch(repo, {
      dispatchId: 'd2',
      workId: 'w2',
      refusedAt: '2026-09-01T09:45:00.000Z',
      declaration: declaration(),
      refusal: { reason: 'no-eligible-lane', rejections: [] },
    });

    const log = await readDispatchLog(repo);
    expect(log.records.map((record) => record.dispatchId)).toEqual(['d1']);
    expect(log.refusals.map((refusal) => refusal.dispatchId)).toEqual(['d2']);
    expect(log.orchestrator?.state).toBe('degraded');
  });

  it('foldDispatchEntries keeps the last report in log order, not the latest timestamp', () => {
    const entries: DispatchEntry[] = [
      { event: 'orchestrator', schemaVersion: 1, reportedAt: '2026-09-01T11:00:00.000Z', state: 'healthy' },
      { event: 'orchestrator', schemaVersion: 1, reportedAt: '2026-09-01T10:00:00.000Z', state: 'exhausted' },
    ];
    expect(foldDispatchEntries(entries).orchestrator?.state).toBe('exhausted');
  });

  it('a line with an event kind nobody knows is still counted unparseable, not mistaken for a report', async () => {
    await mkdir(join(repo, '.cyv-review'), { recursive: true });
    await appendFile(
      dispatchLogPath(repo),
      `${JSON.stringify({ event: 'heartbeat', schemaVersion: 1, at: '2026-09-01T10:00:00.000Z' })}\n`,
      'utf-8',
    );
    const stats = { unparseableLines: 0 };
    const log = await readDispatchLog(repo, stats);
    expect(stats.unparseableLines).toBe(1);
    expect(log).not.toHaveProperty('orchestrator');
  });
});

interface Captured {
  logs: string[];
  errors: string[];
  restore: () => void;
}

function capture(): Captured {
  const logs: string[] = [];
  const errors: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  });
  const error = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map((arg) => String(arg)).join(' '));
  });
  return {
    logs,
    errors,
    restore: () => {
      log.mockRestore();
      error.mockRestore();
    },
  };
}

describe('cyv orchestrator (spec 0036 Requirements 3.1, 3.3, 3.4)', () => {
  let repo: string;
  let captured: Captured;

  function ctx(argv: string[]): CommandContext {
    return { cwd: repo, argv, env: {} };
  }

  beforeEach(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), 'cyv-orchestrator-cli-')));
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    captured = capture();
  });

  afterEach(async () => {
    captured.restore();
    await rm(repo, { recursive: true, force: true });
  });

  it('prints unknown, attributed, when no report has been recorded', async () => {
    expect(await command.run(ctx([]))).toBe(0);
    expect(captured.logs).toEqual(['no self-report recorded — unknown']);
  });

  it('records a report and confirms it on one line', async () => {
    const code = await command.run(
      ctx(['--state', 'degraded', '--reason', 'limit is near', '--model', 'opus']),
    );
    expect(code).toBe(0);
    expect(captured.logs).toHaveLength(1);
    const line = captured.logs[0] ?? '';
    expect(line).toContain('self-reported');
    expect(line).toContain('degraded');
    expect(line).toContain('limit is near');
    expect(line).toContain('opus');

    const log = await readDispatchLog(repo);
    expect(log.orchestrator?.state).toBe('degraded');
    expect(log.orchestrator?.reason).toBe('limit is near');
    expect(log.orchestrator?.model).toBe('opus');
  });

  it('reads the last report back with its timestamp, attributed self-reported', async () => {
    await recordOrchestratorState(repo, { state: 'exhausted', reportedAt: '2026-09-01T10:00:00.000Z' });
    expect(await command.run(ctx([]))).toBe(0);
    const line = captured.logs[0] ?? '';
    expect(line).toContain('self-reported');
    expect(line).toContain('2026-09-01T10:00:00.000Z');
    expect(line).toContain('exhausted');
    expect(line).not.toMatch(/measured|observed|detected/);
  });

  it('--json prints the report, or the unknown state when there is none', async () => {
    expect(await command.run(ctx(['--json']))).toBe(0);
    const empty: unknown = JSON.parse(captured.logs[0] ?? '');
    expect(empty).toEqual({ attribution: 'self-reported', state: 'unknown', report: null });

    const report = await recordOrchestratorState(repo, {
      state: 'healthy',
      reportedAt: '2026-09-01T10:00:00.000Z',
    });
    expect(await command.run(ctx(['--json']))).toBe(0);
    const withReport: unknown = JSON.parse(captured.logs[1] ?? '');
    expect(withReport).toEqual({ attribution: 'self-reported', state: 'healthy', report });
  });

  it('exits 2 on a state it does not record, naming the three it does', async () => {
    expect(await command.run(ctx(['--state', 'tired']))).toBe(2);
    const message = captured.errors.join('\n');
    expect(message).toContain('healthy');
    expect(message).toContain('degraded');
    expect(message).toContain('exhausted');
    expect(await readDispatchEntries(repo)).toEqual([]);
  });

  it('exits 2 on an unknown argument and on --reason without --state', async () => {
    expect(await command.run(ctx(['--bogus']))).toBe(2);
    expect(await command.run(ctx(['--reason', 'why']))).toBe(2);
  });

  it('--help prints usage and exits 0', async () => {
    expect(await command.run(ctx(['--help']))).toBe(0);
    expect(captured.logs.join('\n')).toContain('Usage: cyv orchestrator');
  });
});
