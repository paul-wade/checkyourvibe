import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createProject, loadFiles } from '../../src/project.js';
import { noAsCast } from '../../src/rules/no-as-cast.js';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const badPath = resolve(fixturesDir, 'no-as-cast.bad.ts');
const okPath = resolve(fixturesDir, 'no-as-cast.ok.ts');

describe('no-as-cast', () => {
  it('reports the three cast forms in the bad fixture', () => {
    const { loaded } = loadFiles(createProject(fixturesDir), [badPath]);
    const badFile = loaded[0];
    if (!badFile) {
      throw new Error(`Failed to load ${badPath}`);
    }

    const violations = noAsCast.check(badFile, {});
    const lines = violations.map((v) => v.line).sort((a, b) => a - b);

    expect(violations).toHaveLength(3);
    expect(lines).toEqual([2, 3, 4]);

    const double = violations.find((v) => v.line === 4);
    if (!double) {
      throw new Error('Expected a violation on the double-cast line');
    }
    expect(double.severity).toBe('error');
    expect(double.message).toMatch(/double/i);
  });

  it('reports no violations in the ok fixture', () => {
    const { loaded } = loadFiles(createProject(fixturesDir), [okPath]);
    const okFile = loaded[0];
    if (!okFile) {
      throw new Error(`Failed to load ${okPath}`);
    }

    const violations = noAsCast.check(okFile, {});
    expect(violations).toHaveLength(0);
  });
});
