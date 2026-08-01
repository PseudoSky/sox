/**
 * @adhd/sox-telemetry — the BL-351 tracing/metrics substrate.
 *
 * This is the ONLY package in the repo permitted to house the durable JSONL
 * sink and the wait/work primitive; every other package imports from here
 * rather than hand-rolling its own (BL-351 §5.0). See
 * `docs/research/observability-substrate.md` for the full design and
 * `docs/observability/README.md` for how to read the emitted stream.
 *
 * Published surface, stable names/units (extend this table when you add an
 * instrument — it is the contract PKT-24/25/26/27/44 build against):
 *
 * | Instrument              | Kind              | Unit         | Attributes                                   |
 * |--------------------------|-------------------|--------------|-----------------------------------------------|
 * | `sox.stage.<name>.start`    | log record (hang-visible) | -    | sox_package, sox_stage, sox_path, sox_phase   |
 * | `sox.stage.<name>.admitted` | log record                | wait_ms (ms) | + wait_ms                                     |
 * | `sox.stage.<name>.finish`   | log record                | ms           | + wait_ms, work_ms                            |
 * | `sox.stage.<name>.error`    | log record                | ms           | + wait_ms, work_ms, error                     |
 * | `<event>.start`             | log record (hang-visible) | -            | caller-supplied fields                        |
 * | `<event>.finish`            | log record                 | duration_ms (ms) | caller-supplied fields + duration_ms     |
 * | `<event>.error`             | log record                 | duration_ms (ms) | caller-supplied fields + duration_ms, error |
 *
 * Every record additionally carries `service`, `role`, `trace_id`, `pid`,
 * `ts` (ISO-8601), `level` — set once by `initTelemetry`, never per call site.
 */

import { performance } from 'node:perf_hooks';
import { _emitRecord, currentRuntimeState, type LogFields, log } from './runtime.js';

export {
  initTelemetry,
  currentRuntimeState,
  log,
  telemetrySelfCheck,
  _resetTelemetryForTest,
} from './runtime.js';
export type {
  Role,
  LogSink,
  Outcome,
  InitTelemetryOptions,
  TelemetryHandle,
  LogFields,
  TelemetrySelfCheck,
  StageSelfCheck,
} from './runtime.js';

export { declareStages, StageCatalog } from './stages.js';
export type { StageDeclaration, StageMap } from './stages.js';

export { DurableJsonlSink } from './sink.js';
export type { JsonlSinkOptions } from './sink.js';

export { newTraceId, currentTraceId, traceIdOrNew, withTrace, runWithNewTrace } from './trace.js';

/** Truncate a value for safe, size-bounded logging (SQL text, error messages). */
export function truncateForLog(s: string, maxLen = 500): string {
  return s.length > maxLen ? `${s.slice(0, maxLen)}…[+${s.length - maxLen}b truncated]` : s;
}

/**
 * Log the START of `event` immediately, then run `fn`, then log its finish
 * or error with an elapsed `duration_ms`. The START line reaches the sink
 * before `fn` is even invoked, so an operation that never returns (a hang)
 * is already durably visible with no further code needed.
 */
export async function withTimedEvent<T>(event: string, fields: LogFields, fn: () => Promise<T>): Promise<T> {
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

/**
 * Wrap every method of `obj` so a method added tomorrow by someone who never
 * heard of telemetry is instrumented by construction (BL-351 §5.3(c),
 * generalising `instrumentAdapter`/`instrumentQueryMethods`
 * (`libs/memory-core/src/telemetry.ts`)). Only methods named in `methods` are
 * intercepted; everything else is a transparent passthrough bound to the
 * real target — `this` is always the real object, never the proxy.
 */
export function instrumentBoundary<T extends object>(
  obj: T,
  opts: { component: string; methods: readonly (keyof T & string)[] },
): T {
  const methodSet = new Set<string>(opts.methods);
  return new Proxy(obj, {
    get(target, prop, _receiver): unknown {
      const orig = Reflect.get(target, prop, target) as unknown;
      if (typeof orig !== 'function') return orig;
      const bound = (orig as (...a: unknown[]) => unknown).bind(target);
      if (typeof prop !== 'string' || !methodSet.has(prop)) return bound;
      const method = prop;
      return async (...args: unknown[]): Promise<unknown> =>
        withTimedEvent(`${opts.component}.${method}`, { role: currentRuntimeState().role }, () =>
          Promise.resolve(bound(...args)),
        );
    },
  }) as T;
}

export { _emitRecord as _internalEmitRecord };
