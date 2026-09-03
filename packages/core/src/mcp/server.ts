/**
 * Wires the four tool handlers (`tools.ts`) into an MCP `Server` over stdio.
 *
 * This uses the SDK's low-level `Server` rather than the high-level
 * `McpServer`, because `McpServer`'s `registerTool` requires a Zod schema (or
 * raw shape of Zod schemas) for `inputSchema` — and `zod` is only reachable
 * from the SDK's own package location in this workspace, not from
 * `@checkyourvibe/core` (it is the SDK's dependency, not this package's, and
 * is not hoisted). The low-level `Server` takes a plain JSON Schema object for
 * a tool's `inputSchema`, so no Zod import is needed here at all — every
 * value imported below comes from the SDK's own compiled modules, which
 * resolve `zod` from their own location regardless of what this package
 * declares.
 */
import { readFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { checkFilesTool, checkWorkingTreeTool, explainRuleTool, listRulesTool } from './tools.js';
import type { McpContext } from './types.js';

const TOOLS: Tool[] = [
  {
    name: 'check_files',
    description:
      'Check specific files for rule violations (mode "file"). Every violation embeds its remediation guidance inline — summary, why, allowedFixes, and notFixes — so no follow-up lookup is needed.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths to check, absolute or repo-relative.',
        },
      },
      required: ['paths'],
    },
  },
  {
    name: 'check_working_tree',
    description:
      'Check uncommitted work — the same file selection `cyv check --working` uses. Every violation embeds its remediation guidance inline.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'explain_rule',
    description: "Return a single rule's full remediation guidance by id.",
    inputSchema: {
      type: 'object',
      properties: {
        ruleId: { type: 'string', description: 'The rule id to explain, e.g. "no-any".' },
      },
      required: ['ruleId'],
    },
  },
  {
    name: 'list_rules',
    description: 'List every enabled rule as { id, category, severity, summary }.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readVersion(): Promise<string> {
  const packageJsonUrl = new URL('../../package.json', import.meta.url);
  const raw = await readFile(packageJsonUrl, 'utf-8');
  const pkg: unknown = JSON.parse(raw);
  return isRecord(pkg) && typeof pkg.version === 'string' ? pkg.version : '0.0.0';
}

/** Build (but do not connect) an MCP server exposing the four checkyourvibe tools. */
export async function createServer(cwd: string): Promise<Server> {
  const context: McpContext = { cwd };
  const version = await readVersion();

  const server = new Server(
    { name: 'checkyourvibe', version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const args = request.params.arguments ?? {};

    switch (request.params.name) {
      case 'check_files':
        return checkFilesTool(context, args);
      case 'check_working_tree':
        return checkWorkingTreeTool(context);
      case 'explain_rule':
        return explainRuleTool(context, args);
      case 'list_rules':
        return listRulesTool(context);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool "${request.params.name}"`);
    }
  });

  return server;
}
