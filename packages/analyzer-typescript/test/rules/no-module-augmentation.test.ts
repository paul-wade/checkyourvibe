import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createProject, loadFiles } from '../../src/project.js';
import { noModuleAugmentation } from '../../src/rules/no-module-augmentation.js';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const badPath = resolve(fixturesDir, 'no-module-augmentation.bad.ts');
const okPath = resolve(fixturesDir, 'no-module-augmentation.ok.ts');

function checkFixture(path: string) {
  const { loaded } = loadFiles(createProject(fixturesDir), [path]);
  const file = loaded[0];
  if (!file) {
    throw new Error(`Failed to load ${path}`);
  }
  return noModuleAugmentation.check(file, {});
}

describe('no-module-augmentation', () => {
  it('reports both relative specifier forms in the bad fixture', () => {
    const violations = checkFixture(badPath);
    const lines = violations.map((v) => v.line).sort((a, b) => a - b);

    expect(violations).toHaveLength(2);
    expect(lines).toEqual([8, 14]);

    for (const violation of violations) {
      expect(violation.severity).toBe('error');
    }
  });

  it('names the offending specifier so the message says which file to open', () => {
    const messages = checkFixture(badPath).map((v) => v.message);

    expect(messages).toHaveLength(2);
    expect(messages.some((m) => m.includes("'./no-module-augmentation.dispatch.js'"))).toBe(true);
    expect(
      messages.some((m) => m.includes("'../fixtures/no-module-augmentation.dispatch.js'")),
    ).toBe(true);
  });

  // The three exclusions are the rule, not edge cases bolted on afterwards, so
  // this assertion is the one that would fail if the rule were ever widened to
  // fire on any `declare module` at all.
  it('reports nothing for a bare specifier, a wildcard, or declare global', () => {
    expect(checkFixture(okPath)).toHaveLength(0);
  });
});
