import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import cursorPlugin from '../src/index.js';
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

function assertDefined<T>(value: T | undefined, message: string): asserts value is T {
  if (value === undefined) {
    throw new Error(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasAdditionalContext(value: unknown): value is { additional_context: string } {
  return isRecord(value) && typeof value['additional_context'] === 'string';
}

describe('parseHookPayload', () => {
  it('extracts the path and scope from the recorded fixture', async () => {
    const fixtureUrl = new URL('./fixtures/after-file-edit.json', import.meta.url);
    const raw = await readFile(fixtureUrl, 'utf8');
    const payload = cursorPlugin.parseHookPayload(raw);

    expect(payload.event).toBe('afterFileEdit');
    expect(payload.scope).toBe('files');
    expect(payload.files).toHaveLength(1);
    const file = payload.files[0];
    assertDefined(file, 'expected one file in the payload');
    expect(file).toBe('/home/user/checkout/src/components/Widget.tsx');
  });

  it('throws on malformed JSON', () => {
    expect(() => cursorPlugin.parseHookPayload('not json')).toThrow();
  });

  it('throws when file_path is missing', () => {
    expect(() =>
      cursorPlugin.parseHookPayload(JSON.stringify({ hook_event_name: 'afterFileEdit' })),
    ).toThrow();
  });

  it('throws when file_path is present but empty', () => {
    expect(() =>
      cursorPlugin.parseHookPayload(JSON.stringify({ file_path: '' })),
    ).toThrow();
  });

  it('defaults the event name when hook_event_name is absent', () => {
    const raw = JSON.stringify({ file_path: '/tmp/whatever.ts' });
    const payload = cursorPlugin.parseHookPayload(raw);
    expect(payload.event).toBe('afterFileEdit');
  });
});

describe('detect', () => {
  it('returns true when <repoRoot>/.cursor exists', async () => {
    const emptyPath = await mkdtemp(join(tmpdir(), 'cyv-empty-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));
    await mkdir(join(repoRoot, '.cursor'), { recursive: true });

    const result = await withPath(emptyPath)(() => cursorPlugin.detect({ homeDir, repoRoot }));

    expect(result).toBe(true);
  });

  it('returns false when neither .cursor nor a binary exists', async () => {
    const emptyPath = await mkdtemp(join(tmpdir(), 'cyv-empty-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));

    const result = await withPath(emptyPath)(() => cursorPlugin.detect({ homeDir, repoRoot }));

    expect(result).toBe(false);
  });

  it('returns true when a cursor-agent binary resolves on PATH', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'cyv-bin-'));
    await writeFile(join(binDir, 'cursor-agent'), '');
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));

    const result = await withPath(binDir)(() => cursorPlugin.detect({ homeDir, repoRoot }));

    expect(result).toBe(true);
  });

  it('returns true when a cursor binary resolves on PATH', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'cyv-bin-'));
    await writeFile(join(binDir, 'cursor'), '');
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));

    const result = await withPath(binDir)(() => cursorPlugin.detect({ homeDir, repoRoot }));

    expect(result).toBe(true);
  });
});

describe('plan', () => {
  it('produces the hooks.json merge, workflow block, and one rule file per rule', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-home-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));
    const rules = [makeRule('no-any'), makeRule('no-as-cast')];
    const ctx: PlanContext = {
      homeDir,
      repoRoot,
      cyvCommand: '/opt/cyv/bin/cyv',
      rules,
    };

    const writes = await cursorPlugin.plan(ctx);

    expect(writes).toHaveLength(4);

    const hooks = writes.find((w) => w.path === join(repoRoot, '.cursor', 'hooks.json'));
    assertDefined(hooks, 'expected a write for .cursor/hooks.json');
    expect(hooks.strategy).toBe('json-merge');
    expect(hooks.ownershipMarker).toBe('hook cursor');
    expect(hooks.content).toContain('afterFileEdit');
    expect(hooks.content).toContain('/opt/cyv/bin/cyv hook cursor');
    expect(() => JSON.parse(hooks.content)).not.toThrow();

    const workflow = writes.find(
      (w) => w.path === join(repoRoot, '.cursor', 'rules', 'checkyourvibe.mdc'),
    );
    assertDefined(workflow, 'expected a write for .cursor/rules/checkyourvibe.mdc');
    expect(workflow.strategy).toBe('managed-block');
    expect(workflow.blockId).toBe('cursor-workflow');

    const ruleFiles = writes.filter(
      (w) =>
        w.path.startsWith(join(repoRoot, '.cursor', 'rules')) &&
        w.path !== join(repoRoot, '.cursor', 'rules', 'checkyourvibe.mdc'),
    );
    expect(ruleFiles).toHaveLength(2);

    for (const rule of rules) {
      const file = ruleFiles.find(
        (w) => w.path === join(repoRoot, '.cursor', 'rules', `cyv-${rule.id}.mdc`),
      );
      assertDefined(file, `expected a rule file for ${rule.id}`);
      expect(file.strategy).toBe('create-if-absent');
      expect(file.content).toContain('alwaysApply: false');
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

    await cursorPlugin.plan(ctx);

    expect(await readdir(homeDir)).toHaveLength(0);
    expect(await readdir(repoRoot)).toHaveLength(0);
  });
});

describe('formatResult', () => {
  it('returns exit code 0 and parseable, near-empty stdout when clean', () => {
    const result = cursorPlugin.formatResult([], { files: ['/a.ts', '/b.ts'] });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it('returns exit code 0 (not 2) with additional_context mentioning the rule id and a not-fix', () => {
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

    const result = cursorPlugin.formatResult([violation], { files: [violation.file] });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');

    const parsed: unknown = JSON.parse(result.stdout);
    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();
    if (!hasAdditionalContext(parsed)) {
      throw new Error('expected parsed result to contain an additional_context string');
    }
    const additionalContext = parsed.additional_context;
    expect(typeof additionalContext).toBe('string');
    expect(additionalContext).toContain('no-any');
    expect(additionalContext).toContain('Unexpected `any` type.');
    expect(additionalContext).toContain('Widen to `unknown`');
    expect(additionalContext).toContain('because:');
    expect(additionalContext).toContain('rule: no-unknown');
  });
});
