import { describe, expect, it, vi } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { command } from '../../src/cli/new-rule.js';
import type { CommandContext } from '../../src/cli/types.js';

const ANALYZER_SOURCE = fileURLToPath(new URL('../../../analyzer-typescript', import.meta.url));

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

async function prepareAnalyzer(): Promise<{ tempRoot: string; analyzerDir: string }> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'cyv-new-rule-'));
  const analyzerDir = path.join(tempRoot, 'packages', 'analyzer-typescript');
  await mkdir(path.dirname(analyzerDir), { recursive: true });
  await cp(ANALYZER_SOURCE, analyzerDir, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      return base !== 'dist' && base !== 'node_modules' && base !== '.turbo';
    },
  });
  return { tempRoot, analyzerDir };
}

function context(tempRoot: string, argv: string[]): CommandContext {
  return { cwd: tempRoot, argv, env: {} };
}

async function createdPaths(analyzerDir: string, ruleId: string): Promise<string[]> {
  const candidates = [
    path.join(analyzerDir, 'src', 'rules', `${ruleId}.ts`),
    path.join(analyzerDir, 'test', 'fixtures', `${ruleId}.bad.ts`),
    path.join(analyzerDir, 'test', 'fixtures', `${ruleId}.ok.ts`),
    path.join(analyzerDir, 'test', 'rules', `${ruleId}.test.ts`),
  ];
  const existing: string[] = [];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) {
        existing.push(candidate);
      }
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && typeof err.code === 'string' && err.code === 'ENOENT')) {
        throw err;
      }
    }
  }
  return existing;
}

describe('cyv new-rule', () => {
  it('scaffolds a rule source, fixtures, and test into the default analyzer package', async () => {
    const { tempRoot, analyzerDir } = await prepareAnalyzer();
    const captured = captureConsole();
    try {
      const code = await command.run(context(tempRoot, ['demo-rule']));
      expect(code).toBe(0);

      const ruleSource = await readFile(path.join(analyzerDir, 'src', 'rules', 'demo-rule.ts'), 'utf-8');
      expect(ruleSource).toContain("id: 'demo-rule'");
      expect(ruleSource).toContain('notFixes');
      expect(ruleSource).toContain('// A notFix\'s \'rule\' may only name a rule in the same analyzer; a dangling reference fails conformance.');
      expect(ruleSource).toContain('export const demoRule:');

      await readFile(path.join(analyzerDir, 'test', 'fixtures', 'demo-rule.bad.ts'), 'utf-8');
      await readFile(path.join(analyzerDir, 'test', 'fixtures', 'demo-rule.ok.ts'), 'utf-8');
      const testSource = await readFile(path.join(analyzerDir, 'test', 'rules', 'demo-rule.test.ts'), 'utf-8');
      expect(testSource).toContain("describe('demo-rule'");
      expect(testSource).toContain('it.todo');
    } finally {
      captured.restore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('refuses a rule id that already exists in the analyzer manifest', async () => {
    const { tempRoot, analyzerDir } = await prepareAnalyzer();
    const captured = captureConsole();
    try {
      const code = await command.run(context(tempRoot, ['no-any']));
      expect(code).toBe(2);
      expect(captured.errors.some((line) => line.includes('already exists'))).toBe(true);
      const created = await createdPaths(analyzerDir, 'fresh-rule');
      expect(created).toHaveLength(0);
    } finally {
      captured.restore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('--dry-run prints what it would create and writes nothing', async () => {
    const { tempRoot, analyzerDir } = await prepareAnalyzer();
    const captured = captureConsole();
    try {
      const code = await command.run(context(tempRoot, ['demo-rule', '--dry-run']));
      expect(code).toBe(0);
      expect(captured.logs.some((line) => line.includes('Would create:'))).toBe(true);

      const created = await createdPaths(analyzerDir, 'demo-rule');
      expect(created).toHaveLength(0);
    } finally {
      captured.restore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('never overwrites an existing file', async () => {
    const { tempRoot, analyzerDir } = await prepareAnalyzer();
    const captured = captureConsole();
    try {
      const existingRule = path.join(analyzerDir, 'src', 'rules', 'demo-rule.ts');
      await mkdir(path.dirname(existingRule), { recursive: true });
      await writeFile(existingRule, 'existing', 'utf-8');

      const code = await command.run(context(tempRoot, ['demo-rule']));
      expect(code).toBe(2);
      expect(captured.errors.some((line) => line.includes('already exists'))).toBe(true);
      expect(await readFile(existingRule, 'utf-8')).toBe('existing');
    } finally {
      captured.restore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
