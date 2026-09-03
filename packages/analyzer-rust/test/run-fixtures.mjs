#!/usr/bin/env node
// Dependency-free fixture runner for the Rust analyzer.
// Builds the binary with `cargo build --release`, then drives it against each
// rule's .bad/.ok pair and asserts expected locations.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const fixturesDir = path.join(pkgRoot, 'fixtures');
const manifestPath = path.join(pkgRoot, 'analyzer.manifest.json');

const CASES = [
  { ruleId: 'no-unwrap', expectedBad: [{ line: 2, column: 5 }] },
  { ruleId: 'no-panic-in-library', expectedBad: [{ line: 2, column: 5 }] },
  { ruleId: 'no-unsafe-block', expectedBad: [{ line: 2, column: 5 }] },
  { ruleId: 'no-ignored-result', expectedBad: [{ line: 6, column: 5 }] },
];

let failures = 0;

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  failures += 1;
  process.stdout.write(`FAIL: ${message}\n`);
}

function buildAnalyzer() {
  log('Building analyzer (cargo build --release)...');
  const result = spawnSync('cargo', ['build', '--release'], {
    cwd: pkgRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    log(result.stdout ?? '');
    log(result.stderr ?? '');
    throw new Error(`cargo build exited with code ${result.status}`);
  }
  log('Build succeeded.');
}

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
  buildAnalyzer();
  const { command, args } = resolveExec();

  // A relative command in the manifest resolves to a path we can check exists.
  // A bare name is looked up on PATH by the OS, exactly as core does it, and
  // checking it here with existsSync would reject every valid manifest that
  // names an interpreter or a build tool rather than a binary in this package.
  if (path.isAbsolute(command) && !existsSync(command)) {
    throw new Error(`Resolved analyzer command does not exist: ${command}`);
  }

  for (const { ruleId, expectedBad } of CASES) {
    const badFile = path.join(fixturesDir, `${ruleId}.bad.rs`);
    const okFile = path.join(fixturesDir, `${ruleId}.ok.rs`);
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
