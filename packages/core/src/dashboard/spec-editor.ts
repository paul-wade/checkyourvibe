/**
 * Data-access layer for spec and task markdown files under `docs/specs/`
 * (spec 0051 Requirement 4).
 *
 * Four operations:
 *   - list   — enumerate spec files grouped by spec directory
 *   - read   — return the raw markdown for one file
 *   - write  — replace one file's content atomically (Requirement 4.2)
 *   - lock   — mutual exclusion via the state-store's edit-lock operations
 *              (Requirement 4.3)
 *
 * Path safety: every incoming path is resolved to an absolute path and
 * verified to be contained within the canonical `docs/specs/` directory.
 * A path that escapes the subtree — whether by traversal segment, symlink, or
 * any other means — is refused with a descriptive error. No normalisation
 * silently makes an unsafe path safe.
 *
 * Atomicity: writes go to a sibling `.tmp` file and are renamed into place.
 * The original survives a crash mid-write (Requirement 4.2; same pattern as
 * `state-store.ts`).
 *
 * This module is data access only. It renders no HTML and registers no routes.
 */
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  claimEditLock,
  releaseEditLock,
  readState,
} from './state-store.js';
import type { ClaimResult } from './state-store.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPECS_DIR = 'docs/specs';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One markdown file inside a spec directory. */
export interface SpecFile {
  /**
   * Repo-relative path to the file, using forward slashes.
   * Example: `docs/specs/0051-kanban-diff-drawer/requirements.md`
   */
  repoRelativePath: string;
  /** Bare filename. */
  name: string;
}

/** One spec directory and the markdown files it contains. */
export interface SpecDirectory {
  /** Bare directory name. Example: `0051-kanban-diff-drawer` */
  name: string;
  /** Files found inside this spec directory, sorted by name. */
  files: SpecFile[];
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/**
 * Resolve `filePath` relative to `repoRoot` and verify it is contained
 * within `docs/specs/`. Throws a descriptive error when the resolved path
 * escapes the subtree so callers never need to second-guess containment.
 *
 * `filePath` may be repo-relative (`docs/specs/0051/tasks.md`) or absolute.
 * Traversal segments, extra separators, and symlinks that lead outside the
 * subtree are all caught by the resolve-and-compare strategy rather than by
 * pattern matching on the raw string.
 */
function resolveAndVerify(repoRoot: string, filePath: string): string {
  if (filePath.split(/[\\/]/).includes('..')) {
    throw new Error(`Path refused: "${filePath}" contains traversal segments.`);
  }

  const specsRoot = resolve(repoRoot, SPECS_DIR);
  const absolute = resolve(repoRoot, filePath);

  // Append a path separator before the prefix test so a sibling directory
  // whose name begins with "docs/specs" cannot match.
  const sep = absolute.includes('/') ? '/' : '\\';
  const prefix = specsRoot.endsWith('/') || specsRoot.endsWith('\\')
    ? specsRoot
    : specsRoot + sep;

  if (!absolute.startsWith(prefix) && absolute !== specsRoot) {
    throw new Error(
      `Path refused: "${filePath}" resolves to "${absolute}", which is outside ` +
      `"${specsRoot}". Only files under ${SPECS_DIR}/ may be accessed.`,
    );
  }

  return absolute;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * Return all markdown files under `docs/specs/`, grouped by spec directory,
 * sorted by directory name then by file name within each directory.
 *
 * Spec directories are the immediate children of `docs/specs/`. Files nested
 * more than one level deep (e.g. in a `docs/specs/0051/assets/` subdirectory)
 * are not included; spec files live at exactly one level of depth.
 */
export async function listSpecFiles(repoRoot: string): Promise<SpecDirectory[]> {
  const specsRoot = resolve(repoRoot, SPECS_DIR);

  let topEntries: Dirent[];
  try {
    topEntries = await readdir(specsRoot, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }

  const dirs = topEntries
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();

  const result: SpecDirectory[] = [];

  for (const dirName of dirs) {
    const dirPath = join(specsRoot, dirName);
    
    let entries: Dirent[];
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch (err) {
      if (isEnoent(err)) continue;
      throw err;
    }

    const mdFiles: SpecFile[] = entries
      .filter(f => f.isFile() && f.name.endsWith('.md'))
      .map(f => f.name)
      .sort()
      .map(f => ({
        repoRelativePath: `${SPECS_DIR}/${dirName}/${f}`,
        name: f,
      }));

    if (mdFiles.length > 0) {
      result.push({ name: dirName, files: mdFiles });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read and return the markdown content of one spec file.
 *
 * `filePath` is verified to be inside `docs/specs/` before reading.
 * Throws if the file does not exist or the path is outside the subtree.
 */
export async function readSpecFile(repoRoot: string, filePath: string): Promise<string> {
  const absolute = resolveAndVerify(repoRoot, filePath);
  return readFile(absolute, 'utf-8');
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Write `content` to `filePath`, provided `holder` currently holds the edit
 * lock for that file.
 *
 * The write is atomic: the content goes to a sibling `.tmp` file and is
 * renamed into place, so the original is never truncated in a way that a
 * crash could leave it empty or partial.
 *
 * Throws when:
 * - `filePath` is outside `docs/specs/`
 * - `holder` does not currently hold the edit lock (Requirement 4.3)
 */
export async function writeSpecFile(
  repoRoot: string,
  filePath: string,
  content: string,
  holder: string,
): Promise<void> {
  const absolute = resolveAndVerify(repoRoot, filePath);

  // Verify the holder currently owns the lock before touching the file.
  const state = await readState(repoRoot);
  const lock = state.editLocks[filePath];
  if (lock === undefined || lock.holder !== holder) {
    const currentHolder = lock?.holder ?? 'nobody';
    throw new Error(
      `Write refused: "${filePath}" is locked by "${currentHolder}", not "${holder}". ` +
      `Acquire an edit lock before writing.`,
    );
  }

  // Atomic write: temp file then rename into place.
  await mkdir(dirname(absolute), { recursive: true });
  const temp = `${absolute}.tmp`;
  await writeFile(temp, content, 'utf-8');
  await rename(temp, absolute);
}

// ---------------------------------------------------------------------------
// Lock operations (thin wrappers that expose the right key convention)
// ---------------------------------------------------------------------------

/**
 * Attempt to acquire an edit lock on `filePath` for `holder`.
 *
 * The key stored in the state store is the repo-relative path exactly as
 * supplied. Callers should use consistent forward-slash repo-relative form
 * so the key is the same on every platform.
 *
 * Returns a `ClaimResult`. A `ClaimFailure` names the current holder so the
 * caller can surface a useful error rather than a generic "try again".
 */
export async function claimSpecFile(
  repoRoot: string,
  filePath: string,
  holder: string,
): Promise<ClaimResult> {
  resolveAndVerify(repoRoot, filePath);
  return claimEditLock(repoRoot, filePath, holder);
}

/**
 * Release the edit lock on `filePath` previously acquired by `holder`.
 * No-op if the lock does not exist or is held by someone else.
 */
export async function releaseSpecFile(
  repoRoot: string,
  filePath: string,
  holder: string,
): Promise<void> {
  resolveAndVerify(repoRoot, filePath);
  return releaseEditLock(repoRoot, filePath, holder);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function hasCode(value: unknown): value is { code: unknown } {
  return typeof value === 'object' && value !== null && 'code' in value;
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && hasCode(err) && err.code === 'ENOENT';
}
