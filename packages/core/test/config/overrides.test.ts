import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuleManifest } from '../../src/protocol/index.js';
import type { CheckYourVibeConfig, ConfigOverride, RuleOverride } from '../../src/config/index.js';
import { CONFIG_FILENAME, ConfigError, loadConfig, resolveRulesForFile } from '../../src/config/index.js';

function assertConfigError(err: unknown): asserts err is ConfigError {
  expect(err).toBeInstanceOf(ConfigError);
  if (!(err instanceof ConfigError)) {
    throw err;
  }
}

function makeRule(
  id: string,
  pack: string,
  severity: 'error' | 'warning' = 'warning',
): RuleManifest {
  return {
    id,
    pack,
    category: 'test',
    scope: 'file',
    severity,
    summary: `summary for ${id}`,
    why: `why for ${id}`,
    allowedFixes: ['fix it'],
    notFixes: [],
    examples: { bad: 'bad example', good: 'good example' },
  };
}

function makeConfig(
  packs: string[],
  rules: Record<string, RuleOverride>,
  overrides: ConfigOverride[],
): CheckYourVibeConfig {
  return {
    packs,
    analyzers: [],
    rules,
    overrides,
    strict: false,
    exclude: [],
  };
}

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cyv-overrides-'));
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
  await writeFile(join(repoRoot, CONFIG_FILENAME), JSON.stringify(content, null, 2));
}

describe('resolveRulesForFile', () => {
  it('disables a rule only for files matching the override', () => {
    const rules = [makeRule('no-console', 'core-ts'), makeRule('no-any', 'core-ts')];
    const config = makeConfig(['core-ts'], {}, [
      {
        files: ['packages/core/src/cli/**'],
        reason: 'A CLI writes to stdout by design; no-console governs library code.',
        rules: { 'no-console': false },
      },
    ]);

    const cliFile = resolveRulesForFile(config, rules, 'packages/core/src/cli/check.ts');
    expect(cliFile.has('no-console')).toBe(false);
    expect(cliFile.has('no-any')).toBe(true);

    const libFile = resolveRulesForFile(config, rules, 'packages/core/src/config/resolve.ts');
    expect(libFile.has('no-console')).toBe(true);
    expect(libFile.has('no-any')).toBe(true);
  });

  it('changes severity only for matching files', () => {
    const rules = [makeRule('no-console', 'core-ts', 'error')];
    const config = makeConfig(['core-ts'], {}, [
      {
        files: ['packages/core/src/cli/**'],
        reason: 'CLI output is intentional; downgrade rather than fail the build.',
        rules: { 'no-console': { severity: 'warning' } },
      },
    ]);

    const cliFile = resolveRulesForFile(config, rules, 'packages/core/src/cli/check.ts');
    expect(cliFile.get('no-console')?.severity).toBe('warning');

    const libFile = resolveRulesForFile(config, rules, 'packages/core/src/config/resolve.ts');
    expect(libFile.get('no-console')?.severity).toBe('error');
  });

  it('applies multiple matching overrides in order, with the later one winning', () => {
    const rules = [makeRule('no-console', 'core-ts', 'error')];
    const config = makeConfig(['core-ts'], {}, [
      {
        files: ['packages/core/src/cli/**'],
        reason: 'First pass: just downgrade severity.',
        rules: { 'no-console': { severity: 'warning' } },
      },
      {
        files: ['packages/core/src/cli/**'],
        reason: 'Second pass: actually disable it outright.',
        rules: { 'no-console': false },
      },
    ]);

    const resolved = resolveRulesForFile(config, rules, 'packages/core/src/cli/check.ts');
    expect(resolved.has('no-console')).toBe(false);
  });

  it('leaves the base rules unchanged when an override glob matches nothing', () => {
    const rules = [makeRule('no-console', 'core-ts', 'error')];
    const config = makeConfig(['core-ts'], {}, [
      {
        files: ['packages/core/src/nowhere/**'],
        reason: 'Would disable no-console, but nothing lives at this path.',
        rules: { 'no-console': false },
      },
    ]);

    const resolved = resolveRulesForFile(config, rules, 'packages/core/src/cli/check.ts');
    expect(resolved.get('no-console')?.severity).toBe('error');
  });

  it('throws UNKNOWN_RULE when an override names a rule not in availableRules', () => {
    const rules = [makeRule('no-any', 'core-ts')];
    const config = makeConfig([], {}, [
      {
        files: ['packages/core/src/cli/**'],
        reason: 'Typo in a rule id should still be caught.',
        rules: { 'no-such-rule': false },
      },
    ]);

    expect(() => resolveRulesForFile(config, rules, 'packages/core/src/cli/check.ts')).toThrow(
      ConfigError,
    );

    try {
      resolveRulesForFile(config, rules, 'packages/core/src/cli/check.ts');
      throw new Error('resolveRulesForFile should have thrown');
    } catch (err) {
      assertConfigError(err);
      expect(err.code).toBe('UNKNOWN_RULE');
      expect(err.message).toMatch(/no-such-rule/);
    }
  });

  it('still applies base rules to files no override matches', () => {
    const rules = [makeRule('no-any', 'core-ts', 'error'), makeRule('no-console', 'core-ts')];
    const config = makeConfig(
      ['core-ts'],
      { 'no-console': false },
      [
        {
          files: ['packages/core/src/cli/**'],
          reason: 'CLI is allowed to log.',
          rules: { 'no-console': { severity: 'warning' } },
        },
      ],
    );

    const resolved = resolveRulesForFile(config, rules, 'packages/core/src/config/resolve.ts');
    expect(resolved.get('no-any')?.severity).toBe('error');
    expect(resolved.has('no-console')).toBe(false);
  });
});

describe('config schema: overrides', () => {
  it('rejects an override with a missing reason', async () => {
    const repo = await makeTempRepo();
    try {
      await copySchema(repo);
      await writeConfig(repo, {
        overrides: [
          {
            files: ['packages/core/src/cli/**'],
            rules: { 'no-console': false },
          },
        ],
      });

      try {
        await loadConfig(repo);
        throw new Error('loadConfig should have thrown');
      } catch (err) {
        assertConfigError(err);
        expect(err.code).toBe('INVALID');
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rejects an override with an empty reason', async () => {
    const repo = await makeTempRepo();
    try {
      await copySchema(repo);
      await writeConfig(repo, {
        overrides: [
          {
            files: ['packages/core/src/cli/**'],
            reason: '',
            rules: { 'no-console': false },
          },
        ],
      });

      try {
        await loadConfig(repo);
        throw new Error('loadConfig should have thrown');
      } catch (err) {
        assertConfigError(err);
        expect(err.code).toBe('INVALID');
        expect(err.message).toMatch(/reason/);
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rejects an override with an empty files array', async () => {
    const repo = await makeTempRepo();
    try {
      await copySchema(repo);
      await writeConfig(repo, {
        overrides: [
          {
            files: [],
            reason: 'A CLI writes to stdout by design; no-console governs library code.',
            rules: { 'no-console': false },
          },
        ],
      });

      try {
        await loadConfig(repo);
        throw new Error('loadConfig should have thrown');
      } catch (err) {
        assertConfigError(err);
        expect(err.code).toBe('INVALID');
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('loads a valid override and defaults overrides to an empty array when omitted', async () => {
    const repo = await makeTempRepo();
    try {
      await copySchema(repo);
      await writeConfig(repo, {
        overrides: [
          {
            files: ['packages/core/src/cli/**'],
            reason: 'A CLI writes to stdout by design; no-console governs library code.',
            rules: { 'no-console': false },
          },
        ],
      });

      const config = await loadConfig(repo);
      expect(config.overrides).toHaveLength(1);
      expect(config.overrides?.[0]?.files).toEqual(['packages/core/src/cli/**']);
      expect(config.overrides?.[0]?.reason).toMatch(/CLI writes to stdout/);
      expect(config.overrides?.[0]?.rules).toEqual({ 'no-console': false });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('defaults overrides to an empty array when the config omits it entirely', async () => {
    const repo = await makeTempRepo();
    try {
      await copySchema(repo);
      await writeConfig(repo, {});

      const config = await loadConfig(repo);
      expect(config.overrides).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
