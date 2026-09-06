/**
 * Reading the file system before and after a dispatch (spec 0011 Requirement
 * 2.6; amended by spec 0055 to ask git which files exist before hashing them).
 *
 * `diffSnapshots` in `outcome.ts` compares two maps of repo-relative path to
 * content digest and returns every path that differs. This produces one of
 * those maps by asking git for the candidate path list and then hashing only
 * those files, so the cost is proportional to what git tracks rather than to
 * the size of the build and dependency tree.
 *
 * When git cannot be asked — the directory is not a repository, git is absent,
 * or the command fails — the walk falls back to the prior full-directory
 * traversal and writes a warning to stderr so the fallback is visible rather
 * than silent.
 *
 * Two properties of the snapshot:
 *
 * - A symbolic link is digested from the target text `readlink` returns and is
 *   never followed. A repointed link is therefore still observed as a change,
 *   and the traversal cannot reach a file outside the paths the scope names.
 * - Every path in the git candidate set is observed, so a write to any path
 *   in that set — inside or outside the declared ownership — is still visible.
 *   Narrowing which files are *hashed* does not narrow which writes are *judged*.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { HISTORY_DIR } from '../dashboard/history.js';
import { normalizeOwnedPath } from './ownership.js';

/** A repo-relative path mapped to a digest of what was found there. */
export type Snapshot = ReadonlyMap<string, string>;

/**
 * Directory names skipped wherever they appear beneath a scope root when the
 * git-path-list path is unavailable and the full-walk fallback is in use.
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

// ---------------------------------------------------------------------------
// Git-based path listing (spec 0055)
// ---------------------------------------------------------------------------

/**
 * What `runGitLsFiles` produced, and whether it succeeded.
 *
 * Mirrors the shape used by `runCheckIgnore` in `ignored.ts` so the two
 * git-invocation patterns stay consistent.
 */
interface GitLsFilesRun {
  stdout: string;
  /** Present when the listing could not be obtained, naming what went wrong. */
  failure?: string;
}

/**
 * Run `git ls-files -z --cached --others --exclude-standard` and return its
 * NUL-delimited output.
 *
 * `--cached` lists tracked files; `--others --exclude-standard` adds untracked
 * files that are not ignored. The result is the candidate set spec 0055
 * requires: tracked + untracked-but-not-ignored, nothing else.
 *
 * `spawn` rather than `execFile` for consistency with `ignored.ts`; no paths
 * go on the command line, so a filename containing a shell metacharacter cannot
 * reach the shell.
 */
function runGitLsFiles(repoRoot: string): Promise<GitLsFilesRun> {
  return new Promise<GitLsFilesRun>((resolvePromise) => {
    const child = spawn('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err: Error) => {
      resolvePromise({ stdout: '', failure: err.message });
    });
    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolvePromise({ stdout });
      } else {
        const reason =
          stderr.trim().length > 0 ? stderr.trim() : `git exited with ${String(code)}`;
        resolvePromise({ stdout: '', failure: reason });
      }
    });
  });
}

/**
 * Obtain the set of candidate paths from git: tracked files plus untracked
 * files that are not ignored. Returns `undefined` when git cannot be asked,
 * in which case the caller falls back to a full directory walk.
 *
 * Paths are returned as platform-native relative paths (separator converted)
 * so that `join(repoRoot, path)` works on every platform.
 */
async function gitCandidatePaths(repoRoot: string): Promise<Set<string> | undefined> {
  const run = await runGitLsFiles(repoRoot);
  if (run.failure !== undefined) return undefined;

  const paths = new Set<string>();
  for (const entry of run.stdout.split('\0')) {
    if (entry.length > 0) {
      // git outputs paths with forward slashes; convert to the local
      // separator so join(repoRoot, entry) works on every platform.
      paths.add(entry.split('/').join(sep));
    }
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Snapshot from git-reported paths
// ---------------------------------------------------------------------------

/**
 * Hash only the paths git reported that fall within the given scope, keyed by
 * repo-relative path with forward slashes.
 *
 * A path that resolves outside `root` is skipped (same guard as the full walk).
 * A path that is a symlink is digested from its target text, preserving the
 * behaviour of the full walk.
 */
async function takeSnapshotFromPaths(
  root: string,
  gitPaths: Set<string>,
  scope: readonly string[],
): Promise<Map<string, string>> {
  // Resolve scope entries to absolute paths for filtering.
  const scopeRoots: string[] = [];
  for (const scopePath of scope) {
    const normalized = normalizeOwnedPath(scopePath);
    const absolute = normalized === '' ? root : resolve(root, normalized);
    if (isWithinRoot(root, absolute)) scopeRoots.push(absolute);
  }

  const into = new Map<string, string>();

  for (const rel of gitPaths) {
    const absolute = join(root, rel);

    // Skip anything that somehow resolves outside the repository root.
    if (!isWithinRoot(root, absolute)) continue;

    // Skip paths outside every scope root.
    const inScope = scopeRoots.some((scopeRoot) => isWithinRoot(scopeRoot, absolute));
    if (!inScope) continue;

    const info = await lstatOrMissing(absolute);
    if (info === undefined) continue;

    if (info.isSymbolicLink()) {
      await recordEntry(root, absolute, true, into);
    } else if (info.isFile()) {
      await recordEntry(root, absolute, false, into);
    }
    // Directories in the listing are skipped; git lists files within them.
  }

  return into;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Digest every file and symbolic link under `scope`, keyed by repo-relative
 * path.
 *
 * The candidate path list is obtained from git (tracked files + untracked but
 * not ignored files) so that ignored paths — build output, dependency trees —
 * are neither read nor reported. The observation remains whole-repository in
 * the sense that matters: any write to a path in that candidate set, inside
 * or outside the declared ownership, is still visible.
 *
 * When git cannot be asked the function falls back to a full directory walk of
 * `scope` and writes a warning to stderr so the fallback is visible rather
 * than silent. A fallback that silently observed nothing would make every
 * dispatch appear to have changed no files, which is a catastrophic silent
 * failure.
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
  const gitPaths = await gitCandidatePaths(root);

  if (gitPaths !== undefined) {
    return takeSnapshotFromPaths(root, gitPaths, scope);
  }

  // Git is unavailable or the command failed. Fall back to the full walk so
  // that the snapshot still observes the working tree rather than silently
  // seeing nothing — a silent empty snapshot would make every dispatch appear
  // to have changed no files.
  process.stderr.write(
    '[cyv] snapshot: git could not be asked for the file list; ' +
      'falling back to a full directory walk. ' +
      'This is slower but correct.\n',
  );

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
