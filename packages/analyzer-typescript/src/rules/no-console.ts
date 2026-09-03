import { Node, type SourceFile, type TypeChecker, type Symbol as MorphSymbol, type Identifier, type Expression, type BindingElement } from 'ts-morph';
import { makeViolation } from '../util.js';
import type { RuleManifest, Violation } from '@checkyourvibe/core';
import type { TsRule } from '../rule.js';

const RULE_ID = 'no-console';

type ConsoleReference = { kind: 'object' } | { kind: 'method'; member: string };

const manifest: RuleManifest = {
  id: RULE_ID,
  category: 'style',
  pack: 'core-ts',
  evidence: 'semantic',
  scope: 'file',
  severity: 'warning',
  summary: 'Do not call methods on the global console object.',
  why:
    'The global console is a debugging convenience that writes directly to the user\'s terminal. ' +
    'It mixes formatting, side effects, and severity into a single untyped sink, so committed console ' +
    'calls cannot be filtered, redirected, or tested consistently. A configurable rule lets a project ' +
    'permit the few members a command-line tool genuinely needs while keeping the rest visible.',
  allowedFixes: [
    'Route the output through the application\'s own logging abstraction so it can be filtered, redirected, and tested.',
    'Remove debugging output before committing the change.',
    'Where a command-line tool legitimately must write to the user\'s terminal, add the member to `allowedMethods` and keep the rest reported.',
  ],
  notFixes: [
    {
      pattern: 'Assign the console object or one of its methods to a differently-named local and call that instead',
      because:
        'It is the same global console call with an extra indirection; the rule resolves simple aliases and the behaviour is unchanged.',
    },
    {
      pattern: 'Comment the call out instead of removing or replacing it',
      because:
        'A commented call is not executable but it is still committed noise, and the next reader has no signal whether it was intentional or abandoned.',
    },
  ],
  examples: {
    bad: `console.log('debug');
console.error(new Error('failed'));

const { log } = console;
log('destructured');`,
    good: `function emit(level: 'info' | 'error', message: string): void {
  // routed through the application's logging abstraction
}

emit('error', 'failed');

// For a command-line tool that truly needs the terminal,
// configure allowedMethods: ['warn', 'error']
console.warn('caution');`,
  },
  optionsSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      allowedMethods: {
        type: 'array',
        items: { type: 'string' },
        description: 'console members that are permitted, e.g. warn and error in a CLI',
        default: [],
      },
    },
  },
};

function isGlobalConsoleIdentifier(identifier: Identifier, typeChecker: TypeChecker): boolean {
  if (identifier.getText() !== 'console') {
    return false;
  }
  const symbol = typeChecker.getSymbolAtLocation(identifier);
  if (symbol === undefined) {
    return true;
  }
  const valueDeclaration = symbol.getValueDeclaration();
  if (valueDeclaration !== undefined) {
    return valueDeclaration.getSourceFile().isInNodeModules();
  }
  return symbol.getDeclarations().every((declaration) => declaration.getSourceFile().isInNodeModules());
}

function isConsoleObjectIdentifier(
  identifier: Identifier,
  typeChecker: TypeChecker,
  objectAliases: ReadonlySet<MorphSymbol>,
): boolean {
  if (identifier.getText() === 'console') {
    return isGlobalConsoleIdentifier(identifier, typeChecker);
  }
  const symbol = typeChecker.getSymbolAtLocation(identifier);
  return symbol !== undefined && objectAliases.has(symbol);
}

function readAllowedMethods(options: Record<string, unknown>): ReadonlySet<string> {
  const raw = options.allowedMethods;
  if (raw === undefined || !Array.isArray(raw)) {
    return new Set<string>();
  }
  const values: readonly unknown[] = raw;
  const allowed = new Set<string>();
  for (const item of values) {
    if (typeof item === 'string') {
      allowed.add(item);
    }
  }
  return allowed;
}

function resolveConsoleReference(
  node: Node,
  typeChecker: TypeChecker,
  objectAliases: ReadonlySet<MorphSymbol>,
  methodAliases: ReadonlyMap<MorphSymbol, string>,
): ConsoleReference | undefined {
  if (Node.isPropertyAccessExpression(node)) {
    const receiver = node.getExpression();
    if (Node.isIdentifier(receiver) && isConsoleObjectIdentifier(receiver, typeChecker, objectAliases)) {
      return { kind: 'method', member: node.getName() };
    }
    return undefined;
  }

  if (Node.isElementAccessExpression(node)) {
    const receiver = node.getExpression();
    const argument = node.getArgumentExpression();
    if (
      Node.isIdentifier(receiver) &&
      isConsoleObjectIdentifier(receiver, typeChecker, objectAliases) &&
      argument !== undefined &&
      Node.isStringLiteral(argument)
    ) {
      return { kind: 'method', member: argument.getLiteralValue() };
    }
    return undefined;
  }

  if (Node.isIdentifier(node)) {
    if (isConsoleObjectIdentifier(node, typeChecker, objectAliases)) {
      return { kind: 'object' };
    }
    const symbol = typeChecker.getSymbolAtLocation(node);
    if (symbol !== undefined) {
      const member = methodAliases.get(symbol);
      if (member !== undefined) {
        return { kind: 'method', member };
      }
    }
  }

  return undefined;
}

function propertyNameForBinding(element: BindingElement): string | undefined {
  const propertyNameNode = element.getPropertyNameNode();
  if (propertyNameNode === undefined) {
    return element.getName();
  }
  if (Node.isIdentifier(propertyNameNode)) {
    return propertyNameNode.getText();
  }
  if (Node.isStringLiteral(propertyNameNode) || Node.isNoSubstitutionTemplateLiteral(propertyNameNode)) {
    return propertyNameNode.getLiteralValue();
  }
  if (Node.isNumericLiteral(propertyNameNode)) {
    return String(propertyNameNode.getLiteralValue());
  }
  return undefined;
}

interface AliasContext {
  methods: Map<MorphSymbol, string>;
  objects: Set<MorphSymbol>;
}

function collectAliases(sourceFile: SourceFile, typeChecker: TypeChecker): AliasContext {
  const methods = new Map<MorphSymbol, string>();
  const objects = new Set<MorphSymbol>();
  const declarations = sourceFile.getDescendants().filter(Node.isVariableDeclaration);

  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      const initializer = declaration.getInitializer();
      if (initializer === undefined) {
        continue;
      }

      const nameNode = declaration.getNameNode();
      const reference = resolveConsoleReference(initializer, typeChecker, objects, methods);

      if (Node.isIdentifier(nameNode)) {
        const symbol = typeChecker.getSymbolAtLocation(nameNode);
        if (symbol === undefined) {
          continue;
        }
        if (reference === undefined) {
          continue;
        }
        if (reference.kind === 'method' && !methods.has(symbol)) {
          methods.set(symbol, reference.member);
          changed = true;
        } else if (reference.kind === 'object' && !objects.has(symbol)) {
          objects.add(symbol);
          changed = true;
        }
        continue;
      }

      if (!Node.isObjectBindingPattern(nameNode) || reference?.kind !== 'object') {
        continue;
      }

      for (const element of nameNode.getElements()) {
        if (!Node.isBindingElement(element)) {
          continue;
        }
        const member = propertyNameForBinding(element);
        if (member === undefined) {
          continue;
        }
        const bindingName = element.getNameNode();
        if (!Node.isIdentifier(bindingName)) {
          continue;
        }
        const symbol = typeChecker.getSymbolAtLocation(bindingName);
        if (symbol !== undefined && !methods.has(symbol)) {
          methods.set(symbol, member);
          changed = true;
        }
      }
    }
  }

  return { methods, objects };
}

function findCalledConsoleMember(
  expression: Expression,
  typeChecker: TypeChecker,
  aliases: AliasContext,
): string | undefined {
  const reference = resolveConsoleReference(expression, typeChecker, aliases.objects, aliases.methods);
  if (reference?.kind === 'method') {
    return reference.member;
  }
  return undefined;
}

function buildMessage(member: string, expression: Expression): string {
  if (Node.isIdentifier(expression)) {
    return `Do not call the global console member '${member}' through a local alias.`;
  }
  return `Do not call the global console member '${member}'.`;
}

function check(sourceFile: SourceFile, options: Record<string, unknown>): Violation[] {
  const allowedMethods = readAllowedMethods(options);
  const typeChecker = sourceFile.getProject().getTypeChecker();
  const aliases = collectAliases(sourceFile, typeChecker);
  const violations: Violation[] = [];

  for (const node of sourceFile.getDescendants()) {
    if (!Node.isCallExpression(node)) {
      continue;
    }
    const expression = node.getExpression();
    const member = findCalledConsoleMember(expression, typeChecker, aliases);
    if (member !== undefined && !allowedMethods.has(member)) {
      const message = buildMessage(member, expression);
      violations.push(makeViolation(sourceFile, node, RULE_ID, message, 'warning'));
    }
  }

  return violations;
}

export const noConsole: TsRule = { manifest, check };
