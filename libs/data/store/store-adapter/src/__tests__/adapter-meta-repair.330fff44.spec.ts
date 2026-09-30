/**
 * BL-336 / BL-341 — `_adapter_meta` rebuild (owning uid
 * `330fff44-1a31-44c5-bd25-7bcb8025435a`).
 *
 * The production store carries duplicate PRIMARY KEY rows (BL-336) and a NULL
 * `value` (BL-341). The OLD `repairAdapterMeta` copied `(key, value)` straight
 * into a `value TEXT NOT NULL` shadow table, so the NULL row made it throw
 * `NOT NULL constraint failed: _adapter_meta_repair.value` on EVERY open — the
 * corruption could never self-heal (~1300 `repair_failed` events/day).
 *
 * This suite drives the NEW primitive against a hand-built corrupt table and
 * proves, in the same test, both halves of the red→green:
 *   1. the old semantics THROW on the seeded shape (the RED that would have
 *      caught it), and
 *   2. `rebuildAdapterMetaTable` converges (the GREEN).
 *
 * It also proves the two properties the brief calls load-bearing:
 *   - transactional-DDL ROLLBACK leaves `_adapter_meta` untouched when a step
 *     fails mid-transaction; and
 *   - a healthy table produces `changed:false` with ZERO writes.
 *
 * Every test names `330fff44`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import {
  rebuildAdapterMetaTable,
  EAdapterMetaIdentityConflict,
  type RawMetaExecutor,
} from '../integrity.js';

const Database = require('better-sqlite3') as new (p: string) => BetterSqlite3Database;

const tmpDir = mkdtempSync(join(tmpdir(), 'adapter-meta-repair-330fff44-'));
let counter = 0;

/** A `RawMetaExecutor` over a real better-sqlite3 handle that RECORDS every
 *  statement, so "zero writes" is an assertion and not a claim. */
interface RecordingExec extends RawMetaExecutor {
  writes(): string[];
}

function recordingExec(db: BetterSqlite3Database): RecordingExec {
  const statements: string[] = [];
  return {
    writes() {
      return statements.filter((s) =>
        /^\s*(BEGIN|COMMIT|ROLLBACK|CREATE|DROP|ALTER|INSERT|UPDATE|DELETE|REPLACE)/i.test(s),
      );
    },
    async all<T>(sql: string, args?: unknown[]) {
      statements.push(sql);
      const rows = (args ? db.prepare(sql).all(...args) : db.prepare(sql).all()) as T[];
      return { rows };
    },
    async run(sql: string, args?: unknown[]) {
      statements.push(sql);
      return args ? db.prepare(sql).run(...args) : db.prepare(sql).run();
    },
    async exec(sql: string) {
      statements.push(sql);
      db.exec(sql);
    },
  };
}

const openDbs: BetterSqlite3Database[] = [];
function freshDb(): BetterSqlite3Database {
  counter += 1;
  const db = new Database(join(tmpDir, `case-${counter}-${Date.now()}.db`));
  openDbs.push(db);
  return db;
}
afterEach(() => {
  while (openDbs.length > 0) {
    try {
      openDbs.pop()!.close();
    } catch {
      // already closed
    }
  }
});

/**
 * The OLD `repairAdapterMeta` semantics, reproduced VERBATIM from the pre-fix
 * source — the RED control. Auto-committed (no BEGIN), copies `value` with no
 * null filter.
 */
async function oldRepairAdapterMetaSemantics(x: RawMetaExecutor): Promise<void> {
  const res = await x.all<{ key: string; value: string }>(
    `SELECT key, value FROM _adapter_meta ORDER BY rowid`,
  );
  const keep = new Map<string, string>();
  for (const row of res.rows) if (!keep.has(row.key)) keep.set(row.key, row.value);

  await x.exec(`DROP TABLE IF EXISTS _adapter_meta_repair`);
  await x.exec(`CREATE TABLE _adapter_meta_repair (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  for (const [k, v] of keep) {
    await x.run(`INSERT INTO _adapter_meta_repair (key, value) VALUES (?, ?)`, [k, v]);
  }
  await x.exec(`DROP TABLE _adapter_meta`);
  await x.exec(`ALTER TABLE _adapter_meta_repair RENAME TO _adapter_meta`);
}

/** Seed a corrupt `_adapter_meta`: a NULL value, duplicate keys (one with a
 *  differing value), and an UNKNOWN key. No PRIMARY KEY, so the duplicates
 *  land — exactly the shape a damaged autoindex leaves behind. */
function seeded(): RecordingExec {
  const db = freshDb();
  db.exec(`CREATE TABLE _adapter_meta (key TEXT, value TEXT)`);
  db.exec(`
    INSERT INTO _adapter_meta (key, value) VALUES
      ('deep_verify_state', NULL),
      ('adapter_type', 'sqlite'),
      ('adapter_type', 'sqlite'),
      ('adapter_version', '0.1.0'),
      ('adapter_version', '0.2.0'),
      ('graph_node', 'first'),
      ('graph_node', 'second')
  `);
  return recordingExec(db);
}

describe('330fff44 — _adapter_meta rebuild is transactional, key-class-aware, and lossless', () => {
  it('330fff44: the OLD semantics THROW on the NULL row; the new rebuild converges', async () => {
    const x = seeded();

    // ── RED: the old copy step hits NOT NULL on the seeded NULL value. ──────
    await expect(oldRepairAdapterMetaSemantics(x)).rejects.toThrow(/NOT NULL constraint failed/);

    // The old failure left a half-built shadow table; the new primitive cleans
    // it up (DROP IF EXISTS) before it begins.
    const report = await rebuildAdapterMetaTable(x);

    expect(report.changed).toBe(true);
    expect(report.dropped).toBe(1); // the NULL deep_verify_state row
    expect(report.quarantined).toBe(2); // graph_node ×2
    expect(report.quarantinedKeys).toContain('graph_node');
    expect(report.kept).toBe(2); // adapter_type, adapter_version

    // ── GREEN: one row per key, zero NULLs. ────────────────────────────────
    const grouped = (
      await x.all<{ key: string; c: number }>(
        `SELECT key, COUNT(*) AS c FROM _adapter_meta GROUP BY key`,
      )
    ).rows;
    for (const row of grouped) expect(row.c, `duplicate key ${row.key}`).toBe(1);
    const nulls = await x.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM _adapter_meta WHERE value IS NULL`,
    );
    expect(Number(nulls.rows[0]!.n)).toBe(0);

    // latest-wins kept the later adapter_version; the IDENTITY key is unchanged.
    const values = new Map(
      (
        await x.all<{ key: string; value: string }>(`SELECT key, value FROM _adapter_meta`)
      ).rows.map((r) => [r.key, r.value]),
    );
    expect(values.get('adapter_version')).toBe('0.2.0');
    expect(values.get('adapter_type')).toBe('sqlite');
    // The torn row was DROPPED, not carried and not quarantined.
    expect(values.has('deep_verify_state')).toBe(false);

    // ── Unknown key is QUARANTINED (never dropped), with a reason. ─────────
    const q = (
      await x.all<{ key: string; value: string; reason: string }>(
        `SELECT key, value, reason FROM _adapter_meta_quarantine ORDER BY key, value`,
      )
    ).rows;
    expect(q.map((r) => r.key)).toEqual(['graph_node', 'graph_node']);
    expect(q.every((r) => r.reason === 'unknown_key')).toBe(true);
    expect(q.map((r) => r.value)).toEqual(['first', 'second']);
  });

  it('330fff44: a DISTINCT identity conflict ABORTS and writes NOTHING', async () => {
    const db = freshDb();
    db.exec(`CREATE TABLE _adapter_meta (key TEXT, value TEXT)`);
    db.exec(`
      INSERT INTO _adapter_meta (key, value) VALUES
        ('adapter_type', 'sqlite'),
        ('adapter_type', 'turso'),
        ('adapter_version', '0.13.1')
    `);
    const x = recordingExec(db);

    const err = await rebuildAdapterMetaTable(x).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EAdapterMetaIdentityConflict);
    expect((err as EAdapterMetaIdentityConflict).key).toBe('adapter_type');
    expect((err as EAdapterMetaIdentityConflict).code).toBe('E_ADAPTER_META_IDENTITY_CONFLICT');

    // Nothing was written — the abort happens BEFORE BEGIN IMMEDIATE.
    expect(x.writes()).toEqual([]);
    const rows = (
      await x.all<{ key: string; value: string }>(
        `SELECT key, value FROM _adapter_meta ORDER BY rowid`,
      )
    ).rows;
    expect(rows).toEqual([
      { key: 'adapter_type', value: 'sqlite' },
      { key: 'adapter_type', value: 'turso' },
      { key: 'adapter_version', value: '0.13.1' },
    ]);
  });

  it('330fff44: a mid-transaction failure ROLLBACKs — _adapter_meta is untouched', async () => {
    const db = freshDb();
    db.exec(`CREATE TABLE _adapter_meta (key TEXT, value TEXT)`);
    db.exec(`
      INSERT INTO _adapter_meta (key, value) VALUES
        ('adapter_type', 'sqlite'),
        ('adapter_type', 'sqlite'),
        ('adapter_version', '0.9.0')
    `);
    const base = recordingExec(db);
    const before = (
      await base.all<{ key: string; value: string }>(
        `SELECT key, value FROM _adapter_meta ORDER BY rowid`,
      )
    ).rows;

    // A real executor that fails at the FINAL rename — a genuine mid-transaction
    // engine failure, after DROP/CREATE/INSERT have already run inside BEGIN.
    const failing: RawMetaExecutor = {
      all: (sql, args) => base.all(sql, args),
      run: (sql, args) => base.run(sql, args),
      exec: async (sql) => {
        if (/ALTER TABLE _adapter_meta_repair RENAME/i.test(sql)) {
          throw new Error('injected engine failure at RENAME');
        }
        return base.exec(sql);
      },
    };

    await expect(rebuildAdapterMetaTable(failing)).rejects.toThrow(/injected engine failure/);

    // Transactional DDL held: _adapter_meta is byte-identical, and the shadow
    // table was rolled back out of existence.
    const after = (
      await base.all<{ key: string; value: string }>(
        `SELECT key, value FROM _adapter_meta ORDER BY rowid`,
      )
    ).rows;
    expect(after).toEqual(before);
    const shadow = (
      await base.all<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE name = '_adapter_meta_repair'`,
      )
    ).rows;
    expect(shadow).toEqual([]);
  });

  it('330fff44: a healthy table is changed:false with ZERO writes', async () => {
    const db = freshDb();
    db.exec(`CREATE TABLE _adapter_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.exec(`
      INSERT INTO _adapter_meta (key, value) VALUES
        ('adapter_type', 'sqlite'),
        ('adapter_version', '0.13.1'),
        ('created_at', '2026-08-01T00:00:00.000Z'),
        ('deep_verify_state', '{"v":1}')
    `);
    const x = recordingExec(db);

    const report = await rebuildAdapterMetaTable(x);
    expect(report.changed).toBe(false);
    expect(report.kept).toBe(4);
    expect(report.quarantined).toBe(0);
    expect(report.dropped).toBe(0);
    expect(x.writes(), `healthy reopen must issue no writes: ${x.writes().join(' | ')}`).toEqual(
      [],
    );
  });

  it('330fff44: dryRun computes the report with NO write (incl. no quarantine table)', async () => {
    const x = seeded();
    const report = await rebuildAdapterMetaTable(x, { dryRun: true });

    expect(report.changed).toBe(true);
    expect(report.dropped).toBe(1);
    expect(report.quarantined).toBe(2);
    expect(x.writes()).toEqual([]);
    const qTable = (
      await x.all<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE name = '_adapter_meta_quarantine'`,
      )
    ).rows;
    expect(qTable).toEqual([]);
  });
});
