import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import claudeCodePlugin from '../src/index.js';
import type {
  PlanContext,
  RuleManifest,
  Violation,
} from '@checkyourvibe/core';

function makeRule(id: string, overrides?: Partial<RuleManifest>): RuleManifest {
  return {
    id,
    category: 'type-safety',
    scope: 'file',
    severity: 'error',
    summary: `Do not violate rule ${id}.`,
    why: `Rule ${id} keeps the code base safe.`,
    allowedFixes: [`Use the correct alternative for ${id}.`],
    notFixes: [
      {
        pattern: `A tempting but wrong workaround for ${id}.`,
        because: 'It trades one violation for another.',
        rule: 'other-rule',
      },
    ],
    examples: {
      bad: `// bad example for ${id}`,
      good: `// good example for ${id}`,
    },
    ...overrides,
  };
}

// Narrows `T | undefined` to `T` and fails the test with a clear message
// instead of asserting it away with `!`, which would silently pass through
// `undefined` if the surrounding expectation were ever loosened.
function assertDefined<T>(value: T | undefined, message: string): asserts value is T {
  if (value === undefined) {
    throw new Error(message);
  }
}

function withPath(value: string): <T>(fn: () => Promise<T>) => Promise<T> {
  const original = process.env.PATH;
  return async (fn) => {
    process.env.PATH = value;
    try {
      return await fn();
    } finally {
      if (original === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = original;
      }
    }
  };
}

describe('parseHookPayload', () => {
  it('extracts the path from the committed fixture', async () => {
    const fixtureUrl = new URL('./fixtures/post-tool-use.json', import.meta.url);
    const raw = await readFile(fixtureUrl, 'utf8');
    const payload = claudeCodePlugin.parseHookPayload(raw);

    expect(payload.event).toBe('PostToolUse');
    expect(payload.files).toHaveLength(1);
    const file = payload.files[0];
    assertDefined(file, 'expected one file in the payload');
    expect(file).toBe('/home/user/checkout/src/components/Widget.tsx');
  });

  it('asks for a working-tree check when the turn is ending', () => {
    // Stop carries no tool_input: nothing was edited, the agent is trying to
    // finish. A file created or moved by a shell command never raised an
    // Edit or Write event, so the only chance to see it is here.
    const payload = claudeCodePlugin.parseHookPayload(
      JSON.stringify({ hook_event_name: 'Stop', cwd: '/home/user/checkout' }),
    );

    expect(payload.event).toBe('Stop');
    expect(payload.scope).toBe('working-tree');
    expect(payload.files).toEqual([]);
  });

  it('throws on malformed JSON', () => {
    expect(() => claudeCodePlugin.parseHookPayload('not json')).toThrow();
  });

  it('throws when no file path is present', () => {
    expect(() =>
      claudeCodePlugin.parseHookPayload(JSON.stringify({ tool_input: {} })),
    ).toThrow();
  });

  it('falls back to tool_input.filePath', () => {
    const raw = JSON.stringify({
      tool_input: { filePath: '/tmp/fallback.ts' },
      hook_event_name: 'PostToolUse',
    });
    const payload = claudeCodePlugin.parseHookPayload(raw);
    const fallback = payload.files[0];
    assertDefined(fallback, 'expected one file in the payload');
    expect(fallback).toBe('/tmp/fallback.ts');
  });

  it('resolves a relative path to an absolute path', () => {
    const raw = JSON.stringify({
      tool_input: { file_path: 'src/index.ts' },
    });
    const payload = claudeCodePlugin.parseHookPayload(raw);
    const file = payload.files[0];
    assertDefined(file, 'expected one file in the payload');
    expect(file).toBe(join(process.cwd(), 'src/index.ts'));
  });
});

describe('detect', () => {
  it('returns true when ~/.claude/settings.json exists', async () => {
    const emptyPath = await mkdtemp(join(tmpdir(), 'cyv-empty-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    await mkdir(join(homeDir, '.claude'), { recursive: true });
    await writeFile(join(homeDir, '.claude', 'settings.json'), '{}');

    const result = await withPath(emptyPath)(() =>
      claudeCodePlugin.detect({ homeDir, repoRoot: homeDir }),
    );

    expect(result).toBe(true);
  });

  it('returns false when neither settings nor binary exists', async () => {
    const emptyPath = await mkdtemp(join(tmpdir(), 'cyv-empty-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));

    const result = await withPath(emptyPath)(() =>
      claudeCodePlugin.detect({ homeDir, repoRoot: homeDir }),
    );

    expect(result).toBe(false);
  });

  it('returns true when a claude binary resolves on PATH', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'cyv-bin-'));
    await writeFile(join(binDir, 'claude'), '');
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));

    const result = await withPath(binDir)(() =>
      claudeCodePlugin.detect({ homeDir, repoRoot: homeDir }),
    );

    expect(result).toBe(true);
  });
});

describe('plan', () => {
  it('produces the settings merge, managed block, and one file per rule', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));
    const rules = [makeRule('no-any'), makeRule('no-as-cast')];
    const ctx: PlanContext = {
      homeDir,
      repoRoot,
      cyvCommand: '/opt/cyv/bin/cyv',
      rules,
    };

    const writes = await claudeCodePlugin.plan(ctx);

    expect(writes).toHaveLength(4);

    const settings = writes.find(
      (w) => w.path === join(homeDir, '.claude', 'settings.json'),
    );
    assertDefined(settings, 'expected a write for .claude/settings.json');
    expect(settings.strategy).toBe('json-merge');
    expect(settings.content).toContain('Edit|Write');
    expect(settings.content).toContain('/opt/cyv/bin/cyv hook claude-code');

    const claudeMd = writes.find((w) => w.path === join(repoRoot, 'CLAUDE.md'));
    assertDefined(claudeMd, 'expected a write for CLAUDE.md');
    expect(claudeMd.strategy).toBe('managed-block');
    expect(claudeMd.blockId).toBe('claude-code-workflow');
    expect(claudeMd.content).toContain('not-fixes');

    const ruleFiles = writes.filter((w) =>
      w.path.startsWith(join(homeDir, '.claude', 'agents')),
    );
    expect(ruleFiles).toHaveLength(2);

    for (const rule of rules) {
      const file = ruleFiles.find(
        (w) => w.path === join(homeDir, '.claude', 'agents', `cyv-${rule.id}.md`),
      );
      assertDefined(file, `expected a rule file for ${rule.id}`);
      expect(file.strategy).toBe('create-if-absent');
      expect(file.content).toContain(`name: cyv-${rule.id}`);
      expect(file.content).toContain(rule.summary);
      const firstNotFix = rule.notFixes[0];
      assertDefined(firstNotFix, `expected ${rule.id} to have at least one notFix`);
      expect(file.content).toContain(firstNotFix.pattern);
    }
  });

  it('does not touch the filesystem', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));
    const ctx: PlanContext = {
      homeDir,
      repoRoot,
      cyvCommand: '/opt/cyv/bin/cyv',
      rules: [makeRule('no-any')],
    };

    await claudeCodePlugin.plan(ctx);

    expect(await readdir(homeDir)).toHaveLength(0);
    expect(await readdir(repoRoot)).toHaveLength(0);
  });
});

describe('formatResult', () => {
  it('returns exit code 0 and a short stdout line when clean', () => {
    const result = claudeCodePlugin.formatResult([], {
      files: ['/a.ts', '/b.ts'],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('Checked 2 files.');
  });

  it('returns exit code 2 and writes rule id, message, and notFixes to stderr', () => {
    const violation: Violation = {
      file: 'C:\\project\\src\\index.ts',
      line: 5,
      column: 1,
      ruleId: 'no-any',
      message: 'Unexpected `any` type.',
      snippet: 'let x: any;',
      severity: 'error',
      guidance: {
        summary: 'Do not use the `any` type.',
        why: 'It disables the type checker.',
        allowedFixes: [
          'Use a concrete type.',
          'Use `unknown` only when the value is genuinely unknown.',
        ],
        notFixes: [
          {
            pattern: 'Widen to `unknown`',
            because: 'It still avoids describing the value.',
            rule: 'no-unknown',
          },
        ],
        examples: {
          bad: 'let x: any;',
          good: 'let x: string;',
        },
      },
    };

    const result = claudeCodePlugin.formatResult([violation], {
      files: [violation.file],
    });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('no-any');
    expect(result.stderr).toContain('Unexpected `any` type.');
    expect(result.stderr).toContain('Widen to `unknown`');
    expect(result.stderr).toContain('because:');
    expect(result.stderr).toContain('rule: no-unknown');
  });

  // A warning that blocks makes the cheapest way past it deleting the code
  // that triggered it. Observed: a `no-console` warning on an error-handling
  // branch was answered by removing the check.
  it('reports a warning on stdout and does not block', () => {
    const violation: Violation = {
      file: '/project/src/index.ts',
      line: 5,
      column: 1,
      ruleId: 'no-console',
      message: "Do not call the global console member 'error'.",
      snippet: 'console.error(err);',
      severity: 'warning',
    };

    const result = claudeCodePlugin.formatResult([violation], { files: [violation.file] });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('no-console');
  });

  it('blocks when an error accompanies a warning', () => {
    const warning: Violation = {
      file: '/project/src/index.ts',
      line: 5,
      column: 1,
      ruleId: 'no-console',
      message: "Do not call the global console member 'error'.",
      snippet: 'console.error(err);',
      severity: 'warning',
    };
    const error: Violation = {
      file: '/project/src/index.ts',
      line: 9,
      column: 1,
      ruleId: 'no-any',
      message: 'Unexpected `any` type.',
      snippet: 'let x: any;',
      severity: 'error',
    };

    const result = claudeCodePlugin.formatResult([warning, error], { files: [warning.file] });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('no-any');
    expect(result.stderr).toContain('no-console');
  });
});
