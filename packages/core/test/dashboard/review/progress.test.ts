import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ago, gitLog, uncommittedWork } from '../../../src/dashboard/review/progress.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd },
  );
  return stdout;
}

describe('ago', () => {
  it('uses the same wording at every scale', () => {
    const now = 1_000_000_000_000;
    expect(ago(now, now)).toBe('0s ago');
    expect(ago(now + 5000, now)).toBe('0s ago');
    expect(ago(now - 44_000, now)).toBe('44s ago');
    expect(ago(now - 45_000, now)).toBe('1m ago');
    expect(ago(now - 89 * 60_000, now)).toBe('89m ago');
    expect(ago(now - 90 * 60_000, now)).toBe('2h ago');
    expect(ago(now - 35 * 3_600_000, now)).toBe('35h ago');
    expect(ago(now - 36 * 3_600_000, now)).toBe('2d ago');
    expect(ago(now - 10 * 86_400_000, now)).toBe('10d ago');
  });
});

describe('uncommittedWork and gitLog', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cyv-progress-'));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('reports zeros and no commits for a directory that is not a repository', async () => {
    expect(await uncommittedWork(repo, 1)).toEqual({
      count: 0,
      added: 0,
      removed: 0,
      named: [],
      moreCount: 0,
    });
    expect(await gitLog(repo)).toEqual([]);
  });

  it('counts changed files, line totals, and names the most recently touched', async () => {
    await git(repo, 'init', '-q');
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt']) {
      await writeFile(join(repo, name), 'one\ntwo\n', 'utf8');
    }
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'first commit');

    const clean = await uncommittedWork(repo);
    expect(clean.count).toBe(0);
    expect(clean.named).toEqual([]);

    await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\n', 'utf8');
    await writeFile(join(repo, 'b.txt'), '', 'utf8');
    await writeFile(join(repo, 'c.txt'), 'x\n', 'utf8');
    await writeFile(join(repo, 'd.txt'), 'x\n', 'utf8');
    await writeFile(join(repo, 'e.txt'), 'x\n', 'utf8');
    await writeFile(join(repo, 'new.txt'), 'untracked\n', 'utf8');

    const now = Date.now() + 60_000;
    const work = await uncommittedWork(repo, now);
    expect(work.count).toBe(6);
    // a.txt gains one line; b.txt loses two; c, d and e each swap two lines for one.
    expect(work.added).toBe(1 + 3);
    expect(work.removed).toBe(2 + 6);
    expect(work.named).toHaveLength(4);
    expect(work.moreCount).toBe(2);
    const names = work.named.map((n) => n.name);
    expect(names).toContain('new.txt');
    for (const entry of work.named) {
      expect(typeof entry.touchedAt).toBe('string');
      expect(Date.parse(entry.touchedAt ?? '')).toBeLessThanOrEqual(now);
    }

    const log = await gitLog(repo, 5);
    expect(log).toHaveLength(1);
    expect(log[0]?.subject).toBe('first commit');
    expect(log[0]?.hash).toMatch(/^[0-9a-f]{7,}$/);
    expect(log[0]?.when).toMatch(/ago$/);
  });

  it('keeps a subject containing the delimiters a naive split would trip on', async () => {
    await git(repo, 'init', '-q');
    await writeFile(join(repo, 'a.txt'), 'x\n', 'utf8');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'a | b ; c\tstill one subject');
    const log = await gitLog(repo, 1);
    expect(log[0]?.subject).toBe('a | b ; c\tstill one subject');
  });
});
