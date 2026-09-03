import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectCi } from '../../src/ci/detect.js';

async function makeRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'cyv-ci-detect-'));
}

async function write(root: string, relative: string, content: string): Promise<void> {
  const path = join(root, relative);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf-8');
}

describe('CI detection', () => {
  it('reports no CI system, and names what it looked for, in a bare repository', async () => {
    const root = await makeRepo();
    try {
      const detection = await detectCi(root);
      expect(detection.systems).toEqual([]);
      expect(detection.absent).toContain('github-actions');
      expect(detection.absent).toContain('gitlab-ci');
      expect(detection.absent).toHaveLength(7);
      expect(detection.packageManager).toBeUndefined();
      expect(detection.hookFrameworks).toEqual([]);
      expect(detection.dependency).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('detects GitHub Actions from a workflow file and names it as evidence', async () => {
    const root = await makeRepo();
    try {
      await write(root, '.github/workflows/ci.yml', 'name: ci\n');
      const detection = await detectCi(root);
      expect(detection.systems.map((s) => s.id)).toEqual(['github-actions']);
      expect(detection.systems[0]?.evidence).toEqual(['.github/workflows/ci.yml']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not treat a .github directory without workflows as GitHub Actions', async () => {
    const root = await makeRepo();
    try {
      await write(root, '.github/CODEOWNERS', '* @someone\n');
      await write(root, '.github/dependabot.yml', 'version: 2\n');
      const detection = await detectCi(root);
      expect(detection.systems).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('detects every other platform from its own config file', async () => {
    const root = await makeRepo();
    try {
      await write(root, '.gitlab-ci.yml', 'stages: []\n');
      await write(root, 'Jenkinsfile', 'pipeline {}\n');
      await write(root, '.circleci/config.yml', 'version: 2.1\n');
      await write(root, 'azure-pipelines.yml', 'steps: []\n');
      await write(root, 'bitbucket-pipelines.yml', 'pipelines: {}\n');
      await write(root, '.travis.yml', 'language: node_js\n');

      const detection = await detectCi(root);
      expect(detection.systems.map((s) => s.id).sort()).toEqual([
        'azure-pipelines',
        'bitbucket-pipelines',
        'circleci',
        'gitlab-ci',
        'jenkins',
        'travis-ci',
      ]);
      expect(detection.absent).toEqual(['github-actions']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads the package manager from a lockfile', async () => {
    const root = await makeRepo();
    try {
      await write(root, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
      const detection = await detectCi(root);
      expect(detection.packageManager).toEqual({ id: 'pnpm', evidence: 'pnpm-lock.yaml' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('falls back to the packageManager field when no lockfile is committed', async () => {
    const root = await makeRepo();
    try {
      await write(root, 'package.json', JSON.stringify({ packageManager: 'yarn@4.1.0' }));
      const detection = await detectCi(root);
      expect(detection.packageManager?.id).toBe('yarn');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('detects husky, pre-commit and lefthook together', async () => {
    const root = await makeRepo();
    try {
      await mkdir(join(root, '.husky'), { recursive: true });
      await write(root, '.pre-commit-config.yaml', 'repos: []\n');
      await write(root, 'lefthook.yml', 'pre-commit: {}\n');

      const detection = await detectCi(root);
      expect(detection.hookFrameworks.map((f) => f.id)).toEqual(['husky', 'pre-commit', 'lefthook']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('finds a checkyourvibe dependency under either dependency field', async () => {
    const root = await makeRepo();
    try {
      await write(
        root,
        'package.json',
        JSON.stringify({ devDependencies: { '@checkyourvibe/core': '^0.1.0' } }),
      );
      const detection = await detectCi(root);
      expect(detection.dependency).toBe('@checkyourvibe/core');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('treats an unparseable package.json as no signal rather than throwing', async () => {
    const root = await makeRepo();
    try {
      await write(root, 'package.json', '{ this is not json');
      const detection = await detectCi(root);
      expect(detection.dependency).toBeUndefined();
      expect(detection.packageManager).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
