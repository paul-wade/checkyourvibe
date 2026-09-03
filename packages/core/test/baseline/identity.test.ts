import { describe, expect, it } from 'vitest';
import { computeEntries } from '../../src/baseline/identity.js';
import { partitionViolations } from '../../src/baseline/partition.js';
import { FIXTURE_REPO_ROOT, makeViolation } from './fixtures.js';

describe('baseline identity', () => {
  it('survives an unrelated edit above the violation (line moves, snippet does not)', () => {
    const before = makeViolation({ relPath: 'src/thing.ts', line: 10, snippet: 'const x: any = 1;' });
    // An import was added above the violation: same file, same rule, same
    // snippet, but the line number shifted from 10 to 15.
    const after = makeViolation({ relPath: 'src/thing.ts', line: 15, snippet: 'const x: any = 1;' });

    const [beforeEntry] = computeEntries([before], FIXTURE_REPO_ROOT);
    const [afterEntry] = computeEntries([after], FIXTURE_REPO_ROOT);

    expect(beforeEntry).toBeDefined();
    expect(afterEntry).toBeDefined();
    // Identity fields match even though `line` does not.
    expect(afterEntry?.entry.path).toBe(beforeEntry?.entry.path);
    expect(afterEntry?.entry.ruleId).toBe(beforeEntry?.entry.ruleId);
    expect(afterEntry?.entry.fingerprint).toBe(beforeEntry?.entry.fingerprint);
    expect(afterEntry?.entry.occurrence).toBe(beforeEntry?.entry.occurrence);
    expect(afterEntry?.entry.line).toBe(15);
    expect(beforeEntry?.entry.line).toBe(10);

    // partitionViolations recognises the moved violation as the one already
    // in the baseline (Requirement 2.2), not a new one.
    const baseline = {
      header: { version: 1, takenAt: '2026-01-01T00:00:00.000Z', commit: 'abc123' },
      entries: [beforeEntry.entry],
      repoRoot: FIXTURE_REPO_ROOT,
    };
    const result = partitionViolations([after], baseline);
    expect(result.fresh).toEqual([]);
    expect(result.baselined).toEqual([after]);
    expect(result.stale).toEqual([]);
  });

  it('does NOT survive a change to the snippet itself', () => {
    const before = makeViolation({ relPath: 'src/thing.ts', line: 10, snippet: 'const x: any = 1;' });
    const after = makeViolation({ relPath: 'src/thing.ts', line: 10, snippet: 'const x: any = 2;' });

    const [beforeEntry] = computeEntries([before], FIXTURE_REPO_ROOT);
    const [afterEntry] = computeEntries([after], FIXTURE_REPO_ROOT);

    expect(afterEntry?.entry.fingerprint).not.toBe(beforeEntry?.entry.fingerprint);

    const baseline = {
      header: { version: 1, takenAt: '2026-01-01T00:00:00.000Z', commit: 'abc123' },
      entries: [beforeEntry.entry],
      repoRoot: FIXTURE_REPO_ROOT,
    };
    const result = partitionViolations([after], baseline);
    // The rewritten violation reads as new, conservatively, rather than
    // silently inheriting the old entry's "already known about" status.
    expect(result.fresh).toEqual([after]);
    expect(result.baselined).toEqual([]);
    // And the old entry, no longer matched by anything, is stale.
    expect(result.stale).toEqual([beforeEntry.entry]);
  });

  it('distinguishes two identical snippets in one file by occurrence', () => {
    const first = makeViolation({ relPath: 'src/thing.ts', line: 5, snippet: 'const x: any = 1;' });
    const second = makeViolation({ relPath: 'src/thing.ts', line: 20, snippet: 'const x: any = 1;' });

    const entries = computeEntries([first, second], FIXTURE_REPO_ROOT);
    expect(entries).toHaveLength(2);

    const [entryA, entryB] = entries;
    expect(entryA?.entry.fingerprint).toBe(entryB?.entry.fingerprint);
    expect(entryA?.entry.path).toBe(entryB?.entry.path);
    expect(entryA?.entry.ruleId).toBe(entryB?.entry.ruleId);

    // Occurrence disambiguates them, assigned by source order (line 5 before line 20).
    const occurrences = entries.map((e) => e.entry.occurrence).sort();
    expect(occurrences).toEqual([0, 1]);
    expect(entryA?.entry.line).toBe(5);
    expect(entryA?.entry.occurrence).toBe(0);
    expect(entryB?.entry.line).toBe(20);
    expect(entryB?.entry.occurrence).toBe(1);
  });

  it('is stable regardless of input order', () => {
    const first = makeViolation({ relPath: 'src/thing.ts', line: 5, snippet: 'const x: any = 1;' });
    const second = makeViolation({ relPath: 'src/thing.ts', line: 20, snippet: 'const x: any = 1;' });

    const forward = computeEntries([first, second], FIXTURE_REPO_ROOT);
    const backward = computeEntries([second, first], FIXTURE_REPO_ROOT);

    const byLine = (entries: typeof forward): number[] =>
      [...entries].sort((a, b) => a.entry.line - b.entry.line).map((e) => e.entry.occurrence);

    expect(byLine(forward)).toEqual(byLine(backward));
  });
});
