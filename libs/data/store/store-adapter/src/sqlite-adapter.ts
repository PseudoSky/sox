import { createRequire } from 'node:module';
import { existsSync, statSync } from 'node:fs';
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
import {
  assertValidConcurrencyMode,
  resolveConcurrencyMode,
} from './concurrency-mode.js';
import type { StoreConcurrencyMode } from './concurrency-mode.js';
import {
  EStoreWalReplaced,
  describeWalReplaced,
  logWalReplacedObserved,
  resolveWalOwnershipHeartbeatMs,
  verifyWalIdentityNow,
  WAL_OWNERSHIP_HEARTBEAT_DEFAULT_MS,
} from './wal-ownership.js';
import {
  DEFAULT_IDLE_FLUSH_CEILING_MS,
  DEFAULT_IDLE_FLUSH_FLOOR_MS,
  DEFAULT_WAL_CAP_CEILING_BYTES,
  DEFAULT_WAL_CAP_HEADROOM_BYTES,
  effectiveIdleFlushMs,
  effectiveWalCapBytes,
  updateWriteIntervalEwma,
} from './wal-tuning.js';
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

// ── WAL checkpointing (BL-571) ───────────────────────────────────────────────

/**
 * (BL-571) `e77fb615` (DEBT-004) deleted memory-core's private
 * `WriteQueue`-level WAL checkpointing so every consumer inherits whatever
 * checkpoint behaviour the adapter itself provides. `TursoAdapterImpl` grew
 * that behaviour (idle-flush + wal-cap, `turso-adapter.ts` `DEFAULT_IDLE_FLUSH_MS`
 * / `DEFAULT_WAL_CAP_BYTES`); `SqliteAdapterImpl` never did, so a long-lived
 * `STORE_ADAPTER=sqlite` process had ZERO TRUNCATE path — only SQLite's own
 * ~1000-page PASSIVE auto-checkpoint, which copies frames into the main db
 * file but never shrinks the `-wal` sidecar. This is that missing half, ported
 * from `TursoAdapterImpl` with ONE deliberate simplification below.
 *
 * Same FLOOR as the Turso port (and `WriteQueue.CHECKPOINT_IDLE_MS`, its
 * ancestor) — 2000ms debounce window before an idle connection checkpoints.
 * Overridable per-instance via `opts.idleFlushMs` (tests only; no production
 * caller sets this) — an explicit value is a FIXED window, bypassing the
 * BL-590 adaptive computation below.
 *
 * (BL-590, 2026-08-18) See `turso-adapter.ts`'s `DEFAULT_IDLE_FLUSH_MS` doc
 * comment for the full BL-590 rationale — identical here, shared via
 * `wal-tuning.ts`'s `effectiveIdleFlushMs()`. This adapter has no
 * multiprocess embed-pipeline write pattern of its own today
 * (`STORE_ADAPTER=sqlite` is a legacy single-process opt-in), but the
 * adaptive computation is shared code, not a Turso-only special case — a
 * future sqlite consumer with a bursty write cadence gets the same
 * coalescing benefit for free.
 */
const DEFAULT_IDLE_FLUSH_MS = DEFAULT_IDLE_FLUSH_FLOOR_MS;

/**
 * (BL-571) Forced size-capped flush threshold — same backstop reasoning and
 * same measured default as `TursoAdapterImpl`'s `DEFAULT_WAL_CAP_BYTES` (see
 * its doc comment in turso-adapter.ts for the full derivation): idle-triggered
 * flushing alone has no answer for SUSTAINED write load, where the debounce
 * timer is cancelled and re-armed forever and never fires. This is checked
 * synchronously in the write path after every writable op, so it cannot be
 * starved by continuous traffic. Overridable via `opts.walCapBytes` (tests
 * only).
 *
 * (BL-587, 2026-08-18) THIS CONSTANT IS NO LONGER THE EFFECTIVE CAP BY
 * ITSELF — it is now the HEADROOM budget. Measured directly: this backend's
 * own post-schema WAL baseline for memory-core's real schema is ~150-165 KB
 * (FTS5 alone roughly doubles a trivial-schema baseline, 16,512 -> 32,992
 * bytes), materially higher than `TursoAdapterImpl`'s baseline for the
 * identical schema — so a flat cap gave this backend roughly 100 KB of real
 * headroom against the same nominal 256 KiB threshold that gave turso
 * roughly 245 KB. See `turso-adapter.ts`'s `DEFAULT_WAL_CAP_BYTES` doc
 * comment and `wal-tuning.ts`'s `effectiveWalCapBytes()` for the full
 * baseline-relative computation this constant now feeds.
 */
const DEFAULT_WAL_CAP_BYTES = DEFAULT_WAL_CAP_HEADROOM_BYTES;

/*
 * (BL-571) WHY THIS IS SIMPLER THAN THE TURSO PORT — read before "fixing" it
 * to look more like `turso-adapter.ts`:
 *
 * `TursoAdapterImpl`'s idle-flush is GATED: it must call
 * `releaseIdleConnection()` and check `storeQuiescence()` before a TRUNCATE,
 * because Turso's `multiprocess_wal` topology means N separate OS processes
 * can hold independent connections to the SAME store file concurrently, each
 * with its own `.tshm`-coordinated lease — TRUNCATE needs the writer-exclusive
 * lock, and issuing it while a peer process is live and holding the store
 * risks exactly the upstream #7833/#8348 checkpoint-race class the gating
 * exists to dodge.
 *
 * better-sqlite3 has none of that. It is a single-process, synchronous,
 * in-process native binding — there is no `.tshm` coordinator, no store
 * lease, no cross-process quiescence question, because there is no
 * cross-process anything: only ONE JS process can ever hold this exact
 * `Sqlite3Database` handle (`this.db`), and JS's single-threaded event loop
 * guarantees no two calls into it ever interleave. A plain, ungated
 * `PRAGMA wal_checkpoint(TRUNCATE)` is therefore unconditionally safe here —
 * pretending otherwise and importing Turso's gated/ungated strategy machinery
 * would be cargo-culting a solution to a coordination problem this backend
 * structurally cannot have. (A *different* OS process opening the same file
 * directly — e.g. the `sqlite3` CLI — is out of scope for the same reason
 * multiprocess access to a single-process embedded database always is: this
 * adapter's contract is "one process owns this file".)
 *
 * The one thing that DOES carry over unchanged: never TRUNCATE (or run any
 * checkpoint at all) synchronously in a way that blocks the Node event loop
 * for longer than necessary. better-sqlite3 calls are synchronous FFI calls —
 * `db.pragma('wal_checkpoint(TRUNCATE)')` blocks the thread for the duration
 * of the checkpoint, same as every other better-sqlite3 call in this file.
 * That is fine for a debounced idle timer (fires once, off the hot path) and
 * for a per-write cap check (already measured ~0ms per checkpoint on the
 * Turso PASSIVE path under sequential writes; TRUNCATE here has no writer to
 * wait on either), but it means the idle timer callback itself must do
 * nothing beyond the one checkpoint call — no polling loop, no additional
 * synchronous work — and must be `unref()`'d so a pending 2s timer never by
 * itself keeps an otherwise-finished process alive.
 */

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

  // ── BL-571 WAL checkpointing state — see the design note above the class
  //    for why this is a plain ungated TRUNCATE rather than a port of
  //    TursoAdapterImpl's gated/ungated strategy machinery. ──────────────────

  /** Count of operations currently executing against this connection —
   *  mirrors `TursoAdapterImpl._inFlightOps`. Incremented at the top of
   *  `_trackOp`, decremented in its `finally`; the idle flush only arms once
   *  this reaches zero, and every new op cancels any pending idle timer. */
  private _inFlightOps = 0;

  /** True when this instance is eligible to self-arm the idle WAL flush — set
   *  in the constructor for writable, local-file (`config.dbPath` set)
   *  connections only. A readonly connection cannot checkpoint (better-sqlite3
   *  refuses writes on it, including `wal_checkpoint`); a caller-owned handle
   *  with no known path (the `Sqlite3Database` constructor overload) is left
   *  disabled too — there is no path to stat for the cap check, and forcing
   *  asymmetric idle-only-but-not-cap coverage for that one case is not worth
   *  the complexity for a path with no production caller today. */
  private _idleFlushEnabled = false;

  /** Debounce window FLOOR in ms — see `DEFAULT_IDLE_FLUSH_MS`. */
  private _idleFlushMs: number = DEFAULT_IDLE_FLUSH_MS;

  /** (BL-590) Ceiling of the adaptive debounce window in ms — see
   *  `DEFAULT_IDLE_FLUSH_CEILING_MS`. Overridable via
   *  `opts.idleFlushCeilingMs` (tests only). */
  private _idleFlushCeilingMs: number = DEFAULT_IDLE_FLUSH_CEILING_MS;

  /** (BL-590) Non-null when `opts.idleFlushMs` was explicitly supplied — a
   *  FIXED window, bypassing adaptive computation entirely. */
  private _idleFlushExplicitMs: number | null = null;

  /** (BL-590) EWMA of the observed gap (ms) between successive WRITE ops —
   *  see `TursoAdapterImpl._writeIntervalEwmaMs` for the full rationale. */
  private _writeIntervalEwmaMs: number | null = null;

  /** (BL-590) Wall-clock time of the most recently completed write, or
   *  `null` before the first one. */
  private _lastWriteAt: number | null = null;

  /** (BL-590) The window actually armed by the most recent `_armIdleFlush()`
   *  call — surfaced on `idle_flush*` telemetry events (`idle_window_ms`). */
  private _lastArmedIdleFlushMs: number | null = null;

  /** The pending idle-flush timer, or `null` when none is armed. At most one
   *  is ever live per instance. */
  private _idleFlushTimer: ReturnType<typeof setTimeout> | null = null;

  /** True when this instance is eligible to run the forced size-capped flush
   *  — same eligibility as `_idleFlushEnabled`, set alongside it. */
  private _capFlushEnabled = false;

  /** (BL-587) Non-null when `opts.walCapBytes` was explicitly supplied — a
   *  FIXED absolute cap, bypassing baseline-relative computation entirely. */
  private _walCapExplicitBytes: number | null = null;

  /** (BL-587) HEADROOM budget added on top of the captured baseline — see
   *  `DEFAULT_WAL_CAP_HEADROOM_BYTES`. Overridable via
   *  `opts.walCapHeadroomBytes` (tests only). */
  private _walCapHeadroomBytes: number = DEFAULT_WAL_CAP_BYTES;

  /** (BL-587) Absolute ceiling on the effective cap — see
   *  `DEFAULT_WAL_CAP_CEILING_BYTES`. Overridable via
   *  `opts.walCapCeilingBytes` (tests only). */
  private _walCapCeilingBytes: number = DEFAULT_WAL_CAP_CEILING_BYTES;

  /** (BL-587) The captured post-schema WAL baseline, bytes. `0` (the
   *  default) until a caller invokes `captureWalCapBaseline()`. */
  private _walCapBaselineBytes = 0;

  /** (BUG-026) True once the WAL identity was observed replaced on this
   *  connection. After the first observation the orphaned frames are folded
   *  (PASSIVE) and every SUBSEQUENT writable op throws {@link EStoreWalReplaced}
   *  — fail-loud; reads keep working against the already-folded main db file.
   *  Only a close()+reopen (fresh baseline capture) clears it. */
  private _walReplaced = false;

  /** (BUG-026) True when this instance is eligible to self-arm the
   *  WAL-ownership heartbeat — writable, local-file (`config.dbPath` set)
   *  connections only, same eligibility as `_idleFlushEnabled`. */
  private _walOwnershipHeartbeatEnabled = false;

  /** (BUG-026) The heartbeat interval, ms — clamped [1000, 60000]. Resolved at
   *  construction from `opts.walOwnershipHeartbeatMs` / the
   *  `SOX_WAL_OWNERSHIP_HEARTBEAT_MS` env knob (see wal-ownership.ts). Typed
   *  tuning, never a toggle. */
  private _walOwnershipHeartbeatMs: number = WAL_OWNERSHIP_HEARTBEAT_DEFAULT_MS;

  /** (BUG-026) The pending WAL-ownership heartbeat timer, or `null` when none
   *  is armed. Self-re-arming; `unref()`'d so it never keeps an otherwise-
   *  finished process alive. */
  private _walOwnershipHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;

  /** (BUG-026) Cancel a pending WAL-ownership heartbeat. */
  private _cancelWalOwnershipHeartbeat(): void {
    if (this._walOwnershipHeartbeatTimer !== null) {
      clearTimeout(this._walOwnershipHeartbeatTimer);
      this._walOwnershipHeartbeatTimer = null;
    }
  }

  constructor(
    dbPath: string,
    opts?: {
      readonly?: boolean;
      idleFlushMs?: number;
      idleFlushFloorMs?: number;
      idleFlushCeilingMs?: number;
      walCapBytes?: number;
      walCapHeadroomBytes?: number;
      walCapCeilingBytes?: number;
      walOwnershipHeartbeatMs?: number;
      concurrencyMode?: StoreConcurrencyMode;
    },
  );
  constructor(db: Sqlite3Database);
  constructor(
    dbOrPath: string | Sqlite3Database,
    opts?: {
      readonly?: boolean;
      idleFlushMs?: number;
      idleFlushFloorMs?: number;
      idleFlushCeilingMs?: number;
      walCapBytes?: number;
      walCapHeadroomBytes?: number;
      walCapCeilingBytes?: number;
      walOwnershipHeartbeatMs?: number;
      concurrencyMode?: StoreConcurrencyMode;
    },
  ) {
    // (BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001) Resolve + validate the
    // concurrency mode up front — sqlite mandates 'single-writer' only; a
    // 'multiprocess-wal' declaration throws before any file/WAL is touched.
    const mode: StoreConcurrencyMode = opts?.concurrencyMode ?? resolveConcurrencyMode('sqlite');
    assertValidConcurrencyMode('sqlite', mode);
    if (typeof dbOrPath === 'string') {
      // (BUG014.T4, INV-4) Canonicalize ONCE at open: `config.dbPath` and every
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
        concurrencyMode: mode,
      };
    } else {
      this.db = dbOrPath;
      this.ownDb = false;
      this.config = {
        type: 'sqlite',
        concurrencyMode: mode,
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
      // (BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001) sqlite is a single
      // synchronous in-process connection: 'single-writer' by construction, so
      // the mode is verified intrinsically — no sidecar to probe.
      walMode: mode,
      walModeVerified: true,
      multiprocessWrite: mode === 'multiprocess-wal',
      nativeVectors: false,
      concurrentTransactions: false,
      fts5: true,
      fts: true,
      needsWriteSerialization: true,
      recursiveCte: true,
    };

    // (BL-571) Arm the adapter-owned WAL checkpointing — writable, local-file
    // connections only (see the eligibility doc comment on `_idleFlushEnabled`
    // above). Armed here, not just from `_trackOp()`'s finally, because a
    // freshly opened, never-yet-used instance never runs a `_trackOp()` cycle
    // on its own — without this it would idle forever unflushed until its
    // first real operation.
    if (!this.config.readonly && this.config.dbPath !== undefined) {
      this._idleFlushEnabled = true;
      if (opts?.idleFlushMs !== undefined) {
        this._idleFlushMs = opts.idleFlushMs;
        this._idleFlushExplicitMs = opts.idleFlushMs;
      }
      if (opts?.idleFlushFloorMs !== undefined) this._idleFlushMs = opts.idleFlushFloorMs;
      if (opts?.idleFlushCeilingMs !== undefined) this._idleFlushCeilingMs = opts.idleFlushCeilingMs;
      this._capFlushEnabled = true;
      if (opts?.walCapBytes !== undefined) {
        this._walCapExplicitBytes = opts.walCapBytes;
      }
      if (opts?.walCapHeadroomBytes !== undefined) this._walCapHeadroomBytes = opts.walCapHeadroomBytes;
      if (opts?.walCapCeilingBytes !== undefined) this._walCapCeilingBytes = opts.walCapCeilingBytes;
      this._armIdleFlush();
      // (BUG-026) Arm the WAL-ownership heartbeat — same eligibility as the
      // idle flush, same reasoning (a freshly opened instance never runs a
      // `_trackOp()` cycle on its own). Interval resolved from the explicit
      // opt / the env knob, clamped.
      this._walOwnershipHeartbeatEnabled = true;
      this._walOwnershipHeartbeatMs = resolveWalOwnershipHeartbeatMs(opts?.walOwnershipHeartbeatMs);
      this._armWalOwnershipHeartbeat();
    }
  }

  // ── BL-571 WAL checkpointing methods ────────────────────────────────────

  /** Cancel a pending idle flush — new work arrived. */
  private _cancelIdleFlush(): void {
    if (this._idleFlushTimer !== null) {
      clearTimeout(this._idleFlushTimer);
      this._idleFlushTimer = null;
    }
  }

  /** Arm the idle flush if eligible, currently idle (`_inFlightOps === 0`),
   *  not closed, and nothing is already scheduled. Called from `_trackOp()`'s
   *  `finally` whenever an op completion leaves the connection idle, and once
   *  at the end of the constructor for a freshly opened instance. */
  private _armIdleFlush(): void {
    if (!this._idleFlushEnabled) return;
    if (this.closed) return;
    if (this._inFlightOps > 0) return;
    if (this._idleFlushTimer !== null) return; // already scheduled — coalesced
    // (BL-590) Adaptive window — see `TursoAdapterImpl._armIdleFlush()` for
    // the full rationale; identical computation, shared via wal-tuning.ts.
    const windowMs =
      this._idleFlushExplicitMs ??
      effectiveIdleFlushMs({
        floorMs: this._idleFlushMs,
        ceilingMs: this._idleFlushCeilingMs,
        writeIntervalEwmaMs: this._writeIntervalEwmaMs,
      });
    this._lastArmedIdleFlushMs = windowMs;
    this._idleFlushTimer = setTimeout(() => {
      this._idleFlushTimer = null;
      this._performIdleFlush();
    }, windowMs);
    // (BL-571 design note) A pending idle-flush timer must never by itself
    // keep an otherwise-finished process alive.
    this._idleFlushTimer.unref?.();
  }

  /**
   * Fires once per idle period — the primary WAL durability assurance, same
   * role as `TursoAdapterImpl._performIdleFlush()`. Unlike Turso's gated
   * strategy, this runs a plain, ungated `wal_checkpoint(TRUNCATE)` directly
   * on the live connection — see the design note above the class for why
   * single-process better-sqlite3 needs no quiescence gate. Defensively
   * re-checks `closed`/`_inFlightOps` even though `_armIdleFlush()` already
   * gated on them at schedule time — the debounce window is real wall-clock
   * time in which new work (or a close) can land between "armed" and "fires".
   * Never throws — swallows and logs, same posture as the Turso port.
   */
  private _performIdleFlush(): void {
    if (this.closed || this._inFlightOps > 0) return;
    try {
      const rows = this.db.pragma('wal_checkpoint(TRUNCATE)') as
        | Array<{ busy?: number; log?: number; checkpointed?: number }>
        | undefined;
      const row = rows?.[0];
      if (row?.busy === 1) {
        // Single-process + no other connection SHOULD make this unreachable
        // (see design note), but better-sqlite3's own internal checkpoint
        // lock is opaque from here — log rather than assume it can't happen.
        // Durable either way: frames stay in the WAL, the next idle cycle (or
        // the next write's cap check) retries.
        log.warn('store_adapter.sqlite.idle_flush_busy', {
          db_path: this.config.dbPath,
        });
      } else {
        log.debug('store_adapter.sqlite.idle_flush', {
          db_path: this.config.dbPath,
          frames_checkpointed: row?.checkpointed ?? null,
          // (BL-590) Verifiable-from-telemetry adaptive window.
          idle_window_ms: this._lastArmedIdleFlushMs,
          write_interval_ewma_ms:
            this._writeIntervalEwmaMs !== null ? Math.round(this._writeIntervalEwmaMs) : null,
        });
      }
    } catch (err) {
      log.error('store_adapter.sqlite.idle_flush_failed', {
        db_path: this.config.dbPath,
        error: err instanceof Error ? err.message : String(err),
        idle_window_ms: this._lastArmedIdleFlushMs,
      });
    }
  }

  /** (BUG-026) Arm the WAL-ownership heartbeat if eligible and not already
   *  scheduled — periodic, self-re-arming, same role as the Turso port. */
  private _armWalOwnershipHeartbeat(): void {
    if (!this._walOwnershipHeartbeatEnabled) return;
    if (this.closed) return;
    if (this._walOwnershipHeartbeatTimer !== null) return;
    const ms = this._walOwnershipHeartbeatMs;
    this._walOwnershipHeartbeatTimer = setTimeout(() => {
      this._walOwnershipHeartbeatTimer = null;
      this._performWalOwnershipHeartbeat();
    }, ms);
    this._walOwnershipHeartbeatTimer.unref?.();
  }

  /**
   * (BUG-026) Fires once per heartbeat period. Skips when closed, mid-op, or
   * with no baseline captured yet. On a replaced WAL runs the same recovery
   * as the write path (fold + fail-loud); on an intact WAL runs a PASSIVE
   * checkpoint (never TRUNCATE mid-session — TRUNCATE is the idle-flush/cap
   * path's job). Re-arms itself in `finally`.
   */
  private _performWalOwnershipHeartbeat(): void {
    try {
      if (this.closed || this._walReplaced || this._inFlightOps > 0 || this._walBaseline === null) {
        return;
      }
      const status = verifyWalIdentityNow(this._walBaseline);
      if (status.status === 'replaced') {
        this._recoverReplacedWal('heartbeat', status.finding);
      } else if (status.status === 'intact') {
        this.db.pragma('wal_checkpoint(PASSIVE)');
      }
      // no-baseline: nothing to compare against — no-op.
    } catch (err) {
      log.warn('store_adapter.sqlite.wal_ownership_heartbeat_failed', {
        db_path: this.config.dbPath,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this._armWalOwnershipHeartbeat();
    }
  }

  /**
   * (BUG-026) Fold the orphaned frames of a replaced WAL into the main db file
   * through the fd this connection already holds (PASSIVE), emit
   * damaged/repaired, and set `_walReplaced` so every subsequent writable op
   * fails loud (`EStoreWalReplaced`) rather than silently writing into an
   * orphaned inode.
   */
  private _recoverReplacedWal(
    trigger: 'write' | 'heartbeat',
    finding: import('./integrity.js').IntegrityFinding | null,
  ): void {
    const dbPath = this.config.dbPath;
    emitIntegrityReport(dbPath, 'damaged', describeWalReplaced(finding));
    let folded = false;
    try {
      this.db.pragma('wal_checkpoint(PASSIVE)');
      folded = true;
    } catch (err) {
      log.warn('store_adapter.sqlite.wal_replaced_checkpoint_failed', {
        db_path: dbPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (folded) {
      emitIntegrityReport(
        dbPath,
        'repaired',
        'checkpointed the orphaned WAL into the main database file',
      );
    }
    this._walReplaced = true;
    logWalReplacedObserved('store_adapter.sqlite', dbPath, trigger);
  }

  /**
   * Runs synchronously INSIDE the write path — called from `_trackOp(fn,
   * true)` after a writable operation succeeds. This is the sustained-load
   * backstop: it cannot be starved by continuous traffic the way the
   * debounced idle timer can, because it runs after EVERY writable op. Same
   * ungated `TRUNCATE` as the idle path (see the design note above the class
   * — no writer-exclusive-lock contention is possible against a single
   * in-process connection, so there is no reason to prefer PASSIVE here the
   * way `TursoAdapterImpl` must for its multiprocess topology). Never
   * throws — a failed forced-flush must not fail the write that already
   * succeeded.
   */
  /** (BL-587) The effective wal-cap threshold — see
   *  `TursoAdapterImpl._effectiveWalCapBytes()` / `effectiveWalCapBytes()`
   *  (wal-tuning.ts) for the precedence. */
  private _effectiveWalCapBytes(): number {
    return effectiveWalCapBytes({
      explicitOverrideBytes: this._walCapExplicitBytes,
      baselineBytes: this._walCapBaselineBytes,
      headroomBytes: this._walCapHeadroomBytes,
      ceilingBytes: this._walCapCeilingBytes,
    });
  }

  /**
   * (BL-587) Capture the store's CURRENT `-wal` byte size as the wal-cap
   * baseline. See `TursoAdapter.captureWalCapBaseline()`'s doc comment
   * (types.ts) for the full rationale — identical on this adapter. Callers
   * should invoke this once, right after finishing their own schema DDL.
   * Idempotent; safe to re-call. Returns the captured value.
   */
  captureWalCapBaseline(): number {
    const dbPath = this.config.dbPath;
    let size = 0;
    if (dbPath !== undefined) {
      try {
        size = statSync(`${dbPath}-wal`).size;
      } catch {
        size = 0;
      }
    }
    this._walCapBaselineBytes = size;
    log.debug('store_adapter.sqlite.wal_cap_baseline_captured', {
      db_path: dbPath ?? null,
      baseline_bytes: size,
      headroom_bytes: this._walCapHeadroomBytes,
      effective_cap_bytes: this._effectiveWalCapBytes(),
    });
    return size;
  }

  private _checkWalCapAndFlush(): void {
    if (!this._capFlushEnabled) return;
    const dbPath = this.config.dbPath;
    if (dbPath === undefined) return;
    let size: number;
    try {
      size = statSync(`${dbPath}-wal`).size;
    } catch {
      // No -wal file yet (nothing written since the last full checkpoint), or
      // a transient stat race with a concurrent checkpoint — either way
      // there is nothing to cap right now.
      return;
    }
    const capBytes = this._effectiveWalCapBytes();
    if (size < capBytes) return;
    try {
      const rows = this.db.pragma('wal_checkpoint(TRUNCATE)') as
        | Array<{ busy?: number; log?: number; checkpointed?: number }>
        | undefined;
      const row = rows?.[0];
      if (row?.busy === 1) {
        log.warn('store_adapter.sqlite.wal_cap_flush_busy', {
          db_path: dbPath,
          wal_bytes_at_trip: size,
          cap_bytes: capBytes,
        });
      } else {
        log.debug('store_adapter.sqlite.wal_cap_flush', {
          db_path: dbPath,
          wal_bytes_at_trip: size,
          cap_bytes: capBytes,
          frames_checkpointed: row?.checkpointed ?? null,
        });
      }
    } catch (err) {
      log.error('store_adapter.sqlite.wal_cap_flush_failed', {
        db_path: dbPath,
        wal_bytes_at_trip: size,
        cap_bytes: capBytes,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Tracks in-flight ops for the idle-flush/cap-flush coordination — mirrors
   *  `TursoAdapterImpl._trackOp`. Cancels any pending idle timer on entry,
   *  runs the cap check inline after a successful write (before the op's
   *  caller gets control back), and re-arms the idle timer once the
   *  connection returns to idle. */
  private async _trackOp<T>(fn: () => T | Promise<T>, isWrite = false): Promise<T> {
    this._cancelIdleFlush();
    this._inFlightOps++;
    try {
      // (BUG-026) Fail loud on the first write AFTER a replaced WAL was
      // observed — the orphaned frames were folded, but the connection's
      // baseline is now stale, so writing again risks a second silent-loss
      // window. Reads keep working.
      if (isWrite && this._walReplaced) {
        throw new EStoreWalReplaced(this.config.dbPath);
      }
      const result = await fn();
      if (isWrite) {
        // (BL-590) Feed the observed inter-write gap into the EWMA before
        // the cap check — see `TursoAdapterImpl._trackOp()` for why.
        const now = Date.now();
        if (this._lastWriteAt !== null) {
          this._writeIntervalEwmaMs = updateWriteIntervalEwma(
            this._writeIntervalEwmaMs,
            now - this._lastWriteAt,
          );
        }
        this._lastWriteAt = now;
        // (BUG-026) Lifetime WAL-identity check on EVERY write — a replaced
        // WAL is folded + marked fail-loud here, not only at close.
        const status = verifyWalIdentityNow(this._walBaseline);
        if (status.status === 'replaced') {
          this._recoverReplacedWal('write', status.finding);
        }
        this._checkWalCapAndFlush();
      }
      return result;
    } finally {
      this._inFlightOps--;
      if (this._inFlightOps === 0) this._armIdleFlush();
    }
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
    return this._trackOp(() => {
      const stmt = this.cache.get(sql, this.db);
      const row = args !== undefined ? stmt.get(...args) : stmt.get();
      return (row as T | null) ?? null;
    });
  }

  async executeAll<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<AllResult<T>> {
    return this._trackOp(() => {
      const stmt = this.cache.get(sql, this.db);
      const rows = args !== undefined ? stmt.all(...args) : stmt.all();
      const columns = stmt.columns().map((c) => c.name);
      return { columns, rows: rows as T[] };
    });
  }

  async executeRun(sql: string, args?: unknown[]): Promise<RunResult> {
    return this._trackOp(() => {
      const stmt = this.cache.get(sql, this.db);
      const info = args !== undefined ? stmt.run(...args) : stmt.run();
      return { rowsAffected: info.changes, lastInsertRowid: info.lastInsertRowid };
    }, true);
  }

  async exec(sql: string): Promise<void> {
    return this._trackOp(() => {
      this.db.exec(sql);
    }, true);
  }

  async pragmaSet(key: string, value: string | number | boolean): Promise<void> {
    return this._trackOp(() => {
      const boolVal = typeof value === 'boolean' ? (value ? 1 : 0) : value;
      this.db.pragma(`${key} = ${boolVal}`);
    });
  }

  async pragmaGet<T = unknown>(key: string): Promise<T> {
    return this._trackOp(() => {
      const result = this.db.pragma(key, { simple: true });
      return result as T;
    });
  }

  async transaction<T>(
    fn: (tx: AdapterTransaction) => T | Promise<T>,
    opts?: TransactionOptions,
  ): Promise<T> {
    // (BL-571) The whole BEGIN…COMMIT/ROLLBACK window — including retries —
    // is one tracked op, mirroring `TursoAdapterImpl.transaction()`: the cap
    // check must not run mid-transaction, and the idle timer must not arm
    // until the transaction (successful or not) has fully settled.
    return this._trackOp(() => this._runTransaction(fn, opts), true);
  }

  private async _runTransaction<T>(
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
    // (BL-571) Cancel any pending idle-flush timer — the connection is about
    // to be closed (or handed back to a caller-owned lifecycle), so a timer
    // firing afterward would checkpoint a closed/foreign handle.
    this._cancelIdleFlush();
    // (BUG-026) Cancel the WAL-ownership heartbeat too.
    this._cancelWalOwnershipHeartbeat();
    if (!this.config.readonly && this.ownDb) {
      // (BUG-026) Close-time WAL-identity check + PASSIVE fold — the parity
      // gap with `TursoAdapterImpl.close()`. A replaced WAL must be folded
      // (PASSIVE) and reported, never silently discarded. Runs BEFORE the
      // TRUNCATE below so the orphaned frames land in the main db file first.
      let damaged = false;
      const status = verifyWalIdentityNow(this._walBaseline);
      if (status.status === 'replaced') {
        damaged = true;
        emitIntegrityReport(this.config.dbPath, 'damaged', describeWalReplaced(status.finding));
      }
      let passiveOk = false;
      try {
        this.db.pragma('wal_checkpoint(PASSIVE)');
        passiveOk = true;
      } catch (passiveErr) {
        log.warn('store_adapter.sqlite.close_passive_checkpoint_failed', {
          db_path: this.config.dbPath,
          error: passiveErr instanceof Error ? passiveErr.message : String(passiveErr),
        });
      }
      if (damaged && passiveOk) {
        emitIntegrityReport(
          this.config.dbPath,
          'repaired',
          'checkpointed the orphaned WAL into the main database file before close',
        );
      }

      // (BL-571) Final checkpoint before teardown — best-effort. The
      // idle-flush/cap-flush triggers already keep the WAL bounded through
      // the connection's life; this folds back whatever is left in flight at
      // close time rather than leaving it in the `-wal` sidecar for the next
      // open to find. Never throws — a failed final checkpoint must not
      // prevent the rest of close() (marker stamp, driver close) from
      // running.
      try {
        this.db.pragma('wal_checkpoint(TRUNCATE)');
      } catch (err) {
        log.warn('store_adapter.sqlite.close_checkpoint_failed', {
          db_path: this.config.dbPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await markCleanShutdown(this);
    }
    this.cache.clear();
    if (this.ownDb) {
      this.db.close();
    }
  }
}
