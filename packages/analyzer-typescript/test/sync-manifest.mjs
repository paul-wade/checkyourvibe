// Copies each rule's guidance from the built rules into the static
// analyzer.manifest.json, which ships to installed copies and feeds `cyv explain`.
//
// `allowedFixes` and `notFixes` are copied for the same reason as the rest: the
// rule source is what the hook prints and the JSON is what `cyv explain` prints,
// and a reader has no way to tell they are two copies. They were omitted here
// once, and nothing detected it — a rule shipped with `notFixes: []` in the
// source and populated guidance in the JSON would send an agent down a dead end
// the tool had already documented.
// analyze.test.ts fails when the two drift apart; run this after `tsc -b` to
// close the gap without hand-editing a 45 KB JSON file.
//
//   node packages/analyzer-typescript/test/sync-manifest.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { manifestRules } from '../dist/index.js';

const path = fileURLToPath(new URL('../analyzer.manifest.json', import.meta.url));
const manifest = JSON.parse(readFileSync(path, 'utf8'));
const byId = new Map(manifestRules.map((rule) => [rule.id, rule]));

for (const rule of manifest.rules) {
  const source = byId.get(rule.id);
  if (source === undefined) continue;
  rule.summary = source.summary;
  rule.why = source.why;
  rule.examples = source.examples;
  rule.allowedFixes = source.allowedFixes;
  rule.notFixes = source.notFixes;
}

writeFileSync(path, JSON.stringify(manifest, null, 2).split('\n').join('\r\n') + '\r\n', 'utf8');
console.log('synced');
