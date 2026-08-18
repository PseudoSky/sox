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
 * Defaults. `connect` and `read` are generous relative to their documented
 * nominal cost (recall is <50ms nominal; `openDb` should be near-instant)
 * while still tolerating real contention — the incident's store sat blocked
 * for 24+ minutes, so even a "generous" 30s deadline is a two-orders-of-
 * magnitude improvement over "never".
 *
 * `write` must clear the measured embed max with real margin: 150000ms
 * (150s) leaves ~41s of headroom above the single worst embed observed in
 * production (109089ms).
 *
 * BL-576 (2026-08-17 re-verification): the 109089ms max is corroborated by a
 * FRESH, larger pull of the same real telemetry source
 * (`fastembed_process.request.finish`'s `response_ms`, emitted by
 * `SharedFastembedProcessClient.request()` in `embedding-provider` —
 * `~/.adhd/sox-ecosystem/memory-server/logs/memory-server.live-service-*.jsonl`,
 * n=3873 spanning 2026-08-05..2026-08-17): p50=985ms p90=5532ms p95=12350ms
 * p99=38283ms max=109089ms — max matches exactly. This distribution is
 * genuine, uncensored production queueing latency (real head-of-line
 * blocking behind the shared fastembed child process), NOT a `mutate`- or
 * `write`-deadline artifact: `response_ms` is measured entirely inside
 * `request()`, which `withOperationDeadline` never cancels, so it keeps
 * timing the real underlying call to its real completion regardless of
 * whether the MCP caller was already told the operation timed out. Of 3873
 * samples, only 1 falls in the [43000,46000]ms band that a right-censoring
 * artifact at a ~45s ceiling would pile up against — the tail continues
 * smoothly past it out to 109089ms. See `operation-guard.spec.ts`'s
 * `describe('BL-576 ...')` block for the full write-up, a controlled
 * experiment proving the abstract censoring mechanism IS real when a
 * consumer naively times the guard's own caller-facing promise (which this
 * file does NOT do for its own `slow_finished`/`timeout` telemetry — see
 * `censored` below), and the reconciliation applied here.
 *
 * `mutate` was 45000ms. No currently-classified `mutate` tool embeds
 * (`toolOperationClass` in `index.ts` routes every write-capable tool —
 * `memory_write`, `memory_write_batch`, `memory_update` — to `write`, not
 * `mutate`; verified unchanged since this file's creation). But `mutate` is
 * the documented fallback for any FUTURE unclassified tool specifically
 * "in case it embeds" (see `toolOperationClass`'s doc comment in `index.ts`)
 * — a fallback that was not actually safe against the real embed tail above
 * (109089ms > 45000ms). Raised to 120000ms: clears the measured max with
 * ~11s of real margin while staying meaningfully tighter than `write`'s
 * 150000ms, preserving the intended distinction between "might occasionally
 * embed" (mutate) and "routinely embeds synchronously" (write).
 */
const DEFAULT_DEADLINE_MS: Record<OperationClass, number> = {
  connect: 30_000,
  read: 30_000,
  mutate: 120_000,
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
  /**
   * BL-576: always `true`. A positive marker (not just "absence of a real
   * value") that `timeoutMs` — the only duration this error carries — is a
   * CEILING, not a measurement: the underlying call had not settled when
   * this rejected, so `timeoutMs` says nothing about how long the real work
   * actually took. Any caller that logs or aggregates durations off this
   * error (rather than off a genuine completion) MUST check this flag and
   * exclude the sample from a percentile — mixing it in silently reproduces
   * exactly the right-censoring artifact BL-576 investigated. See the
   * `censored` field on the paired `store.operation.timeout` log line for
   * the same guarantee at the telemetry layer.
   */
  readonly censored = true as const;

  constructor(opClass: OperationClass, opName: string, timeoutMs: number, dbPath: string | undefined) {
    super(
      `store operation "${opName}" (class=${opClass}) exceeded its ${timeoutMs}ms deadline — ` +
        'the underlying store call is still outstanding (BUG-MEMORYSERVER-WEDGES-SILENTLY-NO-SELF-RECOVERY-001); ' +
        'this request failed fast instead of hanging the process. timeoutMs is a CEILING, not a ' +
        'measurement — see the `censored` field.',
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
 * instead of an indefinite hang.
 *
 * BL-576 — cancellation and censoring. `fn()` is NOT force-killed (JS/the
 * underlying native driver offers no such primitive for a call already
 * blocked in it) — but as of this fix `fn` receives an `AbortSignal`,
 * aborted the instant the deadline fires, so any callee built on an
 * abortable primitive (an abortable `fetch`, or `embedding-provider`'s
 * `SharedFastembedProcessClient.request()`, which now honours an external
 * signal) genuinely stops waiting and frees its own bookkeeping instead of
 * riding the timeout out. Every call site in this codebase today still
 * passes a 0-arg `() => Promise<T>` — that stays valid: TS accepts a
 * narrower-arity function wherever a signal parameter is expected, so this
 * is a non-breaking widening, not a rename. If a callee genuinely cannot
 * honour the signal (most native driver calls today), it keeps running in
 * the background exactly as before; if it later settles, that is logged too
 * (`store.operation.completed_after_timeout` /
 * `store.operation.failed_after_timeout`) so a recurrence of this exact
 * incident shape is diagnosable from the log instead of `lsof`/`ps`.
 *
 * Every timeout-path telemetry record and the `StoreOperationTimeoutError`
 * itself carry `censored: true` — a positive, machine-checkable marker that
 * `elapsed_ms`/`timeoutMs` on THAT record is a ceiling the caller gave up
 * at, not a real completion time. A percentile computed by pooling
 * `store.operation.timeout` samples together with genuine
 * `store.operation.slow_finished`/completion samples would reproduce
 * exactly the right-censoring artifact BL-576 set out to find; this flag is
 * the guard against a future consumer doing that by accident. (BL-576's own
 * investigation found the codebase's actual embed-latency percentile source
 * — `fastembed_process.request.finish`'s `response_ms`, read by
 * `tools/scorecard.mjs` — is measured from inside the un-cancelled `fn()`
 * itself, decoupled from this deadline entirely, and is therefore NOT
 * subject to this artifact; see `operation-guard.spec.ts`'s
 * `describe('BL-576 ...')` for the full mechanism proof and the production
 * evidence that refutes it as the source of the previously-suspected p99.)
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
  fn: (signal: AbortSignal) => Promise<T>,
  opts: OperationDeadlineOptions,
): Promise<T> {
  const { opClass, opName, dbPath, extraFields } = opts;
  const timeoutMs = deadlineMsFor(opClass);
  const slowThresholdMs = slowOpThresholdMs();
  const startedAt = Date.now();

  let settled = false;
  let timedOut = false;
  const abortController = new AbortController();

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
      // BL-576: `elapsed_ms` here always sits at ~`timeoutMs` by
      // construction (this timer fired at `timeoutMs`) — `censored: true`
      // says so explicitly rather than leaving that inferable only from
      // the event name.
      log.error('store.operation.timeout', {
        ...baseFields(),
        timeout_ms: timeoutMs,
        elapsed_ms: elapsedMs,
        censored: true,
      });
      const timeoutError = new StoreOperationTimeoutError(opClass, opName, timeoutMs, dbPath);
      abortController.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
    if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
  });

  const work = (async (): Promise<T> => {
    try {
      const result = await fn(abortController.signal);
      settled = true;
      clearTimeout(slowStillRunningTimer);
      clearTimeout(deadlineTimer);
      const elapsedMs = Date.now() - startedAt;
      if (timedOut) {
        // Recovered after we already told the caller it timed out — that is
        // itself the exact diagnosability gap the incident report asked for:
        // proof the underlying call eventually returns (or doesn't), landed
        // in the durable log rather than requiring `lsof`/`ps` next time.
        // This IS a genuine (uncensored) completion time — the work really
        // did take `elapsed_ms` — it is just arriving after the caller
        // already moved on; do not tag it `censored`.
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
