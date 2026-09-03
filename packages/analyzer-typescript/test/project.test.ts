import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { ts } from 'ts-morph';
import { createProject, loadFiles, refreshFiles } from '../src/project.js';
import { makeViolation, truncate } from '../src/util.js';

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function assertDefined<T>(value: T | undefined, message: string): asserts value is T {
  if (value === undefined) {
    throw new Error(message);
  }
}

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

describe('project', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cyv-analyzer-'));
    writeTsConfig(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('createProject picks up the nearest tsconfig', () => {
    const project = createProject(dir);
    const options = project.getCompilerOptions();

    expect(options.strict).toBe(true);
    expect(options.target).toBe(ts.ScriptTarget.ES2022);
  });

  it('loadFiles returns all existing files and skips nonexistent paths', () => {
    const a = join(dir, 'a.ts');
    const b = join(dir, 'b.ts');
    const missing = join(dir, 'missing.ts');

    writeFileSync(a, 'export const a = 1;\n');
    writeFileSync(b, 'export const b = 2;\n');

    const project = createProject(dir);
    const result = loadFiles(project, [a, b, missing]);

    expect(result.loaded).toHaveLength(2);
    expect(result.skipped).toHaveLength(1);
    const skipped = result.skipped[0];
    assertDefined(skipped, 'expected one skipped file');
    expect(skipped.file).toBe(missing);
    expect(skipped.reason.length).toBeGreaterThan(0);

    const loadedPaths = result.loaded
      .map((sourceFile) => normalizePath(sourceFile.getFilePath()))
      .sort();
    expect(loadedPaths).toEqual([a, b].map(normalizePath).sort());
  });

  it('refreshFiles picks up edits made after the initial load', () => {
    const a = join(dir, 'a.ts');
    const original = 'export const a = 1;\n';
    const updated = 'export const a = 42;\n';

    writeFileSync(a, original);

    const project = createProject(dir);
    loadFiles(project, [a]);

    writeFileSync(a, updated);

    const result = refreshFiles(project, [a]);
    expect(result.loaded).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
    const loaded = result.loaded[0];
    assertDefined(loaded, 'expected one loaded file');
    expect(loaded.getText()).toBe(updated);
  });

  it('createProject falls back to strict ES2022 options when no tsconfig exists', () => {
    const fallbackDir = mkdtempSync(join(tmpdir(), 'cyv-fallback-'));
    try {
      const project = createProject(fallbackDir);
      const options = project.getCompilerOptions();

      expect(options.strict).toBe(true);
      expect(options.target).toBe(ts.ScriptTarget.ES2022);
      expect(options.allowJs).toBe(false);
    } finally {
      rmSync(fallbackDir, { recursive: true, force: true });
    }
  });
});

describe('makeViolation', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cyv-violation-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports 1-based line and column', () => {
    const file = join(dir, 'sample.ts');
    writeFileSync(file, 'const x = 1;\n');

    const project = createProject(dir);
    const result = loadFiles(project, [file]);
    const sourceFile = result.loaded[0];
    expect(sourceFile).toBeDefined();

    const declaration = sourceFile.getVariableDeclaration('x');
    expect(declaration).toBeDefined();

    const violation = makeViolation(
      sourceFile,
      declaration,
      'test-rule',
      'A test message',
      'warning',
    );

    expect(violation.file).toBe(sourceFile.getFilePath());
    expect(violation.line).toBe(1);
    expect(violation.column).toBe(7);
    expect(violation.ruleId).toBe('test-rule');
    expect(violation.message).toBe('A test message');
    expect(violation.severity).toBe('warning');
  });

  it('collapses whitespace and truncates long snippets', () => {
    const file = join(dir, 'long.ts');
    const repeated = 'word '.repeat(300).trim();
    writeFileSync(
      file,
      `const longVariable = ${JSON.stringify(repeated)};\n`,
    );

    const project = createProject(dir);
    const result = loadFiles(project, [file]);
    const sourceFile = result.loaded[0];
    expect(sourceFile).toBeDefined();

    const declaration = sourceFile.getVariableDeclaration('longVariable');
    expect(declaration).toBeDefined();

    const violation = makeViolation(
      sourceFile,
      declaration,
      'test-rule',
      'Long snippet',
      'error',
    );

    expect(violation.snippet.length).toBeLessThanOrEqual(200);
    expect(violation.snippet.endsWith('…')).toBe(true);
  });
});

describe('truncate', () => {
  it('collapses whitespace and trims', () => {
    expect(truncate('a\n\tb  c', 20)).toBe('a b c');
  });

  it('adds an ellipsis when text exceeds the max', () => {
    const text = 'a'.repeat(300);
    expect(truncate(text, 20)).toBe('a'.repeat(19) + '…');
  });
});
