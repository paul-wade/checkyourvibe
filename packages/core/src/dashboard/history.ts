/**
 * Run history: an opt-in, append-only record of `cyv check` results.
 *
 * `cyv check --record-history` (the flag is parsed in `cli/check.ts`, which
 * calls `appendRun` below) appends one line per run so the dashboard
 * can draw a trend and tell a rule that produced no finding apart from a rule
 * that was never enabled to fire in the first place (Requirements 4, 5).
 *
 * The file lives under `.cyv-review/`, which the repo root `.gitignore`
 * already excludes: a local project's finding history is a hazard to commit,
 * not a convenience — it would diverge on every run and on every machine.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { isUnknownArray } from '../guards.js';
import { toRepoRelative } from '../baseline/index.js';
import type { RunReport } from '../report/types.js';

const execFileAsync = promisify(execFile);

export const HISTORY_DIR = '.cyv-review';
const HISTORY_FILENAME = 'history.ndjson';

export function historyPath(repoRoot: string): string {
  return join(repoRoot, HISTORY_DIR, HISTORY_FILENAME);
}

/** One recorded `cyv check` run. */
export interface RunRecord {
  /** ISO 8601. */
  timestamp: string;
  /** `git rev-parse HEAD`, or a placeholder when the repository has no commit yet. */
  commit: string;
  totalViolations: number;
  /** Finding count keyed by rule id. A rule absent from this map produced zero findings in this run. */
  ruleCounts: Record<string, number>;
  filesChecked: number;
  /** Optional per-file finding count, added after `ruleCounts` (docs/ROADMAP.md, "0031 — The dashboard as something you would leave open"). */
  fileCounts?: Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isUnknownArray(value);
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'number');
}

function isRunRecord(value: unknown): value is RunRecord {
  if (!isRecord(value)) return false;
  if (value.fileCounts !== undefined && !isNumberRecord(value.fileCounts)) {
    return false;
  }
  return (
    typeof value.timestamp === 'string' &&
    typeof value.commit === 'string' &&
    typeof value.totalViolations === 'number' &&
    typeof value.filesChecked === 'number' &&
    isNumberRecord(value.ruleCounts)
  );
}

function hasErrorCode(value: unknown): value is { code: unknown } {
  return typeof value === 'object' && value !== null && 'code' in value;
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && hasErrorCode(err) && err.code === 'ENOENT';
}

/**
 * Build the record for a completed check run. Exported so tests can construct
 * fixtures without a real git repo.
 *
 * `repoRoot` relativizes each violation's (always absolute, per
 * `protocol/violation.ts`) file path the same way baseline identity does
 * (`baseline/identity.ts`'s `toRepoRelative`), so `fileCounts` is keyed
 * consistently with the baseline's own by-file breakdown. A violation whose
 * file falls outside `repoRoot` is left out of `fileCounts` exactly as
 * `identity.ts`'s `identify()` leaves it out of baseline entries — it cannot
 * happen for a violation reached through normal file selection and routing,
 * so this mirrors an existing precedent rather than inventing a new one.
 */
export function buildRunRecord(
  report: RunReport,
  repoRoot: string,
  commit: string,
  now: Date = new Date(),
): RunRecord {
  const ruleCounts: Record<string, number> = {};
  const fileCounts: Record<string, number> = {};
  for (const violation of report.violations) {
    ruleCounts[violation.ruleId] = (ruleCounts[violation.ruleId] ?? 0) + 1;
    const relPath = toRepoRelative(violation.file, repoRoot);
    if (relPath !== undefined) {
      fileCounts[relPath] = (fileCounts[relPath] ?? 0) + 1;
    }
  }
  return {
    timestamp: now.toISOString(),
    commit,
    totalViolations: report.violations.length,
    ruleCounts,
    fileCounts,
    filesChecked: report.filesChecked,
  };
}

/**
 * Append one run record.
 *
 * A single `appendFile` call, given the complete line (record plus its
 * trailing newline) as one string, becomes one `write()` syscall against a
 * file opened with `O_APPEND`. POSIX guarantees that write lands atomically
 * relative to any other process's `O_APPEND` write of similar size, so two
 * `cyv check --record-history` runs racing each other still each land as one
 * whole line — never interleaved, never a torn record — with no lock file
 * and no read-modify-write cycle that a second writer could step on.
 */
export async function appendRunRecord(repoRoot: string, record: RunRecord): Promise<void> {
  const target = historyPath(repoRoot);
  await mkdir(dirname(target), { recursive: true });
  await appendFile(target, `${JSON.stringify(record)}\n`, 'utf-8');
}

/** Build and append a run record in one call — the API `cyv check --record-history` needs. */
export async function appendRun(
  repoRoot: string,
  report: RunReport,
  commit: string,
  now: Date = new Date(),
): Promise<RunRecord> {
  const record = buildRunRecord(report, repoRoot, commit, now);
  await appendRunRecord(repoRoot, record);
  return record;
}

/** `git rev-parse HEAD`, or a placeholder in a repository with no commits yet. */
export async function resolveCommit(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
    return stdout.trim();
  } catch {
    return '(uncommitted)';
  }
}

/**
 * Optional statistics returned alongside the parsed run records.
 */
export interface ReadHistoryStats {
  /** How many lines in the history file were not valid run records. */
  unparseableLines: number;
}

/**
 * Read every valid run record, oldest first.
 *
 * Returns `[]` when no history file exists — a repository that has never run
 * `cyv check --record-history` — rather than throwing; callers treat that
 * identically to "fewer than two runs" and say so plainly instead of drawing
 * a chart (Requirement 4.5) or claiming a rule has "never fired" when there is
 * simply no data yet (Requirement 5).
 *
 * A line that fails to parse, or parses to the wrong shape, is skipped rather
 * than aborting the whole read. Every append is a single atomic write (see
 * `appendRunRecord`), so a damaged line should not occur in practice — but a
 * read-only history view has no business going dark over one bad line when
 * every run recorded before and after it is still perfectly readable.
 *
 * The optional `stats` argument lets callers learn how many lines were skipped
 * because they could not be parsed. A torn write, a manual edit, or a bug in a
 * writer that does not use `appendRunRecord` can all produce unparseable lines;
 * hiding that count makes the trend chart look complete when it is not.
 */
export async function readHistory(
  repoRoot: string,
  stats?: ReadHistoryStats,
): Promise<RunRecord[]> {
  let raw: string;
  try {
    raw = await readFile(historyPath(repoRoot), 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }

  const records: RunRecord[] = [];
  let unparseableLines = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      unparseableLines += 1;
      console.error(`Skipping malformed history line: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (isRunRecord(parsed)) {
      records.push(parsed);
    } else {
      unparseableLines += 1;
    }
  }

  if (stats !== undefined) {
    stats.unparseableLines = unparseableLines;
  }

  return records;
}
