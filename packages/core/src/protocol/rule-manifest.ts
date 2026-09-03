import type { Severity } from './violation.js';

/**
 * A remediation that looks like a fix but trips a different rule.
 *
 * This is the field that makes the guidance worth more than a lint message.
 * An agent told only "no `any` here" reaches for `unknown`, or an `as` cast, or
 * `@ts-ignore` — each of which is a different violation. Naming those dead ends
 * explicitly, as data rather than prose, is what stops a violation from being
 * laundered into another one.
 *
 * `rule` is optional because some dead ends are not themselves rule violations,
 * just bad ideas. When it is present the core validates that the rule exists.
 */
export interface NotFix {
  /** Short description of the tempting non-fix, e.g. "widen to `unknown`". */
  pattern: string;
  /** Why it does not actually solve the problem. */
  because: string;
  /** The rule id this non-fix would trip, when there is one. */
  rule?: string;
}

/** The explanatory half of a rule — everything a human or agent needs to fix it. */
export interface RuleGuidance {
  /** One line. Shown inline with the violation. */
  summary: string;
  /** Why the rule exists. Reasoning, not restatement. */
  why: string;
  /** Concrete remediations, each independently sufficient. */
  allowedFixes: string[];
  notFixes: NotFix[];
  examples: {
    bad: string;
    good: string;
  };
  /**
   * What kind of evidence this rule's findings rest on.
   *
   * `semantic` — the analyzer consulted a type system or symbol table, so the
   * finding reflects what the compiler actually resolved.
   * `syntax` — the analyzer matched shape alone. Sound for some questions (a
   * bare `except:` is a bare `except:`) and necessarily approximate for others.
   *
   * Severity is deliberately NOT the lever for this. Severity measures impact;
   * this measures confidence, and the two are independent — a syntax-only
   * finding can be both certainly-shaped and severe, or semantically proven and
   * trivial. Conflating them would force an analyzer to understate importance in
   * order to signal uncertainty.
   *
   * Raised by the Python analyzer, which has only `ast`: it can prove a mutable
   * default argument from syntax, but cannot tell whether an `assert` guards
   * external input or an internal invariant. Without this field its findings
   * were indistinguishable from a type-checked analyzer's.
   *
   * It lives on the guidance rather than only on the manifest so that it
   * reaches the agent reading a finding. An agent deciding how hard to argue
   * with a report needs to know whether the compiler resolved this or whether
   * a shape matched.
   *
   * Omitted means unspecified rather than semantic — an analyzer that has not
   * thought about it should not be assumed to have the stronger claim.
   */
  evidence?: 'syntax' | 'semantic';
}

export interface RuleManifest extends RuleGuidance {
  id: string;
  /** Free-form grouping for report output, e.g. "type-safety". */
  category: string;
  /**
   * The rule pack this rule ships in, e.g. "core-ts".
   *
   * Configuration enables rules by pack, so pack membership has to be
   * discoverable from the static manifest — otherwise `packs: ["core-ts"]`
   * expands to nothing and the config silently enables no rules at all.
   * A rule with no pack can only be enabled by naming it explicitly.
   */
  pack?: string;
  /**
   * `file` rules examine one source file at a time and can run on a single
   * edited file — so they work in hook and explicit-path invocations.
   *
   * `project` rules need the whole tree (cross-file maps, orphan detection) and
   * therefore only run in whole-repo modes. The core reports when they were
   * skipped for this reason instead of leaving it as folklore.
   */
  scope: 'file' | 'project';
  /** Default severity. Configuration may override it. */
  severity: Severity;
  /** JSON Schema for this rule's options, when it takes any. */
  optionsSchema?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i];
    if (typeof item !== 'string') return false;
  }
  return true;
}

function isNotFix(value: unknown): value is NotFix {
  if (!isRecord(value)) return false;
  if (typeof value.pattern !== 'string' || typeof value.because !== 'string') return false;
  if (value.rule !== undefined && typeof value.rule !== 'string') return false;
  return true;
}

function isNotFixArray(value: unknown): value is NotFix[] {
  if (!Array.isArray(value)) return false;
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i];
    if (!isNotFix(item)) return false;
  }
  return true;
}

export function isRuleManifest(value: unknown): value is RuleManifest {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || typeof value.category !== 'string') return false;
  if (value.scope !== 'file' && value.scope !== 'project') return false;
  if (value.severity !== 'error' && value.severity !== 'warning') return false;
  if (typeof value.summary !== 'string' || typeof value.why !== 'string') return false;
  if (!isStringArray(value.allowedFixes)) return false;
  if (!isNotFixArray(value.notFixes)) return false;
  if (
    !isRecord(value.examples) ||
    typeof value.examples.bad !== 'string' ||
    typeof value.examples.good !== 'string'
  ) {
    return false;
  }
  return true;
}
