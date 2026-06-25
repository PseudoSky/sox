/**
 * libs/service-proxy/src/ensure-backend.ts — auto-managed backend lifecycle (§9.5).
 *
 * The front-shim (`runFrontShim`) needs a backend to dial. When the MCP client
 * spawns a shim and NO backend is yet live on the store's UDS, the shim must
 * ENSURE one — spawn it detached, singleton-guarded per [def:singleton-key], so
 * that across many concurrent sessions' shims there is exactly ONE backend per
 * store (single-writer). On a dropped backend connection the shim re-ensures.
 *
 * Singleton enforcement here is a leaf-local guard built from two primitives that
 * need no host-runtime import (this lib stays a dependency-free leaf — §9.5.4):
 *
 *   1. **Liveness probe** — connect to the UDS. A successful connect means a
 *      backend is already serving; we do NOT spawn (idempotent).
 *   2. **O_EXCL spawn lock** — keyed by the singleton-key digest, taken with
 *      `fs.open(..., 'wx')` (atomic create-or-fail). Only the winner of the race
 *      spawns; losers wait for the socket to come live. The lock is released once
 *      the socket is live (or on failure), and a stale lock (holder pid dead, or
 *      older than a TTL) is reclaimed. This serializes the spawn across many
 *      shims in many sessions → one backend per store even under a thundering herd.
 *
 * The spawned backend is **detached** (`detached:true`, `unref()`) so it survives
 * the shim's exit (the shim's lifetime is the client's stdio pipe; the backend's
 * lifetime is the store). It is reaper-compatible: the caller passes the backend
 * entrypoint as `args` so `findOrphansByIdentity(entrypointToken)` (BL-31) finds
 * it by the same token the supervisor uses.
 *
 * Leaf module — node builtins only (net, fs, path, child_process, os).
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

/** Options for {@link ensureBackend}. */
export interface EnsureBackendOptions {
  /** The backend UDS path (data-root-derived, [def:singleton-key]-keyed). */
  socketPath: string;
  /** The [def:singleton-key] string (id + canonical store-resource). Identical
   * keys ⇒ identical lock ⇒ one backend, even across sessions. */
  singletonKey: string;
  /** The executable to spawn (e.g. process.execPath). */
  command: string;
  /** Args for the backend process (e.g. ['--enable-source-maps', entrypoint]).
   * The entrypoint path here is the reaper identity token (BL-31). */
  args: string[];
  /** Spawn cwd. */
  cwd?: string;
  /** Spawn env. MUST carry the backend-mode signal (e.g. SOX_PROXY_BACKEND=1) and
   * SOX_CONFIG_* so the backend resolves the right store. */
  env?: NodeJS.ProcessEnv;
  /** Directory for the spawn lock file (defaults to the socket's directory). */
  lockDir?: string;
  /** stderr diagnostics sink. */
  onDiagnostic?: (line: string) => void;
  /** Max ms to wait for the socket to come live after a spawn (default 10000). */
  readyTimeoutMs?: number;
  /** Per-attempt connect-probe timeout in ms (default 250). */
  probeTimeoutMs?: number;
  /** Lock staleness TTL in ms — a lock older than this with no live socket is
   * reclaimed (default 30000). */
  lockTtlMs?: number;
}

/** The disposition of an {@link ensureBackend} call. */
export type EnsureBackendDisposition =
  | 'already-live' // a backend was already serving — we did nothing
  | 'spawned' // we won the lock and spawned the backend; socket came live
  | 'adopted-after-wait' // another shim spawned it; we waited for the socket
  | 'failed'; // could not bring a backend up within the timeout

/** Result of {@link ensureBackend}. */
export interface EnsureBackendResult {
  disposition: EnsureBackendDisposition;
  /** The pid we spawned (only when disposition === 'spawned'). */
  pid?: number;
  /** Diagnostic detail. */
  detail: string;
}

/** Probe the UDS: resolve true iff a backend accepts a connection. */
export function probeSocketLive(socketPath: string, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) {
      resolve(false);
      return;
    }
    const sock = net.createConnection(socketPath);
    let settled = false;
    const done = (live: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(live);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();
    sock.on('connect', () => {
      clearTimeout(timer);
      done(true);
    });
    sock.on('error', () => {
      clearTimeout(timer);
      done(false);
    });
  });
}

/** Is a pid alive? (kill(pid,0) — no signal sent.) */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but is owned by another user — treat as alive.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** sha-free short, fs-safe digest of the singleton key for the lock filename. */
function lockName(singletonKey: string): string {
  // A small, dependency-free FNV-1a hash keeps this a pure leaf (no crypto import
  // needed, though crypto is a builtin — kept minimal). Collisions across
  // distinct keys would only over-serialize, never under-serialize, which is safe.
  let h = 0x811c9dc5;
  for (let i = 0; i < singletonKey.length; i++) {
    h ^= singletonKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `proxy-backend-${h.toString(16).padStart(8, '0')}.lock`;
}

interface LockPayload {
  pid: number;
  t: number;
  key: string;
}

/**
 * Try to take the spawn lock atomically. Returns true if WE hold it. A stale lock
 * (holder dead, or older than TTL with no live socket) is reclaimed.
 */
function tryAcquireLock(lockPath: string, key: string, ttlMs: number): boolean {
  try {
    const fd = fs.openSync(lockPath, 'wx'); // atomic create-or-fail
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, t: Date.now(), key } satisfies LockPayload));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  // Lock exists — is the holder still alive and the lock fresh?
  let payload: LockPayload | null = null;
  try {
    payload = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockPayload;
  } catch {
    payload = null;
  }
  const stale =
    payload === null ||
    !pidAlive(payload.pid) ||
    Date.now() - payload.t > ttlMs;
  if (stale) {
    // Reclaim: unlink and retry once. A race here is benign — the loser of the
    // unlink/recreate race simply fails to acquire and falls back to waiting.
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* another reclaimer won */
    }
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, t: Date.now(), key } satisfies LockPayload));
      fs.closeSync(fd);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function releaseLock(lockPath: string): void {
  try {
    // Only unlink if it's still ours (best-effort — a reclaimed lock may be another's).
    const payload = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockPayload;
    if (payload.pid === process.pid) fs.unlinkSync(lockPath);
  } catch {
    /* gone or not ours */
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref?.());

/**
 * Ensure exactly one backend is live on `socketPath`, spawning it (detached,
 * singleton-guarded) if absent. Idempotent and safe under concurrent shims:
 *
 *   - If a backend is already serving → 'already-live' (no spawn).
 *   - Else take the O_EXCL spawn lock keyed by the singleton-key:
 *       * winner spawns the backend detached and waits for the socket → 'spawned';
 *       * losers wait for the winner's socket to come live → 'adopted-after-wait'.
 *   - If nothing comes up within readyTimeoutMs → 'failed'.
 */
export async function ensureBackend(opts: EnsureBackendOptions): Promise<EnsureBackendResult> {
  const diag = opts.onDiagnostic ?? ((l: string) => process.stderr.write(l + '\n'));
  const readyTimeoutMs = opts.readyTimeoutMs ?? 10000;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 250;
  const lockTtlMs = opts.lockTtlMs ?? 30000;
  const lockDir = opts.lockDir ?? path.dirname(opts.socketPath);

  // Fast path: a backend is already serving.
  if (await probeSocketLive(opts.socketPath, probeTimeoutMs)) {
    return { disposition: 'already-live', detail: `backend already live on ${opts.socketPath}` };
  }

  try {
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  } catch {
    /* dir may already exist */
  }
  const lockPath = path.join(lockDir, lockName(opts.singletonKey));

  // Contend for the spawn lock. The winner spawns; losers wait.
  const haveLock = tryAcquireLock(lockPath, opts.singletonKey, lockTtlMs);

  if (!haveLock) {
    // Another shim is (or just finished) spawning the backend. Wait for its socket.
    diag(`[service-proxy ensure] another holder owns the spawn lock; waiting for ${opts.socketPath}`);
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (await probeSocketLive(opts.socketPath, probeTimeoutMs)) {
        return { disposition: 'adopted-after-wait', detail: 'backend brought up by a peer shim' };
      }
      // If the lock vanished AND no socket, the holder may have died mid-spawn —
      // try to grab the lock ourselves so the backend still comes up.
      if (!fs.existsSync(lockPath)) {
        if (tryAcquireLock(lockPath, opts.singletonKey, lockTtlMs)) {
          return spawnUnderLock(opts, lockPath, diag, readyTimeoutMs, probeTimeoutMs);
        }
      }
      await sleep(100);
    }
    return { disposition: 'failed', detail: 'timed out waiting for a peer-spawned backend' };
  }

  return spawnUnderLock(opts, lockPath, diag, readyTimeoutMs, probeTimeoutMs);
}

/** Spawn the backend while holding the lock; wait for the socket; release. */
async function spawnUnderLock(
  opts: EnsureBackendOptions,
  lockPath: string,
  diag: (l: string) => void,
  readyTimeoutMs: number,
  probeTimeoutMs: number,
): Promise<EnsureBackendResult> {
  try {
    // Re-probe under the lock: a backend may have come up between our first probe
    // and acquiring the lock (double-checked locking).
    if (await probeSocketLive(opts.socketPath, probeTimeoutMs)) {
      return { disposition: 'already-live', detail: 'backend came live before our spawn (double-checked)' };
    }

    // Remove a stale socket file so the backend's listen() binds cleanly
    // (serveBackend also unlinks, but doing it here avoids a transient EADDRINUSE).
    try {
      if (fs.existsSync(opts.socketPath)) fs.unlinkSync(opts.socketPath);
    } catch {
      /* best-effort */
    }

    diag(`[service-proxy ensure] spawning backend: ${opts.command} ${opts.args.join(' ')}`);
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      // Detached so the backend survives the shim's exit (its lifetime = the store,
      // not the client pipe). stdio ignored on stdin/stdout (NEVER inherit stdout —
      // [inv:no-stdout-diagnostics]); stderr inherited so diagnostics are visible.
      detached: true,
      stdio: ['ignore', 'ignore', os.platform() === 'win32' ? 'ignore' : 'inherit'],
    });
    const pid = child.pid;
    // Unref so this shim process can exit independently of the backend.
    child.unref();

    // Wait for the socket to come live.
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (await probeSocketLive(opts.socketPath, probeTimeoutMs)) {
        diag(`[service-proxy ensure] backend live (pid ${String(pid)}) on ${opts.socketPath}`);
        return {
          disposition: 'spawned',
          ...(pid !== undefined ? { pid } : {}),
          detail: `spawned backend pid ${String(pid)}`,
        };
      }
      await sleep(100);
    }
    return { disposition: 'failed', detail: `backend spawned (pid ${String(pid)}) but socket never came live` };
  } finally {
    releaseLock(lockPath);
  }
}
