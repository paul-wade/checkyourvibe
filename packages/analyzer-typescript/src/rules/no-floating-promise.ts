import {
  Node,
  type CallExpression,
  type NewExpression,
  type SourceFile,
  type Type,
} from 'ts-morph';
import type { RuleManifest, Violation } from '@checkyourvibe/core';
import type { TsRule } from '../rule.js';
import { makeViolation } from '../util.js';

const RULE_ID = 'no-floating-promise';

const MESSAGE =
  'The promise returned by this call is not awaited, returned, assigned, or explicitly handled; a rejection will become an unhandled rejection at an unrelated moment.';

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

function returnsPromise(node: CallExpression | NewExpression): boolean {
  return isPromiseType(node.getType());
}

function isExplicitlyHandledChain(node: CallExpression): boolean {
  const expression = node.getExpression();
  if (!Node.isPropertyAccessExpression(expression)) {
    return false;
  }

  const name = expression.getName();
  if (name === 'catch') {
    return true;
  }

  if (name === 'then') {
    // A `.then` with an onRejected handler is an explicit rejection handler;
    // `.then` with only an onFulfilled handler is not.
    return node.getArguments().length >= 2;
  }

  return false;
}


/**
 * Walk up the tree from `node` to the nearest statement or consuming ancestor,
 * deciding whether the value of the promise call is actually handled.
 *
 * The promise call may be part of a chain (`a().then(...)`). In that case the
 * outer call is the candidate to evaluate; the inner call is consumed by the
 * chain and should not be reported.
 */
function isHandled(node: CallExpression | NewExpression): boolean {
  let current: Node = node;

  while (true) {
    const parent = current.getParent();
    if (parent === undefined) {
      return true; // No parent is odd, but do not report a floating promise.
    }

    // Await consumes the promise.
    if (Node.isAwaitExpression(parent)) {
      return true;
    }

    // Returning or assigning the promise consumes it.
    if (Node.isReturnStatement(parent)) {
      return true;
    }

    if (Node.isVariableDeclaration(parent) && parent.getInitializer() === current) {
      return true;
    }

    if (Node.isBinaryExpression(parent) && parent.getRight() === current) {
      const op = parent.getOperatorToken().getText();
      if (op === '=' || op === '??=' || op === '||=' || op === '&&=') {
        return true;
      }
    }

    // The promise is passed into another call or collection, so it is consumed
    // by that expression. The outer expression may itself be floating, but this
    // call is not.
    if (Node.isCallExpression(parent) || Node.isNewExpression(parent)) {
      if (parent.getArguments().some((arg) => arg === current)) {
        return true;
      }
    }

    if (
      Node.isArrayLiteralExpression(parent) ||
      Node.isObjectLiteralExpression(parent) ||
      Node.isSpreadElement(parent)
    ) {
      return true;
    }

    // `void promise` is an explicit, deliberate discard, but only if the
    // author documents why it is safe to ignore the promise. A bare `void`
    // operator looks intentional yet gives the next reader no evidence of that.
    if (Node.isVoidExpression(parent) && parent.getExpression() === current) {
      const statement = parent.getParent();
      if (statement !== undefined && Node.isExpressionStatement(statement)) {
        return statement.getTrailingCommentRanges().length > 0;
      }
      return false;
    }

    // A property access uses the inner call as the object of the access. The
    // inner promise is consumed by that access; the outer call (if any) is a
    // separate promise that this analyzer will evaluate on its own.
    if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === current) {
      return true;
    }

    // Parentheses do not consume the value.
    if (Node.isParenthesizedExpression(parent) && parent.getExpression() === current) {
      current = parent;
      continue;
    }

    // A conditional or loop condition uses the promise as a boolean. A Promise
    // is always truthy, so the condition is a mistake and the rejection is
    // unhandled.
    if (
      Node.isIfStatement(parent) ||
      Node.isWhileStatement(parent) ||
      Node.isDoStatement(parent) ||
      Node.isForStatement(parent) ||
      Node.isSwitchStatement(parent)
    ) {
      return false;
    }

    // A conditional expression uses the promise as its condition or as one of
    // its branches. Continue up to see whether the whole expression is handled.
    if (Node.isConditionalExpression(parent)) {
      current = parent;
      continue;
    }

    // Binary or unary operations use the promise as an operand. Continue up to
    // see whether the whole expression is handled.
    if (Node.isBinaryExpression(parent) || Node.isPrefixUnaryExpression(parent) || Node.isPostfixUnaryExpression(parent)) {
      current = parent;
      continue;
    }

    // Expression statement: the value of the expression is discarded. If the
    // expression is the promise call itself, the promise is floating unless it
    // is handled by `.catch` or a two-argument `.then`.
    if (Node.isExpressionStatement(parent)) {
      return Node.isCallExpression(current) && isExplicitlyHandledChain(current);
    }

    // Any other parent (e.g., a JSX expression, a template span) does not
    // handle the promise by itself; continue up to the next context.
    current = parent;
  }
}

function isFloatingPromise(node: CallExpression | NewExpression): boolean {
  return returnsPromise(node) && !isHandled(node);
}

const manifest: RuleManifest = {
  id: RULE_ID,
  category: 'reliability',
  pack: 'core-ts',
  evidence: 'semantic',
  scope: 'file',
  severity: 'error',
  summary: 'Do not leave a promise unhandled; await it, return it, assign it, or explicitly handle it.',
  why:
    'A call that returns a Promise represents work that may fail asynchronously. If the result is not awaited, returned, stored, or explicitly handled, a rejection becomes an unhandled rejection at a later, unrelated point in the program. The type checker is the only way to know whether a call returns a Promise, so this rule is semantic.',
  allowedFixes: [
    'Await the promise with `await`.',
    'Return the promise so the caller can await it.',
    'Assign the promise to a variable and attach a rejection handler.',
    'Attach a rejection handler with `.catch(...)` or `.then(onFulfilled, onRejected)`.',
    'Pass the promise to a consumer such as `Promise.all` and await the combined result.',
    'If the fire-and-forget is intentional, explicitly discard the result with the `void` operator and a comment explaining why.',
  ],
  notFixes: [
    {
      pattern: 'Cast the promise to `void` or a non-promise type with `as`',
      rule: 'no-as-cast',
      because:
        'A cast does not await or handle the promise; it only hides the return type from the type checker, and the rejection is still unhandled.',
    },
    {
      pattern: 'Annotate the surrounding function or variable as `any` so the Promise type is ignored',
      rule: 'no-any',
      because:
        '`any` removes type information and hides the promise from this rule, but the unhandled rejection still happens at runtime.',
    },
    {
      pattern: 'Suppress the finding with a compiler-directive comment',
      rule: 'no-ts-comment',
      because:
        'A directive comment hides the unhandled promise without adding an `await`, a handler, or an explicit discard.',
    },
    {
      pattern: 'Wrap the call in a try/catch with an empty catch block',
      rule: 'no-swallowed-catch',
      because:
        'A try/catch around an async call cannot catch a promise rejection that happens later; an empty catch swallows synchronous errors and leaves the promise unhandled.',
    },
    {
      pattern: 'Rethrow the caught error unchanged from a catch block',
      rule: 'no-broad-catch-rethrow',
      because:
        'Rethrowing the same error from a catch adds a stack frame without handling the unhandled promise; the promise is still floating.',
    },
    {
      pattern: 'Use `.then(...)` with only an onFulfilled handler',
      because:
        'A single-argument `.then` does not handle rejections; the promise it returns is still unhandled if the original promise rejects.',
    },
    {
      pattern: 'Attach an empty `.catch(() => {})` handler to silence the rejection',
      rule: 'no-swallowed-catch',
      because:
        'The rejection is caught and discarded, so the failure is now invisible instead of loud, which is worse than the floating promise was.',
    },
    {
      pattern: 'Pass the promise to `Promise.all` and ignore the returned promise',
      because:
        '`Promise.all([...])` returns a new promise; if that promise is not awaited or handled, the combined result is still floating.',
    },
    {
      pattern: 'Use the `void` operator to discard the promise but omit an explanatory comment',
      because:
        'A bare `void` operator hides intent from the next reader and offers no evidence that the fire-and-forget was considered; the rule allows `void` only when the expression statement has a trailing comment explaining why.',
    },
  ],
  examples: {
    bad: `declare function fetchData(): Promise<void>;
declare function getUser(): Promise<string>;

fetchData();
getUser().then(console.log);
getUser().finally(() => {});
Promise.all([fetchData()]);
void fetchData();`,
    good: `declare function fetchData(): Promise<void>;
declare function getUser(): Promise<string>;
declare function reportError(err: unknown): void;

async function run() {
  await fetchData();
  await getUser();
}

function runAll() {
  return Promise.all([fetchData(), getUser()]);
}

getUser().catch((err) => {
  reportError(err);
});

void fetchData(); // intentionally fire-and-forget, explained here`,
  },
};

function check(sourceFile: SourceFile, _options: Record<string, unknown>): Violation[] {
  const violations: Violation[] = [];

  for (const node of sourceFile.getDescendants()) {
    if (!Node.isCallExpression(node) && !Node.isNewExpression(node)) {
      continue;
    }

    if (isFloatingPromise(node)) {
      violations.push(makeViolation(sourceFile, node, RULE_ID, MESSAGE, 'error'));
    }
  }

  return violations;
}

export const noFloatingPromise: TsRule = { manifest, check };
