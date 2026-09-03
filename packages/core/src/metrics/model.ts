/**
 * Rule quality metrics (spec 0018).
 *
 * Every metric here is computed from data already on disk: the run history
 * ndjson, the baseline file, and the suppression list. No metric invents new
 * collection, calls out to a network, requires a key, or spends a token.
 *
 * The guiding discipline is Requirement 1: each metric declares the evidence it
 * needs first, reports "not enough evidence" as a distinct state rather than a
 * flattering zero, and names an action a team can take from any genuine
 * reading.
 */
import { buildNeverFiredView } from '../dashboard/model.js';
import type { RunRecord } from '../dashboard/history.js';
import { entryKey } from '../baseline/identity.js';
import { suppressionCoverage } from '../baseline/index.js';
import type { Baseline, Suppression } from '../baseline/index.js';
import type { RuleManifest } from '../protocol/index.js';

/** A rule as the metrics surface needs to name it. */
export interface RuleRef {
  id: string;
  category: string;
  summary: string;
}

function toRuleRef(rule: RuleManifest | undefined, ruleId: string): RuleRef {
  if (rule === undefined) {
    return { id: ruleId, category: 'unknown', summary: 'Rule not in current manifest.' };
  }
  return { id: rule.id, category: rule.category, summary: rule.summary };
}

function refFromKnown(ruleId: string, knownById: Map<string, RuleManifest>): RuleRef {
  return toRuleRef(knownById.get(ruleId), ruleId);
}

function totalFiredByRule(history: readonly RunRecord[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const record of history) {
    for (const [ruleId, count] of Object.entries(record.ruleCounts)) {
      totals.set(ruleId, (totals.get(ruleId) ?? 0) + count);
    }
  }
  return totals;
}

function isExpired(suppression: Suppression, now: Date): boolean {
  return new Date(`${suppression.expires}T00:00:00Z`).getTime() < now.getTime();
}

function uniqueReasons(suppressions: readonly Suppression[]): string[] {
  const seen = new Set<string>();
  const reasons: string[] = [];
  for (const suppression of suppressions) {
    const trimmed = suppression.reason.trim();
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      reasons.push(trimmed);
    }
  }
  return reasons;
}

// ---------- Never fired ----------

export type NeverFiredMetric =
  | { kind: 'no-history'; runCount: number; action: string }
  | { kind: 'no-evidence'; runCount: number; totalFindings: number; action: string }
  | { kind: 'never-fired'; runCount: number; totalFindings: number; rules: RuleRef[]; action: string };

export function buildNeverFiredMetric(
  enabledRules: readonly RuleManifest[],
  history: readonly RunRecord[],
): NeverFiredMetric {
  const view = buildNeverFiredView(enabledRules, history);

  if (view.kind === 'no-history') {
    return {
      kind: 'no-history',
      runCount: 0,
      action: 'Run `cyv check --record-history` at least once to collect evidence.',
    };
  }

  if (view.kind === 'no-evidence') {
    return {
      kind: 'no-evidence',
      runCount: view.runCount,
      totalFindings: 0,
      action:
        'No rule has fired in any recorded run, so an enabled rule that stayed silent is not evidence of a bad rule. Record more runs once the codebase has real findings to compare.',
    };
  }

  const action =
    'For each rule, confirm it still matches its intended pattern against a fixture. If it does, ask whether this codebase already prevents that pattern structurally; where the answer is yes, deleting the rule is the correct action.';

  return {
    kind: 'never-fired',
    runCount: view.runCount,
    totalFindings: view.totalFindings,
    rules: view.rules,
    action,
  };
}

// ---------- Suppression rate ----------

/**
 * Minimum recorded firings before a suppression rate can be told from a single
 * early suppression. The number is intentionally a small, conservative
 * constant: a rule that has only fired once or twice and been suppressed both
 * times is indistinguishable from a rule suppressed five hundred times.
 */
const MIN_FIRED_FOR_SUPPRESSION_RATE = 5;

export interface SuppressionRuleMetric {
  rule: RuleRef;
  totalFired: number;
  matchedFindings: number;
  broadFindings: number;
  pinnedFindings: number;
  broadEntries: number;
  pinnedEntries: number;
  suppressionEntries: number;
  reasons: string[];
  state: 'insufficient-evidence' | 'zero' | 'populated';
  action: string;
  rate?: number;
}

export type SuppressionMetric =
  | { kind: 'insufficient-evidence'; reason: string }
  | { kind: 'populated'; rules: SuppressionRuleMetric[] };

export function buildSuppressionMetric(
  knownRules: readonly RuleManifest[],
  history: readonly RunRecord[],
  baseline: Baseline | null,
  suppressions: readonly Suppression[],
  now: Date,
): SuppressionMetric {
  const active = suppressions.filter((suppression) => !isExpired(suppression, now));
  if (active.length === 0) {
    return {
      kind: 'insufficient-evidence',
      reason: 'No active suppressions to measure. A suppression rate needs both recorded suppressions and recorded firings.',
    };
  }

  const ruleById = new Map(knownRules.map((rule) => [rule.id, rule]));
  const fired = totalFiredByRule(history);

  const baselineByRule = new Map<string, Baseline['entries']>();
  if (baseline !== null) {
    for (const entry of baseline.entries) {
      const list = baselineByRule.get(entry.ruleId) ?? [];
      list.push(entry);
      baselineByRule.set(entry.ruleId, list);
    }
  }

  const ruleIds = new Set<string>();
  for (const suppression of active) {
    ruleIds.add(suppression.ruleId);
  }
  for (const ruleId of baselineByRule.keys()) {
    ruleIds.add(ruleId);
  }
  for (const ruleId of fired.keys()) {
    ruleIds.add(ruleId);
  }

  const rules: SuppressionRuleMetric[] = [];
  for (const ruleId of [...ruleIds].sort((a, b) => a.localeCompare(b))) {
    const ruleSuppressions = active.filter((suppression) => suppression.ruleId === ruleId);
    if (ruleSuppressions.length === 0 && (baselineByRule.get(ruleId) ?? []).length === 0) {
      continue;
    }

    const ruleBaseline = baselineByRule.get(ruleId) ?? [];
    const broadKeys = new Set<string>();
    const pinnedKeys = new Set<string>();

    // The same match `cyv check` performs, so a finding counted here is a
    // finding a run would actually have suppressed.
    const covers = suppressionCoverage(ruleSuppressions);
    for (const entry of ruleBaseline) {
      const coverage = covers(entry);
      if (coverage === 'pinned') {
        pinnedKeys.add(entryKey(entry));
      } else if (coverage === 'broad') {
        broadKeys.add(entryKey(entry));
      }
    }

    const broadEntries = ruleSuppressions.filter((s) => s.fingerprint === undefined).length;
    const pinnedEntries = ruleSuppressions.filter((s) => s.fingerprint !== undefined).length;
    const totalFired = fired.get(ruleId) ?? 0;
    const matched = broadKeys.size + pinnedKeys.size;

    let state: 'insufficient-evidence' | 'zero' | 'populated';
    let action: string;
    let rate: number | undefined;

    if (totalFired < MIN_FIRED_FOR_SUPPRESSION_RATE) {
      state = 'insufficient-evidence';
      rate = undefined;
      action = `This rule has only ${totalFired} recorded firing(s). A suppression rate needs at least ${MIN_FIRED_FOR_SUPPRESSION_RATE} recorded firings before a single early suppression can be told from a pattern of disagreement.`;
    } else if (matched === 0) {
      state = 'zero';
      rate = 0;
      action =
        'Active suppressions exist for this rule but none match the recorded baseline entries, so the current suppression rate is 0%. Remove stale suppressions or record more runs.';
    } else {
      state = 'populated';
      rate = matched / totalFired;
      action =
        'This rule is being routed around at a measurable rate. Review the reasons; if they show broad disagreement rather than a temporary migration, consider deleting the rule, loosening its severity, or narrowing its options.';
    }

    const metric: SuppressionRuleMetric = {
      rule: refFromKnown(ruleId, ruleById),
      totalFired,
      matchedFindings: matched,
      broadFindings: broadKeys.size,
      pinnedFindings: pinnedKeys.size,
      broadEntries,
      pinnedEntries,
      suppressionEntries: ruleSuppressions.length,
      reasons: uniqueReasons(ruleSuppressions),
      state,
      action,
      ...(rate !== undefined ? { rate } : {}),
    };

    rules.push(metric);
  }

  if (rules.length === 0) {
    return {
      kind: 'insufficient-evidence',
      reason: 'Active suppressions exist, but none target a rule with recorded firings or baseline entries.',
    };
  }

  return { kind: 'populated', rules };
}

// ---------- Burn rate / deferred indefinitely ----------

export interface BurnRateRuleMetric {
  rule: RuleRef;
  baselinedCount: number;
  earliest: { timestamp: string; count: number };
  latest: { timestamp: string; count: number };
  change: number;
  resolved: number;
  newFindings: number;
  state: 'resolving' | 'unchanged' | 'worsening';
  deferredIndefinitely: boolean;
  action: string;
}

export type BurnRateMetric =
  | { kind: 'insufficient-evidence'; reason: string }
  | { kind: 'populated'; rules: BurnRateRuleMetric[] };

export function buildBurnRateMetric(
  knownRules: readonly RuleManifest[],
  history: readonly RunRecord[],
  baseline: Baseline | null,
): BurnRateMetric {
  if (history.length < 2) {
    return {
      kind: 'insufficient-evidence',
      reason: `Only ${history.length} run(s) recorded. Burn-rate needs at least two recorded points to say anything about whether a rule's findings are being resolved or accumulating.`,
    };
  }

  const earliest = history[0];
  const latest = history.at(-1);
  if (earliest === undefined || latest === undefined) {
    return { kind: 'insufficient-evidence', reason: 'No recorded runs.' };
  }

  const ruleById = new Map(knownRules.map((rule) => [rule.id, rule]));
  const fired = totalFiredByRule(history);

  const baselineByRule = new Map<string, number>();
  if (baseline !== null) {
    for (const entry of baseline.entries) {
      baselineByRule.set(entry.ruleId, (baselineByRule.get(entry.ruleId) ?? 0) + 1);
    }
  }

  const ruleIds = new Set<string>();
  for (const ruleId of baselineByRule.keys()) {
    ruleIds.add(ruleId);
  }
  for (const ruleId of fired.keys()) {
    ruleIds.add(ruleId);
  }

  const rules: BurnRateRuleMetric[] = [];
  for (const ruleId of [...ruleIds].sort((a, b) => a.localeCompare(b))) {
    const baselinedCount = baselineByRule.get(ruleId) ?? 0;
    const totalFired = fired.get(ruleId) ?? 0;
    if (baselinedCount === 0 && totalFired === 0) {
      continue;
    }

    const earliestCount = earliest.ruleCounts[ruleId] ?? 0;
    const latestCount = latest.ruleCounts[ruleId] ?? 0;
    const change = latestCount - earliestCount;
    const state: 'resolving' | 'unchanged' | 'worsening' =
      change < 0 ? 'resolving' : change === 0 ? 'unchanged' : 'worsening';
    const resolved = Math.max(0, earliestCount - latestCount);
    const newFindings = Math.max(0, latestCount - earliestCount);
    const deferredIndefinitely = baselinedCount > 0 && change >= 0;

    let action: string;
    if (deferredIndefinitely) {
      action =
        "This rule's baselined findings are not decreasing across the observed window. Schedule the fix, accept the debt permanently, or reconsider whether the rule belongs enabled at its current severity.";
    } else if (state === 'resolving') {
      action =
        'Findings are being resolved. Use the remaining baselined count to decide whether to schedule the rest or continue as is.';
    } else if (state === 'worsening') {
      action =
        'New findings are appearing faster than old ones are resolved. Investigate the source before the debt grows.';
    } else {
      action =
        'No deferred findings recorded; this burn-rate compares raw fired counts and cannot claim a fix time for any individual violation.';
    }

    rules.push({
      rule: refFromKnown(ruleId, ruleById),
      baselinedCount,
      earliest: { timestamp: earliest.timestamp, count: earliestCount },
      latest: { timestamp: latest.timestamp, count: latestCount },
      change,
      resolved,
      newFindings,
      state,
      deferredIndefinitely,
      action,
    });
  }

  if (rules.length === 0) {
    return {
      kind: 'insufficient-evidence',
      reason: 'No rule has either a baseline entry or a recorded firing across the available history.',
    };
  }

  return { kind: 'populated', rules };
}

// ---------- Mis-scoped / fires too often ----------

/**
 * A rule must fire at least this many times the median peer rate to be
 * considered an outlier in one run, and it must do so in at least two runs
 * before the pattern is treated as sustained.
 */
const OUTLIER_FACTOR = 2;
const MIN_OUTLIER_RUNS = 2;

export interface MisScopedRuleMetric {
  rule: RuleRef;
  outlierRuns: number;
  peerContextRuns: number;
  totalRuns: number;
  totalFired: number;
  latestRate: number;
  medianPeerRate: number;
  suppressedCount: number;
  baselinedCount: number;
  burnChange: number;
  state: 'insufficient-evidence' | 'zero' | 'outlier';
  action: string;
}

export type MisScopedMetric =
  | { kind: 'insufficient-evidence'; reason: string }
  | { kind: 'populated'; rules: MisScopedRuleMetric[]; considered: number };

export function buildMisScopedMetric(
  enabledRules: readonly RuleManifest[],
  history: readonly RunRecord[],
  suppressionByRule: ReadonlyMap<string, SuppressionRuleMetric>,
  burnByRule: ReadonlyMap<string, BurnRateRuleMetric>,
): MisScopedMetric {
  if (history.length < 2) {
    return {
      kind: 'insufficient-evidence',
      reason: `Only ${history.length} run(s) recorded. A mis-scoped rule must show an outlier rate across multiple runs, not one.`,
    };
  }

  const ruleById = new Map(enabledRules.map((rule) => [rule.id, rule]));

  const totals = new Map<string, number>();
  for (const record of history) {
    for (const [ruleId, count] of Object.entries(record.ruleCounts)) {
      if (ruleById.has(ruleId)) {
        totals.set(ruleId, (totals.get(ruleId) ?? 0) + count);
      }
    }
  }

  const rules: MisScopedRuleMetric[] = [];
  let considered = 0;

  for (const ruleId of ruleById.keys()) {
    const rule = ruleById.get(ruleId);
    if (rule === undefined) {
      continue;
    }

    const totalFired = totals.get(ruleId) ?? 0;
    if (totalFired === 0) {
      continue;
    }
    considered += 1;

    const runDetails: {
      ruleRate: number;
      peerMedian: number;
      hasContext: boolean;
      isOutlier: boolean;
    }[] = [];

    for (const record of history) {
      const ruleCount = record.ruleCounts[ruleId] ?? 0;
      if (ruleCount === 0 || record.filesChecked === 0) {
        runDetails.push({ ruleRate: 0, peerMedian: 0, hasContext: false, isOutlier: false });
        continue;
      }

      const peerRates: number[] = [];
      for (const [otherId, otherCount] of Object.entries(record.ruleCounts)) {
        if (otherId === ruleId) {
          continue;
        }
        if (!ruleById.has(otherId)) {
          continue;
        }
        if (otherCount > 0) {
          peerRates.push(otherCount / record.filesChecked);
        }
      }

      if (peerRates.length === 0) {
        runDetails.push({
          ruleRate: ruleCount / record.filesChecked,
          peerMedian: 0,
          hasContext: false,
          isOutlier: false,
        });
        continue;
      }

      const sorted = peerRates.slice().sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median =
        sorted.length % 2 === 1
          ? (sorted.at(mid) ?? 0)
          : ((sorted.at(mid - 1) ?? 0) + (sorted.at(mid) ?? 0)) / 2;

      const ruleRate = ruleCount / record.filesChecked;
      const isOutlier = ruleRate >= OUTLIER_FACTOR * median;

      runDetails.push({ ruleRate, peerMedian: median, hasContext: true, isOutlier });
    }

    const outlierRuns = runDetails.filter((d) => d.isOutlier).length;
    const peerContextRuns = runDetails.filter((d) => d.hasContext).length;

    const latestContext = [...runDetails].reverse().find((d) => d.hasContext);
    const latestRate = latestContext?.ruleRate ?? 0;
    const medianPeerRate = latestContext?.peerMedian ?? 0;

    const suppressionMetric = suppressionByRule.get(ruleId);
    const burnMetric = burnByRule.get(ruleId);
    const suppressedCount = suppressionMetric?.matchedFindings ?? 0;
    const baselinedCount = burnMetric?.baselinedCount ?? 0;
    const burnChange = burnMetric?.change ?? 0;

    let state: 'insufficient-evidence' | 'zero' | 'outlier';
    let action: string;

    if (peerContextRuns < MIN_OUTLIER_RUNS) {
      state = 'insufficient-evidence';
      action = `Only ${peerContextRuns} recorded run(s) where this rule and at least one peer both fired. Without peer context, a high rate cannot be distinguished from a codebase with only one real pattern.`;
    } else if (outlierRuns < MIN_OUTLIER_RUNS) {
      state = 'zero';
      action = `Fires ${latestRate} per file in the latest run with peer context, not far enough above the median peer rate of ${medianPeerRate} to be flagged as mis-scoped across multiple runs.`;
    } else {
      state = 'outlier';
      action = `Fires ${latestRate} per file, at least ${OUTLIER_FACTOR}x the median peer rate of ${medianPeerRate}, in ${outlierRuns} run(s). If disposal (suppressed ${suppressedCount}, baselined ${baselinedCount}, burn change ${burnChange}) is comparable to its peers, it may be catching something real; if it is disproportionate, narrow the rule, split it by evidence, or leave it enabled and review a sample of findings before disabling.`;
    }

    rules.push({
      rule: { id: rule.id, category: rule.category, summary: rule.summary },
      outlierRuns,
      peerContextRuns,
      totalRuns: history.length,
      totalFired,
      latestRate,
      medianPeerRate,
      suppressedCount,
      baselinedCount,
      burnChange,
      state,
      action,
    });
  }

  return { kind: 'populated', rules, considered };
}

// ---------- Report ----------

export interface MetricsReport {
  runCount: number;
  rulesEnabled: number;
  neverFired: NeverFiredMetric;
  suppressionRate: SuppressionMetric;
  burnRate: BurnRateMetric;
  misScoped: MisScopedMetric;
}

export function buildMetricsReport(
  enabledRules: readonly RuleManifest[],
  knownRules: readonly RuleManifest[],
  history: readonly RunRecord[],
  baseline: Baseline | null,
  suppressions: readonly Suppression[],
  now: Date,
): MetricsReport {
  const neverFired = buildNeverFiredMetric(enabledRules, history);
  const suppressionMetric = buildSuppressionMetric(knownRules, history, baseline, suppressions, now);
  const burnRate = buildBurnRateMetric(knownRules, history, baseline);

  const suppressionByRule = new Map<string, SuppressionRuleMetric>(
    suppressionMetric.kind === 'populated' ? suppressionMetric.rules.map((r) => [r.rule.id, r]) : [],
  );
  const burnByRule = new Map<string, BurnRateRuleMetric>(
    burnRate.kind === 'populated' ? burnRate.rules.map((r) => [r.rule.id, r]) : [],
  );

  const misScoped = buildMisScopedMetric(enabledRules, history, suppressionByRule, burnByRule);

  return {
    runCount: history.length,
    rulesEnabled: enabledRules.length,
    neverFired,
    suppressionRate: suppressionMetric,
    burnRate,
    misScoped,
  };
}
