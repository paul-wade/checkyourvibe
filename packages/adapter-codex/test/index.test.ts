import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import codexPlugin from '../src/index.js';
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
  it('returns working-tree scope with EMPTY files from the recorded fixture', async () => {
    // UNVERIFIED (Requirement 5.2): Codex CLI's PostToolUse payload schema is
    // documented in the researched vendor facts as carrying `session_id`,
    // `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`,
    // `turn_id`, `tool_name`, `tool_use_id`, `tool_input`, and `tool_response`.
    // The `tool_input.command` value in this fixture was constructed to look
    // like an `apply_patch` patch body plus a filename suffix, but the edited
    // path is deliberately not extracted here. Source: the researched vendor
    // facts recorded in docs/specs/0003-agent-plugins/requirements.md.
    const fixtureUrl = new URL('./fixtures/post-tool-use.json', import.meta.url);
    const raw = await readFile(fixtureUrl, 'utf8');
    const payload = codexPlugin.parseHookPayload(raw);

    expect(payload.event).toBe('PostToolUse');
    expect(payload.scope).toBe('working-tree');
    expect(payload.files).toEqual([]);
  });

  it('returns working-tree scope and the provided event name for any well-formed payload', () => {
    const raw = JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'apply_patch',
      tool_input: { command: 'some patch text that does not name a file safely' },
    });

    const payload = codexPlugin.parseHookPayload(raw);

    expect(payload.event).toBe('PostToolUse');
    expect(payload.scope).toBe('working-tree');
    expect(payload.files).toEqual([]);
  });

  it('defaults the event name to PostToolUse when hook_event_name is absent', () => {
    const raw = JSON.stringify({
      tool_name: 'apply_patch',
      tool_input: { command: 'some patch text that does not name a file safely' },
    });

    const payload = codexPlugin.parseHookPayload(raw);

    expect(payload.event).toBe('PostToolUse');
    expect(payload.scope).toBe('working-tree');
    expect(payload.files).toEqual([]);
  });

  it('defaults the event name to PostToolUse when the payload is not an object', () => {
    const payload = codexPlugin.parseHookPayload(JSON.stringify(['not', 'an', 'object']));

    expect(payload.event).toBe('PostToolUse');
    expect(payload.scope).toBe('working-tree');
    expect(payload.files).toEqual([]);
  });

  it('throws on malformed JSON', () => {
    expect(() => codexPlugin.parseHookPayload('not json')).toThrow();
  });
});

describe('detect', () => {
  it('returns true when <homeDir>/.codex exists', async () => {
    const emptyPath = await mkdtemp(join(tmpdir(), 'cyv-empty-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));
    await mkdir(join(homeDir, '.codex'), { recursive: true });

    const result = await withPath(emptyPath)(() => codexPlugin.detect({ homeDir, repoRoot }));

    expect(result).toBe(true);
  });

  it('returns false when neither ~/.codex nor a binary exists', async () => {
    const emptyPath = await mkdtemp(join(tmpdir(), 'cyv-empty-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));

    const result = await withPath(emptyPath)(() => codexPlugin.detect({ homeDir, repoRoot }));

    expect(result).toBe(false);
  });

  it('returns true when a codex binary resolves on PATH', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'cyv-bin-'));
    await writeFile(join(binDir, 'codex'), '');
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));

    const result = await withPath(binDir)(() => codexPlugin.detect({ homeDir, repoRoot }));

    expect(result).toBe(true);
  });
});

describe('plan', () => {
  it('produces the toml-merge config write, AGENTS.md workflow block, and one combined rules file', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));
    const rules = [makeRule('no-any'), makeRule('no-as-cast')];
    const ctx: PlanContext = {
      homeDir,
      repoRoot,
      // Intentionally Windows-shaped to exercise backslash escaping in the
      // TOML command value.
      cyvCommand: 'C:\\tools\\cyv.js',
      rules,
    };

    const writes = await codexPlugin.plan(ctx);

    expect(writes).toHaveLength(3);

    const config = writes.find((w) => w.path === join(homeDir, '.codex', 'config.toml'));
    assertDefined(config, 'expected a config.toml write');
    expect(config.strategy).toBe('toml-merge');
    expect(config.tomlTableArrayPath).toBe('hooks.PostToolUse.hooks');
    expect(config.ownershipMarker).toBe('hook codex');
    expect(config.content).toContain('command = ');
    // The original cyvCommand contains one backslash between each segment;
    // TOML escaping doubles them, so the escaped value contains two.
    expect(config.content).toContain('C:\\\\tools\\\\cyv.js');
    expect(config.content).toContain('hook codex');
    // The content is the entry body only; mergeToml adds the [[...]] header.
    expect(config.content).not.toContain('[[');

    if (process.platform === 'win32') {
      expect(config.content).toContain('commandWindows = ');
    }

    const agentsMd = writes.find((w) => w.path === join(repoRoot, 'AGENTS.md'));
    assertDefined(agentsMd, 'expected an AGENTS.md write');
    expect(agentsMd.strategy).toBe('managed-block');
    expect(agentsMd.blockId).toBe('codex-workflow');
    expect(agentsMd.content).toContain('PostToolUse');

    const rulesFile = writes.find((w) => w.path === join(repoRoot, '.codex', 'checkyourvibe-rules.md'));
    assertDefined(rulesFile, 'expected a combined rules file write');
    expect(rulesFile.strategy).toBe('create-if-absent');
    for (const rule of rules) {
      const notFix = rule.notFixes[0];
      assertDefined(notFix, `expected rule ${rule.id} to have a not-fix`);
      expect(rulesFile.content).toContain(`## ${rule.id}`);
      expect(rulesFile.content).toContain(rule.summary);
      expect(rulesFile.content).toContain(notFix.pattern);
    }
  });

  it('does not touch the filesystem, even when AGENTS.md already has its own prose on disk', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));
    const existingAgentsMd = join(repoRoot, 'AGENTS.md');
    await writeFile(existingAgentsMd, '# Project rules\n\nThis is the project\'s own prose.\n');

    const ctx: PlanContext = {
      homeDir,
      repoRoot,
      cyvCommand: '/opt/cyv/bin/cyv',
      rules: [makeRule('no-any')],
    };

    const before = await readFile(existingAgentsMd, 'utf8');
    const writes = await codexPlugin.plan(ctx);
    const after = await readFile(existingAgentsMd, 'utf8');

    expect(after).toBe(before);
    const agentsMdWrite = writes.find((w) => w.path === existingAgentsMd);
    assertDefined(agentsMdWrite, 'expected an AGENTS.md write');
    expect(agentsMdWrite.content).not.toContain("project's own prose");
  });

  it('does not touch the filesystem otherwise', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));
    const ctx: PlanContext = {
      homeDir,
      repoRoot,
      cyvCommand: '/opt/cyv/bin/cyv',
      rules: [makeRule('no-any')],
    };

    await codexPlugin.plan(ctx);

    expect(await readdir(homeDir)).toHaveLength(0);
    expect(await readdir(repoRoot)).toHaveLength(0);
  });
});

describe('formatResult', () => {
  it('returns exit code 0 and parseable, minimal stdout when clean', () => {
    const result = codexPlugin.formatResult([], { files: ['/a.ts', '/b.ts'] });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(() => JSON.parse(result.stdout)).not.toThrow();

    const parsed: unknown = JSON.parse(result.stdout);
    expect(isJSONObject(parsed)).toBe(true);
  });

  it('returns exit code 0 (not 2) with hookSpecificOutput.additionalContext mentioning the rule id and a not-fix', () => {
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

    const result = codexPlugin.formatResult([violation], { files: [violation.file] });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');

    const parsed: unknown = JSON.parse(result.stdout);
    if (!isHookSpecificOutputShape(parsed)) {
      throw new Error('expected stdout to parse into a hookSpecificOutput hookEventName/additionalContext shape');
    }
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    const additionalContext = parsed.hookSpecificOutput.additionalContext;
    expect(additionalContext).toContain('no-any');
    expect(additionalContext).toContain('Unexpected `any` type.');
    expect(additionalContext).toContain('Widen to `unknown`');
    expect(additionalContext).toContain('because:');
    expect(additionalContext).toContain('rule: no-unknown');
  });
});
