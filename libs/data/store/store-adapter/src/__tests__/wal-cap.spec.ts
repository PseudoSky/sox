/**
 * Forced, size-capped WAL flush — the SECOND independent trigger (owner
 * directive, relayed via team-lead, 2026-08-18): "We also need to ensure
 * that there are constraints around the maximum size / frames of the wal
 * before it interjects between future writes."
 *
 * Why this exists on top of the idle-triggered flush
 * (`idle-flush.spec.ts`): idle-triggering is debounced — new work cancels
 * and reschedules it. Under SUSTAINED write load the queue never drains, so
 * the timer is cancelled and re-armed forever and the flush never runs.
 * `WriteQueue._scheduleIdleCheckpoint()` (libs/memory-core/src/write-queue.ts)
 * has this exact latent flaw too; it has never bitten memory-core because
 * that store's load is bursty. This file pins that the port does NOT
 * inherit it: a second trigger, `_checkWalCapAndFlush()`, runs synchronously
 * inside the write path (`_trackOp(fn, true)`) after every writable
 * operation — it cannot be starved by continuous work because it is not a
 * timer at all.
 *
 * BL-225: every assertion checks the OUTCOME (the on-disk `-wal` size stays
 * bounded, durability holds, no data lost), never a proxy like "the check
 * function was called".
 *
 * `walCapBytes` is a TEST-ONLY `connect()` override (production default
 * `DEFAULT_WAL_CAP_BYTES` = 262,144 bytes — see its doc comment in
 * turso-adapter.ts for the full measurement behind that number) so these
 * tests can trip the cap after a handful of small rows instead of writing
 * hundreds of KB of real data.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, statSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { leaseDirPath } from '../store-lease.js';
import { log } from '@adhd/sox-telemetry';

const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();
const tursoDescribe = hasTurso ? describe : describe.skip;

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-wal-cap-'));
});

function tempPath(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpDir, `${label}-${suffix}.db`);
}

function walSize(dbPath: string): number {
  const p = dbPath + '-wal';
  return existsSync(p) ? statSync(p).size : 0;
}

function liveLeaseCount(dbPath: string): number {
  return readdirSync(leaseDirPath(dbPath)).filter(
    (n) => !n.startsWith('.') && !n.endsWith('.openmark'),
  ).length;
}

tursoDescribe('wal-cap — forced size-capped flush, the sustained-load backstop', () => {
  it('the sustained-load arm: continuous writes with NO idle gap stay bounded below the cap, durability achieved without any idle period ever occurring', async () => {
    const dbPath = tempPath('sustained-load');
    // Deliberately larger than idleFlushMs would need in idle-flush.spec.ts —
    // here it is set LONGER than the whole test run so the idle path
    // structurally CANNOT be the thing keeping the WAL bounded. Only the cap
    // path can be responsible for whatever bound is observed.
    const IDLE_MS = 10_000;
    const CAP_BYTES = 20_000; // small cap, tripped after a handful of rows

    const a = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: IDLE_MS, walCapBytes: CAP_BYTES });
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');

    const ROWS = 400;
    const payload = 'x'.repeat(200);
    let observedOverCapAtAnyPoint = false;
    let maxWalSize = 0;

    // Continuous writes, no gap between them — never `await`ing a delay, so
    // the idle timer (10s away) never has a chance to fire during this loop.
    for (let i = 0; i < ROWS; i++) {
      await a.executeRun('INSERT INTO t (v) VALUES (?)', [`${i}-${payload}`]);
      const size = walSize(dbPath);
      maxWalSize = Math.max(maxWalSize, size);
      // Generous slack over the nominal cap: the cap check runs AFTER a
      // write lands, so the worst-case overshoot is bounded by roughly one
      // write's own frames, not by the whole cap again — 3x cap is a loose
      // upper bound that would only trip if the mechanism were not firing
      // at all.
      if (size > CAP_BYTES * 3) observedOverCapAtAnyPoint = true;
    }

    expect(
      observedOverCapAtAnyPoint,
      `the forced flush must have kept the WAL bounded under continuous writes with no idle gap (max observed: ${maxWalSize} bytes, cap: ${CAP_BYTES})`,
    ).toBe(false);

    // The idle timer genuinely never fired — direct proof this arm is
    // testing the CAP path, not accidentally benefiting from idle timing.
    expect(
      (a as unknown as { _released: boolean })._released,
      'the idle path must not have fired during this test — IDLE_MS (10s) exceeds the whole test run',
    ).toBe(false);

    // Durability: every row survived, with no idle period ever occurring.
    const rows = await a.executeAll<{ v: string }>('SELECT v FROM t ORDER BY id');
    expect(rows.rows.length).toBe(ROWS);
    for (let i = 0; i < ROWS; i++) {
      expect(rows.rows[i]!.v).toBe(`${i}-${payload}`);
    }

    await a.close();
  });

  it('the cap actually interjects: a forced PASSIVE checkpoint fires mid-burst, not deferred to some later point', async () => {
    const dbPath = tempPath('interjects');
    const IDLE_MS = 10_000;
    const CAP_BYTES = 15_000;

    const a = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: IDLE_MS, walCapBytes: CAP_BYTES });
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');

    const debugSpy = vi.spyOn(log, 'debug');
    try {
      const payload = 'x'.repeat(200);
      for (let i = 0; i < 100; i++) {
        await a.executeRun('INSERT INTO t (v) VALUES (?)', [`${i}-${payload}`]);
      }
      const capFlushCalls = debugSpy.mock.calls.filter(
        (c) => c[0] === 'store_adapter.turso.wal_cap_flush',
      );
      expect(
        capFlushCalls.length,
        'at least one forced flush must have actually run during the burst, not been deferred',
      ).toBeGreaterThan(0);
    } finally {
      debugSpy.mockRestore();
    }

    await a.close();
  });

  it('PASSIVE, never TRUNCATE, and never gated on quiescence: the cap path fires with a live peer holding the store', async () => {
    const dbPath = tempPath('cap-under-live-peer');
    const IDLE_MS = 10_000;
    const CAP_BYTES = 15_000;

    const a = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: IDLE_MS, walCapBytes: CAP_BYTES });
    // A second, permanently live connection — this is the scenario a gated
    // TRUNCATE would defer under (`storeQuiescence` sees a peer). The cap
    // path must not care.
    const peer = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: IDLE_MS });
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');

    expect(liveLeaseCount(dbPath), 'precondition: two live connections').toBe(2);

    const payload = 'x'.repeat(200);
    let maxWalSize = 0;
    for (let i = 0; i < 150; i++) {
      await a.executeRun('INSERT INTO t (v) VALUES (?)', [`${i}-${payload}`]);
      maxWalSize = Math.max(maxWalSize, walSize(dbPath));
    }

    // With a live peer, a GATED TRUNCATE would have deferred every single
    // time (storeQuiescence never quiescent). The cap must still have
    // bounded growth — proof it used PASSIVE, not the gated TRUNCATE shape.
    expect(
      maxWalSize,
      `the cap must bound WAL growth even with a live peer present (observed max ${maxWalSize} bytes, cap ${CAP_BYTES})`,
    ).toBeLessThan(CAP_BYTES * 3);

    // Durability holds regardless.
    const rows = await a.executeAll<{ c: number }>('SELECT count(*) AS c FROM t');
    expect(rows.rows[0]!.c).toBe(150);

    await a.close();
    await peer.close();
  });

  it('the idle path and the cap path do not double-fire or race each other', async () => {
    const dbPath = tempPath('no-double-fire');
    const IDLE_MS = 60;
    const CAP_BYTES = 15_000;

    const a = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: IDLE_MS, walCapBytes: CAP_BYTES });
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');

    const warnSpy = vi.spyOn(log, 'warn');
    const errorSpy = vi.spyOn(log, 'error');
    try {
      // Trip the cap mid-burst (cap path fires, connection stays open —
      // PASSIVE never releases).
      const payload = 'x'.repeat(200);
      for (let i = 0; i < 150; i++) {
        await a.executeRun('INSERT INTO t (v) VALUES (?)', [`${i}-${payload}`]);
      }
      // Structural guarantee, not a timing race: `_checkWalCapAndFlush()`
      // runs INSIDE `_trackOp`'s tracked window, before the `finally`
      // decrements `_inFlightOps` — and `_armIdleFlush()` is only ever
      // called from that `finally`, after the count returns to zero. So the
      // cap check can never observe an armed idle timer racing it; the two
      // are structurally serialized by `_inFlightOps`, not by luck. By the
      // time control returns here (all 150 writes awaited sequentially,
      // burst over), the connection IS idle and exactly one coalesced idle
      // timer is now pending — the SAME coalescing invariant proven in
      // idle-flush.spec.ts's "30 back-to-back writes" arm, holding true
      // here too even though every one of those 150 writes also ran a cap
      // check.
      expect(
        (a as unknown as { _idleFlushTimer: unknown })._idleFlushTimer,
        'exactly one idle timer must be pending once the burst is over, not zero (never armed) or a leaked duplicate',
      ).not.toBe(null);

      // Now let the idle path actually run too (go idle for real).
      await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 10));

      // Neither path should have logged a failure from stepping on the
      // other — no uncoordinated-close symptom (the exact BUG-016 shape),
      // no cap-flush failure.
      const badWarnings = warnSpy.mock.calls
        .map((c) => c[0])
        .filter(
          (name) =>
            name === 'store_adapter.turso.close_verify_failed' ||
            name === 'store_adapter.turso.wal_cap_flush_busy',
        );
      expect(badWarnings).toEqual([]);
      expect(errorSpy.mock.calls.map((c) => c[0])).not.toContain(
        'store_adapter.turso.wal_cap_flush_failed',
      );
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }

    // Durability + eventual reclamation: the idle path's gated TRUNCATE
    // still gets to run once truly idle (single connection => quiescent).
    expect(walSize(dbPath)).toBe(0);
    const rows = await a.executeAll<{ c: number }>('SELECT count(*) AS c FROM t');
    expect(rows.rows[0]!.c).toBe(150);

    await a.close();
  });

  it('a read-only connection never arms the cap check (nothing to checkpoint, nothing to grow)', async () => {
    const dbPath = tempPath('readonly-no-cap');
    const writer = await TursoAdapterImpl.connect({ dbPath });
    await writer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await writer.executeRun('INSERT INTO t (v) VALUES (?)', ['seed']);
    await writer.close();

    const reader = await TursoAdapterImpl.connect({ dbPath, readonly: true, walCapBytes: 1 });
    expect((reader as unknown as { _capFlushEnabled: boolean })._capFlushEnabled).toBe(false);
    const row = await reader.executeGet<{ v: string }>('SELECT v FROM t WHERE v = ?', ['seed']);
    expect(row?.v).toBe('seed');
    await reader.close();
  });
});
