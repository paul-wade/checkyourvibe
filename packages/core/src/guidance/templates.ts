import type { NotFix, RuleManifest } from '../protocol/index.js';

/**
 * A single guidance section, independent of output channel.
 */
export interface GuidanceSection {
  /** Section heading as rendered in every channel. */
  heading: string;
  /** Lines of content, ready for channel-specific formatting. */
  lines: string[];
  /**
   * Structured entries for the "Not fixes" section only, omitted everywhere
   * else. `lines` above already composes each entry into one display string
   * for the terminal and markdown renderers (which never need `pattern`,
   * `because`, and `rule` apart); a surface that renders them as separate
   * markup — the dashboard's bordered `.notfix` blocks, one day a site's
   * hyperlinked target — reads this instead. Giving it its own re-derivation
   * of `rule.notFixes` is exactly how the dashboard and the terminal ended up
   * disagreeing about a notFix's wording in the first place.
   */
  notFixEntries?: NotFixEntry[];
}

/** One notFix, kept structured for a surface that formats its parts separately. */
export interface NotFixEntry {
  pattern: string;
  because: string;
  /** Target rule id this non-fix would trip, when the notFix names one. */
  rule: string | undefined;
}

/**
 * The verb phrase connecting a notFix to the rule it names, shared by every
 * surface so the choice is made once.
 *
 * Chosen over "violates <rule>" (the terminal's previous wording): a notFix
 * describes a fix the reader has NOT taken — just one that looks tempting —
 * so a conditional verb matches what the field means. "Violates" reads as a
 * fact about something that already happened, which overstates a notFix into
 * an accusation; "would trip" keeps the warning conditional, and reads the
 * same whether it sits in a terminal's parentheses or an HTML sentence.
 */
export const NOT_FIX_TARGET_VERB = 'would trip';

function notFixLine(notFix: NotFix): string {
  const base = `${notFix.pattern} — ${notFix.because}`;
  return notFix.rule === undefined ? base : `${base} (${NOT_FIX_TARGET_VERB} ${notFix.rule})`;
}

function toNotFixEntry(notFix: NotFix): NotFixEntry {
  return { pattern: notFix.pattern, because: notFix.because, rule: notFix.rule };
}

/**
 * Convert a rule manifest into the shared guidance structure.
 *
 * The same sections are used by the terminal and markdown renderers, and by
 * the dashboard's rule cards, so no surface can drift from another about what
 * a rule's guidance says or how a `notFix` is worded (spec 0032, Requirement
 * 1.4).
 */
export function guidanceSections(rule: RuleManifest): GuidanceSection[] {
  return [
    { heading: 'Summary', lines: [rule.summary] },
    { heading: 'Why', lines: [rule.why] },
    { heading: 'Allowed fixes', lines: rule.allowedFixes },
    {
      heading: 'Not fixes',
      lines:
        rule.notFixes.length === 0
          ? ['None recorded.']
          : rule.notFixes.map(notFixLine),
      notFixEntries: rule.notFixes.map(toNotFixEntry),
    },
    { heading: 'Example', lines: [rule.examples.bad, rule.examples.good] },
  ];
}

/**
 * A rule's evidence kind as text, shared so every surface applies the same
 * fallback. Omitted must read as "unspecified", never as "semantic" — an
 * analyzer that has not thought about evidence should not be credited with
 * the stronger claim (spec 0032, Requirement 2.1; `RuleGuidance.evidence`).
 */
export function evidenceLabel(rule: Pick<RuleManifest, 'evidence'>): string {
  return rule.evidence ?? 'unspecified';
}
