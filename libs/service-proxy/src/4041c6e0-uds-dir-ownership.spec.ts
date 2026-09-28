/**
 * 4041c6e0-uds-dir-ownership.spec.ts — the UDS directory trust check (BL-4041c6e0).
 *
 * A Unix socket is only as private as its directory. `backendSocketPath`'s tier 3
 * lives under `/tmp/sox-<uid>`, inside world-writable `/tmp`, where another local
 * user can pre-create the directory (or a symlink) and plant an impostor socket.
 * These specs pin the contract:
 *
 *   - the listener (`serveBackend`) refuses to bind in an unsafe directory with a
 *     structured `E_UDS_DIR_UNSAFE`, and leaves no socket file behind;
 *   - the dialers (`dialBackend`, `probeSocketLive`, `ensureBackend`) refuse to
 *     connect into one, without a single connection and without re-dialing;
 *   - the rule: not a symlink, a directory, owned by us, the fallback root exactly
 *     0700 and any other dir free of group/other write;
 *   - the check never repairs (chmod/chown/delete) and never falls back.
 *
 * Every test works in an `fs.mkdtempSync` scratch directory, or in a fully
 * injected `lstat`/`mkdir`/`getuid` world — the real `/tmp/sox-<uid>` and any
 * live socket are never touched.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { serveBackend, type BackendHandle } from './backend.js';
import { dialBackend, type BackendConnection } from './dial.js';
import { ensureBackend, probeSocketLive } from './ensure-backend.js';
import { ERR_BACKEND_UNAVAILABLE } from './jsonrpc.js';
import { udsFallbackRoot } from './socket-path.js';
import {
  assertPrivateSocketDir,
  ensurePrivateSocketDir,
  type SocketDirDeps,
} from './socket-dir.js';

const UID = (process.getuid as () => number)();

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A fresh private (0700) scratch dir, removed after the test. */
function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-4041-'));
  cleanups.push(() => {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** A scratch dir whose mode is forced (chmod ignores umask). */
function scratchWithMode(mode: number): string {
  const dir = scratch();
  fs.chmodSync(dir, mode);
  return dir;
}

const noop = (): void => {};

function echoHandler() {
  return (req: { id?: string | number | null }) => ({ jsonrpc: '2.0' as const, id: req.id ?? null, result: 'ok' });
}

/** A fake lstat result. */
function stat(opts: { mode: number; uid: number; dir?: boolean; symlink?: boolean }) {
  return {
    mode: opts.mode,
    uid: opts.uid,
    isDirectory: () => opts.dir ?? true,
    isSymbolicLink: () => opts.symlink ?? false,
  };
}

/** A raw UDS listener that counts accepted connections and replies to nothing. */
async function countingServer(socketPath: string): Promise<{ count: () => number }> {
  let n = 0;
  const server = net.createServer((s) => {
    n++;
    s.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { count: () => n };
}

describe('4041c6e0: udsFallbackRoot', () => {
  it('4041c6e0: is /tmp/sox-<uid> for an explicit or the current uid', () => {
    expect(udsFallbackRoot(4242)).toBe('/tmp/sox-4242');
    expect(udsFallbackRoot()).toBe(`/tmp/sox-${String(UID)}`);
  });

  it('4041c6e0: throws E_UDS_UNSUPPORTED_PLATFORM when process.getuid is unavailable', () => {
    const desc = Object.getOwnPropertyDescriptor(process, 'getuid');
    try {
      Object.defineProperty(process, 'getuid', { value: undefined, configurable: true, writable: true });
      expect(() => udsFallbackRoot()).toThrow(expect.objectContaining({ code: 'E_UDS_UNSUPPORTED_PLATFORM' }));
    } finally {
      if (desc) Object.defineProperty(process, 'getuid', desc);
    }
  });
});

describe('4041c6e0: (2) wrong mode is refused', () => {
  it('4041c6e0: serveBackend in a 0777 dir rejects E_UDS_DIR_UNSAFE and leaves no socket file', async () => {
    const dir = scratchWithMode(0o777);
    const sock = path.join(dir, 'b.sock');

    let handle: BackendHandle | undefined;
    const outcome = await serveBackend({ socketPath: sock, handler: echoHandler(), onDiagnostic: noop }).then(
      (h) => {
        handle = h;
        cleanups.push(() => h.close());
        return 'bound' as const;
      },
      (err: unknown) => err,
    );

    expect(handle).toBeUndefined();
    expect(outcome).toMatchObject({
      code: 'E_UDS_DIR_UNSAFE',
      dir,
      expectedUid: UID,
      actualUid: UID,
      isSymlink: false,
    });
    expect((outcome as { mode: number }).mode & 0o777).toBe(0o777);
    expect(fs.existsSync(sock)).toBe(false);
    // Never repaired: the mode is exactly as the attacker left it.
    expect(fs.statSync(dir).mode & 0o777).toBe(0o777);
  });

  it('4041c6e0: a group-writable (0770) non-root dir is refused; a 0755 one is accepted', () => {
    expect(() => assertPrivateSocketDir(scratchWithMode(0o770))).toThrow(
      expect.objectContaining({ code: 'E_UDS_DIR_UNSAFE' }),
    );
    expect(() => assertPrivateSocketDir(scratchWithMode(0o755))).not.toThrow();
  });

  it('4041c6e0: the fallback root is held to exactly 0700 — 0755 is refused there (injected)', () => {
    const uid = 90210;
    const root = udsFallbackRoot(uid);
    const mkdirCalls: Array<[string, fs.MakeDirectoryOptions]> = [];
    const deps: SocketDirDeps = {
      getuid: () => uid,
      lstat: () => stat({ mode: 0o040755, uid }),
      mkdir: (p, o) => {
        mkdirCalls.push([p, o]);
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      },
    };

    expect(() => ensurePrivateSocketDir(root, { create: true, deps })).toThrow(
      expect.objectContaining({ code: 'E_UDS_DIR_UNSAFE', dir: root, mode: 0o040755 }),
    );
    // Created NON-recursively (never touches /tmp itself); EEXIST is not the failure.
    expect(mkdirCalls).toEqual([[root, { mode: 0o700 }]]);

    // The same 0755 on a non-root dir passes the (looser) general rule.
    expect(() =>
      assertPrivateSocketDir('/some/other/dir', { ...deps, lstat: () => stat({ mode: 0o040755, uid }) }),
    ).not.toThrow();
    // And an exactly-0700 root passes.
    expect(() =>
      ensurePrivateSocketDir(root, { create: true, deps: { ...deps, lstat: () => stat({ mode: 0o040700, uid }) } }),
    ).not.toThrow();
  });

  it('4041c6e0: a non-EEXIST mkdir failure on the fallback root propagates (injected)', () => {
    const uid = 90210;
    const deps: SocketDirDeps = {
      getuid: () => uid,
      lstat: () => stat({ mode: 0o040700, uid }),
      mkdir: () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
    };
    expect(() => ensurePrivateSocketDir(udsFallbackRoot(uid), { create: true, deps })).toThrow(
      expect.objectContaining({ code: 'EACCES' }),
    );
  });

  it('4041c6e0: a non-root dir is created recursively with mode 0700', () => {
    const nested = path.join(scratch(), 'a', 'b', 'run');
    ensurePrivateSocketDir(nested, { create: true });
    const st = fs.lstatSync(nested);
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o077).toBe(0);
  });
});

describe('4041c6e0: (3) foreign owner is refused', () => {
  it('4041c6e0: a dir owned by another uid is refused (injected getuid), with a remediation message', () => {
    const dir = scratch(); // really ours, 0700 — only the uid comparison differs
    let caught: unknown;
    try {
      ensurePrivateSocketDir(dir, { create: true, deps: { getuid: () => UID + 1 } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({
      code: 'E_UDS_DIR_UNSAFE',
      dir,
      expectedUid: UID + 1,
      actualUid: UID,
      isSymlink: false,
    });
    expect((caught as Error).message).toMatch(/^E_UDS_DIR_UNSAFE: /);
    expect((caught as Error).message).toMatch(/Inspect the directory and remove it/);
  });

  it('4041c6e0: a foreign-owned fallback root is refused even at exactly 0700 (injected)', () => {
    const uid = 90210;
    expect(() =>
      ensurePrivateSocketDir(udsFallbackRoot(uid), {
        create: true,
        deps: {
          getuid: () => uid,
          lstat: () => stat({ mode: 0o040700, uid: 0 }),
          mkdir: () => {
            throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
          },
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'E_UDS_DIR_UNSAFE', actualUid: 0, expectedUid: uid }));
  });
});

describe('4041c6e0: (4) symlinks are refused', () => {
  it('4041c6e0: a symlink to a valid 0700 dir is refused by the check and by serveBackend', async () => {
    const real = scratch(); // 0700, ours — valid in its own right
    const link = path.join(scratch(), 'link');
    fs.symlinkSync(real, link);

    expect(() => assertPrivateSocketDir(link)).toThrow(
      expect.objectContaining({ code: 'E_UDS_DIR_UNSAFE', dir: link, isSymlink: true }),
    );

    const sock = path.join(link, 'b.sock');
    await expect(
      serveBackend({ socketPath: sock, handler: echoHandler(), onDiagnostic: noop }),
    ).rejects.toMatchObject({ code: 'E_UDS_DIR_UNSAFE', isSymlink: true });
    expect(fs.existsSync(path.join(real, 'b.sock'))).toBe(false);
    // Never repaired or removed.
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('4041c6e0: a non-directory is refused', () => {
    const file = path.join(scratch(), 'plain');
    fs.writeFileSync(file, '');
    expect(() => assertPrivateSocketDir(file)).toThrow(expect.objectContaining({ code: 'E_UDS_DIR_UNSAFE' }));
  });
});

describe('4041c6e0: (5) dialers refuse an unsafe dir without connecting', () => {
  it('4041c6e0: dialBackend into a 0777 dir fails E_UDS_DIR_UNSAFE with zero connections and no re-dial', async () => {
    const dir = scratch();
    const sock = path.join(dir, 'b.sock');
    const server = await countingServer(sock); // bound while the dir was still private
    fs.chmodSync(dir, 0o777); // ...then the dir turns unsafe

    const conn: BackendConnection = dialBackend({
      socketPath: sock,
      onDiagnostic: noop,
      backoff: { initialMs: 10, maxMs: 20, giveUpAfterMs: 150 },
    });
    cleanups.push(() => conn.close());

    const resp = await conn.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(resp.error?.code).toBe(ERR_BACKEND_UNAVAILABLE);
    expect(resp.error?.message).toMatch(/^E_UDS_DIR_UNSAFE: /);
    expect(resp.error?.data).toMatchObject({ code: 'E_UDS_DIR_UNSAFE', dir, expectedUid: UID });

    // Non-retryable: nothing is re-dialed in the background.
    await new Promise((r) => setTimeout(r, 200));
    expect(server.count()).toBe(0);
    expect(conn.isConnected()).toBe(false);
  });

  it('4041c6e0: a repaired dir recovers on the next send (the verdict is re-checked, not latched)', async () => {
    const dir = scratch();
    const sock = path.join(dir, 'b.sock');
    const handle = await serveBackend({ socketPath: sock, handler: echoHandler(), onDiagnostic: noop });
    cleanups.push(() => handle.close());
    fs.chmodSync(dir, 0o777);

    const conn = dialBackend({ socketPath: sock, onDiagnostic: noop });
    cleanups.push(() => conn.close());
    const refused = await conn.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(refused.error?.data).toMatchObject({ code: 'E_UDS_DIR_UNSAFE' });

    fs.chmodSync(dir, 0o700); // operator fixes it
    const ok = await conn.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    expect(ok.error).toBeUndefined();
    expect(ok.result).toBe('ok');
  });

  it('4041c6e0: a dir that does not exist yet stays retryable — dial connects once it appears', async () => {
    const dir = path.join(scratch(), 'later');
    const sock = path.join(dir, 'b.sock');
    const conn = dialBackend({
      socketPath: sock,
      onDiagnostic: noop,
      backoff: { initialMs: 20, maxMs: 50, giveUpAfterMs: 5000 },
    });
    cleanups.push(() => conn.close());

    const pending = conn.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    await new Promise((r) => setTimeout(r, 100));
    const handle = await serveBackend({ socketPath: sock, handler: echoHandler(), onDiagnostic: noop });
    cleanups.push(() => handle.close());

    const resp = await pending;
    expect(resp.error).toBeUndefined();
    expect(resp.result).toBe('ok');
  });

  it('4041c6e0: probeSocketLive rejects (never resolves false) for a socket in an unsafe dir', async () => {
    const dir = scratch();
    const sock = path.join(dir, 'b.sock');
    const server = await countingServer(sock);
    fs.chmodSync(dir, 0o777);

    await expect(probeSocketLive(sock, 250)).rejects.toMatchObject({ code: 'E_UDS_DIR_UNSAFE' });
    expect(server.count()).toBe(0);
  });

  it('4041c6e0: ensureBackend returns a coded, non-retryable failure and spawns nothing', async () => {
    const dir = scratchWithMode(0o777);
    const sock = path.join(dir, 'b.sock');
    const marker = path.join(scratch(), 'spawned');

    const r = await ensureBackend({
      socketPath: sock,
      singletonKey: 'test|4041c6e0',
      command: process.execPath,
      // If anything were spawned it would leave this marker behind.
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '1')`],
      onDiagnostic: noop,
      readyTimeoutMs: 500,
    });

    expect(r.disposition).toBe('failed');
    expect(r.errorCode).toBe('E_UDS_DIR_UNSAFE');
    expect(r.detail).toMatch(/^E_UDS_DIR_UNSAFE: /);
    await new Promise((res) => setTimeout(res, 150));
    expect(fs.existsSync(marker)).toBe(false);
    // No lock file was taken inside the unsafe dir.
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
