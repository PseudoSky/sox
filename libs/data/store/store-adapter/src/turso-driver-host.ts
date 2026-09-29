/**
 * turso-driver-host.ts — the process-wide, off-thread Turso driver host (plan
 * `862129b5`, packet **TUR-C**).
 *
 * This module is the main-thread half of the off-thread Turso driver. It owns a
 * SINGLETON `worker_threads.Worker` (TUR-B's `turso-driver-worker.js` sidecar)
 * that is the only place the native `@tursodatabase/database` driver is loaded,
 * and it exposes an async, connection-shaped RPC onto that worker so the
 * adapters (TUR-D) can keep their existing `db.run/get/all/exec/pragma` call
 * sites with no cross-thread concerns leaking into them.
 *
 * ## Why the host is a `globalThis` singleton (ADR-0018 pattern)
 *
 * A single process can contain more than one module instance of this package —
 * a top-level copy plus a nested copy under a dependency's own `node_modules`.
 * A module-level `let worker` binding would then be a *per-copy* singleton: the
 * nested copy would lazily spawn a SECOND native driver worker, and two worker
 * threads driving the same store is exactly the multi-open hazard this design
 * exists to remove. So the worker lives in ONE object keyed on
 * `globalThis[Symbol.for('@adhd/sox-store-adapter/turso-driver-host')]`: N copies
 * of this file in one realm resolve to ONE worker thread. The slot records the
 * `TURSO_DRIVER_PROTOCOL_VERSION` it was built against; a copy speaking a
 * different version throws `E_TURSO_DRIVER_PROTOCOL_MISMATCH` rather than
 * spawning a second worker (see `getSlot`).
 *
 * SEPARATE REALMS ARE DELIBERATELY UNAFFECTED: a forked child process or a
 * `worker_threads.Worker` has its own `globalThis` (and its own symbol
 * registry), so each gets its own host — correct, because it is a genuinely
 * separate isolate.
 *
 * ## The lifecycle contract
 *
 * - **Lazy spawn.** No worker exists until the first `openTursoConnection`. The
 *   entry point is `resolveTursoDriverWorkerEntry()`, which mirrors
 *   `deep-verify.ts`'s `resolveDeepVerifierEntry` (sibling `.js` → sibling `.ts`
 *   via `--import tsx` → `../dist`).
 * - **ONE FIFO port.** Requests are posted in arrival order and correlated to
 *   responses by a monotonic `id`. There is NO host-side timeout or
 *   cancellation: a native step cannot be cancelled, so a timer rejection would
 *   invent phantom failures for writes that still commit. A slow worker is
 *   reported, never interrupted — `getTursoDriverStatus()` derives `stalled`
 *   from the oldest pending request's age, and an unref'd main-thread timer
 *   emits `store_adapter.turso.driver_stalled` at doubling intervals with a
 *   matching `driver_recovered` when the backlog drains.
 * - **Ref/unref.** The worker is `ref()`d exactly while `inFlight > 0` and
 *   `unref()`d at 0, so a CLI that opens, queries and exits is never held open
 *   by the driver thread.
 * - **Teardown.** When the last connection closes and nothing is in flight, the
 *   worker is `terminate()`d (unref'd, never awaited on a hot path).
 * - **Unexpected exit.** Every pending request is rejected with
 *   `E_TURSO_DRIVER_WORKER_EXITED`, a `driver_worker.exited` telemetry event is
 *   emitted, `exits` increments, every open connection handle becomes inert
 *   (a further call rejects fatal — which is what the adapter's existing
 *   `_markIfFatal` → `_reconnect` path keys on), and the NEXT
 *   `openTursoConnection` spawns a fresh worker.
 *
 * ## Marshalling
 *
 * Args cross as-is (the driver accepts `Uint8Array`); returned rows/BLOBs are
 * re-materialized through `reviveBuffers`; a worker-realm error is rebuilt
 * through `reviveDriverError` with the main-thread call-site stack captured at
 * request time, so the `errors.ts` duck-type predicates return the SAME verdicts
 * they would for a native in-thread error (ADR-0012 §5).
 *
 * @module
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Worker } from 'node:worker_threads';
import { currentRuntimeState, log, spawnWorker } from '@adhd/sox-telemetry';
import {
  TURSO_DRIVER_PROTOCOL_VERSION,
  assertCloneableOpts,
  reviveBuffers,
  reviveDriverError,
  type DriverMethod,
  type DriverRequest,
  type DriverResponse,
  type SerializedDriverError,
} from './turso-driver-protocol.js';

// ── Public surface ──────────────────────────────────────────────────────────

/**
 * One Turso connection, proxied onto the process-wide driver worker. The shape
 * mirrors the subset of `@tursodatabase/database`'s `Database` the adapters use,
 * so an adapter swaps `this.db` for one of these with no call-site change.
 */
export interface TursoDriverConnection {
  run(sql: string, ...args: unknown[]): Promise<{ changes: number; lastInsertRowid: number | bigint }>;
  get(sql: string, ...args: unknown[]): Promise<Record<string, unknown> | undefined>;
  all(sql: string, ...args: unknown[]): Promise<Record<string, unknown>[]>;
  exec(sql: string): Promise<void>;
  pragma(source: string, options?: { simple?: boolean }): Promise<unknown>;
  close(): Promise<void>;
  readonly connId: number;
}

/** The observable lifecycle state of the process-wide driver worker. */
export type TursoDriverState = 'not-started' | 'idle' | 'busy' | 'stalled' | 'exited';

/** A synchronous, zero-worker-touch snapshot of the driver host. */
export interface TursoDriverStatus {
  state: TursoDriverState;
  /** Requests currently awaiting a response. */
  inFlight: number;
  /** `'<method>:<sql head>'` of the oldest pending request, or `null`. */
  oldestOpLabel: string | null;
  /** Age of the oldest pending request in ms, or `null` when nothing is pending. */
  oldestOpAgeMs: number | null;
  /** Connections the host currently believes are open. */
  openConnections: number;
  /** The worker's thread id, or `null` when no worker is running. */
  workerThreadId: number | null;
  /** Unexpected worker exits since process start. */
  exits: number;
}

/** Default age at which a pending request makes the driver report `stalled`. */
export const DEFAULT_DRIVER_STALL_AFTER_MS = 5_000;

/** Hard cap on the doubling stall-report interval (10 minutes). */
const MAX_DRIVER_STALL_AFTER_MS = 600_000;

/** Table/driver label prefix used for every telemetry event this module emits. */
const TELEMETRY_STALL_EVENT = 'store_adapter.turso.driver_stalled';
const TELEMETRY_RECOVERED_EVENT = 'store_adapter.turso.driver_recovered';
/** The event name the plan fixes for an unexpected worker death. */
const TELEMETRY_WORKER_EXITED_EVENT = 'driver_worker.exited';

// ── Typed errors (module-private; classified by `errors.ts` code) ────────────

/**
 * The failure every pending call gets when the worker dies unexpectedly.
 *
 * Deliberately carries `code = 'E_TURSO_DRIVER_WORKER_EXITED'`: `errors.ts`'s
 * `isFatalConnectionError` recognizes that marker (TUR-C's one-line widening),
 * so a caller gets the SAME `fatal_connection` verdict it would for a native
 * I/O fault and the adapter's `_markIfFatal`/`_reconnect` path recovers with no
 * new adapter code. Not exported: it is internal lifecycle plumbing, not public
 * surface.
 */
class ETursoDriverWorkerExited extends Error {
  public readonly code = 'E_TURSO_DRIVER_WORKER_EXITED';

  constructor(message: string) {
    super(message);
    this.name = 'ETursoDriverWorkerExited';
  }
}

/**
 * Thrown when this copy of the package disagrees with the version the
 * process-wide singleton slot was created under — the duplicate-module /
 * host-only-reload hazard. Refuses rather than spawning a competing worker.
 */
class ETursoDriverProtocolMismatch extends Error {
  public readonly code = 'E_TURSO_DRIVER_PROTOCOL_MISMATCH';

  constructor(slotProtocol: number, expected: number) {
    super(
      `the process-wide Turso driver host was created for protocol v${slotProtocol} but this copy ` +
        `of @adhd/sox-store-adapter speaks v${expected}; refusing to spawn a second driver worker. ` +
        `Reload the process, or align every @adhd/sox-store-adapter copy to one version.`,
    );
    this.name = 'ETursoDriverProtocolMismatch';
  }
}

// ── Worker entry resolution (mirrors deep-verify.ts:258-267) ─────────────────

// Named `__dirname` on purpose: the bundler's sidecar reference scan keys on it.
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Locate `turso-driver-worker.js`: the sibling in a tsc `dist/` or an esbuild
 * bundle (declared in this package's `sox.sidecars`, so every consuming bundle
 * emits it — docs/standards/extension-bundling.md §3), else the `.ts` source
 * run through `tsx` (vitest runs this module from `src/`), else `../dist`.
 *
 * An exact mirror of `resolveDeepVerifierEntry` (deep-verify.ts:258-267).
 */
export function resolveTursoDriverWorkerEntry(): { path: string; execArgv: string[] } {
  const sibling = join(__dirname, 'turso-driver-worker.js');
  if (existsSync(sibling)) return { path: sibling, execArgv: [] };
  const source = join(__dirname, 'turso-driver-worker.ts');
  if (existsSync(source)) return { path: source, execArgv: ['--import', 'tsx'] };
  const distSibling = join(__dirname, '..', 'dist', 'turso-driver-worker.js');
  if (existsSync(distSibling)) return { path: distSibling, execArgv: [] };
  // Returned as-is so a failure names the path actually attempted.
  return { path: sibling, execArgv: [] };
}

// ── The process-wide slot (ADR-0018) ────────────────────────────────────────

/**
 * ⚠️ SEMVER-STABLE CONTRACT. The string inside `Symbol.for(...)` identifies the
 * shared slot across every version of this package coexisting in one process.
 * Changing it silently splits the host again (two workers). Bump the `.vN`
 * suffix only when the slot's SHAPE changes incompatibly.
 */
const HOST_SLOT_KEY: symbol = Symbol.for('@adhd/sox-store-adapter/turso-driver-host');

interface TursoDriverHostSlot {
  /** The `TURSO_DRIVER_PROTOCOL_VERSION` this slot was created under. */
  protocol: number;
  host: TursoDriverHost;
}

function slotTable(): Record<symbol, TursoDriverHostSlot | undefined> {
  return globalThis as unknown as Record<symbol, TursoDriverHostSlot | undefined>;
}

/** Read the slot without creating it — the status path must never spawn. */
function peekSlot(): TursoDriverHostSlot | undefined {
  return slotTable()[HOST_SLOT_KEY];
}

/**
 * Read-or-create the one slot, refusing a protocol mismatch. Creating and
 * checking are the same act: the first copy to arrive installs the slot with
 * its own protocol; a later copy speaking a different version throws instead of
 * spawning a competing worker.
 */
function getSlot(): TursoDriverHostSlot {
  const table = slotTable();
  const existing = table[HOST_SLOT_KEY];
  if (existing !== undefined) {
    if (existing.protocol !== TURSO_DRIVER_PROTOCOL_VERSION) {
      throw new ETursoDriverProtocolMismatch(existing.protocol, TURSO_DRIVER_PROTOCOL_VERSION);
    }
    return existing;
  }
  const created: TursoDriverHostSlot = {
    protocol: TURSO_DRIVER_PROTOCOL_VERSION,
    host: new TursoDriverHost(),
  };
  table[HOST_SLOT_KEY] = created;
  return created;
}

// ── Internal shapes ─────────────────────────────────────────────────────────

/** A request minus its `id` — the host assigns the id at post time. */
type HostRequest =
  | { kind: 'open'; connId: number; url: string; opts: Record<string, unknown> }
  | { kind: 'call'; connId: number; method: DriverMethod; sql: string; args: unknown[]; label: string }
  | { kind: 'close'; connId: number };

interface PendingOp {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  label: string;
  startedAt: number;
  callSiteStack: string | undefined;
}

const EMPTY_STATUS: TursoDriverStatus = {
  state: 'not-started',
  inFlight: 0,
  oldestOpLabel: null,
  oldestOpAgeMs: null,
  openConnections: 0,
  workerThreadId: null,
  exits: 0,
};

/** A short, arg-free SQL head for labels — never a bound value. */
function sqlHead(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().slice(0, 48);
}

/** Capture the main-thread call site now; appended to the worker's stack later. */
function captureCallSiteStack(): string | undefined {
  const err = new Error('turso-driver call site');
  if (typeof err.stack !== 'string') return undefined;
  const lines = err.stack.split('\n');
  // Drop this helper's own frame — keep the caller and below.
  return lines.slice(1).join('\n');
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── The host ────────────────────────────────────────────────────────────────

/**
 * Owns the singleton worker, the FIFO request map, and every lifecycle
 * transition. Not exported: the slot is the only handle, and the module-level
 * functions are the public surface.
 */
class TursoDriverHost {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, PendingOp>();
  /** connId → the worker generation it was opened under. */
  private readonly connections = new Map<number, number>();
  private nextRequestId = 1;
  private nextConnId = 1;
  /** Increments on every spawn; a connection is live only in its own generation. */
  private generation = 0;
  private started = false;
  private exited = false;
  /** True while the host itself is terminating (disposal / reset) — not "unexpected". */
  private expectedTermination = false;
  private exits = 0;
  private ready: Promise<void> = Promise.resolve();
  private readyResolve: (() => void) | undefined;
  private readyReject: ((err: unknown) => void) | undefined;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private stallIntervalMs = DEFAULT_DRIVER_STALL_AFTER_MS;
  private stallReported = false;
  /**
   * (cfed929d) Outstanding adapter holds — see {@link maybeDispose}. The worker
   * is kept alive while this is non-zero even with zero open connections.
   */
  private holds = 0;

  // ── Public operations ─────────────────────────────────────────────────────

  async open(url: string, opts: Record<string, unknown>): Promise<TursoDriverConnection> {
    assertCloneableOpts(opts);
    await this.ensureWorker();
    const connId = this.nextConnId;
    this.nextConnId += 1;
    const generation = this.generation;
    // Reserve the connection BEFORE the open request: it keeps `maybeDispose`
    // from tearing the worker down in the window between the `open` response
    // settling and this method resuming.
    this.connections.set(connId, generation);
    try {
      await this.request({ kind: 'open', connId, url, opts }, 'open');
    } catch (err: unknown) {
      this.connections.delete(connId);
      this.maybeDispose();
      throw err;
    }
    return new DriverConnectionImpl(this, connId, generation);
  }

  status(stallAfterMs: number): TursoDriverStatus {
    const inFlight = this.pending.size;
    const oldest = this.oldestPending();
    let state: TursoDriverState;
    if (!this.started) {
      state = 'not-started';
    } else if (this.worker === null && this.exited) {
      state = 'exited';
    } else if (inFlight > 0) {
      state = oldest !== undefined && Date.now() - oldest.startedAt >= stallAfterMs ? 'stalled' : 'busy';
    } else {
      state = 'idle';
    }
    return {
      state,
      inFlight,
      oldestOpLabel: oldest === undefined ? null : oldest.label,
      oldestOpAgeMs: oldest === undefined ? null : Date.now() - oldest.startedAt,
      openConnections: this.connections.size,
      workerThreadId: this.worker === null ? null : this.worker.threadId,
      exits: this.exits,
    };
  }

  // ── Connection plumbing (called by DriverConnectionImpl) ───────────────────

  isConnectionLive(connId: number, generation: number): boolean {
    return this.connections.get(connId) === generation;
  }

  forgetConnection(connId: number): void {
    this.connections.delete(connId);
    this.maybeDispose();
  }

  async sendClose(connId: number): Promise<void> {
    try {
      await this.request({ kind: 'close', connId }, 'close');
    } catch (err: unknown) {
      // A close that cannot reach the worker means the connection is already
      // gone — the caller's `finally` forgets it, so it is inert either way.
      // Traced, never silently swallowed.
      log.warn('store_adapter.turso.driver_close_failed', {
        conn_id: connId,
        error: describeError(err),
      });
    }
  }

  callConnection(connId: number, method: DriverMethod, sql: string, args: unknown[]): Promise<unknown> {
    const label = `${method}:${sqlHead(sql)}`;
    return this.request({ kind: 'call', connId, method, sql, args, label }, label);
  }

  // ── Worker spawn / ready ──────────────────────────────────────────────────

  private async ensureWorker(): Promise<void> {
    if (this.worker !== null) {
      await this.ready;
      if (this.worker === null) {
        throw new ETursoDriverWorkerExited('the Turso driver worker exited while opening');
      }
      return;
    }
    const entry = resolveTursoDriverWorkerEntry();
    const runtime = currentRuntimeState();
    const worker = spawnWorker(
      entry.path,
      { service: runtime.service, role: runtime.role, logSink: runtime.logSink },
      { execArgv: entry.execArgv },
    );
    this.worker = worker;
    this.started = true;
    this.exited = false;
    this.generation += 1;
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    worker.on('message', (raw: unknown) => this.onMessage(worker, raw));
    worker.on('error', (err: Error) => this.onWorkerError(worker, err));
    worker.on('exit', (code: number) => this.onWorkerExit(worker, code));
    await this.ready;
    if (this.worker === null) {
      throw new ETursoDriverWorkerExited('the Turso driver worker exited while opening');
    }
  }

  private onMessage(worker: Worker, raw: unknown): void {
    if (raw === null || typeof raw !== 'object') return;
    const msg = raw as DriverResponse;
    if (msg.kind === 'ready') {
      this.onReady(worker, msg.protocol);
      return;
    }
    if (this.worker !== worker) return; // a stale response from a replaced worker
    if (msg.kind === 'ok') this.settle(msg.id, msg.value);
    else this.rejectPending(msg.id, msg.error);
  }

  private onReady(worker: Worker, protocol: number): void {
    if (this.worker !== worker) return;
    const resolve = this.readyResolve;
    const reject = this.readyReject;
    this.readyResolve = undefined;
    this.readyReject = undefined;
    if (protocol !== TURSO_DRIVER_PROTOCOL_VERSION) {
      this.expectedTermination = true;
      this.worker = null;
      reject?.(new ETursoDriverProtocolMismatch(protocol, TURSO_DRIVER_PROTOCOL_VERSION));
      void worker.terminate();
      return;
    }
    resolve?.();
  }

  private onWorkerError(worker: Worker, err: Error): void {
    if (this.worker !== worker) return;
    // A worker 'error' is always followed by 'exit' — the rejection/telemetry
    // happens there, once, so a failure never double-reports.
    log.warn('store_adapter.turso.driver_worker_error', { error: err.message });
  }

  private onWorkerExit(worker: Worker, code: number): void {
    // Consume the intentional-termination flag FIRST — before the stale-worker
    // guard below. Every disposal path (`maybeDispose`, `onReady`'s
    // protocol-mismatch branch, `_resetForTest`) nulls `this.worker` before it
    // calls `terminate()`, so the disposal's OWN exit event arrives here with
    // `this.worker !== worker`. Clearing only after that guard (the original
    // order) left the flag set forever: the NEXT genuinely-unexpected death was
    // then misread as intentional and swallowed — its pending calls stranded
    // and never rejected, `exits` not incremented, `driver_worker.exited` not
    // emitted. (BL-16766e77)
    const expected = this.expectedTermination;
    this.expectedTermination = false;

    if (this.worker !== worker) return; // a stale exit from a replaced/disposed worker
    this.worker = null;
    // A worker that dies before posting `ready` (spawn/bootstrap failure, a
    // missing sidecar, bad `execArgv`) can never resolve the pending `this.ready`
    // promise. Capture the rejecter before it is discarded so the awaiting
    // `ensureWorker()` settles with a fatal `E_TURSO_DRIVER_WORKER_EXITED`
    // instead of hanging forever; the `if (this.worker === null) throw` guard
    // after `await this.ready` is unreachable on this path otherwise. Mirrors
    // `onReady()`'s rejecter handoff. (BL-3767d78c)
    const readyReject = this.readyReject;
    this.readyResolve = undefined;
    this.readyReject = undefined;
    this.clearStallTimer();
    this.stallReported = false;
    readyReject?.(new ETursoDriverWorkerExited('the Turso driver worker exited while opening'));
    if (expected) return;

    this.exits += 1;
    this.exited = true;
    const error = new ETursoDriverWorkerExited(
      `the Turso driver worker exited unexpectedly (exit code ${String(code)}); every pending driver ` +
        `call was rejected. The next openTursoConnection() spawns a fresh worker.`,
    );
    const stranded = [...this.pending.values()];
    this.pending.clear();
    this.connections.clear();
    for (const op of stranded) op.reject(error);
    log.warn(TELEMETRY_WORKER_EXITED_EVENT, {
      exit_code: code,
      rejected_calls: stranded.length,
      exits: this.exits,
    });
  }

  // ── Request / response ────────────────────────────────────────────────────

  private request(req: HostRequest, label: string): Promise<unknown> {
    const worker = this.worker;
    if (worker === null) {
      return Promise.reject(new ETursoDriverWorkerExited('the Turso driver worker is not running'));
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const callSiteStack = captureCallSiteStack();
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, label, startedAt: Date.now(), callSiteStack });
      if (this.pending.size === 1) {
        worker.ref();
        this.armStallTimer();
      }
      try {
        worker.postMessage({ ...req, id } as DriverRequest);
      } catch (err: unknown) {
        const op = this.pending.get(id);
        if (op !== undefined) {
          this.pending.delete(id);
          op.reject(err);
        }
        this.afterPendingChange();
      }
    });
  }

  private settle(id: number, value: unknown): void {
    const op = this.pending.get(id);
    if (op === undefined) return;
    this.pending.delete(id);
    op.resolve(reviveBuffers(value));
    this.afterPendingChange();
  }

  private rejectPending(id: number, serialized: SerializedDriverError): void {
    const op = this.pending.get(id);
    if (op === undefined) return;
    this.pending.delete(id);
    op.reject(reviveDriverError(serialized, op.callSiteStack));
    this.afterPendingChange();
  }

  private afterPendingChange(): void {
    if (this.pending.size > 0) return;
    this.clearStallTimer();
    this.maybeEmitRecovered();
    this.worker?.unref();
    this.maybeDispose();
  }

  private oldestPending(): PendingOp | undefined {
    const first = this.pending.values().next();
    return first.done === true ? undefined : first.value;
  }

  // ── Disposal ──────────────────────────────────────────────────────────────

  private maybeDispose(): void {
    if (this.worker === null) return;
    if (this.connections.size > 0) return;
    if (this.pending.size > 0) return;
    // (cfed929d, TUR-D correction) An adapter that has voluntarily RELEASED its
    // connection (`releaseIdleConnection()`) but may still reopen it holds a
    // ref here. Without it, the idle release→reopen cycle tore the worker down
    // on the release and paid a full (re)spawn — plus, under vitest, a
    // `--import tsx` compile — on the next op (observed 341 ms against a 250 ms
    // budget). The hold keeps the singleton worker alive across an idle release
    // and is dropped by the adapter's final `close()`.
    if (this.holds > 0) return;
    const worker = this.worker;
    this.worker = null;
    this.expectedTermination = true;
    this.ready = Promise.resolve();
    void worker.terminate();
  }

  /**
   * Pin the worker open on behalf of one adapter that may reopen after an idle
   * release. Refcounted; balanced by {@link unholdWorker} at the adapter's
   * final close. See {@link maybeDispose} for why this exists.
   */
  holdWorker(): void {
    this.holds += 1;
  }

  /** Release one {@link holdWorker} ref, disposing if it was the last. */
  unholdWorker(): void {
    if (this.holds > 0) this.holds -= 1;
    this.maybeDispose();
  }

  // ── Stall telemetry (unref'd; doubling interval) ──────────────────────────

  private armStallTimer(): void {
    if (this.stallTimer !== null) return;
    this.stallIntervalMs = DEFAULT_DRIVER_STALL_AFTER_MS;
    this.scheduleStallTick();
  }

  private scheduleStallTick(): void {
    const timer = setTimeout(() => {
      this.stallTimer = null;
      if (this.pending.size === 0) {
        this.maybeEmitRecovered();
        return;
      }
      const oldest = this.oldestPending();
      this.stallReported = true;
      log.warn(TELEMETRY_STALL_EVENT, {
        op_label: oldest === undefined ? null : oldest.label,
        blocked_for_ms: oldest === undefined ? 0 : Date.now() - oldest.startedAt,
        in_flight: this.pending.size,
      });
      this.stallIntervalMs = Math.min(this.stallIntervalMs * 2, MAX_DRIVER_STALL_AFTER_MS);
      this.scheduleStallTick();
    }, this.stallIntervalMs);
    timer.unref();
    this.stallTimer = timer;
  }

  private clearStallTimer(): void {
    if (this.stallTimer !== null) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private maybeEmitRecovered(): void {
    if (!this.stallReported) return;
    this.stallReported = false;
    log.info(TELEMETRY_RECOVERED_EVENT, { in_flight: this.pending.size });
  }

  // ── Test seams (internal; not public surface) ─────────────────────────────

  /**
   * @internal Test only — simulate an unexpected worker death with no pending
   * requests (the worker's own crash path). The exit handler treats it as
   * unexpected because `expectedTermination` is left unset.
   */
  _killWorkerForTest(): void {
    void this.worker?.terminate();
  }

  /** @internal Test only — terminate the worker and forget all state. */
  async _resetForTest(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.readyResolve = undefined;
    this.readyReject = undefined;
    this.expectedTermination = true;
    this.clearStallTimer();
    this.stallReported = false;
    this.ready = Promise.resolve();
    const stranded = [...this.pending.values()];
    this.pending.clear();
    const error = new ETursoDriverWorkerExited('the driver host was reset for test');
    for (const op of stranded) op.reject(error);
    this.connections.clear();
    this.started = false;
    this.exited = false;
    this.exits = 0;
    this.generation = 0;
    this.stallIntervalMs = DEFAULT_DRIVER_STALL_AFTER_MS;
    if (worker !== null) await worker.terminate();
  }
}

// ── The connection proxy ────────────────────────────────────────────────────

/**
 * A connection handle is a thin, generation-stamped proxy: every method routes
 * to the host's single FIFO port. If the worker it was opened under has died
 * (or been replaced), a call fails `fatal_connection` — it never silently
 * reaches a fresh worker with a stale `connId`.
 */
class DriverConnectionImpl implements TursoDriverConnection {
  private closed = false;

  constructor(
    private readonly host: TursoDriverHost,
    public readonly connId: number,
    private readonly generation: number,
  ) {}

  async run(
    sql: string,
    ...args: unknown[]
  ): Promise<{ changes: number; lastInsertRowid: number | bigint }> {
    return (await this.call('run', sql, args)) as { changes: number; lastInsertRowid: number | bigint };
  }

  async get(sql: string, ...args: unknown[]): Promise<Record<string, unknown> | undefined> {
    return (await this.call('get', sql, args)) as Record<string, unknown> | undefined;
  }

  async all(sql: string, ...args: unknown[]): Promise<Record<string, unknown>[]> {
    return (await this.call('all', sql, args)) as Record<string, unknown>[];
  }

  async exec(sql: string): Promise<void> {
    await this.call('exec', sql, []);
  }

  async pragma(source: string, options?: { simple?: boolean }): Promise<unknown> {
    const args = options === undefined ? [] : [options];
    return await this.call('pragma', source, args);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.host.isConnectionLive(this.connId, this.generation)) {
        await this.host.sendClose(this.connId);
      }
    } finally {
      this.host.forgetConnection(this.connId);
    }
  }

  private call(method: DriverMethod, sql: string, args: unknown[]): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new ETursoDriverWorkerExited(`connection ${this.connId} is closed`));
    }
    if (!this.host.isConnectionLive(this.connId, this.generation)) {
      return Promise.reject(
        new ETursoDriverWorkerExited(`connection ${this.connId} died with its driver worker`),
      );
    }
    return this.host.callConnection(this.connId, method, sql, args);
  }
}

// ── Public entry points ─────────────────────────────────────────────────────

/**
 * Open a connection on the process-wide driver worker, spawning it lazily on
 * first use. A protocol-version disagreement throws
 * `E_TURSO_DRIVER_PROTOCOL_MISMATCH` (via `getSlot`) rather than starting a
 * second worker.
 */
export async function openTursoConnection(
  url: string,
  opts: Record<string, unknown>,
): Promise<TursoDriverConnection> {
  return getSlot().host.open(url, opts);
}

/**
 * (cfed929d) Pin the process-wide driver worker open on behalf of one adapter
 * that may reopen after an idle release. The adapter takes this on a successful
 * open and drops it ({@link unholdTursoDriverWorker}) on its final `close()`, so
 * the singleton worker survives release→reopen cycles without pinning it past
 * the adapter's lifetime. Refcounted across adapters; see `maybeDispose`.
 */
export function holdTursoDriverWorker(): void {
  getSlot().host.holdWorker();
}

/** (cfed929d) Release one {@link holdTursoDriverWorker} ref. */
export function unholdTursoDriverWorker(): void {
  // `peekSlot` — never create a slot just to drop a hold. A hold can only
  // exist if a slot already existed, so this is a no-op on a missing slot.
  peekSlot()?.host.unholdWorker();
}

/**
 * Snapshot the driver host SYNCHRONOUSLY. This never touches the worker and
 * never spawns one — it is safe to call from a watchdog, a health probe, or a
 * `memory_ping` handler on the main thread. `stallAfterMs` only affects the
 * derived `stalled` verdict.
 */
export function getTursoDriverStatus(
  stallAfterMs: number = DEFAULT_DRIVER_STALL_AFTER_MS,
): TursoDriverStatus {
  const slot = peekSlot();
  if (slot === undefined) return { ...EMPTY_STATUS };
  return slot.host.status(stallAfterMs);
}
