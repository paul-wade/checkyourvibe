import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RegistryError } from '../../src/registry/load.js';
import type { AnalyzerManifest, RuleManifest } from '../../src/protocol/index.js';
import { routeFiles } from '../../src/run/route.js';

function assertDefined<T>(value: T | undefined, message: string): asserts value is T {
  if (value === undefined) {
    throw new Error(message);
  }
}

function validRule(id = 'rule-1'): RuleManifest {
  return {
    id,
    category: 'test',
    scope: 'file',
    severity: 'error',
    summary: 'summary',
    why: 'why',
    allowedFixes: ['fix'],
    notFixes: [],
    examples: { bad: 'bad', good: 'good' },
  };
}

function manifest(id: string, match: string[], exclude?: string[]): AnalyzerManifest {
  const m: AnalyzerManifest = {
    protocol: 1,
    id,
    match,
    rules: [validRule()],
    exec: { type: 'node', module: './index.js' },
  };
  if (exclude) {
    m.exclude = exclude;
  }
  return m;
}

describe('routeFiles', () => {
  it('routes files to the analyzer that claims their extension', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'cyv-route-'));
    try {
      const manifests = [
        manifest('ts', ['**/*.ts']),
        manifest('css', ['**/*.css']),
      ];
      const files = [
        path.resolve(repoRoot, 'src/foo.ts'),
        path.resolve(repoRoot, 'src/bar.css'),
        path.resolve(repoRoot, 'docs/readme.md'),
      ];

      const result = routeFiles(files, manifests, repoRoot);

      const tsFile = files[0];
      assertDefined(tsFile, 'expected a .ts file');
      const cssFile = files[1];
      assertDefined(cssFile, 'expected a .css file');
      const unmatched = files[2];
      assertDefined(unmatched, 'expected an unmatched file');
      expect(result.routed.get('ts')).toEqual([tsFile]);
      expect(result.routed.get('css')).toEqual([cssFile]);
      expect(result.unmatched).toEqual([unmatched]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('excludes take precedence over match, including extra excludes', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'cyv-route-'));
    try {
      const manifests = [manifest('ts', ['**/*.ts'], ['**/*.test.ts'])];
      const files = [
        path.resolve(repoRoot, 'src/foo.ts'),
        path.resolve(repoRoot, 'src/foo.test.ts'),
        path.resolve(repoRoot, 'src/generated.ts'),
      ];

      const result = routeFiles(files, manifests, repoRoot, ['**/generated.ts']);

      const matched = files[0];
      assertDefined(matched, 'expected a .ts file');
      const excludedTest = files[1];
      assertDefined(excludedTest, 'expected a test file');
      const excludedGenerated = files[2];
      assertDefined(excludedGenerated, 'expected a generated file');
      expect(result.routed.get('ts')).toEqual([matched]);
      expect(result.unmatched).toEqual([excludedTest, excludedGenerated]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('throws when a file matches two analyzers', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'cyv-route-'));
    try {
      const manifests = [
        manifest('ts', ['**/*.ts']),
        manifest('ts2', ['src/**/*.ts']),
      ];
      const file = path.resolve(repoRoot, 'src/foo.ts');

      expect(() => routeFiles([file], manifests, repoRoot)).toThrow(RegistryError);

      try {
        routeFiles([file], manifests, repoRoot);
      } catch (err) {
        expect(err).toBeInstanceOf(RegistryError);
        if (err instanceof RegistryError) {
          expect(err.code).toBe('AMBIGUOUS');
        }
      }
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('collects unmatched files', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'cyv-route-'));
    try {
      const manifests = [manifest('ts', ['**/*.ts'])];
      const files = [
        path.resolve(repoRoot, 'src/foo.md'),
        path.resolve(repoRoot, 'src/bar.json'),
      ];

      const result = routeFiles(files, manifests, repoRoot);

      expect(result.routed.size).toBe(0);
      expect(result.unmatched).toEqual(files);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
