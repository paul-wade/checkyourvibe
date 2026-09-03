// Supplemental analyzer: comment quality, across every language the other
// analyzers cover.
//
// It declares `supplements: true`, so it inspects files the language analyzers
// own rather than competing for them. Claiming `**/*.ts` outright would be an
// ambiguity error, and the alternative is reimplementing the same rule inside
// each language analyzer.
//
// The `node` exec type is an imported module, not a subprocess: the core calls
// the default export with a request and awaits the response. It must not read
// stdin, which never ends when a module is imported rather than spawned.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { extractComments, mergeAdjacent, syntaxFor } from './comments.mjs';
import { findEditorialComments } from './no-editorial-comment.mjs';

const PROTOCOL = 1;
const RULE_ID = 'no-editorial-comment';

export default async function analyze(request) {
  const violations = [];
  const skipped = [];
  const diagnostics = [];

  const settings = request?.rules?.[RULE_ID];
  if (settings === undefined) {
    return { protocol: PROTOCOL, violations, skipped, diagnostics };
  }

  for (const file of request.files ?? []) {
    const syntax = syntaxFor(path.extname(file).toLowerCase());
    if (syntax === undefined) {
      skipped.push({ file, reason: `No comment syntax is defined for "${path.extname(file)}".` });
      continue;
    }

    let text;
    try {
      text = await readFile(file, 'utf-8');
    } catch (err) {
      skipped.push({ file, reason: `Could not read the file: ${String(err?.message ?? err)}` });
      continue;
    }

    const comments = mergeAdjacent(extractComments(text, syntax));
    for (const finding of findEditorialComments(comments, settings)) {
      violations.push({
        file,
        line: finding.line,
        column: finding.column,
        ruleId: RULE_ID,
        message: finding.message,
        snippet: finding.snippet,
        severity: settings.severity,
      });
    }
  }

  return { protocol: PROTOCOL, violations, skipped, diagnostics };
}
