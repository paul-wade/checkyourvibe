import { describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { explainRuleTool, listRulesTool } from '../../src/mcp/tools.js';
import type { McpContext, ToolCallResult } from '../../src/mcp/types.js';
import { makeConfiguredRepo, makeRepo } from './fixtures.js';

interface JsonRuleSummary {
  id: string;
  category: string;
  severity: string;
  summary: string;
}

interface RuleExplainResult {
  id: string;
  why: string;
  allowedFixes: string[];
  notFixes: { pattern: string; because: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isRuleSummary(value: unknown): value is JsonRuleSummary {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['category'] === 'string' &&
    typeof value['severity'] === 'string' &&
    typeof value['summary'] === 'string'
  );
}

function assertDefined<T>(value: T | undefined, message: string): asserts value is T {
  if (value === undefined) {
    throw new Error(message);
  }
}

function isRuleListResult(value: unknown): value is { rules: JsonRuleSummary[] } {
  return (
    isRecord(value) &&
    isUnknownArray(value['rules']) &&
    value['rules'].every((item: unknown) => isRuleSummary(item))
  );
}

function isNotFix(value: unknown): value is { pattern: string; because: string } {
  return (
    isRecord(value) &&
    typeof value['pattern'] === 'string' &&
    typeof value['because'] === 'string'
  );
}

function isRuleExplainResult(value: unknown): value is RuleExplainResult {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['why'] === 'string' &&
    isUnknownArray(value['allowedFixes']) &&
    value['allowedFixes'].every((item: unknown) => typeof item === 'string') &&
    isUnknownArray(value['notFixes']) &&
    value['notFixes'].every((item: unknown) => isNotFix(item))
  );
}

function payload<T>(result: ToolCallResult, guard: (value: unknown) => value is T): T {
  const block = result.content[0];
  expect(block).toBeDefined();
  const parsed: unknown = JSON.parse(block?.text ?? '');
  if (!guard(parsed)) {
    throw new Error('expected tool result to contain a valid JSON payload');
  }
  return parsed;
}

describe('listRulesTool', () => {
  it('returns the enabled rules', async () => {
    const { repo } = await makeConfiguredRepo('export const value = 1;\n');
    try {
      const ctx: McpContext = { cwd: repo };
      const result = await listRulesTool(ctx);

      expect(result.isError).toBeUndefined();
      const { rules } = payload(result, isRuleListResult);
      expect(rules).toHaveLength(1);
      const rule = rules[0];
      assertDefined(rule, 'expected one rule in the list');
      expect(rule).toEqual({
        id: 'no-violation-marker',
        category: 'test',
        severity: 'error',
        summary: 'Flags an explicit VIOLATION marker left in source.',
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('returns an error result rather than throwing when there is no config', async () => {
    const repo = await makeRepo();
    try {
      const ctx: McpContext = { cwd: repo };
      const result = await listRulesTool(ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('cyv init');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('explainRuleTool', () => {
  it('returns full guidance for a known rule id', async () => {
    const { repo } = await makeConfiguredRepo('export const value = 1;\n');
    try {
      const ctx: McpContext = { cwd: repo };
      const result = await explainRuleTool(ctx, { ruleId: 'no-violation-marker' });

      expect(result.isError).toBeUndefined();
      const rule = payload(result, isRuleExplainResult);

      expect(rule.id).toBe('no-violation-marker');
      expect(rule.why.length).toBeGreaterThan(0);
      expect(rule.allowedFixes).toEqual(['Remove the VIOLATION marker from the file.']);
      expect(rule.notFixes).toHaveLength(1);
      expect(rule.notFixes[0]?.pattern).toBe('Rename the marker instead of removing it.');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('returns an error result for an unknown rule id', async () => {
    const { repo } = await makeConfiguredRepo('export const value = 1;\n');
    try {
      const ctx: McpContext = { cwd: repo };
      const result = await explainRuleTool(ctx, { ruleId: 'not-a-real-rule' });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('not-a-real-rule');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('returns an error result rather than throwing for a missing "ruleId" argument', async () => {
    const { repo } = await makeConfiguredRepo('export const value = 1;\n');
    try {
      const ctx: McpContext = { cwd: repo };
      const result = await explainRuleTool(ctx, {});
      expect(result.isError).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
