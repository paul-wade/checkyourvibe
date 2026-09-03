import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command } from '../../src/cli/check.js';
import { isUnknownArray } from '../../src/guards.js';
import type { CommandContext } from '../../src/cli/types.js';
import { runCheck } from '../../src/run/check.js';
import { writeBaseline } from '../../src/baseline/write.js';

// One violation per VIOLATION marker, at its real line and column. The
// per-marker positions are what `--pin` selects on, and the repeated snippet
// is what makes `occurrence` load-bearing: every marker hashes identically, so
// a fingerprint alone cannot tell two of them apart.
const ANALYZER_MODULE = `
import { readFileSync } from 'node:fs';

const MARKER = 'VIOLATION';

export default async function analyze(request) {
  const violations = [];
  for (const file of request.files) {
    const lines = readFileSync(file, 'utf-8').split(/\\r?\\n/);
    for (let i = 0; i < lines.length; i++) {
      let from = 0;
      for (;;) {
        const at = lines[i].indexOf(MARKER, from);
        if (at === -1) {
          break;
        }
        violations.push({
          file,
          line: i + 1,
          column: at + 1,
          ruleId: 'no-violation-marker',
          message: 'File contains a VIOLATION marker.',
          snippet: MARKER,
        });
        from = at + MARKER.length;
      }
    }
  }
  return { protocol: 1, violations, skipped: [], diagnostics: [] };
}
`;

function analyzerManifest(): unknown {
  return {
    protocol: 1,
    id: 'stub',
    match: ['**/*.ts'],
    rules: [
      {
        id: 'no-violation-marker',
        category: 'test',
        scope: 'file',
        severity: 'error',
        summary: 'Flags an explicit VIOLATION marker left in source.',
        why: 'Keeps this fixture deterministically wrong so tests can assert on it.',
        allowedFixes: ['Remove the VIOLATION marker from the file.'],
        notFixes: [],
        examples: { bad: 'const x = 1; // VIOLATION', good: 'const x = 1;' },
      },
    ],
    exec: { type: 'node', module: './analyzer.mjs' },
  };
}

function config(suppressions: unknown[] = []): unknown {
  return {
    packs: [],
    analyzers: [{ id: 'stub', package: './analyzer.manifest.json' }],
    rules: { 'no-violation-marker': {} },
    strict: false,
    exclude: [],
    suppressions,
  };
}

async function copySchema(repoRoot: string): Promise<void> {
  const schemaUrl = new URL('../../../../docs/protocol/config.schema.json', import.meta.url);
  const schema = await readFile(schemaUrl, 'utf-8');
  const schemaDir = join(repoRoot, 'docs', 'protocol');
  await mkdir(schemaDir, { recursive: true });
  await writeFile(join(schemaDir, 'config.schema.json'), schema);
}

async function makeRepo(): Promise<string> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'cyv-check-')));
  const repo = join(parent, 'repo');
  await mkdir(repo, { recursive: true });
  execFileSync('git', ['init'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
  return repo;
}

async function makeConfiguredRepo(
  sourceContent: string,
  suppressions: unknown[] = [],
): Promise<{ repo: string; sourcePath: string }> {
  const repo = await makeRepo();
  await copySchema(repo);
  await writeFile(join(repo, 'checkyourvibe.json'), JSON.stringify(config(suppressions), null, 2));
  await writeFile(join(repo, 'analyzer.manifest.json'), JSON.stringify(analyzerManifest(), null, 2));
  await writeFile(join(repo, 'analyzer.mjs'), ANALYZER_MODULE);

  const srcDir = join(repo, 'src');
  await mkdir(srcDir, { recursive: true });
  const sourcePath = join(srcDir, 'thing.ts');
  await writeFile(sourcePath, sourceContent);

  return { repo, sourcePath };
}

function context(repo: string, argv: string[]): CommandContext {
  return { cwd: repo, argv, env: process.env };
}

interface Captured {
  logs: string[];
  errors: string[];
  restore: () => void;
}

function captureConsole(): Captured {
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
    logs.push(line);
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((line: string) => {
    errors.push(line);
  });
  return {
    logs,
    errors,
    restore: () => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function assertDefined<T>(value: T | undefined, message: string): asserts value is T {
  if (value === undefined) {
    throw new Error(message);
  }
}

interface JsonGuidance {
  summary: string;
  why: string;
  allowedFixes: string[];
  notFixes: unknown[];
  examples: { bad: string; good: string };
}

interface JsonViolation {
  ruleId: string;
  guidance?: JsonGuidance;
}

interface JsonReport {
  violations: JsonViolation[];
  filesChecked: number;
  mode: string;
}

function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i];
    if (typeof item !== 'string') {
      return false;
    }
  }
  return true;
}

function isJsonGuidance(value: unknown): value is JsonGuidance {
  if (!isRecord(value)) {
    return false;
  }
  if (
    typeof value.summary !== 'string' ||
    typeof value.why !== 'string' ||
    !isStringArray(value.allowedFixes) ||
    !Array.isArray(value.notFixes)
  ) {
    return false;
  }
  const examples = value.examples;
  if (!isRecord(examples)) {
    return false;
  }
  return typeof examples.bad === 'string' && typeof examples.good === 'string';
}

function isJsonViolation(value: unknown): value is JsonViolation {
  if (!isRecord(value) || typeof value.ruleId !== 'string') {
    return false;
  }
  if (value.guidance !== undefined) {
    return isJsonGuidance(value.guidance);
  }
  return true;
}

function isJsonReport(value: unknown): value is JsonReport {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.filesChecked !== 'number' || typeof value.mode !== 'string' || !Array.isArray(value.violations)) {
    return false;
  }
  for (let i = 0; i < value.violations.length; i++) {
    const v: unknown = value.violations[i];
    if (!isJsonViolation(v)) {
      return false;
    }
  }
  return true;
}

/**
 * The object `--pin` writes to stdout, validated against the shape
 * `parseSuppression` accepts. The shape is asserted rather than assumed
 * because `--pin` promises output that loads without being edited first.
 */
interface EmittedPin {
  ruleId: string;
  target: string;
  reason: string;
  expires: string;
  fingerprint: string;
  occurrence: number;
}

function isEmittedPin(value: unknown): value is EmittedPin {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.ruleId === 'string' &&
    typeof value.target === 'string' &&
    typeof value.reason === 'string' &&
    typeof value.expires === 'string' &&
    typeof value.fingerprint === 'string' &&
    typeof value.occurrence === 'number'
  );
}

function parsePinnedSuppression(raw: string): EmittedPin {
  const parsed: unknown = JSON.parse(raw);
  if (!isEmittedPin(parsed)) {
    throw new Error(`Not a pinned suppression: ${raw.slice(0, 200)}`);
  }
  return parsed;
}

function parseJsonReport(raw: string | undefined): JsonReport {
  if (raw === undefined) {
    throw new Error('Expected a single JSON log line, got none.');
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isJsonReport(parsed)) {
    throw new Error(`Parsed JSON is not a valid report: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  return parsed;
}

describe('cyv check', () => {
  it('returns 0 on a clean run', async () => {
    const { repo, sourcePath } = await makeConfiguredRepo('export const value = 1;\n');
    const captured = captureConsole();
    try {
      const code = await command.run(context(repo, [sourcePath]));
      expect(code).toBe(0);
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('returns 1 when a violation is found, with guidance attached', async () => {
    const { repo, sourcePath } = await makeConfiguredRepo('export const value = 1; // VIOLATION\n');
    const captured = captureConsole();
    try {
      const code = await command.run(context(repo, [sourcePath, '--json']));
      expect(code).toBe(1);

      expect(captured.logs).toHaveLength(1);
      const log = captured.logs[0];
      assertDefined(log, 'expected a single JSON log line');
      const report = parseJsonReport(log);
      expect(report.violations).toHaveLength(1);
      const violation = report.violations[0];
      expect(violation).toBeDefined();
      expect(violation?.ruleId).toBe('no-violation-marker');
      expect(violation?.guidance).toBeDefined();
      expect(violation?.guidance?.summary).toBe('Flags an explicit VIOLATION marker left in source.');
      expect(violation?.guidance?.allowedFixes).toEqual(['Remove the VIOLATION marker from the file.']);
      expect(violation?.guidance?.examples).toEqual({
        bad: 'const x = 1; // VIOLATION',
        good: 'const x = 1;',
      });
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('--json emits parseable JSON with no extra stdout text', async () => {
    const { repo, sourcePath } = await makeConfiguredRepo('export const value = 1;\n');
    const captured = captureConsole();
    try {
      const code = await command.run(context(repo, [sourcePath, '--json']));
      expect(code).toBe(0);
      expect(captured.logs).toHaveLength(1);

      const log = captured.logs[0];
      assertDefined(log, 'expected a single JSON log line');
      const report = parseJsonReport(log);
      expect(report.filesChecked).toBe(1);
      expect(report.mode).toBe('files');
      expect(report.violations).toEqual([]);

      const allErrors = captured.errors.join('\n');
      expect(allErrors).toContain('0 active suppressions');
      expect(allErrors).toContain('0 findings suppressed this run');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('groups the default report by rule and prints each rule guidance once', async () => {
    const { repo } = await makeConfiguredRepo(
      'const a = 1; // VIOLATION\nconst b = 2; // VIOLATION\nconst c = 3; // VIOLATION\n',
    );
    const captured = captureConsole();
    try {
      const code = await command.run(context(repo, ['--all']));
      expect(code).toBe(1);

      const output = captured.logs.join('\n');
      expect(occurrences(output, 'Flags an explicit VIOLATION marker left in source.')).toBe(1);
      expect(occurrences(output, 'Remove the VIOLATION marker from the file.')).toBe(1);
      // Every finding is still located, one line each, under repo-relative paths.
      expect(output).toContain('no-violation-marker — 3 findings');
      expect(output).toContain('src/thing.ts:1:17');
      expect(output).toContain('src/thing.ts:2:17');
      expect(output).toContain('src/thing.ts:3:17');
      expect(output).toContain('3 errors, 0 warnings, 1 file checked');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('--report detailed repeats the guidance under every finding', async () => {
    const { repo } = await makeConfiguredRepo(
      'const a = 1; // VIOLATION\nconst b = 2; // VIOLATION\nconst c = 3; // VIOLATION\n',
    );
    const captured = captureConsole();
    try {
      const code = await command.run(context(repo, ['--all', '--report', 'detailed']));
      expect(code).toBe(1);

      const output = captured.logs.join('\n');
      expect(occurrences(output, 'Flags an explicit VIOLATION marker left in source.')).toBe(3);
      expect(occurrences(output, 'Remove the VIOLATION marker from the file.')).toBe(3);
      expect(output).toContain('3 errors, 0 warnings, 1 file checked');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rejects an unknown --report style and names the ones it takes', async () => {
    const { repo } = await makeConfiguredRepo('const a = 1; // VIOLATION\n');
    const captured = captureConsole();
    try {
      const code = await command.run(context(repo, ['--all', '--report', 'everything']));
      expect(code).toBe(2);
      const errors = captured.errors.join('\n');
      expect(errors).toContain('--report takes one of summary, compact, full, detailed');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('--dedupe-guidance moves the guidance out of the violations and into ruleGuidance', async () => {
    const { repo } = await makeConfiguredRepo(
      'const a = 1; // VIOLATION\nconst b = 2; // VIOLATION\n',
    );
    const captured = captureConsole();
    try {
      const code = await command.run(context(repo, ['--all', '--json', '--dedupe-guidance']));
      expect(code).toBe(1);

      const log = captured.logs[0];
      assertDefined(log, 'expected a single JSON log line');
      const parsed: unknown = JSON.parse(log);
      if (!isRecord(parsed) || !isUnknownArray(parsed.violations)) {
        throw new Error('JSON output has no violations array');
      }
      expect(parsed.violations).toHaveLength(2);
      for (const violation of parsed.violations) {
        if (!isRecord(violation)) {
          throw new Error('a violation is not an object');
        }
        expect(violation.guidance).toBeUndefined();
      }

      const ruleGuidance = parsed.ruleGuidance;
      if (!isRecord(ruleGuidance) || !isRecord(ruleGuidance['no-violation-marker'])) {
        throw new Error('ruleGuidance does not carry the rule');
      }
      expect(ruleGuidance['no-violation-marker'].summary).toBe(
        'Flags an explicit VIOLATION marker left in source.',
      );
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('refuses --dedupe-guidance without --json rather than ignoring it', async () => {
    const { repo } = await makeConfiguredRepo('const a = 1; // VIOLATION\n');
    const captured = captureConsole();
    try {
      const code = await command.run(context(repo, ['--all', '--dedupe-guidance']));
      expect(code).toBe(2);
      expect(captured.errors.join('\n')).toContain('it needs --json');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('returns 2 with a message mentioning `cyv init` when config is missing', async () => {
    const repo = await makeRepo();
    const captured = captureConsole();
    try {
      const code = await command.run(context(repo, []));
      expect(code).toBe(2);
      expect(captured.errors.some((line) => /cyv init/.test(line))).toBe(true);
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('an active suppression removes the violation and reports how many were suppressed', async () => {
    const { repo, sourcePath } = await makeConfiguredRepo('export const value = 1; // VIOLATION\n', [
      {
        ruleId: 'no-violation-marker',
        target: 'src/**',
        reason: 'Known issue, tracked in TICKET-1.',
        expires: '2099-01-01',
      },
    ]);
    const captured = captureConsole();
    try {
      const code = await command.run(context(repo, [sourcePath]));
      expect(code).toBe(0);

      const output = captured.logs.join('\n');
      expect(output).toContain('0 errors, 0 warnings, 1 file checked');
      expect(output).toContain('1 active suppression, 0 expiring within 30 days. 1 finding suppressed this run.');
      expect(output).not.toContain('File contains a VIOLATION marker.');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('an expired suppression does not suppress and names the lapsed suppression', async () => {
    const { repo, sourcePath } = await makeConfiguredRepo('export const value = 1; // VIOLATION\n', [
      {
        ruleId: 'no-violation-marker',
        target: 'src/**',
        reason: 'Should have been fixed by Q1.',
        expires: '2020-01-01',
      },
    ]);
    const captured = captureConsole();
    try {
      const code = await command.run(context(repo, [sourcePath, '--json']));
      expect(code).toBe(1);

      expect(captured.logs).toHaveLength(1);
      const log = captured.logs[0];
      assertDefined(log, 'expected a single JSON log line');
      const report = parseJsonReport(log);
      expect(report.violations).toHaveLength(1);

      const allErrors = captured.errors.join('\n');
      expect(allErrors).toContain('0 active suppressions, 0 expiring within 30 days. 0 findings suppressed this run.');
      expect(allErrors).toContain('EXPIRED');
      expect(allErrors).toContain('no-violation-marker on "src/**" expired 2020-01-01 — Should have been fixed by Q1.');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('exits 2 when a suppression names an unknown rule', async () => {
    const { repo, sourcePath } = await makeConfiguredRepo('export const value = 1; // VIOLATION\n', [
      {
        ruleId: 'no-such-rule',
        target: 'src/**',
        reason: 'Oops.',
        expires: '2099-01-01',
      },
    ]);
    const captured = captureConsole();
    try {
      const code = await command.run(context(repo, [sourcePath, '--json']));
      expect(code).toBe(2);
      expect(captured.errors.some((line) => /unknown rule/.test(line))).toBe(true);
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('reports active and expiring counts even when nothing is suppressed this run', async () => {
    const { repo, sourcePath } = await makeConfiguredRepo('export const value = 1; // VIOLATION\n', [
      {
        ruleId: 'no-violation-marker',
        target: 'other/**',
        reason: 'Does not match the file we are checking.',
        expires: '2099-01-01',
      },
    ]);
    const captured = captureConsole();
    try {
      const code = await command.run(context(repo, [sourcePath]));
      expect(code).toBe(1);

      const output = captured.logs.join('\n');
      expect(output).toContain('File contains a VIOLATION marker.');
      expect(output).toContain('1 active suppression, 0 expiring within 30 days. 0 findings suppressed this run.');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('--pin emits a suppression that defers exactly the pinned finding', async () => {
    const { repo } = await makeConfiguredRepo(
      'const a = 1; // VIOLATION\nconst b = 2;\nconst c = 3; // VIOLATION\n',
    );
    const captured = captureConsole();
    try {
      const code = await command.run(
        context(repo, ['--pin', 'src/thing.ts:1', '--reason', 'Legacy call site, tracked in TICKET-1.']),
      );
      expect(code).toBe(0);

      // One document on stdout, so it can be piped or pasted unedited.
      expect(captured.logs).toHaveLength(1);
      const emitted = captured.logs[0];
      assertDefined(emitted, 'expected the pinned suppression on stdout');
      const pinned = parsePinnedSuppression(emitted);
      expect(pinned.ruleId).toBe('no-violation-marker');
      expect(pinned.target).toBe('src/thing.ts');
      expect(pinned.reason).toBe('Legacy call site, tracked in TICKET-1.');
      expect(pinned.occurrence).toBe(0);
      expect(/^[0-9a-f]{64}$/.test(pinned.fingerprint)).toBe(true);

      // The suppression notice still prints, on stderr, because `--pin` runs a
      // real check and what that check is already hiding must stay stated.
      expect(captured.errors.join('\n')).toContain('0 active suppressions');
      captured.restore();

      // Written back verbatim — the point of the affordance is that nothing
      // about the emitted object has to be edited to make it load.
      await writeFile(join(repo, 'checkyourvibe.json'), JSON.stringify(config([pinned]), null, 2));

      const rerun = captureConsole();
      try {
        const rerunCode = await command.run(context(repo, ['--all']));
        expect(rerunCode).toBe(1);

        const output = rerun.logs.join('\n');
        expect(output).toContain('1 error, 0 warnings, 1 file checked');
        expect(output).toContain('1 active suppression, 0 expiring within 30 days. 1 finding suppressed this run.');
        // The unpinned-suppression callout names nothing, because this one is pinned.
        expect(output).not.toContain('unpinned');
        // The second marker is a different occurrence and is still reported.
        expect(output).toContain('thing.ts:3:17');
        expect(output).not.toContain('thing.ts:1:17');
      } finally {
        rerun.restore();
      }
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('--pin defaults expires to 90 days out and says so', async () => {
    const { repo } = await makeConfiguredRepo('const a = 1; // VIOLATION\n');
    const captured = captureConsole();
    try {
      const code = await command.run(context(repo, ['--pin', 'src/thing.ts:1', '--reason', 'Why.']));
      expect(code).toBe(0);

      const emitted = captured.logs[0];
      assertDefined(emitted, 'expected the pinned suppression on stdout');
      const pinned = parsePinnedSuppression(emitted);

      const expected = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      expect(pinned.expires).toBe(expected);
      expect(captured.errors.join('\n')).toContain('90 days out');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('--pin refuses without a reason', async () => {
    const { repo } = await makeConfiguredRepo('const a = 1; // VIOLATION\n');
    const captured = captureConsole();
    try {
      const code = await command.run(context(repo, ['--pin', 'src/thing.ts:1']));
      expect(code).toBe(2);
      expect(captured.errors.join('\n')).toContain('--reason');
      expect(captured.logs).toHaveLength(0);
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('--pin refuses to guess when a line carries more than one finding', async () => {
    const { repo } = await makeConfiguredRepo('const a = 1; // VIOLATION and VIOLATION\n');
    const captured = captureConsole();
    try {
      const code = await command.run(context(repo, ['--pin', 'src/thing.ts:1', '--reason', 'Why.']));
      expect(code).toBe(2);
      expect(captured.logs).toHaveLength(0);

      const errors = captured.errors.join('\n');
      expect(errors).toContain('2 findings at src/thing.ts:1');
      expect(errors).toContain('no-violation-marker at 1:17');
      expect(errors).toContain('no-violation-marker at 1:31');
      expect(errors).toContain('--pin file:line:column');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('a column picks one of two identical findings on the same line, by occurrence', async () => {
    const { repo } = await makeConfiguredRepo('const a = 1; // VIOLATION and VIOLATION\n');
    const captured = captureConsole();
    try {
      const code = await command.run(
        context(repo, ['--pin', 'src/thing.ts:1:31', '--reason', 'The second one only.']),
      );
      expect(code).toBe(0);

      const emitted = captured.logs[0];
      assertDefined(emitted, 'expected the pinned suppression on stdout');
      const pinned = parsePinnedSuppression(emitted);
      // Both markers hash to the same fingerprint, so `occurrence` is the only
      // field that distinguishes them.
      expect(pinned.occurrence).toBe(1);
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('--pin at a location with no finding lists what the run did report', async () => {
    const { repo } = await makeConfiguredRepo('const a = 1; // VIOLATION\nconst b = 2;\n');
    const captured = captureConsole();
    try {
      const code = await command.run(context(repo, ['--pin', 'src/thing.ts:2', '--reason', 'Why.']));
      expect(code).toBe(2);
      expect(captured.logs).toHaveLength(0);

      const errors = captured.errors.join('\n');
      expect(errors).toContain('No finding at src/thing.ts:2');
      expect(errors).toContain('no-violation-marker at 1:17');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('--pin cannot share stdout with --json', async () => {
    const { repo } = await makeConfiguredRepo('const a = 1; // VIOLATION\n');
    const captured = captureConsole();
    try {
      const code = await command.run(
        context(repo, ['--pin', 'src/thing.ts:1', '--reason', 'Why.', '--json']),
      );
      expect(code).toBe(2);
      expect(captured.errors.join('\n')).toContain('cannot share stdout');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('reports the suppression notice on stderr under --sarif', async () => {
    const { repo, sourcePath } = await makeConfiguredRepo('export const value = 1;\n', [
      {
        ruleId: 'no-violation-marker',
        target: 'src/**',
        reason: 'Known.',
        expires: '2099-01-01',
      },
    ]);
    const captured = captureConsole();
    try {
      const code = await command.run(context(repo, [sourcePath, '--sarif']));
      expect(code).toBe(0);

      // SARIF is a single parseable document on stdout.
      expect(captured.logs).toHaveLength(1);
      const log = captured.logs[0];
      assertDefined(log, 'expected a single SARIF log line');
      const parsed: unknown = JSON.parse(log);
      expect(isRecord(parsed) && parsed.version === '2.1.0').toBe(true);

      const allErrors = captured.errors.join('\n');
      expect(allErrors).toContain('1 active suppression');
      expect(allErrors).toContain('0 findings suppressed this run');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  // `--help` is where `--pin` is discoverable: `cyv --help` lists commands and
  // their summaries and names no flags. Printing help runs no analyzers, so it
  // needs no configured repository.
  it('prints its flags for --help without running a check', async () => {
    const captured = captureConsole();
    try {
      const code = await command.run(context(process.cwd(), ['--help']));
      expect(code).toBe(0);

      const help = captured.logs.join('\n');
      expect(help).toContain('Usage: cyv check');
      for (const flag of [
        '--staged',
        '--working',
        '--branch',
        '--all',
        '--report',
        '--json',
        '--dedupe-guidance',
        '--sarif',
        '--no-color',
        '--since-baseline',
        '--strict',
        '--record-history',
        '--pin',
        '--rule',
        '--reason',
        '--expires',
      ]) {
        expect(help).toContain(flag);
      }
    } finally {
      captured.restore();
    }
  });
});

describe('baseline staleness notice', () => {
  // A baseline entry is "stale" when nothing matches it any more. Only a
  // whole-repository run can support that claim: a narrower run leaves most of
  // the baseline unexamined, and an entry whose file was never checked has not
  // stopped matching — it was simply not looked for. Advising `cyv baseline` on
  // that evidence pushes the user to shrink a baseline against a partial run.
  it('reports stale entries after a repository-wide run', async () => {
    const { repo, sourcePath } = await makeConfiguredRepo('export const value = 1; // VIOLATION\n');
    const captured = captureConsole();
    try {
      const { report } = await runCheck({ cwd: repo, mode: 'all' });
      await writeBaseline(repo, report, 'commit-1');

      // Fixed, so the baseline entry now matches nothing.
      await writeFile(sourcePath, 'export const value = 1;\n');

      await command.run(context(repo, ['--all']));
      expect(captured.logs.join('\n')).toContain('no longer match anything');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('does not claim staleness from a run that checked only some files', async () => {
    const { repo, sourcePath } = await makeConfiguredRepo('export const value = 1; // VIOLATION\n');
    const captured = captureConsole();
    try {
      const { report } = await runCheck({ cwd: repo, mode: 'all' });
      await writeBaseline(repo, report, 'commit-1');

      await writeFile(sourcePath, 'export const value = 1;\n');

      await command.run(context(repo, [sourcePath]));
      expect(captured.logs.join('\n')).not.toContain('no longer match anything');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });
});
