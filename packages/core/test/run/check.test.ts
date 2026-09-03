import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { runCheck } from '../../src/run/check.js';
import { command as baselineCommand } from '../../src/cli/baseline.js';
import { access } from 'node:fs/promises';
import { configNotice, exitCodeFor, renderJson, renderSarif } from '../../src/report/index.js';
import { isUnknownArray } from '../../src/guards.js';
import type { ConfigOverride } from '../../src/config/index.js';

/**
 * Flags a literal `VIOLATION` marker, leaving `severity` unset so
 * `run/execute.ts` resolves it from the request's rule settings — which is
 * exactly the mechanism that lets a per-file rule override change a
 * violation's severity without the analyzer knowing overrides exist. Also
 * emits one `analyze-called` diagnostic per invocation, so tests can assert
 * on how many `AnalyzeRequest`s a run issued (i.e. how the files were
 * grouped) without needing a side channel outside the request/response
 * protocol.
 */
const ANALYZER_MODULE = `
import { readFileSync } from 'node:fs';

export default async function analyze(request) {
  const violations = [];
  for (const file of request.files) {
    const content = readFileSync(file, 'utf-8');
    if (content.includes('VIOLATION')) {
      violations.push({
        file,
        line: 1,
        column: 1,
        ruleId: 'no-violation-marker',
        message: 'File contains a VIOLATION marker.',
        snippet: 'VIOLATION',
      });
    }
  }
  return {
    protocol: 1,
    violations,
    skipped: [],
    diagnostics: [{ level: 'info', message: 'analyze-called' }],
  };
}
`;

function analyzerManifest(): unknown {
  return {
    protocol: 1,
    id: 'stub',
    match: ['**/*.ts'],
    rules: [
      {
        id: 'no-violation-marker',
        category: 'test',
        scope: 'file',
        severity: 'warning',
        summary: 'Flags an explicit VIOLATION marker left in source.',
        why: 'Keeps this fixture deterministically wrong so tests can assert on it.',
        allowedFixes: ['Remove the VIOLATION marker from the file.'],
        notFixes: [],
        examples: { bad: 'const x = 1; // VIOLATION', good: 'const x = 1;' },
      },
      {
        id: 'project-rule',
        category: 'test',
        scope: 'project',
        severity: 'warning',
        summary: 'A project-scope rule the analyzer never actually flags in these tests.',
        why: 'Exists only so file-mode runs have a project-scope rule to report as skipped.',
        allowedFixes: ['N/A'],
        notFixes: [],
        examples: { bad: 'n/a', good: 'n/a' },
      },
    ],
    exec: { type: 'node', module: './analyzer.mjs' },
  };
}

function config(overrides: ConfigOverride[] = []): unknown {
  return {
    packs: [],
    analyzers: [{ id: 'stub', package: './analyzer.manifest.json' }],
    rules: { 'no-violation-marker': {}, 'project-rule': {} },
    overrides,
    strict: false,
    exclude: [],
  };
}

async function copySchema(repoRoot: string): Promise<void> {
  const schemaUrl = new URL('../../../../docs/protocol/config.schema.json', import.meta.url);
  const schema = await readFile(schemaUrl, 'utf-8');
  const schemaDir = join(repoRoot, 'docs', 'protocol');
  await mkdir(schemaDir, { recursive: true });
  await writeFile(join(schemaDir, 'config.schema.json'), schema);
}

async function makeRepo(): Promise<string> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'cyv-run-check-')));
  const repo = join(parent, 'repo');
  await mkdir(repo, { recursive: true });
  execFileSync('git', ['init'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
  return repo;
}

async function makeConfiguredRepo(overrides: ConfigOverride[] = []): Promise<string> {
  const repo = await makeRepo();
  await copySchema(repo);
  await writeFile(join(repo, 'checkyourvibe.json'), JSON.stringify(config(overrides), null, 2));
  await writeFile(join(repo, 'analyzer.manifest.json'), JSON.stringify(analyzerManifest(), null, 2));
  await writeFile(join(repo, 'analyzer.mjs'), ANALYZER_MODULE);
  return repo;
}

function analyzeCallCount(diagnostics: { level: string; message: string }[]): number {
  return diagnostics.filter((d) => d.message === 'analyze-called').length;
}

function packManifest(id: string, ruleId: string, pack: string, match: string): unknown {
  return {
    protocol: 1,
    id,
    match: [match],
    rules: [
      {
        id: ruleId,
        category: 'test',
        pack,
        scope: 'file',
        severity: 'warning',
        summary: `summary for ${ruleId}`,
        why: `why for ${ruleId}`,
        allowedFixes: ['fix it'],
        notFixes: [],
        examples: { bad: 'bad', good: 'good' },
      },
    ],
    exec: { type: 'node', module: './analyzer.mjs' },
  };
}

function packConfig(packs: string[]): unknown {
  return {
    packs,
    analyzers: [
      { id: 'alpha', package: './alpha.manifest.json' },
      { id: 'beta', package: './beta.manifest.json' },
    ],
    rules: {},
    strict: false,
    exclude: [],
  };
}

async function makePackRepo(packs: string[]): Promise<string> {
  const repo = await makeRepo();
  await copySchema(repo);
  await writeFile(join(repo, 'checkyourvibe.json'), JSON.stringify(packConfig(packs), null, 2));
  await writeFile(join(repo, 'alpha.manifest.json'), JSON.stringify(packManifest('alpha', 'alpha-rule', 'pack-a', '**/*.ts'), null, 2));
  await writeFile(join(repo, 'beta.manifest.json'), JSON.stringify(packManifest('beta', 'beta-rule', 'pack-b', '**/*.cs'), null, 2));
  await writeFile(join(repo, 'analyzer.mjs'), ANALYZER_MODULE);
  return repo;
}

describe('runCheck', () => {
  it('attaches guidance to every violation, from the rule manifest', async () => {
    const repo = await makeConfiguredRepo();
    try {
      const srcDir = join(repo, 'src');
      await mkdir(srcDir, { recursive: true });
      const sourcePath = join(srcDir, 'thing.ts');
      await writeFile(sourcePath, 'export const value = 1; // VIOLATION\n');

      const { report } = await runCheck({ cwd: repo, mode: 'files', paths: [sourcePath] });

      expect(report.violations).toHaveLength(1);
      const violation = report.violations[0];
      expect(violation?.guidance).toBeDefined();
      expect(violation?.guidance?.summary).toBe('Flags an explicit VIOLATION marker left in source.');
      expect(violation?.guidance?.allowedFixes).toEqual(['Remove the VIOLATION marker from the file.']);
      expect(violation?.guidance?.examples).toEqual({
        bad: 'const x = 1; // VIOLATION',
        good: 'const x = 1;',
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('applies the base rule set, and groups every file into a single request, when there are no overrides', async () => {
    const repo = await makeConfiguredRepo();
    try {
      const srcDir = join(repo, 'src');
      await mkdir(srcDir, { recursive: true });
      const a = join(srcDir, 'a.ts');
      const b = join(srcDir, 'b.ts');
      await writeFile(a, 'export const value = 1; // VIOLATION\n');
      await writeFile(b, 'export const value = 2; // VIOLATION\n');

      const { report } = await runCheck({ cwd: repo, mode: 'files', paths: [a, b] });

      expect(report.violations).toHaveLength(2);
      for (const violation of report.violations) {
        expect(violation.severity).toBe('warning');
      }
      // No override touches either file, so both share the base rule set and
      // the analyzer must have been invoked exactly once for the whole batch.
      expect(analyzeCallCount(report.diagnostics)).toBe(1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('applies an override only to matching files, merging both groups into one report', async () => {
    const overrides: ConfigOverride[] = [
      {
        files: ['special/**'],
        reason: 'Escalate severity for this directory in this test.',
        rules: { 'no-violation-marker': { severity: 'error' } },
      },
    ];
    const repo = await makeConfiguredRepo(overrides);
    try {
      const srcDir = join(repo, 'src');
      const specialDir = join(repo, 'special');
      await mkdir(srcDir, { recursive: true });
      await mkdir(specialDir, { recursive: true });
      const basePath = join(srcDir, 'thing.ts');
      const specialPath = join(specialDir, 'other.ts');
      await writeFile(basePath, 'export const value = 1; // VIOLATION\n');
      await writeFile(specialPath, 'export const value = 2; // VIOLATION\n');

      const { report } = await runCheck({ cwd: repo, mode: 'files', paths: [basePath, specialPath] });

      expect(report.violations).toHaveLength(2);
      const bySeverity = new Map(report.violations.map((v) => [v.file, v.severity]));
      expect(bySeverity.get(basePath)).toBe('warning');
      expect(bySeverity.get(specialPath)).toBe('error');

      // Two distinct effective rule sets among the routed files must produce
      // two `AnalyzeRequest`s, not one.
      expect(analyzeCallCount(report.diagnostics)).toBe(2);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('reports projectRulesSkipped in file mode', async () => {
    const repo = await makeConfiguredRepo();
    try {
      const srcDir = join(repo, 'src');
      await mkdir(srcDir, { recursive: true });
      const sourcePath = join(srcDir, 'thing.ts');
      await writeFile(sourcePath, 'export const value = 1;\n');

      const { report } = await runCheck({ cwd: repo, mode: 'files', paths: [sourcePath] });

      expect(report.mode).toBe('files');
      expect(report.projectRulesSkipped).toContain('project-rule');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('reports a zero-file selection rather than silently passing', async () => {
    const repo = await makeConfiguredRepo();
    try {
      const { report } = await runCheck({ cwd: repo, mode: 'files', paths: [] });

      expect(report.filesChecked).toBe(0);
      expect(report.violations).toEqual([]);
      expect(report.mode).toBe('files');
      expect(report.diagnostics.some((d) => /No paths provided/.test(d.message))).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('reports the enabled and available rule counts with two analyzers and two packs', async () => {
    const repo = await makePackRepo(['pack-a', 'pack-b']);
    try {
      const { report } = await runCheck({ cwd: repo, mode: 'all' });

      expect(report.rulesEnabled).toBe(2);
      expect(report.rulesAvailable).toBe(2);
      expect(report.unknownPacks).toEqual([]);
      expect(report.zeroContributionAnalyzers).toEqual([]);
      expect(configNotice(report)).toContain('2 of 2 rules enabled');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('reports a pack in config that no loaded analyzer provides', async () => {
    const repo = await makePackRepo(['pack-a', 'unknown-pack']);
    try {
      const { report } = await runCheck({ cwd: repo, mode: 'all' });

      expect(report.rulesEnabled).toBe(1);
      expect(report.rulesAvailable).toBe(2);
      expect(report.unknownPacks).toEqual(['unknown-pack']);
      expect(configNotice(report)).toContain('unknown-pack');
      expect(exitCodeFor(report)).toBe(2);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('reports a loaded analyzer that contributes zero enabled rules', async () => {
    const repo = await makePackRepo(['pack-a']);
    try {
      const { report } = await runCheck({ cwd: repo, mode: 'all' });

      expect(report.rulesEnabled).toBe(1);
      expect(report.rulesAvailable).toBe(2);
      expect(report.zeroContributionAnalyzers).toEqual(['beta']);
      expect(configNotice(report)).toContain('beta');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('does not exit 0 when the configuration expands to zero rules', async () => {
    const repo = await makePackRepo([]);
    try {
      const { report } = await runCheck({ cwd: repo, mode: 'all' });

      expect(report.rulesEnabled).toBe(0);
      expect(report.rulesAvailable).toBe(2);
      expect(report.zeroContributionAnalyzers).toEqual(['alpha', 'beta']);
      expect(exitCodeFor(report)).toBe(2);
      expect(configNotice(report)).toContain('No rules are enabled');
      expect(configNotice(report)).toContain('That is not a clean bill of health');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  /**
   * Selecting `core-ts` and `core-cs` leaves the rules those analyzers ship in
   * other packs available but not enabled, and the notice has to report that
   * gap honestly. The counts are read from the report rather than hardcoded:
   * the previous version of this test asserted "13 of 17", which every new rule
   * broke, and a test that fails on unrelated work gets its number bumped
   * without anyone reading what it was for.
   */
  it('reports fewer rules enabled than available when packs exclude some, and the notice agrees', async () => {
    const realRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    const repo = await makeRepo();
    try {
      await copySchema(repo);
      const repoConfig = {
        packs: ['core-ts', 'core-cs'],
        analyzers: [
          { id: 'typescript', package: join(realRoot, 'packages/analyzer-typescript/analyzer.manifest.json') },
          { id: 'csharp', package: join(realRoot, 'packages/analyzer-csharp/analyzer.manifest.json') },
        ],
        rules: {},
        strict: false,
        exclude: [],
      };
      await writeFile(join(repo, 'checkyourvibe.json'), JSON.stringify(repoConfig, null, 2));

      const { report } = await runCheck({ cwd: repo, mode: 'all' });

      expect(report.rulesEnabled).toBeGreaterThan(0);
      expect(report.rulesAvailable).toBeGreaterThan(report.rulesEnabled);
      expect(configNotice(report)).toContain(
        `${report.rulesEnabled} of ${report.rulesAvailable} rules enabled`,
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('continues with other analyzers when a process analyzer command is missing', async () => {
    const repo = await makePackRepo(['pack-a', 'pack-b']);
    try {
      const srcDir = join(repo, 'src');
      const csDir = join(repo, 'cs');
      await mkdir(srcDir, { recursive: true });
      await mkdir(csDir, { recursive: true });
      await writeFile(join(srcDir, 'thing.ts'), 'export const value = 1;\n');
      await writeFile(join(csDir, 'thing.cs'), 'class Thing {}\n');

      await writeFile(
        join(repo, 'beta.manifest.json'),
        JSON.stringify(
          {
            protocol: 1,
            id: 'beta',
            match: ['**/*.cs'],
            rules: [
              {
                id: 'beta-rule',
                category: 'test',
                pack: 'pack-b',
                scope: 'file',
                severity: 'warning',
                summary: 'summary for beta-rule',
                why: 'why for beta-rule',
                allowedFixes: ['fix it'],
                notFixes: [],
                examples: { bad: 'bad', good: 'good' },
              },
            ],
            exec: { type: 'process', command: 'cyv-missing-process-command' },
          },
          null,
          2,
        ),
      );

      const { report } = await runCheck({ cwd: repo, mode: 'all' });

      expect(report.filesChecked).toBe(1);
      expect(report.violations).toEqual([]);
      expect(report.skipped).toHaveLength(1);
      expect(report.skipped[0]?.file).toContain('thing.cs');
      expect(report.skipped[0]?.reason).toContain('cyv-missing-process-command');
      expect(report.diagnostics.some((d) => d.level === 'error' && d.message.includes('cyv-missing-process-command'))).toBe(true);
      expect(report.strict).toBe(true);
      expect(exitCodeFor(report)).toBe(1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  describe('degraded type resolution', () => {
    const DEGRADED_ANALYZER_MODULE = `
import { basename } from 'node:path';

export default async function analyze(request) {
  const violations = [];
  const degraded = [];
  for (const file of request.files) {
    const name = basename(file);
    const isDegraded = name.startsWith('degraded-');
    if (isDegraded) {
      degraded.push({
        files: [file],
        reason: 'No usable tsconfig.json governs these files.',
      });
    }
    for (const ruleId of Object.keys(request.rules)) {
      violations.push({
        file,
        line: 1,
        column: 1,
        ruleId,
        message: 'Flagged ' + ruleId,
        snippet: 'x',
      });
    }
  }
  const response = { protocol: 1, violations, skipped: [], diagnostics: [] };
  return degraded.length > 0 ? { ...response, degraded } : response;
}
`;

    function isRecord(value: unknown): value is Record<string, unknown> {
      return typeof value === 'object' && value !== null && !isUnknownArray(value);
    }

    function degradedManifest(): unknown {
      return {
        protocol: 1,
        id: 'degraded-stub',
        match: ['**/*.ts'],
        rules: [
          {
            id: 'semantic-rule',
            category: 'test',
            scope: 'file',
            severity: 'warning',
            evidence: 'semantic',
            summary: 'A semantic rule.',
            why: 'Needs types.',
            allowedFixes: ['Fix it.'],
            notFixes: [],
            examples: { bad: 'bad', good: 'good' },
          },
          {
            id: 'syntax-rule',
            category: 'test',
            scope: 'file',
            severity: 'warning',
            evidence: 'syntax',
            summary: 'A syntax rule.',
            why: 'Matches shape.',
            allowedFixes: ['Fix it.'],
            notFixes: [],
            examples: { bad: 'bad', good: 'good' },
          },
          {
            id: 'unspecified-rule',
            category: 'test',
            scope: 'file',
            severity: 'warning',
            summary: 'A rule with no evidence.',
            why: 'Unknown confidence.',
            allowedFixes: ['Fix it.'],
            notFixes: [],
            examples: { bad: 'bad', good: 'good' },
          },
        ],
        exec: { type: 'node', module: './analyzer.mjs' },
      };
    }

    function degradedConfig(): unknown {
      return {
        packs: [],
        analyzers: [{ id: 'degraded-stub', package: './analyzer.manifest.json' }],
        rules: {
          'semantic-rule': {},
          'syntax-rule': {},
          'unspecified-rule': {},
        },
        strict: false,
        exclude: [],
      };
    }

    async function makeDegradedRepo(): Promise<string> {
      const repo = await makeRepo();
      await copySchema(repo);
      await writeFile(join(repo, 'checkyourvibe.json'), JSON.stringify(degradedConfig(), null, 2));
      await writeFile(
        join(repo, 'analyzer.manifest.json'),
        JSON.stringify(degradedManifest(), null, 2),
      );
      await writeFile(join(repo, 'analyzer.mjs'), DEGRADED_ANALYZER_MODULE);
      return repo;
    }

    it('withholds semantic and unspecified findings for degraded files but keeps syntax findings', async () => {
      const repo = await makeDegradedRepo();
      try {
        const srcDir = join(repo, 'src');
        await mkdir(srcDir, { recursive: true });
        const degradedPath = join(srcDir, 'degraded-a.ts');
        const cleanPath = join(srcDir, 'clean-a.ts');
        await writeFile(degradedPath, 'export const a = 1;\n');
        await writeFile(cleanPath, 'export const b = 2;\n');

        const { report } = await runCheck({ cwd: repo, mode: 'files', paths: [degradedPath, cleanPath] });

        const keptRuleIds = new Set(report.violations.map((v) => v.ruleId));

        expect(report.violations).toHaveLength(4);
        expect(keptRuleIds.has('syntax-rule')).toBe(true);
        expect(keptRuleIds.has('semantic-rule')).toBe(true);
        expect(keptRuleIds.has('unspecified-rule')).toBe(true);

        const degradedViolations = report.violations.filter((v) => v.file === degradedPath);
        expect(degradedViolations).toHaveLength(1);
        expect(degradedViolations[0]?.ruleId).toBe('syntax-rule');

        expect(report.withheldFindings).toBe(2);
        expect(report.withheldFiles).toBe(1);
        expect(report.withheldReasons).toContain('No usable tsconfig.json governs these files.');
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    it('does not affect non-degraded files in the same run', async () => {
      const repo = await makeDegradedRepo();
      try {
        const srcDir = join(repo, 'src');
        await mkdir(srcDir, { recursive: true });
        const degradedPath = join(srcDir, 'degraded-a.ts');
        const cleanPath = join(srcDir, 'clean-a.ts');
        await writeFile(degradedPath, 'export const a = 1;\n');
        await writeFile(cleanPath, 'export const b = 2;\n');

        const { report } = await runCheck({ cwd: repo, mode: 'files', paths: [degradedPath, cleanPath] });

        const cleanViolations = report.violations.filter((v) => v.file === cleanPath);
        expect(cleanViolations).toHaveLength(3);
        expect(cleanViolations.some((v) => v.ruleId === 'semantic-rule')).toBe(true);
        expect(cleanViolations.some((v) => v.ruleId === 'syntax-rule')).toBe(true);
        expect(cleanViolations.some((v) => v.ruleId === 'unspecified-rule')).toBe(true);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    it('reports the withheld count in the notice, JSON, SARIF, and exit code', async () => {
      const repo = await makeDegradedRepo();
      try {
        const srcDir = join(repo, 'src');
        await mkdir(srcDir, { recursive: true });
        const degradedPath = join(srcDir, 'degraded-a.ts');
        await writeFile(degradedPath, 'export const a = 1;\n');

        const { report, repoRoot } = await runCheck({ cwd: repo, mode: 'files', paths: [degradedPath] });

        expect(report.withheldFindings).toBe(2);
        expect(report.withheldFiles).toBe(1);
        expect(report.withheldReasons).toContain('No usable tsconfig.json governs these files.');

        const notice = configNotice(report);
        expect(notice).toContain('2 findings withheld from 1 file');
        expect(notice).toContain('No usable tsconfig.json governs these files.');

        const json: unknown = JSON.parse(renderJson(report));
        if (!isRecord(json)) {
          throw new Error('JSON output is not an object');
        }
        expect(json.withheldFindings).toBe(2);
        expect(json.withheldFiles).toBe(1);
        const jsonReasons = json.withheldReasons;
        if (!isUnknownArray(jsonReasons)) {
          throw new Error('JSON withheldReasons is not an array');
        }
        expect(jsonReasons).toContain('No usable tsconfig.json governs these files.');

        const raw: unknown = JSON.parse(renderSarif(report, repoRoot));
        if (!isRecord(raw)) {
          throw new Error('SARIF output is not an object');
        }
        const runs = raw.runs;
        if (!isUnknownArray(runs) || runs.length === 0) {
          throw new Error('SARIF output has no runs');
        }
        const run = runs[0];
        if (!isRecord(run)) {
          throw new Error('SARIF run is not an object');
        }
        const properties = run.properties;
        if (!isRecord(properties)) {
          throw new Error('SARIF properties is not an object');
        }
        expect(properties.withheldFindings).toBe(2);
        expect(properties.withheldFiles).toBe(1);
        const reasons = properties.withheldReasons;
        if (!isUnknownArray(reasons)) {
          throw new Error('SARIF withheldReasons is not an array');
        }
        expect(reasons).toContain('No usable tsconfig.json governs these files.');

        expect(exitCodeFor(report)).toBe(1);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    it('behaves as before when no files are degraded', async () => {
      const repo = await makeDegradedRepo();
      try {
        const srcDir = join(repo, 'src');
        await mkdir(srcDir, { recursive: true });
        const cleanPath = join(srcDir, 'clean-a.ts');
        await writeFile(cleanPath, 'export const b = 2;\n');

        const { report } = await runCheck({ cwd: repo, mode: 'files', paths: [cleanPath] });

        expect(report.violations).toHaveLength(3);
        expect(report.withheldFindings).toBeUndefined();
        expect(report.withheldFiles).toBeUndefined();
        expect(report.withheldReasons).toBeUndefined();
        expect(exitCodeFor(report)).toBe(0);
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });

    // Withheld findings are absent from the report, so a baseline taken here
    // would omit them and report them as new once the configuration is fixed.
    it('refuses to write a baseline while findings are withheld', async () => {
      const repo = await makeDegradedRepo();
      const errors: string[] = [];
      const errorSpy = vi.spyOn(console, 'error').mockImplementation((line: string) => {
        errors.push(line);
      });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        const srcDir = join(repo, 'src');
        await mkdir(srcDir, { recursive: true });
        await writeFile(join(srcDir, 'degraded-a.ts'), 'export const a = 1;\n');

        const code = await baselineCommand.run({ cwd: repo, argv: ['--yes'], env: process.env });

        expect(code).toBe(2);
        expect(errors.join('\n')).toContain('type resolution was degraded');
        await expect(access(join(repo, 'checkyourvibe.baseline.json'))).rejects.toThrow();
      } finally {
        errorSpy.mockRestore();
        logSpy.mockRestore();
        await rm(repo, { recursive: true, force: true });
      }
    });
  });
});
