import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import analyze, { manifestRules } from '../src/index.js';
import type { AnalyzeRequest, RuleSettings } from '@checkyourvibe/core';
import { allTsRules } from '../src/rules/index.js';

const MANIFEST_PATH = fileURLToPath(new URL('../analyzer.manifest.json', import.meta.url));

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

function assertDefined<T>(value: T | undefined, message: string): asserts value is T {
  if (value === undefined) {
    throw new Error(message);
  }
}

describe('analyze', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cyv-analyze-'));
    writeTsConfig(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('analyzes a file and reports violations from several different rules', async () => {
    const file = join(dir, 'bad.ts');
    writeFileSync(
      file,
      [
        'const value: any = 1;',
        'const total = value as number;',
        'function f(x: string | undefined) { return x!; }',
        "console.log('debug');",
        '',
      ].join('\n'),
    );

    const response = await analyze(
      request(dir, [file], {
        'no-any': { severity: 'error' },
        'no-as-cast': { severity: 'error' },
        'no-non-null-assertion': { severity: 'error' },
        'no-console': { severity: 'warning' },
      }),
    );

    expect(response.protocol).toBe(1);
    expect(response.skipped).toHaveLength(0);
    expect(response.diagnostics).toHaveLength(0);

    const ruleIds = new Set(response.violations.map((violation) => violation.ruleId));
    expect(ruleIds.has('no-any')).toBe(true);
    expect(ruleIds.has('no-as-cast')).toBe(true);
    expect(ruleIds.has('no-non-null-assertion')).toBe(true);
    expect(ruleIds.has('no-console')).toBe(true);
  });

  it('overrides a violation severity with the severity from request.rules', async () => {
    const file = join(dir, 'severity.ts');
    writeFileSync(file, "console.log('debug');\n");

    // The rule's own manifest default is 'warning'; the request asks for 'error'.
    const response = await analyze(
      request(dir, [file], {
        'no-console': { severity: 'error' },
      }),
    );

    expect(response.violations.length).toBeGreaterThan(0);
    for (const violation of response.violations) {
      expect(violation.severity).toBe('error');
    }
  });

  it('does not run a rule whose id is absent from request.rules', async () => {
    const file = join(dir, 'only-console.ts');
    writeFileSync(file, "const value: any = 1;\nconsole.log('debug');\n");

    const response = await analyze(
      request(dir, [file], {
        'no-console': { severity: 'warning' },
      }),
    );

    const ruleIds = new Set(response.violations.map((violation) => violation.ruleId));
    expect(ruleIds.has('no-console')).toBe(true);
    expect(ruleIds.has('no-any')).toBe(false);
  });

  it('puts a nonexistent input path into skipped rather than throwing', async () => {
    const missing = join(dir, 'missing.ts');

    const response = await analyze(
      request(dir, [missing], { 'no-any': { severity: 'error' } }),
    );

    expect(response.skipped).toHaveLength(1);
    const skipped = response.skipped[0];
    assertDefined(skipped, 'expected one skipped file');
    expect(skipped.file).toBe(missing);
    expect(response.violations).toHaveLength(0);
  });

  it('reaches the rule with its options: no-console allowedMethods changes the result', async () => {
    const file = join(dir, 'console.ts');
    writeFileSync(file, "console.warn('caution');\n");

    const withoutAllowedMethods = await analyze(
      request(dir, [file], { 'no-console': { severity: 'warning' } }),
    );
    const withAllowedMethods = await analyze(
      request(dir, [file], {
        'no-console': { severity: 'warning', allowedMethods: ['warn'] },
      }),
    );

    expect(withoutAllowedMethods.violations.some((v) => v.ruleId === 'no-console')).toBe(true);
    expect(withAllowedMethods.violations.some((v) => v.ruleId === 'no-console')).toBe(false);
  });

  it('exports manifest metadata for every rule the pack ships', () => {
    // Asserting the SET, not a count. A magic number breaks on every rule added
    // and proves nothing beyond arithmetic; this proves the exported metadata
    // covers exactly the rules that actually run.
    expect(manifestRules.length).toBe(allTsRules.length);
    expect(manifestRules.map((r) => r.id).sort()).toEqual(
      allTsRules.map((r) => r.manifest.id).sort(),
    );
  });
});

interface ManifestExamples {
  readonly bad: string;
  readonly good: string;
}

interface ManifestNotFix {
  readonly pattern: string;
  readonly because: string;
  readonly rule?: string;
}

interface ManifestRuleEntry {
  readonly id: string;
  readonly summary: string;
  readonly why: string;
  readonly examples: ManifestExamples;
  readonly allowedFixes: readonly string[];
  readonly notFixes: readonly ManifestNotFix[];
}

interface StaticAnalyzerManifest {
  readonly protocol: number;
  readonly rules: readonly ManifestRuleEntry[];
}

// `Array.isArray` narrows to `any[]` in the standard lib typings, which would
// smuggle an inferred `any` into `rules.every`'s callback parameter below.
// Wrapping it keeps the narrowed element type at `unknown` instead.
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

// A hand-written guard rather than a cast, because `no-json-parse-cast`
// requires parsed JSON to be checked before it is treated as a given shape,
// and this file is not exempt from the rule it tests.
function isStaticAnalyzerManifest(value: unknown): value is StaticAnalyzerManifest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('protocol' in value) || !('rules' in value)) {
    return false;
  }
  const { protocol, rules } = value;
  if (typeof protocol !== 'number' || !isUnknownArray(rules)) {
    return false;
  }
  return rules.every((rule): rule is ManifestRuleEntry => {
    if (typeof rule !== 'object' || rule === null) {
      return false;
    }
    if (!('id' in rule) || !('summary' in rule) || !('why' in rule) || !('examples' in rule)) {
      return false;
    }
    if (!('allowedFixes' in rule) || !('notFixes' in rule)) {
      return false;
    }
    if (
      typeof rule.id !== 'string' ||
      typeof rule.summary !== 'string' ||
      typeof rule.why !== 'string'
    ) {
      return false;
    }
    if (!isStringArray(rule.allowedFixes) || !isManifestNotFixArray(rule.notFixes)) {
      return false;
    }
    return isManifestExamples(rule.examples);
  });
}

function isStringArray(value: unknown): value is string[] {
  return isUnknownArray(value) && value.every((item) => typeof item === 'string');
}

function isManifestNotFix(value: unknown): value is ManifestNotFix {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('pattern' in value) || !('because' in value)) {
    return false;
  }
  if (typeof value.pattern !== 'string' || typeof value.because !== 'string') {
    return false;
  }
  return !('rule' in value) || value.rule === undefined || typeof value.rule === 'string';
}

function isManifestNotFixArray(value: unknown): value is ManifestNotFix[] {
  return isUnknownArray(value) && value.every(isManifestNotFix);
}

function isManifestExamples(value: unknown): value is ManifestExamples {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('bad' in value) || !('good' in value)) {
    return false;
  }
  return typeof value.bad === 'string' && typeof value.good === 'string';
}

describe('analyzer.manifest.json', () => {
  it('parses as JSON, declares protocol 1, and lists exactly the exported rules', () => {
    const raw = readFileSync(MANIFEST_PATH, 'utf8');
    const parsed: unknown = JSON.parse(raw);

    expect(isStaticAnalyzerManifest(parsed)).toBe(true);
    if (!isStaticAnalyzerManifest(parsed)) {
      throw new Error('unreachable: asserted above');
    }

    expect(parsed.protocol).toBe(1);

    const manifestIds = parsed.rules.map((rule) => rule.id).sort();
    const exportedIds = manifestRules.map((rule) => rule.id).sort();
    expect(manifestIds).toEqual(exportedIds);
  });

  // The static file is what an installed copy of the analyzer ships and what
  // `cyv explain` reads; the exported rules are what actually runs. When a rule's
  // reasoning or its examples are revised in one and not the other, the guidance
  // an agent receives stops describing the rule that reported the finding.
  // The remediation guidance is included for the same reason as the prose, and it
  // is the half that costs most when it drifts: the hook prints the rule source's
  // `notFixes` and `cyv explain` prints the JSON's, so a rule can tell an agent
  // that a change is a dead end in one surface and say nothing in the other.
  // `no-module-augmentation` shipped exactly that way — `notFixes: []` in the
  // source while the JSON carried guidance — and nothing failed, because this
  // assertion covered only summary, why and examples.
  it('carries the same summary, why, examples and remediation guidance as the rules that run', () => {
    const raw = readFileSync(MANIFEST_PATH, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isStaticAnalyzerManifest(parsed)) {
      throw new Error('analyzer.manifest.json is not a valid analyzer manifest');
    }

    const staticText = new Map(
      parsed.rules.map((rule) => [
        rule.id,
        {
          summary: rule.summary,
          why: rule.why,
          examples: rule.examples,
          allowedFixes: rule.allowedFixes,
          notFixes: rule.notFixes,
        },
      ]),
    );
    const exportedText = new Map(
      manifestRules.map((rule) => [
        rule.id,
        {
          summary: rule.summary,
          why: rule.why,
          examples: rule.examples,
          allowedFixes: rule.allowedFixes,
          notFixes: rule.notFixes,
        },
      ]),
    );

    expect(Object.fromEntries(staticText)).toEqual(Object.fromEntries(exportedText));
  });
});
