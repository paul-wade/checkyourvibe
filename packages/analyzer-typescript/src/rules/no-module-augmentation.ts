import { Node, ts, type SourceFile } from 'ts-morph';
import type { RuleManifest, Violation } from '@checkyourvibe/core';
import type { TsRule } from '../rule.js';
import { makeViolation } from '../util.js';

const ruleId = 'no-module-augmentation';

const RELATIVE_PREFIXES: readonly string[] = ['./', '../'];

function isRelativeSpecifier(specifier: string): boolean {
  for (const prefix of RELATIVE_PREFIXES) {
    if (specifier.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function visit(sourceFile: SourceFile): Violation[] {
  const violations: Violation[] = [];

  for (const node of sourceFile.getDescendantsOfKind(ts.SyntaxKind.ModuleDeclaration)) {
    if (!node.hasDeclareKeyword()) {
      continue;
    }

    const nameNode = node.getNameNode();
    if (!Node.isStringLiteral(nameNode)) {
      continue;
    }

    const specifier = nameNode.getLiteralValue();
    if (!isRelativeSpecifier(specifier)) {
      continue;
    }

    const message = `Module augmentation for '${specifier}' adds to a type whose own file does not mention what is being added.`;
    violations.push(makeViolation(sourceFile, node, ruleId, message, 'error'));
  }

  return violations;
}

const manifest: RuleManifest = {
  id: ruleId,
  category: 'type-safety',
  pack: 'core-ts',
  evidence: 'syntax',
  scope: 'file',
  severity: 'error',
  summary: 'Do not augment a module declared in this project with a relative module specifier.',
  why: 'A relative `declare module` adds members to a type that the type\'s own file does not mention, so readers who look there for the complete shape find an incomplete answer.',
  allowedFixes: [
    'Declare the member on the type in the file that owns it, so the declaration and the shape it describes stay in one place.',
    'Compose a new type that contains the original, when one caller needs extra fields and the original should not change meaning for everyone else.',
    'Move a genuinely shared shape into a module both sides import, so the declaration has one home instead of two halves.',
  ],
  notFixes: [
    {
      pattern: 'Assert the member at each use site with `as`.',
      because:
        'An assertion tells the compiler to accept a type it did not derive. The declaring file still does not mention the member, and every new use site needs its own assertion to keep compiling.',
      rule: 'no-as-cast',
    },
    {
      pattern: 'Type the value `any` so the member is reachable.',
      because:
        '`any` disables checking on that value entirely, so the added member resolves — and so does every misspelling of it.',
      rule: 'no-any',
    },
    {
      pattern: 'Silence the resulting property error with a compiler directive.',
      because:
        'A directive suppresses one diagnostic on one line and leaves the type unchanged, so the next reader meets the same error with no record of why it was accepted.',
      rule: 'no-ts-comment',
    },
    {
      pattern: 'Keep the augmentation and make its members required rather than optional.',
      because:
        'Removing the `?` does not put the members back on the declaring file. It additionally asserts they are present on every value of the type, including records written before the augmentation existed.',
    },
    {
      pattern: 'Move the augmentation into a separate declarations file.',
      because:
        'Relocating it makes it easier to find and leaves the original type describing a shape it does not have. A reader who opens the declaring file still gets an incomplete answer.',
    },
  ],
  examples: {
    bad: `declare module './dispatch.js' {
  interface DispatchOpened extends Partial<DispatchLiveness> {}
}`,
    good: `import { DispatchOpened } from './dispatch.js';

interface LiveDispatchOpened extends DispatchOpened {
  liveness?: DispatchLiveness;
}`,
  },
};

export const noModuleAugmentation: TsRule = {
  manifest,
  check(sourceFile: SourceFile, _options: Record<string, unknown>): Violation[] {
    return visit(sourceFile);
  },
};
