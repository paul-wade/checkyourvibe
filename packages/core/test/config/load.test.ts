import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findConfig, loadConfig, CONFIG_FILENAME, ConfigError } from '../../src/config/index.js';

function assertDefined<T>(value: T | undefined, message: string): asserts value is T {
  if (value === undefined) {
    throw new Error(message);
  }
}

function assertConfigError(err: unknown): asserts err is ConfigError {
  expect(err).toBeInstanceOf(ConfigError);
  if (!(err instanceof ConfigError)) {
    throw err;
  }
}

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cyv-load-'));
  await mkdir(join(dir, '.git'));
  return dir;
}

async function copySchema(repoRoot: string): Promise<void> {
  const schemaUrl = new URL('../../../../docs/protocol/config.schema.json', import.meta.url);
  const schema = await readFile(schemaUrl, 'utf-8');
  const schemaDir = join(repoRoot, 'docs', 'protocol');
  await mkdir(schemaDir, { recursive: true });
  await writeFile(join(schemaDir, 'config.schema.json'), schema);
}

async function writeConfig(repoRoot: string, content: unknown): Promise<void> {
  await writeFile(
    join(repoRoot, CONFIG_FILENAME),
    JSON.stringify(content, null, 2),
  );
}

describe('findConfig', () => {
  it('finds checkyourvibe.json in the starting directory', async () => {
    const repo = await makeTempRepo();
    try {
      const expected = join(repo, CONFIG_FILENAME);
      await writeConfig(repo, {});
      const found = await findConfig(repo);
      expect(found).toBe(expected);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('walks up to a config in an ancestor directory', async () => {
    const repo = await makeTempRepo();
    const child = join(repo, 'src', 'nested');
    try {
      await mkdir(child, { recursive: true });
      await writeConfig(repo, {});
      const found = await findConfig(child);
      expect(found).toBe(join(repo, CONFIG_FILENAME));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('returns null when no config is found before the git root', async () => {
    const repo = await makeTempRepo();
    try {
      const found = await findConfig(repo);
      expect(found).toBeNull();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('loadConfig', () => {
  it('throws MISSING with the cyv init remediation when the file is absent', async () => {
    const repo = await makeTempRepo();
    try {
      await expect(loadConfig(repo)).rejects.toBeInstanceOf(ConfigError);
      try {
        await loadConfig(repo);
        throw new Error('loadConfig should have thrown');
      } catch (err) {
        assertConfigError(err);
        expect(err.code).toBe('MISSING');
        expect(err.message).toMatch(/cyv init/);
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('throws INVALID and includes the failing JSON pointer for a bad severity', async () => {
    const repo = await makeTempRepo();
    try {
      await copySchema(repo);
      await writeConfig(repo, {
        rules: {
          'no-console': {
            severity: 'info',
          },
        },
      });
      try {
        await loadConfig(repo);
        throw new Error('loadConfig should have thrown');
      } catch (err) {
        assertConfigError(err);
        expect(err.code).toBe('INVALID');
        expect(err.message).toMatch(/\/rules\/no-console\/severity/);
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('loads and defaults a complete configuration', async () => {
    const repo = await makeTempRepo();
    try {
      await copySchema(repo);
      await writeConfig(repo, {
        $schema: './docs/protocol/config.schema.json',
        packs: ['core-ts'],
        analyzers: [
          {
            id: 'typescript',
            package: '@checkyourvibe/analyzer-typescript',
            options: {},
          },
        ],
        agents: ['claude-code'],
        rules: {
          'no-any': { severity: 'error' },
          'no-console': { severity: 'warning', allowedLoggers: ['log'] },
          'no-useless-types': false,
        },
        strict: false,
        exclude: ['**/dist/**', '**/node_modules/**'],
      });

      const config = await loadConfig(repo);
      expect(config.packs).toEqual(['core-ts']);
      expect(config.analyzers[0]?.id).toBe('typescript');
      expect(config.agents).toEqual(['claude-code']);
      const noConsole = config.rules['no-console'];
      assertDefined(noConsole, 'expected no-console rule override');
      expect(noConsole).toEqual({
        severity: 'warning',
        allowedLoggers: ['log'],
      });
      const noUselessTypes = config.rules['no-useless-types'];
      assertDefined(noUselessTypes, 'expected no-useless-types rule override');
      expect(noUselessTypes).toBe(false);
      expect(config.strict).toBe(false);
      expect(config.exclude).toEqual(['**/dist/**', '**/node_modules/**']);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
