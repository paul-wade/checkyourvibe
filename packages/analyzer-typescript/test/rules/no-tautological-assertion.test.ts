import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createProject, loadFiles } from '../../src/project.js';
import { noTautologicalAssertion } from '../../src/rules/no-tautological-assertion.js';
import type { SourceFile } from 'ts-morph';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const badPath = resolve(fixturesDir, 'no-tautological-assertion.bad.ts');
const okPath = resolve(fixturesDir, 'no-tautological-assertion.ok.ts');

function loadFixture(path: string): SourceFile {
  const { loaded } = loadFiles(createProject(fixturesDir), [path]);
  const sourceFile = loaded[0];
  if (sourceFile === undefined) {
    throw new Error(`Failed to load fixture ${path}`);
  }
  return sourceFile;
}

/**
 * The rule's scope is test files, but committing a `.test.ts` fixture would
 * make vitest try to run it as a test suite. Create the equivalent source file
 * in memory so the rule sees a `.test.ts` basename without adding a new test
 * file to the tree.
 */
function loadAsTestFile(path: string): SourceFile {
  const content = readFileSync(path, 'utf8');
  const project = createProject(fixturesDir);
  const testPath = resolve(fixturesDir, 'no-tautological-assertion.test.ts');
  return project.createSourceFile(testPath, content, { overwrite: true });
}

describe('no-tautological-assertion', () => {
  it('reports each tautological assertion in the bad fixture', () => {
    const sourceFile = loadAsTestFile(badPath);
    const violations = noTautologicalAssertion.check(sourceFile, {});
    const lines = violations.map((v) => v.line).sort((a, b) => a - b);

    expect(violations).toHaveLength(6);
    expect(lines).toEqual([10, 11, 12, 14, 15, 16]);
  });

  it('reports zero violations in the ok fixture when treated as a test file', () => {
    const sourceFile = loadAsTestFile(okPath);
    const violations = noTautologicalAssertion.check(sourceFile, {});

    expect(violations).toHaveLength(0);
  });

  it('does not report non-test files even when they contain the same shape', () => {
    const badSource = loadFixture(badPath);
    const okSource = loadFixture(okPath);

    expect(noTautologicalAssertion.check(badSource, {})).toHaveLength(0);
    expect(noTautologicalAssertion.check(okSource, {})).toHaveLength(0);
  });
});
