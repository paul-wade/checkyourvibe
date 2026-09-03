import type { RuleManifest } from '../protocol/index.js';
import type { RunRecord } from './history.js';
import type { Baseline } from '../baseline/index.js';
import { evaluateSuppressions, type Suppression } from '../baseline/index.js';

/**
 * The shape the dashboard renders, derived entirely from static rule manifests.
 *
 * Nothing here executes an analyzer. Browsing rules costs no toolchain startup,
 * which is the whole reason manifests are static — a user evaluating the tool
 * should be able to read every rule before installing a compiler.
 */

export interface GraphNode {
  id: string;
  /** The interlock group this rule belongs to (pack or analyzer). */
  group: string;
  category: string;
  pack: string | undefined;
  severity: string;
  summary: string;
  /** Edges leaving this rule that name another rule. */
  outDegree: number;
  /** Edges arriving from another rule. */
  inDegree: number;
  /** Dead ends that are bad ideas rather than other rules' violations. */
  terminalCount: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  pattern: string;
  because: string;
}

export interface InterlockGraph {
  /** Pack or analyzer id, depending on what ownership signal was provided. */
  group: string;
  /** Whether `group` came from an analyzer mapping or from `rule.pack`. */
  kind: 'pack' | 'analyzer';
  nodes: GraphNode[];
  edges: GraphEdge[];
  /**
   * Rules with no edges in either direction within this group.
   *
   * Not wrong, but not participating in the interlock either — and the interlock
   * is what makes a rule pack more than a pile of independent checks. Worth
   * surfacing rather than leaving to be noticed.
   */
  isolated: string[];
  /** notFix entries with no `rule` in this group, keyed by the rule that declares them. */
  danglingPatterns: { ruleId: string; pattern: string; because: string }[];
}

/**
 * Build one interlock graph per analyzer, falling back to `rule.pack` when no
 * analyzer mapping is supplied.
 *
 * A `notFix` can only reference a rule in its own analyzer, so edges are only
 * drawn between rules in the same group. Isolation is computed per group: a
 * four-rule pack with one isolated rule means something different from a
 * ten-rule pack doing so.
 */
export function buildInterlockGraph(
  rules: RuleManifest[],
  ruleAnalyzers?: Record<string, string>,
): InterlockGraph[] {
  const byGroup = new Map<string, { kind: 'pack' | 'analyzer'; rules: RuleManifest[] }>();

  for (const rule of rules) {
    const analyzerId = ruleAnalyzers?.[rule.id];
    const group = analyzerId ?? rule.pack ?? 'unknown';
    const kind: 'pack' | 'analyzer' = analyzerId !== undefined ? 'analyzer' : 'pack';

    const bucket = byGroup.get(group);
    if (bucket === undefined) {
      byGroup.set(group, { kind, rules: [rule] });
    } else {
      bucket.rules.push(rule);
    }
  }

  const graphs: InterlockGraph[] = [];

  for (const [group, { kind, rules: groupRules }] of byGroup) {
    const byId = new Map(groupRules.map((rule) => [rule.id, rule]));
    const edges: GraphEdge[] = [];
    const danglingPatterns: InterlockGraph['danglingPatterns'] = [];
    const outCount = new Map<string, number>();
    const inCount = new Map<string, number>();
    const terminalCount = new Map<string, number>();

    const bump = (map: Map<string, number>, key: string): void => {
      map.set(key, (map.get(key) ?? 0) + 1);
    };

    for (const rule of groupRules) {
      for (const notFix of rule.notFixes) {
        const target = notFix.rule;
        if (target !== undefined && byId.has(target)) {
          edges.push({
            from: rule.id,
            to: target,
            pattern: notFix.pattern,
            because: notFix.because,
          });
          bump(outCount, rule.id);
          bump(inCount, target);
          continue;
        }
        // A notFix with no rule, or one that points outside this group,
        // is a dead end that is simply a bad idea rather than an edge within
        // this interlock. Those matter as much as the edges — dropping them
        // would make the guidance look thinner than it is.
        danglingPatterns.push({
          ruleId: rule.id,
          pattern: notFix.pattern,
          because: notFix.because,
        });
        bump(terminalCount, rule.id);
      }
    }

    const nodes: GraphNode[] = groupRules.map((rule) => ({
      id: rule.id,
      group,
      category: rule.category,
      pack: rule.pack,
      severity: rule.severity,
      summary: rule.summary,
      outDegree: outCount.get(rule.id) ?? 0,
      inDegree: inCount.get(rule.id) ?? 0,
      terminalCount: terminalCount.get(rule.id) ?? 0,
    }));

    const isolated = nodes
      .filter((node) => node.outDegree === 0 && node.inDegree === 0)
      .map((node) => node.id)
      .sort((a, b) => a.localeCompare(b));

    graphs.push({ group, kind, nodes, edges, isolated, danglingPatterns });
  }

  return graphs.sort((a, b) => a.group.localeCompare(b.group));
}

export interface RadialPoint {
  id: string;
  x: number;
  y: number;
}

/**
 * Lay the rules out on a circle.
 *
 * Deterministic and dependency-free, which matters more here than optimal edge
 * routing: a force-directed layout would need a library, would move on every
 * reload, and would make two screenshots of the same rule set incomparable.
 * A circle keeps every node visible at any pack size and every edge a simple
 * curve through the middle.
 */
export function radialLayout(
  ids: string[],
  cx: number,
  cy: number,
  radius: number,
): RadialPoint[] {
  const count = ids.length;
  if (count === 0) return [];

  return ids.map((id, index) => {
    // Start at the top and go clockwise, so the first rule is where a reader looks.
    const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
    return {
      id,
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    };
  });
}

/**
 * The dashboard's "results" view: the most recently recorded run, or an
 * explicit statement that none exists.
 *
 * `no-history` and a `latest` record whose `totalViolations` is `0` must
 * render as visually distinct states (Requirement 7.2, 7.3) — the first means
 * nobody has ever checked, the second means someone checked and found
 * nothing. Collapsing them into one "0" is the exact confusion this project
 * exists to catch everywhere else, and would be indefensible here.
 */
export type ResultsView =
  | { kind: 'no-history' }
  | { kind: 'latest'; record: RunRecord; runCount: number };

export function buildResultsView(history: readonly RunRecord[]): ResultsView {
  const last = history.at(-1);
  if (last === undefined) {
    return { kind: 'no-history' };
  }
  return { kind: 'latest', record: last, runCount: history.length };
}

/** One recorded run's counts, projected for charting. */
export interface TrendPoint {
  timestamp: string;
  commit: string;
  total: number;
  ruleCounts: Record<string, number>;
}

/**
 * Total-and-per-rule violation counts over time — or, with fewer than two
 * runs recorded, an explicit statement that there isn't enough data yet.
 *
 * A chart of one point implies a direction that does not exist (Requirement
 * 4.5), so `insufficient-data` is a distinct variant rather than a `trend`
 * with a single-element `points` array a renderer might draw anyway.
 */
export type Trend =
  | { kind: 'insufficient-data'; runCount: number }
  | { kind: 'trend'; points: TrendPoint[] };

export function buildTrend(history: readonly RunRecord[]): Trend {
  if (history.length < 2) {
    return { kind: 'insufficient-data', runCount: history.length };
  }
  return {
    kind: 'trend',
    points: history.map((record) => ({
      timestamp: record.timestamp,
      commit: record.commit,
      total: record.totalViolations,
      ruleCounts: record.ruleCounts,
    })),
  };
}

/** An enabled rule that produced zero findings across every recorded run. */
export interface NeverFiredRule {
  id: string;
  category: string;
  summary: string;
}

/**
 * Enabled rules that have never produced a finding across recorded history.
 *
 * Takes only the *enabled* rule manifests, never the full catalog — a rule
 * this project's configuration never turned on simply does not appear here,
 * which is what keeps it distinct from a rule that is on and has fired zero
 * times (Requirement 5.2). The two look identical in a naive report and mean
 * opposite things: one is "not part of this run", the other is a signal that
 * the rule may be redundant, mis-targeted, or silently broken.
 */
/**
 * The never-fired view has three states, and collapsing them is the same
 * mistake this view exists to catch.
 *
 * `no-history`  — nothing has been recorded; nothing can be concluded.
 * `no-evidence` — runs exist, but NO rule found anything in any of them. Every
 *                 rule is trivially "never fired", and that is a fact about the
 *                 codebase being clean, not about any rule being broken. Saying
 *                 "13 rules never fired, this is not a success" here would be
 *                 actively misleading — it was, until running this view against
 *                 this repository showed it.
 * `never-fired` — other rules HAVE fired, so a rule that stayed silent across
 *                 all of them is genuinely worth questioning.
 */
export type NeverFiredView =
  | { kind: 'no-history' }
  | { kind: 'no-evidence'; runCount: number }
  | { kind: 'never-fired'; rules: NeverFiredRule[]; runCount: number; totalFindings: number };

export function buildNeverFiredView(
  enabledRules: readonly RuleManifest[],
  history: readonly RunRecord[],
): NeverFiredView {
  if (history.length === 0) {
    return { kind: 'no-history' };
  }

  // Summed from ruleCounts rather than totalViolations, because the question
  // this view asks is "did ANY rule fire" — and ruleCounts is the direct answer.
  // A record whose totalViolations disagrees with its ruleCounts is incoherent;
  // deriving from the per-rule counts keeps the judgement anchored to the same
  // data the never-fired list is computed from.
  const totalFindings = history.reduce(
    (sum, record) =>
      sum + Object.values(record.ruleCounts).reduce((inner, count) => inner + count, 0),
    0,
  );
  if (totalFindings === 0) {
    return { kind: 'no-evidence', runCount: history.length };
  }

  return {
    kind: 'never-fired',
    rules: computeNeverFired(enabledRules, history),
    runCount: history.length,
    totalFindings,
  };
}

export function computeNeverFired(
  enabledRules: readonly RuleManifest[],
  history: readonly RunRecord[],
): NeverFiredRule[] {
  const everFired = new Set<string>();
  for (const record of history) {
    for (const [ruleId, count] of Object.entries(record.ruleCounts)) {
      if (count > 0) everFired.add(ruleId);
    }
  }

  return enabledRules
    .filter((rule) => !everFired.has(rule.id))
    .map((rule) => ({ id: rule.id, category: rule.category, summary: rule.summary }));
}

/**
 * Baseline and suppression debt (spec 0008, Requirement 3.6 and Requirement 5).
 *
 * Everything below reads the baseline file and the suppressions config as
 * they exist on disk. It deliberately does NOT run an analyzer to check
 * whether a baselined violation still exists, or whether a suppression's
 * path glob still matches something real — the dashboard's whole premise
 * (see render.ts's lede) is that it never executes analysis to render
 * itself. `cyv baseline --status` runs a live check and can say what
 * *remains after verifying against the current tree*; this page can only
 * honestly say what is *recorded*, and says exactly that rather than
 * borrowing the live command's wording for a number computed differently.
 */

function countBy<T>(items: readonly T[], keyFn: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Highest count first; ties broken by key so output is stable across renders. */
function sortedCounts(counts: Map<string, number>): [string, number][] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * The dashboard's baseline view. Three states, the same shape as
 * `NeverFiredView` above and for the same reason: collapsing "nobody has
 * taken one" and "someone took one and found nothing" into a single
 * "0 remaining" would read as success in both cases when only the second
 * one is.
 *
 * `no-baseline` — no baseline file exists. Says nothing about debt: the
 *                 codebase could be spotless or could have thousands of
 *                 violations that simply were never recorded anywhere.
 * `empty`       — a baseline was taken and it recorded zero entries. A
 *                 stronger, different claim than `no-baseline`: someone
 *                 actually ran the check and nothing needed deferring.
 * `populated`   — the real case: entries recorded, broken down by rule and
 *                 by file (worst first), the way `cyv baseline --status`
 *                 already reports it.
 */
export type BaselineView =
  | { kind: 'no-baseline' }
  | { kind: 'empty'; takenAt: string; commit: string }
  | {
      kind: 'populated';
      takenAt: string;
      commit: string;
      total: number;
      byRule: [string, number][];
      byFile: [string, number][];
    };

export function buildBaselineView(baseline: Baseline | null): BaselineView {
  if (baseline === null) {
    return { kind: 'no-baseline' };
  }
  if (baseline.entries.length === 0) {
    return { kind: 'empty', takenAt: baseline.header.takenAt, commit: baseline.header.commit };
  }
  return {
    kind: 'populated',
    takenAt: baseline.header.takenAt,
    commit: baseline.header.commit,
    total: baseline.entries.length,
    byRule: sortedCounts(countBy(baseline.entries, (entry) => entry.ruleId)),
    byFile: sortedCounts(countBy(baseline.entries, (entry) => entry.path)),
  };
}

/**
 * The dashboard's suppressions view. Three states, mirroring `BaselineView`
 * above for the same reason (Requirement 3.6): "nobody configured this" and
 * "configured, currently empty" are different facts and must not collapse.
 *
 * `not-configured` — `checkyourvibe.json` has no `suppressions` key at all
 *                     (or no config file exists). Nobody has used this
 *                     feature; says nothing about whether the codebase
 *                     needs it.
 * `empty`           — the key is present and is an empty list. Someone
 *                      turned this on and there is currently nothing
 *                      deferred through it.
 * `configured`      — the real case: active and expired suppressions,
 *                      split apart (Requirement 3.3 — an expired
 *                      suppression suppresses nothing and must not be
 *                      shown as though it still does).
 */
export type SuppressionsView =
  | { kind: 'not-configured' }
  | { kind: 'empty' }
  | {
      kind: 'configured';
      active: Suppression[];
      expiringWithin30DaysCount: number;
      expired: Suppression[];
    };

/**
 * How much a suppression covers.
 *
 * `broad`  — only a rule id and a path glob, so it suppresses every occurrence
 *            of that rule under the matched path, including violations written
 *            after it (see `evaluateSuppressions`, and T8009).
 * `pinned` — carries a snippet `fingerprint`, so it matches one recorded
 *            finding and a new violation of the same rule in the same file is
 *            still reported.
 *
 * `evaluateSuppressions` splits the findings it suppresses along the same
 * line, into `broadSuppressed` and `pinnedSuppressed`. Rendering the two
 * scopes alike would state that a wholesale adoption suppression and a pinned
 * one hide the same amount, which is not what either does.
 */
export type SuppressionScope = 'broad' | 'pinned';

export function suppressionScope(suppression: Suppression): SuppressionScope {
  return suppression.fingerprint === undefined ? 'broad' : 'pinned';
}

/**
 * `configured` tells the caller whether `checkyourvibe.json` declares a
 * `suppressions` key at all — `loadSuppressions` itself cannot say, because
 * it returns `[]` both when the key is absent and when it is present but
 * empty (see that module's doc comment). The caller (`cli/dashboard.ts`)
 * determines `configured` from the raw config file, since that distinction
 * lives outside this module's inputs.
 *
 * The active/expired split reuses `evaluateSuppressions` rather than
 * reimplementing the expiry comparison, but is called with an empty
 * violation list: this view has no live violations to evaluate suppressions
 * against (see the module doc above), so only the fields that do not depend
 * on `violations` — `expired` and the active list derived from it — are
 * read. `activeCount` from that call is not reused for the same reason: it
 * would be correct here (it doesn't depend on `violations` either), but
 * `active.length` is the same number computed the honest way, so there is no
 * reason to read two fields that must always agree.
 */
export function buildSuppressionsView(
  suppressions: readonly Suppression[],
  configured: boolean,
  repoRoot: string,
  now: Date = new Date(),
): SuppressionsView {
  if (!configured) {
    return { kind: 'not-configured' };
  }
  if (suppressions.length === 0) {
    return { kind: 'empty' };
  }

  const result = evaluateSuppressions([], suppressions, repoRoot, now);
  const active = suppressions.filter((suppression) => !result.expired.includes(suppression));

  return {
    kind: 'configured',
    active,
    expiringWithin30DaysCount: result.expiringWithin30DaysCount,
    expired: result.expired,
  };
}

/** One file's finding trajectory across the runs that recorded per-file counts. */
export interface FileHeatEntry {
  path: string;
  /** Count per run-with-file-data, oldest to newest — aligned with `withData` in `computeFileHeat`. */
  series: number[];
  /** Count in the most recently recorded run that tracked files. */
  latest: number;
  /** `latest` minus the previous run-with-data's count for this file. Positive means getting worse. */
  delta: number;
}

/**
 * Per-file heat: which files have carried the most findings, and which are
 * trending worse rather than better, across the runs that recorded per-file
 * counts (docs/ROADMAP.md, "0031 — The dashboard as something you would leave open").
 *
 * `RunRecord.fileCounts` (see history.ts) was added after `ruleCounts`
 * existed, so a record written before today simply lacks the field — that is
 * a different fact from "this run touched zero files" and must not collapse
 * into a heat table reading all zeroes. The same three-state discipline as
 * `NeverFiredView` and `BaselineView` applies (see `buildNeverFiredView`'s
 * doc comment for why collapsing states here is the exact failure this
 * project exists to catch), split one step further because "no data" here
 * has two distinct causes worth telling apart:
 *
 * `no-history`   — no run has ever been recorded at all.
 * `no-file-data` — runs exist, but every one of them predates per-file
 *                  tracking. Distinct from `no-history`: the results and
 *                  trend panels above will show real data while this one
 *                  cannot, and a reader deserves to know why rather than
 *                  read it as a bug in this view specifically.
 * `no-evidence`  — at least one run recorded file-level counts, but every
 *                  one of them is zero. Mirrors `buildNeverFiredView`'s
 *                  `no-evidence`: "nothing to report" is a fact about the
 *                  codebase, not the same claim as "nobody ever checked".
 * `heat`         — the real case: files ranked by their most recently
 *                  recorded count, each with a delta against the run before
 *                  it — never invented from the latest run alone.
 */
export type FileHeatView =
  | { kind: 'no-history' }
  | { kind: 'no-file-data'; runCount: number }
  | { kind: 'no-evidence'; runCount: number; runsWithFileData: number }
  | { kind: 'heat'; runCount: number; runsWithFileData: number; files: FileHeatEntry[] };

export function buildFileHeatView(history: readonly RunRecord[]): FileHeatView {
  if (history.length === 0) {
    return { kind: 'no-history' };
  }

  const withData = history.filter((record) => record.fileCounts !== undefined);
  if (withData.length === 0) {
    return { kind: 'no-file-data', runCount: history.length };
  }

  // Summed the same way `buildNeverFiredView` sums `totalFindings`: the
  // question is "did ANY file carry a finding in ANY tracked run", so the
  // per-file counts are the direct answer rather than a value derived some
  // other way that could disagree with them.
  const totalFileFindings = withData.reduce(
    (sum, record) =>
      sum + Object.values(record.fileCounts ?? {}).reduce((inner, count) => inner + count, 0),
    0,
  );
  if (totalFileFindings === 0) {
    return { kind: 'no-evidence', runCount: history.length, runsWithFileData: withData.length };
  }

  return {
    kind: 'heat',
    runCount: history.length,
    runsWithFileData: withData.length,
    files: computeFileHeat(withData),
  };
}

/**
 * Build one entry per file that appears in at least one record's
 * `fileCounts`, ranked by latest count. `withData` must already be filtered
 * to records that carry `fileCounts` — callers needing that filter applied
 * should go through `buildFileHeatView` rather than calling this directly.
 */
export function computeFileHeat(withData: readonly RunRecord[]): FileHeatEntry[] {
  const paths = new Set<string>();
  for (const record of withData) {
    for (const path of Object.keys(record.fileCounts ?? {})) {
      paths.add(path);
    }
  }

  return [...paths]
    .map((path) => {
      const series = withData.map((record) => record.fileCounts?.[path] ?? 0);
      const lastIndex = series.length - 1;
      const latest = series[lastIndex] ?? 0;
      const previous = lastIndex > 0 ? (series[lastIndex - 1] ?? 0) : latest;
      return { path, series, latest, delta: latest - previous };
    })
    .sort((a, b) => b.latest - a.latest || a.path.localeCompare(b.path));
}

/** Active-suppression and baseline-entry counts for one rule. */
export interface RuleDebt {
  /** Active suppressions covering every match of a path glob (see `suppressionScope`). */
  broadSuppressions: number;
  /** Active suppressions pinned to one finding by snippet fingerprint. */
  pinnedSuppressions: number;
  baselineEntries: number;
}

/**
 * Per-rule debt, keyed by rule id — beside each rule in the rule browser
 * (Requirement 3.6). A rule id absent from this map has neither an active
 * suppression nor a baseline entry, and the caller must render nothing for
 * it rather than a row of zeroes: an unannotated rule and a rule explicitly
 * shown as "0 of everything" read very differently, and only the first is
 * true here.
 *
 * Suppressions are counted by scope rather than totalled, because "suppressed
 * everywhere" is the claim Requirement 3.6 is about — a rule carrying one
 * broad suppression and a rule carrying one pinned suppression describe
 * different agreements with the rule.
 */
export function buildRuleDebtMap(
  baselineView: BaselineView,
  suppressionsView: SuppressionsView,
): Map<string, RuleDebt> {
  const baselineByRule = new Map(baselineView.kind === 'populated' ? baselineView.byRule : []);
  const active = suppressionsView.kind === 'configured' ? suppressionsView.active : [];
  const broadByRule = countBy(
    active.filter((suppression) => suppressionScope(suppression) === 'broad'),
    (suppression) => suppression.ruleId,
  );
  const pinnedByRule = countBy(
    active.filter((suppression) => suppressionScope(suppression) === 'pinned'),
    (suppression) => suppression.ruleId,
  );

  const ruleIds = new Set([
    ...baselineByRule.keys(),
    ...broadByRule.keys(),
    ...pinnedByRule.keys(),
  ]);
  const debt = new Map<string, RuleDebt>();
  for (const ruleId of ruleIds) {
    debt.set(ruleId, {
      broadSuppressions: broadByRule.get(ruleId) ?? 0,
      pinnedSuppressions: pinnedByRule.get(ruleId) ?? 0,
      baselineEntries: baselineByRule.get(ruleId) ?? 0,
    });
  }
  return debt;
}

/**
 * Rule ids carrying recorded debt that are not among the rules this
 * configuration enables.
 *
 * Requirement 3.6 asks for suppressions and baseline entries shown *beside the
 * rules they name*. A rule id nobody enabled has no row in the browser to sit
 * beside, so its debt is rendered nowhere and the reader has no way to notice
 * the omission. `cyv baseline --status` names these too; here they are named so
 * the pills' absence is a stated fact rather than a silent drop.
 *
 * Sorted, so two renders of the same state produce the same page.
 */
export function unattachedDebtRuleIds(
  debt: ReadonlyMap<string, RuleDebt>,
  enabledRules: readonly RuleManifest[],
): string[] {
  const enabled = new Set(enabledRules.map((rule) => rule.id));
  return [...debt.keys()].filter((id) => !enabled.has(id)).sort((a, b) => a.localeCompare(b));
}
