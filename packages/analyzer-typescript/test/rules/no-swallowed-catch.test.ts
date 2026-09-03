import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createProject, loadFiles } from '../../src/project.js';
import { noEmptyCatch } from '../../src/rules/no-swallowed-catch.js';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const badPath = resolve(fixturesDir, 'no-swallowed-catch.bad.ts');
const okPath = resolve(fixturesDir, 'no-swallowed-catch.ok.ts');

describe('no-swallowed-catch', () => {
  it('reports the swallowed catch blocks and promise rejection handlers in the bad fixture', () => {
    const { loaded } = loadFiles(createProject(fixturesDir), [badPath]);
    const badFile = loaded[0];
    if (!badFile) {
      throw new Error(`Failed to load ${badPath}`);
    }

    const violations = noEmptyCatch.check(badFile, {});
    const lines = violations.map((violation) => violation.line).sort((a, b) => a - b);

    expect(violations).toHaveLength(15);
    expect(lines).toEqual([12, 18, 26, 35, 45, 54, 63, 64, 65, 66, 67, 68, 69, 70, 71]);
  });

  it('reports no violations in the false-positive guard fixture', () => {
    const { loaded } = loadFiles(createProject(fixturesDir), [okPath]);
    const okFile = loaded[0];
    if (!okFile) {
      throw new Error(`Failed to load ${okPath}`);
    }

    const violations = noEmptyCatch.check(okFile, {});
    expect(violations).toHaveLength(0);
  });
});
