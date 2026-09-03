import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createProject, loadFiles } from '../../src/project.js';
import { noFloatingPromise } from '../../src/rules/no-floating-promise.js';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const badPath = resolve(fixturesDir, 'no-floating-promise.bad.ts');
const okPath = resolve(fixturesDir, 'no-floating-promise.ok.ts');

describe('no-floating-promise', () => {
  it('reports unhandled promises in the bad fixture', () => {
    const { loaded } = loadFiles(createProject(fixturesDir), [badPath]);
    const badFile = loaded[0];
    if (!badFile) {
      throw new Error(`Failed to load ${badPath}`);
    }

    const violations = noFloatingPromise.check(badFile, {});
    const lines = violations.map((violation) => violation.line).sort((a, b) => a - b);

    expect(violations).toHaveLength(5);
    expect(lines).toEqual([7, 8, 9, 10, 11]);
  });

  it('reports no violations in the false-positive guard fixture', () => {
    const { loaded } = loadFiles(createProject(fixturesDir), [okPath]);
    const okFile = loaded[0];
    if (!okFile) {
      throw new Error(`Failed to load ${okPath}`);
    }

    const violations = noFloatingPromise.check(okFile, {});
    expect(violations).toHaveLength(0);
  });
});
