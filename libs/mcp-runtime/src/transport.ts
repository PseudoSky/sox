/**
 * libs/mcp-runtime/src/transport.ts — stdio + sse/http transport selection.
 *
 * Wraps @modelcontextprotocol/sdk transports (ADR decision #4 — do not
 * reimplement the protocol).
 *
 * Transport is selected by the SOX_MCP_TRANSPORT env var (set by the install
 * profile) or the --transport CLI flag. Valid values: "stdio" (default), "sse", "http".
 *
 * [inv:c6-holds]: C6 enforcement (enforce.ts) runs BEFORE any resource sink
 * in both transport paths.
 *
 * [mcp-runtime.2]: dual transport (stdio + sse/http) selected by flag/env.
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/** Transport mode. "stdio" = spawned by Claude; "sse" = sox-service SSE mode; "http" = StreamableHTTP. */
export type TransportMode = 'stdio' | 'sse' | 'http';

/** Options controlling transport selection and sse listening parameters. */
export interface TransportOptions {
  /** Transport mode. Defaults to SOX_MCP_TRANSPORT env var, then "stdio". */
  mode?: TransportMode;
  /** Port for sse/http listener. Defaults to SOX_MCP_PORT env var, then 0 (random). */
  port?: number;
  /** Host to bind for sse/http. Defaults to "127.0.0.1". */
  host?: string;
}

/** Active transport handle — carries mode + cleanup. */
export interface TransportHandle {
  mode: TransportMode;
  /** For sse/http mode: the bound port. */
  port?: number;
  /** Cleanly close the transport. */
  close(): Promise<void>;
}

/**
 * Resolve the effective transport mode from options, SOX_MCP_TRANSPORT env,
 * or the --transport CLI flag.
 *
 * Priority: explicit option > --transport flag > SOX_MCP_TRANSPORT env > "stdio".
 */
export function resolveTransportMode(opts: TransportOptions = {}): TransportMode {
  if (opts.mode) return opts.mode;

  // Check --transport CLI flag
  const flagIdx = process.argv.indexOf('--transport');
  if (flagIdx !== -1 && process.argv[flagIdx + 1]) {
    const val = process.argv[flagIdx + 1] as string;
    if (val === 'sse' || val === 'stdio' || val === 'http') return val;
  }
  // Check --transport=<value> form
  const prefixed = process.argv.find((a) => a.startsWith('--transport='));
  if (prefixed) {
    const val = prefixed.slice('--transport='.length);
    if (val === 'sse' || val === 'stdio' || val === 'http') return val;
  }

  // Check env
  const envVal = process.env['SOX_MCP_TRANSPORT'];
  if (envVal === 'sse' || envVal === 'stdio' || envVal === 'http') return envVal;

  return 'stdio';
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
 * Create an HTTP transport using StreamableHTTPServerTransport.
 * Replaces the deprecated SSEServerTransport-based connectSse.
 * Handles both SSE streaming AND direct HTTP POST responses with session management.
 *
 * [inv:c6-holds]: enforcement is done by the tool handler context before resource sink.
 * [mcp-runtime.2]: dual transport — this is the sse/http branch.
 */
export async function connectStreamableHttp(
  server: Server,
  opts: TransportOptions = {},
): Promise<TransportHandle> {
  const port = opts.port ?? parseInt(process.env['SOX_MCP_PORT'] ?? '0', 10);
  const host = opts.host ?? '127.0.0.1';

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(transport as Transport);

  const httpServer = createServer((req, res) => {
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

/** @deprecated Use connectStreamableHttp instead. */
export const connectSse = connectStreamableHttp;
