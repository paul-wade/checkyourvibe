import { describe, expect, it } from 'vitest';
import { renderDashboard, renderVolatilePanels, type DashboardDebtInput } from '../../src/dashboard/render.js';
import type { RunRecord } from '../../src/dashboard/history.js';
import type { RuleManifest } from '../../src/protocol/index.js';
import type { Baseline, BaselineEntry, Suppression } from '../../src/baseline/index.js';

function rule(overrides: Partial<RuleManifest> & { id: string }): RuleManifest {
  return {
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

const RULES = [rule({ id: 'no-any' }), rule({ id: 'no-console' })];

describe('renderDashboard empty states', () => {
  it('says so and names cyv init when no rules are enabled, instead of an empty dashboard', () => {
    const html = renderDashboard([], ['analyzer'], []);
    expect(html).toContain('No rules are enabled');
    expect(html).toContain('cyv init');
    // None of the results/trend/never-fired sections should render at all —
    // there is nothing configured to report on.
    expect(html).not.toContain('<h2>Results</h2>');
    expect(html).not.toContain('<h2>Trend</h2>');
    expect(html).not.toContain('<h2>Never-fired rules</h2>');
  });

  it('says analysis has never been run, distinct from a zero-violation result', () => {
    const html = renderDashboard(RULES, ['analyzer'], []);
    expect(html).toContain('Analysis has never been run');
    expect(html).not.toContain('0 violations');
  });

  it('renders a zero-violation clean run distinguishably from "never run"', () => {
    const clean = renderDashboard(RULES, ['analyzer'], [record({ totalViolations: 0 })]);
    expect(clean).toContain('0 violations');
    expect(clean).not.toContain('Analysis has never been run');
    // Different visual treatment: a clean run gets the "ok" box, not the
    // dashed "no data" box or the "warn" box a dirty run gets.
    expect(clean).toContain('<div class="okbox"><b>0 violations</b>');
  });

  it('distinguishes a dirty run from a clean one visually as well as textually', () => {
    const dirty = renderDashboard(
      RULES,
      ['analyzer'],
      [record({ totalViolations: 3, ruleCounts: { 'no-any': 3 } })],
    );
    expect(dirty).toContain('3 violations');
    expect(dirty).toContain('<div class="warnbox"><b>3 violations</b>');
  });
});

describe('renderDashboard trend view', () => {
  it('says there is not enough data with a single recorded run, rather than drawing a chart', () => {
    const html = renderDashboard(RULES, ['analyzer'], [record({})]);
    expect(html).toContain('Not enough data for a trend');
    expect(html).toContain('Only 1 run has been recorded');
    // No chart markup should appear for the trend section in this state.
    expect(html).not.toContain('aria-label="Total violations over time');
  });

  it('says there is not enough data with zero recorded runs', () => {
    const html = renderDashboard(RULES, ['analyzer'], []);
    expect(html).toContain('No runs have been recorded yet');
  });

  it('draws a chart once two or more runs exist', () => {
    const html = renderDashboard(
      RULES,
      ['analyzer'],
      [
        record({ commit: 'a', totalViolations: 5, ruleCounts: { 'no-any': 5 } }),
        record({ commit: 'b', totalViolations: 2, ruleCounts: { 'no-any': 2 } }),
      ],
    );
    expect(html).toContain('aria-label="Total violations over time, 2 runs"');
    expect(html).not.toContain('Not enough data for a trend');
  });
});

describe('renderDashboard never-fired view', () => {
  it('withholds judgment with no history rather than declaring every rule never-fired', () => {
    const html = renderDashboard(RULES, ['analyzer'], []);
    expect(html).toContain('No run history yet');
    expect(html).not.toContain('have produced no finding');
  });

  it('lists an enabled rule that never fired, and says it is not a success', () => {
    const html = renderDashboard(
      RULES,
      ['analyzer'],
      [record({ ruleCounts: { 'no-any': 4 } })],
    );
    expect(html).toContain('no-console');
    expect(html).toContain('That asymmetry is the signal');
  });

  it('does not list a rule that is not enabled at all, even though it never fired', () => {
    // Only 'no-any' is passed as enabled; 'no-console' never appears in the
    // enabled rule set at all. It must not show up in the never-fired list —
    // that would misrepresent "not enabled" as "never fired".
    const html = renderDashboard([rule({ id: 'no-any' })], ['analyzer'], [record({ ruleCounts: { 'no-any': 4 } })]);
    expect(html).not.toContain('no-console');
    expect(html).toContain('Every enabled rule has fired');
  });
});

describe('renderDashboard interlock graph', () => {
  it('renders a graph block per pack', () => {
    const a = rule({ id: 'a', pack: 'core-ts' });
    const b = rule({ id: 'b', pack: 'core-cs' });
    const html = renderDashboard([a, b], ['analyzer'], []);

    expect(html).toContain('class="graph-grid"');
    expect(html).toContain('<code>core-ts</code>');
    expect(html).toContain('<code>core-cs</code>');
  });

  it('renders per-pack isolation messages', () => {
    const ts = rule({ id: 'ts-a', pack: 'core-ts' });
    const cs = rule({ id: 'cs-a', pack: 'core-cs' });
    const html = renderDashboard([ts, cs], ['analyzer'], []);

    expect(html).toContain('isolated within the core-ts pack');
    expect(html).toContain('isolated within the core-cs pack');
  });

  it('does not draw an edge from a rule in one pack to a rule in another', () => {
    const ts = rule({
      id: 'ts-a',
      pack: 'core-ts',
      notFixes: [{ pattern: 'fix', because: 'bad', rule: 'cs-a' }],
    });
    const cs = rule({ id: 'cs-a', pack: 'core-cs' });
    const html = renderDashboard([ts, cs], ['analyzer'], []);

    // The cross-pack reference is surfaced as a dangling pattern in the ts group.
    expect(html).toContain('1 dead ends that are simply bad ideas');
  });
});

describe('renderDashboard evidence pill', () => {
  it('renders an evidence pill for every rule', () => {
    const html = renderDashboard(RULES, ['analyzer'], []);
    const pills = html.match(/<span class="pill">unspecified<\/span>/g);
    expect(pills?.length).toBeGreaterThanOrEqual(2);
  });

  it('shows syntax and semantic evidence when present', () => {
    const syntax = rule({ id: 'syntax-rule', evidence: 'syntax' });
    const semantic = rule({ id: 'semantic-rule', evidence: 'semantic' });
    const html = renderDashboard([syntax, semantic], ['analyzer'], []);

    expect(html).toContain('<span class="pill">syntax</span>');
    expect(html).toContain('<span class="pill">semantic</span>');
  });

  it('shows omitted evidence as unspecified, never as semantic', () => {
    const noEvidence = rule({ id: 'no-evidence' });
    const html = renderDashboard([noEvidence], ['analyzer'], []);

    expect(html).toContain('<span class="pill">unspecified</span>');
    expect(html).not.toContain('<span class="pill">semantic</span>');
  });

  it('includes the evidence explanation prose', () => {
    const html = renderDashboard(RULES, ['analyzer'], []);

    expect(html).toContain('Each rule lists its evidence kind');
    expect(html).toContain('<code>semantic</code> findings come from a type system');
    expect(html).toContain('<code>syntax</code> findings from shape alone');
    expect(html).toContain('difference is confidence rather than importance');
    expect(html).toContain('Omitted is shown as <code>unspecified</code>');
  });
});

describe('renderDashboard escaping', () => {
  it('escapes rule content so it cannot break out of the HTML document', () => {
    const dangerous = rule({ id: 'no-any', summary: '<script>alert(1)</script>' });
    const html = renderDashboard([dangerous], ['analyzer'], []);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

function baselineEntry(overrides: Partial<BaselineEntry> & { ruleId: string; path: string }): BaselineEntry {
  return { fingerprint: 'fp', occurrence: 0, line: 1, ...overrides };
}

function baseline(entries: BaselineEntry[]): Baseline {
  return {
    header: { version: 1, takenAt: '2026-01-01T00:00:00.000Z', commit: 'abc123def456' },
    entries,
    repoRoot: '/repo',
  };
}

function suppression(overrides: Partial<Suppression> & { ruleId: string }): Suppression {
  return { target: '**/*', reason: 'reason', expires: '2099-01-01', ...overrides };
}

describe('renderDashboard baseline section', () => {
  it('says no baseline has been taken, and never as "0 remaining"', () => {
    const html = renderDashboard(RULES, ['analyzer'], []);
    expect(html).toContain('<h2>Baseline</h2>');
    expect(html).toContain('No baseline has been taken');
    expect(html).not.toMatch(/0\s+(entr(y|ies)|remaining)/);
  });

  it('distinguishes an empty baseline from no baseline at all', () => {
    const debt: DashboardDebtInput = {
      baseline: baseline([]),
      suppressionsConfigured: false,
      suppressions: [],
      repoRoot: '/repo',
    };
    const html = renderDashboard(RULES, ['analyzer'], [], undefined, debt);
    expect(html).toContain('0 entries recorded');
    expect(html).not.toContain('No baseline has been taken');
  });

  it('reports a populated baseline by rule and by file', () => {
    const debt: DashboardDebtInput = {
      baseline: baseline([
        baselineEntry({ ruleId: 'no-any', path: 'a.ts' }),
        baselineEntry({ ruleId: 'no-any', path: 'a.ts', occurrence: 1 }),
      ]),
      suppressionsConfigured: false,
      suppressions: [],
      repoRoot: '/repo',
    };
    const html = renderDashboard(RULES, ['analyzer'], [], undefined, debt);
    expect(html).toContain('2 entries recorded');
    expect(html).toContain('By rule');
    expect(html).toContain('By file (worst first)');
    expect(html).toContain('a.ts');
  });
});

describe('renderDashboard suppressions section', () => {
  it('says no suppressions are configured when the key is absent', () => {
    const html = renderDashboard(RULES, ['analyzer'], []);
    expect(html).toContain('<h2>Suppressions</h2>');
    expect(html).toContain('No suppressions are configured');
  });

  it('distinguishes an explicitly empty suppression list from not-configured', () => {
    const debt: DashboardDebtInput = {
      baseline: null,
      suppressionsConfigured: true,
      suppressions: [],
      repoRoot: '/repo',
    };
    const html = renderDashboard(RULES, ['analyzer'], [], undefined, debt);
    expect(html).toContain('the list is currently empty');
    expect(html).not.toContain('No suppressions are configured');
  });

  it('renders an expired suppression visibly distinct from an active one', () => {
    const active = suppression({ ruleId: 'no-any', expires: '2099-01-01' });
    const expired = suppression({ ruleId: 'no-console', expires: '2020-01-01' });
    const debt: DashboardDebtInput = {
      baseline: null,
      suppressionsConfigured: true,
      suppressions: [active, expired],
      repoRoot: '/repo',
      now: new Date('2026-01-01'),
    };
    const html = renderDashboard(RULES, ['analyzer'], [], undefined, debt);

    expect(html).toContain('1 active suppression(s)');
    expect(html).toContain('EXPIRED');
    expect(html).toContain('class="expired-row"');
    expect(html).toContain('EXPIRED and no longer suppressing anything');
  });

  it('splits the active count into broad and pinned, the way cyv check reports it', () => {
    const broad = suppression({ ruleId: 'no-any', expires: '2099-01-01' });
    const pinned = suppression({
      ruleId: 'no-console',
      expires: '2099-01-01',
      fingerprint: 'a'.repeat(64),
      occurrence: 2,
    });
    const debt: DashboardDebtInput = {
      baseline: null,
      suppressionsConfigured: true,
      suppressions: [broad, pinned],
      repoRoot: '/repo',
      now: new Date('2026-01-01'),
    };
    const html = renderDashboard(RULES, ['analyzer'], [], undefined, debt);

    expect(html).toContain('2 active suppression(s)');
    expect(html).toContain('1 broad, 1 pinned');
    expect(html).toContain('every match, including');
    expect(html).toContain('one finding (fingerprint, occurrence 2)');
  });

  it('does not describe a pinned suppression as covering every match of a glob', () => {
    const pinned = suppression({
      ruleId: 'no-any',
      expires: '2099-01-01',
      fingerprint: 'a'.repeat(64),
    });
    const debt: DashboardDebtInput = {
      baseline: null,
      suppressionsConfigured: true,
      suppressions: [pinned],
      repoRoot: '/repo',
      now: new Date('2026-01-01'),
    };
    const html = renderDashboard(RULES, ['analyzer'], [], undefined, debt);

    expect(html).toContain('1 active suppression(s)');
    expect(html).toContain('0 broad, 1 pinned');
    expect(html).toContain('one finding (fingerprint)');
    expect(html).not.toContain('every match, including');
  });

  it('escapes a suppression reason so it cannot break out of the document', () => {
    const dangerous = suppression({
      ruleId: 'no-any',
      reason: '<script>alert(1)</script>',
      expires: '2099-01-01',
    });
    const debt: DashboardDebtInput = {
      baseline: null,
      suppressionsConfigured: true,
      suppressions: [dangerous],
      repoRoot: '/repo',
      now: new Date('2026-01-01'),
    };
    const html = renderDashboard(RULES, ['analyzer'], [], undefined, debt);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('does not claim a suppression count is a count of currently hidden findings', () => {
    const html = renderDashboard(RULES, ['analyzer'], []);
    expect(html).toContain('not a count of findings currently hidden');
  });
});

describe('renderDashboard per-rule debt pills', () => {
  it('shows nothing for a rule with neither an active suppression nor a baseline entry', () => {
    const debt: DashboardDebtInput = {
      baseline: baseline([baselineEntry({ ruleId: 'no-any', path: 'a.ts' })]),
      suppressionsConfigured: false,
      suppressions: [],
      repoRoot: '/repo',
    };
    const html = renderDashboard(RULES, ['analyzer'], [], undefined, debt);
    // no-any gets an annotation; no-console must not get an empty "0" row.
    expect(html).toContain('1 baseline entry');
    expect(html).not.toMatch(/no-console[\s\S]{0,400}0 baseline/);
  });

  it('shows both counts beside a rule with both an active suppression and a baseline entry', () => {
    const debt: DashboardDebtInput = {
      baseline: baseline([baselineEntry({ ruleId: 'no-any', path: 'a.ts' })]),
      suppressionsConfigured: true,
      suppressions: [suppression({ ruleId: 'no-any', expires: '2099-01-01' })],
      repoRoot: '/repo',
      now: new Date('2026-01-01'),
    };
    const html = renderDashboard(RULES, ['analyzer'], [], undefined, debt);
    expect(html).toContain('1 baseline entry');
    expect(html).toContain('1 broad suppression<');
  });

  it('keeps a broad suppression distinct from a pinned one beside the same rule', () => {
    const debt: DashboardDebtInput = {
      baseline: null,
      suppressionsConfigured: true,
      suppressions: [
        suppression({ ruleId: 'no-any', expires: '2099-01-01' }),
        suppression({ ruleId: 'no-any', expires: '2099-01-01', fingerprint: 'c'.repeat(64) }),
      ],
      repoRoot: '/repo',
      now: new Date('2026-01-01'),
    };
    const html = renderDashboard(RULES, ['analyzer'], [], undefined, debt);
    expect(html).toContain('1 broad suppression<');
    expect(html).toContain('1 pinned suppression<');
    expect(html).not.toContain('2 active suppressions<');
  });
});

describe('renderDashboard debt with no rule to sit beside', () => {
  it('says nothing when every rule carrying debt is enabled', () => {
    const debt: DashboardDebtInput = {
      baseline: baseline([baselineEntry({ ruleId: 'no-any', path: 'a.ts' })]),
      suppressionsConfigured: false,
      suppressions: [],
      repoRoot: '/repo',
    };
    const html = renderDashboard(RULES, ['analyzer'], [], undefined, debt);
    expect(html).not.toContain('this configuration does not enable');
  });

  it('names a baselined rule that is not enabled, rather than dropping its entries silently', () => {
    const debt: DashboardDebtInput = {
      baseline: baseline([
        baselineEntry({ ruleId: 'renamed-rule', path: 'a.ts' }),
        baselineEntry({ ruleId: 'no-any', path: 'a.ts', occurrence: 1 }),
      ]),
      suppressionsConfigured: false,
      suppressions: [],
      repoRoot: '/repo',
    };
    const html = renderDashboard(RULES, ['analyzer'], [], undefined, debt);
    expect(html).toContain('1 rule id(s) carry a baseline entry or an active');
    expect(html).toContain('renamed-rule');
    expect(html).toContain('this configuration does not enable');
  });
});

describe('renderDashboard file heat section (docs/ROADMAP.md, "0031 — The dashboard as something you would leave open")', () => {
  it('says there is no run history yet, distinct from tracked-but-clean', () => {
    const html = renderDashboard(RULES, ['analyzer'], []);
    expect(html).toContain('<h2>File heat</h2>');
    expect(html).toContain('No run history yet');
  });

  it('says recorded runs predate per-file tracking, distinct from no history at all', () => {
    // Legacy records (no `fileCounts` key) still exist from before this
    // feature shipped — this must not read as "no data" outright, and must
    // not silently draw an all-zero heat table either.
    const html = renderDashboard(RULES, ['analyzer'], [record({ ruleCounts: { 'no-any': 4 } })]);
    expect(html).toContain('predate per-file tracking');
    expect(html).not.toContain('No run history yet');
  });

  it('says there is nothing to report when tracked runs are all clean, distinct from untracked', () => {
    const html = renderDashboard(RULES, ['analyzer'], [record({ fileCounts: {} })]);
    expect(html).toContain('every one of them is zero');
    expect(html).not.toContain('predate per-file tracking');
  });

  it('ranks files by latest recorded count and lists files getting worse', () => {
    const html = renderDashboard(
      RULES,
      ['analyzer'],
      [
        record({ commit: 'a', fileCounts: { 'src/hot.ts': 1, 'src/cold.ts': 5 } }),
        record({ commit: 'b', fileCounts: { 'src/hot.ts': 4, 'src/cold.ts': 5 } }),
      ],
    );
    expect(html).toContain('src/hot.ts');
    expect(html).toContain('src/cold.ts');
    expect(html).toContain('Getting worse');
  });

  it('says nothing got worse when no file rose, rather than an empty "getting worse" table', () => {
    const html = renderDashboard(
      RULES,
      ['analyzer'],
      [record({ commit: 'a', fileCounts: { 'src/a.ts': 3 } }), record({ commit: 'b', fileCounts: { 'src/a.ts': 1 } })],
    );
    expect(html).toContain("No file's count rose since the previous run");
  });

  it('escapes a hostile file path so it cannot break out of the document', () => {
    const dangerous = '<script>alert(1)</script>.ts';
    const html = renderDashboard(RULES, ['analyzer'], [record({ fileCounts: { [dangerous]: 2 } })]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;.ts');
  });
});

describe('renderVolatilePanels', () => {
  it('renders nothing when no rules are enabled, matching renderDashboard', () => {
    expect(renderVolatilePanels([], [])).toBe('');
  });

  it('renders the same volatile sections renderDashboard embeds under #volatile', () => {
    const history = [record({ fileCounts: { 'a.ts': 2 } })];
    const fragment = renderVolatilePanels(RULES, history);
    expect(fragment).toContain('<h2>Results</h2>');
    expect(fragment).toContain('<h2>Trend</h2>');
    expect(fragment).toContain('<h2>Never-fired rules</h2>');
    expect(fragment).toContain('<h2>File heat</h2>');
    expect(fragment).toContain('<h2>Baseline</h2>');
    expect(fragment).toContain('<h2>Suppressions</h2>');
    // It must not repeat the static shell: no rule browser, no full document.
    expect(fragment).not.toContain('<h2>Rules');
    expect(fragment).not.toContain('<!doctype html>');
  });

  it('escapes a hostile rule id the same way inside the volatile fragment', () => {
    const dangerous = '<img src=x onerror=alert(1)>';
    const fragment = renderVolatilePanels(
      [rule({ id: 'no-any' })],
      [record({ ruleCounts: { [dangerous]: 3 }, totalViolations: 3 })],
    );
    expect(fragment).not.toContain('<img src=x onerror=alert(1)>');
    expect(fragment).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('renderDashboard auto-refresh (docs/ROADMAP.md, "0031 — The dashboard as something you would leave open")', () => {
  it('wraps the volatile panels in a container the client script can replace', () => {
    const html = renderDashboard(RULES, ['analyzer'], []);
    expect(html).toContain('id="volatile"');
  });

  it('shows a visible freshness indicator distinct from the panel content', () => {
    const html = renderDashboard(RULES, ['analyzer'], []);
    expect(html).toContain('id="freshness"');
  });

  it('polls the same volatile fragment endpoint the CLI serves', () => {
    const html = renderDashboard(RULES, ['analyzer'], []);
    expect(html).toContain('/volatile.html');
  });

  it('omits the freshness bar entirely when no rules are enabled, like every other volatile panel', () => {
    const html = renderDashboard([], ['analyzer'], []);
    expect(html).not.toContain('id="freshness"');
  });
});

describe('renderDashboard never-fired: the clean-codebase case', () => {
  it('withholds judgement when NO rule fired in any run, rather than blaming every rule', () => {
    // Found by pointing this view at checkyourvibe's own repository, which sits
    // at zero violations. It reported "13 enabled rules have produced no
    // finding — this is not a success", naming every rule as suspect. But when
    // nothing fired at all, every rule is trivially "never fired", and that is a
    // fact about the codebase being clean rather than evidence about any rule.
    // Conflating those two states is the failure this view exists to catch.
    const html = renderDashboard(RULES, ['analyzer'], [record({ ruleCounts: {} })]);

    expect(html).toContain('nothing to say yet');
    expect(html).not.toContain('That asymmetry is the signal');
  });
});
