import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createProject, loadFiles } from '../../src/project.js';
import { noTsComment } from '../../src/rules/no-ts-comment.js';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const badPath = resolve(fixturesDir, 'no-ts-comment.bad.ts');
const okPath = resolve(fixturesDir, 'no-ts-comment.ok.ts');

describe('no-ts-comment', () => {
  it('reports the six directive forms in the bad fixture', () => {
    const { loaded } = loadFiles(createProject(fixturesDir), [badPath]);
    const badFile = loaded[0];
    if (!badFile) {
      throw new Error(`Failed to load ${badPath}`);
    }

    const violations = noTsComment.check(badFile, {});
    const lines = violations.map((v) => v.line).sort((a, b) => a - b);

    expect(violations).toHaveLength(6);
    expect(lines).toEqual([1, 3, 5, 7, 9, 11]);

    const expectErrorLines = [3, 7, 11];
    for (const line of expectErrorLines) {
      const violation = violations.find((v) => v.line === line);
      if (!violation) {
        throw new Error(`Expected a violation on line ${line}`);
      }
      expect(violation.severity).toBe('warning');
    }

    const ignoreLines = [1, 5, 9];
    for (const line of ignoreLines) {
      const violation = violations.find((v) => v.line === line);
      if (!violation) {
        throw new Error(`Expected a violation on line ${line}`);
      }
      expect(violation.severity).toBe('error');
    }
  });

  it('reports no violations in the ok fixture', () => {
    const { loaded } = loadFiles(createProject(fixturesDir), [okPath]);
    const okFile = loaded[0];
    if (!okFile) {
      throw new Error(`Failed to load ${okPath}`);
    }

    const violations = noTsComment.check(okFile, {});
    expect(violations).toHaveLength(0);
  });
});
