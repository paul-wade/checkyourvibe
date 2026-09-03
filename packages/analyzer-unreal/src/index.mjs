// Unreal Engine C++ analyzer for checkyourvibe.
//
// The core imports this module directly (exec.type: 'node') and calls the
// default export with an AnalyzeRequest. Nothing is spawned and nothing is
// read from stdin; reading stdin at import time would hang forever because
// the request is passed as an argument, not on stdin.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { findGarbageCollectionIssues } from './gc-rules.mjs';

const PROTOCOL = 1;

export default async function analyze(request) {
  const violations = [];
  const skipped = [];
  const diagnostics = [];

  const ruleSettings = request?.rules ?? {};
  const enabled = new Set(Object.keys(ruleSettings));

  if (enabled.size === 0) {
    return { protocol: PROTOCOL, violations, skipped, diagnostics };
  }

  for (const file of request?.files ?? []) {
    const ext = path.extname(file).toLowerCase();
    if (ext !== '.h' && ext !== '.cpp') {
      skipped.push({ file, reason: `Unreal analyzer only checks .h and .cpp files, got "${ext}".` });
      continue;
    }

    let text;
    try {
      text = await readFile(file, 'utf-8');
    } catch (err) {
      skipped.push({ file, reason: `Could not read the file: ${String(err?.message ?? err)}` });
      continue;
    }

    for (const finding of findGarbageCollectionIssues(text, enabled)) {
      const settings = ruleSettings[finding.ruleId];
      if (settings === undefined) {
        continue;
      }
      violations.push({
        file,
        line: finding.line,
        column: finding.column,
        ruleId: finding.ruleId,
        message: finding.message,
        snippet: finding.snippet,
        severity: settings.severity,
      });
    }
  }

  return { protocol: PROTOCOL, violations, skipped, diagnostics };
}
