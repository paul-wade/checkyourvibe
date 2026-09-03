import type { RunReport } from './types.js';

/**
 * Modes in which matching zero files means the run did not do what was asked.
 *
 * Named as an allowlist rather than its inverse, deliberately. `staged`,
 * `working` and `branch` legitimately match nothing — a commit touching only
 * images stages nothing checkable, and failing that would make the pre-commit
 * hook unusable within a day. Listing the alarming modes instead of the normal
 * ones means a mode added later has to opt in, so the safe behaviour is the one
 * you get by forgetting.
 *
 * `all` and `files` are alarming because the user was explicit. Asking to check
 * everything, or naming files by hand, and getting nothing back means a bad
 * glob, an exclude that swallowed the tree, or — found in a real repository —
 * every source file living inside a git submodule, which `git ls-files` reports
 * as a single gitlink and never descends into.
 */
const ZERO_FILES_IS_A_FAILURE: ReadonlySet<string> = new Set(['all', 'files']);

export function exitCodeFor(report: RunReport): 0 | 1 | 2 {
  if (report.unknownPacks !== undefined && report.unknownPacks.length > 0) {
    return 2;
  }
  // The report prints "No files were matched by this run; this is not a pass."
  // and previously still exited 0, which is the value CI reads. The prose and
  // the exit code have to agree.
  if (report.filesChecked === 0 && ZERO_FILES_IS_A_FAILURE.has(report.mode)) {
    return 2;
  }
  if (report.rulesEnabled === 0) {
    return 2;
  }
  if (report.violations.some((v) => v.severity === 'error')) {
    return 1;
  }
  // A run that could not resolve types for some files has not finished its work.
  // Withholding the fabricated semantic findings is the honest choice, but
  // returning 0 would make the run look like a clean pass. Exit 1 instead:
  // the run is incomplete and needs a corrected type-resolution configuration.
  if (report.withheldFindings !== undefined && report.withheldFindings > 0) {
    return 1;
  }
  if (report.strict && report.skipped.length > 0) {
    return 1;
  }
  return 0;
}
