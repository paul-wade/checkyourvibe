import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { detectHookManager, planInstall, applyInstall } from '../../src/backstop/install.js';

type RunArgs = readonly string[];

function git(cwd: string, args: RunArgs): void {
  execFileSync('git', [...args], { cwd });
}

async function createTempRepo(): Promise<string> {
  const temp = await mkdtemp(join(tmpdir(), 'cyv-backstop-'));
  const repo = join(temp, 'repo');
  await mkdir(repo, { recursive: true });
  git(repo, ['init']);
  return repo;
}

describe('detectHookManager', () => {
  it('returns raw in a clean repo', async () => {
    const repo = await createTempRepo();
    await expect(detectHookManager(repo)).resolves.toBe('raw');
  });

  it('returns husky when a .husky directory exists', async () => {
    const repo = await createTempRepo();
    await mkdir(join(repo, '.husky'), { recursive: true });
    await expect(detectHookManager(repo)).resolves.toBe('husky');
  });

  it('returns lefthook when lefthook.yml exists', async () => {
    const repo = await createTempRepo();
    await writeFile(join(repo, 'lefthook.yml'), 'pre-commit:\n');
    await expect(detectHookManager(repo)).resolves.toBe('lefthook');
  });

  it('returns lefthook when lefthook.yaml exists', async () => {
    const repo = await createTempRepo();
    await writeFile(join(repo, 'lefthook.yaml'), 'pre-commit:\n');
    await expect(detectHookManager(repo)).resolves.toBe('lefthook');
  });

  it('prefers husky over lefthook when both are present', async () => {
    const repo = await createTempRepo();
    await mkdir(join(repo, '.husky'), { recursive: true });
    await writeFile(join(repo, 'lefthook.yml'), 'pre-commit:\n');
    await expect(detectHookManager(repo)).resolves.toBe('husky');
  });
});

describe('planInstall', () => {
  it('reports create in a clean raw repo', async () => {
    const repo = await createTempRepo();
    const plan = await planInstall(repo, 'cyv');

    expect(plan.manager).toBe('raw');
    expect(plan.action).toBe('create');
    expect(plan.existing).toBeNull();
    expect(plan.path).toBe(join(repo, '.git', 'hooks', 'pre-commit'));
  });

  it('reports create in a husky repo', async () => {
    const repo = await createTempRepo();
    await mkdir(join(repo, '.husky'), { recursive: true });
    const plan = await planInstall(repo, 'cyv');

    expect(plan.manager).toBe('husky');
    expect(plan.action).toBe('create');
    expect(plan.existing).toBeNull();
    expect(plan.path).toBe(join(repo, '.husky', 'pre-commit'));
  });

  it('reports conflict when an unmanaged pre-commit hook exists', async () => {
    const repo = await createTempRepo();
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    const original = 'existing custom hook\n';
    await mkdir(dirname(hook), { recursive: true });
    await writeFile(hook, original);

    const plan = await planInstall(repo, 'cyv');

    expect(plan.manager).toBe('raw');
    expect(plan.action).toBe('conflict');
    expect(plan.existing).toBe(original);
  });
});

describe('applyInstall', () => {
  it('refuses to overwrite an unmanaged hook and leaves it untouched', async () => {
    const repo = await createTempRepo();
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    const original = 'existing custom hook\n';
    await mkdir(dirname(hook), { recursive: true });
    await writeFile(hook, original);

    const plan = await planInstall(repo, 'cyv');
    await expect(applyInstall(plan, 'cyv')).rejects.toThrow('force');

    const after = await readFile(hook, 'utf8');
    expect(after).toBe(original);
  });

  it('replaces an unmanaged hook when force is true', async () => {
    const repo = await createTempRepo();
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    const original = 'existing custom hook\n';
    await mkdir(dirname(hook), { recursive: true });
    await writeFile(hook, original);

    const plan = await planInstall(repo, 'cyv');
    await applyInstall(plan, 'cyv', { force: true });

    const after = await readFile(hook, 'utf8');
    expect(after).toContain('#!/bin/sh');
    expect(after).toContain('# checkyourvibe-managed');
    expect(after).toContain('cyv check --staged --strict');
  });

  it('reports update and is idempotent for a managed raw hook', async () => {
    const repo = await createTempRepo();

    const plan1 = await planInstall(repo, 'cyv');
    expect(plan1.action).toBe('create');
    await applyInstall(plan1, 'cyv');

    const plan2 = await planInstall(repo, 'cyv');
    expect(plan2.action).toBe('update');
    await applyInstall(plan2, 'cyv');

    const first = await readFile(plan1.path, 'utf8');
    const second = await readFile(plan2.path, 'utf8');
    expect(second).toBe(first);
  });

  it('creates a husky pre-commit hook when the .husky directory exists', async () => {
    const repo = await createTempRepo();
    await mkdir(join(repo, '.husky'), { recursive: true });

    const plan = await planInstall(repo, 'npx cyv');
    expect(plan.manager).toBe('husky');
    await applyInstall(plan, 'npx cyv');

    const hook = await readFile(plan.path, 'utf8');
    expect(hook).toContain('#!/bin/sh');
    expect(hook).toContain('# checkyourvibe-managed');
    expect(hook).toContain('npx cyv check --staged --strict');
  });

  it('is idempotent for husky', async () => {
    const repo = await createTempRepo();
    await mkdir(join(repo, '.husky'), { recursive: true });

    const plan1 = await planInstall(repo, 'cyv');
    await applyInstall(plan1, 'cyv');

    const plan2 = await planInstall(repo, 'cyv');
    expect(plan2.action).toBe('update');
    await applyInstall(plan2, 'cyv');

    const first = await readFile(plan1.path, 'utf8');
    const second = await readFile(plan2.path, 'utf8');
    expect(second).toBe(first);
  });

  it('integrates with lefthook and rewrites a managed config', async () => {
    const repo = await createTempRepo();
    await writeFile(join(repo, 'lefthook.yml'), '# checkyourvibe-managed\npre-commit:\n  commands:\n    checkyourvibe:\n      run: cyv check --staged --strict\n');

    const plan = await planInstall(repo, 'cyv');
    expect(plan.manager).toBe('lefthook');
    expect(plan.action).toBe('update');

    await applyInstall(plan, 'cyv');
    const config = await readFile(plan.path, 'utf8');
    expect(config).toContain('# checkyourvibe-managed');
    expect(config).toContain('cyv check --staged --strict');
  });

  it('conflicts with an unmanaged lefthook config and replaces it with force', async () => {
    const repo = await createTempRepo();
    const original = 'pre-commit:\n  commands:\n    lint:\n      run: npm run lint\n';
    const configPath = join(repo, 'lefthook.yml');
    await writeFile(configPath, original);

    const plan = await planInstall(repo, 'cyv');
    expect(plan.manager).toBe('lefthook');
    expect(plan.action).toBe('conflict');
    expect(plan.existing).toBe(original);

    await applyInstall(plan, 'cyv', { force: true });
    const config = await readFile(configPath, 'utf8');
    expect(config).toContain('# checkyourvibe-managed');
    expect(config).toContain('cyv check --staged --strict');
  });
});
