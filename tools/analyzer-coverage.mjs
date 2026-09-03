#!/usr/bin/env node
// Assert that every analyzer is exercised by something.
//
//   node tools/analyzer-coverage.mjs
//
// Two mechanisms are in use, for a reason that is not arbitrary: an analyzer
// whose fixtures are C#, Python or Rust cannot be collected by a TypeScript
// test runner, so it ships `test/run-fixtures.mjs` and CI runs that. An
// analyzer written in TypeScript or ESM is collected by vitest directly.
//
// Either satisfies this check. Neither does not. Without it, a new analyzer
// with no tests is invisible: CI's fixture step iterates over the harnesses
// that exist, so an analyzer without one is skipped rather than reported, and
// the run stays green.

import { readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PACKAGES = path.join(REPO, 'packages');

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Every `*.test.ts` under a directory, at any depth. */
async function testFilesUnder(dir) {
  if (!(await exists(dir))) return [];

  const found = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await testFilesUnder(full)));
    } else if (entry.name.endsWith('.test.ts')) {
      found.push(full);
    }
  }
  return found;
}

async function main() {
  const entries = (await readdir(PACKAGES, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('analyzer-'))
    .map((entry) => entry.name)
    .sort();

  if (entries.length === 0) {
    process.stderr.write('No analyzer packages found. This check is looking in the wrong place.\n');
    process.exit(2);
  }

  const uncovered = [];
  for (const name of entries) {
    const dir = path.join(PACKAGES, name);
    const harness = await exists(path.join(dir, 'test', 'run-fixtures.mjs'));
    const tests = await testFilesUnder(path.join(dir, 'test'));

    const how = harness
      ? 'test/run-fixtures.mjs'
      : tests.length > 0
        ? `${tests.length} vitest file(s)`
        : 'NOTHING';

    process.stdout.write(`  ${name.padEnd(24)} ${how}\n`);
    if (!harness && tests.length === 0) {
      uncovered.push(name);
    }
  }

  if (uncovered.length > 0) {
    process.stderr.write(
      `\n${uncovered.length} analyzer(s) have no tests at all: ${uncovered.join(', ')}.\n` +
        'Add test/run-fixtures.mjs (driven by CI, for analyzers whose fixtures are not TypeScript)\n' +
        'or a test/*.test.ts collected by vitest.\n',
    );
    process.exit(1);
  }

  process.stdout.write(`\nAll ${entries.length} analyzers are covered.\n`);
}

await main();
