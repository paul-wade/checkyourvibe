/**
 * `cyv upgrade` — re-apply generated agent glue after rule manifests change.
 *
 * It loads the existing `checkyourvibe.json`, re-resolves every configured
 * analyzer, rebuilds the rule catalog, and re-plans generated agent glue for
 * every configured agent. Per-rule guidance files are updated when their rule's
 * text changed, and guidance for removed rules is deleted only when the file
 * can be positively identified as generated. A file that appears to have been
 * hand-edited is reported and left alone unless `--force` is passed.
 *
 * Three properties this command holds to:
 *
 * - It plans through the same `AgentPlugin.plan` call and merges through the
 *   same `applyPlannedWrite` as `cyv init`, and it gates writes outside the
 *   repository behind the same `--allow-outside-repo` flag. A file that `init`
 *   would not have written is not a file `upgrade` may write.
 * - An analyzer that no longer resolves is a stale configuration entry to
 *   report, not a crash. The core ships no analyzer, so a catalog that shrinks
 *   to nothing is a state the user can reach by uninstalling one module.
 * - While any configured analyzer is unresolved, no guidance is deleted. Its
 *   rules are missing from the catalog because the manifest could not be read,
 *   which is not evidence that the rules are gone.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolveBriefInput } from '../executor/brief.js';
import type { Dirent } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { Command, CommandContext } from './types.js';
import { repoRoot } from '../run/discover.js';
import { loadConfig } from '../config/load.js';
import {
  allRules,
  loadAnalyzerManifest,
  type AnalyzerConfig,
  type AnalyzerManifest,
} from '../registry/load.js';
import { applyPlannedWrite, planDiff } from '../merge/apply.js';
import {
  MANAGED_BLOCK_END,
  MANAGED_BLOCK_START,
  type AgentPlugin,
  type NotFix,
  type PlannedWrite,
  type RuleManifest,
} from '../protocol/index.js';
import {
  agentPluginsOverride,
  loadAllPlugins,
  resolveCyvCommand,
  assertCyvCommandResolvable,
  resolveHomeDir,
  isInsideRepo,
} from './init.js';

interface ParsedArgs {
  dryRun: boolean;
  force: boolean;
  allowOutsideRepo: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let dryRun = false;
  let force = false;
  let allowOutsideRepo = false;

  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--allow-outside-repo') {
      allowOutsideRepo = true;
    } else {
      throw new Error(`Unknown argument "${arg}" for cyv upgrade.`);
    }
  }

  return { dryRun, force, allowOutsideRepo };
}

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface AnalyzerResolution {
  entry: AnalyzerConfig;
  manifest?: AnalyzerManifest;
  error?: string;
}

async function resolveAnalyzers(
  entries: AnalyzerConfig[],
  root: string,
): Promise<AnalyzerResolution[]> {
  const results: AnalyzerResolution[] = [];

  for (const entry of entries) {
    try {
      const manifest = await loadAnalyzerManifest(entry.package, root);
      if (manifest.id !== entry.id) {
        throw new Error(
          `configured analyzer id "${entry.id}" does not match manifest id "${manifest.id}" from "${entry.package}"`,
        );
      }
      results.push({ entry, manifest });
    } catch (err) {
      results.push({ entry, error: messageFor(err) });
    }
  }

  return results;
}

interface ParsedRule {
  id: string;
  summary: string;
  why: string;
  allowedFixes: string[];
  notFixes: NotFix[];
  examplesBad: string;
  examplesGood: string;
}

interface ParsedGuidanceFile {
  isCombined: boolean;
  rules: ParsedRule[];
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

function trimTrailingBlankLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1];
    if (line === undefined || line.trim() !== '') {
      break;
    }
    end--;
  }
  return lines.slice(0, end);
}

function headingPrefix(depth: number): string {
  return '#'.repeat(depth) + ' ';
}

function isErrnoException(err: unknown, code: string): err is NodeJS.ErrnoException {
  return err instanceof Error && isRecord(err) && err.code === code;
}

async function readTarget(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (err) {
    if (isErrnoException(err, 'ENOENT')) {
      return null;
    }
    throw err;
  }
}

interface FrontmatterResult {
  frontmatter: Record<string, string>;
  bodyLines: string[];
}

function parseFrontmatter(text: string): FrontmatterResult | undefined {
  if (!text.startsWith('---')) {
    return { frontmatter: {}, bodyLines: splitLines(text) };
  }

  const allLines = splitLines(text);
  const frontmatter: Record<string, string> = {};
  let i = 1;

  for (; i < allLines.length; i++) {
    const line = allLines[i];
    if (line === undefined) {
      return undefined;
    }
    if (line === '---') {
      break;
    }
    const colon = line.indexOf(':');
    if (colon === -1) {
      continue;
    }
    const key = line.slice(0, colon).trim();
    let rawValue = line.slice(colon + 1).trim();

    if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(rawValue);
        if (typeof parsed !== 'string') {
          return undefined;
        }
        rawValue = parsed;
      } catch {
        return undefined;
      }
    }

    frontmatter[key] = rawValue;
  }

  if (i >= allLines.length) {
    return undefined;
  }

  return { frontmatter, bodyLines: allLines.slice(i + 1) };
}

function findSectionStart(
  lines: string[],
  start: number,
  end: number,
  headingPrefix: string,
): number {
  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (line !== undefined && line.startsWith(headingPrefix)) {
      return i;
    }
  }
  return -1;
}

function extractSectionLines(
  lines: string[],
  start: number,
  headingPrefix: string,
  end: number,
): string[] | undefined {
  if (start >= end) {
    return undefined;
  }
  const line = lines[start];
  if (line === undefined || !line.startsWith(headingPrefix)) {
    return undefined;
  }

  const body: string[] = [];
  for (let i = start + 1; i < end; i++) {
    const candidate = lines[i];
    if (candidate === undefined) {
      break;
    }
    if (candidate.startsWith(headingPrefix)) {
      break;
    }
    body.push(candidate);
  }

  return trimTrailingBlankLines(body);
}

function parseAllowedFixes(lines: string[]): string[] | undefined {
  const fixes: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') {
      continue;
    }
    if (!line.startsWith('- ')) {
      // A non-bullet after collecting fixes means the next section began.
      return fixes.length > 0 ? fixes : undefined;
    }
    fixes.push(line.slice(2).trim());
  }
  return fixes;
}

function parseNotFixes(lines: string[]): NotFix[] | undefined {
  const notFixes: NotFix[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) {
      break;
    }
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (!line.startsWith('- ')) {
      // A non-bullet after collecting not-fixes means the next section began.
      return notFixes.length > 0 ? notFixes : undefined;
    }

    const pattern = line.slice(2).trim();
    i++;

    const becauseLine = lines[i];
    if (becauseLine === undefined) {
      return undefined;
    }
    const becauseMatch = becauseLine.match(/^\s+because:\s*(.*)$/);
    if (becauseMatch === null || becauseMatch[1] === undefined) {
      return undefined;
    }
    const because = becauseMatch[1].trim();
    i++;

    const nextLine = lines[i];
    if (nextLine !== undefined) {
      const ruleMatch = nextLine.match(/^\s+rule:\s*(.*)$/);
      if (ruleMatch !== null && ruleMatch[1] !== undefined) {
        notFixes.push({ pattern, because, rule: ruleMatch[1].trim() });
        i++;
        continue;
      }
    }

    notFixes.push({ pattern, because });
  }

  return notFixes;
}

function extractCodeBlock(lines: string[], start: number): string | undefined {
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && line.startsWith('```')) {
      break;
    }
  }
  if (i >= lines.length) {
    return undefined;
  }

  i++;
  const body: string[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) {
      return undefined;
    }
    if (line.startsWith('```')) {
      break;
    }
    body.push(line);
  }
  if (i >= lines.length) {
    return undefined;
  }

  return body.join('\n');
}

function parseExamples(
  lines: string[],
  badPrefix: string,
  goodPrefix: string,
): { bad: string; good: string } | undefined {
  const badIndex = lines.findIndex((line) => line.startsWith(badPrefix));
  if (badIndex === -1) {
    return undefined;
  }
  const goodIndex = lines.findIndex((line) => line.startsWith(goodPrefix));
  if (goodIndex === -1) {
    return undefined;
  }

  const badCode = extractCodeBlock(lines, badIndex + 1);
  if (badCode === undefined) {
    return undefined;
  }
  const goodCode = extractCodeBlock(lines, goodIndex + 1);
  if (goodCode === undefined) {
    return undefined;
  }

  return { bad: badCode, good: goodCode };
}

function parseRuleSection(
  lines: string[],
  start: number,
  end: number,
  id: string,
  sectionDepth: number,
  exampleDepth: number,
): ParsedRule | undefined {
  const sectionPrefix = headingPrefix(sectionDepth);
  const examplePrefix = headingPrefix(exampleDepth);

  const whyStart = findSectionStart(lines, start, end, `${sectionPrefix}Why`);
  if (whyStart === -1) {
    return undefined;
  }

  const summaryParts: string[] = [];
  for (let i = start; i < whyStart; i++) {
    const line = lines[i];
    if (line !== undefined && line.trim() !== '') {
      summaryParts.push(line.trim());
    }
  }
  const summary = summaryParts.join('\n');

  const whyLines = extractSectionLines(lines, whyStart, sectionPrefix, end);
  if (whyLines === undefined) {
    return undefined;
  }
  const why = whyLines.join('\n').trim();

  const examplesStart = findSectionStart(lines, whyStart, end, `${sectionPrefix}Examples`);
  if (examplesStart === -1) {
    return undefined;
  }

  const allowedFixes: string[] = [];
  const allowedFixesStart = findSectionStart(
    lines,
    whyStart,
    end,
    `${sectionPrefix}Allowed fixes`,
  );
  if (allowedFixesStart !== -1) {
    const allowedFixesLines = extractSectionLines(
      lines,
      allowedFixesStart,
      sectionPrefix,
      end,
    );
    if (allowedFixesLines !== undefined) {
      const parsed = parseAllowedFixes(allowedFixesLines);
      if (parsed !== undefined) {
        for (const fix of parsed) {
          allowedFixes.push(fix);
        }
      }
    }
  }

  const notFixes: NotFix[] = [];
  const notFixesStart = findSectionStart(lines, whyStart, end, `${sectionPrefix}Not-fixes`);
  if (notFixesStart !== -1) {
    const notFixesLines = extractSectionLines(lines, notFixesStart, sectionPrefix, end);
    if (notFixesLines !== undefined) {
      const parsed = parseNotFixes(notFixesLines);
      if (parsed !== undefined) {
        for (const notFix of parsed) {
          notFixes.push(notFix);
        }
      }
    }
  }

  const examplesLines = extractSectionLines(lines, examplesStart, sectionPrefix, end);
  if (examplesLines === undefined) {
    return undefined;
  }

  const examples = parseExamples(examplesLines, `${examplePrefix}Bad`, `${examplePrefix}Good`);
  if (examples === undefined) {
    return undefined;
  }

  return {
    id,
    summary,
    why,
    allowedFixes,
    notFixes,
    examplesBad: examples.bad,
    examplesGood: examples.good,
  };
}

function parseSingleGuidanceFile(
  bodyLines: string[],
  fileName: string,
): ParsedGuidanceFile | undefined {
  let i = 0;
  while (i < bodyLines.length) {
    const line = bodyLines[i];
    if (line === undefined || line.trim() !== '') {
      break;
    }
    i++;
  }
  if (i >= bodyLines.length) {
    return undefined;
  }

  const titleLine = bodyLines[i];
  if (titleLine === undefined || !titleLine.startsWith('# ')) {
    return undefined;
  }
  const id = titleLine.slice(2).trim();
  const expectedBase = fileName.replace(/^cyv-/, '').replace(/\.mdc?$/, '');
  if (id !== expectedBase) {
    return undefined;
  }

  const rule = parseRuleSection(bodyLines, i + 1, bodyLines.length, id, 2, 3);
  if (rule === undefined) {
    return undefined;
  }

  return { isCombined: false, rules: [rule] };
}

function parseCombinedGuidanceFile(lines: string[]): ParsedGuidanceFile | undefined {
  if (lines.length === 0) {
    return undefined;
  }
  const firstLine = lines[0];
  if (firstLine === undefined || !firstLine.startsWith('# ')) {
    return undefined;
  }

  const ruleHeadings: { index: number; title: string }[] = [];
  const depth2Prefix = headingPrefix(2);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && line.startsWith(depth2Prefix)) {
      ruleHeadings.push({ index: i, title: line.slice(depth2Prefix.length).trim() });
    }
  }

  // A combined file generated while the catalog was empty carries its title and
  // its explanatory paragraph and no rule sections at all. That is generated
  // output, and reading it as an unknown format would refuse to fill it in once
  // an analyzer is installed - the state `cyv init` leaves behind when the core
  // ships no analyzer. Content nobody generated is caught by the stray-line
  // check instead, which is the question actually being asked here.
  const rules: ParsedRule[] = [];
  for (let h = 0; h < ruleHeadings.length; h++) {
    const heading = ruleHeadings[h];
    if (heading === undefined) {
      continue;
    }
    const start = heading.index + 1;
    const nextHeading = ruleHeadings[h + 1];
    const end = nextHeading !== undefined ? nextHeading.index : lines.length;
    const rule = parseRuleSection(lines, start, end, heading.title, 3, 4);
    if (rule !== undefined) {
      rules.push(rule);
    }
  }

  return { isCombined: true, rules };
}

function parseGuidanceFile(
  content: string,
  fileName: string,
): ParsedGuidanceFile | undefined {
  if (fileName === 'checkyourvibe-rules.md') {
    return parseCombinedGuidanceFile(splitLines(content));
  }

  const isPerRule =
    fileName.startsWith('cyv-') && (fileName.endsWith('.md') || fileName.endsWith('.mdc'));
  if (!isPerRule) {
    return undefined;
  }

  const frontmatter = parseFrontmatter(content);
  if (frontmatter === undefined) {
    return undefined;
  }

  const { frontmatter: fm, bodyLines } = frontmatter;
  const baseId = fileName.replace(/^cyv-/, '').replace(/\.mdc?$/, '');
  const name = fm.name;
  if (name !== undefined && name !== `cyv-${baseId}`) {
    return undefined;
  }

  return parseSingleGuidanceFile(bodyLines, fileName);
}

function stringArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (left === undefined || right === undefined || left !== right) {
      return false;
    }
  }
  return true;
}

function notFixesEqual(a: NotFix[], b: NotFix[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (left === undefined || right === undefined) {
      return false;
    }
    if (
      left.pattern !== right.pattern ||
      left.because !== right.because ||
      left.rule !== right.rule
    ) {
      return false;
    }
  }
  return true;
}

function ruleMatchesParsed(rule: RuleManifest, parsed: ParsedRule): boolean {
  if (rule.id !== parsed.id) {
    return false;
  }
  if (rule.summary !== parsed.summary) {
    return false;
  }
  if (rule.why !== parsed.why) {
    return false;
  }
  if (!stringArraysEqual(rule.allowedFixes, parsed.allowedFixes)) {
    return false;
  }
  if (!notFixesEqual(rule.notFixes, parsed.notFixes)) {
    return false;
  }
  if (
    rule.examples.bad !== parsed.examplesBad ||
    rule.examples.good !== parsed.examplesGood
  ) {
    return false;
  }
  return true;
}

function addValueLines(known: Set<string>, value: string): void {
  for (const line of splitLines(value)) {
    known.add(line.trim());
  }
}

/** Structure every generated guidance file carries: headings, fences, delimiters. */
function isStructuralLine(trimmed: string): boolean {
  return trimmed.startsWith('#') || trimmed.startsWith('```') || trimmed === '---';
}

/**
 * The lines a generated guidance file could legitimately contain, given both
 * the file's own parsed rule text and the content the adapter would write now.
 */
function knownGuidanceLines(parsed: ParsedGuidanceFile, planned: string): Set<string> {
  const known = new Set<string>();
  addValueLines(known, planned);

  for (const rule of parsed.rules) {
    addValueLines(known, rule.summary);
    addValueLines(known, rule.why);
    addValueLines(known, rule.examplesBad);
    addValueLines(known, rule.examplesGood);
    for (const fix of rule.allowedFixes) {
      known.add(`- ${fix}`);
    }
    for (const notFix of rule.notFixes) {
      known.add(`- ${notFix.pattern}`);
      known.add(`because: ${notFix.because}`);
      if (notFix.rule !== undefined) {
        known.add(`rule: ${notFix.rule}`);
      }
    }
  }

  return known;
}

/**
 * Lines in an existing guidance file that no version of the generator produces.
 *
 * A file generated from an older rule differs from the planned content in
 * exactly that rule's text, and that text is recoverable by parsing the file.
 * Every other line is either structure the adapter emits verbatim or text the
 * adapter would still emit today, so it is accounted for. What is left over is
 * something a person added, and that is the signal this command needs: it lets
 * a rule-text update proceed on an untouched file and stop at one that has
 * been written in.
 *
 * The converse does not hold and is not claimed. Someone who rewrote the Why
 * paragraph in place leaves no extra line, and the file reads as generated
 * output for an older rule. Separating those two needs provenance recorded when
 * the file was written, which the adapters do not record.
 */
function strayGuidanceLines(
  before: string,
  planned: string,
  parsed: ParsedGuidanceFile,
): string[] {
  const known = knownGuidanceLines(parsed, planned);
  const strays: string[] = [];

  const beforeParts = parseFrontmatter(before);
  const plannedParts = parseFrontmatter(planned);
  if (beforeParts !== undefined && plannedParts !== undefined) {
    for (const key of Object.keys(beforeParts.frontmatter)) {
      if (!(key in plannedParts.frontmatter)) {
        strays.push(`${key}: (frontmatter key)`);
      }
    }
  }

  for (const line of beforeParts?.bodyLines ?? splitLines(before)) {
    const trimmed = line.trim();
    if (trimmed === '' || isStructuralLine(trimmed) || known.has(trimmed)) {
      continue;
    }
    strays.push(trimmed);
  }

  return strays;
}

function firstStray(strays: string[]): string {
  const sample = strays[0] ?? '';
  return sample.length > 60 ? `${sample.slice(0, 60)}…` : sample;
}

function isRuleGuidanceFile(name: string): boolean {
  return (
    name === 'checkyourvibe-rules.md' ||
    (name.startsWith('cyv-') && (name.endsWith('.md') || name.endsWith('.mdc')))
  );
}

interface PlanEntry {
  path: string;
  description: string;
  /**
   * `held` is a file this run deliberately did not touch because the catalog
   * was incomplete, which --force must not override.
   */
  status: 'create' | 'update' | 'unchanged' | 'stale' | 'error' | 'held';
  reason?: string;
  preview?: string;
  /** Outside the repository root, so it affects every project on this machine. */
  outside: boolean;
}

interface OrphanEntry {
  path: string;
  status: 'delete' | 'stale' | 'held';
  reason?: string;
  outside: boolean;
}

function contentEqual(a: string, b: string): boolean {
  return a.trimEnd() === b.trimEnd();
}

function classifyParsedGuidance(
  parsed: ParsedGuidanceFile,
  before: string,
  plannedContent: string,
  catalog: RuleManifest[],
  force: boolean,
  holdRemovals: boolean,
): { status: 'update' | 'unchanged' | 'stale' | 'held'; reason?: string } {
  const rulesById = new Map(catalog.map((r) => [r.id, r]));
  const currentIds = new Set(catalog.map((r) => r.id));

  // Checked before the rule texts, because a file that has both a hand edit and
  // an out-of-date rule is still a hand-edited file. Deciding on the rule text
  // first would rewrite the file and take the edit with it.
  const strays = strayGuidanceLines(before, plannedContent, parsed);
  if (strays.length > 0 && !force) {
    return {
      status: 'stale',
      reason:
        `Contains ${strays.length} line(s) the generator does not produce, starting with "${firstStray(strays)}". ` +
        'Pass --force to overwrite a hand-edited file.',
    };
  }

  for (const pr of parsed.rules) {
    if (currentIds.has(pr.id)) {
      continue;
    }
    // A combined guidance file holds every rule at once, so rewriting it while
    // the catalog is short of an unresolved analyzer's rules would empty it.
    if (holdRemovals) {
      return {
        status: 'held',
        reason:
          `Rule ${pr.id} is not in the catalog, but an analyzer or agent did not resolve this run, ` +
          'so the rule may still exist. Left in place.',
      };
    }
    return { status: 'update', reason: `Rule ${pr.id} no longer exists in the catalog.` };
  }

  if (parsed.isCombined) {
    const parsedIds = new Set(parsed.rules.map((r) => r.id));

    for (const rule of catalog) {
      if (!parsedIds.has(rule.id)) {
        return { status: 'update', reason: `Rule ${rule.id} is missing from the guidance file.` };
      }
    }
  }

  for (const pr of parsed.rules) {
    const rule = rulesById.get(pr.id);
    if (rule === undefined || !ruleMatchesParsed(rule, pr)) {
      const reason =
        rule === undefined
          ? `Rule ${pr.id} no longer exists.`
          : `Rule ${pr.id} guidance has changed.`;
      return { status: 'update', reason };
    }
  }

  if (contentEqual(before, plannedContent)) {
    return { status: 'unchanged' };
  }

  if (force) {
    return { status: 'update' };
  }

  return {
    status: 'stale',
    reason:
      'Rule texts are unchanged, but the file content differs from the generated guidance. Pass --force to overwrite a hand-edited file.',
  };
}

function classifyPerRuleWrite(
  write: PlannedWrite,
  before: string,
  catalog: RuleManifest[],
  force: boolean,
  holdRemovals: boolean,
): { status: 'update' | 'unchanged' | 'stale' | 'held'; reason?: string } {
  const fileName = basename(write.path);
  const parsed = parseGuidanceFile(before, fileName);
  if (parsed === undefined) {
    if (force) {
      return { status: 'update' };
    }
    return {
      status: 'stale',
      reason:
        'Existing file does not match the expected generated format. Pass --force to overwrite.',
    };
  }

  return classifyParsedGuidance(parsed, before, write.content, catalog, force, holdRemovals);
}

function isManagedBlockStale(
  write: PlannedWrite,
  before: string,
): { stale: boolean; reason?: string } {
  if (write.strategy !== 'managed-block' || write.blockId === undefined) {
    return { stale: false };
  }

  const start = MANAGED_BLOCK_START(write.blockId, write.blockComment);
  const end = MANAGED_BLOCK_END(write.blockId, write.blockComment);
  const hasStart = before.includes(start);
  const hasEnd = before.includes(end);

  if (!hasStart && !hasEnd) {
    return { stale: false };
  }
  if (hasStart && !hasEnd) {
    return { stale: true, reason: 'Managed block start delimiter found without end delimiter.' };
  }
  if (!hasStart && hasEnd) {
    return { stale: true, reason: 'Managed block end delimiter found without start delimiter.' };
  }

  const startIndex = before.indexOf(start);
  const endIndex = before.indexOf(end);
  if (endIndex < startIndex) {
    return { stale: true, reason: 'Managed block end delimiter appears before start delimiter.' };
  }

  const body = before.slice(startIndex + start.length, endIndex).trim();
  if (body === write.content.trim()) {
    return { stale: false };
  }

  return { stale: true, reason: 'Managed block content differs from the planned body.' };
}

async function classifyRegularWrite(
  write: PlannedWrite,
  force: boolean,
): Promise<{ status: PlanEntry['status']; reason?: string; preview?: string }> {
  const before = await readTarget(write.path);
  try {
    const diffs = await planDiff([write]);
    const diff = diffs[0];
    if (diff === undefined) {
      return { status: 'error', reason: 'Could not compute diff for this file.' };
    }
    if (!diff.changed) {
      return { status: 'unchanged' };
    }
    if (write.strategy === 'managed-block' && before !== null) {
      const { stale, reason } = isManagedBlockStale(write, before);
      if (stale) {
        if (force) {
          return { status: 'update', preview: diff.preview };
        }
        return { status: 'stale', reason: reason ?? 'Managed block has been edited by hand.' };
      }
    }
    return { status: 'update', preview: diff.preview };
  } catch (err) {
    if (force) {
      return { status: 'update' };
    }
    return { status: 'stale', reason: messageFor(err) };
  }
}

async function findOrphanRuleFiles(
  plannedWrites: PlannedWrite[],
  probeDirs: ReadonlySet<string>,
): Promise<Array<{ path: string; content: string }>> {
  const plannedPaths = new Set(plannedWrites.map((w) => w.path));
  const guidanceDirs = new Set<string>(probeDirs);
  for (const write of plannedWrites) {
    if (isRuleGuidanceFile(basename(write.path))) {
      guidanceDirs.add(dirname(write.path));
    }
  }

  const orphans: Array<{ path: string; content: string }> = [];
  for (const dir of guidanceDirs) {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isErrnoException(err, 'ENOENT')) {
        continue;
      }
      throw err;
    }

    for (const entry of entries) {
      const name = entry.name;
      if (!entry.isFile() || !isRuleGuidanceFile(name)) {
        continue;
      }
      const filePath = join(dir, name);
      if (plannedPaths.has(filePath)) {
        continue;
      }
      const content = await readTarget(filePath);
      if (content !== null) {
        orphans.push({ path: filePath, content });
      }
    }
  }

  return orphans;
}

function symbolFor(status: PlanEntry['status'] | OrphanEntry['status']): string {
  switch (status) {
    case 'create':
      return '+';
    case 'update':
      return '~';
    case 'delete':
      return '-';
    case 'stale':
      return '!';
    case 'held':
      return '!';
    case 'error':
      return 'x';
    case 'unchanged':
      return '=';
    default:
      return '?';
  }
}

function printPlan(
  plan: PlanEntry[],
  orphans: OrphanEntry[],
  staleAnalyzers: string[],
  allowOutsideRepo: boolean,
): void {
  console.log('cyv upgrade plan:');

  if (staleAnalyzers.length > 0) {
    console.log('\nStale checkyourvibe.json entries:');
    for (const line of staleAnalyzers) {
      console.log(`  ${line}`);
    }
  }

  if (plan.length > 0) {
    console.log('\nAgent files:');
    for (const entry of plan) {
      console.log(`  [${symbolFor(entry.status)}] ${entry.path}${entry.outside ? ' (outside this repository)' : ''}`);
      console.log(`      ${entry.description}`);
      if (entry.reason !== undefined) {
        console.log(`      reason: ${entry.reason}`);
      }
      if (entry.preview !== undefined && entry.preview.length > 0) {
        for (const line of entry.preview.split('\n')) {
          console.log(`      ${line}`);
        }
      }
    }
  }

  if (orphans.length > 0) {
    console.log('\nOrphaned per-rule guidance:');
    for (const entry of orphans) {
      console.log(`  [${symbolFor(entry.status)}] ${entry.path}${entry.outside ? ' (outside this repository)' : ''}`);
      if (entry.reason !== undefined) {
        console.log(`      reason: ${entry.reason}`);
      }
    }
  }

  const counts = countPlan(plan, orphans, allowOutsideRepo);
  if (counts.outside > 0 && !allowOutsideRepo) {
    console.log(
      `\n${counts.outside} file(s) live outside this repository and affect every project on this machine. ` +
        '`cyv init` does not write them without --allow-outside-repo, and neither does this command.',
    );
  }

  const summary: string[] = [];
  if (counts.updated > 0) summary.push(`${counts.updated} would update`);
  if (counts.removed > 0) summary.push(`${counts.removed} would remove`);
  if (counts.stale > 0) summary.push(`${counts.stale} stale`);
  if (counts.outside > 0 && !allowOutsideRepo) summary.push(`${counts.outside} outside this repository`);
  if (counts.unchanged > 0) summary.push(`${counts.unchanged} unchanged`);

  if (summary.length === 0) {
    console.log('\nNo changes planned.');
  } else {
    console.log(`\n${summary.join(', ')}.`);
  }
}

interface PlanCounts {
  /** Would be created or rewritten, and is applicable under the current flags. */
  updated: number;
  removed: number;
  stale: number;
  unchanged: number;
  /** Actionable, but outside the repository root. */
  outside: number;
}

function countPlan(
  plan: PlanEntry[],
  orphans: OrphanEntry[],
  allowOutsideRepo: boolean,
): PlanCounts {
  const counts: PlanCounts = { updated: 0, removed: 0, stale: 0, unchanged: 0, outside: 0 };

  for (const entry of plan) {
    if (entry.status === 'unchanged') {
      counts.unchanged += 1;
    } else if (
      entry.status === 'stale' ||
      entry.status === 'error' ||
      entry.status === 'held'
    ) {
      counts.stale += 1;
    } else if (entry.outside && !allowOutsideRepo) {
      counts.outside += 1;
    } else {
      counts.updated += 1;
    }
  }

  for (const orphan of orphans) {
    if (orphan.status === 'stale' || orphan.status === 'held') {
      counts.stale += 1;
    } else if (orphan.outside && !allowOutsideRepo) {
      counts.outside += 1;
    } else {
      counts.removed += 1;
    }
  }

  return counts;
}

async function applyDirectWrite(write: PlannedWrite): Promise<void> {
  await mkdir(dirname(write.path), { recursive: true });
  const temp = join(dirname(write.path), `.${randomUUID()}.tmp`);
  await writeFile(temp, write.content, 'utf-8');
  await rename(temp, write.path);
}

/**
 * A rule that exists only to ask an adapter where it writes per-rule guidance.
 *
 * Guidance directories are otherwise discoverable only from the planned writes
 * of rules that still exist, so a catalog that has emptied leaves nowhere to
 * look and the guidance for every removed rule stays on disk. Planning one
 * synthetic rule names the directory whatever the catalog holds. `plan` is
 * required not to touch the filesystem, and these writes are read for their
 * paths and then discarded.
 */
const GUIDANCE_LOCATION_PROBE: RuleManifest = {
  id: 'checkyourvibe-guidance-location-probe',
  category: 'internal',
  scope: 'file',
  severity: 'error',
  summary: 'Ask this agent where it writes per-rule guidance.',
  why: 'Planned and discarded so upgrade can find generated guidance for rules that no longer exist.',
  allowedFixes: [],
  notFixes: [],
  examples: { bad: '', good: '' },
};

async function classifyWrite(
  write: PlannedWrite,
  root: string,
  catalog: RuleManifest[],
  force: boolean,
  holdRemovals: boolean,
): Promise<PlanEntry> {
  const outside = !isInsideRepo(write.path, root);

  if (isRuleGuidanceFile(basename(write.path))) {
    const before = await readTarget(write.path);
    if (before === null) {
      return { path: write.path, description: write.description, status: 'create', outside };
    }
    const result = classifyPerRuleWrite(write, before, catalog, force, holdRemovals);
    return {
      path: write.path,
      description: write.description,
      status: result.status,
      outside,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    };
  }

  const result = await classifyRegularWrite(write, force);
  return {
    path: write.path,
    description: write.description,
    status: result.status,
    outside,
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    ...(result.preview !== undefined ? { preview: result.preview } : {}),
  };
}

interface AppliedFile {
  status: 'created' | 'updated' | 'removed';
  path: string;
}

interface FailedFile {
  path: string;
  message: string;
}

function printOutcome(
  applied: AppliedFile[],
  plan: PlanEntry[],
  orphans: OrphanEntry[],
  failures: FailedFile[],
  skippedOutside: number,
): void {
  if (applied.length > 0) {
    console.log('\nChanged:');
    for (const entry of applied) {
      console.log(`  [${entry.status}] ${entry.path}`);
    }
  }

  const notUpdated: Array<{ path: string; reason: string }> = [];
  for (const entry of plan) {
    if (entry.status === 'stale' || entry.status === 'error' || entry.status === 'held') {
      notUpdated.push({ path: entry.path, reason: entry.reason ?? 'left in place' });
    }
  }
  for (const orphan of orphans) {
    if (orphan.status === 'stale' || orphan.status === 'held') {
      notUpdated.push({ path: orphan.path, reason: orphan.reason ?? 'left in place' });
    }
  }

  if (notUpdated.length > 0) {
    console.log('\nNot updated:');
    for (const entry of notUpdated) {
      console.log(`  [!] ${entry.path}`);
      console.log(`      ${entry.reason}`);
    }
  }

  if (skippedOutside > 0) {
    console.log(
      `\nSkipped ${skippedOutside} file(s) outside this repository. Re-run with --allow-outside-repo to apply them.`,
    );
  }

  if (failures.length > 0) {
    console.log('\nCould not be written:');
    for (const failure of failures) {
      console.log(`  [x] ${failure.path}`);
      console.log(`      ${failure.message}`);
    }
  }
}

export const command: Command = {
  async run(ctx: CommandContext): Promise<number> {
    try {
      const { dryRun, force, allowOutsideRepo } = parseArgs(ctx.argv);
      const root = await repoRoot(ctx.cwd);
      const homeDir = resolveHomeDir(ctx.env);

      const config = await loadConfig(root);
      const analyzerResolutions = await resolveAnalyzers(config.analyzers, root);
      const manifests: AnalyzerManifest[] = [];
      const staleAnalyzers: string[] = [];

      for (const resolution of analyzerResolutions) {
        if (resolution.error !== undefined) {
          staleAnalyzers.push(
            `analyzer "${resolution.entry.id}" package "${resolution.entry.package}": ${resolution.error}`,
          );
        } else if (resolution.manifest !== undefined) {
          manifests.push(resolution.manifest);
        }
      }

      const configuredAgents = config.agents ?? [];
      if (configuredAgents.length === 0) {
        console.log(
          'No agents are configured in checkyourvibe.json. Add agents to checkyourvibe.json or run `cyv init`.',
        );
        return 1;
      }

      let catalog: RuleManifest[] = [];
      try {
        catalog = allRules(manifests);
      } catch (err) {
        console.error(messageFor(err));
        return 2;
      }

      if (catalog.length === 0) {
        console.log(
          'The rebuilt catalog has no rules. Analyzers are separate modules: install one and name it in ' +
            'checkyourvibe.json, then run this again. Generated glue is still re-planned below.',
        );
      }

      const cyvCommand = await resolveCyvCommand();
      await assertCyvCommandResolvable(cyvCommand);

      const allPlugins = agentPluginsOverride.plugins ?? (await loadAllPlugins());
      const configuredPlugins: AgentPlugin[] = [];
      for (const plugin of allPlugins) {
        if (configuredAgents.includes(plugin.id)) {
          configuredPlugins.push(plugin);
        }
      }

      if (configuredPlugins.length === 0) {
        console.log(`None of the configured agents are installed: ${configuredAgents.join(', ')}.`);
        return 1;
      }

      const orchestration = await resolveBriefInput(config, ctx.env, root);
      const planContext = {
        repoRoot: root,
        homeDir,
        cyvCommand,
        rules: catalog,
        ...(orchestration === undefined ? {} : { orchestration }),
      };
      /**
       * Keyed by path *and* managed block, because two agents legitimately
       * write different blocks into one file - Codex and Antigravity both own a
       * block in `AGENTS.md`. Keying on the path alone dropped one of them from
       * the plan, so its block was never refreshed.
       */
      const plannedByTarget = new Map<string, PlannedWrite>();
      const probeGuidanceDirs = new Set<string>();
      const agentPlanErrors: string[] = [];

      for (const plugin of configuredPlugins) {
        try {
          for (const write of await plugin.plan(planContext)) {
            plannedByTarget.set(`${write.path}|${write.strategy}|${write.blockId ?? ''}`, write);
          }
          const probeWrites = await plugin.plan({ ...planContext, rules: [GUIDANCE_LOCATION_PROBE] });
          for (const probe of probeWrites) {
            if (isRuleGuidanceFile(basename(probe.path))) {
              probeGuidanceDirs.add(dirname(probe.path));
            }
          }
        } catch (err) {
          agentPlanErrors.push(`${plugin.id}: ${messageFor(err)}`);
        }
      }

      /**
       * A rule missing from the catalog is only evidence that its guidance is
       * obsolete when the catalog is complete. An analyzer that did not resolve,
       * or an agent whose plan threw, leaves rules out for a reason that has
       * nothing to do with whether they still exist — so while either is true
       * nothing is deleted, and no guidance file is rewritten without the rules
       * it currently carries.
       */
      const holdDeletions = staleAnalyzers.length > 0 || agentPlanErrors.length > 0;

      const plannedWrites = Array.from(plannedByTarget.values());
      const classified: Array<{ write: PlannedWrite; entry: PlanEntry }> = [];
      for (const write of plannedWrites) {
        classified.push({
          write,
          entry: await classifyWrite(write, root, catalog, force, holdDeletions),
        });
      }
      const plan = classified.map((item) => item.entry);

      const rawOrphans = await findOrphanRuleFiles(plannedWrites, probeGuidanceDirs);
      const orphans: OrphanEntry[] = [];
      const currentIds = new Set(catalog.map((r) => r.id));

      for (const orphan of rawOrphans) {
        const parsed = parseGuidanceFile(orphan.content, basename(orphan.path));
        const outside = !isInsideRepo(orphan.path, root);
        const generatedForRemovedRules =
          parsed !== undefined &&
          parsed.rules.length > 0 &&
          parsed.rules.every((r) => !currentIds.has(r.id));

        if (!generatedForRemovedRules) {
          orphans.push({
            path: orphan.path,
            status: 'stale',
            reason: 'Unknown provenance; leaving in place.',
            outside,
          });
        } else if (holdDeletions) {
          orphans.push({
            path: orphan.path,
            status: 'held',
            reason:
              'Generated guidance for a rule the catalog does not have, but an analyzer or agent did not ' +
              'resolve this run, so the rule may still exist. Left in place.',
            outside,
          });
        } else {
          orphans.push({ path: orphan.path, status: 'delete', outside });
        }
      }

      printPlan(plan, orphans, staleAnalyzers.concat(agentPlanErrors), allowOutsideRepo);

      const counts = countPlan(plan, orphans, allowOutsideRepo);
      const needsAttention =
        counts.stale > 0 ||
        counts.outside > 0 ||
        staleAnalyzers.length > 0 ||
        agentPlanErrors.length > 0;

      if (dryRun) {
        return needsAttention ? 1 : 0;
      }

      const applied: AppliedFile[] = [];
      const failures: FailedFile[] = [];
      let skippedOutside = 0;

      for (const { write, entry } of classified) {
        if (
          entry.status === 'unchanged' ||
          entry.status === 'stale' ||
          entry.status === 'error' ||
          entry.status === 'held'
        ) {
          continue;
        }
        if (entry.outside && !allowOutsideRepo) {
          skippedOutside += 1;
          continue;
        }

        try {
          if (isRuleGuidanceFile(basename(write.path))) {
            // Per-rule guidance is planned `create-if-absent` so `init` never
            // disturbs an existing file. Refreshing one is this command's job,
            // and it happens only after the classification above has decided
            // the file is generated output.
            await applyDirectWrite(write);
          } else {
            await mkdir(dirname(write.path), { recursive: true });
            await applyPlannedWrite(write);
          }
          applied.push({ status: entry.status === 'create' ? 'created' : 'updated', path: write.path });
        } catch (err) {
          failures.push({ path: write.path, message: messageFor(err) });
        }
      }

      for (const orphan of orphans) {
        if (orphan.status !== 'delete') {
          continue;
        }
        if (orphan.outside && !allowOutsideRepo) {
          skippedOutside += 1;
          continue;
        }
        try {
          await rm(orphan.path);
          applied.push({ status: 'removed', path: orphan.path });
        } catch (err) {
          failures.push({ path: orphan.path, message: messageFor(err) });
        }
      }

      printOutcome(applied, plan, orphans, failures, skippedOutside);

      if (failures.length > 0) {
        return 2;
      }

      // `--force` is named only where it would change the outcome. A file held
      // back because an analyzer did not resolve is not one --force should
      // rewrite, and offering the flag there would invite emptying it.
      const forceable = plan.filter(
        (entry) => entry.status === 'stale' || entry.status === 'error',
      ).length;
      const held =
        plan.filter((entry) => entry.status === 'held').length +
        orphans.filter((orphan) => orphan.status === 'held').length;

      if (forceable > 0) {
        console.log(
          `\n${forceable} file(s) were left alone; re-run with --force to overwrite hand-edited files.`,
        );
      }
      if (held > 0) {
        console.log(`\n${held} guidance file(s) were left in place, for the reasons above.`);
      }

      if (needsAttention || skippedOutside > 0) {
        return 1;
      }

      if (applied.length === 0) {
        console.log('\nEverything is up to date.');
      } else {
        console.log(`\n${applied.length} file(s) updated.`);
      }
      return 0;
    } catch (err) {
      console.error(messageFor(err));
      return 2;
    }
  },
};
