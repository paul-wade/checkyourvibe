import { Node, type SourceFile } from 'ts-morph';
import type { RuleManifest, Violation } from '@checkyourvibe/core';
import type { TsRule } from '../rule.js';
import { makeViolation } from '../util.js';

const RULE_ID = 'no-tautological-assertion';

const MESSAGE =
  'This assertion compares a value to an identical value, so the source text already settles its ' +
  'outcome; it does not exercise the code under test.';

const TEST_FILE_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx'];

function isTestFileName(baseName: string): boolean {
  for (const suffix of TEST_FILE_SUFFIXES) {
    if (baseName.endsWith(suffix)) {
      return true;
    }
  }
  return false;
}

function isLiteral(node: Node): boolean {
  return (
    Node.isStringLiteral(node) ||
    Node.isNumericLiteral(node) ||
    Node.isTrueLiteral(node) ||
    Node.isFalseLiteral(node) ||
    Node.isNullLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node) ||
    Node.isBigIntLiteral(node)
  );
}

/**
 * Whether an expression is provably free of side effects. Reading a variable
 * or a literal does nothing observable; anything that calls, assigns, throws,
 * or constructs can change program state and must not be treated as a no-op.
 *
 * This reuses the same line no-swallowed-catch drew, because the question is
 * the same: can this expression read a different value or produce an effect on
 * each evaluation?
 */
function isEffectFreeExpression(node: Node): boolean {
  if (Node.isIdentifier(node) || isLiteral(node)) {
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

/**
 * Strip effect-preserving wrappers from an expression so two occurrences can
 * be compared by their base value. A cast, non-null assertion, parenthesis,
 * `void` or `satisfies` does not change the runtime value.
 */
function getBaseExpression(node: Node): Node {
  if (Node.isParenthesizedExpression(node)) {
    return getBaseExpression(node.getExpression());
  }

  if (
    Node.isVoidExpression(node) ||
    Node.isNonNullExpression(node) ||
    Node.isAsExpression(node) ||
    Node.isTypeAssertion(node) ||
    Node.isSatisfiesExpression(node)
  ) {
    return getBaseExpression(node.getExpression());
  }

  return node;
}

function getLiteralValue(node: Node): string | number | boolean | null | undefined {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralValue();
  }

  if (Node.isNumericLiteral(node)) {
    return node.getLiteralValue();
  }

  if (Node.isTrueLiteral(node) || Node.isFalseLiteral(node)) {
    return node.getLiteralValue();
  }

  if (Node.isNullLiteral(node)) {
    return null;
  }

  if (Node.isBigIntLiteral(node)) {
    return node.getText();
  }

  return undefined;
}

function sameBaseValue(left: Node, right: Node): boolean {
  if (Node.isIdentifier(left) && Node.isIdentifier(right)) {
    return left.getText() === right.getText();
  }

  const leftValue = getLiteralValue(left);
  const rightValue = getLiteralValue(right);

  return leftValue !== undefined && rightValue !== undefined && leftValue === rightValue;
}

function sameEffectFreeExpression(left: Node, right: Node): boolean {
  if (!isEffectFreeExpression(left) || !isEffectFreeExpression(right)) {
    return false;
  }

  return sameBaseValue(getBaseExpression(left), getBaseExpression(right));
}

/**
 * Names that introduce an assertion: the function a test calls to start one.
 *
 * These sets are the difference between a rule and a shape matcher. An earlier
 * version checked no names, on the stated reasoning that the shape of an
 * assertion is distinctive on its own. Complete enumeration on a typeorm clone
 * measured all 39 findings false: `.take(3).skip(3)`, `.from("qaz", "qaz")`,
 * `.leftJoinAndSelect("category", "category")`, `.of(2).add(2)`,
 * `cache.storeInCache(options, options)`, and `VersionUtils.isGreaterOrEqual("1", "1")`
 * all share the shape and none is an assertion. Deleting the name check restores
 * that result.
 */
const ASSERTION_ENTRY_NAMES: ReadonlySet<string> = new Set([
  'expect',
  'assert',
  'should',
  'chai',
  'must',
]);

/**
 * Names of assertion methods that compare two operands for equality.
 *
 * Only equality is listed. The rule's claim is that comparing a value to an
 * identical value settles the outcome before the code under test runs, and that
 * claim holds for equality and its negation but not for containment, matching,
 * or ordering, where two identical operands can still go either way.
 *
 * Names are compared lowercased and whole, never as substrings: `isGreaterOrEqual`
 * ends in `Equal` and is not an assertion.
 */
const EQUALITY_ASSERTION_NAMES: ReadonlySet<string> = new Set([
  'tobe',
  'toequal',
  'tostrictequal',
  'todeepequal',
  'equal',
  'equals',
  'eql',
  'eqls',
  'strictequal',
  'strictequals',
  'deepequal',
  'deepequals',
  'deepstrictequal',
  'deepstrictequals',
  'notequal',
  'notequals',
  'notstrictequal',
  'notdeepequal',
  'notdeepstrictequal',
  'same',
  'strictsame',
  'notsame',
  'assertequal',
  'assertequals',
  'assertstrictequals',
  'assertnotequals',
]);

function isAssertionVocabulary(name: string): boolean {
  const lower = name.toLowerCase();
  return ASSERTION_ENTRY_NAMES.has(lower) || EQUALITY_ASSERTION_NAMES.has(lower);
}

/** The name a call is made through: `expect` for both `expect(x)` and `chai.expect(x)`. */
function getCalleeName(callee: Node): string | undefined {
  if (Node.isIdentifier(callee)) {
    return callee.getText();
  }

  if (Node.isPropertyAccessExpression(callee)) {
    return callee.getName();
  }

  return undefined;
}

/**
 * Whether an expression is a plain name path: an identifier, or a chain of
 * property accesses rooted at one, such as `assert` or `assert.strict`.
 *
 * A call anywhere in the chain means the receiver was produced at run time, as
 * in `expect(actual).to.be`, where the two arguments that follow are an expected
 * value and a failure message rather than two operands of a comparison.
 */
function isPlainNamePath(node: Node): boolean {
  if (Node.isIdentifier(node) || Node.isThisExpression(node)) {
    return true;
  }

  if (Node.isPropertyAccessExpression(node)) {
    return isPlainNamePath(node.getExpression());
  }

  return false;
}

interface ReceiverCall {
  call: Node;
  /** How many properties were read between the call and the matcher. */
  depth: number;
}

/**
 * The call that produced a matcher's receiver, looking through the property
 * chain assertion libraries put in between.
 *
 * `expect(x).toBe(y)` reaches the call in one step; `expect(x).to.equal(y)` and
 * `expect(x).to.be.eql(y)` reach it through chai's connecting properties.
 *
 * The depth is returned because reading a property is not always a connector.
 * In `dataSource.getRepository(Post).target.should.be.eql(Post)` the same
 * descent reaches `getRepository(Post)`, but the value under test is `.target`
 * and the assertion is real; only the caller can tell the two apart.
 */
function getReceiverCall(node: Node, depth: number): ReceiverCall | undefined {
  if (Node.isCallExpression(node)) {
    return { call: node, depth };
  }

  if (Node.isPropertyAccessExpression(node)) {
    return getReceiverCall(node.getExpression(), depth + 1);
  }

  return undefined;
}

/**
 * The shape `expect(actual).matcher(expected)` where both `actual` and
 * `expected` are the same effect-free expression, and either the matcher or the
 * function that produced the receiver is named like an assertion.
 */
function isTautologicalChainedAssertion(node: Node): boolean {
  if (!Node.isCallExpression(node)) {
    return false;
  }

  const outerArguments = node.getArguments();
  if (outerArguments.length !== 1) {
    return false;
  }

  const outerExpression = node.getExpression();
  if (!Node.isPropertyAccessExpression(outerExpression)) {
    return false;
  }

  const receiver = getReceiverCall(outerExpression.getExpression(), 0);
  if (receiver === undefined) {
    return false;
  }

  const innerCall = receiver.call;
  if (!Node.isCallExpression(innerCall)) {
    return false;
  }

  const innerArguments = innerCall.getArguments();
  if (innerArguments.length !== 1) {
    return false;
  }

  const innerName = getCalleeName(innerCall.getExpression());
  const innerIsEntryPoint =
    innerName !== undefined && ASSERTION_ENTRY_NAMES.has(innerName.toLowerCase());

  // Anything read between the call and the matcher may be the value under test
  // rather than a connector, so a chain is only followed back to a call that
  // hands its argument straight to an assertion. `expect(0).to.eql(0)` qualifies;
  // `dataSource.getRepository(Post).target.should.be.eql(Post)` does not, and it
  // asserts something real.
  if (receiver.depth > 0 && !innerIsEntryPoint) {
    return false;
  }

  const namedLikeAnAssertion =
    isAssertionVocabulary(outerExpression.getName()) ||
    (innerName !== undefined && isAssertionVocabulary(innerName));
  if (!namedLikeAnAssertion) {
    return false;
  }

  const actual = innerArguments[0];
  const expected = outerArguments[0];
  if (actual === undefined || expected === undefined) {
    return false;
  }

  return sameEffectFreeExpression(actual, expected);
}

/**
 * The shape `assert.equal(actual, expected)` where both arguments are the same
 * effect-free expression.
 *
 * The method must be named for an equality assertion and must be reached through
 * a plain name path — `assert.equal`, `assert.strict.equal`, `chai.assert.deepEqual`.
 * Both conditions are load-bearing. Without the name, the shape matches ordinary
 * fluent APIs; without the plain path, it matches `expect(actual).to.be.equal(expected, message)`,
 * where the repeated operand is chai's failure message and the value under test
 * is inside the receiver.
 */
function isTautologicalTwoArgumentAssertion(node: Node): boolean {
  if (!Node.isCallExpression(node)) {
    return false;
  }

  const argumentsList = node.getArguments();
  if (argumentsList.length !== 2) {
    return false;
  }

  const callee = node.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) {
    return false;
  }

  if (!EQUALITY_ASSERTION_NAMES.has(callee.getName().toLowerCase())) {
    return false;
  }

  if (!isPlainNamePath(callee.getExpression())) {
    return false;
  }

  const [actual, expected] = argumentsList;
  if (actual === undefined || expected === undefined) {
    return false;
  }

  return sameEffectFreeExpression(actual, expected);
}

function isTautologicalAssertion(node: Node): boolean {
  return isTautologicalChainedAssertion(node) || isTautologicalTwoArgumentAssertion(node);
}

const manifest: RuleManifest = {
  id: RULE_ID,
  category: 'test-quality',
  pack: 'test-quality',
  evidence: 'syntax',
  scope: 'file',
  severity: 'error',
  summary:
    'Do not write an assertion that compares a value to itself, whose outcome the source text ' +
    'already settles.',
  why:
    'An assertion whose left and right sides are the same literal, the same identifier, or the same ' +
    'effect-preserving expression on the same identifier has its verdict fixed before the test runs: ' +
    'an equality check always passes and its negation always fails. Either way it says nothing about ' +
    'the code under test and gives a false sense of coverage. The rule fires only when both operands are ' +
    'provably the same value from syntax alone AND the call is named like an assertion: an assertion ' +
    'entry point (expect, assert, should) or an equality method (toBe, toEqual, equal, eql, ' +
    'strictEqual, deepEqual and their negations). ' +
    'An earlier version matched the shape alone — an inner call feeding a one-argument member call, ' +
    'or any two-argument method call — on the reasoning that the shape belongs to no particular test ' +
    'library. Complete enumeration on a typeorm clone measured that reasoning false: all 39 findings ' +
    'were wrong, every one an ordinary fluent API sharing the shape (.take(3).skip(3), ' +
    '.from("qaz", "qaz"), .leftJoinAndSelect("category", "category"), .of(2).add(2), ' +
    'cache.storeInCache(options, options)) or a deliberate test input ' +
    '(VersionUtils.isGreaterOrEqual("1", "1")). The name check is what makes the shape distinctive; ' +
    'removing it returns the rule to 100% false positives.',
  allowedFixes: [
    'Replace the tautology with a real assertion: compare the result of the code under test to a ' +
      'computed, expected, or fixture value.',
    'If the assertion is a placeholder, delete it and write a test that exercises the function being tested.',
    'For a self-comparison such as `expect(x).toBe(x)`, consider what property of `x` is actually ' +
      'meant to be checked and assert that instead (length, presence, a specific field, a computed transform).',
  ],
  notFixes: [
    {
      pattern: 'Delete the tautological assertion and leave the test otherwise unchanged',
      because:
        'It removes the only check the test had, leaving an assertion-free test. That is not an improvement, ' +
        'even though the matching rule (no-assertion-free-test) is not implemented yet.',
    },
    {
      pattern: 'Replace `expect(x).toBe(x)` with `expect(x).toBeDefined()` or `expect(x).toBeTruthy()`',
      because:
        'These assertions check only that `x` is present or truthy, not that it has the right value, and no ' +
        'rule in this analyzer currently catches that weaker assertion.',
    },
    {
      pattern: 'Cast one side with `as` or assert non-null with `!` to make the two expressions look different',
      rule: 'no-as-cast',
      because:
        'Casts and non-null assertions are effect-free wrappers; they do not change the runtime value, so ' +
        'the comparison is still tautological, and `no-as-cast` or `no-non-null-assertion` will report the wrapper.',
    },
    {
      pattern: 'Cast the other side with `as` or assert non-null with `!`',
      rule: 'no-non-null-assertion',
      because:
        'The same value is still being compared to itself; the wrapper only hides the tautology and trips ' +
        '`no-non-null-assertion` instead.',
    },
  ],
  examples: {
    bad: `it('cannot fail', () => {
  expect(true).toBe(true);
  expect(1).toBe(1);
  expect('x').toBe('x');
  const retries = 3;
  expect(retries).toBe(retries);
  assert.equal('x', 'x');
  expect(0).to.eql(0);
});`,
    good: `it('checks real values', () => {
  const value = compute();
  expect(value).toBe(3);
  expect(fn()).toBe(fn());
  expect(result).toMatchSnapshot();
});`,
  },
};

function check(sourceFile: SourceFile, _options: Record<string, unknown>): Violation[] {
  if (!isTestFileName(sourceFile.getBaseName())) {
    return [];
  }

  const violations: Violation[] = [];

  for (const node of sourceFile.getDescendants()) {
    if (isTautologicalAssertion(node)) {
      violations.push(makeViolation(sourceFile, node, RULE_ID, MESSAGE, 'error'));
    }
  }

  return violations;
}

export const noTautologicalAssertion: TsRule = { manifest, check };
