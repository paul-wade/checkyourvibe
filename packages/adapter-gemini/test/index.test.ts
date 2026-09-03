import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import geminiPlugin, { GEMINI_HOOK_CANDIDATE_PATH_FIELDS } from '../src/index.js';
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
    // UNVERIFIED (Requirement 5.2): Gemini CLI's docs describe `AfterTool`'s
    // top-level fields (tool_name, tool_input, tool_response, mcp_context?,
    // original_request_name?) but do not document which key inside
    // `tool_input` carries the edited path. This fixture was constructed from
    // that documented top-level shape plus a plausible `file_path` key
    // borrowed from Claude Code / Cursor's conventions — it is a best guess
    // at the inner shape, not a captured real payload. Source: the researched
    // vendor facts recorded in docs/specs/0003-agent-plugins/requirements.md.
    const fixtureUrl = new URL('./fixtures/after-tool.json', import.meta.url);
    const raw = await readFile(fixtureUrl, 'utf8');
    const payload = geminiPlugin.parseHookPayload(raw);

    expect(payload.event).toBe('AfterTool');
    expect(payload.scope).toBe('files');
    expect(payload.files).toHaveLength(1);
    const file = payload.files[0];
    assertDefined(file, 'expected one file in the payload');
    expect(file).toBe('/home/user/checkout/src/components/Widget.tsx');
  });

  it('documents the candidate field list in the expected order', () => {
    expect(GEMINI_HOOK_CANDIDATE_PATH_FIELDS).toEqual([
      'absolute_path',
      'file_path',
      'filePath',
      'path',
    ]);
  });

  it.each(GEMINI_HOOK_CANDIDATE_PATH_FIELDS)(
    'resolves the path when only %s is present in tool_input',
    (field) => {
      const raw = JSON.stringify({
        tool_name: 'write_file',
        tool_input: { [field]: '/tmp/from-candidate.ts' },
      });

      const payload = geminiPlugin.parseHookPayload(raw);

      expect(payload.scope).toBe('files');
      expect(payload.files).toEqual(['/tmp/from-candidate.ts']);
    },
  );

  it('resolves a relative candidate path against the current working directory', () => {
    const raw = JSON.stringify({
      tool_name: 'write_file',
      tool_input: { file_path: 'relative/widget.ts' },
    });

    const payload = geminiPlugin.parseHookPayload(raw);

    expect(payload.scope).toBe('files');
    expect(payload.files).toEqual([join(process.cwd(), 'relative/widget.ts')]);
  });

  it('falls back to working-tree scope with empty files when no candidate matches', () => {
    const raw = JSON.stringify({
      tool_name: 'write_file',
      tool_input: { some_other_key: '/tmp/whatever.ts' },
    });

    const payload = geminiPlugin.parseHookPayload(raw);

    expect(payload.scope).toBe('working-tree');
    expect(payload.files).toEqual([]);
    expect(payload.event).toBe('AfterTool');
  });

  it('falls back to working-tree scope when tool_input is missing entirely', () => {
    const raw = JSON.stringify({ tool_name: 'write_file' });

    const payload = geminiPlugin.parseHookPayload(raw);

    expect(payload.scope).toBe('working-tree');
    expect(payload.files).toEqual([]);
  });

  it('falls back to working-tree scope when the payload is a JSON array, not an object', () => {
    const payload = geminiPlugin.parseHookPayload(JSON.stringify(['not', 'an', 'object']));

    expect(payload.scope).toBe('working-tree');
    expect(payload.files).toEqual([]);
  });

  it('throws on malformed JSON', () => {
    expect(() => geminiPlugin.parseHookPayload('not json')).toThrow();
  });
});

describe('detect', () => {
  it('returns true when <repoRoot>/.gemini exists', async () => {
    const emptyPath = await mkdtemp(join(tmpdir(), 'cyv-empty-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));
    await mkdir(join(repoRoot, '.gemini'), { recursive: true });

    const result = await withPath(emptyPath)(() => geminiPlugin.detect({ homeDir, repoRoot }));

    expect(result).toBe(true);
  });

  it('returns true when <homeDir>/.gemini exists', async () => {
    const emptyPath = await mkdtemp(join(tmpdir(), 'cyv-empty-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));
    await mkdir(join(homeDir, '.gemini'), { recursive: true });

    const result = await withPath(emptyPath)(() => geminiPlugin.detect({ homeDir, repoRoot }));

    expect(result).toBe(true);
  });

  it('returns false when neither .gemini directory nor a binary exists', async () => {
    const emptyPath = await mkdtemp(join(tmpdir(), 'cyv-empty-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));

    const result = await withPath(emptyPath)(() => geminiPlugin.detect({ homeDir, repoRoot }));

    expect(result).toBe(false);
  });

  it('returns true when a gemini binary resolves on PATH', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'cyv-bin-'));
    await writeFile(join(binDir, 'gemini'), '');
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));

    const result = await withPath(binDir)(() => geminiPlugin.detect({ homeDir, repoRoot }));

    expect(result).toBe(true);
  });
});

describe('plan', () => {
  it('produces the settings.json merge, GEMINI.md workflow block, and one combined rules file', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));
    const rules = [makeRule('no-any'), makeRule('no-as-cast')];
    const ctx: PlanContext = {
      homeDir,
      repoRoot,
      cyvCommand: '/opt/cyv/bin/cyv',
      rules,
    };

    const writes = await geminiPlugin.plan(ctx);

    expect(writes).toHaveLength(3);

    const settings = writes.find((w) => w.path === join(repoRoot, '.gemini', 'settings.json'));
    assertDefined(settings, 'expected a settings.json write');
    expect(settings.strategy).toBe('json-merge');
    expect(settings.ownershipMarker).toBe('hook gemini');
    expect(settings.content).toContain('AfterTool');
    expect(settings.content).toContain('write_file|replace|edit');
    expect(settings.content).toContain('/opt/cyv/bin/cyv hook gemini');
    expect(() => JSON.parse(settings.content)).not.toThrow();
    const parsedSettings: unknown = JSON.parse(settings.content);
    expect(parsedSettings).toMatchObject({
      hooks: {
        AfterTool: [
          {
            matcher: 'write_file|replace|edit',
            hooks: [
              { name: 'checkyourvibe', type: 'command', timeout: 30000 },
              { name: 'checkyourvibe-notes', type: 'command', timeout: 30000 },
            ],
          },
        ],
      },
    });

    const geminiMd = writes.find((w) => w.path === join(repoRoot, 'GEMINI.md'));
    assertDefined(geminiMd, 'expected a GEMINI.md write');
    expect(geminiMd.strategy).toBe('managed-block');
    expect(geminiMd.blockId).toBe('gemini-workflow');
    expect(geminiMd.content).toContain('AfterTool');

    const rulesFile = writes.find(
      (w) => w.path === join(repoRoot, '.gemini', 'checkyourvibe-rules.md'),
    );
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

  it('does not touch the filesystem', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));
    const ctx: PlanContext = {
      homeDir,
      repoRoot,
      cyvCommand: '/opt/cyv/bin/cyv',
      rules: [makeRule('no-any')],
    };

    await geminiPlugin.plan(ctx);

    expect(await readdir(homeDir)).toHaveLength(0);
    expect(await readdir(repoRoot)).toHaveLength(0);
  });
});

describe('formatResult', () => {
  it('returns exit code 0 and parseable, near-empty stdout when clean', () => {
    const result = geminiPlugin.formatResult([], { files: ['/a.ts', '/b.ts'] });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(() => JSON.parse(result.stdout)).not.toThrow();
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

    const result = geminiPlugin.formatResult([violation], { files: [violation.file] });

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
