# @adhd/sox-telemetry

## 0.2.0

### Minor Changes

- 1291af4: First npm release of the shared tracing/metrics substrate (BL-351/BL-401), as **0.2.0**.

  `@adhd/sox-telemetry` has never existed on npm — `npm view @adhd/sox-telemetry` is a hard E404 — yet
  it is a `dependencies` (not dev) entry of both `@adhd/sox-store-adapter` and `@adhd/sox-memory-core`.
  Changesets rewrites `workspace:*` to a concrete version at publish, so until this ships, every
  publish of those two packages produces a tarball that 404s on install, transitively taking
  `@adhd/sox-graph-store` with it. Nothing in the library set can publish before this does.

  **Why 0.2.0 and not 0.1.0/0.1.1.** The `0.1.0` in the manifest describes a surface that no longer
  exists. Since it was written, `otelReady(): Promise<void>` became a **required** member of
  `TelemetryHandle`, and `otel` + `metric_persistence` became **required** fields of
  `TelemetrySelfCheck`. That is additive for _callers_ — `withSpan`, `otelReady`, `snapshotMetrics`,
  `DurableJsonlSink.plannedPath()`, the `OtelAttributes`/`OtelMetricPoint`/`OtelRuntime`/
  `OtelSpanHandle`/`OtelState` types and two optional `InitTelemetryOptions` fields are all new — but
  **breaking for implementors** of those two interfaces. Nobody outside the package implements them
  today, which is what makes this cheap to do now and expensive to do later. Publishing that surface
  as `0.1.0` would freeze one version number against two different shapes; under 0.x convention a
  breaking change takes the minor, so it takes 0.2.0 and `0.1.0` stays permanently unclaimed.

  **Why not 1.0.0.** Three surfaces on this seam are known-wrong and scheduled to change. `0.x` is the
  honest signal — "adopt it, wire against it, expect one more breaking pass" — and 1.0.0 should wait
  until the contract has soaked against a second real consumer.

  Runtime dependencies are all external registry packages and were verified to resolve, so this
  release cannot reproduce the E404 shape it exists to fix: `@opentelemetry/api@^1.9.0` (1.9.1),
  `@opentelemetry/sdk-trace-base`, `@opentelemetry/sdk-metrics`, `@opentelemetry/context-async-hooks`
  and `@opentelemetry/resources` all at `^2.10.0` (2.10.0), and `ulid@^2.3.0` (8 published 2.x
  versions). Zero `workspace:*` deps of its own — it has no predecessor and can go first.

  Consumers get the OpenTelemetry SDK only through a dynamic `import()` inside `initTelemetry()`
  (measured 91.5ms / 23.6MB RSS on SDK 2.10), so a library that merely imports this package does not
  pay for it. A process that never calls `initTelemetry()` emits a startup warning and drops records —
  that is by design (BL-404), not a defect.
