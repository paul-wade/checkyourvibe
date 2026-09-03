import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import antigravityPlugin, {
  ANTIGRAVITY_HOOK_CANDIDATE_PATH_FIELDS,
} from '../src/index.js';
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
  return typeof hookSpecificOutput['additionalContext'] === 'string';
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
  it('extracts the path and scope from the recorded fixture', async () => {
    // UNVERIFIED (Requirement 5.2): Antigravity CLI documents no PostToolUse
    // payload schema at all — only that hooks receive stdin JSON containing
    // `toolCall.args`, `workspacePaths`, and `transcriptPath` (per the
    // researched vendor facts in docs/specs/0003-agent-plugins/requirements.md
    // and the T3004 task brief), and that the edited path is "presumably
    // somewhere under toolCall.args" with no field name given. This fixture's
    // `toolCall.args.file_path` key is this plugin's own guess, borrowed from
    // the `file_path` field Cursor documents for its analogous event, not a
    // captured real payload or a vendor-confirmed shape.
    const fixtureUrl = new URL('./fixtures/post-tool-use.json', import.meta.url);
    const raw = await readFile(fixtureUrl, 'utf8');
    const payload = antigravityPlugin.parseHookPayload(raw);

    expect(payload.event).toBe('PostToolUse');
    expect(payload.scope).toBe('files');
    expect(payload.files).toHaveLength(1);
    const file = payload.files[0];
    assertDefined(file, 'expected one file in the payload');
    expect(file).toBe('/home/user/checkout/src/components/Widget.tsx');
  });

  it('documents the candidate field list in the expected order', () => {
    expect(ANTIGRAVITY_HOOK_CANDIDATE_PATH_FIELDS).toEqual([
      'absolute_path',
      'file_path',
      'filePath',
      'path',
    ]);
  });

  it.each(ANTIGRAVITY_HOOK_CANDIDATE_PATH_FIELDS)(
    'resolves the path when only %s is present in toolCall.args',
    (field) => {
      const raw = JSON.stringify({
        event: 'PostToolUse',
        toolCall: { name: 'edit_file', args: { [field]: '/tmp/from-candidate.ts' } },
      });

      const payload = antigravityPlugin.parseHookPayload(raw);

      expect(payload.scope).toBe('files');
      expect(payload.files).toEqual(['/tmp/from-candidate.ts']);
    },
  );

  it('resolves a relative candidate path against the current working directory', () => {
    const raw = JSON.stringify({
      event: 'PostToolUse',
      toolCall: { name: 'edit_file', args: { file_path: 'relative/widget.ts' } },
    });

    const payload = antigravityPlugin.parseHookPayload(raw);

    expect(payload.scope).toBe('files');
    expect(payload.files).toEqual([join(process.cwd(), 'relative/widget.ts')]);
  });

  it('falls back to working-tree scope with empty files when no candidate matches in toolCall.args', () => {
    const raw = JSON.stringify({
      event: 'PostToolUse',
      toolCall: { name: 'edit_file', args: { some_other_key: '/tmp/whatever.ts' } },
    });

    const payload = antigravityPlugin.parseHookPayload(raw);

    expect(payload.scope).toBe('working-tree');
    expect(payload.files).toEqual([]);
    expect(payload.event).toBe('PostToolUse');
  });

  it('falls back to working-tree scope when toolCall.args is missing entirely', () => {
    const raw = JSON.stringify({ event: 'PostToolUse', toolCall: { name: 'edit_file' } });

    const payload = antigravityPlugin.parseHookPayload(raw);

    expect(payload.scope).toBe('working-tree');
    expect(payload.files).toEqual([]);
  });

  it('falls back to working-tree scope when toolCall is missing entirely', () => {
    const raw = JSON.stringify({ event: 'PostToolUse' });

    const payload = antigravityPlugin.parseHookPayload(raw);

    expect(payload.scope).toBe('working-tree');
    expect(payload.files).toEqual([]);
  });

  it('falls back to working-tree scope when the payload is a JSON array, not an object', () => {
    const payload = antigravityPlugin.parseHookPayload(JSON.stringify(['not', 'an', 'object']));

    expect(payload.scope).toBe('working-tree');
    expect(payload.files).toEqual([]);
  });

  it('defaults the event name to PostToolUse when absent', () => {
    const payload = antigravityPlugin.parseHookPayload(JSON.stringify({}));

    expect(payload.event).toBe('PostToolUse');
    expect(payload.scope).toBe('working-tree');
  });

  it('throws on malformed JSON', () => {
    expect(() => antigravityPlugin.parseHookPayload('not json')).toThrow();
  });
});

describe('detect', () => {
  it('returns true when <repoRoot>/.agents exists', async () => {
    const emptyPath = await mkdtemp(join(tmpdir(), 'cyv-empty-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));
    await mkdir(join(repoRoot, '.agents'), { recursive: true });

    const result = await withPath(emptyPath)(() =>
      antigravityPlugin.detect({ homeDir, repoRoot }),
    );

    expect(result).toBe(true);
  });

  it('returns false when neither .agents nor a binary exists', async () => {
    const emptyPath = await mkdtemp(join(tmpdir(), 'cyv-empty-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));

    const result = await withPath(emptyPath)(() =>
      antigravityPlugin.detect({ homeDir, repoRoot }),
    );

    expect(result).toBe(false);
  });

  it('returns true when an antigravity binary resolves on PATH', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'cyv-bin-'));
    await writeFile(join(binDir, 'antigravity'), '');
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));

    const result = await withPath(binDir)(() => antigravityPlugin.detect({ homeDir, repoRoot }));

    expect(result).toBe(true);
  });

  it('returns true when an agy binary resolves on PATH', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'cyv-bin-'));
    await writeFile(join(binDir, 'agy'), '');
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));

    const result = await withPath(binDir)(() => antigravityPlugin.detect({ homeDir, repoRoot }));

    expect(result).toBe(true);
  });
});

describe('plan', () => {
  it('produces the hooks.json merge, AGENTS.md workflow block, and one combined skills file', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));
    const rules = [makeRule('no-any'), makeRule('no-as-cast')];
    const ctx: PlanContext = {
      homeDir,
      repoRoot,
      cyvCommand: '/opt/cyv/bin/cyv',
      rules,
    };

    const writes = await antigravityPlugin.plan(ctx);

    expect(writes).toHaveLength(3);

    const hooks = writes.find((w) => w.path === join(repoRoot, '.agents', 'hooks.json'));
    assertDefined(hooks, 'expected a hooks.json write');
    expect(hooks.strategy).toBe('json-merge');
    expect(hooks.ownershipMarker).toBe('hook antigravity');
    expect(hooks.content).toContain('PostToolUse');
    expect(hooks.content).toContain('/opt/cyv/bin/cyv hook antigravity');
    expect(() => JSON.parse(hooks.content)).not.toThrow();
    const parsedHooks: unknown = JSON.parse(hooks.content);
    expect(parsedHooks).toMatchObject({
      hooks: {
        PostToolUse: [
          {
            matcher: '.*',
            hooks: [
              { name: 'checkyourvibe', type: 'command', timeout: 30000 },
              { name: 'checkyourvibe-notes', type: 'command', timeout: 30000 },
            ],
          },
        ],
      },
    });

    const agentsMd = writes.find((w) => w.path === join(repoRoot, 'AGENTS.md'));
    assertDefined(agentsMd, 'expected an AGENTS.md write');
    expect(agentsMd.strategy).toBe('managed-block');
    expect(agentsMd.blockId).toBe('antigravity-workflow');
    expect(agentsMd.content).toContain('PostToolUse');

    const skillsFile = writes.find(
      (w) => w.path === join(repoRoot, '.agents', 'skills', 'checkyourvibe-rules.md'),
    );
    assertDefined(skillsFile, 'expected a combined skills file write');
    expect(skillsFile.strategy).toBe('create-if-absent');
    for (const rule of rules) {
      const notFix = rule.notFixes[0];
      assertDefined(notFix, `expected rule ${rule.id} to have a not-fix`);
      expect(skillsFile.content).toContain(`## ${rule.id}`);
      expect(skillsFile.content).toContain(rule.summary);
      expect(skillsFile.content).toContain(notFix.pattern);
    }
  });

  it('uses a blockId distinct from other adapters\' "workflow" id, since AGENTS.md is shared ground', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));
    const ctx: PlanContext = {
      homeDir,
      repoRoot,
      cyvCommand: '/opt/cyv/bin/cyv',
      rules: [makeRule('no-any')],
    };

    const writes = await antigravityPlugin.plan(ctx);
    const agentsMd = writes.find((w) => w.path === join(repoRoot, 'AGENTS.md'));
    assertDefined(agentsMd, 'expected an AGENTS.md write');

    expect(agentsMd.blockId).not.toBe('workflow');
  });

  it('does not touch the filesystem, even when AGENTS.md already has its own prose on disk', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));
    // Simulates the exact situation the task flagged: a target repo's
    // AGENTS.md already carries its own provenance/workflow prose before
    // checkyourvibe ever runs. `plan()` must not read this file (it never
    // touches the filesystem at all) and must not return its content —
    // the managed-block merge that reads and preserves this prose happens
    // later, in `packages/core/src/merge/apply.ts`.
    const existingAgentsMd = join(repoRoot, 'AGENTS.md');
    await writeFile(existingAgentsMd, '# Project rules\n\nThis is the project\'s own prose.\n');

    const ctx: PlanContext = {
      homeDir,
      repoRoot,
      cyvCommand: '/opt/cyv/bin/cyv',
      rules: [makeRule('no-any')],
    };

    const before = await readFile(existingAgentsMd, 'utf8');
    const writes = await antigravityPlugin.plan(ctx);
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

    await antigravityPlugin.plan(ctx);

    expect(await readdir(homeDir)).toHaveLength(0);
    expect(await readdir(repoRoot)).toHaveLength(0);
  });
});

describe('formatResult', () => {
  it('returns exit code 0 and parseable, near-empty stdout when clean', () => {
    const result = antigravityPlugin.formatResult([], { files: ['/a.ts', '/b.ts'] });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it('returns exit code 0 (not 2) with the violation carrying the rule id and a not-fix, and stdout parsing as JSON', () => {
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

    const result = antigravityPlugin.formatResult([violation], { files: [violation.file] });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');

    const parsed: unknown = JSON.parse(result.stdout);
    if (!isHookSpecificOutputShape(parsed)) {
      throw new Error('expected stdout to parse into a hookSpecificOutput.additionalContext shape');
    }
    const additionalContext = parsed.hookSpecificOutput.additionalContext;
    expect(additionalContext).toContain('no-any');
    expect(additionalContext).toContain('Unexpected `any` type.');
    expect(additionalContext).toContain('Widen to `unknown`');
    expect(additionalContext).toContain('because:');
    expect(additionalContext).toContain('rule: no-unknown');
  });
});
