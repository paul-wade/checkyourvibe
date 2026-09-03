import { Node, type SourceFile, type Type } from 'ts-morph';
import type { RuleManifest, Violation } from '@checkyourvibe/core';
import type { TsRule } from '../rule.js';
import { makeViolation } from '../util.js';

const RULE_ID = 'no-unsafe-index-access';

const UNKNOWN_ELEMENT_MESSAGE =
  'Element or property access on a value typed `unknown` is not checked; the compiler has no information about what this index returns.';

const UNCHECKED_INDEX_MESSAGE =
  'This index access can return `undefined`, but the result is used without a null check, optional chain, or fallback.';

function isUnknownAccess(receiver: Type): boolean {
  return receiver.isUnknown();
}

function isIndexableType(type: Type): boolean {
  if (type.isAny() || type.isUnknown()) {
    return false;
  }
  return (
    type.isArray() ||
    type.isTuple() ||
    type.getNumberIndexType() !== undefined ||
    type.getStringIndexType() !== undefined
  );
}

function isNullableType(type: Type): boolean {
  return type.isNullable() || type.isUndefined();
}

function isUndefinedIdentifier(node: Node): boolean {
  return (
    Node.isIdentifier(node) &&
    (node.getText() === 'undefined' || node.getType().isUndefined())
  );
}

function isNullOrUndefinedLiteral(node: Node): boolean {
  return Node.isNullLiteral(node) || isUndefinedIdentifier(node);
}

function isQuestionDotParent(node: Node): boolean {
  const parent = node.getParent();
  if (parent === undefined) {
    return false;
  }
  return Node.isQuestionDotTokenable(parent) && parent.hasQuestionDotToken();
}

function isTypeOfComparison(node: Node): boolean {
  const parent = node.getParent();
  if (parent === undefined || !Node.isTypeOfExpression(parent)) {
    return false;
  }
  const grandparent = parent.getParent();
  if (grandparent === undefined || !Node.isBinaryExpression(grandparent)) {
    return false;
  }
  const op = grandparent.getOperatorToken().getText();
  if (!['===', '!==', '==', '!='].includes(op)) {
    return false;
  }
  const other =
    grandparent.getLeft() === parent ? grandparent.getRight() : grandparent.getLeft();
  return other !== undefined && Node.isStringLiteral(other);
}

function isGuardedComparison(node: Node): boolean {
  const parent = node.getParent();
  if (parent === undefined || !Node.isBinaryExpression(parent)) {
    return false;
  }
  const op = parent.getOperatorToken().getText();
  if (!['===', '!==', '==', '!='].includes(op)) {
    return false;
  }
  const other = parent.getLeft() === node ? parent.getRight() : parent.getLeft();
  return other !== undefined && isNullOrUndefinedLiteral(other);
}

function isNullishFallback(node: Node): boolean {
  const parent = node.getParent();
  if (parent === undefined || !Node.isBinaryExpression(parent)) {
    return false;
  }
  const op = parent.getOperatorToken().getText();
  return op === '??' || op === '||';
}

function isAssignedToNullableTarget(node: Node): boolean {
  const parent = node.getParent();
  if (parent === undefined) {
    return false;
  }

  if (Node.isVariableDeclaration(parent) && parent.getInitializer() === node) {
    return isNullableType(parent.getType());
  }

  if (Node.isBinaryExpression(parent) && parent.getOperatorToken().getText() === '=') {
    const right = parent.getRight();
    if (right === node) {
      return isNullableType(parent.getLeft().getType());
    }
  }

  return false;
}

function isReturningNullable(node: Node): boolean {
  const parent = node.getParent();
  if (parent === undefined || !Node.isReturnStatement(parent)) {
    return false;
  }

  const ancestor = node.getFirstAncestor(Node.isFunctionLikeDeclaration);
  if (ancestor === undefined) {
    return true;
  }

  return isNullableType(ancestor.getReturnType());
}

function isPreservingCast(node: Node): boolean {
  const parent = node.getParent();
  if (parent === undefined) {
    return false;
  }

  if (Node.isAsExpression(parent) && parent.getExpression() === node) {
    return isNullableType(parent.getType());
  }

  if (Node.isTypeAssertion(parent) && parent.getExpression() === node) {
    return isNullableType(parent.getType());
  }

  return false;
}

// A simple assignment target is a write, not a read; there is no possible
// `undefined` result being consumed.
function isWriteTarget(node: Node): boolean {
  const parent = node.getParent();
  if (parent === undefined) {
    return false;
  }

  if (Node.isBinaryExpression(parent) && parent.getLeft() === node) {
    const op = parent.getOperatorToken().getText();
    return op === '=';
  }

  return false;
}

/**
 * The operand of `delete` names a slot to remove. The slot's value is never
 * produced, so there is no `undefined` result for the surrounding code to
 * consume, and `delete obj[key]` on a missing key is defined behaviour.
 */
function isDeleteOperand(node: Node): boolean {
  const parent = node.getParent();
  return parent !== undefined && Node.isDeleteExpression(parent);
}

function isHandledAccess(node: Node): boolean {
  return (
    isQuestionDotParent(node) ||
    isTypeOfComparison(node) ||
    isGuardedComparison(node) ||
    isNullishFallback(node) ||
    isAssignedToNullableTarget(node) ||
    isReturningNullable(node) ||
    isPreservingCast(node)
  );
}

const manifest: RuleManifest = {
  id: RULE_ID,
  category: 'type-safety',
  pack: 'strict-boundaries',
  scope: 'file',
  severity: 'error',
  evidence: 'semantic',
  summary:
    'Do not read an index or property from a value typed `unknown`, or from an array or record without handling the possible `undefined` result.',
  why:
    'With `noUncheckedIndexedAccess`, every array or record read returns `T | undefined`. Using that result as if it is `T` is an unchecked claim: a missing key or out-of-bounds index becomes a runtime error. The same is true for `unknown`, where the compiler has no idea what properties exist. A type assertion or non-null assertion only hides the uncertainty; it does not prove the value is present.',
  allowedFixes: [
    'Narrow an `unknown` value with `typeof`, `instanceof`, or a user-defined type guard before accessing it.',
    'Guard an array or record access with an `if (value !== undefined)` check, optional chaining (`?.`), or nullish coalescing (`??`).',
    'Use a typed loop such as `for...of` or `Object.entries` that does not depend on unchecked index access.',
    'If the index is definitely in range, prove it with a runtime length or membership check before reading.',
  ],
  notFixes: [
    {
      pattern: 'Silence the possible-undefined error with a non-null assertion (`!`).',
      rule: 'no-non-null-assertion',
      because:
        'It tells the compiler to trust that the value is defined, but a missing element or an out-of-bounds index can still produce `undefined` at runtime.',
    },
    {
      pattern: 'Cast the result to the non-nullable type with `as` or angle brackets.',
      rule: 'no-as-cast',
      because:
        'A cast asserts the type without proof; an out-of-bounds or missing key can still produce `undefined`.',
    },
    {
      pattern: 'Widen the value or the array to `any` so the index access is allowed.',
      rule: 'no-any',
      because:
        'It removes all type information and simply moves the crash to a different line, because a missing element is still `undefined` at runtime.',
    },
    {
      pattern: 'Rely on the element being present because it was set earlier.',
      because:
        'A prior write does not guarantee the element still exists; another caller may have changed the array or record.',
    },
    {
      pattern: 'Write a default value to the index without first checking that the slot exists',
      rule: 'no-non-null-index-write',
      because:
        'Writing to an index without a guard does not prove the slot exists; it may create a hole in an array or silently add a key to a record.',
    },
  ],
  examples: {
    bad: `declare const value: unknown;
declare const arr: string[];
declare const record: Record<string, string>;
declare const i: number;
declare const key: string;

function getElement(): string {
  return arr[i];
}

const name: string = arr[i];
record[key].trim();
value['name'];
value.name;
arr[i].toUpperCase();
(arr[i] as string).trim();`,
    good: `declare const value: unknown;
declare const arr: string[];
declare const record: Record<string, string>;
declare const i: number;
declare const key: string;

// optional chaining handles undefined
arr[i]?.toUpperCase();
record[key]?.trim();

// nullish coalescing provides a fallback
arr[i] ?? 'missing';

// explicit guard narrows both the index and the unknown value
if (arr[i] !== undefined) {
  arr[i].toUpperCase();
}

if (typeof value === 'string') {
  value.length;
}

// preserve the undefined with the type
const found: string | undefined = arr[i];

function find(): string | undefined {
  return record[key];
}`,
  },
};

function check(sourceFile: SourceFile, _options: Record<string, unknown>): Violation[] {
  const violations: Violation[] = [];

  for (const node of sourceFile.getDescendants()) {
    if (Node.isPropertyAccessExpression(node)) {
      const receiver = node.getExpression().getType();
      if (isUnknownAccess(receiver)) {
        violations.push(makeViolation(sourceFile, node, RULE_ID, UNKNOWN_ELEMENT_MESSAGE, 'error'));
      }
      continue;
    }

    if (Node.isElementAccessExpression(node)) {
      const receiver = node.getExpression().getType();

      if (isUnknownAccess(receiver)) {
        violations.push(makeViolation(sourceFile, node, RULE_ID, UNKNOWN_ELEMENT_MESSAGE, 'error'));
        continue;
      }

      if (isIndexableType(receiver) && isNullableType(node.getType())) {
        if (!isWriteTarget(node) && !isDeleteOperand(node) && !isHandledAccess(node)) {
          violations.push(makeViolation(sourceFile, node, RULE_ID, UNCHECKED_INDEX_MESSAGE, 'error'));
        }
      }
    }
  }

  return violations;
}

export const noUnsafeIndexAccess: TsRule = { manifest, check };
