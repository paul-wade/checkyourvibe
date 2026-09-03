import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type AnalyzerConfig,
  allRules,
  hasCommandOnPath,
  hasDotnetOnPath,
  loadAnalyzers,
  loadAnalyzerManifest,
  RegistryError,
} from '../../src/registry/load.js';
import type { AnalyzerManifest, RuleManifest } from '../../src/protocol/index.js';

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

function manifestJson(
  id: string,
  match: string[],
  extra?: {
    protocol?: number;
    rules?: unknown[];
    exclude?: string[];
    exec?: unknown;
  },
): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    protocol: extra?.protocol ?? 1,
    id,
    match,
    rules: extra?.rules ?? [validRule()],
    exec: extra?.exec ?? { type: 'node', module: './index.js' },
  };
  if (extra?.exclude) {
    obj.exclude = extra.exclude;
  }
  return obj;
}

describe('loadAnalyzerManifest', () => {
  it('reads and validates a manifest from a temporary directory', async () => {
    const repoRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'cyv-registry-')));
    try {
      const manifestPath = path.join(repoRoot, 'analyzer.manifest.json');
      await writeFile(
        manifestPath,
        JSON.stringify(manifestJson('ts', ['**/*.ts'])),
        'utf-8',
      );

      const manifest = await loadAnalyzerManifest('analyzer.manifest.json', repoRoot);

      expect(manifest.protocol).toBe(1);
      expect(manifest.id).toBe('ts');
      expect(manifest.match).toEqual(['**/*.ts']);
      expect(manifest.rules).toHaveLength(1);
      // A relative `exec.module` means "next to this manifest", not "next to
      // whatever repository is loading it". The loader resolves it at read time,
      // because it is the only place that knows where the manifest came from.
      expect(manifest.exec).toEqual({
        type: 'node',
        module: path.join(repoRoot, 'index.js'),
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('rejects a manifest with the wrong protocol version', async () => {
    const repoRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'cyv-registry-')));
    try {
      const manifestPath = path.join(repoRoot, 'analyzer.manifest.json');
      await writeFile(
        manifestPath,
        JSON.stringify(manifestJson('ts', ['**/*.ts'], { protocol: 2 })),
        'utf-8',
      );

      await expect(
        loadAnalyzerManifest('analyzer.manifest.json', repoRoot),
      ).rejects.toBeInstanceOf(RegistryError);

      try {
        await loadAnalyzerManifest('analyzer.manifest.json', repoRoot);
      } catch (err) {
        expect(err).toBeInstanceOf(RegistryError);
        if (err instanceof RegistryError) {
          expect(err.code).toBe('INVALID');
        }
      }
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('resolves a bare package specifier from node_modules', async () => {
    const repoRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'cyv-registry-')));
    try {
      const packageName = `cyv-fake-pkg-${Date.now()}`;
      const packageDir = path.join(repoRoot, 'node_modules', packageName);
      await mkdir(packageDir, { recursive: true });
      await writeFile(
        path.join(packageDir, 'analyzer.manifest.json'),
        JSON.stringify(manifestJson('css', ['**/*.css'])),
        'utf-8',
      );

      const manifest = await loadAnalyzerManifest(packageName, repoRoot);

      expect(manifest.id).toBe('css');
      expect(manifest.exec).toEqual({
        type: 'node',
        module: path.join(packageDir, 'index.js'),
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('resolves exec paths against the package directory for a package name', async () => {
    const repoRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'cyv-registry-')));
    try {
      const packageName = `cyv-fake-pkg-${Date.now()}`;
      const packageDir = path.join(repoRoot, 'node_modules', packageName);
      await mkdir(packageDir, { recursive: true });
      await writeFile(
        path.join(packageDir, 'analyzer.manifest.json'),
        JSON.stringify(
          manifestJson('process', ['**/*.ts'], {
            exec: { type: 'process', command: 'dotnet', args: ['./bin/analyzer.dll'] },
          }),
        ),
        'utf-8',
      );

      const manifest = await loadAnalyzerManifest(packageName, repoRoot);

      expect(manifest.exec).toEqual({
        type: 'process',
        command: 'dotnet',
        args: [path.join(packageDir, 'bin', 'analyzer.dll')],
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('throws a clear NOT_FOUND error when a bare package specifier does not resolve', async () => {
    const repoRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'cyv-registry-')));
    try {
      await expect(
        loadAnalyzerManifest('@checkyourvibe/missing-analyzer', repoRoot),
      ).rejects.toBeInstanceOf(RegistryError);

      try {
        await loadAnalyzerManifest('@checkyourvibe/missing-analyzer', repoRoot);
      } catch (err) {
        expect(err).toBeInstanceOf(RegistryError);
        if (err instanceof RegistryError) {
          expect(err.code).toBe('NOT_FOUND');
          expect(err.message).toContain('@checkyourvibe/missing-analyzer');
        }
      }
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('loadAnalyzers', () => {
  it('loads every configured analyzer and checks the id matches', async () => {
    const repoRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'cyv-registry-')));
    try {
      await writeFile(
        path.join(repoRoot, 'ts.analyzer.manifest.json'),
        JSON.stringify(manifestJson('ts', ['**/*.ts'])),
        'utf-8',
      );

      const config: AnalyzerConfig[] = [
        { id: 'ts', package: 'ts.analyzer.manifest.json' },
      ];

      const manifests = await loadAnalyzers(config, repoRoot);

      expect(manifests).toHaveLength(1);
      expect(manifests[0]?.id).toBe('ts');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('throws when the configured id does not match the manifest id', async () => {
    const repoRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'cyv-registry-')));
    try {
      await writeFile(
        path.join(repoRoot, 'analyzer.manifest.json'),
        JSON.stringify(manifestJson('actual', ['**/*.ts'])),
        'utf-8',
      );

      const config: AnalyzerConfig[] = [
        { id: 'configured', package: 'analyzer.manifest.json' },
      ];

      await expect(loadAnalyzers(config, repoRoot)).rejects.toBeInstanceOf(RegistryError);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('allRules', () => {
  it('flattens rules from several manifests', () => {
    const a: AnalyzerManifest = {
      protocol: 1,
      id: 'a',
      match: ['**/*.ts'],
      rules: [validRule('a-1')],
      exec: { type: 'node', module: './a.js' },
    };
    const b: AnalyzerManifest = {
      protocol: 1,
      id: 'b',
      match: ['**/*.css'],
      rules: [validRule('b-1')],
      exec: { type: 'node', module: './b.js' },
    };

    const rules = allRules([a, b]);

    expect(rules.map((r) => r.id)).toEqual(['a-1', 'b-1']);
  });

  it('throws when the same rule id appears in two analyzers', () => {
    const a: AnalyzerManifest = {
      protocol: 1,
      id: 'a',
      match: ['**/*.ts'],
      rules: [validRule('shared')],
      exec: { type: 'node', module: './a.js' },
    };
    const b: AnalyzerManifest = {
      protocol: 1,
      id: 'b',
      match: ['**/*.css'],
      rules: [validRule('shared')],
      exec: { type: 'node', module: './b.js' },
    };

    expect(() => allRules([a, b])).toThrow(RegistryError);

    try {
      allRules([a, b]);
    } catch (err) {
      expect(err).toBeInstanceOf(RegistryError);
      if (err instanceof RegistryError) {
        expect(err.code).toBe('AMBIGUOUS');
      }
    }
  });
});

describe('hasCommandOnPath', () => {
  it('is true for a command that is on PATH', () => {
    expect(hasCommandOnPath('node')).toBe(true);
  });

  it('is false for an empty command', () => {
    expect(hasCommandOnPath('')).toBe(false);
  });

  it('is false for a command that is not on PATH', () => {
    expect(hasCommandOnPath('cyv-definitely-missing-command')).toBe(false);
  });

  it('finds a command in a directory added to PATH', async () => {
    const tmpDir = await realpath(await mkdtemp(path.join(tmpdir(), 'cyv-path-')));
    const originalPath = process.env.PATH;
    const originalPathext = process.env.PATHEXT;

    try {
      const binName = process.platform === 'win32' ? 'cyv-test-bin.exe' : 'cyv-test-bin';
      const binPath = path.join(tmpDir, binName);
      await writeFile(binPath, '#!/bin/sh\necho ok');
      if (process.platform !== 'win32') {
        await chmod(binPath, 0o755);
      }

      process.env.PATH = tmpDir;
      process.env.PATHEXT = '.EXE';

      expect(hasCommandOnPath('cyv-test-bin')).toBe(true);
      expect(hasDotnetOnPath()).toBe(false);
    } finally {
      if (originalPath !== undefined) {
        process.env.PATH = originalPath;
      } else {
        delete process.env.PATH;
      }
      if (originalPathext !== undefined) {
        process.env.PATHEXT = originalPathext;
      } else {
        delete process.env.PATHEXT;
      }
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
