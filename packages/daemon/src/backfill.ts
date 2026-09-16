/**
 * On daemon start: backfill closed dispatches missing from events.ndjson.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { appendEvent, knownDispatchIds } from './events.js';
import { parseClosedDispatchLine } from './parse.js';

/** Returns how many new closed events were appended. */
export function backfillFromDispatches(projectCwd: string): number {
  const logPath = join(projectCwd, '.cyv-review', 'dispatches.ndjson');
  if (!existsSync(logPath)) return 0;
  const known = knownDispatchIds();
  const text = readFileSync(logPath, 'utf8');
  let added = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = parseClosedDispatchLine(line);
    if (row === undefined) continue;
    if (known.has(row.dispatchId)) continue;

    const outcome = row.outcomeKind ?? row.reportStatus;
    const payload: Parameters<typeof appendEvent>[0] = {
      type: 'dispatch.closed',
      dispatchId: row.dispatchId,
      projectCwd,
      cwd: projectCwd,
    };
    if (row.workId !== undefined) payload.workId = row.workId;
    if (row.laneId !== undefined) payload.laneId = row.laneId;
    if (outcome !== undefined) payload.outcome = outcome;
    if (row.outcomeSummary !== undefined) payload.summary = row.outcomeSummary;
    if (row.closedAt !== undefined) payload.at = row.closedAt;

    appendEvent(payload);
    known.add(row.dispatchId);
    added += 1;
  }
  return added;
}