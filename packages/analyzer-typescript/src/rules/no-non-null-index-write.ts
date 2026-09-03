import { Node, ts, type BinaryExpression, type ElementAccessExpression, type ForStatement, type SourceFile, type Type } from 'ts-morph';
import type { RuleManifest, Violation } from '@checkyourvibe/core';
import type { TsRule } from '../rule.js';
import { makeViolation } from '../util.js';

const RULE_ID = 'no-non-null-index-write';

const MESSAGE =
  'This index write reaches a slot that may not exist; the read at the same index would be `T | undefined` under `noUncheckedIndexedAccess`.';

function isArrayOrTuple(type: Type): boolean {
  if (type.isArray() || type.isTuple()) {
    return true;
  }
  if (type.isUnion()) {
    return type.getUnionTypes().every((member) => member.isArray() || member.isTuple());
  }
  return false;
}

function getIndexExpression(left: ElementAccessExpression): Node | undefined {
  return left.getArgumentExpression();
}

function nonNegativeIntegerValue(node: Node): number | undefined {
  if (!Node.isNumericLiteral(node)) {
    return undefined;
  }

  const value = node.getLiteralValue();
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return undefined;
  }

  return value;
}

function isNumericLiteralInTupleRange(left: ElementAccessExpression, receiver: Type): boolean {
  if (!receiver.isTuple()) {
    return false;
  }

  const index = getIndexExpression(left);
  if (index === undefined) {
    return false;
  }

  const value = nonNegativeIntegerValue(index);
  if (value === undefined) {
    return false;
  }

  const tupleElements = receiver.getTupleElements();
  return value < tupleElements.length;
}

function isSafeNumericLiteralIndex(left: ElementAccessExpression, receiver: Type): boolean {
  const index = getIndexExpression(left);
  if (index === undefined) {
    return false;
  }

  if (nonNegativeIntegerValue(index) === undefined) {
    return false;
  }

  if (receiver.isArray()) {
    // A non-negative numeric literal into an array is an explicit slot choice,
    // not a variable whose value is unknown. The rule targets non-literal
    // indices; literal indices are the programmer's own guard.
    return true;
  }

  return isNumericLiteralInTupleRange(left, receiver);
}

function isWithin(node: Node, ancestor: Node): boolean {
  let current: Node | undefined = node.getParent();
  while (current !== undefined) {
    if (current === ancestor) {
      return true;
    }
    current = current.getParent();
  }
  return false;
}

function isReceiverLength(node: Node, receiver: Node): boolean {
  return (
    Node.isPropertyAccessExpression(node) &&
    node.getName() === 'length' &&
    node.getExpression().getText() === receiver.getText()
  );
}

/**
 * Whether `condition` establishes that `index` is a valid slot of `receiver`.
 *
 * `allowCustomBounds` is the deliberate hole in this rule, and it is worth
 * being explicit about rather than discovering later.
 *
 * Outside a loop, only `index < receiver.length` (or `index in receiver`)
 * counts: the bound has to name the receiver, because nothing else proves the
 * slot exists.
 *
 * Inside a `for` loop that controls the index, ANY upper bound is accepted —
 * `j <= n` as readily as `j < arr.length`. That is knowingly permissive, and it
 * means the canonical off-by-one (`for (let j = 1; j <= n; j++) arr[j] = x`)
 * is NOT reported. The alternative is worse: writing into one array while
 * iterating the length of another is common and usually correct (parallel
 * arrays, a preallocated buffer), and flagging it would return this rule to
 * the state it was in when it fired fourteen times on this repository and was
 * wrong every time.
 *
 * So the rule catches the bare unguarded write and declines to reason about
 * loop arithmetic. Narrowing this further needs range analysis, not a better
 * pattern match.
 */
function isInGuardCondition(condition: Node, index: Node, receiver: Node, allowCustomBounds: boolean): boolean {
  if (!Node.isBinaryExpression(condition)) {
    return false;
  }

  const op = condition.getOperatorToken().getText();

  if (op === 'in') {
    const left = condition.getLeft();
    const right = condition.getRight();
    return left.getText() === index.getText() && right.getText() === receiver.getText();
  }

  const left = condition.getLeft();
  const right = condition.getRight();
  const indexText = index.getText();

  if (op === '<' || op === '<=') {
    if (left.getText() !== indexText) {
      return false;
    }
    if (!allowCustomBounds) {
      return op === '<' && isReceiverLength(right, receiver);
    }
    return true;
  }

  if (op === '>' || op === '>=') {
    if (right.getText() !== indexText) {
      return false;
    }
    if (!allowCustomBounds) {
      return op === '>' && isReceiverLength(left, receiver);
    }
    return true;
  }

  return false;
}

function isGuardedByIfStatement(assignment: BinaryExpression, index: Node, receiver: Node): boolean {
  const ifStatement = assignment.getFirstAncestor(Node.isIfStatement);
  if (ifStatement === undefined) {
    return false;
  }

  const thenStatement = ifStatement.getThenStatement();
  if (!isWithin(assignment, thenStatement)) {
    return false;
  }

  const elseStatement = ifStatement.getElseStatement();
  if (elseStatement !== undefined && isWithin(assignment, elseStatement)) {
    return false;
  }

  return isInGuardCondition(ifStatement.getExpression(), index, receiver, false);
}

function forLoopControlsIndex(forStatement: ForStatement, index: Node): boolean {
  const indexText = index.getText();

  const initializer = forStatement.getInitializer();
  if (initializer !== undefined && Node.isVariableDeclarationList(initializer)) {
    for (const declaration of initializer.getDeclarations()) {
      const nameNode = declaration.getNameNode();
      if (Node.isIdentifier(nameNode) && nameNode.getText() === indexText) {
        return true;
      }
    }
  }

  const incrementor = forStatement.getIncrementor();
  if (incrementor === undefined) {
    return false;
  }

  if (Node.isPostfixUnaryExpression(incrementor) || Node.isPrefixUnaryExpression(incrementor)) {
    const operator = incrementor.getOperatorToken();
    if (operator === ts.SyntaxKind.PlusPlusToken || operator === ts.SyntaxKind.MinusMinusToken) {
      if (incrementor.getOperand().getText() === indexText) {
        return true;
      }
    }
  }

  if (Node.isBinaryExpression(incrementor)) {
    const left = incrementor.getLeft();
    if (Node.isIdentifier(left) && left.getText() === indexText) {
      return true;
    }
  }

  return false;
}

function isGuardedByForStatement(assignment: BinaryExpression, index: Node, receiver: Node): boolean {
  const forStatement = assignment.getFirstAncestor(Node.isForStatement);
  if (forStatement === undefined) {
    return false;
  }

  const statement = forStatement.getStatement();
  if (!isWithin(assignment, statement)) {
    return false;
  }

  const condition = forStatement.getCondition();
  if (condition === undefined) {
    return false;
  }

  if (!isInGuardCondition(condition, index, receiver, true)) {
    return false;
  }

  return forLoopControlsIndex(forStatement, index);
}

function isGuardedWrite(assignment: BinaryExpression, left: ElementAccessExpression, receiver: Type): boolean {
  const index = getIndexExpression(left);
  if (index === undefined) {
    return false;
  }

  if (isSafeNumericLiteralIndex(left, receiver)) {
    return true;
  }

  return (
    isGuardedByIfStatement(assignment, index, left.getExpression()) ||
    isGuardedByForStatement(assignment, index, left.getExpression())
  );
}

const manifest: RuleManifest = {
  id: RULE_ID,
  category: 'type-safety',
  pack: 'strict-boundaries',
  evidence: 'semantic',
  scope: 'file',
  severity: 'error',
  summary: 'Do not write through an index whose read would be `T | undefined` without establishing the slot exists.',
  why:
    'Under `noUncheckedIndexedAccess`, reading an array or tuple index returns `T | undefined` unless the slot is known to exist. ' +
    'Writing to the same index without a guard is an implicit claim that the slot exists; if it does not, the write may create a hole, overwrite the wrong element, or turn a compile-time `undefined` into a runtime surprise.',
  allowedFixes: [
    'Guard the write with `if (i < arr.length)`, `if (i in arr)`, or `if (i in tuple)` before the assignment.',
    'Use `arr.push(value)` or `arr.splice(...)` when the intent is to add or replace elements.',
    'For a tuple, use a numeric literal index that is within the tuple\'s declared length.',
    'If the index may be missing, use `arr[i] ??= defaultValue` or `tuple[i] ??= defaultValue` to establish a default first.',
  ],
  notFixes: [
    {
      pattern: 'Use a non-null assertion on the read side to claim the slot exists',
      rule: 'no-non-null-assertion',
      because:
        'A non-null assertion does not prove the slot exists; it only tells the compiler to trust that it does, and the write can still land on a missing index.',
    },
    {
      pattern: 'Cast the index to a narrower type with `as`',
      rule: 'no-as-cast',
      because:
        'Casting the index does not change the actual range of the value; an out-of-bounds or missing slot can still be written.',
    },
    {
      pattern: 'Widen the array or tuple to `any` so the index write is not checked',
      rule: 'no-any',
      because:
        '`any` removes all type information and simply moves the out-of-bounds or missing-slot risk to runtime without a compile-time guard.',
    },
    {
      pattern: 'Suppress the finding with a compiler-directive comment',
      rule: 'no-ts-comment',
      because:
        'A directive comment hides the unchecked write without adding a guard, so the runtime risk of writing to a missing slot remains.',
    },
    {
      pattern: 'Use `Array.isArray` on an `any` or `unknown` value to justify the index write',
      rule: 'no-unsafe-array-narrowing',
      because:
        '`Array.isArray` narrows `unknown` to `any[]`, so the element write is still unchecked and the rule no-unsafe-array-narrowing will fire.',
    },
  ],
  examples: {
    bad: `declare const arr: string[];
declare const tuple: [string, number];
declare const i: number;

arr[i] = 'x';
tuple[i] = 'x';
tuple[100] = 'x';`,
    good: `declare const arr: string[];
declare const tuple: [string, number];
declare const i: number;

if (i < arr.length) {
  arr[i] = 'x';
}

if (i in arr) {
  arr[i] = 'x';
}

for (let j = 0; j < arr.length; j++) {
  arr[j] = 'x';
}

tuple[0] = 'a';
tuple[1] = 1;

arr[0] = 'x';

arr.push('x');

arr[i] ??= 'default';`,
  },
};

function check(sourceFile: SourceFile, _options: Record<string, unknown>): Violation[] {
  const violations: Violation[] = [];

  for (const node of sourceFile.getDescendants()) {
    if (!Node.isBinaryExpression(node)) {
      continue;
    }

    const operator = node.getOperatorToken().getText();
    if (operator !== '=' && operator !== '+=' && operator !== '-=' && operator !== '*=' && operator !== '/=' && operator !== '%=') {
      continue;
    }

    const left = node.getLeft();
    if (!Node.isElementAccessExpression(left)) {
      continue;
    }

    const receiver = left.getExpression().getType();
    if (!isArrayOrTuple(receiver)) {
      continue;
    }

    if (isGuardedWrite(node, left, receiver)) {
      continue;
    }

    violations.push(makeViolation(sourceFile, left, RULE_ID, MESSAGE, 'error'));
  }

  return violations;
}

export const noNonNullIndexWrite: TsRule = { manifest, check };
