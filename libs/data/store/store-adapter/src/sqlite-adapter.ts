import DatabaseConstructor from 'better-sqlite3';
import { ensureAdapterMetaTable, stampAdapterMeta } from './adapter-meta.js';
import type {
  SqliteAdapter,
  AdapterTransaction,
  AdapterConfig,
  AdapterCapabilities,
  RunResult,
  AllResult,
  TransactionOptions,
} from './types.js';

type Sqlite3Database = import('better-sqlite3').Database;
type Sqlite3Statement = import('better-sqlite3').Statement;

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

  constructor(dbPath: string, opts?: { readonly?: boolean });
  constructor(db: Sqlite3Database);
  constructor(dbOrPath: string | Sqlite3Database, opts?: { readonly?: boolean }) {
    if (typeof dbOrPath === 'string') {
      this.db = new DatabaseConstructor(dbOrPath, {
        readonly: opts?.readonly ?? false,
      });
      this.ownDb = true;
      this.config = {
        type: 'sqlite',
        dbPath: dbOrPath,
        readonly: opts?.readonly ?? false,
      };
    } else {
      this.db = dbOrPath;
      this.ownDb = false;
      this.config = {
        type: 'sqlite',
      };
    }

    this.cache = new StatementCache(256);
    this.capabilities = {
      multiprocessWrite: false,
      nativeVectors: false,
      concurrentTransactions: false,
      fts5: true,
      fts: true,
      needsWriteSerialization: true,
    };
  }

  /**
   * Initialise the adapter — stamps adapter metadata into the store.
   *
   * Safe to call multiple times; idempotent via `INSERT OR REPLACE`.
   * Skip for read-only connections.
   */
  async init(): Promise<void> {
    if (this.config.readonly) return;
    try {
      await ensureAdapterMetaTable(this);
      await stampAdapterMeta(this, 'sqlite');
    } catch {
      // Non-fatal — stamping is a convenience marker, not a correctness requirement
    }
  }

  unwrap(): import('better-sqlite3').Database {
    return this.db;
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
        } catch {
          // Ignore rollback errors
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cache.clear();
    if (this.ownDb) {
      this.db.close();
    }
  }
}
