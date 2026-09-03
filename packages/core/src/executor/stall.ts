/**
 * The stall signal: what cyv can honestly measure about a run that went quiet
 * (spec 0036 Requirement 4, Decision 4).
 *
 * A stall is three facts together — open work exists, a lane could take it,
 * and nothing has been dispatched for a while — and it names no cause. An
 * exhausted orchestrator, a closed terminal and a session waiting on a question
 * all look the same from the log, and this module does not pretend to tell
 * them apart. It reports, and it does not re-dispatch (Requirement 4.5).
 *
 * Everything here is pure: the caller supplies the clock, so a test can place
 * `now` wherever it likes and the dashboard can compute against the instant the
 * page was built.
 */
import type { CheckYourVibeConfig } from '../config/types.js';
import type { StallSignal } from '../dashboard/view-model.js';
import { acceptsDispatch } from './lane.js';
import type { DispatchRecord } from './dispatch.js';
import type { LaneRuntime } from './schedule.js';

/**
 * Thirty minutes is a choice about how soon a reader who walked away is told
 * that nothing is happening: long enough that deliberate pacing and one
 * long-running judgment dispatch do not trip it, short enough that a return to
 * the machine finds the report rather than the hour of silence. It is not a
 * reset window (Requirement 4.4).
 */
export const DEFAULT_STALL_INTERVAL_MINUTES = 30;

export interface StallInput {
  runtimes: readonly LaneRuntime[];
  records: readonly DispatchRecord[];
  /** Whether any task remains that could be dispatched. */
  openWorkExists: boolean;
  now: Date;
  intervalMinutes?: number;
}

/**
 * The lanes that could take a dispatch right now: accepting dispatched work,
 * not in cooldown, and below their declared cap. The orchestrating lane counts
 * only when it has opted in (Requirement 4.3; spec 0036 Requirement 1.2).
 */
export function idleLanes(runtimes: readonly LaneRuntime[]): string[] {
  return runtimes
    .filter(
      (runtime) =>
        acceptsDispatch(runtime.lane) &&
        runtime.cooldown === undefined &&
        runtime.inFlight.length < runtime.lane.concurrencyCap,
    )
    .map((runtime) => runtime.lane.id);
}

/** The most recent `openedAt` across the records, or `undefined` when none parses. */
export function lastOpenedAt(records: readonly DispatchRecord[]): string | undefined {
  let latest: { at: string; ms: number } | undefined;
  for (const record of records) {
    const ms = Date.parse(record.openedAt);
    if (!Number.isFinite(ms)) continue;
    if (latest === undefined || ms > latest.ms) latest = { at: record.openedAt, ms };
  }
  return latest?.at;
}

/**
 * The stall, or `undefined` when the run is not stalled. A record opened in the
 * future counts as recent: a clock that disagrees with the log is not evidence
 * that nothing is happening.
 */
export function detectStall(input: StallInput): StallSignal | undefined {
  if (!input.openWorkExists) return undefined;
  const idle = idleLanes(input.runtimes);
  if (idle.length === 0) return undefined;

  const intervalMinutes = input.intervalMinutes ?? DEFAULT_STALL_INTERVAL_MINUTES;
  const last = lastOpenedAt(input.records);
  if (last !== undefined) {
    const sinceLastMs = input.now.getTime() - Date.parse(last);
    if (sinceLastMs < intervalMinutes * 60_000) return undefined;
  }

  return {
    idleLanes: idle,
    ...(last === undefined ? {} : { lastOpenedAt: last }),
    intervalMinutes,
  };
}

/**
 * The configured interval, or the default. A value that is not a positive
 * number falls to the default; the schema already refuses one, and this is
 * the same answer for a config literal built by hand.
 */
export function stallIntervalMinutes(config: CheckYourVibeConfig): number {
  const configured = config.executor?.stallAfterMinutes;
  return configured !== undefined && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_STALL_INTERVAL_MINUTES;
}
