import path from 'node:path';
import type { RuleGuidance, Severity, Violation } from '../protocol/index.js';
import type { RunReport } from './types.js';

interface SarifMessage {
  text: string;
  markdown?: string;
}

interface SarifRule {
  id: string;
  shortDescription: SarifMessage;
  fullDescription: SarifMessage;
  help: { text: string; markdown: string };
  properties?: Record<string, string>;
}

interface SarifArtifactLocation {
  uri: string;
}

interface SarifRegion {
  startLine: number;
  startColumn: number;
  endLine?: number;
  endColumn?: number;
}

interface SarifPhysicalLocation {
  artifactLocation: SarifArtifactLocation;
  region: SarifRegion;
}

interface SarifLocation {
  physicalLocation: SarifPhysicalLocation;
}

interface SarifResult {
  ruleId: string;
  ruleIndex?: number;
  level: 'error' | 'warning' | 'note' | 'none';
  message: { text: string };
  locations: SarifLocation[];
}

interface SarifToolDriver {
  name: string;
  informationUri: string;
  rules: SarifRule[];
}

interface SarifTool {
  driver: SarifToolDriver;
}

/**
 * Enough of a SARIF `invocation` to say what this run actually did.
 *
 * An empty `results` array is the same shape whether the tool checked 149 files
 * and found nothing or checked none at all because a path glob matched nothing.
 * SARIF consumers render both as "no alerts", so the distinction has to be
 * carried somewhere a reader can reach — here, and in `properties` below.
 */
interface SarifInvocation {
  executionSuccessful: boolean;
  toolExecutionNotifications?: SarifNotification[];
}

interface SarifNotification {
  level: 'note' | 'warning' | 'error';
  message: { text: string };
}

interface SarifRunProperties {
  filesChecked: number;
  mode: string;
  strict: boolean;
  /** Rules enabled for this run, whether or not any of them fired. */
  rulesEnabled: number;
  /** Rules with scope 'project' that this mode could not run. */
  projectRulesSkipped: string[];
  /** How many semantic findings were withheld because type resolution was degraded. */
  withheldFindings?: number;
  /** How many distinct files had at least one finding withheld. */
  withheldFiles?: number;
  /** Reasons the analyzer gave for degraded type resolution, one per distinct cause. */
  withheldReasons?: string[];
}

interface SarifRun {
  tool: SarifTool;
  invocations: SarifInvocation[];
  results: SarifResult[];
  properties: SarifRunProperties;
}

interface SarifLog {
  $schema: string;
  version: '2.1.0';
  runs: SarifRun[];
}

const SARIF_SCHEMA_URI = 'https://json.schemastore.org/sarif-2.1.0.json';
const TOOL_INFORMATION_URI = 'https://github.com/checkyourvibe/checkyourvibe';

function levelForSeverity(severity: Severity): 'error' | 'warning' | 'note' | 'none' {
  return severity === 'error' ? 'error' : 'warning';
}

/**
 * A SARIF `artifactLocation.uri` is resolved by the consumer against a base,
 * so it must be repository-relative. An absolute Windows path breaks every
 * consumer that tries.
 *
 * The repository root is passed in rather than inferred. Inferring it from the
 * common directory of the reported files was the first attempt, and it is
 * wrong in the ordinary case: a run over a single file has that file's own
 * directory as its common prefix, so every URI collapsed to a bare basename
 * and pointed at the wrong place in the repository — silently, and only when
 * a consumer went looking for the file.
 */
function repoRelativeUri(file: string, repoRoot: string): string {
  const relativePath = path.relative(repoRoot, path.resolve(file));
  return relativePath.replace(/\\/g, '/');
}

function buildRegion(violation: Violation): SarifRegion {
  const region: SarifRegion = {
    startLine: violation.line,
    startColumn: violation.column,
  };

  if (violation.endLine !== undefined) {
    region.endLine = violation.endLine;
  }
  if (violation.endColumn !== undefined) {
    region.endColumn = violation.endColumn;
  }

  return region;
}

function buildHelpMarkdown(guidance: RuleGuidance): string {
  const lines: string[] = [];

  lines.push('## Allowed fixes');
  for (const fix of guidance.allowedFixes) {
    lines.push(`- ${fix}`);
  }

  if (guidance.notFixes.length > 0) {
    lines.push('');
    lines.push('## Do not');
    for (const notFix of guidance.notFixes) {
      const ruleRef = notFix.rule !== undefined ? ` (would trip \`${notFix.rule}\`)` : '';
      lines.push(`- **${notFix.pattern}** — ${notFix.because}${ruleRef}`);
    }
  }

  return lines.join('\n');
}

function findRule(ruleId: string, report: RunReport): RuleGuidance | undefined {
  for (const violation of report.violations) {
    if (violation.ruleId === ruleId && violation.guidance !== undefined) {
      return violation.guidance;
    }
  }
  return undefined;
}

function ruleProperties(
  ruleId: string,
  guidance: RuleGuidance,
  report: RunReport,
): Record<string, string> | undefined {
  const properties: Record<string, string> = {};

  const analyzer = report.ruleAnalyzers?.[ruleId];
  if (analyzer !== undefined) {
    properties.analyzer = analyzer;
  }

  if (guidance.evidence === 'syntax' || guidance.evidence === 'semantic') {
    properties.evidence = guidance.evidence;
  }

  if (Object.keys(properties).length === 0) {
    return undefined;
  }

  return properties;
}

function buildRule(ruleId: string, guidance: RuleGuidance, report: RunReport): SarifRule {
  const properties = ruleProperties(ruleId, guidance, report);
  const rule: SarifRule = {
    id: ruleId,
    shortDescription: { text: guidance.summary },
    fullDescription: { text: guidance.why },
    help: {
      text: 'Remediation guidance for this rule.',
      markdown: buildHelpMarkdown(guidance),
    },
  };

  if (properties !== undefined) {
    rule.properties = properties;
  }

  return rule;
}

function buildRules(report: RunReport): SarifRule[] {
  const ruleIds = new Set(report.violations.map((v) => v.ruleId));
  const rules: SarifRule[] = [];

  for (const ruleId of ruleIds) {
    const guidance = findRule(ruleId, report);
    if (guidance === undefined) {
      continue;
    }
    rules.push(buildRule(ruleId, guidance, report));
  }

  return rules;
}

function buildResults(report: RunReport, rules: SarifRule[], repoRoot: string): SarifResult[] {
  const ruleIndexById = new Map(rules.map((rule, index) => [rule.id, index]));

  const results: SarifResult[] = [];
  for (const violation of report.violations) {
    const ruleIndex = ruleIndexById.get(violation.ruleId);
    const result: SarifResult = {
      ruleId: violation.ruleId,
      level: levelForSeverity(violation.severity),
      message: { text: violation.message },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: repoRelativeUri(violation.file, repoRoot) },
            region: buildRegion(violation),
          },
        },
      ],
    };

    if (ruleIndex !== undefined) {
      result.ruleIndex = ruleIndex;
    }

    results.push(result);
  }

  return results;
}

/**
 * Everything the run needs to say that an empty `results` array cannot.
 *
 * A file this run could not read, a project-scoped rule this mode could not
 * run, and a run that checked nothing at all are each reported here. A
 * consumer that shows only `results` will still show "no alerts" — but the
 * information exists for one that looks, rather than being dropped at the
 * boundary because the format's headline field had no room for it.
 */
function buildNotifications(report: RunReport): SarifNotification[] {
  const notifications: SarifNotification[] = [];

  if (report.filesChecked === 0) {
    notifications.push({
      level: 'warning',
      message: {
        text:
          'No files were checked. An empty result set here means nothing was examined, ' +
          'not that nothing was found.',
      },
    });
  }

  for (const skipped of report.skipped) {
    notifications.push({
      level: 'warning',
      message: { text: `Skipped ${skipped.file}: ${skipped.reason}` },
    });
  }

  for (const diagnostic of report.diagnostics) {
    notifications.push({
      level: 'note',
      message: { text: diagnostic.message },
    });
  }

  if (report.projectRulesSkipped.length > 0) {
    notifications.push({
      level: 'note',
      message: {
        text:
          `${report.projectRulesSkipped.length} project-scoped rule(s) did not run in mode ` +
          `"${report.mode}": ${report.projectRulesSkipped.join(', ')}.`,
      },
    });
  }

  return notifications;
}

function buildRun(report: RunReport, repoRoot: string): SarifRun {
  const rules = buildRules(report);
  const results = buildResults(report, rules, repoRoot);
  const notifications = buildNotifications(report);

  const invocation: SarifInvocation = {
    // The run completed. Whether it found anything is `results`; whether it
    // could not examine something is `toolExecutionNotifications`.
    executionSuccessful: true,
  };
  if (notifications.length > 0) {
    invocation.toolExecutionNotifications = notifications;
  }

  const properties: SarifRunProperties = {
    filesChecked: report.filesChecked,
    mode: report.mode,
    strict: report.strict,
    rulesEnabled: Object.keys(report.ruleCategories ?? {}).length,
    projectRulesSkipped: report.projectRulesSkipped,
  };

  if (report.withheldFindings !== undefined) {
    properties.withheldFindings = report.withheldFindings;
  }
  if (report.withheldFiles !== undefined) {
    properties.withheldFiles = report.withheldFiles;
  }
  if (report.withheldReasons !== undefined) {
    properties.withheldReasons = report.withheldReasons;
  }

  return {
    tool: {
      driver: {
        name: 'checkyourvibe',
        informationUri: TOOL_INFORMATION_URI,
        rules,
      },
    },
    invocations: [invocation],
    results,
    properties,
  };
}

export function renderSarif(report: RunReport, repoRoot: string): string {
  const log: SarifLog = {
    $schema: SARIF_SCHEMA_URI,
    version: '2.1.0',
    runs: [buildRun(report, path.resolve(repoRoot))],
  };

  return JSON.stringify(log, null, 2);
}
