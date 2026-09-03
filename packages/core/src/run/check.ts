/**
 * The one check pipeline.
 *
 * `cyv check`, `cyv hook <agent-id>`, and the MCP `check_files` /
 * `check_working_tree` tools all need the same sequence — resolve the repo
 * root, load and validate configuration, load analyzer manifests, collect and
 * validate rules, select files, route them to their analyzer, run each
 * analyzer, and attach guidance to every violation from its rule manifest —
 * so a violation reads identically whether it surfaced in a terminal, an
 * editor hook, or over MCP. This module is that sequence, written once.
 *
 * Each of the three call sites keeps only what is specific to it (flag
 * parsing and exit codes for the CLI, stdin/plugin handling and a
 * never-block policy for the hook, MCP's error-result wrapping) and delegates
 * everything else here.
 */
import path from 'node:path';
import { repoRoot, selectFiles } from './discover.js';
import type { RunMode } from './modes.js';
import { routeFiles } from './route.js';
import { runAnalyzer, AnalyzerError } from './execute.js';
import { loadConfig } from '../config/load.js';
import type { CheckYourVibeConfig } from '../config/types.js';
import { resolveRules, resolveRulesForFile } from '../config/resolve.js';
import { loadAnalyzers, allRules } from '../registry/load.js';
import { validateRules } from '../guidance/validate.js';
import type { RunReport } from '../report/types.js';
import {
  PROTOCOL_VERSION,
  type AnalyzeRequest,
  type AnalyzerManifest,
  type Diagnostic,
  type RuleGuidance,
  type RuleManifest,
  type RuleSettings,
  type SkippedFile,
  type Violation,
} from '../protocol/index.js';

export interface RunCheckOptions {
  cwd: string;
  mode: RunMode;
  paths?: string[];
  /** Overrides `config.strict` when set. Omit to use the configured value. */
  strict?: boolean;
}

export interface RunCheckResult {
  report: RunReport;
  repoRoot: string;
}

/**
 * `file`-mode requests (explicit paths, or `--staged` for a pre-commit hook)
 * carry only file-scope rules: they run against a partial file set, and a
 * project-scope rule needs the whole tree to be meaningful. Every other mode
 * gets the full enabled set.
 */
function analyzeModeFor(mode: RunMode): 'file' | 'project' {
  return mode === 'files' || mode === 'staged' ? 'file' : 'project';
}

function rulesForAnalyzer(
  manifest: AnalyzerManifest,
  resolved: Map<string, RuleSettings>,
  requestMode: 'file' | 'project',
): Record<string, RuleSettings> {
  const rules: Record<string, RuleSettings> = {};
  for (const rule of manifest.rules) {
    if (requestMode === 'file' && rule.scope === 'project') {
      continue;
    }
    const settings = resolved.get(rule.id);
    if (settings !== undefined) {
      rules[rule.id] = settings;
    }
  }
  return rules;
}

function optionsFor(config: CheckYourVibeConfig, analyzerId: string): Record<string, unknown> | undefined {
  return config.analyzers.find((entry) => entry.id === analyzerId)?.options;
}

function collectPackNames(catalog: RuleManifest[]): Set<string> {
  const packNames = new Set<string>();
  for (const rule of catalog) {
    if (rule.pack !== undefined) {
      packNames.add(rule.pack);
    }
  }
  return packNames;
}

function findUnknownPacks(config: CheckYourVibeConfig, catalog: RuleManifest[]): string[] {
  const packNames = collectPackNames(catalog);
  const unknown: string[] = [];
  for (const pack of config.packs) {
    if (!packNames.has(pack)) {
      unknown.push(pack);
    }
  }
  return unknown;
}

function findZeroContributionAnalyzers(
  manifests: AnalyzerManifest[],
  enabledIds: Set<string>,
): string[] {
  const zero: string[] = [];
  for (const manifest of manifests) {
    let contributes = false;
    for (const rule of manifest.rules) {
      if (enabledIds.has(rule.id)) {
        contributes = true;
        break;
      }
    }
    if (!contributes) {
      zero.push(manifest.id);
    }
  }
  return zero;
}

/**
 * Attach a violation's remediation guidance from its rule manifest.
 *
 * This is the one place in the codebase that does this. Analyzers never
 * populate `guidance` — the core does, from the same rule manifest every
 * time, so the explanation is identical whether the violation surfaced in
 * the terminal, in a hook, or over MCP.
 */
function guidanceFor(rule: RuleManifest): RuleGuidance {
  return {
    summary: rule.summary,
    why: rule.why,
    allowedFixes: rule.allowedFixes,
    notFixes: rule.notFixes,
    examples: rule.examples,
    ...(rule.evidence !== undefined ? { evidence: rule.evidence } : {}),
  };
}

/**
 * Same repo-relative convention `run/route.ts` uses internally: forward
 * slashes, and `undefined` for anything outside `repoRoot`. Every file this
 * function is called with already survived `routeFiles`, so it always has a
 * valid repo-relative path in practice; the `undefined` case exists only as
 * an honest fallback rather than a `!` assertion.
 */
function toRepoRelative(file: string, root: string): string | undefined {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  if (rel === '' || rel.startsWith('.')) {
    return undefined;
  }
  return rel;
}

interface RuleGroup {
  rules: Record<string, RuleSettings>;
  files: string[];
}

/**
 * Group an analyzer's files by their effective rule set.
 *
 * `resolveRulesForFile` can resolve a different rule set per file (per-path
 * `overrides`), but an `AnalyzeRequest` carries exactly one rule set for
 * every file in it. Grouping files whose resolved settings serialize
 * identically keeps the common case — no override touches this analyzer's
 * files — down to a single request, and only splits into more requests where
 * an override actually changes something.
 */
function groupFilesByRules(
  files: string[],
  manifest: AnalyzerManifest,
  config: CheckYourVibeConfig,
  catalog: RuleManifest[],
  root: string,
  requestMode: 'file' | 'project',
): RuleGroup[] {
  const groups = new Map<string, RuleGroup>();

  for (const file of files) {
    const relPath = toRepoRelative(file, root);
    const resolved =
      relPath !== undefined
        ? resolveRulesForFile(config, catalog, relPath)
        : resolveRules(config, catalog);
    const rules = rulesForAnalyzer(manifest, resolved, requestMode);

    const key = JSON.stringify(rules);
    const existing = groups.get(key);
    if (existing !== undefined) {
      existing.files.push(file);
    } else {
      groups.set(key, { rules, files: [file] });
    }
  }

  return [...groups.values()];
}

/**
 * Run the configured analyzers against `options.mode` (and `options.paths`,
 * for `files` mode), honoring per-path rule overrides, and return a
 * ready-to-render report with guidance attached to every violation.
 */
export async function runCheck(options: RunCheckOptions): Promise<RunCheckResult> {
  const { cwd, mode, strict } = options;

  const root = await repoRoot(cwd);
  const config = await loadConfig(root);

  const manifests = await loadAnalyzers(config.analyzers, root);
  const catalog = allRules(manifests);
  validateRules(catalog);

  const ruleById = new Map(catalog.map((rule) => [rule.id, rule]));

  const selection = await selectFiles({
    repoRoot: root,
    mode,
    ...(mode === 'files' ? { paths: options.paths ?? [] } : {}),
  });

  const requestMode = analyzeModeFor(selection.mode);
  const { routed, supplemental } = routeFiles(selection.files, manifests, root, config.exclude);

  const violations: Violation[] = [];
  const skipped: SkippedFile[] = [];
  const diagnostics: Diagnostic[] = [];
  let filesChecked = 0;
  let reportStrict = strict !== undefined ? strict : config.strict;
  let withheldFindings = 0;
  const withheldFiles = new Set<string>();
  const withheldReasons = new Set<string>();

  if (selection.reason !== undefined) {
    diagnostics.push({ level: 'info', message: selection.reason });
  }

  for (const manifest of manifests) {
    // A supplemental analyzer reads files another analyzer owns, so its file
    // list comes from the supplemental map rather than from `routed`. Both are
    // dispatched by the same loop: past this point a supplemental analyzer is
    // an analyzer like any other, speaking the same request and response.
    const files =
      manifest.supplements === true ? supplemental.get(manifest.id) : routed.get(manifest.id);
    if (files === undefined || files.length === 0) {
      continue;
    }

    const analyzerOptions = optionsFor(config, manifest.id);
    const groups = groupFilesByRules(files, manifest, config, catalog, root, requestMode);

    let failedAt = -1;

    try {
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        const group = groups[groupIndex];
        if (group === undefined) {
          continue;
        }

        const request: AnalyzeRequest = {
          protocol: PROTOCOL_VERSION,
          repoRoot: root,
          mode: requestMode,
          files: group.files,
          rules: group.rules,
          ...(analyzerOptions !== undefined ? { options: analyzerOptions } : {}),
        };

        failedAt = groupIndex;
        const response = await runAnalyzer(manifest, request, root);

        // Only the owning analyzer's pass counts toward the file total. A
        // supplemental analyzer reads files that were already counted, so
        // adding its pass would report more files checked than the run
        // selected — "3 files checked" becoming 6 for the same three files.
        if (manifest.supplements !== true) {
          filesChecked += group.files.length;
        }

        const degradedReasonByFile = new Map<string, string>();
        if (response.degraded !== undefined) {
          for (const entry of response.degraded) {
            for (const file of entry.files) {
              const resolved = path.resolve(root, file);
              degradedReasonByFile.set(resolved, entry.reason);
            }
          }
        }

        for (const violation of response.violations) {
          const rule = ruleById.get(violation.ruleId);
          const resolvedFile = path.resolve(root, violation.file);
          const degradedReason = degradedReasonByFile.get(resolvedFile);
          if (degradedReason !== undefined && rule?.evidence !== 'syntax') {
            withheldFindings += 1;
            withheldFiles.add(resolvedFile);
            withheldReasons.add(degradedReason);
            continue;
          }
          violations.push(rule !== undefined ? { ...violation, guidance: guidanceFor(rule) } : violation);
        }
        skipped.push(...response.skipped);
        diagnostics.push(...response.diagnostics);
      }
    } catch (err) {
      const reason = err instanceof AnalyzerError ? err.message : String(err);
      diagnostics.push({ level: 'error', message: reason });

      const startIndex = failedAt >= 0 ? failedAt : 0;
      for (let remainingIndex = startIndex; remainingIndex < groups.length; remainingIndex++) {
        const group = groups[remainingIndex];
        if (group === undefined) {
          continue;
        }
        for (const file of group.files) {
          skipped.push({ file, reason });
        }
      }

      reportStrict = true;
    }
  }

  const baseResolved = resolveRules(config, catalog);
  const projectRulesSkipped =
    requestMode === 'file'
      ? [...baseResolved.keys()].filter((id) => ruleById.get(id)?.scope === 'project')
      : [];

  const unknownPacks = findUnknownPacks(config, catalog);
  const zeroContributionAnalyzers = findZeroContributionAnalyzers(
    manifests,
    new Set(baseResolved.keys()),
  );

  const ruleCategories: Record<string, string> = {};
  for (const rule of catalog) {
    ruleCategories[rule.id] = rule.category;
  }

  // Which analyzer owns each rule. With one analyzer this was obvious; with two
  // it is not, and a user meeting an unfamiliar rule id has no way to tell which
  // toolchain to go and look at. Inferring it from a file extension works right
  // up until two analyzers claim the same extension, so it is recorded here
  // where the answer is actually known.
  const ruleAnalyzers: Record<string, string> = {};
  for (const manifest of manifests) {
    for (const rule of manifest.rules) {
      ruleAnalyzers[rule.id] = manifest.id;
    }
  }

  const report: RunReport = {
    violations,
    skipped,
    diagnostics,
    filesChecked,
    mode: selection.mode,
    projectRulesSkipped,
    strict: reportStrict,
    ruleCategories,
    ruleAnalyzers,
    rulesEnabled: baseResolved.size,
    rulesAvailable: catalog.length,
    unknownPacks,
    zeroContributionAnalyzers,
    ...(withheldFindings > 0
      ? {
          withheldFindings,
          withheldFiles: withheldFiles.size,
          withheldReasons: [...withheldReasons],
        }
      : {}),
  };

  return { report, repoRoot: root };
}
