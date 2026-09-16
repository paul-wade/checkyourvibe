/** Narrow unknown JSON into daemon shapes without casts. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

export type ClosedDispatchRow = {
  event: 'closed';
  dispatchId: string;
  closedAt?: string;
  workId?: string;
  outcomeKind?: string;
  outcomeSummary?: string;
  reportStatus?: string;
  laneId?: string;
};

export function parseClosedDispatchLine(text: string): ClosedDispatchRow | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    process.stderr.write(`daemon: skip corrupt dispatches line: ${err instanceof Error ? err.message : String(err)}\n`);
    return undefined;
  }
  if (!isRecord(raw)) return undefined;
  if (raw.event !== 'closed') return undefined;
  const dispatchId = readString(raw, 'dispatchId');
  if (dispatchId === undefined) return undefined;

  const outcome = isRecord(raw.outcome) ? raw.outcome : undefined;
  const report = isRecord(raw.report) ? raw.report : undefined;
  const assignment = isRecord(raw.assignment) ? raw.assignment : undefined;

  const row: ClosedDispatchRow = {
    event: 'closed',
    dispatchId,
  };
  const closedAt = readString(raw, 'closedAt');
  if (closedAt !== undefined) row.closedAt = closedAt;
  const workId = readString(raw, 'workId');
  if (workId !== undefined) row.workId = workId;
  const outcomeKind = outcome !== undefined ? readString(outcome, 'kind') : undefined;
  if (outcomeKind !== undefined) row.outcomeKind = outcomeKind;
  const outcomeSummary = outcome !== undefined ? readString(outcome, 'summary') : undefined;
  if (outcomeSummary !== undefined) row.outcomeSummary = outcomeSummary;
  const reportStatus = report !== undefined ? readString(report, 'status') : undefined;
  if (reportStatus !== undefined) row.reportStatus = reportStatus;
  const laneId = assignment !== undefined ? readString(assignment, 'laneId') : undefined;
  if (laneId !== undefined) row.laneId = laneId;
  return row;
}

export type AppendBody = {
  type: 'dispatch.closed' | 'dispatch.opened';
  dispatchId: string;
  workId?: string;
  laneId?: string;
  cwd?: string;
  outcome?: string;
  summary?: string;
  prUrl?: string;
  projectCwd?: string;
};

export function parseAppendBody(text: string): AppendBody | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (!isRecord(raw)) return { error: 'body must be an object' };
  const type = readString(raw, 'type');
  const dispatchId = readString(raw, 'dispatchId');
  if (type !== 'dispatch.closed' && type !== 'dispatch.opened') {
    return { error: 'type must be dispatch.closed or dispatch.opened' };
  }
  if (dispatchId === undefined) return { error: 'dispatchId required' };

  const body: AppendBody = { type, dispatchId };
  const workId = readString(raw, 'workId');
  if (workId !== undefined) body.workId = workId;
  const laneId = readString(raw, 'laneId');
  if (laneId !== undefined) body.laneId = laneId;
  const cwd = readString(raw, 'cwd');
  if (cwd !== undefined) body.cwd = cwd;
  const outcome = readString(raw, 'outcome');
  if (outcome !== undefined) body.outcome = outcome;
  const summary = readString(raw, 'summary');
  if (summary !== undefined) body.summary = summary;
  const prUrl = readString(raw, 'prUrl');
  if (prUrl !== undefined) body.prUrl = prUrl;
  const projectCwd = readString(raw, 'projectCwd');
  if (projectCwd !== undefined) body.projectCwd = projectCwd;
  return body;
}

export type StoredEvent = {
  eventId: string;
  type: 'dispatch.closed' | 'dispatch.opened';
  dispatchId: string;
  workId?: string;
  laneId?: string;
  cwd?: string;
  outcome?: string;
  summary?: string;
  prUrl?: string;
  at: string;
  projectCwd?: string;
};

export function parseStoredEventLine(text: string): StoredEvent | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    process.stderr.write(`daemon: skip corrupt events line: ${err instanceof Error ? err.message : String(err)}\n`);
    return undefined;
  }
  if (!isRecord(raw)) return undefined;
  const eventId = readString(raw, 'eventId');
  const type = readString(raw, 'type');
  const dispatchId = readString(raw, 'dispatchId');
  const at = readString(raw, 'at');
  if (eventId === undefined || dispatchId === undefined || at === undefined) return undefined;
  if (type !== 'dispatch.closed' && type !== 'dispatch.opened') return undefined;
  const event: StoredEvent = { eventId, type, dispatchId, at };
  const workId = readString(raw, 'workId');
  if (workId !== undefined) event.workId = workId;
  const laneId = readString(raw, 'laneId');
  if (laneId !== undefined) event.laneId = laneId;
  const cwd = readString(raw, 'cwd');
  if (cwd !== undefined) event.cwd = cwd;
  const outcome = readString(raw, 'outcome');
  if (outcome !== undefined) event.outcome = outcome;
  const summary = readString(raw, 'summary');
  if (summary !== undefined) event.summary = summary;
  const prUrl = readString(raw, 'prUrl');
  if (prUrl !== undefined) event.prUrl = prUrl;
  const projectCwd = readString(raw, 'projectCwd');
  if (projectCwd !== undefined) event.projectCwd = projectCwd;
  return event;
}