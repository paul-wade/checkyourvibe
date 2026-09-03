import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { diffSnapshots } from '../../src/executor/outcome.js';
import {
  DEFAULT_EXCLUDED_DIRECTORIES,
  isWithinRoot,
  takeSnapshot,
} from '../../src/executor/snapshot.js';

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf-8');
}

/**
 * Create a link and report whether the platform produced one the walk will see
 * as a link. Windows refuses a file symlink without elevation, so a directory
 * junction is used, and a platform that produces neither leaves the linked
 * cases unexercised rather than failing.
 */
async function tryLink(linkPath: string, target: string): Promise<boolean> {
  try {
    await symlink(target, linkPath, 'junction');
  } catch {
    return false;
  }
  const info = await lstat(linkPath);
  return info.isSymbolicLink();
}

describe('takeSnapshot', () => {
  let repo: string;
  let outside: string;

  beforeEach(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), 'cyv-snapshot-')));
    outside = await realpath(await mkdtemp(join(tmpdir(), 'cyv-outside-')));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('keys every file in the scope by its repo-relative path', async () => {
    await write(repo, 'src/a.ts', 'one');
    await write(repo, 'src/nested/b.ts', 'two');

    const snapshot = await takeSnapshot(repo, ['src']);

    expect([...snapshot.keys()].sort()).toEqual(['src/a.ts', 'src/nested/b.ts']);
  });

  it('reports a content change, an addition, and a removal', async () => {
    await write(repo, 'src/a.ts', 'one');
    await write(repo, 'src/gone.ts', 'doomed');
    const before = await takeSnapshot(repo, ['src']);

    await write(repo, 'src/a.ts', 'one changed');
    await write(repo, 'src/added.ts', 'new');
    await rm(join(repo, 'src/gone.ts'));
    const after = await takeSnapshot(repo, ['src']);

    expect(diffSnapshots(before, after)).toEqual(['src/a.ts', 'src/added.ts', 'src/gone.ts']);
  });

  it('reports nothing when the scope is untouched', async () => {
    await write(repo, 'src/a.ts', 'one');
    const before = await takeSnapshot(repo, ['src']);
    const after = await takeSnapshot(repo, ['src']);

    expect(diffSnapshots(before, after)).toEqual([]);
  });

  it('contributes nothing for a scope entry that does not exist yet', async () => {
    const before = await takeSnapshot(repo, ['src/a.ts']);
    expect(before.size).toBe(0);

    await write(repo, 'src/a.ts', 'created by the dispatch');
    const after = await takeSnapshot(repo, ['src/a.ts']);

    expect(diffSnapshots(before, after)).toEqual(['src/a.ts']);
  });

  it('skips a scope entry that resolves outside the repository root', async () => {
    await write(outside, 'secret.txt', 'not mine');

    const snapshot = await takeSnapshot(repo, ['../', outside, '../../..']);

    expect([...snapshot.keys()]).toEqual([]);
  });

  it('skips the directories that hold state no dispatch owns', async () => {
    for (const excluded of DEFAULT_EXCLUDED_DIRECTORIES) {
      await write(repo, join(excluded, 'inside.txt'), 'ignored');
    }
    await write(repo, 'src/a.ts', 'one');

    const snapshot = await takeSnapshot(repo, ['.']);

    expect([...snapshot.keys()]).toEqual(['src/a.ts']);
  });

  it('honours a replacement exclusion list', async () => {
    await write(repo, 'node_modules/dep.js', 'vendored');
    await write(repo, 'build/out.js', 'generated');

    const snapshot = await takeSnapshot(repo, ['.'], { excludedDirectories: ['build'] });

    expect([...snapshot.keys()]).toEqual(['node_modules/dep.js']);
  });

  it('records a link without following it out of the repository', async () => {
    await write(outside, 'secret.txt', 'original');
    const linked = await tryLink(join(repo, 'link'), outside);
    if (!linked) return;

    const before = await takeSnapshot(repo, ['.']);
    expect([...before.keys()]).toEqual(['link']);

    await write(outside, 'secret.txt', 'changed behind the link');
    const after = await takeSnapshot(repo, ['.']);

    expect(diffSnapshots(before, after)).toEqual([]);
  });

  it('observes a link that is repointed', async () => {
    const first = await realpath(await mkdtemp(join(tmpdir(), 'cyv-target-')));
    try {
      const linked = await tryLink(join(repo, 'link'), first);
      if (!linked) return;

      const before = await takeSnapshot(repo, ['.']);
      await rm(join(repo, 'link'), { recursive: true, force: true });
      await tryLink(join(repo, 'link'), outside);
      const after = await takeSnapshot(repo, ['.']);

      expect(diffSnapshots(before, after)).toEqual(['link']);
    } finally {
      await rm(first, { recursive: true, force: true });
    }
  });

  it('collapses overlapping scope roots into one entry per path', async () => {
    await write(repo, 'src/a.ts', 'one');

    const snapshot = await takeSnapshot(repo, ['.', 'src', 'src/a.ts']);

    expect([...snapshot.keys()]).toEqual(['src/a.ts']);
  });
});

describe('isWithinRoot', () => {
  it('accepts the root itself and anything beneath it', () => {
    expect(isWithinRoot(join('/repo'), join('/repo'))).toBe(true);
    expect(isWithinRoot(join('/repo'), join('/repo', 'src', 'a.ts'))).toBe(true);
  });

  it('rejects a sibling and a parent', () => {
    expect(isWithinRoot(join('/repo'), join('/elsewhere'))).toBe(false);
    expect(isWithinRoot(join('/repo', 'src'), join('/repo'))).toBe(false);
  });
});
