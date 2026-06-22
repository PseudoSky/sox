/**
 * libs/mcp-runtime/src/serve.ts — Author-facing API: serve(defineTool(...)).
 *
 * [shape:mcp-tool]: authors write tools only; the wrapper owns transport,
 * protocol, health, shutdown, and C6 enforcement.
 *
 * Wraps @modelcontextprotocol/sdk (ADR decision #4 — do not reimplement).
 * Uses the low-level Server class to support plain JSON schema inputSchema
 * (authors do not need Zod).
 *
 * [mcp-runtime.1]: grep for 'serve|defineTool' and '@modelcontextprotocol/sdk'
 * → both non-empty.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { getPolicy } from './enforce.js';
import { resolveTransportMode, connectStdio, connectSse, type TransportOptions } from './transport.js';

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * The policy context exposed to tool handlers.
 * [shape:mcp-tool]: ctx exposes policy accessors; sink is C6-enforced.
 */
export interface ToolContext {
  /** Whether the server is operating under C6 enforcement. */
  enforced: boolean;
  /** Check fs-read access to absPath. Returns true if allowed. */
  allowsFsRead(absPath: string): boolean;
  /** Check fs-write access to absPath. Returns true if allowed. */
  allowsFsWrite(absPath: string): boolean;
  /** Check network access to hostOrUrl. Returns true if allowed. */
  allowsNetwork(hostOrUrl: string): boolean;
  /** Check socket access to absPath. Returns true if allowed. */
  allowsSocket(absPath: string): boolean;
}

/** Tool result content item. */
export interface ToolResultContent {
  type: 'text';
  text: string;
}

/** The return type from a tool handler — success payload. */
export interface ToolResult {
  content: ToolResultContent[];
  isError?: boolean;
}

/**
 * Tool definition — the shape authors pass to defineTool().
 * [shape:mcp-tool]
 */
export interface ToolDefinition<TArgs extends Record<string, unknown> = Record<string, unknown>> {
  /** Unique tool name. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Plain JSON Schema object describing the input arguments. */
  inputSchema: {
    type: 'object';
    properties: Record<string, object>;
    required?: string[];
  };
  /**
   * Tool implementation.
   * ctx exposes policy accessors ([shape:mcp-tool]).
   * Enforcement is applied before the OS resource in the transport layer.
   */
  handler: (args: TArgs, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}

/** A compiled, registered tool ready for serve(). */
export interface RegisteredTool {
  definition: ToolDefinition;
}

// ─── defineTool ───────────────────────────────────────────────────────────────

/**
 * Define a tool for use with serve().
 *
 * Authors write only the handler; the wrapper provides transport, protocol,
 * C6 enforcement, health, and graceful shutdown.
 *
 * [shape:mcp-tool]:
 *   serve(defineTool({ name, description, inputSchema, handler }));
 */
export function defineTool<TArgs extends Record<string, unknown> = Record<string, unknown>>(
  def: ToolDefinition<TArgs>,
): RegisteredTool {
  // Type-erase TArgs for the registry — callers receive proper types through
  // the ToolDefinition<TArgs> generic.
  return { definition: def as unknown as ToolDefinition };
}

// ─── serve ────────────────────────────────────────────────────────────────────

/** Options for serve(). */
export interface ServeOptions {
  /** Server display name for MCP initialize response. */
  name: string;
  /** Server version string. */
  version?: string;
  /**
   * Transport options (mode, port, host).
   * mode defaults to SOX_MCP_TRANSPORT env var → --transport flag → "stdio".
   */
  transport?: TransportOptions;
}

/**
 * Start an MCP server with the given tools.
 *
 * Wraps @modelcontextprotocol/sdk — the SDK handles initialize, protocol
 * framing, session management. This function layers:
 *   - transport selection (stdio | sse/http) per the install profile
 *   - C6 policy-env enforcement at the resource sink (via ToolContext)
 *   - graceful shutdown on SIGTERM / SIGINT
 *
 * [mcp-runtime.1]: wraps the official SDK (Server, ListToolsRequestSchema,
 *   CallToolRequestSchema) — not a reimplementation.
 * [inv:c6-holds]: getPolicy() runs before handler() in EVERY tool call path.
 *
 * @param tools - The tools to expose (created via defineTool()).
 * @param opts  - Server identity + transport options.
 */
export async function serve(tools: RegisteredTool[], opts: ServeOptions): Promise<void> {
  // [shape:serve-marker]: emit the real-path marker so guards can prove the
  // genuine serve() ran (not a deleted hand-rolled fallback or stub).
  process.stderr.write('[serve] real-path: ' + __dirname + '\n');

  const { name, version = '0.1.0', transport: transportOpts = {} } = opts;

  // Build MCP SDK Server (low-level, protocol-aware)
  const server = new Server(
    { name, version },
    { capabilities: { tools: {} } },
  );

  // tools/list — return the declared tools
  server.setRequestHandler(ListToolsRequestSchema, () => {
    const sdkTools: Tool[] = tools.map((t) => ({
      name: t.definition.name,
      description: t.definition.description,
      inputSchema: t.definition.inputSchema,
    }));
    return { tools: sdkTools };
  });

  // tools/call — resolve the tool, build ToolContext, run handler
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name: toolName, arguments: rawArgs = {} } = req.params;

    const tool = tools.find((t) => t.definition.name === toolName);
    if (!tool) {
      const result: CallToolResult = {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
      };
      return result;
    }

    // [inv:c6-holds]: build context from the current policy BEFORE calling handler.
    // Policy is read fresh each call so test env mutations are respected.
    const policy = getPolicy();
    const ctx: ToolContext = {
      enforced: policy.enforced,
      allowsFsRead: (p) => policy.allowsFsRead(p),
      allowsFsWrite: (p) => policy.allowsFsWrite(p),
      allowsNetwork: (h) => policy.allowsNetwork(h),
      allowsSocket: (p) => policy.allowsSocket(p),
    };

    try {
      const handlerResult = await tool.definition.handler(
        rawArgs as Record<string, unknown>,
        ctx,
      );
      const result: CallToolResult = {
        isError: handlerResult.isError,
        content: handlerResult.content,
      };
      return result;
    } catch (err) {
      const result: CallToolResult = {
        isError: true,
        content: [{ type: 'text', text: `Tool error: ${String(err)}` }],
      };
      return result;
    }
  });

  // Select and connect transport
  const mode = resolveTransportMode(transportOpts);
  const handle =
    mode === 'sse'
      ? await connectSse(server, transportOpts)
      : await connectStdio(server);

  // Graceful shutdown
  const shutdown = () => {
    void handle.close();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
