import { ensureAdapterMetaTable, stampAdapterMeta } from './adapter-meta.js';
import type {
  TursoAdapter,
  AdapterTransaction,
  AdapterConfig,
  AdapterCapabilities,
  RunResult,
  AllResult,
  TransactionOptions,
} from './types.js';

// ── TursoTransaction (internal) ──────────────────────────────────────────────

class TursoTransactionImpl implements AdapterTransaction {
  private db: { run: Function; get: Function; all: Function; exec: Function };

  constructor(db: { run: Function; get: Function; all: Function; exec: Function }) {
    this.db = db;
  }

  async executeGet<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<T | null> {
    const row = args !== undefined ? await this.db.get(sql, ...args) : await this.db.get(sql);
    return (row as T | null) ?? null;
  }

  async executeAll<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<AllResult<T>> {
    const rows = args !== undefined ? await this.db.all(sql, ...args) : await this.db.all(sql);
    const rowsArr = rows as T[];
    const columns = rowsArr.length > 0 ? Object.keys(rowsArr[0] as Record<string, unknown>) : [];
    return { columns, rows: rowsArr };
  }

  async executeRun(sql: string, args?: unknown[]): Promise<RunResult> {
    const info = args !== undefined ? await this.db.run(sql, ...args) : await this.db.run(sql);
    return { rowsAffected: info.changes as number, lastInsertRowid: info.lastInsertRowid as number };
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }
}

// ── TursoAdapterImpl ─────────────────────────────────────────────────────────

export class TursoAdapterImpl implements TursoAdapter {
  readonly config: Readonly<AdapterConfig & { type: 'turso' }>;
  readonly capabilities: Readonly<AdapterCapabilities>;

  private db: {
    run: Function;
    get: Function;
    all: Function;
    exec: Function;
    close: Function;
    pragma: Function;
  };
  private closed = false;

  /**
   * (BL-321) `this.db` is ONE shared connection handle — @tursodatabase/database
   * local mode has no per-transaction connection or session isolation. Two
   * concurrent JS callers each running the `transaction()` retry loop below
   * against this one handle contend for the SAME logical transaction slot:
   * one's `BEGIN` can land while another's is still open, which the engine
   * correctly refuses with `Transaction error: cannot start a transaction
   * within a transaction`. Empirically (verified against the real driver,
   * see /tmp/turso-concurrency/exp3.mjs) this is a robustness/availability
   * failure, NOT silent data loss or cross-transaction corruption — every
   * commit that lands is durable, every rejection surfaces to the caller,
   * and a rolled-back transaction never discards a concurrent sibling's
   * committed work. But once a transaction is held open longer than the
   * `maxRetries=3` / `baseDelayMs=10` retry budget (~70ms) can absorb — e.g.
   * real async work between statements — the caller gets a hard throw
   * instead of a queued wait. `_txMutexChain` is a classic promise-chain
   * mutex (cheap, JS-event-loop-safe — no window for a second synchronous
   * mutation to interleave with the reassignment below) that serializes the
   * critical section per adapter instance so concurrent callers wait their
   * turn instead of colliding. This is intentionally the ONLY change here:
   * `needsWriteSerialization`/`concurrentTransactions`/`multiprocessWrite`
   * stay at their Turso defaults (store owner directive — do not revert any
   * Turso default or multiprocess-writer concurrency improvement). The
   * WriteQueue bypass (`_noop = true` for Turso) is UNCHANGED; this mutex is
   * defense-in-depth for callers that reach the adapter directly.
   */
  private _txMutexChain: Promise<void> = Promise.resolve();

  /** Run `fn` exclusively with respect to any other in-flight `transaction()`
   *  call on this adapter instance. FIFO-ish: chains onto the previous run
   *  regardless of whether it resolved or rejected, so one failed transaction
   *  never wedges the mutex for subsequent ones. */
  private _withTxLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this._txMutexChain.then(fn, fn);
    this._txMutexChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private constructor(
    db: any,
    config: AdapterConfig & { type: 'turso' },
    capabilities: AdapterCapabilities,
  ) {
    this.db = db;
    this.config = config;
    this.capabilities = capabilities;
  }

  /**
   * Create a TursoAdapter wrapping an existing connection handle.
   * Internal use; prefer `TursoAdapterImpl.connect()`.
   */
  static async connect(opts: {
    url?: string;
    dbPath?: string;
    authToken?: string;
    readonly?: boolean;
    encryption?: AdapterConfig['encryption'];
    experimental?: { multiprocessWal?: boolean };
    defaultQueryTimeout?: number;
  }): Promise<TursoAdapterImpl> {
    // Dynamic import so @tursodatabase/database is only loaded when used
    let tursoModule: any;
    try {
      tursoModule = await import('@tursodatabase/database');
    } catch {
      throw new Error(
        '@tursodatabase/database is not installed. Install it with: pnpm add @tursodatabase/database',
      );
    }

    const { connect } = tursoModule;

    // Determine connection path/url.
    // @tursodatabase/database connect() accepts a bare file path for local mode
    // or a libsql:// URL for remote connections. Do NOT prefix local paths with
    // 'file:' — that causes "I/O error (statfs shared WAL coordination path)"
    // on macOS (the Rust binary's filesystem check fails on the URI-wrapped path).
    const url = opts.url || opts.dbPath;
    if (!url) {
      throw new Error('TursoAdapter requires either url or dbPath');
    }

    // Build DatabaseOpts
    const dbOpts: any = {};
    if (opts.readonly !== undefined) dbOpts.readonly = opts.readonly;
    if (opts.defaultQueryTimeout !== undefined) dbOpts.defaultQueryTimeout = opts.defaultQueryTimeout;

    // Enable multiprocess_wal by default for concurrent reader/writer support.
    // Uses .tshm shared memory files for WAL coordination instead of exclusive fcntl locks.
    const experiments: string[] = ['multiprocess_wal'];
    if (opts.experimental?.multiprocessWal === false) {
      // Explicit opt-out via experimental: { multiprocessWal: false }
      experiments.length = 0;
    }
    if (opts.encryption) {
      dbOpts.encryption = {
        cipher: opts.encryption.cipher,
        hexkey: opts.encryption.hexkey,
      };
    }
    if (experiments.length > 0) {
      dbOpts.experimental = experiments;
    }

    // Turso adapter supports both local file: and remote libsql:// URLs
    // When authToken is present, it's a remote connection
    let db: any;
    if (opts.authToken && !url.startsWith('file:')) {
      // Remote connection via libsql:// — use connect()
      db = await connect(url, { authToken: opts.authToken, ...dbOpts });
    } else if (url.startsWith('file:') || !opts.authToken) {
      // Local connection — use connect() for async
      db = await connect(url, dbOpts);
    } else {
      db = await connect(url, { authToken: opts.authToken, ...dbOpts });
    }

    const config = { type: 'turso' } as AdapterConfig & { type: 'turso' };
    if (opts.url !== undefined) config.url = opts.url;
    if (opts.dbPath !== undefined) config.dbPath = opts.dbPath;
    if (opts.authToken !== undefined) config.authToken = opts.authToken;
    if (opts.readonly !== undefined) config.readonly = opts.readonly;
    if (opts.encryption !== undefined) config.encryption = opts.encryption;
    if (opts.experimental !== undefined) config.experimental = opts.experimental;
    if (opts.defaultQueryTimeout !== undefined) config.defaultQueryTimeout = opts.defaultQueryTimeout;

    const capabilities: AdapterCapabilities = {
      multiprocessWrite: opts.experimental?.multiprocessWal ?? true, // enabled by default
      nativeVectors: true,
      concurrentTransactions: true,
      fts5: false,
      fts: true,
      needsWriteSerialization: false,
    };

    const instance = new TursoAdapterImpl(db, config, capabilities);

    // Stamp adapter metadata (non-fatal)
    if (!opts.readonly) {
      try {
        await ensureAdapterMetaTable(instance);
        await stampAdapterMeta(instance, 'turso');
      } catch {
        // Non-fatal
      }
    }

    return instance;
  }

  unwrap(): import('@tursodatabase/database').Database {
    return this.db as import('@tursodatabase/database').Database;
  }

  async executeGet<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<T | null> {
    const row = args !== undefined ? await this.db.get(sql, ...args) : await this.db.get(sql);
    return (row as T | null) ?? null;
  }

  async executeAll<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<AllResult<T>> {
    const rows = args !== undefined ? await this.db.all(sql, ...args) : await this.db.all(sql);
    const rowsArr = rows as T[];
    const columns = rowsArr.length > 0 ? Object.keys(rowsArr[0] as Record<string, unknown>) : [];
    return { columns, rows: rowsArr };
  }

  async executeRun(sql: string, args?: unknown[]): Promise<RunResult> {
    const info = args !== undefined ? await this.db.run(sql, ...args) : await this.db.run(sql);
    return { rowsAffected: info.changes as number, lastInsertRowid: info.lastInsertRowid as number };
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async pragmaSet(key: string, value: string | number | boolean): Promise<void> {
    const boolVal = typeof value === 'boolean' ? (value ? 1 : 0) : value;
    await this.db.exec(`PRAGMA ${key} = ${boolVal}`);
  }

  async pragmaGet<T = unknown>(key: string): Promise<T> {
    const rows = await this.db.pragma(key, { simple: true });
    return rows as T;
  }

  async transaction<T>(
    fn: (tx: AdapterTransaction) => T | Promise<T>,
    opts?: TransactionOptions,
  ): Promise<T> {
    // (BL-321) Serialize the entire BEGIN…COMMIT/ROLLBACK critical section —
    // including retries — against any other concurrent transaction() call on
    // this adapter instance. See `_withTxLock` doc comment above.
    return this._withTxLock(() => this._runTransaction(fn, opts));
  }

  private async _runTransaction<T>(
    fn: (tx: AdapterTransaction) => T | Promise<T>,
    opts?: TransactionOptions,
  ): Promise<T> {
    const mode = opts?.mode ?? 'deferred';

    const beginSQL =
      mode === 'concurrent'
        ? 'BEGIN CONCURRENT'
        : mode === 'exclusive'
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
        await this.db.exec(beginSQL);
      } catch (err) {
        if (attempt < maxRetries) {
          lastError = err;
          continue;
        }
        throw err;
      }

      const tx = new TursoTransactionImpl(this.db);
      try {
        const result = await fn(tx);
        await this.db.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          await this.db.exec('ROLLBACK');
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
    await this.db.close();
  }
}
