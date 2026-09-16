/**
 * Poll watched projects' dispatches.ndjson and emit durable events for new rows.
 */
import { existsSync, readFileSync, statSync, type Stats } from 'node:fs';
import { join } from 'node:path';

import { appendEvent, type DaemonEvent } from './events.js';
import { parseClosedDispatchLine, isRecord, readString } from './parse.js';

export type WatchEmit = (event: DaemonEvent) => void;

interface WatchState {
  size: number;
  seen: Set<string>;
}

function openedKey(dispatchId: string): string {
  return `opened:${dispatchId}`;
}
function closedKey(dispatchId: string): string {
  return `closed:${dispatchId}`;
}

function parseOpenedLine(text: string): { dispatchId: string; workId?: string; laneId?: string; at?: string } | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    process.stderr.write(
      `daemon: skip corrupt opened line: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return undefined;
  }
  if (!isRecord(raw) || raw.event !== 'opened') return undefined;
  const dispatchId = readString(raw, 'dispatchId');
  if (dispatchId === undefined) return undefined;
  const workId = readString(raw, 'workId');
  const assignment = isRecord(raw.assignment) ? raw.assignment : undefined;
  const laneId = assignment !== undefined ? readString(assignment, 'laneId') : undefined;
  const at = readString(raw, 'openedAt');
  const out: { dispatchId: string; workId?: string; laneId?: string; at?: string } = { dispatchId };
  if (workId !== undefined) out.workId = workId;
  if (laneId !== undefined) out.laneId = laneId;
  if (at !== undefined) out.at = at;
  return out;
}

export function startDispatchWatchers(
  projectCwds: readonly string[],
  onEvent: WatchEmit,
  intervalMs = 1000,
): { stop: () => void } {
  const state = new Map<string, WatchState>();

  const tick = (): void => {
    for (const cwd of projectCwds) {
      const logPath = join(cwd, '.cyv-review', 'dispatches.ndjson');
      if (!existsSync(logPath)) continue;
      let st: Stats;
      try {
        st = statSync(logPath);
      } catch (err) {
        process.stderr.write(
          `daemon: stat failed for ${logPath}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        continue;
      }
      let cur = state.get(cwd);
      if (cur === undefined) {
        cur = { size: 0, seen: new Set() };
        state.set(cwd, cur);
        // Seed seen from existing file so we only emit *new* lines after start
        // (startup backfill already covered history).
        const text = readFileSync(logPath, 'utf8');
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          const closed = parseClosedDispatchLine(line);
          if (closed !== undefined) cur.seen.add(closedKey(closed.dispatchId));
          const opened = parseOpenedLine(line);
          if (opened !== undefined) cur.seen.add(openedKey(opened.dispatchId));
        }
        cur.size = st.size;
        continue;
      }
      if (st.size === cur.size) continue;
      // Truncation / rotation: rescan
      if (st.size < cur.size) {
        cur.seen.clear();
        cur.size = 0;
      }
      const text = readFileSync(logPath, 'utf8');
      cur.size = st.size;
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const opened = parseOpenedLine(line);
        if (opened !== undefined && !cur.seen.has(openedKey(opened.dispatchId))) {
          cur.seen.add(openedKey(opened.dispatchId));
          const payload: Parameters<typeof appendEvent>[0] = {
            type: 'dispatch.opened',
            dispatchId: opened.dispatchId,
            projectCwd: cwd,
            cwd,
          };
          if (opened.workId !== undefined) payload.workId = opened.workId;
          if (opened.laneId !== undefined) payload.laneId = opened.laneId;
          if (opened.at !== undefined) payload.at = opened.at;
          onEvent(appendEvent(payload));
        }
        const closed = parseClosedDispatchLine(line);
        if (closed !== undefined && !cur.seen.has(closedKey(closed.dispatchId))) {
          cur.seen.add(closedKey(closed.dispatchId));
          const outcome = closed.outcomeKind ?? closed.reportStatus;
          const payload: Parameters<typeof appendEvent>[0] = {
            type: 'dispatch.closed',
            dispatchId: closed.dispatchId,
            projectCwd: cwd,
            cwd,
          };
          if (closed.workId !== undefined) payload.workId = closed.workId;
          if (closed.laneId !== undefined) payload.laneId = closed.laneId;
          if (outcome !== undefined) payload.outcome = outcome;
          if (closed.outcomeSummary !== undefined) payload.summary = closed.outcomeSummary;
          if (closed.closedAt !== undefined) payload.at = closed.closedAt;
          onEvent(appendEvent(payload));
        }
      }
    }
  };

  const handle = setInterval(tick, intervalMs);
  // first tick after a beat so backfill finishes first at startup
  setTimeout(tick, 50);

  return {
    stop: () => {
      clearInterval(handle);
    },
  };
}