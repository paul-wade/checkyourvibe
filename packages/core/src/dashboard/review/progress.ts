/**
 * Work that no dispatch record carries (0040 Requirement 3.6): uncommitted
 * changes in the working tree, and what git says landed last.
 *
 * Everything here is derived from git or from file times. Nothing is a list an
 * agent updates by hand, because such a list reports whatever it was last told
 * and gives no signal when it stops being true. `now` is passed in so a caller
 * can render a fixed moment and the output is testable without the clock.
 */
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { UncommittedWork } from '../view-model.js';

const execFileAsync = promisify(execFile);

/**
 * The separator git expands `%x1f` into. Written as an escape rather than the
 * literal byte, which is invisible in an editor and survives an edit only by
 * luck.
 */
const UNIT = '\x1f';

/** How many changed files to name before summarising the rest. */
const NAMED_FILES = 4;

export interface CommitLine {
  hash: string;
  /** Git's own relative wording, e.g. `3 hours ago`. */
  when: string;
  subject: string;
}

export function ago(fromMs: number, nowMs: number): string {
  const secs = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (secs < 45) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

async function git(repo: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', [...args], { cwd: repo });
    return stdout;
  } catch {
    // Not a repository, or no git: the caller reports nothing rather than failing.
    return undefined;
  }
}

async function changedFiles(repo: string): Promise<string[]> {
  const stdout = await git(repo, ['status', '--porcelain']);
  if (stdout === undefined) return [];
  return stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.slice(3).trim())
    .filter((name) => name !== '');
}

interface DiffTotals {
  added: number;
  removed: number;
}

async function diffTotals(repo: string): Promise<DiffTotals> {
  const stdout = await git(repo, ['diff', 'HEAD', '--numstat']);
  let added = 0;
  let removed = 0;
  for (const line of (stdout ?? '').split('\n')) {
    if (line === '') continue;
    const [a, r] = line.split('\t');
    // Binary files report `-` for both counts; they change nothing countable.
    added += Number.parseInt(a ?? '', 10) || 0;
    removed += Number.parseInt(r ?? '', 10) || 0;
  }
  return { added, removed };
}

interface TouchedFile {
  name: string;
  at: number;
}

/** Modification time per file, newest first; a file deleted from the tree has none. */
async function touched(repo: string, files: readonly string[]): Promise<TouchedFile[]> {
  const stamped: TouchedFile[] = [];
  for (const name of files) {
    try {
      const info = await stat(path.join(repo, name));
      stamped.push({ name, at: info.mtimeMs });
    } catch {
      stamped.push({ name, at: 0 });
    }
  }
  return stamped.sort((a, b) => b.at - a.at);
}

export async function uncommittedWork(
  repo: string,
  now: number = Date.now(),
): Promise<UncommittedWork> {
  const [files, totals] = await Promise.all([changedFiles(repo), diffTotals(repo)]);
  const recent = await touched(repo, files);
  // `now` bounds a touch time from the future, which a clock skew can produce
  // and which would otherwise sort ahead of every real edit.
  const named = recent.slice(0, NAMED_FILES).map((entry) => ({
    name: entry.name,
    ...(entry.at > 0 ? { touchedAt: new Date(Math.min(entry.at, now)).toISOString() } : {}),
  }));
  return {
    count: files.length,
    added: totals.added,
    removed: totals.removed,
    named,
    moreCount: Math.max(0, recent.length - NAMED_FILES),
  };
}

export async function gitLog(repo: string, n: number = 20): Promise<CommitLine[]> {
  // `%x1f` is a separator git expands itself, safe against subjects containing
  // any printable delimiter that might otherwise have been picked.
  const stdout = await git(repo, ['log', `-${n}`, `--pretty=format:%h%x1f%ar%x1f%s`]);
  if (stdout === undefined) return [];
  const lines: CommitLine[] = [];
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const [hash, when, subject] = line.split(UNIT);
    if (hash === undefined || when === undefined) continue;
    lines.push({ hash, when, subject: subject ?? '' });
  }
  return lines;
}
