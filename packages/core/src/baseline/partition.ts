import type { Violation } from '../protocol/index.js';
import type { Baseline, BaselineEntry } from './types.js';
import { computeEntries, entryKey } from './identity.js';

export interface PartitionResult {
  /** Violations the baseline does not know about — the ones a gate should act on. */
  fresh: Violation[];
  /** Violations the baseline already recorded — deferred, not invisible (Requirement 4.4). */
  baselined: Violation[];
  /** Baseline entries that no longer match anything current — the baseline can shrink (Requirement 2.3). */
  stale: BaselineEntry[];
}

/**
 * Split `violations` into what `baseline` already knows about and what it
 * doesn't, and report which of `baseline`'s entries no longer match anything.
 *
 * A "moved but not changed" violation (Requirement 2.2) is recognised as the
 * same violation because identity never depended on its line in the first
 * place — see `identity.ts`. Occurrence numbers are recomputed from
 * `violations` using that same module's deterministic ordering, so nothing
 * here needs to remember how they were numbered when the baseline was taken.
 */
export function partitionViolations(violations: readonly Violation[], baseline: Baseline): PartitionResult {
  const current = computeEntries(violations, baseline.repoRoot);

  const baselineKeys = new Set(baseline.entries.map((entry) => entryKey(entry)));
  const currentKeys = new Set<string>();

  const fresh: Violation[] = [];
  const baselined: Violation[] = [];

  for (const { violation, entry } of current) {
    const key = entryKey(entry);
    currentKeys.add(key);
    if (baselineKeys.has(key)) {
      baselined.push(violation);
    } else {
      fresh.push(violation);
    }
  }

  const stale = baseline.entries.filter((entry) => !currentKeys.has(entryKey(entry)));

  return { fresh, baselined, stale };
}
