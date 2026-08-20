/**
 * libs/service-proxy/src/ensure-backend.ts — auto-managed backend lifecycle (§9.5).
 *
 * The front-shim (`runFrontShim`) needs a backend to dial. When the MCP client
 * spawns a shim and NO backend is yet live on the store's UDS, the shim must
 * ENSURE one — spawn it detached, singleton-guarded per [def:singleton-key], so
 * that across many concurrent sessions' shims there is exactly ONE backend per
 * store (single-writer). On a dropped backend connection the shim re-ensures.
 *
 * SA-4 hardening adds:
 *   3. **Readiness handshake** (`handshakeBackend`) — after the socket accepts a
 *      TCP connection, the caller sends a JSON-RPC `ping` and verifies a response
 *      (any response) returns within the timeout. A socket that accepts connections
 *      but whose handler has not finished initializing (e.g. mid-`serveBackend`
 *      resolve) is NOT considered ready. This replaces the fixed 10s timeout.
 *   4. **Backend exit monitoring** — `spawnUnderLock` tracks the child's 'exit'
 *      event so a backend that crashes before binding its socket produces a fast
 *      `'failed'` with the exit code/reason, rather than waiting the full timeout.
 *   5. **Live-socket steal prevention** — before unlinking the stale socket in
 *      `spawnUnderLock`, we re-probe (double-checked locking guard). The backend's
 *      own `serveBackend` also refuses (probe-before-bind, structured error).
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
import * as path from 'node:path';
import { encodeFrame, FrameDecoder } from './framing.js';

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
  /**
   * Path to a log file for the detached backend's stderr output.
   *
   * [inv:no-fd-inherit] A detached daemon MUST fully sever inherited stdio so it
   * never holds a parent pipe open. By default (when omitted) stderr goes to
   * /dev/null. When provided, the backend's stderr is redirected to this file
   * (append mode) — useful for diagnosing backend startup issues without
   * inheriting the caller's fds (which would keep any piped caller's pipe open).
   *
   * NEVER use 'inherit' for a detached backend: if the spawning process has its
   * stderr connected to a pipe (e.g. `soxe upgrade --all 2>&1 | tail`), the
   * detached child holds that pipe open forever → the pipeline hangs (BL-67).
   */
  stderrLogPath?: string;
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

/**
 * SA-4: Readiness handshake — connect to the socket, send a JSON-RPC ping,
 * and verify any response returns within the timeout.
 *
 * Unlike `probeSocketLive` (which only checks that the socket accepts a TCP
 * connection), this proves the backend's request handler is initialized and
 * serving. Even an error response (e.g. "Method not found" for an unknown
 * method) proves the backend is live.
 */
export function handshakeBackend(socketPath: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (!fs.existsSync(socketPath)) {
      resolve(false);
      return;
    }
    const sock = net.createConnection(socketPath);
    let settled = false;
    const done = (success: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(success);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();

    const decoder = new FrameDecoder(
      (_msg) => {
        // Any response — even an error — proves the backend handler is live.
        clearTimeout(timer);
        done(true);
      },
      () => {
        clearTimeout(timer);
        done(false);
      },
    );

    sock.on('connect', () => {
      // Send a well-formed JSON-RPC request. Even if the backend doesn't
      // handle 'ping', it returns a "Method not found" error (-32601) which
      // satisfies the "any response" criterion.
      const ping = encodeFrame({ jsonrpc: '2.0', id: '__sa4_probe', method: 'ping' });
      sock.write(ping);
    });
    sock.on('data', (chunk: Buffer) => decoder.push(chunk));
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

/**
 * (BUG-SOX-UPGRADE-DIES-SILENTLY-AT-ENSUREBACKEND) REFERENCED on purpose.
 *
 * This timer used to call `.unref()`. That is fatal for any caller that awaits
 * it as its only pending work: `spawnUnderLock` calls `child.unref()` right
 * before its readiness loop, so once the spawn's own handles are released the
 * unref'd sleep left the event loop with ZERO referenced handles. Node then
 * exits cleanly — status 0 — while suspended at `await sleep(100)`, and every
 * statement after the await simply never runs.
 *
 * Measured 2026-08-20: `soxe upgrade --all` died exactly there, mid-rolling-
 * restart. It had already unloaded memory-server's OS unit ([inv:unload-then-
 * reap]) and never reached the re-enable, leaving a live but UNSUPERVISED
 * process; the other 5 upgraded consumers were never restarted; no summary
 * printed; exit code 0. The log ends at the spawn line, 504 lines in.
 *
 * A sleep that a caller AWAITS must hold the loop for exactly as long as it is
 * awaited — otherwise "await" silently means "maybe exit here". The wait loops
 * this serves are all deadline-bounded (`readyTimeoutMs`), so holding the loop
 * cannot hang: the worst case is the bounded wait actually elapsing.
 */
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

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

/** Spawn the backend while holding the lock; wait for readiness; release. */
async function spawnUnderLock(
  opts: EnsureBackendOptions,
  lockPath: string,
  diag: (l: string) => void,
  readyTimeoutMs: number,
  probeTimeoutMs: number,
): Promise<EnsureBackendResult> {
  try {
    // SA-4: Re-probe under the lock with handshake (not just connect-probe).
    // A backend may have come up between our first probe and acquiring the lock
    // (double-checked locking). Use the full handshake to confirm readiness.
    if (await handshakeBackend(opts.socketPath, probeTimeoutMs)) {
      return { disposition: 'already-live', detail: 'backend came live before our spawn (double-checked)' };
    }

    // SA-4: Live-socket steal — before unlinking the socket file, verify
    // it's truly dead (re-probe since the check above may be a race window old).
    if (fs.existsSync(opts.socketPath)) {
      const stillDead = !(await probeSocketLive(opts.socketPath, probeTimeoutMs));
      if (!stillDead) {
        return { disposition: 'already-live', detail: 'socket came live between probe and unlink (live-socket steal prevented)' };
      }
      // Stale socket from a dead backend — remove it.
      try { fs.unlinkSync(opts.socketPath); } catch { /* best-effort */ }
    }

    diag(`[service-proxy ensure] spawning backend: ${opts.command} ${opts.args.join(' ')}`);

    // [inv:no-fd-inherit] Fully sever all inherited stdio fds. A detached daemon
    // MUST NOT hold a parent pipe open — if the spawner has its stderr connected to
    // a pipe (e.g. `soxe upgrade --all 2>&1 | tail`), an inherited fd 2 keeps the
    // pipe open indefinitely, hanging the pipeline (BL-67).
    //
    // When opts.stderrLogPath is provided we redirect fd 2 to that file (append)
    // so backend startup diagnostics are preserved without inheriting parent fds.
    // Otherwise fd 2 is /dev/null (fully silent — the onDiagnostic callback above
    // already captured the spawn initiation for the caller).
    //
    // We use a synchronously-opened fd (not a WriteStream) because `spawn` needs
    // an integer fd or 'ignore'/'pipe'/'inherit' — a WriteStream object that hasn't
    // been fully opened yet would yield an invalid fd and the backend would fail to
    // start. After `spawn()` returns the child has inherited the fd; we close our
    // copy immediately so this process doesn't keep the file open unnecessarily.
    let stderrFd: number | 'ignore' = 'ignore';
    if (opts.stderrLogPath) {
      try {
        fs.mkdirSync(path.dirname(opts.stderrLogPath), { recursive: true, mode: 0o700 });
        stderrFd = fs.openSync(opts.stderrLogPath, 'a');
      } catch {
        stderrFd = 'ignore';
      }
    }

    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      // Detached so the backend survives the shim's exit (its lifetime = the store,
      // not the client pipe). ALL fds are explicitly severed — never inherit from
      // the parent ([inv:no-fd-inherit] — prevents BL-67 pipe-hold hang).
      detached: true,
      stdio: ['ignore', 'ignore', stderrFd === 'ignore' ? 'ignore' : stderrFd],
    });
    // Close our copy of the log fd immediately after spawn() so this process
    // doesn't keep the file open unnecessarily. The child has already inherited it.
    if (stderrFd !== 'ignore') {
      try { fs.closeSync(stderrFd); } catch { /* ignore */ }
    }
    const pid = child.pid;
    // Unref so this shim process can exit independently of the backend.
    child.unref();

    // SA-4: Backend exit monitoring — track child exit for fast failure.
    let childExited = false;
    let childExitCode: number | null = null;
    let childExitSignal: string | null = null;
    child.on('exit', (code, signal) => {
      childExited = true;
      childExitCode = code;
      childExitSignal = signal;
    });

    // SA-4: Wait for readiness using the RPC handshake (not just socket probe).
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      // Fast-fail if the child exited before becoming ready.
      if (childExited) {
        return {
          disposition: 'failed',
          detail:
            `backend process (${childExitSignal ? `signal ${childExitSignal}` : `exit code ${String(childExitCode)}`}) ` +
            `died before socket became ready on ${opts.socketPath}`,
        };
      }

      // SA-4: Use the full readiness handshake (connect + RPC ping/response),
      // not just a TCP connect probe. This verifies the backend's handler is
      // actually serving requests.
      if (await handshakeBackend(opts.socketPath, probeTimeoutMs)) {
        diag(`[service-proxy ensure] backend live (pid ${String(pid)}) on ${opts.socketPath}`);
        return {
          disposition: 'spawned',
          ...(pid !== undefined ? { pid } : {}),
          detail: `spawned backend pid ${String(pid)}`,
        };
      }
      await sleep(100);
    }

    // SA-4: Distinguish between "child died" and "child lived but didn't bind".
    if (childExited) {
      return {
        disposition: 'failed',
        detail:
          `backend process (${childExitSignal ? `signal ${childExitSignal}` : `exit code ${String(childExitCode)}`}) ` +
          `died within ${readyTimeoutMs}ms timeout on ${opts.socketPath}`,
      };
    }
    return { disposition: 'failed', detail: `backend spawned (pid ${String(pid)}) but socket never came live` };
  } finally {
    releaseLock(lockPath);
  }
}
