import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { log } from '@adhd/sox-telemetry';
import {
  consumeUncleanShutdownFlag,
  ensureAdapterMetaTable,
  markCleanShutdown,
  stampAdapterMeta,
} from './adapter-meta.js';
import {
  captureWalIdentity,
  emitIntegrityReport,
  runOpenTimeIntegrity,
  summarizeBackupIntegrity,
  verifyStoreIntegrity,
} from './integrity.js';
import type { BackupIntegrityReport, WalIdentity } from './integrity.js';
import type {
  SqliteAdapter,
  AdapterTransaction,
  AdapterConfig,
  AdapterCapabilities,
  AdapterBackupOptions,
  AdapterBackupResult,
  FtsCountOptions,
  FtsEnsureOptions,
  FtsEnsureResult,
  FtsSearchOptions,
  RunResult,
  AllResult,
  TransactionOptions,
} from './types.js';
import { ETursoNativeStore, isTursoNativeStoreSchemaError } from './errors.js';
import { ensureEngineMarker, readApplicationId, SOX_APP_ID_TURSO } from './engine-guard.js';
import { canonicalDbPath } from './path-identity.js';
import {
  ensureFtsIndex as ensureFtsIndexOn,
  ftsCount as ftsCountOn,
  ftsSearch as ftsSearchOn,
} from './fts-ops.js';

type Sqlite3Database = import('better-sqlite3').Database;
type Sqlite3Statement = import('better-sqlite3').Statement;

/**
 * better-sqlite3 is a SOFT dependency (optionalDependencies) — the Turso
 * adapter is the primary path and must remain usable where better-sqlite3 is
 * not installed. It is therefore NEVER imported at module scope (that would
 * make the whole package unimportable without it, ERR_MODULE_NOT_FOUND); the
 * binding is resolved lazily, only when the sqlite adapter is actually
 * constructed. Same pattern as preflight.ts's `openSchemaReader`.
 */
const requireBetterSqlite3 = createRequire(import.meta.url);

/** Structural constructor type — better-sqlite3 is `export =` CJS; the
 *  module's default export IS the Database constructor (no `.default` member
 *  on its namespace type). Same shape as preflight.ts's cast. */
type BetterSqlite3Constructor = new (
  p: string,
  o?: { readonly?: boolean },
) => Sqlite3Database;

let cachedDatabaseConstructor: BetterSqlite3Constructor | undefined;
function loadBetterSqlite3(): BetterSqlite3Constructor {
  if (cachedDatabaseConstructor === undefined) {
    try {
      cachedDatabaseConstructor = requireBetterSqlite3('better-sqlite3') as BetterSqlite3Constructor;
    } catch (err) {
      throw new Error(
        'better-sqlite3 is not installed. The sqlite adapter requires it — install it with ' +
          '"pnpm add better-sqlite3" (or "npm install better-sqlite3"). ' +
          'The Turso adapter does not need it.',
        err instanceof Error ? { cause: err } : undefined,
      );
    }
  }
  return cachedDatabaseConstructor;
}

// ── Statement cache (LRU, 256 entries) ──────────────────────────────────────

class StatementCache {
  private readonly max: number;
  private readonly map = new Map<string, Sqlite3Statement>();

  constructor(max: number) {
    this.max = max;
  }

  get(sql: string, db: Sqlite3Database): Sqlite3Statement {
    const existing = this.map.get(sql);
    if (existing) {
      // Move to end (most recently used)
      this.map.delete(sql);
      this.map.set(sql, existing);
      return existing;
    }

    const stmt = db.prepare(sql);
    this.map.set(sql, stmt);

    if (this.map.size > this.max) {
      // Delete least recently used (first entry)
      const first = this.map.keys().next();
      if (first.value !== undefined) {
        this.map.delete(first.value);
      }
    }

    return stmt;
  }

  clear(): void {
    this.map.clear();
  }
}

// ── SqliteTransaction (internal) ─────────────────────────────────────────────

class SqliteTransactionImpl implements AdapterTransaction {
  private readonly cache: StatementCache;
  private readonly db: Sqlite3Database;

  constructor(db: Sqlite3Database, cache: StatementCache) {
    this.db = db;
    this.cache = cache;
  }

  async executeGet<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<T | null> {
    const stmt = this.cache.get(sql, this.db);
    const row = args !== undefined ? stmt.get(...args) : stmt.get();
    return (row as T | null) ?? null;
  }

  async executeAll<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<AllResult<T>> {
    const stmt = this.cache.get(sql, this.db);
    const rows = args !== undefined ? stmt.all(...args) : stmt.all();
    const columns = stmt.columns().map((c) => c.name);
    return { columns, rows: rows as T[] };
  }

  async executeRun(sql: string, args?: unknown[]): Promise<RunResult> {
    const stmt = this.cache.get(sql, this.db);
    const info = args !== undefined ? stmt.run(...args) : stmt.run();
    return { rowsAffected: info.changes, lastInsertRowid: info.lastInsertRowid };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }
}

// ── SqliteAdapterImpl ───────────────────────────────────────────────────────

export class SqliteAdapterImpl implements SqliteAdapter {
  readonly config: Readonly<AdapterConfig & { type: 'sqlite' }>;
  readonly capabilities: Readonly<AdapterCapabilities>;

  private db: Sqlite3Database;
  private ownDb: boolean;
  private cache: StatementCache;
  private closed = false;

  /** (BL-508) Did the db file exist before this adapter opened it? Tells
   *  `init()`'s marker backfill whether the store is fresh (created by this
   *  very open → this engine owns it) or legacy (unmarked → infer). */
  private _fileExisted = false;

  /** (BL-330) WAL identity captured at `init()`. See TursoAdapterImpl. */
  _walBaseline: WalIdentity | null = null;

  constructor(dbPath: string, opts?: { readonly?: boolean });
  constructor(db: Sqlite3Database);
  constructor(dbOrPath: string | Sqlite3Database, opts?: { readonly?: boolean }) {
    if (typeof dbOrPath === 'string') {
      // (BUG-018, INV-4) Canonicalize ONCE at open: `config.dbPath` and every
      // sidecar/integrity path derived from it carry the canonical spelling
      // (`realpathSync(dirname)` + `basename` — see path-identity.ts), so a
      // cross-engine peer (turso) keying its lease/marker/sidecars off the
      // canonical path sees the SAME files and the SAME coordination state a
      // classic open spelled through a symlink alias or `/tmp`-style parent
      // alias would otherwise fragment.
      const canonicalPath = canonicalDbPath(dbOrPath);
      // (BL-508) TOOLING-intent marker probe, BEFORE the writable handle is
      // opened: a pure header read (readApplicationId) that refuses a
      // Turso-owned store with the typed error and zero WAL/schema touch.
      // The existing BL-329 sqlite_master probe below only fires on
      // unmarked Tantivy stores — the marker catches a Turso store that has
      // NO Tantivy schema too (a plain turso-created store parses fine in
      // better-sqlite3, which is exactly the silent cross-engine open this
      // guard exists to stop).
      const appId = readApplicationId(canonicalPath);
      if (appId === SOX_APP_ID_TURSO) {
        throw new ETursoNativeStore(canonicalPath, null, { detectedEngine: 'turso' });
      }
      this._fileExisted = existsSync(canonicalPath);
      this.db = new (loadBetterSqlite3())(canonicalPath, {
        readonly: opts?.readonly ?? false,
      });
      this.ownDb = true;
      this.config = {
        type: 'sqlite',
        dbPath: canonicalPath,
        readonly: opts?.readonly ?? false,
      };
    } else {
      this.db = dbOrPath;
      this.ownDb = false;
      this.config = {
        type: 'sqlite',
      };
      // (BL-508) Best-effort marker probe on a caller-owned handle: the
      // handle is already open, so read the pragma directly (still a raw
      // header read, no schema touch).
      try {
        const appId = this.db.pragma('application_id', { simple: true }) as number;
        if (appId === SOX_APP_ID_TURSO) {
          throw new ETursoNativeStore(this.db.name ?? '<caller-owned handle>', null, {
            detectedEngine: 'turso',
          });
        }
      } catch (err) {
        if (err instanceof ETursoNativeStore) throw err;
        // Unreadable pragma on a caller-owned handle → leave to the
        // sqlite_master probe below.
      }
    }

    // (BL-329) `new DatabaseConstructor()` above succeeds even against a
    // Turso-native store — better-sqlite3 doesn't parse the schema at open
    // time. The failure would otherwise surface opaquely, named after
    // whatever internal Tantivy object happens to sort first, from
    // wherever the caller's FIRST real query happens to be (could be deep
    // in an unrelated code path, minutes/hours later). Probe for it HERE,
    // at open time, with a single cheap `sqlite_master` read — SQLite
    // parses every CREATE statement's SQL text to build the schema before
    // running ANY statement, so this one probe query is sufficient
    // regardless of which table a caller eventually touches — and convert
    // it into a typed, store-path-carrying error immediately.
    try {
      this.db.prepare('SELECT name FROM sqlite_master LIMIT 1').get();
    } catch (err) {
      if (isTursoNativeStoreSchemaError(err)) {
        const path = this.config.dbPath ?? this.db.name ?? '<unknown path>';
        try {
          this.db.close();
        } catch (closeErr) {
          // best-effort — we're already throwing the schema error below, but
          // the failed close is itself worth a trace.
          log.debug('store_adapter.sqlite.close_best_effort_failed', {
            error: closeErr instanceof Error ? closeErr.message : String(closeErr),
          });
        }
        throw new ETursoNativeStore(path, err);
      }
      throw err;
    }

    this.cache = new StatementCache(256);
    this.capabilities = {
      multiprocessWrite: false,
      nativeVectors: false,
      concurrentTransactions: false,
      fts5: true,
      fts: true,
      needsWriteSerialization: true,
      recursiveCte: true,
    };
  }

  /**
   * Initialise the adapter — stamps adapter metadata, then verifies and
   * repairs the generated artifacts in the store (BL-352).
   *
   * Safe to call multiple times; the stamp upserts and every probe is
   * read-only until it finds damage.
   * Skip for read-only connections.
   */
  async init(): Promise<void> {
    if (this.config.readonly) return;
    // (BL-508) Engine marker on first open (idempotent; fresh stores and
    // legacy-unmarked sqlite stores get stamped here). Runs before the meta
    // stamp so a marker is never missed because stamping failed.
    if (this.config.dbPath) {
      await ensureEngineMarker(this, 'sqlite', this.config.dbPath, {
        fresh: !this._fileExisted,
      });
    }
    let uncleanShutdown = false;
    try {
      await ensureAdapterMetaTable(this);
      await stampAdapterMeta(this, 'sqlite');
      uncleanShutdown = await consumeUncleanShutdownFlag(this);
    } catch (err) {
      // Non-fatal — stamping is a convenience marker, not a correctness
      // requirement — but meta stamping failing on every open is a real signal.
      log.warn('store_adapter.sqlite.adapter_meta_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this._walBaseline = captureWalIdentity(this.config.dbPath);
    await runOpenTimeIntegrity(this, {
      uncleanShutdown,
      walBaseline: this._walBaseline,
      onReport: (event, detail) => emitIntegrityReport(this.config.dbPath, event, detail),
    });
  }

  unwrap(): import('better-sqlite3').Database {
    return this.db;
  }

  /**
   * (BL-385) VACUUM INTO — owns its own sqlite-vec load so vec0 shadow tables
   * (e.g. `vec_node`) copy correctly. Runs directly on `this.db`; a connection
   * opened with `{ readonly: true }` (better-sqlite3's native OPEN_READONLY,
   * not `PRAGMA query_only`) still permits `VACUUM INTO` because it only
   * writes to `destPath`, never to the source file.
   */
  async backupTo(destPath: string, opts: AdapterBackupOptions = {}): Promise<AdapterBackupResult> {
    const sqliteVec = await import('sqlite-vec');
    sqliteVec.load(this.db);
    this.db.exec('PRAGMA busy_timeout = 3000;');
    this.db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);

    let integrityCheck = 'ok';
    let integrityReport: BackupIntegrityReport | undefined;
    if (!opts.skipIntegrityCheck) {
      const backupAdapter = new SqliteAdapterImpl(destPath, { readonly: true });
      try {
        sqliteVec.load(backupAdapter.unwrap());
        // (BL-449) NO `only:` narrowing. The previous `only:
        // ['pragma_integrity_check']` was written before the other probes
        // existed and silently excluded every one of them — including
        // `fts_index_live`, so a copy of a store with a dead FTS index was
        // certified 'ok' by a pragma structurally incapable of reading a
        // Tantivy/FTS5 index. The backup copy is a throwaway read-only
        // connection, so probe cost is not on any hot path. If a probe ever
        // must come out, use `skip` — it is recorded as `unknown` in the
        // report (BL-431), where `only` left no trace at all.
        const report = await verifyStoreIntegrity(backupAdapter, { depth: 'deep' });
        const summary = summarizeBackupIntegrity(report);
        integrityCheck = summary.legacyString;
        integrityReport = summary.verdict;
      } finally {
        await backupAdapter.close();
      }
    }
    return integrityReport === undefined
      ? { destPath, integrityCheck }
      : { destPath, integrityCheck, integrityReport };
  }

  async executeGet<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<T | null> {
    const stmt = this.cache.get(sql, this.db);
    const row = args !== undefined ? stmt.get(...args) : stmt.get();
    return (row as T | null) ?? null;
  }

  async executeAll<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<AllResult<T>> {
    const stmt = this.cache.get(sql, this.db);
    const rows = args !== undefined ? stmt.all(...args) : stmt.all();
    const columns = stmt.columns().map((c) => c.name);
    return { columns, rows: rows as T[] };
  }

  async executeRun(sql: string, args?: unknown[]): Promise<RunResult> {
    const stmt = this.cache.get(sql, this.db);
    const info = args !== undefined ? stmt.run(...args) : stmt.run();
    return { rowsAffected: info.changes, lastInsertRowid: info.lastInsertRowid };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async pragmaSet(key: string, value: string | number | boolean): Promise<void> {
    const boolVal = typeof value === 'boolean' ? (value ? 1 : 0) : value;
    this.db.pragma(`${key} = ${boolVal}`);
  }

  async pragmaGet<T = unknown>(key: string): Promise<T> {
    const result = this.db.pragma(key, { simple: true });
    return result as T;
  }

  async transaction<T>(
    fn: (tx: AdapterTransaction) => T | Promise<T>,
    opts?: TransactionOptions,
  ): Promise<T> {
    const mode = opts?.mode ?? 'deferred';
    if (mode === 'concurrent') {
      throw new TypeError('SqliteAdapter does not support BEGIN CONCURRENT');
    }

    const beginSQL =
      mode === 'exclusive'
        ? 'BEGIN EXCLUSIVE'
        : mode === 'immediate'
          ? 'BEGIN IMMEDIATE'
          : 'BEGIN DEFERRED';

    const maxRetries = opts?.maxRetries ?? 3;
    const baseDelayMs = opts?.baseDelayMs ?? 10;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      try {
        this.db.exec(beginSQL);
      } catch (err) {
        if (attempt < maxRetries) {
          lastError = err;
          continue;
        }
        throw err;
      }

      const tx = new SqliteTransactionImpl(this.db, this.cache);
      try {
        const result = await fn(tx);
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          this.db.exec('ROLLBACK');
        } catch (rollbackErr) {
          // Ignore rollback errors — but a failed ROLLBACK leaves transaction
          // state uncertain, so trace it even though the original error still
          // propagates below.
          log.debug('store_adapter.sqlite.rollback_failed', {
            error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
          });
        }
        throw err;
      }
    }

    throw lastError;
  }

  async executeMany(stmts: { sql: string; args?: unknown[] }[]): Promise<RunResult[]> {
    const results: RunResult[] = [];
    for (const { sql, args } of stmts) {
      const result = await this.executeRun(sql, args);
      results.push(result);
    }
    return results;
  }

  // ── Full-text search (A2) — per-backend SQL delegated to fts-ops.ts ────────

  async ftsSearch<T = Record<string, unknown>>(
    table: string,
    columns: string[],
    query: string,
    opts: FtsSearchOptions = {},
  ): Promise<Array<T & { rowid: number; score: number }>> {
    return ftsSearchOn(this, table, columns, query, opts);
  }

  async ftsCount(
    table: string,
    columns: string[],
    query: string,
    opts: FtsCountOptions = {},
  ): Promise<number> {
    return ftsCountOn(this, table, columns, query, opts);
  }

  async ensureFtsIndex(
    table: string,
    columns: string[],
    opts: FtsEnsureOptions = {},
  ): Promise<FtsEnsureResult> {
    return ensureFtsIndexOn(this, table, columns, opts);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.config.readonly && this.ownDb) {
      await markCleanShutdown(this);
    }
    this.cache.clear();
    if (this.ownDb) {
      this.db.close();
    }
  }
}
