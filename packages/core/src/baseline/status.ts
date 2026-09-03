/**
 * Burn-down report for `cyv baseline --status` (Requirement 5).
 *
 * This module is deliberately separate from `cli/baseline.ts`: the report is a
 * value that can be built from any set of inputs and tested without spinning up
 * a git repository, while the CLI module owns the I/O and the `--yes` prompt.
 *
 * Nothing here invents numbers. A status report is just counts and names: no
 * streaks, no scores, no encouragement (Requirement 5.5).
 */
import type { Baseline } from './types.js';
import type { Suppression } from './suppressions.js';
import type { Violation } from '../protocol/index.js';
import { partitionViolations } from './partition.js';
import { evaluateSuppressions } from './suppressions.js';
import { toRepoRelative } from './identity.js';

export interface StatusReport {
  /** ISO 8601 timestamp the baseline was taken. */
  takenAt: string;
  /** Git commit the baseline was taken against. */
  commit: string;
  /** Total entries recorded in the baseline. */
  totalRecorded: number;
  /** Baselined violations that still match the current code. */
  baselinedCount: number;
  /** Remaining count by rule, highest first. */
  byRule: [string, number][];
  /** Remaining count by file, highest first. */
  byFile: [string, number][];
  /** Baseline entries whose rule is still enabled but no longer match anything. */
  staleFixedCount: number;
  /** Baseline entries whose rule is no longer enabled, grouped by rule. */
  deadRuleCounts: [string, number][];
  /** Active suppressions. */
  activeSuppressions: number;
  /** Active suppressions expiring within 30 days of `now`. */
  expiringWithin30Days: number;
  /** Suppressions that have expired as of `now`. */
  expired: Suppression[];
}

function countBy<T>(items: readonly T[], keyFn: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Highest count first; ties broken by key so output is stable across runs. */
function sortedCounts(counts: Map<string, number>): [string, number][] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** File paths in a status report should be repo-relative, like the baseline file. */
function repoRelativeFile(file: string, repoRoot: string): string {
  return toRepoRelative(file, repoRoot) ?? file;
}

/**
 * Build a `StatusReport` from the current run, the baseline, the enabled rule
 * set, and the configured suppressions.
 *
 * `now` is injectable so tests can assert on expiry boundaries without
 * depending on the calendar of the machine running the test.
 */
export function buildStatusReport(
  baseline: Baseline,
  violations: readonly Violation[],
  enabled: Set<string>,
  suppressions: readonly Suppression[],
  repoRoot: string,
  now: Date = new Date(),
): StatusReport {
  const { baselined, stale } = partitionViolations(violations, baseline);
  const staleFixed = stale.filter((entry) => enabled.has(entry.ruleId));
  const deadEntries = stale.filter((entry) => !enabled.has(entry.ruleId));
  const suppressionResult = evaluateSuppressions(violations, suppressions, repoRoot, now);

  return {
    takenAt: baseline.header.takenAt,
    commit: baseline.header.commit,
    totalRecorded: baseline.entries.length,
    baselinedCount: baselined.length,
    byRule: sortedCounts(countBy(baselined, (v) => v.ruleId)),
    byFile: sortedCounts(countBy(baselined, (v) => repoRelativeFile(v.file, repoRoot))),
    staleFixedCount: staleFixed.length,
    deadRuleCounts: sortedCounts(countBy(deadEntries, (entry) => entry.ruleId)),
    activeSuppressions: suppressionResult.activeCount,
    expiringWithin30Days: suppressionResult.expiringWithin30DaysCount,
    expired: suppressionResult.expired,
  };
}

function formatCountLine(key: string, count: number): string {
  return `  ${count.toString().padStart(5)}  ${key}`;
}

/** Render a `StatusReport` to the lines `cyv baseline --status` prints. */
export function formatStatusReport(report: StatusReport): string[] {
  const lines: string[] = [];
  lines.push(`Baseline taken ${report.takenAt} against commit ${report.commit}.`);
  lines.push(
    `${report.baselinedCount} baselined violation(s) remain, out of ${report.totalRecorded} recorded.`,
  );

  lines.push('');
  lines.push('By rule:');
  lines.push(...report.byRule.map(([ruleId, count]) => formatCountLine(ruleId, count)));

  lines.push('');
  lines.push('By file (worst first):');
  lines.push(...report.byFile.map(([file, count]) => formatCountLine(file, count)));

  if (report.staleFixedCount > 0) {
    lines.push('');
    lines.push(
      `${report.staleFixedCount} baselined entries no longer match anything and can be dropped ` +
        '(the underlying violation appears to be fixed) — run `cyv baseline` to shrink the baseline.',
    );
  }

  if (report.deadRuleCounts.length > 0) {
    lines.push('');
    const totalDead = report.deadRuleCounts.reduce((sum, [, count]) => sum + count, 0);
    lines.push(
      `${totalDead} baselined entries reference a rule that is no longer enabled (dead entries):`,
    );
    lines.push(...report.deadRuleCounts.map(([ruleId, count]) => formatCountLine(ruleId, count)));
  }

  lines.push('');
  lines.push(
    `${report.activeSuppressions} active suppression(s), ` +
      `${report.expiringWithin30Days} expiring within 30 days.`,
  );

  if (report.expired.length > 0) {
    lines.push(`${report.expired.length} suppression(s) have EXPIRED and no longer suppress anything:`);
    for (const suppression of report.expired) {
      lines.push(
        `  ${suppression.ruleId} on "${suppression.target}" expired ${suppression.expires} — ${suppression.reason}`,
      );
    }
  }

  return lines;
}

/**
 * The output of `cyv baseline --status`: `formatStatusReport`'s lines joined
 * into one string. The CLI logs it; tests can call this directly.
 */
export function renderStatus(report: StatusReport): string {
  return formatStatusReport(report).join('\n');
}
