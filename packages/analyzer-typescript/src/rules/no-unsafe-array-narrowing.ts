import {
  Node,
  type CallExpression,
  type ForOfStatement,
  type FunctionLikeDeclaration,
  type IfStatement,
  type SourceFile,
  type Type,
  type TypeChecker,
  type TypeNode,
  type TypePredicateNode,
  ts,
} from 'ts-morph';
import { makeViolation } from '../util.js';
import type { RuleManifest, Violation } from '@checkyourvibe/core';
import type { TsRule } from '../rule.js';

const RULE_ID = 'no-unsafe-array-narrowing';

const MESSAGE =
  'Calling `Array.isArray` on a value typed `unknown` or `any` narrows it to `any[]`, so the narrowed binding and every element read from it are unchecked.';

// The call has a single argument, and it is `any` or `unknown`.
function hasBroadArgument(call: CallExpression): boolean {
  const argument = call.getArguments()[0];
  if (argument === undefined) {
    return false;
  }
  const type = argument.getType();
  return type.isAny() || type.isUnknown();
}

// The call resolves to the standard `Array.isArray` method in the TypeScript
// lib files, whose type predicate narrows `unknown` to `any[]`.
function isBuiltInIsArrayCall(call: CallExpression, typeChecker: TypeChecker): boolean {
  const signature = typeChecker.getResolvedSignature(call);
  if (signature === undefined) {
    return false;
  }
  const declaration = signature.getDeclaration();
  if (declaration === undefined) {
    return false;
  }
  const sourceFile = declaration.getSourceFile();
  if (!sourceFile.isInNodeModules()) {
    return false;
  }
  const parent = declaration.getParent();
  if (parent === undefined) {
    return false;
  }
  if (!Node.isInterfaceDeclaration(parent) && !Node.isTypeAliasDeclaration(parent) && !Node.isClassDeclaration(parent)) {
    return false;
  }
  if (parent.getName() !== 'ArrayConstructor') {
    return false;
  }
  const symbol = typeChecker.getSymbolAtLocation(declaration) ?? declaration.getSymbol();
  if (symbol === undefined) {
    return false;
  }
  if (symbol.getName() !== 'isArray') {
    return false;
  }
  return true;
}

// A type is an array (or tuple) of `any` when its element type is `any`.
// A union of arrays, such as `any[] | string[]`, also has an `any` element
// because at least one branch does.
function isAnyArrayType(type: Type): boolean {
  if (type.isArray() || type.isTuple()) {
    const elementType = type.getArrayElementType();
    return elementType !== undefined && elementType.isAny();
  }

  if (type.isUnion()) {
    const elementTypes = type
      .getUnionTypes()
      .map((unionType) => (unionType.isArray() || unionType.isTuple() ? unionType.getArrayElementType() : undefined))
      .filter((elementType): elementType is Type => elementType !== undefined);

    if (elementTypes.length === 0) {
      return false;
    }
    return elementTypes.some((elementType) => elementType.isAny());
  }

  return false;
}

function getReturnTypeNode(ancestor: FunctionLikeDeclaration): TypeNode | undefined {
  return ancestor.getReturnTypeNode();
}

// The call is inside a user-defined type-guard whose return predicate is a
// safe array type (e.g. `unknown[]` or `string[]`), or a non-array type (e.g.
// `Record<string, unknown>`). In those cases the `Array.isArray` call is part
// of a safe guard, not the bare narrowing this rule exists to stop.
function isInsideSafeGuardFunction(call: CallExpression): boolean {
  const ancestor = call.getFirstAncestor(Node.isFunctionLikeDeclaration);
  if (ancestor === undefined) {
    return false;
  }

  const returnTypeNode = getReturnTypeNode(ancestor);
  if (returnTypeNode === undefined || !Node.isTypePredicate(returnTypeNode)) {
    return false;
  }

  const predicateTypeNode = returnTypeNode.getTypeNode();
  if (predicateTypeNode === undefined) {
    // `asserts` predicates have no narrowed type.
    return true;
  }

  // A predicate to `any[]` is the same trap as a direct `Array.isArray` check.
  return !isAnyArrayType(predicateTypeNode.getType());
}

// The call appears in a position where TypeScript uses it to narrow a type:
// a conditional, a logical operator, a ternary, a negated guard, or the
// return of a type-predicate function.
function isUsedAsTypeGuard(call: CallExpression): boolean {
  let current: Node = call;

  while (true) {
    const parent = current.getParent();
    if (parent === undefined) {
      return false;
    }

    if (
      Node.isIfStatement(parent) ||
      Node.isWhileStatement(parent) ||
      Node.isDoStatement(parent)
    ) {
      return parent.getExpression() === current;
    }

    if (Node.isForStatement(parent)) {
      return parent.getCondition() === current;
    }

    if (Node.isConditionalExpression(parent)) {
      return parent.getCondition() === current;
    }

    if (Node.isPrefixUnaryExpression(parent)) {
      const operator = parent.getOperatorToken();
      if (operator === ts.SyntaxKind.ExclamationToken) {
        current = parent;
        continue;
      }
    }

    if (Node.isParenthesizedExpression(parent)) {
      current = parent;
      continue;
    }

    if (Node.isBinaryExpression(parent)) {
      const operator = parent.getOperatorToken().getText();
      if (operator === '&&' || operator === '||') {
        current = parent;
        continue;
      }
    }

    if (Node.isReturnStatement(parent) && parent.getExpression() === current) {
      const ancestor = call.getFirstAncestor(Node.isFunctionLikeDeclaration);
      if (ancestor === undefined) {
        return false;
      }
      const returnTypeNode = getReturnTypeNode(ancestor);
      return returnTypeNode !== undefined && Node.isTypePredicate(returnTypeNode);
    }

    return false;
  }
}

// A direct `Array.isArray(value)` check that is immediately followed by a
// `for...of` loop whose body guards the loop variable before using it is a safe
// validation pattern. It narrows to `any[]`, but the element is checked before
// any unchecked use, so the invisible `any` does not escape.
function isSafeValidationLoop(call: CallExpression): boolean {
  const argument = call.getArguments()[0];
  if (argument === undefined) {
    return false;
  }

  // Only handle cases where the value being narrowed is a simple identifier or
  // property/element access that we can match to the for-of expression.
  let narrowedText: string;
  if (Node.isIdentifier(argument) || Node.isPropertyAccessExpression(argument) || Node.isElementAccessExpression(argument)) {
    narrowedText = argument.getText();
  } else {
    return false;
  }

  const guardInfo = findGuardIfStatement(call);
  if (guardInfo === undefined) {
    return false;
  }

  const forOf = findFollowingForOf(guardInfo, narrowedText);
  if (forOf === undefined) {
    return false;
  }

  return firstBodyStatementGuardsElement(forOf);
}

function findGuardIfStatement(call: CallExpression): { ifStatement: IfStatement; negated: boolean } | undefined {
  let current: Node = call;
  let negated = false;

  while (true) {
    const parent = current.getParent();
    if (parent === undefined) {
      return undefined;
    }

    if (Node.isPrefixUnaryExpression(parent)) {
      const operator = parent.getOperatorToken();
      if (operator === ts.SyntaxKind.ExclamationToken) {
        negated = !negated;
        current = parent;
        continue;
      }
      return undefined;
    }

    if (Node.isParenthesizedExpression(parent)) {
      current = parent;
      continue;
    }

    if (Node.isBinaryExpression(parent)) {
      const operator = parent.getOperatorToken().getText();
      if (operator === '&&' || operator === '||') {
        current = parent;
        continue;
      }
      return undefined;
    }

    if (Node.isIfStatement(parent)) {
      if (parent.getExpression() === current) {
        return { ifStatement: parent, negated };
      }
      return undefined;
    }

    return undefined;
  }
}

function findFollowingForOf(
  guardInfo: { ifStatement: IfStatement; negated: boolean },
  narrowedText: string,
): ForOfStatement | undefined {
  const { ifStatement, negated } = guardInfo;

  if (!negated) {
    return forOfInStatement(ifStatement.getThenStatement(), narrowedText);
  }

  if (!isEarlyExit(ifStatement.getThenStatement())) {
    return undefined;
  }

  const parent = ifStatement.getParent();
  if (!Node.isBlock(parent)) {
    return undefined;
  }

  const statements = parent.getStatements();
  const index = statements.findIndex((statement) => statement === ifStatement);
  for (let i = index + 1; i < statements.length; i++) {
    const statement = statements[i];
    if (statement === undefined) {
      continue;
    }
    const forOf = forOfInStatement(statement, narrowedText);
    if (forOf !== undefined) {
      return forOf;
    }
  }

  return undefined;
}

function isEarlyExit(statement: Node): boolean {
  if (Node.isReturnStatement(statement) || Node.isThrowStatement(statement)) {
    return true;
  }

  if (Node.isBlock(statement)) {
    const statements = statement.getStatements();
    // Destructured rather than indexed. `statements[0]` behind a length
    // comparison is `Statement | undefined` under noUncheckedIndexedAccess and
    // the compiler does not connect the guard to the index — our own
    // `no-unsafe-index-access` reported it, correctly.
    const [only] = statements;
    return (
      statements.length === 1 &&
      only !== undefined &&
      (Node.isReturnStatement(only) || Node.isThrowStatement(only))
    );
  }

  return false;
}

function forOfInStatement(statement: Node, narrowedText: string): ForOfStatement | undefined {
  if (Node.isForOfStatement(statement)) {
    if (statement.getExpression().getText() === narrowedText) {
      return statement;
    }
    return undefined;
  }

  if (Node.isBlock(statement)) {
    for (const child of statement.getStatements()) {
      const forOf = forOfInStatement(child, narrowedText);
      if (forOf !== undefined) {
        return forOf;
      }
    }
  }

  return undefined;
}

function firstBodyStatementGuardsElement(forOf: ForOfStatement): boolean {
  const initializer = forOf.getInitializer();
  let variableName: string | undefined;
  if (Node.isVariableDeclarationList(initializer)) {
    const declarations = initializer.getDeclarations();
    const first = declarations[0];
    if (first !== undefined) {
      variableName = first.getName();
    }
  } else if (Node.isVariableDeclaration(initializer)) {
    variableName = initializer.getName();
  } else if (Node.isIdentifier(initializer)) {
    variableName = initializer.getText();
  }

  if (variableName === undefined) {
    return false;
  }

  const body = forOf.getStatement();
  let firstStatement: Node | undefined = body;
  if (Node.isBlock(body)) {
    const statements = body.getStatements();
    firstStatement = statements[0];
  }

  if (firstStatement === undefined || !Node.isIfStatement(firstStatement)) {
    return false;
  }

  return isGuardCondition(firstStatement.getExpression(), variableName);
}

function isGuardCondition(condition: Node, variableName: string): boolean {
  if (Node.isBinaryExpression(condition)) {
    const operator = condition.getOperatorToken().getText();

    if (operator === '&&' || operator === '||') {
      return (
        isGuardCondition(condition.getLeft(), variableName) &&
        isGuardCondition(condition.getRight(), variableName)
      );
    }

    if (operator === 'in') {
      return expressionUsesVariable(condition.getRight(), variableName);
    }

    if (operator === 'instanceof') {
      return expressionUsesVariable(condition.getLeft(), variableName);
    }

    if (['===', '!==', '==', '!='].includes(operator)) {
      const left = condition.getLeft();
      const right = condition.getRight();

      if (isNullOrUndefinedLiteral(left) || isNullOrUndefinedLiteral(right)) {
        return expressionUsesVariable(left, variableName) || expressionUsesVariable(right, variableName);
      }

      if (Node.isTypeOfExpression(left) && Node.isStringLiteral(right)) {
        return true;
      }

      if (Node.isStringLiteral(left) && Node.isTypeOfExpression(right)) {
        return true;
      }
    }

    // Numeric comparisons on a guarded value are safe checks (e.g. `quantity > 0`).
    if (['<', '>', '<=', '>='].includes(operator)) {
      const left = condition.getLeft();
      const right = condition.getRight();

      if (Node.isNumericLiteral(left) && expressionUsesVariable(right, variableName)) {
        return true;
      }

      if (Node.isNumericLiteral(right) && expressionUsesVariable(left, variableName)) {
        return true;
      }
    }

    return false;
  }

  if (Node.isIdentifier(condition) && condition.getText() === variableName) {
    return true;
  }

  if (Node.isPrefixUnaryExpression(condition) && condition.getOperatorToken() === ts.SyntaxKind.ExclamationToken) {
    const operand = condition.getOperand();
    return Node.isIdentifier(operand) && operand.getText() === variableName;
  }

  if (Node.isCallExpression(condition)) {
    const callee = condition.getExpression();
    if (Node.isPropertyAccessExpression(callee) && callee.getName() === 'isArray') {
      const args = condition.getArguments();
      const first = args[0];
      return first !== undefined && expressionUsesVariable(first, variableName);
    }
  }

  return false;
}

function expressionUsesVariable(expression: Node, variableName: string): boolean {
  let current: Node = expression;

  while (
    Node.isPropertyAccessExpression(current) ||
    Node.isElementAccessExpression(current) ||
    Node.isParenthesizedExpression(current) ||
    Node.isAsExpression(current)
  ) {
    current = current.getExpression();
  }

  return Node.isIdentifier(current) && current.getText() === variableName;
}

function isNullOrUndefinedLiteral(node: Node): boolean {
  return (
    Node.isNullLiteral(node) ||
    (Node.isIdentifier(node) && node.getText() === 'undefined')
  );
}

const manifest: RuleManifest = {
  id: RULE_ID,
  category: 'type-safety',
  pack: 'strict-boundaries',
  scope: 'file',
  severity: 'error',
  evidence: 'semantic',
  summary: 'Do not use `Array.isArray` to narrow an `unknown` or `any` value to `any[]`.',
  why:
    'The built-in `Array.isArray` type predicate narrows `unknown` and `any` to `any[]`. ' +
    'The resulting binding is an `any`, and every element read from it is unchecked from then on. ' +
    'The `any` is invisible: no `any` keyword was written, the code looks like careful validation, and it type-checks. ' +
    'A hand-written guard that narrows to `unknown[]` or to an array with validated element types keeps the checks explicit.',
  allowedFixes: [
    'Replace the check with a hand-written type guard that narrows to `unknown[]` (for example, `function isUnknownArray(value: unknown): value is unknown[] { return Array.isArray(value); }`).',
    'Use a hand-written guard that validates each element type before narrowing (for example, `value is string[]` backed by `value.every((item: unknown) => typeof item === \'string\')`).',
  ],
  notFixes: [
    {
      pattern: 'Cast the narrowed value to `unknown[]` with `as` or angle brackets to recover a safe element type.',
      rule: 'no-as-cast',
      because:
        'A cast asserts the type without proof; at runtime the value is still `any[]`, and the compiler stops checking element accesses.',
    },
    {
      pattern: 'Use the non-null assertion operator `!` to treat the value as an array or an element as present.',
      rule: 'no-non-null-assertion',
      because:
        '`!` removes a check without proving the value is an array or that an element has the expected type.',
    },
    {
      pattern: 'Widen the argument to `any` so the type guard succeeds without a complaint.',
      rule: 'no-any',
      because:
        '`any` already removes type checking; making the argument `any` only hides the `Array.isArray` call in a wider untyped surface.',
    },
    {
      pattern: 'Suppress the error with `// @ts-ignore` or `// @ts-expect-error`.',
      rule: 'no-ts-comment',
      because:
        'A directive comment hides the narrowing to `any[]` without replacing it with a safe guard.',
    },
  ],
  examples: {
    bad: `declare const value: unknown;

if (Array.isArray(value)) {
  value;
}

if (!Array.isArray(value)) {
  value;
}

const result = Array.isArray(value) ? value : null;

function isAnyArray(value: unknown): value is any[] {
  return Array.isArray(value);
}`,
    good: `declare const maybeArray: string[] | string;

if (Array.isArray(maybeArray)) {
  maybeArray;
}

const isArr = Array.isArray(maybeArray);

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}`,
  },
};

function check(sourceFile: SourceFile, _options: Record<string, unknown>): Violation[] {
  const violations: Violation[] = [];
  const typeChecker = sourceFile.getProject().getTypeChecker();

  for (const node of sourceFile.getDescendants()) {
    if (!Node.isCallExpression(node)) {
      continue;
    }

    if (!isBuiltInIsArrayCall(node, typeChecker)) {
      continue;
    }

    if (!hasBroadArgument(node)) {
      continue;
    }

    if (isInsideSafeGuardFunction(node)) {
      continue;
    }

    if (!isUsedAsTypeGuard(node)) {
      continue;
    }

    if (isSafeValidationLoop(node)) {
      continue;
    }

    violations.push(makeViolation(sourceFile, node, RULE_ID, MESSAGE, 'error'));
  }

  return violations;
}

export const noUnsafeArrayNarrowing: TsRule = { manifest, check };
