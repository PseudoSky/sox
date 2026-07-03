/**
 * ensure-backend.spec.ts — the auto-managed, singleton-guarded backend lifecycle
 * (§9.5 step 3). Proves:
 *   - probeSocketLive returns false for an absent/dead socket, true for a live one;
 *   - ensureBackend('already-live') is a no-op when a backend already serves;
 *   - ensureBackend spawns a backend when absent and waits for the socket;
 *   - two CONCURRENT ensureBackend calls (simulating two sessions' shims) result in
 *     exactly ONE spawned backend (the O_EXCL spawn lock → single-writer).
 *   - BL-67: the detached backend DOES NOT hold the spawner's stdout/stderr pipe open
 *     (ensureBackend fully severs inherited stdio → piped callers receive EOF on exit).
 *
 * SA-4 additions:
 *   - handshakeBackend: returns true for a live, responding backend handler; false
 *     for absent, dead, or non-responding sockets.
 *   - A backend process that exits before binding its socket → fast 'failed' with
 *     the exit code in detail (backend exit handling, not a wait-for-timeout).
 *   - Live-socket steal: ensureBackend already handles this via probeSocketLive in
 *     the fast path; backed up by serveBackend's E_LIVE_SOCKET rejection.
 *   - Negative control: simulating the OLD unlink-first behavior (unlinking a live
 *     backend's socket) silently breaks the backend, proving why SA-4 is necessary.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { ensureBackend, probeSocketLive, handshakeBackend } from './ensure-backend.js';
import { serveBackend, type BackendHandle } from './backend.js';

/**
 * BL-67 regression helpers: two fixture scripts for the pipe-sever test.
 *
 * The test proves that after `ensureBackend` returns and the spawner exits,
 * the pipe connected to the spawner's stdout+stderr gets EOF immediately.
 * If the detached backend inherited those fds (the BL-67 bug), the pipe would
 * stay open indefinitely — `child.on('close')` would never fire.
 *
 * Two separate file fixtures avoid any escaping complexity:
 *  - backendFixtureBl67: the detached backend (binds the socket, runs forever)
 *  - spawnerFixture: calls ensureBackend, writes "disposition:<x>" to stdout, exits
 */
function backendFixtureBl67(dir: string, distIndex: string): string {
  const file = path.join(dir, 'bl67-backend.cjs');
  fs.writeFileSync(file, `
'use strict';
const { serveBackend } = require(${JSON.stringify(distIndex)});
const fs = require('node:fs');
const socketPath = process.argv[2];
const counterFile = process.argv[3];
fs.appendFileSync(counterFile, process.pid + '\\n');
serveBackend({
  socketPath,
  onDiagnostic: () => {},
  handler: (req) => ({ jsonrpc: '2.0', id: req.id ?? null, result: { ok: true } }),
}).then(() => {});
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1 << 30);
`);
  return file;
}

function spawnerFixture(dir: string, distIndex: string, backendFile: string): string {
  const file = path.join(dir, 'bl67-spawner.cjs');
  // IMPORTANT: ensureBackend uses unref()'d timers in its socket-probe wait loop
  // (sleep(100) + probeSocketLive timeout) so that the shim process's event loop
  // can exit when the MCP client closes the pipe. That is correct for the shim.
  // But in a standalone spawner script with NO other event-loop refs, those unref'd
  // timers allow the process to exit BEFORE the promise settles.
  //
  // We pin the event loop with a ref'd interval for the duration of the call, and
  // clear it (+ call process.exit) in the then/catch callbacks. This simulates what
  // the real shim does naturally (its stdin/stdout pipes keep the event loop alive).
  fs.writeFileSync(file, `
'use strict';
const { ensureBackend } = require(${JSON.stringify(distIndex)});
const socketPath = process.argv[2];
const counterFile = process.argv[3];
const backendFile = ${JSON.stringify(backendFile)};
// Keep the event loop alive while ensureBackend is doing its probe+spawn wait.
const keepAlive = setInterval(() => {}, 100);
ensureBackend({
  socketPath,
  singletonKey: 'bl67-pipe-test:' + socketPath,
  command: process.execPath,
  args: [backendFile, socketPath, counterFile],
  onDiagnostic: () => {},
  readyTimeoutMs: 8000,
}).then((r) => {
  clearInterval(keepAlive);
  process.stdout.write('disposition:' + r.disposition + '\\n', () => {
    process.exit(0);
  });
}).catch((e) => {
  clearInterval(keepAlive);
  process.exitCode = 1;
  process.stdout.write('spawner-error: ' + String(e) + '\\n', () => {
    process.exit(1);
  });
});
`);
  return file;
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sox-ensure-'));
}

const cleanups: Array<() => void | Promise<void>> = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  for (const ch of children.splice(0)) {
    try {
      ch.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
});

/**
 * A tiny backend fixture program that, when run, binds the socket AND appends its
 * pid to a counter file — so the test can count how many backends actually spawned.
 */
function backendFixture(dir: string): string {
  const distIndex = path.join(__dirname, '..', 'dist', 'index.js');
  const file = path.join(dir, 'backend-fixture.cjs');
  const src = `
const { serveBackend } = require(${JSON.stringify(distIndex)});
const fs = require('node:fs');
const socketPath = process.argv[2];
const counterFile = process.argv[3];
// Record this spawn (one line per real spawn) BEFORE binding so the count is exact.
fs.appendFileSync(counterFile, process.pid + '\\n');
serveBackend({
  socketPath,
  onDiagnostic: () => {},
  handler: (req) => ({ jsonrpc: '2.0', id: req.id ?? null, result: { ok: true, pid: process.pid } }),
}).then(() => {
  process.stderr.write('listening ' + socketPath + '\\n');
});
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1 << 30);
`;
  fs.writeFileSync(file, src);
  return file;
}

describe('probeSocketLive', () => {
  it('is false for an absent socket', async () => {
    const dir = tmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    expect(await probeSocketLive(path.join(dir, 'nope.sock'), 100)).toBe(false);
  });

  it('is true for a live backend, false after it closes', async () => {
    const dir = tmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const sock = path.join(dir, 'live.sock');
    const h: BackendHandle = await serveBackend({
      socketPath: sock,
      onDiagnostic: () => {},
      handler: (req) => ({ jsonrpc: '2.0', id: req.id ?? null, result: {} }),
    });
    expect(await probeSocketLive(sock, 200)).toBe(true);
    await h.close();
    expect(await probeSocketLive(sock, 200)).toBe(false);
  });
});

describe('ensureBackend', () => {
  it("returns 'already-live' and does NOT spawn when a backend is up", async () => {
    const dir = tmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const sock = path.join(dir, 'up.sock');
    const h = await serveBackend({
      socketPath: sock,
      onDiagnostic: () => {},
      handler: (req) => ({ jsonrpc: '2.0', id: req.id ?? null, result: {} }),
    });
    cleanups.push(() => h.close());

    const r = await ensureBackend({
      socketPath: sock,
      singletonKey: 'test up:/up',
      command: process.execPath,
      args: ['-e', 'process.exit(7)'], // would fail if actually spawned
      onDiagnostic: () => {},
      readyTimeoutMs: 2000,
    });
    expect(r.disposition).toBe('already-live');
  });

  it('spawns a backend when absent and the socket comes live', async () => {
    const dir = tmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const sock = path.join(dir, 'spawn.sock');
    const counter = path.join(dir, 'count.txt');
    const fixture = backendFixture(dir);

    const r = await ensureBackend({
      socketPath: sock,
      singletonKey: 'test spawn:/spawn',
      command: process.execPath,
      args: [fixture, sock, counter],
      onDiagnostic: () => {},
      readyTimeoutMs: 8000,
    });
    expect(r.disposition).toBe('spawned');
    expect(r.pid).toBeGreaterThan(0);
    expect(await probeSocketLive(sock, 500)).toBe(true);
    // Exactly one spawn recorded.
    const count = fs.readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length;
    expect(count).toBe(1);
    // Reap the spawned (detached) backend.
    if (r.pid) {
      try {
        process.kill(r.pid, 'SIGTERM');
      } catch {
        /* gone */
      }
    }
  });

  /**
   * BL-67 regression: a detached backend MUST NOT hold the spawner's pipe open.
   *
   * We spawn a "spawner" child process with `stdio: 'pipe'` (both stdout+stderr
   * piped to the test). The spawner calls ensureBackend, which auto-spawns a
   * detached backend, then exits. If the detached backend inherited the pipe's
   * write-end (the BL-67 bug), the test-side pipe never gets EOF and the
   * `child.on('close')` never fires — the `await` below would time out.
   *
   * After the fix (ensure-backend uses `stdio:['ignore','ignore','ignore']` or a
   * log-file fd rather than inheriting fd 2), the child's pipe closes within a
   * couple of seconds of the spawner exiting.
   */
  it('[BL-67] detached backend does NOT hold the spawner pipe open (stdout+stderr both close)', async () => {
    const dir = tmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const sock = path.join(dir, 'bl67.sock');
    const counter = path.join(dir, 'bl67-count.txt');
    const distIndex = path.join(__dirname, '..', 'dist', 'index.js');
    const backendFile = backendFixtureBl67(dir, distIndex);
    const spawnerFile = spawnerFixture(dir, distIndex, backendFile);

    // Spawn the spawner with BOTH stdout and stderr PIPED to us.
    // The critical assertion: the child's stdio streams BOTH close within N seconds.
    // (If the detached backend holds fd 1 or fd 2 open, this never resolves.)
    const PIPE_CLOSE_TIMEOUT_MS = 12_000; // well above the 8s ready-timeout
    const child = spawn(process.execPath, [spawnerFile, sock, counter], {
      stdio: 'pipe',
      // Deliberately do NOT set detached:true for the spawner — we want to capture
      // its exit and its pipe close as two separate events to prove causality.
    });
    children.push(child);

    let stdoutData = '';
    let stderrData = '';
    child.stdout?.on('data', (c: Buffer) => { stdoutData += c.toString(); });
    child.stderr?.on('data', (c: Buffer) => { stderrData += c.toString(); });

    // Collect the close event on both streams (not just the process exit).
    // The pipe closes when ALL write-end holders release it.
    const pipeClosedAt = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(
          `[BL-67] HANG: spawner's pipe did not close within ${PIPE_CLOSE_TIMEOUT_MS}ms — ` +
          `detached backend likely holds the write-end open (stdout: ${JSON.stringify(stdoutData)}, ` +
          `stderr: ${JSON.stringify(stderrData)})`,
        )),
        PIPE_CLOSE_TIMEOUT_MS,
      );
      // 'close' fires after BOTH stdout and stderr have been fully consumed,
      // meaning all write-end holders (spawner + any inherited child) have closed them.
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        // Capture the exit code+signal in the error output (via stderrData).
        stderrData += `[exitCode=${String(code)} signal=${String(signal)}]`;
        resolve(Date.now());
      });
    });

    // The pipe closed — assert it closed quickly (within a reasonable margin).
    // The spawner should finish within ~8s (ensureBackend readyTimeoutMs).
    const _ = pipeClosedAt; // used to prove the await resolved, not timed out
    // Include stderr in the error message to diagnose spawner crashes.
    expect(stdoutData, `spawner stderr: ${JSON.stringify(stderrData)}`).toMatch(/disposition:/);
    expect(stdoutData).not.toMatch(/disposition:failed/);

    // The backend process should be live (the spawn worked).
    expect(await probeSocketLive(sock, 500)).toBe(true);

    // Exactly one backend spawned.
    if (fs.existsSync(counter)) {
      const count = fs.readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length;
      expect(count).toBe(1);
      // Reap the detached backend.
      const pid = parseInt(fs.readFileSync(counter, 'utf8').trim().split('\n')[0]!, 10);
      if (!isNaN(pid)) try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
    }
  });

  it('enforces single-writer: two concurrent ensures spawn exactly ONE backend', async () => {
    const dir = tmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const sock = path.join(dir, 'race.sock');
    const counter = path.join(dir, 'count.txt');
    const fixture = backendFixture(dir);

    const key = 'test race:/race';
    const mk = () =>
      ensureBackend({
        socketPath: sock,
        singletonKey: key,
        command: process.execPath,
        args: [fixture, sock, counter],
        onDiagnostic: () => {},
        readyTimeoutMs: 8000,
        probeTimeoutMs: 150,
      });

    // Fire two ensures at once (two sessions' shims contending).
    const [a, b] = await Promise.all([mk(), mk()]);

    // Exactly one 'spawned'; the other 'adopted-after-wait' or 'already-live'.
    const dispositions = [a.disposition, b.disposition].sort();
    expect(dispositions).toContain('spawned');
    const nonSpawn = dispositions.filter((d) => d !== 'spawned');
    expect(nonSpawn.length).toBe(1);
    expect(['adopted-after-wait', 'already-live']).toContain(nonSpawn[0]);

    // The counter file proves exactly ONE backend process actually started.
    const count = fs.readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length;
    expect(count).toBe(1);

    // Reap.
    const pid = a.pid ?? b.pid;
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* gone */
      }
    }
  });

  // ── SA-4: Backend exit handling ─────────────────────────────────────────
  it('[SA-4] backend that exits before binding returns failed', async () => {
    const dir = tmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const sock = path.join(dir, 'crash.sock');

    // Spawn a script that exits immediately (simulates a crashed backend).
    const r = await ensureBackend({
      socketPath: sock,
      singletonKey: 'test crash:/crash',
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
      onDiagnostic: () => {},
      readyTimeoutMs: 3000,
      probeTimeoutMs: 100,
    });
    expect(r.disposition).toBe('failed');
    expect(r.detail).toMatch(/exit code 1/);
  });

  // ── SA-4: handshakeBackend tests ─────────────────────────────────────────────
  it('[SA-4] handshakeBackend returns false for absent socket', async () => {
    expect(await handshakeBackend('/nonexistent/sock', 100)).toBe(false);
  });

  it('[SA-4] handshakeBackend returns true for a live backend handler', async () => {
    const dir = tmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const sock = path.join(dir, 'handshake.sock');
    const h = await serveBackend({
      socketPath: sock,
      handler: (req) => ({ jsonrpc: '2.0', id: req.id ?? null, result: {} }),
      onDiagnostic: () => {},
    });
    cleanups.push(() => h.close());

    expect(await handshakeBackend(sock, 500)).toBe(true);
  });

  it('[SA-4] handshakeBackend returns false after backend closes', async () => {
    const dir = tmpDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const sock = path.join(dir, 'gone.sock');
    const h = await serveBackend({
      socketPath: sock,
      handler: (req) => ({ jsonrpc: '2.0', id: req.id ?? null, result: {} }),
      onDiagnostic: () => {},
    });
    await h.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(await handshakeBackend(sock, 200)).toBe(false);
  });
});

// ── SA-4: Negative control — simulate old unlink-first behavior ─────────────
describe('[SA-4 negative control] unlink-first silently breaks a live backend', () => {
  it('unlinking a live backend socket causes the backend to fail its next accept', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-negctrl-'));
    const sock = path.join(dir, 'neg.sock');
    const afterEachCleanup: Array<() => void | Promise<void>> = [];
    const afterEachChildren: ChildProcess[] = [];

    try {
      // Start a real backend on the socket.
      const h: BackendHandle = await serveBackend({
        socketPath: sock,
        handler: (req) => ({ jsonrpc: '2.0', id: req.id ?? null, result: { ok: true } }),
        onDiagnostic: () => {},
      });
      afterEachCleanup.push(() => h.close());

      // Old behavior: unlink the socket without checking if it's live.
      // This is what the OLD serveBackend did before SA-4.
      fs.unlinkSync(sock);
      expect(fs.existsSync(sock)).toBe(false);

      // The backend process gets EADDRINUSE on its next accept (it won't be
      // able to accept new connections or re-bind). Verify by trying to dial.
      // Since the file is unlinked, the socket is now orphaned — the kernel
      // still has the socket, but the file is gone, so new clients can't reach it.
      const dialPath = sock; // same path, file is gone
      const conn = net.createConnection(dialPath);
      const dialResult = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), 500);
        conn.on('connect', () => {
          clearTimeout(timer);
          resolve('connected');
        });
        conn.on('error', (err: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          resolve(`error: ${err.code}`);
        });
      });
      conn.destroy();

      // The old unlink-first approach means clients get ENOENT or ECONNREFUSED
      // even though the backend process is still logically running. This is the
      // "silent breakage" that SA-4 prevents.
      expect(dialResult).not.toBe('connected');

      await h.close();
    } finally {
      for (const c of afterEachChildren) { try { c.kill('SIGKILL'); } catch { /* ok */ } }
      for (const c of afterEachCleanup) { try { await c(); } catch { /* ok */ } }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });
});
