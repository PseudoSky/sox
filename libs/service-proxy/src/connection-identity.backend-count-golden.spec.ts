/**
 * connection-identity.backend-count-golden.spec.ts — 8468f7b1 SP4 (QUARANTINED real-UDS lane, GOLDEN, recorded from the
 * UNMODIFIED 0.5.0 backend.ts BEFORE connection identity was added).
 *
 * Pins the exact `onClientCountChange` sequence `serveBackend` emits, on BOTH the
 * own-bind and the inherited-fd paths, including:
 *   - the synchronous close-time `0` (own-bind: unguarded; inherited-fd: guarded),
 *   - the extra `0` each destroyed socket's async `close` handler emits after
 *     `handle.close()` already cleared the set,
 *   - the own-bind close rejecting when the hook throws (unguarded call).
 * Real UDS in a mkdtemp dir, no spawn, no third-party network (quarantined wiring
 * proof). Lane: the `connection-identity.*.spec.ts` family (loopback, kill9, this one) are the
 * real-socket specs; the shared prefix is the lane selector (`vitest run connection-identity`).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { serveBackend, type BackendHandle } from './backend.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-count-golden-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Same pre-bound-socket technique as backend.spec.ts (dup fd, rename aside). */
async function preBoundSocket(dir: string): Promise<{ socketPath: string; fd: number }> {
  const socketPath = path.join(dir, 'inherit.sock');
  const tempPath = `${socketPath}.tmp`;
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(socketPath, resolve);
  });
  const origFd = (server as unknown as { _handle: { fd: number } })._handle.fd;
  const devFd = process.platform === 'darwin' ? `/dev/fd/${origFd}` : `/proc/self/fd/${origFd}`;
  const fd = fs.openSync(devFd, fs.constants.O_RDWR);
  fs.renameSync(socketPath, tempPath);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.renameSync(tempPath, socketPath);
  return { socketPath, fd };
}

async function until(pred: () => boolean, label: string, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Let destroyed sockets' async `close` events run (they land after close() resolves). */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

function connect(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(socketPath);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
    cleanups.push(() => { s.destroy(); });
  });
}

type Mode = 'own-bind' | 'inherited-fd';

async function start(
  mode: Mode,
  onClientCountChange: (n: number) => void,
): Promise<BackendHandle> {
  const dir = tmpDir();
  const handler = (req: { id?: unknown }) => ({ jsonrpc: '2.0' as const, id: (req.id ?? null) as never, result: {} });
  if (mode === 'own-bind') {
    return serveBackend({ socketPath: path.join(dir, 'own.sock'), handler, onDiagnostic: () => {}, onClientCountChange });
  }
  const { socketPath, fd } = await preBoundSocket(dir);
  return serveBackend({ socketPath, inheritFd: fd, handler, onDiagnostic: () => {}, onClientCountChange });
}

describe.each<Mode>(['own-bind', 'inherited-fd'])('onClientCountChange golden — %s (8468f7b1 SP4)', (mode) => {
  it('connect, connect, one disconnect, close with one live => [1,2,1,0,0]', async () => {
    const seen: number[] = [];
    const h = await start(mode, (n) => seen.push(n));
    const a = await connect(h.socketPath);
    await until(() => seen.length >= 1, 'first connect');
    const b = await connect(h.socketPath);
    await until(() => seen.length >= 2, 'second connect');
    a.destroy();
    await until(() => seen.length >= 3, 'first disconnect');
    expect(seen).toEqual([1, 2, 1]);
    await h.close();
    await settle(); // b's async close-handler 0 lands after close() resolves
    expect(seen).toEqual([1, 2, 1, 0, 0]);
    expect(b.destroyed).toBe(true);
  });

  it('close with N live sockets => close-time 0 then one trailing 0 per destroyed socket', async () => {
    const seen: number[] = [];
    const h = await start(mode, (n) => seen.push(n));
    await connect(h.socketPath);
    await connect(h.socketPath);
    await connect(h.socketPath);
    await until(() => seen.length >= 3, 'three connects');
    await h.close();
    await settle();
    expect(seen).toEqual([1, 2, 3, 0, 0, 0, 0]);
  });

  it('close with no live sockets => single close-time 0', async () => {
    const seen: number[] = [];
    const h = await start(mode, (n) => seen.push(n));
    await h.close();
    await settle();
    expect(seen).toEqual([0]);
  });
});

describe('onClientCountChange throwing hook on close (8468f7b1 SP4, SP5)', () => {
  it('own-bind: the close-time call is UNGUARDED so close() rejects with the hook error', async () => {
    const h = await start('own-bind', () => { throw new Error('boom-own'); });
    // connect-time notify is guarded (diag), so connecting is fine
    await expect(h.close()).rejects.toThrow('boom-own');
  });

  it('inherited-fd: the close-time call is GUARDED so close() resolves', async () => {
    const h = await start('inherited-fd', () => { throw new Error('boom-fd'); });
    await expect(h.close()).resolves.toBeUndefined();
  });
});
