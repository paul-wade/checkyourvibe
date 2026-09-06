import { describe, expect, it } from 'vitest';

import { parseUnifiedDiff } from '../../src/dashboard/spec-diff.js';

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' const kept = 1;',
  '-const gone = 2;',
  '+const added = 2;',
  '+const alsoAdded = 3;',
  'diff --git a/src/b.ts b/src/b.ts',
  'index 3333333..4444444 100644',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('splits a patch by file and counts what each side changed', () => {
    const parsed = parseUnifiedDiff(PATCH);

    expect(parsed.files.map((file) => file.path)).toEqual(['src/a.ts', 'src/b.ts']);
    const [first, second] = parsed.files;
    expect(first?.added).toBe(2);
    expect(first?.removed).toBe(1);
    expect(second?.added).toBe(1);
    expect(second?.removed).toBe(1);
    expect(parsed.truncated).toBe(false);
  });

  it('does not count the +++ and --- headers as changed lines', () => {
    const [first] = parseUnifiedDiff(PATCH).files;
    const headers = first?.lines.filter((line) => line.text.startsWith('+++') || line.text.startsWith('---'));

    expect(headers?.every((line) => line.kind === 'meta')).toBe(true);
  });

  it('stops emitting lines past the limit and says so', () => {
    const parsed = parseUnifiedDiff(PATCH, 4);

    expect(parsed.truncated).toBe(true);
    const total = parsed.files.reduce((sum, file) => sum + file.lines.length, 0);
    expect(total).toBe(4);
  });

  // Two large files once spent the whole budget between them and the
  // twenty-nine after them rendered "+0 -0", which reads as "unchanged".
  it('counts every file even when the budget ran out before it', () => {
    const parsed = parseUnifiedDiff(PATCH, 4);
    const second = parsed.files.at(1);

    expect(second?.path).toBe('src/b.ts');
    expect(second?.lines).toEqual([]);
    expect(second?.added).toBe(1);
    expect(second?.removed).toBe(1);
    expect(second?.bodyTruncated).toBe(true);
  });

  it('returns no files for a patch with no diff headers', () => {
    expect(parseUnifiedDiff('nothing to see').files).toEqual([]);
  });
});
