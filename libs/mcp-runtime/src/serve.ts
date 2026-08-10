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
import { log } from '@adhd/sox-telemetry';
import { getPolicy } from './enforce.js';
import {
  type TransportHandle,
  type ToolDispatch,
  resolveTransports,
  connectStdio,
  connectUds,
  connectStreamableHttp,
  type TransportOptions,
} from './transport.js';

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

// ─── formatToolError ─────────────────────────────────────────────────────────

/**
 * (BUG-MEMORY-001 §2.4) Detect a StorageError-shaped object (CONTRACTS §B:
 * `{code, message, retryable}`, `code` prefixed `E_`) without importing
 * memory-core's type — mcp-runtime is generic and must not depend on any
 * single tool consumer's error taxonomy.
 */
function looksLikeStorageError(
  err: unknown,
): err is { code: string; message: string; retryable: boolean } {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  return (
    typeof e['code'] === 'string' &&
    e['code'].startsWith('E_') &&
    typeof e['message'] === 'string' &&
    typeof e['retryable'] === 'boolean'
  );
}

/**
 * (BUG-MEMORY-001 §2.4) Format a caught tool-handler exception into a
 * `CallToolResult`-shaped error payload, WITHOUT destroying a structured
 * `StorageError` (defect (C) of BUG-MEMORY-001): the previous
 * `text: \`Tool error: ${String(err)}\`` pattern collapses any structured
 * object to the literal string `"[object Object]"` via `String()`, so even a
 * correctly wrapped, correctly classified `StorageError` reaching this
 * boundary lost its shape before reaching the MCP caller.
 *
 * Shared by both MCP dispatch surfaces that catch a thrown tool exception —
 * `buildToolDispatch` below (the `serve()` stdio/sse/http path) and
 * `memory-server/src/backend.ts`'s `handleBackendRequest` (the live UDS
 * backend dispatcher) — fixed once, in one place, per the architect's ruling,
 * not as two independent patches. This is a duck-type check (no cross-package
 * type import), additive-only: anything that is NOT StorageError-shaped keeps
 * the exact current `Tool error: …` text.
 *
 * (BL-500) The non-StorageError fallback previously used `String(err)`, which
 * collapses ANY plain object to `"[object Object]"` — an un-diagnosable,
 * untraced blind spot for non-`StorageError` throws. The fallback now reads
 * the best available text — `message` → `code` → full `JSON.stringify` — and
 * the complete error is traced through `@adhd/sox-telemetry` (`ctx.tool`, when
 * supplied, names the failing tool). Returned text keeps the `Tool error: `
 * prefix promised above; the trace is strictly additive.
 */
export function formatToolError(
  err: unknown,
  ctx?: { tool?: string },
): { isError: true; content: [{ type: 'text'; text: string }] } {
  const fallbackText =
    (err as { message?: unknown } | null)?.message ??
    (err as { code?: unknown } | null)?.code ??
    JSON.stringify(err);
  const text = looksLikeStorageError(err) ? JSON.stringify(err) : `Tool error: ${String(fallbackText)}`;
  log.error('mcp.tool_call.error', {
    tool: ctx?.tool ?? undefined,
    error:
      err instanceof Error
        ? `${err.message}${err.stack ? `\n${err.stack}` : ''}`
        : String(fallbackText),
  });
  return { isError: true, content: [{ type: 'text', text }] };
}

// ─── buildToolDispatch ─────────────────────────────────────────────────────────

/**
 * Build a ToolDispatch from registered tools.
 * The dispatch provides tool listing and invocation backed by C6 enforcement,
 * shared across all transport bindings (stdio, uds, http).
 */
export function buildToolDispatch(
  tools: RegisteredTool[],
  serverInfo: { name: string; version: string },
): ToolDispatch {
  return {
    serverInfo,
    listTools: () =>
      tools.map((t) => ({
        name: t.definition.name,
        description: t.definition.description,
        inputSchema: t.definition.inputSchema,
      })),
    callTool: async (name: string, args: Record<string, unknown>) => {
      const tool = tools.find((t) => t.definition.name === name);
      if (!tool) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
        };
      }

      // [inv:c6-holds]: build context from the current policy BEFORE calling handler.
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
          args as Record<string, unknown>,
          ctx,
        );
        return {
          content: handlerResult.content as Array<{ type: 'text'; text: string }>,
          ...(handlerResult.isError !== undefined ? { isError: handlerResult.isError } : {}),
        };
      } catch (err) {
        return formatToolError(err, { tool: name });
      }
    },
  };
}

// ─── serve ─────────────────────────────────────────────────────────────────────

/** Options for serve(). */
export interface ServeOptions {
  /** Server display name for MCP initialize response. */
  name: string;
  /** Server version string. */
  version?: string;
  /**
   * Transport options (mode, port, host).
   * mode defaults to SOX_MCP_TRANSPORT env var → --transport flag → "stdio".
   * Use `transports` array for multi-bind (TR-1).
   */
  transport?: TransportOptions;
}

/**
 * Start an MCP server with the given tools.
 *
 * Wraps @modelcontextprotocol/sdk — the SDK handles initialize, protocol
 * framing, session management. This function layers:
 *   - transport selection (stdio | uds | http) per the install profile
 *   - multi-bind: all transports in `transports` array bound simultaneously
 *   - C6 policy-env enforcement at the resource sink (via ToolContext)
 *   - graceful shutdown on SIGTERM / SIGINT with queue drain
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
  const serverInfo = { name, version };

  // Build MCP SDK Server (low-level, protocol-aware) — needed for stdio and http transports.
  const server = new Server(
    serverInfo,
    { capabilities: { tools: {} } },
  );

  // Build shared tool dispatch
  const dispatch = buildToolDispatch(tools, serverInfo);

  // tools/list — return the declared tools
  server.setRequestHandler(ListToolsRequestSchema, () => {
    const sdkTools: Tool[] = dispatch.listTools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Tool['inputSchema'],
    }));
    return { tools: sdkTools };
  });

  // tools/call — delegate to dispatch
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name: toolName, arguments: rawArgs = {} } = req.params;
    const result = await dispatch.callTool(toolName, rawArgs as Record<string, unknown>);
    const callResult: CallToolResult = {
      isError: result.isError,
      content: result.content,
    };
    return callResult;
  });

  // Resolve multi-transport list and bind each simultaneously
  const modes = resolveTransports(transportOpts);
  const handles: TransportHandle[] = [];

  for (const mode of modes) {
    if (mode === 'stdio') {
      handles.push(await connectStdio(server));
    } else if (mode === 'uds') {
      const socketPath = transportOpts.socketPath ?? resolveDefaultUdsPath(name);
      handles.push(await connectUds(dispatch, socketPath));
    } else if (mode === 'sse' || mode === 'http') {
      handles.push(await connectStreamableHttp(server, transportOpts));
    }
  }

  // Graceful shutdown: drain all transports before closing
  const shutdown = async () => {
    for (const h of handles) {
      await h.close();
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/**
 * Derive a default UDS socket path from the server name.
 * Data-root convention: ~/.sox/sockets/<name>.sock
 */
function resolveDefaultUdsPath(name: string): string {
  const home = process.env['HOME'] ?? '/tmp';
  return `${home}/.sox/sockets/${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.sock`;
}
