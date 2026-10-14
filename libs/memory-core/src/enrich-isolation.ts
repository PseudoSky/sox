/**
 * enrich-isolation.ts — BL-348 committed-stage boundary, PARENT-process side.
 *
 * See `enrich-process-host.ts` for the full rationale (event-loop-blocking
 * synchronous SQL + unhandled-rejection crash risk, both structurally ruled
 * out by a real OS process boundary). This module is the one entry point the
 * rest of memory-server should call instead of `runBatchEnrich()` directly
 * for the periodic/write-triggered clustering pass.
 *
 * `runEnrichIsolated()` NEVER throws and NEVER rejects — every outcome
 * (success, thrown error inside the child, timeout, unexpected exit/crash) is
 * reported as a `{ ok: true, result }` or `{ ok: false, error }` value. This
 * is deliberate: a floating `void runPeriodicEnrichPassGuarded()` call
 * upstream must never see a rejection, because an unhandled rejection is
 * fatal to the parent process by default — exactly the hazard this file
 * exists to eliminate. Do not "simplify" this to throw-on-error.
 *
 * BL-465121ca invariants enforced here:
 *   - A timed-out child is SIGTERMed, then SIGKILLed after a grace period if it
 *     is still running. The SIGKILL is armed independently of `settle()`.
 *   - At most one enrich child is alive per store. A tick that finds a prior
 *     child still running is refused (reported as an error), never forked.
 *   - Every live child is SIGKILLed when this parent process exits.
 */

import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BatchEnrichOptions, BatchEnrichResult } from './enrich-batch.js';
import type { EnrichRequest, EnrichResponse } from './enrich-process-host.js';
import {
  forkChild,
  _recordChildTelemetry,
  type ChildTelemetrySnapshot,
  type ChildTelemetryRecord,
} from '@adhd/sox-telemetry';
import type { InitTelemetryOptions } from '@adhd/sox-telemetry';
import { log } from './telemetry.js';

export interface EnrichIsolatedOk {
  ok: true;
  result: BatchEnrichResult;
  /** The child's `telemetry.ready` ack (its own reported telemetry state), or
   *  `null` if the child settled without ever acking — the BL-618 signal that
   *  the child's telemetry never initialised. */
  child_telemetry: ChildTelemetrySnapshot | null;
}
export interface EnrichIsolatedErr {
  ok: false;
  /** Human-readable cause: child-reported error message, 'timeout', or
   *  'exit:<code>'/'signal:<signal>' for a crash with no reported error. */
  error: string;
}
export type EnrichIsolatedResult = EnrichIsolatedOk | EnrichIsolatedErr;

/** Grace between SIGTERM and SIGKILL for a timed-out child (BL-465121ca). */
export const ENRICH_KILL_GRACE_MS = 3000;

/** Own directory, resolved in a way that is safe both under the esbuild CJS
 *  bundle (where `__dirname` is a real global injected by esbuild — never use
 *  `import.meta.url` here, it is `{}` in that context, BL-155) and under
 *  Vite/vitest's SSR execution of TS source (which also provides `__dirname`
 *  for CJS-shaped modules like this one, since the package has no `"type":
 *  "module"` and compiles to CommonJS). */
function resolveOwnDir(): string {
  if (typeof __dirname === 'string' && __dirname.length > 0) return __dirname;
  throw new Error('enrich-isolation: __dirname unavailable — unexpected execution context');
}

/**
 * Resolve the forkable entry point for `enrich-process-host`, and the node
 * flags needed to run it, across three execution contexts:
 *   1. Compiled dist sibling (production: `nx build memory-server` inlines
 *      memory-core, and the sidecar bundler emits `enrich-process-host.js`
 *      next to the main bundle — see `sox.sidecars` in this package's
 *      package.json and docs/standards/extension-bundling.md).
 *   2. Compiled dist fallback one level up (mirrors
 *      `sharedFastembedProcess.ts`'s `resolveFastembedHostPath` — vitest runs
 *      `.ts` files directly via SSR transform, so `__dirname` resolves to
 *      `src/`, which never contains a compiled `.js`, but a stale/partial
 *      `dist/` may still exist one directory up).
 *   3. Source TS directly, via `tsx`'s CJS register hook (dev/test only —
 *      never reachable in a bundled extension, where (1) always wins).
 */
function resolveEnrichHostFork(): { modulePath: string; execArgv: string[] } {
  const ownDir = resolveOwnDir();

  const sibling = join(ownDir, 'enrich-process-host.js');
  if (existsSync(sibling)) return { modulePath: sibling, execArgv: [] };

  const distFallback = join(ownDir, '..', 'dist', 'enrich-process-host.js');
  if (existsSync(distFallback)) return { modulePath: distFallback, execArgv: [] };

  const srcPath = join(ownDir, 'enrich-process-host.ts');
  if (existsSync(srcPath)) {
    const tsxRegister = require.resolve('tsx/cjs');
    return { modulePath: srcPath, execArgv: ['-r', tsxRegister] };
  }

  // Last resort: return the original candidate so the resulting error names
  // the path that was actually attempted, mirroring resolveFastembedHostPath.
  return { modulePath: sibling, execArgv: [] };
}

/** Test seam: force a specific resolution instead of the real lookup. */
let _forkResolverOverride: (() => { modulePath: string; execArgv: string[] }) | null = null;
export function _setEnrichHostForkResolverForTest(
  fn: (() => { modulePath: string; execArgv: string[] }) | null,
): void {
  _forkResolverOverride = fn;
}

// ── BL-465121ca: live-child registry (one holder per store) ───────────────────

/** The enrich child currently alive for each store path. */
const liveChildrenByDb = new Map<string, ChildProcess>();

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/**
 * SIGTERM a child, then SIGKILL it after `graceMs` if it is still running.
 * The SIGKILL timer is independent of the caller's promise settlement, so a
 * child that ignores SIGTERM is always escalated (BL-465121ca defect 1).
 */
export function terminateEnrichChild(child: ChildProcess, graceMs = ENRICH_KILL_GRACE_MS): void {
  if (!isRunning(child)) return;
  try {
    child.kill('SIGTERM');
  } catch (err) {
    log.warn('enrich.child.sigterm_failed', {
      pid: child.pid ?? 0,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const escalate = setTimeout(() => {
    if (!isRunning(child)) return;
    log.warn('enrich.child.sigkill_escalated', { pid: child.pid ?? 0, grace_ms: graceMs });
    try {
      child.kill('SIGKILL');
    } catch (err) {
      log.error('enrich.child.sigkill_failed', {
        pid: child.pid ?? 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, graceMs);
  escalate.unref?.();
}

/**
 * SIGKILL every enrich child this parent still holds. Registered once on the
 * parent's own `exit` so an orderly parent exit never leaves a holder behind.
 */
export function killLiveEnrichChildren(): number {
  let killed = 0;
  for (const [dbPath, child] of liveChildrenByDb) {
    if (!isRunning(child)) continue;
    try {
      child.kill('SIGKILL');
      killed++;
    } catch (err) {
      log.error('enrich.child.exit_kill_failed', {
        db_path: dbPath,
        pid: child.pid ?? 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (killed > 0) log.warn('enrich.child.killed_on_parent_exit', { count: killed });
  return killed;
}
process.once('exit', () => {
  killLiveEnrichChildren();
});

/** Count of live enrich children, for health/telemetry callers. */
export function liveEnrichChildCount(): number {
  let n = 0;
  for (const child of liveChildrenByDb.values()) if (isRunning(child)) n++;
  return n;
}

// ── Idle-tick gate (BL-465121ca / e85abe84): skip the fork when nothing changed ─

/**
 * Forced-pass cap. A store whose ticks were idle may skip at most this many
 * consecutive forks; the next tick always runs a real child pass. This bounds
 * how long any fingerprint blind spot (for example an in-place invalidation,
 * which does not move MAX(rowid)) can hide pending clustering work.
 */
export const IDLE_ENRICH_MAX_CONSECUTIVE_SKIPS = 12;

export interface IdleEnrichGateState {
  /** Fingerprint of the store after the last idle pass, or null if the last
   *  pass produced work (or none has run yet). */
  fingerprint: string | null;
  consecutiveSkips: number;
}

export function createIdleEnrichGate(): IdleEnrichGateState {
  return { fingerprint: null, consecutiveSkips: 0 };
}

const idleGates = new Map<string, IdleEnrichGateState>();

/** Per-store idle gate state (created on first use). */
export function getIdleEnrichGate(dbPath: string): IdleEnrichGateState {
  let state = idleGates.get(dbPath);
  if (!state) {
    state = createIdleEnrichGate();
    idleGates.set(dbPath, state);
  }
  return state;
}

/**
 * Pure decision: may this tick skip forking a child? Only when there is no
 * open enrich trigger, the store fingerprint is unchanged since an idle pass,
 * and the forced-pass cap has not been reached.
 */
export function shouldSkipIdleEnrichFork(
  state: IdleEnrichGateState,
  input: { hasOpenTriggers: boolean; fingerprint: string },
): boolean {
  if (input.hasOpenTriggers) return false;
  if (state.fingerprint === null || state.fingerprint !== input.fingerprint) return false;
  return state.consecutiveSkips < IDLE_ENRICH_MAX_CONSECUTIVE_SKIPS;
}

/** A pass result counts as idle only if the child did no observable work. */
export function isIdleBatchResult(result: BatchEnrichResult): boolean {
  return (
    !result.cluster_pass_skipped &&
    result.communities_upserted === 0 &&
    result.member_of_edges === 0 &&
    result.incremental_joined === 0 &&
    result.importance_updated === 0 &&
    result.relates_to_edges === 0 &&
    result.topics_backfilled === 0 &&
    result.legacy_nodes_stamped === 0 &&
    result.embed_model_backfilled === 0
  );
}

/** Advance the gate after a tick. `kind` is what the tick actually did. */
export function advanceIdleEnrichGate(
  state: IdleEnrichGateState,
  event:
    | { kind: 'skipped' }
    | { kind: 'idle-pass'; fingerprint: string }
    | { kind: 'busy-pass' },
): void {
  if (event.kind === 'skipped') {
    state.consecutiveSkips++;
    return;
  }
  state.consecutiveSkips = 0;
  state.fingerprint = event.kind === 'idle-pass' ? event.fingerprint : null;
}

/** A successful zero-work result, reported when a tick skipped the fork. */
export function idleSkipResult(): BatchEnrichResult {
  return {
    communities_upserted: 0,
    member_of_edges: 0,
    importance_updated: 0,
    relates_to_edges: 0,
    topics_backfilled: 0,
    legacy_nodes_stamped: 0,
    embed_model_backfilled: 0,
    cluster_pass_skipped: false,
    incremental_joined: 0,
  } as BatchEnrichResult;
}

let _nextId = 1;

/**
 * Run one `runBatchEnrich` pass in an isolated child process and await its
 * result. Never throws, never rejects.
 *
 * @param timeoutMs Hard wall-clock budget. On expiry the child is SIGTERM'd
 *   and SIGKILL'd after `ENRICH_KILL_GRACE_MS` if it is still running, and the
 *   call resolves `{ ok: false, error: 'timeout' }`. A hung clustering pass can
 *   therefore never hold isolation resources indefinitely, and — critically —
 *   never blocks the parent event loop for even a moment, since the parent
 *   is only ever `await`ing a promise, not running the work itself.
 * @param childTelemetry The telemetry config injected into the child's
 *   `SOX_TELEMETRY_INIT` env (BL-618) and merged over its own defaults.
 */
export async function runEnrichIsolated(
  dbPath: string,
  opts: BatchEnrichOptions,
  timeoutMs = 120_000,
  childTelemetry: InitTelemetryOptions = { service: 'memory-core', role: 'harness', logSink: 'file' },
): Promise<EnrichIsolatedResult> {
  const startedAt = Date.now();
  const prior = liveChildrenByDb.get(dbPath);
  if (prior && isRunning(prior)) {
    // BL-465121ca defect 2: one holder per store. A prior child that outlived
    // its timeout is still alive; forking another would double the holders.
    log.warn('enrich.child.refused_prior_alive', { db_path: dbPath, prior_pid: prior.pid ?? 0 });
    return {
      ok: false,
      error: `previous enrich child still running (pid ${prior.pid ?? 0}); not forking a second holder for this store`,
    };
  }

  const { modulePath, execArgv } = _forkResolverOverride
    ? _forkResolverOverride()
    : resolveEnrichHostFork();

  const id = _nextId++;
  const req: EnrichRequest = { id, dbPath, opts };
  log.info('enrich.child.spawn', { id, db_path: dbPath, timeout_ms: timeoutMs, incremental: opts.incrementalCluster ?? false });

  return new Promise<EnrichIsolatedResult>((resolve) => {
    let settled = false;
    let child: ChildProcess;
    let ackedTelemetry: ChildTelemetrySnapshot | null = null;
    let spawnRecord: ChildTelemetryRecord | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = (r: EnrichIsolatedResult): void => {
      if (settled) return;
      settled = true;
      // BL-618: a child that settles successfully without ever acking its
      // telemetry is the "no-op child" signal — record it as unacked so
      // telemetrySelfCheck().children surfaces it.
      if (ackedTelemetry === null && spawnRecord !== null) {
        _recordChildTelemetry({ ...spawnRecord, unacked: true });
      }
      if (timeoutTimer) clearTimeout(timeoutTimer);
      log.info('enrich.child.settled', {
        id,
        db_path: dbPath,
        ok: r.ok,
        error: r.ok ? null : r.error,
        duration_ms: Date.now() - startedAt,
      });
      resolve(r);
    };

    try {
      child = forkChild(modulePath, childTelemetry, {
        execArgv: [...execArgv, ...process.execArgv.filter((a) => a.startsWith('--max-old-space-size'))],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        detached: false,
      });
      spawnRecord = {
        service: childTelemetry.service,
        role: childTelemetry.role,
        logSink: childTelemetry.logSink ?? 'file',
        filePath: null,
        pid: child.pid ?? 0,
        source: 'enrich',
      };
      _recordChildTelemetry(spawnRecord);
    } catch (err) {
      settle({ ok: false, error: `spawn failed: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    liveChildrenByDb.set(dbPath, child);
    child.unref();

    timeoutTimer = setTimeout(() => {
      if (settled) return;
      log.warn('enrich.child.timeout', { id, db_path: dbPath, pid: child.pid ?? 0, timeout_ms: timeoutMs });
      terminateEnrichChild(child);
      settle({ ok: false, error: 'timeout' });
    }, timeoutMs);
    if (timeoutTimer.unref) timeoutTimer.unref();

    child.on('message', (msg: EnrichResponse) => {
      // BL-618: handle the telemetry.ready ack FIRST, before the id filter —
      // it must never settle the promise, only record the child's state.
      if ('type' in msg && msg.type === 'telemetry.ready') {
        if (msg.id === id) {
          ackedTelemetry = msg.telemetry;
          _recordChildTelemetry({ ...msg.telemetry, source: 'enrich', acked: true });
        }
        return;
      }
      if (msg.id !== id) return;
      if ('result' in msg) settle({ ok: true, result: msg.result, child_telemetry: ackedTelemetry });
      else if ('error' in msg) settle({ ok: false, error: msg.error });
    });

    child.on('error', (err: Error) => {
      settle({ ok: false, error: `child process error: ${err.message}` });
    });

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      // The holder is released the moment the child is actually gone, whether
      // or not its promise already settled on timeout (BL-465121ca defect 2).
      if (liveChildrenByDb.get(dbPath) === child) liveChildrenByDb.delete(dbPath);
      log.info('enrich.child.exit', {
        id,
        db_path: dbPath,
        pid: child.pid ?? 0,
        code,
        signal,
        settled_before_exit: settled,
      });
      // Only a problem if we never got a message — a clean exit(0) after the
      // message already resolved this promise is the normal successful path.
      if (settled) return;
      settle({ ok: false, error: signal ? `signal:${signal}` : `exit:${code ?? 'null'}` });
    });

    child.send(req);
  });
}

/**
 * Gate a tick on the store's idle state, then run the pass if it has work.
 * Returns the same shape as `runEnrichIsolated`, plus `idle_skip: true` when
 * the fork was skipped. A skipped tick is a successful zero-work pass.
 */
export async function runEnrichIsolatedGated(
  dbPath: string,
  opts: BatchEnrichOptions,
  gate: { hasOpenTriggers: boolean; fingerprint: string },
  timeoutMs = 120_000,
  childTelemetry?: InitTelemetryOptions,
): Promise<EnrichIsolatedResult & { idle_skip?: true }> {
  const state = getIdleEnrichGate(dbPath);
  if (shouldSkipIdleEnrichFork(state, gate)) {
    advanceIdleEnrichGate(state, { kind: 'skipped' });
    log.info('enrich.child.idle_skip', {
      db_path: dbPath,
      consecutive_skips: state.consecutiveSkips,
      fingerprint: gate.fingerprint,
    });
    return { ok: true, result: idleSkipResult(), child_telemetry: null, idle_skip: true };
  }
  const outcome = await runEnrichIsolated(dbPath, opts, timeoutMs, childTelemetry);
  if (outcome.ok && isIdleBatchResult(outcome.result) && !gate.hasOpenTriggers) {
    advanceIdleEnrichGate(state, { kind: 'idle-pass', fingerprint: gate.fingerprint });
  } else {
    advanceIdleEnrichGate(state, { kind: 'busy-pass' });
  }
  return outcome;
}
