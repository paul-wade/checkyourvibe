import { describe, expect, it } from 'vitest';
import {
  configNotice,
  exitCodeFor,
  renderJson,
  renderText,
  renderTextPlain,
} from '../../src/report/index.js';
import { isUnknownArray } from '../../src/guards.js';
import type { Violation, SkippedFile, Diagnostic } from '../../src/protocol/index.js';
import type { RunReport } from '../../src/report/types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isUnknownArray(value);
}

const guidance: NonNullable<Violation['guidance']> = {
  summary: 'Avoid any because it erases type information.',
  why: 'An explicit any prevents the compiler from catching mistakes.',
  allowedFixes: ['Give the value a concrete type', 'Use unknown and narrow it'],
  notFixes: [
    { pattern: 'widen to unknown', because: 'the code still needs narrowing before use', rule: 'no-unknown' },
    { pattern: 'use an as cast', because: 'it only hides the underlying any' },
  ],
  examples: {
    bad: 'const x: any = 1;',
    good: 'const x: number = 1;',
  },
};

type MakeViolationInput = Partial<Violation> &
  Required<Pick<Violation, 'ruleId' | 'message' | 'line' | 'column' | 'file' | 'severity'>>;

function makeViolation(props: MakeViolationInput): Violation {
  return { snippet: 'x', ...props };
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Two rules in two categories, unevenly weighted, across two files. */
function mixedReport(): RunReport {
  return {
    violations: [
      makeViolation({
        file: '/project/b.ts',
        line: 1,
        column: 10,
        ruleId: 'no-console',
        message: 'console in b',
        severity: 'warning',
      }),
      makeViolation({
        file: '/project/a.ts',
        line: 2,
        column: 5,
        ruleId: 'no-console',
        message: 'console in a',
        severity: 'warning',
      }),
      makeViolation({
        file: '/project/a.ts',
        line: 2,
        column: 1,
        ruleId: 'no-console',
        message: 'console in a first',
        severity: 'warning',
      }),
      makeViolation({
        file: '/project/a.ts',
        line: 1,
        column: 1,
        ruleId: 'no-any',
        message: 'any in a',
        severity: 'error',
      }),
    ],
    skipped: [],
    diagnostics: [],
    filesChecked: 3,
    mode: 'file',
    projectRulesSkipped: [],
    strict: false,
    ruleCategories: { 'no-console': 'style', 'no-any': 'type-safety' },
  };
}

/** One rule, `count` findings carrying the same guidance, one file each. */
function repeatedReport(count: number): RunReport {
  const violations: Violation[] = [];
  for (let i = 0; i < count; i++) {
    violations.push(
      makeViolation({
        file: `/project/file-${String(i).padStart(3, '0')}.ts`,
        line: i + 1,
        column: 1,
        ruleId: 'no-any',
        message: 'Do not use any.',
        severity: 'error',
        guidance,
      }),
    );
  }
  return {
    violations,
    skipped: [],
    diagnostics: [],
    filesChecked: count,
    mode: 'all',
    projectRulesSkipped: [],
    strict: false,
    ruleCategories: { 'no-any': 'type-safety' },
  };
}

describe('text reporter', () => {
  it('reports a zero-file run loudly', () => {
    const report: RunReport = {
      violations: [],
      skipped: [],
      diagnostics: [],
      filesChecked: 0,
      mode: 'file',
      projectRulesSkipped: [],
      strict: false,
    };
    const text = renderTextPlain(report);
    expect(text).toContain('No files were matched by this run; this is not a pass.');
    expect(text).toContain('0 files checked');
  });

  it('lists every skipped file with its reason', () => {
    const skipped: SkippedFile[] = [
      { file: '/project/bad.ts', reason: 'parse error' },
      { file: '/project/missing.ts', reason: 'file not found' },
    ];
    const report: RunReport = {
      violations: [],
      skipped,
      diagnostics: [],
      filesChecked: 2,
      mode: 'file',
      projectRulesSkipped: [],
      strict: false,
    };
    const text = renderTextPlain(report);
    for (const { file, reason } of skipped) {
      expect(text).toContain(`${file} — ${reason}`);
    }
    expect(text).not.toContain('Strict mode is on');
  });

  it('says skipped files fail the run when strict is set', () => {
    const report: RunReport = {
      violations: [],
      skipped: [{ file: '/project/bad.ts', reason: 'parse error' }],
      diagnostics: [],
      filesChecked: 1,
      mode: 'file',
      projectRulesSkipped: [],
      strict: true,
    };
    const text = renderTextPlain(report);
    expect(text).toContain('Strict mode is on, so skipped files cause this run to fail.');
  });

  it('names the project-scope rules that were skipped and the mode that runs them', () => {
    const report: RunReport = {
      violations: [],
      skipped: [],
      diagnostics: [],
      filesChecked: 1,
      mode: 'file',
      projectRulesSkipped: ['no-orphan-imports'],
      strict: false,
    };
    const text = renderTextPlain(report);
    expect(text).toContain("Project-scope rules not run in 'file' mode:");
    expect(text).toContain('no-orphan-imports');
    expect(text).toContain('would run in project mode');
  });

  it('renders guidance, allowed fixes and notFixes for a rule that fired', () => {
    const report: RunReport = {
      violations: [
        makeViolation({
          file: '/project/file.ts',
          line: 3,
          column: 5,
          ruleId: 'no-any',
          message: 'Do not use any.',
          severity: 'error',
          guidance,
        }),
      ],
      skipped: [],
      diagnostics: [],
      filesChecked: 1,
      mode: 'file',
      projectRulesSkipped: [],
      strict: false,
    };
    const text = renderTextPlain(report);
    expect(text).toContain(guidance.summary);
    for (const fix of guidance.allowedFixes) {
      expect(text).toContain(`- ${fix}`);
    }
    for (const notFix of guidance.notFixes) {
      expect(text).toContain(`not: ${notFix.pattern}`);
      expect(text).toContain(notFix.because);
    }
  });

  it('groups findings under their rule, and each rule under its category', () => {
    const text = renderTextPlain(mixedReport());

    const consoleSection = text.indexOf('no-console — 3 findings');
    const anySection = text.indexOf('no-any — 1 finding,');
    const consoleLine2Col1 = text.indexOf('/project/a.ts:2:1');
    const consoleLine2Col5 = text.indexOf('/project/a.ts:2:5');
    const consoleInB = text.indexOf('/project/b.ts:1:10');
    const anyFinding = text.indexOf('/project/a.ts:1:1');

    // The heavier category leads, and its rule's findings sort by file, line, column.
    expect(text.indexOf('\nstyle\n')).toBeLessThan(text.indexOf('\ntype-safety\n'));
    expect(consoleSection).toBeLessThan(consoleLine2Col1);
    expect(consoleLine2Col1).toBeLessThan(consoleLine2Col5);
    expect(consoleLine2Col5).toBeLessThan(consoleInB);
    expect(consoleInB).toBeLessThan(anySection);
    expect(anySection).toBeLessThan(anyFinding);
  });

  it('leads with a per-rule breakdown and the files carrying the most findings', () => {
    const text = renderTextPlain(mixedReport());

    expect(text).toContain('Findings by rule — 4 findings in 2 of 3 files checked');
    expect(text).toContain('3  warning  no-console  style');
    expect(text).toContain('1  error    no-any      type-safety');
    expect(text).toContain('Files with the most findings');
    expect(text).toContain('3  /project/a.ts');
    expect(text).toContain('1  /project/b.ts');

    // The breakdown comes before any individual finding.
    expect(text.indexOf('Findings by rule')).toBeLessThan(text.indexOf('/project/a.ts:1:1'));
    expect(text.indexOf('Files with the most findings')).toBeLessThan(
      text.indexOf('/project/a.ts:1:1'),
    );
  });

  it('prints a rule guidance block once however many findings the rule produced', () => {
    const report = repeatedReport(50);
    const text = renderTextPlain(report, { maxPerRule: 50 });

    expect(occurrences(text, guidance.summary)).toBe(1);
    expect(occurrences(text, 'Use unknown and narrow it')).toBe(1);
    expect(occurrences(text, 'not: widen to unknown')).toBe(1);
    // Every finding is still there, one line each.
    expect(occurrences(text, 'Do not use any.')).toBe(50);
  });

  it('lists a bounded number of findings per rule and counts the rest', () => {
    const text = renderTextPlain(repeatedReport(50), { maxPerRule: 3 });

    expect(occurrences(text, 'Do not use any.')).toBe(3);
    expect(text).toContain('… 47 more findings for no-any, not listed.');
    expect(text).toContain('47 findings were counted but not listed.');
    expect(text).toContain('--report full');
    // The count of what happened is never truncated.
    expect(text).toContain('50 errors, 0 warnings, 50 files checked');
  });

  it('lists every finding under --report full', () => {
    const text = renderTextPlain(repeatedReport(50), { style: 'full', maxPerRule: 3 });

    expect(occurrences(text, 'Do not use any.')).toBe(50);
    expect(text).not.toContain('not listed');
    expect(occurrences(text, guidance.summary)).toBe(1);
  });

  it('lists no findings under --report summary but keeps the tables and the counts', () => {
    const text = renderTextPlain(repeatedReport(50), { style: 'summary' });

    expect(text).toContain('Findings by rule');
    expect(text).toContain('Files with the most findings');
    expect(occurrences(text, 'Do not use any.')).toBe(0);
    expect(text).toContain('50 findings not listed.');
    expect(text).toContain('50 errors, 0 warnings, 50 files checked');
  });

  it('repeats the guidance under every finding under --report detailed', () => {
    const text = renderTextPlain(repeatedReport(5), { style: 'detailed' });

    // The shape a consumer that reads one finding at a time depends on: every
    // finding carries its own fixes and its own dead ends.
    expect(occurrences(text, guidance.summary)).toBe(5);
    expect(occurrences(text, '- Use unknown and narrow it')).toBe(5);
    expect(occurrences(text, 'not: widen to unknown')).toBe(5);
    expect(text).not.toContain('Findings by rule');
  });

  it('prints paths relative to a given root, and says what the root is', () => {
    const text = renderTextPlain(mixedReport(), { root: '/project' });

    expect(text).toContain('Paths below are relative to /project.');
    expect(text).toContain('a.ts:1:1');
    expect(text).not.toContain('/project/a.ts:1:1');
  });

  it('leaves a path outside the root absolute', () => {
    const report: RunReport = {
      violations: [
        makeViolation({
          file: '/elsewhere/f.ts',
          line: 1,
          column: 1,
          ruleId: 'no-any',
          message: 'any',
          severity: 'error',
        }),
      ],
      skipped: [],
      diagnostics: [],
      filesChecked: 1,
      mode: 'file',
      projectRulesSkipped: [],
      strict: false,
    };
    expect(renderTextPlain(report, { root: '/project' })).toContain('/elsewhere/f.ts:1:1');
  });

  it('disables colour for the plain-text path', () => {
    const report: RunReport = {
      violations: [
        makeViolation({
          file: '/project/f.ts',
          line: 1,
          column: 1,
          ruleId: 'no-any',
          message: 'any',
          severity: 'error',
        }),
      ],
      skipped: [],
      diagnostics: [],
      filesChecked: 1,
      mode: 'file',
      projectRulesSkipped: [],
      strict: false,
    };
    const plain = renderTextPlain(report);
    expect(plain).not.toContain('\x1b[');
  });

  it('uses colour on a TTY when NO_COLOR is not set', () => {
    const report: RunReport = {
      violations: [
        makeViolation({
          file: '/project/f.ts',
          line: 1,
          column: 1,
          ruleId: 'no-any',
          message: 'any',
          severity: 'error',
        }),
      ],
      skipped: [],
      diagnostics: [],
      filesChecked: 1,
      mode: 'file',
      projectRulesSkipped: [],
      strict: false,
    };

    const previousIsTTY = process.stdout.isTTY;
    const noColorWasSet = 'NO_COLOR' in process.env;
    const previousNoColor = process.env.NO_COLOR;

    try {
      process.stdout.isTTY = true;
      delete process.env.NO_COLOR;
      const colored = renderText(report);
      expect(colored).toContain('\x1b[');
    } finally {
      process.stdout.isTTY = previousIsTTY;
      if (noColorWasSet) {
        process.env.NO_COLOR = previousNoColor;
      }
    }
  });
});

describe('exit codes', () => {
  it('returns 0 for warnings alone', () => {
    const report: RunReport = {
      violations: [
        makeViolation({
          file: '/project/w.ts',
          line: 1,
          column: 1,
          ruleId: 'no-console',
          message: 'console',
          severity: 'warning',
        }),
      ],
      skipped: [],
      diagnostics: [],
      filesChecked: 1,
      mode: 'file',
      projectRulesSkipped: [],
      strict: false,
    };
    expect(exitCodeFor(report)).toBe(0);
  });

  it('returns 1 when a violation has severity error', () => {
    const report: RunReport = {
      violations: [
        makeViolation({
          file: '/project/e.ts',
          line: 1,
          column: 1,
          ruleId: 'no-any',
          message: 'any',
          severity: 'error',
        }),
      ],
      skipped: [],
      diagnostics: [],
      filesChecked: 1,
      mode: 'file',
      projectRulesSkipped: [],
      strict: false,
    };
    expect(exitCodeFor(report)).toBe(1);
  });

  it('returns 1 when strict is set and files were skipped', () => {
    const report: RunReport = {
      violations: [],
      skipped: [{ file: '/project/s.ts', reason: 'could not read' }],
      diagnostics: [],
      filesChecked: 1,
      mode: 'file',
      projectRulesSkipped: [],
      strict: true,
    };
    expect(exitCodeFor(report)).toBe(1);
  });
});

describe('json reporter', () => {
  it('stringifies the full report and parses back to the same object', () => {
    const report: RunReport = {
      violations: [
        makeViolation({
          file: '/project/j.ts',
          line: 4,
          column: 2,
          ruleId: 'no-any',
          message: 'any',
          severity: 'error',
          guidance,
        }),
      ],
      skipped: [{ file: '/project/x.ts', reason: 'parse error' }],
      diagnostics: [{ level: 'warn', message: 'analyzer emitted a warning' }],
      filesChecked: 2,
      mode: 'project',
      projectRulesSkipped: ['no-orphan-imports'],
      strict: true,
    };
    expect(JSON.parse(renderJson(report))).toEqual(report);
  });

  it('always carries the rule-to-analyzer mapping when it is present', () => {
    const report: RunReport = {
      violations: [
        makeViolation({
          file: '/project/j.ts',
          line: 4,
          column: 2,
          ruleId: 'no-any',
          message: 'any',
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
    const json = renderJson(report);
    expect(json).toContain('"ruleAnalyzers"');
    expect(json).toContain('"no-any": "typescript"');
  });

  it('keeps guidance on every violation by default, so one finding is self-contained', () => {
    const parsed: unknown = JSON.parse(renderJson(repeatedReport(3)));
    if (!isRecord(parsed) || !isUnknownArray(parsed.violations)) {
      throw new Error('JSON output has no violations array');
    }
    expect(parsed.violations).toHaveLength(3);
    for (const violation of parsed.violations) {
      if (!isRecord(violation) || !isRecord(violation.guidance)) {
        throw new Error('a violation lost its guidance');
      }
      expect(violation.guidance.summary).toBe(guidance.summary);
    }
    expect(parsed.ruleGuidance).toBeUndefined();
  });

  it('writes each rule guidance once under ruleGuidance when asked to dedupe it', () => {
    const raw = renderJson(repeatedReport(3), { dedupeGuidance: true });
    expect(occurrences(raw, guidance.summary)).toBe(1);

    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isUnknownArray(parsed.violations)) {
      throw new Error('JSON output has no violations array');
    }
    for (const violation of parsed.violations) {
      if (!isRecord(violation)) {
        throw new Error('a violation is not an object');
      }
      expect(violation.guidance).toBeUndefined();
      expect(violation.ruleId).toBe('no-any');
    }

    const ruleGuidance = parsed.ruleGuidance;
    if (!isRecord(ruleGuidance) || !isRecord(ruleGuidance['no-any'])) {
      throw new Error('ruleGuidance does not carry the rule');
    }
    expect(ruleGuidance['no-any'].summary).toBe(guidance.summary);
    expect(ruleGuidance['no-any'].notFixes).toEqual(guidance.notFixes);
  });

  it('carries withheld counts as top-level fields', () => {
    const report: RunReport = {
      violations: [],
      skipped: [],
      diagnostics: [],
      filesChecked: 170,
      mode: 'project',
      projectRulesSkipped: [],
      strict: false,
      withheldFindings: 673,
      withheldFiles: 170,
      withheldReasons: ['No usable tsconfig.json governs these files.'],
    };
    const parsed: unknown = JSON.parse(renderJson(report));
    if (!isRecord(parsed)) {
      throw new Error('JSON output is not an object');
    }
    expect(parsed.withheldFindings).toBe(673);
    expect(parsed.withheldFiles).toBe(170);
    const reasons = parsed.withheldReasons;
    if (!isUnknownArray(reasons)) {
      throw new Error('JSON withheldReasons is not an array');
    }
    expect(reasons).toContain('No usable tsconfig.json governs these files.');
  });
});

describe('config notice', () => {
  it('states the enabled and available rule counts', () => {
    const report: RunReport = {
      violations: [],
      skipped: [],
      diagnostics: [],
      filesChecked: 0,
      mode: 'project',
      projectRulesSkipped: [],
      strict: false,
      rulesEnabled: 13,
      rulesAvailable: 17,
    };
    const notice = configNotice(report);
    expect(notice).toContain('13 of 17 rules enabled');
  });

  it('names every pack in config that no analyzer provides', () => {
    const report: RunReport = {
      violations: [],
      skipped: [],
      diagnostics: [],
      filesChecked: 0,
      mode: 'project',
      projectRulesSkipped: [],
      strict: false,
      rulesEnabled: 1,
      rulesAvailable: 2,
      unknownPacks: ['missing-pack'],
    };
    const notice = configNotice(report);
    expect(notice).toContain('missing-pack');
    expect(notice).toContain('no loaded analyzer provides it');
  });

  it('names every analyzer that contributes zero enabled rules', () => {
    const report: RunReport = {
      violations: [],
      skipped: [],
      diagnostics: [],
      filesChecked: 0,
      mode: 'project',
      projectRulesSkipped: [],
      strict: false,
      rulesEnabled: 1,
      rulesAvailable: 2,
      zeroContributionAnalyzers: ['csharp'],
    };
    const notice = configNotice(report);
    expect(notice).toContain('csharp');
    expect(notice).toContain('contributes 0 enabled rules');
  });

  it('is loud when the configuration expands to zero rules', () => {
    const report: RunReport = {
      violations: [],
      skipped: [],
      diagnostics: [],
      filesChecked: 0,
      mode: 'project',
      projectRulesSkipped: [],
      strict: false,
      rulesEnabled: 0,
      rulesAvailable: 17,
    };
    const notice = configNotice(report);
    expect(notice).toContain('0 of 17 rules enabled');
    expect(notice).toContain('No rules are enabled');
    expect(notice).toContain('That is not a clean bill of health');
  });

  it('returns an empty string when the count is not present', () => {
    const report: RunReport = {
      violations: [],
      skipped: [],
      diagnostics: [],
      filesChecked: 0,
      mode: 'project',
      projectRulesSkipped: [],
      strict: false,
    };
    expect(configNotice(report)).toBe('');
  });

  it('states how many findings were withheld and why', () => {
    const report: RunReport = {
      violations: [],
      skipped: [],
      diagnostics: [],
      filesChecked: 170,
      mode: 'project',
      projectRulesSkipped: [],
      strict: false,
      rulesEnabled: 3,
      rulesAvailable: 3,
      withheldFindings: 673,
      withheldFiles: 170,
      withheldReasons: [
        'No usable tsconfig.json governs these files (none found, or the nearest one is solution-style).',
      ],
    };
    const notice = configNotice(report);
    expect(notice).toContain('673 findings withheld from 170 files');
    expect(notice).toContain(
      'No usable tsconfig.json governs these files (none found, or the nearest one is solution-style).',
    );
    expect(notice).toContain('Fixing the configuration named above restores them');
  });
});

describe('exit codes for config issues', () => {
  it('returns 2 when the configuration names an unknown pack', () => {
    const report: RunReport = {
      violations: [],
      skipped: [],
      diagnostics: [],
      filesChecked: 0,
      mode: 'project',
      projectRulesSkipped: [],
      strict: false,
      rulesEnabled: 1,
      rulesAvailable: 2,
      unknownPacks: ['missing-pack'],
    };
    expect(exitCodeFor(report)).toBe(2);
  });

  it('returns 2 when the configuration expands to zero rules', () => {
    const report: RunReport = {
      violations: [],
      skipped: [],
      diagnostics: [],
      filesChecked: 0,
      mode: 'project',
      projectRulesSkipped: [],
      strict: false,
      rulesEnabled: 0,
      rulesAvailable: 17,
    };
    expect(exitCodeFor(report)).toBe(2);
  });

  it('fails a --all run that matched no files, because the words already said so', () => {
    // The report has always printed "No files were matched by this run; this is
    // not a pass." and then exited 0, so every CI system read it as a pass.
    // Found in a real repository whose sources all lived inside git submodules:
    // `git ls-files` reports a gitlink and never descends, so the run checked
    // nothing and announced success.
    const report: RunReport = {
      violations: [],
      skipped: [],
      diagnostics: [],
      filesChecked: 0,
      mode: 'all',
      projectRulesSkipped: [],
      strict: false,
      rulesEnabled: 13,
      rulesAvailable: 17,
    };
    expect(exitCodeFor(report)).toBe(2);
  });

  it('passes a --staged run that matched no files, which is an ordinary commit', () => {
    // A commit touching only images stages nothing checkable. Failing that would
    // make the pre-commit hook unusable within a day.
    const report: RunReport = {
      violations: [],
      skipped: [],
      diagnostics: [],
      filesChecked: 0,
      mode: 'staged',
      projectRulesSkipped: [],
      strict: false,
      rulesEnabled: 13,
      rulesAvailable: 17,
    };
    expect(exitCodeFor(report)).toBe(0);
  });

  it('returns 0 when an analyzer contributes zero rules but nothing else is wrong', () => {
    const report: RunReport = {
      violations: [],
      skipped: [],
      diagnostics: [],
      filesChecked: 0,
      mode: 'project',
      projectRulesSkipped: [],
      strict: false,
      rulesEnabled: 1,
      rulesAvailable: 2,
      zeroContributionAnalyzers: ['csharp'],
    };
    expect(exitCodeFor(report)).toBe(0);
  });

  it('returns 1 when findings were withheld', () => {
    const report: RunReport = {
      violations: [],
      skipped: [],
      diagnostics: [],
      filesChecked: 170,
      mode: 'project',
      projectRulesSkipped: [],
      strict: false,
      rulesEnabled: 3,
      rulesAvailable: 3,
      withheldFindings: 673,
      withheldFiles: 170,
      withheldReasons: ['No usable tsconfig.json governs these files.'],
    };
    expect(exitCodeFor(report)).toBe(1);
  });
});

describe('analyzer labels', () => {
  it('labels each violation when the report spans more than one analyzer', () => {
    const ruleCategories: Record<string, string> = {
      'no-any': 'type-safety',
      'no-dynamic': 'type-safety',
    };
    const report: RunReport = {
      violations: [
        makeViolation({
          file: '/project/Program.cs',
          line: 3,
          column: 10,
          ruleId: 'no-dynamic',
          message: 'Do not use dynamic.',
          severity: 'error',
        }),
        makeViolation({
          file: '/project/index.ts',
          line: 5,
          column: 1,
          ruleId: 'no-any',
          message: 'Do not use any.',
          severity: 'error',
        }),
      ],
      skipped: [],
      diagnostics: [],
      filesChecked: 2,
      mode: 'project',
      projectRulesSkipped: [],
      strict: false,
      ruleCategories,
      ruleAnalyzers: { 'no-dynamic': 'csharp', 'no-any': 'typescript' },
    };
    const text = renderTextPlain(report);
    expect(text).toContain('no-dynamic [csharp]');
    expect(text).toContain('no-any [typescript]');
  });

  it('does not add analyzer labels for a single-analyzer report', () => {
    const ruleCategories: Record<string, string> = {
      'no-console': 'style',
      'no-any': 'type-safety',
    };
    const report: RunReport = {
      violations: [
        makeViolation({
          file: '/project/a.ts',
          line: 1,
          column: 1,
          ruleId: 'no-console',
          message: 'console call',
          severity: 'warning',
        }),
        makeViolation({
          file: '/project/b.ts',
          line: 2,
          column: 5,
          ruleId: 'no-any',
          message: 'any',
          severity: 'error',
        }),
      ],
      skipped: [],
      diagnostics: [],
      filesChecked: 2,
      mode: 'project',
      projectRulesSkipped: [],
      strict: false,
      ruleCategories,
      ruleAnalyzers: { 'no-console': 'typescript', 'no-any': 'typescript' },
    };
    const text = renderTextPlain(report);
    expect(text).not.toContain('no-console [typescript]');
    expect(text).not.toContain('no-any [typescript]');
    expect(text).toContain('no-console');
    expect(text).toContain('no-any');
  });
});
