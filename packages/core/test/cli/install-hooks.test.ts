import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command } from '../../src/cli/install-hooks.js';
import type { CommandContext } from '../../src/cli/types.js';

async function makeRepo(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'cyv-install-hooks-'));
  const repo = join(parent, 'repo');
  await mkdir(repo, { recursive: true });
  execFileSync('git', ['init'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
  return repo;
}

function context(repo: string, argv: string[]): CommandContext {
  return { cwd: repo, argv, env: process.env };
}

async function cleanup(...paths: string[]): Promise<void> {
  for (const path of paths) {
    await rm(path, { recursive: true, force: true });
  }
}

describe('cyv install-hooks', () => {
  it('writes a raw pre-commit hook that is baseline-aware', async () => {
    const repo = await makeRepo();
    try {
      const code = await command.run(context(repo, []));
      expect(code).toBe(0);

      const hookPath = join(repo, '.git', 'hooks', 'pre-commit');
      const content = await readFile(hookPath, 'utf-8');
      expect(content).toContain('checkyourvibe-managed');
      expect(content).toContain('check --staged --strict');
      expect(content).toContain('checkyourvibe.baseline.json');
      expect(content).toContain('--since-baseline');
      expect(content).toContain('if [ -f ');
    } finally {
      await cleanup(repo);
    }
  }, 15_000);

  it('writes a lefthook command that is baseline-aware', async () => {
    const repo = await makeRepo();
    const lefthookPath = join(repo, 'lefthook.yml');
    await writeFile(lefthookPath, 'pre-commit:\n  commands: {}\n');

    try {
      const code = await command.run(context(repo, ['--force']));
      expect(code).toBe(0);

      const content = await readFile(lefthookPath, 'utf-8');
      expect(content).toContain('checkyourvibe-managed');
      expect(content).toContain('check --staged --strict');
      expect(content).toContain('checkyourvibe.baseline.json');
      expect(content).toContain('--since-baseline');
    } finally {
      await cleanup(repo);
    }
  }, 15_000);

  it('leaves the drift check out unless it is asked for', async () => {
    const repo = await makeRepo();
    try {
      expect(await command.run(context(repo, []))).toBe(0);
      const content = await readFile(join(repo, '.git', 'hooks', 'pre-commit'), 'utf-8');
      expect(content).not.toContain('doctor');
      expect(content).not.toContain('CYV_SKIP_DRIFT');
    } finally {
      await cleanup(repo);
    }
  }, 15_000);

  it('adds a drift check with three escapes when --with-drift-check is passed', async () => {
    const repo = await makeRepo();
    try {
      expect(await command.run(context(repo, ['--with-drift-check']))).toBe(0);
      const content = await readFile(join(repo, '.git', 'hooks', 'pre-commit'), 'utf-8');

      // It runs doctor and blocks only on exit 1 — the code that means drift.
      expect(content).toContain('doctor >/dev/null 2>&1');
      expect(content).toContain('if [ "$doctor_status" = 1 ]; then');
      expect(content).toContain('exit 1');

      // Escape one: an environment variable, named in the message it prints.
      expect(content).toContain('CYV_SKIP_DRIFT');
      expect(content).toContain('To commit without this check: CYV_SKIP_DRIFT=1 git commit');

      // Escape two: git's own in-progress state files.
      for (const state of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD']) {
        expect(content).toContain(state);
      }

      // Any other non-zero exit reports and continues rather than blocking twice.
      expect(content).toContain('could not report on drift');

      // The analysis gate still runs after it.
      expect(content).toContain('check --staged --strict');
    } finally {
      await cleanup(repo);
    }
  }, 15_000);

  it('removes the drift check when install-hooks is re-run without the flag', async () => {
    const repo = await makeRepo();
    try {
      await command.run(context(repo, ['--with-drift-check']));
      expect(await command.run(context(repo, []))).toBe(0);
      const content = await readFile(join(repo, '.git', 'hooks', 'pre-commit'), 'utf-8');
      expect(content).not.toContain('doctor');
      expect(content).toContain('check --staged --strict');
    } finally {
      await cleanup(repo);
    }
  }, 15_000);

  it('carries the drift check into a lefthook config as a single run command', async () => {
    const repo = await makeRepo();
    const lefthookPath = join(repo, 'lefthook.yml');
    await writeFile(lefthookPath, 'pre-commit:\n  commands: {}\n');

    try {
      expect(await command.run(context(repo, ['--force', '--with-drift-check']))).toBe(0);
      const content = await readFile(lefthookPath, 'utf-8');
      expect(content).toContain('doctor');
      expect(content).toContain('CYV_SKIP_DRIFT');
      expect(content).toContain('check --staged --strict');
      // Still one `run:` scalar, not a multi-line block the parser would reject.
      expect(content.split('\n').filter((line) => line.includes('run:'))).toHaveLength(1);
    } finally {
      await cleanup(repo);
    }
  }, 15_000);

  it('writes a husky pre-commit hook that is baseline-aware', async () => {
    const repo = await makeRepo();
    const huskyDir = join(repo, '.husky');
    await mkdir(huskyDir, { recursive: true });

    try {
      const code = await command.run(context(repo, []));
      expect(code).toBe(0);

      const hookPath = join(huskyDir, 'pre-commit');
      const content = await readFile(hookPath, 'utf-8');
      expect(content).toContain('checkyourvibe-managed');
      expect(content).toContain('check --staged --strict');
      expect(content).toContain('checkyourvibe.baseline.json');
      expect(content).toContain('--since-baseline');
    } finally {
      await cleanup(repo);
    }
  }, 15_000);
});
