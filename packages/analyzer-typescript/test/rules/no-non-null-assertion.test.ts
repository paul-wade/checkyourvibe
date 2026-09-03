import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createProject, loadFiles } from '../../src/project.js';
import { noNonNullAssertion } from '../../src/rules/no-non-null-assertion.js';

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const badFixture = join(__dirname, '../fixtures/no-non-null-assertion.bad.ts');
const okFixture = join(__dirname, '../fixtures/no-non-null-assertion.ok.ts');

describe('no-non-null-assertion', () => {
  it('reports every form of the non-null assertion in the bad fixture', () => {
    const project = createProject(__dirname);
    const { loaded } = loadFiles(project, [badFixture, okFixture]);

    const badFile = loaded.find((file) => normalizePath(file.getFilePath()) === normalizePath(badFixture));
    if (badFile === undefined) {
      throw new Error(`Failed to load bad fixture: ${badFixture}`);
    }

    const violations = noNonNullAssertion.check(badFile, {});
    const lines = violations.map((violation) => violation.line).sort((a, b) => a - b);

    expect(violations).toHaveLength(9);
    expect(lines).toEqual([8, 12, 16, 20, 24, 27, 32, 32, 32]);
  });

  it('gives each assertion in a chain its own column', () => {
    const project = createProject(__dirname);
    const { loaded } = loadFiles(project, [badFixture, okFixture]);

    const badFile = loaded.find((file) => normalizePath(file.getFilePath()) === normalizePath(badFixture));
    if (badFile === undefined) {
      throw new Error(`Failed to load bad fixture: ${badFixture}`);
    }

    const identities = noNonNullAssertion
      .check(badFile, {})
      .map((violation) => `${violation.line}:${violation.column}`);

    expect(new Set(identities).size).toBe(identities.length);
  });

  it('reports no violations in the false-positive guard fixture', () => {
    const project = createProject(__dirname);
    const { loaded } = loadFiles(project, [badFixture, okFixture]);

    const okFile = loaded.find((file) => normalizePath(file.getFilePath()) === normalizePath(okFixture));
    if (okFile === undefined) {
      throw new Error(`Failed to load ok fixture: ${okFixture}`);
    }

    const violations = noNonNullAssertion.check(okFile, {});

    expect(violations).toHaveLength(0);
  });
});
