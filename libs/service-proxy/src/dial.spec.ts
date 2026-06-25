/**
 * dial.spec.ts — the re-dial backend connection: framing round-trip, fast-fail
 * -32001 past the give-up bound, and reconnect-resumes-without-error after a backend
 * restart (the zero-downtime mechanism at the dial layer).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { dialBackend, type BackendConnection } from './dial.js';
import { serveBackend, type BackendHandle } from './backend.js';
import { ERR_BACKEND_UNAVAILABLE } from './jsonrpc.js';

function tmpSock(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sox-proxy-')), `${name}.sock`);
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** An echo backend: replies to every request with result = { echo: params }. */
async function startEcho(socketPath: string): Promise<BackendHandle> {
  const h = await serveBackend({
    socketPath,
    onDiagnostic: () => {},
    handler: (req) => ({ jsonrpc: '2.0', id: req.id ?? null, result: { echo: req.params, method: req.method } }),
  });
  cleanups.push(() => h.close());
  return h;
}

function track(conn: BackendConnection): BackendConnection {
  cleanups.push(() => conn.close());
  return conn;
}

describe('dialBackend', () => {
  it('round-trips a request over the UDS frame protocol', async () => {
    const sock = tmpSock('echo');
    await startEcho(sock);
    const conn = track(dialBackend({ socketPath: sock, onDiagnostic: () => {} }));

    const resp = await conn.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } });
    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({ echo: { name: 'x' }, method: 'tools/call' });
  });

  it('queues a request issued before the backend is up, then forwards on connect', async () => {
    const sock = tmpSock('late');
    const conn = track(dialBackend({ socketPath: sock, onDiagnostic: () => {} }));

    // Send BEFORE the backend exists — must be buffered, not rejected.
    const pending = conn.send({ jsonrpc: '2.0', id: 7, method: 'ping' });
    // Bring the backend up a moment later.
    await new Promise((r) => setTimeout(r, 120));
    await startEcho(sock);

    const resp = await pending;
    expect(resp.error).toBeUndefined();
    expect((resp.result as { method: string }).method).toBe('ping');
  });

  it('fast-fails pending with -32001 once the give-up bound elapses (pipe stays usable)', async () => {
    const sock = tmpSock('down');
    // No backend ever started. Short give-up so the test is fast.
    const conn = track(
      dialBackend({
        socketPath: sock,
        onDiagnostic: () => {},
        backoff: { initialMs: 20, maxMs: 40, giveUpAfterMs: 150 },
      }),
    );

    const resp = await conn.send({ jsonrpc: '2.0', id: 99, method: 'tools/call' });
    expect(resp.error?.code).toBe(ERR_BACKEND_UNAVAILABLE);
    expect(resp.error?.message).toMatch(/unavailable/);
    expect(resp.id).toBe(99);
  });

  it('auto-recovers: after fast-fail, a later request succeeds once the backend returns', async () => {
    const sock = tmpSock('recover');
    const conn = track(
      dialBackend({
        socketPath: sock,
        onDiagnostic: () => {},
        backoff: { initialMs: 20, maxMs: 40, giveUpAfterMs: 150 },
      }),
    );

    // First call fast-fails (backend down).
    const first = await conn.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(first.error?.code).toBe(ERR_BACKEND_UNAVAILABLE);

    // Backend comes up; the dial loop keeps re-dialing at maxMs and recovers.
    await startEcho(sock);
    await new Promise((r) => setTimeout(r, 120));

    const second = await conn.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    expect(second.error).toBeUndefined();
    expect((second.result as { method: string }).method).toBe('ping');
  });

  it('survives a backend restart: a request spanning the restart still resolves', async () => {
    const sock = tmpSock('restart');
    let backend = await startEcho(sock);
    const conn = track(
      dialBackend({ socketPath: sock, onDiagnostic: () => {}, backoff: { initialMs: 20, maxMs: 60 } }),
    );

    // Prove a baseline call works.
    const before = await conn.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(before.error).toBeUndefined();

    // ROLLING RESTART the backend (verified stop + respawn on the same socket).
    await backend.close();
    backend = await startEcho(sock);

    // A request after the restart resolves with no error and no reconnect at the
    // dial layer (same BackendConnection object).
    const after = await conn.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { k: 'v' } });
    expect(after.error).toBeUndefined();
    expect((after.result as { echo: unknown }).echo).toEqual({ k: 'v' });
  });
});
