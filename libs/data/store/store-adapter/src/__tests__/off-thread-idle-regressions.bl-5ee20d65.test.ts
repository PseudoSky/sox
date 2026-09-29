/**
 * BL-5ee20d65 / TUR-D idle-release regressions (off-thread driver host).
 *
 * Packet TUR-D (commit `fdd2e61b`, plan `862129b5`) moved the Turso adapter's
 * driver onto the process-wide off-thread worker. That rewire widened three
 * pre-existing windows from "a synchronous in-thread call" to "an async worker
 * RPC plus a lease unlink", and this spec pins the two idle-release ones
 * deterministically (the third — the FTS `optimize.finish` → `_lastFtsOptimize`
 * window — stays pinned by `fts-optimize-bounded-segments.4cd68c4e.spec.ts`,
 * which is the spec that actually observes the pass):
 *
 *  1. BL-5ee20d65 (bug) — `releaseIdleConnection()` set `_released` only AFTER
 *     `_closeConnection()` fully returned. `_closeConnectionBody` awaits
 *     `this.db.close()` (a worker round-trip) and then — still inside its
 *     `finally` — awaits `this._lease.release()` (an fs unlink). For the whole
 *     of that second await `this.db` is a CLOSED host connection while
 *     `_released` is still false, so an operation landing there ran
 *     `_ensureHealthy()` (early-return: not poisoned / not released / not
 *     never-opened), issued its query against the closed handle, and got
 *     `E_TURSO_DRIVER_WORKER_EXITED` — which `isFatalConnectionError` now
 *     classifies fatal, poisoning the adapter. Fixed by making the teardown
 *     state observable BEFORE the driver closes: a `_releaseInFlight` promise
 *     `_ensureHealthy()` awaits, so an op in the window WAITS for the release
 *     and then reconnects, instead of racing the close.
 *
 *  2. BL-cfed929d (debt) — `DriverConnectionImpl.close()` calls
 *     `host.forgetConnection()`, and the host terminates its worker whenever
 *     the last connection is forgotten and nothing is in flight
 *     (`maybeDispose`). Nothing pinned the worker across a RELEASED-but-usable
 *     adapter, so the idle release→reopen cycle paid a full worker (re)spawn
 *     (`idle-release-writefree`'s T1 250 ms budget; observed 341 ms on the
 *     regressed tree). Fixed with a host-side hold refcount that an adapter
 *     keeps for as long as it may reopen (taken on a successful open, released
 *     by the final `close()`), so the singleton worker outlives an idle release.
 *
 * Every assertion is an OUTCOME (BL-225): the op's real settlement, the live
 * worker's identity — never a proxy like "a flag was set".
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { log } from '@adhd/sox-telemetry';
import { TursoAdapterImpl } from '../turso-adapter.js';
import type { StoreLease } from '../store-lease.js';

const require = createRequire(import.meta.url);
const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();
const tursoDescribe = hasTurso ? describe : describe.skip;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bl-5ee20d65-'));
});

function tempPath(label: string): string {
  return join(tmpDir, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}

tursoDescribe('BL-5ee20d65 / TUR-D — off-thread idle-release regressions', () => {
  it('BL-5ee20d65: an operation landing while a release tears the connection down must WAIT for it and reconnect — never run on the closed host connection', async () => {
    const dbPath = tempPath('release-op-race');
    const a = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: 600_000 });
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await a.executeRun('INSERT INTO t (v) VALUES (?)', ['before-release']);
    // A real open has happened, so the instance holds its own live lease.
    const lease = (a as unknown as { _lease: StoreLease | null })._lease;
    expect(lease, 'precondition: the adapter holds a lease after a real op').not.toBeNull();

    // Pin the release INSIDE its final window: the driver connection is already
    // closed (this mock fires only after `this.db.close()` resolved) while
    // `_released` is still false (it is set after `_closeConnection()` returns).
    // This is the exact async gap TUR-D widened into a reliable hit.
    const origRelease = lease!.release;
    let entered!: () => void;
    const atWindow = new Promise<void>((r) => {
      entered = r;
    });
    let openGate!: () => void;
    const gate = new Promise<void>((r) => {
      openGate = r;
    });
    const releaseSpy = vi.spyOn(lease!, 'release').mockImplementation(async function (this: StoreLease) {
      entered();
      await gate;
      return origRelease.call(this);
    });

    let releaseP: Promise<boolean> | undefined;
    try {
      releaseP = a.releaseIdleConnection();
      await atWindow; // now: this.db is CLOSED, _released is still false

      const opP = a.executeGet<{ one: number }>('SELECT 1 AS one');
      // The buggy tree rejects here almost immediately (the op ran on the
      // closed handle). The fixed tree leaves it pending — it is waiting on
      // the release it must not race — until we open the gate below.
      const early = await Promise.race([
        opP.then(
          () => 'settled' as const,
          () => 'rejected' as const,
        ),
        sleep(150).then(() => 'pending' as const),
      ]);

      openGate();
      expect(await releaseP, 'the release completes').toBe(true);

      expect(
        early,
        'an op issued during the release window must wait for the release, ' +
          'not execute against the already-closed driver connection',
      ).toBe('pending');

      const row = await opP;
      expect(row?.one, 'the waited op reconnects transparently and succeeds').toBe(1);
      expect(
        (a as unknown as { _poisoned: boolean })._poisoned,
        'a wait-then-reconnect must not poison the adapter',
      ).toBe(false);
      expect(a.connectionHealth).toBe('healthy');
    } finally {
      openGate();
      if (releaseP !== undefined) await releaseP.catch(() => undefined);
      releaseSpy.mockRestore();
      await a.close().catch(() => undefined);
      rmSync(dbPath + '.sox-lease.d', { recursive: true, force: true });
    }
  }, 30_000);

  it('BL-cfed929d: the process-wide driver worker survives an idle release — no respawn on the next operation', async () => {
    const dbPath = tempPath('worker-hold');
    const a = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: 600_000 });
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await a.executeGet('SELECT 1 AS one');

    const before = a.driverStatus.workerThreadId;
    expect(before, 'precondition: a real open spawned the worker').not.toBeNull();

    // An idle release drops the DRIVER CONNECTION (so a peer's close-time
    // TRUNCATE can find the store quiescent) — but must NOT drop the worker:
    // tearing it down makes the very next op pay a full spin-up, which is the
    // release-then-reopen regression (BL-1010e417's write-free reopen).
    expect(await a.releaseIdleConnection()).toBe(true);
    expect(
      a.driverStatus.workerThreadId,
      'the singleton driver worker must outlive an idle release',
    ).toBe(before);

    // The next op reuses the SAME worker — the held adapter keeps it pinned.
    const row = await a.executeGet<{ one: number }>('SELECT 1 AS one');
    expect(row?.one).toBe(1);
    expect(a.driverStatus.workerThreadId, 'the reopen reused the held worker').toBe(before);

    await a.close();
    rmSync(dbPath + '.sox-lease.d', { recursive: true, force: true });
  }, 30_000);

  it('BL-c5eb649a: the FTS optimize outcome is published BEFORE the awaited pass-count write — fts.optimize.finish is never observable with ftsMaintenance.last === null', async () => {
    const dbPath = tempPath('fts-state-publish');
    const seed = await TursoAdapterImpl.connect({ dbPath });
    await seed.exec('CREATE TABLE node (id INTEGER PRIMARY KEY, content TEXT)');
    await seed.exec('CREATE INDEX idx_fts_node ON node USING fts (content)');
    await seed.close();

    // Park the pass-count write (an off-thread RPC on the TUR-D tree) on a
    // gate. It is called AFTER `_optimizeAllFtsIndexes` has logged
    // `fts.optimize.finish` and — before the fix — BEFORE `_lastFtsOptimize`
    // was assigned. Gating it makes the finish→state window observable
    // deterministically instead of by a flaky sleep race.
    const proto = TursoAdapterImpl.prototype as unknown as Record<
      string,
      (...a: unknown[]) => Promise<void>
    >;
    const origCount = proto['_countInServiceOptimizePass']!;
    let atCountResolve!: () => void;
    const atCount = new Promise<void>((r) => {
      atCountResolve = r;
    });
    let openGate!: () => void;
    const gate = new Promise<void>((r) => {
      openGate = r;
    });
    let gated = false;
    const countSpy = vi
      .spyOn(proto, '_countInServiceOptimizePass')
      .mockImplementation(async function (this: unknown, ...args: unknown[]) {
        if (!gated) {
          gated = true;
          atCountResolve();
          await gate;
        }
        return origCount.apply(this, args);
      });

    const a = await TursoAdapterImpl.connect({
      dbPath,
      idleFlushMs: 150,
      ftsOptimizeWriteThreshold: 5,
    });
    const infoSpy = vi.spyOn(log, 'info');
    try {
      for (let i = 0; i < 10; i++) {
        await a.executeRun('INSERT INTO node (content) VALUES (?)', [
          `row ${i} alpha beta gamma delta epsilon zeta`,
        ]);
      }
      await Promise.race([
        atCount,
        sleep(20_000).then(() => {
          throw new Error('the in-service optimize pass never reached its pass-count write');
        }),
      ]);
      expect(
        infoSpy.mock.calls.some(([e]) => e === 'fts.optimize.finish'),
        'precondition: the pass finished (its finish log fired)',
      ).toBe(true);
      // The window: finish has fired, the count write is parked, and the
      // outcome must already be published.
      expect(
        a.ftsMaintenance.last,
        'ftsMaintenance.last must be set by the time fts.optimize.finish is observable, ' +
          'not only after the awaited pass-count write returns',
      ).toMatchObject({ status: 'optimized', indexes: ['idx_fts_node'] });
    } finally {
      openGate();
      countSpy.mockRestore();
      infoSpy.mockRestore();
      await a.close().catch(() => undefined);
      rmSync(dbPath + '.sox-lease.d', { recursive: true, force: true });
    }
  }, 30_000);
});
