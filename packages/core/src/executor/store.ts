/**
 * The dispatch store: an append-only log of dispatch entries (spec 0011
 * Requirements 4.5, 6.4, 6.5).
 *
 * It lives beside `history.ndjson` and `latest-run.json` under `.cyv-review/`
 * and follows `dashboard/history.ts`: one JSON object per line, appended with a
 * single `appendFile` call so a whole line lands atomically against another
 * writer's `O_APPEND` write, and a line that will not parse is skipped rather
 * than taking the whole log down.
 *
 * A dispatch writes two entries — `opened` when it is scheduled, `closed` when
 * it finishes. The in-flight state is therefore on disk while the dispatch is
 * running, which is what lets a second orchestrating session read the full
 * state of in-flight and completed dispatches with the first session gone
 * (Requirement 6.4).
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { HISTORY_DIR } from '../dashboard/history.js';
import { parseDispatchEntry } from './parse.js';
import { thisProcessIdentity } from './liveness.js';
import {
  DISPATCH_SCHEMA_VERSION,
  type DispatchAcknowledged,
  type DispatchAssignment,
  type DispatchClosed,
  type DispatchDeclaration,
  type DispatchEntry,
  type DispatchOpened,
  type DispatchRecord,
  type DispatchRefused,
  type Escalation,
  type OrchestratorReported,
  type OrchestratorState,
  type SchedulingRefusal,
} from './dispatch.js';
import type { DispatchOutcome, ExecutorReport, GateResult } from './outcome.js';

const DISPATCH_FILENAME = 'dispatches.ndjson';

export function dispatchLogPath(repoRoot: string): string {
  return join(repoRoot, HISTORY_DIR, DISPATCH_FILENAME);
}

function hasErrorCode(value: unknown): value is { code: unknown } {
  return typeof value === 'object' && value !== null && 'code' in value;
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && hasErrorCode(err) && err.code === 'ENOENT';
}

/** Append one entry as a single line. */
export async function appendDispatchEntry(
  repoRoot: string,
  entry: DispatchEntry,
): Promise<void> {
  const target = dispatchLogPath(repoRoot);
  await mkdir(dirname(target), { recursive: true });
  await appendFile(target, `${JSON.stringify(entry)}\n`, 'utf-8');
}

export interface OpenDispatchInput {
  dispatchId: string;
  workId: string;
  attempt: number;
  openedAt: string;
  declaration: DispatchDeclaration;
  assignment: DispatchAssignment;
  escalation?: Escalation;
}

/** Build and append the `opened` entry for a scheduled dispatch. */
export async function openDispatch(
  repoRoot: string,
  input: OpenDispatchInput,
): Promise<DispatchOpened> {
  const { host, pid, processStartedAt } = thisProcessIdentity();
  const entry: DispatchOpened = {
    event: 'opened',
    schemaVersion: DISPATCH_SCHEMA_VERSION,
    dispatchId: input.dispatchId,
    workId: input.workId,
    attempt: input.attempt,
    openedAt: input.openedAt,
    declaration: input.declaration,
    assignment: input.assignment,
    ...(input.escalation === undefined ? {} : { escalation: input.escalation }),
    ...(host === undefined ? {} : { host }),
    ...(pid === undefined ? {} : { pid }),
    ...(processStartedAt === undefined ? {} : { processStartedAt }),
  };
  await appendDispatchEntry(repoRoot, entry);
  return entry;
}

export interface CloseDispatchInput {
  dispatchId: string;
  closedAt: string;
  report: ExecutorReport;
  gateResults: readonly GateResult[];
  outcome: DispatchOutcome;
}

/** Build and append the `closed` entry for a finished dispatch. */
export async function closeDispatch(
  repoRoot: string,
  input: CloseDispatchInput,
): Promise<DispatchClosed> {
  const entry: DispatchClosed = {
    event: 'closed',
    schemaVersion: DISPATCH_SCHEMA_VERSION,
    dispatchId: input.dispatchId,
    closedAt: input.closedAt,
    report: input.report,
    gateResults: input.gateResults,
    outcome: input.outcome,
  };
  await appendDispatchEntry(repoRoot, entry);
  return entry;
}

export interface RefuseDispatchInput {
  dispatchId: string;
  workId: string;
  refusedAt: string;
  declaration: DispatchDeclaration;
  refusal: SchedulingRefusal;
}

/**
 * Record a dispatch the core declined to schedule. Requirement 4.3 requires the
 * refusal to be reported rather than dropped, and Requirement 3.6 requires the
 * same of a dispatch left with nowhere to run.
 */
export async function refuseDispatch(
  repoRoot: string,
  input: RefuseDispatchInput,
): Promise<DispatchRefused> {
  const entry: DispatchRefused = {
    event: 'refused',
    schemaVersion: DISPATCH_SCHEMA_VERSION,
    dispatchId: input.dispatchId,
    workId: input.workId,
    refusedAt: input.refusedAt,
    declaration: input.declaration,
    refusal: input.refusal,
  };
  await appendDispatchEntry(repoRoot, entry);
  return entry;
}

export interface RecordOrchestratorStateInput {
  state: OrchestratorState;
  reason?: string;
  model?: string;
  reportedAt: string;
}

/**
 * Append the orchestrating session's account of itself (spec 0036 Requirement
 * 3.1). It goes into the dispatch log rather than a file beside it because the
 * log is already the thing a later session reads from disk alone (Decision 3).
 * Host and pid are this process's, so a reader can tell which session spoke.
 */
export async function recordOrchestratorState(
  repoRoot: string,
  input: RecordOrchestratorStateInput,
): Promise<OrchestratorReported> {
  const { host, pid } = thisProcessIdentity();
  const entry: OrchestratorReported = {
    event: 'orchestrator',
    schemaVersion: DISPATCH_SCHEMA_VERSION,
    reportedAt: input.reportedAt,
    state: input.state,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(host === undefined ? {} : { host }),
    ...(pid === undefined ? {} : { pid }),
  };
  await appendDispatchEntry(repoRoot, entry);
  return entry;
}

export interface AcknowledgeItemInput {
  itemId: string;
  acknowledgedAt: string;
  note?: string;
}

/** Record that a person saw a needs-you item and it needs nothing more. */
export async function acknowledgeItem(
  repoRoot: string,
  input: AcknowledgeItemInput,
): Promise<DispatchAcknowledged> {
  const entry: DispatchAcknowledged = {
    event: 'acknowledged',
    schemaVersion: DISPATCH_SCHEMA_VERSION,
    itemId: input.itemId,
    acknowledgedAt: input.acknowledgedAt,
    ...(input.note === undefined ? {} : { note: input.note }),
  };
  await appendDispatchEntry(repoRoot, entry);
  return entry;
}

export interface ReadDispatchStats {
  /** Lines in the log that were not valid dispatch entries. */
  unparseableLines: number;
}

/**
 * Read every valid entry, oldest first. Returns `[]` when no log exists.
 */
export async function readDispatchEntries(
  repoRoot: string,
  stats?: ReadDispatchStats,
): Promise<DispatchEntry[]> {
  let raw: string;
  try {
    raw = await readFile(dispatchLogPath(repoRoot), 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }

  const entries: DispatchEntry[] = [];
  let unparseableLines = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      unparseableLines += 1;
      continue;
    }

    const maybe = parseDispatchEntry(parsed);
    if (maybe === undefined) {
      unparseableLines += 1;
      continue;
    }
    entries.push(maybe);
  }

  if (stats !== undefined) {
    stats.unparseableLines = unparseableLines;
  }
  return entries;
}

/** Records and refusals, folded from a log's entries. */
export interface DispatchLog {
  /** Opened dispatches, oldest first, each with its close entry when it has one. */
  records: DispatchRecord[];
  /** Dispatches the core declined to schedule, oldest first. */
  refusals: DispatchRefused[];
  /**
   * The orchestrating session's most recent self-report, in log order. Absent
   * when no session has reported, which every reader shows as unknown rather
   * than as either healthy or exhausted (spec 0036 Requirement 3.4).
   */
  orchestrator?: OrchestratorReported;
  /** Needs-you item ids a person has acknowledged, so they leave the list. */
  acknowledged: string[];
}

/**
 * Fold entries into records. A `closed` entry with no matching `opened` entry
 * is dropped: there is no declaration or assignment to attach it to, and the
 * fields a record needs cannot be recovered from the close alone.
 */
export function foldDispatchEntries(entries: readonly DispatchEntry[]): DispatchLog {
  const records: DispatchRecord[] = [];
  const refusals: DispatchRefused[] = [];
  const byId = new Map<string, DispatchRecord>();
  let orchestrator: OrchestratorReported | undefined;
  const acknowledged = new Set<string>();

  for (const entry of entries) {
    if (entry.event === 'orchestrator') {
      orchestrator = entry;
      continue;
    }
    if (entry.event === 'acknowledged') {
      acknowledged.add(entry.itemId);
      continue;
    }
    if (entry.event === 'refused') {
      refusals.push(entry);
      continue;
    }
    if (entry.event === 'opened') {
      const record: DispatchRecord = {
        dispatchId: entry.dispatchId,
        workId: entry.workId,
        attempt: entry.attempt,
        openedAt: entry.openedAt,
        declaration: entry.declaration,
        assignment: entry.assignment,
        ...(entry.escalation === undefined ? {} : { escalation: entry.escalation }),
        ...(entry.host === undefined ? {} : { host: entry.host }),
        ...(entry.pid === undefined ? {} : { pid: entry.pid }),
        ...(entry.processStartedAt === undefined ? {} : { processStartedAt: entry.processStartedAt }),
      };
      records.push(record);
      byId.set(entry.dispatchId, record);
      continue;
    }
    const open = byId.get(entry.dispatchId);
    if (open === undefined) continue;
    open.closed = {
      closedAt: entry.closedAt,
      report: entry.report,
      gateResults: entry.gateResults,
      outcome: entry.outcome,
    };
  }

  return {
    records,
    refusals,
    acknowledged: [...acknowledged],
    ...(orchestrator === undefined ? {} : { orchestrator }),
  };
}

/** Read the log and fold it in one call. */
export async function readDispatchLog(
  repoRoot: string,
  stats?: ReadDispatchStats,
): Promise<DispatchLog> {
  return foldDispatchEntries(await readDispatchEntries(repoRoot, stats));
}
