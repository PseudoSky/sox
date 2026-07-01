/**
 * libs/service-proxy/src/shim.ts — the stdio front-shim (§9.5.2 / §9.5.3).
 *
 * `runFrontShim` is what `cmdServe` invokes in proxy-mode. It is the M3-shaped
 * surface the MCP client spawns over stdio, but it holds NO tool implementation.
 * It:
 *   1. Serves `initialize` + `tools/list` from a cached schema (read once from the
 *      backend, or from a published schema.json), so the client gets an instant,
 *      stable interface.
 *   2. Proxies every other JSON-RPC request to the backend over a UDS via
 *      `dialBackend` — which survives backend restarts (the zero-downtime path).
 *   3. On each backend (re)connect, re-reads the backend schema-hash; on a mismatch
 *      it keeps serving the old schema, emits a stderr notice, and (if the client
 *      declared the capability) a `notifications/tools/list_changed` so a capable
 *      client refreshes without a full reconnect (`[contract:schema-hash]`).
 *
 * `[inv:no-stdout-diagnostics]`: stdout carries ONLY newline-delimited JSON-RPC to
 * the client. Every diagnostic goes to stderr. A stray stdout byte corrupts the
 * client's JSON-RPC stream.
 *
 * The MCP stdio wire format (per the MCP SDK's StdioServerTransport) is
 * newline-delimited JSON-RPC — one JSON object per line. We read/write that on the
 * client side and translate to/from length-prefixed UDS frames on the backend side.
 *
 * Leaf module — node builtins only (fs, readline, crypto via schema-hash).
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import { dialBackend, type BackendConnection } from './dial.js';
import {
  type JsonRpcRequest,
  type JsonRpcResponse,
  errorResponse,
  isJsonRpcRequest,
} from './jsonrpc.js';
import { computeSchemaHash } from './schema-hash.js';

/** Options for {@link runFrontShim}. */
export interface FrontShimOptions {
  /** Extension id (for diagnostics + serve-record). */
  id: string;
  /** Backend UDS path (data-root-derived, ADR-0004). */
  socketPath: string;
  /** Path to a published schema.json the backend writes (optional). If present and
   * readable, the shim serves tools/list from it immediately without waiting for a
   * backend connection — making `initialize`/`tools/list` instant even if the
   * backend is mid-restart at client-connect time. */
  schemaCachePath?: string;
  /** The readable stream of client→shim JSON-RPC (default process.stdin). */
  input?: NodeJS.ReadableStream;
  /** The writable stream of shim→client JSON-RPC (default process.stdout). */
  output?: NodeJS.WritableStream;
  /** stderr diagnostics sink (default process.stderr). */
  onDiagnostic?: (line: string) => void;
  /** Backoff override (forwarded to dialBackend). */
  backoff?: Parameters<typeof dialBackend>[0]['backoff'];
  /**
   * Auto-managed backend lifecycle hook (§9.5 step 3). When provided, the shim
   * calls this BEFORE dialing (to ensure a backend exists) and AGAIN whenever the
   * backend connection drops mid-flight (re-ensure after a crash). Idempotent —
   * a no-op when a backend is already live (see {@link ensureBackend}). When
   * omitted, the shim assumes the backend is managed externally (e.g. an M4 unit)
   * and only dials.
   */
  ensure?: () => Promise<void>;
  /**
   * When set, start an HTTP listener on the given port in ADDITION to the stdio
   * input stream. The HTTP server accepts JSON-RPC via POST /mcp and proxies
   * through the same backend connection. Supports both stdio and HTTP clients
   * simultaneously.
   */
  httpPort?: number;
}

/** A running front-shim handle (for tests; in production the process lives until
 * the client closes the pipe). */
export interface FrontShimHandle {
  /** Resolves when the client input stream ends (the pipe closed). */
  done: Promise<void>;
  /** Force-close the shim (tears down the backend connection). */
  close(): void;
  /** The connection to the backend (exposed for tests). */
  backend: BackendConnection;
}

/**
 * Run the front-shim. Returns once wired; the returned `done` promise resolves when
 * the client closes the input pipe.
 */
export function runFrontShim(opts: FrontShimOptions): FrontShimHandle {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const diag = opts.onDiagnostic ?? ((line: string) => process.stderr.write(line + '\n'));

  /** The cached tools/list result the shim serves to the client. */
  let cachedToolsList: unknown | null = null;
  /** The schema-hash the shim served at initialize/tools/list time. */
  let servedSchemaHash: string | null = null;
  /** Whether the client declared it honors tools/list_changed (set from initialize). */
  let clientSupportsListChanged = false;
  /** Whether the client has called initialize yet. */
  let initialized = false;

  // Seed the cached schema from a published schema.json if available (instant
  // tools/list even while the backend restarts).
  if (opts.schemaCachePath !== undefined && opts.schemaCachePath !== '') {
    try {
      const raw = fs.readFileSync(opts.schemaCachePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      cachedToolsList = parsed;
      servedSchemaHash = computeSchemaHash(parsed);
      diag(`[service-proxy shim:${opts.id}] seeded schema from ${opts.schemaCachePath}`);
    } catch {
      // No published schema — we'll read it from the backend on first tools/list.
    }
  }

  function writeToClient(resp: JsonRpcResponse | JsonRpcRequest): void {
    // [inv:no-stdout-diagnostics]: ONLY framed JSON-RPC goes to the client stream.
    output.write(JSON.stringify(resp) + '\n');
  }

  /**
   * Run the auto-managed backend ensure (§9.5 step 3), swallowing errors so a
   * failed ensure never crashes the shim — the re-dial loop will keep retrying and
   * a fast-fail (-32001) is surfaced to the client without closing the pipe.
   * Serialized: overlapping ensure calls (start + a disconnect at the same time)
   * collapse onto one in-flight promise so we never spawn a thundering herd.
   */
  let ensureInFlight: Promise<void> | null = null;
  function ensureBackendLive(reason: string): void {
    if (opts.ensure === undefined) return;
    if (ensureInFlight !== null) return;
    diag(`[service-proxy shim:${opts.id}] ensuring backend (${reason})`);
    ensureInFlight = opts
      .ensure()
      .catch((e: unknown) => {
        diag(`[service-proxy shim:${opts.id}] ensure-backend error: ${(e as Error).message}`);
      })
      .finally(() => {
        ensureInFlight = null;
      });
  }

  // Ensure a backend exists before (and concurrently with) the first dial. The
  // dial layer retries with backoff, so it connects as soon as ensure brings the
  // backend up — no ordering dependency.
  ensureBackendLive('shim start');

  // Backend connection (re-dialing, survives restarts).
  const backend = dialBackend({
    socketPath: opts.socketPath,
    ...(opts.backoff !== undefined ? { backoff: opts.backoff } : {}),
    onDiagnostic: diag,
    onConnect: () => {
      // On every backend (re)connect, re-read the schema-hash and run the
      // interface-change handshake (§9.5.3).
      void refreshBackendSchema();
    },
    onDisconnect: () => {
      // The backend dropped (crash or an upgrade rolling-restart). Re-ensure it so
      // a CRASHED backend (not a clean rolling-restart, which respawns itself) is
      // brought back up. Idempotent: a no-op if the restart already re-bound.
      ensureBackendLive('backend disconnect');
    },
  });

  /**
   * Read the backend's current tools/list, compare its schema-hash to what we
   * served the client, and run the [contract:schema-hash] handshake.
   */
  async function refreshBackendSchema(): Promise<void> {
    const resp = await backend.send({
      jsonrpc: '2.0',
      id: `__shim_tools_list_${Date.now()}`,
      method: 'tools/list',
    });
    if (resp.error) {
      diag(`[service-proxy shim:${opts.id}] backend tools/list error: ${resp.error.message}`);
      return;
    }
    const result = resp.result;
    const newHash = computeSchemaHash(result);

    if (cachedToolsList === null) {
      // First time we've seen a schema — adopt it as the served schema.
      cachedToolsList = result;
      servedSchemaHash = newHash;
      return;
    }

    if (newHash !== servedSchemaHash) {
      // Interface change behind the shim (§9.5.3). Keep serving the OLD schema to
      // the connected client (in-flight calls don't break); emit a stderr notice
      // and a tools/list_changed nudge if the client honors it.
      diag(
        `[service-proxy shim:${opts.id}] backend schema-hash changed ` +
          `(${servedSchemaHash?.slice(0, 12)} → ${newHash.slice(0, 12)}); ` +
          `serving cached schema, nudging client`,
      );
      if (clientSupportsListChanged) {
        writeToClient({
          jsonrpc: '2.0',
          method: 'notifications/tools/list_changed',
        } as JsonRpcRequest);
      }
    }
  }

  async function handleRequest(req: JsonRpcRequest): Promise<void> {
    // ── initialize: record client capabilities; proxy to backend, but the shim
    //    answers so the client gets a stable serverInfo even mid-restart. ──
    if (req.method === 'initialize') {
      initialized = true;
      const params = (req.params ?? {}) as { capabilities?: Record<string, unknown> };
      const caps = params.capabilities ?? {};
      // A client that lists a `tools` capability with `listChanged` honors the nudge.
      const toolsCap = (caps as { tools?: { listChanged?: boolean } }).tools;
      clientSupportsListChanged = toolsCap?.listChanged === true;

      const resp = await backend.send(req);
      // Forward the backend's initialize result verbatim (it carries the real
      // serverInfo + capabilities). If the backend is unavailable, the dial layer
      // returns a -32001 error response — the client sees a clean error, pipe open.
      writeToClient({ ...resp, id: req.id ?? null });
      return;
    }

    // ── tools/list: serve from cache when we have it (the whole point — stable,
    //    instant, survives backend restarts). Otherwise read through. ──
    if (req.method === 'tools/list') {
      if (cachedToolsList !== null) {
        writeToClient({ jsonrpc: '2.0', id: req.id ?? null, result: cachedToolsList });
        return;
      }
      const resp = await backend.send(req);
      if (!resp.error && resp.result !== undefined) {
        cachedToolsList = resp.result;
        servedSchemaHash = computeSchemaHash(resp.result);
      }
      writeToClient({ ...resp, id: req.id ?? null });
      return;
    }

    // ── notifications (no id): forward best-effort, no response. ──
    if (req.id === undefined) {
      backend.notify(req);
      return;
    }

    // ── everything else (tools/call, …): proxy to the backend. ──
    const resp = await backend.send(req);
    writeToClient({ ...resp, id: req.id ?? null });
  }

  // ── Read newline-delimited JSON-RPC from the client (MCP stdio wire format). ──
  let lineBuf = '';
  function onInputData(chunk: Buffer | string): void {
    lineBuf += chunk.toString();
    let nl: number;
    while ((nl = lineBuf.indexOf('\n')) !== -1) {
      const line = lineBuf.slice(0, nl).trim();
      lineBuf = lineBuf.slice(nl + 1);
      if (line === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        diag(`[service-proxy shim:${opts.id}] invalid JSON from client: ${(e as Error).message}`);
        continue;
      }
      if (!isJsonRpcRequest(parsed)) {
        diag(`[service-proxy shim:${opts.id}] non-request frame from client (ignored)`);
        continue;
      }
      void handleRequest(parsed as JsonRpcRequest).catch((e: unknown) => {
        const req = parsed as JsonRpcRequest;
        diag(`[service-proxy shim:${opts.id}] handler error: ${(e as Error).message}`);
        if (req.id !== undefined) {
          writeToClient(errorResponse(req.id, -32603, `proxy error: ${(e as Error).message}`));
        }
      });
    }
  }

  let resolveDone!: () => void;
  const done = new Promise<void>((res) => {
    resolveDone = res;
  });

  input.on('data', onInputData);
  input.on('end', () => {
    diag(`[service-proxy shim:${opts.id}] client pipe closed (initialized=${initialized})`);
    backend.close();
    resolveDone();
  });
  input.on('error', (err: Error) => {
    diag(`[service-proxy shim:${opts.id}] client input error: ${err.message}`);
    backend.close();
    resolveDone();
  });

  // ── Optional HTTP listener (dual transport: stdio + HTTP) ──────────────────
  let httpServer: http.Server | undefined;
  if (opts.httpPort !== undefined) {
    httpServer = http.createServer((req, res) => {
      // Only accept POST /mcp (MCP StreamableHTTP endpoint).
      if (req.method !== 'POST' || req.url !== '/mcp') {
        res.writeHead(405);
        res.end();
        return;
      }

      // Set CORS headers for browser-based MCP clients.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Content-Type', 'application/json');

      let body = '';
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }));
          return;
        }
        if (!isJsonRpcRequest(parsed)) {
          res.writeHead(400);
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' } }));
          return;
        }

        const reqRpc = parsed as JsonRpcRequest;

        // initialize: return stable serverInfo immediately without backend wait.
        if (reqRpc.method === 'initialize') {
          const params = (reqRpc.params ?? {}) as { capabilities?: Record<string, unknown> };
          const caps = params.capabilities ?? {};
          const toolsCap = (caps as { tools?: { listChanged?: boolean } }).tools;
          if (toolsCap?.listChanged === true) clientSupportsListChanged = true;
          initialized = true;

          backend
            .send(reqRpc)
            .then((resp) => {
              res.end(JSON.stringify({ ...resp, id: reqRpc.id ?? null }));
            })
            .catch((e: unknown) => {
              res.end(
                JSON.stringify(
                  errorResponse(reqRpc.id ?? null, -32603, `proxy error: ${(e as Error).message}`),
                ),
              );
            });
          return;
        }

        // tools/list: serve from cache when available.
        if (reqRpc.method === 'tools/list') {
          if (cachedToolsList !== null) {
            res.end(JSON.stringify({ jsonrpc: '2.0', id: reqRpc.id ?? null, result: cachedToolsList }));
            return;
          }
          backend
            .send(reqRpc)
            .then((resp) => {
              if (!resp.error && resp.result !== undefined) {
                cachedToolsList = resp.result;
                servedSchemaHash = computeSchemaHash(resp.result);
              }
              res.end(JSON.stringify({ ...resp, id: reqRpc.id ?? null }));
            })
            .catch((e: unknown) => {
              res.end(
                JSON.stringify(
                  errorResponse(reqRpc.id ?? null, -32603, `proxy error: ${(e as Error).message}`),
                ),
              );
            });
          return;
        }

        // everything else: proxy to backend.
        backend
          .send(reqRpc)
          .then((resp) => {
            res.end(JSON.stringify({ ...resp, id: reqRpc.id ?? null }));
          })
          .catch((e: unknown) => {
            res.end(
              JSON.stringify(
                errorResponse(reqRpc.id ?? null, -32603, `proxy error: ${(e as Error).message}`),
              ),
            );
          });
      });
    });

    httpServer.listen(opts.httpPort, '127.0.0.1', () => {
      diag(`[service-proxy shim:${opts.id}] HTTP listener on 127.0.0.1:${opts.httpPort}/mcp`);
    });
  }

  return {
    done,
    close: () => {
      if (httpServer) httpServer.close();
      backend.close();
      resolveDone();
    },
    backend,
  };
}
