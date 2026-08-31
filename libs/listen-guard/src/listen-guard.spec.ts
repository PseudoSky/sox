/**
 * listen-guard.spec.ts — BL-619 repo-wide listen() safety invariant.
 *
 * RED→GREEN: before this lib existed, `libs/service-proxy/src/shim.ts` called
 * `httpServer.listen(port, host, ...)` with no 'error' listener — a port
 * collision (launchd-held 3099 + a client-spawned duplicate shim) crashed the
 * process with an unhandled 'error' event, six times on 2026-07-18.
 *
 * These tests pin the LIFETIME fix:
 *   - probeTcp detects a held port BEFORE bind (fast path).
 *   - classifyListenError maps EADDRINUSE → 'already-running', else 'other'.
 *   - emitListenFailure appends a structured JSONL record.
 *   - listenGuarded never throws for a bind failure; it resolves {ok:false, …}
 *     with a failure record carrying port/pid/code, and — the process-level
 *     uncaughtException trap — a bind collision never surfaces as an unhandled
 *     'error' that would kill the process.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  classifyListenError,
  emitListenFailure,
  listenGuarded,
  probeTcp,
  type ListenFailureRecord,
} from './listen-guard.js';

const tmpDirs: string[] = [];
function tmpPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-listen-guard-'));
  tmpDirs.push(dir);
  return path.join(dir, name);
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** Bind a TCP server on an ephemeral port and return its bound port. */
function holdTcp(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ─── classifyListenError ──────────────────────────────────────────────────────

describe('classifyListenError (BL-619)', () => {
  it('EADDRINUSE → already-running', () => {
    const err = Object.assign(new Error('address already in use'), { code: 'EADDRINUSE' });
    expect(classifyListenError(err)).toBe('already-running');
  });

  it('EACCES → other', () => {
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    expect(classifyListenError(err)).toBe('other');
  });

  it('non-errno (no code) → other', () => {
    expect(classifyListenError(new Error('boom'))).toBe('other');
    expect(classifyListenError(undefined)).toBe('other');
  });
});

// ─── probeTcp ─────────────────────────────────────────────────────────────────

describe('probeTcp (BL-619)', () => {
  it('returns true when a server holds the port', async () => {
    const { server, port } = await holdTcp();
    try {
      expect(await probeTcp('127.0.0.1', port, 250)).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it('returns false when nothing holds the port', async () => {
    // Reserve then release a port so we have a near-certain-free one to probe.
    const { server, port } = await holdTcp();
    await closeServer(server);
    expect(await probeTcp('127.0.0.1', port, 250)).toBe(false);
  });
});

// ─── emitListenFailure ────────────────────────────────────────────────────────

describe('emitListenFailure (BL-619)', () => {
  it('appends a single JSONL record to the record file', () => {
    const file = tmpPath('failures.jsonl');
    const rec: ListenFailureRecord = {
      code: 'EADDRINUSE',
      message: 'listen on 127.0.0.1:3099 failed: EADDRINUSE',
      host: '127.0.0.1',
      port: 3099,
      disposition: 'already-running',
      pid: 12345,
      ts: '2026-07-18T00:00:00.000Z',
    };
    emitListenFailure(rec, { recordFile: file });
    emitListenFailure(rec, { recordFile: file });

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const parsed = JSON.parse(lines[0]!) as ListenFailureRecord;
    expect(parsed.code).toBe('EADDRINUSE');
    expect(parsed.port).toBe(3099);
    expect(parsed.disposition).toBe('already-running');
    expect(parsed.pid).toBe(12345);
  });

  it('creates missing parent directories and does not throw on a bad path', () => {
    const nested = tmpPath('deep/nested/failures.jsonl');
    expect(() =>
      emitListenFailure(
        { message: 'x', disposition: 'other', pid: 1, ts: 'x' },
        { recordFile: nested },
      ),
    ).not.toThrow();
    expect(fs.existsSync(nested)).toBe(true);
  });
});

// ─── listenGuarded ────────────────────────────────────────────────────────────

describe('listenGuarded (BL-619)', () => {
  it('free port → { ok: true } and the server is listening', async () => {
    const { server, port } = await holdTcp();
    await closeServer(server); // release so it is free

    const srv = net.createServer();
    const outcome = await listenGuarded(srv, { port, host: '127.0.0.1' });
    try {
      expect(outcome.ok).toBe(true);
      expect(srv.listening).toBe(true);
    } finally {
      await closeServer(srv);
    }
  });

  it('port held → { ok:false, disposition:"already-running" } with failure.port/pid/code; listen never called (fast path)', async () => {
    const { server: holder, port } = await holdTcp();
    try {
      const srv = net.createServer();
      const outcome = await listenGuarded(srv, { port, host: '127.0.0.1' });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.disposition).toBe('already-running');
      expect(outcome.failure.port).toBe(port);
      expect(outcome.failure.pid).toBe(process.pid);
      expect(outcome.failure.code).toBe('EADDRINUSE');
      // Fast path: the probe found a live holder, so listen() was never invoked.
      expect(srv.listening).toBe(false);
    } finally {
      await closeServer(holder);
    }
  });

  it('UDS EADDRINUSE → { ok:false, "already-running" } without an unhandled error (error path)', async () => {
    const sock = tmpPath('held.sock');
    const holder = net.createServer();
    await new Promise<void>((res, rej) => {
      holder.once('error', rej);
      holder.listen(sock, res);
    });
    try {
      let uncaught: unknown = null;
      const onUncaught = (e: unknown) => { uncaught = e; };
      process.once('uncaughtException', onUncaught);
      try {
        const srv = net.createServer();
        const outcome = await listenGuarded(srv, { socketPath: sock });
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.disposition).toBe('already-running');
        expect(outcome.failure.socketPath).toBe(sock);
        // Give a tick for any stray unhandled 'error' to surface.
        await new Promise((r) => setTimeout(r, 20));
        expect(uncaught).toBeNull();
      } finally {
        process.removeListener('uncaughtException', onUncaught);
      }
    } finally {
      await closeServer(holder);
    }
  });

  it('UDS missing parent dir → { ok:false, disposition:"other" } (non-EADDRINUSE error path)', async () => {
    const missing = path.join(tmpPath('no-such-dir'), 'x.sock');
    const srv = net.createServer();
    const outcome = await listenGuarded(srv, { socketPath: missing });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.disposition).toBe('other');
    // The exact errno varies by platform (EACCES on darwin, ENOENT on linux) —
    // pin that it is a real bind error, and NOT the already-running disposition.
    expect(outcome.failure.code).toBeDefined();
    expect(outcome.failure.code).not.toBe('EADDRINUSE');
  });

  it('does not throw when listen fails (returns a resolved outcome)', async () => {
    const missing = path.join(tmpPath('gone'), 'x.sock');
    const srv = net.createServer();
    await expect(listenGuarded(srv, { socketPath: missing })).resolves.toMatchObject({ ok: false });
  });
});
