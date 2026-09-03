import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import analyze from '../src/index.js';
import type { AnalyzeRequest, RuleSettings } from '@checkyourvibe/core';

const fixtureRoot = fileURLToPath(
  new URL('../test/fixtures/monorepo', import.meta.url),
);

function request(
  files: string[],
  rules: Record<string, RuleSettings>,
): AnalyzeRequest {
  return {
    protocol: 1,
    repoRoot: fixtureRoot,
    mode: 'file',
    files,
    rules,
  };
}

describe('solution-style tsconfig resolution', () => {
  it('resolves references and reports zero no-any findings on covered source files', async () => {
    const files = [
      join(fixtureRoot, 'libs', 'api-contracts', 'src', 'index.ts'),
      join(fixtureRoot, 'libs', 'api-contracts', 'src', 'index.spec.ts'),
    ];

    const response = await analyze(
      request(files, { 'no-any': { severity: 'error' } }),
    );

    const noAny = response.violations.filter((v) => v.ruleId === 'no-any');
    expect(noAny).toHaveLength(0);
    expect(response.diagnostics).toHaveLength(0);
  });

  it('falls back to default options and reports a diagnostic for uncovered files', async () => {
    const files = [
      join(fixtureRoot, 'libs', 'api-contracts', 'orphan.ts'),
    ];

    const response = await analyze(
      request(files, { 'no-any': { severity: 'error' } }),
    );

    expect(response.diagnostics).toHaveLength(1);
    const diagnostic = response.diagnostics[0];
    if (diagnostic === undefined) {
      throw new Error('expected one diagnostic');
    }
    expect(diagnostic.level).toBe('warn');
    expect(diagnostic.message).toContain('No usable tsconfig.json governs these files');
  });
});
