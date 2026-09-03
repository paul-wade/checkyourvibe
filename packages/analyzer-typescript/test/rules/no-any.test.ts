import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { noAny } from '../../src/rules/no-any.js';
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

describe('no-any', () => {
  it('reports explicit and inferred any in the bad fixture', () => {
    const sourceFile = loadFixture('no-any.bad.ts');
    const violations = noAny.check(sourceFile, {});
    const lines = violations.map((v) => v.line).sort((a, b) => a - b);

    expect(violations).toHaveLength(2);
    expect(lines).toEqual([1, 4]);
  });

  it('reports zero violations in the ok fixture', () => {
    const sourceFile = loadFixture('no-any.ok.ts');
    const violations = noAny.check(sourceFile, {});

    expect(violations).toHaveLength(0);
  });
});
