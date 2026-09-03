/**
 * Reading the file system before and after a dispatch (spec 0011 Requirement
 * 2.6).
 *
 * `diffSnapshots` in `outcome.ts` compares two maps of repo-relative path to
 * content digest and returns every path that differs. This produces one of
 * those maps by walking a declared scope on disk, so the changed-file set a
 * dispatch is judged on is read from the repository rather than from anything
 * the executor said about itself.
 *
 * Two properties of the walk:
 *
 * - A symbolic link is digested from the target text `readlink` returns and is
 *   never followed. A repointed link is therefore still observed as a change,
 *   and the traversal cannot reach a file outside the paths the scope names.
 * - Only the scope it is given is read. The scope is the caller's declaration,
 *   so the cost of a snapshot is proportional to the paths a dispatch touches
 *   rather than to the size of the repository.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { HISTORY_DIR } from '../dashboard/history.js';
import { normalizeOwnedPath } from './ownership.js';

/** A repo-relative path mapped to a digest of what was found there. */
export type Snapshot = ReadonlyMap<string, string>;

/**
 * Directory names skipped wherever they appear beneath a scope root.
 *
 * `.git` and `node_modules` hold state no dispatch declares ownership of and
 * would make the walk's cost unbounded. `.cyv-review` holds the dispatch log
 * this layer writes to while a dispatch is open, so its contents change during
 * every run for reasons that are not the executor's doing.
 */
export const DEFAULT_EXCLUDED_DIRECTORIES: readonly string[] = [
  '.git',
  'node_modules',
  '.cyv-review',
];

export interface SnapshotOptions {
  /** Replaces `DEFAULT_EXCLUDED_DIRECTORIES` when supplied. */
  excludedDirectories?: readonly string[];
}

function isEnoent(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code: unknown = Reflect.get(err, 'code');
  return code === 'ENOENT';
}

function digest(kind: string, bytes: Buffer | string): string {
  return `${kind}:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** The repo-relative key a path is recorded under, with forward slashes. */
function keyFor(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}

/** True when `candidate` is `root` itself or sits beneath it. */
export function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function lstatOrMissing(target: string): Promise<Stats | undefined> {
  try {
    return await lstat(target);
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }
}

async function digestFile(absolute: string): Promise<string | undefined> {
  try {
    return digest('file', await readFile(absolute));
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }
}

async function digestLink(absolute: string): Promise<string | undefined> {
  try {
    return digest('symlink', await readlink(absolute));
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }
}

async function recordEntry(
  root: string,
  absolute: string,
  isLink: boolean,
  into: Map<string, string>,
): Promise<void> {
  const value = isLink ? await digestLink(absolute) : await digestFile(absolute);
  if (value === undefined) return;
  into.set(keyFor(root, absolute), value);
}

async function walkDirectory(
  root: string,
  directory: string,
  excluded: readonly string[],
  into: Map<string, string>,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }

  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      await recordEntry(root, absolute, true, into);
      continue;
    }
    if (entry.isDirectory()) {
      if (excluded.includes(entry.name)) continue;
      await walkDirectory(root, absolute, excluded, into);
      continue;
    }
    if (entry.isFile()) {
      await recordEntry(root, absolute, false, into);
    }
  }
}

async function walkScopeEntry(
  root: string,
  scopePath: string,
  excluded: readonly string[],
  into: Map<string, string>,
): Promise<void> {
  const normalized = normalizeOwnedPath(scopePath);
  const absolute = normalized === '' ? root : resolve(root, normalized);
  if (!isWithinRoot(root, absolute)) return;

  const info = await lstatOrMissing(absolute);
  if (info === undefined) return;

  if (info.isSymbolicLink()) {
    await recordEntry(root, absolute, true, into);
    return;
  }
  if (info.isDirectory()) {
    await walkDirectory(root, absolute, excluded, into);
    return;
  }
  if (info.isFile()) {
    await recordEntry(root, absolute, false, into);
  }
}

/**
 * Digest every file and symbolic link under `scope`, keyed by repo-relative
 * path.
 *
 * A scope entry that does not exist contributes nothing, so a file the dispatch
 * creates is absent from the before-snapshot and present in the after-snapshot,
 * which `diffSnapshots` reports as a change. A scope entry that resolves
 * outside `repoRoot` is skipped.
 */
export async function takeSnapshot(
  repoRoot: string,
  scope: readonly string[],
  options: SnapshotOptions = {},
): Promise<Map<string, string>> {
  const root = resolve(repoRoot);
  const excluded = options.excludedDirectories ?? DEFAULT_EXCLUDED_DIRECTORIES;
  const into = new Map<string, string>();
  for (const scopePath of scope) {
    await walkScopeEntry(root, scopePath, excluded, into);
  }
  return into;
}

/**
 * Where a dispatch's before-snapshot waits between the two phases of a
 * sub-agent run (spec 0041 Requirement 2.3).
 *
 * A dispatch to a CLI brackets the child: snapshot, run, snapshot, all inside
 * one process. A sub-agent dispatch is the orchestrating session doing the work
 * itself, so the two snapshots are taken by two different invocations of `cyv`,
 * minutes or hours apart, and the first one's result has to outlive its
 * process. It lives beside the dispatch log rather than in memory for the same
 * reason the log does: a run has to be readable from disk alone (spec 0036).
 */
export function snapshotPath(repoRoot: string, dispatchId: string): string {
  return join(repoRoot, HISTORY_DIR, 'snapshots', `${dispatchId}.json`);
}

/** What `persistSnapshot` wrote, as `loadSnapshot` returns it. */
export interface PersistedSnapshot {
  snapshot: Snapshot;
  /** The scope the snapshot covered, so the second phase can match it exactly. */
  observedScope: readonly string[];
}

export async function persistSnapshot(
  repoRoot: string,
  dispatchId: string,
  persisted: PersistedSnapshot,
): Promise<string> {
  const target = snapshotPath(repoRoot, dispatchId);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(
    target,
    JSON.stringify(
      {
        observedScope: persisted.observedScope,
        entries: Object.fromEntries(persisted.snapshot),
      },
      null,
      2,
    ),
    'utf8',
  );
  return target;
}

/**
 * The persisted snapshot for a dispatch, or `undefined` when there is none.
 *
 * `undefined` is what `--close` on an unknown or already-closed dispatch gets,
 * and Requirement 2.3 has it refuse rather than proceed: without the before
 * snapshot there is nothing to diff against, and closing anyway would record an
 * outcome derived from a comparison that never happened.
 */
export async function loadSnapshot(
  repoRoot: string,
  dispatchId: string,
): Promise<PersistedSnapshot | undefined> {
  let text: string;
  try {
    text = await readFile(snapshotPath(repoRoot, dispatchId), 'utf8');
  } catch {
    return undefined;
  }

  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const scope = 'observedScope' in parsed ? parsed.observedScope : undefined;
  const entries = 'entries' in parsed ? parsed.entries : undefined;
  if (!isStringArray(scope)) return undefined;
  if (!isUnknownRecord(entries)) return undefined;

  const snapshot = new Map<string, string>();
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value !== 'string') return undefined;
    snapshot.set(key, value);
  }
  return { snapshot, observedScope: scope };
}

function isStringArray(value: unknown): value is string[] {
  return isUnknownArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * `Array.isArray` narrows an `unknown` to `any[]`, which makes every element
 * read from it an `any` — including the `entry` a `.every` callback receives.
 * Narrowing to `unknown[]` keeps the element checks meaningful.
 */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Narrow to a record whose values are `unknown` rather than leaving them
 * inferred. `Object.entries` on a bare `object` hands back `any` values, so
 * every `typeof value === 'string'` check below would be checking an `any` and
 * proving nothing.
 */
function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Remove a dispatch's persisted snapshot once it has been closed. */
export async function discardSnapshot(repoRoot: string, dispatchId: string): Promise<void> {
  await rm(snapshotPath(repoRoot, dispatchId), { force: true });
}
