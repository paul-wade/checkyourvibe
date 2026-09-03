import type {
  DegradedResolution,
  AnalyzeFn,
  AnalyzeRequest,
  AnalyzeResponse,
  Diagnostic,
  RuleManifest,
  Violation,
} from '@checkyourvibe/core';
import { PROTOCOL_VERSION } from '@checkyourvibe/core';
import type { SourceFile } from 'ts-morph';
import { groupFilesByProject, loadFiles } from './project.js';
import { allTsRules } from './rules/index.js';

/** Static rule metadata for every rule this analyzer ships, in pack order. */
export const manifestRules: RuleManifest[] = allTsRules.map((rule) => rule.manifest);

const rulesById = new Map(allTsRules.map((rule) => [rule.manifest.id, rule]));

/**
 * The reference `exec.type: 'node'` implementation of the analyzer protocol.
 *
 * One rule throwing must not take the rest of the run down with it: the core
 * still needs the violations every other rule found, on every other file. A
 * thrown error becomes a diagnostic instead — visible in the response, never
 * a silently dropped result.
 */
const analyze: AnalyzeFn = async (request: AnalyzeRequest): Promise<AnalyzeResponse> => {
  const violations: Violation[] = [];
  const diagnostics: Diagnostic[] = [];
  const skipped: AnalyzeResponse['skipped'] = [];
  const loaded: { sourceFile: SourceFile; degraded: string | undefined }[] = [];
  const degraded: DegradedResolution[] = [];

  // One project per governing tsconfig, resolved from each file's own location.
  // Resolving once from the repository root gives every package in a monorepo
  // the root config — usually solution-style — and silently destroys type
  // resolution for all of them.
  for (const group of groupFilesByProject(request.files)) {
    const result = loadFiles(group.project, group.files);
    skipped.push(...result.skipped);
    for (const sourceFile of result.loaded) {
      loaded.push({ sourceFile, degraded: group.degraded });
    }
    if (group.degraded !== undefined) {
      diagnostics.push({
        level: 'warn',
        message: `${group.files.length} file(s): ${group.degraded}`,
      });
      // The same fact in a form the core can act on. The diagnostic above is
      // prose for a human; this is the contract. Without it the core's
      // withholding logic has nothing to withhold against — which is exactly
      // what happened when the two halves landed separately: `degraded` was
      // consumed by `run/check.ts` and emitted by nobody, so a run over 170
      // unresolvable files still reported every inferred-type finding it made.
      degraded.push({ files: [...group.files], reason: group.degraded });
    }
  }

  for (const { sourceFile } of loaded) {
    for (const [ruleId, settings] of Object.entries(request.rules)) {
      const rule = rulesById.get(ruleId);
      if (rule === undefined) {
        continue;
      }

      // `file` mode is used by hooks and explicit-path invocations that only
      // ever see one file at a time, so project-scope rules (which need the
      // whole tree to mean anything) are excluded there.
      if (request.mode === 'file' && rule.manifest.scope !== 'file') {
        continue;
      }

      const { severity, ...options } = settings;

      try {
        const results = rule.check(sourceFile, options);
        // The core is the source of truth for severity: configuration may
        // downgrade or upgrade a rule, and that choice must win over whatever
        // the rule itself hard-coded.
        for (const violation of results) {
          violations.push({ ...violation, severity });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        diagnostics.push({
          level: 'error',
          message: `rule ${ruleId} failed on ${sourceFile.getFilePath()}: ${message}`,
        });
      }
    }
  }

  // `degraded` is omitted rather than sent empty: the field is optional, and an
  // empty array would read as "the analyzer considered this and found none",
  // which is true here but would not be for an analyzer that never sets it.
  return {
    protocol: PROTOCOL_VERSION,
    violations,
    skipped,
    diagnostics,
    ...(degraded.length > 0 ? { degraded } : {}),
  };
};

export default analyze;
