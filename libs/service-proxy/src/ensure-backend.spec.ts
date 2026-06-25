/**
 * ensure-backend.spec.ts — the auto-managed, singleton-guarded backend lifecycle
 * (§9.5 step 3). Proves:
 *   - probeSocketLive returns false for an absent/dead socket, true for a live one;
 *   - ensureBackend('already-live') is a no-op when a backend already serves;
 *   - ensureBackend spawns a backend when absent and waits for the socket;
 *   - two CONCURRENT ensureBackend calls (simulating two sessions' shims) result in
 *     exactly ONE spawned backend (the O_EXCL spawn lock → single-writer).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { ensureBackend, probeSocketLive } from './ensure-backend.js';
import { serveBackend, type BackendHandle } from './backend.js';

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
});
