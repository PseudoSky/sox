/**
 * (BL-361) Out-of-process schema pre-flight for Turso stores.
 *
 * ## The failure this exists to survive
 *
 * A Turso store whose `sqlite_master` carries an FTS index row
 * (`CREATE INDEX … USING fts (…)`) while one of that index's Tantivy backing
 * objects is missing does not fail `connect()` with an error. It **panics in
 * Rust and aborts the host process**:
 *
 * ```
 * thread '<unnamed>' panicked at core/vdbe/execute.rs:13189:51:
 * internal error: entered unreachable code: invalid transaction state for
 * SetCookie: TransactionState::Read, should be write
 * ```
 *
 * Measured against `@tursodatabase/database@0.7.1`: the process exits with
 * signal `SIGABRT` (status 134). Nothing in-process can catch it, log it, or
 * repair it — a Rust `panic!` crossing the FFI boundary is not an exception.
 *
 * **What triggers it, precisely (measured 2026-08-05 — BL-361's own account of
 * this is wrong):** `connect()` does NOT panic. Neither does `SELECT 1`, a base
 * table read, a `sqlite_master` read, an `INSERT`, a
 * `CREATE INDEX IF NOT EXISTS … USING fts`, or `DROP INDEX`. Exactly one
 * statement aborts the process: **`fts_match` against the orphaned index**. The
 * adapter reaches it unaided — `TursoAdapterImpl.connect()` →
 * `runOpenTimeIntegrity` → `probeFtsIndexes` issues a sentinel `fts_match` on
 * every open — so an ordinary open of such a store still kills its host.
 *
 * Reported upstream: https://github.com/tursodatabase/turso/issues/8216
 * (a malformed schema must surface as an error, never a `panic!`).
 *
 * ## Why the store's own unclean-shutdown flag cannot gate this
 *
 * `consumeUncleanShutdownFlag()` reads `_adapter_meta` **through the adapter**
 * (`adapter-meta.ts:102-115`), and is called from `turso-adapter.ts` *after*
 * `connect()` has already returned. On a store in this state the process is
 * dead long before that line. Any gate that lives inside the database is
 * unreachable at the moment it is needed, so the gate here is an **out-of-band
 * marker file** written beside the database: {@link markStoreOpen} on open,
 * {@link clearStoreOpenMarker} on an orderly close. Marker present at open time
 * ⇒ the previous session did not close ⇒ pre-flight.
 *
 * That gate is deliberate: an unconditional pre-flight would add a second
 * native open plus a `sqlite_master` scan to the hot MCP open path. The cost of
 * skipping it is stated honestly in {@link preflightSchemaSanity}'s contract —
 * a store damaged *without* a preceding unclean session still panics. Revisit
 * only with a measurement.
 *
 * ## Why `better-sqlite3` can read a schema Turso cannot open
 *
 * A plain `better-sqlite3` open of a Turso-FTS store throws
 * `malformed database schema (__turso_internal_fts_dir_idx_fts_node_key) -
 * near "USING": syntax error` on the first schema-touching statement — that is
 * BL-329, and it is still true. The escape hatch is **two** settings, not one:
 *
 * 1. `db.unsafeMode(true)` — better-sqlite3 enables SQLite's *defensive* mode
 *    by default, and in defensive mode `PRAGMA writable_schema` is silently a
 *    no-op. Without this call step 2 does nothing. (Measured 2026-08-05: with
 *    `writable_schema=ON` alone, better-sqlite3 12.10.0 / SQLite 3.53.1 still
 *    throws. Node's own `node:sqlite` 3.50.4 does not, because it is not
 *    defensive — hence the earlier BL-362 note that the pragma "just works".)
 * 2. `PRAGMA writable_schema = ON` — makes SQLite tolerate schema rows it
 *    cannot parse, which is every `USING fts` / `USING backing_btree` row.
 *
 * With both, `sqlite_master` reads and writes normally, WAL contents included
 * (verified against a store with a 49 KB hot Turso WAL). Detection opens
 * **read-only**; only a confirmed repair opens for write.
 *
 * ## What "orphaned" means, precisely
 *
 * `CREATE INDEX idx_fts_node ON node USING fts (content)` materialises three
 * `sqlite_master` rows:
 *
 * | row | kind | note |
 * |---|---|---|
 * | `idx_fts_node` | index | `rootpage = 0` — no btree of its own |
 * | `__turso_internal_fts_dir_idx_fts_node` | table | **always 0 rows**, in every state |
 * | `__turso_internal_fts_dir_idx_fts_node_key` | index (`USING backing_btree`) | holds the Tantivy segments |
 *
 * Measured outcomes when a row is missing:
 * - directory **table** row gone → catchable `Corrupt database: sqlite_schema
 *   contains index for missing table …`. Survivable; not this module's problem.
 * - `_key` **index** row gone → **panic**.
 * - both gone → **panic**.
 *
 * So the pre-flight condition is: an FTS index row exists and **either**
 * backing object is absent. The repair deletes all three rows, which restores a
 * store Turso opens normally; the consumer's own
 * `CREATE INDEX IF NOT EXISTS … USING fts` then rebuilds and backfills it
 * (verified: `fts_match` returns the pre-damage rows afterwards).
 *
 * @module
 */

import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { engineForApplicationId } from './engine-guard.js';

const require = createRequire(import.meta.url);

// ── Out-of-band open marker ──────────────────────────────────────────────────

/**
 * Path of the marker file for `dbPath`.
 *
 * Deliberately NOT a SQLite sidecar suffix (`-wal`, `-shm`, `-tshm`) — this
 * file must survive anything the engine does to the store, including the
 * sidecar reconciliation in `recoverStaleWalIndex()`.
 */
export function storeOpenMarkerPath(dbPath: string): string {
  return `${dbPath}-openmark`;
}

/** Record that a session is open against `dbPath`. Never throws. */
export function markStoreOpen(dbPath: string | undefined): void {
  if (!dbPath) return;
  try {
    writeFileSync(storeOpenMarkerPath(dbPath), `${process.pid} ${new Date().toISOString()}\n`);
  } catch {
    // A marker we cannot write only costs the next open its pre-flight.
  }
}

/** Clear the marker on an orderly close. Never throws. */
export function clearStoreOpenMarker(dbPath: string | undefined): void {
  if (!dbPath) return;
  try {
    unlinkSync(storeOpenMarkerPath(dbPath));
  } catch {
    // Already gone (or never written) — both fine.
  }
}

/**
 * True when a previous session left its marker behind.
 *
 * A *concurrently open* session also leaves it present, and that is accepted:
 * detection is a read-only `sqlite_master` scan, and the only state that
 * escalates to a write is one in which no other process could be holding the
 * store open — Turso cannot open it at all.
 */
export function hasStoreOpenMarker(dbPath: string | undefined): boolean {
  if (!dbPath) return false;
  try {
    return existsSync(storeOpenMarkerPath(dbPath));
  } catch {
    return false;
  }
}

// ── Schema pre-flight ────────────────────────────────────────────────────────

/** One `sqlite_master` row, as the pre-flight reads it. */
interface MasterRow {
  type: string;
  name: string;
  tbl_name: string;
  rootpage: number;
  sql: string | null;
}

/** Outcome of {@link preflightSchemaSanity}. */
export interface SchemaPreflightResult {
  /** Did the schema scan actually run? `false` ⇒ see {@link skipped}. */
  ran: boolean;
  /** Why the scan did not run (missing file, unreadable schema, …). */
  skipped: string | null;
  /** FTS index names whose Tantivy backing objects are missing — each one of
   *  these would abort the process on the next `connect()`. */
  orphaned: string[];
  /** `sqlite_master` names actually deleted by the repair. */
  dropped: string[];
  /** Set when a repair was attempted and failed. */
  failed: string | null;
  /** (BL-508) Engine identified by the store's `application_id` marker when
   *  readable — `'turso' | 'sqlite'`, else `null` (unmarked/legacy). The
   *  pre-flight open is REPAIR intent: it proceeds regardless of marker (it
   *  is the sanctioned escape hatch for hybrid files) but records the engine
   *  so a repair of a foreign-engine store is visible, never silent. */
  detected_engine: 'turso' | 'sqlite' | null;
}

/** `CREATE INDEX … USING fts (…)` — the Tantivy-backed index form. */
function isTursoFtsIndexSql(sql: string | null): boolean {
  return sql !== null && /\busing\s+fts\s*\(/i.test(sql);
}

/** The two backing objects Turso materialises for FTS index `name`. */
function backingObjectNames(indexName: string): { table: string; key: string } {
  const table = `__turso_internal_fts_dir_${indexName}`;
  return { table, key: `${table}_key` };
}

function openSchemaReader(dbPath: string, readonly: boolean): BetterSqlite3Database {
  // Lazy require: better-sqlite3 is a native module and this module is imported
  // by the Turso adapter, which must stay usable where it is not built.
  const Database = require('better-sqlite3') as new (
    p: string,
    o?: { readonly?: boolean },
  ) => BetterSqlite3Database;
  const db = readonly ? new Database(dbPath, { readonly: true }) : new Database(dbPath);
  db.unsafeMode(true); // MUST precede writable_schema — see the module docs.
  db.pragma('writable_schema = ON');
  return db;
}

/**
 * Detect — and optionally repair — the `sqlite_master` state that makes Turso's
 * `connect()` abort the process (BL-361).
 *
 * Synchronous and self-contained: it must be callable before any adapter
 * exists. Never throws; every failure degrades to "did not run", because a
 * pre-flight that can itself break an open is worse than no pre-flight.
 *
 * **Contract, stated honestly:** this only sees damage that is present *now*.
 * It does not prove a store is healthy, and it cannot help a store damaged
 * during a session that afterwards closed cleanly (no marker ⇒ no call).
 */
export function preflightSchemaSanity(
  dbPath: string,
  opts: { repair?: boolean } = {},
): SchemaPreflightResult {
  const result: SchemaPreflightResult = {
    ran: false,
    skipped: null,
    orphaned: [],
    dropped: [],
    failed: null,
    detected_engine: null,
  };

  if (!existsSync(dbPath)) {
    result.skipped = 'no database file at that path';
    return result;
  }

  let rows: MasterRow[];
  try {
    const db = openSchemaReader(dbPath, true);
    try {
      // (BL-508) REPAIR intent: record the engine marker if readable. The
      // open proceeds regardless — this is the sanctioned escape hatch for
      // hybrid files — but a repair of a foreign-engine store must be visible.
      try {
        const appId = db.pragma('application_id', { simple: true }) as number;
        result.detected_engine = engineForApplicationId(appId);
      } catch {
        result.detected_engine = null;
      }
      rows = db
        .prepare('SELECT type, name, tbl_name, rootpage, sql FROM sqlite_master')
        .all() as MasterRow[];
    } finally {
      db.close();
    }
  } catch (err) {
    result.skipped = `could not read sqlite_master: ${
      err instanceof Error ? err.message : String(err)
    }`;
    return result;
  }

  result.ran = true;
  const present = new Set(rows.map((r) => r.name));
  const doomed: string[] = [];
  for (const row of rows) {
    if (row.type !== 'index' || !isTursoFtsIndexSql(row.sql)) continue;
    const backing = backingObjectNames(row.name);
    // The `_key` backing_btree is the object whose absence panics the driver;
    // the directory table's absence is merely a catchable corruption error.
    // Both are repaired the same way, so both are collected here.
    if (!present.has(backing.key) || !present.has(backing.table)) {
      result.orphaned.push(row.name);
      doomed.push(row.name, backing.table, backing.key);
    }
  }

  if (result.orphaned.length === 0 || opts.repair !== true) return result;

  try {
    const db = openSchemaReader(dbPath, false);
    try {
      const del = db.prepare('DELETE FROM sqlite_master WHERE name = ?');
      for (const name of doomed) {
        if (!present.has(name)) continue;
        if (del.run(name).changes > 0) result.dropped.push(name);
      }
      db.pragma('writable_schema = RESET');
    } finally {
      db.close();
    }
  } catch (err) {
    result.failed = err instanceof Error ? err.message : String(err);
  }
  return result;
}

/**
 * Human-readable line for a pre-flight that found something.
 *
 * The reclassification clause is not decoration: BL-361's load-bearing question
 * — whether a crash can produce this state *naturally* — is still open. It was
 * only ever produced deliberately. If this line is ever emitted by a store
 * nobody damaged by hand, that question is answered and the item is HIGH.
 */
export function describePreflight(result: SchemaPreflightResult): string {
  const objects = result.orphaned.join(', ');
  if (result.failed !== null) {
    return (
      `[BL-361] FTS index(es) ${objects} have no Tantivy backing objects — opening this store ` +
      `would PANIC the driver and abort this process — and the pre-flight repair FAILED: ${result.failed}. ` +
      `If nobody damaged this store by hand, BL-361 is reachable naturally and reclassifies to HIGH.`
    );
  }
  return (
    `[BL-361] FTS index(es) ${objects} had no Tantivy backing objects; opening this store would ` +
    `have PANICKED the driver and aborted this process. Dropped the orphaned schema rows ` +
    `(${result.dropped.join(', ')}) out of process; the index is rebuilt by the normal ` +
    `CREATE INDEX … USING fts path. If nobody damaged this store by hand, BL-361 is reachable ` +
    `naturally and reclassifies to HIGH — say so on the item.`
  );
}
