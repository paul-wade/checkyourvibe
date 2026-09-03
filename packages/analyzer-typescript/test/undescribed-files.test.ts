import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import analyze from '../src/index.js';
import type { AnalyzeRequest, DegradedResolution, RuleSettings } from '@checkyourvibe/core';

function request(
  repoRoot: string,
  files: string[],
  rules: Record<string, RuleSettings>,
): AnalyzeRequest {
  return { protocol: 1, repoRoot, mode: 'all', files, rules };
}

function reasonFor(degraded: DegradedResolution[] | undefined, file: string): string | undefined {
  for (const entry of degraded ?? []) {
    if (entry.files.includes(file)) {
      return entry.reason;
    }
  }
  return undefined;
}

const UNTYPED_SOURCE =
  'export function widen(input: string): void {\n' +
  '  const parsed = JSON.parse(input);\n' +
  '  void parsed;\n' +
  '}\n';

/**
 * Findings only mean something when the configuration they were produced under
 * describes the file they came from. Two ways it does not: the config excludes
 * the file, and the package's dependencies are absent so nothing it imports has
 * a type.
 */
describe('files the project does not describe', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cyv-undescribed-'));
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'src', 'fixtures'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeProject(dependencies: Record<string, string>): void {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'undescribed', version: '0.0.0', dependencies }),
    );
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'ES2022', lib: ['ES2022'], strict: true },
        include: ['src'],
        exclude: ['src/fixtures'],
      }),
    );
  }

  it('declares an excluded file degraded and leaves a claimed file alone', async () => {
    writeProject({});
    const claimed = join(dir, 'src', 'claimed.ts');
    const excluded = join(dir, 'src', 'fixtures', 'excluded.ts');
    writeFileSync(claimed, UNTYPED_SOURCE);
    writeFileSync(excluded, UNTYPED_SOURCE);

    const response = await analyze(
      request(dir, [claimed, excluded], { 'no-any': { severity: 'error' } }),
    );

    expect(reasonFor(response.degraded, claimed)).toBeUndefined();
    const reason = reasonFor(response.degraded, excluded);
    expect(reason).toContain('excludes these files');

    // Both files carry the same `any`, so the rule still ran on the excluded
    // one. Withholding is the core's job; the analyzer only states the fact.
    const files = response.violations.map((violation) => violation.file.split('\\').join('/'));
    expect(files).toContain(claimed.split('\\').join('/'));
    expect(files).toContain(excluded.split('\\').join('/'));
  });

  it('declares every file degraded when a declared dependency is not installed', async () => {
    writeProject({ 'not-installed-package': '^1.0.0' });
    const source = join(dir, 'src', 'claimed.ts');
    writeFileSync(source, UNTYPED_SOURCE);

    const response = await analyze(
      request(dir, [source], { 'no-any': { severity: 'error' } }),
    );

    const reason = reasonFor(response.degraded, source);
    expect(reason).toContain('not-installed-package');
    expect(reason).toContain('not installed');
  });

  it('declares nothing degraded once the dependency is present in node_modules', async () => {
    writeProject({ 'installed-package': '^1.0.0' });
    mkdirSync(join(dir, 'node_modules', 'installed-package'), { recursive: true });
    const source = join(dir, 'src', 'claimed.ts');
    writeFileSync(source, UNTYPED_SOURCE);

    const response = await analyze(
      request(dir, [source], { 'no-any': { severity: 'error' } }),
    );

    expect(response.degraded).toBeUndefined();
    expect(response.diagnostics).toHaveLength(0);
  });
});
