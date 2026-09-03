/**
 * `cyv mcp` — serve analysis and guidance over MCP on stdio.
 *
 * stdout is the transport: the SDK's `StdioServerTransport` writes JSON-RPC
 * frames there, so this module must never `console.log`. Anything meant for
 * a human runs to stderr instead.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Command, CommandContext } from './types.js';
import { createServer } from '../mcp/server.js';

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const command: Command = {
  async run(ctx: CommandContext): Promise<number> {
    try {
      const server = await createServer(ctx.cwd);
      const transport = new StdioServerTransport();

      const closed = new Promise<void>((resolve) => {
        server.onclose = () => resolve();
      });

      await server.connect(transport);
      await closed;

      return 0;
    } catch (err) {
      console.error(messageFor(err));
      return 2;
    }
  },
};
