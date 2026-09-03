import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { command } from '../../src/cli/verify-analyzer.js';
import type { CommandContext } from '../../src/cli/types.js';

const COMPLIANT_MODULE = `
import { readFileSync } from 'node:fs';

export default async function analyze(request) {
  const skipped = [];
  for (const file of request.files) {
    try {
      readFileSync(file, 'utf-8');
    } catch (err) {
      skipped.push({ file, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { protocol: 1, violations: [], skipped, diagnostics: [] };
}
`;

function compliantManifest(): Record<string, unknown> {
  return {
    protocol: 1,
    id: 'cli-fixture',
    match: ['**/*.sample'],
    rules: [
      {
        id: 'no-bad-marker',
        category: 'test',
        scope: 'file',
        severity: 'error',
        summary: 'Flags the literal BAD_MARKER token.',
        why: 'A deterministic fixture rule for conformance testing.',
        allowedFixes: ['Remove the BAD_MARKER token from the file.'],
        notFixes: [],
        examples: { bad: 'const x = 1; // BAD_MARKER', good: 'const x = 1;' },
      },
    ],
    exec: { type: 'node', module: './analyzer.mjs' },
  };
}

function brokenManifest(): Record<string, unknown> {
  return { ...compliantManifest(), protocol: 2 };
}

async function writeFixture(manifest: Record<string, unknown>): Promise<{ dir: string; manifestPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'cyv-verify-cli-'));
  const manifestPath = join(dir, 'analyzer.manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  await writeFile(join(dir, 'analyzer.mjs'), COMPLIANT_MODULE, 'utf-8');
  return { dir, manifestPath };
}

function context(cwd: string, argv: string[]): CommandContext {
  return { cwd, argv, env: process.env };
}

function assertDefined<T>(value: T | undefined, message: string): asserts value is T {
  if (value === undefined) {
    throw new Error(message);
  }
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

describe('cyv verify-analyzer', () => {
  it('exits 0 and prints a passing checklist for a compliant analyzer', async () => {
    const { dir, manifestPath } = await writeFixture(compliantManifest());
    const captured = captureConsole();
    try {
      const code = await command.run(context(dir, [manifestPath]));
      expect(code).toBe(0);
      expect(captured.logs).toHaveLength(1);
      const output = captured.logs[0] ?? '';
      expect(output).toContain('cli-fixture');
      expect(output).toContain('All');
      expect(output).not.toContain('[FAIL]');
    } finally {
      captured.restore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves a relative manifest path against the command context cwd', async () => {
    const { dir } = await writeFixture(compliantManifest());
    const captured = captureConsole();
    try {
      const code = await command.run(context(dir, ['analyzer.manifest.json']));
      expect(code).toBe(0);
    } finally {
      captured.restore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 and names the failing check for a noncompliant analyzer', async () => {
    const { dir, manifestPath } = await writeFixture(brokenManifest());
    const captured = captureConsole();
    try {
      const code = await command.run(context(dir, [manifestPath]));
      expect(code).toBe(1);
      const output = captured.logs[0] ?? '';
      expect(output).toContain('[FAIL]');
      expect(output).toContain('protocol version is 1');
    } finally {
      captured.restore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 when the manifest path cannot be read at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyv-verify-cli-'));
    const captured = captureConsole();
    try {
      const code = await command.run(context(dir, [join(dir, 'does-not-exist.json')]));
      expect(code).toBe(2);
      expect(captured.errors).toHaveLength(1);
    } finally {
      captured.restore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 with usage when no path is given', async () => {
    const captured = captureConsole();
    try {
      const code = await command.run(context(process.cwd(), []));
      expect(code).toBe(2);
      const error = captured.errors[0];
      assertDefined(error, 'expected a single error line');
      expect(error).toContain('Usage');
    } finally {
      captured.restore();
    }
  });
});
