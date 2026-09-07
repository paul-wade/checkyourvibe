import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command, runHook, readLifecycleEvents, type LifecycleEvent } from '../../src/cli/hook.js';
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

const NOTFIX_PATTERN = 'Silence the marker with a non-null assertion';
const NOTFIX_BECAUSE = 'It asserts presence where nothing proves it.';

function analyzerManifest(notFixes: unknown[] = []): unknown {
  const rules: unknown[] = [
    {
      id: 'no-violation-marker',
      category: 'test',
      scope: 'file',
      severity: 'error',
      summary: 'Flags an explicit VIOLATION marker left in source.',
      why: 'Keeps this fixture deterministically wrong so tests can assert on it.',
      allowedFixes: ['Remove the VIOLATION marker from the file.'],
      notFixes,
      examples: { bad: 'const x = 1; // VIOLATION', good: 'const x = 1;' },
    },
  ];
  if (notFixes.length > 0) {
    // A notFix's `rule` must name a rule in the same catalog, so the rule it
    // would trip is declared alongside the one that lists it.
    rules.push({
      id: 'no-non-null-assertion',
      category: 'test',
      scope: 'file',
      severity: 'error',
      summary: 'Disallows postfix non-null assertions.',
      why: 'An assertion does not make an absent value present.',
      allowedFixes: ['Guard the value before reading it.'],
      notFixes: [],
      examples: { bad: 'const v = maybe!;', good: 'const v = maybe ?? fallback;' },
    });
  }
  return {
    protocol: 1,
    id: 'stub',
    match: ['**/*.ts'],
    rules,
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

async function makeConfiguredRepo(
  sourceContent: string,
  notFixes: unknown[] = [],
): Promise<{ repo: string; sourcePath: string }> {
  const repo = await makeRepo();
  await copySchema(repo);
  await writeFile(join(repo, 'checkyourvibe.json'), JSON.stringify(config(), null, 2));
  await writeFile(join(repo, 'analyzer.manifest.json'), JSON.stringify(analyzerManifest(notFixes), null, 2));
  await writeFile(join(repo, 'analyzer.mjs'), ANALYZER_MODULE);

  const srcDir = join(repo, 'src');
  await mkdir(srcDir, { recursive: true });
  const sourcePath = join(srcDir, 'thing.ts');
  await writeFile(sourcePath, sourceContent);

  return { repo, sourcePath };
}

function context(repo: string, argv: string[]): CommandContext {
  // An ambient CYV_DISPATCH_* left by a surrounding run would scope these
  // tests to a dispatch that does not exist here; each test declares its own.
  const env = { ...process.env };
  delete env.CYV_DISPATCH_DECLARATION;
  delete env.CYV_DISPATCH_ID;
  delete env.CYV_DISPATCH_PARENTS;
  return { cwd: repo, argv, env };
}

function claudeCodePayload(filePath: string): string {
  return JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_input: { file_path: filePath },
  });
}

function claudeCodePrePayload(toolName: string, toolInput: unknown): string {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    session_id: 'test-session',
  });
}

async function decisionLog(repo: string): Promise<string> {
  return readFile(join(repo, '.cyv-review', 'decisions.jsonl'), 'utf-8');
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

describe('cyv hook PreToolUse', () => {
  it('denies a Write whose proposed content violates, with the rule guidance in the reason', async () => {
    const { repo } = await makeConfiguredRepo('export const value = 1;\n');
    const newPath = join(repo, 'src', 'new.ts');
    const captured = captureStd();
    try {
      const code = await runHook(
        context(repo, ['claude-code']),
        claudeCodePrePayload('Write', {
          file_path: newPath,
          content: 'export const value = 1; // VIOLATION\n',
        }),
      );
      // The decision travels in the structured protocol on stdout, so a deny
      // is still a clean exit — only `permissionDecision` blocks the call.
      expect(code).toBe(0);
      const out = captured.outLines.join('');
      expect(out).toContain('"permissionDecision":"deny"');
      expect(out).toContain('no-violation-marker');
      // The reason names the real file, not the materialized check file, and
      // nothing temporary is left behind.
      expect(out).not.toContain('cyv-pending');
      const srcEntries = await readdir(join(repo, 'src'));
      expect(srcEntries.some((name) => name.includes('cyv-pending'))).toBe(false);

      const log = await decisionLog(repo);
      expect(log).toContain('"decision":"deny"');
      expect(log).toContain('no-violation-marker');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('denies an Edit whose result would introduce a violation', async () => {
    const { repo, sourcePath } = await makeConfiguredRepo('export const value = 1;\n');
    const captured = captureStd();
    try {
      const code = await runHook(
        context(repo, ['claude-code']),
        claudeCodePrePayload('Edit', {
          file_path: sourcePath,
          old_string: 'export const value = 1;',
          new_string: 'export const value = 1; // VIOLATION',
        }),
      );
      expect(code).toBe(0);
      const out = captured.outLines.join('');
      expect(out).toContain('"permissionDecision":"deny"');
      expect(out).toContain('no-violation-marker');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('denies an Edit on a CRLF file whose old_string arrives normalized to LF', async () => {
    // A checkout under core.autocrlf holds \r\n on disk while the tool input
    // carries \n. A byte-exact match finds nothing, which used to read as
    // "the edit would not apply" and let the write through unchecked.
    const { repo, sourcePath } = await makeConfiguredRepo(
      'export const value = 1;\r\nexport const other = 2;\r\n',
    );
    const captured = captureStd();
    try {
      const code = await runHook(
        context(repo, ['claude-code']),
        claudeCodePrePayload('Edit', {
          file_path: sourcePath,
          old_string: 'export const value = 1;\nexport const other = 2;',
          new_string: 'export const value = 1; // VIOLATION\nexport const other = 2;',
        }),
      );
      expect(code).toBe(0);
      const out = captured.outLines.join('');
      expect(out).toContain('"permissionDecision":"deny"');
      expect(out).toContain('no-violation-marker');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('allows a Write with clean proposed content', async () => {
    const { repo } = await makeConfiguredRepo('export const value = 1;\n');
    const captured = captureStd();
    try {
      const code = await runHook(
        context(repo, ['claude-code']),
        claudeCodePrePayload('Write', {
          file_path: join(repo, 'src', 'clean.ts'),
          content: 'export const value = 2;\n',
        }),
      );
      expect(code).toBe(0);
      expect(captured.outLines.join('')).toContain('"permissionDecision":"allow"');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('allows a tool it does not recognize, and records why', async () => {
    const { repo } = await makeConfiguredRepo('export const value = 1;\n');
    const captured = captureStd();
    try {
      const code = await runHook(
        context(repo, ['claude-code']),
        claudeCodePrePayload('Frobnicate', { some: 'input' }),
      );
      expect(code).toBe(0);
      expect(captured.outLines.join('')).toContain('"permissionDecision":"allow"');

      const log = await decisionLog(repo);
      expect(log).toContain('Frobnicate');
      expect(log).toContain('unrecognized tool');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('denies a Bash redirect that targets a file cyv analyzes, naming the path', async () => {
    const { repo } = await makeConfiguredRepo('export const value = 1;\n');
    const captured = captureStd();
    try {
      const code = await runHook(
        context(repo, ['claude-code']),
        claudeCodePrePayload('Bash', {
          command: 'echo "const value = 1" > src/thing.ts',
        }),
      );
      expect(code).toBe(0);
      const out = captured.outLines.join('');
      expect(out).toContain('"permissionDecision":"deny"');
      expect(out).toContain('src/thing.ts');

      const log = await decisionLog(repo);
      expect(log).toContain('"decision":"deny"');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('denies a heredoc that writes to a file cyv analyzes', async () => {
    const { repo } = await makeConfiguredRepo('export const value = 1;\n');
    const captured = captureStd();
    try {
      const code = await runHook(
        context(repo, ['claude-code']),
        claudeCodePrePayload('Bash', {
          command: 'cat <<\'EOF\' > src/thing.ts\nconst value = 1;\nEOF',
        }),
      );
      expect(code).toBe(0);
      const out = captured.outLines.join('');
      expect(out).toContain('"permissionDecision":"deny"');
      expect(out).toContain('src/thing.ts');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('allows a Bash command that writes nothing', async () => {
    const { repo } = await makeConfiguredRepo('export const value = 1;\n');
    const captured = captureStd();
    try {
      const code = await runHook(
        context(repo, ['claude-code']),
        claudeCodePrePayload('Bash', { command: 'pnpm test' }),
      );
      expect(code).toBe(0);
      expect(captured.outLines.join('')).toContain('"permissionDecision":"allow"');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('allows a Bash write whose target cannot be resolved, and records it', async () => {
    // Requirement 2.3: a write cyv cannot classify is reported, not ignored.
    const { repo } = await makeConfiguredRepo('export const value = 1;\n');
    const captured = captureStd();
    try {
      const code = await runHook(
        context(repo, ['claude-code']),
        claudeCodePrePayload('Bash', { command: 'echo hi > $OUT' }),
      );
      expect(code).toBe(0);
      expect(captured.outLines.join('')).toContain('"permissionDecision":"allow"');

      const log = await decisionLog(repo);
      expect(log).toContain('could not be resolved');
      expect(log).toContain('$OUT');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('omits the notFixes section under --omit-notfixes but keeps the rule guidance', async () => {
    // The flag is what makes the benchmark's bare arms possible: the report
    // must carry the rule id, summary, why and allowed fixes, and none of
    // the not-fix list.
    const notFixes = [{ pattern: NOTFIX_PATTERN, because: NOTFIX_BECAUSE, rule: 'no-non-null-assertion' }];
    const { repo, sourcePath } = await makeConfiguredRepo(
      'export const value = 1; // VIOLATION\n',
      notFixes,
    );
    const captured = captureStd();
    try {
      const code = await runHook(
        context(repo, ['claude-code', '--omit-notfixes']),
        claudeCodePayload(sourcePath),
      );
      expect(code).toBe(2);
      const err = captured.errLines.join('');
      expect(err).toContain('no-violation-marker');
      expect(err).toContain('Flags an explicit VIOLATION marker');
      expect(err).toContain('Allowed fixes');
      expect(err).not.toContain(NOTFIX_PATTERN);
      expect(err).not.toContain(NOTFIX_BECAUSE);
      expect(err).not.toContain('Non-fixes');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('reports the notFixes section when --omit-notfixes is absent', async () => {
    const notFixes = [{ pattern: NOTFIX_PATTERN, because: NOTFIX_BECAUSE, rule: 'no-non-null-assertion' }];
    const { repo, sourcePath } = await makeConfiguredRepo(
      'export const value = 1; // VIOLATION\n',
      notFixes,
    );
    const captured = captureStd();
    try {
      const code = await runHook(context(repo, ['claude-code']), claudeCodePayload(sourcePath));
      expect(code).toBe(2);
      const err = captured.errLines.join('');
      expect(err).toContain('no-violation-marker');
      expect(err).toContain(NOTFIX_PATTERN);
      expect(err).toContain(NOTFIX_BECAUSE);
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('strips notFixes from a denial reason under --omit-notfixes', async () => {
    // A denied edit hands `permissionDecisionReason` to the model, so the
    // bare variant has to hold there too — stripping only the post-tool
    // report would leave the enforcing arm unable to produce bare guidance.
    const notFixes = [{ pattern: NOTFIX_PATTERN, because: NOTFIX_BECAUSE, rule: 'no-non-null-assertion' }];
    const { repo } = await makeConfiguredRepo('export const value = 1;\n', notFixes);
    const captured = captureStd();
    try {
      const code = await runHook(
        context(repo, ['claude-code', '--omit-notfixes']),
        claudeCodePrePayload('Write', {
          file_path: join(repo, 'src', 'new.ts'),
          content: 'export const value = 1; // VIOLATION\n',
        }),
      );
      expect(code).toBe(0);
      const out = captured.outLines.join('');
      expect(out).toContain('"permissionDecision":"deny"');
      expect(out).toContain('no-violation-marker');
      expect(out).toContain('Allowed fixes');
      expect(out).not.toContain(NOTFIX_PATTERN);
      expect(out).not.toContain(NOTFIX_BECAUSE);
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('prints usage that marks --omit-notfixes as a benchmark-only flag', async () => {
    const { repo } = await makeConfiguredRepo('export const value = 1;\n');
    const captured = captureStd();
    try {
      const code = await command.run(context(repo, ['--help']));
      expect(code).toBe(0);
      const out = captured.outLines.join('');
      expect(out).toContain('--omit-notfixes');
      expect(out).toMatch(/benchmark/i);
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('allows — and records the failure — when cyv itself throws, rather than denying on its own bug', async () => {
    const { repo } = await makeConfiguredRepo('export const value = 1;\n');
    // A configured analyzer whose manifest is missing makes the check
    // pipeline throw. The gate never fails closed on its own bug.
    const broken = {
      packs: [],
      analyzers: [{ id: 'ghost', package: './does-not-exist.json' }],
      rules: {},
      strict: false,
      exclude: [],
    };
    await writeFile(join(repo, 'checkyourvibe.json'), JSON.stringify(broken, null, 2));

    const captured = captureStd();
    try {
      const code = await runHook(
        context(repo, ['claude-code']),
        claudeCodePrePayload('Write', {
          file_path: join(repo, 'src', 'new.ts'),
          content: 'export const value = 1; // VIOLATION\n',
        }),
      );
      expect(code).toBe(0);
      expect(captured.outLines.join('')).toContain('"permissionDecision":"allow"');
      expect(captured.outLines.join('')).not.toContain('"deny"');

      const log = await decisionLog(repo);
      expect(log).toContain('internal error');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('lifecycle events', () => {
  function lifecyclePayload(
    repo: string,
    event: string,
    sessionId: string,
    extra?: Record<string, unknown>,
  ): string {
    return JSON.stringify({ hook_event_name: event, session_id: sessionId, cwd: repo, ...extra });
  }

  it('records SessionStart with session id, cwd and source', async () => {
    const { repo } = await makeConfiguredRepo('export const value = 1;\n');
    const captured = captureStd();
    try {
      const code = await runHook(
        context(repo, ['claude-code']),
        lifecyclePayload(repo, 'SessionStart', 'test-sess-1', { source: 'startup' }),
      );
      expect(code).toBe(0);

      const events = await readLifecycleEvents(repo);
      expect(events).toHaveLength(1);
      const [first] = events;
      expect(first?.event).toBe('SessionStart');
      expect(first?.sessionId).toBe('test-sess-1');
      expect(first?.cwd).toBe(repo);
      expect(first?.source).toBe('startup');
      expect(first?.at).toMatch(/^\d{4}-/);
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('records UserPromptSubmit, Stop and SessionEnd', async () => {
    const { repo } = await makeConfiguredRepo('export const value = 1;\n');
    const captured = captureStd();
    try {
      for (const payload of [
        lifecyclePayload(repo, 'UserPromptSubmit', 'test-sess-2'),
        lifecyclePayload(repo, 'Stop', 'test-sess-2'),
        lifecyclePayload(repo, 'SessionEnd', 'test-sess-2', { reason: 'user stopped' }),
      ]) {
        const code = await runHook(context(repo, ['claude-code']), payload);
        expect(code).toBe(0);
      }

      const events = await readLifecycleEvents(repo);
      expect(events.map((e) => e.event)).toEqual([
        'UserPromptSubmit',
        'Stop',
        'SessionEnd',
      ]);
      const end = events[events.length - 1];
      if (end === undefined) throw new Error('Expected SessionEnd event.');
      expect(end.reason).toBe('user stopped');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  // `Stop` is both a lifecycle event and the turn's last analysis checkpoint.
  // It is the only point that sees a file a shell command created or moved,
  // which `PostToolUse` never reports. Recording the event was once made to
  // return early, which silently disabled that check while every test stayed
  // green — the existing lifecycle test uses a clean file, so it passes either
  // way. This one does not: it asserts the event is recorded *and* the
  // violation is still reported.
  it('records Stop and still analyzes the working tree', async () => {
    const { repo } = await makeConfiguredRepo('export const value = 1; // VIOLATION\n');
    const captured = captureStd();
    try {
      const code = await runHook(context(repo, ['claude-code']), lifecyclePayload(repo, 'Stop', 'test-sess-4'));

      const events = await readLifecycleEvents(repo);
      expect(events.map((e) => e.event)).toEqual(['Stop']);

      const reported = `${captured.errLines.join('')}${captured.outLines.join('')}`;
      expect(reported).toContain('no-violation-marker');
      expect(code).not.toBe(0);
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('does not fail the turn when the lifecycle log cannot be written', async () => {
    const { repo } = await makeConfiguredRepo('export const value = 1;\n');
    // Make `.cyv-review` a file so the directory creation fails.
    await writeFile(join(repo, '.cyv-review'), 'not a directory');

    const captured = captureStd();
    try {
      const code = await runHook(
        context(repo, ['claude-code']),
        lifecyclePayload(repo, 'SessionStart', 'test-sess-3', { source: 'startup' }),
      );
      expect(code).toBe(0);
      expect(captured.errLines.join('')).toContain('could not record the lifecycle event');
    } finally {
      captured.restore();
      await rm(repo, { recursive: true, force: true });
    }
  });
});
