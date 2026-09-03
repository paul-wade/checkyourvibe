import type { Diagnostic, SkippedFile, Violation } from '../protocol/index.js';

export interface RunReport {
  violations: Violation[];
  skipped: SkippedFile[];
  diagnostics: Diagnostic[];
  filesChecked: number;
  mode: string;
  /** Rule ids with scope 'project' that this mode did not run. */
  projectRulesSkipped: string[];
  strict: boolean;
  /** Optional map from rule id to category; used to group text output. */
  ruleCategories?: Record<string, string>;
  /** Optional map from rule id to analyzer id; used to attribute findings in multi-analyzer runs. */
  ruleAnalyzers?: Record<string, string>;
  /** Rules enabled by the resolved configuration (across every configured pack). */
  rulesEnabled?: number;
  /** Total rules available from every loaded analyzer manifest. */
  rulesAvailable?: number;
  /** Pack names declared in configuration that no loaded analyzer provides. */
  unknownPacks?: string[];
  /** Analyzer ids that have zero rules enabled by the configuration. */
  zeroContributionAnalyzers?: string[];
  /** How many semantic findings were withheld because type resolution was degraded. */
  withheldFindings?: number;
  /** How many distinct files had at least one finding withheld. */
  withheldFiles?: number;
  /** Reasons the analyzer gave for degraded type resolution, one per distinct cause. */
  withheldReasons?: string[];
}
