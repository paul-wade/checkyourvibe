/**
 * @file packages/core/src/dashboard/gate-health.ts
 * Whether the gate is actually judging the edits it sees.
 *
 * `PreToolUse` fails open on its own errors — a gate that fails closed on a bug
 * of its own is the worst outcome it can produce — and records why in
 * `.cyv-review/decisions.jsonl`. Until this existed nothing read that file, so
 * a gate that had allowed every edit because it could not judge any of them
 * looked exactly like a gate with nothing to complain about.
 */
import type { HookDecisionRecord } from '../cli/hook.js';

/** How far back a recorded failure still describes the gate running now. */
const RECENT_MS = 6 * 60 * 60 * 1000;

export interface GateHealth {
  /** Decisions inside the window. */
  considered: number;
  /** Decisions allowed because the gate could not judge the edit. */
  unjudged: number;
  /** The most recent such reason, as the gate recorded it. */
  latestReason?: string;
  /** When that happened. */
  latestAt?: string;
  /**
   * When the gate last judged any write at all, unjudged or not.
   *
   * This is the difference between an orchestrator that has stopped and one
   * that is working on the repository itself rather than dispatching. Both
   * open no dispatches; only the first is stalled.
   */
  lastWriteAt?: string;
}

/** A decision the gate allowed because it failed rather than because it passed. */
function isUnjudged(decision: HookDecisionRecord): boolean {
  return decision.decision === 'allow' && decision.reason.startsWith('internal error:');
}

/**
 * Summarise the decisions recorded in the last few hours. An older failure
 * describes a configuration that may since have been repaired, so it is left
 * out rather than reported as current.
 */
export function summarizeGate(
  decisions: readonly HookDecisionRecord[],
  now: number,
): GateHealth {
  let considered = 0;
  let unjudged = 0;
  let latest: HookDecisionRecord | undefined;
  let lastWriteAt: string | undefined;

  for (const decision of decisions) {
    const at = Date.parse(decision.at);
    if (!Number.isFinite(at) || now - at > RECENT_MS) continue;
    considered += 1;
    if (lastWriteAt === undefined || decision.at > lastWriteAt) lastWriteAt = decision.at;
    if (!isUnjudged(decision)) continue;
    unjudged += 1;
    if (latest === undefined || decision.at > latest.at) latest = decision;
  }

  return {
    considered,
    unjudged,
    ...(latest === undefined ? {} : { latestReason: latest.reason, latestAt: latest.at }),
    ...(lastWriteAt === undefined ? {} : { lastWriteAt }),
  };
}
