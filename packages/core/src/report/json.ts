import type { RuleGuidance, Violation } from '../protocol/index.js';
import type { RunReport } from './types.js';

export interface JsonReportOptions {
  /**
   * Move each rule's guidance out of its violations and into a single
   * `ruleGuidance` object keyed by rule id.
   *
   * Off by default: Requirement 3.5 puts the guidance on the violation so that
   * a consumer reading one finding has its fixes and its dead ends without a
   * second lookup, and every existing consumer reads it there. On a repository
   * with thousands of findings the same guidance objects are what most of the
   * document is, so this is the encoding for a caller that wants the whole
   * report rather than individual findings.
   */
  dedupeGuidance?: boolean;
}

interface DedupedViolations {
  violations: Violation[];
  ruleGuidance: Record<string, RuleGuidance>;
}

/**
 * Strip `guidance` from each violation and collect one copy per rule id.
 *
 * Two violations of the same rule carry the same guidance object, because the
 * core attaches it from the rule manifest rather than letting analyzers write
 * it (see `protocol/violation.ts`). The first copy seen is therefore the copy
 * for the rule.
 */
function dedupeGuidance(violations: readonly Violation[]): DedupedViolations {
  const ruleGuidance: Record<string, RuleGuidance> = {};
  const stripped: Violation[] = [];

  for (const violation of violations) {
    const { guidance, ...rest } = violation;
    if (guidance !== undefined && ruleGuidance[violation.ruleId] === undefined) {
      ruleGuidance[violation.ruleId] = guidance;
    }
    stripped.push(rest);
  }

  return { violations: stripped, ruleGuidance };
}

export function renderJson(report: RunReport, options: JsonReportOptions = {}): string {
  const deduped = options.dedupeGuidance === true ? dedupeGuidance(report.violations) : undefined;

  const ordered: Record<string, unknown> = {
    violations: deduped?.violations ?? report.violations,
    skipped: report.skipped,
    diagnostics: report.diagnostics,
    filesChecked: report.filesChecked,
    mode: report.mode,
    projectRulesSkipped: report.projectRulesSkipped,
    strict: report.strict,
  };

  if (deduped !== undefined) {
    ordered.ruleGuidance = deduped.ruleGuidance;
  }

  if (report.ruleCategories !== undefined) {
    ordered.ruleCategories = report.ruleCategories;
  }

  if (report.ruleAnalyzers !== undefined) {
    ordered.ruleAnalyzers = report.ruleAnalyzers;
  }

  // How much of the configuration actually ran. The human notice has said
  // "13 of 17 rules enabled" since a one-character typo in a pack name silently
  // disabled four rules and printed a clean result — but the JSON did not carry
  // it, so every machine consumer was back to the state that defect exposed:
  // unable to tell a full run from a nearly-empty one.
  if (report.rulesEnabled !== undefined) {
    ordered.rulesEnabled = report.rulesEnabled;
  }
  if (report.rulesAvailable !== undefined) {
    ordered.rulesAvailable = report.rulesAvailable;
  }
  if (report.unknownPacks !== undefined && report.unknownPacks.length > 0) {
    ordered.unknownPacks = report.unknownPacks;
  }
  if (report.zeroContributionAnalyzers !== undefined && report.zeroContributionAnalyzers.length > 0) {
    ordered.zeroContributionAnalyzers = report.zeroContributionAnalyzers;
  }

  if (report.withheldFindings !== undefined) {
    ordered.withheldFindings = report.withheldFindings;
  }
  if (report.withheldFiles !== undefined) {
    ordered.withheldFiles = report.withheldFiles;
  }
  if (report.withheldReasons !== undefined) {
    ordered.withheldReasons = report.withheldReasons;
  }

  return JSON.stringify(ordered, null, 2);
}
