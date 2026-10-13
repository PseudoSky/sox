/**
 * connection-identity.loopback.spec.ts — 8468f7b1 Feature A wiring proofs.
 *
 * QUARANTINED lane (decision D3): real UDS in a mkdtemp dir, NO child process,
 * NO third-party network. Everything with logic lives in the pure
 * connection-tracker.spec.ts; this file only proves serveBackend wires the
 * tracker correctly on BOTH bind paths (own-bind and inherited-fd).
 */
import { describe, it, expect, afterEach, expectTypeOf } from 'vitest';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  serveBackend,
  type BackendHandle,
  type BackendHandler,
  type ClientDisconnectReason,
  type ConnectionContext,
} from './backend.js';
import { dialBackend } from './dial.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-conn-id-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

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

function rawConnect(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(socketPath);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
    cleanups.push(() => { s.destroy(); });
  });
}

type Mode = 'own-bind' | 'inherited-fd';

interface Rig {
  handle: BackendHandle;
  log: string[];
  seenCtx: ConnectionContext[];
  diags: string[];
}

async function rig(
  mode: Mode,
  extra: {
    onClientConnect?: (id: string) => void;
    onClientDisconnect?: (id: string, r: ClientDisconnectReason) => void;
  } = {},
): Promise<Rig> {
  const dir = tmpDir();
  const log: string[] = [];
  const seenCtx: ConnectionContext[] = [];
  const diags: string[] = [];
  const handler: BackendHandler = (req, ctx) => {
    seenCtx.push(ctx);
    return { jsonrpc: '2.0', id: req.id ?? null, result: { connectionId: ctx.connectionId } };
  };
  const hooks = {
    handler,
    onDiagnostic: (l: string) => diags.push(l),
    onClientCountChange: (n: number) => log.push(`count:${n}`),
    onClientConnect: (id: string) => {
      log.push(`connect:${id}`);
      extra.onClientConnect?.(id);
    },
    onClientDisconnect: (id: string, r: ClientDisconnectReason) => {
      log.push(`disconnect:${id}:${r}`);
      extra.onClientDisconnect?.(id, r);
    },
  };
  const handle =
    mode === 'own-bind'
      ? await serveBackend({ socketPath: path.join(dir, 'own.sock'), ...hooks })
      : await (async () => {
          const { socketPath, fd } = await preBoundSocket(dir);
          return serveBackend({ socketPath, inheritFd: fd, ...hooks });
        })();
  cleanups.push(() => handle.close());
  return { handle, log, seenCtx, diags };
}

describe.each<Mode>(['own-bind', 'inherited-fd'])('connection identity over a real UDS — %s', (mode) => {
  it('8468f7b1 SP1: ctx.connectionId is stable per connection and distinct across connections', async () => {
    const r = await rig(mode);
    const c1 = dialBackend({ socketPath: r.handle.socketPath, onDiagnostic: () => {} });
    const c2 = dialBackend({ socketPath: r.handle.socketPath, onDiagnostic: () => {} });
    cleanups.push(() => c1.close(), () => c2.close());
    const a1 = await c1.send({ jsonrpc: '2.0', id: 1, method: 'x' });
    const a2 = await c1.send({ jsonrpc: '2.0', id: 2, method: 'x' });
    const b1 = await c2.send({ jsonrpc: '2.0', id: 1, method: 'x' });
    const idA = (a1.result as { connectionId: string }).connectionId;
    expect((a2.result as { connectionId: string }).connectionId).toBe(idA);
    expect((b1.result as { connectionId: string }).connectionId).not.toBe(idA);
    expect(idA).toMatch(/^c\d+$/);
    // the same frozen object is handed to every request on one connection
    expect(r.seenCtx[0]).toBe(r.seenCtx[1]);
  });

  it('8468f7b1 SP3: connect after count, disconnect before count, reason "end" for a peer close', async () => {
    const r = await rig(mode);
    const a = await rawConnect(r.handle.socketPath);
    await until(() => r.log.includes('connect:c1'), 'connect hook');
    expect(r.log).toEqual(['count:1', 'connect:c1']);
    a.destroy();
    await until(() => r.log.some((l) => l.startsWith('disconnect:')), 'disconnect hook');
    expect(r.log).toEqual(['count:1', 'connect:c1', 'disconnect:c1:end', 'count:0']);
  });

  it('8468f7b1 SP3: a malformed frame destroys the connection and reports reason "error"', async () => {
    const r = await rig(mode);
    const a = await rawConnect(r.handle.socketPath);
    await until(() => r.log.includes('connect:c1'), 'connect hook');
    // 4-byte length prefix declaring an absurd length, then garbage: decoder error path
    const bad = Buffer.alloc(8);
    bad.writeUInt32BE(0xffffffff, 0);
    a.write(bad);
    await until(() => r.log.some((l) => l.startsWith('disconnect:')), 'disconnect hook');
    expect(r.log).toContain('disconnect:c1:error');
  });

  it('8468f7b1 SP3: handle.close() reports every live connection as closed-by-backend, once each', async () => {
    const r = await rig(mode);
    await rawConnect(r.handle.socketPath);
    await rawConnect(r.handle.socketPath);
    await until(() => r.log.includes('connect:c2'), 'two connects');
    await r.handle.close();
    await until(() => r.log.filter((l) => l.startsWith('disconnect:')).length === 2, 'two disconnects');
    const disconnects = r.log.filter((l) => l.startsWith('disconnect:')).sort();
    expect(disconnects).toEqual(['disconnect:c1:closed-by-backend', 'disconnect:c2:closed-by-backend']);
    // GOLDEN 0.5.0 ordering retained: sync close-time 0 precedes the per-socket hooks
    expect(r.log.indexOf('count:0')).toBeLessThan(r.log.indexOf(disconnects[0]!));
  });

  it('8468f7b1 SP5: throwing connect/disconnect hooks are diagnosed; connection and other hooks continue', async () => {
    const r = await rig(mode, {
      onClientConnect: () => { throw new Error('cb'); },
      onClientDisconnect: () => { throw new Error('db'); },
    });
    const c = dialBackend({ socketPath: r.handle.socketPath, onDiagnostic: () => {} });
    cleanups.push(() => c.close());
    const resp = await c.send({ jsonrpc: '2.0', id: 1, method: 'x' });
    expect(resp.error).toBeUndefined(); // connection survived the throwing connect hook
    c.close();
    await until(() => r.log.some((l) => l.startsWith('disconnect:')), 'disconnect hook');
    await until(() => r.log.includes('count:0'), 'count back to 0');
    expect(r.diags.some((d) => d.includes('onClientConnect threw: cb'))).toBe(true);
    expect(r.diags.some((d) => d.includes('onClientDisconnect threw: db'))).toBe(true);
  });
});

describe('one-argument handlers (0.5.0 shape)', () => {
  it('8468f7b1 SP2: a handler taking only the request still type-checks and serves', async () => {
    const dir = tmpDir();
    const oneArg = (req: { id?: string | number | null }) =>
      ({ jsonrpc: '2.0' as const, id: req.id ?? null, result: 'one-arg' });
    expectTypeOf(oneArg).toExtend<BackendHandler>();
    const handle = await serveBackend({
      socketPath: path.join(dir, 'one.sock'),
      handler: oneArg,
      onDiagnostic: () => {},
    });
    cleanups.push(() => handle.close());
    const c = dialBackend({ socketPath: handle.socketPath, onDiagnostic: () => {} });
    cleanups.push(() => c.close());
    expect((await c.send({ jsonrpc: '2.0', id: 1, method: 'x' })).result).toBe('one-arg');
  });

  it('8468f7b1 SP33: ConnectionContext and ClientDisconnectReason are exported with the final shape', () => {
    expectTypeOf<ConnectionContext>().toEqualTypeOf<{ readonly connectionId: string }>();
    expectTypeOf<ClientDisconnectReason>().toEqualTypeOf<'end' | 'error' | 'closed-by-backend'>();
  });
});
