import { describe, expect, it } from 'vitest';
import {
  buildInterlockGraph,
  buildResultsView,
  buildTrend,
  computeNeverFired,
  buildBaselineView,
  buildSuppressionsView,
  buildRuleDebtMap,
  buildFileHeatView,
  computeFileHeat,
  suppressionScope,
  unattachedDebtRuleIds,
} from '../../src/dashboard/model.js';
import type { RunRecord } from '../../src/dashboard/history.js';
import type { RuleManifest } from '../../src/protocol/index.js';
import type { Baseline, BaselineEntry, Suppression } from '../../src/baseline/index.js';

function rule(overrides: Partial<RuleManifest> & { id: string }): RuleManifest {
  return {
    category: 'type-safety',
    scope: 'file',
    severity: 'error',
    summary: 'summary',
    why: 'why',
    allowedFixes: [],
    notFixes: [],
    examples: { bad: 'bad', good: 'good' },
    ...overrides,
  };
}

function record(overrides: Partial<RunRecord>): RunRecord {
  return {
    timestamp: '2026-01-01T00:00:00.000Z',
    commit: 'commit-1',
    totalViolations: 0,
    ruleCounts: {},
    filesChecked: 10,
    ...overrides,
  };
}

describe('buildResultsView', () => {
  it('reports no-history when nothing has been recorded', () => {
    expect(buildResultsView([])).toEqual({ kind: 'no-history' });
  });

  it('reports the most recent record and the total run count', () => {
    const r1 = record({ commit: 'a', totalViolations: 5 });
    const r2 = record({ commit: 'b', totalViolations: 2 });
    expect(buildResultsView([r1, r2])).toEqual({ kind: 'latest', record: r2, runCount: 2 });
  });
});

describe('buildTrend', () => {
  it('reports insufficient-data for zero runs', () => {
    expect(buildTrend([])).toEqual({ kind: 'insufficient-data', runCount: 0 });
  });

  it('reports insufficient-data for exactly one run rather than charting a single point', () => {
    expect(buildTrend([record({})])).toEqual({ kind: 'insufficient-data', runCount: 1 });
  });

  it('builds a trend once at least two runs exist', () => {
    const r1 = record({ commit: 'a', totalViolations: 5, ruleCounts: { 'no-any': 5 } });
    const r2 = record({ commit: 'b', totalViolations: 2, ruleCounts: { 'no-any': 2 } });
    const trend = buildTrend([r1, r2]);
    expect(trend.kind).toBe('trend');
    if (trend.kind !== 'trend') throw new Error('expected trend');
    expect(trend.points).toEqual([
      { timestamp: r1.timestamp, commit: 'a', total: 5, ruleCounts: { 'no-any': 5 } },
      { timestamp: r2.timestamp, commit: 'b', total: 2, ruleCounts: { 'no-any': 2 } },
    ]);
  });
});

describe('buildInterlockGraph', () => {
  it('draws no edges when no rules are enabled', () => {
    expect(buildInterlockGraph([])).toEqual([]);
  });

  it('groups by pack when no analyzer mapping is provided', () => {
    const a = rule({ id: 'a', pack: 'core-ts' });
    const b = rule({ id: 'b', pack: 'core-cs' });
    const graphs = buildInterlockGraph([a, b]);

    expect(graphs).toHaveLength(2);
    const groups = graphs.map((g) => g.group).sort();
    expect(groups).toEqual(['core-cs', 'core-ts']);
    expect(graphs[0]?.kind).toBe('pack');
    expect(graphs[1]?.kind).toBe('pack');
  });

  it('groups by analyzer id when a ruleAnalyzers map is provided', () => {
    const a = rule({ id: 'a', pack: 'core-ts' });
    const b = rule({ id: 'b', pack: 'core-cs' });
    const graphs = buildInterlockGraph([a, b], { a: 'typescript', b: 'csharp' });

    expect(graphs).toHaveLength(2);
    const groups = graphs.map((g) => g.group).sort();
    expect(groups).toEqual(['csharp', 'typescript']);
    expect(graphs.every((g) => g.kind === 'analyzer')).toBe(true);
  });

  it('computes isolation per group, not globally', () => {
    const tsA = rule({
      id: 'ts-a',
      pack: 'core-ts',
      notFixes: [{ pattern: 'fix', because: 'bad', rule: 'ts-b' }],
    });
    const tsB = rule({
      id: 'ts-b',
      pack: 'core-ts',
      notFixes: [{ pattern: 'fix', because: 'bad', rule: 'ts-a' }],
    });
    const csIsolated = rule({ id: 'cs-isolated', pack: 'core-cs' });
    const graphs = buildInterlockGraph([tsA, tsB, csIsolated]);

    expect(graphs).toHaveLength(2);
    const tsGraph = graphs.find((g) => g.group === 'core-ts');
    const csGraph = graphs.find((g) => g.group === 'core-cs');

    expect(tsGraph?.isolated).toEqual([]);
    expect(csGraph?.isolated).toEqual(['cs-isolated']);
  });

  it('does not draw an edge between rules from different packs', () => {
    const ts = rule({
      id: 'ts-a',
      pack: 'core-ts',
      notFixes: [{ pattern: 'fix', because: 'bad', rule: 'cs-a' }],
    });
    const cs = rule({ id: 'cs-a', pack: 'core-cs' });
    const graphs = buildInterlockGraph([ts, cs]);

    const tsGraph = graphs.find((g) => g.group === 'core-ts');
    expect(tsGraph?.edges).toHaveLength(0);
    expect(tsGraph?.danglingPatterns).toHaveLength(1);
  });
});

describe('computeNeverFired', () => {
  it('lists an enabled rule that produced zero findings across all recorded history', () => {
    const enabled = [rule({ id: 'no-any' }), rule({ id: 'no-console' })];
    const history = [
      record({ ruleCounts: { 'no-any': 3 } }),
      record({ ruleCounts: { 'no-any': 1 } }),
    ];

    const result = computeNeverFired(enabled, history);
    expect(result.map((r) => r.id)).toEqual(['no-console']);
  });

  it('does not list a rule that fired in at least one recorded run', () => {
    const enabled = [rule({ id: 'no-any' }), rule({ id: 'no-console' })];
    const history = [
      record({ ruleCounts: { 'no-any': 3 } }),
      record({ ruleCounts: { 'no-console': 1 } }),
    ];

    expect(computeNeverFired(enabled, history)).toEqual([]);
  });

  it('never lists a rule that is not enabled, even if it never fires', () => {
    // Only 'no-any' is "enabled" here; 'no-console' is a real rule id that
    // simply never made it into the enabled set passed in. A never-fired
    // report must not conflate "not enabled" with "never fired" — they mean
    // opposite things (Requirement 5.2).
    const enabled = [rule({ id: 'no-any' })];
    const history = [record({ ruleCounts: { 'no-any': 3 } })];

    const result = computeNeverFired(enabled, history);
    expect(result.map((r) => r.id)).not.toContain('no-console');
    expect(result).toEqual([]);
  });

  it('treats a rule with zero recorded findings as never-fired even when history exists', () => {
    const enabled = [rule({ id: 'no-any' })];
    const history = [record({ ruleCounts: {} }), record({ ruleCounts: {} })];

    expect(computeNeverFired(enabled, history).map((r) => r.id)).toEqual(['no-any']);
  });
});

describe('buildFileHeatView', () => {
  it('reports no-history when nothing has been recorded', () => {
    expect(buildFileHeatView([])).toEqual({ kind: 'no-history' });
  });

  it('reports no-file-data when every recorded run predates per-file tracking', () => {
    const legacy = record({ ruleCounts: { 'no-any': 2 } });
    expect('fileCounts' in legacy).toBe(false);
    expect(buildFileHeatView([legacy])).toEqual({ kind: 'no-file-data', runCount: 1 });
  });

  it('reports no-evidence when file data was tracked but every count is zero, distinct from no-file-data', () => {
    const clean = record({ fileCounts: {} });
    expect(buildFileHeatView([clean])).toEqual({
      kind: 'no-evidence',
      runCount: 1,
      runsWithFileData: 1,
    });
  });

  it('treats a mix of legacy and tracked runs as tracked, using only the tracked ones', () => {
    const legacy = record({ commit: 'a', ruleCounts: { 'no-any': 1 } });
    const tracked = record({ commit: 'b', fileCounts: { 'a.ts': 3 } });
    const view = buildFileHeatView([legacy, tracked]);

    expect(view.kind).toBe('heat');
    if (view.kind !== 'heat') throw new Error('expected heat');
    expect(view.runCount).toBe(2);
    expect(view.runsWithFileData).toBe(1);
    // Only one tracked run means there is no previous tracked run to diff
    // against — delta is 0 here for the same reason `ruleTrendRows` treats a
    // series of length 1 as its own "previous": there is nothing earlier to
    // compare to yet, not evidence the count didn't change.
    expect(view.files).toEqual([{ path: 'a.ts', series: [3], latest: 3, delta: 0 }]);
  });

  it('ranks files by latest count, worst first, and computes delta against the previous tracked run', () => {
    const r1 = record({ commit: 'a', fileCounts: { 'hot.ts': 1, 'cold.ts': 5 } });
    const r2 = record({ commit: 'b', fileCounts: { 'hot.ts': 4, 'cold.ts': 5 } });
    const view = buildFileHeatView([r1, r2]);

    expect(view.kind).toBe('heat');
    if (view.kind !== 'heat') throw new Error('expected heat');
    expect(view.files).toEqual([
      { path: 'cold.ts', series: [5, 5], latest: 5, delta: 0 },
      { path: 'hot.ts', series: [1, 4], latest: 4, delta: 3 },
    ]);
  });

  it('treats a file absent from a later run as zero for that run, not as missing data', () => {
    const r1 = record({ commit: 'a', fileCounts: { 'fixed.ts': 2 } });
    const r2 = record({ commit: 'b', fileCounts: {} });
    const view = buildFileHeatView([r1, r2]);

    expect(view.kind).toBe('heat');
    if (view.kind !== 'heat') throw new Error('expected heat');
    expect(view.files).toEqual([{ path: 'fixed.ts', series: [2, 0], latest: 0, delta: -2 }]);
  });
});

describe('computeFileHeat', () => {
  it('returns one entry per file across the records it is given, sorted by latest descending', () => {
    const r1 = record({ fileCounts: { 'a.ts': 1, 'b.ts': 9 } });
    const entries = computeFileHeat([r1]);
    expect(entries.map((e) => e.path)).toEqual(['b.ts', 'a.ts']);
  });
});

function baselineEntry(overrides: Partial<BaselineEntry> & { ruleId: string; path: string }): BaselineEntry {
  return { fingerprint: 'fp', occurrence: 0, line: 1, ...overrides };
}

function baseline(entries: BaselineEntry[], headerOverrides: Partial<Baseline['header']> = {}): Baseline {
  return {
    header: { version: 1, takenAt: '2026-01-01T00:00:00.000Z', commit: 'abc123', ...headerOverrides },
    entries,
    repoRoot: '/repo',
  };
}

function suppression(overrides: Partial<Suppression> & { ruleId: string }): Suppression {
  return { target: '**/*', reason: 'reason', expires: '2099-01-01', ...overrides };
}

describe('buildBaselineView', () => {
  it('reports no-baseline when no baseline file exists', () => {
    expect(buildBaselineView(null)).toEqual({ kind: 'no-baseline' });
  });

  it('reports empty when a baseline exists with zero entries, distinct from no-baseline', () => {
    const b = baseline([]);
    expect(buildBaselineView(b)).toEqual({ kind: 'empty', takenAt: b.header.takenAt, commit: 'abc123' });
  });

  it('reports populated with counts by rule and by file, worst first', () => {
    const entries = [
      baselineEntry({ ruleId: 'no-any', path: 'a.ts' }),
      baselineEntry({ ruleId: 'no-any', path: 'a.ts', occurrence: 1 }),
      baselineEntry({ ruleId: 'no-console', path: 'b.ts' }),
    ];
    const view = buildBaselineView(baseline(entries));

    expect(view.kind).toBe('populated');
    if (view.kind !== 'populated') throw new Error('expected populated');
    expect(view.total).toBe(3);
    expect(view.byRule).toEqual([
      ['no-any', 2],
      ['no-console', 1],
    ]);
    expect(view.byFile).toEqual([
      ['a.ts', 2],
      ['b.ts', 1],
    ]);
  });
});

describe('buildSuppressionsView', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('reports not-configured when checkyourvibe.json has no suppressions key', () => {
    expect(buildSuppressionsView([], false, '/repo', now)).toEqual({ kind: 'not-configured' });
  });

  it('reports empty when the key is present but the list is empty, distinct from not-configured', () => {
    expect(buildSuppressionsView([], true, '/repo', now)).toEqual({ kind: 'empty' });
  });

  it('splits active from expired, and an expired suppression is excluded from active', () => {
    const active = suppression({ ruleId: 'no-any', expires: '2099-01-01' });
    const expired = suppression({ ruleId: 'no-console', expires: '2020-01-01' });
    const view = buildSuppressionsView([active, expired], true, '/repo', now);

    expect(view.kind).toBe('configured');
    if (view.kind !== 'configured') throw new Error('expected configured');
    expect(view.active).toEqual([active]);
    expect(view.expired).toEqual([expired]);
  });

  it('counts suppressions expiring within 30 days', () => {
    const soon = suppression({ ruleId: 'no-any', expires: '2026-06-15' });
    const view = buildSuppressionsView([soon], true, '/repo', now);

    expect(view.kind).toBe('configured');
    if (view.kind !== 'configured') throw new Error('expected configured');
    expect(view.expiringWithin30DaysCount).toBe(1);
  });
});

describe('buildRuleDebtMap', () => {
  it('omits a rule with neither an active suppression nor a baseline entry', () => {
    const debt = buildRuleDebtMap({ kind: 'no-baseline' }, { kind: 'not-configured' });
    expect(debt.has('no-any')).toBe(false);
    expect(debt.size).toBe(0);
  });

  it('reports baseline entries and active suppressions per rule, and nothing for an untouched rule', () => {
    const entries = [
      baselineEntry({ ruleId: 'no-any', path: 'a.ts' }),
      baselineEntry({ ruleId: 'no-any', path: 'b.ts', occurrence: 1 }),
    ];
    const baselineView = buildBaselineView(baseline(entries));
    const suppressionsView = buildSuppressionsView(
      [suppression({ ruleId: 'no-console', expires: '2099-01-01' })],
      true,
      '/repo',
      new Date('2026-01-01'),
    );

    const debt = buildRuleDebtMap(baselineView, suppressionsView);

    expect(debt.get('no-any')).toEqual({
      broadSuppressions: 0,
      pinnedSuppressions: 0,
      baselineEntries: 2,
    });
    expect(debt.get('no-console')).toEqual({
      broadSuppressions: 1,
      pinnedSuppressions: 0,
      baselineEntries: 0,
    });
    expect(debt.has('no-unrelated')).toBe(false);
  });

  it('counts a fingerprinted suppression as pinned and a path-glob one as broad', () => {
    const suppressionsView = buildSuppressionsView(
      [
        suppression({ ruleId: 'no-any', expires: '2099-01-01' }),
        suppression({ ruleId: 'no-any', expires: '2099-01-01', fingerprint: 'f'.repeat(64) }),
      ],
      true,
      '/repo',
      new Date('2026-01-01'),
    );

    const debt = buildRuleDebtMap({ kind: 'no-baseline' }, suppressionsView);

    expect(debt.get('no-any')).toEqual({
      broadSuppressions: 1,
      pinnedSuppressions: 1,
      baselineEntries: 0,
    });
  });

  it('does not count an expired suppression, which suppresses nothing', () => {
    const suppressionsView = buildSuppressionsView(
      [suppression({ ruleId: 'no-any', expires: '2020-01-01' })],
      true,
      '/repo',
      new Date('2026-01-01'),
    );

    const debt = buildRuleDebtMap({ kind: 'no-baseline' }, suppressionsView);

    expect(debt.has('no-any')).toBe(false);
  });
});

describe('suppressionScope', () => {
  it('calls a rule-and-glob suppression broad, because it covers violations added later', () => {
    expect(suppressionScope(suppression({ ruleId: 'no-any' }))).toBe('broad');
  });

  it('calls a fingerprinted suppression pinned, because it names one recorded finding', () => {
    const pinned = suppression({ ruleId: 'no-any', fingerprint: 'b'.repeat(64), occurrence: 0 });
    expect(suppressionScope(pinned)).toBe('pinned');
  });
});

describe('unattachedDebtRuleIds', () => {
  const enabled = [rule({ id: 'no-any' })];

  it('is empty when every rule carrying debt is enabled', () => {
    const baselineView = buildBaselineView(baseline([baselineEntry({ ruleId: 'no-any', path: 'a.ts' })]));
    const debt = buildRuleDebtMap(baselineView, { kind: 'not-configured' });

    expect(unattachedDebtRuleIds(debt, enabled)).toEqual([]);
  });

  it('names the rules whose recorded debt has no rule below to annotate, sorted', () => {
    const baselineView = buildBaselineView(
      baseline([
        baselineEntry({ ruleId: 'renamed-rule', path: 'a.ts' }),
        baselineEntry({ ruleId: 'no-any', path: 'a.ts', occurrence: 1 }),
        baselineEntry({ ruleId: 'gone-rule', path: 'b.ts' }),
      ]),
    );
    const debt = buildRuleDebtMap(baselineView, { kind: 'not-configured' });

    expect(unattachedDebtRuleIds(debt, enabled)).toEqual(['gone-rule', 'renamed-rule']);
  });
});
