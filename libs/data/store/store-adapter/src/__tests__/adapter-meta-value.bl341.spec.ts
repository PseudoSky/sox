/**
 * BL-341 — `_adapter_meta` VALUE damage (owning uid `BL-341`; the live symptom
 * `deep_verify.state_read_failed  Unexpected token 'i', "ix_node_kind_live" is
 * not valid JSON`).
 *
 * The live store holds a truncated / non-JSON `deep_verify_state` value and a
 * NULL `value` row. This suite proves the three links of the fix:
 *   1. `probeAdapterMetaValues` FLAGS both shapes (the FAST-tier trigger);
 *   2. `repairStoreIntegrity` QUARANTINES the non-JSON value (and drops the
 *      torn NULL row) without dropping either; and
 *   3. after the repair, `readDeepVerifyState` no longer raises
 *      `state_read_failed` — the row it would have choked on is gone.
 *
 * Every test names `BL-341`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { log } from '@adhd/sox-telemetry';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { createSqliteAdapter } from '../factory.js';
import {
  probeAdapterMetaValues,
  verifyStoreIntegrity,
  repairStoreIntegrity,
} from '../integrity.js';
import { readDeepVerifyState } from '../deep-verify.js';
import type { StoreAdapter } from '../types.js';

const Database = require('better-sqlite3') as new (p: string) => BetterSqlite3Database;

const tmpDir = mkdtempSync(join(tmpdir(), 'adapter-meta-value-bl341-'));
let counter = 0;
function tempPath(): string {
  counter += 1;
  return join(tmpDir, `bl341-${counter}-${Date.now()}.db`);
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
});
function track<T extends StoreAdapter>(a: T): T {
  open.push(a);
  return a;
}

/**
 * Seed the BL-341 shape. The `value` column is deliberately NULLABLE here (the
 * real table declares `value TEXT NOT NULL`, yet a NULL exists in production —
 * that schema-vs-content inconsistency IS the corruption; a plain `CREATE TABLE`
 * with a NOT NULL column refuses to hold the seed).
 */
function seedBl341(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE _adapter_meta (key TEXT PRIMARY KEY, value TEXT)`);
  db.exec(`
    INSERT INTO _adapter_meta (key, value) VALUES
      ('adapter_type', 'sqlite'),
      ('adapter_version', '0.13.1'),
      ('deep_verify_state', 'ix_node_kind_live'),
      ('last_integrity', NULL)
  `);
  db.close();
}

function isStateReadFailed(args: unknown[]): boolean {
  return args[0] === 'store_adapter.deep_verify.state_read_failed';
}

describe('BL-341 — a non-JSON / torn _adapter_meta value is flagged, quarantined, and no longer poisons the reader', () => {
  it('BL-341: probe flags both shapes; repair quarantines the JSON and drops the torn row; the reader stops raising', async () => {
    const dbPath = tempPath();
    seedBl341(dbPath);
    const adapter = track(createSqliteAdapter({ dbPath }));

    // ── 1. The FAST-tier probe flags BOTH the torn row and the non-JSON value.
    const findings = await probeAdapterMetaValues(adapter);
    const damaged = findings.filter((f) => f.status === 'damaged');
    expect(damaged).toHaveLength(1);
    expect(damaged[0]!.probe).toBe('adapter_meta_value_valid');
    expect(damaged[0]!.backlog).toBe('BL-341');
    expect(damaged[0]!.repairable).toBe(true);
    expect(damaged[0]!.detail).toMatch(/deep_verify_state/);
    expect(damaged[0]!.detail).toMatch(/last_integrity/);

    // ── RED: the non-JSON value poisons `readDeepVerifyState` (it raises
    //    `state_read_failed` and silently returns null). ────────────────────
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const before = await readDeepVerifyState(adapter);
      expect(before).toBeNull();
      expect(
        warn.mock.calls.some((c) => isStateReadFailed(c as unknown[])),
        'the pre-repair read raises state_read_failed (the live symptom)',
      ).toBe(true);

      warn.mockClear();

      // ── 2. Repair: quarantine the non-JSON value, drop the torn row. ──────
      const report = await verifyStoreIntegrity(adapter, { only: ['adapter_meta_value_valid'] });
      expect(report.damaged).toHaveLength(1);
      const repair = await repairStoreIntegrity(adapter, report, {
        only: ['adapter_meta_value_valid'],
      });
      expect(repair.actions[0]!.ok).toBe(true);
      expect(repair.actions[0]!.action).toMatch(/rebuilt _adapter_meta/);

      // The non-JSON value moved to quarantine with its reason; the torn row is
      // gone from both tables (it carried no data).
      const q = (
        await adapter.executeAll<{ key: string; value: string; reason: string }>(
          `SELECT key, value, reason FROM _adapter_meta_quarantine`,
        )
      ).rows;
      expect(q).toEqual([
        { key: 'deep_verify_state', value: 'ix_node_kind_live', reason: 'invalid_json' },
      ]);
      const remaining = (
        await adapter.executeAll<{ key: string }>(
          `SELECT key FROM _adapter_meta ORDER BY key`,
        )
      ).rows;
      expect(remaining.map((r) => r.key)).toEqual(['adapter_type', 'adapter_version']);

      // ── 3. GREEN: the reader no longer raises — the bad row is gone. ──────
      const after = await readDeepVerifyState(adapter);
      expect(after).toBeNull();
      expect(
        warn.mock.calls.some((c) => isStateReadFailed(c as unknown[])),
        'after the repair the read must NOT raise state_read_failed',
      ).toBe(false);

      // And the probe is now clean (its "ok" finding carries no damage).
      const recheck = await probeAdapterMetaValues(adapter);
      expect(recheck.filter((f) => f.status === 'damaged')).toEqual([]);
      expect(recheck.some((f) => f.status === 'ok')).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
