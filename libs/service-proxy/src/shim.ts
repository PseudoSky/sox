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
import { randomUUID } from 'node:crypto';
import { dialBackend, type BackendConnection } from './dial.js';
import {
  type JsonRpcRequest,
  type JsonRpcResponse,
  errorResponse,
  isJsonRpcRequest,
  isNotification,
} from './jsonrpc.js';
import { computeSchemaHash } from './schema-hash.js';

/**
 * BL-62: per-request workspace attribution context injected by the shim into every
 * `tools/call` internal frame. The backend uses this as the project_path default when
 * the tool's own `arguments.project_path` is absent. The field is INTERNAL to the
 * shim↔backend UDS protocol — it is never sent to the MCP client.
 *
 * Backward compat: the field is optional/additive. An old backend that does not
 * understand it simply ignores the unknown key; a new backend in the absence of this
 * field falls back to the current env/cwd-based attribution.
 */
export interface ClientContext {
  /** The workspace root path for the MCP client that this shim is serving. */
  project_path: string;
}

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
  /**
   * BL-62: the workspace root for this shim's client. When set (injected by
   * `cmdServe` from `SOX_CONFIG_PROJECT_PATH` at shim spawn), every `tools/call`
   * forwarded to the backend carries a `client_context: { project_path }` field in
   * its internal frame. The backend uses this as the default project attribution when
   * the tool call's own `arguments.project_path` is absent, so each request is
   * attributed to the CALLING client's workspace — not to the backend process's env.
   *
   * OPTIONAL and ADDITIVE: absent → no client_context injected. Old backends ignore
   * the unknown field; old shims omitting this field are handled by the backend's
   * absence check (falls back to current env/cwd behavior).
   */
  clientProjectPath?: string;
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
 * BL-62: attach `client_context` to a `tools/call` internal frame. Only applied
 * when `clientProjectPath` is a non-empty string AND the request method is
 * `tools/call` — all other methods are returned as-is. This is the INTERNAL
 * shim↔backend envelope extension; the MCP client never sees this field.
 */
function injectClientContext(req: JsonRpcRequest, clientProjectPath: string | undefined): JsonRpcRequest {
  if (req.method !== 'tools/call') return req;
  if (typeof clientProjectPath !== 'string' || clientProjectPath.length === 0) return req;
  const existingParams = (req.params ?? {}) as Record<string, unknown>;
  return {
    ...req,
    params: {
      ...existingParams,
      client_context: { project_path: clientProjectPath } satisfies ClientContext,
    },
  };
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
    // BL-62: inject client_context into tools/call internal frames so the backend
    // can attribute the request to this shim's client workspace rather than the
    // backend process's env.
    const resp = await backend.send(injectClientContext(req, opts.clientProjectPath));
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

  // §9.5.2/§9.5.5: HTTP transport lifecycle MUST be independent of the stdio-client's
  // presence. When an HTTP listener is active (headless/launchd mode) there may be NO
  // interactive stdio client at all — launchd wires `stdin=/dev/null`, which EOFs
  // immediately. In that mode the stdio pipe ending must NOT tear down the backend
  // connection (that is what caused BL-157: the backend was closed the instant the
  // shim started, so every subsequent HTTP request fast-failed with `-32001 proxy
  // closed`). The HTTP server + its backend connection own their own lifecycle; the
  // process is kept alive by the SIGTERM wait in `cmdServe`. Only in the pure
  // stdio-client case (no httpPort) does the pipe closing tear down the backend — that
  // preserves today's zero-downtime stdio behaviour and the S1.5/S1.6 guarantees.
  const httpActive = opts.httpPort !== undefined;

  input.on('data', onInputData);
  input.on('end', () => {
    diag(
      `[service-proxy shim:${opts.id}] client pipe closed (initialized=${initialized}` +
        `${httpActive ? ', http-active — backend kept alive' : ''})`,
    );
    if (!httpActive) {
      backend.close();
      resolveDone();
    }
    // When httpActive: keep the backend connection and the process running for the
    // HTTP transport. `done` remains pending; the process exits via cmdServe's SIGTERM
    // handler (or an explicit close()).
  });
  input.on('error', (err: Error) => {
    diag(`[service-proxy shim:${opts.id}] client input error: ${err.message}`);
    if (!httpActive) {
      backend.close();
      resolveDone();
    }
  });

  // ── Optional HTTP listener (dual transport: stdio + HTTP/SSE) ─────────────
  let httpServer: http.Server | undefined;
  if (opts.httpPort !== undefined) {
    // SSE sessions: active SSE response per session ID.
    const sseSessions = new Map<string, http.ServerResponse>();

    /**
     * Handle one JSON-RPC request/notification received over HTTP — shared by
     * StreamableHTTP (POST /mcp, and POST to whatever URL a "remote" host config
     * points at — e.g. OpenCode ALWAYS POSTs directly to the configured URL and
     * never does the classic SSE GET-handshake, confirmed by capturing its real
     * traffic: it POSTs to `/sse` itself with `Accept: application/json,
     * text/event-stream` and reads the JSON-RPC response straight from the POST
     * body) and the classic HTTP+SSE `/messages` endpoint.
     *
     * Returns `null` for a notification (e.g. `notifications/initialized`, which
     * every conformant client sends right after `initialize`) — mirroring the
     * stdio path's `backend.notify()` fire-and-forget handling. This guard is
     * REQUIRED: `backend.send()` (dial.ts) only tracks a promise in its
     * `pending` map when `request.id !== undefined` — an id-less request is
     * written to the backend but never resolves the caller's promise, so
     * calling `backend.send()` on a notification hangs the HTTP response
     * forever. Every method branch below MUST go through this notification
     * check first; none may call `backend.send()` directly on `reqRpc`.
     */
    async function handleHttpRpc(reqRpc: JsonRpcRequest): Promise<JsonRpcResponse | null> {
      if (isNotification(reqRpc)) {
        backend.notify(reqRpc);
        return null;
      }
      try {
        if (reqRpc.method === 'initialize') {
          const caps = ((reqRpc.params ?? {}) as { capabilities?: Record<string, unknown> }).capabilities ?? {};
          const toolsCap = (caps as { tools?: { listChanged?: boolean } }).tools;
          if (toolsCap?.listChanged === true) clientSupportsListChanged = true;
          initialized = true;
          return await backend.send(reqRpc);
        }
        if (reqRpc.method === 'tools/list') {
          if (cachedToolsList !== null) return { jsonrpc: '2.0', id: reqRpc.id ?? null, result: cachedToolsList };
          const resp = await backend.send(reqRpc);
          if (!resp.error && resp.result !== undefined) {
            cachedToolsList = resp.result;
            servedSchemaHash = computeSchemaHash(resp.result);
          }
          return resp;
        }
        // BL-62: inject client_context for tools/call over HTTP transport.
        return await backend.send(injectClientContext(reqRpc, opts.clientProjectPath));
      } catch (e) {
        return errorResponse(reqRpc.id ?? null, -32603, `proxy error: ${(e as Error).message}`);
      }
    }

    /** Parse the request body as a JSON-RPC frame, or write a JSON-RPC error and return null. */
    function parseJsonRpcBody(body: string, res: http.ServerResponse, badStatus: number): JsonRpcRequest | null {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(badStatus);
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }));
        return null;
      }
      if (!isJsonRpcRequest(parsed)) {
        res.writeHead(badStatus);
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' } }));
        return null;
      }
      return parsed;
    }

    /** StreamableHTTP-style handler: single request in, single JSON (or 202) response out. */
    function handleStreamableHttpPost(req: http.IncomingMessage, res: http.ServerResponse): void {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      let body = '';
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        const reqRpc = parseJsonRpcBody(body, res, 400);
        if (!reqRpc) return;
        void handleHttpRpc(reqRpc).then((resp) => {
          if (resp === null) {
            // Notification: no JSON-RPC response is ever sent for one.
            res.writeHead(202);
            res.end();
            return;
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(resp));
        });
      });
    }

    httpServer = http.createServer((req, res) => {
      // ── SSE endpoint ──────────────────────────────────────────────────
      if (req.method === 'GET' && req.url === '/sse') {
        const sessionId = randomUUID();
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);
        sseSessions.set(sessionId, res);
        diag(`[service-proxy shim:${opts.id}] SSE session ${sessionId.slice(0, 8)} opened`);
        req.on('close', () => {
          diag(`[service-proxy shim:${opts.id}] SSE session ${sessionId.slice(0, 8)} closed`);
          sseSessions.delete(sessionId);
        });
        return;
      }

      // ── SSE messages endpoint (classic HTTP+SSE transport) ─────────────
      const msgMatch = req.method === 'POST' && req.url?.match(/^\/messages\?sessionId=([a-f0-9-]+)$/);
      if (msgMatch) {
        const sessionId = msgMatch[1]!;
        const sseRes = sseSessions.get(sessionId);
        if (!sseRes) {
          res.writeHead(404);
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Session not found' } }));
          return;
        }
        let body = '';
        req.on('data', (chunk: string) => (body += chunk));
        req.on('end', () => {
          const reqRpc = parseJsonRpcBody(body, res, 200);
          if (!reqRpc) return;
          void handleHttpRpc(reqRpc).then((resp) => {
            if (resp === null) {
              // Notification: no JSON-RPC response is ever sent for one.
              res.writeHead(202);
              res.end();
              return;
            }
            // Dual-write the response for broad client compatibility:
            //  - Spec-compliant clients (e.g. the official @modelcontextprotocol/sdk
            //    SSEClientTransport — verified via its client/sse.js `send()`, which
            //    calls `response.body?.cancel()` and reads the result exclusively off
            //    the SSE stream's `onmessage`) get it over the SSE channel, as the
            //    classic HTTP+SSE transport spec requires.
            //  - Simplified/non-compliant remote clients that read the JSON-RPC
            //    response synchronously from the POST body get it there too.
            // Writing both channels satisfies both without regressing either.
            if (sseRes.writable) {
              sseRes.write(`data: ${JSON.stringify(resp)}\n\n`);
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(resp));
          });
        });
        return;
      }

      // ── StreamableHTTP endpoint ─────────────────────────────────────────
      // POST /mcp is the documented StreamableHTTP endpoint. We ALSO accept
      // POST /sse here: real-traffic capture (2026-07-18) proved OpenCode's
      // "type: remote" client does not perform the classic SSE GET-handshake
      // at all — it POSTs JSON-RPC directly to whatever URL the host config
      // gives it (in OpenCode's case, literally the `/sse`-suffixed URL
      // host-registry generates) and reads the response from the POST body,
      // i.e. it always speaks StreamableHTTP regardless of the URL's path.
      // Serving both paths identically satisfies every host config we generate
      // (`/mcp` for the http profile, `/sse` for the sse profile) without
      // requiring every remote client to implement the classic transport.
      if (req.method === 'POST' && (req.url === '/mcp' || req.url === '/sse')) {
        handleStreamableHttpPost(req, res);
        return;
      }

      // Anything else.
      res.writeHead(405);
      res.end();
    });

    httpServer.listen(opts.httpPort, '127.0.0.1', () => {
      diag(`[service-proxy shim:${opts.id}] HTTP listener on 127.0.0.1:${opts.httpPort}/mcp`);
    });
  }

  // ── BL-310: inactivity watchdog (defense-in-depth) ──────────────────────
  // Fallback 30-minute timeout for pure-stdio mode: if stdin never closes
  // (MCP host disconnected without cleanly closing the pipe), force-shutdown.
  // Unref'd so it doesn't prevent process exit when stdin closes normally.
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  if (!httpActive) {
    watchdogTimer = setTimeout(() => {
      diag(`[service-proxy shim:${opts.id}] inactivity watchdog after 30min — forcing close`);
      if (httpServer) httpServer.close();
      backend.close();
      resolveDone();
    }, 30 * 60 * 1000);
    watchdogTimer.unref();
  }

  return {
    done,
    close: () => {
      if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
      if (httpServer) httpServer.close();
      backend.close();
      resolveDone();
    },
    backend,
  };
}
