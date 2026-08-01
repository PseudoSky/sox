/**
 * telemetry.ts — persisted structured logging + tracing for memory-core (BL-320).
 *
 * INCIDENT CONTEXT: the live Turso migration was debugged "nearly blind" — the
 * only diagnostics were ad-hoc `console.error` lines (write-queue.ts, embed-pipeline.ts)
 * that vanish once the host rotates/loses stdio, carry no correlation id, and
 * never record an operation's START — only whatever happened to get logged on
 * the way out. A hang (the exact recall bug that triggered this work) left
 * ZERO trace. This module fixes that structurally:
 *
 *   - JSONL, one event per line, to a ROTATING file under
 *     `~/.adhd/sox-ecosystem/memory/logs/` (this machine's convention: personal
 *     tool/service state lives under `~/.adhd/<tool>/`, not XDG paths — see
 *     `SOX_ECOSYSTEM_HOME` / ADR-0004's data-root, which this mirrors without
 *     introducing a cross-package dependency on host-runtime).
 *   - A trace id threaded end-to-end via `AsyncLocalStorage`: whichever code
 *     path establishes the root context (normally `WriteQueue.enqueue`) makes
 *     every nested `log.*` call — write.ts, embed.ts, embed-pipeline.ts,
 *     db.ts — automatically carry the same `trace_id`, with ZERO signature
 *     changes required on any function in between.
 *   - `withTimedEvent` / `logOpStart` always log the START of an operation
 *     BEFORE awaiting it, so an operation that never returns (a hang) is
 *     already durably visible in the log — this is the single biggest gap the
 *     incident exposed and the reason a plain try/finally wrapper is not
 *     enough (finally never runs on a hang).
 *   - NEVER logs episode content, embedding vectors, or raw query parameters —
 *     only ids, counts, byte lengths, durations, and error text.
 *   - Logging NEVER throws and NEVER blocks the hot path: every write is best
 *     effort (fire-and-forget stream write), wrapped in try/catch, silently
 *     dropped on failure.
 *
 * Env surface (all optional; safe defaults so logging is ON by default):
 *   SOX_MEMORY_LOG_DIR        — override the log directory entirely.
 *   SOX_MEMORY_LOG_LEVEL      — 'debug'|'info'|'warn'|'error' (default 'info').
 *   SOX_MEMORY_LOG_COMPONENT  — file-name prefix (default 'memory-core').
 *   SOX_MEMORY_LOG_DISABLE    — '1' disables all writes (tests / opt-out).
 *   SOX_MEMORY_LOG_MAX_BYTES  — size-based rotation cap (default 20_000_000).
 *   SOX_MEMORY_LOG_MAX_FILES  — retained rotated files per component (default 7).
 *
 * All env vars are read PER CALL (not cached at module load) so tests and
 * live operators can flip them without a process restart.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { performance } from 'node:perf_hooks';
import { DurableJsonlSink } from '@adhd/sox-telemetry';
import {
  newTraceId,
  currentTraceId,
  traceIdOrNew,
  withTrace,
  runWithNewTrace,
} from '@adhd/sox-telemetry';
import { startSuspensionTracking, suspensionBetween } from './suspension.js';

// BL-401: trace-id propagation is no longer a private AsyncLocalStorage
// instance here — it is re-exported from `@adhd/sox-telemetry`'s `trace.ts`,
// which is the ONE ALS instance for the whole process. Two independent ALS
// instances (the old shape: one here, one in the substrate) cannot see each
// other's context, which would silently break trace-id propagation exactly at
// the memory-core / sox-telemetry package boundary — see trace.ts's own doc
// comment. `newTraceId`/`currentTraceId`/`traceIdOrNew`/`withTrace`/
// `runWithNewTrace` keep their exact prior signatures; every existing caller
// in this codebase (write-queue.ts, write.ts, embed-pipeline.ts) is unchanged.
export { newTraceId, currentTraceId, traceIdOrNew, withTrace, runWithNewTrace };

// ── Levels ────────────────────────────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function resolveLevel(): LogLevel {
  const raw = (process.env['SOX_MEMORY_LOG_LEVEL'] ?? 'info').toLowerCase();
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info';
}

function isDisabled(): boolean {
  return process.env['SOX_MEMORY_LOG_DISABLE'] === '1';
}

// ── Path resolution (mirrors ADR-0004's data-root, without depending on
//    host-runtime — memory-core must not take a reverse dependency on it) ──────

function ecosystemHome(): string {
  const override = process.env['SOX_ECOSYSTEM_HOME'];
  if (override !== undefined && override !== '') return override;
  return path.join(os.homedir(), '.adhd', 'sox-ecosystem');
}

function resolveLogDir(): string {
  const override = process.env['SOX_MEMORY_LOG_DIR'];
  if (override !== undefined && override !== '') return override;
  return path.join(ecosystemHome(), 'memory', 'logs');
}

function resolveComponent(): string {
  return process.env['SOX_MEMORY_LOG_COMPONENT'] ?? 'memory-core';
}

function resolveMaxBytes(): number {
  const raw = process.env['SOX_MEMORY_LOG_MAX_BYTES'];
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 20_000_000;
}

/**
 * BL-365: are log writes synchronous (durable) or buffered (fast)?
 *
 * DEFAULT: durable. The owner's requirement is that telemetry be **written to
 * disk**, on the rationale that the process holding in-memory evidence is the
 * one that crashes. The previous implementation used a fire-and-forget
 * `createWriteStream`, and measurement showed **0 of 10,000 records surviving
 * SIGKILL** — the log looked healthy precisely because it could only be read
 * from a process that had not crashed.
 *
 * The realistic exposure was the current synchronous burst plus roughly the
 * last 1-5 ms. A *hang* lost nothing; a SIGKILL, panic, or power cut lost
 * exactly the pre-crash window the log exists for — and the host lost power
 * mid-backfill on 2026-07-30 (BL-338), so that window is simply gone for the
 * one incident we most needed to analyse.
 *
 * Cost, measured over 50,000 records: 3,254 ns/record synchronous vs 1,043
 * ns/record buffered — **+2.2µs**. At the projected live rate that is ~15 ms of
 * CPU per day, and a 100-record burst blocks the event loop for 0.33 ms.
 * Durability is the correct default at that price.
 *
 * `SOX_MEMORY_LOG_SYNC=0` opts back into buffered writes for a
 * high-volume/low-forensic-value population (test and CI processes, which were
 * measured at 97.3% of total log volume and ~0% of forensic value). Set it
 * deliberately; it trades away crash evidence.
 */
function durableWrites(): boolean {
  const raw = (process.env['SOX_MEMORY_LOG_SYNC'] ?? '').toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off');
}

function resolveMaxFiles(): number {
  const raw = process.env['SOX_MEMORY_LOG_MAX_FILES'];
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 7;
}

// ── Durable JSONL sink (BL-401: migrated onto the shared substrate) ────────────
//
// This used to be a private `RotatingJsonlWriter` class — a near-duplicate of
// `@adhd/sox-telemetry`'s `DurableJsonlSink` (BL-351 §5.6/§5.8), which was
// itself generalized FROM this class. Now there is exactly one durable-JSONL
// implementation in the repo; memory-core just composes it.
//
// ENV CONTRACT (the reason this isn't a one-line swap — see BL-401's fix
// note): `DurableJsonlSink` takes its directory/component/rotation policy as
// CONSTRUCTOR options rather than reading `process.env` itself — env
// resolution belongs to the composition root, not the sink (by design, so
// role-qualified callers don't need the sink to know about env at all). But
// `telemetry-crash-durability.spec.ts` and `telemetry.spec.ts` are
// load-bearing regression tests that rely on `SOX_MEMORY_LOG_*` being
// re-read PER CALL — a test flips an env var mid-run without reconstructing
// anything and expects the very next `log.*` call to honour it.
//
// The sink's own `reconfigure()` method exists for exactly this shape (see
// its doc comment: "lets a caller re-resolve environment variables on every
// call ... without constructing a new sink instance per write"). `getWriter()`
// below re-resolves every env var on EVERY call (mirroring the old
// `RotatingJsonlWriter.write()`'s per-write env read) and calls
// `reconfigure()` before returning the singleton sink; the sink itself
// detects drift against what it's currently opened for and reopens lazily on
// the next `write()`. This preserves BL-365's crash-durability guarantee
// unchanged — `durable` is resolved via the same `SOX_MEMORY_LOG_SYNC`
// per-call read as before, just plumbed through `reconfigure()` instead of a
// private field.
function currentSinkOptions(): {
  dir: string;
  component: string;
  maxBytes: number;
  maxFiles: number;
  durable: boolean;
} {
  return {
    dir: resolveLogDir(),
    component: resolveComponent(),
    maxBytes: resolveMaxBytes(),
    maxFiles: resolveMaxFiles(),
    durable: durableWrites(),
  };
}

let _writer: DurableJsonlSink | null = null;
function getWriter(): DurableJsonlSink {
  const opts = currentSinkOptions();
  if (_writer === null) {
    _writer = new DurableJsonlSink(opts);
  } else {
    _writer.reconfigure(opts);
  }
  return _writer;
}

/** Test-only: close the active stream and drop the singleton so the next
 *  write() re-resolves env vars / paths from scratch. */
export function _resetTelemetryForTest(): void {
  if (_writer) _writer.close();
  _writer = null;
}

/** The file currently being written, or '' if nothing has been logged yet. */
export function currentLogFilePath(): string {
  return getWriter().currentPath();
}

/** Test-only: await flush of every `log.*` call made so far (writes are async
 *  fire-and-forget on the hot path; tests need a deterministic sync point). */
export function _flushTelemetryForTest(): Promise<void> {
  return getWriter().flush();
}

// ── Core log record + emission ──────────────────────────────────────────────────

export interface LogFields {
  [key: string]: unknown;
}

/**
 * BL-369: annotate any record carrying a `duration_ms` with how much of that
 * window the process was not actually running.
 *
 * Done HERE, at the logging boundary, rather than at each call site. There are
 * a dozen inline `duration_ms` emitters (`embed.ts`, `write.ts`, `write-queue.ts`
 * ×6, `db.ts` ×2, `withTimedEvent`) and a call-site fix would have to be
 * repeated by every future one — the same "remembered convention" failure that
 * left BL-320's telemetry unread and BL-344's allowlist duplicated six times.
 * Annotating at the boundary makes every emitter, present and future, correct
 * by construction.
 *
 * `duration_ms` itself is NEVER modified: it stays raw and reconcilable against
 * the record's own `ts`. See `suspension.ts` for why annotating beats
 * subtracting, and for the measurements showing no clock swap can fix this.
 */
function annotateSuspension(fields?: LogFields): LogFields | undefined {
  const d = fields?.['duration_ms'];
  if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0) return fields;
  const end = Date.now();
  const extra = suspensionBetween(end - d, end);
  if (extra.suspended_ms === 0 && extra.blocked_ms === 0) return fields;
  return {
    ...fields,
    ...(extra.suspended_ms > 0 ? { suspended_ms: extra.suspended_ms } : {}),
    ...(extra.blocked_ms > 0 ? { blocked_ms: extra.blocked_ms } : {}),
  };
}

function emit(level: LogLevel, event: string, rawFields?: LogFields): void {
  try {
    if (isDisabled()) return;
    if (LEVEL_ORDER[level] < LEVEL_ORDER[resolveLevel()]) return;
    // Cheap and idempotent; guarantees the ledger is running wherever telemetry
    // is, without every consumer having to remember to start it. The timer is
    // unref()'d, so this can never hold a process open (BL-370's failure shape).
    startSuspensionTracking();
    const fields = annotateSuspension(rawFields);
    const traceId = (fields && typeof fields['trace_id'] === 'string' ? (fields['trace_id'] as string) : undefined) ?? currentTraceId() ?? null;
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      event,
      trace_id: traceId,
      pid: process.pid,
      ...fields,
    };
    getWriter().write(JSON.stringify(record) + '\n');
  } catch {
    // Logging must NEVER break or slow the caller — swallow anything, including
    // a JSON.stringify failure on a pathological `fields` value.
  }
}

export const log = {
  debug: (event: string, fields?: LogFields): void => emit('debug', event, fields),
  info: (event: string, fields?: LogFields): void => emit('info', event, fields),
  warn: (event: string, fields?: LogFields): void => emit('warn', event, fields),
  error: (event: string, fields?: LogFields): void => emit('error', event, fields),
};

/** Truncate a value for safe, size-bounded logging (SQL text, error messages). */
export function truncateForLog(s: string, maxLen = 500): string {
  return s.length > maxLen ? `${s.slice(0, maxLen)}…[+${s.length - maxLen}b truncated]` : s;
}

/**
 * Log the START of `event` immediately, then run `fn`, then log its finish or
 * error with an elapsed `duration_ms`. The START line is written and flushed
 * to the OS write buffer before `fn` is even invoked — so a hang inside `fn`
 * (the exact class of bug this module exists to catch) is already visible in
 * the log with no further code needed.
 */
export async function withTimedEvent<T>(
  event: string,
  fields: LogFields,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = performance.now();
  log.info(`${event}.start`, fields);
  try {
    const result = await fn();
    log.info(`${event}.finish`, { ...fields, duration_ms: Math.round(performance.now() - t0) });
    return result;
  } catch (err) {
    log.error(`${event}.error`, {
      ...fields,
      duration_ms: Math.round(performance.now() - t0),
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// ── Adapter instrumentation (store/SQL error capture with SQL text) ────────────

const QUERY_METHODS = new Set(['executeGet', 'executeAll', 'executeRun', 'exec']);

/**
 * Wrap every query-executing method of an adapter-shaped object (StoreAdapter
 * OR AdapterTransaction — same method names/signatures) so that any thrown
 * error is logged with the offending SQL text (truncated) BEFORE being
 * re-thrown UNCHANGED. Pure passthrough on success — zero behavioural change,
 * only observability. `adapterType` is attached to every error line so Turso
 * vs. SQLite failures are trivially greppable (`rg '"adapter_type":"turso"'`).
 *
 * Implemented as a `Proxy` (not a property-copy) specifically so every
 * unwrapped method call still forwards `this === target` — the real adapter
 * instance, including its private/internal state — never the proxy. Only
 * `executeGet`/`executeAll`/`executeRun`/`exec` are intercepted; everything
 * else (`transaction`, `config`, `capabilities`, `close`, `unwrap`, …) is a
 * transparent passthrough bound to the real target.
 */
export function instrumentQueryMethods<T extends object>(target: T, adapterType: string): T {
  return new Proxy(target, {
    get(obj, prop, _receiver): unknown {
      const orig = Reflect.get(obj, prop, obj) as unknown;
      if (typeof orig !== 'function') return orig;
      const boundOrig = (orig as (...a: unknown[]) => unknown).bind(obj);
      if (typeof prop !== 'string' || !QUERY_METHODS.has(prop)) return boundOrig;
      const method = prop;
      return async (...args: unknown[]): Promise<unknown> => {
        try {
          return await boundOrig(...args);
        } catch (err) {
          const sql = typeof args[0] === 'string' ? truncateForLog(args[0]) : undefined;
          log.error('store.error', {
            method,
            sql,
            adapter_type: adapterType,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      };
    },
  }) as T;
}

/** Structural shape needed to instrument `transaction()` as well — kept
 *  minimal/local so telemetry.ts does not need to import the full
 *  `@adhd/sox-store-adapter` generic types just for this helper. */
export interface TransactionCapable<Tx> {
  transaction<T>(fn: (tx: Tx) => T | Promise<T>, opts?: unknown): Promise<T>;
}

/**
 * Wrap a full adapter: instruments its own query methods AND wraps
 * `transaction()` so the transaction object handed to the callback is ALSO
 * instrumented — every SQL error anywhere on the write/read path (open-time
 * DDL, a Phase-A insert, a recall query, a curate op) is captured with its
 * SQL text, not just top-level adapter calls.
 */
export function instrumentAdapter<A extends TransactionCapable<Tx>, Tx extends object>(
  adapter: A,
  adapterType: string,
): A {
  return new Proxy(adapter, {
    get(obj, prop, _receiver): unknown {
      if (prop === 'transaction') {
        return <T>(fn: (tx: Tx) => T | Promise<T>, opts?: unknown): Promise<T> =>
          obj.transaction((tx: Tx) => fn(instrumentQueryMethods(tx, adapterType)), opts);
      }
      const orig = Reflect.get(obj, prop, obj) as unknown;
      if (typeof orig !== 'function') return orig;
      const bound = (orig as (...a: unknown[]) => unknown).bind(obj);
      if (typeof prop === 'string' && QUERY_METHODS.has(prop)) {
        const method = prop;
        return async (...args: unknown[]): Promise<unknown> => {
          try {
            return await bound(...args);
          } catch (err) {
            const sql = typeof args[0] === 'string' ? truncateForLog(args[0]) : undefined;
            log.error('store.error', {
              method,
              sql,
              adapter_type: adapterType,
              error: err instanceof Error ? err.message : String(err),
            });
            throw err;
          }
        };
      }
      return bound;
    },
  }) as A;
}
