import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createProject, loadFiles } from '../../src/project.js';
import { noBroadCatchRethrow } from '../../src/rules/no-broad-catch-rethrow.js';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const badPath = resolve(fixturesDir, 'no-broad-catch-rethrow.bad.ts');
const okPath = resolve(fixturesDir, 'no-broad-catch-rethrow.ok.ts');

describe('no-broad-catch-rethrow', () => {
  it('reports catch clauses that immediately rethrow in the bad fixture', () => {
    const { loaded } = loadFiles(createProject(fixturesDir), [badPath]);
    const badFile = loaded[0];
    if (!badFile) {
      throw new Error(`Failed to load ${badPath}`);
    }

    const violations = noBroadCatchRethrow.check(badFile, {});
    const lines = violations.map((violation) => violation.line).sort((a, b) => a - b);

    expect(violations).toHaveLength(2);
    expect(lines).toEqual([4, 12]);
  });

  it('reports no violations in the false-positive guard fixture', () => {
    const { loaded } = loadFiles(createProject(fixturesDir), [okPath]);
    const okFile = loaded[0];
    if (!okFile) {
      throw new Error(`Failed to load ${okPath}`);
    }

    const violations = noBroadCatchRethrow.check(okFile, {});
    expect(violations).toHaveLength(0);
  });
});
