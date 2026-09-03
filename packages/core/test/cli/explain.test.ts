import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command } from '../../src/cli/explain.js';
import type { CommandContext } from '../../src/cli/types.js';
import { isUnknownArray } from '../../src/guards.js';

/**
 * Two rules from one analyzer: `rule-a` is enabled by pack membership,
 * `rule-b` is not enabled by anything and carries a `notFix` that names
 * `rule-a` — the fixture for both the enabled/disabled distinction
 * (Requirement 2.3/2.4) and inbound `notFixes` (Requirement 2.5).
 */
function analyzerManifest(): unknown {
  return {
    protocol: 1,
    id: 'alpha',
    match: ['**/*.ts'],
    rules: [
      {
        id: 'rule-a',
        category: 'cat-a',
        scope: 'file',
        severity: 'error',
        pack: 'pack-a',
        summary: 'summary for rule-a',
        why: 'why for rule-a',
        allowedFixes: ['fix rule-a'],
        notFixes: [],
        examples: { bad: 'bad a', good: 'good a' },
      },
      {
        id: 'rule-b',
        category: 'cat-b',
        scope: 'file',
        severity: 'warning',
        summary: 'summary for rule-b',
        why: 'why for rule-b',
        allowedFixes: ['fix rule-b'],
        notFixes: [{ pattern: 'tempting shortcut', because: 'still wrong', rule: 'rule-a' }],
        examples: { bad: 'bad b', good: 'good b' },
        evidence: 'syntax',
      },
    ],
    // Never executed by `cyv explain` — a manifest is read as static JSON, so
    // this module does not need to exist on disk.
    exec: { type: 'node', module: './alpha.mjs' },
  };
}

function config(): unknown {
  return {
    packs: ['pack-a'],
    analyzers: [{ id: 'alpha', package: './alpha.manifest.json' }],
    rules: {},
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
  const parent = await mkdtemp(join(tmpdir(), 'cyv-explain-'));
  const repo = join(parent, 'repo');
  await mkdir(repo, { recursive: true });
  execFileSync('git', ['init'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
  return repo;
}

async function makeConfiguredRepo(): Promise<string> {
  const repo = await makeRepo();
  await copySchema(repo);
  await writeFile(join(repo, 'checkyourvibe.json'), JSON.stringify(config(), null, 2));
  await writeFile(join(repo, 'alpha.manifest.json'), JSON.stringify(analyzerManifest(), null, 2));
  return repo;
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

describe('cyv explain <rule> — metadata', () => {
  it('shows pack, category, severity, scope, evidence, analyzer, and enabled state', async () => {
    const repo = await makeConfiguredRepo();
    const captured = captureConsole();
    try {
      const code = await command.run(context(repo, ['rule-a']));
      expect(code).toBe(0);
      const output = captured.logs.join('\n');
      expect(output).toContain('Pack: pack-a');
      expect(output).toContain('Category: cat-a');
      expect(output).toContain('Severity: error');
      expect(output).toContain('Scope: file');
      expect(output).toContain('Evidence: unspecified');
      expect(output).toContain('Analyzer: alpha');
      expect(output).toContain('Enabled: yes');
    } finally {
      captured.restore();
    }
  });

  it('shows a declared evidence kind rather than "unspecified"', async () => {
    const repo = await makeConfiguredRepo();
    const captured = captureConsole();
    try {
      await command.run(context(repo, ['rule-b']));
      const output = captured.logs.join('\n');
      expect(output).toContain('Evidence: syntax');
    } finally {
      captured.restore();
    }
  });

  it('shows the absence of a pack rather than omitting the line', async () => {
    const repo = await makeConfiguredRepo();
    const captured = captureConsole();
    try {
      await command.run(context(repo, ['rule-b']));
      const output = captured.logs.join('\n');
      expect(output).toContain('Pack: none');
    } finally {
      captured.restore();
    }
  });

  it('says a catalog rule is not enabled, rather than printing its guidance silently', async () => {
    const repo = await makeConfiguredRepo();
    const captured = captureConsole();
    try {
      const code = await command.run(context(repo, ['rule-b']));
      expect(code).toBe(0);
      const output = captured.logs.join('\n');
      expect(output).toContain("Enabled: no — not active in this repository's configuration");
      // The guidance is still printed even though the rule is disabled.
      expect(output).toContain('summary for rule-b');
    } finally {
      captured.restore();
    }
  });
});

describe('cyv explain <rule> — inbound notFixes', () => {
  it('lists another rule that names this one as a dead end', async () => {
    const repo = await makeConfiguredRepo();
    const captured = captureConsole();
    try {
      await command.run(context(repo, ['rule-a']));
      const output = captured.logs.join('\n');
      expect(output).toContain('Inbound notFixes (other rules that would trip this one)');
      expect(output).toContain('rule-b: tempting shortcut — still wrong');
    } finally {
      captured.restore();
    }
  });

  it('says none are recorded for a rule nothing points at', async () => {
    const repo = await makeConfiguredRepo();
    const captured = captureConsole();
    try {
      await command.run(context(repo, ['rule-b']));
      const output = captured.logs.join('\n');
      expect(output).toContain('Inbound notFixes (other rules that would trip this one)');
      const inboundIndex = output.indexOf('Inbound notFixes');
      expect(output.slice(inboundIndex)).toContain('None recorded.');
    } finally {
      captured.restore();
    }
  });
});

describe('cyv explain — no-argument listing', () => {
  it('lists every catalog rule, marking which are enabled, rather than only the enabled ones', async () => {
    const repo = await makeConfiguredRepo();
    const captured = captureConsole();
    try {
      const code = await command.run(context(repo, []));
      expect(code).toBe(0);
      const output = captured.logs.join('\n');
      expect(output).toContain('1 of 2 rule(s) enabled');
      expect(output).toMatch(/\[enabled\].*rule-a/);
      expect(output).toMatch(/\[disabled\].*rule-b/);
    } finally {
      captured.restore();
    }
  });

  it('still lists only the enabled set for --json, unchanged', async () => {
    const repo = await makeConfiguredRepo();
    const captured = captureConsole();
    try {
      const code = await command.run(context(repo, ['--json']));
      expect(code).toBe(0);
      const parsed: unknown = JSON.parse(captured.logs.join(''));
      expect(isUnknownArray(parsed)).toBe(true);
      if (isUnknownArray(parsed)) {
        const ids: unknown[] = parsed.map((rule: unknown) =>
          rule !== null && typeof rule === 'object' && 'id' in rule ? rule.id : undefined,
        );
        expect(ids).toEqual(['rule-a']);
      }
    } finally {
      captured.restore();
    }
  });
});

describe('cyv explain <unknown-rule>', () => {
  it('errors and lists available ids', async () => {
    const repo = await makeConfiguredRepo();
    const captured = captureConsole();
    try {
      const code = await command.run(context(repo, ['no-such-rule']));
      expect(code).toBe(2);
      const output = captured.errors.join('\n');
      expect(output).toContain('Unknown rule "no-such-rule"');
      expect(output).toContain('rule-a');
      expect(output).toContain('rule-b');
    } finally {
      captured.restore();
    }
  });
});
