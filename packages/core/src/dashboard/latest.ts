/**
 * The state a developer waiting on a run actually wants: whether a check is
 * running right now, and if it has finished, what it found — the findings
 * themselves, not a count of them.
 *
 * This is deliberately separate from `history.ndjson`. History is an append-only
 * series of totals for charting a trend, it is opt-in behind
 * `--record-history` because it grows without bound, and it stores counts
 * because a trend only needs counts. None of that serves someone who just wants
 * to know what to fix. This file is a single record, overwritten every run, so
 * it costs the same whether you run a check once or ten thousand times — which
 * is why it needs no flag to enable it.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { isUnknownArray } from '../guards.js';
import { HISTORY_DIR } from './history.js';
import type { RunReport } from '../report/types.js';
import type { Violation } from '../protocol/index.js';

const LATEST_FILENAME = 'latest-run.json';

/**
 * Findings are capped so a first run on an unadopted repository writes a
 * bounded file rather than a multi-megabyte one. The total is always exact —
 * `violationCount` is the real number, `violations` is what fits — so a
 * truncated list can say so instead of quietly looking like the whole set.
 */
export const MAX_RECORDED_VIOLATIONS = 500;

export function latestRunPath(repoRoot: string): string {
  return join(repoRoot, HISTORY_DIR, LATEST_FILENAME);
}

/** One finding, flattened to what a reader needs to go and look at it. */
export interface LatestViolation {
  ruleId: string;
  severity: string;
  file: string;
  line: number;
  column: number;
  message: string;
}

/**
 * A check that has started and not yet reported. Written before any analyzer
 * runs so the page can distinguish "working" from "finished and found nothing",
 * which look identical when the only evidence is an absence of findings.
 */
export interface RunningRun {
  status: 'running';
  startedAt: string;
  mode: string;
  /** Absent when the run has not resolved its file list yet. */
  filesChecked?: number;
}

export interface FinishedRun {
  status: 'finished';
  startedAt: string;
  finishedAt: string;
  mode: string;
  commit: string;
  filesChecked: number;
  /** Optional because `RunReport` leaves them optional; never invented when absent. */
  rulesEnabled?: number;
  rulesAvailable?: number;
  violationCount: number;
  /** At most `MAX_RECORDED_VIOLATIONS`; compare with `violationCount` to detect truncation. */
  violations: LatestViolation[];
}

export type LatestRun = RunningRun | FinishedRun;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isUnknownArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseViolation(value: unknown): LatestViolation | undefined {
  if (!isRecord(value)) return undefined;
  const ruleId = asString(value.ruleId);
  const severity = asString(value.severity);
  const file = asString(value.file);
  const message = asString(value.message);
  const line = asNumber(value.line);
  const column = asNumber(value.column);
  if (
    ruleId === undefined ||
    severity === undefined ||
    file === undefined ||
    message === undefined ||
    line === undefined ||
    column === undefined
  ) {
    return undefined;
  }
  return { ruleId, severity, file, line, column, message };
}

/**
 * Parse a stored record, returning `null` for anything that does not fully
 * satisfy one of the two shapes. A half-understood record would render as a
 * page confidently reporting fields it actually guessed.
 */
export function parseLatestRun(value: unknown): LatestRun | null {
  if (!isRecord(value)) return null;

  const startedAt = asString(value.startedAt);
  const mode = asString(value.mode);
  if (startedAt === undefined || mode === undefined) return null;

  if (value.status === 'running') {
    const filesChecked = asNumber(value.filesChecked);
    return filesChecked === undefined
      ? { status: 'running', startedAt, mode }
      : { status: 'running', startedAt, mode, filesChecked };
  }

  if (value.status !== 'finished') return null;

  const finishedAt = asString(value.finishedAt);
  const commit = asString(value.commit);
  const filesChecked = asNumber(value.filesChecked);
  const violationCount = asNumber(value.violationCount);
  if (
    finishedAt === undefined ||
    commit === undefined ||
    filesChecked === undefined ||
    violationCount === undefined ||
    !isUnknownArray(value.violations)
  ) {
    return null;
  }
  const rulesEnabled = asNumber(value.rulesEnabled);
  const rulesAvailable = asNumber(value.rulesAvailable);

  const violations: LatestViolation[] = [];
  for (const entry of value.violations) {
    const parsed = parseViolation(entry);
    if (parsed === undefined) return null;
    violations.push(parsed);
  }

  return {
    status: 'finished',
    startedAt,
    finishedAt,
    mode,
    commit,
    filesChecked,
    violationCount,
    violations,
    ...(rulesEnabled === undefined ? {} : { rulesEnabled }),
    ...(rulesAvailable === undefined ? {} : { rulesAvailable }),
  };
}

/**
 * Write via a temporary file and rename, so a page polling this never reads a
 * half-written record. Rename within a directory is atomic on both platforms
 * this project targets.
 */
async function writeAtomic(target: string, contents: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  await writeFile(temp, contents, 'utf-8');
  await rename(temp, target);
}

export async function writeLatestRun(repoRoot: string, record: LatestRun): Promise<void> {
  await writeAtomic(latestRunPath(repoRoot), `${JSON.stringify(record, null, 2)}\n`);
}

/** Returns `null` when there is no record, or when the record cannot be trusted. */
export async function readLatestRun(repoRoot: string): Promise<LatestRun | null> {
  let raw: string;
  try {
    raw = await readFile(latestRunPath(repoRoot), 'utf-8');
  } catch {
    return null;
  }

  try {
    return parseLatestRun(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Flatten a report's violations into the stored shape, capped and counted. */
export function violationsFor(violations: readonly Violation[]): LatestViolation[] {
  return violations.slice(0, MAX_RECORDED_VIOLATIONS).map((v) => ({
    ruleId: v.ruleId,
    severity: v.severity,
    file: v.file,
    line: v.line,
    column: v.column,
    message: v.message,
  }));
}

export function finishedRunFrom(
  report: RunReport,
  options: { startedAt: string; finishedAt: string; mode: string; commit: string },
): FinishedRun {
  return {
    status: 'finished',
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
    mode: options.mode,
    commit: options.commit,
    filesChecked: report.filesChecked,
    violationCount: report.violations.length,
    violations: violationsFor(report.violations),
    ...(report.rulesEnabled === undefined ? {} : { rulesEnabled: report.rulesEnabled }),
    ...(report.rulesAvailable === undefined ? {} : { rulesAvailable: report.rulesAvailable }),
  };
}
