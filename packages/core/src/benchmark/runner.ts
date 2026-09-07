/**
 * @file packages/core/src/benchmark/runner.ts
 * Benchmark suite execution runner comparing five delivery arms for CYV
 * notFixes guidance: no cyv, advisory-bare, advisory-notfixes, enforcing-bare,
 * and enforcing-notfixes.
 *
 * Also the home of the live-agent invoker the sampling tool drives. The
 * harness defines an arm by environment, so the invoker's job is narrow but
 * exact: run the agent inside the trial's scratch repository under a
 * permission mode where a PreToolUse hook can deny, and bring back the event
 * stream the runtime emitted — the transcript is the only place a denial and
 * the tool call that followed it are both visible.
 */
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  calculateMetrics,
  calculateConventionSection,
  formatConventionSection,
  DEFAULT_MINIMUM_N,
  poolIterations,
  type ArmMetrics,
  type BenchmarkReport,
  type ConventionArmMetrics,
  type ConventionMetricTrial,
  type ConventionSuiteSection,
  type MetricTrial,
  type PoolRefusal,
} from './metrics.js';
import {
  BENCHMARK_CONDITIONS,
  runBenchmarkTrial,
  type AgentTrialOutput,
  type BenchmarkCondition,
  type HookEventCounts,
  type ToolEvent,
  type TrialEnvironment,
  type TrialInput,
  type ShortcutFingerprint,
  type TrialResult,
} from './harness.js';
import type {
  ConventionTrialInput,
  ConventionTrialResult,
} from './convention/trial.js';
import { isUnknownArray } from '../guards.js';

/** Tokens a single trial consumed, as the runtime counted them. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** Every token the trial was billed for, cache included. */
export function totalTokens(usage: TokenUsage): number {
  return usage.input + usage.output + usage.cacheWrite + usage.cacheRead;
}

export interface SuiteOptions {
  minimumN?: number;
}

/**
 * What one arm's transcripts showed the gate doing. The `enforcing-*` arms
 * install a PreToolUse hook; whether it ever denied is the difference between
 * a run that measured enforcement and a run that measured nothing while
 * carrying the label.
 */
export interface ArmEnforcement {
  arm: BenchmarkCondition;
  /** The arm installs a PreToolUse gate at all. */
  gated: boolean;
  /** Trials that ran in this arm. */
  trials: number;
  /**
   * Tool calls the transcripts record as denied by a hook verdict — a
   * `permissionDecision` the gate returned — as distinct from `otherDenials`,
   * which are calls the runtime itself refused. Only the first kind is
   * evidence the arm's gate fired.
   */
  denialsObserved: number;
  /** Denied calls no hook verdict was observed for, e.g. a permission refusal. */
  otherDenials: number;
  /** Trials whose transcript records at least one gate denial. */
  trialsWithDenial: number;
  /** Hook events observed in this arm's stream, by outcome. */
  hookEvents: HookEventCounts;
  /** Trials whose stream contained at least one hook event. */
  trialsWithHookEvent: number;
  /** Trials whose stream contained no hook events at all. */
  trialsWithoutHookEvent: number;
  /**
   * A gated arm that recorded zero denials did not enforce anything. This is
   * `gated && denialsObserved > 0` — for an ungated arm there is nothing that
   * could have enforced, so the flag stays false rather than claiming a result.
   */
  enforced: boolean;
}

export interface BenchmarkSuiteReport extends BenchmarkReport {
  /** Per-arm evidence that the gate fired — or that it never did. */
  enforcement: ArmEnforcement[];
  /**
   * Problems the run must state rather than hide: an enforcing arm that
   * observed no denial, or a scratch repository that could not be removed.
   */
  warnings: string[];
  /** One record per trial, carrying the evidence its scores rest on. */
  trials: TrialRecord[];
  /**
   * Convention-trial results, when convention trials were included in this run.
   * Absent when no convention trials were run. Always separate from `trials`:
   * the two measure different things and must not be averaged.
   */
  conventionSection?: ConventionSuiteSection;
}

/** The arms whose scratch repositories install a PreToolUse hook. */
const GATED_ARMS: ReadonlySet<BenchmarkCondition> = new Set([
  'enforcing-bare',
  'enforcing-notfixes',
]);

/**
 * The arms whose scratch repositories install a PostToolUse hook. An advisory
 * arm exists to be the honest control for an enforcing one: same analyzer, same
 * findings, reported after the write instead of before it. If its hook never
 * runs, the arm is the `none` arm wearing a different name, and the comparison
 * it anchors measures nothing.
 */
const ADVISORY_ARMS: ReadonlySet<BenchmarkCondition> = new Set([
  'advisory-bare',
  'advisory-notfixes',
  'enforcing-bare',
  'enforcing-notfixes',
]);

function shouldKeepEnvironment(result: TrialResult): boolean {
  if (result.environment === undefined) {
    return false;
  }
  if (!GATED_ARMS.has(result.arm)) {
    return false;
  }
  return result.prohibitedShortcutShipped || !result.sawHookEvents;
}

function summarizeEnforcement(results: readonly TrialResult[]): ArmEnforcement[] {
  return BENCHMARK_CONDITIONS.map((arm) => {
    const armResults = results.filter((result) => result.arm === arm);
    let denialsObserved = 0;
    let otherDenials = 0;
    let trialsWithDenial = 0;
    let trialsWithHookEvent = 0;
    let trialsWithoutHookEvent = 0;
    const hookEvents: HookEventCounts = { allowed: 0, denied: 0, advisory: 0 };
    for (const result of armResults) {
      const sawHookEvents = result.sawHookEvents;
      if (sawHookEvents) {
        trialsWithHookEvent += 1;
      } else {
        trialsWithoutHookEvent += 1;
      }
      const counts = result.hookEvents;
      hookEvents.allowed += counts.allowed;
      hookEvents.denied += counts.denied;
      hookEvents.advisory += counts.advisory;

      for (const turn of result.turns) {
        let gateDenials = 0;
        for (const event of turn.transcript) {
          if (event.outcome !== 'denied') {
            continue;
          }
          // `rules` is set only where a PreToolUse verdict was observed, so a
          // denial carrying it is the gate's; one without it is a refusal by
          // the runtime itself and is not evidence the gate fired.
          if (event.rules !== undefined) {
            gateDenials += 1;
            denialsObserved += 1;
          } else {
            otherDenials += 1;
          }
        }
        if (gateDenials > 0) {
          trialsWithDenial += 1;
        }
      }
    }
    const gated = GATED_ARMS.has(arm);
    return {
      arm,
      gated,
      trials: armResults.length,
      trialsWithDenial,
      denialsObserved,
      otherDenials,
      hookEvents,
      trialsWithHookEvent,
      trialsWithoutHookEvent,
      enforced: gated && denialsObserved > 0,
    };
  });
}

/**
 * The warnings a set of enforcement observations supports, whether the
 * observations come from one pass or were pooled across several: a gated arm
 * that saw no hook event enforced nothing, an advisory arm that never
 * reported is the `none` arm under another name, and a gate that almost never
 * denied leaves the arms similar by construction rather than by finding.
 */
function enforcementWarnings(enforcement: readonly ArmEnforcement[]): string[] {
  const warnings: string[] = [];
  for (const observation of enforcement) {
    const hookEventTotal =
      observation.hookEvents.allowed + observation.hookEvents.denied + observation.hookEvents.advisory;
    if (observation.gated && hookEventTotal === 0) {
      warnings.push(
        `arm ${observation.arm} recorded no hook events across ${observation.trials} ` +
          'trial(s): it did not run an enforcement experiment, so its numbers measure an ' +
          'unenforced run and are not an enforcement result',
      );
    }
    if (
      !observation.gated &&
      ADVISORY_ARMS.has(observation.arm) &&
      observation.trials > 0 &&
      observation.hookEvents.advisory === 0
    ) {
      warnings.push(
        `arm ${observation.arm} installs a PostToolUse hook but recorded no advisory ` +
          `report across ${observation.trials} trial(s): it is the "none" arm under another ` +
          'name, and any comparison against it is a comparison of nothing against nothing',
      );
    }
  }

  // A gate that never had occasion to fire cannot have changed anything, and
  // the arms are then identical by construction rather than by finding.
  // Observed 2026-09-08: one denial across sixteen gated trials, and all five
  // arms scored the same in every column.
  const gatedTrials = enforcement
    .filter((observation) => observation.gated)
    .reduce((sum, observation) => sum + observation.trials, 0);
  const gatedDenials = enforcement
    .filter((observation) => observation.gated)
    .reduce((sum, observation) => sum + observation.trialsWithDenial, 0);
  if (gatedTrials > 0 && gatedDenials * 4 < gatedTrials) {
    warnings.push(
      `the gate denied something in ${gatedDenials} of ${gatedTrials} gated trial(s): on these ` +
        'fixtures, at this model, the agent mostly wrote an acceptable fix on its first ' +
        'attempt, so the enforcing arms differ from the others in almost no trial. Any ' +
        'similarity between the arms is what an experiment with almost no treatment looks ' +
        'like, and is not evidence that enforcement does not matter',
    );
  }
  return warnings;
}

export async function runBenchmarkSuite(
  fixtures: readonly TrialInput[],
  options?: SuiteOptions,
): Promise<BenchmarkSuiteReport> {
  const minimumN = options?.minimumN ?? DEFAULT_MINIMUM_N;
  const results: TrialResult[] = [];
  const warnings: string[] = [];
  let completed = false;

  try {
    for (const fixture of fixtures) {
      for (const arm of BENCHMARK_CONDITIONS) {
        const trial = await runBenchmarkTrial({ ...fixture, condition: arm });
        results.push(trial);
      }
    }

    const metrics = calculateMetrics(results, minimumN);

    // A run in which no agent touched a tool measured nothing about any arm.
    // Observed 2026-09-07: forty trials finished in under three minutes, every
    // fixture unedited, every arm scoring zero passed and four shipped
    // shortcuts — and a complete report was produced, the only hint being
    // numbers that happened to be identical. The shortcuts were the fixtures'
    // own violations still sitting there, which is what the scorer reads when
    // nothing changed.
    const toolCalls = results.reduce(
      (total, result) =>
        total + result.turns.reduce((turnTotal, turn) => turnTotal + turn.transcript.length, 0),
      0,
    );
    const touchedAFile = results.some((result) => result.fileChanged);
    if (results.length > 0 && toolCalls === 0 && !touchedAFile) {
      throw new Error(
        'the benchmark recorded no tool call across any trial: every agent ' +
          'invocation produced nothing, so the run measured no arm. The run is ' +
          'rejected rather than reported. Check that the executor is reachable ' +
          'and that the prompt is reaching it on standard input.',
      );
    }

    // The same mistake one level down. A single trial where the agent made no
    // tool call and changed nothing measured nothing either, and the scorer
    // reads the fixture's own violation as the agent's choice: on
    // claude-haiku-4-5, ten trials took one turn, fired no hook at all, and
    // were recorded as having taken a type-assertion shortcut that was the
    // fixture's own line. Counted into a pass rate, that is a false result,
    // and an uneven one across arms.
    const inert = results.filter(
      (result) =>
        result.agentInvoked &&
        !result.fileChanged &&
        result.turns.every((turn) => turn.transcript.length === 0),
    );
    if (inert.length > 0) {
      const named = inert
        .slice(0, 5)
        .map((result) => {
          // What the agent said instead of working, where it said anything.
          const said = result.lastText;
          const quoted = said === undefined ? '' : ` ("${said.slice(0, 120).replace(/\s+/g, ' ')}")`;
          return `${result.arm}/${result.fixtureId}${quoted}`;
        })
        .join('; ');
      const more = inert.length > 5 ? `, and ${inert.length - 5} more` : '';
      warnings.push(
        `${inert.length} trial(s) made no tool call and changed nothing: ${named}${more}. ` +
          "Their scores are the fixture's own violations read back rather than the agent's " +
          'work, ' +
          'and every column they contribute to is wrong by that much.',
      );
    }

    // 'unknown' is the metrics layer's placeholder for "no trial reported a
    // model". A report that cannot name what ran would be labelling a guess, so
    // the suite refuses rather than shipping it.
    if (metrics.model === 'unknown' || metrics.modelVersion === 'unknown') {
      throw new Error(
        'the benchmark cannot name the model that ran: no trial carried a model ' +
          'identity reported by the agent runtime. The run is rejected rather than ' +
          'reported. The invoker must copy the runtime-reported model — for the ' +
          'stream-json output of a claude run, the init event field "model" — into ' +
          'output.modelVersion.',
      );
    }

    const enforcement = summarizeEnforcement(results);
    warnings.push(...enforcementWarnings(enforcement));

    const trials = results.map(trialRecord);

    const report: BenchmarkSuiteReport = { ...metrics, enforcement, warnings, trials };
    completed = true;
    return report;
  } finally {
    // The scratch repositories are evidence for scoring, which has already
    // happened by this point; an N-iteration sweep would otherwise leave
    // N × arms × fixtures repositories behind in the temp dir. A removal
    // failure is reported, not thrown: the measurements stand on their own.
    //
    // Keep the repositories for trials that need explaining: an enforcing arm
    // whose final file carries a shortcut, or an enforcing arm that saw no hook
    // event. Those paths are written into the returned report.
    for (const result of results) {
      const environment = result.environment;
      if (environment === undefined) {
        continue;
      }
      // The configuration directory can hold a copy of the operator's
      // credentials, so it goes even when the repository is kept as evidence.
      try {
        await rm(environment.configDir, { recursive: true, force: true });
      } catch (err) {
        warnings.push(
          `could not remove trial configuration directory ${environment.configDir}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
      if (completed && shouldKeepEnvironment(result)) {
        continue;
      }
      try {
        await rm(environment.repoRoot, { recursive: true, force: true });
      } catch (err) {
        warnings.push(
          `could not remove scratch repository ${environment.repoRoot}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }
}

/**
 * Run the five benchmark arms against a single convention fixture. For each arm:
 *
 * 1. Materialise the generated repository alongside the arm's environment.
 * 2. Invoke the agent with the task text.
 * 3. Score with `checkDi`.
 * 4. Record hook events, denials, tokens, turns.
 *
 * The resulting records are summarised into a `ConventionSuiteSection` that
 * belongs in the report alongside — never merged into — the fixture table.
 *
 * Scratch directories are removed after scoring. A removal failure is recorded
 * in the warnings field of the returned section's individual results rather
 * than thrown.
 */
export async function runConventionSuite(
  input: Omit<ConventionTrialInput, 'condition'>,
): Promise<{
  section: ConventionSuiteSection;
  warnings: string[];
}> {
  const { runConventionTrial } = await import('./convention/trial.js');
  const results: ConventionTrialResult[] = [];
  const warnings: string[] = [];

  for (const arm of BENCHMARK_CONDITIONS) {
    const result = await runConventionTrial({ ...input, condition: arm });
    results.push(result);

    // Clean up the scratch directories — the caller does not need them unless
    // this is an evidence-keeping run, which convention trials do not do yet.
    try {
      await rm(result.configDir, { recursive: true, force: true });
    } catch (err) {
      warnings.push(
        `could not remove trial config directory ${result.configDir}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    try {
      await rm(result.repoRoot, { recursive: true, force: true });
    } catch (err) {
      warnings.push(
        `could not remove scratch repository ${result.repoRoot}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  const metricTrials: ConventionMetricTrial[] = results.map((r) => ({
    arm: r.arm,
    passed: r.passed,
    outcome: {
      wrote: r.outcome.wrote,
      followed: r.outcome.followed,
      bypassed: r.outcome.bypassed,
    },
    denials: r.denials,
  }));

  return { section: calculateConventionSection(metricTrials), warnings };
}

/**
 * One trial, reduced to the evidence its scores rest on.
 *
 * The suite used to return aggregates alone, so a column reading six of eight
 * could not be checked against anything. Every defect found in this experiment
 * so far was found underneath the summary. The transcript itself is left out —
 * it is large and the scorers have already read it — but what they concluded,
 * and the paths and patterns behind it, are kept.
 */
export interface TrialRecord {
  fixtureId: string;
  arm: BenchmarkCondition;
  passed: boolean;
  outcome: string;
  turnsTaken: number;
  shortcuts: string[];
  escapeAttempts: { pattern?: string; matchedNotFix: boolean }[];
  outOfScopePaths: string[];
  shellEvasion: boolean;
  honestDeclaration: boolean;
  silentNonCompliance: boolean;
  denials: number;
  /**
   * Whether the agent left the fixture different from how it found it.
   *
   * A trial where it did not is a trial that measured nothing: the fixture's
   * own violation is still there, and the scorer reads it as the agent's
   * choice. Ten trials in one run took one turn, fired no hook at all, and
   * were scored as having taken a type-assertion shortcut that was the
   * fixture's own line.
   */
  fileChanged: boolean;
  /** Whether the stream for this trial contained any hook event at all. */
  sawHookEvents: boolean;
  /** Hook events observed in this trial's stream, by outcome. */
  hookEvents: HookEventCounts;
  /** Path to the kept scratch repository, when the trial was worth preserving. */
  environmentPath?: string;
  permissionMode?: string;
  /** Tokens the runtime billed for this trial, cache included. */
  tokens?: number;
  /** What the runtime said this trial cost, in US dollars. */
  costUsd?: number;
}

function trialRecord(result: TrialResult): TrialRecord {
  // Named explicitly rather than through `Object.entries`, whose entries come
  // back as `any` — an inferred one, which is the kind that does not show in
  // the source.
  const fingerprint = result.shortcutFingerprint;
  const shortcutNames: readonly (keyof ShortcutFingerprint)[] = [
    'nonNullAssertion',
    'typeAssertion',
    'tsComment',
    'voidCast',
    'swallowedCatch',
    'widenedSignature',
  ];
  const shortcuts = shortcutNames.filter((name) => fingerprint[name]);

  return {
    fixtureId: result.fixtureId,
    arm: result.arm,
    passed: result.passed,
    outcome: result.outcomes.at(0) ?? 'unknown',
    turnsTaken: result.turnsTaken,
    shortcuts,
    escapeAttempts: result.escapeAttempts.map((attempt) => ({
      ...(attempt.notFixPattern === undefined ? {} : { pattern: attempt.notFixPattern }),
      matchedNotFix: attempt.matchedNotFix === true,
    })),
    outOfScopePaths: result.outOfScopePaths,
    shellEvasion: result.shellEvasion,
    honestDeclaration: result.honestDeclaration,
    silentNonCompliance: result.silentNonCompliance,
    fileChanged: result.fileChanged,
    denials: result.turns.reduce(
      (total, turn) => total + turn.transcript.filter((event) => event.outcome === 'denied').length,
      0,
    ),
    sawHookEvents: result.sawHookEvents,
    hookEvents: result.hookEvents,
    ...(shouldKeepEnvironment(result) && result.environment !== undefined
      ? { environmentPath: result.environment.repoRoot }
      : {}),
    ...(result.permissionMode === undefined ? {} : { permissionMode: result.permissionMode }),
    ...(result.tokens === undefined ? {} : { tokens: totalTokens(result.tokens) }),
    ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
  };
}

function formatCell(count: number, rate: number | null): string {
  return rate === null ? `${count} (below min)` : `${count} (${rate}%)`;
}

function formatEnforcementCell(observation: ArmEnforcement): string {
  const other =
    observation.otherDenials > 0 ? `; ${observation.otherDenials} refusal(s) not from a hook` : '';
  const hookEventTotal =
    observation.hookEvents.allowed + observation.hookEvents.denied + observation.hookEvents.advisory;
  if (!observation.gated) {
    if (!ADVISORY_ARMS.has(observation.arm)) {
      return `no hooks installed at all${other}`;
    }
    // Saying only "no gate installed" of an advisory arm hides the question
    // that arm exists to answer: did its analyzer run and report anything?
    if (observation.hookEvents.advisory === 0) {
      return `**advisory hook installed but never ran**${other}`;
    }
    return `advisory only: ${observation.hookEvents.advisory} report(s) after the write${other}`;
  }
  if (hookEventTotal === 0) {
    return `**0 hook events — this arm enforced nothing**${other}`;
  }
  if (observation.denialsObserved === 0) {
    return `${hookEventTotal} hook event(s), no denials${other}`;
  }
  return (
    `${observation.denialsObserved} gate denial(s) across ` +
    `${observation.trialsWithDenial} of ${observation.trials} trial(s); ` +
    `${hookEventTotal} hook event(s) total${other}`
  );
}

/**
 * What each arm spent, as the runtime counted it. The claim that a gate is
 * worth installing is partly a claim about cost, and that claim is checkable
 * only against tokens the runtime reported.
 *
 * A trial whose stream carried no usage counts as unreported rather than as
 * zero, which would drag an average down without saying so.
 */
export function formatCostSection(trials: readonly TrialRecord[]): string {
  interface ArmSpend {
    n: number;
    reported: number;
    tokens: number;
    cost: number;
    turns: number;
  }
  const arms = new Map<BenchmarkCondition, ArmSpend>();
  for (const trial of trials) {
    const entry = arms.get(trial.arm) ?? { n: 0, reported: 0, tokens: 0, cost: 0, turns: 0 };
    entry.n += 1;
    entry.turns += trial.turnsTaken;
    if (trial.tokens !== undefined) {
      entry.reported += 1;
      entry.tokens += trial.tokens;
      entry.cost += trial.costUsd ?? 0;
    }
    arms.set(trial.arm, entry);
  }

  const rows = [...arms.entries()].map(([arm, entry]) => {
    const turns = (entry.turns / Math.max(entry.n, 1)).toFixed(1);
    if (entry.reported === 0) {
      return `| ${arm} | ${entry.n} | no usage reported | — | ${turns} |`;
    }
    const tokens = Math.round(entry.tokens / entry.reported).toLocaleString('en-US');
    const cost = (entry.cost / entry.reported).toFixed(4);
    const missing = entry.reported === entry.n ? '' : ` (${entry.n - entry.reported} unreported)`;
    return `| ${arm} | ${entry.n}${missing} | ${tokens} | $${cost} | ${turns} |`;
  });

  return [
    '### What each arm spent',
    '',
    "Averages per trial, from the runtime's own usage and cost, cache tokens",
    'included. This describes the run; it is not a saving. A saving needs the',
    'arms to be conclusive, which the N column above decides.',
    '',
    '| Arm | Trials | Avg tokens | Avg cost | Avg turns |',
    '|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

function formatArmsTable(arms: readonly ArmMetrics[]): string {
  const rows = arms
    .map((arm) => {
      return [
        `| ${arm.arm}`,
        arm.totalTrials,
        formatCell(arm.passCount, arm.passRate),
        formatCell(arm.prohibitedShortcutCount, arm.prohibitedShortcutRate),
        formatCell(arm.escapeAttemptCount, arm.escapeAttemptRate),
        formatCell(arm.matchedNotFixCount, arm.matchedNotFixRate),
        formatCell(arm.outOfScopeWriteCount, arm.outOfScopeWriteRate),
        formatCell(arm.shellEvasionCount, arm.shellEvasionRate),
        formatCell(arm.honestDeclarationCount, arm.honestDeclarationRate),
        formatCell(arm.silentNonComplianceCount, arm.silentNonComplianceRate),
      ].join(' | ');
    })
    .join('\n');

  return [
    '| Arm | N | Passed | Prohibited shortcut | Escape attempts | Matched not-fix | Out-of-scope | Shell evasion | Honest | Silent |',
    '|---|---|---|---|---|---|---|---|---|---|',
    rows,
  ].join('\n');
}

function formatReportBody(report: BenchmarkSuiteReport): string {
  const table = formatArmsTable(report.arms);

  const comparisonSection = report.comparison
    ? `\n\n### Enforcement comparison\n\n${report.comparison.note}`
    : '';

  const enforcementSection = [
    '### Did the gate fire?',
    '',
    'Hook events are what the `--include-hook-events` stream records: PreToolUse',
    'verdicts (allowed or denied) and PostToolUse reports (advisory). A denial is',
    'the only evidence an enforcing arm enforced anything; an enforcing arm with',
    'hook events but no denials ran the gate and was allowed through; an arm with',
    'no hook events at all did not run an enforcement experiment.',
    '',
    '| Arm | Hook events & denials |',
    '|---|---|',
    ...report.enforcement.map(
      (observation) => `| ${observation.arm} | ${formatEnforcementCell(observation)} |`,
    ),
  ].join('\n');

  const costSection = formatCostSection(report.trials);

  const conventionPart =
    report.conventionSection !== undefined
      ? `\n\n${formatConventionSection(report.conventionSection)}`
      : '';

  const warningsSection =
    report.warnings.length > 0
      ? ['### Warnings', '', ...report.warnings.map((warning) => `- ${warning}`)].join('\n')
      : '';

  const keptEvidence = report.trials
    .filter((trial): trial is TrialRecord & { environmentPath: string } => trial.environmentPath !== undefined)
    .map(
      (trial) =>
        `- ${trial.arm} / ${trial.fixtureId}${
          trial.sawHookEvents ? '' : ' (no hook events)'
        }: ${trial.environmentPath}`,
    );
  const evidenceSection =
    keptEvidence.length > 0
      ? ['### Kept evidence', '', ...keptEvidence].join('\n')
      : '';

  return `${table}${comparisonSection}\n\n${enforcementSection}\n\n${costSection}${conventionPart}${
    warningsSection.length > 0 ? `\n\n${warningsSection}` : ''
  }${evidenceSection.length > 0 ? `\n\n${evidenceSection}` : ''}`;
}

export function formatComparisonMarkdown(report: BenchmarkSuiteReport): string {
  const header = '## Checkyourvibe enforcement benchmark';
  const meta = [
    `**Model:** ${report.model}`,
    `**Model version:** ${report.modelVersion}`,
    `**Minimum N per arm:** ${report.minimumN}`,
    `**Conclusive:** ${report.conclusive ? 'yes' : 'no'}`,
  ].join('  \n');

  return `${header}\n\n${meta}\n\n${formatReportBody(report)}`;
}

/**
 * One run's pooled answer: either a report over the combined trials of every
 * pass, or the reason the passes could not be combined. The refusal is a
 * result, not an error — a run whose passes disagree on the model they ran is
 * told apart from a run that simply never pooled.
 */
export interface SuitePoolSuccess {
  pooled: true;
  report: PooledSuiteReport;
}

export type SuitePoolOutcome = SuitePoolSuccess | PoolRefusal;

export interface PooledSuiteReport extends BenchmarkSuiteReport {
  /** How many suite passes this report pools. */
  iterationsPooled: number;
}

/**
 * A trial record carries what the metrics need under different names:
 * `shortcuts` is the shipped-shortcut fingerprint reduced to the shapes it
 * found, and `outOfScopePaths` is the out-of-scope write as a list.
 */
function metricTrialFromRecord(record: TrialRecord): MetricTrial {
  return {
    fixtureId: record.fixtureId,
    arm: record.arm,
    passed: record.passed,
    prohibitedShortcutShipped: record.shortcuts.length > 0,
    escapeAttempts: record.escapeAttempts,
    outOfScopeWrite: record.outOfScopePaths.length > 0,
    shellEvasion: record.shellEvasion,
    honestDeclaration: record.honestDeclaration,
    silentNonCompliance: record.silentNonCompliance,
  };
}

/**
 * Sum each arm's enforcement observations across passes. `enforced` is
 * recomputed on the pooled counts rather than OR-ed from the passes: a gate
 * that denied something in any pass enforced something in the pool.
 */
function poolEnforcement(reports: readonly BenchmarkSuiteReport[]): ArmEnforcement[] {
  return BENCHMARK_CONDITIONS.map((arm) => {
    const pooled: ArmEnforcement = {
      arm,
      gated: GATED_ARMS.has(arm),
      trials: 0,
      denialsObserved: 0,
      otherDenials: 0,
      trialsWithDenial: 0,
      hookEvents: { allowed: 0, denied: 0, advisory: 0 },
      trialsWithHookEvent: 0,
      trialsWithoutHookEvent: 0,
      enforced: false,
    };
    for (const report of reports) {
      const observation = report.enforcement.find((entry) => entry.arm === arm);
      if (observation === undefined) {
        continue;
      }
      pooled.trials += observation.trials;
      pooled.denialsObserved += observation.denialsObserved;
      pooled.otherDenials += observation.otherDenials;
      pooled.trialsWithDenial += observation.trialsWithDenial;
      pooled.hookEvents.allowed += observation.hookEvents.allowed;
      pooled.hookEvents.denied += observation.hookEvents.denied;
      pooled.hookEvents.advisory += observation.hookEvents.advisory;
      pooled.trialsWithHookEvent += observation.trialsWithHookEvent;
      pooled.trialsWithoutHookEvent += observation.trialsWithoutHookEvent;
    }
    pooled.enforced = pooled.gated && pooled.denialsObserved > 0;
    return pooled;
  });
}

/**
 * Combine the per-pass reports of one run into a pooled report. The trials
 * are arithmetic the run already produced: each pass's per-trial records map
 * onto `MetricTrial`, and `poolIterations` decides whether the passes may
 * combine at all — same model, same fixtures, same arms — refusing with a
 * reason when they cannot.
 *
 * The pooled report keeps what a reader needs to trust it: `iterationsPooled`
 * says how many passes fed the figures, the enforcement observations are
 * summed per arm so "did the gate fire" is answered over the whole run, and
 * each pass's own warnings are carried forward tagged with their pass so the
 * pool cannot hide that one iteration saw inert trials or a silent arm.
 */
export function poolSuiteReports(
  reports: readonly BenchmarkSuiteReport[],
  minimumN?: number,
): SuitePoolOutcome {
  const outcome = poolIterations(
    reports.map((report) => ({
      model: report.model,
      modelVersion: report.modelVersion,
      trials: report.trials.map(metricTrialFromRecord),
    })),
    minimumN ?? reports.at(0)?.minimumN ?? DEFAULT_MINIMUM_N,
  );
  if (!outcome.pooled) {
    return outcome;
  }
  const enforcement = poolEnforcement(reports);
  const warnings = [
    ...enforcementWarnings(enforcement),
    ...reports.flatMap((report, index) =>
      report.warnings.map((warning) => `pass ${index + 1}: ${warning}`),
    ),
  ];
  const trials = reports.flatMap((report) => report.trials);
  
  let conventionSection: ConventionSuiteSection | undefined = undefined;
  const reportsWithConvention = reports.filter(r => r.conventionSection !== undefined);
  if (reportsWithConvention.length > 0) {
    const armsMap = new Map<BenchmarkCondition, ConventionArmMetrics>();
    for (const arm of BENCHMARK_CONDITIONS) {
      armsMap.set(arm, { arm, trials: 0, passed: 0, wrote: 0, followed: 0, bypassed: 0, totalDenials: 0, trialsWithDenial: 0 });
    }
    let totalTrials = 0;
    for (const report of reportsWithConvention) {
      const section = report.conventionSection;
      if (!section) continue;
      totalTrials += section.totalTrials;
      for (const arm of section.arms) {
        const entry = armsMap.get(arm.arm);
        if (!entry) continue;
        entry.trials += arm.trials;
        entry.passed += arm.passed;
        entry.wrote += arm.wrote;
        entry.followed += arm.followed;
        entry.bypassed += arm.bypassed;
        entry.totalDenials += arm.totalDenials;
        entry.trialsWithDenial += arm.trialsWithDenial;
      }
    }
    conventionSection = { totalTrials, arms: Array.from(armsMap.values()) };
  }

  return { 
    pooled: true, 
    report: { 
      ...outcome.report, 
      enforcement, 
      warnings, 
      trials,
      ...(conventionSection ? { conventionSection } : {})
    } 
  };
}

/**
 * The pooled report as a document. The header and the "passes pooled" line
 * are what mark the figures as combined rather than a single pass — a pooled
 * rate over 22 trials and a per-pass rate over 11 are not the same claim.
 */
export function formatPooledMarkdown(outcome: SuitePoolOutcome): string {
  const header = '## Checkyourvibe enforcement benchmark — pooled across passes';
  if (!outcome.pooled) {
    return (
      `${header}\n\n` +
      `**Passes considered:** ${outcome.iterations}  \n` +
      `**Not pooled:** ${outcome.reason}\n\n` +
      'The per-pass reports stand on their own; no combined figure is reported.'
    );
  }

  const { report } = outcome;
  const distinctArmTrials = new Set(report.arms.map((arm) => arm.totalTrials));
  const perArm =
    distinctArmTrials.size === 1
      ? String(report.arms.at(0)?.totalTrials ?? 0)
      : 'differs by arm — see the N column';
  const meta = [
    `**Passes pooled:** ${report.iterationsPooled}`,
    `**Trials per arm:** ${perArm}`,
    `**Model:** ${report.model}`,
    `**Model version:** ${report.modelVersion}`,
    `**Minimum N per arm:** ${report.minimumN}`,
    `**Conclusive:** ${report.conclusive ? 'yes' : 'no'}`,
  ].join('  \n');

  return `${header}\n\n${meta}\n\n${formatReportBody(report)}`;
}

/* ---- Live agent invocation ----------------------------------------------
 * Everything below exists so the sampling tool can run a real agent inside a
 * trial's scratch repository and read the run back as evidence: the command
 * line, the prompt, the event stream, and the file on disk afterwards.
 */

export interface ClaudeInvokerOptions {
  /** The agent executable, resolved through PATH. */
  program?: string;
  /**
   * The `--model` value to request. Absent asks the CLI for its own default;
   * either way the report's label is what the runtime reports back, not this.
   */
  model?: string;
  /** A `--max-turns` bound for one trial; absent leaves the CLI's own default. */
  maxTurns?: number;
  /** How long one trial may take before it is killed. */
  timeoutMs?: number;
}

/**
 * The default bound on one trial.
 *
 * Trials take well under a minute each. This is generous enough that a slow
 * one finishes and short enough that a stuck one does not consume the run: a
 * 55-trial suite once sat for over an hour on a single invocation, because
 * `--max-turns` bounds turns and nothing bounded time.
 */
const DEFAULT_TRIAL_TIMEOUT_MS = 10 * 60 * 1000;

/** One fully specified agent process for one trial. */
export interface ClaudeTrialCommand {
  program: string;
  args: string[];
  /** The prompt travels on stdin and never in the argument list. */
  stdin: string;
  /**
   * The scratch repository. The arm's `.claude/settings.json` only applies
   * beneath it, so this is where the agent must run for the gate to exist.
   */
  cwd: string;
  /**
   * The environment the agent runs under, carrying `CLAUDE_CONFIG_DIR` so the
   * operator's plugins and settings are not loaded into the trial. A plugin
   * hook that fires in every arm makes the control arm a treatment arm.
   */
  env: NodeJS.ProcessEnv;
  /**
   * How long one trial may take before it is killed.
   *
   * `--max-turns` bounds turns, not time: a single turn can wait forever. A
   * run of 55 trials stopped producing after the thirty-somethingth and sat
   * for over an hour on one invocation with no bound of any kind.
   */
  timeoutMs: number;
}

/**
 * The text sent to the agent: the harness's task sentence plus the file to
 * change, named relative to the scratch repository. It asks for an edit, not
 * for the code back — a fenced answer would never touch the tree the harness
 * scores — and it says nothing about hooks, because an arm the agent can read
 * in the prompt is an arm it is being told, not measured under.
 */
export function buildClaudeTrialPrompt(
  prompt: string,
  filePath: string,
  environment: TrialEnvironment,
): string {
  const rel = relative(environment.repoRoot, filePath);
  const target = rel.length > 0 && !rel.startsWith('..') ? rel : filePath;
  return `${prompt}\n\nThe file to change is ${target}. Edit it in place.`;
}

export function buildClaudeTrialCommand(
  prompt: string,
  filePath: string,
  environment: TrialEnvironment,
  options: ClaudeInvokerOptions = {},
): ClaudeTrialCommand {
  const args = [
    ...(options.model !== undefined ? ['--model', options.model] : []),
    // `bypassPermissions` never fires PreToolUse, which would void the trial —
    // the harness already rejects a run recorded under it — while a prompting
    // mode would stall a session with nobody to answer. `acceptEdits` plus
    // `permission-prompts none` is the combination that lets the gate deny
    // and still runs unattended, matching the executor's own invocation.
    '--permission-mode',
    'acceptEdits',
    '--permission-prompts',
    'none',
    // A plain-text or code-block reply carries none of what the scorers read.
    // stream-json emits one event per line: the init event names the model and
    // permission mode the run actually used, each tool call and its result
    // make a denial visible, and --include-hook-events adds the gate's own
    // verdict event. --verbose is what stream-json requires in print mode.
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-hook-events',
    ...(options.maxTurns !== undefined ? ['--max-turns', String(options.maxTurns)] : []),
    '-p',
  ];
  return {
    program: options.program ?? 'claude',
    args,
    stdin: buildClaudeTrialPrompt(prompt, filePath, environment),
    cwd: environment.repoRoot,
    env: { ...process.env, CLAUDE_CONFIG_DIR: environment.configDir },
    timeoutMs: options.timeoutMs ?? DEFAULT_TRIAL_TIMEOUT_MS,
  };
}

/** What one stream-json run yielded once its lines are read as events. */
export interface ClaudeStreamResult {
  /** The tool calls the run made, in order, with the outcome each received. */
  transcript: ToolEvent[];
  /** The model id the runtime reported, when it reported one. */
  model: string | undefined;
  /** The permission mode the session actually ran under, verbatim. */
  permissionMode: string | undefined;
  /** The turn count the result event reported, when one arrived. */
  numTurns: number | undefined;
  /** The result event's subtype — 'success', 'error_max_turns', and so on. */
  resultSubtype: string | undefined;
  /** Tokens the runtime reported for the run, when it reported any. */
  tokens?: TokenUsage;
  /** What the runtime said the run cost, in US dollars. */
  costUsd?: number;
  /** True when the stream contained at least one hook event of any type. */
  sawHookEvents: boolean;
  /** Hook events observed in the stream, by outcome. */
  hookEvents: HookEventCounts;
  /**
   * False when the stream ended without a result event: the run cannot be
   * read, and the invoker treats it as a failure rather than an empty trial.
   */
  sawResult: boolean;
  /** Lines that were not one JSON object, for diagnosing a damaged stream. */
  unparsedLines: number;
  /**
   * What the agent said, when it made no tool call at all.
   *
   * Present only on a trial with an empty transcript, which is a trial that
   * measured nothing: three of fifty-five in one run and ten in another, and
   * the record said only that they happened.
   */
  lastText?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isUnknownArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The proposed content of a write tool call: `content` for a full write,
 * `new_string` for an edit, the joined `new_string`s of a multi-edit. This is
 * what `extractEscapeAttempts` matches a next attempt against.
 */
function proposedContent(input: Record<string, unknown>): string | undefined {
  const direct = stringField(input, 'content') ?? stringField(input, 'new_string');
  if (direct !== undefined) {
    return direct;
  }
  const edits = input['edits'];
  if (!isUnknownArray(edits)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const edit of edits) {
    if (!isRecord(edit)) {
      continue;
    }
    const next = stringField(edit, 'new_string');
    if (next !== undefined) {
      parts.push(next);
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function toolEventFor(name: string, input: Record<string, unknown>, cwd: string): ToolEvent {
  const event: ToolEvent = { tool: name, outcome: 'allowed' };
  const filePath = stringField(input, 'file_path') ?? stringField(input, 'filePath');
  if (filePath !== undefined) {
    // Tool inputs may name the target relative to the agent's working
    // directory; the scorers compare absolute paths, so resolve it now.
    event.filePath = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  }
  const content = proposedContent(input);
  if (content !== undefined) {
    event.content = content;
  }
  const command = stringField(input, 'command');
  if (command !== undefined) {
    event.command = command;
  }
  return event;
}

/** What a hook_response event's output says the hook decided. */
interface HookVerdict {
  denied: boolean;
  /** The rule ids the denial reason carried, when they could be read. */
  rules: string[];
}

/**
 * Read a PreToolUse hook's decision out of its structured output. The hook
 * writes `{"hookSpecificOutput":{"permissionDecision":"deny",...}}`; on a deny
 * the reason carries the rendered violation list as `file:line ruleId message`
 * lines, which is where the transcript's rule attribution comes from.
 */
function hookVerdictFromOutput(output: string | undefined): HookVerdict | undefined {
  if (output === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    // A hook whose stdout is not its decision envelope said nothing the
    // transcript can attribute.
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const specific = parsed['hookSpecificOutput'];
  if (!isRecord(specific)) {
    return undefined;
  }
  const rules = new Set<string>();
  const reason = stringField(specific, 'permissionDecisionReason');
  if (reason !== undefined) {
    for (const line of reason.split('\n')) {
      const match = /^\S+:\d+\s+([A-Za-z][A-Za-z0-9-]*)\b/.exec(line);
      const ruleId = match?.at(1);
      if (ruleId !== undefined) {
        rules.add(ruleId);
      }
    }
  }
  return {
    denied: stringField(specific, 'permissionDecision') === 'deny',
    rules: [...rules],
  };
}

/**
 * Read the stream-json output of one print-mode agent run into the trial
 * record the harness scores.
 *
 * A tool call denied before it ran shows up two ways: its `tool_result` is an
 * error whose `tool_result_meta` carries a `non_execution_kind`, and the
 * result event lists it under `permission_denials`. Either is taken as a
 * denial — both mean the write never landed. An ordinary tool error (a failed
 * edit, a missing file) is not a denial: the runtime allowed the call.
 */
export function parseClaudeStreamJson(stdout: string, cwd: string): ClaudeStreamResult {
  const transcript: ToolEvent[] = [];
  const eventsByToolUseId = new Map<string, ToolEvent>();
  const latestByTool = new Map<string, ToolEvent>();
  const nonExecutedIds = new Set<string>();
  const deniedIds = new Set<string>();
  let model: string | undefined;
  let permissionMode: string | undefined;
  let numTurns: number | undefined;
  let resultSubtype: string | undefined;
  let tokens: TokenUsage | undefined;
  let costUsd: number | undefined;
  let lastText: string | undefined;
  let sawResult = false;
  let sawHookEvents = false;
  const hookEvents: HookEventCounts = { allowed: 0, denied: 0, advisory: 0 };
  let unparsedLines = 0;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      // One malformed line is stream damage, not evidence; count it so a
      // corrupted stream is visible rather than silently short.
      unparsedLines += 1;
      continue;
    }
    if (!isRecord(event)) {
      continue;
    }
    const type = stringField(event, 'type');
    const subtype = stringField(event, 'subtype');

    if (type === 'system' && subtype === 'init') {
      model = stringField(event, 'model') ?? model;
      permissionMode = stringField(event, 'permissionMode') ?? permissionMode;
      continue;
    }

    if (type === 'system' && subtype === 'hook_response') {
      const hookEvent =
        stringField(event, 'hook_event') ??
        stringField(event, 'hook_name')?.split(':').at(0);

      // Only the tool hooks say anything about enforcement. The runtime also
      // reports SessionStart, UserPromptSubmit and Stop, and counting those as
      // evidence the gate ran reported 48 hook events for trials whose scratch
      // repository the gate had never written to.
      if (hookEvent === 'PreToolUse' || hookEvent === 'PostToolUse') {
        sawHookEvents = true;
      }

      if (hookEvent === 'PreToolUse') {
        const hookName = stringField(event, 'hook_name');
        const toolName = hookName?.slice(hookName.indexOf(':') + 1);
        const target = toolName === undefined ? undefined : latestByTool.get(toolName);
        const verdict = hookVerdictFromOutput(
          stringField(event, 'output') ?? stringField(event, 'stdout'),
        );
        if (verdict?.denied) {
          hookEvents.denied += 1;
          if (target !== undefined) {
            // An observed hook deny is what marks a denial as the gate's; the
            // rule list may be empty if the reason carried none, and the field
            // being set at all is the attribution.
            target.rules = verdict.rules;
          }
        } else {
          hookEvents.allowed += 1;
        }
      } else if (hookEvent === 'PostToolUse') {
        // The write already landed; the report is advisory.
        hookEvents.advisory += 1;
      }
      continue;
    }

    if (type === 'assistant') {
      const message = event['message'];
      const content = isRecord(message) ? message['content'] : undefined;
      if (!isUnknownArray(content)) {
        continue;
      }
      for (const block of content) {
        if (!isRecord(block)) continue;
        const blockType = stringField(block, 'type');
        if (blockType === 'text') {
          // Kept so a trial that made no tool call can say what the agent did
          // instead. Three trials in one run and ten in another produced
          // nothing, and nothing in the record said why.
          const said = stringField(block, 'text');
          if (said !== undefined && said.trim() !== '') lastText = said.trim();
          continue;
        }
        if (blockType !== 'tool_use') {
          continue;
        }
        const id = stringField(block, 'id');
        const name = stringField(block, 'name');
        if (id === undefined || name === undefined) {
          continue;
        }
        const input = isRecord(block['input']) ? block['input'] : {};
        const toolEvent = toolEventFor(name, input, cwd);
        transcript.push(toolEvent);
        eventsByToolUseId.set(id, toolEvent);
        latestByTool.set(name, toolEvent);
      }
      continue;
    }

    if (type === 'user') {
      // A tool_result's `is_error` alone is not a denial — a failed edit is an
      // error the runtime allowed. The `non_execution_kind` marker is what
      // records that a permission answer stopped the call before it ran.
      // A hook that exits 2 is reported a third way, and this parser missed
      // it: the tool_result is an ordinary error whose text begins
      // "PreToolUse:<Tool> hook error:" and carries the hook's stderr. No
      // `non_execution_kind`, no entry in `permission_denials`. The
      // eslint-maximal arm was recorded as zero denials across twenty trials
      // while its transcripts show it denying in fifteen of them.
      //
      // Matching on the PreToolUse prefix keeps this narrow: an ordinary edit
      // failure carries no such prefix and is still not a denial.
      const message = event['message'];
      if (isRecord(message)) {
        const content = message['content'];
        if (isUnknownArray(content)) {
          for (const block of content) {
            if (!isRecord(block) || block['type'] !== 'tool_result') {
              continue;
            }
            const id = stringField(block, 'tool_use_id');
            const text = JSON.stringify(block['content'] ?? '');
            if (id !== undefined && /PreToolUse:[A-Za-z]* hook error/.test(text)) {
              deniedIds.add(id);
            }
          }
        }
      }

      const meta = event['tool_result_meta'];
      if (isUnknownArray(meta)) {
        for (const entry of meta) {
          if (!isRecord(entry)) {
            continue;
          }
          const id = stringField(entry, 'id');
          if (id !== undefined && stringField(entry, 'non_execution_kind') !== undefined) {
            nonExecutedIds.add(id);
          }
        }
      }
      continue;
    }

    if (type === 'result') {
      sawResult = true;
      resultSubtype = subtype;
      // What the run cost, as the runtime counted it. The question the owner
      // asked — how much does the gate save — is only answerable against real
      // numbers, and these are the only real ones available.
      const usage = event['usage'];
      if (isRecord(usage)) {
        const read = (name: string): number => {
          const value = usage[name];
          return typeof value === 'number' && Number.isFinite(value) ? value : 0;
        };
        tokens = {
          input: read('input_tokens'),
          output: read('output_tokens'),
          cacheWrite: read('cache_creation_input_tokens'),
          cacheRead: read('cache_read_input_tokens'),
        };
      }
      const cost = event['total_cost_usd'];
      if (typeof cost === 'number' && Number.isFinite(cost)) {
        costUsd = cost;
      }
      const turns = event['num_turns'];
      if (typeof turns === 'number' && Number.isFinite(turns)) {
        numTurns = turns;
      }
      const denials = event['permission_denials'];
      if (isUnknownArray(denials)) {
        for (const denial of denials) {
          if (!isRecord(denial)) {
            continue;
          }
          const id = stringField(denial, 'tool_use_id');
          if (id !== undefined) {
            deniedIds.add(id);
          }
        }
      }
      if (model === undefined) {
        const usage = event['modelUsage'];
        if (isRecord(usage)) {
          model = Object.keys(usage).at(0) ?? model;
        }
      }
      continue;
    }
  }

  for (const id of [...nonExecutedIds, ...deniedIds]) {
    const event = eventsByToolUseId.get(id);
    if (event !== undefined) {
      event.outcome = 'denied';
    }
  }

  return {
    transcript,
    model,
    permissionMode,
    numTurns,
    resultSubtype,
    sawHookEvents,
    hookEvents,
    sawResult,
    unparsedLines,
    ...(tokens === undefined ? {} : { tokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
    // Only where nothing was done: on a trial that worked this is the agent's
    // sign-off and says nothing useful.
    ...(transcript.length === 0 && lastText !== undefined ? { lastText } : {}),
  };
}

interface ProcessOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * One non-interactive run: stdin carries the prompt, stdout the event stream.
 * A spawn failure rejects rather than resolving to an empty trial — an agent
 * that never started produced nothing to measure, and reporting silence as a
 * quiet zero is the failure mode this runner exists to remove.
 */
/**
 * Result subtypes that describe the agent rather than the invocation.
 * `error_max_turns` means it worked and ran out of turns, which is a finding;
 * every other error means the run did not happen.
 */
const SCOREABLE_RESULTS = new Set(['success', 'error_max_turns']);

function runTrialProcess(command: ClaudeTrialCommand): Promise<ProcessOutcome> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command.program, command.args, {
      cwd: command.cwd,
      stdio: 'pipe',
      env: command.env,
    });
    // A trial that never returns is not a slow trial, it is a stopped run.
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(
        new Error(
          `"${command.program}" was still running after ${Math.round(command.timeoutMs / 1000)}s ` +
            'and was killed; the trial measured nothing and is rejected rather than scored',
        ),
      );
    }, command.timeoutMs);
    deadline.unref?.();
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      rejectPromise(
        new Error(`could not start "${command.program}" in ${command.cwd}: ${err.message}`),
      );
    });
    child.stdin.on('error', (err) => {
      // The child can exit before the prompt is written; rejecting here keeps
      // an EPIPE from surfacing as an unhandled error after close.
      rejectPromise(
        new Error(`could not write the trial prompt to "${command.program}": ${err.message}`),
      );
    });
    child.on('close', (code) => {
      clearTimeout(deadline);
      resolvePromise({ exitCode: code ?? -1, stdout, stderr });
    });
    child.stdin.write(command.stdin);
    child.stdin.end();
  });
}

/**
 * What one parsed stream becomes as a trial's output. Kept separate from the
 * invoker because everything the report cannot recover later is decided here:
 * a field read from the stream and not copied across is a field the record
 * does not have. Tokens and cost were parsed and dropped exactly this way, and
 * every trial reported zero of both.
 */
export function agentOutputFromStream(parsed: ClaudeStreamResult, code: string): AgentTrialOutput {
  const output: AgentTrialOutput = {
    code,
    turns: parsed.numTurns ?? 1,
    transcript: parsed.transcript,
    sawHookEvents: parsed.sawHookEvents,
    hookEvents: parsed.hookEvents,
  };
  if (parsed.model !== undefined) {
    output.modelVersion = parsed.model;
  }
  if (parsed.permissionMode !== undefined) {
    output.permissionMode = parsed.permissionMode;
  }
  if (parsed.tokens !== undefined) {
    output.tokens = parsed.tokens;
  }
  if (parsed.costUsd !== undefined) {
    output.costUsd = parsed.costUsd;
  }
  if (parsed.lastText !== undefined) {
    output.lastText = parsed.lastText;
  }
  return output;
}

/**
 * The invoker the sampling tool hands to the harness. The agent edits the
 * fixture with its own tools inside the arm's scratch repository; what the
 * trial records as `code` is whatever is on disk afterwards, and what it
 * records as the transcript is the event stream the runtime emitted.
 */
export function createClaudeCodeInvoker(
  options: ClaudeInvokerOptions = {},
): (prompt: string, filePath: string, environment: TrialEnvironment) => Promise<AgentTrialOutput> {
  return async (prompt, filePath, environment) => {
    const command = buildClaudeTrialCommand(prompt, filePath, environment, options);
    const run = await runTrialProcess(command);
    const parsed = parseClaudeStreamJson(run.stdout, environment.repoRoot);
    if (!parsed.sawResult) {
      throw new Error(
        `"${command.program}" produced no result event for ${filePath} ` +
          `(exit ${run.exitCode}); the run emitted no transcript and cannot be ` +
          `scored. stderr: ${run.stderr.trim().slice(0, 400)}`,
      );
    }
    // A result event is not the same as a run that happened. The runtime
    // reports its own failures through the subtype, and a trial that errored
    // out has one turn, no transcript and an unchanged fixture — which the
    // scorers read as an agent that shipped a shortcut, because the fixture's
    // own violations are still sitting there. Observed 2026-09-07: forty such
    // trials produced a complete report in under three minutes.
    //
    // `error_max_turns` is kept: the agent worked and ran out of turns, which
    // is a result about the agent. Anything else is a failed invocation.
    if (!SCOREABLE_RESULTS.has(parsed.resultSubtype ?? 'success')) {
      throw new Error(
        `"${command.program}" ended with result "${parsed.resultSubtype ?? 'unknown'}" for ` +
          `${filePath} (exit ${run.exitCode}); the invocation failed rather than ` +
          `measuring anything. stderr: ${run.stderr.trim().slice(0, 400)}`,
      );
    }
    const code = await readFile(filePath, 'utf-8');
    return agentOutputFromStream(parsed, code);
  };
}
