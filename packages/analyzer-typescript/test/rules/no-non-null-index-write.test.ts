import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createProject, loadFiles } from '../../src/project.js';
import { noNonNullIndexWrite } from '../../src/rules/no-non-null-index-write.js';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const badPath = resolve(fixturesDir, 'no-non-null-index-write.bad.ts');
const okPath = resolve(fixturesDir, 'no-non-null-index-write.ok.ts');

describe('no-non-null-index-write', () => {
  it('reports unsafe index writes in the bad fixture', () => {
    const { loaded } = loadFiles(createProject(fixturesDir), [badPath]);
    const badFile = loaded[0];
    if (!badFile) {
      throw new Error(`Failed to load ${badPath}`);
    }

    const violations = noNonNullIndexWrite.check(badFile, {});
    const lines = violations.map((violation) => violation.line).sort((a, b) => a - b);

    expect(violations).toHaveLength(3);
    expect(lines).toEqual([5, 6, 7]);
  });

  it('reports no violations in the false-positive guard fixture', () => {
    const { loaded } = loadFiles(createProject(fixturesDir), [okPath]);
    const okFile = loaded[0];
    if (!okFile) {
      throw new Error(`Failed to load ${okPath}`);
    }

    const violations = noNonNullIndexWrite.check(okFile, {});
    expect(violations).toHaveLength(0);
  });
});
