/**
 * otel-types.ts — the SDK-free seam between the always-loaded telemetry core
 * and the OpenTelemetry SDK (BL-401 gap 4).
 *
 * ⚠️ THIS FILE MUST NEVER IMPORT `@opentelemetry/*`. It is imported by
 * `runtime.ts` and `stages.ts`, which every library in the repo pulls in
 * transitively. Loading the SDK here would pay its cost in every process.
 *
 * Measured on this machine (Node v24.11.1 darwin/arm64, SDK 2.10.0):
 *
 *     require(sdk-trace-base + sdk-metrics + context-async-hooks + resources)
 *       load_ms 91.5   rss_delta_mb 23.6
 *
 * That is 5x the load time and 1.7x the RSS quoted in
 * `docs/research/observability-substrate.md` §3.2/§5.0 (18.5 ms / 13.7 MB,
 * measured against an earlier SDK) — so the §5.0 rule that libraries must not
 * load the SDK is *more* load-bearing now, not less. `runtime.ts` therefore
 * reaches the real implementation (`otel.ts`) through a dynamic `import()`
 * issued only inside `initTelemetry()`, and everything else in the package
 * talks to this interface.
 *
 * `NOOP_OTEL` is the null object every uninitialised process runs against, so
 * `stages.ts` has exactly ONE code path rather than an `if (otel)` fork whose
 * two branches inevitably drift (the BL-319 shape: an instrument wired to one
 * of two paths is indistinguishable from no instrument).
 */

export type OtelAttributes = Record<string, string | number | boolean>;

/** The subset of an OTel `Span` the substrate needs. Kept minimal so the
 *  no-op implementation is trivially correct. */
export interface OtelSpanHandle {
  setAttributes(attrs: OtelAttributes): void;
  recordError(err: unknown): void;
}

/** One collected metric stream, flattened for the status surface / snapshot.
 *  `p50`/`p99` are approximated from exponential-histogram bucket bounds
 *  (§3.5: measured +2.4% / +3.4% error against a known distribution) — they
 *  are bucket UPPER bounds, never interpolated, so they read high, never low. */
export interface OtelMetricPoint {
  name: string;
  kind: 'histogram' | 'sum' | 'gauge';
  unit: string;
  attributes: OtelAttributes;
  count: number;
  sum: number;
  min: number | null;
  max: number | null;
  p50: number | null;
  p99: number | null;
}

export type OtelState = 'disabled' | 'pending' | 'ready' | 'failed';

export interface OtelRuntime {
  readonly enabled: boolean;
  /**
   * Run `fn` inside a real OTel span that is ALSO the active context, so any
   * nested span in any package joins the same trace with no parameter passing
   * (§3.4 — forgetting `AsyncLocalStorageContextManager` silently shatters
   * every trace into unrelated roots, which is why registering it is not
   * reachable by a caller).
   *
   * `suppressRecord: true` tells `JsonlSpanProcessor` NOT to write this span's
   * `.start`/`.finish` lines, because the caller already writes richer ones of
   * its own (`stages.ts`). Without it every stage would appear twice on disk
   * under two different shapes, and `docs/observability/README.md` §5.2's
   * `starts − (finishes + errors)` accounting would double-count.
   */
  withSpan<R>(
    name: string,
    attrs: OtelAttributes,
    fn: (span: OtelSpanHandle) => Promise<R>,
    opts?: { suppressRecord?: boolean },
  ): Promise<R>;
  recordHistogram(name: string, value: number, attrs: OtelAttributes): void;
  addCount(name: string, value: number, attrs: OtelAttributes): void;
  /** Pull-only collection — no timer, no background work (§3.3/BL-345). */
  collect(): Promise<OtelMetricPoint[]>;
  shutdown(): Promise<void>;
}

const NOOP_SPAN: OtelSpanHandle = {
  setAttributes: () => {},
  recordError: () => {},
};

export const NOOP_OTEL: OtelRuntime = {
  enabled: false,
  withSpan: <R>(_n: string, _a: OtelAttributes, fn: (span: OtelSpanHandle) => Promise<R>): Promise<R> => fn(NOOP_SPAN),
  recordHistogram: () => {},
  addCount: () => {},
  collect: () => Promise.resolve([]),
  shutdown: () => Promise.resolve(),
};
