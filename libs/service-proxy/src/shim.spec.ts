/**
 * shim.spec.ts — the front-shim end-to-end (§9.5).
 *
 * The headline gate: a client connected through the shim issues a tools/call,
 * the backend is rolling-restarted, and the SAME client call path keeps working
 * with the stdio pipe NEVER closing (zero-downtime). Plus: tools/list served from
 * cache, no-stdout-diagnostics invariant, and the schema-hash list_changed nudge.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import { runFrontShim, type FrontShimHandle } from './shim.js';
import { serveBackend, type BackendHandle, type BackendHandler } from './backend.js';

function tmpSock(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sox-proxy-')), `${name}.sock`);
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const TOOLS = {
  tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { v: { type: 'string' } } } }],
};

/**
 * A backend that serves a fixed tools/list and handles tools/call by returning a
 * payload tagged with `version` so a test can prove WHICH backend answered (proving
 * the upgrade took effect behind the shim).
 */
async function startBackend(socketPath: string, version: string, extraTools?: unknown[]): Promise<BackendHandle> {
  const handler: BackendHandler = (req) => {
    if (req.method === 'tools/list') {
      const tools = extraTools ? [...TOOLS.tools, ...extraTools] : TOOLS.tools;
      return { jsonrpc: '2.0', id: req.id ?? null, result: { tools } };
    }
    if (req.method === 'initialize') {
      return { jsonrpc: '2.0', id: req.id ?? null, result: { serverInfo: { name: 'test', version }, capabilities: {} } };
    }
    if (req.method === 'tools/call') {
      return { jsonrpc: '2.0', id: req.id ?? null, result: { version, params: req.params } };
    }
    return { jsonrpc: '2.0', id: req.id ?? null, result: null };
  };
  const h = await serveBackend({ socketPath, handler, onDiagnostic: () => {} });
  cleanups.push(() => h.close());
  return h;
}

/** A test client driving the shim over in-memory streams; collects line responses. */
function makeClient(opts: Parameters<typeof runFrontShim>[0]): {
  shim: FrontShimHandle;
  toClient: PassThrough;
  fromClient: PassThrough;
  stderr: string[];
  send(req: unknown): void;
  next(predicate?: (r: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
} {
  const fromClient = new PassThrough(); // client → shim (input)
  const toClient = new PassThrough(); // shim → client (output)
  const stderr: string[] = [];
  const responses: Record<string, unknown>[] = [];
  const waiters: Array<{ predicate?: (r: Record<string, unknown>) => boolean; resolve: (r: Record<string, unknown>) => void }> = [];

  let buf = '';
  toClient.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const obj = JSON.parse(line) as Record<string, unknown>;
      responses.push(obj);
      const idx = waiters.findIndex((w) => !w.predicate || w.predicate(obj));
      if (idx !== -1) {
        const [w] = waiters.splice(idx, 1);
        w?.resolve(obj);
      }
    }
  });

  const shim = runFrontShim({
    ...opts,
    input: fromClient,
    output: toClient,
    onDiagnostic: (l) => stderr.push(l),
  });
  cleanups.push(() => shim.close());

  return {
    shim,
    toClient,
    fromClient,
    stderr,
    send(req: unknown) {
      fromClient.write(JSON.stringify(req) + '\n');
    },
    next(predicate?) {
      const existing = responses.find((r) => !predicate || predicate(r));
      if (existing) {
        responses.splice(responses.indexOf(existing), 1);
        return Promise.resolve(existing);
      }
      return new Promise((resolve) =>
        waiters.push(predicate ? { predicate, resolve } : { resolve }),
      );
    },
  };
}

describe('runFrontShim', () => {
  it('serves tools/list (cached) and proxies tools/call to the backend', async () => {
    const sock = tmpSock('basic');
    await startBackend(sock, 'v1');
    const c = makeClient({ id: 'test', socketPath: sock });

    c.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const list = await c.next((r) => r['id'] === 1);
    expect((list['result'] as { tools: unknown[] }).tools).toHaveLength(1);

    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { v: 'hi' } } });
    const call = await c.next((r) => r['id'] === 2);
    expect((call['result'] as { version: string }).version).toBe('v1');
  });

  it('ZERO-DOWNTIME: a tools/call succeeds across a backend rolling-restart, pipe never closes', async () => {
    const sock = tmpSock('zdt');
    let backend = await startBackend(sock, 'v1');
    const c = makeClient({ id: 'mem', socketPath: sock, backoff: { initialMs: 20, maxMs: 60 } });

    // The client connects + calls once against v1.
    c.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { x: 1 } });
    const r1 = await c.next((r) => r['id'] === 1);
    expect((r1['result'] as { version: string }).version).toBe('v1');

    // Track whether the client's stdio pipe ever closes during the upgrade.
    let pipeClosed = false;
    c.shim.done.then(() => { pipeClosed = true; });

    // ── ROLLING RESTART the backend to "v2" (verified-stop + respawn). ──
    await backend.close();
    backend = await startBackend(sock, 'v2');

    // The SAME client (no reconnect — fromClient stream never ended) issues another
    // tools/call. It must succeed and be answered by the NEW backend (v2).
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { x: 2 } });
    const r2 = await c.next((r) => r['id'] === 2);
    expect(r2['error']).toBeUndefined();
    expect((r2['result'] as { version: string }).version).toBe('v2');

    // The stdio pipe to the client was NEVER closed across the restart.
    expect(pipeClosed).toBe(false);
    expect(c.fromClient.writableEnded).toBe(false);
  });

  it('[inv:no-stdout-diagnostics]: nothing but framed JSON-RPC is written to the client stream', async () => {
    const sock = tmpSock('nostdout');
    await startBackend(sock, 'v1');
    const c = makeClient({ id: 'q', socketPath: sock });

    // Capture every byte written to the client output stream.
    const rawOut: string[] = [];
    c.toClient.on('data', (chunk: Buffer) => rawOut.push(chunk.toString()));

    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } });
    await c.next((r) => r['id'] === 1);
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await c.next((r) => r['id'] === 2);
    c.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {} });
    await c.next((r) => r['id'] === 3);

    // Every newline-delimited line on stdout must parse as JSON (no stray diagnostics).
    const lines = rawOut.join('').split('\n').filter((l) => l.trim() !== '');
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      const obj = JSON.parse(line) as Record<string, unknown>;
      expect(obj['jsonrpc']).toBe('2.0');
    }
    // All diagnostics went to the stderr sink instead.
    expect(c.stderr.length).toBeGreaterThan(0);
  });

  it('serves the CACHED schema and emits tools/list_changed when the backend schema-hash changes', async () => {
    const sock = tmpSock('schema');
    let backend = await startBackend(sock, 'v1');
    // Client declares it honors tools/list_changed.
    const c = makeClient({ id: 's', socketPath: sock, backoff: { initialMs: 20, maxMs: 60 } });

    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: { tools: { listChanged: true } } } });
    await c.next((r) => r['id'] === 1);
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const list1 = await c.next((r) => r['id'] === 2);
    expect((list1['result'] as { tools: unknown[] }).tools).toHaveLength(1);

    // Restart the backend with an ADDED tool (interface change → new schema-hash).
    await backend.close();
    backend = await startBackend(sock, 'v2', [
      { name: 'extra', description: 'new', inputSchema: { type: 'object' } },
    ]);

    // On reconnect the shim re-reads the schema, detects the change, and nudges.
    const nudge = await c.next((r) => r['method'] === 'notifications/tools/list_changed');
    expect(nudge['method']).toBe('notifications/tools/list_changed');

    // Until the client refreshes, the shim still serves the OLD cached schema
    // (1 tool) so in-flight calls don't break.
    c.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const list2 = await c.next((r) => r['id'] === 3);
    expect((list2['result'] as { tools: unknown[] }).tools).toHaveLength(1);
  });

  it('calls the ensure hook on START (before any backend exists)', async () => {
    const sock = tmpSock('ensure-start');
    let ensured = 0;
    // The backend does NOT exist yet; the ensure hook brings it up.
    const c = makeClient({
      id: 'e',
      socketPath: sock,
      backoff: { initialMs: 20, maxMs: 60 },
      ensure: async () => {
        ensured++;
        // Bring the backend up on first ensure so the subsequent dial connects.
        if (ensured === 1) await startBackend(sock, 'v1');
      },
    });

    // Issue a call: the dial layer retries with backoff until the ensure-spawned
    // backend binds, then answers — proving ensure ran at start.
    c.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { v: 'x' } });
    const r1 = await c.next((r) => r['id'] === 1);
    expect((r1['result'] as { version: string }).version).toBe('v1');
    expect(ensured).toBeGreaterThanOrEqual(1);
  });

  it('RE-ensures on a dropped backend connection (crash recovery)', async () => {
    const sock = tmpSock('ensure-redrop');
    let backend = await startBackend(sock, 'v1');
    let ensured = 0;
    const c = makeClient({
      id: 'r',
      socketPath: sock,
      backoff: { initialMs: 20, maxMs: 60 },
      ensure: async () => {
        ensured++;
        // The first ensure (start) is a no-op (backend already live). On the
        // disconnect ensure, respawn the backend so the shim re-dials successfully.
        if (ensured >= 2) backend = await startBackend(sock, 'v2');
      },
    });

    // Baseline against v1.
    c.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} });
    const r1 = await c.next((r) => r['id'] === 1);
    expect((r1['result'] as { version: string }).version).toBe('v1');

    // Drop the backend (simulate a crash, not a clean rolling-restart).
    await backend.close();

    // The shim's onDisconnect → ensure re-spawns v2; the SAME client call succeeds.
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} });
    const r2 = await c.next((r) => r['id'] === 2);
    expect(r2['error']).toBeUndefined();
    expect((r2['result'] as { version: string }).version).toBe('v2');
    expect(ensured).toBeGreaterThanOrEqual(2);
  });

  // ── BL-157: HTTP transport must be independent of the stdio-client lifecycle ──
  //
  // Under launchd the shim is spawned with `stdin=/dev/null`, which EOFs immediately.
  // Previously the shim's `input.on('end')` handler unconditionally closed the backend
  // connection, so every HTTP request afterward fast-failed with
  // `{"error":{"code":-32001,"message":"proxy closed"}}`. The fix decouples the HTTP
  // listener from stdio-client presence: when httpPort is set, an EOF on stdin must NOT
  // tear down the backend. These tests pin that behaviour.

  /** Pick a free TCP port (ask the OS for one, then release it). */
  function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        srv.close(() => resolve(port));
      });
      srv.on('error', reject);
    });
  }

  /** POST a JSON-RPC request to the shim's /mcp endpoint; resolve the parsed body. */
  function postMcp(port: number, body: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        },
        (res) => {
          let data = '';
          res.on('data', (c: Buffer) => (data += c.toString()));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data) as Record<string, unknown>);
            } catch (e) {
              reject(new Error(`bad JSON from shim: ${data} (${(e as Error).message})`));
            }
          });
        },
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  it('BL-157: HTTP initialize + tools/call succeed AFTER stdin EOFs (headless/launchd mode)', async () => {
    const sock = tmpSock('headless-http');
    await startBackend(sock, 'v1');
    const port = await freePort();

    // A stdin stream that EOFs immediately — exactly what launchd's /dev/null does.
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdout.on('data', () => {}); // drain

    const handle = runFrontShim({
      id: 'headless',
      socketPath: sock,
      httpPort: port,
      input: stdin,
      output: stdout,
      backoff: { initialMs: 20, maxMs: 60 },
      onDiagnostic: () => {},
    });
    cleanups.push(() => handle.close());

    // Simulate launchd's stdin=/dev/null: end the input immediately.
    stdin.end();

    // The stdio pipe closing MUST NOT resolve `done` (process stays alive for HTTP).
    let doneResolved = false;
    handle.done.then(() => { doneResolved = true; });

    // Wait for the HTTP listener to bind + the backend to connect.
    await new Promise((r) => setTimeout(r, 150));

    // Over HTTP: initialize then tools/call must succeed end-to-end — NO "proxy closed".
    const initResp = await postMcp(port, {
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} },
    });
    expect(initResp['error']).toBeUndefined();
    expect((initResp['result'] as { serverInfo: { version: string } }).serverInfo.version).toBe('v1');

    const callResp = await postMcp(port, {
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { v: 'hi' } },
    });
    expect(callResp['error']).toBeUndefined();
    expect((callResp['result'] as { version: string }).version).toBe('v1');

    // The backend connection stayed alive; `done` never resolved on the stdin EOF.
    expect(doneResolved).toBe(false);
    expect(handle.backend.isConnected()).toBe(true);
  });

  /**
   * Opens the classic HTTP+SSE handshake (GET /sse), parses the `endpoint` event,
   * and returns both the messages URL and a way to read the next SSE `data:` frame —
   * mirroring exactly what the official @modelcontextprotocol/sdk's SSEClientTransport
   * does (verified by reading its client/sse.js source), without pulling that package
   * in as a dependency of this deliberately dependency-free leaf lib.
   */
  function openSse(port: number): Promise<{
    endpointPath: string;
    nextMessage: () => Promise<Record<string, unknown>>;
    close: () => void;
  }> {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/sse', headers: { Accept: 'text/event-stream' } }, (res) => {
        let buf = '';
        const waiters: Array<(v: Record<string, unknown>) => void> = [];
        const pending: Record<string, unknown>[] = [];
        let endpointPath: string | undefined;
        res.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const eventLine = frame.split('\n').find((l) => l.startsWith('event: '));
            const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
            if (!dataLine) continue;
            const data = dataLine.slice('data: '.length);
            if (eventLine?.slice('event: '.length) === 'endpoint') {
              endpointPath = data;
              resolve({
                endpointPath,
                nextMessage: () =>
                  pending.length > 0 ? Promise.resolve(pending.shift()!) : new Promise((r) => waiters.push(r)),
                close: () => req.destroy(),
              });
            } else {
              const parsed = JSON.parse(data) as Record<string, unknown>;
              const w = waiters.shift();
              if (w) w(parsed);
              else pending.push(parsed);
            }
          }
        });
      });
      req.on('error', reject);
    });
  }

  /** POST a JSON-RPC request to an SSE messages endpoint; resolve the parsed POST-body response. */
  function postMessages(port: number, endpointPath: string, body: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: endpointPath,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        },
        (res) => {
          let data = '';
          res.on('data', (c: Buffer) => (data += c.toString()));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data) as Record<string, unknown>);
            } catch (e) {
              reject(new Error(`bad JSON from shim: ${data} (${(e as Error).message})`));
            }
          });
        },
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  it('SSE transport: a client that reads ONLY the SSE stream (spec-compliant, e.g. official SDK) gets the response', async () => {
    const sock = tmpSock('sse-stream-only');
    await startBackend(sock, 'v1');
    const port = await freePort();

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdout.on('data', () => {});
    const handle = runFrontShim({ id: 'sse-test', socketPath: sock, httpPort: port, input: stdin, output: stdout, onDiagnostic: () => {} });
    cleanups.push(() => handle.close());
    await new Promise((r) => setTimeout(r, 150));

    const sse = await openSse(port);
    cleanups.push(sse.close);

    // Fire the POST but deliberately IGNORE its body — a spec-compliant client
    // (per the official SDK's `response.body?.cancel()`) never reads it.
    void postMessages(port, sse.endpointPath, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } });
    const initMsg = await sse.nextMessage();
    expect(initMsg['error']).toBeUndefined();
    expect((initMsg['result'] as { serverInfo: { version: string } }).serverInfo.version).toBe('v1');

    void postMessages(port, sse.endpointPath, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { v: 'hi' } } });
    const callMsg = await sse.nextMessage();
    expect(callMsg['error']).toBeUndefined();
    expect((callMsg['result'] as { version: string }).version).toBe('v1');
  });

  it('SSE transport: a client that reads ONLY the POST body (non-spec, e.g. OpenCode remote) ALSO gets the response', async () => {
    const sock = tmpSock('sse-postbody-only');
    await startBackend(sock, 'v1');
    const port = await freePort();

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdout.on('data', () => {});
    const handle = runFrontShim({ id: 'sse-test-2', socketPath: sock, httpPort: port, input: stdin, output: stdout, onDiagnostic: () => {} });
    cleanups.push(() => handle.close());
    await new Promise((r) => setTimeout(r, 150));

    const sse = await openSse(port);
    cleanups.push(sse.close);

    // This time we read the POST response directly and ignore the SSE stream.
    const initResp = await postMessages(port, sse.endpointPath, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } });
    expect(initResp['error']).toBeUndefined();
    expect((initResp['result'] as { serverInfo: { version: string } }).serverInfo.version).toBe('v1');

    const callResp = await postMessages(port, sse.endpointPath, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { v: 'hi' } } });
    expect(callResp['error']).toBeUndefined();
    expect((callResp['result'] as { version: string }).version).toBe('v1');
  });

  /** POST to an arbitrary path; resolve with status code + parsed JSON body (empty object if no body). */
  function postJson(port: number, urlPath: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: urlPath,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(payload) },
        },
        (res) => {
          let data = '';
          res.on('data', (c: Buffer) => (data += c.toString()));
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, json: data ? (JSON.parse(data) as Record<string, unknown>) : {} });
          });
        },
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  it('StreamableHTTP: POST /sse (no GET handshake) is served identically to POST /mcp — matches OpenCode real-traffic capture (2026-07-18)', async () => {
    // OpenCode's "type: remote" client never performs a GET /sse handshake — it
    // POSTs JSON-RPC directly to whatever URL is configured (confirmed by
    // capturing its real requests: method=POST url=/sse, no prior GET). Before
    // this fix, POST /sse fell through to the shim's catch-all 405 and every
    // OpenCode request silently failed.
    const sock = tmpSock('streamable-sse-path');
    await startBackend(sock, 'v1');
    const port = await freePort();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdout.on('data', () => {});
    const handle = runFrontShim({ id: 'streamable-sse', socketPath: sock, httpPort: port, input: stdin, output: stdout, onDiagnostic: () => {} });
    cleanups.push(() => handle.close());
    await new Promise((r) => setTimeout(r, 150));

    const { status, json } = await postJson(port, '/sse', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } });
    expect(status).toBe(200);
    expect(json['error']).toBeUndefined();
    expect((json['result'] as { serverInfo: { version: string } }).serverInfo.version).toBe('v1');
  });

  it('notifications (id-less, e.g. notifications/initialized) complete the HTTP response instead of hanging — /mcp', async () => {
    // Regression for a real hang: dial.ts's `send()` only tracks a promise in its
    // `pending` map when `request.id !== undefined` (see writeToBackend). Before
    // this fix, every HTTP handler called `backend.send()` unconditionally for any
    // method it didn't special-case — including notifications — so the returned
    // promise NEVER resolved and the client's POST request hung forever.
    const sock = tmpSock('notif-no-hang-mcp');
    await startBackend(sock, 'v1');
    const port = await freePort();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdout.on('data', () => {});
    const handle = runFrontShim({ id: 'notif-mcp', socketPath: sock, httpPort: port, input: stdin, output: stdout, onDiagnostic: () => {} });
    cleanups.push(() => handle.close());
    await new Promise((r) => setTimeout(r, 150));

    const result = await Promise.race([
      postJson(port, '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1500)),
    ]);
    expect(result).not.toBe('timeout');
    expect((result as { status: number }).status).toBe(202);
  });

  it('notifications (id-less) complete the HTTP response instead of hanging — /sse (StreamableHTTP path) and /messages (classic SSE)', async () => {
    const sock = tmpSock('notif-no-hang-sse');
    await startBackend(sock, 'v1');
    const port = await freePort();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdout.on('data', () => {});
    const handle = runFrontShim({ id: 'notif-sse', socketPath: sock, httpPort: port, input: stdin, output: stdout, onDiagnostic: () => {} });
    cleanups.push(() => handle.close());
    await new Promise((r) => setTimeout(r, 150));

    const sseResult = await Promise.race([
      postJson(port, '/sse', { jsonrpc: '2.0', method: 'notifications/initialized' }),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1500)),
    ]);
    expect(sseResult).not.toBe('timeout');
    expect((sseResult as { status: number }).status).toBe(202);

    const sse = await openSse(port);
    cleanups.push(sse.close);
    const messagesResult = await Promise.race([
      postJson(port, sse.endpointPath, { jsonrpc: '2.0', method: 'notifications/initialized' }),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1500)),
    ]);
    expect(messagesResult).not.toBe('timeout');
    expect((messagesResult as { status: number }).status).toBe(202);
  });

  it('BL-157: pure stdio mode STILL closes the backend on pipe end (no regression)', async () => {
    const sock = tmpSock('stdio-close');
    await startBackend(sock, 'v1');

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdout.on('data', () => {});

    const handle = runFrontShim({
      id: 'stdio-only',
      socketPath: sock,
      input: stdin,
      output: stdout,
      backoff: { initialMs: 20, maxMs: 60 },
      onDiagnostic: () => {},
    });
    cleanups.push(() => handle.close());

    // Let the backend connect.
    await new Promise((r) => setTimeout(r, 100));
    expect(handle.backend.isConnected()).toBe(true);

    // In pure-stdio mode, ending the pipe MUST tear down the backend + resolve done.
    stdin.end();
    await handle.done; // resolves only if the pipe-end handler ran
    expect(handle.backend.isConnected()).toBe(false);
  });

  // ── BL-62: per-request project_path attribution via client_context ────────────
  //
  // The shim injects `client_context: { project_path }` into every `tools/call`
  // internal frame when `clientProjectPath` is configured. This is the INTERNAL
  // shim↔backend envelope extension — it must NOT appear in responses to the client,
  // and must NOT be injected for other methods (initialize, tools/list, etc.).

  /**
   * A backend that captures the raw `params` it receives for each `tools/call`,
   * so tests can assert the `client_context` field was (or wasn't) injected.
   */
  async function startCapturingBackend(
    socketPath: string,
  ): Promise<{ handle: BackendHandle; captured: Array<unknown> }> {
    const captured: Array<unknown> = [];
    const handler: BackendHandler = (req) => {
      if (req.method === 'tools/call') captured.push(req.params);
      if (req.method === 'tools/list') return { jsonrpc: '2.0', id: req.id ?? null, result: TOOLS };
      if (req.method === 'initialize') return { jsonrpc: '2.0', id: req.id ?? null, result: { serverInfo: { name: 'cap', version: '1' }, capabilities: {} } };
      return { jsonrpc: '2.0', id: req.id ?? null, result: { ok: true } };
    };
    const handle = await serveBackend({ socketPath, handler, onDiagnostic: () => {} });
    cleanups.push(() => handle.close());
    return { handle, captured };
  }

  it('BL-62: shim attaches client_context to tools/call when clientProjectPath is set', async () => {
    const sock = tmpSock('bl62-inject');
    const { captured } = await startCapturingBackend(sock);
    const c = makeClient({
      id: 'bl62',
      socketPath: sock,
      backoff: { initialMs: 20, maxMs: 60 },
      clientProjectPath: '/workspace/project-a',
    });

    c.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { v: 'hi' } } });
    await c.next((r) => r['id'] === 1);

    expect(captured).toHaveLength(1);
    const params = captured[0] as Record<string, unknown>;
    expect(params['client_context']).toEqual({ project_path: '/workspace/project-a' });
    // The original fields are preserved.
    expect(params['name']).toBe('echo');
    expect((params['arguments'] as { v: string }).v).toBe('hi');
  });

  it('BL-62: shim does NOT attach client_context when clientProjectPath is absent', async () => {
    const sock = tmpSock('bl62-no-inject');
    const { captured } = await startCapturingBackend(sock);
    // No clientProjectPath in options.
    const c = makeClient({ id: 'bl62-nopp', socketPath: sock, backoff: { initialMs: 20, maxMs: 60 } });

    c.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } });
    await c.next((r) => r['id'] === 1);

    expect(captured).toHaveLength(1);
    const params = captured[0] as Record<string, unknown>;
    // No client_context field injected.
    expect(params['client_context']).toBeUndefined();
  });

  it('BL-62: shim does NOT attach client_context when clientProjectPath is empty string', async () => {
    const sock = tmpSock('bl62-empty');
    const { captured } = await startCapturingBackend(sock);
    const c = makeClient({
      id: 'bl62-empty',
      socketPath: sock,
      backoff: { initialMs: 20, maxMs: 60 },
      clientProjectPath: '',
    });

    c.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } });
    await c.next((r) => r['id'] === 1);

    expect(captured).toHaveLength(1);
    expect((captured[0] as Record<string, unknown>)['client_context']).toBeUndefined();
  });

  it('BL-62: shim does NOT inject client_context into tools/list or initialize', async () => {
    const sock = tmpSock('bl62-non-call');
    // Track all raw requests arriving at the backend.
    const allParams: Array<{ method: string; params: unknown }> = [];
    const handler: BackendHandler = (req) => {
      allParams.push({ method: req.method, params: req.params });
      if (req.method === 'tools/list') return { jsonrpc: '2.0', id: req.id ?? null, result: TOOLS };
      if (req.method === 'initialize') return { jsonrpc: '2.0', id: req.id ?? null, result: { serverInfo: { name: 't', version: '1' }, capabilities: {} } };
      return { jsonrpc: '2.0', id: req.id ?? null, result: {} };
    };
    const bHandle = await serveBackend({ socketPath: sock, handler, onDiagnostic: () => {} });
    cleanups.push(() => bHandle.close());

    const c = makeClient({
      id: 'bl62-noncall',
      socketPath: sock,
      backoff: { initialMs: 20, maxMs: 60 },
      clientProjectPath: '/workspace/project-b',
    });

    // initialize
    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } });
    await c.next((r) => r['id'] === 1);

    // tools/list — served from cache after the first backend connect, but force a
    // backend read by clearing the cache path: just check the backend receives no ctx.
    // (The shim might serve from cache; we look at what arrived at the backend instead.)
    // Issue a tools/call to ensure the backend got at least one call with context.
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: {} } });
    await c.next((r) => r['id'] === 2);

    // All non-tools/call methods forwarded to the backend must NOT carry client_context.
    for (const entry of allParams) {
      if (entry.method !== 'tools/call') {
        const p = entry.params as Record<string, unknown> | undefined;
        expect(p?.['client_context']).toBeUndefined();
      }
    }
    // The tools/call one MUST have client_context.
    const callEntry = allParams.find((e) => e.method === 'tools/call');
    expect(callEntry).toBeDefined();
    expect((callEntry!.params as Record<string, unknown>)['client_context']).toEqual({
      project_path: '/workspace/project-b',
    });
  });
});
