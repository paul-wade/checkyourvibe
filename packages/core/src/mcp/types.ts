/**
 * Local, SDK-independent result shape for a tool call.
 *
 * This mirrors the subset of `CallToolResult` (from `@modelcontextprotocol/sdk`)
 * that these tools actually produce: a single text block, plus `isError` for
 * the "internal failure" case. Keeping it local — rather than importing the
 * SDK's type here — lets the handler functions in `tools.ts` be exercised
 * directly in tests with no transport, and keeps this module's only coupling
 * to the SDK at the wiring layer in `server.ts`.
 */
export interface ToolTextContent {
  type: 'text';
  text: string;
}

export interface ToolCallResult {
  content: ToolTextContent[];
  isError?: boolean;
  /**
   * The SDK's `CallToolResult` is a "loose" schema (it permits and preserves
   * unknown extra keys), which TypeScript represents as an index signature.
   * Declaring one here too is what keeps this local type assignable to the
   * SDK's at the `server.ts` boundary without a cast.
   */
  [key: string]: unknown;
}

/** What a tool handler needs to know about where it is running. */
export interface McpContext {
  /** The working directory the MCP server was started from. */
  cwd: string;
}
