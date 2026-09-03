import { describe, expect, it } from 'vitest';
import type { RuleManifest } from '../../src/protocol/index.js';
import { guidanceSections, evidenceLabel } from '../../src/guidance/templates.js';
import { renderTerminal, renderMarkdown } from '../../src/guidance/render.js';
import { validateRules, GuidanceError } from '../../src/guidance/validate.js';

function assertGuidanceError(err: unknown): asserts err is GuidanceError {
  expect(err).toBeInstanceOf(GuidanceError);
  if (!(err instanceof GuidanceError)) {
    throw err;
  }
}

const noAsCast: RuleManifest = {
  id: 'no-as-cast',
  category: 'type-safety',
  scope: 'file',
  severity: 'error',
  summary: 'Do not use type assertions.',
  why: 'Assertions override the type checker and hide real type mismatches.',
  allowedFixes: [
    'Use a type guard.',
    'Refine the inferred type with a conditional.',
  ],
  notFixes: [],
  examples: {
    bad: 'const x = value as number;',
    good: 'if (typeof value === "number") { const x = value; }',
  },
};

const noAny: RuleManifest = {
  id: 'no-any',
  category: 'type-safety',
  scope: 'file',
  severity: 'error',
  summary:
    'Do not use the `any` type because it removes static type checking and allows values of any shape to propagate without verification.',
  why:
    'A value typed as `any` bypasses every check in the project, so refactorings and call sites silently accept incorrect values.',
  allowedFixes: [
    'Replace with a specific type.',
    'Use `unknown` and narrow before use.',
  ],
  notFixes: [
    {
      pattern: 'widen to `unknown`',
      because: 'the value is still untyped once narrowed away',
      rule: 'no-as-cast',
    },
    {
      pattern: 'cast with `as`',
      because: 'it overrides the type checker',
    },
  ],
  examples: {
    bad: 'let x: any = 1;',
    good: 'let x: number = 1;',
  },
};

const expectedHeadings = ['Summary', 'Why', 'Allowed fixes', 'Not fixes', 'Example'];

function terminalHeadings(text: string): string[] {
  return text.split('\n').filter((line) => expectedHeadings.includes(line));
}

function markdownHeadings(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('## '))
    .map((line) => line.slice(3));
}

describe('guidanceSections', () => {
  it('produces the five sections in order', () => {
    const sections = guidanceSections(noAny);
    expect(sections.map((section) => section.heading)).toEqual(expectedHeadings);
  });

  it('renders None recorded for an empty notFixes list', () => {
    const sections = guidanceSections(noAsCast);
    const notFixes = sections.find((section) => section.heading === 'Not fixes');
    expect(notFixes).toBeDefined();
    expect(notFixes?.lines).toEqual(['None recorded.']);
  });

  it('carries structured notFixEntries alongside the composed lines, so a surface that needs to format pattern/because/rule separately does not have to re-derive them from the manifest', () => {
    const sections = guidanceSections(noAny);
    const notFixes = sections.find((section) => section.heading === 'Not fixes');
    expect(notFixes?.notFixEntries).toEqual([
      {
        pattern: 'widen to `unknown`',
        because: 'the value is still untyped once narrowed away',
        rule: 'no-as-cast',
      },
      {
        pattern: 'cast with `as`',
        because: 'it overrides the type checker',
        rule: undefined,
      },
    ]);
  });

  it('other sections carry no notFixEntries', () => {
    const sections = guidanceSections(noAny);
    for (const section of sections) {
      if (section.heading !== 'Not fixes') {
        expect(section.notFixEntries).toBeUndefined();
      }
    }
  });
});

describe('evidenceLabel', () => {
  it('reads unspecified when evidence is omitted, never semantic', () => {
    expect(evidenceLabel(noAny)).toBe('unspecified');
  });

  it('reads the declared evidence kind when present', () => {
    expect(evidenceLabel({ ...noAny, evidence: 'syntax' })).toBe('syntax');
    expect(evidenceLabel({ ...noAny, evidence: 'semantic' })).toBe('semantic');
  });
});

describe('renderers', () => {
  it('include the same section headings in the same order', () => {
    const terminal = renderTerminal(noAny);
    const markdown = renderMarkdown(noAny);
    expect(terminalHeadings(terminal)).toEqual(expectedHeadings);
    expect(markdownHeadings(markdown)).toEqual(expectedHeadings);
  });

  it('render notFixes with the "would trip" suffix when a rule is set', () => {
    const terminal = renderTerminal(noAny);
    const markdown = renderMarkdown(noAny);
    const line =
      'widen to `unknown` — the value is still untyped once narrowed away (would trip no-as-cast)';
    // Markdown is not column-wrapped, so the composed line survives intact.
    expect(markdown).toContain(line);
    // The terminal renderer wraps at 88 columns, and this line is 90 — so
    // check its unwrapped substrings rather than the exact composed string.
    expect(terminal).toContain('widen to `unknown` — the value is still untyped once narrowed away');
    expect(terminal).toContain('(would trip');
    expect(terminal).toContain('no-as-cast)');
  });

  it('render "None recorded." when notFixes is empty', () => {
    const terminal = renderTerminal(noAsCast);
    const markdown = renderMarkdown(noAsCast);
    expect(terminal).toContain('None recorded.');
    expect(markdown).toContain('None recorded.');
  });
});

describe('renderTerminal', () => {
  it('wraps lines to 88 columns and emits no ANSI escapes', () => {
    const terminal = renderTerminal(noAny);
    for (const line of terminal.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(88);
    }
    expect(terminal).not.toMatch(/\u001b\[/);
  });
});

describe('validateRules', () => {
  it('passes for valid rules', () => {
    expect(() => validateRules([noAny, noAsCast])).not.toThrow();
  });

  it('throws for a dangling notFix rule reference', () => {
    const bad: RuleManifest = {
      ...noAny,
      notFixes: [
        { pattern: 'ignore the value', because: 'bad idea', rule: 'missing-rule' },
      ],
    };
    let caught: GuidanceError | undefined;
    try {
      validateRules([bad]);
    } catch (error) {
      if (error instanceof GuidanceError) {
        caught = error;
      } else {
        throw error;
      }
    }
    assertGuidanceError(caught);
    expect(caught.code).toBe('UNKNOWN_NOTFIX_RULE');
    expect(caught.message).toContain('no-any');
    expect(caught.message).toContain('missing-rule');
  });

  it('throws for an empty allowedFixes array', () => {
    const bad: RuleManifest = { ...noAsCast, allowedFixes: [] };
    let caught: GuidanceError | undefined;
    try {
      validateRules([bad]);
    } catch (error) {
      if (error instanceof GuidanceError) {
        caught = error;
      } else {
        throw error;
      }
    }
    assertGuidanceError(caught);
    expect(caught.code).toBe('EMPTY_FIELD');
    expect(caught.message).toContain('no-as-cast');
    expect(caught.message).toContain('allowedFixes');
  });
});
