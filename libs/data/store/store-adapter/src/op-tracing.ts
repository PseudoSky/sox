/**
 * Per-call DB-operation tracing shared by `SqliteAdapterImpl._trackOp` and
 * `TursoAdapterImpl._trackOp`, plus each adapter's documented bypass sites
 * (idle-flush, wal-ownership heartbeat, reconnect, close, fts-optimize —
 * see the BUG-022 comments at those call sites for why they must NOT route
 * through `_trackOp`).
 *
 * Convention: this package has no existing `withTimedEvent`/stage-substrate
 * usage in either adapter file — every other `log.*` call site here uses a
 * plain `store_adapter.<engine>.<event>` key (see `retry.ts`, the
 * `wal_cap_flush*`/`idle_flush*`/`adapter_meta_failed` events in
 * sqlite-adapter.ts). This module follows that convention rather than
 * introducing `withTimedEvent`'s unconditional per-call `.start` log line,
 * which would flood the sink at DB-call frequency.
 *
 * Aggregation uses `registerSnapshotSection` (sox-telemetry's existing
 * `metrics.snapshot` extension point) registered exactly ONCE at module
 * scope — never per adapter instance. `getDb`/memory-core caches several
 * concurrent adapter instances per process and `backupTo` opens throwaway
 * instances constantly; per-instance registration would either collide on
 * the section name or leak unregistered sections.
 */
import { performance } from 'node:perf_hooks';
import { log, registerSnapshotSection } from '@adhd/sox-telemetry';
import {
  isFatalConnectionError,
  isConcurrentConflict,
  isBusyError,
  isUniqueConstraintError,
  isForeignKeyError,
  dbErrorCode,
} from './errors.js';

/**
 * Local truncate helper — deliberately NOT `@adhd/sox-telemetry`'s own
 * `truncateForLog` export. Measured directly (see the backlog item filed
 * alongside this module): under `node --import tsx`'s CJS↔ESM interop, a
 * named import of `truncateForLog`/`withSpan`/`withTimedEvent`/
 * `instrumentBoundary` from `@adhd/sox-telemetry` throws
 * `SyntaxError: The requested module '@adhd/sox-telemetry' does not provide
 * an export named 'truncateForLog'` — reproduced with a minimal two-line
 * probe, independent of this package. `log` and `registerSnapshotSection`
 * (both re-exported from `runtime.js` via `Object.defineProperty` getters)
 * import cleanly; the four symbols defined directly in `sox-telemetry/src/
 * index.ts` and exported via plain `exports.name = name` assignments do not
 * — cjs-module-lexer (Node's static CJS-named-export scanner for ESM
 * `import {...}` of a CJS module) fails to detect that specific shape here.
 * Root-caused to `@adhd/sox-telemetry`, out of this package's scope to fix;
 * this local copy sidesteps it entirely.
 */
function truncateForLog(s: string, maxLen = 500): string {
  return s.length > maxLen ? `${s.slice(0, maxLen)}…[+${s.length - maxLen}b truncated]` : s;
}

/** Typed config default — ADR-0013 (typed tuning, never an env toggle). */
export const DEFAULT_SLOW_OP_THRESHOLD_MS = 1000;

export type OpBackend = 'sqlite' | 'turso';

/** Phased wall-clock timing for one tracked (or bypass) operation. */
export interface OpTiming {
  /** Time spent in `_ensureHealthy()` — TursoAdapter only. `undefined` when
   *  the backend/call site has no health-check phase (e.g. every sqlite
   *  `_trackOp` call, and every bypass site on both backends). */
  health_ms?: number | undefined;
  /** Time spent in the caller's `fn()` (or, for a bypass site, the whole
   *  instrumented body). */
  op_ms: number;
  /** Time spent in the post-write WAL-identity-recovery + wal-cap-flush
   *  check — write ops only. */
  post_write_ms?: number | undefined;
}

/**
 * (ADR-0012 §3: "adapter detects, memory-core classifies") There is no
 * driver-agnostic `StorageErrorCode` taxonomy in this package — that
 * classification lives in memory-core, which `data` packages may not import
 * (`libs/data/CLAUDE.md` boundary rule: `data→data|shared` only). This is a
 * small LOCAL label for tracing/log purposes only, built from the detectors
 * `errors.ts` already exports — not a re-implementation of the taxonomy.
 */
export function classifyOpError(err: unknown): string {
  if (isFatalConnectionError(err)) return 'fatal_connection';
  if (isConcurrentConflict(err)) return 'concurrent_conflict';
  if (isBusyError(err)) return 'busy';
  if (isUniqueConstraintError(err)) return 'unique_constraint';
  if (isForeignKeyError(err)) return 'foreign_key';
  return dbErrorCode(err) ?? 'unknown';
}

interface OpAggregate {
  count: number;
  error_count: number;
  slow_count: number;
  total_ms: number;
  max_ms: number;
}

function newAggregate(): OpAggregate {
  return { count: 0, error_count: 0, slow_count: 0, total_ms: 0, max_ms: 0 };
}

const aggregates = new Map<OpBackend, Map<string, OpAggregate>>([
  ['sqlite', new Map()],
  ['turso', new Map()],
]);

function getAggregate(backend: OpBackend, label: string): OpAggregate {
  const byLabel = aggregates.get(backend)!;
  let agg = byLabel.get(label);
  if (!agg) {
    agg = newAggregate();
    byLabel.set(label, agg);
  }
  return agg;
}

let unregisterSnapshotSection: (() => void) | null = null;

function ensureSnapshotSectionRegistered(): void {
  if (unregisterSnapshotSection !== null) return;
  unregisterSnapshotSection = registerSnapshotSection('store_adapter.op_timing', () => {
    const out: Record<string, unknown> = {};
    for (const [backend, byLabel] of aggregates) {
      const backendOut: Record<string, unknown> = {};
      for (const [label, agg] of byLabel) {
        backendOut[label] = {
          count: agg.count,
          error_count: agg.error_count,
          slow_count: agg.slow_count,
          avg_ms: agg.count > 0 ? Math.round(agg.total_ms / agg.count) : 0,
          max_ms: agg.max_ms,
        };
      }
      out[backend] = backendOut;
    }
    return out;
  });
}
ensureSnapshotSectionRegistered();

/**
 * Record the outcome of one op — logs a failure unconditionally, logs a slow
 * completion when `timing.op_ms` (or, if absent, the total) meets/exceeds
 * `slowThresholdMs`, and ALWAYS updates the process-local aggregate whether
 * or not a line was logged (the `metrics.snapshot`-style counters described
 * above).
 */
export function recordOpOutcome(
  backend: OpBackend,
  label: string,
  timing: OpTiming,
  err: unknown,
  slowThresholdMs: number,
): void {
  const agg = getAggregate(backend, label);
  agg.count += 1;
  agg.total_ms += timing.op_ms;
  if (timing.op_ms > agg.max_ms) agg.max_ms = timing.op_ms;

  if (err !== undefined) {
    agg.error_count += 1;
    log.error(`store_adapter.${backend}.op_failed`, {
      op: label,
      error_code: classifyOpError(err),
      error: truncateForLog(err instanceof Error ? err.message : String(err)),
      health_ms: timing.health_ms,
      op_ms: timing.op_ms,
      post_write_ms: timing.post_write_ms,
    });
    return;
  }

  if (timing.op_ms >= slowThresholdMs) {
    agg.slow_count += 1;
    log.debug(`store_adapter.${backend}.op_slow`, {
      op: label,
      health_ms: timing.health_ms,
      op_ms: timing.op_ms,
      post_write_ms: timing.post_write_ms,
      threshold_ms: slowThresholdMs,
    });
  }
}

/** Monotonic ms — a thin, named wrapper so call sites read intent, not raw `performance.now()`. */
export function nowMs(): number {
  return performance.now();
}

/** Rounds a `performance.now()` delta to whole ms for logging/aggregation. */
export function elapsedMs(start: number): number {
  return Math.round(performance.now() - start);
}

/** Test-only reset — mirrors `_resetTelemetryForTest`'s purpose for this module's
 *  own process-local aggregates (not exported from the package's public surface). */
export function _resetOpTracingForTest(): void {
  for (const byLabel of aggregates.values()) byLabel.clear();
}
