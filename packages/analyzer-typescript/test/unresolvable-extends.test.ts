import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import analyze from '../src/index.js';
import type { AnalyzeRequest, RuleSettings } from '@checkyourvibe/core';

function request(
  repoRoot: string,
  files: string[],
  rules: Record<string, RuleSettings>,
): AnalyzeRequest {
  return { protocol: 1, repoRoot, mode: 'all', files, rules };
}

/**
 * A tsconfig whose `extends` target is not installed still parses as JSON, so
 * the analyzer used to load it as a working configuration. Everything the base
 * config would have supplied — `target`, `lib`, `types` — is absent, the
 * standard library is not loaded, and inferred types collapse to `any`.
 */
describe('a tsconfig whose extends target cannot be read', () => {
  let dir: string;
  let source: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cyv-extends-'));
    mkdirSync(join(dir, 'src'));
    source = join(dir, 'src', 'a.ts');
    writeFileSync(
      source,
      'export async function join(items: readonly string[]): Promise<string> {\n' +
        '  return items.join(",");\n' +
        '}\n' +
        '\n' +
        'export const first = join(["a"]);\n',
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('declares the files degraded and names the file TypeScript could not read', async () => {
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        extends: '@tsconfig/not-installed/tsconfig.json',
        compilerOptions: { noImplicitAny: true },
        include: ['src'],
      }),
    );

    const response = await analyze(
      request(dir, [source], { 'no-any': { severity: 'error' } }),
    );

    expect(response.degraded).toBeDefined();
    const degraded = response.degraded ?? [];
    expect(degraded).toHaveLength(1);
    const entry = degraded[0];
    if (entry === undefined) {
      throw new Error('expected one degraded entry');
    }
    expect(entry.files).toEqual([source]);
    expect(entry.reason).toContain('@tsconfig/not-installed/tsconfig.json');
    expect(response.diagnostics).toHaveLength(1);
  });

  it('declares nothing degraded when the same config resolves', async () => {
    writeFileSync(
      join(dir, 'base.json'),
      JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['ES2022'] } }),
    );
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        extends: './base.json',
        compilerOptions: { noImplicitAny: true },
        include: ['src'],
      }),
    );

    const response = await analyze(
      request(dir, [source], { 'no-any': { severity: 'error' } }),
    );

    expect(response.degraded).toBeUndefined();
    expect(response.diagnostics).toHaveLength(0);
    expect(response.violations).toHaveLength(0);
  });
});
