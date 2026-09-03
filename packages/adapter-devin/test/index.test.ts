import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import devinPlugin from '../src/index.js';
import type { PlanContext, RuleManifest, Violation } from '../../core/src/protocol/index.js';

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

function isJSONObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface HookSpecificOutputShape {
  hookSpecificOutput: {
    hookEventName: string;
    additionalContext: string;
  };
}

// Narrows the parsed stdout JSON to the shape this suite asserts on, without
// an `as` cast — an unvalidated cast would happily lie about a malformed
// hookSpecificOutput and the assertions below would then check the wrong thing.
function isHookSpecificOutputShape(value: unknown): value is HookSpecificOutputShape {
  if (!isJSONObject(value)) {
    return false;
  }
  const hookSpecificOutput = value['hookSpecificOutput'];
  if (!isJSONObject(hookSpecificOutput)) {
    return false;
  }
  return (
    typeof hookSpecificOutput['hookEventName'] === 'string' &&
    typeof hookSpecificOutput['additionalContext'] === 'string'
  );
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
  // The fixture is a `PostToolUse` payload recorded from a real run of the CLI
  // against a hook that logged its standard input. Its one departure from the
  // capture is the path: the run was on Windows and carried a backslashed
  // absolute path in the same `tool_input.file_path` field, and a POSIX
  // absolute path is absolute on both platforms.
  it('reads the edited path out of the recorded payload', async () => {
    const fixtureUrl = new URL('./fixtures/post-tool-use.json', import.meta.url);
    const raw = await readFile(fixtureUrl, 'utf8');
    const payload = devinPlugin.parseHookPayload(raw);

    expect(payload.event).toBe('PostToolUse');
    expect(payload.scope).toBe('files');
    expect(payload.files).toEqual(['/home/user/checkout/src/components/Widget.tsx']);
  });

  it('resolves a relative path against the current working directory', () => {
    const raw = JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'edit',
      tool_input: { file_path: 'relative/widget.ts', old_string: 'a', new_string: 'b' },
    });

    const payload = devinPlugin.parseHookPayload(raw);

    expect(payload.scope).toBe('files');
    expect(payload.files).toEqual([join(process.cwd(), 'relative/widget.ts')]);
  });

  it('falls back to working-tree scope for a tool whose input names no file', () => {
    const raw = JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'exec',
      tool_input: { command: 'pnpm test' },
    });

    const payload = devinPlugin.parseHookPayload(raw);

    expect(payload.scope).toBe('working-tree');
    expect(payload.files).toEqual([]);
    expect(payload.event).toBe('PostToolUse');
  });

  it('falls back to working-tree scope when tool_input is missing entirely', () => {
    const payload = devinPlugin.parseHookPayload(
      JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'exec' }),
    );

    expect(payload.scope).toBe('working-tree');
    expect(payload.files).toEqual([]);
  });

  it('falls back to working-tree scope when the payload is a JSON array, not an object', () => {
    const payload = devinPlugin.parseHookPayload(JSON.stringify(['not', 'an', 'object']));

    expect(payload.scope).toBe('working-tree');
    expect(payload.files).toEqual([]);
  });

  it('defaults the event name to PostToolUse when absent', () => {
    const payload = devinPlugin.parseHookPayload(JSON.stringify({}));

    expect(payload.event).toBe('PostToolUse');
    expect(payload.scope).toBe('working-tree');
  });

  it('carries the event name the payload gave', () => {
    const payload = devinPlugin.parseHookPayload(
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'write' }),
    );

    expect(payload.event).toBe('PreToolUse');
  });

  it('throws on malformed JSON', () => {
    expect(() => devinPlugin.parseHookPayload('not json')).toThrow();
  });
});

describe('detect', () => {
  it('returns true when <repoRoot>/.devin exists', async () => {
    const emptyPath = await mkdtemp(join(tmpdir(), 'cyv-empty-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));
    await mkdir(join(repoRoot, '.devin'), { recursive: true });

    const result = await withPath(emptyPath)(() => devinPlugin.detect({ homeDir, repoRoot }));

    expect(result).toBe(true);
  });

  it('returns true when ~/.config/devin exists', async () => {
    const emptyPath = await mkdtemp(join(tmpdir(), 'cyv-empty-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));
    await mkdir(join(homeDir, '.config', 'devin'), { recursive: true });

    const result = await withPath(emptyPath)(() => devinPlugin.detect({ homeDir, repoRoot }));

    expect(result).toBe(true);
  });

  it('returns true when a devin binary resolves on PATH', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'cyv-bin-'));
    await writeFile(join(binDir, 'devin'), '');
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));

    const result = await withPath(binDir)(() => devinPlugin.detect({ homeDir, repoRoot }));

    expect(result).toBe(true);
  });

  it('returns false when neither a directory nor a binary exists', async () => {
    const emptyPath = await mkdtemp(join(tmpdir(), 'cyv-empty-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));

    const result = await withPath(emptyPath)(() => devinPlugin.detect({ homeDir, repoRoot }));

    expect(result).toBe(false);
  });
});

describe('plan', () => {
  it('produces the hooks merge, the AGENTS.md workflow block, and one skill per rule', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));
    const rules = [makeRule('no-any'), makeRule('no-as-cast')];
    const ctx: PlanContext = {
      homeDir,
      repoRoot,
      cyvCommand: '/opt/cyv/bin/cyv',
      rules,
    };

    const writes = await devinPlugin.plan(ctx);

    expect(writes).toHaveLength(2 + rules.length);

    const hooks = writes.find((w) => w.path === join(repoRoot, '.devin', 'hooks.v1.json'));
    assertDefined(hooks, 'expected a hooks.v1.json write');
    expect(hooks.strategy).toBe('json-merge');
    expect(hooks.ownershipMarker).toBe('hook devin');
    expect(hooks.content).toContain('/opt/cyv/bin/cyv hook devin');
    const parsedHooks: unknown = JSON.parse(hooks.content);
    expect(parsedHooks).toMatchObject({
      PostToolUse: [
        {
          matcher: 'edit|write',
          hooks: [
            { type: 'command', timeout: 30000 },
            { type: 'command', timeout: 30000 },
          ],
        },
      ],
    });

    const agentsMd = writes.find((w) => w.path === join(repoRoot, 'AGENTS.md'));
    assertDefined(agentsMd, 'expected an AGENTS.md write');
    expect(agentsMd.strategy).toBe('managed-block');
    expect(agentsMd.blockId).toBe('devin-workflow');
    expect(agentsMd.content).toContain('PostToolUse');

    for (const rule of rules) {
      const skill = writes.find(
        (w) => w.path === join(repoRoot, '.devin', 'skills', `cyv-${rule.id}`, 'SKILL.md'),
      );
      assertDefined(skill, `expected a skill write for ${rule.id}`);
      expect(skill.strategy).toBe('create-if-absent');
      expect(skill.content.startsWith('---\n')).toBe(true);
      expect(skill.content).toContain(`name: cyv-${rule.id}`);
      expect(skill.content).toContain('description: ');
      const notFix = rule.notFixes[0];
      assertDefined(notFix, `expected rule ${rule.id} to have a not-fix`);
      expect(skill.content).toContain(notFix.pattern);
    }
  });

  it('keeps a summary carrying a colon inside one YAML scalar', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));
    const rule = makeRule('no-any', { summary: 'Avoid this: it hides a "type" problem.' });
    const ctx: PlanContext = { homeDir, repoRoot, cyvCommand: '/opt/cyv/bin/cyv', rules: [rule] };

    const writes = await devinPlugin.plan(ctx);
    const skill = writes.find(
      (w) => w.path === join(repoRoot, '.devin', 'skills', 'cyv-no-any', 'SKILL.md'),
    );
    assertDefined(skill, 'expected a skill write');

    expect(skill.content).toContain(
      `description: ${JSON.stringify('Avoid this: it hides a "type" problem.')}`,
    );
  });

  it("uses a blockId distinct from other adapters', since AGENTS.md is shared ground", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));
    const ctx: PlanContext = {
      homeDir,
      repoRoot,
      cyvCommand: '/opt/cyv/bin/cyv',
      rules: [makeRule('no-any')],
    };

    const writes = await devinPlugin.plan(ctx);
    const agentsMd = writes.find((w) => w.path === join(repoRoot, 'AGENTS.md'));
    assertDefined(agentsMd, 'expected an AGENTS.md write');

    expect(agentsMd.blockId).toBe('devin-workflow');
    expect(agentsMd.blockId).not.toBe('workflow');
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

    await devinPlugin.plan(ctx);

    expect(await readdir(homeDir)).toHaveLength(0);
    expect(await readdir(repoRoot)).toHaveLength(0);
  });
});

describe('formatResult', () => {
  it('returns exit code 0 and parseable, near-empty stdout when clean', () => {
    const result = devinPlugin.formatResult([], { files: ['/a.ts', '/b.ts'] });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it('carries the findings in additionalContext and still exits 0', () => {
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
        allowedFixes: ['Use a concrete type.'],
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

    const result = devinPlugin.formatResult([violation], { files: [violation.file] });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');

    const parsed: unknown = JSON.parse(result.stdout);
    if (!isHookSpecificOutputShape(parsed)) {
      throw new Error('expected stdout to parse into a hookSpecificOutput shape');
    }
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    const additionalContext = parsed.hookSpecificOutput.additionalContext;
    expect(additionalContext).toContain('no-any');
    expect(additionalContext).toContain('Unexpected `any` type.');
    expect(additionalContext).toContain('Widen to `unknown`');
    expect(additionalContext).toContain('rule: no-unknown');
  });
});
