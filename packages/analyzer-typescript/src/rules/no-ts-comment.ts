import type { Node, SourceFile } from 'ts-morph';
import { truncate } from '../util.js';
import { SNIPPET_MAX_LENGTH } from '@checkyourvibe/core';
import type { RuleManifest, Violation } from '@checkyourvibe/core';
import type { TsRule } from '../rule.js';

const RULE_ID = 'no-ts-comment';

interface ParsedDirective {
  kind: 'ts-ignore' | 'ts-expect-error';
  offset: number;
}

interface DirectiveToken {
  readonly text: string;
  readonly kind: 'ts-ignore' | 'ts-expect-error' | 'ts-nocheck';
}

const DIRECTIVES: readonly DirectiveToken[] = [
  { text: '@ts-ignore', kind: 'ts-ignore' },
  { text: '@ts-expect-error', kind: 'ts-expect-error' },
  { text: '@ts-nocheck', kind: 'ts-nocheck' },
];

const WHITESPACE = /[ \t\r\n]/;
const WORD_CONTINUATION = /[A-Za-z0-9_-]/;

function isWhitespace(char: string): boolean {
  return WHITESPACE.test(char);
}

function isWordContinuation(char: string): boolean {
  return WORD_CONTINUATION.test(char);
}

function findDirective(text: string): ParsedDirective | null {
  let bodyStart: number;
  let bodyEnd: number;
  let stripAsterisks: boolean;

  if (text.startsWith('//')) {
    bodyStart = 2;
    bodyEnd = text.length;
    stripAsterisks = false;
  } else if (text.startsWith('/**') && text.endsWith('*/')) {
    bodyStart = 3;
    bodyEnd = text.length - 2;
    stripAsterisks = true;
  } else if (text.startsWith('/*') && text.endsWith('*/')) {
    bodyStart = 2;
    bodyEnd = text.length - 2;
    stripAsterisks = true;
  } else {
    return null;
  }

  let i = bodyStart;
  while (i < bodyEnd) {
    const char = text.charAt(i);
    if (isWhitespace(char)) {
      i++;
      continue;
    }
    if (stripAsterisks && char === '*') {
      i++;
      continue;
    }

    for (const directive of DIRECTIVES) {
      const end = i + directive.text.length;
      if (end > bodyEnd) {
        continue;
      }
      if (text.slice(i, end) === directive.text) {
        const next = end < bodyEnd ? text.charAt(end) : '';
        if (next === '' || !isWordContinuation(next)) {
          if (directive.kind === 'ts-nocheck') {
            return null;
          }
          return { kind: directive.kind, offset: i };
        }
      }
    }

    return null;
  }

  return null;
}

const manifest: RuleManifest = {
  id: RULE_ID,
  category: 'type-safety',
  pack: 'core-ts',
  evidence: 'syntax',
  scope: 'file',
  severity: 'error',
  summary: 'Do not silence type errors with `@ts-ignore` or `@ts-expect-error` compiler directive comments.',
  why: 'Compiler directive comments stop the type checker from reporting a specific line. They leave the actual mismatch in the source, so the next reader and every later refactor inherit a false assumption. `@ts-expect-error` is safer than `@ts-ignore` because it fails when the error is removed, but it still marks an unresolved type error as acceptable.',
  allowedFixes: [
    'Fix the underlying type error at its source, such as a wrong declaration or a missing property.',
    'Narrow the value with a type guard, `typeof`, `instanceof`, or an `in` check before it reaches the silenced line.',
    'If a dependency type declaration is inaccurate, correct it locally with a module augmentation.',
    'When the checker cannot see a value because of control flow, restructure the code or add a runtime check so the type becomes derivable.',
  ],
  notFixes: [
    {
      pattern: 'Replace `@ts-ignore` with `@ts-expect-error` to avoid the stricter severity',
      because: 'This rule reports both directives. The underlying type error is still hidden from the checker and still present in the code.',
    },
    {
      pattern: 'Cast the value so the directive is no longer needed',
      rule: 'no-as-cast',
      because: 'A type assertion overrides the actual type without proof; the runtime value can still mismatch, so the suppressed error reappears as an unchecked cast.',
    },
    {
      pattern: 'Annotate the value as `any` so the error disappears',
      rule: 'no-any',
      because: '`any` removes type information for that value and everything it flows into, which is a broader and more damaging violation than a single suppressed error.',
    },
  ],
  examples: {
    bad: `// @ts-ignore
const value: number = 'not a number';

/** @ts-expect-error */
const other: string = 123;`,
    good: `function parse(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }
  throw new Error('expected a string');
}`,
  },
};

function check(sourceFile: SourceFile, _options: Record<string, unknown>): Violation[] {
  const violations: Violation[] = [];
  const seen = new Set<string>();

  sourceFile.forEachDescendant((node: Node) => {
    for (const range of node.getLeadingCommentRanges()) {
      const key = `${range.getPos()}:${range.getEnd()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const parsed = findDirective(range.getText());
      if (parsed === null) {
        continue;
      }

      const position = range.getPos() + parsed.offset;
      const { line, column } = sourceFile.getLineAndColumnAtPos(position);
      const severity = parsed.kind === 'ts-ignore' ? 'error' : 'warning';
      const message =
        parsed.kind === 'ts-ignore'
          ? '`@ts-ignore` suppresses the type checker without fixing the underlying type error.'
          : '`@ts-expect-error` records an unresolved type error that should be fixed, not committed.';

      violations.push({
        file: sourceFile.getFilePath(),
        line,
        column,
        ruleId: RULE_ID,
        message,
        snippet: truncate(range.getText(), SNIPPET_MAX_LENGTH),
        severity,
      });
    }
  });

  return violations;
}

export const noTsComment: TsRule = { manifest, check };
