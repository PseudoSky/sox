/**
 * A2 — FTS operations (FEAT-SOXGRAPH-001) on the store-adapter surface:
 * `ftsSearch`, `ftsCount`, `ensureFtsIndex`, and the `fts-ops.ts` builders.
 *
 * Real adapters only — real better-sqlite3 temp dbPath (SqliteAdapterImpl)
 * and real @tursodatabase/database temp dbPath (TursoAdapterImpl, connect()
 * defaults already carry `experimental: ['index_method']` — see
 * turso-fts-index-method.test.ts). No mocks gate any behavior in this suite.
 *
 * ── The parity test is the red→green star (BL-367, BL-225) ──────────────────
 * `identical rowid sets for a multi-term query on sqlite vs turso` fails when
 * the match query is the engine's naive default — SQLite FTS5 ANDs bareword
 * tokens (`fox riverbank` requires BOTH in one row) while Turso's Tantivy
 * matches ANY. Against the corpus below, the naive sqlite form returns
 * {1,4} while turso returns {1,2,3,4,8}. Landing the explicit
 * `"fox" OR "riverbank"` form (FTSDialect.buildMatchQuery, BL-367) makes both
 * engines return the identical set — red→green was run live (see the report).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAdapterImpl } from './sqlite-adapter.js';
import { TursoAdapterImpl } from './turso-adapter.js';
import { MockAdapter } from './mock-adapter.js';
import { buildFtsSearchSql, ensureFtsIndex, ftsCount, ftsSearch } from './fts-ops.js';
import { createFTSDialect } from './fts-dialect.js';
import type { StoreAdapter } from './types.js';

const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();
const tursoDescribe = hasTurso ? describe : describe.skip;

// ── Fixtures ────────────────────────────────────────────────────────────────

const FTS_COLUMNS = ['content', 'name', 'summary'];

/** graph-store's FTS5 DDL shape (external content on `node`, rowid-mapped),
 *  inlined here because store-adapter cannot depend on graph-store. */
const FTS5_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS fts_node USING fts5(content, name, summary,
  content='node', content_rowid='rowid', tokenize='unicode61')`;

const FTS5_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS fts_node_ai AFTER INSERT ON node BEGIN
  INSERT INTO fts_node(rowid, content, name, summary)
    VALUES (new.rowid, new.content, new.name, new.summary);
END;
CREATE TRIGGER IF NOT EXISTS fts_node_ad AFTER DELETE ON node BEGIN
  INSERT INTO fts_node(fts_node, rowid, content, name, summary)
    VALUES ('delete', old.rowid, old.content, old.name, old.summary);
END;
CREATE TRIGGER IF NOT EXISTS fts_node_au AFTER UPDATE ON node BEGIN
  INSERT INTO fts_node(fts_node, rowid, content, name, summary)
    VALUES ('delete', old.rowid, old.content, old.name, old.summary);
  INSERT INTO fts_node(rowid, content, name, summary)
    VALUES (new.rowid, new.content, new.name, new.summary);
END;`;

/** 8 rows; rowids 1..8. `fox` lives on rows 1,2,4; `riverbank` on 1,3,4 —
 *  rows 1 and 4 carry BOTH. Both terms have df = 3 (idf > 0 under BM25), so
 *  both-term rows rank strictly above single-term rows — making limit/offset
 *  assertions deterministic. For the query `fox riverbank`: bareword-AND
 *  (sqlite default) → {1,4}; explicit OR → {1,2,3,4}. */
const SEED_ROWS: Array<[number, string, string, string]> = [
  [1, 'fox riverbank runs fast', 'alpha', 'swift mammal'],
  [2, 'a quick brown fox jumped', 'beta', ''],
  [3, 'the riverbank is green', 'gamma', 'riverside'],
  [4, 'fox and riverbank together', 'delta', ''],
  [5, 'nothing to see here', 'epsilon', ''],
  [6, 'moonlight sonata plays', 'zeta', 'MOONLIGHT moves'],
  [7, 'durable storage works', 'eta', ''],
  [8, 'a quiet zebra sleeps', 'theta', ''],
];

async function seedNodeTable(adapter: StoreAdapter): Promise<void> {
  await adapter.exec(
    'CREATE TABLE node (rowid INTEGER PRIMARY KEY, content TEXT, name TEXT, summary TEXT)',
  );
  for (const [rowid, content, name, summary] of SEED_ROWS) {
    await adapter.executeRun(
      'INSERT INTO node (rowid, content, name, summary) VALUES (?, ?, ?, ?)',
      [rowid, content, name, summary],
    );
  }
}

/** Ensure the FTS index on both backends with the caller-supplied DDL on
 *  sqlite (Turso generates its own). */
async function seedFtsIndex(adapter: StoreAdapter): Promise<void> {
  const res = await adapter.ensureFtsIndex('node', FTS_COLUMNS, {
    sqliteDDL: [FTS5_DDL, FTS5_TRIGGERS],
  });
  if (!res.ensured) throw new Error('ensureFtsIndex failed to ensure');
}

const rowids = (rows: Array<{ rowid: number }>): number[] =>
  rows.map((r) => r.rowid).sort((a, b) => a - b);

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-a2-fts-ops-'));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const open: StoreAdapter[] = [];
async function openSqlite(): Promise<SqliteAdapterImpl> {
  const adapter = new SqliteAdapterImpl(
    join(tmpDir, `sqlite-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`),
  );
  open.push(adapter);
  return adapter;
}
async function openTurso(): Promise<TursoAdapterImpl> {
  const adapter = await TursoAdapterImpl.connect({
    dbPath: join(tmpDir, `turso-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`),
  });
  open.push(adapter);
  return adapter;
}
afterEach(async () => {
  while (open.length > 0) {
    const a = open.pop();
    try {
      await a?.close();
    } catch {
      // best effort
    }
  }
});

// ── The parity star (red→green on the sqlite-AND default) ──────────────────

describe('A2 ftsSearch — sqlite vs turso parity (BL-367)', () => {
  it('returns the IDENTICAL rowid set for a multi-term query on both real backends', async () => {
    const sqlite = await openSqlite();
    const turso = await openTurso();
    await seedNodeTable(sqlite);
    await seedNodeTable(turso);
    await seedFtsIndex(sqlite);
    await seedFtsIndex(turso);

    const sqliteHits = await sqlite.ftsSearch('node', FTS_COLUMNS, 'fox riverbank');
    const tursoHits = await turso.ftsSearch('node', FTS_COLUMNS, 'fox riverbank');

    // Explicit-OR semantics: any row containing either term. The sqlite
    // bareword-AND default returns only {1,4} here — this is the BL-367
    // red→green assertion.
    expect(rowids(sqliteHits)).toEqual([1, 2, 3, 4]);
    expect(rowids(tursoHits)).toEqual([1, 2, 3, 4]);
    expect(rowids(sqliteHits)).toEqual(rowids(tursoHits));
    expect(sqliteHits.length).toBe(4);
    expect(tursoHits.length).toBe(4);
  });

  it('is case-insensitive on both backends', async () => {
    const sqlite = await openSqlite();
    const turso = await openTurso();
    await seedNodeTable(sqlite);
    await seedNodeTable(turso);
    await seedFtsIndex(sqlite);
    await seedFtsIndex(turso);

    expect(rowids(await sqlite.ftsSearch('node', FTS_COLUMNS, 'FOX RIVERBANK'))).toEqual([1, 2, 3, 4]);
    expect(rowids(await turso.ftsSearch('node', FTS_COLUMNS, 'FOX RIVERBANK'))).toEqual([1, 2, 3, 4]);
    // Mixed-case term inside a column value (summary 'MOONLIGHT moves')
    expect(rowids(await sqlite.ftsSearch('node', FTS_COLUMNS, 'moonlight'))).toEqual([6]);
    expect(rowids(await turso.ftsSearch('node', FTS_COLUMNS, 'moonlight'))).toEqual([6]);
  });
});

// ── BUG-013: turso positional-bind fts_score returns 0 (score>0 gate) ───────
// turso drivers 0.7.1 AND 0.7.2 return score=0 for EVERY row when fts_score's
// query arrives via a POSITIONAL `?` bind; NAMED params and INLINE literals
// return real BM25 (debug-triage probe, 2026-08-12 — reproduced on both driver
// versions). fts-ops buildFtsSearchSql used to bind fts_match/fts_score
// positionally, so every adapter-mediated turso ftsSearch scored 0 (recall
// unaffected — RRF ranks on position, not score; hybrid-search textScore
// degraded). The fix inlines the match query as an escaped SQL literal; this
// test is the RED→GREEN gate that makes score=0 VISIBLE — the existing parity
// tests only compare rowids and cannot catch it. It also gates the eventual
// revert to parameterized binds (see the debt note in fts-ops.ts).

tursoDescribe('A2 ftsSearch — turso scores real BM25, not 0 (BUG-013)', () => {
  it('returns score > 0 for a known match through adapter.ftsSearch, ranked both-term above single-term', async () => {
    const turso = await openTurso();
    await seedNodeTable(turso);
    await seedFtsIndex(turso);

    const hits = await turso.ftsSearch('node', FTS_COLUMNS, 'fox riverbank');
    expect(hits).toHaveLength(4);
    for (const h of hits) {
      expect(Number.isFinite(h.score)).toBe(true);
      expect(h.score).toBeGreaterThan(0);
    }
    // BM25 sanity: rows 1 and 4 carry BOTH terms → strictly above single-term
    // rows 2 and 3. A driver regression to degenerate scoring would flatten
    // this ordering even when every score is technically positive.
    const byId = new Map(hits.map((h) => [h.rowid, h.score]));
    const bothTerms = Math.min(byId.get(1)!, byId.get(4)!);
    const singleTerm = Math.max(byId.get(2)!, byId.get(3)!);
    expect(bothTerms).toBeGreaterThan(singleTerm);
  });

  it('a single-quote-bearing query token parses through the inlined literal (escaping guard)', async () => {
    const turso = await openTurso();
    await seedNodeTable(turso);
    await seedFtsIndex(turso);
    // `zzz'qq` matches nothing in the corpus — the assertion is that the
    // escaped literal parses. A regression that interpolates buildMatchQuery
    // output raw (no `'`-doubling) would throw a SQL syntax error here.
    const hits = await turso.ftsSearch('node', FTS_COLUMNS, "zzz'qq");
    expect(hits).toEqual([]);
  });
});

// ── buildFtsSearchSql — BUG-013 inline-literal shape ────────────────────────

describe('A2 buildFtsSearchSql — inlines the match query as an escaped literal (BUG-013)', () => {
  const tursoDialect = createFTSDialect('turso');
  const sqliteDialect = createFTSDialect('sqlite');

  it('turso: both fts_match and fts_score receive the quoted literal; query dropped from params', () => {
    const { sql, params } = buildFtsSearchSql(
      tursoDialect,
      'node',
      FTS_COLUMNS,
      '"fox" OR "riverbank"',
      {},
    );
    expect(sql).toContain(`fts_match("content", "name", "summary", '"fox" OR "riverbank"')`);
    expect(sql).toContain(`fts_score("content", "name", "summary", '"fox" OR "riverbank"')`);
    expect(params).not.toContain('"fox" OR "riverbank"');
    expect(params).toEqual([50]); // default limit only — no query binds
  });

  it('sqlite: fts_node MATCH receives the quoted literal; query dropped from params', () => {
    const { sql, params } = buildFtsSearchSql(
      sqliteDialect,
      'node',
      FTS_COLUMNS,
      '"fox" OR "riverbank"',
      {},
    );
    expect(sql).toContain(`fts_node MATCH '"fox" OR "riverbank"'`);
    expect(params).not.toContain('"fox" OR "riverbank"');
    expect(params).toEqual([50]);
  });

  it('doubles single quotes inside tokens — buildMatchQuery output is NOT SQL-safe raw', () => {
    const ftsQuery = `"don't" OR "stop"`;
    const { sql } = buildFtsSearchSql(tursoDialect, 'node', FTS_COLUMNS, ftsQuery, {});
    expect(sql).toContain(`fts_match("content", "name", "summary", '"don''t" OR "stop"')`);
    expect(sql).not.toContain(`'"don't" OR "stop"'`); // raw quote must never reach the SQL
    const { sql: sqliteSql } = buildFtsSearchSql(sqliteDialect, 'node', FTS_COLUMNS, ftsQuery, {});
    expect(sqliteSql).toContain(`fts_node MATCH '"don''t" OR "stop"'`);
  });

  it('keeps where/limit/offset binds positional while only the query is inlined', () => {
    const { sql, params } = buildFtsSearchSql(
      tursoDialect,
      'node',
      FTS_COLUMNS,
      '"fox" OR "riverbank"',
      { where: 'n.rowid >= ?', params: [3], limit: 2, offset: 1 },
    );
    expect(sql).toContain(`fts_match("content", "name", "summary", '"fox" OR "riverbank"')`);
    // subquery shape: inner LIMIT (limit+offset), outer LIMIT/OFFSET
    expect(params).toEqual([3, 3, 2, 1]);
  });
});

// ── sqlite score sanity (BUG-013 parity: sqlite must keep real BM25) ────────

describe('A2 ftsSearch — sqlite score sanity (BUG-013 parity)', () => {
  it('returns finite scores with both-term rows strictly above single-term rows', async () => {
    const sqlite = await openSqlite();
    await seedNodeTable(sqlite);
    await seedFtsIndex(sqlite);
    const hits = await sqlite.ftsSearch('node', FTS_COLUMNS, 'fox riverbank');
    expect(hits).toHaveLength(4);
    for (const h of hits) {
      expect(Number.isFinite(h.score)).toBe(true);
    }
    const byId = new Map(hits.map((h) => [h.rowid, h.score]));
    const bothTerms = Math.min(byId.get(1)!, byId.get(4)!);
    const singleTerm = Math.max(byId.get(2)!, byId.get(3)!);
    expect(bothTerms).toBeGreaterThan(singleTerm);
  });
});

// ── Search options: where / limit / offset ──────────────────────────────────

describe('A2 ftsSearch — where fragment, limit, offset (n-alias)', () => {
  async function seeded(): Promise<{ sqlite: SqliteAdapterImpl; turso: TursoAdapterImpl }> {
    const sqlite = await openSqlite();
    const turso = await openTurso();
    await seedNodeTable(sqlite);
    await seedNodeTable(turso);
    await seedFtsIndex(sqlite);
    await seedFtsIndex(turso);
    return { sqlite, turso };
  }

  it('ANDs an n-aliased where fragment with bound params (both forms: bare and WHERE-prefixed)', async () => {
    const { sqlite, turso } = await seeded();
    const opts = { where: 'n.rowid >= ?', params: [3] };
    expect(rowids(await sqlite.ftsSearch('node', FTS_COLUMNS, 'fox', opts))).toEqual([4]);
    expect(rowids(await turso.ftsSearch('node', FTS_COLUMNS, 'fox', opts))).toEqual([4]);

    const wherePrefixed = { where: 'WHERE n.name = ?', params: ['beta'] };
    expect(rowids(await sqlite.ftsSearch('node', FTS_COLUMNS, 'fox', wherePrefixed))).toEqual([2]);
    expect(rowids(await turso.ftsSearch('node', FTS_COLUMNS, 'fox', wherePrefixed))).toEqual([2]);
  });

  it('applies limit and offset in score order (both-term rows rank above single-term rows)', async () => {
    const { sqlite, turso } = await seeded();
    // 'fox riverbank': rows {1,4} carry both terms and rank strictly higher.
    const top2Sqlite = await sqlite.ftsSearch('node', FTS_COLUMNS, 'fox riverbank', { limit: 2 });
    const top2Turso = await turso.ftsSearch('node', FTS_COLUMNS, 'fox riverbank', { limit: 2 });
    expect(rowids(top2Sqlite)).toEqual([1, 4]);
    expect(rowids(top2Turso)).toEqual([1, 4]);

    const offSqlite = await sqlite.ftsSearch('node', FTS_COLUMNS, 'fox riverbank', { offset: 2 });
    const offTurso = await turso.ftsSearch('node', FTS_COLUMNS, 'fox riverbank', { offset: 2 });
    expect(rowids(offSqlite)).toEqual([2, 3]);
    expect(rowids(offTurso)).toEqual([2, 3]);

    const page2Sqlite = await sqlite.ftsSearch('node', FTS_COLUMNS, 'fox riverbank', { offset: 2, limit: 1 });
    const page2Turso = await turso.ftsSearch('node', FTS_COLUMNS, 'fox riverbank', { offset: 2, limit: 1 });
    // Both engines return exactly one row from the tied single-term pair
    // {2,3} — WHICH tie member is engine-determined, so assert membership.
    expect(page2Sqlite.length).toBe(1);
    expect([2, 3]).toContain(page2Sqlite[0]!.rowid);
    expect(page2Turso.length).toBe(1);
    expect([2, 3]).toContain(page2Turso[0]!.rowid);
  });

  it('defaults limit to 50 when unspecified', async () => {
    const { sqlite } = await seeded();
    const all = await sqlite.ftsSearch('node', FTS_COLUMNS, 'fox riverbank');
    expect(all.length).toBe(4);
  });
});

// ── ftsCount ────────────────────────────────────────────────────────────────

describe('A2 ftsCount — real backends', () => {
  it('counts the same rowid set as ftsSearch, honoring where', async () => {
    const sqlite = await openSqlite();
    const turso = await openTurso();
    await seedNodeTable(sqlite);
    await seedNodeTable(turso);
    await seedFtsIndex(sqlite);
    await seedFtsIndex(turso);

    expect(await sqlite.ftsCount('node', FTS_COLUMNS, 'fox riverbank')).toBe(4);
    expect(await turso.ftsCount('node', FTS_COLUMNS, 'fox riverbank')).toBe(4);
    expect(await sqlite.ftsCount('node', FTS_COLUMNS, 'fox')).toBe(3);
    expect(await turso.ftsCount('node', FTS_COLUMNS, 'fox')).toBe(3);
    expect(await sqlite.ftsCount('node', FTS_COLUMNS, 'zzzqqunmatched')).toBe(0);
    expect(await turso.ftsCount('node', FTS_COLUMNS, 'zzzqqunmatched')).toBe(0);

    const opts = { where: 'n.rowid >= ?', params: [3] };
    expect(await sqlite.ftsCount('node', FTS_COLUMNS, 'fox', opts)).toBe(1);
    expect(await turso.ftsCount('node', FTS_COLUMNS, 'fox', opts)).toBe(1);
  });
});

// ── Empty queries and the capability gate ───────────────────────────────────

describe('A2 — empty queries and the fts:false capability gate', () => {
  it('returns [] / 0 for empty or whitespace-only queries, never throws', async () => {
    const sqlite = await openSqlite();
    await seedNodeTable(sqlite);
    await seedFtsIndex(sqlite);
    expect(await sqlite.ftsSearch('node', FTS_COLUMNS, '')).toEqual([]);
    expect(await sqlite.ftsSearch('node', FTS_COLUMNS, '   ')).toEqual([]);
    expect(await sqlite.ftsCount('node', FTS_COLUMNS, '')).toBe(0);
    expect(await sqlite.ftsCount('node', FTS_COLUMNS, '   ')).toBe(0);
  });

  it('gates on capabilities.fts === false — ftsSearch [], ftsCount 0, ensureFtsIndex {ensured:false}, never throws', async () => {
    const gated = {
      config: { type: 'sqlite' },
      capabilities: { fts: false },
    } as unknown as StoreAdapter;
    expect(await ftsSearch(gated, 'node', FTS_COLUMNS, 'fox')).toEqual([]);
    expect(await ftsCount(gated, 'node', FTS_COLUMNS, 'fox')).toBe(0);
    expect(await ensureFtsIndex(gated, 'node', FTS_COLUMNS)).toEqual({
      ensured: false,
      adoptedExisting: null,
      indexName: null,
      backfilled: false,
      residueDropped: [],
      residueNeedsOutOfBand: false,
    });
  });
});

// ── ensureFtsIndex ──────────────────────────────────────────────────────────

describe('A2 ensureFtsIndex — canonical create (sqlite FTS5)', () => {
  it('creates the FTS5 shadow table, backfills it, and reports the shape', async () => {
    const sqlite = await openSqlite();
    await seedNodeTable(sqlite);
    const res = await sqlite.ensureFtsIndex('node', FTS_COLUMNS, {
      sqliteDDL: [FTS5_DDL, FTS5_TRIGGERS],
    });
    expect(res.ensured).toBe(true);
    expect(res.adoptedExisting).toBeNull();
    expect(res.indexName).toBe('fts_node');
    expect(res.backfilled).toBe(true);
    expect(res.residueDropped).toEqual([]);
    expect(res.residueNeedsOutOfBand).toBe(false);

    // The backfill made the shadow table searchable immediately.
    expect(rowids(await sqlite.ftsSearch('node', FTS_COLUMNS, 'fox'))).toEqual([1, 2, 4]);
  });

  it('is idempotent on re-ensure (per-statement already-exists skip)', async () => {
    const sqlite = await openSqlite();
    await seedNodeTable(sqlite);
    const first = await sqlite.ensureFtsIndex('node', FTS_COLUMNS, {
      sqliteDDL: [FTS5_DDL, FTS5_TRIGGERS],
    });
    const second = await sqlite.ensureFtsIndex('node', FTS_COLUMNS, {
      sqliteDDL: [FTS5_DDL, FTS5_TRIGGERS],
    });
    expect(first.ensured).toBe(true);
    expect(second.ensured).toBe(true);
    expect(second.backfilled).toBe(false); // shadow table already has the rows
    expect(rowids(await sqlite.ftsSearch('node', FTS_COLUMNS, 'fox riverbank'))).toEqual([1, 2, 3, 4]);
  });

  it('skips the backfill when backfill:false', async () => {
    const sqlite = await openSqlite();
    await seedNodeTable(sqlite);
    const res = await sqlite.ensureFtsIndex('node', FTS_COLUMNS, {
      sqliteDDL: [FTS5_DDL, FTS5_TRIGGERS],
      backfill: false,
    });
    expect(res.ensured).toBe(true);
    expect(res.backfilled).toBe(false);
  });

  it('drops the other dialect\'s legacy residue (real objects under the exact residue names)', async () => {
    // The turso FTS residue's REAL DDL (`CREATE INDEX … USING fts`,
    // `… USING backing_btree`) is unparseable by vanilla better-sqlite3 — the
    // BL-329 guard refuses such a store at open, which is precisely why this
    // branch is defense-in-depth on sqlite. The branch's contract is NAME-based
    // (detect dialect.legacyResidueNames → run dropLegacyDDL → report), so this
    // test exercises it end-to-end on a real adapter with real objects bearing
    // the exact residue names.
    const sqlite = await openSqlite();
    await seedNodeTable(sqlite);
    await sqlite.exec('CREATE INDEX idx_fts_node ON node (rowid)');
    await sqlite.exec('CREATE TABLE __turso_internal_fts_dir_idx_fts_node (path TEXT)');
    await sqlite.exec(
      'CREATE INDEX __turso_internal_fts_dir_idx_fts_node_key ON __turso_internal_fts_dir_idx_fts_node (path)',
    );

    const res = await sqlite.ensureFtsIndex('node', FTS_COLUMNS, {
      sqliteDDL: [FTS5_DDL, FTS5_TRIGGERS],
    });
    expect(res.ensured).toBe(true);
    expect(res.residueDropped.sort()).toEqual(
      ['idx_fts_node', '__turso_internal_fts_dir_idx_fts_node', '__turso_internal_fts_dir_idx_fts_node_key'].sort(),
    );
    expect(res.residueNeedsOutOfBand).toBe(false);
    const leftover = await sqlite.executeAll<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE name IN ('idx_fts_node', '__turso_internal_fts_dir_idx_fts_node', '__turso_internal_fts_dir_idx_fts_node_key')",
    );
    expect(leftover.rows).toEqual([]);
  });
});

tursoDescribe('A2 ensureFtsIndex — turso (Tantivy)', () => {
  it('creates the canonical Tantivy index; no backfill surface (fts5 === false)', async () => {
    const turso = await openTurso();
    await seedNodeTable(turso);
    const res = await turso.ensureFtsIndex('node', FTS_COLUMNS);
    expect(res.ensured).toBe(true);
    expect(res.adoptedExisting).toBeNull();
    expect(res.indexName).toBe('idx_fts_node');
    expect(res.backfilled).toBe(false);
    expect(res.residueDropped).toEqual([]);
    expect(res.residueNeedsOutOfBand).toBe(false);

    const idx = await turso.executeAll<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='node' AND sql LIKE '%USING fts%'",
    );
    expect(idx.rows).toHaveLength(1);
    expect(rowids(await turso.ftsSearch('node', FTS_COLUMNS, 'fox riverbank'))).toEqual([1, 2, 3, 4]);
  });

  it('ADOPTS a non-canonical existing index by lookup instead of duplicating it (BL-461)', async () => {
    const turso = await openTurso();
    await seedNodeTable(turso);
    // What the BL-461 orphan guard leaves behind after a rebuild: a healthy
    // index that can never be renamed back onto idx_fts_node.
    await turso.exec(
      'CREATE INDEX idx_fts_node__r1 ON "node" USING fts ("content", "name", "summary")',
    );

    const res = await turso.ensureFtsIndex('node', FTS_COLUMNS);
    expect(res.ensured).toBe(true);
    expect(res.adoptedExisting).toBe('idx_fts_node__r1');
    expect(res.indexName).toBe('idx_fts_node__r1');

    // MUST NOT have built a second full index over the same columns.
    const idx = await turso.executeAll<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='node' AND sql LIKE '%USING fts%'",
    );
    expect(idx.rows).toEqual([{ name: 'idx_fts_node__r1' }]);
    expect(rowids(await turso.ftsSearch('node', FTS_COLUMNS, 'fox riverbank'))).toEqual([1, 2, 3, 4]);
  });

  it('is idempotent across a close/reopen cycle', async () => {
    const dbPath = join(tmpDir, `turso-reopen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    {
      const first = await TursoAdapterImpl.connect({ dbPath });
      open.push(first);
      await seedNodeTable(first);
      const res = await first.ensureFtsIndex('node', FTS_COLUMNS);
      expect(res.ensured).toBe(true);
      expect(res.adoptedExisting).toBeNull();
      await first.close();
      const i = open.indexOf(first);
      if (i >= 0) open.splice(i, 1);
    }
    const reopened = await TursoAdapterImpl.connect({ dbPath });
    open.push(reopened);
    const res = await reopened.ensureFtsIndex('node', FTS_COLUMNS);
    expect(res.ensured).toBe(true);
    expect(res.adoptedExisting).toBeNull();
    const idx = await reopened.executeAll<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='node' AND sql LIKE '%USING fts%'",
    );
    expect(idx.rows).toEqual([{ name: 'idx_fts_node' }]);
  });

  it('detects SQLite FTS5 residue and reports residueNeedsOutOfBand (drops nothing)', async () => {
    const dbPath = join(tmpDir, `turso-residue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    // Build the fts5 residue with better-sqlite3 — the Turso engine cannot
    // create fts5 objects; it merely tolerates their presence (verified: a
    // store carrying them opens, writes and reads fine on Turso).
    {
      const b = new SqliteAdapterImpl(dbPath);
      await b.exec('CREATE TABLE node (rowid INTEGER PRIMARY KEY, content TEXT)');
      await b.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS fts_node USING fts5(content, content='node', content_rowid='rowid')",
      );
      await b.exec(
        'CREATE TRIGGER IF NOT EXISTS fts_node_ai AFTER INSERT ON node BEGIN INSERT INTO fts_node(rowid, content) VALUES (new.rowid, new.content); END',
      );
      await b.close();
    }

    // Connect to the FIXTURE path — the store carrying the fts5 residue.
    const turso = await TursoAdapterImpl.connect({ dbPath });
    open.push(turso);
    const res = await turso.ensureFtsIndex('node', ['content']);
    expect(res.ensured).toBe(true);
    // Dropping through the Turso engine would silently no-op (see
    // FTSDialect.dropLegacyDDL) — the branch must report, not drop.
    expect(res.residueNeedsOutOfBand).toBe(true);
    expect(res.residueDropped).toEqual([]);

    // The residue is still there — it was detected, not destroyed.
    const left = await turso.executeAll<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE name IN ('fts_node', 'fts_node_ai')",
    );
    expect(left.rows.map((r) => r.name).sort()).toEqual(['fts_node', 'fts_node_ai']);
  });
});

// ── MockAdapter (in-memory double for consumers) ────────────────────────────

describe('A2 MockAdapter — in-memory ftsSearch/ftsCount/ensureFtsIndex', () => {
  async function seededMock(): Promise<MockAdapter> {
    const mock = new MockAdapter();
    await seedNodeTable(mock);
    await mock.ensureFtsIndex('node', FTS_COLUMNS);
    return mock;
  }

  it('matches case-insensitively with score = matched-token count', async () => {
    const mock = await seededMock();
    const hits = await mock.ftsSearch('node', FTS_COLUMNS, 'FOX RIVERBANK');
    expect(rowids(hits)).toEqual([1, 2, 3, 4]);
    // Row 1 and 4 carry BOTH terms → score 2; single-term rows score 1.
    const byId = new Map(hits.map((h) => [h.rowid, h.score]));
    expect(byId.get(1)).toBe(2);
    expect(byId.get(4)).toBe(2);
    expect(byId.get(2)).toBe(1);
    expect(byId.get(3)).toBe(1);
  });

  it('honors the n-aliased where fragment with params, limit and offset', async () => {
    const mock = await seededMock();
    // The mock's SimpleSqlParser only understands `col = ?` fragments (real
    // operators like `>=` are exercised against the real adapters above).
    expect(rowids(await mock.ftsSearch('node', FTS_COLUMNS, 'fox', { where: 'n.rowid = ?', params: [4] }))).toEqual([4]);
    expect(rowids(await mock.ftsSearch('node', FTS_COLUMNS, 'fox', { where: 'WHERE n.name = ?', params: ['beta'] }))).toEqual([2]);
    expect(rowids(await mock.ftsSearch('node', FTS_COLUMNS, 'fox riverbank', { limit: 2 }))).toEqual([1, 4]);
    expect((await mock.ftsSearch('node', FTS_COLUMNS, 'fox riverbank', { offset: 2 })).length).toBe(2);
  });

  it('counts and gates like the real backends', async () => {
    const mock = await seededMock();
    expect(await mock.ftsCount('node', FTS_COLUMNS, 'fox riverbank')).toBe(4);
    expect(await mock.ftsCount('node', FTS_COLUMNS, '')).toBe(0);
    expect(await mock.ftsSearch('node', FTS_COLUMNS, '   ')).toEqual([]);
    expect(await mock.ensureFtsIndex('node', FTS_COLUMNS)).toMatchObject({
      ensured: true,
      indexName: 'fts_node',
      backfilled: true,
    });
  });
});
