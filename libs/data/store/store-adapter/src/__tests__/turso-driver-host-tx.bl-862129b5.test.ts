/**
 * turso-driver-host-tx.bl-862129b5.test.ts — packet TUR-C, plan `862129b5`.
 *
 * A transaction opened through the worker-hosted connection must behave exactly
 * as it does in-thread, because the host forwards every request over ONE FIFO
 * port on ONE connection — arrival order is preserved, so a non-transaction
 * statement issued while a transaction is open lands INSIDE it (the plan's
 * "preserves today's interleaving" requirement). Three arms:
 *
 *   1. rollback on throw — neither insert is visible afterwards, and the error
 *      the caller threw reaches it by identity (the host never re-wraps it);
 *   2. commit on pass — both inserts are visible;
 *   3. the interleaving arm — a non-transaction `run` issued during the open
 *      transaction rolls back with it, proving FIFO arrival order rather than a
 *      per-call independent connection;
 *   4. worker death mid-transaction — every pending call rejects with the fatal
 *      `E_TURSO_DRIVER_WORKER_EXITED` (which `errors.ts`'s
 *      `isFatalConnectionError` classifies as `fatal_connection`, the signal the
 *      adapter's reconnect path keys on), the uncommitted rows are discarded,
 *      and the next `openTursoConnection` respawns the worker.
 *
 * The worker-death arm uses the host's documented test seam
 * (`_killWorkerForTest`) to terminate the worker with no pending request — a
 * stand-in for a native crash. `worker.terminate()` cannot interrupt a thread
 * parked in native code, which is exactly why the plan makes an external kill
 * the bound; between operations the thread is idle, so it is deterministic.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { isFatalConnectionError } from '../errors.js';

const require = createRequire(import.meta.url);
const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch (err) {
    process.stderr.write(`[turso-driver-host-tx test] driver unavailable: ${String(err)}\n`);
    return false;
  }
})();
const itTurso = hasTurso ? it : it.skip;

type HostModule = typeof import('../turso-driver-host.js');
type Connection = Awaited<ReturnType<HostModule['openTursoConnection']>>;

const HOST_SLOT = Symbol.for('@adhd/sox-store-adapter/turso-driver-host');

interface SlotShape {
  protocol: number;
  host: { _resetForTest(): Promise<void>; _killWorkerForTest(): void };
}

function slot(): SlotShape | undefined {
  return (globalThis as unknown as Record<symbol, SlotShape | undefined>)[HOST_SLOT];
}

async function freshHost(): Promise<HostModule> {
  vi.resetModules();
  return (await import('../turso-driver-host.js')) as HostModule;
}

async function resetHost(): Promise<void> {
  const s = slot();
  if (s !== undefined) await s.host._resetForTest();
  delete (globalThis as unknown as Record<symbol, unknown>)[HOST_SLOT];
}

const OPEN_OPTS: Record<string, unknown> = {
  experimental: ['index_method', 'multiprocess_wal'],
  timeout: 5_000,
};

const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
    await sleep(20);
  }
}

let dir: string;
let seq = 0;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'turso-driver-host-tx-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
afterEach(async () => {
  await resetHost();
});

function dbPath(label: string): string {
  seq += 1;
  return join(dir, `${label}-${seq}.db`);
}

async function openWithTable(host: HostModule, label: string): Promise<{ conn: Connection; path: string }> {
  const path = dbPath(label);
  const conn = await host.openTursoConnection(path, OPEN_OPTS);
  await conn.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  return { conn, path };
}

describe('turso-driver-host — transaction semantics across the worker boundary', () => {
  itTurso('rolls back on throw: neither insert remains visible, and the caller error keeps its identity', async () => {
    const host = await freshHost();
    const { conn } = await openWithTable(host, 'rb');

    const boom = new Error('transaction body exploded');
    let caught: unknown;
    await conn.exec('BEGIN');
    try {
      await conn.run('INSERT INTO t (v) VALUES (?)', 'A');
      await sleep(50);
      await conn.run('INSERT INTO t (v) VALUES (?)', 'B');
      throw boom;
    } catch (err: unknown) {
      caught = err;
      await conn.exec('ROLLBACK');
    }

    expect(caught).toBe(boom);
    expect(await conn.all('SELECT * FROM t')).toHaveLength(0);
    await conn.close();
  });

  itTurso('commits on pass: both inserts are visible', async () => {
    const host = await freshHost();
    const { conn } = await openWithTable(host, 'commit');

    await conn.exec('BEGIN');
    await conn.run('INSERT INTO t (v) VALUES (?)', 'A');
    await conn.run('INSERT INTO t (v) VALUES (?)', 'B');
    await conn.exec('COMMIT');

    const rows = await conn.all('SELECT v FROM t ORDER BY v');
    expect(rows.map((r) => r['v'])).toEqual(['A', 'B']);
    await conn.close();
  });

  itTurso('a non-transaction run inside the open transaction rolls back with it (FIFO arrival order)', async () => {
    const host = await freshHost();
    const { conn } = await openWithTable(host, 'interleave');

    await conn.exec('BEGIN');
    await conn.run('INSERT INTO t (v) VALUES (?)', 'A');
    // Issued in the gap while the transaction is still open — a different
    // logical caller reusing the same worker-hosted connection.
    const interloper = conn.run('INSERT INTO t (v) VALUES (?)', 'C');
    await sleep(50);
    await conn.run('INSERT INTO t (v) VALUES (?)', 'B');
    // The interloper really did execute inside the transaction (it was accepted,
    // not deferred to a new connection)…
    await expect(interloper).resolves.toMatchObject({ changes: 1 });
    await conn.exec('ROLLBACK');

    // …and therefore rolls back with it.
    expect(await conn.all('SELECT * FROM t')).toHaveLength(0);
    await conn.close();
  });

  itTurso('worker killed mid-transaction: fatal error, no partial rows, next open respawns', async () => {
    const host = await freshHost();
    const { conn, path } = await openWithTable(host, 'kill');
    const firstThread = host.getTursoDriverStatus().workerThreadId;
    expect(firstThread).not.toBeNull();

    await conn.exec('BEGIN');
    await conn.run('INSERT INTO t (v) VALUES (?)', 'partial');

    const s = slot();
    expect(s).toBeDefined();
    s!.host._killWorkerForTest();
    await waitFor(() => host.getTursoDriverStatus().exits === 1, 5_000, 'unexpected worker exit');

    expect(host.getTursoDriverStatus().state).toBe('exited');
    expect(host.getTursoDriverStatus().workerThreadId).toBeNull();

    // A call on the dead connection is FATAL, by the marker `errors.ts` now
    // recognizes — this is the exact signal the adapter's reconnect keys on.
    let caught: unknown;
    try {
      await conn.run('SELECT 1');
    } catch (err: unknown) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe('E_TURSO_DRIVER_WORKER_EXITED');
    expect(isFatalConnectionError(caught)).toBe(true);

    // The next open respawns the worker; the killed transaction left no rows.
    const reopened = await host.openTursoConnection(path, OPEN_OPTS);
    const status = host.getTursoDriverStatus();
    expect(status.exits).toBe(1);
    expect(status.state).not.toBe('exited');
    expect(status.workerThreadId).not.toBeNull();
    expect(status.workerThreadId).not.toBe(firstThread);
    expect(await reopened.all('SELECT * FROM t')).toHaveLength(0);

    await conn.close();
    await reopened.close();
  });
});
