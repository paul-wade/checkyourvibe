import { Node, SyntaxKind } from 'ts-morph';
import type { SourceFile } from 'ts-morph';
import { makeViolation } from '../util.js';
import type { TsRule } from '../rule.js';
import type { RuleManifest, Violation } from '@checkyourvibe/core';

const EXPLICIT_MESSAGE = 'Explicit `any` type is not allowed.';
const INFERRED_MESSAGE =
  'This binding has an inferred `any` type; no `any` is written in the source, but the type checker cannot determine a more precise type.';

const manifest: RuleManifest = {
  id: 'no-any',
  category: 'type-safety',
  pack: 'core-ts',
  evidence: 'semantic',
  scope: 'file',
  severity: 'error',
  summary: 'Do not use the `any` type, whether it is written explicitly or inferred.',
  why: 'The `any` type opts a value out of TypeScript\'s type checking. Every value that flows through it becomes a black box: the compiler cannot check property access, function calls, or assignments, and errors that would have been caught at compile time surface as runtime failures or misleading completions. Inferred `any` is just as dangerous as the written keyword, because it appears when the type checker cannot determine a type and silently disables checking without being visible in the source.',
  allowedFixes: [
    'Return a concrete type from the producing function and use that type at every call site.',
    'For a function that passes a value through unchanged, use a generic parameter (`<T>`) so the input type is preserved.',
    'Validate data that enters the program from an external source at the boundary, then use the validated result\'s type instead of `any`.',
    'Model a value that may be one of several shapes as a discriminated union rather than collapsing it to `any`.',
    'For a function that only performs side effects, declare its return type as `void`.',
  ],
  notFixes: [
    {
      pattern: 'widen the type to `unknown`',
      because:
        'It hides the `any` at the declaration but forces every consumer to narrow or cast before use, so the untyped surface simply moves downstream.',
    },
    {
      pattern: 'cast the value with `as`',
      rule: 'no-as-cast',
      because:
        'It asserts a type without proof; the runtime value can still be anything, and the compiler stops checking it.',
    },
    {
      pattern: 'replace the type with `object` or `{}` to keep the code compiling',
      rule: 'no-useless-types',
      because:
        'Those types look like constraints but accept almost every value, so the underlying problem is still there and no-useless-types will report them.',
    },
    {
      pattern: 'suppress the error with `// @ts-ignore` or `// @ts-expect-error`',
      rule: 'no-ts-comment',
      because:
        'It silences the type checker rather than replacing the missing type, so later code assumes guarantees that do not exist.',
    },
  ],
  examples: {
    bad: `function process(input) {
  return input;
}

const value: any = 1;`,
    good: `function identity<T>(input: T): T {
  return input;
}

type Shape =
  | { kind: 'circle'; radius: number }
  | { kind: 'square'; side: number };

function describe(shape: Shape): string {
  switch (shape.kind) {
    case 'circle':
      return \`circle with radius \${shape.radius}\`;
    case 'square':
      return \`square with side \${shape.side}\`;
  }
}

function emit(event: string, sink: (message: string) => void): void {
  sink(event);
}`,
  },
};

/**
 * Whether a type annotation writes `any` anywhere inside it.
 *
 * `x: any` is one shape of a written `any`; `x: any | any[]`,
 * `x: Promise<any>` and `x: (v: any) => void` are others. Each `any` keyword in
 * them is already reported by the explicit pass, and the resulting type of the
 * binding may still be `any`, so without this the same declaration also
 * receives the inferred-`any` message — whose text states that no `any` is
 * written in the source.
 */
function annotationWritesAny(typeNode: Node): boolean {
  if (Node.isAnyKeyword(typeNode)) {
    return true;
  }
  return typeNode.getDescendantsOfKind(SyntaxKind.AnyKeyword).length > 0;
}

function check(sourceFile: SourceFile, _options: Record<string, unknown>): Violation[] {
  const violations: Violation[] = [];
  const reported = new Set<number>();

  for (const node of sourceFile.getDescendants()) {
    if (Node.isAnyKeyword(node)) {
      violations.push(makeViolation(sourceFile, node, 'no-any', EXPLICIT_MESSAGE, 'error'));
      reported.add(node.getStart());
    }
  }

  for (const node of sourceFile.getDescendants()) {
    if (reported.has(node.getStart())) {
      continue;
    }

    let isInferredAny = false;

    if (
      Node.isParameterDeclaration(node) ||
      Node.isVariableDeclaration(node) ||
      Node.isPropertyDeclaration(node)
    ) {
      const typeNode = node.getTypeNode();
      if (typeNode !== undefined && annotationWritesAny(typeNode)) {
        continue;
      }

      // A destructuring declaration's name is a pattern, not an identifier, and
      // asking the declaration for "its" type does not describe any binding the
      // pattern introduces. Reporting it flags well-typed destructuring as
      // untyped. The individual bindings are still checked below, which is where
      // a genuinely untyped one shows up.
      const nameNode = node.getNameNode();
      if (Node.isObjectBindingPattern(nameNode) || Node.isArrayBindingPattern(nameNode)) {
        continue;
      }

      isInferredAny = node.getType().isAny();
    } else if (Node.isBindingElement(node)) {
      isInferredAny = node.getType().isAny();
    } else if (Node.isCatchClause(node)) {
      const variableDeclaration = node.getVariableDeclaration();
      if (variableDeclaration !== undefined) {
        const typeNode = variableDeclaration.getTypeNode();
        if (typeNode !== undefined && annotationWritesAny(typeNode)) {
          continue;
        }
        isInferredAny = variableDeclaration.getType().isAny();
      }
    }

    if (isInferredAny) {
      violations.push(makeViolation(sourceFile, node, 'no-any', INFERRED_MESSAGE, 'error'));
      reported.add(node.getStart());
    }
  }

  return violations;
}

export const noAny: TsRule = { manifest, check };
