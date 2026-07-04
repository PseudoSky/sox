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
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
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
});
