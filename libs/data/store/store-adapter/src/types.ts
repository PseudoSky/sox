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
  /** DDL to create the FTS index for a given table/columns.
   *  For SQLite FTS5, this returns an empty string (DDL managed separately via
   *  CREATE VIRTUAL TABLE). For Turso, this returns CREATE INDEX ... USING fts. */
  createIndexDDL(table: string, columns: string[], weights?: Record<string, number>): string;
  /** WHERE clause fragment for FTS matching.
   *  Returns { sql, params } where sql uses the given queryParam placeholder. */
  matchClause(columns: string[], queryParam: string): { sql: string };
  /** ORDER BY clause for BM25 scoring. Returns a SQL expression for ranking. */
  scoreClause(columns: string[], queryParam: string): string;
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

  // Lifecycle
  close(): Promise<void>;

  // Introspection
  readonly config: Readonly<AdapterConfig>;
  readonly capabilities: Readonly<AdapterCapabilities>;

  /** Escape hatch — returns the raw driver handle. Calling this breaks portability. */
  unwrap(): unknown;
}

// ── Narrowed sub-types ─────────────────────────────────────────────────────

export interface SqliteAdapter extends StoreAdapter {
  readonly config: Readonly<AdapterConfig & { type: 'sqlite' }>;
  /** Escape hatch — returns the raw better-sqlite3.Database handle. Calling this breaks portability. */
  unwrap(): import('better-sqlite3').Database;
}

export interface TursoAdapter extends StoreAdapter {
  readonly config: Readonly<AdapterConfig & { type: 'turso' }>;
  /** Escape hatch — returns the raw @tursodatabase/database handle. Calling this breaks portability. */
  unwrap(): import('@tursodatabase/database').Database;
}
