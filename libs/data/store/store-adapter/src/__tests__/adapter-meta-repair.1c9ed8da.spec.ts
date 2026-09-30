/**
 * BL-336 — the LIVE corruption shape converges (owning uid
 * `1c9ed8da-7ec7-497e-b082-b84d3445858f`).
 *
 * The production `_adapter_meta` carried duplicate PRIMARY KEY rows under a mix
 * of KNOWN keys and keys that are not `_adapter_meta` keys at all
 * (`node ×12, edge ×6, request_ledger ×2, organizer_queue ×2` — table names that
 * somehow landed in the meta table). The rebuild must keep exactly one row per
 * KNOWN key and QUARANTINE every unknown key rather than dropping it.
 *
 * This is the convergence test: after one rebuild the table is one-row-per-key,
 * the unknown rows are in `_adapter_meta_quarantine` (not gone), and the counter
 * key holds its maximum.
 *
 * Every test names `1c9ed8da`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { KNOWN_ADAPTER_META_KEYS } from '../adapter-meta.js';
import { rebuildAdapterMetaTable, type RawMetaExecutor } from '../integrity.js';

const Database = require('better-sqlite3') as new (p: string) => BetterSqlite3Database;

const tmpDir = mkdtempSync(join(tmpdir(), 'adapter-meta-repair-1c9ed8da-'));

const openDbs: BetterSqlite3Database[] = [];
afterEach(() => {
  while (openDbs.length > 0) {
    try {
      openDbs.pop()!.close();
    } catch {
      // already closed
    }
  }
});

function exec(db: BetterSqlite3Database): RawMetaExecutor {
  return {
    all: async <T,>(sql: string, args?: unknown[]) => {
      const rows = (args ? db.prepare(sql).all(...args) : db.prepare(sql).all()) as T[];
      return { rows };
    },
    run: async (sql: string, args?: unknown[]) =>
      args ? db.prepare(sql).run(...args) : db.prepare(sql).run(),
    exec: async (sql: string) => {
      db.exec(sql);
    },
  };
}

describe('1c9ed8da — the live _adapter_meta shape converges in one rebuild', () => {
  it('1c9ed8da: node×12 / edge×6 / request_ledger×2 / organizer_queue×2 all converge', async () => {
    const db = new Database(join(tmpDir, `live-${Date.now()}.db`));
    openDbs.push(db);
    db.exec(`CREATE TABLE _adapter_meta (key TEXT, value TEXT)`);

    // Known keys — the real stamp shape (some duplicated).
    db.exec(`
      INSERT INTO _adapter_meta (key, value) VALUES
        ('adapter_type', 'turso'),
        ('adapter_version', '0.13.1'),
        ('created_at', '2026-08-01T00:00:00.000Z'),
        ('clean_shutdown', '0'),
        ('deep_verify_owed', '{"reason":"unclean_shutdown","since":"2026-09-01T00:00:00.000Z"}'),
        ('deep_verify_state', '{"v":1,"status":"ok"}'),
        ('last_integrity', '{"v":1}'),
        ('fts_optimize_passes_since_rebuild', '2'),
        ('fts_optimize_passes_since_rebuild', '5'),
        ('last_rebuild_at', '2026-08-15T00:00:00.000Z'),
        ('migrated_from', 'sqlite'),
        ('migrated_at', '2026-07-01T00:00:00.000Z')
    `);

    // Unknown keys — the foreign duplicates that landed in the meta table.
    const insertUnknown = db.prepare(`INSERT INTO _adapter_meta (key, value) VALUES (?, ?)`);
    const seedMany = (key: string, n: number): void => {
      for (let i = 0; i < n; i++) insertUnknown.run(key, `${key}-row-${i}`);
    };
    seedMany('node', 12);
    seedMany('edge', 6);
    seedMany('request_ledger', 2);
    seedMany('organizer_queue', 2);

    const x = exec(db);
    const report = await rebuildAdapterMetaTable(x);

    expect(report.changed).toBe(true);
    expect(report.kept).toBe(KNOWN_ADAPTER_META_KEYS.length); // 11 known keys
    expect(report.quarantined).toBe(22); // 12 + 6 + 2 + 2
    expect(report.dropped).toBe(0);
    expect(new Set(report.quarantinedKeys)).toEqual(
      new Set(['node', 'edge', 'request_ledger', 'organizer_queue']),
    );

    // One row per key now.
    const grouped = (
      await x.all<{ key: string; c: number }>(
        `SELECT key, COUNT(*) AS c FROM _adapter_meta GROUP BY key`,
      )
    ).rows;
    for (const row of grouped) expect(row.c, `duplicate key ${row.key}`).toBe(1);
    expect(grouped.length).toBe(KNOWN_ADAPTER_META_KEYS.length);

    // Counter class kept the MAXIMUM ('5'), not the earliest or the latest-by-rowid.
    const passes = (
      await x.all<{ value: string }>(
        `SELECT value FROM _adapter_meta WHERE key = 'fts_optimize_passes_since_rebuild'`,
      )
    ).rows;
    expect(passes).toEqual([{ value: '5' }]);

    // Every unknown row survived into quarantine — none was dropped.
    const qCount = (
      await x.all<{ n: number }>(`SELECT COUNT(*) AS n FROM _adapter_meta_quarantine`)
    ).rows;
    expect(Number(qCount[0]!.n)).toBe(22);
    const qKeys = (
      await x.all<{ key: string; c: number }>(
        `SELECT key, COUNT(*) AS c FROM _adapter_meta_quarantine GROUP BY key ORDER BY key`,
      )
    ).rows;
    expect(qKeys).toEqual([
      { key: 'edge', c: 6 },
      { key: 'node', c: 12 },
      { key: 'organizer_queue', c: 2 },
      { key: 'request_ledger', c: 2 },
    ]);

    // A second rebuild is a no-op (idempotent convergence).
    const second = await rebuildAdapterMetaTable(x);
    expect(second.changed).toBe(false);
    expect(second.kept).toBe(KNOWN_ADAPTER_META_KEYS.length);
  });
});
