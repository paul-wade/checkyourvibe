import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createProject, loadFiles } from '../../src/project.js';
import { noJsonParseCast } from '../../src/rules/no-json-parse-cast.js';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const badPath = resolve(fixturesDir, 'no-json-parse-cast.bad.ts');
const okPath = resolve(fixturesDir, 'no-json-parse-cast.ok.ts');
const recursivePath = resolve(fixturesDir, 'no-json-parse-cast.recursive.ts');

describe('no-json-parse-cast', () => {
  it('reports all five claim forms in the bad fixture', () => {
    const { loaded } = loadFiles(createProject(fixturesDir), [badPath]);
    const badFile = loaded[0];
    if (!badFile) {
      throw new Error(`Failed to load ${badPath}`);
    }

    const violations = noJsonParseCast.check(badFile, {});
    const lines = violations.map((violation) => violation.line).sort((a, b) => a - b);

    expect(violations).toHaveLength(5);
    expect(lines).toEqual([6, 7, 8, 9, 10]);
  });

  it('reports no violations in the false-positive guard fixture', () => {
    const { loaded } = loadFiles(createProject(fixturesDir), [okPath]);
    const okFile = loaded[0];
    if (!okFile) {
      throw new Error(`Failed to load ${okPath}`);
    }

    const violations = noJsonParseCast.check(okFile, {});
    expect(violations).toHaveLength(0);
  });

  // A type that reaches itself used to recurse until the stack overflowed. The
  // analyzer catches that throw and marks the rule failed for the file, which
  // does not fail the run — so the file went unchecked while the summary still
  // reported a clean pass. What matters here is that the check returns at all.
  it('terminates on a self-referential type', () => {
    const { loaded } = loadFiles(createProject(fixturesDir), [recursivePath]);
    const recursiveFile = loaded[0];
    if (!recursiveFile) {
      throw new Error(`Failed to load ${recursivePath}`);
    }

    expect(() => noJsonParseCast.check(recursiveFile, {})).not.toThrow();
  });
});
