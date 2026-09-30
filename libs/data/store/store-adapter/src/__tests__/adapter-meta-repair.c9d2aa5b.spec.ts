/**
 * BL-336 / BL-341 — bounded attempts (owning uid
 * `c9d2aa5b-f5ba-4bc5-966c-98835dafb630`).
 *
 * The pre-fix `repairAdapterMeta` ran on EVERY open and failed every time
 * (~1300 `repair_failed` events/day). The fix bounds retries with an in-process
 * circuit breaker (exponential backoff 1→2→4→8→30 min, cap 5) plus a durable
 * sidecar marker so a RESTART does not restart the hammering.
 *
 * This suite drives the real `repairStoreIntegrity` path against a store whose
 * `_adapter_meta` holds a DISTINCT identity conflict (so every rebuild attempt
 * aborts deterministically), and proves:
 *   - after the cap no further attempt is made in-process;
 *   - the durable marker suppresses attempts for a "fresh process" (map
 *     cleared, marker retained); and
 *   - `resetAdapterMetaRepairBreakerForTest` restores attempts.
 *
 * Every test names `c9d2aa5b`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { createSqliteAdapter } from '../factory.js';
import { leaseDirPath } from '../store-lease.js';
import {
  verifyStoreIntegrity,
  repairStoreIntegrity,
  resetAdapterMetaRepairBreakerForTest,
} from '../integrity.js';
import type { StoreAdapter } from '../types.js';

const Database = require('better-sqlite3') as new (p: string) => BetterSqlite3Database;

const tmpDir = mkdtempSync(join(tmpdir(), 'adapter-meta-repair-c9d2aa5b-'));
let counter = 0;
function tempPath(): string {
  counter += 1;
  return join(tmpDir, `breaker-${counter}-${Date.now()}.db`);
}

const open: StoreAdapter[] = [];
afterEach(async () => {
  while (open.length > 0) {
    try {
      await open.pop()!.close();
    } catch {
      // already closed
    }
  }
  vi.useRealTimers();
});
function track<T extends StoreAdapter>(a: T): T {
  open.push(a);
  return a;
}

/** Seed `_adapter_meta` with a DISTINCT identity conflict — every rebuild
 *  attempt aborts before the transaction, so failures are deterministic. */
function seedIdentityConflict(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE _adapter_meta (key TEXT, value TEXT)`);
  db.exec(`
    INSERT INTO _adapter_meta (key, value) VALUES
      ('adapter_type', 'sqlite'),
      ('adapter_type', 'turso'),
      ('adapter_version', '0.13.1')
  `);
  db.close();
}

async function attempt(adapter: StoreAdapter) {
  const report = await verifyStoreIntegrity(adapter, { only: ['adapter_meta_unique'] });
  return repairStoreIntegrity(adapter, report, { only: ['adapter_meta_unique'] });
}

describe('c9d2aa5b — _adapter_meta rebuild attempts are bounded', () => {
  it('c9d2aa5b: after the cap, no further attempt in-process; reset restores it', async () => {
    const dbPath = tempPath();
    seedIdentityConflict(dbPath);
    const adapter = track(createSqliteAdapter({ dbPath }));
    const canonical = adapter.config.dbPath!;
    resetAdapterMetaRepairBreakerForTest(canonical);

    // Fake only `Date` so we can clear the exponential backoff deterministically
    // without waiting real minutes. Timers stay real (the adapter's idle-flush
    // interval must not be disturbed).
    const real = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(real);

    try {
      // Five attempts, each past the previous backoff window → each runs and
      // fails (identity conflict), after the cap the breaker trips.
      for (let i = 0; i < 5; i++) {
        vi.setSystemTime(real + i * 31 * 60_000);
        const rep = await attempt(adapter);
        expect(rep.actions[0]!.ok, `attempt ${i + 1} must fail`).toBe(false);
        expect(rep.actions[0]!.error).toMatch(/distinct value/);
      }

      // The durable marker was written on trip.
      const markerPath = join(leaseDirPath(canonical), 'adapter-meta-repair.json');
      expect(existsSync(markerPath), 'breaker trip writes the sidecar marker').toBe(true);
      const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
        attempts: number;
        storeIdentity: string;
      };
      expect(marker.attempts).toBe(5);
      expect(marker.storeIdentity).toMatch(/^\d+:\d+$/);

      // ── The 6th call is SKIPPED (cap reached), not attempted. ─────────────
      const rep6 = await attempt(adapter);
      expect(rep6.actions[0]!.ok).toBe(true);
      expect(rep6.actions[0]!.action).toMatch(/circuit breaker/i);

      // ── Fresh-process simulation: clear the in-process map but keep the
      //    marker; the next call is suppressed by the DURABLE marker. ────────
      resetAdapterMetaRepairBreakerForTest(); // no arg → clears the map only
      const rep7 = await attempt(adapter);
      expect(rep7.actions[0]!.ok).toBe(true);
      expect(rep7.actions[0]!.action).toMatch(/circuit breaker|skipped/i);

      // ── reset with the path clears both → attempts resume. ────────────────
      resetAdapterMetaRepairBreakerForTest(canonical);
      expect(existsSync(markerPath)).toBe(false);
      const rep8 = await attempt(adapter);
      expect(rep8.actions[0]!.ok).toBe(false); // attempted again, still fails
    } finally {
      vi.useRealTimers();
      resetAdapterMetaRepairBreakerForTest(canonical);
    }
  });

  it('c9d2aa5b: a healthy store never trips the breaker', async () => {
    const dbPath = tempPath();
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE _adapter_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.exec(`INSERT INTO _adapter_meta (key, value) VALUES ('adapter_type', 'sqlite')`);
    db.close();

    const adapter = track(createSqliteAdapter({ dbPath }));
    const canonical = adapter.config.dbPath!;
    resetAdapterMetaRepairBreakerForTest(canonical);

    const report = await verifyStoreIntegrity(adapter, { only: ['adapter_meta_unique'] });
    expect(report.damaged).toEqual([]);
    // No damage ⇒ repairStoreIntegrity is a no-op (verifyAndRepair's own gate),
    // so there is nothing to trip the breaker over.
    const rep = await repairStoreIntegrity(adapter, report, { only: ['adapter_meta_unique'] });
    expect(rep.actions).toEqual([]);
    expect(existsSync(join(leaseDirPath(canonical), 'adapter-meta-repair.json'))).toBe(false);
  });
});
