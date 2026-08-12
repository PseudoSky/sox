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
 * marker** — one file per connection, `<leaseDir>/<token>.openmark`, written
 * by {@link markStoreOpen} on open and removed by {@link clearStoreOpenMarker}
 * on that connection's own orderly close (BUG-019: per-connection, so a
 * sibling's close can never erase a peer's crash evidence). A marker whose
 * pid is DEAD at open time ⇒ the previous session did not close ⇒ pre-flight
 * ({@link hasUncleanShutdown}). A marker whose pid is LIVE is a concurrent
 * session, never an unclean signal.
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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { engineForApplicationId } from './engine-guard.js';
import { entryLiveness, leaseDirPath, storeQuiescence } from './store-lease.js';
import { log } from '@adhd/sox-telemetry';

const require = createRequire(import.meta.url);

// ── Out-of-band open marker ──────────────────────────────────────────────────

/**
 * (BUG-019) The LEGACY single-shared marker path (`${dbPath}-openmark`),
 * written by store-adapter versions before the per-connection marker landed.
 *
 * Retained ONLY for the one-shot migration shim: when a legacy marker file
 * exists, {@link hasUncleanShutdown} treats the store as unclean ONCE and
 * {@link sweepDeadOpenMarkers} deletes it, so a crash recorded under the old
 * scheme is honored exactly once and never re-triggers.
 *
 * Deliberately NOT a SQLite sidecar suffix (`-wal`, `-shm`, `-tshm`) — this
 * file must survive anything the engine does to the store, including the
 * sidecar reconciliation in `recoverStaleWalIndex()`.
 */
export function storeOpenMarkerPath(dbPath: string): string {
  return `${dbPath}-openmark`;
}

/**
 * (BUG-019) Path of ONE connection's open marker: `<leaseDir>/<token>.openmark`.
 *
 * The marker now lives INSIDE the per-store lease directory and is keyed per
 * lease token, so N concurrent connections hold N markers and an orderly close
 * unlinks only its own (`clearStoreOpenMarker(dbPath, ownToken)`) — the
 * refcount the single shared `${dbPath}-openmark` file lacked. Callers MUST
 * pass the CANONICAL dbPath (SPEC §T4, INV-4): every process reaching the same
 * physical store must scan the SAME directory.
 */
export function openMarkerPath(dbPath: string, token: string): string {
  return join(leaseDirPath(dbPath), `${token}.openmark`);
}

/**
 * Record that a session is open against `dbPath`. Never throws.
 *
 * (BUG-019) Per-connection: with `token` (the connection's lease token — the
 * adapter always passes it), writes `<leaseDir>/<token>.openmark` carrying the
 * CURRENT pid, so a sibling connection's orderly close can never erase this
 * session's crash evidence (the shared-marker failure BUG-019 fixes).
 *
 * Without `token` the LEGACY `${dbPath}-openmark` file is written instead — a
 * deprecated form kept ONLY for tests that simulate a pre-fix crash session
 * (a legacy file IS an unclean signal by definition, consumed once by the
 * migration shim on the next open).
 */
export function markStoreOpen(dbPath: string | undefined, token?: string): void {
  if (!dbPath) return;
  try {
    if (token !== undefined) {
      mkdirSync(leaseDirPath(dbPath), { recursive: true });
      writeFileSync(
        openMarkerPath(dbPath, token),
        `${process.pid}\n${new Date().toISOString()}\n`,
      );
    } else {
      writeFileSync(storeOpenMarkerPath(dbPath), `${process.pid} ${new Date().toISOString()}\n`);
    }
  } catch {
    // A marker we cannot write only costs the next open its pre-flight.
  }
}

/**
 * Clear THIS session's marker on an orderly close. Never throws.
 *
 * (BUG-019) With `token` unlinks only `<leaseDir>/<token>.openmark` — its own
 * marker — never a sibling connection's. Without `token` (deprecated form)
 * unlinks the legacy `${dbPath}-openmark` file only.
 */
export function clearStoreOpenMarker(dbPath: string | undefined, token?: string): void {
  if (!dbPath) return;
  try {
    if (token !== undefined) {
      unlinkSync(openMarkerPath(dbPath, token));
    } else {
      unlinkSync(storeOpenMarkerPath(dbPath));
    }
  } catch {
    // Already gone (or never written) — both fine.
  }
}

/**
 * (BUG-019) True when a previous session left the store unclean.
 *
 * "Unclean" is now a DEAD connection, not a present file: any `.openmark`
 * whose pid is dead (or older than 24 h — the SAME liveness logic and age-out
 * `storeQuiescence` applies to lease entries, via {@link entryLiveness}) means
 * a session started and did not end orderly, so the pre-flight must run. A
 * marker whose pid is LIVE is a session that is STILL OPEN — a concurrent
 * peer, never an unclean signal. The old shared marker could not distinguish
 * the two, which is what made every fresh open under a long-lived server run
 * the pre-flight against a live multiprocess store (BUG-019).
 *
 * Migration shim: a LEGACY `${dbPath}-openmark` file (pre-BUG-019 versions
 * wrote one shared file) is treated as unclean ONCE, until
 * {@link sweepDeadOpenMarkers} removes it.
 *
 * Never throws: absent/unreadable lease dir ⇒ false.
 */
export function hasUncleanShutdown(dbPath: string | undefined): boolean {
  if (!dbPath) return false;
  try {
    if (existsSync(storeOpenMarkerPath(dbPath))) return true; // legacy shim
  } catch {
    return false;
  }
  const now = Date.now();
  try {
    const dir = leaseDirPath(dbPath);
    const names = readdirSync(dir);
    for (const name of names) {
      if (!name.endsWith('.openmark')) continue;
      let content: string;
      try {
        content = readFileSync(join(dir, name), 'utf8');
      } catch {
        continue; // unreadable — cannot judge liveness
      }
      // Only a PROVEN-dead pid (or age-out) is an unclean signal; unparseable
      // content and live pids are not.
      const info = entryLiveness(content, now);
      if (info !== null && !info.live) return true;
    }
  } catch {
    return false; // absent/unreadable dir ⇒ clean
  }
  return false;
}

/**
 * (BUG-019) Remove every dead open marker — the `.openmark` files whose pid
 * is dead or aged out (plus any legacy `${dbPath}-openmark` shim file) — after
 * the pre-flight has CONSUMED the unclean signal, so the SAME crash evidence
 * never re-triggers a second pre-flight ("runs preflight exactly once").
 * Live markers (concurrent peers) are never touched. Never throws; returns
 * the number of files removed.
 */
export function sweepDeadOpenMarkers(dbPath: string | undefined): number {
  if (!dbPath) return 0;
  let swept = 0;
  try {
    if (existsSync(storeOpenMarkerPath(dbPath))) {
      try {
        unlinkSync(storeOpenMarkerPath(dbPath));
        swept += 1;
      } catch {
        // raced by another sweeper — idempotent
      }
    }
  } catch {
    return swept;
  }
  const now = Date.now();
  try {
    const dir = leaseDirPath(dbPath);
    const names = readdirSync(dir);
    for (const name of names) {
      if (!name.endsWith('.openmark')) continue;
      const markerPath = join(dir, name);
      let content: string;
      try {
        content = readFileSync(markerPath, 'utf8');
      } catch {
        continue; // concurrent removal
      }
      // Dead, aged-out, or unparseable → swept. A live session's marker is
      // always parseable (we wrote it), so a live marker can never match here.
      const info = entryLiveness(content, now);
      if (info === null || !info.live) {
        try {
          unlinkSync(markerPath);
          swept += 1;
        } catch {
          // raced — idempotent
        }
      }
    }
  } catch {
    // absent/unreadable dir — nothing to sweep
  }
  return swept;
}

/**
 * @deprecated (BUG-019) Use {@link hasUncleanShutdown}. The old name claimed
 * "a marker file is present", which was also true for a CONCURRENT live
 * session — the predicate that gates the pre-flight is "a session ended
 * uncleanly", i.e. a marker whose pid is dead. Retained as an alias for
 * compatibility.
 */
export function hasStoreOpenMarker(dbPath: string | undefined): boolean {
  return hasUncleanShutdown(dbPath);
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
  opts: { repair?: boolean; ownLeaseToken?: string } = {},
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

  // (BL-506) Shared escape-hatch repair — the exact mechanism this module
  // documented for its own orphaned-Tantivy repair is now also graph-store's
  // fts5-residue drop; both funnel through the same out-of-band DELETE.
  const repair = deleteSchemaRowsViaBetterSqlite3(
    dbPath,
    doomed,
    opts.ownLeaseToken !== undefined ? { ownLeaseToken: opts.ownLeaseToken } : {},
  );
  result.dropped = repair.dropped;
  result.failed = repair.failed;
  return result;
}

// ── Shared escape-hatch repair (BL-506) ──────────────────────────────────────

/** Outcome of {@link deleteSchemaRowsViaBetterSqlite3}. */
export interface SchemaRowDeleteResult {
  /** `sqlite_master` names actually deleted (DELETE reported ≥1 row changed). */
  dropped: string[];
  /** Set when the whole drop failed (open, DELETE, or reset). */
  failed: string | null;
}

/**
 * (BL-506) Delete `sqlite_master` rows out of band — the sanctioned escape
 * hatch, shared by the pre-flight's own repair and graph-store's FK-heal.
 *
 * Why this is the ONLY tool for the job:
 *
 * - The Turso driver hard-refuses `sqlite_master` writes on every surface
 *   (`all`/`exec`/`batch`/`pragma`/`compat`/`native`; `writable_schema` is a
 *   silent no-op through it — measured on the live store 2026-08-11), and its
 *   `DROP` statements against objects it cannot parse (fts5 VTs, orphaned
 *   Tantivy backing) silently "succeed" while leaving the row in place.
 * - better-sqlite3 executes these deletes for real once BOTH settings are on:
 *   `unsafeMode(true)` (better-sqlite3 is defensive by default, which no-ops
 *   the pragma) followed by `PRAGMA writable_schema = ON` (tolerates the very
 *   schema rows being deleted plus every `USING fts` / `USING backing_btree`
 *   row a Turso store carries — see {@link openSchemaReader}'s callers for the
 *   BL-361/BL-362 measurements).
 *
 * Deleting by NAME (not by rowid): the caller supplies the object names
 * (e.g. `FTSDialect.legacyResidueNames('node')` for fts5 residue); any present
 * row with that name is deleted, whether it is a table, index, trigger, or
 * view — the uniform repair the live backlog store received in 2026-08-11.
 *
 * Never throws: every failure degrades to `{ failed: <message> }` so a repair
 * that can itself break an open is worse than no repair (same contract as
 * {@link preflightSchemaSanity}).
 *
 * (BUG-017, INV-1) The writable open is QUIESCENCE-GATED: `openSchemaReader(
 * dbPath, false)` is the proven exp9 poisoner while live turso multiprocess
 * peers hold the store — classic SQLite cannot see `-tshm` clients, so a
 * writable open+close checkpoints/deletes the WAL out from under them. When
 * `storeQuiescence` reports live peers the delete is DECLINED loudly
 * (`failed: 'declined: …'` + a typed warn log — INV-5, never a silent skip)
 * and the caller's repair is deferred until the store is quiescent.
 */
export function deleteSchemaRowsViaBetterSqlite3(
  dbPath: string,
  names: readonly string[],
  opts: { ownLeaseToken?: string } = {},
): SchemaRowDeleteResult {
  const result: SchemaRowDeleteResult = { dropped: [], failed: null };
  if (names.length === 0) return result;

  // (BUG-017) Gate BEFORE any writable classic open. `excludeToken` is the
  // caller's OWN connection lease (a process's own lease must never count
  // against itself — same contract as the sidecar-reconcile and close-TRUNCATE
  // gates). Under live peers: decline with the typed INV-1 contract; the
  // repair is re-attempted once the store is quiescent.
  const quiescence = storeQuiescence(dbPath, opts.ownLeaseToken);
  if (!quiescence.quiescent) {
    result.failed = `declined: ${quiescence.livePeers.length} live peer(s) hold the store (INV-1); repair deferred`;
    log.warn('store_adapter.preflight.schema_repair_declined_live_peers', {
      db_path: dbPath,
      live_peer_count: quiescence.livePeers.length,
      live_peer_pids: quiescence.livePeers.map((p) => p.pid).join(','),
    });
    return result;
  }

  try {
    const db = openSchemaReader(dbPath, false);
    try {
      const del = db.prepare('DELETE FROM sqlite_master WHERE name = ?');
      for (const name of names) {
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
