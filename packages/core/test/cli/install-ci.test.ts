import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command } from '../../src/cli/install-ci.js';
import type { CommandContext } from '../../src/cli/types.js';

async function makeRepo(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'cyv-install-ci-'));
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

async function write(root: string, relative: string, content: string): Promise<void> {
  const path = join(root, relative);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf-8');
}

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(repo: string, argv: string[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map((a) => String(a)).join(' '));
  });
  const error = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(args.map((a) => String(a)).join(' '));
  });

  try {
    const code = await command.run(context(repo, argv));
    return { code, stdout: out.join('\n'), stderr: err.join('\n') };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

const EXISTING_WORKFLOW = `name: existing
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;

const EXISTING_GITLAB = `stages:
  - test

existing-job:
  stage: test
  script:
    - echo hi
`;

describe('cyv install-ci', () => {
  it('reports no CI system as a statement and exits 0', async () => {
    const repo = await makeRepo();
    try {
      const result = await run(repo, []);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('CI systems detected: none.');
      expect(result.stdout).toContain('Looked for and not present: GitHub Actions');
      expect(result.stdout).toContain('not a failure');
      expect(result.stdout).toContain('--system');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 15_000);

  it('writes a GitHub Actions workflow beside the one already there', async () => {
    const repo = await makeRepo();
    try {
      await write(repo, '.github/workflows/ci.yml', EXISTING_WORKFLOW);
      await write(repo, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
      await write(
        repo,
        'package.json',
        JSON.stringify({ devDependencies: { '@checkyourvibe/core': '^0.1.0' } }),
      );

      const result = await run(repo, ['--yes']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('GitHub Actions — .github/workflows/ci.yml');
      expect(result.stdout).toContain('Package manager: pnpm — pnpm-lock.yaml.');

      const generated = await readFile(join(repo, '.github/workflows/checkyourvibe.yml'), 'utf-8');
      expect(generated).toContain('# checkyourvibe:start:ci-github-actions');
      expect(generated).toContain('pnpm exec cyv check --all --strict');
      expect(generated).toContain('fetch-depth: 0');

      const untouched = await readFile(join(repo, '.github/workflows/ci.yml'), 'utf-8');
      expect(untouched).toBe(EXISTING_WORKFLOW);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 15_000);

  it('appends a job to an existing .gitlab-ci.yml without touching what is there', async () => {
    const repo = await makeRepo();
    try {
      await write(repo, '.gitlab-ci.yml', EXISTING_GITLAB);

      const result = await run(repo, ['--yes']);
      expect(result.code).toBe(0);

      const after = await readFile(join(repo, '.gitlab-ci.yml'), 'utf-8');
      expect(after.startsWith(EXISTING_GITLAB)).toBe(true);
      expect(after).toContain('# checkyourvibe:start:ci-gitlab');
      expect(after).toContain('checkyourvibe:');
      expect(after).toContain('cyv check --all --strict');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 15_000);

  it('is idempotent: a second run changes nothing', async () => {
    const repo = await makeRepo();
    try {
      await write(repo, '.gitlab-ci.yml', EXISTING_GITLAB);
      await run(repo, ['--yes']);
      const first = await readFile(join(repo, '.gitlab-ci.yml'), 'utf-8');

      const second = await run(repo, ['--yes']);
      expect(second.code).toBe(0);
      expect(second.stdout).toContain('0 of 1 file(s) would change.');
      expect(await readFile(join(repo, '.gitlab-ci.yml'), 'utf-8')).toBe(first);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 20_000);

  it('writes nothing when --dry-run is passed', async () => {
    const repo = await makeRepo();
    try {
      await write(repo, '.gitlab-ci.yml', EXISTING_GITLAB);
      const result = await run(repo, ['--dry-run']);
      expect(result.code).toBe(0);
      expect(await readFile(join(repo, '.gitlab-ci.yml'), 'utf-8')).toBe(EXISTING_GITLAB);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 15_000);

  it('refuses to replace a file at its own path that carries no marker', async () => {
    const repo = await makeRepo();
    const foreign = 'name: someone-elses\non:\n  push:\njobs: {}\n';
    try {
      await write(repo, '.github/workflows/checkyourvibe.yml', foreign);

      const result = await run(repo, ['--yes']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('checkyourvibe did not write it');
      expect(await readFile(join(repo, '.github/workflows/checkyourvibe.yml'), 'utf-8')).toBe(foreign);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 15_000);

  it('replaces that file wholesale under --force rather than appending a second document', async () => {
    const repo = await makeRepo();
    try {
      await write(repo, '.github/workflows/checkyourvibe.yml', 'name: someone-elses\non:\n  push:\njobs: {}\n');

      const result = await run(repo, ['--yes', '--force']);
      expect(result.code).toBe(0);

      const after = await readFile(join(repo, '.github/workflows/checkyourvibe.yml'), 'utf-8');
      expect(after).not.toContain('someone-elses');
      expect(after.startsWith('# checkyourvibe:start:ci-github-actions')).toBe(true);
      // One document, not two: the appending path would have left both `name:` keys.
      expect(after.split('\nname:').length).toBe(2);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 15_000);

  it('renders a gate for a platform named with --system that is not set up yet', async () => {
    const repo = await makeRepo();
    try {
      const result = await run(repo, ['--dry-run', '--system', 'circleci']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Named with --system despite not being detected: CircleCI.');
      expect(result.stdout).toContain('Printed, not written:');
      expect(result.stdout).toContain('cyv check --all --strict');
      expect(result.stdout).toContain('0 of 0 file(s) would change.');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 15_000);

  it('rejects an unknown --system value instead of silently ignoring it', async () => {
    const repo = await makeRepo();
    try {
      const result = await run(repo, ['--system', 'teamcity']);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('is not one of');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 15_000);

  it('names the hook frameworks it found', async () => {
    const repo = await makeRepo();
    try {
      await mkdir(join(repo, '.husky'), { recursive: true });
      await write(repo, '.pre-commit-config.yaml', 'repos: []\n');
      const result = await run(repo, []);
      expect(result.stdout).toContain('husky (.husky/)');
      expect(result.stdout).toContain('pre-commit (the Python framework) (.pre-commit-config.yaml)');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 15_000);
});
