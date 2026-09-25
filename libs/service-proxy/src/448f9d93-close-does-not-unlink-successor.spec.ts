/**
 * 448f9d93 — a retiring listener's close callback must never unlink a
 * SUCCESSOR's socket.
 *
 * `server.close()` stops accepting and libuv unlinks the pipe path right away,
 * but the Node close callback only runs once every client connection has
 * closed. A successor (the next embedding host spawned by a consumer's
 * re-ensure) can bind the same path inside that window. Before the fix the
 * callback unlinked by PATH, deleting the successor's freshly bound socket:
 * the successor kept running with no reachable socket and every consumer
 * re-spawned forever.
 *
 * The test drives exactly that interleaving and asserts it actually happened
 * (B bound before A's close resolved) — otherwise a pass would prove nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { serveBackend, type BackendHandle } from './backend.js';
import { dialBackend } from './dial.js';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const echo = async (req: { id?: unknown; method: string }) => ({
  jsonrpc: '2.0' as const,
  id: (req.id ?? null) as string | number | null,
  result: { method: req.method },
});

describe('448f9d93 — close does not unlink a successor socket', () => {
  it('B binds the path while A is still closing; after A closes, B\'s socket exists and accepts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-448f9d93-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const socketPath = path.join(dir, 'host.sock');
    const diagA: string[] = [];

    const a: BackendHandle = await serveBackend({
      socketPath,
      handler: echo,
      onDiagnostic: (l) => diagA.push(l),
    });

    // A connected client holds A's close callback open until its socket closes.
    const client = net.createConnection(socketPath);
    await new Promise<void>((r, j) => {
      client.once('connect', () => r());
      client.once('error', j);
    });
    client.on('error', () => undefined);

    let aClosed = false;
    const aClosing = a.close().then(() => {
      aClosed = true;
    });

    // A has stopped listening; libuv already removed the path. Bind B now,
    // synchronously inside this tick, i.e. BEFORE A's close callback.
    const bPromise = serveBackend({ socketPath, handler: echo, onDiagnostic: () => undefined });
    const bFileBeforeAClosed = fs.existsSync(socketPath) && !aClosed;
    const b = await bPromise;
    cleanups.push(() => b.close());
    const bBoundBeforeAClosed = !aClosed;

    await aClosing;
    client.destroy();

    // The interleaving under test must actually have occurred.
    expect(bFileBeforeAClosed || bBoundBeforeAClosed, 'B must bind before A.close() resolves').toBe(true);

    // B's socket survives A's close callback …
    expect(fs.existsSync(socketPath), `successor socket was unlinked; A diag: ${diagA.join(' | ')}`).toBe(true);

    // … and still accepts a real request.
    const conn = dialBackend({ socketPath, onDiagnostic: () => undefined });
    cleanups.push(() => conn.close());
    const resp = (await conn.send({ jsonrpc: '2.0', id: 1, method: 'ping' })) as { result?: unknown };
    expect(resp.result).toEqual({ method: 'ping' });
  });

  it('a lone listener still removes its own socket on close', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-448f9d93-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const socketPath = path.join(dir, 'host.sock');
    const a = await serveBackend({ socketPath, handler: echo, onDiagnostic: () => undefined });
    expect(fs.existsSync(socketPath)).toBe(true);
    await a.close();
    expect(fs.existsSync(socketPath)).toBe(false);
  });
});
