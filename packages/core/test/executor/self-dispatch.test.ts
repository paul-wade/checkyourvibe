import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeSelfDispatch, openSelfDispatch } from '../../src/executor/run.js';
import { loadSnapshot, snapshotPath } from '../../src/executor/snapshot.js';
import { readDispatchLog } from '../../src/executor/store.js';
import type { DispatchAssignment, DispatchDeclaration } from '../../src/executor/dispatch.js';

let repo: string;

const assignment: DispatchAssignment = {
  laneId: 'session',
  agentId: 'claude-code',
  model: 'weak',
  billing: 'subscription',
  permitsBilledOverage: false,
  orchestrator: true,
  declaredHeadroomAtSchedule: 1,
};

function declaration(overrides: Partial<DispatchDeclaration> = {}): DispatchDeclaration {
  return {
    task: 'rename the symbol',
    taskKind: 'mechanical-transformation',
    ownedPaths: ['src'],
    expectsFileChanges: true,
    gates: [],
    ...overrides,
  };
}

async function open(id = 'w1-attempt-1', decl = declaration()): Promise<void> {
  await openSelfDispatch({
    repoRoot: repo,
    dispatchId: id,
    workId: 'w1',
    attempt: 1,
    declaration: decl,
    assignment,
    observedScope: ['src'],
  });
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'cyv-self-'));
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('opening a dispatch for self-execution (spec 0041 Requirement 2.3)', () => {
  it('opens the record and persists the before snapshot without spawning anything', async () => {
    const result = await openSelfDispatch({
      repoRoot: repo,
      dispatchId: 'w1-attempt-1',
      workId: 'w1',
      attempt: 1,
      declaration: declaration(),
      assignment,
      observedScope: ['src'],
    });

    expect(result.opened.dispatchId).toBe('w1-attempt-1');
    expect(result.snapshotPath).toBe(snapshotPath(repo, 'w1-attempt-1'));

    const persisted = await loadSnapshot(repo, 'w1-attempt-1');
    expect(persisted?.observedScope).toEqual(['src']);
    expect(persisted?.snapshot.has('src/a.ts')).toBe(true);
  });

  it('leaves the dispatch open in the log, so it counts and is judged for liveness', async () => {
    await open();

    const { records } = await readDispatchLog(repo);
    const record = records.find((entry) => entry.dispatchId === 'w1-attempt-1');
    expect(record).toBeDefined();
    expect(record?.closed).toBeUndefined();
  });
});

describe('closing a self-executed dispatch (spec 0041 Requirement 2.3)', () => {
  it('judges the outcome by what changed, not by anything the session claimed', async () => {
    await open();
    await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 2;\n', 'utf8');

    const result = await closeSelfDispatch({
      repoRoot: repo,
      dispatchId: 'w1-attempt-1',
      declaration: declaration(),
      assignment,
    });

    expect(result.closed).toBe(true);
    if (!result.closed) return;
    expect(result.result.changedPaths).toEqual(['src/a.ts']);
    expect(result.result.closed.outcome.kind).toBe('succeeded');
  });

  it('records produced-nothing when the session closed without changing a file', async () => {
    await open();

    const result = await closeSelfDispatch({
      repoRoot: repo,
      dispatchId: 'w1-attempt-1',
      declaration: declaration(),
      assignment,
    });

    expect(result.closed).toBe(true);
    if (!result.closed) return;
    // The report says success — the session claimed to be done by calling
    // close at all. The outcome disagrees, which is the observed-effect rule.
    expect(result.result.closed.report.status).toBe('success');
    expect(result.result.closed.outcome.kind).toBe('produced-nothing');
  });

  it('fails a dispatch whose gate fails, even though nothing was spawned', async () => {
    await open('w1-attempt-1', declaration({ gates: ['tsc'] }));
    await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 2;\n', 'utf8');

    const result = await closeSelfDispatch({
      repoRoot: repo,
      dispatchId: 'w1-attempt-1',
      declaration: declaration({ gates: ['tsc'] }),
      assignment,
      gateRunner: () => ({ gate: 'tsc', passed: false, detail: 'two errors' }),
    });

    expect(result.closed).toBe(true);
    if (!result.closed) return;
    expect(result.result.closed.outcome.kind).not.toBe('succeeded');
    expect(result.result.closed.gateResults[0]?.passed).toBe(false);
  });

  it('carries no exit code, because there was no child to produce one', async () => {
    await open();
    await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 2;\n', 'utf8');

    const result = await closeSelfDispatch({
      repoRoot: repo,
      dispatchId: 'w1-attempt-1',
      declaration: declaration(),
      assignment,
    });

    expect(result.closed).toBe(true);
    if (!result.closed) return;
    expect(result.result.closed.report.exitCode).toBeUndefined();
    expect(result.result.closed.report.detail).toContain('no child process');
  });

  it('refuses when no before-snapshot was persisted', async () => {
    const result = await closeSelfDispatch({
      repoRoot: repo,
      dispatchId: 'never-opened',
      declaration: declaration(),
      assignment,
    });

    expect(result.closed).toBe(false);
    if (result.closed) return;
    expect(result.reason).toContain('no before-snapshot is recorded');
  });

  it('refuses a second close, because the snapshot is discarded with the first', async () => {
    await open();
    await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 2;\n', 'utf8');
    await closeSelfDispatch({
      repoRoot: repo,
      dispatchId: 'w1-attempt-1',
      declaration: declaration(),
      assignment,
    });

    const second = await closeSelfDispatch({
      repoRoot: repo,
      dispatchId: 'w1-attempt-1',
      declaration: declaration(),
      assignment,
    });

    expect(second.closed).toBe(false);
  });

  it('diffs against the scope the first phase recorded, not one passed later', async () => {
    await open();
    // A file outside the recorded scope changes; the diff must not see it.
    await mkdir(join(repo, 'docs'), { recursive: true });
    await writeFile(join(repo, 'docs', 'note.md'), 'hello\n', 'utf8');

    const result = await closeSelfDispatch({
      repoRoot: repo,
      dispatchId: 'w1-attempt-1',
      declaration: declaration(),
      assignment,
    });

    expect(result.closed).toBe(true);
    if (!result.closed) return;
    expect(result.result.observedScope).toEqual(['src']);
    expect(result.result.changedPaths).toEqual([]);
  });

  it('leaves no snapshot file behind once the dispatch is closed', async () => {
    await open();
    await closeSelfDispatch({
      repoRoot: repo,
      dispatchId: 'w1-attempt-1',
      declaration: declaration(),
      assignment,
    });

    await expect(readFile(snapshotPath(repo, 'w1-attempt-1'), 'utf8')).rejects.toThrow();
  });
});
