import { Node, type SourceFile, type Type } from 'ts-morph';
import type { RuleManifest, Violation } from '@checkyourvibe/core';
import type { TsRule } from '../rule.js';
import { makeViolation } from '../util.js';

const RULE_ID = 'no-swallowed-catch';

const CATCH_MESSAGE =
  'Catch block neither handles nor rethrows the exception; swallowing errors hides failures and makes debugging harder.';

const REJECTION_MESSAGE =
  'Promise rejection handler neither handles nor rethrows the rejection; swallowing errors hides failures and makes debugging harder.';

function isSwallowingCatchClause(node: Node): node is import('ts-morph').CatchClause {
  if (!Node.isCatchClause(node)) {
    return false;
  }

  return isNoOpBody(node.getBlock());
}

function isPromiseLike(type: Type): boolean {
  const symbol = type.getSymbol();
  return symbol !== undefined && symbol.getName() === 'Promise';
}

function isPromiseType(type: Type): boolean {
  const nonNullable = type.getNonNullableType();
  if (isPromiseLike(nonNullable)) {
    return true;
  }

  if (nonNullable.isUnion()) {
    return nonNullable.getUnionTypes().some(isPromiseLike);
  }

  return false;
}

function isLiteralExpression(node: Node): boolean {
  return (
    Node.isLiteralExpression(node) ||
    Node.isTrueLiteral(node) ||
    Node.isFalseLiteral(node) ||
    Node.isNullLiteral(node)
  );
}

/**
 * Whether an expression is provably free of side effects. Reading a variable
 * or a literal does nothing observable; anything that calls, assigns, throws,
 * or constructs can change program state and must not be treated as a no-op.
 */
function isEffectFreeExpression(node: Node): boolean {
  if (Node.isIdentifier(node) || isLiteralExpression(node)) {
    return true;
  }

  if (Node.isParenthesizedExpression(node)) {
    return isEffectFreeExpression(node.getExpression());
  }

  if (Node.isVoidExpression(node)) {
    return isEffectFreeExpression(node.getExpression());
  }

  if (Node.isNonNullExpression(node) || Node.isAsExpression(node) || Node.isTypeAssertion(node)) {
    return isEffectFreeExpression(node.getExpression());
  }

  if (Node.isSatisfiesExpression(node)) {
    return isEffectFreeExpression(node.getExpression());
  }

  return false;
}

function isNoOpStatement(statement: Node): boolean {
  if (Node.isEmptyStatement(statement)) {
    return true;
  }

  if (Node.isContinueStatement(statement) || Node.isBreakStatement(statement)) {
    return true;
  }

  if (Node.isReturnStatement(statement) && statement.getExpression() === undefined) {
    return true;
  }

  if (Node.isExpressionStatement(statement) && isEffectFreeExpression(statement.getExpression())) {
    return true;
  }

  return false;
}

function isNoOpBody(body: Node): boolean {
  if (!Node.isBlock(body)) {
    return false;
  }

  for (const statement of body.getStatements()) {
    if (!isNoOpStatement(statement)) {
      return false;
    }
  }

  return true;
}

function asFunctionLiteral(
  node: Node,
): import('ts-morph').ArrowFunction | import('ts-morph').FunctionExpression | undefined {
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    return node;
  }

  if (
    Node.isParenthesizedExpression(node) ||
    Node.isAsExpression(node) ||
    Node.isNonNullExpression(node) ||
    Node.isSatisfiesExpression(node)
  ) {
    return asFunctionLiteral(node.getExpression());
  }

  return undefined;
}

function getRejectionHandler(
  node: import('ts-morph').CallExpression,
): Node | undefined {
  const expression = node.getExpression();
  if (!Node.isPropertyAccessExpression(expression)) {
    return undefined;
  }

  const name = expression.getName();
  const args = node.getArguments();

  if (name === 'catch') {
    return args[0];
  }

  if (name === 'then') {
    return args[1];
  }

  return undefined;
}

function isNoOpPromiseRejectionHandler(node: Node): node is import('ts-morph').CallExpression {
  if (!Node.isCallExpression(node)) {
    return false;
  }

  const expression = node.getExpression();
  if (!Node.isPropertyAccessExpression(expression)) {
    return false;
  }

  const receiver = expression.getExpression();
  if (!isPromiseType(receiver.getType())) {
    return false;
  }

  const handler = getRejectionHandler(node);
  if (handler === undefined) {
    return false;
  }

  const literal = asFunctionLiteral(handler);
  if (literal === undefined) {
    return false;
  }

  const body = literal.getBody();
  return isNoOpBody(body);
}

const manifest: RuleManifest = {
  id: RULE_ID,
  category: 'reliability',
  pack: 'core-ts',
  evidence: 'semantic',
  scope: 'file',
  severity: 'error',
  summary: 'Do not use a catch block or promise rejection handler that neither handles nor rethrows the error.',
  why:
    'A catch clause or promise rejection handler that is empty or does nothing observable with the error swallows the failure. ' +
    'The program continues as if nothing failed, so the failure is invisible to logs, metrics, and the caller. ' +
    'This makes crashes harder to diagnose and allows corrupted state to propagate. ' +
    'Promise rejection handlers need the type checker to confirm the receiver is a real Promise; matching the method name alone would flag every object with a catch or then method.',
  allowedFixes: [
    'Rethrow the exception, optionally wrapped with additional context.',
    'Handle the error by logging it through the application\'s own logging abstraction and then returning a safe fallback or exiting.',
    'Replace the catch with a typed error boundary or recovery function that the caller can observe.',
    'If the exception is truly unrecoverable, move the operation to a context where failure is reported, not swallowed.',
    'For a promise rejection handler, log or rethrow the rejected value, or return a meaningful fallback the caller can observe.',
  ],
  notFixes: [
    {
      pattern: 'Annotate the catch variable as `any` to avoid having to narrow it.',
      rule: 'no-any',
      because:
        'It removes type information and lets the error pass through untouched; the catch block is still swallowing the exception.',
    },
    {
      pattern: 'Cast the caught error to a concrete type and leave the block otherwise empty.',
      rule: 'no-as-cast',
      because:
        'A cast asserts a type without proof and does not change the fact that the exception is being ignored.',
    },
    {
      pattern: 'Add a comment inside the catch block explaining why the exception is ignored.',
      because:
        'A comment does not handle or rethrow the exception; the rule still reports an empty or comment-only catch block.',
    },
    {
      pattern: 'Assign the error to a local variable and leave it unused.',
      because:
        'The block still does not handle or rethrow the exception; it only silences an unused-variable warning.',
    },
    {
      pattern: 'Replace the empty catch with a catch that immediately rethrows the same error',
      rule: 'no-broad-catch-rethrow',
      because:
        'Rethrowing the caught error unchanged adds a stack frame without adding context or handling; the exception was already going to propagate.',
    },
  ],
  examples: {
    bad: `function load() {
  try {
    return fetchData();
  } catch {}
}

function save() {
  try {
    writeData();
  } catch (e) {
    /* ignore */
  }
}

declare function getUser(): Promise<string>;
declare function onFulfilled(value: string): void;

function silence() {
  getUser().catch(() => {});
  getUser().catch(function() {});
  getUser().then(onFulfilled, () => {});
}`,
    good: `function load() {
  try {
    return fetchData();
  } catch (e) {
    throw new Error('failed to load data', { cause: e });
  }
}

function save() {
  try {
    writeData();
  } catch (e) {
    logError('save failed', e);
    return { ok: false };
  }
}

declare function getUser(): Promise<string>;
declare function onFulfilled(value: string): void;
declare function reportError(err: unknown): void;

function handle() {
  getUser().catch((err) => {
    reportError(err);
  });
  getUser().then(onFulfilled, (err) => {
    reportError(err);
  });
}`,
  },
};

function check(sourceFile: SourceFile, _options: Record<string, unknown>): Violation[] {
  const violations: Violation[] = [];

  for (const node of sourceFile.getDescendants()) {
    if (isSwallowingCatchClause(node)) {
      violations.push(makeViolation(sourceFile, node, RULE_ID, CATCH_MESSAGE, 'error'));
      continue;
    }

    if (isNoOpPromiseRejectionHandler(node)) {
      violations.push(makeViolation(sourceFile, node, RULE_ID, REJECTION_MESSAGE, 'error'));
    }
  }

  return violations;
}

export const noEmptyCatch: TsRule = { manifest, check };
