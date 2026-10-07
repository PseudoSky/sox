/**
 * acquire.ts — idempotent, single-owner, ref-counted telemetry acquisition
 * (621a11c5).
 *
 * `initTelemetry` is LAST-WINS: each call closes the previous sink, shuts the
 * previous OTel provider down and installs a new configuration. Two plugins in
 * one process that each call it therefore fight over one global provider — the
 * later caller silently reconfigures the earlier one, and (before the
 * generation guard in `runtime.ts`) the earlier caller's `close()` tore down
 * the LATER caller's provider. Separately, the OTel API's own global
 * registration is FIRST-WINS (`trace.setGlobalTracerProvider` refuses a second
 * registration), so two live `bringUpOtel` calls leave the second provider
 * unregistered while it still owns its own span processor.
 *
 * `acquireTelemetry` removes the fight: the first caller in the process
 * becomes the owner and brings telemetry up; every later caller joins the
 * existing instance. The provider is registered exactly once and torn down
 * only when the LAST lease releases.
 *
 * The owner record lives on the shared `globalThis` runtime slot (see the
 * BL-404 comment in `runtime.ts`), so two installed copies of this package in
 * one process share one owner and one reference count.
 */

import {
  _acquireSlot,
  _initTelemetryOwned,
  currentRuntimeState,
  log,
  type InitTelemetryOptions,
  type TelemetryHandle,
} from './runtime.js';

/**
 * A claim on the process's shared telemetry instance. It satisfies
 * {@link TelemetryHandle}, so it drops in wherever `initTelemetry`'s handle was
 * used — `close()` is an alias for {@link TelemetryLease.release}.
 */
export interface TelemetryLease extends TelemetryHandle {
  /**
   * `true` when THIS call brought telemetry up (it was the first live lease);
   * `false` when it joined an instance another caller already owns. Later
   * acquirers' options are ignored — the owner's configuration stands.
   */
  readonly owned: boolean;
  /**
   * Options this caller passed that differ from the owner's resolved
   * configuration, as a subset of `service | role | logSink | logDir | otel`.
   * Always empty when `owned` is true. A non-empty list is also written once to
   * the sink as a `telemetry.acquire.config_conflict` warning, so a silently
   * mislabelled service is never invisible.
   */
  readonly conflicts: readonly string[];
  /**
   * Give the lease back. Idempotent: a second call is a no-op and never
   * decrements twice. When this was the LAST live lease, resolves once the
   * final snapshot is written and the sinks and provider are closed; otherwise
   * resolves immediately. Never rejects.
   */
  release(): Promise<void>;
}

interface Owner {
  refs: number;
  handle: TelemetryHandle;
  closeAsync: () => Promise<void>;
  /** The runtime state object this owner installed; if it is no longer the
   *  live state, a raw `initTelemetry` (or a test reset) superseded us. */
  state: unknown;
  config: Resolved;
}

interface Resolved {
  service: string;
  role: string;
  logSink: string;
  logDir: string | undefined;
  otel: boolean;
}

function resolve(opts: InitTelemetryOptions): Resolved {
  return {
    service: opts.service,
    role: opts.role,
    logSink: opts.logSink ?? 'file',
    logDir: opts.logDir,
    otel: opts.otel ?? (opts.role === 'live-service' || opts.role === 'cli'),
  };
}

function diff(owner: Resolved, mine: Resolved): string[] {
  const out: string[] = [];
  if (mine.service !== owner.service) out.push('service');
  if (mine.role !== owner.role) out.push('role');
  if (mine.logSink !== owner.logSink) out.push('logSink');
  // An omitted logDir means "the default", which is not a conflict with any
  // explicit directory the owner picked — only two explicit, different dirs are.
  if (mine.logDir !== undefined && owner.logDir !== undefined && mine.logDir !== owner.logDir) out.push('logDir');
  if (mine.otel !== owner.otel) out.push('otel');
  return out;
}

function liveOwner(): Owner | null {
  const slot = _acquireSlot();
  const owner = slot.owner as Owner | null;
  if (owner === null) return null;
  if (owner.state !== currentRuntimeState()) {
    // Superseded by a raw initTelemetry()/reset: those already closed our
    // sink and provider, so there is nothing left for us to own.
    slot.owner = null;
    return null;
  }
  return owner;
}

/**
 * Acquire the process's shared telemetry. The first call initialises it with
 * `opts`; later calls join it. Pair every acquire with one `release()`.
 *
 * Prefer this over `initTelemetry` in any LIBRARY or PLUGIN that may share a
 * process with another telemetry user; keep `initTelemetry` for a composition
 * root that is the sole owner (its API is unchanged).
 *
 * @example
 * ```ts
 * // plugin A and plugin B, same process, each written independently:
 * const a = acquireTelemetry({ service: 'agent-mcp', role: 'live-service' });
 * const b = acquireTelemetry({ service: 'agent-mcp', role: 'live-service' });
 * await a.otelReady();        // one provider, registered once
 * await a.release();          // provider stays up — b still holds a lease
 * await b.release();          // last lease: final snapshot, then teardown
 * ```
 */
export function acquireTelemetry(opts: InitTelemetryOptions): TelemetryLease {
  const mine = resolve(opts);
  let owner = liveOwner();
  let owned = false;
  let conflicts: string[] = [];

  if (owner === null) {
    const init = _initTelemetryOwned(opts);
    owner = { refs: 0, handle: init.handle, closeAsync: init.closeAsync, state: init.state, config: mine };
    _acquireSlot().owner = owner;
    owned = true;
  } else {
    conflicts = diff(owner.config, mine);
    if (conflicts.length > 0) {
      log.warn('telemetry.acquire.config_conflict', {
        conflicts,
        owner_service: owner.config.service,
        requested_service: mine.service,
      });
    }
  }
  owner.refs += 1;

  const joined = owner;
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    joined.refs -= 1;
    if (joined.refs > 0) return;
    const slot = _acquireSlot();
    if (slot.owner === joined) slot.owner = null;
    await joined.closeAsync().catch(() => undefined);
  };

  return {
    service: joined.handle.service,
    role: joined.handle.role,
    owned,
    conflicts,
    currentLogFilePath: () => joined.handle.currentLogFilePath(),
    flush: () => joined.handle.flush(),
    otelReady: () => joined.handle.otelReady(),
    close: () => {
      void release();
    },
    release,
  };
}

/** Test/diagnostic: live lease count on the current owner (0 when none). */
export function _activeLeaseCountForTest(): number {
  return liveOwner()?.refs ?? 0;
}
