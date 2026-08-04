/**
 * otel.ts — the real OpenTelemetry SDK wiring (BL-401 gap 4).
 *
 * This is the ONLY file in the repo that imports `@opentelemetry/*` beyond the
 * bare API facade, and it is reached ONLY through a dynamic `import()` issued
 * inside `initTelemetry()` (see `otel-types.ts` for the measured reason). A
 * library that never calls `initTelemetry()` never loads any of this.
 *
 * What `docs/research/observability-substrate.md` specified, and what is here:
 *
 * | §    | Specified                                            | Implemented |
 * |------|------------------------------------------------------|-------------|
 * | §5.1 | `AsyncLocalStorageContextManager` registered globally | `bringUpOtel` — not reachable to forget (§3.4) |
 * | §5.1 | `BasicTracerProvider` + span processor               | `BasicTracerProvider({ resource, spanProcessors: [JsonlSpanProcessor] })` |
 * | §5.6 | `SpanProcessor.onStart` writes the START record       | `JsonlSpanProcessor.onStart` — hang-visible, the property a `SpanExporter` structurally cannot provide |
 * | §5.1 | `MeterProvider` with a **pull-only** reader           | `PullMetricReader extends MetricReader` — no timer, no `PeriodicExportingMetricReader` |
 * | §5.1 | exponential-histogram view                           | `AggregationType.EXPONENTIAL_HISTOGRAM`, `maxSize: 160` on `sox.stage.*_ms` |
 * | §3.3 | zero active handles                                  | asserted by `bl401-otel-sdk.spec.ts` via `getActiveResourcesInfo()` |
 *
 * **Neither `BatchSpanProcessor` nor `PeriodicExportingMetricReader` is used,
 * deliberately** (§3.3): both are timers doing work on the same event loop as
 * `memory_recall`, which is precisely the BL-345 starvation shape. Collection
 * happens synchronously inside the call that asked for it.
 */

import { context, trace, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  type ReadableSpan,
  type Span as SdkSpan,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  AggregationType,
  DataPointType,
  MeterProvider,
  MetricReader,
  type Histogram as OtelHistogramData,
  type ExponentialHistogram,
  type MetricData,
} from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { OtelAttributes, OtelMetricPoint, OtelRuntime, OtelSpanHandle } from './otel-types.js';

/** Attribute that tells `JsonlSpanProcessor` the caller already writes its own,
 *  richer JSONL lines for this span. See `OtelRuntime.withSpan`. */
export const SUPPRESS_RECORD_ATTR = 'sox.suppress_span_record';

export interface BringUpOtelOptions {
  service: string;
  role: string;
  /** Emit one JSONL record into the durable sink. Supplied by `runtime.ts` so
   *  span records inherit the exact same envelope (ts/level/event/service/role/
   *  trace_id/pid) as every other record — `docs/observability/README.md`'s
   *  catalog and the analysis scripts stay valid (§5.6: "the record format is
   *  unchanged"). */
  emit: (event: string, level: 'info' | 'error', fields: Record<string, unknown>) => void;
}

// ── §5.6: the span processor that preserves the hang guarantee ───────────────

/**
 * The START record is written from `onStart`, which fires BEFORE the span body
 * runs — so an operation that never returns is already durably on disk. A
 * `SpanExporter` only ever sees finished spans and therefore cannot see a hang
 * at all; the research prototype measured exactly that (2 started, 1 exported).
 */
class JsonlSpanProcessor implements SpanProcessor {
  constructor(private readonly opts: BringUpOtelOptions) {}

  private suppressed(attrs: Record<string, unknown>): boolean {
    return attrs[SUPPRESS_RECORD_ATTR] === true;
  }

  onStart(span: SdkSpan): void {
    if (this.suppressed(span.attributes)) return;
    this.opts.emit(`${span.name}.start`, 'info', {
      ...span.attributes,
      span_id: span.spanContext().spanId,
      otel_trace_id: span.spanContext().traceId,
    });
  }

  onEnd(span: ReadableSpan): void {
    if (this.suppressed(span.attributes)) return;
    const errored = span.status.code === SpanStatusCode.ERROR;
    const fields: Record<string, unknown> = {
      ...span.attributes,
      span_id: span.spanContext().spanId,
      otel_trace_id: span.spanContext().traceId,
      duration_ms: Math.round(span.duration[0] * 1000 + span.duration[1] / 1e6),
    };
    if (errored && span.status.message !== undefined) fields['error'] = span.status.message;
    this.opts.emit(`${span.name}.${errored ? 'error' : 'finish'}`, errored ? 'error' : 'info', fields);
  }

  forceFlush(): Promise<void> {
    // The sink is writeSync-durable (BL-365); there is nothing buffered to flush.
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

// ── §3.3 / §5.8-A: pull-only reader, zero handles ───────────────────────────

/**
 * A `MetricReader` with no export loop at all. `collect()` is inherited and
 * runs synchronously on the caller's stack; the two abstract hooks exist only
 * because push exporters need them, and for a pull reader they are genuinely
 * no-ops rather than stubs hiding unimplemented work.
 */
class PullMetricReader extends MetricReader {
  protected onShutdown(): Promise<void> {
    return Promise.resolve();
  }

  protected onForceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

// ── Percentiles from an exponential histogram (§3.5) ────────────────────────

/**
 * OTel histograms expose count/sum/min/max but not percentiles, while the
 * existing `memory_ping` contract is `{p50, p99, mean, max}`. Recover them from
 * the bucket structure: bucket `i` at scale `s` covers
 * `(base^i, base^(i+1)]` where `base = 2^(2^-s)`.
 *
 * The value returned is the bucket's UPPER bound — measured error +2.4% (p50)
 * and +3.4% (p99) against a known uniform distribution (§3.5). It therefore
 * reads HIGH, never low, which is the safe direction for a latency alarm.
 * Interpolating to the midpoint would roughly halve the error and is
 * deliberately not done: a bound you can reason about beats a smaller number
 * you cannot.
 */
function exponentialQuantile(h: ExponentialHistogram, q: number): number | null {
  if (h.count === 0) return null;
  const target = q * h.count;
  let cumulative = h.zeroCount;
  if (cumulative >= target) return 0;
  const base = Math.pow(2, Math.pow(2, -h.scale));
  const { offset, bucketCounts } = h.positive;
  for (let i = 0; i < bucketCounts.length; i++) {
    cumulative += bucketCounts[i] ?? 0;
    if (cumulative >= target) return Math.pow(base, offset + i + 1);
  }
  return h.max ?? null;
}

function toPoints(md: MetricData): OtelMetricPoint[] {
  const name = md.descriptor.name;
  const unit = md.descriptor.unit;
  const out: OtelMetricPoint[] = [];
  for (const dp of md.dataPoints) {
    const attributes = dp.attributes as OtelAttributes;
    if (md.dataPointType === DataPointType.EXPONENTIAL_HISTOGRAM) {
      const v = dp.value as ExponentialHistogram;
      out.push({
        name,
        kind: 'histogram',
        unit,
        attributes,
        count: v.count,
        sum: v.sum ?? 0,
        min: v.min ?? null,
        max: v.max ?? null,
        p50: exponentialQuantile(v, 0.5),
        p99: exponentialQuantile(v, 0.99),
      });
    } else if (md.dataPointType === DataPointType.HISTOGRAM) {
      const v = dp.value as OtelHistogramData;
      out.push({
        name,
        kind: 'histogram',
        unit,
        attributes,
        count: v.count,
        sum: v.sum ?? 0,
        min: v.min ?? null,
        max: v.max ?? null,
        p50: null,
        p99: null,
      });
    } else {
      const v = dp.value as number;
      out.push({
        name,
        kind: md.dataPointType === DataPointType.SUM ? 'sum' : 'gauge',
        unit,
        attributes,
        count: v,
        sum: v,
        min: null,
        max: null,
        p50: null,
        p99: null,
      });
    }
  }
  return out;
}

// ── Bring-up ────────────────────────────────────────────────────────────────

const SCOPE_NAME = '@adhd/sox-telemetry';

export function bringUpOtel(opts: BringUpOtelOptions): OtelRuntime {
  // §3.4: THE single line whose omission does not error, does not warn, and
  // silently shatters every trace into unrelated roots. It is registered here,
  // unconditionally, before anything can create a span — there is no code path
  // that yields a provider without a context manager.
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);

  const resource = resourceFromAttributes({
    'service.name': opts.service,
    // BL-353: the field whose absence made the live population and the test
    // population indistinguishable on a shared disk. It is a resource
    // attribute, so it is on every span and every metric point by construction.
    'sox.role': opts.role,
  });

  const spanProcessor = new JsonlSpanProcessor(opts);
  const tracerProvider = new BasicTracerProvider({ resource, spanProcessors: [spanProcessor] });
  trace.setGlobalTracerProvider(tracerProvider);

  const reader = new PullMetricReader();
  const meterProvider = new MeterProvider({
    resource,
    readers: [reader],
    views: [
      {
        // §3.5: 81 populated buckets beat LatencyRing's 1,000 retained raw
        // samples on memory AND give exact count/sum/min/max. NOTE: this does
        // NOT replace `LatencyRing` in `write-queue.ts` — that ring is a
        // CONTROL input (admission control's rolling "mean of the last N"),
        // which a cumulative histogram cannot answer. Swapping it would
        // silently change admission behaviour.
        instrumentName: 'sox.stage.*_ms',
        aggregation: { type: AggregationType.EXPONENTIAL_HISTOGRAM, options: { maxSize: 160, recordMinMax: true } },
      },
    ],
  });

  const tracer: Tracer = tracerProvider.getTracer(SCOPE_NAME);
  const meter = meterProvider.getMeter(SCOPE_NAME);
  const histograms = new Map<string, ReturnType<typeof meter.createHistogram>>();
  const counters = new Map<string, ReturnType<typeof meter.createCounter>>();

  const wrapSpan = (span: Span): OtelSpanHandle => ({
    setAttributes: (attrs) => {
      span.setAttributes(attrs);
    },
    recordError: (err) => {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
    },
  });

  return {
    enabled: true,

    withSpan: async <R>(
      name: string,
      attrs: OtelAttributes,
      fn: (span: OtelSpanHandle) => Promise<R>,
      spanOpts?: { suppressRecord?: boolean },
    ): Promise<R> => {
      const attributes: OtelAttributes =
        spanOpts?.suppressRecord === true ? { ...attrs, [SUPPRESS_RECORD_ATTR]: true } : attrs;
      const span = tracer.startSpan(name, { attributes });
      const handle = wrapSpan(span);
      // `context.with` is what makes a nested span in ANOTHER package join this
      // trace across an `await` with no parameter threading (§3.4's `mode=ctx`).
      return context.with(trace.setSpan(context.active(), span), async () => {
        try {
          const result = await fn(handle);
          span.end();
          return result;
        } catch (err) {
          handle.recordError(err);
          span.end();
          throw err;
        }
      });
    },

    recordHistogram: (name, value, attrs) => {
      let h = histograms.get(name);
      if (!h) {
        h = meter.createHistogram(name, { unit: 'ms' });
        histograms.set(name, h);
      }
      h.record(value, attrs);
    },

    addCount: (name, value, attrs) => {
      let c = counters.get(name);
      if (!c) {
        c = meter.createCounter(name, { unit: '1' });
        counters.set(name, c);
      }
      c.add(value, attrs);
    },

    collect: async (): Promise<OtelMetricPoint[]> => {
      const result = await reader.collect();
      const out: OtelMetricPoint[] = [];
      for (const scope of result.resourceMetrics.scopeMetrics) {
        for (const md of scope.metrics) out.push(...toPoints(md));
      }
      return out;
    },

    shutdown: async (): Promise<void> => {
      await meterProvider.shutdown();
      await tracerProvider.shutdown();
      contextManager.disable();
      context.disable();
      trace.disable();
    },
  };
}
