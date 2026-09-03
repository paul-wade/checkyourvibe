import { Node, ts, type SourceFile, type TypeReferenceNode } from 'ts-morph';
import type { RuleManifest, Violation } from '@checkyourvibe/core';
import type { TsRule } from '../rule.js';
import { makeViolation } from '../util.js';

const ruleId = 'no-useless-types';

const OBJECT_MESSAGE =
  'The `object` type accepts any non-primitive value; it says nothing about the value\'s shape or members.';

const FUNCTION_MESSAGE =
  'The `Function` type accepts any callable; it says nothing about parameters, return type, or arity.';

const EMPTY_OBJECT_MESSAGE =
  'The empty object type `{}` accepts almost every value except `null` and `undefined`; it is not an object with no properties.';

const TYPE_SCRIPT_LIB_PATTERN = /[\\/]typescript[\\/]lib[\\/]lib(?:\.[\w.]+)?\.d\.ts$/;

function isBuiltInFunctionType(node: TypeReferenceNode): boolean {
  const typeName = node.getTypeName();
  if (!Node.isIdentifier(typeName) || typeName.getText() !== 'Function') {
    return false;
  }

  if (node.getTypeArguments().length > 0) {
    return false;
  }

  const type = node.getType();
  const symbol = type.getSymbol();
  if (symbol === undefined) {
    return false;
  }

  const declarations = symbol.getDeclarations();
  if (declarations.length === 0) {
    return false;
  }

  for (const declaration of declarations) {
    const sourceFile = declaration.getSourceFile();
    const filePath = sourceFile.getFilePath();
    if (sourceFile.isInNodeModules() && TYPE_SCRIPT_LIB_PATTERN.test(filePath)) {
      continue;
    }

    // Any declaration outside the TypeScript lib files means the name is
    // user-defined or imported, not the built-in global `Function` interface.
    return false;
  }

  return true;
}

function visit(sourceFile: SourceFile): Violation[] {
  const violations: Violation[] = [];

  for (const node of sourceFile.getDescendants()) {
    if (node.isKind(ts.SyntaxKind.ObjectKeyword)) {
      violations.push(makeViolation(sourceFile, node, ruleId, OBJECT_MESSAGE, 'error'));
      continue;
    }

    if (Node.isTypeLiteral(node) && node.getMembers().length === 0) {
      violations.push(makeViolation(sourceFile, node, ruleId, EMPTY_OBJECT_MESSAGE, 'error'));
      continue;
    }

    if (Node.isTypeReference(node) && isBuiltInFunctionType(node)) {
      violations.push(makeViolation(sourceFile, node, ruleId, FUNCTION_MESSAGE, 'error'));
    }
  }

  return violations;
}

const manifest: RuleManifest = {
  id: ruleId,
  category: 'type-safety',
  pack: 'core-ts',
  evidence: 'semantic',
  scope: 'file',
  severity: 'error',
  summary:
    'Do not use the `object`, `Function`, or empty-object `{}` types because they accept far more than they appear to.',
  why:
    'These types look like constraints but do not describe the actual value. `object` accepts any non-primitive, `Function` accepts any callable without describing its arguments or result, and `{}` accepts every value except `null` and `undefined`. Code that uses them still compiles when passed arrays, functions, numbers, or strings, so the type system cannot catch mistakes at the boundary. Later readers assume the type is narrower than it is, and every property access or call must be checked or cast by hand, defeating the purpose of static typing.',
  allowedFixes: [
    'Declare an interface that lists the members the value is actually expected to have.',
    'For a callback, write the full function signature with typed parameters and a typed return value.',
    'When a value is only passed through unchanged, use a generic type parameter so the caller\'s type is preserved.',
    'When nothing is known about a value, use `unknown` and narrow it with a type guard before use.',
  ],
  notFixes: [
    {
      pattern: 'replace the type with `any`',
      rule: 'no-any',
      because:
        'It removes type information entirely and lets any value through without checking, which is a broader and more damaging violation than the original.',
    },
    {
      pattern: 'cast the value with `as` or an angle-bracket assertion at the use site to recover the lost shape',
      rule: 'no-as-cast',
      because:
        'Casting asserts a type the value may not have; it does not add the missing type information, it only silences the compiler at that point.',
    },
    {
      pattern: 'swap `{}` for `object` or `object` for `{}`',
      because:
        'Both types are reported by this rule for the same reason; neither one describes the value\'s actual structure, so the change only moves the violation to a different line.',
    },
  ],
  examples: {
    bad: `function getValue(): object {
  return {};
}

let handler: Function;
type Empty = {};

function collect(items: Array<object>) {
  return items;
}

interface Container {
  value: {};
  runner: Function;
}`,
    good: `interface User {
  name: string;
}

let handler: (event: string) => number;

function identity<T>(value: T): T {
  return value;
}

let value: unknown;
if (typeof value === 'string') {
  value.toUpperCase();
}`,
  },
};

export const noUselessTypes: TsRule = {
  manifest,
  check(sourceFile: SourceFile, _options: Record<string, unknown>): Violation[] {
    return visit(sourceFile);
  },
};
