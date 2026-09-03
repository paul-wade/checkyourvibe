import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createProject, loadFiles } from '../../src/project.js';
import { noUselessTypes } from '../../src/rules/no-useless-types.js';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const badPath = resolve(fixturesDir, 'no-useless-types.bad.ts');
const okPath = resolve(fixturesDir, 'no-useless-types.ok.ts');

describe('no-useless-types', () => {
  it('reports all three useless type forms across the bad fixture', () => {
    const { loaded } = loadFiles(createProject(fixturesDir), [badPath]);
    const badFile = loaded[0];
    if (!badFile) {
      throw new Error(`Failed to load ${badPath}`);
    }

    const violations = noUselessTypes.check(badFile, {});
    const lines = violations.map((v) => v.line).sort((a, b) => a - b);

    expect(violations).toHaveLength(7);
    expect(lines).toEqual([1, 5, 7, 9, 14, 15, 16]);
  });

  it('reports no violations in the false-positive guard fixture', () => {
    const { loaded } = loadFiles(createProject(fixturesDir), [okPath]);
    const okFile = loaded[0];
    if (!okFile) {
      throw new Error(`Failed to load ${okPath}`);
    }

    const violations = noUselessTypes.check(okFile, {});
    expect(violations).toHaveLength(0);
  });
});
