import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { renderSarif } from '../../src/report/sarif.js';
import { isUnknownArray } from '../../src/guards.js';
import type { RunReport } from '../../src/report/types.js';
import type { RuleGuidance, Severity, Violation } from '../../src/protocol/index.js';

const repoRoot = process.cwd();

function makeViolation(props: {
  ruleId: string;
  message: string;
  file: string;
  line: number;
  column: number;
  severity: Severity;
  guidance?: RuleGuidance;
}): Violation {
  return {
    ruleId: props.ruleId,
    message: props.message,
    file: props.file,
    line: props.line,
    column: props.column,
    severity: props.severity,
    snippet: 'x',
    ...(props.guidance !== undefined ? { guidance: props.guidance } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isUnknownArray(value);
}

function assertArray(value: unknown): asserts value is unknown[] {
  if (!isUnknownArray(value)) {
    throw new Error(`Expected an array, got ${typeof value}`);
  }
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected a record, got ${typeof value}`);
  }
}

function defined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

function getRun(log: Record<string, unknown>): Record<string, unknown> {
  const runs = log.runs;
  assertArray(runs);
  const run = defined(runs[0], 'expected a run');
  assertRecord(run);
  return run;
}

function getToolDriver(run: Record<string, unknown>): Record<string, unknown> {
  const tool = run.tool;
  assertRecord(tool);
  const driver = tool.driver;
  assertRecord(driver);
  return driver;
}

function getRule(driver: Record<string, unknown>, ruleId: string): Record<string, unknown> {
  const rules = driver.rules;
  assertArray(rules);
  for (const raw of rules) {
    assertRecord(raw);
    if (raw.id === ruleId) {
      return raw;
    }
  }
  throw new Error(`rule ${ruleId} not found in SARIF rules`);
}

function getResult(run: Record<string, unknown>, index: number): Record<string, unknown> {
  const results = run.results;
  assertArray(results);
  const result = defined(results[index], `expected result at index ${index}`);
  assertRecord(result);
  return result;
}

function getResultLocation(result: Record<string, unknown>): Record<string, unknown> {
  const locations = result.locations;
  assertArray(locations);
  const location = defined(locations[0], 'expected a location');
  assertRecord(location);
  const physicalLocation = location.physicalLocation;
  assertRecord(physicalLocation);
  return physicalLocation;
}

describe('sarif reporter', () => {
  it('produces valid SARIF 2.1.0 with the expected schema and version', () => {
    const report: RunReport = {
      violations: [],
      skipped: [],
      diagnostics: [],
      filesChecked: 0,
      mode: 'project',
      projectRulesSkipped: [],
      strict: false,
    };

    const raw: unknown = JSON.parse(renderSarif(report, repoRoot));
    assertRecord(raw);

    expect(raw.version).toBe('2.1.0');
    expect(raw.$schema).toBe('https://json.schemastore.org/sarif-2.1.0.json');

    const run = getRun(raw);
    const tool = run.tool;
    assertRecord(tool);
    const driver = tool.driver;
    assertRecord(driver);
    expect(driver.name).toBe('checkyourvibe');
    expect(typeof driver.informationUri).toBe('string');
  });

  it('carries notFixes in rule help.markdown', () => {
    const notFixes = [
      { pattern: 'use an as cast', because: 'it only hides the underlying any', rule: 'no-as-cast' },
      { pattern: 'widen to unknown', because: 'the code still needs narrowing' },
    ];

    const guidance: RuleGuidance = {
      summary: 'Avoid any because it erases type information.',
      why: 'An explicit any prevents the compiler from catching mistakes.',
      allowedFixes: ['Give the value a concrete type', 'Use unknown and narrow it'],
      notFixes,
      examples: { bad: 'const x: any = 1;', good: 'const x: number = 1;' },
    };

    const report: RunReport = {
      violations: [
        makeViolation({
          ruleId: 'no-any',
          message: 'Do not use any.',
          file: path.join(repoRoot, 'src/a.ts'),
          line: 3,
          column: 5,
          severity: 'error',
          guidance,
        }),
      ],
      skipped: [],
      diagnostics: [],
      filesChecked: 1,
      mode: 'project',
      projectRulesSkipped: [],
      strict: false,
    };

    const raw: unknown = JSON.parse(renderSarif(report, repoRoot));
    assertRecord(raw);
    const run = getRun(raw);
    const driver = getToolDriver(run);
    const rule = getRule(driver, 'no-any');
    const help = rule.help;
    assertRecord(help);
    const markdown = help.markdown;
    expect(typeof markdown).toBe('string');
    const markdownText = String(markdown);
    expect(markdownText).toContain('Allowed fixes');
    expect(markdownText).toContain('Do not');
    expect(markdownText).toContain('use an as cast');
    expect(markdownText).toContain('no-as-cast');
    expect(markdownText).toContain('widen to unknown');
  });

  it('uses repo-relative URIs in result locations', () => {
    const guidance: RuleGuidance = {
      summary: 'Avoid any.',
      why: 'Any is unsafe.',
      allowedFixes: ['Use a concrete type'],
      notFixes: [],
      examples: { bad: 'const x: any = 1;', good: 'const x: number = 1;' },
    };

    const report: RunReport = {
      violations: [
        makeViolation({
          ruleId: 'no-any',
          message: 'Do not use any.',
          file: path.join(repoRoot, 'packages/core/src/a.ts'),
          line: 1,
          column: 1,
          severity: 'error',
          guidance,
        }),
      ],
      skipped: [],
      diagnostics: [],
      filesChecked: 1,
      mode: 'project',
      projectRulesSkipped: [],
      strict: false,
    };

    const raw: unknown = JSON.parse(renderSarif(report, repoRoot));
    assertRecord(raw);
    const run = getRun(raw);
    const result = getResult(run, 0);
    const physicalLocation = getResultLocation(result);
    const artifactLocation = physicalLocation.artifactLocation;
    assertRecord(artifactLocation);
    expect(artifactLocation.uri).toBe('packages/core/src/a.ts');

    const region = physicalLocation.region;
    assertRecord(region);
    expect(region.startLine).toBe(1);
    expect(region.startColumn).toBe(1);
  });

  it('maps severity to SARIF level correctly', () => {
    const guidance: RuleGuidance = {
      summary: 'Summary.',
      why: 'Why.',
      allowedFixes: ['Fix'],
      notFixes: [],
      examples: { bad: 'bad', good: 'good' },
    };

    const report: RunReport = {
      violations: [
        makeViolation({
          ruleId: 'no-any',
          message: 'error one',
          file: path.join(repoRoot, 'a.ts'),
          line: 1,
          column: 1,
          severity: 'error',
          guidance,
        }),
        makeViolation({
          ruleId: 'no-console',
          message: 'warning one',
          file: path.join(repoRoot, 'b.ts'),
          line: 1,
          column: 1,
          severity: 'warning',
          guidance,
        }),
      ],
      skipped: [],
      diagnostics: [],
      filesChecked: 2,
      mode: 'project',
      projectRulesSkipped: [],
      strict: false,
    };

    const raw: unknown = JSON.parse(renderSarif(report, repoRoot));
    assertRecord(raw);
    const run = getRun(raw);
    expect(getResult(run, 0).level).toBe('error');
    expect(getResult(run, 1).level).toBe('warning');
  });

  it('carries analyzer and evidence in rule properties when present', () => {
    const guidance: RuleGuidance = {
      summary: 'Avoid any.',
      why: 'Any is unsafe.',
      allowedFixes: ['Use a concrete type'],
      notFixes: [],
      examples: { bad: 'const x: any = 1;', good: 'const x: number = 1;' },
      evidence: 'semantic',
    };

    const report: RunReport = {
      violations: [
        makeViolation({
          ruleId: 'no-any',
          message: 'Do not use any.',
          file: path.join(repoRoot, 'a.ts'),
          line: 1,
          column: 1,
          severity: 'error',
          guidance,
        }),
      ],
      skipped: [],
      diagnostics: [],
      filesChecked: 1,
      mode: 'project',
      projectRulesSkipped: [],
      strict: false,
      ruleAnalyzers: { 'no-any': 'typescript' },
    };

    const raw: unknown = JSON.parse(renderSarif(report, repoRoot));
    assertRecord(raw);
    const run = getRun(raw);
    const driver = getToolDriver(run);
    const rule = getRule(driver, 'no-any');
    const properties = rule.properties;
    assertRecord(properties);
    expect(properties.analyzer).toBe('typescript');
    expect(properties.evidence).toBe('semantic');
  });

  it('keeps a URI repo-relative when every finding is in one directory', () => {
    // The repository root used to be inferred from the common directory of the
    // reported files. A run over a single file has that file's own directory as
    // its common prefix, so every URI collapsed to a bare basename and pointed
    // at the wrong place in the repository. It is passed in now, and this is the
    // case that proves it.
    const guidance: RuleGuidance = {
      summary: 'Avoid any.',
      why: 'Any is unsafe.',
      allowedFixes: ['Use a concrete type'],
      notFixes: [],
      examples: { bad: 'const x: any = 1;', good: 'const x: number = 1;' },
    };

    const report: RunReport = {
      violations: [
        makeViolation({
          ruleId: 'no-any',
          message: 'Do not use any.',
          file: path.join(repoRoot, 'packages/core/src/deep/only.ts'),
          line: 1,
          column: 1,
          severity: 'error',
          guidance,
        }),
      ],
      skipped: [],
      diagnostics: [],
      filesChecked: 1,
      mode: 'files',
      projectRulesSkipped: [],
      strict: false,
    };

    const raw: unknown = JSON.parse(renderSarif(report, repoRoot));
    assertRecord(raw);
    const artifactLocation = getResultLocation(getResult(getRun(raw), 0)).artifactLocation;
    assertRecord(artifactLocation);
    expect(artifactLocation.uri).toBe('packages/core/src/deep/only.ts');
  });

  it('says it checked nothing rather than reporting a clean run', () => {
    // An empty `results` array is the same shape whether 149 files were checked
    // and found clean or none were checked at all. SARIF consumers render both
    // as "no alerts", so the difference has to be carried where a reader can
    // reach it.
    const report: RunReport = {
      violations: [],
      skipped: [],
      diagnostics: [],
      filesChecked: 0,
      mode: 'files',
      projectRulesSkipped: [],
      strict: false,
      ruleCategories: { 'no-any': 'type-safety' },
    };

    const raw: unknown = JSON.parse(renderSarif(report, repoRoot));
    assertRecord(raw);
    const run = getRun(raw);

    const properties = run.properties;
    assertRecord(properties);
    expect(properties.filesChecked).toBe(0);
    expect(properties.rulesEnabled).toBe(1);

    const invocations = run.invocations;
    assertArray(invocations);
    const invocation = defined(invocations[0], 'expected an invocation');
    assertRecord(invocation);
    const notifications = invocation.toolExecutionNotifications;
    assertArray(notifications);
    const first = defined(notifications[0], 'expected a notification');
    assertRecord(first);
    const message = first.message;
    assertRecord(message);
    expect(String(message.text)).toContain('No files were checked');
  });

  it('carries withheld counts in run properties', () => {
    const report: RunReport = {
      violations: [],
      skipped: [],
      diagnostics: [],
      filesChecked: 170,
      mode: 'project',
      projectRulesSkipped: [],
      strict: false,
      ruleCategories: { 'no-any': 'type-safety' },
      withheldFindings: 673,
      withheldFiles: 170,
      withheldReasons: ['No usable tsconfig.json governs these files.'],
    };

    const raw: unknown = JSON.parse(renderSarif(report, repoRoot));
    assertRecord(raw);
    const run = getRun(raw);

    const properties = run.properties;
    assertRecord(properties);
    expect(properties.withheldFindings).toBe(673);
    expect(properties.withheldFiles).toBe(170);
    const reasons = properties.withheldReasons;
    assertArray(reasons);
    expect(reasons).toContain('No usable tsconfig.json governs these files.');
  });
});
