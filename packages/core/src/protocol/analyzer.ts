import { isUnknownArray } from '../guards.js';
import type { RuleManifest } from './rule-manifest.js';
import type { Diagnostic, Severity, SkippedFile, Violation } from './violation.js';

export const PROTOCOL_VERSION = 1;

/**
 * How the core reaches an analyzer.
 *
 * `node` is an in-process fast path: no serialization, and watch mode can hold
 * warm state between runs. `process` is the universal path — any runtime that
 * can read stdin and write stdout qualifies, which is what makes a Roslyn or
 * libclang analyzer possible without changing the core.
 *
 * Both satisfy the same request/response schemas. The reference TypeScript
 * analyzer implements both so the subprocess path stays exercised rather than
 * bit-rotting until the first non-Node analyzer appears.
 */
export type AnalyzerExec =
  | { type: 'node'; module: string }
  | { type: 'process'; command: string; args?: string[] };

/**
 * Static description of an analyzer, readable WITHOUT executing it.
 *
 * The separation is deliberate: `cyv explain <rule>` and agent-glue generation
 * need rule metadata, and neither should pay a .NET or clang startup to get it.
 */
export interface AnalyzerManifest {
  protocol: typeof PROTOCOL_VERSION;
  id: string;
  /** Globs, relative to the repo root, this analyzer claims. */
  match: string[];
  exclude?: string[];
  /**
   * A supplemental analyzer runs alongside whichever analyzer owns a file,
   * instead of competing for it.
   *
   * Ownership is normally exclusive: two analyzers claiming the same file is a
   * configuration error, because it means neither is authoritative about the
   * language. That is right for language analyzers and wrong for a rule that
   * applies to every language at once — comment style, licence headers, encoding
   * — which would otherwise have to be reimplemented inside each analyzer and
   * would drift between them.
   *
   * A supplemental analyzer is exempt from the exclusivity check and never
   * counts as the claimant of a file. A file matched only by supplemental
   * analyzers is still unmatched, because nothing owns it.
   */
  supplements?: boolean;
  rules: RuleManifest[];
  /** Reserved for a future long-lived-session protocol. Unused in v1. */
  capabilities?: { session?: boolean };
  exec: AnalyzerExec;
}

/** Per-rule configuration handed to the analyzer: severity plus that rule's own options. */
export type RuleSettings = { severity: Severity } & Record<string, unknown>;

export interface AnalyzeRequest {
  protocol: typeof PROTOCOL_VERSION;
  repoRoot: string;
  /**
   * `file` sends only file-scope rules — the mode used by editor hooks and
   * explicit paths. `project` additionally sends project-scope rules, which
   * need the whole tree.
   */
  mode: 'file' | 'project';
  /** Absolute paths. */
  files: string[];
  /** Keyed by rule id. Only enabled rules appear. */
  rules: Record<string, RuleSettings>;
  /** Analyzer-specific options passed through opaquely from configuration. */
  options?: Record<string, unknown>;
}

/**
 * A group of files the analyzer could not type-check with its normal
 * configuration, and why. Semantic findings for these files are withheld
 * because they rest on a type graph the analyzer does not trust.
 */
export interface DegradedResolution {
  /** Absolute paths of the files whose type resolution was degraded. */
  files: string[];
  /** Why the type resolution was degraded, in terms a human can act on. */
  reason: string;
}

export interface AnalyzeResponse {
  protocol: typeof PROTOCOL_VERSION;
  violations: Violation[];
  skipped: SkippedFile[];
  diagnostics: Diagnostic[];
  /** Files whose type resolution was degraded. Optional for backward compatibility. */
  degraded?: DegradedResolution[];
}

/** The default export an `exec.type: 'node'` analyzer module must provide. */
export type AnalyzeFn = (request: AnalyzeRequest) => Promise<AnalyzeResponse>;

export function emptyResponse(): AnalyzeResponse {
  return { protocol: PROTOCOL_VERSION, violations: [], skipped: [], diagnostics: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isUnknownArray(value);
}

function isStringArray(value: unknown): value is string[] {
  if (!isUnknownArray(value)) return false;
  for (const item of value) {
    if (typeof item !== 'string') return false;
  }
  return true;
}

function isDegradedResolution(value: unknown): value is DegradedResolution {
  if (!isRecord(value)) return false;
  if (typeof value.reason !== 'string' || !isStringArray(value.files)) return false;
  return true;
}

function isDegradedResolutionArray(value: unknown): value is DegradedResolution[] {
  if (!isUnknownArray(value)) return false;
  for (const item of value) {
    if (!isDegradedResolution(item)) return false;
  }
  return true;
}

/**
 * Structural check on an analyzer's reply.
 *
 * A malformed response is a hard error rather than something to coerce: a
 * response we cannot read means files whose results we do not have, and
 * reporting success over those is the failure mode this project exists to stop.
 */
export function isAnalyzeResponse(value: unknown): value is AnalyzeResponse {
  if (!isRecord(value)) return false;
  if (
    value.protocol !== PROTOCOL_VERSION ||
    !isUnknownArray(value.violations) ||
    !isUnknownArray(value.skipped) ||
    !isUnknownArray(value.diagnostics)
  ) {
    return false;
  }
  if (value.degraded !== undefined && !isDegradedResolutionArray(value.degraded)) {
    return false;
  }
  return true;
}
