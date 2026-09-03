/**
 * The analysis pipeline shared by `check_files` and `check_working_tree`.
 *
 * A thin adapter over `run/check.ts`'s `runCheck` — the one check pipeline
 * every surface (`cyv check`, `cyv hook`, and this) is built from — so a
 * violation surfaced over MCP carries identical guidance to one surfaced in
 * the terminal or a hook. Nothing analytical lives here; this module only
 * narrows `RunCheckResult` down to the shape `mcp/tools.ts` serializes.
 */
import { runCheck } from '../run/check.js';
import type { RunMode } from '../run/modes.js';
import type { Diagnostic, SkippedFile, Violation } from '../protocol/index.js';

export interface CheckResult {
  violations: Violation[];
  skipped: SkippedFile[];
  diagnostics: Diagnostic[];
  filesChecked: number;
  mode: string;
  projectRulesSkipped: string[];
}

/**
 * Run the configured analyzers against `mode` (and `paths`, for `files` mode)
 * and return violations with guidance attached, mirroring `cyv check`'s
 * selection and rule-scoping rules exactly.
 */
export async function runCheckPipeline(cwd: string, mode: RunMode, paths?: string[]): Promise<CheckResult> {
  const { report } = await runCheck({
    cwd,
    mode,
    ...(paths !== undefined ? { paths } : {}),
  });

  return {
    violations: report.violations,
    skipped: report.skipped,
    diagnostics: report.diagnostics,
    filesChecked: report.filesChecked,
    mode: report.mode,
    projectRulesSkipped: report.projectRulesSkipped,
  };
}
