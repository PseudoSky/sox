/**
 * FTS operation builders (A2 — FEAT-SOXGRAPH-001).
 *
 * This is the ONE exempt layer where store-adapter owns per-backend FTS query
 * SQL (the package's "no SQL above store-adapter" rule bends here by design —
 * the architect spec names this file as the exemption). Everything else in the
 * package stays SQL-free; the per-backend FTS knowledge (DDL, MATCH/score
 * clauses, residue) lives in `fts-dialect.ts`, and this module composes it
 * into complete search/count/ensure operations.
 *
 * The builders key on `FTSDialect.supportsShadowTable` — NEVER on
 * `adapter.config.type`:
 *
 * - SQLite FTS5 (`supportsShadowTable: true`): the index is a separate
 *   external-content virtual table `fts_<table>` kept in sync by triggers,
 *   joined back to the base table on rowid. Score is the NEGATED `rank`
 *   column (FTS5's rank is 0 = best, so negation makes higher = better).
 * - Turso Tantivy (`supportsShadowTable: false`): the index lives directly on
 *   the base table; `fts_match`/`fts_score` each take the query. (BUG-013) the
 *   query is inlined as an escaped SQL string literal — see
 *   {@link buildFtsSearchSql} — because turso drivers 0.7.1/0.7.2 return
 *   `fts_score=0` for every row when the query arrives via a positional `?`
 *   bind. `fts_score` is already higher = better.
 *
 * Multi-term queries are normalized (trim → lowercase → whitespace-split →
 * drop empties) and rebuilt as an explicit `"tok1" OR "tok2"` match query via
 * `FTSDialect.buildMatchQuery` (BL-367) so both engines return IDENTICAL
 * rowid sets for the same query — SQLite FTS5's bareword default is AND, which
 * silently drops every row where not all tokens co-occur.
 */
import {
  canonicalFtsIndexName,
  createFTSDialect,
  resolveExistingFtsIndexName,
} from './fts-dialect.js';
import { log } from '@adhd/sox-telemetry';
import type {
  FTSDialect,
  FtsCountOptions,
  FtsEnsureOptions,
  FtsEnsureResult,
  FtsSearchOptions,
  StoreAdapter,
} from './types.js';

// ── Query normalization ──────────────────────────────────────────────────────

/** trim → lowercase → whitespace-split → strip double quotes → drop empty
 *  tokens. Shared by every backend so the token sets fed to
 *  `buildMatchQuery` are engine-identical.
 *
 *  (BUG-STOREADAPTER-TURSO-FTS-QUOTE-ESCAPE-001) The double-quote strip is
 *  load-bearing, not cosmetic. A caller query that itself contains double
 *  quotes — e.g. a recall for `"e68be52c" or "cb47fb79" review findings` —
 *  tokenizes to `['"e68be52c"', 'or', ...]` with the quotes glued to the
 *  token. `buildMatchQuery` then escapes each embedded `"` by doubling it
 *  (the SQLite FTS5 convention) and wraps the result, producing a
 *  triple-quoted token. SQLite FTS5 parses that fine. Turso's Tantivy query
 *  parser does NOT implement a doubled quote as an escape inside a phrase
 *  and rejects the whole match query outright:
 *
 *    FTS parse error: Syntax Error: """e68be52c""" OR "or" OR ...
 *
 *  Measured 2026-09-22 against a live Turso store: the triple-quoted form
 *  throws, while `"e68be52c" OR "or"` returns rows — the triple-quote form
 *  is the sole culprit; the bare `"or"` token is NOT implicated. In
 *  production that error was caught by recall.ts's BL-391 handler and
 *  downgraded to an `fts:` degradation, so the BM25 arm silently produced
 *  zero rows for any recall whose query contained a quotation mark
 *  (observed once on the live store, pid 99483, 2026-09-22T19:57:59Z).
 *
 *  The fix lives HERE rather than in `TursoFTSDialect.buildMatchQuery`
 *  precisely to preserve the engine-identical-token-set invariant this
 *  function exists to guarantee: per-dialect quote handling would make the
 *  same caller query mean different things on the two backends. A double
 *  quote in a free-text recall query is search *syntax*, never searchable
 *  content, so dropping it is also the semantically correct read — the
 *  caller wants the term, not a literal-quote phrase. `buildMatchQuery`
 *  keeps its escaping as defence-in-depth for any non-recall caller that
 *  builds tokens without going through this function. */
export function normalizeFtsTokens(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ''))
    .filter((t) => t.length > 0);
}

/** Normalize a caller `where` fragment into an AND-joined suffix: tolerates a
 *  leading `WHERE`/`AND`, so `where: 'n.kind = ?'`, `'WHERE n.kind = ?'` and
 *  `'AND n.kind = ?'` all behave identically. Returns '' for empty input. */
function normalizeWhereFragment(where: string | undefined): string {
  if (!where || where.trim() === '') return '';
  const frag = where
    .trim()
    .replace(/^\s*WHERE\s+/i, '')
    .replace(/^\s*AND\s+/i, '')
    .trim();
  return frag === '' ? '' : `AND ${frag}`;
}

// ── Per-backend SQL builders ─────────────────────────────────────────────────

export interface FtsSearchSql {
  sql: string;
  params: unknown[];
}

/**
 * Build the search SQL for the given dialect.
 *
 * (BUG-013) The normalized match query is delivered to the FTS functions as an
 * ESCAPED SQL string literal (`sqlStringLiteral`) rather than a bound param:
 * turso drivers 0.7.1 AND 0.7.2 return `fts_score=0` for every row when the
 * query reaches `fts_score(..., ?)` through a positional bind (named params
 * and inline literals return real BM25 — verified empirically on both driver
 * versions). `fts_match` positional keeps selecting the correct rows, but
 * inlining BOTH keeps the two functions symmetric and removes the whole
 * bind-class. Params:
 * - shadow (SQLite): `[...whereParams, limit, offset?]` — no query bind
 *   (score is the negated rank column, which takes no query at all; the match
 *   query is the inlined literal)
 * - non-shadow (Turso): `[...whereParams, limit, offset?]` — both `fts_match`
 *   and `fts_score` receive the inlined literal
 *
 * DEBT (BUG-013): this is a driver-bug workaround, not a design choice.
 * REVERT to parameterized binds (`matchClause(columns, '?')` + the query back
 * in `params`) when the turso driver fixes the positional-bind score bug
 * upstream. The `A2 ftsSearch — turso scores real BM25, not 0 (BUG-013)` spec
 * (fts-ops.spec.ts) asserts `score > 0` on the turso path and gates the
 * revert: it must FAIL with score=0 on a regression to positional binds.
 */
export function buildFtsSearchSql(
  dialect: FTSDialect,
  table: string,
  columns: string[],
  ftsQuery: string,
  opts: FtsSearchOptions,
): FtsSearchSql {
  const andWhere = normalizeWhereFragment(opts.where);
  const queryLiteral = sqlStringLiteral(ftsQuery);
  const { sql: matchSql } = dialect.matchClause(columns, queryLiteral);
  const scoreExpr = dialect.scoreClause(columns, queryLiteral);
  const limit = opts.limit ?? 50;
  let limitClause = 'LIMIT ?';
  const limitParams: unknown[] = [limit];
  if (opts.offset !== undefined) {
    limitClause += ' OFFSET ?';
    limitParams.push(opts.offset);
  }
  if (dialect.supportsShadowTable) {
    return {
      sql: `SELECT n.*, n.rowid AS rowid, -${scoreExpr} AS score
        FROM fts_${table} JOIN ${table} n ON fts_${table}.rowid = n.rowid
        WHERE ${matchSql} ${andWhere}
        ORDER BY score DESC ${limitClause}`,
      params: [...(opts.params ?? []), ...limitParams],
    };
  }
  // Non-shadow (Turso): the Tantivy FTS scan IGNORES `OFFSET` on the same
  // query as `fts_match` (verified empirically 2026-08-08 — bound and literal
  // forms alike return the first `limit` rows regardless of `offset`; the
  // `no-fts-match` control honors it). Workaround: when `offset` is set, wrap
  // the FTS scan in a subquery — the OUTER `LIMIT ? OFFSET ?` then applies to
  // a materialized plain scan, where OFFSET is honored (verified: correct
  // paging over the inner score-ordered rows). The no-offset shape stays the
  // spec form.
  if (opts.offset !== undefined) {
    return {
      sql: `SELECT * FROM (
        SELECT n.*, n.rowid AS rowid, ${scoreExpr} AS score
        FROM ${table} n
        WHERE ${matchSql} ${andWhere}
        ORDER BY score DESC LIMIT ?
      ) LIMIT ? OFFSET ?`,
      params: [...(opts.params ?? []), limit + opts.offset, limit, opts.offset],
    };
  }
  return {
    sql: `SELECT n.*, n.rowid AS rowid, ${scoreExpr} AS score
      FROM ${table} n
      WHERE ${matchSql} ${andWhere}
      ORDER BY score DESC ${limitClause}`,
    params: [...(opts.params ?? []), ...limitParams],
  };
}

/**
 * Wrap `value` in a SQLite-family string literal for inline interpolation
 * (BUG-013). SQLite/Turso string literals are `'...'` with embedded single
 * quotes DOUBLED (`'` → `''`); backslashes are literal, never escapes, so no
 * other character needs handling. The FTS match query built by
 * `FTSDialect.buildMatchQuery` may legally contain single quotes — a token
 * like `don't` survives `normalizeFtsTokens` (whitespace-only splitting), and
 * `buildMatchQuery` escapes double quotes for the FTS query syntax but not
 * single quotes for the SQL literal — so this doubling is what makes the
 * inlined literal safe. Run AFTER `buildMatchQuery`: the FTS engine receives
 * the de-quoted literal value, byte-identical to what a bound param delivered.
 */
function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Build the count SQL for the given dialect. Params: `[ftsQuery, ...whereParams]`
 * on both backends (the count has no score expression, so Turso binds the
 * query once, in fts_match).
 */
export function buildFtsCountSql(
  dialect: FTSDialect,
  table: string,
  columns: string[],
  ftsQuery: string,
  opts: FtsCountOptions,
): FtsSearchSql {
  const andWhere = normalizeWhereFragment(opts.where);
  const { sql: matchSql } = dialect.matchClause(columns, '?');
  if (dialect.supportsShadowTable) {
    return {
      sql: `SELECT COUNT(*) AS cnt
        FROM fts_${table} JOIN ${table} n ON fts_${table}.rowid = n.rowid
        WHERE ${matchSql} ${andWhere}`,
      params: [ftsQuery, ...(opts.params ?? [])],
    };
  }
  return {
    sql: `SELECT COUNT(*) AS cnt FROM ${table} n WHERE ${matchSql} ${andWhere}`,
    params: [ftsQuery, ...(opts.params ?? [])],
  };
}

// ── Orchestrators (adapter-facing) ───────────────────────────────────────────

/**
 * Ranked FTS search over one adapter. Capability gate (`capabilities.fts ===
 * false`) → `[]`; empty token set → `[]`. Real DB errors rethrow.
 */
export async function ftsSearch<T = Record<string, unknown>>(
  adapter: StoreAdapter,
  table: string,
  columns: string[],
  query: string,
  opts: FtsSearchOptions = {},
): Promise<Array<T & { rowid: number; score: number }>> {
  if (!adapter.capabilities.fts) return [];
  const dialect = createFTSDialect(adapter.config.type);
  const tokens = normalizeFtsTokens(query);
  if (tokens.length === 0) return [];
  const ftsQuery = dialect.buildMatchQuery(tokens);
  const { sql, params } = buildFtsSearchSql(dialect, table, columns, ftsQuery, opts);
  const { rows } = await adapter.executeAll<T & { rowid: number; score: number }>(sql, params);
  return rows;
}

/** Row count for the same match as {@link ftsSearch}. Capability gate → 0;
 *  empty token set → 0. Real DB errors rethrow. */
export async function ftsCount(
  adapter: StoreAdapter,
  table: string,
  columns: string[],
  query: string,
  opts: FtsCountOptions = {},
): Promise<number> {
  if (!adapter.capabilities.fts) return 0;
  const dialect = createFTSDialect(adapter.config.type);
  const tokens = normalizeFtsTokens(query);
  if (tokens.length === 0) return 0;
  const ftsQuery = dialect.buildMatchQuery(tokens);
  const { sql, params } = buildFtsCountSql(dialect, table, columns, ftsQuery, opts);
  const row = await adapter.executeGet<{ cnt: number }>(sql, params);
  return row?.cnt ?? 0;
}

/**
 * Idempotently ensure an FTS index over `columns` of `table`:
 *
 * 1. Resolve the index ACTUALLY present (BL-461) — adopt a non-canonical one
 *    (e.g. `idx_fts_node__r1` after an orphan-guard rebuild) instead of
 *    building a duplicate over the same columns. SQLite returns `null` here
 *    (fts5's virtual-table name is load-bearing), so the FTS5 path is
 *    unaffected.
 * 2. Otherwise run the dialect's creation DDL, skipping per-statement
 *    `already exists` races.
 * 3. Backfill `INSERT INTO fts_<table> SELECT FROM <table>` — only when
 *    `capabilities.fts5` (Turso's Tantivy index is engine-maintained).
 * 4. Clean the OTHER dialect's legacy FTS residue: dropped directly on SQLite
 *    (Turso objects are opaque rows to better-sqlite3), detected and reported
 *    as `residueNeedsOutOfBand` on Turso (its engine's DROPs against fts5
 *    objects silently no-op — must go through better-sqlite3, see
 *    `FTSDialect.dropLegacyDDL`).
 *
 * Capability gate → `{ ensured: false, … }`. Real DB errors rethrow.
 */
export async function ensureFtsIndex(
  adapter: StoreAdapter,
  table: string,
  columns: string[],
  opts: FtsEnsureOptions = {},
): Promise<FtsEnsureResult> {
  const result: FtsEnsureResult = {
    ensured: false,
    adoptedExisting: null,
    indexName: null,
    backfilled: false,
    residueDropped: [],
    residueNeedsOutOfBand: false,
  };
  if (!adapter.capabilities.fts) return result;

  const dialect = createFTSDialect(adapter.config.type);

  // 1. Adopt a non-canonical existing index rather than building a duplicate.
  const existing = await resolveExistingFtsIndexName(adapter, table);
  if (existing !== null && existing !== canonicalFtsIndexName(table)) {
    result.ensured = true;
    result.adoptedExisting = existing;
    result.indexName = existing;
    return finishEnsureFtsIndex(adapter, dialect, table, result, opts);
  }

  // 2. Create.
  for (const stmt of createIndexStmts(dialect, table, columns, opts)) {
    try {
      await adapter.exec(stmt);
    } catch (err) {
      if (err instanceof Error && /already exists/i.test(err.message)) continue;
      throw err;
    }
  }
  result.ensured = true;
  result.indexName = dialect.supportsShadowTable ? `fts_${table}` : canonicalFtsIndexName(table);

  // (BL-507) Turso can report a DDL success it did not perform — the same
  // caveat the orphan guard documents (fts-orphan-guard.ts:264-284). A
  // Tantivy index is materialised as THREE sqlite_master rows (the index row,
  // the `__turso_internal_fts_dir_*` directory table, and the `_key`
  // backing_btree index that holds the segments); if any of them failed to
  // land, the next `fts_match` against this index PANICS the process (BL-361)
  // before any open-time guard can run. Verify the materialisation here and
  // repair it in-session: DROP + CREATE on the open connection removes and
  // rebuilds all three rows (measured), so a half-created index heals itself
  // instead of being reported as `ensured`. If the retry still lands
  // incomplete, THROW — reporting `ensured: true` on a panic-bomb index is
  // the defect this closes. SQLite FTS5 (`supportsShadowTable`) is untouched.
  if (!dialect.supportsShadowTable) {
    await verifyTursoFtsMaterialization(adapter, dialect, table, columns, opts, result.indexName);
  }

  // 3. Backfill the FTS5 shadow table (only when the engine exposes one).
  //    Gated on the segment table `fts_<table>_idx` being EMPTY: on an
  //    external-content FTS5 table, `SELECT COUNT(*) FROM fts_<table>` reads
  //    the CONTENT table (a fresh index over a populated `node` reports the
  //    node count), while `fts_<table>_idx` holds only actual index segments
  //    (0 fresh, >0 after backfill — measured). Re-ensure must not re-run
  //    `INSERT … SELECT`: a second backfill duplicates segments (measured:
  //    idx count 1 → 2), inflating BM25 scores.
  if (adapter.capabilities.fts5 && opts.backfill !== false) {
    const ftsTable = `fts_${table}`;
    if (await tableExists(adapter, ftsTable)) {
      const cnt = await adapter.executeGet<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${ftsTable}_idx`,
        [],
      );
      if ((cnt?.n ?? 0) === 0) {
        const colList = ['rowid', ...columns].join(', ');
        await adapter.exec(
          `INSERT INTO ${ftsTable}(${colList}) SELECT ${colList} FROM ${table}`,
        );
        result.backfilled = true;
      }
    }
  }

  return finishEnsureFtsIndex(adapter, dialect, table, result, opts);
}

/** Residue cleanup shared by the created and adopted paths. */
async function finishEnsureFtsIndex(
  adapter: StoreAdapter,
  dialect: FTSDialect,
  table: string,
  result: FtsEnsureResult,
  opts: FtsEnsureOptions,
): Promise<FtsEnsureResult> {
  if (opts.dropLegacyResidue === false) return result;
  const residueNames = dialect.legacyResidueNames(table);
  const present = await existingObjectNames(adapter, residueNames);
  if (present.length === 0) return result;
  if (dialect.supportsShadowTable) {
    // sqlite dialect: residue is the Turso Tantivy index — droppable through
    // better-sqlite3 (harmless opaque rows; the DDL has IF EXISTS guards).
    for (const stmt of dialect.dropLegacyDDL(table)) {
      try {
        await adapter.exec(stmt);
      } catch (err) {
        if (err instanceof Error && /already exists/i.test(err.message)) continue;
        throw err;
      }
    }
    result.residueDropped = present;
  } else {
    // turso dialect: residue is the SQLite FTS5 stack — the engine's DROPs
    // silently no-op (documented in fts-dialect.ts); clean via better-sqlite3
    // out of band, report the need.
    result.residueNeedsOutOfBand = true;
  }
  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Call `dialect.createIndexDDL` without ever passing an explicit `undefined`
 * into an optional parameter (tsconfig has `exactOptionalPropertyTypes`).
 * Behaviorally `{}` weights ≡ undefined weights on both dialects (SQLite
 * ignores them; Turso emits no `WITH (weights=…)` clause for an empty map).
 */
function createIndexStmts(
  dialect: FTSDialect,
  table: string,
  columns: string[],
  opts: FtsEnsureOptions,
): string[] {
  if (opts.weights === undefined && opts.sqliteDDL === undefined) {
    return dialect.createIndexDDL(table, columns);
  }
  if (opts.weights === undefined) {
    return dialect.createIndexDDL(table, columns, {}, opts.sqliteDDL);
  }
  if (opts.sqliteDDL === undefined) {
    return dialect.createIndexDDL(table, columns, opts.weights);
  }
  return dialect.createIndexDDL(table, columns, opts.weights, opts.sqliteDDL);
}

/**
 * The three `sqlite_master` rows a Turso Tantivy FTS index materialises:
 * the index row itself, Turso's internal directory table, and the `_key`
 * backing_btree index that holds the segments. `CREATE INDEX … USING fts`
 * is only "done" when all three are present — see
 * {@link verifyTursoFtsMaterialization}.
 */
function tursoFtsMaterializationNames(indexName: string): string[] {
  const dir = `__turso_internal_fts_dir_${indexName}`;
  return [indexName, dir, `${dir}_key`];
}

/** Which of the three expected rows are absent from `sqlite_master`. Never
 *  throws — an unreadable schema degrades to "all absent". */
async function absentTursoFtsMaterialization(
  adapter: StoreAdapter,
  indexName: string,
): Promise<string[]> {
  const names = tursoFtsMaterializationNames(indexName);
  try {
    const placeholders = names.map(() => '?').join(', ');
    const { rows } = await adapter.executeAll<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE name IN (${placeholders})`,
      names,
    );
    const got = new Set(rows.map((r) => r.name));
    return names.filter((n) => !got.has(n));
  } catch (err) {
    log.debug('store_adapter.fts.backing_read_failed', {
      index: indexName,
      error: err instanceof Error ? err.message : String(err),
    });
    return names;
  }
}

/**
 * (BL-507) Verify — and repair — the Tantivy materialisation of a just-created
 * (or already-present) Turso FTS index.
 *
 * Turso reports a DDL success it did not perform, so `CREATE INDEX … USING
 * fts` resolving without error proves nothing about the three rows the index
 * actually needs. When any row is missing, the index is in the exact state
 * that makes the next `fts_match` panic the host process (BL-361) — a
 * panic-bomb, never to be reported as `ensured: true`. Repair is
 * self-contained and measured: `DROP INDEX IF EXISTS "<index>"` on the open
 * connection removes all three rows, and a fresh `CREATE INDEX` rebuilds all
 * three. One retry; a still-incomplete materialisation throws a typed error.
 */
async function verifyTursoFtsMaterialization(
  adapter: StoreAdapter,
  dialect: FTSDialect,
  table: string,
  columns: string[],
  opts: FtsEnsureOptions,
  indexName: string,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const absent = await absentTursoFtsMaterialization(adapter, indexName);
    if (absent.length === 0) return;
    if (attempt === 1) {
      throw new Error(
        `[BL-507] Turso FTS index "${indexName}" on "${table}" reported created but its Tantivy ` +
          `backing did not materialise (missing: ${absent.join(', ')}); the next fts_match would ` +
          `PANIC the process, so the index is NOT ensured. Retried once after DROP+CREATE.`,
      );
    }
    log.warn('store_adapter.fts.backing_incomplete_repair', {
      table,
      index: indexName,
      missing: absent.join(', '),
      detail: 'reported success it did not perform — dropping and recreating the index in-session',
    });
    try {
      await adapter.exec(`DROP INDEX IF EXISTS "${indexName}"`);
    } catch (err) {
      throw new Error(
        `[BL-507] repair of incompletely-materialised FTS index "${indexName}" failed at DROP: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    for (const stmt of createIndexStmts(dialect, table, columns, opts)) {
      try {
        await adapter.exec(stmt);
      } catch (err) {
        if (err instanceof Error && /already exists/i.test(err.message)) continue;
        throw err;
      }
    }
  }
}

/** True when `name` exists as a table/view in `sqlite_master`. Never throws —
 *  an unreadable schema degrades to false. */
async function tableExists(adapter: StoreAdapter, name: string): Promise<boolean> {
  try {
    const row = await adapter.executeGet<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('table','view') AND name = ?`,
      [name],
    );
    return (row?.n ?? 0) > 0;
  } catch (err) {
    log.debug('store_adapter.fts.table_exists_failed', {
      table: name,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Subset of `names` that exist in `sqlite_master` (any object type — tables,
 *  triggers, indexes, virtual tables). Never throws — an unreadable schema
 *  degrades to []. */
async function existingObjectNames(
  adapter: StoreAdapter,
  names: string[],
): Promise<string[]> {
  if (names.length === 0) return [];
  try {
    const placeholders = names.map(() => '?').join(', ');
    const { rows } = await adapter.executeAll<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE name IN (${placeholders})`,
      names,
    );
    const found = new Set(rows.map((r) => r.name));
    return names.filter((n) => found.has(n));
  } catch (err) {
    log.debug('store_adapter.fts.existing_objects_failed', {
      names,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
