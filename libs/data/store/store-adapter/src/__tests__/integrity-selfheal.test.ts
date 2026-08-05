/**
 * BL-352 — adapters must VERIFY and SELF-HEAL the artifacts they generate.
 * Plus BL-330 (unlinked WAL discards committed data), BL-335 (unpopulated
 * secondary indexes), BL-336 (duplicate `_adapter_meta` PRIMARY KEY rows),
 * BL-337 (`REINDEX <table>` impossible with a Tantivy index), BL-341
 * (`integrity_check` message cap + a Turso false positive), BL-347 (an FTS
 * index that exists but is empty).
 *
 * ── The shape of every test here ────────────────────────────────────────────
 *
 * 1. **Negative control first.** Verify the healthy store and assert the probe
 *    reports `ok`. A probe that cannot pass on a good store is measuring
 *    nothing; a probe that cannot fail on a bad one is a comment (BL-167).
 * 2. **Damage a generated artifact** with fixture-only code.
 * 3. **Assert the probe goes red** — this is the assertion that would have
 *    caught BL-347 in production.
 * 4. **Prove re-running the schema DDL does NOT fix it.** `CREATE … IF NOT
 *    EXISTS` no-ops on a structure that exists but is empty. That no-op is the
 *    entire mechanism of BL-352, so it is asserted, not assumed.
 * 5. **Re-open through the normal adapter path** and assert the damage is
 *    detected and repaired with **no repair DDL anywhere in the test**.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, statSync, unlinkSync, existsSync, copyFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { createSqliteAdapter, createStoreAdapter } from '../factory.js';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { readAdapterMeta } from '../adapter-meta.js';
import {
  verifyStoreIntegrity,
  repairStoreIntegrity,
  parsePartialPredicate,
  parseFtsColumns,
  pickSentinelToken,
  pickSentinelTokens,
  isKnownFalsePositive,
  captureWalIdentity,
  isStaleWalIndexError,
  recoverStaleWalIndex,
  describeStaleWalIndexFailure,
  resolveVerifyDepth,
} from '../integrity.js';
import { summarizeIntegrityForStatus, integrityHeadline } from '../integrity-status.js';
import type { StoreAdapter } from '../types.js';

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
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-integrity-'));
});

function tempPath(label: string): string {
  return join(tmpDir, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
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

// ── Fixture-only damage seeding ──────────────────────────────────────────────

/**
 * Make an existing btree index **exist but be empty** — the BL-335 shape:
 * rows physically present and readable, but invisible to any query the planner
 * routes through the index.
 *
 * Repoints the index at a freshly created, empty btree via `writable_schema`.
 * This is damage seeding, not remediation — no repair path uses it.
 */
function seedUnpopulatedIndex(dbPath: string, indexName: string): void {
  const Database = require('better-sqlite3') as new (p: string) => BetterSqlite3Database;
  const db = new Database(dbPath);
  db.unsafeMode(true);
  db.exec(`CREATE TABLE IF NOT EXISTS _damage_scratch (z TEXT)`);
  db.exec(`DROP INDEX IF EXISTS _damage_scratch_ix`);
  db.exec(`CREATE INDEX _damage_scratch_ix ON _damage_scratch (z)`);
  const scratch = db
    .prepare(`SELECT rootpage FROM sqlite_master WHERE name = '_damage_scratch_ix'`)
    .get() as { rootpage: number };
  db.pragma('writable_schema = ON');
  db.prepare(`UPDATE sqlite_master SET rootpage = ? WHERE name = ?`).run(scratch.rootpage, indexName);
  // Hand the empty page over exclusively, so the damaged index is the only
  // owner and a later REINDEX rebuilds it without collateral.
  db.prepare(`DELETE FROM sqlite_master WHERE name IN ('_damage_scratch', '_damage_scratch_ix')`).run();
  db.pragma('writable_schema = RESET');
  db.close();
}

/**
 * Empty an FTS5 index while leaving the virtual table (and every `sqlite_master`
 * row) in place — the BL-347 shape: the artifact exists, the migrator's
 * `IF NOT EXISTS` sees it and no-ops, and keyword search silently returns
 * nothing.
 */
function seedEmptyFts5Index(adapter: StoreAdapter, ftsTable: string): void {
  const raw = adapter.unwrap() as BetterSqlite3Database;
  raw.exec(`INSERT INTO ${ftsTable}(${ftsTable}) VALUES('delete-all')`);
}

/** Seed duplicate PRIMARY KEY rows into `_adapter_meta` (the BL-336 shape). */
function seedDuplicateAdapterMeta(adapter: StoreAdapter): void {
  const raw = adapter.unwrap() as BetterSqlite3Database;
  raw.unsafeMode(true);
  raw.pragma('writable_schema = ON');
  // Detach the unique index so the duplicate can land, exactly as it did in
  // production when the index was inconsistent and the constraint was not
  // enforced. The index row itself stays in sqlite_master.
  raw.exec(`CREATE TABLE IF NOT EXISTS _meta_scratch (z TEXT)`);
  raw.exec(`DROP INDEX IF EXISTS _meta_scratch_ix`);
  raw.exec(`CREATE INDEX _meta_scratch_ix ON _meta_scratch (z)`);
  const scratch = raw
    .prepare(`SELECT rootpage FROM sqlite_master WHERE name = '_meta_scratch_ix'`)
    .get() as { rootpage: number };
  raw
    .prepare(`UPDATE sqlite_master SET rootpage = ? WHERE name = 'sqlite_autoindex__adapter_meta_1'`)
    .run(scratch.rootpage);
  // Hand the page over exclusively. Leaving the scratch objects in
  // `sqlite_master` makes them share a rootpage with the detached autoindex,
  // and the btree probe then legitimately fails to REINDEX a malformed index —
  // fixture collateral that looks like an engine defect.
  raw.prepare(`DELETE FROM sqlite_master WHERE name IN ('_meta_scratch', '_meta_scratch_ix')`).run();
  raw.pragma('writable_schema = RESET');
  raw.close();
}

// ── The schema an ordinary consumer applies (NOT repair DDL) ─────────────────

const NODE_DDL = `
  CREATE TABLE IF NOT EXISTS node (
    id INTEGER PRIMARY KEY, content TEXT, name TEXT, summary TEXT, topic TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_node_topic_all ON node (topic);
  CREATE INDEX IF NOT EXISTS ix_node_topic_partial ON node (topic) WHERE topic IS NOT NULL;
`;
const FTS5_DDL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS fts_node USING fts5(
    content, name, summary, content='node', content_rowid='rowid'
  );
`;

async function seedRows(adapter: StoreAdapter, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await adapter.executeRun(
      `INSERT INTO node (content, name, summary, topic) VALUES (?, ?, ?, ?)`,
      [
        `episode ${i} concerning quarterly hippopotamus logistics and reconciliation`,
        `name-${i}`,
        `summary ${i}`,
        i % 3 === 0 ? null : `topic-${i % 5}`,
      ],
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BL-335 — an index that exists but is unpopulated
// ═══════════════════════════════════════════════════════════════════════════

describe('BL-335 / BL-352 — unpopulated secondary index is detected and repaired', () => {
  it('detects the damage, proves the schema DDL cannot fix it, and self-heals on the next open', async () => {
    const dbPath = tempPath('bl335');

    // ── build a healthy store through the normal adapter path ──────────────
    const built = track(createSqliteAdapter({ dbPath }));
    await built.exec(NODE_DDL);
    await seedRows(built, 40);

    // ── negative control: the probe passes on a HEALTHY store ──────────────
    const healthy = await verifyStoreIntegrity(built);
    const healthyIx = healthy.findings.filter((f) => f.probe === 'btree_index_populated');
    expect(healthyIx.length).toBeGreaterThan(0);
    expect(healthy.damaged.filter((f) => f.probe === 'btree_index_populated')).toEqual([]);
    // …and it was actually validated — not silently a table scan compared to itself.
    expect(healthyIx.every((f) => f.probeValidated)).toBe(true);
    await built.close();

    // ── damage a generated artifact ────────────────────────────────────────
    seedUnpopulatedIndex(dbPath, 'ix_node_topic_all');

    // ── the probe goes RED ─────────────────────────────────────────────────
    const damagedAdapter = track(createSqliteAdapter({ dbPath }));
    const damaged = await verifyStoreIntegrity(damagedAdapter);
    const finding = damaged.damaged.find(
      (f) => f.probe === 'btree_index_populated' && f.object === 'ix_node_topic_all',
    );
    expect(finding, JSON.stringify(damaged.findings, null, 2)).toBeDefined();
    expect(finding!.detail).toMatch(/holds 0 entries but the table has 40/);

    // ── re-running the SCHEMA DDL does not fix it — this is the mechanism ──
    await damagedAdapter.exec(NODE_DDL);
    const afterSchema = await verifyStoreIntegrity(damagedAdapter);
    expect(
      afterSchema.damaged.some((f) => f.object === 'ix_node_topic_all'),
      'CREATE INDEX IF NOT EXISTS no-ops on an index that exists but is empty — ' +
        'that no-op is precisely why BL-347/BL-335 were permanent and invisible',
    ).toBe(true);
    await damagedAdapter.close();

    // ── re-open through the NORMAL adapter path: no repair DDL in this test ─
    const prev = process.env.STORE_ADAPTER;
    process.env.STORE_ADAPTER = 'sqlite';
    try {
      const reopened = track(await createStoreAdapter({ dbPath }));
      const after = await verifyStoreIntegrity(reopened);
      expect(
        after.damaged.filter((f) => f.probe === 'btree_index_populated'),
        'the adapter must repair what it generates, on open, unprompted',
      ).toEqual([]);
      const repaired = await reopened.executeGet<{ c: number }>(
        `SELECT COUNT(*) AS c FROM node INDEXED BY ix_node_topic_all`,
      );
      expect(repaired!.c).toBe(40);
    } finally {
      if (prev === undefined) delete process.env.STORE_ADAPTER;
      else process.env.STORE_ADAPTER = prev;
    }
  });

  it('repairs by REINDEXing the index BY NAME, never the table (BL-337)', async () => {
    const dbPath = tempPath('bl337');
    const build = track(createSqliteAdapter({ dbPath }));
    await build.exec(NODE_DDL);
    await seedRows(build, 12);
    await build.close();

    seedUnpopulatedIndex(dbPath, 'ix_node_topic_all');

    const adapter = track(createSqliteAdapter({ dbPath }));
    const report = await verifyStoreIntegrity(adapter);
    const repair = await repairStoreIntegrity(adapter, report);
    const action = repair.actions.find((a) => a.object === 'ix_node_topic_all');
    expect(action).toBeDefined();
    expect(action!.ok).toBe(true);
    expect(action!.action).toMatch(/reindexed "ix_node_topic_all" individually/);
    expect(repair.verified).not.toBeNull();
    expect(repair.verified!.damaged.filter((f) => f.probe === 'btree_index_populated')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BL-347 — an FTS index that exists but is empty
// ═══════════════════════════════════════════════════════════════════════════

describe('BL-347 / BL-352 — an FTS index that exists but is empty is detected and rebuilt', () => {
  it('sentinel round-trip detects an emptied index; the schema DDL does not fix it; the adapter does', async () => {
    const dbPath = tempPath('bl347');
    const adapter = track(createSqliteAdapter({ dbPath }));
    await adapter.exec(NODE_DDL);
    await adapter.exec(FTS5_DDL);
    await seedRows(adapter, 30);
    await adapter.exec(
      `INSERT INTO fts_node(rowid, content, name, summary)
         SELECT rowid, content, name, summary FROM node`,
    );

    // ── negative control on a healthy index ────────────────────────────────
    const healthy = await verifyStoreIntegrity(adapter, { only: ['fts_index_live'] });
    expect(healthy.findings.map((f) => f.object)).toContain('fts_node');
    expect(healthy.damaged).toEqual([]);
    expect(healthy.findings.every((f) => f.probeValidated)).toBe(true);

    // ── damage: the index object survives, its content does not ────────────
    seedEmptyFts5Index(adapter, 'fts_node');

    const damaged = await verifyStoreIntegrity(adapter, { only: ['fts_index_live'] });
    const finding = damaged.damaged.find((f) => f.object === 'fts_node');
    expect(finding, JSON.stringify(damaged.findings, null, 2)).toBeDefined();
    expect(finding!.backlog).toBe('BL-347');
    expect(finding!.detail).toMatch(/NOT matchable/);

    // ── the artifact still EXISTS, so the migrator's IF NOT EXISTS no-ops ──
    const stillThere = await adapter.executeGet<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE name = 'fts_node'`,
    );
    expect(stillThere).not.toBeNull();
    await adapter.exec(FTS5_DDL);
    const afterSchema = await verifyStoreIntegrity(adapter, { only: ['fts_index_live'] });
    expect(
      afterSchema.damaged.some((f) => f.object === 'fts_node'),
      'existence is not integrity — re-issuing the FTS DDL cannot repopulate an empty index',
    ).toBe(true);

    // ── repair through the adapter's own path, no DDL here ─────────────────
    const repair = await repairStoreIntegrity(adapter, afterSchema);
    expect(repair.actions.some((a) => a.object === 'fts_node' && a.ok)).toBe(true);
    expect(repair.verified!.damaged.filter((f) => f.probe === 'fts_index_live')).toEqual([]);
  });

  it('the naive "does FTS match anything at all" probe PASSES on the live damage shape', async () => {
    // Live measurement 2026-07-31: on the damaged store `fts_match('the')`
    // returned 3 hits while `fts_match('memory')` returned 0 against 1074 LIKE
    // hits — the rows written after the index was orphaned ARE indexed. A probe
    // that only asks "did anything match" is green on a store where keyword
    // search is dead for 99.9% of the corpus. This test pins that the cheap
    // probe is unsound, which is why probeFtsIndexes samples SPECIFIC rows.
    const dbPath = tempPath('bl347-naive');
    const adapter = track(createSqliteAdapter({ dbPath }));
    await adapter.exec(NODE_DDL);
    await adapter.exec(FTS5_DDL);
    await seedRows(adapter, 30);
    await adapter.exec(
      `INSERT INTO fts_node(rowid, content, name, summary)
         SELECT rowid, content, name, summary FROM node`,
    );
    seedEmptyFts5Index(adapter, 'fts_node');
    // A single later write re-populates one row — the "recent writes still work"
    // state the live store was in.
    await adapter.executeRun(
      `INSERT INTO node (content, name, summary, topic) VALUES (?, ?, ?, ?)`,
      ['a freshly written episode about hippopotamus reconciliation', 'late', 'late', 'late'],
    );
    await adapter.exec(
      `INSERT INTO fts_node(rowid, content, name, summary)
         SELECT rowid, content, name, summary FROM node ORDER BY rowid DESC LIMIT 1`,
    );

    const anyMatch = await adapter.executeGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM fts_node WHERE fts_node MATCH 'hippopotamus'`,
    );
    expect(anyMatch!.c, 'the naive probe sees matches and would report healthy').toBeGreaterThan(0);

    const report = await verifyStoreIntegrity(adapter, { only: ['fts_index_live'] });
    expect(
      report.damaged.length,
      'the sentinel probe must still go red where the naive probe is green',
    ).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BL-336 — duplicate _adapter_meta PRIMARY KEY rows
// ═══════════════════════════════════════════════════════════════════════════

describe('BL-336 — _adapter_meta must hold exactly one row per key', () => {
  it('re-stamping the same store does not duplicate a PRIMARY KEY', async () => {
    const dbPath = tempPath('bl336-upsert');
    const first = track(createSqliteAdapter({ dbPath }));
    await first.init();
    await first.init();
    await first.init();
    const rows = await first.executeAll<{ key: string; c: number }>(
      `SELECT key, COUNT(*) AS c FROM _adapter_meta GROUP BY key`,
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) expect(row.c).toBe(1);

    // The FIRST created_at must survive a re-stamp — it is the meaningful one.
    const meta = await readAdapterMeta(first);
    expect(meta.adapter_type).toBe('sqlite');
    expect(meta.created_at).not.toBeNull();
  });

  it('detects and repairs duplicates that a damaged unique index let through', async () => {
    const dbPath = tempPath('bl336-dupes');
    const seedAdapter = track(createSqliteAdapter({ dbPath }));
    await seedAdapter.init();
    seedDuplicateAdapterMeta(seedAdapter); // closes the raw handle
    open.pop();

    const withDupes = track(createSqliteAdapter({ dbPath }));
    await withDupes.executeRun(`INSERT INTO _adapter_meta (key, value) VALUES (?, ?)`, [
      'adapter_type',
      'turso',
    ]);
    await withDupes.executeRun(`INSERT INTO _adapter_meta (key, value) VALUES (?, ?)`, [
      'adapter_version',
      '9.9.9',
    ]);

    const damaged = await verifyStoreIntegrity(withDupes, { only: ['adapter_meta_unique'] });
    expect(damaged.damaged.length, JSON.stringify(damaged.findings)).toBe(1);
    expect(damaged.damaged[0]!.detail).toMatch(/Duplicate PRIMARY KEY rows/);

    const repair = await repairStoreIntegrity(withDupes, damaged, { only: ['adapter_meta_unique'] });
    expect(repair.actions[0]!.ok).toBe(true);
    const after = await withDupes.executeAll<{ key: string; c: number }>(
      `SELECT key, COUNT(*) AS c FROM _adapter_meta GROUP BY key`,
    );
    for (const row of after.rows) expect(row.c).toBe(1);
    // Earliest row per key is kept — the original stamp, not the duplicate.
    const meta = await readAdapterMeta(withDupes);
    expect(meta.adapter_type).toBe('sqlite');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Probe-design guards — the BL-167 defences, asserted rather than assumed
// ═══════════════════════════════════════════════════════════════════════════

describe('BL-352 — probe design guards', () => {
  it('parses partial predicates so a partial index is probed with its own WHERE clause', () => {
    expect(parsePartialPredicate(`CREATE INDEX ix ON node (topic)`)).toBeNull();
    expect(parsePartialPredicate(`CREATE INDEX ix ON node (topic) WHERE topic IS NOT NULL`)).toBe(
      'topic IS NOT NULL',
    );
    expect(
      parsePartialPredicate(
        `CREATE INDEX ix_node_temporal ON node (t_invalid, t_created DESC) WHERE t_invalid IS NULL`,
      ),
    ).toBe('t_invalid IS NULL');
    expect(parsePartialPredicate(null)).toBeNull();
  });

  it('parses Turso FTS index columns', () => {
    expect(
      parseFtsColumns(
        `CREATE INDEX IF NOT EXISTS idx_fts_node ON "node" USING fts ("content", "name", "summary") WITH (weights = 'content=1')`,
      ),
    ).toEqual(['content', 'name', 'summary']);
    expect(parseFtsColumns(`CREATE INDEX ix ON node (topic)`)).toEqual([]);
  });

  it('filters the Turso Tantivy integrity_check false positive, and nothing else', () => {
    // Measured 2026-07-31 on a FRESHLY BUILT, fully working index whose
    // fts_match returned 200/200 — the message is unconditional, so treating
    // integrity_check as pass/fail on a Turso FTS store reports damage forever.
    expect(
      isKnownFalsePositive('wrong # of entries in index __turso_internal_fts_dir_idx_fts_node_key'),
    ).toBe(true);
    expect(isKnownFalsePositive('wrong # of entries in index ix_node_topic')).toBe(false);
    expect(isKnownFalsePositive('row 4 missing from index sqlite_autoindex__adapter_meta_1')).toBe(
      false,
    );
  });

  it('picks a sentinel token that a tokenizer will index as one term', () => {
    expect(pickSentinelToken('the quick brown hippopotamus jumped')).toBe('hippopotamus');
    expect(pickSentinelToken('a b c')).toBeNull();
    expect(pickSentinelToken(null)).toBeNull();
    expect(pickSentinelToken(42)).toBeNull();
  });

  it('escalates verification depth after an unclean shutdown', () => {
    const prev = process.env.SOX_STORE_VERIFY;
    delete process.env.SOX_STORE_VERIFY;
    try {
      expect(resolveVerifyDepth(false)).toBe('fast');
      expect(resolveVerifyDepth(true)).toBe('deep');
      process.env.SOX_STORE_VERIFY = 'off';
      expect(resolveVerifyDepth(true)).toBe('off');
      process.env.SOX_STORE_VERIFY = 'deep';
      expect(resolveVerifyDepth(false)).toBe('deep');
    } finally {
      if (prev === undefined) delete process.env.SOX_STORE_VERIFY;
      else process.env.SOX_STORE_VERIFY = prev;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BL-330 — an unlinked WAL must never silently discard committed data
// ═══════════════════════════════════════════════════════════════════════════

tursoDescribe('BL-330 — unlinked WAL is detected at close and recovered, never silent', () => {
  it('control: with the WAL in place, every committed row survives close/reopen', async () => {
    const dbPath = tempPath('bl330-control');
    const a = track(await TursoAdapterImpl.connect({ dbPath }));
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    for (let i = 0; i < 140; i++) await a.executeRun('INSERT INTO t (v) VALUES (?)', ['v' + i]);
    await a.close();
    open.pop();

    const b = track(await TursoAdapterImpl.connect({ dbPath }));
    const after = await b.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM t');
    expect(after!.c).toBe(140);
  });

  it('unlinked WAL: close checkpoints and retains the data instead of dropping it silently', async () => {
    const dbPath = tempPath('bl330-unlinked');
    const a = track(await TursoAdapterImpl.connect({ dbPath }));
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    for (let i = 0; i < 140; i++) await a.executeRun('INSERT INTO t (v) VALUES (?)', ['v' + i]);

    // The WAL must actually exist for this to be the BL-330 scenario.
    expect(existsSync(dbPath + '-wal')).toBe(true);
    const baselineIno = statSync(dbPath + '-wal').ino;
    unlinkSync(dbPath + '-wal');
    expect(existsSync(dbPath + '-wal')).toBe(false);

    // The probe must see it. (Without the fix this returns clean and close()
    // then discards everything above with no error at all.)
    const report = await verifyStoreIntegrity(a, {
      only: ['wal_identity'],
      walBaseline: { path: dbPath + '-wal', present: true, dev: 0, ino: baselineIno },
    });
    expect(report.damaged.length).toBe(1);
    expect(report.damaged[0]!.backlog).toBe('BL-330');
    expect(report.damaged[0]!.detail).toMatch(/unlinked|replaced/);

    await a.close();
    open.pop();

    const b = track(await TursoAdapterImpl.connect({ dbPath }));
    const after = await b.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM t');
    expect(
      after!.c,
      'a graceful close over an unlinked WAL previously lost EVERYTHING — ' +
        'the reopened store did not even have the table',
    ).toBe(140);
  });

  it('captureWalIdentity reports absence rather than throwing', () => {
    const identity = captureWalIdentity(join(tmpDir, 'does-not-exist.db'));
    expect(identity).not.toBeNull();
    expect(identity!.present).toBe(false);
    expect(captureWalIdentity(undefined)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Turso — the probes must be sound on the backend that actually ships
// ═══════════════════════════════════════════════════════════════════════════

tursoDescribe('BL-352 — Turso probe soundness', () => {
  it('does NOT report a PARTIAL index healthy on the strength of a table scan', async () => {
    // Turso accepts `INDEXED BY <partial index>` and then plans a plain
    // `SCAN t` anyway (real SQLite raises "no query solution"), so a naive
    // probe compares a table scan against itself and reports every partial
    // index healthy. 8 of the live store's 20 indexes are partial.
    const dbPath = tempPath('turso-partial');
    const a = track(await TursoAdapterImpl.connect({ dbPath }));
    await a.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, p TEXT)`);
    await a.exec(`CREATE INDEX ix_part ON t (p) WHERE p IS NOT NULL`);
    for (let i = 0; i < 50; i++) await a.executeRun(`INSERT INTO t (p) VALUES (?)`, [i % 2 ? 'p' + i : null]);

    const plain = await a.executeAll<Record<string, unknown>>(
      `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM t INDEXED BY ix_part`,
    );
    const usedWithoutPredicate = plain.rows.some((r) =>
      Object.values(r).some((v) => typeof v === 'string' && v.includes('ix_part')),
    );
    expect(
      usedWithoutPredicate,
      'if Turso ever starts honouring INDEXED BY on partial indexes this guard can relax — ' +
        'until then the predicate is mandatory',
    ).toBe(false);

    const report = await verifyStoreIntegrity(a, { only: ['btree_index_populated'] });
    const finding = report.findings.find((f) => f.object === 'ix_part');
    expect(finding).toBeDefined();
    // With the predicate supplied the planner DOES use the index, so the probe
    // is validated and can legitimately report ok.
    expect(finding!.probeValidated).toBe(true);
    expect(finding!.status).toBe('ok');
    expect(finding!.detail).toMatch(/25\/25/);
  });

  it('reports a healthy Turso FTS index as live via a sentinel round-trip', async () => {
    const dbPath = tempPath('turso-fts');
    const a = track(await TursoAdapterImpl.connect({ dbPath }));
    await a.exec(`CREATE TABLE node (id INTEGER PRIMARY KEY, content TEXT, name TEXT, summary TEXT)`);
    for (let i = 0; i < 60; i++)
      await a.executeRun(`INSERT INTO node (content,name,summary) VALUES (?,?,?)`, [
        `episode ${i} concerning quarterly hippopotamus logistics`,
        `name-${i}`,
        `summary ${i}`,
      ]);
    await a.exec(
      `CREATE INDEX IF NOT EXISTS idx_fts_node ON "node" USING fts ("content", "name", "summary")`,
    );

    // The backing-table row count reads 0 on a WORKING index — this is the
    // measurement that makes it useless as a health signal (BL-347).
    const backing = await a.executeGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM __turso_internal_fts_dir_idx_fts_node`,
    );
    expect(backing!.c).toBe(0);

    const report = await verifyStoreIntegrity(a, { only: ['fts_index_live'] });
    const finding = report.findings.find((f) => f.object === 'idx_fts_node');
    expect(finding, JSON.stringify(report.findings)).toBeDefined();
    expect(finding!.status).toBe('ok');
    expect(finding!.probeValidated).toBe(true);
  });

  it('deep verification filters the Tantivy false positive and stays green on a healthy store', async () => {
    const dbPath = tempPath('turso-deep');
    const a = track(await TursoAdapterImpl.connect({ dbPath }));
    await a.exec(`CREATE TABLE node (id INTEGER PRIMARY KEY, content TEXT, name TEXT, summary TEXT)`);
    for (let i = 0; i < 40; i++)
      await a.executeRun(`INSERT INTO node (content,name,summary) VALUES (?,?,?)`, [
        `episode ${i} concerning quarterly hippopotamus logistics`,
        `name-${i}`,
        `summary ${i}`,
      ]);
    await a.exec(
      `CREATE INDEX IF NOT EXISTS idx_fts_node ON "node" USING fts ("content", "name", "summary")`,
    );

    const raw = await a.executeAll<Record<string, unknown>>('PRAGMA integrity_check');
    const messages = raw.rows
      .flatMap((r) => Object.values(r))
      .filter((v): v is string => typeof v === 'string');
    expect(
      messages.some((m) => isKnownFalsePositive(m)),
      'the false positive is expected here — if Turso stops emitting it, drop the filter',
    ).toBe(true);

    const report = await verifyStoreIntegrity(a, { depth: 'deep', only: ['pragma_integrity_check'] });
    expect(report.damaged, JSON.stringify(report.findings)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BL-374 — after a repair whose actions all succeed, reverification must AGREE
// with ground truth. A verdict that cannot return to ok after a correct repair
// is a permanent false alarm on the one surface built to make silent damage
// visible, and it gets tuned out exactly like BL-360's unconditional message.
//
// Root cause of the live instance: the sentinel token picker capped tokens at
// 20 letters and therefore TRUNCATED longer ones. Live row 9478 contains
// `sharedFastembedProcess` (22 letters); the probe extracted
// `sharedFastembedProce`, which is not a term in any tokenizer, so a perfectly
// healthy index reported that row as unindexed — deterministically, forever.
// Measured on 400 consecutive live rows against a known-good index: 29 false
// misses (7.3%) with the truncating picker, 0 with whole-word candidates.
// ═══════════════════════════════════════════════════════════════════════════

describe('BL-374 — a healthy index is never reported damaged, and repair clears the verdict', () => {
  const LONG_IDENT = 'sharedFastembedProcess'; // 22 letters — the live shape

  it('never emits a truncated fragment of a long word as a sentinel token', () => {
    const text = `the call site is ${LONG_IDENT} which unrefs the child twice`;
    const tokens = pickSentinelTokens(text, 5);

    // The exact live failure: a 20-char prefix of a 22-char word.
    expect(tokens).not.toContain(LONG_IDENT.slice(0, 20));
    // Every candidate must be a WHOLE word present in the text.
    for (const t of tokens) {
      expect(
        new RegExp(`(?<![A-Za-z])${t}(?![A-Za-z])`).test(text),
        `"${t}" is not a complete word in the source text`,
      ).toBe(true);
    }
    expect(tokens.length).toBeGreaterThan(0);
  });

  it('reports a HEALTHY index as ok even when rows contain over-long identifiers', async () => {
    const dbPath = tempPath('bl374-healthy');
    const adapter = track(createSqliteAdapter({ dbPath }));
    await adapter.exec(NODE_DDL);
    await adapter.exec(FTS5_DDL);
    // Every row's longest letter-run exceeds the old 20-char cap, so the old
    // picker truncated on EVERY row and the probe went red on a healthy store.
    for (let i = 0; i < 12; i++) {
      await adapter.executeRun(
        `INSERT INTO node (content, name, summary, topic) VALUES (?, ?, ?, ?)`,
        [`row ${i}: ${LONG_IDENT} calls unref twice on the child handle`, `n${i}`, `s${i}`, 't'],
      );
    }
    await adapter.exec(
      `INSERT INTO fts_node(rowid, content, name, summary)
         SELECT rowid, content, name, summary FROM node`,
    );

    // Ground truth: the index genuinely works.
    const truth = await adapter.executeGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM fts_node WHERE fts_node MATCH ?`,
      [LONG_IDENT],
    );
    expect(truth!.c, 'precondition: the index really does contain these rows').toBe(12);

    const report = await verifyStoreIntegrity(adapter, { only: ['fts_index_live'] });
    expect(
      report.damaged,
      'a healthy index must not be reported damaged: ' + JSON.stringify(report.findings, null, 2),
    ).toEqual([]);
    expect(report.findings.find((f) => f.object === 'fts_node')?.status).toBe('ok');
  });

  it('THE INVARIANT: repair whose actions all succeed leaves reverification agreeing with ground truth', async () => {
    const dbPath = tempPath('bl374-invariant');
    const build = track(createSqliteAdapter({ dbPath }));
    await build.exec(NODE_DDL);
    await build.exec(FTS5_DDL);
    await build.init();
    for (let i = 0; i < 15; i++) {
      await build.executeRun(
        `INSERT INTO node (content, name, summary, topic) VALUES (?, ?, ?, ?)`,
        [`entry ${i}: ${LONG_IDENT} concerning quarterly hippopotamus logistics`, `n${i}`, `s${i}`, 't'],
      );
    }
    await build.exec(
      `INSERT INTO fts_node(rowid, content, name, summary)
         SELECT rowid, content, name, summary FROM node`,
    );

    // Damage BOTH artifacts, as the live store was.
    seedEmptyFts5Index(build, 'fts_node');
    seedDuplicateAdapterMeta(build); // closes the raw handle
    open.pop();
    const dupes = track(createSqliteAdapter({ dbPath }));
    await dupes.executeRun(`INSERT INTO _adapter_meta (key, value) VALUES (?, ?)`, [
      'adapter_type',
      'turso',
    ]);

    const before = await verifyStoreIntegrity(dupes);
    expect(before.damaged.length, 'precondition: both artifacts must read damaged').toBeGreaterThanOrEqual(2);

    const repair = await repairStoreIntegrity(dupes, before);

    // Every action succeeded…
    expect(repair.actions.length).toBeGreaterThan(0);
    for (const a of repair.actions) expect(a.ok, `${a.object}: ${a.error ?? ''}`).toBe(true);

    // …so reverification must agree, and the top-level verdict must clear.
    expect(repair.verified, 'repair must be re-verified, never believed on its own').not.toBeNull();
    expect(
      repair.verified!.damaged,
      'reverify disagreed with successful repairs: ' +
        JSON.stringify(repair.verified!.damaged, null, 2),
    ).toEqual([]);
    expect(repair.ok).toBe(true);

    // Cross-checked against DIRECT ground truth in this same test, so the
    // assertion cannot pass on a summariser that merely agrees with itself.
    const ftsTruth = await dupes.executeGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM fts_node WHERE fts_node MATCH ?`,
      ['hippopotamus'],
    );
    expect(ftsTruth!.c, 'ground truth: FTS must really match every row again').toBe(15);
    const metaTruth = await dupes.executeAll<{ key: string }>(
      `SELECT key FROM _adapter_meta ORDER BY rowid`,
    );
    const counts = new Map<string, number>();
    for (const r of metaTruth.rows) counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
    for (const [k, c] of counts) expect(c, `ground truth: duplicate key ${k}`).toBe(1);

    // And the operator-facing verdict clears to `repaired` / healthy.
    const view = summarizeIntegrityForStatus({ verify: before, repair }, Date.now());
    expect(view.overall).toBe('repaired');
    expect(view.healthy).toBe(true);
    expect(integrityHeadline(view)).toMatch(/REPAIRED/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BL-373 — a stale Turso WAL-index sidecar (`-tshm`) makes the store
// permanently unopenable, and the driver's diagnostic names the wrong file.
//
// Reproduced from the preserved live artifacts: with a `-tshm` from the
// previous day beside a 0-byte WAL, every open failed with
// `I/O error: short read on WAL frame at offset 383192: expected 4096 bytes,
// got 0` — a WAL frame that cannot exist in an empty WAL. The backend
// crash-looped. Moving the `-tshm` aside made the store open immediately.
// Removing the ordinary `-shm` alone did NOT help.
// ═══════════════════════════════════════════════════════════════════════════

tursoDescribe('BL-373 — a stale WAL-index sidecar is reconciled at open, not fatal', () => {
  /** Build a real store, then fabricate the stale-sidecar state: a `-tshm`
   *  describing WAL frames that no longer exist, beside an empty WAL. */
  async function seedStaleTshm(dbPath: string): Promise<void> {
    // Seeded with the RAW driver on purpose. Going through the adapter would
    // write `_adapter_meta` (stamp + clean-shutdown marker) AFTER the
    // checkpoint, putting fresh frames back into the WAL and defeating the
    // fixture — the adapter's own behaviour must stay out of the seed.
    const { connect } = (await import('@tursodatabase/database')) as {
      connect: (p: string, o?: unknown) => Promise<{
        exec: (sql: string) => Promise<void>;
        run: (sql: string, ...a: unknown[]) => Promise<unknown>;
        all: (sql: string) => Promise<unknown>;
        close: () => Promise<void>;
      }>;
    };
    const seed = await connect(dbPath, { experimental: ['index_method', 'multiprocess_wal'] });
    await seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    // Enough frames that the captured sidecar describes WAL content the
    // checkpoint then discards. Measured: 300 and 600 rows do NOT reproduce,
    // 900 and 1200 do — the sidecar has to outlive frames that really existed.
    for (let i = 0; i < 1200; i++) {
      await seed.run('INSERT INTO t (v) VALUES (?)', 'v'.repeat(400) + i);
    }
    const tshm = dbPath + '-tshm';
    expect(existsSync(tshm), 'precondition: Turso must have created a -tshm').toBe(true);
    const captured = join(tmpDir, `captured-${Date.now()}.tshm`);
    copyFileSync(tshm, captured);
    // Checkpoint + close empties the WAL and clears the sidecar…
    await seed.all('PRAGMA wal_checkpoint(TRUNCATE)');
    await seed.close();
    // …then put the OLD sidecar back beside the now-empty WAL. That is exactly
    // the state the live store came back in after a restart.
    copyFileSync(captured, tshm);
  }

  it('opens the store and moves the stale sidecar aside instead of crash-looping', async () => {
    const dbPath = tempPath('bl373');
    await seedStaleTshm(dbPath);

    // NEGATIVE CONTROL: the raw driver must actually fail on this state,
    // otherwise the recovery below proves nothing.
    const { connect } = (await import('@tursodatabase/database')) as {
      connect: (p: string, o?: unknown) => Promise<{ close: () => Promise<void> }>;
    };
    let rawError: string | null = null;
    try {
      const raw = await connect(dbPath, { experimental: ['index_method', 'multiprocess_wal'] });
      await raw.close();
    } catch (err) {
      rawError = err instanceof Error ? err.message : String(err);
    }
    if (rawError === null) {
      // The driver tolerated it — this build does not exhibit BL-373, so the
      // recovery cannot be exercised. Fail loudly rather than pass vacuously.
      expect.fail(
        'precondition not met: the raw driver opened a store with a stale -tshm, ' +
          'so this test cannot demonstrate the recovery. Re-derive the seed.',
      );
    }
    expect(rawError).toMatch(/WAL frame|wal[- ]?index/i);

    // The adapter must recover where the raw driver could not.
    const adapter = track(await TursoAdapterImpl.connect({ dbPath }));
    const rows = await adapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM t');
    expect(rows!.c, 'every row must still be there — recovery must not lose data').toBe(1200);

    // The stale sidecar is preserved for forensics, never deleted.
    const asideFiles = readdirSync(dirname(dbPath)).filter(
      (f) => f.startsWith(basename(dbPath) + '-tshm.stale-'),
    );
    expect(asideFiles.length, 'the stale -tshm must be renamed, not destroyed').toBeGreaterThan(0);
  });

  it('recovery is DECLINED when the WAL has content — never discard state that may be needed', () => {
    const dbPath = join(tmpDir, `bl373-decline-${Date.now()}.db`);
    writeFileSync(dbPath, '');
    writeFileSync(dbPath + '-wal', 'x'.repeat(4096));
    writeFileSync(dbPath + '-tshm', 'y'.repeat(32));

    const recovery = recoverStaleWalIndex(dbPath);
    expect(recovery.attempted).toBe(false);
    expect(recovery.movedAside).toEqual([]);
    expect(recovery.declined).toMatch(/holds 4096 bytes/);
    expect(existsSync(dbPath + '-tshm'), 'the sidecar must be left untouched').toBe(true);
  });

  it('the error names -tshm, which the driver message never does', () => {
    const original = new Error(
      'failed to open database /x/memory.db: I/O error: short read on WAL frame at offset 383192: expected 4096 bytes, got 0',
    );
    expect(isStaleWalIndexError(original)).toBe(true);
    expect(isStaleWalIndexError(new Error('no such table: node'))).toBe(false);

    const described = describeStaleWalIndexFailure(
      '/x/memory.db',
      { attempted: false, movedAside: [], declined: 'the WAL holds 12 bytes' },
      original,
    );
    expect(described.message).toContain('/x/memory.db-tshm');
    expect(described.message).toMatch(/BL-373/);
    // The original driver text must survive — it is still the primary evidence.
    expect(described.message).toContain('short read on WAL frame');
  });
});
