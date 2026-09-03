import type {
  MetricsReport,
  NeverFiredMetric,
  SuppressionMetric,
  BurnRateMetric,
  MisScopedMetric,
} from './model.js';

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function formatNeverFired(metric: NeverFiredMetric): string[] {
  const header = 'Never-fired rules';
  if (metric.kind === 'no-history') {
    return [
      header,
      '  Not enough data. No run history has been recorded yet, so there is no way to tell a rule that never fires from a rule that has never been checked.',
      `  Action: ${metric.action}`,
    ];
  }
  if (metric.kind === 'no-evidence') {
    return [
      header,
      `  No evidence yet. No rule has fired in ${metric.runCount} recorded run(s), so every rule is trivially "never fired". That is a fact about the codebase being clean, not a verdict on any rule.`,
      `  Action: ${metric.action}`,
    ];
  }
  if (metric.rules.length === 0) {
    return [
      header,
      `  Zero rules. Every enabled rule has fired at least once across ${metric.runCount} recorded run(s) and ${metric.totalFindings} total finding(s).`,
      `  Action: ${metric.action}`,
    ];
  }
  const lines: string[] = [
    header,
    `  ${metric.rules.length} enabled rule(s) have never fired across ${metric.runCount} recorded run(s), while other rules found ${metric.totalFindings} violation(s). That asymmetry is the signal: a rule silent while its neighbours fire is redundant, mis-targeted, or silently broken.`,
  ];
  for (const rule of metric.rules) {
    lines.push(`    ${rule.id} — ${rule.category} — ${rule.summary}`);
  }
  lines.push(`  Action: ${metric.action}`);
  return lines;
}

function formatSuppression(metric: SuppressionMetric): string[] {
  const header = 'Rules suppressed most often';
  if (metric.kind === 'insufficient-evidence') {
    return [
      header,
      `  Not enough data. ${metric.reason}`,
      '  A suppression rate needs both recorded firings and recorded suppressions to mean anything.',
    ];
  }
  const lines: string[] = [
    header,
    '  Suppressed count / recorded fired count. Broad (unpinned glob) and pinned (fingerprint) suppressions are counted separately.',
  ];
  for (const rule of metric.rules) {
    lines.push(`  ${rule.rule.id} — ${rule.rule.category} — ${rule.rule.summary}`);
    if (rule.state === 'insufficient-evidence') {
      lines.push(
        `    Not enough evidence: ${rule.totalFired} recorded firing(s), need at least 5; ${rule.matchedFindings} matched baseline entries.`,
      );
    } else {
      lines.push(
        `    ${formatPercent(rule.rate ?? 0)} of ${rule.totalFired} recorded firing(s) are suppressed (${rule.broadFindings} broad, ${rule.pinnedFindings} pinned).`,
      );
    }
    lines.push(
      `    ${rule.suppressionEntries} active suppression entry(s) (${rule.broadEntries} broad, ${rule.pinnedEntries} pinned). ` +
        `Reasons: ${rule.reasons.length > 0 ? rule.reasons.join('; ') : 'none given'}`,
    );
    lines.push(`    Action: ${rule.action}`);
  }
  return lines;
}

function formatBurnRate(metric: BurnRateMetric): string[] {
  const header = 'Findings deferred to baseline (burn-rate)';
  if (metric.kind === 'insufficient-evidence') {
    return [header, `  Not enough data. ${metric.reason}`];
  }
  const lines: string[] = [
    header,
    '  Count at the latest recorded point versus count at the earliest. Decrease means at least that many findings were resolved somewhere between the two runs; this is a bounded window, not a per-violation fix time.',
  ];
  for (const rule of metric.rules) {
    lines.push(`  ${rule.rule.id} — baselined ${rule.baselinedCount}`);
    lines.push(
      `    Fired count went from ${rule.earliest.count} at ${rule.earliest.timestamp} to ${rule.latest.count} at ${rule.latest.timestamp}. ` +
        `Resolved: ${rule.resolved}, new: ${rule.newFindings}. State: ${rule.state}.`,
    );
    if (rule.deferredIndefinitely) {
      lines.push('    These baselined findings have persisted across the observed window.');
    }
    lines.push(`    Action: ${rule.action}`);
  }
  return lines;
}

function formatMisScoped(metric: MisScopedMetric): string[] {
  const header = 'Rules that fire too often to be catching something real';
  if (metric.kind === 'insufficient-evidence') {
    return [header, `  Not enough data. ${metric.reason}`];
  }
  const outliers = metric.rules.filter((r) => r.state === 'outlier');
  const lines: string[] = [
    header,
    `  ${outliers.length} of ${metric.considered} observed rule(s) fire far above their peers across multiple runs. A raw count is not enough on its own; the signal is the rate relative to peers in the same run.`,
  ];
  if (outliers.length === 0) {
    lines.push('  No rule is an outlier in enough runs to look mis-scoped.');
  }
  for (const rule of outliers) {
    lines.push(`  ${rule.rule.id} — ${rule.rule.category}`);
    lines.push(
      `    ${rule.latestRate} per file, median peer rate ${rule.medianPeerRate}. ` +
        `Outlier in ${rule.outlierRuns}/${rule.totalRuns} run(s).`,
    );
    lines.push(
      `    Disposal context: ${rule.suppressedCount} suppressed, ${rule.baselinedCount} baselined, burn change ${rule.burnChange}.`,
    );
    lines.push(`    Action: ${rule.action}`);
  }
  return lines;
}

export function formatMetricsReport(report: MetricsReport): string {
  const lines: string[] = [];
  lines.push('Rule quality metrics');
  lines.push('');
  lines.push(
    'Computed from data already on disk — run history, the baseline file, and the suppression list — ' +
      'and read only as far as the evidence allows. No network, no key, no token.',
  );
  lines.push('');
  lines.push(`  ${report.runCount} recorded run(s), ${report.rulesEnabled} enabled rule(s).`);
  lines.push('');
  lines.push(...formatNeverFired(report.neverFired));
  lines.push('');
  lines.push(...formatSuppression(report.suppressionRate));
  lines.push('');
  lines.push(...formatBurnRate(report.burnRate));
  lines.push('');
  lines.push(...formatMisScoped(report.misScoped));
  return lines.join('\n');
}
