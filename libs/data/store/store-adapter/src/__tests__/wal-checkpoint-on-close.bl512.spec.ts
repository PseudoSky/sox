/**
 * BL-512 — the WAL never consolidates on a writable close.
 *
 * Defect (owner-directed fix, confirmed 2026-08-12): `TursoAdapterImpl.close()`
 * only ran `PRAGMA wal_checkpoint(PASSIVE)` when `verifyStoreIntegrity` reported
 * a damaged `wal_identity` finding. On a clean writable close it just marked
 * clean shutdown and closed — so every short-lived process (the backlog CLI
 * spawns one process per command) left its writes in the WAL. The WAL grew
 * without bound (measured 3.8 MB on the live store vs a 19 MB db file), and a
 * later connection's stale-`-tshm` reconciliation could discard those
 * uncheckpointed frames — the phantom-write class (CLI reported created:true,
 * the row never persisted; 4+ items lost on the live store).
 *
 * The fix: a writable close must ALWAYS `PRAGMA wal_checkpoint(TRUNCATE)` — not
 * just on the damage path, and TRUNCATE rather than PASSIVE so the `-wal` file
 * is reset to ~0 bytes and the next open neither replays nor re-accumulates.
 * `_softReadonly` adapters hold a driver-writable connection (BL-391 — FTS
 * requires it), so they checkpoint too; a hard `readonly` open never does.
 *
 * What this file pins (real engine, tursoDescribe — skipped only when the
 * driver is absent, like every other spec in this package):
 *  1. After a writable close, the `-wal` file is ~0 bytes — the discriminating
 *     assertion that is IMPOSSIBLE without the fix (a clean close previously
 *     left every frame in the WAL, size > 0).
 *  2. The row lives in the MAIN db file: a fresh open against the truncated
 *     (empty) WAL still sees it — no WAL replay is carrying the write.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TursoAdapterImpl } from '../turso-adapter.js';
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
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-bl512-'));
});

function tempPath(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpDir, `${label}-${suffix}.db`);
}

tursoDescribe('BL-512 — a writable close() always checkpoints the WAL into the main db and truncates it', () => {
  it('close() resets the -wal to ~0 bytes and the row survives a fresh open with no WAL replay', async () => {
    const dbPath = tempPath('bl512-truncate-on-close');
    const a = await TursoAdapterImpl.connect({ dbPath });
    try {
      await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      await a.executeRun('INSERT INTO t (v) VALUES (?)', ['persist-me']);

      // Precondition: the write really did land in the WAL — an uncheckpointed
      // frame, exactly the state every short-lived CLI process leaves behind.
      const walPath = dbPath + '-wal';
      expect(existsSync(walPath), 'the write must have created the -wal file').toBe(true);
      expect(
        statSync(walPath).size,
        'precondition: the WAL must hold the uncheckpointed frame',
      ).toBeGreaterThan(0);
    } finally {
      await a.close();
    }

    // THE assertion that cannot pass without the fix: a clean writable close
    // previously ran NO checkpoint at all, leaving the frame in the WAL
    // (size > 0). The fix runs wal_checkpoint(TRUNCATE) on every writable
    // close, so the -wal is reset to ~0 bytes — no uncheckpointed window
    // survives the process that wrote it.
    const walPath = dbPath + '-wal';
    const walSize = existsSync(walPath) ? statSync(walPath).size : 0;
    expect(
      walSize,
      'BL-512: close() must TRUNCATE-checkpoint the WAL to ~0 bytes on a writable close',
    ).toBe(0);

    // And the row itself is in the MAIN db file: a fresh open against the
    // truncated (empty) WAL — which SQLite does not replay — must still see it.
    const b = await TursoAdapterImpl.connect({ dbPath });
    try {
      const row = await b.executeGet<{ id: number; v: string }>(
        'SELECT id, v FROM t WHERE v = ?',
        ['persist-me'],
      );
      expect(
        row,
        'the write must survive close() in the main db file, not be carried by the WAL',
      ).not.toBeNull();
      expect(row!.v).toBe('persist-me');
    } finally {
      await b.close();
    }
  });

  it('BL-512: with a concurrent reader holding the WAL, close() logs the busy row and still succeeds — frames stay durable', async () => {
    const dbPath = tempPath('bl512-busy-on-close');
    const writer = await TursoAdapterImpl.connect({ dbPath });
    await writer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await writer.exec('INSERT INTO t (v) VALUES (\'persist-me\')');

    // A second connection holds an OPEN read transaction — the WAL read lock
    // is held across the writer's close(), so wal_checkpoint(TRUNCATE) must
    // degrade to busy=1 (returned, not thrown — verified against the live
    // @tursodatabase/database 0.7.1: [{busy:1,log:null,checkpointed:null}]).
    const reader = await TursoAdapterImpl.connect({ dbPath });
    await reader.exec('BEGIN');
    await reader.executeGet('SELECT count(*) AS c FROM t');

    const warnSpy = vi.spyOn(log, 'warn');
    try {
      // close() must NOT throw, hang, or drop the write — busy TRUNCATE is a
      // durability-safe degradation (frames are fsynced at COMMIT).
      await writer.close();
      expect(warnSpy.mock.calls.map((c) => c[0])).toContain(
        'store_adapter.turso.close_checkpoint_busy',
      );
    } finally {
      warnSpy.mockRestore();
      await reader.exec('ROLLBACK');
      await reader.close();
    }

    // Durability holds: a fresh open still sees the row — even though the
    // busy TRUNCATE left the WAL untruncated, the frames were never lost.
    const b = await TursoAdapterImpl.connect({ dbPath });
    try {
      const row = await b.executeGet<{ id: number; v: string }>(
        'SELECT id, v FROM t WHERE v = ?',
        ['persist-me'],
      );
      expect(
        row,
        'the write must survive a busy close — frames are durable, only truncation degraded',
      ).not.toBeNull();
      expect(row!.v).toBe('persist-me');
    } finally {
      await b.close();
    }
  });
});
