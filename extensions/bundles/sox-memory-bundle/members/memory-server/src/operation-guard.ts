/**
 * operation-guard.ts — BUG-MEMORYSERVER-WEDGES-SILENTLY-NO-SELF-RECOVERY-001.
 *
 * INCIDENT: the live server wedged for ~24 minutes (2026-08-15T02:16-02:40Z).
 * `openDb()` alone — isolated from the embed path — hung past 120s from a
 * fresh process. The blocked process sat at 0.0% CPU ('sleeping'): it was not
 * spinning, it was waiting on something that never returned. It logged
 * NOTHING for the entire wedge (last log line was routine SSE churn ~40 min
 * earlier) and never self-recovered; only a manual `service disable`+`enable`
 * fixed it.
 *
 * A client dying mid-operation against a multiprocess-WAL store is a NORMAL
 * event in this topology, not an exceptional one — the server must survive
 * it. This module gives every store-touching call a bounded deadline so a
 * blocked call FAILS with a typed, traced error instead of hanging the
 * process forever, and logs any operation that runs long enough to be worth
 * knowing about even when it eventually succeeds.
 *
 * DEADLINE SIZING — read before changing any default. The embed subsystem
 * (BUG-MEMORY-EMBED-HEAD-OF-LINE-BLOCKING-001, live production telemetry,
 * n=3769) measured:
 *
 *   response_ms   p50=1011ms   p90=5674ms   p99=40518ms   max=109089ms
 *
 * `memory_write`/`memory_write_batch` can embed SYNCHRONOUSLY when
 * `SOX_SYNC_EMBED=1` is set — under the async default (production) the write
 * itself does not wait on embed, but the deadline for the write-class tools
 * must still be sized above the sync-embed worst case observed in
 * production, with real margin, or a legitimate slow embed under
 * `SOX_SYNC_EMBED=1` gets killed as a false-positive wedge. A blanket 10s
 * deadline (as the incident report explicitly warns against) would do
 * exactly that.
 *
 * Every threshold below is overridable via env var — see `DEADLINE_ENV` —
 * so an operator can tune without a rebuild, and tests can shrink deadlines
 * to milliseconds without touching production defaults.
 */

import { log } from '@adhd/sox-memory-core';

/** Coarse classes of store-touching work. Each gets its own deadline because
 *  their legitimate latency distributions are wildly different — a `connect`
 *  (`getDb`/`openDb`) call should be near-instant even under contention,
 *  while a `write` may be riding behind a 109s embed. */
export type OperationClass = 'connect' | 'read' | 'mutate' | 'write';

/** Env var name for each class's deadline override (milliseconds). */
export const DEADLINE_ENV: Record<OperationClass, string> = {
  connect: 'SOX_MEMORY_SERVER_DEADLINE_CONNECT_MS',
  read: 'SOX_MEMORY_SERVER_DEADLINE_READ_MS',
  mutate: 'SOX_MEMORY_SERVER_DEADLINE_MUTATE_MS',
  write: 'SOX_MEMORY_SERVER_DEADLINE_WRITE_MS',
};

/**
 * Defaults. `connect` and `read`/`mutate` are generous relative to their
 * documented nominal cost (recall is <50ms nominal; `openDb` should be
 * near-instant) while still tolerating real contention — the incident's
 * store sat blocked for 24+ minutes, so even a "generous" 30-45s deadline is
 * a two-orders-of-magnitude improvement over "never".
 *
 * `write` must clear the measured embed max (109089ms) with real margin:
 * 150000ms (150s) leaves ~41s of headroom above the single worst embed
 * observed in 11 days of production telemetry (n=3769).
 */
const DEFAULT_DEADLINE_MS: Record<OperationClass, number> = {
  connect: 30_000,
  read: 30_000,
  mutate: 45_000,
  write: 150_000,
};

/** Default threshold (ms) above which a completed-but-slow operation gets
 *  logged. Deliberately much smaller than any deadline above — the incident
 *  complaint was silence, not just the eventual hang. */
const DEFAULT_SLOW_OP_THRESHOLD_MS = 3_000;
export const SLOW_OP_THRESHOLD_ENV = 'SOX_MEMORY_SERVER_SLOW_OP_THRESHOLD_MS';

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Resolve the deadline (ms) for an operation class, honouring the env
 *  override. Read PER CALL (not cached) so tests can flip env vars without a
 *  process restart — mirrors the convention memory-core's telemetry.ts
 *  already established for this codebase. */
export function deadlineMsFor(opClass: OperationClass): number {
  return readPositiveIntEnv(DEADLINE_ENV[opClass], DEFAULT_DEADLINE_MS[opClass]);
}

/** Resolve the slow-operation logging threshold (ms), env-overridable. */
export function slowOpThresholdMs(): number {
  return readPositiveIntEnv(SLOW_OP_THRESHOLD_ENV, DEFAULT_SLOW_OP_THRESHOLD_MS);
}

/**
 * Typed, traced error thrown when an operation exceeds its deadline. `log`
 * (from `@adhd/sox-memory-core`) stamps every emission with the ambient
 * `trace_id` automatically (see telemetry.ts's `emit()`) — the timeout log
 * line this error is always paired with (`store.operation.timeout`, emitted
 * by `withOperationDeadline` before this constructs) carries that trace_id,
 * so this error and its log line are correlatable even though the Error
 * object itself does not carry a trace_id field.
 */
export class StoreOperationTimeoutError extends Error {
  readonly code = 'E_STORE_OPERATION_TIMEOUT' as const;
  readonly opClass: OperationClass;
  readonly opName: string;
  readonly timeoutMs: number;
  readonly dbPath: string | undefined;

  constructor(opClass: OperationClass, opName: string, timeoutMs: number, dbPath: string | undefined) {
    super(
      `store operation "${opName}" (class=${opClass}) exceeded its ${timeoutMs}ms deadline — ` +
        'the underlying store call is still outstanding (BUG-MEMORYSERVER-WEDGES-SILENTLY-NO-SELF-RECOVERY-001); ' +
        'this request failed fast instead of hanging the process.',
    );
    this.name = 'StoreOperationTimeoutError';
    this.opClass = opClass;
    this.opName = opName;
    this.timeoutMs = timeoutMs;
    this.dbPath = dbPath;
  }
}

export interface OperationDeadlineOptions {
  opClass: OperationClass;
  opName: string;
  dbPath?: string;
  /**
   * Extra fields merged into every log line this call emits — e.g. the
   * adapter's `connectionHealth` at the moment of a timeout. Finding from
   * this incident: store-adapter's 'healthy'|'poisoned'|'reconnecting'
   * state machine (SPEC-CONN-RECYCLE, turso-adapter.ts) only transitions on
   * a THROWN/rejected error (`isFatalConnectionError(err)`) — it has no
   * timeout-based trigger of its own, so a call that never returns at all
   * (no error, no resolve — exactly this incident's shape) is structurally
   * invisible to it; reading `connectionHealth` at timeout time answers
   * "did the existing health machine even notice?" directly in the log.
   * A thunk (not a plain object) so each log emission reads the CURRENT
   * value — connectionHealth genuinely changes between an operation's start
   * and its eventual timeout/slow-still-running/completion log lines.
   */
  extraFields?: () => Record<string, unknown>;
}

/**
 * Race `fn()` against a per-class deadline. On timeout: logs LOUDLY
 * (`store.operation.timeout`, level error) and rejects with a
 * `StoreOperationTimeoutError` — the caller gets a typed, traced failure
 * instead of an indefinite hang. `fn()` itself is NOT cancelled (JS/the
 * underlying driver offers no such primitive for a blocked native call) —
 * it keeps running in the background; if it later settles, that is logged
 * too (`store.operation.completed_after_timeout` /
 * `store.operation.failed_after_timeout`) so a recurrence of this exact
 * incident shape is diagnosable from the log instead of `lsof`+`ps`.
 *
 * Any operation that takes >= the slow-op threshold (default 3s, well under
 * every deadline above) is logged on completion with its duration, whether
 * it succeeded, failed, or timed out — "operation exceeding a few seconds"
 * per the incident's ask. A timer armed at the threshold also fires a
 * `store.operation.slow_still_running` warning if the op is STILL in flight
 * at that point, so a long-but-not-yet-timed-out operation is visible in
 * the log before it resolves, not just after.
 */
export function withOperationDeadline<T>(
  fn: () => Promise<T>,
  opts: OperationDeadlineOptions,
): Promise<T> {
  const { opClass, opName, dbPath, extraFields } = opts;
  const timeoutMs = deadlineMsFor(opClass);
  const slowThresholdMs = slowOpThresholdMs();
  const startedAt = Date.now();

  let settled = false;
  let timedOut = false;

  const baseFields = (): Record<string, unknown> => ({
    op_class: opClass,
    op_name: opName,
    ...(dbPath !== undefined ? { db_path: dbPath } : {}),
    ...(extraFields ? extraFields() : {}),
  });

  const slowStillRunningTimer = setTimeout(() => {
    if (settled) return;
    log.warn('store.operation.slow_still_running', {
      ...baseFields(),
      elapsed_ms: Date.now() - startedAt,
      threshold_ms: slowThresholdMs,
    });
  }, slowThresholdMs);
  if (typeof slowStillRunningTimer.unref === 'function') slowStillRunningTimer.unref();

  let deadlineTimer!: ReturnType<typeof setTimeout>;
  const deadlinePromise = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      const elapsedMs = Date.now() - startedAt;
      log.error('store.operation.timeout', { ...baseFields(), timeout_ms: timeoutMs, elapsed_ms: elapsedMs });
      reject(new StoreOperationTimeoutError(opClass, opName, timeoutMs, dbPath));
    }, timeoutMs);
    if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
  });

  const work = (async (): Promise<T> => {
    try {
      const result = await fn();
      settled = true;
      clearTimeout(slowStillRunningTimer);
      clearTimeout(deadlineTimer);
      const elapsedMs = Date.now() - startedAt;
      if (timedOut) {
        // Recovered after we already told the caller it timed out — that is
        // itself the exact diagnosability gap the incident report asked for:
        // proof the underlying call eventually returns (or doesn't), landed
        // in the durable log rather than requiring `lsof`/`ps` next time.
        log.warn('store.operation.completed_after_timeout', { ...baseFields(), elapsed_ms: elapsedMs });
      } else if (elapsedMs >= slowThresholdMs) {
        log.warn('store.operation.slow_finished', { ...baseFields(), elapsed_ms: elapsedMs });
      }
      return result;
    } catch (err) {
      settled = true;
      clearTimeout(slowStillRunningTimer);
      clearTimeout(deadlineTimer);
      const elapsedMs = Date.now() - startedAt;
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (timedOut) {
        log.warn('store.operation.failed_after_timeout', { ...baseFields(), elapsed_ms: elapsedMs, error: errorMsg });
      } else if (elapsedMs >= slowThresholdMs) {
        log.warn('store.operation.slow_failed', { ...baseFields(), elapsed_ms: elapsedMs, error: errorMsg });
      }
      throw err;
    }
  })();

  return Promise.race([work, deadlinePromise]);
}
