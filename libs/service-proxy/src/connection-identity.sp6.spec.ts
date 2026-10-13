/**
 * connection-identity.sp6.spec.ts — 8468f7b1 SP6: `E_LIVE_SOCKET` (probe-before-bind) and the
 * 448f9d93 successor-socket behavior are unchanged by connection identity.
 *
 * QUARANTINED lane (decision D3, same as connection-identity.*): real UDS in a mkdtemp dir, no
 * child process, no network. The base specs (backend.spec.ts SA-4, 448f9d93-*) stay unmodified;
 * this file re-drives the same two behaviors with the 0.6.0 connection-identity surface ACTIVE
 * (two-argument handler and onClientConnect/onClientDisconnect hooks installed).
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { serveBackend, type BackendHandle, type BackendHandler } from './backend.js';
import { dialBackend } from './dial.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-sp6-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const whoami = (owner: string): BackendHandler => (req, ctx) => ({
  jsonrpc: '2.0',
  id: req.id ?? null,
  result: { owner, connectionId: ctx.connectionId },
});

describe('8468f7b1 SP6 E_LIVE_SOCKET and 448f9d93 are unchanged by connection identity', () => {
  it('8468f7b1 SP6 a second serveBackend on a live socket rejects E_LIVE_SOCKET and the live server is unaffected', async () => {
    const sock = path.join(tmpDir(), 'live.sock');
    const connects: string[] = [];
    const first: BackendHandle = await serveBackend({
      socketPath: sock,
      handler: whoami('first'),
      onClientConnect: (id) => connects.push(id),
      onDiagnostic: () => undefined,
    });
    cleanups.push(() => first.close());

    const before = dialBackend({ socketPath: sock, onDiagnostic: () => undefined });
    cleanups.push(() => before.close());
    const r1 = (await before.send({ jsonrpc: '2.0', id: 1, method: 'ping' })) as {
      result: { owner: string; connectionId: string };
    };
    expect(r1.result.owner).toBe('first');

    const err = await serveBackend({
      socketPath: sock,
      handler: whoami('second'),
      onClientConnect: () => undefined,
      onDiagnostic: () => undefined,
    }).then(
      () => null,
      (e: unknown) => e as Error & { code?: string },
    );
    expect(err, 'second bind must be refused').not.toBeNull();
    expect(err?.code).toBe('E_LIVE_SOCKET');
    expect(err?.message).toMatch(/E_LIVE_SOCKET/);

    // The refused bind did not unlink or replace the live socket.
    expect(fs.existsSync(sock)).toBe(true);
    // The pre-existing connection keeps its identity and keeps being served.
    const r2 = (await before.send({ jsonrpc: '2.0', id: 2, method: 'ping' })) as typeof r1;
    expect(r2.result).toEqual(r1.result);
    // A fresh client still reaches the FIRST server and gets a new, distinct connection id.
    const after = dialBackend({ socketPath: sock, onDiagnostic: () => undefined });
    cleanups.push(() => after.close());
    const r3 = (await after.send({ jsonrpc: '2.0', id: 3, method: 'ping' })) as typeof r1;
    expect(r3.result.owner).toBe('first');
    expect(r3.result.connectionId).not.toBe(r1.result.connectionId);
    expect(new Set(connects).size).toBe(connects.length);
  });

  it('8468f7b1 SP6 a retiring listener with identity hooks installed does not unlink a successor socket (448f9d93)', async () => {
    const sock = path.join(tmpDir(), 'host.sock');
    const disconnects: Array<[string, string]> = [];
    const a = await serveBackend({
      socketPath: sock,
      handler: whoami('A'),
      onClientDisconnect: (id, reason) => disconnects.push([id, reason]),
      onDiagnostic: () => undefined,
    });

    // A live client holds A's close callback open until its socket closes.
    const client = net.createConnection(sock);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('error', reject);
    });
    client.on('error', () => undefined);

    let aClosed = false;
    const aClosing = a.close().then(() => {
      aClosed = true;
    });
    // Bind the successor inside the window, before A's close callback runs.
    const bPromise = serveBackend({ socketPath: sock, handler: whoami('B'), onDiagnostic: () => undefined });
    const bFileBeforeAClosed = fs.existsSync(sock) && !aClosed;
    const b = await bPromise;
    cleanups.push(() => b.close());
    const bBoundBeforeAClosed = !aClosed;
    expect(bFileBeforeAClosed || bBoundBeforeAClosed, 'B must bind before A.close() resolves').toBe(true);

    await aClosing;
    client.destroy();

    expect(fs.existsSync(sock), 'successor socket was unlinked by the retiring listener').toBe(true);
    const conn = dialBackend({ socketPath: sock, onDiagnostic: () => undefined });
    cleanups.push(() => conn.close());
    const resp = (await conn.send({ jsonrpc: '2.0', id: 1, method: 'ping' })) as {
      result: { owner: string };
    };
    expect(resp.result.owner).toBe('B');
  });
});
