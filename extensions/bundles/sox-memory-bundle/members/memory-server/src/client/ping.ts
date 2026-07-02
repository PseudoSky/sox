/**
 * Memory ping — verify the server is reachable.
 *
 * [inv:no-mcp] — returns a plain object, never an MCP ToolResult.
 */

export interface PingResult {
  ok: boolean;
}

export const inputSchema = {
  type: 'object' as const,
  properties: {},
};

/**
 * Backing for memory_ping. Returns a simple { ok: true } object.
 * The content-address identity (sha256 of the running artifact) is an
 * MCP-server concern and lives in index.ts, not here.
 */
export async function pingMemory(): Promise<PingResult> {
  return { ok: true };
}
