import { describe, expect, it } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { checkFilesTool, checkWorkingTreeTool } from '../../src/mcp/tools.js';
import type { McpContext, ToolCallResult } from '../../src/mcp/types.js';
import { makeConfiguredRepo, makeRepo } from './fixtures.js';

interface JsonViolation {
  file: string;
  ruleId: string;
  guidance?: {
    summary: string;
    why: string;
    allowedFixes: string[];
    notFixes: { pattern: string; because: string; rule?: string }[];
    examples: { bad: string; good: string };
  };
}

interface JsonCheckResult {
  violations: JsonViolation[];
  filesChecked: number;
  mode: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isNotFix(value: unknown): value is { pattern: string; because: string; rule?: string } {
  return (
    isRecord(value) &&
    typeof value['pattern'] === 'string' &&
    typeof value['because'] === 'string' &&
    (value['rule'] === undefined || typeof value['rule'] === 'string')
  );
}

function isExamples(value: unknown): value is { bad: string; good: string } {
  return isRecord(value) && typeof value['bad'] === 'string' && typeof value['good'] === 'string';
}

function isJsonViolation(value: unknown): value is JsonViolation {
  if (!isRecord(value)) return false;
  if (typeof value['file'] !== 'string' || typeof value['ruleId'] !== 'string') return false;
  const guidance = value['guidance'];
  if (guidance !== undefined) {
    if (!isRecord(guidance)) return false;
    if (
      typeof guidance['summary'] !== 'string' ||
      typeof guidance['why'] !== 'string' ||
      !isUnknownArray(guidance['allowedFixes']) ||
      !guidance['allowedFixes'].every((item: unknown) => typeof item === 'string') ||
      !isUnknownArray(guidance['notFixes']) ||
      !guidance['notFixes'].every((item: unknown) => isNotFix(item)) ||
      !isExamples(guidance['examples'])
    ) {
      return false;
    }
  }
  return true;
}

function isJsonCheckResult(value: unknown): value is JsonCheckResult {
  return (
    isRecord(value) &&
    isUnknownArray(value['violations']) &&
    value['violations'].every((item: unknown) => isJsonViolation(item)) &&
    typeof value['filesChecked'] === 'number' &&
    typeof value['mode'] === 'string'
  );
}

function payload(result: ToolCallResult): JsonCheckResult {
  const block = result.content[0];
  expect(block).toBeDefined();
  const parsed: unknown = JSON.parse(block?.text ?? '');
  if (!isJsonCheckResult(parsed)) {
    throw new Error('expected tool result to contain a JSON check result');
  }
  return parsed;
}

describe('checkFilesTool', () => {
  it('returns violations with guidance embedded, including notFixes', async () => {
    const { repo, sourcePath } = await makeConfiguredRepo('export const value = 1; // VIOLATION\n');
    try {
      const ctx: McpContext = { cwd: repo };
      const result = await checkFilesTool(ctx, { paths: [sourcePath] });

      expect(result.isError).toBeUndefined();
      const report = payload(result);

      expect(report.violations).toHaveLength(1);
      const violation = report.violations[0];
      expect(violation).toBeDefined();
      expect(violation?.ruleId).toBe('no-violation-marker');

      const guidance = violation?.guidance;
      expect(guidance).toBeDefined();
      expect(guidance?.summary).toBe('Flags an explicit VIOLATION marker left in source.');
      expect(guidance?.why.length).toBeGreaterThan(0);
      expect(guidance?.allowedFixes).toEqual(['Remove the VIOLATION marker from the file.']);

      // The hard requirement: notFixes travels with the finding, not just the message.
      expect(guidance?.notFixes).toBeDefined();
      expect(guidance?.notFixes.length).toBeGreaterThan(0);
      expect(guidance?.notFixes[0]?.pattern).toBe('Rename the marker instead of removing it.');
      expect(guidance?.notFixes[0]?.because.length).toBeGreaterThan(0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('returns a clean result with no violations for clean files', async () => {
    const { repo, sourcePath } = await makeConfiguredRepo('export const value = 1;\n');
    try {
      const ctx: McpContext = { cwd: repo };
      const result = await checkFilesTool(ctx, { paths: [sourcePath] });

      expect(result.isError).toBeUndefined();
      const report = payload(result);
      expect(report.violations).toEqual([]);
      expect(report.filesChecked).toBe(1);
      expect(report.mode).toBe('files');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('returns an error result (not a throw) for a malformed "paths" argument', async () => {
    const { repo } = await makeConfiguredRepo('export const value = 1;\n');
    try {
      const ctx: McpContext = { cwd: repo };
      const result = await checkFilesTool(ctx, { paths: 'not-an-array' });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('paths');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('returns an MCP error result rather than throwing on an internal failure', async () => {
    // Not a git repository at all: repoRoot() rejects, and the handler must
    // catch that instead of letting it propagate and take the process down.
    const ctx: McpContext = { cwd: await (await import('node:os')).tmpdir() };
    await expect(checkFilesTool(ctx, { paths: ['whatever.ts'] })).resolves.toEqual(
      expect.objectContaining({ isError: true }),
    );
    const result = await checkFilesTool(ctx, { paths: ['whatever.ts'] });
    expect(result.content[0]?.text).toContain('check_files failed');
  });
});

describe('checkWorkingTreeTool', () => {
  it('reports an uncommitted violation via the same selection as `cyv check --working`', async () => {
    const { repo, sourcePath } = await makeConfiguredRepo('export const value = 1;\n');
    try {
      // Uncommitted edit — this is exactly what --working diffs against HEAD.
      await writeFile(sourcePath, 'export const value = 2; // VIOLATION\n');

      const ctx: McpContext = { cwd: repo };
      const result = await checkWorkingTreeTool(ctx);

      expect(result.isError).toBeUndefined();
      const report = payload(result);
      expect(report.violations).toHaveLength(1);
      expect(report.violations[0]?.guidance?.notFixes.length).toBeGreaterThan(0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('returns an error result rather than throwing when there is no config', async () => {
    const repo = await makeRepo();
    try {
      const ctx: McpContext = { cwd: repo };
      const result = await checkWorkingTreeTool(ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('cyv init');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
