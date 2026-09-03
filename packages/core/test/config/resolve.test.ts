import { describe, expect, it } from 'vitest';
import type { RuleManifest } from '../../src/protocol/index.js';
import type { CheckYourVibeConfig, RuleOverride } from '../../src/config/index.js';
import { resolveRules, ConfigError } from '../../src/config/index.js';

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
): CheckYourVibeConfig {
  return {
    packs,
    analyzers: [],
    rules,
    strict: false,
    exclude: [],
  };
}

describe('resolveRules', () => {
  it('expands a pack into all of its rules', () => {
    const rules = [
      makeRule('no-any', 'core-ts'),
      makeRule('no-console', 'core-ts'),
      makeRule('no-useless-types', 'core-ts'),
    ];
    const config = makeConfig(['core-ts'], {});

    const resolved = resolveRules(config, rules);

    expect(resolved.size).toBe(3);
    expect(resolved.get('no-any')?.severity).toBe('warning');
    expect(resolved.get('no-console')?.severity).toBe('warning');
    expect(resolved.get('no-useless-types')?.severity).toBe('warning');
  });

  it('disables a rule from a pack', () => {
    const rules = [
      makeRule('no-any', 'core-ts'),
      makeRule('no-console', 'core-ts'),
    ];
    const config = makeConfig(['core-ts'], { 'no-console': false });

    const resolved = resolveRules(config, rules);

    expect(resolved.has('no-console')).toBe(false);
    expect(resolved.has('no-any')).toBe(true);
  });

  it('passes severity and rule options through', () => {
    const rules = [makeRule('no-console', 'core-ts')];
    const config = makeConfig(['core-ts'], {
      'no-console': { severity: 'error', allowedLoggers: ['log'] },
    });

    const resolved = resolveRules(config, rules);
    const settings = resolved.get('no-console');

    expect(settings).toBeDefined();
    expect(settings?.severity).toBe('error');
    expect(settings?.allowedLoggers).toEqual(['log']);
  });

  it('throws UNKNOWN_RULE for a rule id not in availableRules', () => {
    const rules = [makeRule('no-any', 'core-ts')];
    const config = makeConfig([], { 'no-such-rule': { severity: 'error' } });

    try {
      resolveRules(config, rules);
      throw new Error('resolveRules should have thrown');
    } catch (err) {
      assertConfigError(err);
      expect(err.code).toBe('UNKNOWN_RULE');
      expect(err.message).toMatch(/no-such-rule/);
    }
  });

  it('can enable a rule through an override alone', () => {
    const rules = [makeRule('no-any', 'core-ts', 'warning')];
    const config = makeConfig([], { 'no-any': { severity: 'error' } });

    const resolved = resolveRules(config, rules);

    expect(resolved.get('no-any')?.severity).toBe('error');
  });
});
