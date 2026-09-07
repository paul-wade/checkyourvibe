import { describe, expect, it } from 'vitest';
import { isRuleManifest } from '../../src/protocol/index.js';

/** A structurally valid manifest whose only notFix carries a string `example`. */
function manifestWithExample(example: unknown): unknown {
  return {
    id: 'rule-1',
    category: 'test',
    scope: 'file',
    severity: 'error',
    summary: 'summary',
    why: 'why',
    allowedFixes: ['fix'],
    notFixes: [{ pattern: 'p', because: 'b', rule: 'other-rule', example }],
    examples: { bad: 'bad', good: 'good' },
  };
}

describe('isRuleManifest — NotFix.example', () => {
  it('accepts a notFix whose example is a string', () => {
    expect(isRuleManifest(manifestWithExample('const x = 1; // BAD_MARKER'))).toBe(true);
  });

  it('accepts a notFix with no example at all', () => {
    const manifest = {
      id: 'rule-1',
      category: 'test',
      scope: 'file',
      severity: 'error',
      summary: 'summary',
      why: 'why',
      allowedFixes: ['fix'],
      notFixes: [{ pattern: 'p', because: 'b', rule: 'other-rule' }],
      examples: { bad: 'bad', good: 'good' },
    };
    expect(isRuleManifest(manifest)).toBe(true);
  });

  it('rejects a notFix whose example is a number', () => {
    expect(isRuleManifest(manifestWithExample(42))).toBe(false);
  });
});
