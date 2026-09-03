import type { Node, SourceFile } from 'ts-morph';
import type { Severity, Violation } from '@checkyourvibe/core';

const SNIPPET_MAX_LENGTH = 200;

export function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max
    ? collapsed
    : `${collapsed.slice(0, max - 1)}…`;
}

export function makeViolation(
  sourceFile: SourceFile,
  node: Node,
  ruleId: string,
  message: string,
  severity: Severity,
): Violation {
  return makeViolationAt(sourceFile, node, node.getStart(), ruleId, message, severity);
}

/**
 * A violation whose reported position is a token inside `node` rather than the
 * node's own start.
 *
 * An operator that trails its operand — the `!` of a non-null assertion, the
 * `as` of a cast — sits at the end of an expression that may span many lines.
 * Reporting the expression's start sends the reader to a line that does not
 * contain the operator at all, and, for a chain such as `a!.b()!.c!`, gives
 * every assertion in the chain the same file:line:column. That is not only
 * confusing to read: file, line, column and rule are the identity a baseline
 * entry and a `--pin` suppression are written against, so three distinct
 * assertions collapsing onto one identity means pinning one silently pins all
 * three. The position of the operator itself is unique and is where a reader
 * looks.
 */
export function makeViolationAt(
  sourceFile: SourceFile,
  node: Node,
  start: number,
  ruleId: string,
  message: string,
  severity: Severity,
): Violation {
  const { line, column } = sourceFile.getLineAndColumnAtPos(start);
  const file = sourceFile.getFilePath();
  const snippet = truncate(node.getText(), SNIPPET_MAX_LENGTH);

  return { file, line, column, ruleId, message, snippet, severity };
}
