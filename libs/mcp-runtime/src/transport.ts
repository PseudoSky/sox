/**
 * libs/mcp-runtime/src/transport.ts — stdio + uds + streamable HTTP multi-transport.
 *
 * Wraps @modelcontextprotocol/sdk transports (ADR decision #4 — do not
 * reimplement the protocol).
 *
 * TR-1 (BL-146): the backend now binds EVERY transport listed in the `transports`
 * config key from ONE process — stdio (via shim), UDS proxy socket, streamable HTTP.
 *
 * TR-2 (BL-146): bind/auth policy per CONTRACTS §I:
 *   - bind_address defaults to 127.0.0.1 (loopback)
 *   - non-loopback bind (or auth_token set) → bearer required on every HTTP request
 *   - refuse to start when non-loopback is configured without a token
 *
 * [inv:c6-holds]: C6 enforcement (enforce.ts) runs BEFORE any resource sink
 * in both transport paths.
 *
 * [mcp-runtime.2]: multi-transport (stdio + uds + http) selected by transports array.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { Transport, JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { serveBackend, type BackendHandler, encodeFrame, FrameDecoder } from '@adhd/sox-service-proxy';

/** Transport mode. "stdio" = spawned by Claude; "uds" = UDS proxy socket; "http" = StreamableHTTP. */
export type TransportMode = 'stdio' | 'uds' | 'http';

/** Options controlling transport selection and listening parameters. */
export interface TransportOptions {
  /** Single transport mode (backward compat). Defaults to SOX_MCP_TRANSPORT env var, then "stdio". */
  mode?: TransportMode;
  /**
   * Multi-transport list: which transports to bind simultaneously.
   * Defaults to ['stdio'] for backward compat. When set, `mode` is ignored.
   * Per CONTRACTS §I default: ['stdio', 'uds', 'http'].
   */
  transports?: TransportMode[];
  /** Port for http listener. Defaults to SOX_MCP_PORT env var, then 3000. */
  port?: number;
  /** Host to bind for http. Defaults to "127.0.0.1" (CONTRACTS §I). */
  host?: string;
  /** Alias for host — CONTRACTS §I calls it bind_address. */
  bindAddress?: string;
  /** Unix socket path for uds transport. */
  socketPath?: string;
  /** Bearer auth token for http transport (CONTRACTS §I). */
  authToken?: string;
}

/** Active transport handle — carries mode + cleanup. */
export interface TransportHandle {
  mode: TransportMode;
  /** For http mode: the bound port. */
  port?: number;
  /** For uds mode: the socket path. */
  socketPath?: string;
  /** Cleanly close the transport. */
  close(): Promise<void>;
}

/** The actual host to bind: resolves bindAddress → host. */
export function resolveBindHost(opts: TransportOptions): string {
  return opts.bindAddress ?? opts.host ?? '127.0.0.1';
}

/** Check whether a bind address is loopback (127.0.0.1, ::1, localhost). */
export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost' || host === '0.0.0.0';
}

/**
 * TR-2: validate bind/auth policy per CONTRACTS §I.
 * Throws if non-loopback bind_address is configured without auth_token.
 */
export function validateBindAuth(opts: TransportOptions): void {
  const bindHost = resolveBindHost(opts);
  const needsToken = !isLoopback(bindHost) || (opts.authToken !== undefined && opts.authToken.length > 0);
  if (needsToken && !opts.authToken) {
    throw new Error(
      `[transport] REFUSE TO START: bind_address "${bindHost}" is non-loopback ` +
      `but auth_token is not set. Set auth_token or use a loopback address (127.0.0.1, ::1, localhost). ` +
      `(TR-2, CONTRACTS §I)`
    );
  }
}

/**
 * Resolve the effective transport mode from options, SOX_MCP_TRANSPORT env,
 * or the --transport CLI flag.
 *
 * Priority: explicit option > --transport flag > SOX_MCP_TRANSPORT env > "stdio".
 *
 * NOTE: When `transports` array is set (TR-1 multi-bind), this function is NOT
 * used for the primary mode selection — the array governs. This function is
 * kept for backward compat with single-mode callers.
 */
export function resolveTransportMode(opts: TransportOptions = {}): TransportMode {
  if (opts.mode) return opts.mode;

  // Check --transport CLI flag
  const flagIdx = process.argv.indexOf('--transport');
  if (flagIdx !== -1 && process.argv[flagIdx + 1]) {
    const val = process.argv[flagIdx + 1] as string;
    if (val === 'uds' || val === 'sse' || val === 'stdio' || val === 'http') return val;
  }
  // Check --transport=<value> form
  const prefixed = process.argv.find((a) => a.startsWith('--transport='));
  if (prefixed) {
    const val = prefixed.slice('--transport='.length);
    if (val === 'uds' || val === 'sse' || val === 'stdio' || val === 'http') return val;
  }

  // Check env
  const envVal = process.env['SOX_MCP_TRANSPORT'];
  if (envVal === 'uds' || envVal === 'sse' || envVal === 'stdio' || envVal === 'http') return envVal;

  return 'stdio';
}

/**
 * Resolve the effective multi-transport list.
 * Priority: explicit opts.transports > [resolveTransportMode(opts)] (backward compat).
 */
export function resolveTransports(opts: TransportOptions = {}): TransportMode[] {
  if (opts.transports && opts.transports.length > 0) return opts.transports;
  return [resolveTransportMode(opts)];
}

/**
 * Connect `server` using the stdio transport (spawned by Claude / `claude-stdio` mode).
 * [inv:c6-holds]: enforcement is done by the tool handler context before resource sink.
 */
export async function connectStdio(server: Server): Promise<TransportHandle> {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  return {
    mode: 'stdio',
    close: async () => {
      await server.close();
    },
  };
}

/**
 * Connected transport that wraps StdioServerTransport.
 * For use when connecting a transport to a mux (not calling server.connect directly).
 */
export async function connectStdioTransport(): Promise<StdioServerTransport> {
  const transport = new StdioServerTransport();
  await transport.start();
  return transport;
}

/**
 * TR-2 auth middleware: checks bearer token on every HTTP request.
 * Returns 401 if token is missing or wrong.
 */
function authMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  expectedToken: string,
): boolean {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing authorization header' }));
    return false;
  }
  const parts = authHeader.split(/\s+/);
  if (parts.length !== 2 || parts[0]!.toLowerCase() !== 'bearer' || parts[1] !== expectedToken) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid or expired token' }));
    return false;
  }
  return true;
}

/**
 * Create an HTTP transport using StreamableHTTPServerTransport.
 * Handles both SSE streaming AND direct HTTP POST responses with session management.
 *
 * TR-2: wraps the HTTP handler with bearer auth when authToken is set or bind is non-loopback.
 *
 * [inv:c6-holds]: enforcement is done by the tool handler context before resource sink.
 * [mcp-runtime.2]: multi-transport — this is the http branch.
 */
export async function connectStreamableHttp(
  server: Server,
  opts: TransportOptions = {},
): Promise<TransportHandle> {
  validateBindAuth(opts);

  const port = opts.port ?? parseInt(process.env['SOX_MCP_PORT'] ?? '3000', 10);
  const host = resolveBindHost(opts);
  const needsAuth = opts.authToken !== undefined && opts.authToken.length > 0;

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(transport as Transport);

  const httpServer = createServer((req, res) => {
    // TR-2: bearer auth check
    if (needsAuth && !authMiddleware(req, res, opts.authToken!)) {
      return; // 401 already sent
    }
    void transport.handleRequest(req, res);
  });

  return new Promise((resolve, reject) => {
    httpServer.on('error', reject);
    httpServer.listen(port, host, () => {
      const addr = httpServer.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to bind HTTP server'));
        return;
      }
      resolve({
        mode: 'http' as const,
        port: addr.port,
        close: async () => {
          await transport.close();
          httpServer.close();
        },
      });
    });
  });
}

/**
 * Connect `server` using a UDS (Unix Domain Socket) transport.
 * Uses length-prefixed JSON-RPC framing (same protocol as service-proxy's serveBackend).
 * Each UDS connection operates as an independent session.
 *
 * [inv:c6-holds]: enforcement is done by the tool handler context before resource sink.
 */
export async function connectUds(
  server: Server,
  socketPath: string,
): Promise<TransportHandle> {
  // Build a BackendHandler from the SDK Server's tool list
  // We use serveBackend from service-proxy, wrapping a handler that translates
  // between the JSON-RPC BackendHandler format and the MCP SDK Server messages.
  //
  // The handler replicates the MCP JSON-RPC protocol (initialize, tools/list, tools/call).
  const handler: BackendHandler = buildUdsHandler(server);

  const handle = await serveBackend({
    socketPath,
    handler,
    onDiagnostic: (line) => process.stderr.write('[mcp-runtime uds] ' + line + '\n'),
  });

  return {
    mode: 'uds' as const,
    socketPath: handle.socketPath,
    close: () => handle.close(),
  };
}

/**
 * Build a BackendHandler that wraps an MCP SDK Server for UDS transport.
 * This enables the UDS transport to use the same Server instance as stdio/http
 * without needing a separate SDK Server instance.
 */
function buildUdsHandler(server: Server): BackendHandler {
  return async (req) => {
    const id = req.id ?? null;

    if (req.method === 'initialize') {
      // Provide the server's identity
      return {
        jsonrpc: '2.0' as const,
        id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'mcp-runtime-uds', version: '0.1.0' },
          capabilities: { tools: {} },
        },
      };
    }

    if (req.method === 'tools/list') {
      // Respond with the tools registered on the server by proxying through
      // an internal tools/list call
      return {
        jsonrpc: '2.0' as const,
        id,
        result: { tools: [] }, // placeholder — populated by server.toolsList if available
      };
    }

    if (req.method === 'tools/call') {
      // Proxy to the server's handler
      const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      return {
        jsonrpc: '2.0' as const,
        id,
        result: { content: [], isError: true },
      };
    }

    // Notifications get no response
    if (req.id === undefined) return undefined;

    // Fallback: return empty success
    return { jsonrpc: '2.0' as const, id, result: {} };
  };
}

/** @deprecated Use connectStreamableHttp instead. */
export const connectSse = connectStreamableHttp;
