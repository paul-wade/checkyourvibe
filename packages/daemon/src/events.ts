/**
 * Append-only durable event log. Canonical store for overnight catch-up.
 * Write path: append line, fsync, then callers may fan out to SSE/webhook.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

import { parseStoredEventLine, type StoredEvent } from './parse.js';
import { eventsLogPath } from './paths.js';

export type DaemonEvent = StoredEvent;

function nextEventId(existing: readonly DaemonEvent[]): string {
  let max = 0;
  for (const e of existing) {
    const n = Number.parseInt(e.eventId, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1);
}

export function readAllEvents(logPath = eventsLogPath()): DaemonEvent[] {
  if (!existsSync(logPath)) return [];
  const text = readFileSync(logPath, 'utf8');
  const out: DaemonEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = parseStoredEventLine(line);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

export function eventsAfter(afterId: string | undefined, logPath = eventsLogPath()): DaemonEvent[] {
  const all = readAllEvents(logPath);
  if (afterId === undefined) return all;
  const afterNum = Number.parseInt(afterId, 10);
  if (!Number.isFinite(afterNum)) {
    const idx = all.findIndex((e) => e.eventId === afterId);
    return idx < 0 ? all : all.slice(idx + 1);
  }
  return all.filter((e) => {
    const n = Number.parseInt(e.eventId, 10);
    return Number.isFinite(n) ? n > afterNum : e.eventId > afterId;
  });
}

export function knownDispatchIds(logPath = eventsLogPath()): Set<string> {
  return new Set(readAllEvents(logPath).map((e) => e.dispatchId));
}

/**
 * Append one event with fsync. Idempotent on (dispatchId, type).
 */
export function appendEvent(
  partial: Omit<DaemonEvent, 'eventId' | 'at'> & { at?: string; eventId?: string },
  logPath = eventsLogPath(),
): DaemonEvent {
  mkdirSync(dirname(logPath), { recursive: true });
  const existing = readAllEvents(logPath);
  const found = existing.find((e) => e.dispatchId === partial.dispatchId && e.type === partial.type);
  if (found !== undefined) return found;

  const event: DaemonEvent = {
    ...partial,
    eventId: partial.eventId ?? nextEventId(existing),
    at: partial.at ?? new Date().toISOString(),
  };
  const fd = openSync(logPath, 'a');
  try {
    writeSync(fd, `${JSON.stringify(event)}\n`, null, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return event;
}