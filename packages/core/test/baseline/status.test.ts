import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command } from '../../src/cli/baseline.js';
import { computeEntries } from '../../src/baseline/identity.js';
import { buildStatusReport, formatStatusReport, renderStatus } from '../../src/baseline/status.js';
import type { Baseline } from '../../src/baseline/types.js';
import type { Suppression } from '../../src/baseline/suppressions.js';
import type { Violation } from '../../src/protocol/index.js';
import { FIXTURE_REPO_ROOT, makeViolation } from './fixtures.js';

function baselineFor(violations: readonly Violation[], extraEntries: Baseline['entries'] = []): Baseline {
  const entries = computeEntries(violations, FIXTURE_REPO_ROOT).map(({ entry }) => entry);
  return {
    header: { version: 1, takenAt: '2026-01-01T00:00:00.000Z', commit: 'abc123' },
    entries: [...entries, ...extraEntries],
    repoRoot: FIXTURE_REPO_ROOT,
  };
}

function statusFor(
  violations: readonly Violation[],
  extraEntries: Baseline['entries'] = [],
  enabled: Set<string>,
  suppressions: readonly Suppression[] = [],
  now: Date = new Date('2026-06-01T00:00:00.000Z'),
): string {
  const baseline = baselineFor(violations, extraEntries);
  const report = buildStatusReport(baseline, violations, enabled, suppressions, FIXTURE_REPO_ROOT, now);
  return renderStatus(report);
}

describe('buildStatusReport', () => {
  it('groups remaining violations by rule and by file', () => {
    const violations = [
      makeViolation({ relPath: 'src/a.ts', ruleId: 'no-a', snippet: 'a' }),
      makeViolation({ relPath: 'src/b.ts', ruleId: 'no-a', snippet: 'a' }),
      makeViolation({ relPath: 'src/b.ts', ruleId: 'no-b', snippet: 'b' }),
      makeViolation({ relPath: 'src/c.ts', ruleId: 'no-a', snippet: 'a' }),
      makeViolation({ relPath: 'src/c.ts', ruleId: 'no-b', snippet: 'b' }),
      makeViolation({ relPath: 'src/c.ts', ruleId: 'no-b', snippet: 'b2' }),
    ];
    const baseline = baselineFor(violations);
    const report = buildStatusReport(
      baseline,
      violations,
      new Set(['no-a', 'no-b']),
      [],
      FIXTURE_REPO_ROOT,
    );

    expect(report.baselinedCount).toBe(6);
    expect(report.byRule).toEqual([
      ['no-a', 3],
      ['no-b', 3],
    ]);
    expect(report.byFile).toEqual([
      ['src/c.ts', 3],
      ['src/b.ts', 2],
      ['src/a.ts', 1],
    ]);
  });

  it('identifies baseline entries whose rule is no longer enabled as dead entries', () => {
    const violations = [makeViolation({ relPath: 'src/a.ts', ruleId: 'no-a', snippet: 'a' })];
    const extra: Baseline['entries'] = [
      { path: 'src/old.ts', ruleId: 'no-longer-enabled', fingerprint: 'dead', occurrence: 0, line: 1 },
    ];
    const baseline = baselineFor(violations, extra);
    const report = buildStatusReport(
      baseline,
      violations,
      new Set(['no-a']),
      [],
      FIXTURE_REPO_ROOT,
    );

    expect(report.baselinedCount).toBe(1);
    expect(report.deadRuleCounts).toEqual([['no-longer-enabled', 1]]);
    expect(report.staleFixedCount).toBe(0);
  });

  it('counts active and expiring suppressions and names expired ones', () => {
    const violations = [makeViolation({ relPath: 'src/a.ts', ruleId: 'no-a', snippet: 'a' })];
    const suppressions: Suppression[] = [
      {
        ruleId: 'no-a',
        target: 'src/a.ts',
        reason: 'Legacy, fix in Q1.',
        expires: '2025-01-01',
      },
      {
        ruleId: 'no-a',
        target: 'src/a.ts',
        reason: 'Recent, fix in Q3.',
        expires: '2099-01-01',
      },
    ];
    const baseline = baselineFor(violations);
    const report = buildStatusReport(
      baseline,
      violations,
      new Set(['no-a']),
      suppressions,
      FIXTURE_REPO_ROOT,
      new Date('2026-06-01T00:00:00.000Z'),
    );

    expect(report.activeSuppressions).toBe(1);
    expect(report.expiringWithin30Days).toBe(0);
    expect(report.expired).toHaveLength(1);
    expect(report.expired[0]?.ruleId).toBe('no-a');
    expect(report.expired[0]?.reason).toBe('Legacy, fix in Q1.');
  });

  it('counts expiring-within-30-days correctly across a date boundary', () => {
    const violations = [makeViolation({ relPath: 'src/a.ts', ruleId: 'no-a', snippet: 'a' })];
    const suppressions: Suppression[] = [
      {
        ruleId: 'no-a',
        target: 'src/a.ts',
        reason: 'Fix next month.',
        expires: '2026-07-01',
      },
    ];
    const baseline = baselineFor(violations);

    const justBefore = buildStatusReport(
      baseline,
      violations,
      new Set(['no-a']),
      suppressions,
      FIXTURE_REPO_ROOT,
      new Date('2026-05-31T23:59:59.999Z'),
    );
    expect(justBefore.activeSuppressions).toBe(1);
    expect(justBefore.expiringWithin30Days).toBe(0);

    const justAfter = buildStatusReport(
      baseline,
      violations,
      new Set(['no-a']),
      suppressions,
      FIXTURE_REPO_ROOT,
      new Date('2026-06-01T00:00:00.000Z'),
    );
    expect(justAfter.activeSuppressions).toBe(1);
    expect(justAfter.expiringWithin30Days).toBe(1);
  });
});

describe('formatStatusReport', () => {
  it('renders the remaining count, by rule, and by file (worst first)', () => {
    const output = statusFor(
      [
        makeViolation({ relPath: 'src/a.ts', ruleId: 'no-a', snippet: 'a' }),
        makeViolation({ relPath: 'src/b.ts', ruleId: 'no-a', snippet: 'a' }),
        makeViolation({ relPath: 'src/b.ts', ruleId: 'no-b', snippet: 'b' }),
        makeViolation({ relPath: 'src/c.ts', ruleId: 'no-a', snippet: 'a' }),
        makeViolation({ relPath: 'src/c.ts', ruleId: 'no-b', snippet: 'b' }),
      ],
      [],
      new Set(['no-a', 'no-b']),
    );

    expect(output).toContain('5 baselined violation(s) remain');
    expect(output).toContain('By rule:');
    expect(output).toContain('By file (worst first):');
    expect(output).toMatch(/3\s+no-a/);
    expect(output).toMatch(/2\s+no-b/);

    const fileSection = output.split('By file (worst first):')[1] ?? '';
    const fileLines = fileSection.split('\n').filter((line) => line.includes('src/'));
    expect(fileLines[0] ?? '').toContain('src/b.ts');
    expect(fileLines[1] ?? '').toContain('src/c.ts');
    expect(fileLines[2] ?? '').toContain('src/a.ts');
  });

  it('reports dead entries by disabled rule', () => {
    const output = statusFor(
      [makeViolation({ relPath: 'src/a.ts', ruleId: 'no-a', snippet: 'a' })],
      [
        {
          path: 'src/old.ts',
          ruleId: 'no-longer-enabled',
          fingerprint: 'dead',
          occurrence: 0,
          line: 1,
        },
      ],
      new Set(['no-a']),
    );

    expect(output).toContain(
      '1 baselined entries reference a rule that is no longer enabled (dead entries):',
    );
    expect(output).toMatch(/1\s+no-longer-enabled/);
  });

  it('names an expired suppression specifically', () => {
    const output = statusFor(
      [makeViolation({ relPath: 'src/a.ts', ruleId: 'no-a', snippet: 'a' })],
      [],
      new Set(['no-a']),
      [
        {
          ruleId: 'no-a',
          target: 'src/a.ts',
          reason: 'Legacy, fix in Q1.',
          expires: '2025-01-01',
        },
      ],
    );

    expect(output).toContain('1 suppression(s) have EXPIRED and no longer suppress anything:');
    expect(output).toContain('no-a on "src/a.ts" expired 2025-01-01 — Legacy, fix in Q1.');
  });

  it('produces sensible output when the baseline is empty', () => {
    const output = statusFor([], [], new Set(['no-a']));

    expect(output).toContain('0 baselined violation(s) remain, out of 0 recorded.');
    expect(output).toContain('By rule:');
    expect(output).toContain('By file (worst first):');
    expect(output).toContain('0 active suppression(s), 0 expiring within 30 days.');
  });
});

async function copySchema(repoRoot: string): Promise<void> {
  const schemaUrl = new URL('../../../../docs/protocol/config.schema.json', import.meta.url);
  const schema = await readFile(schemaUrl, 'utf-8');
  const schemaDir = join(repoRoot, 'docs', 'protocol');
  await mkdir(schemaDir, { recursive: true });
  await writeFile(join(schemaDir, 'config.schema.json'), schema);
}

async function makeRepo(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'cyv-status-'));
  const repo = join(parent, 'repo');
  await mkdir(repo, { recursive: true });
  execFileSync('git', ['init'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
  return repo;
}

function captureConsole(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
    logs.push(String(line));
  });
  return {
    logs,
    restore: () => spy.mockRestore(),
  };
}

describe('cyv baseline --status command', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeRepo();
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('says no baseline is recorded when the baseline file is absent', async () => {
    await copySchema(repo);
    await writeFile(
      join(repo, 'checkyourvibe.json'),
      JSON.stringify(
        {
          $schema: './docs/protocol/config.schema.json',
          packs: [],
          analyzers: [],
          rules: {},
          strict: false,
          exclude: [],
        },
        null,
        2,
      ),
    );

    const captured = captureConsole();
    try {
      const code = await command.run({ cwd: repo, argv: ['--status'], env: process.env });
      expect(code).toBe(0);
      expect(captured.logs.some((line) => /No baseline recorded/.test(line))).toBe(true);
    } finally {
      captured.restore();
    }
  });
});
