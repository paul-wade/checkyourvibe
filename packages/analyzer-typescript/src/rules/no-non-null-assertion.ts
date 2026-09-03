import { Node, type SourceFile } from 'ts-morph';
import type { RuleManifest, Violation } from '@checkyourvibe/core';
import type { TsRule } from '../rule.js';
import { makeViolation, makeViolationAt } from '../util.js';

const ruleId = 'no-non-null-assertion';

/**
 * The position of the `!` that ends a non-null assertion.
 *
 * The operator is the last character of the expression, before any trailing
 * trivia. `getEnd()` is exclusive, so the token starts one before it.
 */
function exclamationTokenStart(node: Node): number {
  return node.getEnd() - 1;
}

function visit(sourceFile: SourceFile): Violation[] {
  const violations: Violation[] = [];

  sourceFile.forEachDescendant((node) => {
    if (Node.isNonNullExpression(node)) {
      // Reported at the `!` rather than at the start of the asserted
      // expression. A chain such as `table!.findColumnByName(name)!.type!`
      // contains three assertions whose expressions all begin at `table`, so
      // reporting the expression start gave all three the same position and
      // the same identity.
      violations.push(
        makeViolationAt(
          sourceFile,
          node,
          exclamationTokenStart(node),
          ruleId,
          'Non-null assertion (!) assumes a value is present without checking it.',
          'error',
        ),
      );
      return;
    }

    if (Node.isPropertyDeclaration(node) && node.hasExclamationToken()) {
      violations.push(
        makeViolation(
          sourceFile,
          node,
          ruleId,
          'Definite assignment assertion (!) on a property claims a value is present without verification at declaration time.',
          'error',
        ),
      );
      return;
    }

    if (Node.isVariableDeclaration(node) && node.hasExclamationToken()) {
      violations.push(
        makeViolation(
          sourceFile,
          node,
          ruleId,
          'Definite assignment assertion (!) on a variable claims a value is present without verification at declaration time.',
          'error',
        ),
      );
    }
  });

  return violations;
}

const manifest: RuleManifest = {
  id: ruleId,
  category: 'type-safety',
  pack: 'core-ts',
  evidence: 'syntax',
  scope: 'file',
  severity: 'error',
  summary:
    "Do not use the non-null assertion operator `!` or definite assignment assertions `!` to silence the type checker.",
  why:
    "The `!` operator and the definite assignment assertion both tell the compiler to trust that a value will be present. They remove a safety check without adding any verification. If the assumption is wrong, the program fails at runtime and the type system offers no guidance toward the fix. Asserting the same thing on a field declaration instead of a use site does not make the claim safer; it only moves the unverified assumption earlier.",
  allowedFixes: [
    'Narrow the value with an explicit check, such as `if (value !== undefined)`, before using it.',
    'Initialize the field in a constructor so it is genuinely assigned before use.',
    'Give the field a default value that is valid for its type.',
    'Model genuine absence as an optional property and handle the missing case explicitly.',
    'Use a nullish-coalescing fallback (`?? defaultValue`) where a default is the right behaviour.',
  ],
  notFixes: [
    {
      pattern: 'Cast the value to the desired type instead',
      because:
        'A cast also bypasses the type checker and is just another way to assert a claim without evidence.',
      rule: 'no-as-cast',
    },
    {
      pattern: 'Annotate the value as `any` so the compiler stops asking',
      because:
        'Widening to `any` removes type information entirely and hides every future mistake.',
      rule: 'no-any',
    },
    {
      pattern: 'Suppress the error with a compiler-directive comment',
      because:
        'A directive comment hides the problem from the type checker without removing the runtime risk.',
      rule: 'no-ts-comment',
    },
    {
      pattern: 'Move the `!` from the use site to the field declaration',
      because:
        'It is the same unchecked claim relocated; this rule reports both use-site and declaration-site assertions.',
    },
  ],
  examples: {
    bad: `function f(value: string | undefined) {
  return value!;
}

class C {
  field!: string;
}`,
    good: `function f(value: string | undefined) {
  if (value !== undefined) {
    return value;
  }
  return '';
}

class C {
  field: string = '';
}`,
  },
};

export const noNonNullAssertion: TsRule = {
  manifest,
  check(sourceFile: SourceFile, _options: Record<string, unknown>): Violation[] {
    return visit(sourceFile);
  },
};
