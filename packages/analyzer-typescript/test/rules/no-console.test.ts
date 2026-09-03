import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { noConsole } from '../../src/rules/no-console.js';
import { createProject, loadFiles } from '../../src/project.js';
import type { SourceFile } from 'ts-morph';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const badPath = resolve(fixturesDir, 'no-console.bad.ts');
const okPath = resolve(fixturesDir, 'no-console.ok.ts');

function loadFixture(path: string): SourceFile {
  const { loaded } = loadFiles(createProject(packageRoot), [path]);
  const sourceFile = loaded[0];
  if (sourceFile === undefined) {
    throw new Error(`Failed to load ${path}`);
  }
  return sourceFile;
}

describe('no-console', () => {
  it('reports global console calls and destructured aliases by default', () => {
    const sourceFile = loadFixture(badPath);
    const violations = noConsole.check(sourceFile, {});
    const lines = violations.map((v) => v.line).sort((a, b) => a - b);

    expect(violations).toHaveLength(15);
    expect(lines).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 17, 19]);
  });

  it('allows configured methods in the bad fixture', () => {
    const sourceFile = loadFixture(badPath);
    const violations = noConsole.check(sourceFile, { allowedMethods: ['warn', 'error'] });
    const lines = violations.map((v) => v.line).sort((a, b) => a - b);

    expect(violations).toHaveLength(11);
    expect(lines).toEqual([1, 4, 5, 6, 7, 8, 9, 10, 12, 17, 19]);
  });

  it('does not flag a shadowed console, an unrelated log, or a configured allowed member', () => {
    const sourceFile = loadFixture(okPath);
    const violations = noConsole.check(sourceFile, { allowedMethods: ['warn'] });

    expect(violations).toHaveLength(0);
  });
});
