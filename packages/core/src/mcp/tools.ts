/**
 * The four MCP tool handlers, as plain functions.
 *
 * Kept independent of the MCP SDK (see `types.ts`) so they can be called
 * directly in tests, with no transport or schema-validation layer in the way.
 * `server.ts` is the only module that adapts these to the SDK's wire format.
 *
 * Every handler catches its own failures and returns an error result rather
 * than throwing: the server is long-lived, and one bad request — a missing
 * config, an unreadable file, a broken analyzer — must not take the process
 * down with it.
 */
import { isUnknownArray } from '../guards.js';
import { runCheckPipeline } from './pipeline.js';
import { findRule, listEnabledRules } from './rules.js';
import type { McpContext, ToolCallResult } from './types.js';

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function textResult(text: string): ToolCallResult {
  return { content: [{ type: 'text', text }] };
}

function jsonResult(data: unknown): ToolCallResult {
  return textResult(JSON.stringify(data, null, 2));
}

function errorResult(message: string): ToolCallResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function asStringArray(value: unknown): string[] | undefined {
  if (!isUnknownArray(value)) {
    return undefined;
  }
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i];
    if (typeof item !== 'string') {
      return undefined;
    }
    result.push(item);
  }
  return result;
}

/** `list_rules()` — every enabled rule as `{ id, category, severity, summary }`. */
export async function listRulesTool(ctx: McpContext): Promise<ToolCallResult> {
  try {
    const rules = await listEnabledRules(ctx.cwd);
    return jsonResult({ rules });
  } catch (err) {
    return errorResult(`Failed to list rules: ${messageFor(err)}`);
  }
}

/** `explain_rule(ruleId)` — that rule's full guidance, or an error result if unknown. */
export async function explainRuleTool(ctx: McpContext, args: Record<string, unknown>): Promise<ToolCallResult> {
  try {
    const ruleId = args.ruleId;
    if (typeof ruleId !== 'string' || ruleId.trim() === '') {
      return errorResult('explain_rule requires a non-empty "ruleId" string argument.');
    }

    const rule = await findRule(ctx.cwd, ruleId);
    if (rule === undefined) {
      return errorResult(`Unknown rule "${ruleId}".`);
    }

    return jsonResult(rule);
  } catch (err) {
    return errorResult(`Failed to explain rule: ${messageFor(err)}`);
  }
}

/** `check_files(paths)` — violations for those files (mode 'file'), guidance embedded. */
export async function checkFilesTool(ctx: McpContext, args: Record<string, unknown>): Promise<ToolCallResult> {
  try {
    const paths = asStringArray(args.paths);
    if (paths === undefined) {
      return errorResult('check_files requires a "paths" argument: an array of file path strings.');
    }
    if (paths.length === 0) {
      return errorResult('check_files requires at least one path.');
    }

    const result = await runCheckPipeline(ctx.cwd, 'files', paths);
    return jsonResult(result);
  } catch (err) {
    return errorResult(`check_files failed: ${messageFor(err)}`);
  }
}

/** `check_working_tree()` — violations for uncommitted work, the same selection `cyv check --working` uses. */
export async function checkWorkingTreeTool(ctx: McpContext): Promise<ToolCallResult> {
  try {
    const result = await runCheckPipeline(ctx.cwd, 'working');
    return jsonResult(result);
  } catch (err) {
    return errorResult(`check_working_tree failed: ${messageFor(err)}`);
  }
}
