/**
 * The unit of output. Deliberately language-agnostic: nothing here knows about
 * TypeScript, and nothing here should. A C# or C++ analyzer reports the same shape.
 */

export type Severity = 'error' | 'warning';

export interface Violation {
  /** Absolute path. Analyzers must not report repo-relative paths. */
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  endLine?: number;
  endColumn?: number;
  ruleId: string;
  message: string;
  /** The offending source text, truncated to SNIPPET_MAX_LENGTH. */
  snippet: string;
  severity: Severity;
  /**
   * Remediation guidance, attached by the core from the rule's manifest.
   *
   * Analyzers MUST NOT populate this — they report facts, the core explains
   * them. Keeping it one-directional is what guarantees that guidance is
   * identical across every channel (terminal, hook, MCP) and every analyzer,
   * rather than each analyzer inventing its own wording.
   */
  guidance?: import('./rule-manifest.js').RuleGuidance;
}

/**
 * A file an analyzer could not process.
 *
 * This is part of the contract rather than a log line because a skipped file is
 * an unchecked file, and silently reporting success over unchecked files is the
 * exact failure this project exists to avoid. The core surfaces these, and
 * `--strict` treats them as failure.
 */
export interface SkippedFile {
  file: string;
  reason: string;
}

export interface Diagnostic {
  level: 'info' | 'warn' | 'error';
  message: string;
}

export const SNIPPET_MAX_LENGTH = 200;

export function truncateSnippet(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= SNIPPET_MAX_LENGTH
    ? collapsed
    : `${collapsed.slice(0, SNIPPET_MAX_LENGTH - 1)}…`;
}
