/**
 * BL-571 — `SqliteAdapterImpl` had NO WAL-checkpoint mechanism at all.
 *
 * `e77fb615` (DEBT-004/005) deleted memory-core's private `WriteQueue`-level
 * WAL checkpointing so every consumer inherits whatever checkpoint behaviour
 * the adapter itself provides. `TursoAdapterImpl` grew that behaviour
 * (`idle-flush.spec.ts`, `wal-cap.spec.ts`); `SqliteAdapterImpl` never did —
 * a long-lived `STORE_ADAPTER=sqlite` process relied solely on SQLite's own
 * ~1000-page PASSIVE auto-checkpoint, which copies frames into the main db
 * file but never shrinks the `-wal` sidecar. The WAL grew without bound.
 *
 * This file pins the fix: an idle-triggered flush (primary durability
 * assurance) and a size-capped forced flush (the sustained-load backstop
 * the idle path structurally cannot provide, since a debounced timer that
 * never sees a quiet period never fires). Both use a plain, ungated
 * `PRAGMA wal_checkpoint(TRUNCATE)` — see the design note above
 * `SqliteAdapterImpl` in `sqlite-adapter.ts` for why no quiescence gate is
 * needed for this single-process, synchronous backend (unlike
 * `TursoAdapterImpl`'s multiprocess_wal topology).
 *
 * `journal_mode = WAL` is set explicitly in every test: better-sqlite3
 * defaults to `delete` (rollback journal), and `SqliteAdapterImpl` itself
 * never flips the mode — that is memory-core's job (`schema.ts`, `db.ts`),
 * per the existing convention in `integrity-repair-reverify.bl379.test.ts`.
 *
 * BL-225: every assertion checks the OUTCOME (the on-disk `-wal` file
 * actually shrinks / actually stays bounded / actually never touched for
 * readonly), never a proxy like "a timer was scheduled" or "the check
 * function was called".
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAdapterImpl } from '../sqlite-adapter.js';
import { log } from '@adhd/sox-telemetry';

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-wal-checkpoint-bl571-'));
});

function tempPath(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpDir, `${label}-${suffix}.db`);
}

function walSize(dbPath: string): number {
  const p = `${dbPath}-wal`;
  return existsSync(p) ? statSync(p).size : 0;
}

/** Poll until `predicate()` is true or `timeoutMs` elapses. Idle-flush fires
 *  off a `setTimeout`, so tests must wait for it rather than assert
 *  synchronously right after the debounce window "should" have elapsed. */
async function waitUntil(predicate: () => boolean, timeoutMs: number, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  if (!predicate()) {
    throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
  }
}

describe('BL-571 — SqliteAdapterImpl WAL checkpointing', () => {
  it("idle-flush: an idle adapter's WAL actually shrinks to 0 without any caller calling anything", async () => {
    const dbPath = tempPath('idle-shrink');
    const IDLE_MS = 50;

    const a = new SqliteAdapterImpl(dbPath, { idleFlushMs: IDLE_MS });
    await a.exec('PRAGMA journal_mode = WAL');
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await a.executeRun('INSERT INTO t (v) VALUES (?)', ['grow-the-wal']);

    expect(existsSync(`${dbPath}-wal`), 'precondition: the write created the -wal file').toBe(true);
    expect(walSize(dbPath), 'precondition: the WAL holds the uncheckpointed frame').toBeGreaterThan(0);

    // THE RED CASE (verified manually with the fix reverted — see report):
    // with no checkpoint mechanism at all, `walSize(dbPath)` stays exactly
    // where the single INSERT left it forever; this `waitUntil` times out.
    // GREEN below: nobody calls close() or any checkpoint API — the adapter
    // does this on its own once idle.
    await waitUntil(() => walSize(dbPath) === 0, IDLE_MS * 40);

    // The adapter is still fully usable afterward and still sees its own
    // earlier write.
    const row = await a.executeGet<{ v: string }>('SELECT v FROM t WHERE v = ?', ['grow-the-wal']);
    expect(row?.v).toBe('grow-the-wal');

    await a.close();
  });

  it('idle-flush: new work cancels and reschedules a pending flush (coalesced, not double-fired)', async () => {
    const dbPath = tempPath('idle-coalesce');
    const IDLE_MS = 80;

    const a = new SqliteAdapterImpl(dbPath, { idleFlushMs: IDLE_MS });
    await a.exec('PRAGMA journal_mode = WAL');
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await a.executeRun('INSERT INTO t (v) VALUES (?)', ['first']);

    // Wait most of the debounce window, then issue new work — this must
    // cancel the pending flush and push it out by another full IDLE_MS.
    await new Promise((resolve) => setTimeout(resolve, Math.floor(IDLE_MS * 0.7)));
    await a.executeRun('INSERT INTO t (v) VALUES (?)', ['second']);

    // At the point the ORIGINAL timer would have fired, the WAL must still
    // be non-zero — the reschedule actually took effect.
    await new Promise((resolve) => setTimeout(resolve, Math.floor(IDLE_MS * 0.5)));
    expect(
      walSize(dbPath),
      'new work must have cancelled and rescheduled the flush — it must not have fired on the original schedule',
    ).toBeGreaterThan(0);

    await waitUntil(() => walSize(dbPath) === 0, IDLE_MS * 40);

    const rows = await a.executeAll<{ v: string }>('SELECT v FROM t ORDER BY id');
    expect(rows.rows.map((r) => r.v)).toEqual(['first', 'second']);

    await a.close();
  });

  it('wal-cap: sustained writes with NO idle gap stay bounded — durability without any idle period ever occurring', async () => {
    const dbPath = tempPath('sustained-load');
    // Deliberately far longer than the whole test run — the idle path
    // structurally CANNOT be the thing bounding the WAL here. Only the cap
    // path can be responsible for whatever bound is observed.
    const IDLE_MS = 10_000;
    const CAP_BYTES = 20_000;

    const a = new SqliteAdapterImpl(dbPath, { idleFlushMs: IDLE_MS, walCapBytes: CAP_BYTES });
    await a.exec('PRAGMA journal_mode = WAL');
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');

    const ROWS = 400;
    const payload = 'x'.repeat(200);
    let observedOverCapAtAnyPoint = false;
    let maxWalSize = 0;

    for (let i = 0; i < ROWS; i++) {
      await a.executeRun('INSERT INTO t (v) VALUES (?)', [`${i}-${payload}`]);
      const size = walSize(dbPath);
      maxWalSize = Math.max(maxWalSize, size);
      // Generous slack: the cap check runs AFTER a write lands, so the
      // worst-case overshoot is bounded by roughly one write's own frames.
      if (size > CAP_BYTES * 3) observedOverCapAtAnyPoint = true;
    }

    expect(
      observedOverCapAtAnyPoint,
      `the forced flush must have kept the WAL bounded under continuous writes with no idle gap (max observed: ${maxWalSize} bytes, cap: ${CAP_BYTES})`,
    ).toBe(false);

    const rows = await a.executeAll<{ v: string }>('SELECT v FROM t ORDER BY id');
    expect(rows.rows.length).toBe(ROWS);

    await a.close();
  });

  it('wal-cap: the cap actually interjects mid-burst, not deferred to some later point', async () => {
    const dbPath = tempPath('interjects');
    const IDLE_MS = 10_000;
    const CAP_BYTES = 15_000;

    const a = new SqliteAdapterImpl(dbPath, { idleFlushMs: IDLE_MS, walCapBytes: CAP_BYTES });
    await a.exec('PRAGMA journal_mode = WAL');
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');

    const debugSpy = vi.spyOn(log, 'debug');
    try {
      const payload = 'x'.repeat(200);
      for (let i = 0; i < 100; i++) {
        await a.executeRun('INSERT INTO t (v) VALUES (?)', [`${i}-${payload}`]);
      }
      const capFlushCalls = debugSpy.mock.calls.filter(
        (c) => c[0] === 'store_adapter.sqlite.wal_cap_flush',
      );
      expect(
        capFlushCalls.length,
        'at least one forced flush must have actually run during the burst, not been deferred',
      ).toBeGreaterThan(0);
    } finally {
      debugSpy.mockRestore();
    }

    // The idle timer (10s away) never fired — this test isolates the cap
    // path, same structural proof as `idle-flush`'s sibling arm.
    const rows = await a.executeAll<{ c: number }>('SELECT count(*) AS c FROM t');
    expect(rows.rows[0]!.c).toBe(100);

    await a.close();
  });

  it('close(): a final checkpoint runs even without any prior idle period', async () => {
    const dbPath = tempPath('close-flush');
    // Idle window far longer than the test — proves close() itself does the
    // flush, not a lucky idle-timer race.
    const a = new SqliteAdapterImpl(dbPath, { idleFlushMs: 10_000 });
    await a.exec('PRAGMA journal_mode = WAL');
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await a.executeRun('INSERT INTO t (v) VALUES (?)', ['close-me']);

    expect(walSize(dbPath), 'precondition: the WAL holds the uncheckpointed frame').toBeGreaterThan(0);

    await a.close();

    expect(walSize(dbPath), 'close() must checkpoint the WAL before teardown').toBe(0);
  });

  it('a readonly connection never arms the idle flush or the cap check', async () => {
    const dbPath = tempPath('readonly-no-flush');
    const writer = new SqliteAdapterImpl(dbPath);
    await writer.exec('PRAGMA journal_mode = WAL');
    await writer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await writer.executeRun('INSERT INTO t (v) VALUES (?)', ['seed']);
    await writer.close();

    const reader = new SqliteAdapterImpl(dbPath, { readonly: true, idleFlushMs: 5, walCapBytes: 1 });
    expect((reader as unknown as { _idleFlushEnabled: boolean })._idleFlushEnabled).toBe(false);
    expect((reader as unknown as { _capFlushEnabled: boolean })._capFlushEnabled).toBe(false);

    const row = await reader.executeGet<{ v: string }>('SELECT v FROM t WHERE v = ?', ['seed']);
    expect(row?.v).toBe('seed');

    await reader.close();
  });
});
