/**
 * libs/mcp-runtime/src/transport.ts — stdio + sse/http transport selection.
 *
 * Wraps @modelcontextprotocol/sdk transports (ADR decision #4 — do not
 * reimplement the protocol).
 *
 * Transport is selected by the SOX_MCP_TRANSPORT env var (set by the install
 * profile) or the --transport CLI flag. Valid values: "stdio" (default), "sse".
 *
 * [inv:c6-holds]: C6 enforcement (enforce.ts) runs BEFORE any resource sink
 * in both transport paths.
 *
 * [mcp-runtime.2]: dual transport (stdio + sse/http) selected by flag/env.
 */

import * as http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

/** Transport mode. "stdio" = spawned by Claude; "sse" = sox-service mode. */
export type TransportMode = 'stdio' | 'sse';

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
  /** For sse mode: the bound port. */
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
    if (val === 'sse' || val === 'stdio') return val;
  }
  // Check --transport=<value> form
  const prefixed = process.argv.find((a) => a.startsWith('--transport='));
  if (prefixed) {
    const val = prefixed.slice('--transport='.length);
    if (val === 'sse' || val === 'stdio') return val;
  }

  // Check env
  const envVal = process.env['SOX_MCP_TRANSPORT'];
  if (envVal === 'sse' || envVal === 'stdio') return envVal;

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
 * Connect `server` using the SSE/HTTP transport (sox-service mode).
 *
 * Starts an HTTP server that:
 *   GET /sse   — opens the SSE stream
 *   POST /message — receives client messages
 *
 * [inv:c6-holds]: enforcement is done by the tool handler context before resource sink.
 * [mcp-runtime.2]: dual transport — this is the sse/http branch.
 */
export async function connectSse(
  server: Server,
  opts: TransportOptions = {},
): Promise<TransportHandle> {
  const port = opts.port ?? Number(process.env['SOX_MCP_PORT'] ?? 0);
  const host = opts.host ?? '127.0.0.1';

  // Sessions keyed by sessionId
  const transports = new Map<string, SSEServerTransport>();

  const httpServer = http.createServer((req, res) => {
    const url = req.url ?? '/';

    if (req.method === 'GET' && url.startsWith('/sse')) {
      const sseTransport = new SSEServerTransport('/message', res);
      transports.set(sseTransport.sessionId, sseTransport);

      sseTransport.onclose = () => {
        transports.delete(sseTransport.sessionId);
      };

      void server.connect(sseTransport);
      return;
    }

    if (req.method === 'POST' && url.startsWith('/message')) {
      const sessionId = new URL(url, 'http://localhost').searchParams.get('sessionId');
      const transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        res.writeHead(404);
        res.end('Session not found');
        return;
      }
      void transport.handlePostMessage(req, res);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  const boundPort = await new Promise<number>((resolve, reject) => {
    httpServer.on('error', reject);
    httpServer.listen(port, host, () => {
      const addr = httpServer.address();
      resolve(typeof addr === 'object' && addr !== null ? addr.port : port);
    });
  });

  return {
    mode: 'sse',
    port: boundPort,
    close: async () => {
      for (const t of transports.values()) {
        await t.close();
      }
      transports.clear();
      await server.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
