import type { RuleGuidance, Severity, Violation } from '../protocol/index.js';
import type { RunReport } from './types.js';

const INDENT = '  ';
const SUB_INDENT = '    ';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

/**
 * How many findings each rule lists in the default report before the remainder
 * is counted rather than printed.
 */
export const DEFAULT_MAX_PER_RULE = 10;

/** How many files the "most findings" table names. */
const TOP_FILES = 10;

/**
 * How the findings are laid out.
 *
 * `summary` — the per-rule and per-file tables only; no individual findings.
 * `compact` — the tables, then each rule's guidance once followed by up to
 *   `maxPerRule` of its findings, one line each.
 * `full` — `compact` with every finding listed.
 * `detailed` — one block per finding, each carrying its own copy of the rule's
 *   guidance. This is the shape an agent reads when it consumes findings one at
 *   a time rather than a whole repository at once.
 */
export type ReportStyle = 'summary' | 'compact' | 'full' | 'detailed';

export interface TextReportOptions {
  style?: ReportStyle;
  /** Findings listed per rule in `compact`. Ignored by the other styles. */
  maxPerRule?: number;
  /**
   * Absolute repository root. Finding paths inside it are printed relative to
   * it, and the report states the root once.
   */
  root?: string;
}

function isColorEnabled(): boolean {
  return process.stdout.isTTY === true && !('NO_COLOR' in process.env);
}

function color(code: string, text: string, enabled: boolean): string {
  return enabled ? `${code}${text}${RESET}` : text;
}

function severityColor(severity: Severity): string {
  return severity === 'error' ? '\x1b[31m' : '\x1b[33m';
}

function severityLabel(severity: Severity, useColor: boolean): string {
  const label = severity.padEnd(7);
  return color(severityColor(severity), label, useColor);
}

function categoryFor(violation: Violation, report: RunReport): string {
  const fromRule = report.ruleCategories?.[violation.ruleId];
  if ('category' in violation) {
    const category = violation.category;
    if (typeof category === 'string') {
      return category;
    }
  }
  return fromRule ?? violation.ruleId;
}

function analyzerFromFile(file: string): string | undefined {
  const lower = file.toLowerCase();
  if (lower.endsWith('.cs')) return 'csharp';
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'typescript';
  return undefined;
}

function analyzerFor(
  violation: Violation,
  report: RunReport,
): string | undefined {
  const fromRule = report.ruleAnalyzers?.[violation.ruleId];
  return fromRule ?? analyzerFromFile(violation.file);
}

function sortKey(
  violation: Violation,
  report: RunReport,
): [string, string, number, number] {
  return [
    categoryFor(violation, report),
    violation.file,
    violation.line,
    violation.column,
  ];
}

function sortedViolations(report: RunReport): Violation[] {
  return [...report.violations].sort((a, b) => {
    const [aCategory, aFile, aLine, aColumn] = sortKey(a, report);
    const [bCategory, bFile, bLine, bColumn] = sortKey(b, report);

    const category = aCategory.localeCompare(bCategory);
    if (category !== 0) return category;

    const file = aFile.localeCompare(bFile);
    if (file !== 0) return file;

    if (aLine !== bLine) return aLine - bLine;
    return aColumn - bColumn;
  });
}

function byLocation(a: Violation, b: Violation): number {
  const file = a.file.localeCompare(b.file);
  if (file !== 0) return file;
  if (a.line !== b.line) return a.line - b.line;
  return a.column - b.column;
}

/** The allowed fixes and the dead ends, one line each. */
function formatFixes(guidance: RuleGuidance, indent: string): string[] {
  const lines: string[] = [];

  for (const fix of guidance.allowedFixes) {
    lines.push(`${indent}- ${fix}`);
  }

  for (const notFix of guidance.notFixes) {
    const rule = notFix.rule !== undefined ? ` [would trip ${notFix.rule}]` : '';
    lines.push(`${indent}not: ${notFix.pattern} — ${notFix.because}${rule}`);
  }

  return lines;
}

function formatGuidance(guidance: RuleGuidance, indent: string): string[] {
  return [`${indent}${guidance.summary}`, ...formatFixes(guidance, indent)];
}

function formatViolation(
  violation: Violation,
  useColor: boolean,
  showAnalyzer: boolean,
  analyzer: string | undefined,
): string[] {
  const lines: string[] = [];
  const location = `${violation.file}:${violation.line}:${violation.column}`;
  const ruleLabel =
    showAnalyzer && analyzer !== undefined
      ? `${violation.ruleId} [${analyzer}]`
      : violation.ruleId;
  lines.push(
    `${INDENT}${severityLabel(violation.severity, useColor)}  ${location}  ${ruleLabel}  ${violation.message}`,
  );

  if (violation.guidance !== undefined) {
    lines.push(...formatGuidance(violation.guidance, SUB_INDENT));
  }

  return lines;
}

/**
 * The path as the report prints it: relative to `root` when the file is inside
 * it, absolute otherwise.
 *
 * The comparison is case-insensitive and separator-insensitive because
 * analyzers report OS-native absolute paths, which on Windows can differ from
 * the resolved repository root in drive-letter case and slash direction.
 */
function displayPath(file: string, root: string | undefined): string {
  if (root === undefined) {
    return file;
  }
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedFile = file.replace(/\\/g, '/');
  const prefix = `${normalizedRoot}/`;
  if (normalizedFile.toLowerCase().startsWith(prefix.toLowerCase())) {
    return normalizedFile.slice(prefix.length);
  }
  return file;
}

interface RuleGroup {
  ruleId: string;
  category: string;
  analyzer: string | undefined;
  guidance: RuleGuidance | undefined;
  violations: Violation[];
  errors: number;
  warnings: number;
}

interface CategoryGroup {
  category: string;
  rules: RuleGroup[];
  total: number;
}

function groupByRule(report: RunReport): RuleGroup[] {
  const groups = new Map<string, RuleGroup>();

  for (const violation of report.violations) {
    const existing = groups.get(violation.ruleId);
    const group: RuleGroup = existing ?? {
      ruleId: violation.ruleId,
      category: categoryFor(violation, report),
      analyzer: analyzerFor(violation, report),
      guidance: violation.guidance,
      violations: [],
      errors: 0,
      warnings: 0,
    };
    if (existing === undefined) {
      groups.set(violation.ruleId, group);
    }
    if (group.guidance === undefined && violation.guidance !== undefined) {
      group.guidance = violation.guidance;
    }
    group.violations.push(violation);
    if (violation.severity === 'error') {
      group.errors += 1;
    } else {
      group.warnings += 1;
    }
  }

  const ordered = [...groups.values()];
  for (const group of ordered) {
    group.violations.sort(byLocation);
  }
  ordered.sort(
    (a, b) => b.violations.length - a.violations.length || a.ruleId.localeCompare(b.ruleId),
  );
  return ordered;
}

function groupByCategory(rules: readonly RuleGroup[]): CategoryGroup[] {
  const categories = new Map<string, CategoryGroup>();

  for (const rule of rules) {
    const existing = categories.get(rule.category);
    const group: CategoryGroup = existing ?? {
      category: rule.category,
      rules: [],
      total: 0,
    };
    if (existing === undefined) {
      categories.set(rule.category, group);
    }
    group.rules.push(rule);
    group.total += rule.violations.length;
  }

  const ordered = [...categories.values()];
  ordered.sort((a, b) => b.total - a.total || a.category.localeCompare(b.category));
  return ordered;
}

interface FileCount {
  file: string;
  count: number;
}

function countByFile(violations: readonly Violation[]): FileCount[] {
  const counts = new Map<string, number>();
  for (const violation of violations) {
    counts.set(violation.file, (counts.get(violation.file) ?? 0) + 1);
  }
  const ordered: FileCount[] = [];
  for (const [file, count] of counts) {
    ordered.push({ file, count });
  }
  ordered.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
  return ordered;
}

function widestCount(counts: readonly number[]): number {
  let widest = 0;
  for (const count of counts) {
    const width = String(count).length;
    if (width > widest) {
      widest = width;
    }
  }
  return widest;
}

function ruleSeverityLabel(group: RuleGroup, useColor: boolean): string {
  if (group.errors > 0 && group.warnings > 0) {
    return 'mixed  ';
  }
  return severityLabel(group.errors > 0 ? 'error' : 'warning', useColor);
}

function findingWord(count: number): string {
  return count === 1 ? 'finding' : 'findings';
}

/**
 * The per-rule table: every rule that fired, ordered by how many findings it
 * produced.
 */
function ruleTable(
  rules: readonly RuleGroup[],
  report: RunReport,
  fileTotal: number,
  useColor: boolean,
  showAnalyzers: boolean,
): string[] {
  const total = report.violations.length;
  const lines: string[] = [
    color(
      BOLD,
      `Findings by rule — ${total} ${findingWord(total)} in ${fileTotal} of ${report.filesChecked} files checked`,
      useColor,
    ),
  ];

  const countWidth = widestCount(rules.map((rule) => rule.violations.length));
  let ruleWidth = 0;
  for (const rule of rules) {
    if (rule.ruleId.length > ruleWidth) {
      ruleWidth = rule.ruleId.length;
    }
  }

  for (const rule of rules) {
    const analyzer =
      showAnalyzers && rule.analyzer !== undefined ? ` [${rule.analyzer}]` : '';
    const count = String(rule.violations.length).padStart(countWidth);
    lines.push(
      `${INDENT}${count}  ${ruleSeverityLabel(rule, useColor)}  ${rule.ruleId.padEnd(ruleWidth)}  ${rule.category}${analyzer}`,
    );
  }

  return lines;
}

/** The per-file table: the files carrying the most findings. */
function fileTable(
  files: readonly FileCount[],
  root: string | undefined,
  useColor: boolean,
): string[] {
  const shown = files.slice(0, TOP_FILES);
  const lines: string[] = [color(BOLD, 'Files with the most findings', useColor)];

  const countWidth = widestCount(shown.map((entry) => entry.count));
  for (const entry of shown) {
    lines.push(
      `${INDENT}${String(entry.count).padStart(countWidth)}  ${displayPath(entry.file, root)}`,
    );
  }

  const remaining = files.length - shown.length;
  if (remaining > 0) {
    lines.push(
      `${INDENT}… and ${remaining} more file${remaining === 1 ? '' : 's'} with findings.`,
    );
  }

  return lines;
}

/**
 * One rule's section: its guidance once, then its findings one line each.
 *
 * The guidance is printed at the head of the section rather than under every
 * finding. A reader of the section still sees the allowed fixes and the
 * not-fixes without leaving the report, and sees them once however many
 * findings the rule produced.
 */
function ruleSection(
  group: RuleGroup,
  options: {
    style: ReportStyle;
    maxPerRule: number;
    root: string | undefined;
    useColor: boolean;
    showAnalyzers: boolean;
  },
): { lines: string[]; hidden: number } {
  const { useColor, root } = options;
  const count = group.violations.length;
  const analyzer =
    options.showAnalyzers && group.analyzer !== undefined ? ` [${group.analyzer}]` : '';
  const severity =
    group.errors > 0 && group.warnings > 0
      ? `${group.errors} error${group.errors === 1 ? '' : 's'}, ${group.warnings} warning${group.warnings === 1 ? '' : 's'}`
      : group.errors > 0
        ? 'error'
        : 'warning';

  const lines: string[] = [
    `${INDENT}${color(BOLD, group.ruleId, useColor)}${analyzer} — ${count} ${findingWord(count)}, ${severity}`,
  ];

  const guidance = group.guidance;
  if (guidance !== undefined) {
    lines.push(`${SUB_INDENT}${guidance.summary}`);
    // Printing the guidance once per rule leaves room for `why`, which the
    // per-finding form omits.
    lines.push(`${SUB_INDENT}${guidance.why}`);
    lines.push(...formatFixes(guidance, SUB_INDENT));
    if (guidance.evidence !== undefined) {
      lines.push(
        `${SUB_INDENT}Evidence: ${guidance.evidence === 'semantic' ? 'resolved types' : 'syntax only'}.`,
      );
    }
  }

  const limit = options.style === 'full' ? count : Math.min(options.maxPerRule, count);
  const mixed = group.errors > 0 && group.warnings > 0;
  for (const violation of group.violations.slice(0, limit)) {
    const marker = mixed ? `${severityLabel(violation.severity, useColor)}  ` : '';
    lines.push(
      `${SUB_INDENT}${marker}${displayPath(violation.file, root)}:${violation.line}:${violation.column}  ${violation.message}`,
    );
  }

  const hidden = count - limit;
  if (hidden > 0) {
    lines.push(
      color(
        DIM,
        `${SUB_INDENT}… ${hidden} more ${findingWord(hidden)} for ${group.ruleId}, not listed.`,
        useColor,
      ),
    );
  }

  return { lines, hidden };
}

/** The lines that precede the findings in every style. */
function preamble(report: RunReport): string[] {
  const lines: string[] = [];

  if (report.filesChecked === 0) {
    lines.push('No files were matched by this run; this is not a pass.');
  }

  if (report.projectRulesSkipped.length > 0) {
    lines.push(`Project-scope rules not run in '${report.mode}' mode:`);
    for (const ruleId of report.projectRulesSkipped) {
      lines.push(`${INDENT}${ruleId} — would run in project mode`);
    }
  }

  if (report.skipped.length > 0) {
    lines.push('Skipped files:');
    for (const { file, reason } of report.skipped) {
      lines.push(`${INDENT}${file} — ${reason}`);
    }
    if (report.strict) {
      lines.push('Strict mode is on, so skipped files cause this run to fail.');
    }
  }

  if (report.diagnostics.length > 0) {
    lines.push('Diagnostics:');
    for (const { level, message } of report.diagnostics) {
      lines.push(`${INDENT}[${level}] ${message}`);
    }
  }

  return lines;
}

/** The counts every run ends with, whatever the style. */
function summaryLine(report: RunReport): string {
  const errors = report.violations.filter((v) => v.severity === 'error').length;
  const warnings = report.violations.filter((v) => v.severity === 'warning').length;
  const errorWord = errors === 1 ? 'error' : 'errors';
  const warningWord = warnings === 1 ? 'warning' : 'warnings';
  const fileWord = report.filesChecked === 1 ? 'file' : 'files';
  return `${errors} ${errorWord}, ${warnings} ${warningWord}, ${report.filesChecked} ${fileWord} checked`;
}

function analyzersInPlay(report: RunReport): boolean {
  const ids = new Set<string>();
  for (const violation of report.violations) {
    const id = analyzerFor(violation, report);
    if (id !== undefined) {
      ids.add(id);
    }
  }
  return ids.size > 1;
}

/**
 * The findings as one block per finding, each repeating its rule's guidance.
 *
 * This is the shape `cyv check` printed before the grouped report existed, and
 * the shape a consumer that reads findings individually needs: a single finding
 * lifted out of this output still carries its fixes and its dead ends.
 */
function detailedFindings(report: RunReport, useColor: boolean): string[] {
  const lines: string[] = [];
  const showAnalyzers = analyzersInPlay(report);
  let currentCategory: string | undefined;

  for (const violation of sortedViolations(report)) {
    const category = categoryFor(violation, report);
    if (category !== currentCategory) {
      if (currentCategory !== undefined) {
        lines.push('');
      }
      lines.push(color(BOLD, category, useColor));
      currentCategory = category;
    }
    lines.push(
      ...formatViolation(violation, useColor, showAnalyzers, analyzerFor(violation, report)),
    );
  }

  return lines;
}

/**
 * The findings as a per-rule breakdown, the files carrying the most of them,
 * and then each rule's guidance once above a compact list of its findings.
 */
function groupedFindings(
  report: RunReport,
  useColor: boolean,
  options: Required<Pick<TextReportOptions, 'style' | 'maxPerRule'>> & { root: string | undefined },
): string[] {
  const rules = groupByRule(report);
  if (rules.length === 0) {
    return [];
  }

  const showAnalyzers = analyzersInPlay(report);
  const files = countByFile(report.violations);
  const lines: string[] = [];

  if (options.style === 'summary' || rules.length > 1) {
    lines.push(...ruleTable(rules, report, files.length, useColor, showAnalyzers));
    lines.push('');
  }

  if (options.style === 'summary' || files.length > 1) {
    lines.push(...fileTable(files, options.root, useColor));
    lines.push('');
  }

  if (options.style === 'summary') {
    const total = report.violations.length;
    lines.push(
      `${total} ${findingWord(total)} not listed. Use --report compact for each rule's guidance and examples, --report full for every finding, or --json for all of them.`,
    );
    lines.push('');
    return lines;
  }

  if (options.root !== undefined) {
    lines.push(`Paths below are relative to ${options.root}.`);
    lines.push('');
  }

  let hiddenTotal = 0;
  for (const category of groupByCategory(rules)) {
    lines.push(color(BOLD, category.category, useColor));
    for (const rule of category.rules) {
      const section = ruleSection(rule, {
        style: options.style,
        maxPerRule: options.maxPerRule,
        root: options.root,
        useColor,
        showAnalyzers,
      });
      lines.push(...section.lines);
      lines.push('');
      hiddenTotal += section.hidden;
    }
  }

  if (hiddenTotal > 0) {
    lines.push(
      `${hiddenTotal} ${findingWord(hiddenTotal)} were counted but not listed. Use --report full to list every one, or --json for the whole report.`,
    );
    lines.push('');
  }

  return lines;
}

function buildReportText(
  report: RunReport,
  useColor: boolean,
  options: TextReportOptions,
): string {
  const style = options.style ?? 'compact';
  const maxPerRule = options.maxPerRule ?? DEFAULT_MAX_PER_RULE;
  const lines: string[] = [...preamble(report)];

  if (style === 'detailed') {
    lines.push(...detailedFindings(report, useColor));
  } else {
    if (lines.length > 0 && report.violations.length > 0) {
      lines.push('');
    }
    lines.push(...groupedFindings(report, useColor, { style, maxPerRule, root: options.root }));
  }

  lines.push(summaryLine(report));

  return lines.join('\n');
}

/** Render a report for the terminal, using colour when stdout is a TTY. */
export function renderText(report: RunReport, options: TextReportOptions = {}): string {
  return buildReportText(report, isColorEnabled(), options);
}

/** Render a report with colour disabled, for tests and non-TTY consumers. */
export function renderTextPlain(report: RunReport, options: TextReportOptions = {}): string {
  return buildReportText(report, false, options);
}
