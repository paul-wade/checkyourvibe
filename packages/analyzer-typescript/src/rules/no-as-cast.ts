import { ts, type Node, type SourceFile } from 'ts-morph';
import { makeViolation, makeViolationAt } from '../util.js';
import type { RuleManifest, Violation } from '@checkyourvibe/core';
import type { TsRule } from '../rule.js';

const RULE_ID = 'no-as-cast';

/**
 * The position of the `as` keyword in a cast, falling back to the start of the
 * whole expression when the keyword cannot be located.
 *
 * An `as` trails its operand, and the operand may span several lines, so the
 * start of the expression can be on a line that contains no `as`. An
 * angle-bracket assertion needs no equivalent: `<T>x` starts at the assertion.
 */
function asKeywordStart(node: Node): number {
  const keyword = node.getFirstChildByKind(ts.SyntaxKind.AsKeyword);
  return keyword === undefined ? node.getStart() : keyword.getStart();
}

/**
 * A cast that is itself the expression of an outer cast would be reported
 * twice for the same stretch of code. The outer node covers the whole
 * assertion, so skip the inner one.
 */
function isNestedInOuterCast(node: Node): boolean {
  const parent = node.getParent();
  if (parent === undefined) {
    return false;
  }
  if (
    !parent.isKind(ts.SyntaxKind.AsExpression) &&
    !parent.isKind(ts.SyntaxKind.TypeAssertionExpression)
  ) {
    return false;
  }
  return parent.getExpression() === node;
}

function isConstAssertion(node: Node): boolean {
  if (!node.isKind(ts.SyntaxKind.AsExpression)) {
    return false;
  }
  const typeNode = node.getTypeNode();
  return typeNode !== undefined && typeNode.getText() === 'const';
}

const manifest: RuleManifest = {
  id: RULE_ID,
  category: 'type-safety',
  pack: 'core-ts',
  evidence: 'syntax',
  scope: 'file',
  severity: 'error',
  summary: 'Do not force a value into a type with `as` or angle-bracket assertions.',
  why:
    'Type assertions tell the compiler to trust a type that the value may not actually have. ' +
    'They move a runtime mismatch forward in time, where it becomes harder to diagnose, ' +
    'and they defeat the guarantees that make refactoring safe.',
  allowedFixes: [
    'Narrow the value with a type guard, `typeof`, `instanceof`, or an `in` check before using it.',
    'Validate unknown input at the boundary with a schema validator and use the validated result.',
    'Fix the upstream declaration so the value has the correct type at the source.',
    'Use a generic so the caller supplies the type and the implementation stays honest.',
  ],
  notFixes: [
    {
      pattern: 'Route the value through `unknown` to reach the target type (`x as unknown as T`).',
      because:
        'It is the same assertion with an extra indirection; this rule reports the double-cast pattern more severely, not less.',
    },
    {
      pattern: 'Assert the value is non-null with `!` instead of proving it.',
      rule: 'no-non-null-assertion',
      because:
        'It removes the same nullability check the cast was trying to avoid, and is reported by no-non-null-assertion.',
    },
    {
      pattern: 'Move the cast to the result of `JSON.parse` or `response.json()` and annotate the parsed value.',
      rule: 'no-json-parse-cast',
      because:
        'The data still reaches the target type without a runtime check; the cast is simply hidden behind a parser call.',
    },
    {
      pattern: 'Suppress the resulting error with a compiler-directive comment such as `@ts-ignore` or `@ts-expect-error`.',
      rule: 'no-ts-comment',
      because:
        'A directive comment hides the type error without changing the actual value, so the mismatch remains at runtime.',
    },
    {
      pattern: 'Annotate the value as `any` so no cast is needed.',
      rule: 'no-any',
      because:
        'Using `any` removes type information altogether, which is a broader and more damaging violation.',
    },
    {
      pattern: 'Cast a returned promise to `void` so the call can be used as an expression statement.',
      rule: 'no-floating-promise',
      because:
        'A cast does not await or handle the promise; it only hides the unhandled promise from the type checker, and `void` should be the explicit, documented discard instead.',
    },
  ],
  examples: {
    bad: `const user = loadUser() as User;
const total = <number>rawTotal;`,
    good: `function load<T>(id: string): T {
  throw new Error('unimplemented');
}
const user = validateUser(loadUser());
if (typeof rawTotal === 'number') {
  const total = rawTotal;
}`,
  },
};

const noAsCast: TsRule = {
  manifest,
  check(sourceFile: SourceFile): Violation[] {
    const violations: Violation[] = [];

    for (const node of sourceFile.getDescendants()) {
      if (node.isKind(ts.SyntaxKind.SatisfiesExpression)) {
        continue;
      }

      if (node.isKind(ts.SyntaxKind.AsExpression)) {
        if (isNestedInOuterCast(node) || isConstAssertion(node)) {
          continue;
        }

        const expression = node.getExpression();
        const start = asKeywordStart(node);
        if (expression.isKind(ts.SyntaxKind.AsExpression)) {
          violations.push(
            makeViolationAt(
              sourceFile,
              node,
              start,
              RULE_ID,
              'Double `as` cast: forcing a value through two type assertions in a row hides more than a single lie.',
              'error',
            ),
          );
        } else {
          violations.push(
            makeViolationAt(
              sourceFile,
              node,
              start,
              RULE_ID,
              '`as` cast overrides the actual type of a value.',
              'error',
            ),
          );
        }

        continue;
      }

      if (node.isKind(ts.SyntaxKind.TypeAssertionExpression)) {
        if (isNestedInOuterCast(node)) {
          continue;
        }

        violations.push(
          makeViolation(
            sourceFile,
            node,
            RULE_ID,
            'Angle-bracket type assertion overrides the actual type of a value.',
            'error',
          ),
        );
      }
    }

    return violations;
  },
};

export { noAsCast };
