import { existsSync, renameSync, statSync } from 'node:fs';
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
  isTshmContentDead,
  proactivelyReconcileStaleSidecar,
  probeWalFrames,
  recoverStaleWalIndex,
  runOpenTimeIntegrity,
  summarizeBackupIntegrity,
  verifyStoreIntegrity,
  warnIfStaleSidecar,
} from './integrity.js';
import type { BackupIntegrityReport, WalIdentity } from './integrity.js';
import { maybePruneStaleTshmSidecars } from './sidecar-retention.js';
import { acquireStoreLease, storeQuiescence, type StoreLease } from './store-lease.js';
import { canonicalDbPath } from './path-identity.js';
import {
  clearStoreOpenMarker,
  describePreflight,
  hasUncleanShutdown,
  markStoreOpen,
  preflightSchemaSanity,
  sweepDeadOpenMarkers,
} from './preflight.js';
import {
  describeFtsOrphanGuard,
  guardOrphanedFtsIndexes,
  guardSucceeded,
} from './fts-orphan-guard.js';
import {
  isAlreadyOpenWithoutMultiprocessWal,
  isTshmCoordinationInitRace,
  isFatalConnectionError,
  RepairDeclinedLivePeersError,
} from './errors.js';
import { ESqliteNativeStore, isBusyError } from './errors.js';
import { ensureEngineMarker, readApplicationId, SOX_APP_ID_SQLITE } from './engine-guard.js';
import {
  assertValidConcurrencyMode,
  resolveConcurrencyMode,
  verifyMultiprocessWalSidecar,
  EWalModeUnverified,
} from './concurrency-mode.js';
import type { StoreConcurrencyMode } from './concurrency-mode.js';
import {
  EForeignSqliteSidecar,
  describeWalReplaced,
  logWalReplacedObserved,
  reconcileForeignSqliteShm,
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
import { log } from '@adhd/sox-telemetry';
import {
  ensureFtsIndex as ensureFtsIndexOn,
  ftsCount as ftsCountOn,
  ftsSearch as ftsSearchOn,
} from './fts-ops.js';
import type {
  TursoAdapter,
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

// ── TursoTransaction (internal) ──────────────────────────────────────────────

/** (BL-512) Bounded busy timeout (ms) applied to EVERY driver connect — maps
 *  to sqlite3_busy_timeout. Empirically REQUIRED for concurrent multiprocess
 *  writers: with the driver default (0) a connect/first-statement landing in
 *  another process's close()-TRUNCATE window fails instantly with "database is
 *  locked" and the write is lost (measured 2026-08-12, see connect()). Never
 *  a toggle — a store opened concurrently must wait out transient locks. */
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/** (BL-512 follow-on) Bounded connect-level retry budget for the driver's own
 *  open-handshake race. 3 total attempts (1 initial + 2 retries) matches
 *  ADR-0012 §4's retry ceiling — the same 3 `_runTransaction`'s
 *  `maxRetries=3` default and the write-queue bypass's
 *  `BYPASS_MAX_ATTEMPTS=3` use, so every independent retry loop in the write
 *  path shares one bound. A still-matching failure after this budget is
 *  surfaced with `retryable: true`; the CALLER decides beyond it (§4). */
const OPEN_RETRY_MAX_ATTEMPTS = 3;

/** (BL-512 follow-on) Linear backoff between open-handshake retries: 100ms
 *  after the first failure, 200ms after the second. Seeded from a constant —
 *  deliberately NOT `retry_after_ms` (the write-queue's E_BUSY hint): no I/O
 *  is involved in this race, the other opener releases within a few scheduler
 *  quanta, and a multi-hundred-ms wait between connect attempts would only
 *  stretch every concurrent writer's open time under maximal contention. */
const OPEN_RETRY_BACKOFF_START_MS = 100;
const OPEN_RETRY_BACKOFF_STEP_MS = 100;

/** (idle-flush, 2026-08-17 — store-adapter-owned WAL durability) FLOOR of the
 *  debounce window for the adapter's own idle WAL flush. Deliberately equal
 *  to `WriteQueue.CHECKPOINT_IDLE_MS` (libs/memory-core/src/write-queue.ts)
 *  so every consumer — queued or talking to the adapter directly — settles
 *  on one idle-cadence floor, not two competing ones. Overridable
 *  per-connect via `opts.idleFlushMs` (tests only; no production caller sets
 *  this) — an explicit `opts.idleFlushMs` is a fixed window, bypassing the
 *  BL-590 adaptive computation below entirely (same "explicit override wins"
 *  posture as `opts.walCapBytes`, see `DEFAULT_WAL_CAP_HEADROOM_BYTES`).
 *
 * (BL-590, 2026-08-18) THIS CONSTANT ALONE NO LONGER SETS THE ARMED WINDOW.
 * Measured live: the dominant writers on this store are ASYNC VECTOR WRITES
 * from the embed pipeline, cadence `time_to_vector_ms` p50 4516ms — against
 * a flat 2000ms debounce, a write arriving every ~4.5s is NEVER coalesced
 * with its neighbour (measured coalescing ratio 12 writes / 11 flushes =
 * 1.09, i.e. one full GATED close+reopen cycle per write). `_armIdleFlush()`
 * now computes the ACTUAL armed window via `effectiveIdleFlushMs()`
 * (wal-tuning.ts): an EWMA of observed inter-write gaps
 * (`updateWriteIntervalEwma()`, recorded once per write in `_trackOp`),
 * margined up (`IDLE_FLUSH_MARGIN_FACTOR`) so a steady cadence coalesces
 * instead of each write paying its own flush, clamped between this constant
 * (the floor — an idle store with no write history still flushes promptly)
 * and `DEFAULT_IDLE_FLUSH_CEILING_MS` (a pathological cadence cannot defer
 * flushing forever). The chosen window is logged on every
 * `store_adapter.turso.idle_flush*` event (`idle_window_ms`) so the tuning
 * is verifiable from telemetry, not inferred. */
const DEFAULT_IDLE_FLUSH_MS = DEFAULT_IDLE_FLUSH_FLOOR_MS;

/**
 * (wal-cap, 2026-08-18 — owner directive: "constraints around the maximum
 * size / frames of the wal before it interjects between future writes")
 *
 * Idle-triggering alone has no answer for SUSTAINED write load: a queue that
 * never drains cancels-and-rearms the idle timer forever, so the flush never
 * runs — the WAL grows without bound for exactly the traffic pattern that
 * grows it fastest. This is a second, independent trigger that FORCES a
 * flush by checking WAL size after every writable operation
 * (`executeRun`/`exec`/`transaction`, see `_trackOp(fn, true)`), not on a
 * timer — so it cannot be starved by continuous work the way a debounced
 * timer can.
 *
 * BYTES, not frames: `fs.statSync(dbPath + '-wal').size` is a single
 * syscall already used by `WriteQueue.walBytes()`
 * (libs/memory-core/src/write-queue.ts) — checking frame count would need an
 * extra pragma round-trip on every write, which defeats the point of a cheap
 * per-write check.
 *
 * Threshold measured, not guessed, against the reference points from the
 * live incident this traces to:
 *  - pathological live WAL reached 539,752 bytes before the fix that
 *    prompted this whole effort.
 *  - a clean-shutdown stamp frame is ~4,152 bytes (the steady-state noise
 *    floor — must never trip the cap on its own).
 *  - observed steady-state after a truncation is 0 bytes.
 *
 * 262,144 bytes (256 KiB) sits at ~63x the noise floor (never fires on
 * routine stamp-only activity) and at ~49% of the pathological figure —
 * bounding worst-case growth to roughly HALF of what was observed live, with
 * headroom: because the check runs after EVERY write (not periodically),
 * the actual worst-case overshoot past the cap before the backstop catches
 * it is at most one write's own frames, not another whole cap-multiple.
 *
 * PASSIVE, not TRUNCATE, and UNGATED (no `storeQuiescence()` check) —
 * deliberately independent of `_walFlushStrategy`, which governs the IDLE
 * path only. Under sustained load, peers are BY DEFINITION active, so a
 * gated TRUNCATE cap would defer exactly when most needed — the same
 * failure mode the idle path already had to solve, but worse here because
 * there is no quiet period to eventually catch up in. PASSIVE sidesteps the
 * question entirely: it copies WAL frames into the main db file without
 * requiring the writer-exclusive lock TRUNCATE needs (already the basis for
 * `close()`'s own unconditional-PASSIVE-then-gated-TRUNCATE pairing, see
 * `close()` below — this generalizes that proven shape into the write path
 * rather than inventing a new one). Verified empirically (not just from
 * docs), 2026-08-18: a script issuing `PRAGMA wal_checkpoint(PASSIVE)` from
 * a second connection while ~300 sequential inserts ran on a first,
 * interleaved every 50/100 writes, returned `busy:0` and completed in 0ms
 * every time, with the on-disk `-wal` size measurably bounded/reset rather
 * than growing monotonically (243,112 -> 486,192 -> 473,832 -> 238,992 bytes
 * across the run) — PASSIVE achieves real durability+bounding without
 * exclusivity under multiprocess_wal in this topology.
 *
 * (BUG-019, 2026-08-18) CORRECTION to the paragraph above: "PASSIVE ...
 * stays safe exactly when peers are most likely to be active" is true for
 * the writer-exclusive-LOCK half of the claim (PASSIVE genuinely never
 * blocks another writer the way TRUNCATE would) but was overstated as
 * "safe" full stop. The sequential-inserts-from-a-second-connection probe
 * that produced the numbers above never exercised the failure mode that
 * hit production: under GENUINE sustained concurrent write load, PASSIVE
 * can still THROW — reproduced live as six consecutive
 * `error="step failed: Runtime error: database table is locked"` in
 * ~130ms — instead of degrading to the graceful `busy:1` result row this
 * file's own busy-branch comment already anticipated ("PASSIVE can still
 * degrade to busy if even a passive checkpoint attempt collides with the
 * engine's own internal checkpoint lock", `_checkWalCapAndFlush()` below).
 * Durability still holds either way (a thrown checkpoint touches nothing;
 * nothing already in the WAL is lost, and the next write's cap check
 * retries), so PASSIVE remains the right call over a gated TRUNCATE — but
 * "stays safe" should be read as "never blocks a peer and never loses a
 * frame," not "never throws." See `_checkWalCapAndFlush()`'s catch branch
 * for how the thrown case is now classified using the SAME busy/lock
 * message marker `isBusyError()` (errors.ts) already recognizes.
 *
 * The native `PRAGMA wal_autocheckpoint` was checked FIRST, per the
 * directive to prefer configuring an in-engine backstop over hand-rolling
 * one — and rejected on direct measurement, not assumption: the current
 * `@tursodatabase/database` driver does not honor it at all. A probe script
 * set `wal_autocheckpoint = 10` (10 pages, an aggressive threshold) and
 * inserted 500 rows; the WAL grew unbounded to 2,401,992 bytes with zero
 * auto-checkpoints ever firing, and reading the pragma back after setting it
 * returned `[]` (unset/unrecognized) rather than echoing the value. There is
 * no native backstop available to configure; this hand-rolled one is
 * required.
 *
 * (BL-587, 2026-08-18) THIS CONSTANT IS NO LONGER THE EFFECTIVE CAP BY
 * ITSELF. It was measured to mean something materially different on the two
 * adapters that share it: `SqliteAdapterImpl`'s post-schema WAL baseline for
 * memory-core's real schema is ~150-165 KB (FTS5 alone roughly doubles a
 * trivial-schema baseline, 16,512 -> 32,992 bytes, measured directly), far
 * above `TursoAdapterImpl`'s baseline for the identical schema — so sqlite
 * had roughly 100 KB of real headroom against this flat number while turso
 * had roughly 245 KB, an asymmetry nobody chose. This constant is now the
 * HEADROOM budget (`DEFAULT_WAL_CAP_HEADROOM_BYTES`, wal-tuning.ts), and the
 * effective cap `_checkWalCapAndFlush()` actually enforces is
 * `baseline + headroom` (via `effectiveWalCapBytes()`), clamped to
 * `DEFAULT_WAL_CAP_CEILING_BYTES`. The baseline defaults to 0 (identical
 * behaviour to before) until a caller invokes the new
 * `captureWalCapBaseline()` — ideally right after finishing its own schema
 * DDL, since the adapter itself has no way to know when a caller's schema
 * creation is done (data→data-only boundary — this package cannot reach
 * upward to ask). `opts.walCapBytes` remains a full explicit override for
 * tests, bypassing baseline-relative computation entirely — see
 * `effectiveWalCapBytes()`'s doc comment.
 */
const DEFAULT_WAL_CAP_BYTES = DEFAULT_WAL_CAP_HEADROOM_BYTES;

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

/** (DEBT-003, lazy-connect) Placeholder assigned to `TursoAdapterImpl.db`
 *  for an instance that has never performed a real driver open
 *  (`_neverOpened === true`). Every direct `this.db.*` call site in
 *  `TursoAdapterImpl` runs downstream of `_ensureHealthy()` (via `_trackOp`
 *  or, for `_runTransaction`, an explicit call) — which transparently opens
 *  the real connection before any of these methods can be reached — EXCEPT
 *  `close()`, which short-circuits before ever touching `this.db` while
 *  `_neverOpened` is still true. So these throw only if some future call
 *  site bypasses `_ensureHealthy()`; the message says so plainly rather than
 *  surfacing an obscure "x is not a function" from a stub. */
function createNeverOpenedDb(): {
  run: Function;
  get: Function;
  all: Function;
  exec: Function;
  close: Function;
  pragma: Function;
} {
  const fail = (method: string) => (): never => {
    throw new Error(
      `[DEBT-003] TursoAdapterImpl.db.${method}() invoked on a never-opened instance without going ` +
        `through _ensureHealthy() first — this is an adapter bug (a new direct this.db.* call site ` +
        `that bypasses _trackOp()/_ensureHealthy()), not a caller error.`,
    );
  };
  return {
    run: fail('run'),
    get: fail('get'),
    all: fail('all'),
    exec: fail('exec'),
    close: fail('close'),
    pragma: fail('pragma'),
  };
}

// ── TursoAdapterImpl ─────────────────────────────────────────────────────────

export class TursoAdapterImpl implements TursoAdapter {
  readonly config: Readonly<AdapterConfig & { type: 'turso' }>;

  /** (DEBT-003, lazy-connect) Backing field for the public `capabilities`
   *  getter. A field, not the interface's plain `readonly` property, ONLY
   *  because `connect()` now returns an instance before `recursiveCte` has
   *  ever been probed (that probe issues a real query — see `_openReal()` —
   *  and cannot run until a connection exists). `connect()` seeds this with
   *  a conservative `recursiveCte: false` guess; `_reconnect()` overwrites it
   *  with the real probed value the FIRST time this instance actually opens
   *  (never-opened → real), and is a harmless no-op resync on every
   *  subsequent poison/release reconnect (the value cannot change for a
   *  given store). Every other field is a static, unconditional constant
   *  (see `_openReal()`) and never varies. */
  private _capabilities: AdapterCapabilities;

  get capabilities(): Readonly<AdapterCapabilities> {
    return this._capabilities;
  }

  private db: {
    run: Function;
    get: Function;
    all: Function;
    exec: Function;
    close: Function;
    pragma: Function;
  };
  private closed = false;

  /** (SPEC-CONN-RECYCLE) The exact `opts` argument `connect()` received —
   *  frozen, captured verbatim (never reconstructed field-by-field from
   *  `this.config`, which drops `allowFtsInReadonly`). Replayed into a fresh
   *  `TursoAdapterImpl.connect()` call by `_reconnect()` so a reconnect gets
   *  the full BL-361/BL-461/BL-352 open-time ceremony for free. */
  private _connectOpts!: Parameters<typeof TursoAdapterImpl.connect>[0];

  /** (SPEC-CONN-RECYCLE) True once a fatal driver fault (see
   *  `isFatalConnectionError`) has been observed on `this.db` and no
   *  reconnect has completed since. Set by `_markIfFatal`, cleared by a
   *  successful `_reconnect()`. */
  private _poisoned = false;

  /** (SPEC-CONN-RECYCLE) Single in-flight reconnect shared by every caller
   *  that observes `_poisoned` — same shape as `_txMutexChain` above
   *  (BL-321 precedent: one shared promise guarding one shared resource).
   *  Cleared on both success and failure so the next call after a failed
   *  reconnect gets a fresh attempt rather than being permanently stuck on
   *  one rejected promise. */
  private _reconnectPromise: Promise<void> | null = null;

  /** (idle-release, 2026-08-17 — store-connection-lifetime design) True once
   *  `releaseIdleConnection()` has voluntarily torn this connection down
   *  (full `close()` ceremony: checkpoint, quiescence-gated TRUNCATE, driver
   *  close, marker clear, lease release) WITHOUT setting `closed = true` —
   *  the adapter instance stays usable and `_ensureHealthy()` transparently
   *  reconnects it on the next call, same shared-promise machinery as
   *  `_poisoned`. Distinguished from `_poisoned`: a poisoned connection died
   *  unexpectedly (a driver fault); a released one was torn down on purpose,
   *  specifically to drop this connection's lease entry and let ANOTHER
   *  connection's close()-time TRUNCATE find a genuinely quiescent store
   *  (the 1,409 `close_checkpoint_busy` incident, 2026-08-12..17). See
   *  `_reconnect()` for how the two cases differ in lease handling. */
  private _released = false;

  /** (DEBT-003, lazy-connect, 2026-08-17 — owner directive: "Consumers of
   *  store adapter should not have to think about connect / disconnect,
   *  that should be automatic under the hood") True from construction until
   *  the FIRST real driver open completes; set only by `connect()` and
   *  cleared only by a successful `_reconnect()`. Distinguished from
   *  `_released` (this instance HAD a lease and gave it back) and
   *  `_poisoned` (a live connection died): a never-opened instance never had
   *  a driver connection, a lease, an idle-flush arm, or a WAL baseline at
   *  all — there is nothing to recover from, only a first open to perform.
   *  Deliberately reuses the SAME `_ensureHealthy()`/`_reconnect()` recovery
   *  path `_released`/`_poisoned` already use (see `_ensureHealthy()` and
   *  `_reconnect()`) rather than a second reopen branch — the owner's own
   *  design directive for this feature. `this.db` holds a sentinel object
   *  (`NEVER_OPENED_DB`) while this is true; every direct `this.db.*` call
   *  site in this class runs downstream of `_ensureHealthy()`/`_trackOp()`
   *  EXCEPT `close()`, which short-circuits before ever touching `this.db`
   *  when this is still true (see `close()`) — closing an adapter that was
   *  constructed and discarded without ever being used must not pay for an
   *  open only to immediately tear it down. */
  private _neverOpened = false;

  /** (idle-release) Count of operations currently executing against this
   *  connection — incremented SYNCHRONOUSLY at the top of `_trackOp` (before
   *  any `await`), so a burst of calls issued in the same tick is never
   *  transiently invisible to `releaseIdleConnection()`'s busy check (the
   *  "pendingCount trap": a counter incremented only after an await reads 0
   *  for everything issued in the same tick). `releaseIdleConnection()`
   *  refuses to run while this is non-zero — never releases mid-operation,
   *  including mid-transaction (the whole `transaction()` call is one
   *  tracked op, not just its `BEGIN`). */
  private _inFlightOps = 0;

  /** (idle-flush) True when this instance is eligible to self-arm the idle
   *  WAL flush — set by `connect()` for writable, local-file (`dbPath`)
   *  connections only. Remote URLs and readonly/soft-readonly connections
   *  never arm: a readonly connection cannot checkpoint, and a remote store
   *  has no local lease/quiescence semantics to gate on. Constant for the
   *  life of the instance (sourced once from `connect()` opts, same as
   *  `_idleFlushMs`/`_walFlushStrategy`). */
  private _idleFlushEnabled = false;

  /** (idle-flush) FLOOR of the debounce window in ms — see
   *  `DEFAULT_IDLE_FLUSH_MS`. When `opts.idleFlushMs` was explicitly
   *  supplied this is a FIXED window (`_idleFlushExplicitMs` non-null);
   *  otherwise it is the floor `effectiveIdleFlushMs()` (BL-590) clamps
   *  against. */
  private _idleFlushMs: number = DEFAULT_IDLE_FLUSH_MS;

  /** (BL-590) Ceiling of the adaptive debounce window in ms — see
   *  `DEFAULT_IDLE_FLUSH_CEILING_MS`. Overridable via
   *  `opts.idleFlushCeilingMs` (tests only). */
  private _idleFlushCeilingMs: number = DEFAULT_IDLE_FLUSH_CEILING_MS;

  /** (BL-590) Non-null when `opts.idleFlushMs` was explicitly supplied at
   *  connect — an explicit window is a FIXED value, bypassing adaptive
   *  computation entirely (same "explicit override wins" posture as
   *  `_walCapExplicitBytes`). */
  private _idleFlushExplicitMs: number | null = null;

  /** (BL-590) EWMA of the observed gap (ms) between successive WRITE ops on
   *  this connection — the signal `effectiveIdleFlushMs()` adapts the
   *  debounce window to. `null` until at least one write has completed
   *  (a freshly opened instance has no cadence to adapt to yet, so the next
   *  arm uses the floor). Updated once per write in `_trackOp`, via
   *  `updateWriteIntervalEwma()` (wal-tuning.ts). */
  private _writeIntervalEwmaMs: number | null = null;

  /** (BL-590) Wall-clock time (`Date.now()`) of the most recently completed
   *  write op, or `null` before the first one. Paired with
   *  `_writeIntervalEwmaMs` to compute the gap for the NEXT write. */
  private _lastWriteAt: number | null = null;

  /** (BL-590) The window actually armed by the most recent `_armIdleFlush()`
   *  call — surfaced on every `idle_flush*` telemetry event
   *  (`idle_window_ms`) so the adaptive tuning is verifiable from logs, not
   *  inferred. `null` before the first arm. */
  private _lastArmedIdleFlushMs: number | null = null;

  /**
   * (idle-flush) ONE decision point for gated-vs-ungated, per owner
   * directive (2026-08-17): "structure the flush so gated-vs-ungated is one
   * decision point — a strategy/flag, not a design assumption threaded
   * through the implementation."
   *
   * - `'gated'` (DEFAULT): the idle flush calls `releaseIdleConnection()`,
   *   which runs the FULL `close()` ceremony — PASSIVE checkpoint always,
   *   then `wal_checkpoint(TRUNCATE)` gated on `storeQuiescence()` (no other
   *   live peer holding the store) — and leaves the instance usable; the
   *   next operation transparently reconnects. Safe under N concurrent
   *   multiprocess_wal peers because it never truncates while a peer is
   *   live, at the cost of TRUNCATE frequently deferring under sustained
   *   multi-process contention (1,409 deferrals/4 days measured live —
   *   `store_adapter.turso.close_checkpoint_busy`).
   * - `'ungated'`: issues `PRAGMA wal_checkpoint(TRUNCATE)` directly, with
   *   NO quiescence check and WITHOUT releasing the connection — the exact
   *   shape of `WriteQueue.walCheckpoint()` in memory-core, safe at
   *   concurrency 1, of UNKNOWN safety at higher concurrency.
   *
   * (2026-08-18 update) `wal-truncate-safety-experiment` reported back:
   * 1,180 concurrent-writer trials across 5 configs on 0.7.1/macOS arm64
   * (plain N=20; barrier-synced with an artificially-aged `-tshm` matching
   * #8348's documented deterministic precondition; the same plus
   * overflow-triggering payloads at N=8 matching the issue's own repro;
   * natural-spawn+overflow at N=20) produced ZERO SIGABRT and zero integrity
   * damage — but could NOT reproduce #8348's own 3/20 baseline at all, so
   * the configs that would have actually exercised the race never ran.
   * #8348's own deterministic repro runs through Turso's internal Rust
   * `multiprocess_tests` harness — a JS-binding-level harness structurally
   * cannot reach that timing granularity. This is "the harness cannot see
   * the failure," NOT "the failure is absent," and must not be read either
   * way. **GATED IS THEREFORE THE PERMANENT DEFAULT, not a placeholder
   * pending a result** — absent a reproduction, the conservative behavior
   * stays until upstream fixes the assert. No caller may select `'ungated'`
   * outside a test.
   *
   * This is NOT a compromise, and NOT "safe but never fires" traded against
   * "fires but unsafe" — the crux of this whole feature is that these are
   * not the only two options. The gate itself was never wrong; its
   * precondition (no concurrent connection holding the store) simply went
   * unsatisfied for 4 days straight in production because `serve` processes
   * held their lease for their entire multi-hour/day session. The idle-flush
   * feature's OTHER half — lazy connect + auto-release (`releaseIdleConnection()`,
   * `_armIdleFlush()`) — MANUFACTURES that precondition: an idle adapter now
   * voluntarily drops its lease, so quiescence becomes reachable, and the
   * SAME gated TRUNCATE that "never fired" fires exactly as designed, with
   * no change whatsoever to its safety posture. We are not choosing between
   * two flawed strategies; we are making the already-safe one able to run.
   */
  private _walFlushStrategy: 'gated' | 'ungated' = 'gated';

  /** (idle-flush) The pending idle-flush timer, or `null` when none is
   *  armed. At most one is ever live per instance — `_armIdleFlush()`
   *  refuses to schedule a second one while this is non-null, and every
   *  `_trackOp()` call cancels it the instant new work arrives. Same
   *  debounced-coalesced shape as `WriteQueue._checkpointTimer`
   *  (`_cancelCheckpoint()` on new work / `_scheduleIdleCheckpoint()` on
   *  drain), pushed down one layer so every consumer — not just
   *  memory-core's queue — inherits it automatically. */
  private _idleFlushTimer: ReturnType<typeof setTimeout> | null = null;

  /** (BUG-026) True when this instance is eligible to self-arm the
   *  WAL-ownership heartbeat — set by `connect()`/`_openReal()` for writable,
   *  local-file connections only (same eligibility as `_idleFlushEnabled`: a
   *  readonly connection cannot checkpoint, and a remote URL has no local
   *  sidecar to inspect). Constant for the life of the instance. */
  private _walOwnershipHeartbeatEnabled = false;

  /** (BUG-026) The heartbeat interval, ms — clamped [1000, 60000]. Resolved at
   *  connect time from `opts.walOwnershipHeartbeatMs` / the
   *  `SOX_WAL_OWNERSHIP_HEARTBEAT_MS` env knob (see wal-ownership.ts). Typed
   *  tuning, never a toggle. */
  private _walOwnershipHeartbeatMs: number = WAL_OWNERSHIP_HEARTBEAT_DEFAULT_MS;

  /** (BUG-026) The pending WAL-ownership heartbeat timer, or `null` when none
   *  is armed. Self-re-arming: each fire re-arms for the next period unless
   *  the instance is closed/released. `unref()`'d so a pending timer never by
   *  itself keeps an otherwise-finished process alive. */
  private _walOwnershipHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;

  /** (BUG-026) Cancel a pending WAL-ownership heartbeat. */
  private _cancelWalOwnershipHeartbeat(): void {
    if (this._walOwnershipHeartbeatTimer !== null) {
      clearTimeout(this._walOwnershipHeartbeatTimer);
      this._walOwnershipHeartbeatTimer = null;
    }
  }

  /** (idle-flush) Cancel a pending idle flush — new work arrived. Mirrors
   *  `WriteQueue._cancelCheckpoint()`. */
  private _cancelIdleFlush(): void {
    if (this._idleFlushTimer !== null) {
      clearTimeout(this._idleFlushTimer);
      this._idleFlushTimer = null;
    }
  }

  /** (idle-flush) Arm the idle flush if this instance is idle-flush-eligible
   *  and currently idle (`_inFlightOps === 0`), not closed, not released,
   *  and nothing is already scheduled. Mirrors
   *  `WriteQueue._scheduleIdleCheckpoint()`. Called from `_trackOp()`'s
   *  `finally` whenever an operation completion leaves the connection idle,
   *  and once at the end of `connect()` for a freshly opened, otherwise-idle
   *  instance (which never runs a `_trackOp()` cycle on its own). */
  private _armIdleFlush(): void {
    if (!this._idleFlushEnabled) return;
    if (this.closed || this._released) return;
    if (this._inFlightOps > 0) return;
    if (this._idleFlushTimer !== null) return; // already scheduled — coalesced
    // (BL-590) Adaptive window: an explicit `opts.idleFlushMs` is a fixed
    // value (bypasses adaptation entirely, same posture as the wal-cap
    // explicit override); otherwise the window tracks the observed
    // inter-write cadence, clamped [floor, ceiling]. See
    // `effectiveIdleFlushMs()` (wal-tuning.ts).
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
      void this._performIdleFlush();
    }, windowMs);
  }

  /**
   * (idle-flush) Fires once per idle period. THIS is the primary WAL
   * durability assurance (owner directive, 2026-08-17) — not `close()`, not
   * a caller remembering to call anything. See `_walFlushStrategy` for the
   * gated/ungated decision point.
   *
   * Defensively re-checks `closed`/`released`/`_inFlightOps` even though
   * `_armIdleFlush()` already gated on them at schedule time — the debounce
   * window is real wall-clock time in which new work (or a close, or a
   * release) can land between "timer armed" and "timer fires".
   */
  private async _performIdleFlush(): Promise<void> {
    if (this.closed || this._released || this._inFlightOps > 0) return;
    // (BL-589) Observability parity with the wal-cap backstop.
    //
    // This method is the PRIMARY durability mechanism, but until now it
    // emitted ONLY on failure, while `_checkWalCapAndFlush()` — the
    // last-resort backstop — emitted on success. The result was an inverted
    // picture in the traces: the only flush anyone could SEE was the
    // backstop, so a healthy store driven entirely by this debounce looked
    // like a store being rescued by its size cap. Measured on the backlog
    // CLI: one `wal_cap_flush` against fourteen writes, with no positive
    // evidence anywhere that the debounce ran at all.
    //
    // Silence is not evidence of absence, and a design cannot be verified
    // from an absence. Emit the WAL delta so the trace states plainly which
    // mechanism reclaimed the file.
    const flushPath = this.coordPath;
    const walBytes = (): number | null => {
      if (flushPath === undefined) return null;
      try {
        return statSync(flushPath + '-wal').size;
      } catch {
        return 0;
      }
    };
    const startedAt = Date.now();
    const before = walBytes();
    try {
      if (this._walFlushStrategy === 'gated') {
        // `releaseIdleConnection()` runs the FULL close() ceremony (PASSIVE
        // checkpoint always, quiescence-gated TRUNCATE, driver close, marker
        // clear, lease release) and leaves the instance usable — the next
        // operation transparently reconnects via the same
        // `_ensureHealthy()`/`_reconnect()` machinery SPEC-CONN-RECYCLE
        // already uses for poison recovery. Every durability guarantee
        // `close()` has applies unchanged here; this is deliberate reuse,
        // not a parallel reimplementation.
        await this.releaseIdleConnection();
      } else {
        // UNGATED — see `_walFlushStrategy` doc comment. No quiescence
        // check, connection stays open (deliberately does NOT go through
        // `releaseIdleConnection()`).
        //
        // (BUG-022, the graph item — "idle-flush ungated strategy self-perpetuates",
        // not a bug014-plan-local number) Deliberately calls `this.db.get(...)` directly instead of
        // the public `executeGet()` — `executeGet()` routes through
        // `_trackOp()`, whose `finally` unconditionally re-arms THIS SAME
        // idle-flush timer once `_inFlightOps` returns to 0. A checkpoint
        // issued through the tracked wrapper therefore re-arms its own timer
        // with zero new caller activity: a self-perpetuating flush loop that
        // never quiesces. GATED sidesteps the structurally identical hazard
        // in `close()` by setting `this.closed = true` BEFORE its own
        // `executeAll('PRAGMA wal_checkpoint...')` call, so `_armIdleFlush()`'s
        // `this.closed` guard refuses the re-arm; UNGATED deliberately keeps
        // the connection open (see comment above), so there is no equivalent
        // guard state to piggyback on here — bypass `_trackOp()` entirely
        // instead. Checkpoint semantics are unchanged (same PRAGMA, same
        // connection, same error handling/`_markIfFatal` parity with
        // `executeGet()`); only the re-arm side effect is removed.
        //
        // (DEBT-STOREADAPTER-UNGATED-FLUSH-LOSES-SELFHEAL) Bypassing
        // `_trackOp()` also bypasses the `_ensureHealthy()` it calls, which is
        // what transparently reconnects a `_poisoned`/`_released` connection.
        // Call it explicitly so a flush firing on a dead connection still
        // self-heals here rather than waiting for the next real caller op —
        // `_ensureHealthy()` does not arm the idle timer (only `_trackOp()`'s
        // `finally` does), so this restores the recovery without restoring the
        // re-arm loop.
        try {
          await this._ensureHealthy();
          await this.db.get('PRAGMA wal_checkpoint(TRUNCATE)');
        } catch (err) {
          this._markIfFatal(err);
          log.warn('store_adapter.turso.idle_flush_ungated_failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const after = walBytes();
      log.debug('store_adapter.turso.idle_flush', {
        db_path: flushPath ?? null,
        strategy: this._walFlushStrategy,
        wal_bytes_before: before,
        wal_bytes_after: after,
        reclaimed_bytes: before !== null && after !== null ? before - after : null,
        duration_ms: Date.now() - startedAt,
        // (BL-590) The window this specific flush was armed with — makes the
        // adaptive debounce verifiable from telemetry rather than inferred.
        idle_window_ms: this._lastArmedIdleFlushMs,
        write_interval_ewma_ms:
          this._writeIntervalEwmaMs !== null ? Math.round(this._writeIntervalEwmaMs) : null,
      });
    } catch (err) {
      log.error('store_adapter.turso.idle_flush_failed', {
        error: err instanceof Error ? err.message : String(err),
        idle_window_ms: this._lastArmedIdleFlushMs,
      });
    }
  }

  /** (wal-cap) True when this instance is eligible to run the forced
   *  size-capped flush — same eligibility as `_idleFlushEnabled` (writable,
   *  local-file connections only), set alongside it at the end of
   *  `connect()`. Independent field so the two triggers can be reasoned
   *  about, tested, and (in principle) disabled separately even though
   *  today they always travel together. */
  private _capFlushEnabled = false;

  /** (BL-587) Non-null when `opts.walCapBytes` was explicitly supplied at
   *  connect — a FIXED absolute cap, bypassing baseline-relative computation
   *  entirely (see `effectiveWalCapBytes()`). Used by
   *  `wal-cap-concurrency.bug019.spec.ts` and `wal-cap.spec.ts` to trip the
   *  backstop deterministically under a tiny controlled threshold. */
  private _walCapExplicitBytes: number | null = null;

  /** (BL-587) HEADROOM budget added on top of the captured baseline — see
   *  `DEFAULT_WAL_CAP_HEADROOM_BYTES`. Overridable via
   *  `opts.walCapHeadroomBytes` (tests only). */
  private _walCapHeadroomBytes: number = DEFAULT_WAL_CAP_BYTES;

  /** (BL-587) Absolute ceiling on the effective cap regardless of baseline —
   *  see `DEFAULT_WAL_CAP_CEILING_BYTES`. Overridable via
   *  `opts.walCapCeilingBytes` (tests only). */
  private _walCapCeilingBytes: number = DEFAULT_WAL_CAP_CEILING_BYTES;

  /** (BL-587) The captured post-schema WAL baseline, bytes. `0` (the
   *  default) until a caller invokes `captureWalCapBaseline()` — with no
   *  baseline captured, `effectiveWalCapBytes()` reduces to exactly
   *  `_walCapHeadroomBytes`, i.e. the pre-BL-587 flat-constant behaviour. */
  private _walCapBaselineBytes = 0;

  /**
   * (wal-cap) Runs synchronously INSIDE the write path — called from
   * `_trackOp(fn, true)` after a writable operation succeeds, before that
   * operation's caller gets control back. This is what makes it an actual
   * backstop rather than a second debounced timer with the same starvation
   * flaw as the idle path: under sustained writes, this check runs after
   * EVERY one of them, so it cannot be cancelled/starved by continuous
   * traffic the way `_armIdleFlush()`'s timer can. The cost is real and
   * intentional — the write that trips the cap pays the PASSIVE
   * checkpoint's latency inline (measured ~0ms per checkpoint in the
   * sequential-write probe this threshold was derived from; see
   * `DEFAULT_WAL_CAP_BYTES`'s doc comment).
   *
   * PASSIVE, unconditionally — no `storeQuiescence()` gate, independent of
   * `_walFlushStrategy` (which governs the idle path only). See
   * `DEFAULT_WAL_CAP_BYTES` for why: PASSIVE does not need TRUNCATE's
   * writer-exclusive lock, so it never BLOCKS a peer — the opposite of when
   * a gated TRUNCATE would work. (BUG-019) That is a claim about locking,
   * not about the checkpoint call never throwing: under genuine sustained
   * concurrent write load PASSIVE can still raise a busy/lock error instead
   * of the graceful `busy:1` result row below — see the catch branch.
   *
   * Never throws OUT of this method — a failed forced-flush must not fail
   * the write that already succeeded. Swallows and logs internally, same
   * posture as `_performIdleFlush()`. (BUG-019) The PASSIVE checkpoint
   * PRAGMA call itself CAN throw internally (see catch branch); this method
   * always catches it, classifies it, and returns normally either way.
   */
  /** (BL-587) The effective wal-cap threshold — see `effectiveWalCapBytes()`
   *  (wal-tuning.ts) for the precedence (explicit override > baseline +
   *  headroom, clamped to the ceiling). */
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
   * baseline. Callers should invoke this once, right after finishing their
   * own schema DDL (`CREATE TABLE`/`CREATE VIRTUAL TABLE ... USING fts5`/
   * etc.) — this package cannot know when that is done itself (data→data
   * boundary; the adapter has no visibility into a caller's schema), so it
   * is deliberately NOT called automatically anywhere in `connect()`.
   * Safe to call multiple times (idempotent re-capture — e.g. after a
   * migration that materially changes the schema's steady-state WAL
   * footprint); each call replaces the previous baseline. A no-op (baseline
   * stays `0`, i.e. today's flat-headroom behaviour) for callers that never
   * invoke it. Returns the captured value (0 if the `-wal` file does not
   * currently exist, e.g. immediately after a checkpoint) for the caller's
   * own logging/assertions.
   */
  captureWalCapBaseline(): number {
    const dbPath = this.coordPath;
    let size = 0;
    if (dbPath !== undefined) {
      try {
        size = statSync(dbPath + '-wal').size;
      } catch {
        size = 0;
      }
    }
    this._walCapBaselineBytes = size;
    log.debug('store_adapter.turso.wal_cap_baseline_captured', {
      db_path: dbPath ?? null,
      baseline_bytes: size,
      headroom_bytes: this._walCapHeadroomBytes,
      effective_cap_bytes: this._effectiveWalCapBytes(),
    });
    return size;
  }

  private async _checkWalCapAndFlush(): Promise<void> {
    if (!this._capFlushEnabled) return;
    const dbPath = this.coordPath;
    if (dbPath === undefined) return;
    let size: number;
    try {
      size = statSync(dbPath + '-wal').size;
    } catch {
      // No -wal file yet (nothing written since the last full checkpoint),
      // or a transient stat race with a concurrent checkpoint/truncate —
      // either way there is nothing to cap right now.
      return;
    }
    const capBytes = this._effectiveWalCapBytes();
    if (size < capBytes) return;
    try {
      const result = await this.executeAll<{ busy?: number; log?: number; checkpointed?: number }>(
        'PRAGMA wal_checkpoint(PASSIVE)',
      );
      const row = result.rows[0];
      if (row?.busy === 1) {
        // Genuinely unusual for PASSIVE (see doc comment — it does not need
        // the writer-exclusive lock), but PASSIVE can still degrade to busy
        // if even a passive checkpoint attempt collides with the engine's
        // own internal checkpoint lock. Durable either way — frames stay in
        // the WAL and the NEXT write's cap check retries immediately.
        log.warn('store_adapter.turso.wal_cap_flush_busy', {
          db_path: dbPath,
          wal_bytes_at_trip: size,
          cap_bytes: capBytes,
        });
      } else {
        log.debug('store_adapter.turso.wal_cap_flush', {
          db_path: dbPath,
          wal_bytes_at_trip: size,
          cap_bytes: capBytes,
          frames_checkpointed: row?.checkpointed ?? null,
        });
      }
    } catch (err) {
      // (BUG-019) `PRAGMA wal_checkpoint(PASSIVE)` can THROW a busy/lock
      // condition instead of returning the graceful `busy:1` row the
      // `if (row?.busy === 1)` branch above handles — reproduced live
      // 2026-08-18 under real sustained concurrent load (6 consecutive trips
      // in ~130ms, `error="step failed: Runtime error: database table is
      // locked"`). This is NOT a new failure mode this codebase has never
      // seen: `isBusyError()` (errors.ts) already recognizes this EXACT
      // message text — `/database (is|table is) locked/i` — as a
      // busy/lock-contention condition, not a fault; it is the same
      // classification `withRetry()` (retry.ts) uses to decide a write is
      // safe to retry, and `reportFailedPassiveCheckpoint()` (this file,
      // close()) already applies the analogous "thrown PASSIVE-checkpoint
      // error is a durable deferral, not data loss" distinction at close
      // time. Before this fix, THIS call site was the one place in the file
      // that still logged the raw throw as an unqualified fault
      // (`wal_cap_flush_failed` at `error` level) regardless of what the
      // driver's own text said — misclassifying a recognized, retriable
      // busy condition as an unexpected one.
      //
      // Route it into the SAME `wal_cap_flush_busy` signal the graceful
      // `busy:1` row gets: frames stay durable in the WAL either way (a
      // thrown checkpoint touches nothing — it either backfills a prefix of
      // frames before hitting the lock, or backfills none; nothing already
      // in the WAL is lost), and the NEXT write's cap check retries
      // immediately, exactly as the `busy:1` comment above already
      // documents. A genuinely unrecognized driver failure (not a busy/lock
      // message) still logs at `error` — this narrows the false-fault
      // signal, it does not silence real ones.
      const busy = isBusyError(err);
      const fields = {
        db_path: dbPath,
        wal_bytes_at_trip: size,
        cap_bytes: capBytes,
        error: err instanceof Error ? err.message : String(err),
      };
      if (busy) {
        log.warn('store_adapter.turso.wal_cap_flush_busy', fields);
      } else {
        log.error('store_adapter.turso.wal_cap_flush_failed', fields);
      }
    }
  }

  /** (BUG-026) Arm the WAL-ownership heartbeat if eligible and not already
   *  scheduled — periodic, self-re-arming. Unlike the idle flush (one-shot,
   *  re-armed by `_trackOp` on drain), this runs on a fixed cadence regardless
   *  of traffic, so a replaced WAL is detected within one heartbeat even while
   *  the connection sits idle. */
  private _armWalOwnershipHeartbeat(): void {
    if (!this._walOwnershipHeartbeatEnabled) return;
    if (this.closed || this._released) return;
    if (this._walOwnershipHeartbeatTimer !== null) return; // already scheduled
    const ms = this._walOwnershipHeartbeatMs;
    this._walOwnershipHeartbeatTimer = setTimeout(() => {
      this._walOwnershipHeartbeatTimer = null;
      void this._performWalOwnershipHeartbeat();
    }, ms);
    this._walOwnershipHeartbeatTimer.unref?.();
  }

  /**
   * (BUG-026) Fires once per heartbeat period. Skips when closed, released,
   * mid-op (`_inFlightOps > 0`), or with no baseline captured yet. On a
   * replaced WAL runs the same recovery as the write path (fold + recycle);
   * on an intact WAL runs a PASSIVE checkpoint — never TRUNCATE mid-session
   * (a TRUNCATE under a concurrent multiprocess peer is the #7833/#8348
   * checkpoint-race class). Re-arms itself in `finally` so the cadence keeps
   * running until close.
   */
  private async _performWalOwnershipHeartbeat(): Promise<void> {
    try {
      if (
        this.closed ||
        this._released ||
        this._poisoned ||
        this._inFlightOps > 0 ||
        this._walBaseline === null
      ) {
        return;
      }
      const status = verifyWalIdentityNow(this._walBaseline);
      if (status.status === 'replaced') {
        await this._recoverReplacedWal('heartbeat', status.finding);
      } else if (status.status === 'intact') {
        await this.db.get('PRAGMA wal_checkpoint(PASSIVE)');
      }
      // no-baseline: nothing to compare against — no-op.
    } catch (err) {
      log.warn('store_adapter.turso.wal_ownership_heartbeat_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this._armWalOwnershipHeartbeat();
    }
  }

  /**
   * (BUG-026) Recover from a replaced WAL observed on the write path or the
   * heartbeat: emit damaged, fold the orphaned frames into the main db file
   * through the fd this connection already holds (PASSIVE — never TRUNCATE),
   * emit repaired, then poison the connection DIRECTLY (not `_markIfFatal` —
   * a distinct, expected recycle cause, so it logs under its own key;
   * `_ensureHealthy` reconnects on the next op, re-capturing the baseline).
   */
  private async _recoverReplacedWal(
    trigger: 'write' | 'heartbeat',
    finding: import('./integrity.js').IntegrityFinding | null,
  ): Promise<void> {
    const dbPath = this.coordPath ?? this.config.url;
    emitIntegrityReport(dbPath, 'damaged', describeWalReplaced(finding));
    let folded = false;
    try {
      await this.db.get('PRAGMA wal_checkpoint(PASSIVE)');
      folded = true;
    } catch (err) {
      log.warn('store_adapter.turso.wal_replaced_checkpoint_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (folded) {
      emitIntegrityReport(
        dbPath,
        'repaired',
        'checkpointed the orphaned WAL into the main database file before reconnect',
      );
    }
    this._poisoned = true;
    logWalReplacedObserved('store_adapter.turso', dbPath, trigger);
  }

  /** (BUG-026) Write-path WAL-identity check — run inside `_trackOp(fn, true)`
   *  after the write succeeds, before the wal-cap backstop. No-op on
   *  `no-baseline`/`intact`. */
  private async _recoverReplacedWalIfNeeded(): Promise<void> {
    const status = verifyWalIdentityNow(this._walBaseline);
    if (status.status !== 'replaced') return;
    await this._recoverReplacedWal('write', status.finding);
  }

  /** (idle-release) Wraps every method that touches `this.db` directly:
   *  increments `_inFlightOps` before `_ensureHealthy()` runs (so a
   *  reconnect itself also counts as "busy"), decrements in `finally`
   *  regardless of outcome. Centralizes the `_ensureHealthy()` call so every
   *  wrapped method gets poison- AND release-recovery for free.
   *
   *  (idle-flush) Also owns the flush timer's cancel/rearm: new work always
   *  cancels a pending flush FIRST (before `_ensureHealthy()` — a reconnect
   *  triggered by this same op must not race a flush firing underneath it),
   *  and a completion that leaves the connection idle rearms it.
   *
   *  (wal-cap) `isWrite` (default `false`) additionally runs the forced
   *  size-capped flush check AFTER `fn()` succeeds, still inside the tracked
   *  window (`_inFlightOps` stays non-zero) — so the idle-flush timer cannot
   *  arm mid-check, and the two triggers are structurally unable to race
   *  each other: the cap check only ever runs while `_inFlightOps > 0`, the
   *  idle flush only ever fires once it observes `_inFlightOps === 0`. */
  private async _trackOp<T>(fn: () => Promise<T>, isWrite = false): Promise<T> {
    this._cancelIdleFlush();
    this._inFlightOps++;
    try {
      await this._ensureHealthy();
      const result = await fn();
      if (isWrite) {
        // (BL-590) Feed the observed inter-write gap into the EWMA BEFORE
        // the cap check — the cap check's own (rare) latency must not itself
        // count as part of the write cadence being measured.
        const now = Date.now();
        if (this._lastWriteAt !== null) {
          this._writeIntervalEwmaMs = updateWriteIntervalEwma(
            this._writeIntervalEwmaMs,
            now - this._lastWriteAt,
          );
        }
        this._lastWriteAt = now;
        // (BUG-026) Lifetime WAL-identity check on EVERY write — a replaced
        // WAL is folded + the connection recycled here, not hours later at
        // close. Runs before the wal-cap backstop so the two never race.
        await this._recoverReplacedWalIfNeeded();
        await this._checkWalCapAndFlush();
      }
      return result;
    } finally {
      this._inFlightOps--;
      if (this._inFlightOps === 0) this._armIdleFlush();
    }
  }

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

  /** (BUG-007/008/009, adapter-race-fix §4) This connection's cross-process
   *  lease entry, acquired by `connect()` when `opts.dbPath` is set and
   *  released LAST in `close()` — after the driver has let go. The lease is
   *  the quiescence gate for every destructive sidecar operation (proactive
   *  `-tshm` rename, close()-TRUNCATE): a store with a live peer is never
   *  reconciled, never truncated. `_reconnect()` deliberately does NOT adopt
   *  the fresh instance's lease — the original entry stays valid across the
   *  reconnect (same connection), and adopting a second entry would leak it. */
  private _lease: StoreLease | null = null;

  /**
   * (BUG-STOREADAPTER-COORDINATION-PATH-ASYMMETRY) The CANONICAL store identity,
   * computed once by `connect()` and the ONLY path any coordination site may use.
   *
   * `this.config.dbPath` holds the caller's ORIGINAL spelling and must keep it —
   * the driver `url` and the `_connectOpts` replay legitimately depend on it. But
   * the lease directory is derived from the path (`<dbPath>.sox-lease.d/`), so a
   * caller-supplied spelling that is not already canonical (a relative path, a
   * symlinked parent, a `..` segment, a doubled separator) makes the raw and
   * canonical forms address DIFFERENT DIRECTORIES.
   *
   * That is not cosmetic. `connect()` takes the lease under the CANONICAL path;
   * before this field existed, `close()` read quiescence under the RAW one, found
   * an empty directory, concluded the store was quiescent, and issued
   * `PRAGMA wal_checkpoint(TRUNCATE)` while a live peer held the store — the
   * turso #7833 trigger, reachable with no race at all, only a path spelling.
   * The same asymmetry left every `.openmark` uncleared (written canonical at
   * `markStoreOpen`, cleared raw at `close()`), which pins `hasUncleanShutdown`
   * true forever and re-runs the panic-adjacent pre-flight probe on every open.
   *
   * Read it through {@link coordPath}, never directly, so a hand-constructed
   * instance still resolves correctly.
   */
  private _canonicalDb: string | undefined = undefined;

  /**
   * The path every lease / quiescence / sidecar / marker call site MUST use.
   *
   * Falls back to canonicalizing `config.dbPath` on demand so an instance built
   * outside `connect()` (tests, future factories) cannot silently regress to the
   * raw spelling. `canonicalDbPath` is memoized, so the fallback is cheap.
   */
  private get coordPath(): string | undefined {
    if (this._canonicalDb !== undefined) return this._canonicalDb;
    return this.config.dbPath !== undefined ? canonicalDbPath(this.config.dbPath) : undefined;
  }

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

  /**
   * (SPEC-CONN-RECYCLE) `'healthy'` unless a fatal driver fault has poisoned
   * `this.db` and no reconnect has completed since. Reading this never
   * itself starts a reconnect — it is a pure observation for callers (e.g.
   * a health surface) that want state without issuing a query.
   *
   * (DEBT-003, lazy-connect) A never-opened instance (no operation has run
   * yet) reports `'healthy'`, not a fourth state — nothing has failed, there
   * is simply nothing open yet, and adding a new state to this union would
   * be a breaking type change for every existing consumer of this getter
   * (including the external `@adhd/backlog` dependency). `'reconnecting'`
   * correctly still applies once the first operation has actually kicked off
   * the deferred open (`_reconnectPromise` is set by `_ensureHealthy()`
   * regardless of whether it was triggered by poison, release, or
   * never-opened).
   */
  get connectionHealth(): 'healthy' | 'poisoned' | 'reconnecting' {
    if (this._reconnectPromise) return 'reconnecting';
    return this._poisoned ? 'poisoned' : 'healthy';
  }

  /**
   * (SPEC-CONN-RECYCLE) If `err` is a fatal connection-level fault (see
   * `isFatalConnectionError`), mark this adapter `_poisoned` so the NEXT
   * call reconnects before issuing its query. Never swallows or transforms
   * `err` — callers always rethrow the original error unchanged; this only
   * records the side effect.
   */
  private _markIfFatal(err: unknown): void {
    if (isFatalConnectionError(err)) {
      this._poisoned = true;
      log.error('store_adapter.turso.connection.poisoned', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * (SPEC-CONN-RECYCLE; DEBT-003 lazy-connect) If `_poisoned`, `_released`,
   * or `_neverOpened`, await-or-start a single shared reconnect before
   * letting the caller proceed. Must be called before every direct
   * `this.db.*` call site (after `_assertWritable()` where both apply — a
   * read-only-mode rejection is not a connection question). This is the ONE
   * gate through which a never-opened instance performs its first real
   * driver open — see `_neverOpened`'s doc comment for why deferred-open is
   * expressed through this existing recovery path rather than a parallel one.
   */
  private async _ensureHealthy(): Promise<void> {
    if (!this._poisoned && !this._released && !this._neverOpened) return;
    if (!this._reconnectPromise) {
      this._reconnectPromise = this._reconnect();
    }
    await this._reconnectPromise;
  }

  /**
   * (SPEC-CONN-RECYCLE) Reconnect via a full re-run of
   * `TursoAdapterImpl.connect(this._connectOpts)` — the real connect path,
   * not a bespoke lightweight reopen — so BL-361's out-of-process preflight,
   * BL-461's in-process FTS orphan guard, and BL-352's open-time integrity
   * verify-and-repair all run again on the fresh connection. Adopts the
   * fresh instance's live-connection state (`db`, `_walBaseline`,
   * `_softReadonly`) onto `this`; `config`/`capabilities`/`_connectOpts`
   * describe the adapter's identity and stay stable so callers holding a
   * reference to them never see it change under them.
   *
   * The stale, poisoned handle's own `close()` is fired detached and
   * best-effort AFTER the fresh connection is already live — never awaited
   * on this recovery critical path. `close()` itself issues queries
   * (`verifyStoreIntegrity`, `PRAGMA wal_checkpoint`) against the very
   * connection that just proved it can hang or error on I/O; the incident's
   * own "only kill -TERM recovered it" symptom is consistent with a
   * synchronous wait on exactly this kind of call.
   *
   * On success, clears `_poisoned`/`_released` and `_reconnectPromise`. On
   * failure, leaves `_poisoned = true` (a failed recovery from a release is
   * ALSO reported as poisoned, not silently re-marked released, so the next
   * `_ensureHealthy()` call retries via the same well-tested path rather than
   * a second released-specific branch), clears `_reconnectPromise` (so the
   * next call gets a fresh attempt rather than being stuck on one failed
   * promise), and rethrows — an unreachable store must not fake success.
   *
   * (idle-release) Lease handling differs by WHY this instance needed
   * reconnecting:
   *  - Recovering from `_poisoned`: this instance's OWN lease entry was
   *    never released (the driver died; the fs lease is independent of driver
   *    health) — it is still the correct, live token, so `this._lease` is
   *    left untouched, exactly as before this feature existed. But `connect()`
   *    ALWAYS acquires a lease for the temporary `fresh` instance regardless
   *    of purpose, and until now nothing released THAT one — a real, if
   *    narrow, leak (one orphaned-but-technically-live lease entry per
   *    poison-reconnect, invisible to `storeQuiescence` sweeping because the
   *    owning pid stays alive for the process's whole life). Fixed here:
   *    release `fresh._lease` immediately since this instance never adopts it.
   *  - Recovering from `_released`: `releaseIdleConnection()`'s `close()` call
   *    already released this instance's OWN lease entry on purpose — there is
   *    no existing valid token to keep, so the fresh `connect()`'s lease MUST
   *    be adopted as this instance's new one, or every future `close()`/
   *    `releaseIdleConnection()` call silently stops participating in
   *    `storeQuiescence()` (the `coordDb && this._lease` gate at close()'s
   *    TRUNCATE branch would fall through to the "no lease" branch forever).
   *  - Recovering from `_neverOpened` (DEBT-003, lazy-connect): identical to
   *    `_released` for lease purposes — this instance has NEVER held a lease
   *    (`connect()` deliberately does not acquire one for a never-opened
   *    shell, see `_neverOpened`), so the fresh `_openReal()`'s lease MUST be
   *    adopted as this instance's first one, same as the `_released` branch.
   *
   * (DEBT-003, lazy-connect) Calls `TursoAdapterImpl._openReal()` — the
   * actual full-ceremony open — NOT the public `TursoAdapterImpl.connect()`.
   * Since `connect()` itself is now the LAZY entry point (constructs a
   * never-opened shell, performs no driver open), replaying `connect()` here
   * would just hand back a second never-opened shell forever instead of ever
   * actually reconnecting. `_openReal()` is the one place the real open
   * ceremony lives; both the public `connect()`'s eventual first-op deferral
   * and every genuine poison/release reconnect go through it.
   */
  private async _reconnect(): Promise<void> {
    const staleDb = this.db;
    const wasNeverOpened = this._neverOpened;
    const wasReleased = this._released || wasNeverOpened;
    try {
      const fresh = await TursoAdapterImpl._openReal(this._connectOpts);
      this.db = fresh.db;
      this._walBaseline = fresh._walBaseline;
      this._softReadonly = fresh._softReadonly;
      // (DEBT-003, lazy-connect) `recursiveCte` is the one capability that
      // genuinely requires a live connection to probe (see `_openReal()`) —
      // `connect()` seeds a conservative `false` guess for a never-opened
      // shell. Sync the real probed value now. A harmless no-op resync on
      // every ordinary poison/release reconnect (the value is a fixed
      // property of the store/driver version and cannot change between
      // reconnects of the same instance).
      this._capabilities = fresh._capabilities;
      // (idle-flush, BUG-STOREADAPTER-RECONNECT-ORPHANED-IDLE-TIMER,
      // discovered 2026-08-17 while building this feature) `connect()`
      // self-arms an idle-flush timer on EVERY writable local-file instance
      // it returns, including this throwaway `fresh` one — and `fresh._idleFlushTimer`
      // is never adopted onto `this` (`this` keeps running its OWN idle-flush
      // cycle, set up identically at its own original `connect()`). Left
      // uncancelled, that orphaned timer stays alive (its closure keeps
      // `fresh` reachable) bound to `fresh.db`, which is THE SAME live
      // connection object `this.db` now points at (assigned just above) —
      // when it eventually fires it runs a second, completely uncoordinated
      // `releaseIdleConnection()`/`close()` ceremony against that shared
      // connection, independent of `this`'s own `_inFlightOps`/idle-flush
      // state. Measured: this raced `this`'s own close(), producing
      // `store_adapter.turso.close_verify_failed` /
      // `checkpoint_deferred: The database connection is not open` — a
      // benign-but-real "deferred, not lost" symptom (BUG-011), not data
      // loss, but a genuine extra uncoordinated close cycle this line
      // eliminates at the source.
      fresh._cancelIdleFlush();
      // (BUG-026) Same orphaned-timer hazard as the idle flush: `fresh` arms
      // its OWN WAL-ownership heartbeat on every writable local-file open.
      // Cancel it (its closure would otherwise keep `fresh` reachable and run
      // a second uncoordinated heartbeat against the shared `this.db`), and
      // re-arm `this`'s heartbeat so the lifetime ownership check resumes on
      // the recycled connection. Unlike the idle flush (re-armed by
      // `_trackOp` on drain), the heartbeat is periodic and has no other
      // re-arm source, so it must be re-armed here explicitly.
      fresh._cancelWalOwnershipHeartbeat();
      this._walOwnershipHeartbeatEnabled = fresh._walOwnershipHeartbeatEnabled;
      this._walOwnershipHeartbeatMs = fresh._walOwnershipHeartbeatMs;
      this._armWalOwnershipHeartbeat();
      if (wasReleased) {
        this._lease = fresh._lease;
      } else if (fresh._lease) {
        // (BUG-015, discovered 2026-08-17 while building idle-release)
        // `this._lease` is still valid and untouched — the fresh instance's
        // own lease is unused and would otherwise linger in the lease dir
        // for this process's entire remaining life.
        await fresh._lease.release().catch((leaseErr: unknown) => {
          log.warn('store_adapter.turso.reconnect_stale_lease_release_failed', {
            error: leaseErr instanceof Error ? leaseErr.message : String(leaseErr),
          });
        });
      }
      this._poisoned = false;
      this._released = false;
      this._neverOpened = false;
    } catch (err) {
      log.error('store_adapter.turso.connection.reconnect_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      this._poisoned = true;
      throw err;
    } finally {
      this._reconnectPromise = null;
    }

    // (DEBT-003, lazy-connect) A never-opened instance's "stale" handle is
    // the `NEVER_OPENED_DB` sentinel, not a real driver connection — there is
    // nothing to close, and invoking it would only produce a spurious
    // `stale_close_failed` error log on every single first-use deferred open.
    if (wasNeverOpened) return;

    // Detached, best-effort close of the stale handle — never on the
    // recovery critical path (see doc comment above).
    void Promise.resolve()
      .then(() => staleDb.close())
      .catch((closeErr: unknown) => {
        log.error('store_adapter.turso.connection.stale_close_failed', {
          error: closeErr instanceof Error ? closeErr.message : String(closeErr),
        });
      });
  }

  private constructor(
    db: any,
    config: AdapterConfig & { type: 'turso' },
    capabilities: AdapterCapabilities,
  ) {
    this.db = db;
    this.config = config;
    this._capabilities = capabilities;
  }

  /**
   * (DEBT-003, lazy-connect) THE REAL OPEN. Every step here is unchanged
   * from before this feature existed: acquire the lease, run the BL-361
   * out-of-process pre-flight, BL-373 sidecar reconcile, open the driver,
   * the BL-508 foreign-engine refusal, the `WITH RECURSIVE` capability
   * probe, stamp the engine marker, run the BL-461 FTS orphan guard, stamp
   * adapter metadata, run BL-352 open-time integrity repair, capture the WAL
   * baseline, and arm the idle-flush/wal-cap triggers. Called from THREE
   * places, never directly by external callers:
   *  - the public `connect()` used to call this same code inline; it is now
   *    a thin lazy shell (see its doc comment) that defers to this method
   *    via `_reconnect()` on first use;
   *  - `_reconnect()`, for every poison/release/never-opened recovery — the
   *    SAME recovery path this method has always powered;
   *  - `withConnectionClosedForRepair()`, to reopen after an out-of-band
   *    classic-engine repair.
   * Kept `private static` (was `static` / public) — nothing outside this
   * class may call it directly; going through `connect()` is the only public
   * surface, exactly as the pre-existing "prefer TursoAdapterImpl.connect()"
   * guidance already said.
   */
  private static async _openReal(opts: {
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
    defaultQueryTimeout?: number;
    /**
     * (BL-508) Permit opening a store whose engine marker claims the OTHER
     * engine (SQLite-owned) — the deliberate-migration escape hatch. Only the
     * factory's `migrateOnAdapterChange` path sets this; every other caller
     * fails closed with `ESqliteNativeStore` before any write/WAL touch.
     */
    allowForeignEngine?: boolean;
    /**
     * (BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001) The concurrency mode to
     * open under. Optional — defaults to `resolveConcurrencyMode('turso')` =
     * `'multiprocess-wal'` (ADR-0012, no opt-out). When set to anything but
     * `'multiprocess-wal'`, `assertValidConcurrencyMode` throws. The resolved
     * mode drives the `multiprocess_wal` experiments flag, the
     * `capabilities.walMode`/`multiprocessWrite` fields, and the post-open
     * `-tshm` verification — there is no independent hardcode.
     */
    concurrencyMode?: StoreConcurrencyMode;
    /**
     * (idle-flush, TEST-ONLY) Override the idle-flush debounce window
     * (default `DEFAULT_IDLE_FLUSH_MS` = 2000ms). No production caller sets
     * this — it exists so tests can observe idle-flush behavior without a
     * real 2s wait.
     */
    idleFlushMs?: number;
    /**
     * (BL-590, TEST-ONLY) Override the idle-flush debounce FLOOR (default
     * `DEFAULT_IDLE_FLUSH_FLOOR_MS` = 2000ms) WITHOUT fixing the window —
     * unlike `idleFlushMs`, this does NOT disable adaptive computation.
     * Exists so tests can exercise the real BL-590 adaptive path (EWMA +
     * margin, clamped [floor, ceiling]) with a small floor, instead of
     * either paying a real 2s floor or using `idleFlushMs` (which bypasses
     * adaptation entirely by design — see its own doc comment).
     */
    idleFlushFloorMs?: number;
    /**
     * (BL-590, TEST-ONLY) Override the idle-flush debounce CEILING (default
     * `DEFAULT_IDLE_FLUSH_CEILING_MS` = 30,000ms). No production caller sets
     * this — lets tests exercise the adaptive window's upper clamp without a
     * real 30s wait.
     */
    idleFlushCeilingMs?: number;
    /**
     * (idle-flush) Select the gated-vs-ungated strategy for the IDLE path —
     * see `_walFlushStrategy`'s doc comment for the full decision. Default
     * `'gated'`, now PERMANENT (2026-08-18): `wal-truncate-safety-experiment`
     * came back INCONCLUSIVE (could not reproduce the #8348 baseline at all
     * via the JS binding, so the 5-config/1,180-trial sweep's clean result
     * cannot be read either way) — this is not a placeholder pending a
     * result, it is the settled answer. No caller may pass `'ungated'`
     * outside a test.
     */
    walFlushStrategy?: 'gated' | 'ungated';
    /**
     * (wal-cap, TEST-ONLY) Override the forced-flush byte threshold (default
     * `DEFAULT_WAL_CAP_BYTES` = 262,144 / 256 KiB). No production caller
     * sets this — it exists so tests can trip the cap without writing
     * hundreds of KB of real rows.
     */
    walCapBytes?: number;
    /**
     * (BL-587, TEST-ONLY) Override the HEADROOM budget added on top of the
     * captured baseline (default `DEFAULT_WAL_CAP_HEADROOM_BYTES` =
     * 262,144 / 256 KiB). No production caller sets this.
     */
    walCapHeadroomBytes?: number;
    /**
     * (BL-587, TEST-ONLY) Override the absolute ceiling on the effective cap
     * (default `DEFAULT_WAL_CAP_CEILING_BYTES` = 1,048,576 / 1 MiB). No
     * production caller sets this.
     */
    walCapCeilingBytes?: number;
    /**
     * (BUG-026, TEST-ONLY) Override the WAL-ownership heartbeat interval
     * (default resolved from `SOX_WAL_OWNERSHIP_HEARTBEAT_MS`, else 10s). No
     * production caller sets this — it exists so tests can observe the
     * heartbeat's replaced-WAL detection without a real 10s wait. Clamped to
     * [1000, 60000].
     */
    walOwnershipHeartbeatMs?: number;
  }): Promise<TursoAdapterImpl> {
    // Dynamic import so @tursodatabase/database is only loaded when used
    let tursoModule: any;
    try {
      tursoModule = await import('@tursodatabase/database');
    } catch (err) {
      // The thrown message says "not installed", but the import can fail for
      // other reasons (native binding, version) — trace the REAL error, which
      // this throw would otherwise discard.
      log.error('store_adapter.turso.driver_import_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
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

    // (BUG014.T4, INV-4) ONE canonical path per physical store. Every
    // cross-process coordination key below — the lease directory, the
    // out-of-band open marker, every sidecar probe — must be derived from the
    // SAME string whatever spelling this caller used (a symlinked directory
    // alias, `/tmp` vs `/private/tmp`, a relative path vs its absolute form).
    // Canonicalize ONCE here (`canonicalDbPath`: realpathSync(dirname) +
    // basename, memoized) and use `canonicalDb` at every coordination call
    // site below — never `opts.dbPath` again except where the driver open
    // (`url`) and the `_connectOpts` replay legitimately keep the caller's
    // original spelling (connect() re-canonicalizes on replay).
    const canonicalDb = opts.dbPath !== undefined ? canonicalDbPath(opts.dbPath) : undefined;

    // (BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001) Resolve + validate the
    // concurrency mode up front — turso mandates 'multiprocess-wal' only; a
    // 'single-writer' declaration throws before any lease/file/WAL is touched.
    const mode: StoreConcurrencyMode = opts.concurrencyMode ?? resolveConcurrencyMode('turso');
    assertValidConcurrencyMode('turso', mode);

    let lease: StoreLease | null = null;
    if (canonicalDb !== undefined) {
      lease = await acquireStoreLease(canonicalDb);
    }

    try {
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
      // (BL-512, concurrent-write follow-on) A bounded busy timeout is ALWAYS
      // on — not a toggle, matching multiprocess_wal. With the driver's default
      // busy_timeout=0, a connect or first statement that lands inside another
      // process's close()-TRUNCATE exclusive-lock window fails instantly with
      // "database is locked" and the write is lost (measured 2026-08-12: 6
      // parallel processes × 3 cycles lost 2-4/18 under 0-timeout churn; the
      // identical workload with `timeout: 5000` persists 18/18, 3/3 runs — the
      // raw-driver control isolates this from the adapter). The timeout makes
      // the engine WAIT out the transient lock instead of failing.
      dbOpts.timeout = DEFAULT_BUSY_TIMEOUT_MS;

      // index_method is ALWAYS on, unconditionally — not a toggle. Turso's FTS
      // index DDL (`CREATE INDEX ... USING fts (...)`) and every subsequent
      // fts_match/fts_score query against it require this experimental flag on
      // the connection that runs them — not just the connection that created
      // the index. Without it, index creation throws a parse error ("index
      // method is an experimental feature") that was previously swallowed by a
      // surrounding try/catch at log.debug in db.ts, so idx_fts_node silently
      // never existed on any real Turso store and FTS was dead in production.
      // There is no PRAGMA workaround (Turso silently no-ops unknown PRAGMAs).
      // FTS is a core feature, so this is unconditional.
      //
      // multiprocess_wal is ALSO always on, unconditionally — NOT a toggle
      // (BL-512 concurrent-write defect). The backlog store is opened by many
      // short-lived processes at once; multiprocess WAL (.tshm coordination)
      // is what lets those coexisting opens share the store. An open WITHOUT it
      // while another process holds multiprocess authority is refused by the
      // engine ("Database is already open without experimental multiprocess WAL
      // in another process") and the write is lost — which is exactly what the
      // pre-connect better-sqlite3 probe used to trigger (engine-guard
      // `readApplicationId`, now header-first). There is no opt-out: the
      // `experimental: { multiprocessWal: false }` option was REMOVED from the
      // adapter API with this fix.
      //
      // (BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001) The flag is now
      // DERIVED from the resolved concurrency mode — see
      // `StoreConcurrencyMode`/`resolveConcurrencyMode` in concurrency-mode.ts.
      // turso's one valid mode is 'multiprocess-wal', so for every real turso
      // open the flag is present (BL-512 semantics preserved); there is no
      // independent `experiments` literal to drift from `capabilities.walMode`.
      const experiments: string[] = ['index_method', ...(mode === 'multiprocess-wal' ? ['multiprocess_wal'] : [])];
      if (opts.encryption) {
        dbOpts.encryption = {
          cipher: opts.encryption.cipher,
          hexkey: opts.encryption.hexkey,
        };
      }
      if (experiments.length > 0) {
        dbOpts.experimental = experiments;
      }

      // (BUG-026) FOREIGN -shm RECONCILE, after lease before driver open. A
      // `-shm` beside a turso store is FOREIGN by construction (turso
      // coordinates through `-tshm`, never `-shm`) — the 'exp9 poisoner'
      // residue left by a better-sqlite3 opener (graph-store's former
      // `engineIdentity` getter, or any raw better-sqlite3 open). Quiescent →
      // rename aside; live peers → refuse, because reconciling under a live
      // peer is the cross-engine hazard this guard exists to prevent.
      if (canonicalDb !== undefined && opts.readonly !== true && opts.allowForeignEngine !== true && lease) {
        const shmQuiescence = storeQuiescence(canonicalDb, lease.token);
        const shm = reconcileForeignSqliteShm(canonicalDb, {
          storeInUse: !shmQuiescence.quiescent,
        });
        if (shm.reconciled && shm.renamedTo) {
          emitIntegrityReport(
            canonicalDb,
            'repaired',
            `[BUG-026] foreign -shm sidecar reconciled BEFORE the open: moved aside to ` +
              `${shm.renamedTo} — the turso store opens against its own -tshm coordination`,
          );
        } else if (shm.declined !== undefined && !shmQuiescence.quiescent) {
          throw new EForeignSqliteSidecar(canonicalDb, shmQuiescence.livePeers);
        }
      }

      // Turso adapter supports both local file: and remote libsql:// URLs
      // When authToken is present, it's a remote connection
      const driverOpen = async (): Promise<any> => {
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

      // (BL-512 follow-on) BOUNDED CONNECT-LEVEL RETRY for the driver's own
      // open-handshake race ("Database is already open without experimental
      // multiprocess WAL in another process"). Measured 2026-08-12 under
      // barrier-synced maximal simultaneous opens, this is the driver's
      // transient classification of an in-progress sibling open as a legacy
      // opener — a raw-driver control (no adapter, no better-sqlite3) fails
      // 1-14/20 at varying rates WITH the barrier sync and 20/20 every run
      // without it, so the adapter cannot remove it and the driver's busy
      // timeout cannot absorb it (hard error, not busy). This loop is the only
      // remaining lever. It is a SCALPEL: retried ONLY when the thrown open
      // error matches `isAlreadyOpenWithoutMultiprocessWal` — any other open
      // failure (wrong mode, permission, corrupt file, stale-WAL sidecar…)
      // propagates immediately.
      //
      // (BL-TSHM-INIT-RACE) The SAME loop also absorbs a `-tshm`
      // coordination-file INIT race: two processes opening (and then
      // writing to, e.g. schema DDL) the same COLD store at once can have
      // one stat/read the `-tshm` sidecar before the other has finished
      // writing its 4096-byte header, which `@tursodatabase/database@0.7.2`
      // reports as:
      //   "Corrupt database: shared WAL coordination map magic mismatch"
      //   "Corrupt database: shared WAL coordination file is smaller than
      //    the coordination header: got 0, minimum 4096"
      // Despite the wording this is NOT corruption — measured 2026-09-06
      // (minimal repro: createStoreAdapter + a real write, no other
      // write-layer code; 40 two-process cold-open races: 0.9.0 failed
      // 1/10, published 0.7.0 failed 2/10, both variants seen; a suite of
      // 300 processes/150 races over this exact adapter path failed 5/300
      // with the retry disabled and 0/300 with it enabled — see
      // tshm-init-race.spec.ts) retrying the SAME dbPath in a brand-new
      // process after a failure succeeded 5/5 with 0 sticky failures.
      //
      // This is a DISTINCT window from the documented stale-`-tshm`-after-
      // TRUNCATE case (BUG-STOREADAPTER-ADAPTER-NOT-ENGINE-FIASCO-RECORD-001):
      // that one is a PRE-EXISTING store whose `-tshm` survives a
      // close()-TRUNCATE and indexes dead frames on a LATER open; this one
      // only exists the very first time a store is created, and this fix
      // does not touch the stale-sidecar-reconcile machinery at all. It is
      // also distinct from the raw turso engine's own open-handshake race
      // above ("already open without experimental multiprocess WAL",
      // "database is locked") — a raw-driver control (no adapter, same
      // two-process cold-store shape, 20 iterations) reproduced THOSE
      // signatures 5/20 but never once produced either tshm-coordination
      // message; the two signatures here are only observed through this
      // adapter's own open path.
      //
      // `isTshmCoordinationInitRace` is a SCALPEL, matching ONLY these two
      // exact message markers — any other "Corrupt database" text (a
      // genuinely malformed file, wrong engine, permission error…) is NEVER
      // retried and propagates immediately, exactly like `E_IO` in the
      // write-queue layer.
      //
      // Bound: OPEN_RETRY_MAX_ATTEMPTS total (1 initial + 2 retries) — ADR-0012
      // §4's ceiling, the same 3 the transaction and write-queue loops use.
      // Backoff: linear 100ms → 200ms (constants above — no I/O involved, the
      // other opener releases within a few scheduler quanta). Exhaustion: the
      // ORIGINAL driver error is rethrown UNCHANGED (only marked
      // `retryable: true`, never wrapped) so the CALLER decides beyond this
      // bound and the driver's own text is never lost (§4). No config
      // toggle: unconditional fixed behavior (ADR-0013).
      const openOnce = async (): Promise<any> => {
        let lastError: unknown;
        for (let attempt = 0; attempt < OPEN_RETRY_MAX_ATTEMPTS; attempt++) {
          try {
            return await driverOpen();
          } catch (err) {
            const isMultiprocessWalRace = isAlreadyOpenWithoutMultiprocessWal(err);
            const isTshmInitRace = isTshmCoordinationInitRace(err);
            if (!isMultiprocessWalRace && !isTshmInitRace) throw err;

            if (attempt >= OPEN_RETRY_MAX_ATTEMPTS - 1) {
              // Exhausted — surface the ORIGINAL driver error, marked
              // retryable so the caller knows this is the transient race and
              // may retry beyond the adapter's bound (ADR-0012 §4).
              if (err !== null && typeof err === 'object') {
                (err as { retryable?: boolean }).retryable = true;
                // For the -tshm case ONLY, append a note. The driver's own
                // text says "Corrupt database", which is actively misleading:
                // the sidecar was merely read before a concurrently-opening
                // process finished writing its header. Measured: a fresh
                // process against the SAME path succeeded 5/5 after this
                // error, and 0 stores stayed broken — nothing is corrupt and
                // there is no recovery procedure to hunt for. The original
                // message is preserved verbatim ahead of the note (§4).
                const e = err as { message?: string };
                if (isTshmInitRace && typeof e.message === 'string' && !e.message.includes('NOT database corruption')) {
                  e.message =
                    `${e.message} — NOTE: this is the transient shared-WAL coordination cold-init ` +
                    `race, NOT database corruption despite the driver's wording: the coordination ` +
                    `sidecar was read before its header was written by a concurrently-opening ` +
                    `process. The store is intact; retry the open (measured to succeed 5/5).`;
                }
              }
              throw err;
            }

            const delay = OPEN_RETRY_BACKOFF_START_MS + attempt * OPEN_RETRY_BACKOFF_STEP_MS;
            log.warn(
              isTshmInitRace
                ? 'store_adapter.turso.open_tshm_init_race_retry'
                : 'store_adapter.turso.open_multiprocess_wal_retry',
              {
                attempt: attempt + 1,
                max_attempts: OPEN_RETRY_MAX_ATTEMPTS,
                delay_ms: delay,
                error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
              },
            );
            lastError = err;
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
        // Unreachable in practice (every path above returns or throws), but
        // satisfies the type system — same shape as retry.ts `withRetry`.
        throw lastError;
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
      //
      // (BUG-017) The repair (a WRITABLE better-sqlite3 open) is quiescence-
      // gated INSIDE `deleteSchemaRowsViaBetterSqlite3`; the connect-scope
      // lease token is threaded through so the adapter's OWN lease never
      // counts against itself. The lease is acquired ABOVE this block (≈400),
      // so `lease?.token` is in scope — the preflight-before-lease ordering
      // trap does not apply here, but any future reordering must keep the
      // lease acquisition above the preflight.
      //
      // (BUG014.T5) The gate is now "a DEAD connection left the store unclean"
      // (`hasUncleanShutdown`: any `<leaseDir>/<token>.openmark` whose pid is
      // dead or aged out, plus the legacy one-shot shim), NOT "a marker file
      // is present". A marker whose pid is LIVE is a CONCURRENT session — the
      // production shape (4-6 live MCP servers + CLI one-shots) — and must
      // never trigger the pre-flight against a live multiprocess store (the
      // BUG-017 writable-repair trigger surface). The marker is per-connection
      // now, so the FIRST orderly close can no longer erase a peer's crash
      // evidence: a crashed server's dead marker still gates the next open.
      if (canonicalDb !== undefined && opts.readonly !== true && hasUncleanShutdown(canonicalDb)) {
        // (INV-5) The trigger is loud, never silent.
        log.debug('store_adapter.turso.preflight_triggered_unclean', {
          db_path: canonicalDb,
          detail: 'a dead-pid open marker was found; running the out-of-process schema pre-flight',
        });
        const preflight = preflightSchemaSanity(
          canonicalDb,
          lease !== null ? { repair: true, ownLeaseToken: lease.token } : { repair: true },
        );
        if (preflight.orphaned.length > 0) {
          emitIntegrityReport(
            canonicalDb,
            preflight.failed !== null ? 'repair_failed' : 'repaired',
            describePreflight(preflight),
          );
        }
        // (BUG014.T5) Consume the signal AFTER the pre-flight: dead markers (and
        // any legacy `${dbPath}-openmark` shim file) are swept so the SAME
        // crash evidence never re-triggers a second pre-flight on the next
        // open. Live peers' markers are never touched.
        sweepDeadOpenMarkers(canonicalDb);
      }

      // (BL-373 family) Informational, BEFORE any open attempt: a `-tshm` that
      // is provably older than the `-wal` beside it is decaying, and the open
      // about to run may be the one that fails with a WAL-frame short read.
      // Two statSync calls, never throws.
      warnIfStaleSidecar(canonicalDb);

      // (BL-373 family) PROACTIVE — root-cause prevention, not just healing.
      // The mechanism (confirmed by scratch repro, 2026-08-11): the -tshm is
      // maintained only while a Turso connection holds the store; any other
      // writer (better-sqlite3 / stock SQLite, which maintains the classic -shm
      // and never the -tshm) advances, checkpoints or deletes the WAL without
      // touching the sidecar, so the next Turso open short-reads against the
      // frozen sidecar. Moving a CONTENT-PROVEN-DEAD sidecar HERE — before
      // `openOnce()` even runs — means the failed-open path is never taken; the
      // catch below stays as the backstop for races and non-content shapes.
      //
      // (BUG014.T3) The trigger is content-deadness (`isTshmContentDead`), never
      // mtime: under multiprocess WAL the tshm mtime freezes at file creation,
      // so mtime skew is expected on a HEALTHY sidecar and the old mtime
      // heuristic renamed it during brief quiescent windows (the 2026-08-12
      // 08:28–08:46 false-positive churn). mtime survives only as a log-only
      // hint in the decline text. The -shm is NEVER touched pre-open
      // (self-reconciling; moving it under a concurrent multiprocess-WAL reader
      // is corruption — that branch stays in the catch).
      //
      // (BUG-007, adapter-race-fix §6c) The reconcile is QUiescence-gated: under
      // concurrency the first opener's rename of a LIVE store's coordination
      // sidecar is exactly what makes every sibling open short-read (or fail
      // outright). With a live peer the rename is a `log.debug`-only SKIP — not
      // damage, not repair, no integrity report. Only a quiescent store is
      // reconciled proactively.
      if (canonicalDb !== undefined && lease) {
        const quiescence = storeQuiescence(canonicalDb, lease.token);
        const proactive = proactivelyReconcileStaleSidecar(canonicalDb, {
          storeInUse: !quiescence.quiescent,
        });
        if (proactive.moved && proactive.to) {
          emitIntegrityReport(
            canonicalDb,
            'repaired',
            `[BL-373] stale -tshm reconciled BEFORE the open: moved aside to ${proactive.to} — ` +
              `the open proceeds against the existing WAL, no failed-open path`,
          );
        } else if (quiescence.livePeers.length > 0) {
          log.debug('store_adapter.turso.sidecar_reconcile_deferred', {
            detail: `-tshm reconcile skipped: ${quiescence.livePeers.length} live connection(s) hold the store`,
          });
        }

        // (BL-591) Sweep on EVERY open, not only when THIS open happened to
        // rename something.
        //
        // The sweep was originally nested inside the `proactive.moved` branch
        // above, on the reasoning that a rename is "the moment retention needs
        // re-evaluating". That made it inert in production, and measurably so:
        // across 2026-08-18 the live memory-server logged 543
        // `close_tshm_reset` events (the close/recover path, which is what
        // actually creates `.stale-*` debris once an idle flush takes the WAL
        // to 0) and 74 `sidecar_reconcile_deferred` — but ZERO `sidecar_sweep`
        // of any kind, while the on-disk debris grew past 240 files / 20 MB.
        //
        // The producer and the collector were on different paths. A long-lived
        // server holds the store, so this pre-open reconcile is usually
        // DEFERRED (`livePeers.length > 0`) and its moved-branch never runs,
        // while the debris keeps accumulating from close-time. Hoisting the
        // call out of that branch attaches the collector to something that
        // actually happens: every open.
        //
        // Cost is unchanged in the common case — `maybePruneStaleTshmSidecars`
        // throttles real directory scans to one per 10 minutes per store, so
        // this is one extra stat() per open, which is what its own rate-limit
        // design already assumed it would be paying.
        const sweep = maybePruneStaleTshmSidecars(canonicalDb, {
          log: (msg) => log.debug('store_adapter.turso.sidecar_sweep', { detail: msg }),
        });
        if (sweep && sweep.pruned > 0) {
          log.info('store_adapter.turso.sidecar_sweep_pruned', {
            detail: `pruned ${sweep.pruned} stale WAL-index sidecar(s) beyond retention beside ${canonicalDb} (BL-591)`,
          });
        }
      }

      // (BL-508) Was the db file already there before this open? `ensureEngineMarker`
      // needs to know whether the store is FRESH (created by this very open → this
      // engine owns it) or LEGACY (unmarked → infer the owning engine before stamping).
      const fileExisted = canonicalDb !== undefined && existsSync(canonicalDb);

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
        //
        // (BL-373 third recurrence) A non-empty WAL is no longer an automatic
        // decline: the content-deadness discriminator in `recoverStaleWalIndex`
        // moves a CONTENT-PROVEN-DEAD sidecar even over a multi-hundred-KB WAL
        // (the Aug-1/Aug-3/Aug-11 shape: `-tshm` indexing a frame offset beyond
        // the WAL EOF, every fresh open failing with a short read). The WAL
        // itself is never touched by sidecar recovery — reopen against it
        // as-is. If the reopen STILL fails on a probe-truncated WAL (Shape B),
        // that is REFUSAL-ONLY (ADR-0013, owner directive): the operator gets
        // the typed action naming the manual step with the data-loss disclosure
        // — moving the WAL is a human decision, never an automatic one.
        // (BUG014.T4) The guard keys off the CANONICAL identity — a url-only
        // connect (no local db) has nothing to recover.
        if (!isStaleWalIndexError(err) || canonicalDb === undefined) throw err;

        // (BUG-009, adapter-race-fix §6d) The catch is now quiescence-gated.
        // A store with a live peer is NOT stale/corrupt — the frame short-read
        // is the transient close()-TRUNCATE race (a sibling's TRUNCATE zeroes
        // the -wal mid-pread). Never recover, never classify as corruption,
        // never rename -tshm/-shm, never wrap in describeStaleWalIndexFailure:
        // retry the open with the same bounded budget the handshake race uses.
        // Exhaustion surfaces the ORIGINAL driver error marked retryable
        // (ADR-0012 §4 — the caller decides beyond this bound).
        const quiescence = storeQuiescence(canonicalDb, lease?.token);

        if (!quiescence.quiescent) {
          // (BUG-014/DEBT-003) CONTENT-DEAD RECONCILE UNDER A LIVE PEER —
          // BEFORE the BUG-009 transient-retry branch. The lease-gate's
          // premise — "a live peer may be using this -tshm" — is FALSE for a
          // tshm that is CONTENT-PROVEN DEAD (the -wal is 0 bytes/absent, or
          // the tshm's own snapshot indexes a frame offset beyond the WAL
          // EOF): no live connection can be reading frames a WAL of that size
          // cannot contain (proven safe under a live peer by triage Probe D
          // on the live-store copies). Without this, a stale tshm surviving a
          // close()-TRUNCATE deadlocks every fresh open under server leases —
          // the BUG-009 retry branch is PROVABLY non-transient for this state
          // (identical short-read on every attempt, budget burned on a
          // guaranteed failure, live 5/5). Only a tshm that is NOT proven
          // dead (a genuinely fresh index) keeps the defer-and-retry behavior
          // below — the BUG-007 guard is intact.
          //
          // (SPEC §T2 Change 1) The probe is `isTshmContentDead`: statSync
          // `-wal` size (0 or ENOENT ⇒ dead) else probeWalFrames'
          // first-indexed-offset vs WAL EOF — never the mtime heuristic.
          const contentDead = isTshmContentDead(canonicalDb);
          let reconcileFailed: unknown = null;
          // The reconcile's own result, preserved for the typed operator
          // error on exhaustion (a fresh call would report "no -tshm
          // present" — it was already moved; the original result narrates
          // what actually happened).
          let contentDeadRecovery: ReturnType<typeof recoverStaleWalIndex> | null = null;
          if (contentDead.dead) {
            log.warn('store_adapter.turso.open_shortread_contentdead_reconcile', {
              detail: `-tshm is content-proven dead: ${contentDead.reason}; reconciling even though a live peer holds the store`,
            });
            // (SPEC §T2 Change 2) content-deadness is the gate, not
            // quiescence: recoverStaleWalIndex in
            // { allowUnderLivePeers: true, requireContentDead: true } mode.
            const recovery = recoverStaleWalIndex(canonicalDb, {
              allowUnderLivePeers: true,
              requireContentDead: true,
            });
            contentDeadRecovery = recovery;
            if (recovery.movedAside.length > 0) {
              emitIntegrityReport(
                canonicalDb,
                'repaired',
                `[BUG-014/DEBT-003] content-proven-dead -tshm reconciled under a live peer: moved aside ` +
                  `${recovery.movedAside.map((m) => m.to).join(', ')} — ${contentDead.reason}. ` +
                  `The open retries against the fresh sidecar.`,
              );
              try {
                db = await openOnce();
              } catch (reopenErr) {
                // The reconcile did not cure the open (a transient race may
                // overlap) — the bounded retry loop below takes over with
                // this error as its baseline.
                reconcileFailed = reopenErr;
              }
            } else {
              log.debug('store_adapter.turso.open_shortread_contentdead_nothing_to_move', {
                detail: `content-dead -tshm had nothing to move: ${recovery.declined ?? 'unknown reason'}`,
              });
            }
          }

          if (reconcileFailed === null && db !== undefined) {
            // The content-dead reconcile cured the open — the fresh sidecar
            // was rebuilt and the reopen landed. Skip the retry loop.
          } else {
            // (SPEC §T2 Change 3) Content-live, or a reconcile that did not
            // cure the open: keep the bounded retry — the genuine
            // close()-TRUNCATE transient race. (SPEC §T2 Change 4) The log
            // serializes the LATEST error (`lastError`), never the original
            // `err`, so operators see the failure class change mid-retry.
            let lastError: unknown = reconcileFailed ?? err;
            for (let attempt = 0; attempt < OPEN_RETRY_MAX_ATTEMPTS - 1; attempt++) {
              const delay = OPEN_RETRY_BACKOFF_START_MS + attempt * OPEN_RETRY_BACKOFF_STEP_MS;
              log.warn('store_adapter.turso.open_shortread_transient_retry', {
                attempt: attempt + 1,
                max_attempts: OPEN_RETRY_MAX_ATTEMPTS,
                delay_ms: delay,
                error: (lastError instanceof Error ? lastError.message : String(lastError)).slice(0, 300),
              });
              await new Promise((resolve) => setTimeout(resolve, delay));
              try {
                db = await openOnce();
                lastError = null;
                break;
              } catch (retryErr) {
                lastError = retryErr;
                if (!isStaleWalIndexError(retryErr)) break; // different class — propagate below
              }
            }
            if (lastError !== null) {
              // (SPEC §T2 Change 4) `retryable` is set ONLY for the
              // content-live branch. A content-dead failure AFTER the
              // reconcile is NOT transient — the stale index was already
              // moved; the open failing again means the WAL itself is at
              // fault (Shape B / corruption) and the operator gets the typed
              // error, never a retryable driver error the caller would burn
              // another budget on.
              if (contentDead.dead) {
                throw describeStaleWalIndexFailure(
                  canonicalDb,
                  // (DEBT-003 review finding 1) `contentDeadRecovery` is
                  // assigned unconditionally at the top of the
                  // `if (contentDead.dead)` block above (line 691), so the
                  // former `?? recoverStaleWalIndex(...)` fallback was
                  // unreachable defensive code — a redundant re-probe that
                  // could never fire. The preserved reconcile result is the
                  // only one the typed operator error can truthfully
                  // narrate: a fresh call would report "no -tshm present"
                  // (it was already moved) and mislead the operator.
                  contentDeadRecovery!,
                  lastError,
                  probeWalFrames(canonicalDb + '-wal'),
                );
              }
              if (lastError !== null && typeof lastError === 'object') {
                (lastError as { retryable?: boolean }).retryable = true;
              }
              throw lastError;
            }
            // else: retried open succeeded — fall through to the post-catch
            // ceremony below with `db` assigned.
          }
        } else {
          // Quiescent — the genuinely-stale case (or genuine corruption).
          // Existing recovery logic runs UNCHANGED (the store is quiescent, so
          // reconciling its sidecar cannot race a live peer).
          const recovery = recoverStaleWalIndex(canonicalDb, { storeInUse: false });
          emitIntegrityReport(
            canonicalDb,
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
            // Declined with evidence (the decline text carries the frame probe).
            // Pass the probe onward so the typed operator error also names the
            // WAL-side action when the WAL is genuinely truncated (Shape B) —
            // "truncated WAL + fresh sidecar" is exactly the ambiguous case that
            // goes to the operator.
            throw describeStaleWalIndexFailure(
              canonicalDb,
              recovery,
              err,
              probeWalFrames(canonicalDb + '-wal'),
            );
          }

          try {
            db = await openOnce();
          } catch (retryErr) {
            // Sidecar moved aside but the open STILL fails. Shape B is refusal-
            // only: the frame probe's evidence rides the thrown typed error,
            // which names the exact manual operator step (`mv …-wal …-wal.corrupt-<stamp>`
            // or restore from backup) with the data-loss disclosure. Never an
            // automatic WAL move — a store that cannot open loses nothing by
            // waiting, and data-loss decisions are human (ADR-0013).
            throw describeStaleWalIndexFailure(
              canonicalDb,
              recovery,
              retryErr,
              probeWalFrames(canonicalDb + '-wal'),
            );
          }
          emitIntegrityReport(
            canonicalDb,
            'repaired',
            `[BL-373] store opened after reconciling the stale WAL-index sidecar`,
          );
        }
      }

      // (BL-508) FOREIGN-ENGINE REFUSAL, BEFORE the driver even opens the file: a
      // store whose marker claims SQLite ownership must not be opened by the Turso
      // adapter — cross-engine WAL coordination is exactly what destroyed stores in
      // the incident this guard exists for. The probe is a pure header read of
      // `application_id` (fs-level, no schema touch, no driver, no sidecars).
      // Unmarked legacy stores are NOT refused (backfill on next sox open), and
      // the deliberate-migration escape hatch (`allowForeignEngine: true` — the
      // factory's `migrateOnAdapterChange` path) proceeds.
      if (canonicalDb !== undefined && opts.readonly !== true && opts.allowForeignEngine !== true) {
        const appId = readApplicationId(canonicalDb);
        if (appId === SOX_APP_ID_SQLITE) {
          throw new ESqliteNativeStore(canonicalDb, 'sqlite');
        }
      }

      // (SOXGRAPH-001) Probe recursive-CTE support ONCE at connect, before the
      // capabilities object is built. Turso Database Rust < 0.8.0 rejects
      // `WITH RECURSIVE` at prepare (`Parse error`) while SQLite and Turso
      // >= 0.8.0 accept it — proven empirically by
      // `recursive-cte.probe.test.ts`. graph-store reads
      // `capabilities.recursiveCte` to pick its iterative fallbacks for the
      // five recursive-graph methods; a wrong TRUE here would send raw
      // recursive SQL at a 0.7.x Turso store and every one of those methods
      // would throw. A single read-only counter CTE in a try/catch settles it;
      // the result is cached in the capabilities object below (the instance's
      // only cache — `capabilities` is captured at construction).
      let recursiveCte = false;
      try {
        await db.get(
          `WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 5) SELECT x FROM cnt`,
        );
        recursiveCte = true;
      } catch (err) {
        // Feature probe — a 0.7.x Turso rejects WITH RECURSIVE; that is the
        // expected false. Any OTHER failure is still worth a trace.
        log.debug('store_adapter.turso.recursive_cte_probe_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        recursiveCte = false;
      }

      const config = TursoAdapterImpl._buildConfig(opts, canonicalDb, mode);

      const capabilities: AdapterCapabilities = {
        // (BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001) Declared mode +
        // derived flag. `walModeVerified` is set post-open once the -tshm
        // coordinator is confirmed (see the verification block before
        // `return instance`); it reads `null` until then.
        walMode: mode,
        walModeVerified: null,
        multiprocessWrite: mode === 'multiprocess-wal',
        nativeVectors: true,
        concurrentTransactions: true,
        fts5: false,
        fts: true,
        needsWriteSerialization: false,
        recursiveCte,
      };

      const instance = new TursoAdapterImpl(db, config, capabilities);
      instance._softReadonly = softReadonly;

      // (BL-373 family) The open SUCCEEDED despite a mtime-skewed sidecar — the
      // masked case. warnIfStaleSidecar fires only on mtime-skew (informational
      // only, BUG014.T3 — it never renames anything), so a healthy sidecar emits
      // nothing. Never throws.
      // (BUG014.T4) The probe keys off the CANONICAL identity — a url-only
      // connect (no local db) has no sidecars to probe.
      warnIfStaleSidecar(canonicalDb);

      // (BL-508) Engine marker on first open (idempotent; fresh turso stores
      // and legacy unmarked stores inferred turso get stamped here).
      if (canonicalDb !== undefined && opts.readonly !== true) {
        await ensureEngineMarker(instance, 'turso', canonicalDb, { fresh: !fileExisted });
      }

      // (BL-361) The store is now open, so this session owns it. The marker is
      // what tells the NEXT open that this session may not have ended cleanly —
      // `close()` clears it. It lives outside the database on purpose: the state
      // it guards against is one where the database cannot be read at all.
      // (BUG014.T5) PER-CONNECTION: the marker is `<leaseDir>/<token>.openmark`
      // carrying this pid, so a sibling connection's orderly close can never
      // erase this session's crash evidence (the shared-marker failure).
      if (opts.readonly !== true) markStoreOpen(canonicalDb, lease?.token);

      // (BL-461) IN-PROCESS FTS ORPHAN GUARD. The pre-flight above is gated on
      // the marker, so it never runs for a store damaged inside a session that
      // afterwards closed cleanly — and that store still reaches `fts_match` and
      // aborts this process. This guard is unconditional and closes that hole
      // from inside the connection that is already open: `sqlite_master` reads,
      // `CREATE INDEX … USING fts` and `DROP INDEX` are all measured safe on a
      // store in this state; only `fts_match` panics, and nothing has issued one
      // yet at this line. It MUST stay above `runOpenTimeIntegrity` —
      // `probeFtsIndexes` is the caller that issues that statement.
      //
      // Repair builds the replacement BEFORE destroying the orphan (see
      // fts-orphan-guard.ts for the measurements and for why a failed build still
      // drops). Read-only opens detect and report but never write.
      {
        const guard = await guardOrphanedFtsIndexes(instance, { repair: opts.readonly !== true });
        if (guard.orphaned.length > 0) {
          emitIntegrityReport(
            canonicalDb ?? opts.url,
            opts.readonly === true ? 'damaged' : guardSucceeded(guard) ? 'repaired' : 'repair_failed',
            describeFtsOrphanGuard(guard),
          );
        }
      }

      // Stamp adapter metadata (non-fatal)
      if (!opts.readonly) {
        let uncleanShutdown = false;
        try {
          await ensureAdapterMetaTable(instance);
          await stampAdapterMeta(instance, 'turso');
          uncleanShutdown = await consumeUncleanShutdownFlag(instance);
        } catch (err) {
          // Non-fatal — but meta stamping failing on every open is a real signal.
          log.warn('store_adapter.turso.adapter_meta_failed', {
            error: err instanceof Error ? err.message : String(err),
          });
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

      // (SPEC-CONN-RECYCLE) Capture the exact `opts` this connect() call
      // received — never reconstructed from `config` (which drops
      // `allowFtsInReadonly`, see the field's doc comment) — so a later
      // reconnect can replay it verbatim through this same connect() path.
      // (BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001) The RESOLVED mode is
      // stamped in so a replay re-validates the same mode rather than
      // re-resolving (which could theoretically drift if env changed mid-process).
      instance._connectOpts = Object.freeze({ ...opts, concurrencyMode: mode });

      instance._lease = lease;

      // (BUG-STOREADAPTER-COORDINATION-PATH-ASYMMETRY) Pin the canonical identity
      // onto the instance. `config.dbPath` keeps the caller's spelling for the
      // driver/replay; every coordination site reads `coordPath` instead.
      instance._canonicalDb = canonicalDb;

      // (idle-flush) Arm the adapter-owned idle WAL flush — the primary WAL
      // durability assurance every consumer inherits automatically, no
      // caller action required. Eligible only for writable (not `readonly`,
      // not soft-readonly) local-file (`canonicalDb` set — i.e. a `dbPath`
      // was given, not a bare remote `url`) connections: a readonly
      // connection cannot checkpoint, and a remote URL has no local
      // lease/quiescence semantics for the gated strategy to check. Armed
      // here (not just from `_trackOp()`'s finally) because a freshly
      // opened, never-yet-used instance never runs a `_trackOp()` cycle on
      // its own — without this line it would idle forever unflushed until
      // its first real operation.
      if (!opts.readonly && canonicalDb !== undefined) {
        instance._idleFlushEnabled = true;
        if (opts.idleFlushMs !== undefined) {
          instance._idleFlushMs = opts.idleFlushMs;
          instance._idleFlushExplicitMs = opts.idleFlushMs;
        }
        if (opts.idleFlushFloorMs !== undefined) instance._idleFlushMs = opts.idleFlushFloorMs;
        if (opts.idleFlushCeilingMs !== undefined) instance._idleFlushCeilingMs = opts.idleFlushCeilingMs;
        if (opts.walFlushStrategy !== undefined) instance._walFlushStrategy = opts.walFlushStrategy;
        instance._armIdleFlush();

        // (wal-cap) Same eligibility as the idle flush, same reasoning —
        // writable local-file connections only. Unlike the idle flush this
        // needs no "arm at connect time" step: it is checked synchronously
        // inside `_trackOp(fn, true)` on every writable operation, so it is
        // live the instant the first write happens; nothing to schedule
        // ahead of time.
        instance._capFlushEnabled = true;
        if (opts.walCapBytes !== undefined) {
          instance._walCapExplicitBytes = opts.walCapBytes;
        }
        if (opts.walCapHeadroomBytes !== undefined) instance._walCapHeadroomBytes = opts.walCapHeadroomBytes;
        if (opts.walCapCeilingBytes !== undefined) instance._walCapCeilingBytes = opts.walCapCeilingBytes;

        // (BUG-026) Arm the WAL-ownership heartbeat — the lifetime check that
        // detects a replaced WAL within one heartbeat, not only at close.
        // Same eligibility as the idle flush; resolved from the explicit opt /
        // the env knob, clamped. Armed here (not just from a fire's re-arm)
        // because a freshly opened instance never runs a `_trackOp()` cycle on
        // its own and must not idle forever un-heartbeat'd.
        instance._walOwnershipHeartbeatEnabled = true;
        instance._walOwnershipHeartbeatMs = resolveWalOwnershipHeartbeatMs(
          opts.walOwnershipHeartbeatMs ?? config.walOwnershipHeartbeatMs,
        );
        instance._armWalOwnershipHeartbeat();
      }

      // (BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001) POST-OPEN VERIFICATION.
      // The mandate (ADR-0012) is not just declared — it is verified. A writable
      // local-file turso open under 'multiprocess-wal' must prove the `-tshm`
      // coordinator sidecar exists (it is created by the first write, which the
      // stamping/integrity ceremony above has already issued). Absent ⇒ the
      // driver did not enable the mandated coordination ⇒ refuse. Skipped for
      // readonly, remote (url-only), and the deliberate-migration escape hatch.
      if (
        mode === 'multiprocess-wal' &&
        canonicalDb !== undefined &&
        opts.readonly !== true &&
        opts.allowForeignEngine !== true
      ) {
        const verified = await verifyMultiprocessWalSidecar(canonicalDb);
        if (!verified) {
          throw new EWalModeUnverified(canonicalDb);
        }
        instance._capabilities = { ...instance._capabilities, walModeVerified: true };
      }

      return instance;
    } catch (err) {
      if (lease) await lease.release().catch(() => {});
      throw err;
    }
  }

  /** (DEBT-003, lazy-connect) Build `config` from `opts` — shared by the
   *  eager `connect()` shell and the real `_openReal()` open so the two can
   *  never diverge. `config.dbPath`, when set, is always the CANONICAL path
   *  (BUG014.T4) — every coordination site downstream reads it, never the
   *  caller's raw spelling. Pure/synchronous — no I/O beyond the
   *  already-computed `canonicalDb`. */
  private static _buildConfig(
    opts: Parameters<typeof TursoAdapterImpl._openReal>[0],
    canonicalDb: string | undefined,
    mode: StoreConcurrencyMode,
  ): AdapterConfig & { type: 'turso' } {
    const config = { type: 'turso' } as AdapterConfig & { type: 'turso' };
    if (opts.url !== undefined) config.url = opts.url;
    // (BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001) Stamp the RESOLVED
    // mode so a caller reading `config.concurrencyMode` sees exactly what it
    // got — the declared-or-default value, never the engine's implicit one.
    config.concurrencyMode = mode;
    // (BUG014.T4) `config.dbPath` is the CANONICAL path — the close path
    // (storeQuiescence, clearStoreOpenMarker, resetTshmAfterTruncate),
    // withConnectionClosedForRepair, and graph-store's repair path all read
    // it from here and therefore inherit the canonical identity.
    if (canonicalDb !== undefined) config.dbPath = canonicalDb;
    if (opts.authToken !== undefined) config.authToken = opts.authToken;
    if (opts.readonly !== undefined) config.readonly = opts.readonly;
    if (opts.encryption !== undefined) config.encryption = opts.encryption;
    if (opts.defaultQueryTimeout !== undefined) config.defaultQueryTimeout = opts.defaultQueryTimeout;
    if (opts.walOwnershipHeartbeatMs !== undefined) {
      config.walOwnershipHeartbeatMs = opts.walOwnershipHeartbeatMs;
    }
    return config;
  }

  /**
   * (DEBT-003, lazy-connect, 2026-08-17 — owner directive: "Consumers of
   * store adapter should not have to think about connect / disconnect, that
   * should be automatic under the hood") THE PUBLIC ENTRY POINT. Returns an
   * instance that has opened NO driver connection, acquired NO lease, and
   * run NONE of the real open-time ceremony (BL-361 preflight, BL-373
   * sidecar reconcile, BL-508 engine-marker stamp, BL-461 FTS orphan guard,
   * BL-352 open-time integrity repair, idle-flush/wal-cap arming) — every
   * one of those genuinely requires a connection and now runs exactly once,
   * on the first real operation this instance performs, via
   * `_ensureHealthy()` → `_reconnect()` → `_openReal()` (the SAME recovery
   * path `_poisoned`/`_released` already use — see `_neverOpened`'s doc
   * comment for why there is deliberately no second reopen branch).
   *
   * ONE check stays HERE, eager, before any instance is even constructed:
   * the BL-508 foreign-engine marker refusal. It is a pure `application_id`
   * header read (`readApplicationId`, engine-guard.ts) — filesystem only, no
   * lease, no driver — so it costs nothing to run up front, and "consumers
   * should not have to think about connect" does not mean "an unopenable
   * store should silently defer its failure to whatever random first query
   * happens to run later." `_openReal()` re-checks the SAME marker
   * unconditionally (unchanged from before this feature) — this eager copy
   * is a fail-fast convenience for the deferred-open shell, not a
   * replacement for the real check: the store's marker could in principle
   * change between this call and the eventual first real open, and only the
   * real check runs under the lease that makes that check meaningful.
   *
   * Every OTHER fail-closed case in `_openReal()` — BL-361's out-of-process
   * schema pre-flight, BL-373's stale-sidecar reconcile/retry, the
   * `WITH RECURSIVE` capability probe, BL-461's FTS orphan guard, BL-352's
   * integrity repair — genuinely requires a live connection (several also
   * require the lease `_openReal()` acquires, which this method deliberately
   * does NOT acquire — an unopened instance holding a lease is exactly the
   * orphaned-lease class this codebase already fights) and therefore moves
   * to the first real operation, surfacing there instead of at `connect()`.
   * See `_openReal()`'s own doc comment for the unchanged mechanics of each.
   *
   * `unwrap()` is the one caller-visible surface that CANNOT be made to work
   * before the first real operation — it is synchronous and returns the
   * live driver handle, which by definition does not exist yet on a
   * never-opened instance. It throws a clear, typed-message error instead of
   * returning a dead/fake handle; see `unwrap()`'s doc comment. `config` and
   * `capabilities` are metadata computed eagerly here (capabilities'
   * `recursiveCte` field is a conservative guess, corrected transparently on
   * first real open) and read correctly by any caller at any time.
   */
  static async connect(
    opts: Parameters<typeof TursoAdapterImpl._openReal>[0],
  ): Promise<TursoAdapterImpl> {
    // (Cheap, synchronous — no I/O) Same precondition `_openReal()` enforces.
    const url = opts.url || opts.dbPath;
    if (!url) {
      throw new Error('TursoAdapter requires either url or dbPath');
    }

    // (BUG014.T4, INV-4) Canonicalize once, exactly as `_openReal()` does —
    // every coordination key downstream (lease dir, open marker, sidecar
    // probes, and this eager preflight) must agree on ONE spelling.
    const canonicalDb = opts.dbPath !== undefined ? canonicalDbPath(opts.dbPath) : undefined;

    // (BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001) Resolve + validate the
    // concurrency mode eagerly — a mismatched declaration fails at connect(),
    // before any deferred open, exactly like the foreign-engine check below.
    const mode: StoreConcurrencyMode = opts.concurrencyMode ?? resolveConcurrencyMode('turso');
    assertValidConcurrencyMode('turso', mode);

    // (BL-508) FOREIGN-ENGINE REFUSAL — see this method's doc comment for
    // why this ONE check runs eagerly instead of deferring to first use.
    if (canonicalDb !== undefined && opts.readonly !== true && opts.allowForeignEngine !== true) {
      const appId = readApplicationId(canonicalDb);
      if (appId === SOX_APP_ID_SQLITE) {
        throw new ESqliteNativeStore(canonicalDb, 'sqlite');
      }
    }

    const config = TursoAdapterImpl._buildConfig(opts, canonicalDb, mode);

    // (DEBT-003) Conservative default — `recursiveCte` is the one capability
    // that genuinely needs a live probe (a real `WITH RECURSIVE` query, see
    // `_openReal()`); every other field is a static, unconditional constant
    // regardless of connection state (see `_openReal()`'s own `capabilities`
    // construction — this mirrors it exactly for every field but
    // `recursiveCte`). `_reconnect()` overwrites this with the real probed
    // value on first open (see `_capabilities`'s doc comment).
    // (BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001) `walModeVerified` is
    // `null` here — the shell has not opened, so the -tshm verification has
    // not run; `_openReal()` sets it to `true` after the first real open.
    const capabilities: AdapterCapabilities = {
      walMode: mode,
      walModeVerified: null,
      multiprocessWrite: mode === 'multiprocess-wal',
      nativeVectors: true,
      concurrentTransactions: true,
      fts5: false,
      fts: true,
      needsWriteSerialization: false,
      recursiveCte: false,
    };

    const instance = new TursoAdapterImpl(createNeverOpenedDb(), config, capabilities);
    instance._softReadonly = opts.readonly === true && opts.allowFtsInReadonly === true;
    instance._canonicalDb = canonicalDb;
    // (SPEC-CONN-RECYCLE) Capture the exact `opts` this call received —
    // frozen verbatim, same as `_openReal()` always has — so `_reconnect()`
    // can replay it through `_openReal()` on first use. The RESOLVED mode is
    // stamped in so the replay re-validates the same mode.
    instance._connectOpts = Object.freeze({ ...opts, concurrencyMode: mode });
    instance._neverOpened = true;

    // (idle-flush / wal-cap — constraint 4) Eligibility is decided from
    // `opts` NOW, exactly as `_openReal()` decides it — but NOT armed: there
    // is nothing to flush on a connection that has never opened. Arming
    // happens naturally the first time `_trackOp()`'s `finally` observes
    // this instance idle, i.e. immediately after the first real operation
    // completes — the same path every ordinary post-open idle period
    // already uses, so no special-case "arm on first open" step is needed.
    if (!opts.readonly && canonicalDb !== undefined) {
      instance._idleFlushEnabled = true;
      if (opts.idleFlushMs !== undefined) {
        instance._idleFlushMs = opts.idleFlushMs;
        instance._idleFlushExplicitMs = opts.idleFlushMs;
      }
      if (opts.idleFlushFloorMs !== undefined) instance._idleFlushMs = opts.idleFlushFloorMs;
      if (opts.idleFlushCeilingMs !== undefined) instance._idleFlushCeilingMs = opts.idleFlushCeilingMs;
      if (opts.walFlushStrategy !== undefined) instance._walFlushStrategy = opts.walFlushStrategy;
      instance._capFlushEnabled = true;
      if (opts.walCapBytes !== undefined) {
        instance._walCapExplicitBytes = opts.walCapBytes;
      }
      if (opts.walCapHeadroomBytes !== undefined) instance._walCapHeadroomBytes = opts.walCapHeadroomBytes;
      if (opts.walCapCeilingBytes !== undefined) instance._walCapCeilingBytes = opts.walCapCeilingBytes;
      // (BUG-026) Heartbeat eligibility + interval resolved eagerly, exactly
      // as `_openReal()` resolves them — but NOT armed here (nothing to
      // heartbeat on a never-opened shell; `_reconnect()` arms it on the first
      // real open).
      instance._walOwnershipHeartbeatEnabled = true;
      instance._walOwnershipHeartbeatMs = resolveWalOwnershipHeartbeatMs(opts.walOwnershipHeartbeatMs);
    }

    return instance;
  }

  /**
   * (DEBT-003, lazy-connect) The one caller-visible surface `connect()`'s
   * doc comment names as unable to "keep working" before the first real
   * operation: `unwrap()` is synchronous and returns the LIVE driver handle,
   * which by construction does not exist yet on a never-opened instance —
   * there is no way to synchronously await the async open this class defers.
   * Throws a clear, actionable error rather than returning `null`/a dead
   * stub/the `NEVER_OPENED_DB` sentinel (any of which would fail far later,
   * at the first real query against it, with a confusing stack). Callers
   * that need the raw handle must perform (and await) any real operation
   * first — `executeGet('SELECT 1')` is the cheapest — which transparently
   * opens the connection via the same `_ensureHealthy()` path every other
   * method uses.
   */
  unwrap(): import('@tursodatabase/database').Database {
    if (this._neverOpened) {
      throw new Error(
        '[DEBT-003] TursoAdapterImpl.unwrap() called before any operation has run — this adapter ' +
          'is lazy-connected and has not opened a driver connection yet. Await a real operation ' +
          "first (e.g. `await adapter.executeGet('SELECT 1')`), then call unwrap().",
      );
    }
    return this.db as import('@tursodatabase/database').Database;
  }

  /**
   * (BL-385) VACUUM INTO, run directly on this adapter's existing connection
   * with its experimental flags (`index_method`, `multiprocess_wal` — both
   * unconditional since BL-512, see `connect()` above). Measured 2026-08-01
   * against a copy of the live
   * store: identical nodes/vec_node/edge counts, identical fts_match hit
   * count, and 19 MB reclaimed — with no new flags required.
   *
   * IMPORTANT: plain in-place `VACUUM` (no INTO) fails on this connection
   * with `Parse error: VACUUM is incompatible with experimental multiprocess
   * WAL`. `VACUUM INTO` has no such restriction — do not "simplify" this to
   * a plain VACUUM.
   */
  async backupTo(destPath: string, opts: AdapterBackupOptions = {}): Promise<AdapterBackupResult> {
    // (idle-release) `_trackOp` both guards against a concurrent
    // `releaseIdleConnection()` tearing this connection down mid-VACUUM and
    // — a pre-existing gap this closes as a side effect — gives `backupTo`
    // poison-reconnect coverage it never had (the previous direct
    // `this.db.exec` call bypassed `_ensureHealthy`/`_markIfFatal` entirely).
    await this._trackOp(async () => {
      try {
        await this.db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
      } catch (err) {
        this._markIfFatal(err);
        throw err;
      }
    });

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
    return this._trackOp(async () => {
      try {
        const row = args !== undefined ? await this.db.get(sql, ...args) : await this.db.get(sql);
        return (row as T | null) ?? null;
      } catch (err) {
        this._markIfFatal(err);
        throw err;
      }
    });
  }

  async executeAll<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<AllResult<T>> {
    return this._trackOp(async () => {
      try {
        const rows = args !== undefined ? await this.db.all(sql, ...args) : await this.db.all(sql);
        const rowsArr = rows as T[];
        const columns = rowsArr.length > 0 ? Object.keys(rowsArr[0] as Record<string, unknown>) : [];
        return { columns, rows: rowsArr };
      } catch (err) {
        this._markIfFatal(err);
        throw err;
      }
    });
  }

  async executeRun(sql: string, args?: unknown[]): Promise<RunResult> {
    this._assertWritable();
    return this._trackOp(async () => {
      try {
        const info = args !== undefined ? await this.db.run(sql, ...args) : await this.db.run(sql);
        return { rowsAffected: info.changes as number, lastInsertRowid: info.lastInsertRowid as number };
      } catch (err) {
        this._markIfFatal(err);
        throw err;
      }
    }, true);
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
    return this._trackOp(async () => {
      try {
        await this.db.exec(sql);
      } catch (err) {
        this._markIfFatal(err);
        throw err;
      }
    }, true);
  }

  /** (SPEC-CONN-RECYCLE) Wired through `_trackOp` (`_ensureHealthy`/
   *  `_markIfFatal`) like every other direct `this.db.*` call site — a
   *  caller that issues a pragma against an already-poisoned OR released
   *  handle mid-session (not just at connection-open time, which is the only
   *  way today's callers use it) must get the same reconnect-then-retry-once
   *  semantics as `exec`/`executeGet`/`executeAll`/`executeRun`, not a
   *  silent query against a dead connection. */
  async pragmaSet(key: string, value: string | number | boolean): Promise<void> {
    return this._trackOp(async () => {
      const boolVal = typeof value === 'boolean' ? (value ? 1 : 0) : value;
      try {
        await this.db.exec(`PRAGMA ${key} = ${boolVal}`);
      } catch (err) {
        this._markIfFatal(err);
        throw err;
      }
    });
  }

  /** (SPEC-CONN-RECYCLE) See `pragmaSet` doc comment — same wiring. */
  async pragmaGet<T = unknown>(key: string): Promise<T> {
    return this._trackOp(async () => {
      try {
        const rows = await this.db.pragma(key, { simple: true });
        return rows as T;
      } catch (err) {
        this._markIfFatal(err);
        throw err;
      }
    });
  }

  async transaction<T>(
    fn: (tx: AdapterTransaction) => T | Promise<T>,
    opts?: TransactionOptions,
  ): Promise<T> {
    this._assertWritable();
    // (BL-321) Serialize the entire BEGIN…COMMIT/ROLLBACK critical section —
    // including retries — against any other concurrent transaction() call on
    // this adapter instance. See `_withTxLock` doc comment above.
    //
    // (idle-release) The WHOLE transaction — not just its opening
    // `_ensureHealthy()` check — is one tracked op: `_inFlightOps` must stay
    // non-zero for the entire BEGIN..COMMIT/ROLLBACK window (including the
    // caller's `fn`), or `releaseIdleConnection()` could tear the connection
    // down between two statements of an in-progress transaction.
    return this._trackOp(() => this._withTxLock(() => this._runTransaction(fn, opts)), true);
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

    // (SPEC-CONN-RECYCLE) A transaction must never BEGIN against a
    // known-poisoned handle — check/reconnect once, up front, before the
    // retry loop.
    await this._ensureHealthy();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      try {
        await this.db.exec(beginSQL);
      } catch (err) {
        this._markIfFatal(err);
        // (SPEC-CONN-RECYCLE) Retrying BEGIN against a connection that just
        // proved fatal cannot succeed — it only delays the caller. Rethrow
        // immediately rather than continuing the retry loop.
        if (isFatalConnectionError(err)) throw err;
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
        this._markIfFatal(err);
        try {
          await this.db.exec('ROLLBACK');
        } catch (rollbackErr) {
          // Ignore rollback errors — but a failed ROLLBACK leaves transaction
          // state uncertain, so trace it even though the original error still
          // propagates below.
          log.debug('store_adapter.turso.rollback_failed', {
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
   *
   * (BL-512) Since 2026-08-12 the checkpoint is UNCONDITIONAL on a writable
   * close — TRUNCATE, not PASSIVE, and not gated on damage. The defect: a
   * clean writable close only marked clean shutdown and closed, so every
   * short-lived process (the backlog CLI spawns one per command) left its
   * writes in the WAL; the WAL grew forever (measured 3.8 MB beside a 19 MB
   * db) and a later connection's stale-`-tshm` reconciliation could discard
   * those uncheckpointed frames — the phantom-write class (created:true, row
   * never persisted; 4+ items lost on the live store). TRUNCATE resets the
   * `-wal` to ~0 bytes so the next open neither replays nor re-accumulates.
   * `_softReadonly` adapters hold a driver-writable connection (BL-391 — FTS
   * requires it), so they checkpoint too; a hard `readonly` open never does.
   */
  /**
   * (idle-release, 2026-08-17 — store-connection-lifetime design) Voluntarily
   * release the underlying driver connection AND this connection's lease-dir
   * entry while KEEPING this adapter instance usable: `closed` stays `false`,
   * and the NEXT call to any query/exec/transaction method transparently
   * reconnects (paying the full `connect()` ceremony — measured ~3-4ms
   * steady-state, `tools/bench-connect-cost.mjs` — before proceeding), via
   * the same `_ensureHealthy()`/`_reconnectPromise` machinery SPEC-CONN-
   * RECYCLE already uses for poison recovery.
   *
   * Runs the FULL `close()` ceremony first — PASSIVE checkpoint always, then
   * a quiescence-gated `wal_checkpoint(TRUNCATE)`, driver close, marker
   * clear, lease release — by literally calling `this.close()` and then
   * un-setting `closed`. This is deliberate reuse, not parallel
   * reimplementation: every durability guarantee `close()` already has
   * (BL-330 orphaned-WAL PASSIVE backstop, BUG-008 single-TRUNCATE-per-close,
   * the BUG-STOREADAPTER-QUIESCENCE-TOCTOU detector) applies unchanged to a
   * release.
   *
   * Intended for a long-lived caller (e.g. a `backlog serve` process) that
   * holds a connection open for its whole session but is idle between
   * requests. Releasing during an idle period drops THIS connection's lease
   * entry — which is what lets ANOTHER connection's close()-time TRUNCATE
   * find a genuinely quiescent store instead of deferring forever (the 1,409
   * `store_adapter.turso.close_checkpoint_busy` events, 2026-08-12..17, root-
   * caused to idle-held `serve` connections never releasing —
   * `docs/reporting/memory/findings/2026-08-17-store-connection-lifetime-forensics.md`).
   *
   * Returns `false` (no-op, nothing changed) rather than throwing when a
   * release is not currently possible:
   *  - already permanently closed (`this.closed`) — call `close()` instead;
   *  - already released (`this._released`) — idempotent, avoids a caller's
   *    own idle-timer double-firing paying two teardown cycles;
   *  - a reconnect is already in flight (`this._reconnectPromise`) — don't
   *    race it, whatever triggered it (poison OR a prior release) owns the
   *    transition;
   *  - an operation is currently executing on this connection
   *    (`this._inFlightOps > 0`) — NEVER releases mid-request, including
   *    mid-transaction (the whole `transaction()` call is one tracked op).
   * Returns `true` once the release has completed. A caller with an idle
   * timer should treat `false` as "try again on the next tick," not as an
   * error.
   */
  async releaseIdleConnection(): Promise<boolean> {
    if (this.closed || this._released || this._reconnectPromise || this._inFlightOps > 0) {
      return false;
    }
    await this.close();
    // `close()` sets `closed = true` — undo that so this instance stays
    // usable. `close()` already nulled `this._lease` as part of its own
    // teardown; `_reconnect()` (triggered by `_ensureHealthy()` on the next
    // operation) adopts a fresh one, see its doc comment for why that must
    // differ from poison recovery's lease handling.
    this.closed = false;
    this._released = true;
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // (DEBT-003, lazy-connect) An instance that was constructed via
    // `connect()` and closed WITHOUT ever performing an operation has no
    // driver connection, no lease, no marker, and no idle-flush timer to
    // tear down — `this.db` still holds the `NEVER_OPENED_DB` sentinel.
    // Every line below this point either directly calls `this.db.*` or
    // assumes a real `_lease`/`coordPath` from a completed open; running any
    // of it here would either throw against the sentinel or silently no-op
    // against state that was never populated. Short-circuit before any of
    // that — closing a never-used adapter is a legitimate, common shape
    // (e.g. an error-handling path that connects and immediately closes)
    // and must cost nothing.
    if (this._neverOpened) {
      this.closed = true;
      this._neverOpened = false;
      return;
    }
    this.closed = true;
    // (idle-flush) A direct `close()` call (not the `_performIdleFlush()`
    // path, which has already nulled the timer before invoking
    // `releaseIdleConnection()`) may still have a flush armed — cancel it so
    // a stray fire never runs `releaseIdleConnection()` against an adapter
    // that is now permanently closed (harmless either way — `_performIdleFlush`
    // re-checks `this.closed` at fire time — but this avoids the dead timer
    // lingering at all).
    this._cancelIdleFlush();
    // (BUG-026) Cancel the WAL-ownership heartbeat too — the connection is
    // about to close, so a heartbeat firing afterward would checkpoint a dead
    // (or handed-back) handle. `_reconnect()` re-arms it on recycle.
    this._cancelWalOwnershipHeartbeat();

    // (BL-512) "Writable" for checkpoint purposes means the connection can
    // write: `!config.readonly` (the historical gate), PLUS soft-readonly
    // (BL-391 — opened without the native readonly option so `fts_match`
    // works, enforced read-only only at the application layer).
    const writableClose = !this.config.readonly || this._softReadonly;
    if (writableClose) {
      try {
        const report = await verifyStoreIntegrity(this, {
          only: ['wal_identity'],
          walBaseline: this._walBaseline,
        });
        const damaged = report.damaged.length > 0;
        for (const finding of report.damaged) {
          // (BUG-STOREADAPTER-COORDINATION-PATH-ASYMMETRY) Canonical: integrity
          // reports are keyed by this string, so two spellings of one store would
          // fragment its history into two unrelated-looking timelines.
          emitIntegrityReport(this.coordPath ?? this.config.url, 'damaged', finding.detail);
        }

        // (BL-330) PASSIVE is the durability backstop and runs ALWAYS: it copies
        // WAL frames into the main db through the fd we already hold, even when
        // the WAL was unlinked or a concurrent reader holds it. Never truncates.
        let passiveOk = false;
        try {
          await this.executeAll('PRAGMA wal_checkpoint(PASSIVE)');
          passiveOk = true;
        } catch (passiveErr) {
          this.reportFailedPassiveCheckpoint(passiveErr, damaged);
        }

        // (BL-330) The orphaned-WAL recovery report rides the PASSIVE result.
        if (damaged && passiveOk) {
          emitIntegrityReport(
            this.coordPath ?? this.config.url,
            'repaired',
            'checkpointed the orphaned WAL into the main database file before close',
          );
        }

        // (BL-512) Clean-shutdown stamp — written BEFORE the TRUNCATE so the
        // stamp's single frame is flushed by the SAME truncate (this is the
        // BUG-008 double-truncate fix: exactly one TRUNCATE per close, never two).
        // Gated on !damaged exactly as before.
        if (!damaged) {
          await markCleanShutdown(this);
        }

        // (BUG-008) The single TRUNCATE — quiescence-gated. TRUNCATE physically
        // zeroes the -wal (turso wal.rs:5208), which races a concurrent opener's
        // frame pread. Issue it ONLY when no other live connection holds the
        // store. Under contention: defer (frames stay durable; the next
        // quiescent close truncates) — same degradation the busy=1 path already
        // accepted, now decided BEFORE the truncate instead of reported after.
        // (BUG-STOREADAPTER-COORDINATION-PATH-ASYMMETRY) MUST be the canonical
        // identity: the lease this gate looks for was taken under it. Reading the
        // raw spelling here found an empty lease dir and truncated the WAL under
        // live peers — the #7833 trigger, with no race required.
        const coordDb = this.coordPath;
        if (coordDb && this._lease) {
          const quiescence = storeQuiescence(coordDb, this._lease.token);
          if (!quiescence.quiescent) {
            log.warn('store_adapter.turso.close_checkpoint_busy', {
              detail:
                `another connection holds the store; -wal was NOT truncated (frames remain durable; ` +
                `the next writable close without a concurrent connection truncates)`,
            });
          } else {
            try {
              const truncate = await this.executeAll<{ busy?: number }>(
                'PRAGMA wal_checkpoint(TRUNCATE)',
              );

              // (BUG-STOREADAPTER-QUIESCENCE-TOCTOU) DETECTION, not prevention.
              //
              // `storeQuiescence` above is a point-in-time readdirSync and no
              // lock spans the gap to the TRUNCATE that just ran, so a peer
              // whose connect() reached `acquireStoreLease` inside that window
              // was invisible to the decision. The gap is structurally real:
              // with the seam deliberately widened, the truncate reaches the
              // driver with peer leases present.
              //
              // It is NOT known to be reachable naturally. Measured 2026-08-14:
              // 40/40 barrier-synchronized two-process rounds (child pre-warmed,
              // released in the same tick as the close) and 25/25 in-process
              // rounds completed with zero silent loss and zero panics. The
              // window is narrow because `acquireStoreLease` runs very early in
              // connect, long before the peer depends on WAL contents.
              //
              // A lock spanning check->act was deliberately NOT added. It would
              // introduce a stale-lock failure mode after a crash — and on this
              // system native turso panics are a demonstrated event class, so a
              // lock left behind by one could block every subsequent open. That
              // is a worse, and provably reachable, failure than the theoretical
              // one it would prevent.
              //
              // So: observe instead. If a peer appeared across the truncate,
              // say so loudly. If this ever fires in production it is the
              // evidence that would justify the lock; until then, silence here
              // is itself the measurement.
              const post = storeQuiescence(coordDb, this._lease.token);
              if (!post.quiescent) {
                log.warn('store_adapter.turso.close_truncate_toctou_window_observed', {
                  db_path: coordDb,
                  peer_count: post.livePeers.length,
                  peer_pids: post.livePeers.map((p) => p.pid).join(','),
                  detail:
                    `a peer registered a lease BETWEEN the pre-TRUNCATE quiescence check and the ` +
                    `completed wal_checkpoint(TRUNCATE) — the check-then-act window was hit. The ` +
                    `WAL was truncated while this peer was opening. If you are seeing this, ` +
                    `BUG-STOREADAPTER-QUIESCENCE-TOCTOU is reachable in practice and the gate ` +
                    `needs a lock spanning check->act, not just this detector.`,
                });
              }

              if (truncate.rows[0]?.busy === 1) {
                log.warn('store_adapter.turso.close_checkpoint_busy', {
                  detail:
                    'another connection held the WAL; -wal was NOT truncated (frames remain durable; the next writable close without a concurrent reader truncates)',
                });
              } else {
                // (BUG-014/DEBT-003) The TRUNCATE succeeded (busy=0) — the
                // -wal is 0 bytes, so the -tshm this close just orphaned
                // indexes frames the WAL no longer holds. Reset it so the
                // stale-index state never persists (the root-cause complement
                // to the open-time content-dead reconcile).
                this.resetTshmAfterTruncate();
              }
            } catch (truncateErr) {
              log.warn('store_adapter.turso.close_checkpoint_truncate_failed', {
                error: truncateErr instanceof Error ? truncateErr.message : String(truncateErr),
              });
              try {
                await this.executeAll('PRAGMA wal_checkpoint(PASSIVE)');
              } catch (passiveErr) {
                this.reportFailedPassiveCheckpoint(passiveErr, damaged);
              }
            }
          }
        } else {
          // Remote URL or no lease — truncate as before (single attempt).
          try {
            const truncate = await this.executeAll<{ busy?: number }>(
              'PRAGMA wal_checkpoint(TRUNCATE)',
            );
            if (truncate.rows[0]?.busy === 1) {
              log.warn('store_adapter.turso.close_checkpoint_busy', {
                detail:
                  'another connection held the WAL; -wal was NOT truncated (frames remain durable; the next writable close without a concurrent reader truncates)',
              });
            } else {
              // (BUG-014/DEBT-003) Same tshm-reset as the quiescent branch —
              // the TRUNCATE succeeded, so the -tshm indexes frames the
              // now-empty -wal cannot contain. No-op for remote URLs (no
              // local dbPath).
              this.resetTshmAfterTruncate();
            }
          } catch (truncateErr) {
            log.warn('store_adapter.turso.close_checkpoint_truncate_failed', {
              error: truncateErr instanceof Error ? truncateErr.message : String(truncateErr),
            });
            try {
              await this.executeAll('PRAGMA wal_checkpoint(PASSIVE)');
            } catch (passiveErr) {
              this.reportFailedPassiveCheckpoint(passiveErr, damaged);
            }
          }
        }
      } catch (err) {
        // A verification failure must never block a close — but it is a
        // data-loss-adjacent signal (BL-330) and must be durable, not silent.
        log.warn('store_adapter.turso.close_verify_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // (BUG-STOREADAPTER-CLOSE-THROW-STRANDS-MARKER-AND-LEASE) The driver close
    // sits in a `try` whose `finally` ALWAYS runs the cleanup below. Previously
    // `await this.db.close()` was unguarded, so a throwing close skipped both
    // the marker unlink and the lease release: the process exited still holding
    // a store-open marker and a live lease, and the strand was invisible because
    // the error surfaced as an ordinary close failure and the orphan was only
    // noticed at the NEXT open.
    //
    // The ordering rationale below is unchanged and still correct — marker and
    // lease must drop AFTER the driver has let go. `finally` preserves that: the
    // close has been awaited (successfully or not) before either line runs.
    //
    // The close error still propagates. This is deliberately NOT a swallow: the
    // point is that cleanup becomes unconditional, not that failure becomes
    // silent.
    try {
      await this.db.close();
    } finally {
      try {
        // (BL-361) Orderly close — drop THIS connection's out-of-band marker last,
        // after the driver has actually let go of the file. Its presence at the
        // next open is the ONLY signal that a session ended without getting here,
        // and that is the population that can carry the panic-on-open schema state.
        // (BUG014.T5) Unlink only THIS connection's marker (`<leaseDir>/<token>.openmark`)
        // — never a sibling's: a peer's crash evidence must survive this close.
        // (BUG-STOREADAPTER-COORDINATION-PATH-ASYMMETRY) Clear under the CANONICAL
        // path — `markStoreOpen` wrote it there. Clearing the raw spelling left the
        // marker in place on every orderly close.
        if (!this.config.readonly) clearStoreOpenMarker(this.coordPath, this._lease?.token);
      } catch (markerErr) {
        // Cleanup failure must never mask the original close error (which, if
        // there is one, is propagating through this same `finally`).
        log.warn('store_adapter.turso.close_marker_clear_failed', {
          error: markerErr instanceof Error ? markerErr.message : String(markerErr),
        });
      }

      // (BUG-007/008) Release the lease LAST, after the driver has let go.
      if (this._lease) {
        await this._lease.release().catch((leaseErr: unknown) => {
          log.warn('store_adapter.turso.close_lease_release_failed', {
            error: leaseErr instanceof Error ? leaseErr.message : String(leaseErr),
          });
        });
        this._lease = null;
      }
    }
  }

  /**
   * (BUG-011) Report a failed PASSIVE checkpoint with an ACCURATE verdict.
   *
   * `PRAGMA wal_checkpoint(PASSIVE)` throwing is NOT by itself data loss:
   * under a contended close (a peer reader pins the WAL, or the closing
   * connection holds its own open read tx) PASSIVE can fail while every
   * frame stays durable in the `-wal` and replays on the next open. The
   * strong "being lost" wording is reserved for the BL-330 orphaned-WAL
   * case, where the frames are genuinely unreachable:
   *
   *  - `walDamaged` — the wal_identity probe (run moments earlier in the
   *    same close) flagged the WAL unlinked or REPLACED under this
   *    connection. The replaced case is why existsSync alone is not enough:
   *    a new `-wal` exists at the path, but this session's frames went to
   *    the orphaned inode.
   *  - `!walPresent` — the `-wal` is absent at the catch site (covers the
   *    no-baseline case where the probe never fired).
   *
   * Otherwise the failure is a durable deferral: emit `checkpoint_deferred`
   * with the "frames remain durable" wording, never `repair_failed`. Remote
   * URLs (no local `dbPath`) keep the pre-BUG-011 wording — the server-side
   * WAL cannot be inspected from here, so nothing is reclassified.
   */
  private reportFailedPassiveCheckpoint(passiveErr: unknown, walDamaged: boolean): void {
    // (BUG-STOREADAPTER-COORDINATION-PATH-ASYMMETRY) Canonical: this probes the
    // real `-wal` on disk and the verdict it produces (`repair_failed` vs
    // `checkpoint_deferred`) is a data-loss signal. A raw spelling that missed
    // the sidecar would report genuine loss on a perfectly healthy store.
    const dbPath = this.coordPath;
    const walPresent = dbPath !== undefined && existsSync(dbPath + '-wal');
    const genuineLoss = walDamaged || !walPresent;
    const detail = passiveErr instanceof Error ? passiveErr.message : String(passiveErr);
    emitIntegrityReport(
      dbPath ?? this.config.url,
      genuineLoss ? 'repair_failed' : 'checkpoint_deferred',
      genuineLoss
        ? `checkpoint of the WAL failed — data since the last checkpoint is being lost: ${detail}`
        : `checkpoint of the WAL failed; frames remain durable in the WAL and replay on the next open (checkpoint deferred): ${detail}`,
    );
  }

  /**
   * (BUG-014/DEBT-003) COMPLEMENT to the BL-512 TRUNCATE-on-close: after a
   * SUCCESSFUL `wal_checkpoint(TRUNCATE)` zeroed the `-wal`, reset the `-tshm`
   * residue this close just orphaned.
   *
   * The TRUNCATE physically zeroes the `-wal` (turso wal.rs:5208) but leaves
   * the `-tshm` — Turso's WAL-index coordination file — on disk, still
   * indexing the frames the empty WAL no longer holds. That frozen residue is
   * what fed the every-minute `.stale-*` self-healing loop on quiescent
   * stores AND the BUG-014 deadlock under live peers (a stale tshm surviving
   * a close()-TRUNCATE makes every fresh open short-read while the 0.5.7
   * lease-gate forbids the reconcile). Moving it aside here — beside the
   * TRUNCATE that orphaned it — means the stale-index state never persists:
   * the next open rebuilds the sidecar from the empty WAL in the normal open
   * path, and the every-minute cycle has no state left to feed on.
   *
   * Called ONLY when the TRUNCATE actually succeeded (busy=0): a deferred
   * TRUNCATE (busy=1) or a failed one leaves the WAL holding frames, so the
   * tshm is still describing real content and must not be touched.
   *
   * Renamed (`.stale-<stamp>`), never deleted — the stale file is the
   * forensic record, matching every other sidecar reconciliation in this
   * package. No-op for remote URLs (no local dbPath) and when no tshm exists.
   */
  private resetTshmAfterTruncate(): void {
    // (BUG-STOREADAPTER-COORDINATION-PATH-ASYMMETRY) Sidecars sit beside the REAL
    // file. Deriving `-tshm` from the caller's spelling can name a path that does
    // not exist (or, through a symlinked parent, a different store's sidecar).
    const coordDb = this.coordPath;
    if (!coordDb) return;
    const tshmPath = coordDb + '-tshm';
    try {
      statSync(tshmPath);
    } catch {
      return; // no residue to reset
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
    const to = `${tshmPath}.stale-${stamp}`;
    try {
      renameSync(tshmPath, to);
      log.debug('store_adapter.turso.close_tshm_reset', {
        detail: `-tshm moved aside after the close()-TRUNCATE: ${to} — the next open rebuilds it from the empty -wal`,
      });
    } catch (err) {
      log.warn('store_adapter.turso.close_tshm_reset_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return; // nothing new was actually created — no reason to sweep
    }

    // (BL-591, second fix) THIS is the dominant producer of `.stale-*` debris
    // in production, not the `_openReal()` pre-open reconcile the sweep was
    // originally (and then, on the first fix, still only) attached to.
    // Measured live on memory-server across 2026-08-18: 543
    // `close_tshm_reset` events here vs 74 `sidecar_reconcile_deferred` in
    // the pre-open path (most of those 74 declined anyway — a long-lived
    // server almost always has itself as a live peer at pre-open time) and
    // ZERO sweeps of any kind. Producer and collector were on genuinely
    // different code paths; a long-lived server's own opens rarely reach the
    // pre-open reconcile in a state where hoisting the call there could ever
    // see a live artefact. This call site fires on the exact event that
    // creates a new artefact, every time, regardless of connection lifetime
    // — which the pre-open path structurally cannot promise.
    //
    // Kept in ADDITION to the `_openReal()` hook (harmless, and covers a
    // rename produced by the pre-open path itself), not instead of it — this
    // is now the primary collector, that one is a backstop.
    //
    // Throttled internally (maybePruneStaleTshmSidecars, ≤1 real scan/10min
    // per store) so this adds at most one stat() to `close()`, which is
    // already the debounce/wal-cap-sensitive path BL-590 is trying to keep
    // cheap — never a full directory scan on every TRUNCATE.
    const sweep = maybePruneStaleTshmSidecars(coordDb, {
      log: (msg) => log.debug('store_adapter.turso.sidecar_sweep', { detail: msg }),
    });
    if (sweep && sweep.pruned > 0) {
      log.info('store_adapter.turso.sidecar_sweep_pruned', {
        detail: `pruned ${sweep.pruned} stale WAL-index sidecar(s) beyond retention beside ${coordDb} (BL-591)`,
      });
    }
  }

  /**
   * (BL-506) Close the current connection, run `fn` against the store file
   * while NO turso connection is open, then reopen through the full
   * `connect()` ceremony — all on THIS instance, so every caller holding
   * this adapter keeps a valid handle.
   *
   * Why this exists: graph-store's FK-heal must delete fts5-residue rows
   * from `sqlite_master` via the better-sqlite3 `writable_schema` escape
   * hatch (the Turso driver hard-refuses `sqlite_master` writes and its
   * DROPs against fts5 objects silently no-op). A better-sqlite3 write must
   * never run while a turso connection holds the file — cross-engine WAL
   * coordination (turso's `-tshm` vs SQLite's `-shm`) is exactly what
   * destroyed stores (BL-508). So: `close()` (checkpoint + driver close +
   * marker clear), `fn()` (the out-of-band repair), then a fresh
   * `connect(this._connectOpts)` whose live state (`db`, `_walBaseline`,
   * `_softReadonly`) is adopted onto `this` — the SPEC-CONN-RECYCLE
   * `_reconnect()` pattern. `config`/`capabilities`/`_connectOpts` describe
   * the adapter's identity and never change, so callers holding references
   * to them never see them change under them.
   *
   * The repair itself is `fn`'s job; this method only guarantees the
   * connection is closed around it and restored after — a repair that
   * throws still gets the reopen in the `finally`, so the adapter is never
   * left dead. If the reopen itself fails, the error propagates (an
   * unreachable store must not fake success).
   *
   * (BUG-017, INV-1) Before `fn()` runs — after the OWN connection is closed —
   * the store is checked for quiescence. A WRITABLE classic-engine repair
   * while live turso multiprocess peers hold the store is the exp9 poisoner
   * (classic SQLite cannot see `-tshm` clients; a writable open+close
   * checkpoints/deletes the WAL). Under live peers this throws a typed
   * {@link RepairDeclinedLivePeersError} carrying the peer count + pids; the
   * caller decides (graph-store logs and skips the drop — the pre-BL-506
   * degradation, which is safe). The own lease token is captured BEFORE
   * `close()` (close releases it and nulls `this._lease`), so the probe
   * excludes exactly this instance's own entry. The reopen in the `finally`
   * still runs — the adapter handle stays live.
   */
  async withConnectionClosedForRepair<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) {
      throw new Error(
        'withConnectionClosedForRepair: the adapter is already closed and cannot be reopened',
      );
    }
    // (idle-release) Bump `_inFlightOps` for the WHOLE close-repair-reopen
    // window so a concurrent `releaseIdleConnection()` call cannot interleave
    // with it — two independent close/reopen cycles racing on the same `db`/
    // `_lease` fields would corrupt adapter state, not just the store.
    this._inFlightOps++;
    try {
      // (idle-release) A prior `releaseIdleConnection()` may have left this
      // instance disguised as open (`closed === false`, per its own
      // contract) with a torn-down driver handle underneath. Reconnect
      // transparently first — the repair's own close()/reopen dance below
      // assumes a LIVE connection to close, not an already-dead one; calling
      // `close()` twice against the same driver handle would throw.
      await this._ensureHealthy();
      // (BUG-STOREADAPTER-COORDINATION-PATH-ASYMMETRY) Canonical: this value feeds
      // the `storeQuiescence` gate below that authorizes a WRITABLE classic-engine
      // repair. Reading the raw spelling would let that gate consult a lease
      // directory no peer ever wrote to — the worst possible place for this bug.
      const repairDbPath = this.coordPath;
      const ownLeaseToken = this._lease?.token;
      await this.close(); // full clean-close ceremony (checkpoint, driver close, marker clear)
      try {
        // (BUG-017 review fix) The quiescence probe is LOCAL-FILE-only. A
        // URL-only connection (`dbPath === undefined`) is exempt: the exp9
        // poisoner is a WRITABLE classic open against a LOCAL store file whose
        // WAL/`-tshm` coordination it cannot see — a remote URL has no local
        // store file to poison, so there is nothing for this gate to protect
        // (and leases are never acquired for URLs; store-lease.ts:16). No
        // production caller reaches this branch with a better-sqlite3 drop
        // anyway — graph-store early-returns on `cfg.dbPath === undefined`
        // (index.ts:1274) — so INV-1 is not bypassed.
        if (repairDbPath !== undefined) {
          const quiescence = storeQuiescence(repairDbPath, ownLeaseToken);
          if (!quiescence.quiescent) {
            throw new RepairDeclinedLivePeersError(repairDbPath, quiescence.livePeers);
          }
        }
        return await fn();
      } finally {
        // (DEBT-003, lazy-connect) Must call `_openReal()`, not the public
        // `connect()` — `connect()` is now the LAZY entry point and would
        // hand back a never-opened shell instead of an actually-reopened
        // connection, which is exactly what this `finally` needs (the
        // caller keeps using `this` immediately after this returns).
        const fresh = await TursoAdapterImpl._openReal(this._connectOpts);
        this.db = fresh.db;
        this._lease = fresh._lease;
        // (BUG-STOREADAPTER-COORDINATION-PATH-ASYMMETRY) Adopt the fresh instance's
        // canonical identity alongside its lease. The two are a pair: `_lease` was
        // taken under `_canonicalDb`, so carrying one without the other would point
        // this connection's coordination at a directory its own lease is not in.
        this._canonicalDb = fresh._canonicalDb;
        this._walBaseline = fresh._walBaseline;
        this._softReadonly = fresh._softReadonly;
        this._capabilities = fresh._capabilities;
        this._poisoned = false;
        this._released = false; // (idle-release) defense-in-depth — should already be false
        this._neverOpened = false; // (DEBT-003) defense-in-depth — should already be false
        this.closed = false; // the fresh connection is live; close() set this true
      }
    } finally {
      this._inFlightOps--;
    }
  }
}
