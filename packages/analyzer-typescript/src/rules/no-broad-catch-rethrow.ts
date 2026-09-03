import { Node, type SourceFile } from 'ts-morph';
import type { RuleManifest, Violation } from '@checkyourvibe/core';
import type { TsRule } from '../rule.js';
import { makeViolation } from '../util.js';

const RULE_ID = 'no-broad-catch-rethrow';

const MESSAGE =
  'Catch clause catches an exception and immediately rethrows the same value unchanged; this adds a stack frame and hides nothing.';

function isRethrowOfVariable(statement: Node, variableName: string): boolean {
  if (!Node.isThrowStatement(statement)) {
    return false;
  }

  const expression = statement.getExpression();
  return expression !== undefined && Node.isIdentifier(expression) && expression.getText() === variableName;
}

function isBroadCatchRethrow(node: Node): node is import('ts-morph').CatchClause {
  if (!Node.isCatchClause(node)) {
    return false;
  }

  const variableDeclaration = node.getVariableDeclaration();
  if (variableDeclaration === undefined) {
    // `catch { throw; }` is not valid TypeScript, and a catch without a
    // variable cannot rethrow the original exception unchanged.
    return false;
  }

  const block = node.getBlock();
  const statements = block.getStatements();

  // Allow only a single throw statement. Any extra code, even a comment that
  // survives as a statement, means the catch is doing something more than an
  // immediate rethrow.
  if (statements.length !== 1) {
    return false;
  }

  const firstStatement = statements[0];
  if (firstStatement === undefined) {
    return false;
  }

  return isRethrowOfVariable(firstStatement, variableDeclaration.getName());
}

const manifest: RuleManifest = {
  id: RULE_ID,
  category: 'reliability',
  pack: 'core-ts',
  evidence: 'syntax',
  scope: 'file',
  severity: 'error',
  summary: 'Do not catch an exception only to throw the same value unchanged.',
  why:
    'A catch block that immediately rethrows the caught value adds a stack frame and an extra control-flow hop without adding context or filtering. The original exception already propagates; the catch is either a no-op or a sign that the author intended to add handling but forgot.',
  allowedFixes: [
    'Remove the catch clause and let the exception propagate directly.',
    'If cleanup is needed, keep a `finally` block and remove the catch/rethrow.',
    'Rethrow with added context using `new Error("...", { cause: e })`.',
    'Catch only specific, recoverable errors and handle them instead of rethrowing.',
  ],
  notFixes: [
    {
      pattern: 'Add a comment inside the catch block explaining why the exception is rethrown',
      because:
        'A comment does not remove the extra catch frame or add information; the exception still propagates through an unnecessary catch.',
    },
    {
      pattern: 'Annotate the catch variable as `any`',
      rule: 'no-any',
      because:
        'It removes type information from the caught error without changing the fact that the catch block does nothing but rethrow.',
    },
    {
      pattern: 'Cast the caught error with `as` before rethrowing',
      rule: 'no-as-cast',
      because:
        'A cast asserts a type without proof; the exception is still rethrown unchanged and the catch frame still adds nothing.',
    },
    {
      pattern: 'Remove the `throw` and leave the catch block empty',
      rule: 'no-swallowed-catch',
      because:
        'An empty catch swallows the exception entirely, which is a different and usually worse failure than a useless rethrow.',
    },
    {
      pattern: 'Suppress the finding with a compiler-directive comment',
      rule: 'no-ts-comment',
      because:
        'A directive comment hides the useless catch without removing it, so the extra frame and obscured stack remain.',
    },
  ],
  examples: {
    bad: `function load() {
  try {
    return fetchData();
  } catch (e) {
    throw e;
  }
}`,
    good: `function load() {
  try {
    return fetchData();
  } catch (e) {
    throw new Error('failed to load data', { cause: e });
  }
}

function load() {
  try {
    return fetchData();
  } finally {
    // cleanup runs whether or not the call throws
  }
}`,
  },
};

function check(sourceFile: SourceFile, _options: Record<string, unknown>): Violation[] {
  const violations: Violation[] = [];

  for (const node of sourceFile.getDescendants()) {
    if (isBroadCatchRethrow(node)) {
      violations.push(makeViolation(sourceFile, node, RULE_ID, MESSAGE, 'error'));
    }
  }

  return violations;
}

export const noBroadCatchRethrow: TsRule = { manifest, check };
