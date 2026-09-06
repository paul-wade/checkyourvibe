import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  ensureWorktree,
  claimWorktree,
  reclaimWorktree,
  mergeWorktree,
  removeWorktree,
  readWorktreeLog,
} from '../../src/executor/worktree.js';
import { openDispatch, readDispatchLog } from '../../src/executor/store.js';
import { readState } from '../../src/dashboard/state-store.js';
import type { DispatchAssignment } from '../../src/executor/dispatch.js';
import type { GateContext } from '../../src/executor/run.js';
import type { GateResult } from '../../src/executor/outcome.js';
import { declaration } from './fixtures.js';

const execFileAsync = promisify(execFile);

const noOpPrepare = [
  { command: 'node', args: ['-e', 'console.log("prepared")'] },
];

const testAssignment: DispatchAssignment = {
  laneId: 'local',
  agentId: 'local-agent',
  model: 'weak',
  billing: 'subscription',
  permitsBilledOverage: false,
  orchestrator: false,
  declaredHeadroomAtSchedule: 1,
};

const passingCyvCheck = (_context: GateContext): Promise<GateResult> =>
  Promise.resolve({ gate: 'cyv-check', passed: true, detail: 'clean' });

const failingCyvCheck = (_context: GateContext): Promise<GateResult> =>
  Promise.resolve({ gate: 'cyv-check', passed: false, detail: 'dirty' });

const passingGateRunner = (gate: string): GateResult => ({ gate, passed: true });
const failingGateRunner = (gate: string): GateResult => ({ gate, passed: false, detail: 'fails' });

async function initGitRepo(repo: string): Promise<void> {
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.email', 'cyv@test'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.name', 'cyv'], { cwd: repo });
  await writeFile(join(repo, 'README.md'), '# test\n', 'utf-8');
  await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repo });
}

async function branchLog(repo: string, branch: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['log', '--oneline', `main..${branch}`], {
    cwd: repo,
  });
  return stdout.trim();
}

async function commitInWorktree(worktreePath: string, message: string): Promise<void> {
  await execFileAsync('git', ['add', '.'], { cwd: worktreePath });
  await execFileAsync('git', ['commit', '-m', message], { cwd: worktreePath });
}

describe('worktree', () => {
  let repo: string;
  let worktreeRoot: string;

  beforeEach(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), 'cyv-worktree-main-')));
    worktreeRoot = join(dirname(repo), 'cyv-worktree-roots');
    await initGitRepo(repo);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(worktreeRoot, { recursive: true, force: true });
  });

  it('creates and reuses a worktree for a spec', async () => {
    const first = await ensureWorktree({
      repoRoot: repo,
      specName: 'test-spec',
      worktreeRoot,
      prepareSteps: noOpPrepare,
    });
    expect(first.created).toBe(true);
    expect(first.prepared).toBe(true);
    expect(first.worktreePath).toContain('test-spec');

    const log = await readWorktreeLog(repo, 'test-spec');
    expect(log.map((t) => t.state)).toEqual(['created', 'prepared']);

    const second = await ensureWorktree({
      repoRoot: repo,
      specName: 'test-spec',
      worktreeRoot,
      prepareSteps: noOpPrepare,
    });
    expect(second.created).toBe(false);
    expect(second.prepared).toBe(false);
    expect(second.worktreePath).toBe(first.worktreePath);
  });

  it('refuses a second claim and names the holder', async () => {
    const wt = await ensureWorktree({
      repoRoot: repo,
      specName: 'claim-spec',
      worktreeRoot,
      prepareSteps: noOpPrepare,
    });
    const first = await claimWorktree({
      repoRoot: repo,
      specName: 'claim-spec',
      holder: 'd1',
      worktreeRoot,
    });
    expect(first.claimed).toBe(true);
    if (!first.claimed) {
      throw new Error('expected first to be claimed');
    }
    expect(first.worktreePath).toBe(wt.worktreePath);

    const second = await claimWorktree({
      repoRoot: repo,
      specName: 'claim-spec',
      holder: 'd2',
      worktreeRoot,
    });
    expect(second.claimed).toBe(false);
    if (!second.claimed) {
      expect(second.holder).toBe('d1');
    }
  });

  it('reclaims a worktree whose holder is gone', async () => {
    const wt = await ensureWorktree({
      repoRoot: repo,
      specName: 'reclaim-dead',
      worktreeRoot,
      prepareSteps: noOpPrepare,
    });
    const decl = declaration({ ownedPaths: ['src/a.ts'] });
    await openDispatch(repo, {
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      openedAt: '2026-01-01T00:00:00.000Z',
      declaration: decl,
      assignment: testAssignment,
    });
    await claimWorktree({ repoRoot: repo, specName: 'reclaim-dead', holder: 'd1', worktreeRoot });

    const result = await reclaimWorktree({
      repoRoot: repo,
      specName: 'reclaim-dead',
      holder: 'd2',
      worktreeRoot,
      livenessProbe: { processExists: () => false },
    });
    expect(result.reclaimed).toBe(true);
    if (!result.reclaimed) {
      throw new Error('expected result to be reclaimed');
    }
    expect(result.worktreePath).toBe(wt.worktreePath);

    const state = await readState(repo);
    expect(state.workingTrees[wt.worktreePath] ?? 'no-holder').toBe('d2');

    const log = await readWorktreeLog(repo, 'reclaim-dead');
    const reclaimed = log.find((t) => t.state === 'reclaimed');
    expect(reclaimed).toBeDefined();
    expect(reclaimed?.previousHolder).toBe('d1');
  });

  it('refuses to reclaim a worktree from a live holder', async () => {
    await ensureWorktree({
      repoRoot: repo,
      specName: 'reclaim-live',
      worktreeRoot,
      prepareSteps: noOpPrepare,
    });
    const decl = declaration({ ownedPaths: ['src/a.ts'] });
    await openDispatch(repo, {
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      openedAt: '2026-01-01T00:00:00.000Z',
      declaration: decl,
      assignment: testAssignment,
    });
    await claimWorktree({ repoRoot: repo, specName: 'reclaim-live', holder: 'd1', worktreeRoot });

    const { records } = await readDispatchLog(repo);
    const record = records.find((r) => r.dispatchId === 'd1');
    const processStartedAt = record?.processStartedAt ?? '2026-01-01T00:00:00.000Z';

    const result = await reclaimWorktree({
      repoRoot: repo,
      specName: 'reclaim-live',
      holder: 'd2',
      worktreeRoot,
      livenessProbe: {
        processExists: () => true,
        processStartedAt: () => Promise.resolve(processStartedAt),
      },
    });
    expect(result.reclaimed).toBe(false);
    if (!result.reclaimed) {
      expect(result.holder).toBe('d1');
      expect(result.liveness).toBe('live');
    }
  });

  it('refuses to merge a changed path outside the declared ownership', async () => {
    const wt = await ensureWorktree({
      repoRoot: repo,
      specName: 'merge-out-of-scope',
      worktreeRoot,
      prepareSteps: noOpPrepare,
    });
    await claimWorktree({
      repoRoot: repo,
      specName: 'merge-out-of-scope',
      holder: 'd1',
      worktreeRoot,
    });
    await writeFile(join(wt.worktreePath, 'outside.txt'), 'outside', 'utf-8');

    const result = await mergeWorktree({
      repoRoot: repo,
      specName: 'merge-out-of-scope',
      holder: 'd1',
      declaration: declaration({ ownedPaths: ['src/a.ts'], gates: [], expectsFileChanges: true }),
      assignment: testAssignment,
      worktreeRoot,
      runCyvCheck: passingCyvCheck,
      gateRunner: passingGateRunner,
    });
    expect(result.merged).toBe(false);
    expect(result.reason).toBe('out-of-scope');
    expect(result.detail).toContain('outside.txt');
  });

  it('refuses to merge when cyv-check is not clean', async () => {
    const wt = await ensureWorktree({
      repoRoot: repo,
      specName: 'merge-cyv-fail',
      worktreeRoot,
      prepareSteps: noOpPrepare,
    });
    await claimWorktree({
      repoRoot: repo,
      specName: 'merge-cyv-fail',
      holder: 'd1',
      worktreeRoot,
    });
    await mkdir(join(wt.worktreePath, 'src'), { recursive: true });
    await writeFile(join(wt.worktreePath, 'src', 'a.ts'), 'inside', 'utf-8');

    const result = await mergeWorktree({
      repoRoot: repo,
      specName: 'merge-cyv-fail',
      holder: 'd1',
      declaration: declaration({ ownedPaths: ['src/a.ts'], gates: [], expectsFileChanges: true }),
      assignment: testAssignment,
      worktreeRoot,
      runCyvCheck: failingCyvCheck,
      gateRunner: passingGateRunner,
    });
    expect(result.merged).toBe(false);
    expect(result.reason).toBe('cyv-check-failed');
  });

  it('refuses to merge when a gate fails', async () => {
    const wt = await ensureWorktree({
      repoRoot: repo,
      specName: 'merge-gate-fail',
      worktreeRoot,
      prepareSteps: noOpPrepare,
    });
    await claimWorktree({
      repoRoot: repo,
      specName: 'merge-gate-fail',
      holder: 'd1',
      worktreeRoot,
    });
    await mkdir(join(wt.worktreePath, 'src'), { recursive: true });
    await writeFile(join(wt.worktreePath, 'src', 'a.ts'), 'inside', 'utf-8');

    const result = await mergeWorktree({
      repoRoot: repo,
      specName: 'merge-gate-fail',
      holder: 'd1',
      declaration: declaration({
        ownedPaths: ['src/a.ts'],
        gates: ['run:fail'],
        expectsFileChanges: true,
      }),
      assignment: testAssignment,
      worktreeRoot,
      runCyvCheck: passingCyvCheck,
      gateRunner: failingGateRunner,
    });
    expect(result.merged).toBe(false);
    expect(result.reason).toBe('gate-failed');
    expect(result.detail).toContain('run:fail');
  });

  it('leaves the worktree and its commits intact when a merge is refused', async () => {
    const wt = await ensureWorktree({
      repoRoot: repo,
      specName: 'merge-keeps-commits',
      worktreeRoot,
      prepareSteps: noOpPrepare,
    });
    await claimWorktree({
      repoRoot: repo,
      specName: 'merge-keeps-commits',
      holder: 'd1',
      worktreeRoot,
    });
    await mkdir(join(wt.worktreePath, 'src'), { recursive: true });
    await writeFile(join(wt.worktreePath, 'src', 'a.ts'), 'inside', 'utf-8');
    await commitInWorktree(wt.worktreePath, 'agent commit');

    const branch = wt.branch;
    const before = await branchLog(repo, branch);
    expect(before.length).toBeGreaterThan(0);

    const result = await mergeWorktree({
      repoRoot: repo,
      specName: 'merge-keeps-commits',
      holder: 'd1',
      declaration: declaration({ ownedPaths: ['src/a.ts'], gates: [], expectsFileChanges: true }),
      assignment: testAssignment,
      worktreeRoot,
      runCyvCheck: failingCyvCheck,
      gateRunner: passingGateRunner,
    });
    expect(result.merged).toBe(false);

    const after = await branchLog(repo, branch);
    expect(after).toBe(before);
  });

  it('merges a clean worktree and releases the claim', async () => {
    const wt = await ensureWorktree({
      repoRoot: repo,
      specName: 'merge-success',
      worktreeRoot,
      prepareSteps: noOpPrepare,
    });
    await claimWorktree({
      repoRoot: repo,
      specName: 'merge-success',
      holder: 'd1',
      worktreeRoot,
    });
    await mkdir(join(wt.worktreePath, 'src'), { recursive: true });
    await writeFile(join(wt.worktreePath, 'src', 'a.ts'), 'merged content', 'utf-8');

    const result = await mergeWorktree({
      repoRoot: repo,
      specName: 'merge-success',
      holder: 'd1',
      declaration: declaration({ ownedPaths: ['src/a.ts'], gates: [], expectsFileChanges: true }),
      assignment: testAssignment,
      worktreeRoot,
      runCyvCheck: passingCyvCheck,
      gateRunner: passingGateRunner,
    });
    expect(result.merged).toBe(true);
    expect(result.changedPaths).toContain('src/a.ts');

    const state = await readState(repo);
    expect(wt.worktreePath in state.workingTrees).toBe(false);

    const mainContent = await readFile(join(repo, 'src', 'a.ts'), 'utf-8');
    expect(mainContent).toBe('merged content');

    const log = await readWorktreeLog(repo, 'merge-success');
    const merged = log.find((t) => t.state === 'merged');
    expect(merged).toBeDefined();
    expect(merged?.enforcement).toBe('merge-time');
  });

  it('refuses to remove a worktree that has unmerged work', async () => {
    const wt = await ensureWorktree({
      repoRoot: repo,
      specName: 'remove-unmerged',
      worktreeRoot,
      prepareSteps: noOpPrepare,
    });
    await claimWorktree({
      repoRoot: repo,
      specName: 'remove-unmerged',
      holder: 'd1',
      worktreeRoot,
    });
    await writeFile(join(wt.worktreePath, 'unmerged.txt'), 'unmerged', 'utf-8');

    const first = await removeWorktree({
      repoRoot: repo,
      specName: 'remove-unmerged',
      holder: 'd1',
      worktreeRoot,
    });
    expect(first.removed).toBe(false);
    expect(first.reason).toBe('unmerged-work');

    const second = await removeWorktree({
      repoRoot: repo,
      specName: 'remove-unmerged',
      holder: 'd1',
      worktreeRoot,
      abandon: true,
    });
    expect(second.removed).toBe(true);
  });
});
