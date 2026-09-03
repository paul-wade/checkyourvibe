import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { repoRoot, defaultBranch, mergeBase, selectFiles } from '../../src/run/discover.js';

type RunArgs = readonly string[];

function git(cwd: string, args: RunArgs): void {
  execFileSync('git', [...args], { cwd });
}

async function createTempRepo(): Promise<string> {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'cyv-')));
  const repo = join(temp, 'repo');
  await mkdir(repo, { recursive: true });
  git(repo, ['init']);
  git(repo, ['checkout', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test User']);
  return repo;
}

async function commitFile(repo: string, filePath: string, content: string): Promise<void> {
  const absPath = join(repo, filePath);
  await mkdir(resolve(absPath, '..'), { recursive: true });
  await writeFile(absPath, content);
  git(repo, ['add', filePath]);
  git(repo, ['commit', '-m', `add ${filePath}`]);
}

async function writeWorkingFile(repo: string, filePath: string, content: string): Promise<string> {
  const absPath = join(repo, filePath);
  await writeFile(absPath, content);
  return absPath;
}

describe('repoRoot', () => {
  it('resolves the repository root from a subdirectory', async () => {
    const repo = await createTempRepo();
    await commitFile(repo, 'a.txt', 'a');
    const sub = join(repo, 'src', 'deep');
    await mkdir(sub, { recursive: true });
    const root = await repoRoot(sub);
    expect(root).toBe(resolve(repo));
  });

  it('throws when the directory is not a git repository', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'cyv-nogit-')));
    await expect(repoRoot(dir)).rejects.toThrow('git is not available or the directory is not a git repository');
  });
});

describe('defaultBranch', () => {
  it('detects the current branch name', async () => {
    const repo = await createTempRepo();
    await commitFile(repo, 'a.txt', 'a');
    await expect(defaultBranch(repo)).resolves.toBe('main');
  });
});

describe('mergeBase', () => {
  it('returns the merge base with the default branch', async () => {
    const repo = await createTempRepo();
    await commitFile(repo, 'a.txt', 'a');
    const base = await mergeBase(repo, 'main');
    expect(typeof base).toBe('string');
    expect(base).toHaveLength(40);
  });
});

describe('selectFiles', () => {
  it('staged picks up an added file', async () => {
    const repo = await createTempRepo();
    await commitFile(repo, 'committed.txt', 'committed');
    const stagedPath = await writeWorkingFile(repo, 'staged.txt', 'staged');
    git(repo, ['add', 'staged.txt']);

    const selection = await selectFiles({ repoRoot: repo, mode: 'staged' });

    expect(selection.empty).toBe(false);
    expect(selection.files).toContain(resolve(stagedPath));
    expect(selection.files).not.toContain(resolve(repo, 'committed.txt'));
  });

  it('working sees an uncommitted edit', async () => {
    const repo = await createTempRepo();
    await commitFile(repo, 'tracked.txt', 'first');
    await writeWorkingFile(repo, 'tracked.txt', 'second');

    const selection = await selectFiles({ repoRoot: repo, mode: 'working' });

    expect(selection.empty).toBe(false);
    expect(selection.files).toContain(resolve(repo, 'tracked.txt'));
  });

  it('branch does NOT see an uncommitted edit', async () => {
    const repo = await createTempRepo();
    await commitFile(repo, 'tracked.txt', 'first');
    await writeWorkingFile(repo, 'tracked.txt', 'second');

    const selection = await selectFiles({ repoRoot: repo, mode: 'branch' });

    expect(selection.empty).toBe(true);
    expect(selection.files).not.toContain(resolve(repo, 'tracked.txt'));
  });

  it('all lists tracked files', async () => {
    const repo = await createTempRepo();
    await commitFile(repo, 'a.txt', 'a');
    await commitFile(repo, 'src/b.txt', 'b');

    const selection = await selectFiles({ repoRoot: repo, mode: 'all' });

    expect(selection.empty).toBe(false);
    expect(selection.files).toHaveLength(2);
    expect(selection.files).toContain(resolve(repo, 'a.txt'));
    expect(selection.files).toContain(resolve(repo, 'src/b.txt'));
  });

  it('files mode resolves and filters to existing files', async () => {
    const repo = await createTempRepo();
    await commitFile(repo, 'a.txt', 'a');

    const selection = await selectFiles({
      repoRoot: repo,
      mode: 'files',
      paths: ['a.txt', 'missing.txt'],
    });

    expect(selection.empty).toBe(false);
    expect(selection.files).toEqual([resolve(repo, 'a.txt')]);
  });

  it('empty is true when nothing matches', async () => {
    const repo = await createTempRepo();
    await commitFile(repo, 'a.txt', 'a');

    const staged = await selectFiles({ repoRoot: repo, mode: 'staged' });
    expect(staged.empty).toBe(true);
    expect(staged.files).toHaveLength(0);

    const files = await selectFiles({
      repoRoot: repo,
      mode: 'files',
      paths: ['does-not-exist.txt'],
    });
    expect(files.empty).toBe(true);
    expect(files.files).toHaveLength(0);
  });
});
