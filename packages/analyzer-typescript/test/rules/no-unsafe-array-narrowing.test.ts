import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { noUnsafeArrayNarrowing } from '../../src/rules/no-unsafe-array-narrowing.js';
import { createProject, loadFiles } from '../../src/project.js';
import type { SourceFile } from 'ts-morph';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixturesDir = fileURLToPath(new URL('../fixtures', import.meta.url));

function loadFixture(name: string): SourceFile {
  const project = createProject(packageRoot);
  const path = join(fixturesDir, name);
  const { loaded } = loadFiles(project, [path]);
  const sourceFile = loaded[0];
  if (sourceFile === undefined) {
    throw new Error(`Fixture ${name} did not load`);
  }
  return sourceFile;
}

describe('no-unsafe-array-narrowing', () => {
  it('reports Array.isArray narrowing on unknown in the bad fixture', () => {
    const sourceFile = loadFixture('no-unsafe-array-narrowing.bad.ts');
    const violations = noUnsafeArrayNarrowing.check(sourceFile, {});
    const lines = violations.map((v) => v.line).sort((a, b) => a - b);

    expect(violations).toHaveLength(4);
    expect(lines).toEqual([3, 7, 11, 14]);
  });

  it('reports no violations in the false-positive guard fixture', () => {
    const sourceFile = loadFixture('no-unsafe-array-narrowing.ok.ts');
    const violations = noUnsafeArrayNarrowing.check(sourceFile, {});

    expect(violations).toHaveLength(0);
  });
});
