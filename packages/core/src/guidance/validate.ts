import type { RuleManifest } from '../protocol/index.js';

export class GuidanceError extends Error {
  readonly code: 'UNKNOWN_NOTFIX_RULE' | 'EMPTY_FIELD';

  constructor(code: 'UNKNOWN_NOTFIX_RULE' | 'EMPTY_FIELD', message: string) {
    super(message);
    this.code = code;
    this.name = 'GuidanceError';
  }
}

function failEmpty(ruleId: string, field: string): never {
  throw new GuidanceError(
    'EMPTY_FIELD',
    `Rule ${ruleId}: ${field} is empty. Add a value so the guidance can be rendered.`,
  );
}

/**
 * Validate that a set of rule manifests is internally consistent.
 *
 * Every notFix rule reference must point to a rule id that exists in the same
 * set, and every required guidance field must have a non-empty value.
 */
export function validateRules(rules: RuleManifest[]): void {
  const knownIds = new Set(rules.map((rule) => rule.id));

  for (const rule of rules) {
    if (rule.summary.trim() === '') failEmpty(rule.id, 'summary');
    if (rule.why.trim() === '') failEmpty(rule.id, 'why');
    if (rule.allowedFixes.length === 0) failEmpty(rule.id, 'allowedFixes');

    for (let i = 0; i < rule.allowedFixes.length; i += 1) {
      const fix = rule.allowedFixes[i];
      if (fix === undefined || fix.trim() === '') {
        failEmpty(rule.id, `allowedFixes[${i}]`);
      }
    }

    if (rule.examples.bad.trim() === '') failEmpty(rule.id, 'examples.bad');
    if (rule.examples.good.trim() === '') failEmpty(rule.id, 'examples.good');

    for (const notFix of rule.notFixes) {
      if (notFix.rule !== undefined && !knownIds.has(notFix.rule)) {
        throw new GuidanceError(
          'UNKNOWN_NOTFIX_RULE',
          `Rule ${rule.id}: notFix references unknown rule '${notFix.rule}'. Add the rule or remove the reference.`,
        );
      }
    }
  }
}
