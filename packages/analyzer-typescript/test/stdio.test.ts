import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runStdio } from '../src/bin/analyze.js';
import type { AnalyzeRequest, RuleSettings } from '@checkyourvibe/core';

function writeTsConfig(dir: string): void {
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        strict: true,
      },
    }),
  );
}

function request(
  dir: string,
  files: string[],
  rules: Record<string, RuleSettings>,
): AnalyzeRequest {
  return {
    protocol: 1,
    repoRoot: dir,
    mode: 'file',
    files,
    rules,
  };
}

/**
 * A hand-written guard, not a cast: `JSON.parse`'s result is `unknown`, and
 * this file's subject (the stdio boundary) exists precisely to check a
 * parsed value's shape before treating it as anything specific.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDiagnosticArray(value: unknown): value is { level: string; message: string }[] {
  if (!Array.isArray(value)) {
    return false;
  }
  // `Array.isArray` narrows its parameter to `any[]` in the standard lib
  // typings, so the callback parameter needs an explicit annotation to avoid
  // an inferred `any`.
  return value.every(
    (item: unknown) => isRecord(item) && typeof item.level === 'string' && typeof item.message === 'string',
  );
}

interface ParsedResponse {
  protocol: number;
  violations: unknown[];
  skipped: unknown[];
  diagnostics: { level: string; message: string }[];
}

function isParsedResponse(value: unknown): value is ParsedResponse {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.protocol === 'number' &&
    Array.isArray(value.violations) &&
    Array.isArray(value.skipped) &&
    isDiagnosticArray(value.diagnostics)
  );
}

describe('runStdio', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cyv-stdio-'));
    writeTsConfig(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns a parseable AnalyzeResponse with protocol 1 for a valid request', async () => {
    const file = join(dir, 'clean.ts');
    writeFileSync(file, "export const value = 1;\n");

    const { stdout, exitCode } = await runStdio(
      JSON.stringify(request(dir, [file], { 'no-any': { severity: 'error' } })),
    );

    expect(exitCode).toBe(0);
    const parsed: unknown = JSON.parse(stdout);
    expect(isParsedResponse(parsed)).toBe(true);
    if (!isParsedResponse(parsed)) {
      throw new Error('unreachable: asserted above');
    }
    expect(parsed.protocol).toBe(1);
  });

  it('reports at least one violation for a file with an obvious violation', async () => {
    const file = join(dir, 'bad.ts');
    writeFileSync(file, 'const value: any = 1;\n');

    const { stdout, exitCode } = await runStdio(
      JSON.stringify(request(dir, [file], { 'no-any': { severity: 'error' } })),
    );

    expect(exitCode).toBe(0);
    const parsed: unknown = JSON.parse(stdout);
    expect(isParsedResponse(parsed)).toBe(true);
    if (!isParsedResponse(parsed)) {
      throw new Error('unreachable: asserted above');
    }
    expect(parsed.violations.length).toBeGreaterThan(0);
  });

  it('returns exitCode 1 and an explanatory diagnostic for malformed JSON', async () => {
    const { stdout, exitCode } = await runStdio('{ this is not json');

    expect(exitCode).toBe(1);
    const parsed: unknown = JSON.parse(stdout);
    expect(isParsedResponse(parsed)).toBe(true);
    if (!isParsedResponse(parsed)) {
      throw new Error('unreachable: asserted above');
    }
    expect(parsed.violations).toHaveLength(0);
    expect(parsed.skipped).toHaveLength(0);
    expect(parsed.diagnostics.length).toBeGreaterThan(0);
    expect(parsed.diagnostics[0]?.level).toBe('error');
    expect(parsed.diagnostics[0]?.message.length).toBeGreaterThan(0);
  });

  it('rejects a request declaring protocol 2 the same way as a malformed request', async () => {
    const { stdout, exitCode } = await runStdio(
      JSON.stringify({
        protocol: 2,
        repoRoot: dir,
        mode: 'file',
        files: [],
        rules: {},
      }),
    );

    expect(exitCode).toBe(1);
    const parsed: unknown = JSON.parse(stdout);
    expect(isParsedResponse(parsed)).toBe(true);
    if (!isParsedResponse(parsed)) {
      throw new Error('unreachable: asserted above');
    }
    expect(parsed.diagnostics.length).toBeGreaterThan(0);
    expect(parsed.diagnostics[0]?.level).toBe('error');
  });

  it('emits ONLY the JSON response on stdout, with no leading or trailing noise', async () => {
    const file = join(dir, 'clean2.ts');
    writeFileSync(file, "export const value = 2;\n");

    const { stdout } = await runStdio(
      JSON.stringify(request(dir, [file], { 'no-any': { severity: 'error' } })),
    );

    // A stray leading/trailing character (a log line, a trailing newline the
    // core did not ask for) is exactly what JSON.parse rejects here.
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stdout).toBe(stdout.trim());
    expect(stdout.startsWith('{')).toBe(true);
    expect(stdout.endsWith('}')).toBe(true);
  });
});
