/**
 * Persisted shape of `checkyourvibe.baseline.json`, and the in-memory form
 * `readBaseline` returns.
 *
 * See `identity.ts` for why an entry's identity is `(path, ruleId,
 * fingerprint, occurrence)` rather than `(path, line)`.
 */

/** Format version of the baseline file. Bump when the on-disk shape changes. */
export const BASELINE_VERSION = 1;

/**
 * One recorded violation.
 *
 * `line` is carried only so a human reading the file (or `cyv baseline
 * --status`) has a rough locator, and so a freshly-taken baseline's diff shows
 * roughly where an entry lives. It is NOT part of identity: an edit to an
 * unrelated line elsewhere in the file must not turn this entry into a
 * mismatch. `path`, `ruleId`, `fingerprint`, and `occurrence` together are the
 * only fields two entries are compared on.
 */
export interface BaselineEntry {
  /** Repo-relative path, forward slashes. */
  path: string;
  ruleId: string;
  /** Content fingerprint of the normalized offending snippet. See identity.ts. */
  fingerprint: string;
  /**
   * Disambiguates multiple violations that share the same
   * (path, ruleId, fingerprint) — e.g. the same banned pattern copy-pasted
   * twice in one file. Assigned by source order (line, then column) among
   * entries in that group, starting at 0.
   */
  occurrence: number;
  /** 1-based line number at the time this entry was recorded. Informational only. */
  line: number;
}

export interface BaselineHeader {
  version: number;
  /** ISO 8601 timestamp of when this baseline was taken. */
  takenAt: string;
  /** The git commit the baseline was taken against. */
  commit: string;
}

/**
 * A baseline as loaded into memory.
 *
 * `repoRoot` is attached by `readBaseline` from the argument it was called
 * with; it is never part of the persisted file (a machine-specific absolute
 * path has no business in a file every teammate commits and reads). It rides
 * along on the in-memory value so `partitionViolations` can relativize each
 * `Violation.file` — always absolute, see `protocol/violation.ts` — against
 * the same root the baseline was read for, without every caller having to
 * thread a repo root through separately.
 */
export interface Baseline {
  header: BaselineHeader;
  entries: BaselineEntry[];
  repoRoot: string;
}
