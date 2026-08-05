import {
  consumeUncleanShutdownFlag,
  ensureAdapterMetaTable,
  markCleanShutdown,
  stampAdapterMeta,
} from './adapter-meta.js';
import {
  captureWalIdentity,
  describeStaleWalIndexFailure,
  emitIntegrityReport,
  isStaleWalIndexError,
  recoverStaleWalIndex,
  runOpenTimeIntegrity,
  summarizeBackupIntegrity,
  verifyStoreIntegrity,
} from './integrity.js';
import type { BackupIntegrityReport, WalIdentity } from './integrity.js';
import {
  clearStoreOpenMarker,
  describePreflight,
  hasStoreOpenMarker,
  markStoreOpen,
  preflightSchemaSanity,
} from './preflight.js';
import type {
  TursoAdapter,
  AdapterTransaction,
  AdapterConfig,
  AdapterCapabilities,
  AdapterBackupOptions,
  AdapterBackupResult,
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

  /** (BL-330) WAL identity as it stood when this connection opened. Compared
   *  again at close: if the `-wal` path has vanished or now resolves to a
   *  different inode, every write since the last checkpoint is about to be
   *  discarded silently and we must checkpoint and say so. Internal — set by
   *  `connect()`. */
  _walBaseline: WalIdentity | null = null;

  /** (BL-391) Set by `connect()` when opened with `readonly: true,
   *  allowFtsInReadonly: true` — the native driver connection is writable
   *  (required for `fts_match` to work at all), so this adapter enforces
   *  read-only at the application layer instead. See `_assertWritable()`. */
  private _softReadonly = false;

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
    /**
     * (BL-391) When combined with `readonly: true`, keeps `fts_match`/
     * `fts_score` functional instead of failing with `Resource is
     * read-only`. Measured empirically (2026-08-03): Turso's native
     * `readonly` connect option treats `fts_match` as a write-shaped
     * statement — it fails identically whether protection comes from the
     * driver's `readonly` option OR from a `PRAGMA query_only=ON` on an
     * otherwise-writable connection (`Parse error: Cannot execute write
     * statement in query_only mode`). This is NOT the missing
     * `index_method` flag — that experiment is unconditionally on above,
     * with or without this option, and plain reads (`COUNT(*)`) work
     * identically under real Turso readonly. It is a genuine Turso engine
     * limitation specific to `fts_match`/`fts_score` execution.
     *
     * With this flag, the connection opens WITHOUT the native `readonly`
     * driver option (so `fts_match` works), and this adapter instance
     * enforces read-only at the application layer instead: `executeRun`,
     * `exec`, and `transaction` all throw immediately (see
     * `_assertWritable`). Metadata stamping / open-time integrity repair
     * are still skipped, identically to hard `readonly: true` (BL-352's
     * writes are exactly the kind of accidental mutation to a
     * non-primary/federated store this option exists to prevent).
     *
     * Ignored unless `readonly` is also `true`. Default false — existing
     * callers (e.g. `backup.ts`'s VACUUM INTO source, which never touches
     * `fts_match`) are unaffected.
     */
    allowFtsInReadonly?: boolean;
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

    // (BL-391) Soft-readonly: caller wants read-only semantics but needs
    // fts_match to keep working, which Turso's native readonly option
    // categorically blocks (see allowFtsInReadonly doc comment above). Do
    // NOT forward `readonly` to the native driver in that case — the
    // connection opens writable at the driver level, and this instance
    // enforces read-only itself via `_assertWritable()`.
    const softReadonly = opts.readonly === true && opts.allowFtsInReadonly === true;

    // Build DatabaseOpts
    const dbOpts: any = {};
    if (opts.readonly !== undefined && !softReadonly) dbOpts.readonly = opts.readonly;
    if (opts.defaultQueryTimeout !== undefined) dbOpts.defaultQueryTimeout = opts.defaultQueryTimeout;

    // index_method is ALWAYS on, unconditionally — not a toggle. Turso's FTS
    // index DDL (`CREATE INDEX ... USING fts (...)`) and every subsequent
    // fts_match/fts_score query against it require this experimental flag on
    // the connection that runs them — not just the connection that created
    // the index. Without it, index creation throws a parse error ("index
    // method is an experimental feature") that was previously swallowed by a
    // surrounding try/catch at log.debug in db.ts, so idx_fts_node silently
    // never existed on any real Turso store and FTS was dead in production.
    // There is no PRAGMA workaround (Turso silently no-ops unknown PRAGMAs).
    // FTS is a core feature, so this is unconditional — merged with, never
    // overwritten by, the multiprocess_wal toggle below.
    const experiments: string[] = ['index_method'];
    // Enable multiprocess_wal by default for concurrent reader/writer support.
    // Uses .tshm shared memory files for WAL coordination instead of exclusive fcntl locks.
    // Independently toggle-able via experimental: { multiprocessWal: false } —
    // must not clobber index_method above when opted out.
    if (opts.experimental?.multiprocessWal !== false) {
      experiments.push('multiprocess_wal');
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
    const openOnce = async (): Promise<any> => {
      if (opts.authToken && !url.startsWith('file:')) {
        // Remote connection via libsql:// — use connect()
        return connect(url, { authToken: opts.authToken, ...dbOpts });
      }
      if (url.startsWith('file:') || !opts.authToken) {
        // Local connection — use connect() for async
        return connect(url, dbOpts);
      }
      return connect(url, { authToken: opts.authToken, ...dbOpts });
    };

    // (BL-361) OUT-OF-PROCESS PRE-FLIGHT. An FTS index row whose Tantivy
    // backing objects are missing does not fail with an error — the first
    // `fts_match` against it PANICS in Rust and aborts this process (SIGABRT).
    // The driver open below survives; `runOpenTimeIntegrity` a few lines down
    // does not, because `probeFtsIndexes` issues exactly that query on every
    // open. A panic crossing the FFI boundary is not catchable, so no probe
    // and no repair path downstream ever runs. The only defence is to look at
    // `sqlite_master` through a different engine BEFORE the store is used.
    // See preflight.ts for the mechanism and the per-statement measurements,
    // and upstream https://github.com/tursodatabase/turso/issues/8216.
    //
    // Gated on the out-of-band marker file, NOT on the store's own unclean
    // flag: `consumeUncleanShutdownFlag()` reads `_adapter_meta` through this
    // adapter, i.e. after `connect()` returned — and this pre-flight has to
    // decide before that, so the gate must live outside the database.
    if (opts.dbPath && opts.readonly !== true && hasStoreOpenMarker(opts.dbPath)) {
      const preflight = preflightSchemaSanity(opts.dbPath, { repair: true });
      if (preflight.orphaned.length > 0) {
        emitIntegrityReport(
          opts.dbPath,
          preflight.failed !== null ? 'repair_failed' : 'repaired',
          describePreflight(preflight),
        );
      }
    }

    let db: any;
    try {
      db = await openOnce();
    } catch (err) {
      // (BL-373) A stale `-tshm` — Turso's own WAL-index sidecar — makes the
      // store PERMANENTLY unopenable after an ordinary restart, with a
      // diagnostic that names the database and a WAL frame offset while the WAL
      // is 0 bytes. The backend crash-loops and nothing recovers it. The
      // sidecar is derived state that Turso rebuilds from scratch, so
      // reconciling it is safe when the WAL has nothing to lose. This must live
      // here rather than in a post-open probe: `connect()` itself is what
      // fails, so nothing downstream ever runs.
      if (!isStaleWalIndexError(err) || !opts.dbPath) throw err;

      const recovery = recoverStaleWalIndex(opts.dbPath);
      emitIntegrityReport(
        opts.dbPath,
        recovery.movedAside.length > 0 ? 'damaged' : 'repair_failed',
        recovery.movedAside.length > 0
          ? `[BL-373] stale WAL-index sidecar blocked the open; moved aside: ${recovery.movedAside
              .map((m) => m.to)
              .join(', ')}`
          : `[BL-373] open failed with a WAL-frame error and the sidecar could NOT be reconciled: ${
              recovery.declined ?? 'unknown reason'
            }`,
      );
      if (recovery.movedAside.length === 0) {
        throw describeStaleWalIndexFailure(opts.dbPath, recovery, err);
      }
      try {
        db = await openOnce();
      } catch (retryErr) {
        throw describeStaleWalIndexFailure(opts.dbPath, recovery, retryErr);
      }
      emitIntegrityReport(
        opts.dbPath,
        'repaired',
        `[BL-373] store opened after reconciling the stale WAL-index sidecar`,
      );
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
    instance._softReadonly = softReadonly;

    // (BL-361) The store is now open, so this session owns it. The marker is
    // what tells the NEXT open that this session may not have ended cleanly —
    // `close()` clears it. It lives outside the database on purpose: the state
    // it guards against is one where the database cannot be read at all.
    if (opts.readonly !== true) markStoreOpen(opts.dbPath);

    // Stamp adapter metadata (non-fatal)
    if (!opts.readonly) {
      let uncleanShutdown = false;
      try {
        await ensureAdapterMetaTable(instance);
        await stampAdapterMeta(instance, 'turso');
        uncleanShutdown = await consumeUncleanShutdownFlag(instance);
      } catch {
        // Non-fatal
      }

      // (BL-352) Verify — and repair — the artifacts this adapter generates.
      // `CREATE INDEX IF NOT EXISTS` cannot see a structure that exists but is
      // empty, so schema reconciliation alone leaves damage permanent and
      // invisible. See integrity.ts for the probes and their negative controls.
      instance._walBaseline = captureWalIdentity(config.dbPath ?? config.url);
      await runOpenTimeIntegrity(instance, {
        uncleanShutdown,
        walBaseline: instance._walBaseline,
        onReport: (event, detail) => emitIntegrityReport(config.dbPath ?? config.url, event, detail),
      });
    }

    return instance;
  }

  unwrap(): import('@tursodatabase/database').Database {
    return this.db as import('@tursodatabase/database').Database;
  }

  /**
   * (BL-385) VACUUM INTO, run directly on this adapter's existing connection
   * with whatever experimental flags it was opened with (`index_method`,
   * optionally `multiprocess_wal` — see `connect()` above, the same flags
   * production already sets). Measured 2026-08-01 against a copy of the live
   * store: identical nodes/vec_node/edge counts, identical fts_match hit
   * count, and 19 MB reclaimed — with no new flags required.
   *
   * IMPORTANT: plain in-place `VACUUM` (no INTO) fails on this connection
   * with `Parse error: VACUUM is incompatible with experimental multiprocess
   * WAL`. `VACUUM INTO` has no such restriction — do not "simplify" this to
   * a plain VACUUM.
   */
  async backupTo(destPath: string, opts: AdapterBackupOptions = {}): Promise<AdapterBackupResult> {
    await this.db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);

    let integrityCheck = 'ok';
    let integrityReport: BackupIntegrityReport | undefined;
    if (!opts.skipIntegrityCheck) {
      // Reopen the backup with the SAME experimental flags as the source —
      // `index_method` is required to even read the FTS index the copy
      // carries. verifyStoreIntegrity's pragma_integrity_check probe already
      // filters the known permanent Turso FTS false positive
      // (`isKnownFalsePositive`), so a clean copy reports 'ok' here.
      //
      // (BL-449) `allowFtsInReadonly` is required now that the full probe set
      // runs: `fts_index_live` issues `fts_match`, which Turso's native
      // readonly connect option blocks outright (BL-391). Without it the FTS
      // probe cannot run on the copy, and "cannot run" is exactly the state
      // this packet exists to stop reporting as healthy.
      const backupConnectOpts: Parameters<typeof TursoAdapterImpl.connect>[0] = {
        dbPath: destPath,
        readonly: true,
        allowFtsInReadonly: true,
      };
      if (this.config.experimental !== undefined) {
        backupConnectOpts.experimental = this.config.experimental;
      }
      const backupAdapter = await TursoAdapterImpl.connect(backupConnectOpts);
      try {
        // (BL-449) NO `only:` narrowing — see the SqliteAdapter twin for the
        // full reasoning. `only: ['pragma_integrity_check']` excluded every
        // probe written after it, silently and with no trace in the report.
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

  /** (BL-391) Throws if this adapter was opened `readonly: true,
   *  allowFtsInReadonly: true` — the native driver connection is writable in
   *  that mode (a requirement for `fts_match`), so mutation must be blocked
   *  here instead. Never triggers for a normal writable connection or for a
   *  hard `readonly: true` (native driver already refuses those writes). */
  private _assertWritable(): void {
    if (this._softReadonly) {
      throw new Error(
        '[BL-391] TursoAdapter is read-only (opened with allowFtsInReadonly for federated ' +
          'recall / read-only fan-out) — writes are not permitted on this connection.',
      );
    }
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
    this._assertWritable();
    const info = args !== undefined ? await this.db.run(sql, ...args) : await this.db.run(sql);
    return { rowsAffected: info.changes as number, lastInsertRowid: info.lastInsertRowid as number };
  }

  /**
   * CAVEAT (verified independently by two agents, 2026-07-30): `DROP TABLE`
   * and `DROP TRIGGER` issued through Turso against fts5 (and vec0) objects
   * "succeed" with no error, but the object REMAINS in `sqlite_master` —
   * Turso silently no-ops the drop rather than honoring it. Callers relying
   * on `exec()`'s DDL being applied must not assume a successful `DROP` on
   * these object kinds actually removed anything; verify via
   * `sqlite_master` or route the drop through better-sqlite3 instead (see
   * `db.ts`'s VACUUM/vec0-drop compatibility repair for the established
   * pattern). Relatedly: Turso also never invokes fts5 trigger bodies at
   * all — INSERT/UPDATE/DELETE on a triggering table succeed with stale
   * fts5 triggers present, but the trigger body silently never runs. This
   * happens to be harmless today only because nothing depends on those
   * triggers firing; it would break instantly if a future Turso version
   * starts executing them for real.
   */
  async exec(sql: string): Promise<void> {
    this._assertWritable();
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
    this._assertWritable();
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

  /**
   * (BL-330) Close, but never silently.
   *
   * Reproduced 2026-07-31 against `@tursodatabase/database@0.7.1`: with the
   * `-wal` file unlinked mid-session, `close()` returned **with no error** and
   * the reopened store had lost not merely rows but the table itself
   * (`no such table: t`) — every write since the last checkpoint, gone. The
   * control run with the WAL intact retained 140/140.
   *
   * `PRAGMA wal_checkpoint(PASSIVE)` copies the orphaned WAL's pages into the
   * still-linked main database file through the fd we already hold, and
   * recovers the data in full (measured: 140/140 vs total loss). So the close
   * path checkpoints first and reports loudly, rather than refusing — refusing
   * would strand the data in an inode nothing can reach.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (!this.config.readonly) {
      try {
        const report = await verifyStoreIntegrity(this, {
          only: ['wal_identity'],
          walBaseline: this._walBaseline,
        });
        for (const finding of report.damaged) {
          emitIntegrityReport(this.config.dbPath ?? this.config.url, 'damaged', finding.detail);
          try {
            await this.executeAll('PRAGMA wal_checkpoint(PASSIVE)');
            emitIntegrityReport(
              this.config.dbPath ?? this.config.url,
              'repaired',
              'checkpointed the orphaned WAL into the main database file before close',
            );
          } catch (err) {
            emitIntegrityReport(
              this.config.dbPath ?? this.config.url,
              'repair_failed',
              `checkpoint of the orphaned WAL failed — data since the last checkpoint is being lost: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
        if (report.damaged.length === 0) await markCleanShutdown(this);
      } catch {
        // A verification failure must never block a close.
      }
    }

    await this.db.close();

    // (BL-361) Orderly close — drop the out-of-band marker last, after the
    // driver has actually let go of the file. Its presence at the next open is
    // the ONLY signal that a session ended without getting here, and that is
    // the population that can carry the panic-on-open schema state.
    if (!this.config.readonly) clearStoreOpenMarker(this.config.dbPath);
  }
}
