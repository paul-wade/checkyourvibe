import { describe, expect, it } from 'vitest';
import type { BaselineEntry, BaselineHeader } from '../../src/baseline/types.js';
import { parseBaseline, serializeBaseline, sortEntries } from '../../src/baseline/format.js';

function entry(overrides: Partial<BaselineEntry>): BaselineEntry {
  return {
    path: 'src/thing.ts',
    ruleId: 'no-any',
    fingerprint: 'deadbeef',
    occurrence: 0,
    line: 1,
    ...overrides,
  };
}

const HEADER: BaselineHeader = { version: 1, takenAt: '2026-01-01T00:00:00.000Z', commit: 'abc123' };

describe('baseline format', () => {
  it('round-trips header and entries through serialize/parse', () => {
    const entries = [
      entry({ path: 'src/a.ts', ruleId: 'no-any', fingerprint: 'aaa', occurrence: 0, line: 3 }),
      entry({ path: 'src/b.ts', ruleId: 'no-console', fingerprint: 'bbb', occurrence: 0, line: 9 }),
    ];

    const text = serializeBaseline(HEADER, entries);
    const parsed = parseBaseline(text);

    expect(parsed.header).toEqual(HEADER);
    expect(parsed.entries).toEqual(sortEntries(entries));
  });

  it('sorts entries deterministically by path, then rule, then fingerprint, then occurrence', () => {
    const shuffled = [
      entry({ path: 'src/b.ts', ruleId: 'no-any', fingerprint: 'ccc', occurrence: 0 }),
      entry({ path: 'src/a.ts', ruleId: 'no-console', fingerprint: 'bbb', occurrence: 0 }),
      entry({ path: 'src/a.ts', ruleId: 'no-any', fingerprint: 'aaa', occurrence: 1 }),
      entry({ path: 'src/a.ts', ruleId: 'no-any', fingerprint: 'aaa', occurrence: 0 }),
    ];

    const sorted = sortEntries(shuffled);
    expect(sorted.map((e) => [e.path, e.ruleId, e.fingerprint, e.occurrence])).toEqual([
      ['src/a.ts', 'no-any', 'aaa', 0],
      ['src/a.ts', 'no-any', 'aaa', 1],
      ['src/a.ts', 'no-console', 'bbb', 0],
      ['src/b.ts', 'no-any', 'ccc', 0],
    ]);
  });

  it('serializes to byte-identical text regardless of input order (write twice, same result)', () => {
    const entries = [
      entry({ path: 'src/b.ts', ruleId: 'no-any', fingerprint: 'ccc', occurrence: 0 }),
      entry({ path: 'src/a.ts', ruleId: 'no-any', fingerprint: 'aaa', occurrence: 0 }),
    ];
    const reversed = [...entries].reverse();

    const first = serializeBaseline(HEADER, entries);
    const second = serializeBaseline(HEADER, reversed);

    expect(first).toBe(second);
  });

  it('puts one entry per line, so a diff shows exactly what was added or removed', () => {
    const entries = [entry({ path: 'src/a.ts' }), entry({ path: 'src/b.ts' })];
    const text = serializeBaseline(HEADER, entries);
    const entryLines = text.split('\n').filter((line) => line.trim().startsWith('{"path"'));
    expect(entryLines).toHaveLength(2);
  });

  it('rejects malformed baseline text rather than silently dropping entries', () => {
    expect(() => parseBaseline('not json')).toThrow();
    expect(() => parseBaseline(JSON.stringify({ version: 1 }))).toThrow();
    expect(() =>
      parseBaseline(JSON.stringify({ version: 1, takenAt: 'x', commit: 'y', entries: [{ path: 'a' }] })),
    ).toThrow();
  });
});
