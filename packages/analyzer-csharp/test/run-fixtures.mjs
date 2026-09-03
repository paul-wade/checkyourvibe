#!/usr/bin/env node
// Builds the C# analyzer and drives it, as a real subprocess speaking the published protocol,
// against each fixture pair in ../fixtures/. Node-builtin only, no test framework, no
// dependencies -- see ../README.md for how to run this.
//
// For every rule:
//   - the .bad.cs fixture must produce exactly the expected violations (rule id, line, column)
//     when only that rule is enabled;
//   - the .ok.cs fixture must produce zero violations for that rule (the false-positive guard).
//
// Exits non-zero on any mismatch, build failure, or malformed response.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const repoRoot = path.resolve(pkgRoot, '../..');
const fixturesDir = path.join(pkgRoot, 'fixtures');
const srcDir = path.join(pkgRoot, 'src');
const manifestPath = path.join(pkgRoot, 'analyzer.manifest.json');

/** One row per rule: the fixture pair and the exact findings the .bad.cs file must produce. */
const CASES = [
  {
    ruleId: 'no-dynamic',
    expectedBad: [
      { line: 10, column: 9 },
      { line: 15, column: 5 },
      { line: 15, column: 23 },
    ],
  },
  {
    ruleId: 'no-unchecked-cast',
    expectedBad: [
      { line: 14, column: 19 },
      { line: 22, column: 17 },
    ],
  },
  {
    ruleId: 'no-null-forgiving',
    expectedBad: [{ line: 10, column: 24 }],
  },
  {
    ruleId: 'no-empty-catch',
    expectedBad: [
      { line: 14, column: 9 },
      { line: 26, column: 9 },
      { line: 40, column: 13 },
      { line: 55, column: 13 },
      { line: 68, column: 9 },
    ],
  },
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
  log('Building analyzer (dotnet build -c Release)...');
  const result = spawnSync('dotnet', ['build', '-c', 'Release'], {
    cwd: srcDir,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    log(result.stdout ?? '');
    log(result.stderr ?? '');
    throw new Error(`dotnet build exited with code ${result.status}`);
  }
  log('Build succeeded.');
}

/**
 * Resolve the manifest's `exec` into the exact argv the core loader would use.
 *
 * Both halves of this used to be wrong, in a way nothing could notice because
 * no test ever ran this file. `args` was dropped entirely, so the analyzer was
 * spawned as a bare `dotnet` with nothing to run; and the caller stat'd the
 * command as if it were always a path, which a bare `dotnet` never is. A
 * relative path in either position is resolved against the manifest's own
 * directory, which is what the manifest documents.
 */
function resolveExec() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const { command, args } = manifest.exec;
  const resolveMaybeRelative = (value) =>
    value.startsWith('./') || value.startsWith('../') ? path.resolve(pkgRoot, value) : value;

  return {
    command: resolveMaybeRelative(command),
    args: (args ?? []).map(resolveMaybeRelative),
  };
}

/**
 * A command containing a separator is a file and must exist. A bare name is
 * looked up on PATH by the OS at spawn time, so the only honest check here is
 * whether spawning it fails with ENOENT, which `runAnalyzer` already reports.
 */
function isPathLike(command) {
  return command.includes('/') || command.includes('\\');
}

function runAnalyzer(exec, request) {
  const result = spawnSync(exec.command, exec.args, {
    input: JSON.stringify(request),
    encoding: 'utf8',
    cwd: repoRoot,
  });

  if (result.error) {
    throw new Error(`Could not spawn analyzer: ${result.error.message}`);
  }

  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(
      `Analyzer did not print a well-formed JSON response on stdout (exit ${result.status}).\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }

  return { response, exitCode: result.status };
}

function buildRequest(files, ruleId) {
  return {
    protocol: 1,
    repoRoot,
    mode: 'file',
    files,
    rules: { [ruleId]: { severity: 'error' } },
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

function violationKey(v) {
  return `${v.ruleId}@${v.line}:${v.column}`;
}

function checkBadFixture(exec, ruleId, file, expected) {
  const label = `${ruleId} (bad)`;
  const { response, exitCode } = runAnalyzer(exec, buildRequest([file], ruleId));

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
      fail(`${label}: violation at ${v.line}:${v.column} populated "guidance" -- analyzers must not do this`);
    }
  }

  log(`PASS: ${label} -- ${actual.length} violation(s) matched expected locations.`);
}

function checkOkFixture(exec, ruleId, file) {
  const label = `${ruleId} (ok)`;
  const { response, exitCode } = runAnalyzer(exec, buildRequest([file], ruleId));

  if (exitCode !== 0) {
    fail(`${label}: analyzer exited ${exitCode} on a well-formed request`);
    return;
  }
  if (!checkWellFormed(response, label)) return;

  const ruleViolations = response.violations.filter((v) => v.ruleId === ruleId);
  if (ruleViolations.length > 0) {
    fail(
      `${label}: expected zero violations for the false-positive guard, got ${JSON.stringify(ruleViolations)}`,
    );
    return;
  }

  log(`PASS: ${label} -- no false positives.`);
}

function checkMalformedRequest(exec) {
  const result = spawnSync(exec.command, exec.args, { input: 'not json', encoding: 'utf8', cwd: repoRoot });
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
  const exec = resolveExec();
  if (isPathLike(exec.command) && !existsSync(exec.command)) {
    throw new Error(`Resolved analyzer command does not exist: ${exec.command}`);
  }
  for (const arg of exec.args) {
    if (path.isAbsolute(arg) && !existsSync(arg)) {
      throw new Error(`Resolved analyzer argument does not exist: ${arg}. Was the build skipped?`);
    }
  }

  for (const { ruleId, expectedBad } of CASES) {
    const badFile = path.join(fixturesDir, `${ruleId}.bad.cs`);
    const okFile = path.join(fixturesDir, `${ruleId}.ok.cs`);
    if (!existsSync(badFile)) throw new Error(`Missing fixture: ${badFile}`);
    if (!existsSync(okFile)) throw new Error(`Missing fixture: ${okFile}`);

    checkBadFixture(exec, ruleId, badFile, expectedBad);
    checkOkFixture(exec, ruleId, okFile);
  }

  checkMalformedRequest(exec);

  if (failures > 0) {
    log(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  log('\nAll fixture checks passed.');
}

main();
