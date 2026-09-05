import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook } from '../../src/cli/hook.js';
import { runCheck } from '../../src/run/check.js';
import { writeBaseline } from '../../src/baseline/write.js';
import type { CommandContext } from '../../src/cli/types.js';

const ANALYZER_MODULE = `
import { readFileSync } from 'node:fs';

export default async function analyze(request) {
  const violations = [];
  for (const file of request.files) {
    const content = readFileSync(file, 'utf-8');
    if (content.includes('VIOLATION')) {
      violations.push({
        file,
        line: 1,
        column: 1,
        ruleId: 'no-violation-marker',
        message: 'File contains a VIOLATION marker.',
        snippet: 'VIOLATION',
      });
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

function config(): unknown {
  return {
    packs: [],
    analyzers: [{ id: 'stub', package: './analyzer.manifest.json' }],
    rules: { 'no-violation-marker': {} },
    strict: false,
    exclude: [],
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
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'cyv-hook-')));
  const repo = join(parent, 'repo');
  await mkdir(repo, { recursive: true });
  execFileSync('git', ['init'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
  return repo;
}

async function makeConfiguredRepo(sourceContent: string): Promise<{ repo: string; sourcePath: string }> {
  const repo = await makeRepo();
  await copySchema(repo);
  await writeFile(join(repo, 'checkyourvibe.json'), JSON.stringify(config(), null, 2));
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

function claudeCodePayload(filePath: string): string {
  return JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_input: { file_path: filePath },
  });
}

interface Captured {
  outLines: string[];
  errLines: string[];
  restore: () => void;
}

function captureStd(): Captured {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    outLines.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    errLines.push(String(chunk));
    return true;
  });
  return {
    outLines,
    errLines,
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

describe('cyv hook', () => {
  it('exits 2 with the rule id on stderr for a valid payload naming a violating file', async () => {
    const { repo, sourcePath } = await makeConfiguredRepo('export const value = 1; // VIOLATION\n');
    const captured = captureStd();
    try {
      const code = await runHook(context(repo, ['claude-code']), claudeCodePayload(sourcePath));
      expect(code).toBe(2);
      expect(captured.errLines.join('')).toContain('no-violation-marker');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('--observe records a violation without telling the agent anything', async () => {
    // The point of observing is to measure how often an edit introduces a
    // violation without changing what the agent does. A hook that speaks, or
    // exits non-zero, is an intervention, and cannot be used as an instrument
    // in an arm that is meant to be unenforced.
    const { repo, sourcePath } = await makeConfiguredRepo('export const value = 1; // VIOLATION\n');
    const captured = captureStd();
    try {
      const code = await runHook(
        context(repo, ['claude-code', '--observe']),
        claudeCodePayload(sourcePath),
      );
      expect(code).toBe(0);
      expect(captured.errLines).toHaveLength(0);
      expect(captured.outLines).toHaveLength(0);

      const log = await readFile(join(repo, '.cyv-review', 'observations.jsonl'), 'utf-8');
      const first = log.trim().split('\n')[0] ?? '{}';
      const entry: unknown = JSON.parse(first);
      expect(entry).toMatchObject({ violationCount: 1, sequence: 1 });
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('--observe records a clean edit too, so a rate has a denominator', async () => {
    const { repo, sourcePath } = await makeConfiguredRepo('export const value = 1;\n');
    const captured = captureStd();
    try {
      const code = await runHook(
        context(repo, ['claude-code', '--observe']),
        claudeCodePayload(sourcePath),
      );
      expect(code).toBe(0);

      const log = await readFile(join(repo, '.cyv-review', 'observations.jsonl'), 'utf-8');
      const entry: unknown = JSON.parse(log.trim().split('\n')[0] ?? '{}');
      expect(entry).toMatchObject({ violationCount: 0, sequence: 1 });
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('exits 0 for a valid payload naming a clean file', async () => {
    const { repo, sourcePath } = await makeConfiguredRepo('export const value = 1;\n');
    const captured = captureStd();
    try {
      const code = await runHook(context(repo, ['claude-code']), claudeCodePayload(sourcePath));
      expect(code).toBe(0);
      expect(captured.errLines).toHaveLength(0);
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('exits 0 with a warning for malformed JSON on stdin', async () => {
    const { repo } = await makeConfiguredRepo('export const value = 1;\n');
    const captured = captureStd();
    try {
      const code = await runHook(context(repo, ['claude-code']), '{ not valid json');
      expect(code).toBe(0);
      expect(captured.errLines.length).toBeGreaterThan(0);
      expect(captured.errLines.join('')).toContain('cyv hook:');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('exits 0 quietly when no configured analyzer claims the named file', async () => {
    const { repo } = await makeConfiguredRepo('export const value = 1;\n');
    const unclaimedPath = join(repo, 'README.md');
    await writeFile(unclaimedPath, '# not typescript\n');
    const captured = captureStd();
    try {
      const code = await runHook(context(repo, ['claude-code']), claudeCodePayload(unclaimedPath));
      expect(code).toBe(0);
      expect(captured.outLines).toHaveLength(0);
      expect(captured.errLines).toHaveLength(0);
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('exits 0 quietly when checkyourvibe.json is missing', async () => {
    const repo = await makeRepo();
    const srcDir = join(repo, 'src');
    await mkdir(srcDir, { recursive: true });
    const sourcePath = join(srcDir, 'thing.ts');
    await writeFile(sourcePath, 'export const value = 1;\n');

    const captured = captureStd();
    try {
      const code = await runHook(context(repo, ['claude-code']), claudeCodePayload(sourcePath));
      expect(code).toBe(0);
      expect(captured.outLines).toHaveLength(0);
      expect(captured.errLines).toHaveLength(0);
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('exits 0 with a warning when checkyourvibe.json exists but cannot be used', async () => {
    const { repo, sourcePath } = await makeConfiguredRepo('export const value = 1;\n');
    await writeFile(join(repo, 'checkyourvibe.json'), '{ not valid json', 'utf-8');

    const captured = captureStd();
    try {
      const code = await runHook(context(repo, ['claude-code']), claudeCodePayload(sourcePath));
      expect(code).toBe(0);
      expect(captured.errLines.length).toBeGreaterThan(0);
      expect(captured.errLines.join('')).toContain('cyv hook:');
      expect(captured.errLines.join('')).toContain('Invalid JSON');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('exits 0 with a warning for an unknown agent id', async () => {
    const { repo } = await makeConfiguredRepo('export const value = 1;\n');
    const captured = captureStd();
    try {
      const code = await runHook(context(repo, ['some-other-agent']), claudeCodePayload(join(repo, 'src', 'thing.ts')));
      expect(code).toBe(0);
      expect(captured.errLines.length).toBeGreaterThan(0);
      expect(captured.errLines.join('')).toMatch(/unknown agent/i);
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('exits 0 with a warning when no agent id is given', async () => {
    const { repo } = await makeConfiguredRepo('export const value = 1;\n');
    const captured = captureStd();
    try {
      const code = await runHook(context(repo, []), claudeCodePayload(join(repo, 'src', 'thing.ts')));
      expect(code).toBe(0);
      expect(captured.errLines.length).toBeGreaterThan(0);
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });
  // A repository that adopts checkyourvibe on an existing codebase baselines
  // what already fails. The agent then edits those same files, and reporting
  // their deferred debt back on every edit buries whatever the agent actually
  // introduced. `install-hooks` already runs the git hook with
  // `--since-baseline`; these pin the same rule for the agent hook.
  it('stays silent for a violation the baseline already defers', async () => {
    const { repo, sourcePath } = await makeConfiguredRepo('export const value = 1; // VIOLATION\n');
    const captured = captureStd();
    try {
      const { report } = await runCheck({ cwd: repo, mode: 'files', paths: [sourcePath] });
      await writeBaseline(repo, report, 'commit-1');

      const code = await runHook(context(repo, ['claude-code']), claudeCodePayload(sourcePath));
      expect(code).toBe(0);
      expect(captured.errLines.join('')).toBe('');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('still reports a violation the baseline does not cover', async () => {
    const { repo, sourcePath } = await makeConfiguredRepo('export const value = 1;\n');
    const captured = captureStd();
    try {
      const { report } = await runCheck({ cwd: repo, mode: 'files', paths: [sourcePath] });
      await writeBaseline(repo, report, 'commit-1');

      // Introduced after the baseline was taken, so it is this edit's problem.
      await writeFile(sourcePath, 'export const value = 1; // VIOLATION\n');

      const code = await runHook(context(repo, ['claude-code']), claudeCodePayload(sourcePath));
      expect(code).toBe(2);
      expect(captured.errLines.join('')).toContain('no-violation-marker');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });
});
