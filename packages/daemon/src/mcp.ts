#!/usr/bin/env node
/**
 * checkyourvibe-dispatch MCP (stdio) — thin bridge to the loopback daemon.
 * Does not replace analysis `cyv mcp`.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import { DaemonClient } from './http-client.js';
import { isRecord, isUnknownArray, readString } from './parse.js';

const TOOLS: Tool[] = [
  {
    name: 'cyv_health',
    description: 'Ping the local cyv dispatch daemon (127.0.0.1).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cyv_events_after',
    description:
      'Catch-up: return durable completion events after a cursor eventId (overnight-safe). Omit after for all.',
    inputSchema: {
      type: 'object',
      properties: {
        after: { type: 'string', description: 'Last seen eventId; returns strictly later events.' },
      },
    },
  },
  {
    name: 'cyv_status',
    description: 'Latest open/closed state for a workId from the on-disk dispatch store.',
    inputSchema: {
      type: 'object',
      properties: {
        workId: { type: 'string' },
        cwd: { type: 'string', description: 'Project root that owns .cyv-review/dispatches.ndjson' },
      },
      required: ['workId', 'cwd'],
    },
  },
  {
    name: 'cyv_dispatch',
    description:
      'Start a cyv dispatch asynchronously via the daemon. Returns workId immediately (does not wait for the executor).',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        task: { type: 'string' },
        lane: { type: 'string' },
        kind: { type: 'string' },
        own: { type: 'array', items: { type: 'string' } },
        expectsNoFileChanges: { type: 'boolean' },
        timeoutSeconds: { type: 'number' },
      },
      required: ['cwd', 'task'],
    },
  },
  {
    name: 'cyv_wait',
    description:
      'Poll durable events until a matching dispatch.closed for workId (or dispatchId prefix), or timeoutMs.',
    inputSchema: {
      type: 'object',
      properties: {
        workId: { type: 'string' },
        after: { type: 'string', description: 'Optional cursor to start from.' },
        timeoutMs: { type: 'number', description: 'Default 120000' },
        pollMs: { type: 'number', description: 'Default 1000' },
      },
      required: ['workId'],
    },
  },
];

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function jsonResult(data: unknown): CallToolResult {
  return textResult(JSON.stringify(data, null, 2));
}

async function main(): Promise<void> {
  const client = new DaemonClient();
  const server = new Server(
    { name: 'checkyourvibe-dispatch', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = isRecord(req.params.arguments) ? req.params.arguments : {};
    try {
      if (name === 'cyv_health') {
        return jsonResult(await client.health());
      }
      if (name === 'cyv_events_after') {
        const after = readString(args, 'after');
        return jsonResult(await client.eventsAfter(after));
      }
      if (name === 'cyv_status') {
        const workId = readString(args, 'workId');
        const cwd = readString(args, 'cwd');
        if (workId === undefined || cwd === undefined) {
          return textResult('workId and cwd required', true);
        }
        return jsonResult(await client.status(workId, cwd));
      }
      if (name === 'cyv_dispatch') {
        const cwd = readString(args, 'cwd');
        const task = readString(args, 'task');
        if (cwd === undefined || task === undefined) {
          return textResult('cwd and task required', true);
        }
        const body: Record<string, unknown> = { cwd, task };
        const lane = readString(args, 'lane');
        if (lane !== undefined) body.lane = lane;
        const kind = readString(args, 'kind');
        if (kind !== undefined) body.kind = kind;
        if (args.expectsNoFileChanges === true) body.expectsNoFileChanges = true;
        if (typeof args.timeoutSeconds === 'number') body.timeoutSeconds = args.timeoutSeconds;
        if (isUnknownArray(args.own)) {
          const own: string[] = [];
          for (const item of args.own) {
            if (typeof item === 'string') own.push(item);
          }
          if (own.length > 0) body.own = own;
        }
        return jsonResult(await client.dispatch(body));
      }
      if (name === 'cyv_wait') {
        const workId = readString(args, 'workId');
        if (workId === undefined) return textResult('workId required', true);
        const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 120_000;
        const pollMs = typeof args.pollMs === 'number' ? args.pollMs : 1_000;
        let cursor = readString(args, 'after');
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const page = await client.eventsAfter(cursor);
          const events =
            isRecord(page) && isUnknownArray(page.events) ? page.events : [];
          for (const ev of events) {
            if (!isRecord(ev)) continue;
            const id = readString(ev, 'dispatchId') ?? '';
            const wid = readString(ev, 'workId') ?? '';
            const type = readString(ev, 'type');
            const eventId = readString(ev, 'eventId');
            if (eventId !== undefined) cursor = eventId;
            if (
              type === 'dispatch.closed' &&
              (wid === workId || id === workId || id.startsWith(`${workId}-`))
            ) {
              return jsonResult({ ok: true, event: ev });
            }
          }
          await new Promise((r) => setTimeout(r, pollMs));
        }
        return textResult(`timeout waiting for closed event for ${workId}`, true);
      }
      return textResult(`Unknown tool: ${name}`, true);
    } catch (err) {
      return textResult(err instanceof Error ? err.message : String(err), true);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});