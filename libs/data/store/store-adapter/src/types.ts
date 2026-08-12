// Type-only import: erased at emit, so this does NOT create a runtime cycle
// with `integrity.ts` (which imports `StoreAdapter` from here, also as a type).
import type { BackupIntegrityReport } from './integrity.js';

// ── Adapter meta (adapter-type stamping) ────────────────────────────────────

export interface AdapterMeta {
  adapter_type: 'sqlite' | 'turso' | null;
  adapter_version: string | null;
  created_at: string | null;
}

// ── Result types ────────────────────────────────────────────────────────────

export interface RunResult {
  rowsAffected: number;
  lastInsertRowid: number | bigint;
}

export interface AllResult<T = Record<string, unknown>> {
  columns: string[];
  rows: T[];
}

// ── Transaction ─────────────────────────────────────────────────────────────

export interface AdapterTransaction {
  executeGet<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<T | null>;
  executeAll<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<AllResult<T>>;
  executeRun(sql: string, args?: unknown[]): Promise<RunResult>;
  exec(sql: string): Promise<void>;
}

/**
 * Maps to SQLite's transaction types:
 * - 'deferred'  -> BEGIN DEFERRED (lock on first write — SQLite default)
 * - 'immediate' -> BEGIN IMMEDIATE (RESERVED lock at start — CAS primitive)
 * - 'exclusive' -> BEGIN EXCLUSIVE (EXCLUSIVE lock at start)
 * - 'concurrent' -> BEGIN CONCURRENT (MVCC optimistic — TursoAdapter only)
 *
 * SqliteAdapter supports deferred/immediate/exclusive.
 * concurrent is TursoAdapter-only — SqliteAdapter throws if used.
 */
export type TransactionMode = 'deferred' | 'immediate' | 'exclusive' | 'concurrent';

export interface TransactionOptions {
  /** Transaction mode. Default: 'deferred'. Portable code SHOULD set this explicitly. */
  mode?: TransactionMode;
  /** Retry on concurrent conflict (BUSY / SQLITE_BUSY_SNAPSHOT). Default: 3. */
  maxRetries?: number;
  /** Initial backoff delay in ms. Doubles each retry. Default: 10. */
  baseDelayMs?: number;
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
}

// ── Capability flags ────────────────────────────────────────────────────────

export interface AdapterCapabilities {
  multiprocessWrite: boolean;
  nativeVectors: boolean;
  concurrentTransactions: boolean;
  /** @deprecated Use `fts` instead. */
  fts5: boolean;
  /** True when the adapter supports full-text search (FTS5 on SQLite, Tantivy on Turso). */
  fts: boolean;
  /** True when the adapter uses a single sync connection that requires write serialization
   *  (e.g. better-sqlite3). False for async adapters with native concurrent I/O (e.g. Turso).
   *  WriteQueue checks this to decide whether to serialize writes or execute immediately. */
  needsWriteSerialization: boolean;
  /** True when the engine accepts `WITH RECURSIVE` at prepare time. SQLite
   *  always; Turso Database Rust >= 0.8.0 always; Turso Database Rust < 0.8.0
   *  rejects recursive CTEs at prepare (`Parse error`) — the probe that pins
   *  this is `recursive-cte.probe.test.ts`. Probed ONCE at connect and cached
   *  in this capabilities object. graph-store reads it to select its
   *  iterative fallbacks for the five recursive-graph methods
   *  (getSupersessionChain / getNeighbors / isReachable / getSubgraph). */
  recursiveCte: boolean;
}

// ── Vector dialect ──────────────────────────────────────────────────────────

export type VectorMetric = 'cosine' | 'l2' | 'dot';

export interface VectorDialect {
  vectorColumnType(dim: number): string;
  distanceExpr(column: string, queryVec: number[]): string;
  createTableDDL(table: string, column: string, dim: number): string;
  createIndexDDL(table: string, column: string, metric: VectorMetric): string;
  topKQuery(table: string, column: string, queryVec: number[], k: number, metric: VectorMetric): { sql: string; args: unknown[] };
}

// ── FTS dialect ──────────────────────────────────────────────────────────────

export interface FTSDialect {
  /** Whether full-text search is supported on this backend. */
  readonly supported: boolean;
  /** Dialect discriminator. */
  readonly dialect: 'sqlite' | 'turso';
  /** True when this dialect maintains FTS as a separate shadow table/index kept
   *  in sync by triggers (SQLite FTS5: `fts_node` + 3 triggers). False when the
   *  index lives directly on the base table with no trigger-synced shadow state
   *  (Turso Tantivy: a single `CREATE INDEX ... USING fts` on `node` itself). */
  readonly supportsShadowTable: boolean;

  /**
   * Build the ordered list of DDL statements required to create (or
   * idempotently ensure) full-text search on `table`.
   *
   * - Turso: a single `CREATE INDEX ... USING fts (...)` statement generated
   *   from `columns`/`weights`. `sqliteDDL` is ignored.
   * - SQLite FTS5: the canonical virtual-table + trigger DDL is schema-owned
   *   by graph-store (the single upstream source of truth for that SQL —
   *   store-adapter cannot depend on graph-store without introducing a
   *   circular package dependency, since graph-store itself depends on
   *   store-adapter). Callers pass that DDL via `sqliteDDL` (typically
   *   `[FTS_DDL, FTS_TRIGGERS]` from `memory-core`'s schema.ts) and it is
   *   returned verbatim, in order. `columns`/`weights` are ignored.
   */
  createIndexDDL(
    table: string,
    columns: string[],
    weights?: Record<string, number>,
    sqliteDDL?: readonly string[],
  ): string[];

  /**
   * Names of `sqlite_master` objects (tables + triggers) that belong to the
   * OTHER dialect's FTS mechanism and may linger on a store migrated from
   * that backend (e.g. a store originally created by SQLite/FTS5, later
   * opened by Turso — or vice versa). Empty when this dialect has nothing to
   * clean up. Used by callers to detect residue BEFORE it can break writes.
   */
  legacyResidueNames(table: string): string[];

  /**
   * DDL statements (run in order — triggers/indexes before their backing
   * tables) that remove the objects named by `legacyResidueNames`.
   *
   * ⚠️ On Turso, issuing these DIRECTLY through the Turso engine's own
   * connection is NOT reliable — `DROP TABLE`/`DROP TRIGGER` against objects
   * created by a different SQLite engine module (fts5, vec0) can report
   * success while leaving the object in `sqlite_master` untouched (verified
   * empirically, the same silent-no-op behavior documented for vec0 DROPs).
   * Callers on Turso MUST execute these through a better-sqlite3 connection
   * against the same file (close the Turso connection first, reopen after).
   */
  dropLegacyDDL(table: string): string[];

  /** WHERE clause fragment for FTS matching.
   *  Returns { sql, params } where sql uses the given queryParam placeholder. */
  matchClause(columns: string[], queryParam: string): { sql: string };
  /** ORDER BY clause for BM25 scoring. Returns a SQL expression for ranking. */
  scoreClause(columns: string[], queryParam: string): string;

  /**
   * Build the bound MATCH-query text (the value ultimately bound to
   * `matchClause`'s `queryParam` placeholder) from a whitespace-tokenised
   * query.
   *
   * BL-367: the two engines have DIFFERENT implicit boolean defaults for a
   * bareword query string. SQLite FTS5 ANDs bareword tokens together
   * (`fox riverbank` requires BOTH terms present) while Turso's Tantivy
   * `fts_match` matches on ANY token present (effectively OR). A naive
   * space-joined query therefore returns dramatically fewer — often zero —
   * results on SQLite than the identical query on Turso for any multi-term
   * query where not every token co-occurs in one document (empirically
   * measured: 4/5 test queries returned ZERO SQLite FTS matches while Turso
   * returned real hits for the same corpus — see
   * `recall-parity-arm-attribution.test.ts`).
   *
   * Both dialects now build an explicit `"tok1" OR "tok2" OR ...` query
   * string so the boolean semantics are identical (and independent of
   * either engine's implicit default) — matching recall's intent of a
   * forgiving, any-term-contributes text-search signal, not exact-phrase
   * matching. Tokens are individually double-quoted (FTS5 phrase-query
   * syntax, which also disables prefix/column-filter special characters)
   * with embedded quotes escaped by doubling.
   */
  buildMatchQuery(tokens: string[]): string;
}

// ── FTS operations (A2 — FEAT-SOXGRAPH-001) ──────────────────────────────────

export interface FtsSearchOptions {
  /** Max rows returned. Default: 50. */
  limit?: number;
  /** Row offset. */
  offset?: number;
  /** SQL WHERE fragment AND-ed after the FTS match. May reference the base
   *  table under its alias `n` (e.g. `n.kind = ?`); a leading `WHERE`/`AND`
   *  is tolerated and normalized away. Bound values go in `params`, in
   *  placeholder order. */
  where?: string;
  /** Bound params for `where`, in placeholder order. */
  params?: unknown[];
  /** Accepted for interface symmetry with {@link FtsEnsureOptions.weights} —
   *  NOT used by the search SQL on either backend (column weights are fixed
   *  at index-creation time on both FTS5 and Tantivy; there is no per-query
   *  weight surface). */
  weights?: Record<string, number>;
}

export interface FtsCountOptions {
  /** Same `where` semantics as {@link FtsSearchOptions.where}. */
  where?: string;
  /** Bound params for `where`, in placeholder order. */
  params?: unknown[];
}

export interface FtsEnsureOptions {
  /** Column weights — honored on Turso (Tantivy `WITH (weights=...)` clause),
   *  ignored on SQLite (FTS5 weights are part of the caller-supplied
   *  `sqliteDDL`). */
  weights?: Record<string, number>;
  /** SQLite FTS5 DDL statements, returned verbatim by the dialect in order
   *  (typically `[FTS_DDL, FTS_TRIGGERS]` from memory-core's schema.ts —
   *  store-adapter cannot depend on graph-store, so callers pass the DDL).
   *  Ignored on Turso, which generates its own `CREATE INDEX … USING fts`. */
  sqliteDDL?: readonly string[];
  /** Backfill the FTS5 shadow table (`INSERT INTO fts_<table> SELECT FROM
   *  <table>`). SQLite FTS5 only — Turso's Tantivy index is maintained by the
   *  engine and has no row-insert surface. Default: true. */
  backfill?: boolean;
  /** Detect and clean the OTHER dialect's legacy FTS residue. On SQLite the
   *  Turso Tantivy index is dropped directly (harmless opaque rows to
   *  better-sqlite3); on Turso the SQLite FTS5 stack is detected and reported
   *  as `residueNeedsOutOfBand` — the Turso engine cannot reliably `DROP`
   *  fts5 objects (silent no-op, see `FTSDialect.dropLegacyDDL`). Default:
   *  true. */
  dropLegacyResidue?: boolean;
}

export interface FtsEnsureResult {
  /** True when an FTS index exists (created or adopted) after the call. */
  ensured: boolean;
  /** Non-null when an existing non-canonical index (e.g. `idx_fts_node__r1`
   *  after a BL-461 orphan-guard rebuild) was ADOPTED instead of creating a
   *  duplicate over the same columns. */
  adoptedExisting: string | null;
  /** The index object in effect: the FTS5 virtual table `fts_<table>` on
   *  SQLite, the Tantivy index name on Turso — the adopted name when adopted,
   *  `null` when not ensured. */
  indexName: string | null;
  /** True when a shadow-table backfill `INSERT … SELECT` ran. */
  backfilled: boolean;
  /** Names of legacy-residue objects actually dropped by this call. */
  residueDropped: string[];
  /** True when the OTHER dialect's FTS residue was detected but could NOT be
   *  dropped through this connection (Turso cannot drop fts5 objects
   *  reliably — needs a better-sqlite3 pass against the same file, out of
   *  band). */
  residueNeedsOutOfBand: boolean;
}

// ── Backup (BL-385) ──────────────────────────────────────────────────────────

export interface AdapterBackupOptions {
  /**
   * Skip the post-backup integrity verification of the destination.
   * NOT recommended for production — only for test scenarios.
   * Default: false.
   */
  skipIntegrityCheck?: boolean;
}

export interface AdapterBackupResult {
  /** Absolute destination path written. */
  destPath: string;
  /**
   * Result of the post-backup integrity check: 'ok' on success, otherwise a
   * semicolon-joined description of the finding(s). 'ok' (unverified) when
   * `skipIntegrityCheck` was set.
   *
   * **Prefer {@link integrityReport}.** This string cannot distinguish
   * "verified clean" from "not verified at all" (BL-449), and it is kept
   * populated only so existing callers keep compiling and behaving.
   */
  integrityCheck: string;
  /**
   * (BL-341, BL-449) The structured verdict: what was actually checked, what
   * could not be, and whether the backend truncated its own output. Absent
   * only when `skipIntegrityCheck` was set — in which case nothing was
   * checked and there is no verdict to report.
   */
  integrityReport?: BackupIntegrityReport;
}

// ── Config ──────────────────────────────────────────────────────────────────

export interface AdapterConfig {
  type: 'sqlite' | 'turso';
  /** For SqliteAdapter: path to the database file (required). For TursoAdapter: if url is also set, url takes precedence. If only dbPath is set, treated as local file: mode. */
  dbPath?: string;
  /** TursoAdapter remote URL (libsql://my-db.turso.io). Takes precedence over dbPath for remote connections. Ignored by SqliteAdapter. */
  url?: string;
  authToken?: string;
  readonly?: boolean;
  /** (BL-391) TursoAdapter only: combined with `readonly: true`, keeps
   *  `fts_match`/`fts_score` working — Turso's native readonly connect
   *  option blocks it outright (`Resource is read-only`), a genuine engine
   *  limitation, not a missing experimental flag. See
   *  `TursoAdapterImpl.connect()`'s doc comment for the full mechanism and
   *  measurements. Ignored by SqliteAdapter (its native readonly already
   *  coexists with FTS5). */
  allowFtsInReadonly?: boolean;
  encryption?: {
    cipher: 'aegis256' | 'aes256gcm';
    hexkey: string;
  };
  /** Experimental feature flags. Currently: multiprocessWal enables multi-process write support. */
  experimental?: { multiprocessWal?: boolean };
  defaultQueryTimeout?: number;
}

// ── Factory options ──────────────────────────────────────────────────────────

/**
 * Options for `createStoreAdapter()`.
 */
export interface CreateStoreOptions {
  /** Auto-migrate when the store's `_adapter_meta` adapter_type differs from
   *  the requested adapter type. When `true` and a type mismatch is detected,
   *  the factory copies all user data to a new store of the requested type
   *  using an atomic temp-file swap. Default: `false`. */
  migrateOnAdapterChange?: boolean;
  /** Options forwarded to `migrateStore` during auto-migration. */
  migrationOptions?: import('./migration.js').MigrationOptions;
}

// ── Main interface ──────────────────────────────────────────────────────────

export interface StoreAdapter {
  // Query methods
  executeGet<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<T | null>;
  executeAll<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<AllResult<T>>;
  executeRun(sql: string, args?: unknown[]): Promise<RunResult>;

  // DDL / multi-statement
  exec(sql: string): Promise<void>;

  // PRAGMA shortcuts. Boolean values are converted to 1 (true) / 0 (false).
  pragmaSet(key: string, value: string | number | boolean): Promise<void>;
  pragmaGet<T = unknown>(key: string): Promise<T>;

  // Transaction with mode support
  /**
   * Execute a callback within a database transaction.
   *
   * To abort a transaction, throw from the callback — the adapter automatically
   * issues ROLLBACK and re-throws. There is no explicit rollback() method.
   *
   * @param fn  The transactional body. Both adapters support sync and async callbacks.
   *            Use await on AdapterTransaction methods inside the callback — they all return Promises.
   * @param opts  Optional mode + retry config. mode defaults to 'deferred'.
   *              Use 'immediate' for CAS, 'exclusive' for schema migrations,
   *              'concurrent' for MVCC (TursoAdapter only).
   */
  transaction<T>(fn: (tx: AdapterTransaction) => T | Promise<T>, opts?: TransactionOptions): Promise<T>;

  // Batch convenience (NON-ATOMIC — runs statements sequentially; first failure does not roll back prior statements. For atomicity, use transaction().)
  executeMany(stmts: { sql: string; args?: unknown[] }[]): Promise<RunResult[]>;

  // Full-text search (A2 — FEAT-SOXGRAPH-001). Per-backend SQL lives in
  // fts-ops.ts, keyed on FTSDialect.supportsShadowTable — never config.type.
  /**
   * Ranked full-text search over `columns` of `table`.
   *
   * - Returns rows joined to the FTS match with `rowid` (the base row's
   *   rowid) and `score` (higher = better on BOTH backends: SQLite FTS5's
   *   negated `rank` column, Turso's native `fts_score`), ordered score DESC.
   * - Multi-term queries are normalized to the explicit `"tok1" OR "tok2"`
   *   form (BL-367) so SQLite and Turso return identical rowid sets.
   * - `opts.where` is AND-ed after the match and may reference the base table
   *   alias `n` (e.g. `n.kind = ?`).
   * - Capability gate: `capabilities.fts === false` → `[]`. Empty/normalized
   *   query → `[]`. Real DB errors rethrow.
   */
  ftsSearch<T = Record<string, unknown>>(
    table: string,
    columns: string[],
    query: string,
    opts?: FtsSearchOptions,
  ): Promise<Array<T & { rowid: number; score: number }>>;
  /** Row count for the same match as {@link ftsSearch} (ignores limit/offset).
   *  Capability gate → 0; empty query → 0. */
  ftsCount(
    table: string,
    columns: string[],
    query: string,
    opts?: FtsCountOptions,
  ): Promise<number>;
  /** Idempotently ensure an FTS index over `columns` of `table`. Adopts an
   *  existing non-canonical index by lookup (BL-461), skips per-statement
   *  `already exists` races, backfills the FTS5 shadow table when
   *  `capabilities.fts5`, and cleans the other dialect's legacy residue.
   *  Capability gate → `{ ensured: false, … }`. */
  ensureFtsIndex(
    table: string,
    columns: string[],
    opts?: FtsEnsureOptions,
  ): Promise<FtsEnsureResult>;

  // Lifecycle

  /**
   * Post-construction initialisation: stamps `_adapter_meta`, then verifies
   * and repairs the artifacts the adapter generates (BL-352 — see
   * `integrity.ts`). `createStoreAdapter()` calls it; direct constructor
   * users must call it themselves or the store opens unverified.
   *
   * Optional because an adapter wrapping a caller-owned handle (e.g.
   * `createSqliteAdapter(db)`) may have nothing to initialise.
   */
  init?(): Promise<void>;

  close(): Promise<void>;

  // Introspection
  readonly config: Readonly<AdapterConfig>;
  readonly capabilities: Readonly<AdapterCapabilities>;

  /** Escape hatch — returns the raw driver handle. Calling this breaks portability. */
  unwrap(): unknown;

  /**
   * (BL-385) Create a compacted, consistent, single-file copy of this store
   * at `destPath` via `VACUUM INTO` — the adapter owns the operation so
   * callers (e.g. `memory-core`'s `backup.ts`) never have to know or guess
   * what backend they are talking to. Each implementation runs `VACUUM INTO`
   * on its own connection with whatever flags that backend requires:
   *  - `SqliteAdapter`: loads sqlite-vec before vacuuming so vec0 shadow
   *    tables copy correctly.
   *  - `TursoAdapter`: runs directly on the existing connection's
   *    experimental flags (`index_method`, optionally `multiprocess_wal`) —
   *    `VACUUM INTO` has no restriction against `multiprocess_wal`, unlike
   *    in-place `VACUUM` (`Parse error: VACUUM is incompatible with
   *    experimental multiprocess WAL`).
   * `destPath` must not already exist; implementations must fail rather than
   * silently overwrite. Optional — `MockAdapter` (tests) does not implement
   * it.
   */
  backupTo?(destPath: string, opts?: AdapterBackupOptions): Promise<AdapterBackupResult>;
}

// ── Narrowed sub-types ─────────────────────────────────────────────────────

export interface SqliteAdapter extends StoreAdapter {
  readonly config: Readonly<AdapterConfig & { type: 'sqlite' }>;
  /** Always present on this adapter — stamps meta, then verifies and repairs
   *  the store's generated artifacts (BL-352). TursoAdapter does the
   *  equivalent inside `connect()`, which is why the base declaration is
   *  optional. */
  init(): Promise<void>;
  /** Escape hatch — returns the raw better-sqlite3.Database handle. Calling this breaks portability. */
  unwrap(): import('better-sqlite3').Database;
}

export interface TursoAdapter extends StoreAdapter {
  readonly config: Readonly<AdapterConfig & { type: 'turso' }>;
  /** Escape hatch — returns the raw @tursodatabase/database handle. Calling this breaks portability. */
  unwrap(): import('@tursodatabase/database').Database;
  /**
   * (SPEC-CONN-RECYCLE) Live connection health. `'poisoned'` after a fatal
   * driver fault (see `isFatalConnectionError`) has been detected and a
   * reconnect has not yet started; `'reconnecting'` while one is in flight;
   * `'healthy'` otherwise. Additive-only seam for callers (e.g. a health
   * surface) that want to report connection state without triggering a
   * query — reading it never itself starts a reconnect.
   */
  readonly connectionHealth: 'healthy' | 'poisoned' | 'reconnecting';
  /**
   * (BL-506) Close the current connection, run `fn` against the store file
   * while NO turso connection is open, then reopen through the full
   * `connect()` ceremony — all on THIS instance, so every caller holding
   * this adapter keeps a valid handle. See
   * `TursoAdapterImpl.withConnectionClosedForRepair` for the full contract.
   */
  withConnectionClosedForRepair<T>(fn: () => Promise<T>): Promise<T>;
}
