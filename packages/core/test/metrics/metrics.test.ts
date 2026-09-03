import { describe, expect, it } from 'vitest';
import {
  buildBurnRateMetric,
  buildMetricsReport,
  buildNeverFiredMetric,
  buildSuppressionMetric,
  formatMetricsReport,
} from '../../src/metrics/index.js';
import type { RunRecord } from '../../src/dashboard/history.js';
import type { Baseline, BaselineEntry, Suppression } from '../../src/baseline/index.js';
import type { RuleManifest } from '../../src/protocol/index.js';

function rule(overrides: Partial<RuleManifest> & { id: string }): RuleManifest {
  return {
    id: overrides.id,
    category: 'type-safety',
    scope: 'file',
    severity: 'error',
    summary: `summary for ${overrides.id}`,
    why: 'why',
    allowedFixes: [],
    notFixes: [],
    examples: { bad: 'bad', good: 'good' },
    ...overrides,
  };
}

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    timestamp: '2026-01-01T00:00:00.000Z',
    commit: 'commit-1',
    totalViolations: 0,
    ruleCounts: {},
    filesChecked: 10,
    ...overrides,
  };
}

function baselineEntry(overrides: Partial<BaselineEntry> & { ruleId: string; path: string }): BaselineEntry {
  return { fingerprint: 'a'.repeat(64), occurrence: 0, line: 1, ...overrides };
}

function baseline(entries: BaselineEntry[]): Baseline {
  return {
    header: { version: 1, takenAt: '2026-01-01T00:00:00.000Z', commit: 'commit-1' },
    entries,
    repoRoot: '/repo',
  };
}

function suppression(overrides: Partial<Suppression> & { ruleId: string }): Suppression {
  return { target: '**/*', reason: 'reason', expires: '2099-01-01', ...overrides };
}

describe('buildNeverFiredMetric', () => {
  it('reports no-history as distinct from a zero never-fired list', () => {
    const result = buildNeverFiredMetric([rule({ id: 'no-any' })], []);
    expect(result.kind).toBe('no-history');
  });

  it('reports no-evidence when no rule has fired', () => {
    const result = buildNeverFiredMetric(
      [rule({ id: 'no-any' }), rule({ id: 'no-console' })],
      [record({}), record({})],
    );
    expect(result.kind).toBe('no-evidence');
  });

  it('lists an enabled rule that never fired while others have', () => {
    const enabled = [rule({ id: 'no-any' }), rule({ id: 'no-console' })];
    const history = [record({ ruleCounts: { 'no-any': 3 } }), record({ ruleCounts: { 'no-any': 1 } })];
    const result = buildNeverFiredMetric(enabled, history);
    expect(result.kind).toBe('never-fired');
    if (result.kind !== 'never-fired') throw new Error('expected never-fired');
    expect(result.rules.map((r) => r.id)).toEqual(['no-console']);
  });

  it('reports a zero never-fired list when every enabled rule has fired', () => {
    const enabled = [rule({ id: 'no-any' }), rule({ id: 'no-console' })];
    const history = [record({ ruleCounts: { 'no-any': 1, 'no-console': 1 } })];
    const result = buildNeverFiredMetric(enabled, history);
    expect(result.kind).toBe('never-fired');
    if (result.kind !== 'never-fired') throw new Error('expected never-fired');
    expect(result.rules).toEqual([]);
  });
});

describe('buildSuppressionMetric', () => {
  it('reports insufficient evidence when there are no active suppressions', () => {
    const result = buildSuppressionMetric([rule({ id: 'no-any' })], [], null, [], new Date('2026-01-01'));
    expect(result.kind).toBe('insufficient-evidence');
  });

  it('counts an unpinned glob suppression differently from a pinned fingerprint suppression', () => {
    const broadFp = 'b'.repeat(64);
    const pinnedFp = 'c'.repeat(64);
    const known = [rule({ id: 'no-any' })];
    const history = [record({ ruleCounts: { 'no-any': 10 } })];
    const entries = [
      baselineEntry({ ruleId: 'no-any', path: 'a.ts', fingerprint: broadFp }),
      baselineEntry({ ruleId: 'no-any', path: 'b.ts', fingerprint: pinnedFp, occurrence: 0 }),
    ];
    const suppressions = [
      suppression({ ruleId: 'no-any', target: '**/*.ts' }),
      suppression({ ruleId: 'no-any', target: 'b.ts', fingerprint: pinnedFp, occurrence: 0 }),
    ];
    const result = buildSuppressionMetric(known, history, baseline(entries), suppressions, new Date('2026-01-01'));
    expect(result.kind).toBe('populated');
    if (result.kind !== 'populated') throw new Error('expected populated');
    const noAny = result.rules.find((r) => r.rule.id === 'no-any');
    expect(noAny).toBeDefined();
    if (noAny === undefined) throw new Error('expected no-any');
    expect(noAny.broadFindings).toBe(1);
    expect(noAny.pinnedFindings).toBe(1);
    expect(noAny.broadEntries).toBe(1);
    expect(noAny.pinnedEntries).toBe(1);
    expect(noAny.totalFired).toBe(10);
    expect(noAny.rate).toBe(0.2);
  });

  it('distinguishes insufficient evidence from a measured zero rate', () => {
    const known = [rule({ id: 'no-console' }), rule({ id: 'no-eval' })];
    const history = [record({ ruleCounts: { 'no-console': 10, 'no-eval': 2 } })];
    const entries = [baselineEntry({ ruleId: 'no-eval', path: 'a.ts' })];
    const suppressions = [suppression({ ruleId: 'no-console' }), suppression({ ruleId: 'no-eval' })];
    const result = buildSuppressionMetric(known, history, baseline(entries), suppressions, new Date('2026-01-01'));
    expect(result.kind).toBe('populated');
    if (result.kind !== 'populated') throw new Error('expected populated');
    const consoleRule = result.rules.find((r) => r.rule.id === 'no-console');
    const evalRule = result.rules.find((r) => r.rule.id === 'no-eval');
    expect(consoleRule?.state).toBe('zero');
    expect(consoleRule?.rate).toBe(0);
    expect(evalRule?.state).toBe('insufficient-evidence');
    expect(evalRule?.rate).toBeUndefined();
  });
});

describe('buildBurnRateMetric', () => {
  it('reports insufficient evidence with fewer than two runs', () => {
    const result = buildBurnRateMetric(
      [rule({ id: 'no-any' })],
      [record({ ruleCounts: { 'no-any': 5 } })],
      null,
    );
    expect(result.kind).toBe('insufficient-evidence');
  });

  it('reports a zero state distinct from insufficient evidence', () => {
    const known = [rule({ id: 'no-any' })];
    const history = [
      record({ ruleCounts: { 'no-any': 5 } }),
      record({ ruleCounts: { 'no-any': 5 } }),
    ];
    const result = buildBurnRateMetric(known, history, null);
    expect(result.kind).toBe('populated');
    if (result.kind !== 'populated') throw new Error('expected populated');
    const noAny = result.rules.find((r) => r.rule.id === 'no-any');
    expect(noAny?.state).toBe('unchanged');
    expect(noAny?.deferredIndefinitely).toBe(false);
  });

  it('flags baselined findings that persist across the window as deferred indefinitely', () => {
    const known = [rule({ id: 'no-any' })];
    const history = [
      record({ ruleCounts: { 'no-any': 5 } }),
      record({ ruleCounts: { 'no-any': 5 } }),
    ];
    const entries = [baselineEntry({ ruleId: 'no-any', path: 'a.ts' })];
    const result = buildBurnRateMetric(known, history, baseline(entries));
    expect(result.kind).toBe('populated');
    if (result.kind !== 'populated') throw new Error('expected populated');
    const noAny = result.rules.find((r) => r.rule.id === 'no-any');
    expect(noAny?.deferredIndefinitely).toBe(true);
    expect(noAny?.state).toBe('unchanged');
  });
});

describe('buildMetricsReport', () => {
  it('produces no output keyed by author', () => {
    const enabled = [rule({ id: 'no-any' }), rule({ id: 'no-console' })];
    const history = [
      record({ ruleCounts: { 'no-any': 5, 'no-console': 1 }, filesChecked: 100 }),
      record({ ruleCounts: { 'no-any': 6, 'no-console': 1 }, filesChecked: 100 }),
      record({ ruleCounts: { 'no-any': 5, 'no-console': 1 }, filesChecked: 100 }),
    ];
    const report = buildMetricsReport(enabled, enabled, history, null, [], new Date('2026-01-01'));
    const json = JSON.stringify(report);
    expect(json).not.toContain('author');
    expect(json).not.toContain('committer');
    expect(json).not.toContain('Author');
    expect(json).not.toContain('Committer');
  });

  it('flags a rule that fires far above its peers across multiple runs', () => {
    const enabled = [rule({ id: 'no-any' }), rule({ id: 'no-console' })];
    const history = [
      record({ ruleCounts: { 'no-any': 5, 'no-console': 1 }, filesChecked: 100 }),
      record({ ruleCounts: { 'no-any': 6, 'no-console': 1 }, filesChecked: 100 }),
      record({ ruleCounts: { 'no-any': 5, 'no-console': 1 }, filesChecked: 100 }),
    ];
    const report = buildMetricsReport(enabled, enabled, history, null, [], new Date('2026-01-01'));
    expect(report.misScoped.kind).toBe('populated');
    if (report.misScoped.kind !== 'populated') throw new Error('expected populated');
    const noAny = report.misScoped.rules.find((r) => r.rule.id === 'no-any');
    expect(noAny?.state).toBe('outlier');
    expect(noAny?.outlierRuns).toBeGreaterThanOrEqual(2);
    const noConsole = report.misScoped.rules.find((r) => r.rule.id === 'no-console');
    expect(noConsole?.state).toBe('zero');
  });

  it('reports insufficient evidence for mis-scoped when fewer than two runs exist', () => {
    const enabled = [rule({ id: 'no-any' })];
    const history = [record({ ruleCounts: { 'no-any': 5 }, filesChecked: 100 })];
    const report = buildMetricsReport(enabled, enabled, history, null, [], new Date('2026-01-01'));
    expect(report.misScoped.kind).toBe('insufficient-evidence');
  });

  it('human output and --json report agree on the same counts', () => {
    const enabled = [rule({ id: 'no-any' }), rule({ id: 'no-console' })];
    const history = [
      record({ ruleCounts: { 'no-any': 5, 'no-console': 1 }, filesChecked: 100 }),
      record({ ruleCounts: { 'no-any': 5, 'no-console': 1 }, filesChecked: 100 }),
    ];
    const report = buildMetricsReport(enabled, enabled, history, null, [], new Date('2026-01-01'));
    const human = formatMetricsReport(report);
    const json = JSON.stringify(report);
    expect(human).toContain('2 recorded run(s)');
    expect(human).toContain('2 enabled rule(s)');
    expect(json).toContain('"runCount":2');
    expect(json).toContain('"rulesEnabled":2');
  });
});
