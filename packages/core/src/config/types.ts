import type { Severity } from '../protocol/violation.js';
import type { Suppression } from '../baseline/suppressions.js';
import type { LaneDeclaration } from '../executor/lane.js';

/**
 * Analyzer declared in the top-level configuration.
 *
 * The `package` field is opaque to the core: it is either an npm-style
 * specifier or a path to the analyzer manifest, and it is resolved by the
 * registry later. Keeping it a plain string here prevents the loader from
 * needing to know about every analyzer distribution format.
 */
export interface AnalyzerConfig {
  id: string;
  package: string;
  options?: Record<string, unknown>;
}

/**
 * Active rule override for a single rule.
 *
 * `severity` is optional because omitting it keeps the rule manifest's
 * default. `Record<string, unknown>` lets rule-specific options pass through
 * without the core needing to know their shape.
 */
export type RuleOverrideEnabled = { severity?: Severity } & Record<string, unknown>;

export type RuleOverride = false | RuleOverrideEnabled;

/**
 * A per-path rule override.
 *
 * Configuration otherwise has a single global posture: every rule setting in
 * `rules` applies to every file the analyzer sees. That is too coarse for a
 * monorepo where one directory has a legitimately different posture (a CLI
 * module writing to stdout, generated code, a vendored subtree). `overrides`
 * lets `rules`-shaped settings apply only to files matching a glob, instead of
 * forcing a choice between disabling a rule everywhere or leaving a directory
 * permanently in violation.
 *
 * `reason` is required and must be non-empty: an override without a stated
 * reason is indistinguishable from a blanket exemption, which is exactly what
 * this feature exists to avoid.
 */
export interface ConfigOverride {
  /** Non-empty list of globs, matched against each file's repo-relative path. */
  files: string[];
  /** Why this path gets different treatment. Required, must be non-empty. */
  reason: string;
  /** Same shape as the top-level `rules`: a rule object, or `false` to disable. */
  rules: Record<string, RuleOverride>;
}

/**
 * The executor lanes declared for this repository (spec 0011 Requirements 1.3,
 * 3.1, 8.2).
 *
 * `lanes` holds `LaneDeclaration` itself rather than a parallel configuration
 * shape, so a declared lane reaches the scheduler and the localhost view with
 * nothing translated on the way — in particular each lane's per-kind model
 * ordering, which the core reads from one end and never re-orders.
 *
 * `meteredLanesEnabled` is a second, by-name step for a metered lane, checked
 * by `laneConfigProblem` in `lanes.ts`: a lane declaring `billing.kind` of
 * `metered` loads only when its id is listed here.
 */
export interface ExecutorConfig {
  lanes: LaneDeclaration[];
  /**
   * Optional in the same way `overrides` is: the schema's `default: []` fills
   * it, and a config literal built by hand does not have to name it.
   */
  meteredLanesEnabled?: string[];
  /**
   * Minutes without a newly opened dispatch, while open work exists and a lane
   * is free, before the run is reported as stalled (spec 0036 Requirement 4).
   *
   * This is reporting latency: how long silence goes on before a reader is
   * told about it. It is not a reset window, and no subscription's limit
   * informed it — cyv has no such data (Requirement 4.4, 0011 R7.5). Omitted,
   * the default in `executor/stall.ts` applies.
   */
  stallAfterMinutes?: number;
  /**
   * The most dispatches that may be open across every lane at once (spec 0041
   * Requirement 3.1).
   *
   * Omitted, it resolves to the sum of the dispatchable lanes' own caps, which
   * by construction can never bind before those caps do — so the default adds
   * no limit and declaring more lanes raises the ceiling without a second
   * number to maintain. Set it lower to hold a run below what the lanes would
   * otherwise permit.
   */
  maxConcurrentDispatches?: number;
}

/**
 * Parsed and validated `checkyourvibe.json`.
 *
 * This type represents the config after defaults have been applied, so the
 * loader is responsible for filling in omitted optional fields.
 */
export interface CheckYourVibeConfig {
  $schema?: string;
  packs: string[];
  analyzers: AnalyzerConfig[];
  agents?: string[];
  rules: Record<string, RuleOverride>;
  /**
   * Per-path rule overrides, applied in array order after the base `rules`.
   * A later override wins over an earlier one for the same rule id.
   *
   * Optional (like `agents`) so callers that build a `CheckYourVibeConfig`
   * literal by hand do not have to name every field: `loadConfig` always
   * populates it via the schema's `default: []`.
   */
  overrides?: ConfigOverride[];
  /**
   * Individual violations deferred rather than fixed.
   *
   * Optional for the same reason `overrides` is: hand-built config literals
   * elsewhere in the repository would otherwise fail to compile for omitting it,
   * and `loadConfig` fills it from the schema's `default: []` regardless.
   *
   * Each entry requires a reason and an expiry. There is deliberately no bare
   * ignore directive — this project's rule guidance argues against exactly that
   * pattern, and shipping one would be incoherent.
   */
  suppressions?: Suppression[];
  /**
   * Executor lanes. Optional, and absent from what `cyv init` writes: no lane
   * is declared until someone declares one, and the localhost view renders that
   * state as it is rather than guessing a lane's cap.
   */
  executor?: ExecutorConfig;
  strict: boolean;
  exclude: string[];
}

/**
 * A single deferred violation, re-exported from the module that parses and
 * applies suppressions rather than redeclared here.
 *
 * The shape has invariants the configuration file shares — a pinned
 * suppression carries a fingerprint, an occurrence and an exact path — and a
 * second declaration of it would drift from the schema and the matcher.
 *
 * This is a type-only re-export, so it introduces no runtime import of the
 * baseline module, which reads `CONFIG_FILENAME` from this package.
 */
export type {
  BroadSuppression,
  PinnedSuppression,
  Suppression,
} from '../baseline/suppressions.js';
