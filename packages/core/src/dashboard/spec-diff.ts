/**
 * The diff a person reviews is the spec's, not a dispatch's.
 *
 * A spec is finished by several dispatches, each of which changed a few files.
 * Reviewing them one at a time asks for a sign-off on every individual edit,
 * which is the gate's job. What a person wants is the same thing a pull request
 * shows: every file the spec touched, against the branch it will land on.
 *
 * This computes that from git rather than from the dispatch snapshots, because
 * the snapshots record a content digest per path and not the content itself.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Whole-file diffs run to megabytes; the drawer renders a review, not a dump. */
const MAX_LINES = 4000;

/**
 * No single file may spend the whole budget. Two large files once consumed it
 * between them and the twenty-nine after them rendered as "+0 −0", which reads
 * as "this file did not change" — the opposite of true.
 */
const MAX_LINES_PER_FILE = 400;

export type DiffLineKind = 'context' | 'added' | 'removed' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface DiffFile {
  path: string;
  added: number;
  removed: number;
  lines: DiffLine[];
  /** Its counts are complete; its body was cut to keep the drawer readable. */
  bodyTruncated: boolean;
}

export interface SpecDiff {
  base: string;
  files: DiffFile[];
  truncated: boolean;
  /** Absent unless git refused; the drawer says why rather than showing nothing. */
  error?: string;
}

function lineKind(text: string): DiffLineKind {
  if (text.startsWith('+++') || text.startsWith('---')) return 'meta';
  if (text.startsWith('@@')) return 'meta';
  if (text.startsWith('+')) return 'added';
  if (text.startsWith('-')) return 'removed';
  return 'context';
}

/**
 * Splits a unified diff into per-file line runs. Kept separate from the git
 * call so the shape can be tested without a repository.
 */
export function parseUnifiedDiff(
  patch: string,
  limit = MAX_LINES,
): { files: DiffFile[]; truncated: boolean } {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let emitted = 0;
  let truncated = false;

  for (const raw of patch.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header !== null) {
      const [, , after] = header;
      current = { path: after ?? line, added: 0, removed: 0, lines: [], bodyTruncated: false };
      files.push(current);
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith('index ') || line.startsWith('similarity ') || line.startsWith('rename ')) {
      continue;
    }
    // Counting is what makes the file list honest, and it costs nothing, so it
    // happens whether or not there is room left to keep the line itself.
    const kind = lineKind(line);
    if (kind === 'added') current.added += 1;
    if (kind === 'removed') current.removed += 1;
    if (emitted >= limit || current.lines.length >= MAX_LINES_PER_FILE) {
      current.bodyTruncated = true;
      truncated = true;
      continue;
    }
    current.lines.push({ kind, text: line });
    emitted += 1;
  }

  return { files, truncated };
}

async function resolves(root: string, ref: string): Promise<boolean> {
  // A ref that does not exist makes git exit non-zero, which the promise
  // reports as a rejection. The caller observes that answer as false.
  return execFileAsync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    cwd: root,
  }).then(
    () => true,
    () => false,
  );
}

async function firstResolvable(root: string, refs: string[]): Promise<string | undefined> {
  for (const ref of refs) {
    if (await resolves(root, ref)) return ref;
  }
  return undefined;
}

export interface SpecDiffInput {
  root: string;
  /** Paths the spec's dispatches recorded as changed; empty means diff everything. */
  paths: string[];
  /** The branch the work will land on. Falls back through the usual names. */
  base?: string;
}

interface GitDiffResult {
  patch: string;
  error?: string;
}

async function runDiff(root: string, args: string[]): Promise<GitDiffResult> {
  return execFileAsync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 }).then(
    (done) => ({ patch: done.stdout }),
    (refused: unknown) => {
      const message = refused instanceof Error ? refused.message : String(refused);
      return { patch: '', error: message.split('\n')[0] ?? 'git refused the diff' };
    },
  );
}

/**
 * The diff of a spec against its base branch, including work that is still
 * uncommitted — the board shows dispatches that closed minutes ago, and a
 * review that ignored the working tree would show a person nothing.
 */
export async function specDiff(input: SpecDiffInput): Promise<SpecDiff> {
  const wanted = input.base === undefined || input.base === '' ? undefined : input.base;
  const candidates = wanted === undefined ? ['origin/main', 'main', 'HEAD'] : [wanted];
  const base = await firstResolvable(input.root, candidates);
  if (base === undefined) {
    const named = wanted ?? 'origin/main';
    return {
      base: named,
      files: [],
      truncated: false,
      error: `no ref named "${named}" resolves in this repository`,
    };
  }

  const scope = input.paths.length === 0 ? [] : ['--', ...input.paths];
  const result = await runDiff(input.root, ['diff', '--no-color', '--find-renames', base, ...scope]);
  if (result.error !== undefined) {
    return { base, files: [], truncated: false, error: result.error };
  }
  const parsed = parseUnifiedDiff(result.patch);
  return { base, files: parsed.files, truncated: parsed.truncated };
}
