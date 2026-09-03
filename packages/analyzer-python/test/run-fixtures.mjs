#!/usr/bin/env node
// Dependency-free fixture runner for the Python analyzer.
// Spawns the analyzer via the manifest's exec block for each rule's .bad/.ok
// pair and asserts expected locations. Exits non-zero on any mismatch.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const fixturesDir = path.join(pkgRoot, 'fixtures');
const manifestPath = path.join(pkgRoot, 'analyzer.manifest.json');

/** One row per rule: the fixture pair and the exact violation the .bad.py must produce. */
const CASES = [
  { ruleId: 'no-bare-except', expectedBad: [{ line: 4, column: 5 }] },
  { ruleId: 'no-mutable-default-arg', expectedBad: [{ line: 1, column: 24 }] },
  { ruleId: 'no-assert-for-validation', expectedBad: [{ line: 2, column: 5 }] },
  { ruleId: 'no-star-import', expectedBad: [{ line: 1, column: 1 }] },
];

let failures = 0;

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  failures += 1;
  process.stdout.write(`FAIL: ${message}\n`);
}

/**
 * Resolve the manifest's exec command and args the same way the core loader does:
 * paths beginning with ./ or ../ are resolved against the manifest directory.
 */
function resolveExec() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const { command, args = [] } = manifest.exec;
  const resolve = (p) =>
    p.startsWith('./') || p.startsWith('../') ? path.resolve(pkgRoot, p) : p;
  return { command: resolve(command), args: args.map(resolve) };
}

function runAnalyzer(command, args, request) {
  const result = spawnSync(command, args, {
    input: JSON.stringify(request),
    encoding: 'utf8',
    cwd: pkgRoot,
  });

  if (result.error) {
    throw new Error(`Could not spawn analyzer: ${result.error.message}`);
  }

  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(
      `Analyzer did not print a well-formed JSON response (exit ${result.status}).\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }

  return { response, exitCode: result.status };
}

function buildRequest(files, ruleId, severity = 'error') {
  return {
    protocol: 1,
    repoRoot: pkgRoot,
    mode: 'file',
    files,
    rules: { [ruleId]: { severity } },
  };
}

function checkWellFormed(response, label) {
  const ok =
    response.protocol === 1 &&
    Array.isArray(response.violations) &&
    Array.isArray(response.skipped) &&
    Array.isArray(response.diagnostics);
  if (!ok) {
    fail(`${label}: response is not a well-formed AnalyzeResponse: ${JSON.stringify(response)}`);
  }
  return ok;
}

function checkBadFixture(command, args, ruleId, file, expected) {
  const label = `${ruleId} (bad)`;
  const { response, exitCode } = runAnalyzer(command, args, buildRequest([file], ruleId));

  if (exitCode !== 0) {
    fail(`${label}: analyzer exited ${exitCode} on a well-formed request`);
    return;
  }
  if (!checkWellFormed(response, label)) return;

  if (response.skipped.length > 0) {
    fail(`${label}: file was skipped instead of analyzed: ${JSON.stringify(response.skipped)}`);
    return;
  }

  const actual = response.violations
    .filter((v) => v.ruleId === ruleId)
    .map((v) => ({ line: v.line, column: v.column }));

  const expectedKeys = expected.map((e) => `${e.line}:${e.column}`).sort();
  const actualKeys = actual.map((e) => `${e.line}:${e.column}`).sort();

  if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
    fail(
      `${label}: expected violations at ${JSON.stringify(expectedKeys)}, got ${JSON.stringify(actualKeys)} ` +
        `(full response: ${JSON.stringify(response.violations)})`,
    );
    return;
  }

  for (const v of response.violations) {
    if (v.ruleId !== ruleId) continue;
    if (typeof v.snippet !== 'string' || v.snippet.length === 0) {
      fail(`${label}: violation at ${v.line}:${v.column} has an empty snippet`);
    }
    if (v.guidance !== undefined) {
      fail(`${label}: violation at ${v.line}:${v.column} populated "guidance"`);
    }
  }

  log(`PASS: ${label} -- ${actual.length} violation(s) matched expected locations.`);
}

function checkOkFixture(command, args, ruleId, file) {
  const label = `${ruleId} (ok)`;
  const { response, exitCode } = runAnalyzer(command, args, buildRequest([file], ruleId));

  if (exitCode !== 0) {
    fail(`${label}: analyzer exited ${exitCode} on a well-formed request`);
    return;
  }
  if (!checkWellFormed(response, label)) return;

  const ruleViolations = response.violations.filter((v) => v.ruleId === ruleId);
  if (ruleViolations.length > 0) {
    fail(`${label}: expected zero violations for the false-positive guard, got ${JSON.stringify(ruleViolations)}`);
    return;
  }

  log(`PASS: ${label} -- no false positives.`);
}

function checkMalformedRequest(command, args) {
  const result = spawnSync(command, args, { input: 'not json', encoding: 'utf8', cwd: pkgRoot });
  if (result.status === 0) {
    fail('malformed request: expected a non-zero exit code, got 0');
    return;
  }

  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    fail(`malformed request: stdout was not valid JSON: ${result.stdout}`);
    return;
  }

  if (!checkWellFormed(response, 'malformed request')) return;
  if (response.diagnostics.length === 0) {
    fail('malformed request: expected at least one diagnostic explaining the problem');
    return;
  }
  log('PASS: malformed request -- well-formed diagnostic response with a non-zero exit code.');
}

function main() {
  const { command, args } = resolveExec();

  for (const { ruleId, expectedBad } of CASES) {
    const badFile = path.join(fixturesDir, `${ruleId}.bad.py`);
    const okFile = path.join(fixturesDir, `${ruleId}.ok.py`);
    if (!existsSync(badFile)) throw new Error(`Missing fixture: ${badFile}`);
    if (!existsSync(okFile)) throw new Error(`Missing fixture: ${okFile}`);

    checkBadFixture(command, args, ruleId, badFile, expectedBad);
    checkOkFixture(command, args, ruleId, okFile);
  }

  checkMalformedRequest(command, args);

  if (failures > 0) {
    log(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  log('\nAll fixture checks passed.');
}

main();
