# Observability substrate — research and recommendation (BL-351)

> **Status:** recommendation, not yet implemented. Research performed 2026-07-31 on branch
> `wip/turso-live-metrics`.
> **Governs:** BL-351 (the substrate), and unblocks BL-319, BL-322, BL-331, BL-334, BL-345, BL-348.
> **Owner directive, verbatim:** *"I do not want to rewrite distributed tracing / metric aggregation
> from scratch for obvious reasons so we should find tools that handle 99% of the lift but put our
> wrapper and semantics around them so we're eliminating the risk of incorrectly integrating those
> tools."*

**Recommendation in one line:** adopt the **OpenTelemetry API facade** (`@opentelemetry/api`, zero
dependencies) in every library, keep the **SDK** (`sdk-trace-base` + `sdk-metrics` +
`context-async-hooks`) confined to the composition root, and export through a **pull-only
`MetricReader` driven by `memory_ping`** — no collector, no daemon, no background timer. Wrap it in
`@adhd/sox-telemetry`, which is the only module allowed to import `@opentelemetry/*`.

---

## 1. Memory-first findings (DRY directive)

Executed in the mandated order.

**Step 1 — internal solutions already built.** `memory_recall` for *"tracing metrics observability
OpenTelemetry instrumentation spans"* and *"telemetry logging structured logger sox package"*
returned **nothing on topic**. Top hits scored 0.0056 and 0.0071 and were about the unrelated
`scratch/claude-metadata` Python CLI and BL-339 probe rows. Vector recall functioned (`provenance:
["temporal"]`, non-zero `vec` sub-scores); keyword/FTS returned a single row on one of two queries
and zero on the other — consistent with **BL-347** (FTS index present with an empty Tantivy
directory). **Which functioned: vector yes, FTS effectively no.** Neither surfaced prior art.

**Step 2 — prior tool research.** None found in the store. There is no prior evaluation of Node
tracing libraries logged in memory.

**Step 3 — live search.** Therefore required, and performed (§2). Per the directive, the
generalized finding is written back to memory (see §8).

**What did exist internally — found by reading the repo, not memory.** Three pieces of real prior
art that the recommendation deliberately builds on rather than replaces:

| Asset | Location | Verdict |
|---|---|---|
| JSONL structured log, rotating, ALS trace-id, `withTimedEvent` start-before-await | `libs/memory-core/src/telemetry.ts:1-478` | **Keep**, promote to shared package |
| `percentile` / `summarizeLatencies` / `LatencyRing` | `libs/memory-core/src/latency-stats.ts:17-114` | **Keep** for control-path; superseded for reporting |
| Adapter `Proxy` instrumentation (`instrumentAdapter`, `instrumentQueryMethods`) | `libs/memory-core/src/telemetry.ts:405-478` | **Keep**, generalize — this is the single best mis-integration defence already in the repo |
| Event catalog + read procedure for the JSONL stream | `docs/observability/README.md` (written 2026-07-31 under BL-353) | **Keep**, extend to the new instruments |

`telemetry.ts` is genuinely good work. Its problem is not quality, it is **scope** (memory-core
only), **reach** (env controls scrubbed, BL-344), and **coverage** (logs, no metrics — nothing
aggregates, so every number in `memory_ping` is hand-rolled separately).

**Two requirements imported from BL-353**, filed concurrently with this research by another agent
and grounded in the first analysis pass ever run over that JSONL stream. Both are folded into the
design below rather than left as follow-on work:

1. **Every record must carry its emitting role.** The log is a *single stream shared by the live
   server and every test process on the machine*, with no field distinguishing them — populations
   can only be separated by inferring which pids touched the live store path. Analysed together
   they are meaningless in both directions: the combined embed mean of 69,476 ms describes neither
   the 297 ms test median nor the 6,936 ms live median. A `role` attribute removes the inference.
   See §5.1.
2. **Start/finish accounting is a derived metric the substrate should own.** `withTimedEvent`'s
   log-START-before-await contract makes hangs *countable* as `starts − (finishes + errors)`, and
   that count is damning: `store.open` **4,559 unaccounted of 7,514 (61%)**, `write.phaseA`
   **2,770 of 3,910 (71%)**. Nobody computed it for two days because it required a human to know
   the file existed and write a script. See §5.3(d).

BL-353 also **partially answers BL-331**, which this document's earlier framing treated as fully
open: the 18x is *not* queue-wait and *not* the DB write (inter-embed median gap 9 ms;
`writequeue.task` p50 0 ms) — the time is inside embed compute, and the real shape is **~23x on the
median plus a catastrophic tail** (live p90 91,186 ms, max 3 hours; 21 of 80 embeds over 30 s). What
remains unanswered is *where inside embed compute*, which is a stage-attribution question and
squarely in scope here.

---

## 2. Candidate survey

All version, licence, dependency and date data below was read from the npm registry on
2026-07-31 via `npm view`, not from search snippets. All bundle sizes, timings and RSS figures were
measured locally on this machine (Node v24.11.1, darwin arm64) — see §3 for method.

### 2.1 `@opentelemetry/api` — the facade

- **1.9.1**, Apache-2.0, last published **2026-05-01**, `engines.node >= 8`.
- **Zero runtime dependencies.**
- Default behaviour with no SDK registered: every tracer/meter is a **no-op singleton**
  (`NoopMeter`, `NoopTracer`, `NOOP_HISTOGRAM_METRIC` etc. — visible in the bundled output at
  `bundle-api.cjs:459-505`).

### 2.2 OpenTelemetry SDK 2.x — the implementation

- `@opentelemetry/sdk-trace-base` **2.10.0**, Apache-2.0, published **2026-07-21**. Deps: `core`,
  `resources`, `sdk-trace`, `semantic-conventions` (4).
- `@opentelemetry/sdk-metrics` **2.10.0**, Apache-2.0, published **2026-07-21**. Deps: `core`,
  `resources` (2).
- `@opentelemetry/context-async-hooks` **2.10.0**, Apache-2.0. Deps: **none** (api is a peer).
- `engines.node ^18.19.0 || >=20.6.0` — Node 24 in range, verified running.
- Actively maintained: three of the four packages published within the last 10 days.

**Breaking-change note found during the prototype:** SDK **2.x removed the `View` and
`ExplicitBucketHistogramAggregation` classes**. `new ExplicitBucketHistogramAggregation(...)` throws
`TypeError: ... is not a constructor` on 2.10.0. Views are now plain objects and aggregation is
selected via the `AggregationType` enum (`{ type: AggregationType.EXPONENTIAL_HISTOGRAM, options:
{...} }`). Any tutorial or model recall predating SDK 2.0 will produce code that does not run — a
concrete instance of why the live-search directive exists.

### 2.3 `@opentelemetry/sdk-node` — the batteries-included bundle

- **0.221.0**, Apache-2.0. **~30 direct dependencies**, including `exporter-*-otlp-grpc`
  (`@grpc/grpc-js`), `exporter-zipkin`, and `@opentelemetry/instrumentation` (which pulls
  `import-in-the-middle` / `require-in-the-middle`).
- **Disqualified.** Rationale in §4.

### 2.4 `@opentelemetry/auto-instrumentations-node`

- **0.79.0**, Apache-2.0, published 2026-07-23. Auto-patches http/fs/dns/etc. at require time.
- **Disqualified.** Rationale in §4.

### 2.5 `dd-trace` (Datadog)

- **6.8.0**, `(Apache-2.0 OR BSD-3-Clause)`, published 2026-07-30 (very actively maintained).
- Deps: `dc-polyfill`, `opentracing`, **`import-in-the-middle` ^3.3.2**.
- **Disqualified.** Rationale in §4.

### 2.6 `pino` — structured logging

- **10.3.1**, MIT. 11 deps including `sonic-boom` and **`thread-stream` ^4.0.0** (worker-thread
  transports).
- Genuinely excellent logger. But we already have a working JSONL logger with the one feature pino
  does not give us for free — `withTimedEvent`'s **log-the-START-before-awaiting** contract, which
  is the only reason a *hang* leaves a trace (`telemetry.ts:358-384`). Adopting pino means
  reimplementing that on top of it and taking a worker-thread dependency into a process where
  BL-345 says background work starves the foreground.

### 2.7 `prom-client`

- **15.1.3**, Apache-2.0. Deps: `@opentelemetry/api` ^1.4.0, `tdigest`. `engines.node ^16 || ^18 ||
  >=20` — **does not declare Node 24**, though it would almost certainly run.
- Designed around a `/metrics` HTTP scrape endpoint. We have no Prometheus and the status surface is
  an MCP tool call, not HTTP.

### 2.8 `hdr-histogram-js`

- **3.0.1**, BSD-2-Clause. Deps include `@assemblyscript/loader` (WASM) and `pako`.
- Better percentile fidelity than anything else here, but it is a *component*, not a substrate — it
  gives histograms and nothing else, and the WASM loader is an extra bundling risk for accuracy we
  do not need (§3.4).

### 2.9 Node built-ins — `diagnostics_channel`, `perf_hooks`, `AsyncLocalStorage`

- Zero dependency, zero bundle cost, already in use (`telemetry.ts:47-48`).
- **`diagnostics_channel` is worth noting specifically:** it is already active in this process —
  Node's own module loader routes through `TracingChannel.traceSync` (visible in the stack trace of
  the failed prototype run at `node:diagnostics_channel:328:14`). It is the right mechanism for
  *decoupled* publish/subscribe, but it provides no span model, no trace-id propagation, no
  aggregation, and no percentile math. Using it as the substrate **is** hand-rolling distributed
  tracing, which the owner directive rules out.

---

## 3. Scored evaluation against the hard constraints

### 3.1 HARD — stdout must never be written (MCP JSON-RPC channel)

**Verified, not assumed.** Method: bundle each candidate set to CJS with esbuild 0.25.0, then (a)
grep the bundled output for `process.stdout`, (b) execute the bundle with stdout redirected to a
file and byte-count it.

| Bundle | `process.stdout` occurrences | stdout bytes at runtime |
|---|---|---|
| `@opentelemetry/api` only | **0** | **0** |
| `sdk-metrics` + `sdk-trace-base` | **0** | **0** |
| Full recommended set (api + sdk-trace-base + sdk-metrics + context-async-hooks) | **0** | **0** |

The bundles contain exactly **one** `console.log` reference each, and it is inside
`DiagConsoleLogger` (`bundle-api.cjs:434-455`) — an **opt-in** class that only runs if you
explicitly call `diag.setLogger(new DiagConsoleLogger())`. The default diag logger is a no-op.
`@opentelemetry/sdk-metrics` also exports a `ConsoleMetricExporter`, and `sdk-trace-base` a
`ConsoleSpanExporter` — same shape: opt-in, never wired by default.

**Conclusion: PASS, with a named hazard.** The entire stdout risk surface of OpenTelemetry reduces
to three exported symbols — `DiagConsoleLogger`, `ConsoleMetricExporter`, `ConsoleSpanExporter`.
That is small enough to eliminate structurally: §5.4 specifies an ESLint `no-restricted-imports` /
`no-restricted-syntax` rule banning all three repo-wide. A grep-able list of three banned identifiers
is a materially better safety story than "remember not to log to stdout."

`pino` fails this by default (writes to fd 1); it is configurable to fd 2, but the default is the
dangerous direction, which is the wrong shape for a mis-integration-resistant pick.

### 3.2 HARD — esbuild-bundleable CJS, no native addons

Measured on the recommended set:

- `.node` binary references in the unminified bundle: **0**
- Externals required: **none**
- Unminified CJS bundle: **573,358 bytes**. Minified: **209,001 bytes**. (`tools/bundle-extension.cjs`
  does **not** minify — grep for `minify` returns nothing — so **573 KB** is the figure that
  applies.)
- Current `memory-server/dist/index.js` is **2,418,414 bytes**, so the full SDK is **+23.7%**.
- The API facade alone bundles to **52,962 bytes** — **+2.2%**.

**Conclusion: PASS.** Pure JavaScript, no `--external` declarations needed, no BL-307/BL-309
externals story required. This is a significantly cleaner bundling story than `fastembed`/
`onnxruntime-node` already have.

### 3.3 HARD — low overhead (BL-345: background work starves foreground)

Benchmarked at 500,000 iterations after a 20,000-iteration warmup, `performance.now()` timing.

| Operation | ns/op |
|---|---|
| baseline: two `performance.now()` calls | 41 |
| **current repo**: `AsyncLocalStorage.getStore()` | **11** |
| **current repo**: `LatencyRing.push` equivalent | **6** |
| OTel API, **no SDK registered**: `startActiveSpan` + `end` | **96** |
| OTel API, no SDK registered: `histogram.record` | **5** |
| OTel **SDK**, sampler ON: `startActiveSpan` + `end` | **859** |
| OTel **SDK**, sampler OFF (`AlwaysOffSampler`): `startActiveSpan` + `end` | **508** |
| OTel SDK: `histogram.record`, no attributes | **42** |
| OTel SDK: `histogram.record`, 1 attribute | **42** |

Three findings that matter:

1. **A sampled-*off* span still costs 508 ns** — 59% of a sampled-on span. Turning the sampler down
   is *not* how you turn the cost off; it still allocates a `NonRecordingSpan` and manipulates
   context. The only genuinely free configuration is **no SDK registered at all** (96 ns), which is
   exactly what a library-depends-on-facade-only architecture gives you for free in tests, in the
   CLI, and in any consumer that has not opted in.
2. **Metric recording is essentially free and attribute-count-independent** (42 ns, identical with
   and without an attribute). Metrics can be always-on with no sampling at all.
3. **Against the actual workload these numbers are noise.** Live `memory_ping` right now reports
   `embed_throughput_per_sec: 0.0167` and `throughput_writes_per_sec: 0`; `embed_duration_ms.mean`
   is **7,910 ms**. A 859 ns span on a 7.9-second embed is **1.1 × 10⁻⁵ %**. Even on a 1 ms SQL
   query it is 0.086%.

**The overhead risk in this system is not the instrument — it is the exporter.** BL-345 established
that any in-process background job starves foreground reads, and a `PeriodicExportingMetricReader`
or a `BatchSpanProcessor` is precisely such a job: a timer that wakes up and does work on the same
event loop as `memory_recall`. **The recommendation therefore uses neither.**

Prototype of the recommended reader — a `MetricReader` subclass with no timer, collected on demand:

```
collect() latency ms: 0.635        # 3 instruments × 10,000 recorded samples
errors: []
active resources after setup: []   # process.getActiveResourcesInfo()
```

**Zero active handles. No timer. No background work of any kind.** Collection happens synchronously
inside the `memory_ping` call that asked for it, in 0.6 ms. **Conclusion: PASS**, and specifically
passes the BL-345 constraint that the obvious enterprise configuration would fail.

### 3.4 REQUIRED — spans with propagated trace-id across packages

Prototype: two tracers with different instrumentation-scope names (`memory-core`, `store-adapter`),
the second called from inside the first with **no parent handed across the call**, separated by an
`await`.

```
mode=noctx                                                   # no context manager registered
  store-adapter  store.exec   trace=64fc4a2a…  parent=ROOT
  memory-core    memory.write trace=0d00970c…  parent=ROOT
  => distinct trace ids: 2 BROKEN

mode=ctx                                                     # AsyncLocalStorageContextManager registered
  store-adapter  store.exec   trace=441002fc…  parent=12e8c7ed28a9b228
  memory-core    memory.write trace=441002fc…  parent=ROOT
  => distinct trace ids: 1 JOINED
```

This is **the BL-351 acceptance criterion demonstrated** — and, more importantly, it demonstrates
the mis-integration failure mode the wrapper exists to prevent. Forgetting one line
(`context.setGlobalContextManager(new AsyncLocalStorageContextManager())`) does not error, does not
warn, and does not stop spans being emitted. It silently shatters every trace into unrelated roots.
An operator would see spans, believe tracing works, and never be able to join them. That is
BL-319's failure shape wearing a different hat.

**This single line is the strongest argument for the wrapper.** §5.1 makes it unreachable to get
wrong.

### 3.5 REQUIRED — counters/gauges/histograms, and percentiles

OTel histograms give `count`, `sum`, `min`, `max` natively. They do **not** give p50/p99 directly —
the existing `memory_ping` contract does (`write_latency_ms: {p50, p99, mean, max}`).

Measured with an exponential histogram (`AggregationType.EXPONENTIAL_HISTOGRAM`, `maxSize: 160`)
over a known uniform 0–999 ms distribution:

| | approximated | true | error |
|---|---|---|---|
| p50 | 512.0 | 500 | +2.4% |
| p99 | 1024.0 | 990 | +3.4% |

Auto-selected scale 3, 81 populated buckets. The error is the bucket *upper bound*; interpolating to
the bucket midpoint roughly halves it. **This is more than adequate** — the open questions are
BL-331's *~23x median and 3-hour tail* and BL-345's starvation, not 3%.

Worth noting: the exponential histogram is also **cheaper in memory** than what we do today — 81
bounded buckets versus `LatencyRing`'s 1,000 retained raw `number` samples — while additionally
giving exact `count`/`sum`/`min`/`max`.

**One thing it cannot do, and this is load-bearing:** OTel histograms are **cumulative**. They
cannot answer *"mean of the most recent N samples."* `WriteQueue`'s admission-control estimator
(`recentMean(RECENT_AVG_WINDOW)`, `write-queue.ts:576-612`) depends on exactly that rolling window
to compute `estimated_wait_ms`. **`LatencyRing` must stay** — it is a *control* input, not a
*reporting* output. Replacing it with an OTel histogram would silently change admission-control
behaviour. This distinction is written into §5 as a rule.

### 3.6 REQUIRED — `wait` vs `work` as a first-class primitive

**Confirmed absent today.** `WriteQueue.enqueue` pushes `{label, kind, operation, resolve, reject,
traceId}` onto the queue (`write-queue.ts:615`) with **no enqueue timestamp**, and
`_recordLatencySample` (`write-queue.ts:657`) records only *execution* latency. The time an item
spends sitting in the queue — `write_queue_wait`, the entire subject of Theme 2 — is **never
measured**. `estimated_wait_ms` is a *prediction* computed from work latency, not an observation.

No off-the-shelf library provides this semantic; it is a domain concept. It is exactly the right
thing for the wrapper to own. §5.2 makes it structurally impossible to record one without the other.

### 3.7 REQUIRED — reaches the status surface, not a log file

The pull-only reader in §3.3 returns a plain object tree
(`resourceMetrics.scopeMetrics[].metrics[].dataPoints[]`) synchronously in 0.6 ms. It is assembled
directly into the `memory_ping` response next to the existing `write_queue` and `embed_pipeline`
blocks (`memory-server/src/index.ts:956-963`). **No log grepping, no exporter, no collector.**

### 3.8 Node 24 / TypeScript strict / pnpm / nx

All prototypes ran on **Node v24.11.1**. `engines` for the recommended packages are
`^18.19.0 || >=20.6.0`. All ship their own `.d.ts`. Apache-2.0 throughout.

### 3.9 Scorecard

| | otel api+sdk (recommended) | otel `sdk-node` | dd-trace | pino | prom-client | diagnostics_channel only |
|---|---|---|---|---|---|---|
| stdout-safe | **PASS** (verified 0 bytes) | PASS but huge surface | unverified, agent-coupled | **FAIL by default** (fd 1) | PASS | PASS |
| esbuild CJS, no natives | **PASS** (0 `.node`, 0 externals) | **FAIL** (grpc) | **FAIL** (`import-in-the-middle`) | risk (`thread-stream` workers) | PASS | PASS |
| no background job (BL-345) | **PASS** (0 active handles) | **FAIL** (periodic reader default) | **FAIL** (agent flush loop) | risk | FAIL (scrape server) | PASS |
| cross-package trace join | **PASS** (verified) | PASS | PASS | no | no | **FAIL** (no span model) |
| histograms + percentiles | **PASS** (±3%) | PASS | PASS | no | PASS | **FAIL** |
| wait/work primitive | ours (§5.2) | ours | ours | no | ours | ours |
| status-surface export | **PASS** (0.6 ms pull) | awkward | **FAIL** (vendor sink) | no | HTTP only | ours |
| local-dev appropriate | **PASS** | no | no | partial | no | PASS |
| bundle cost | **+573 KB** (+23.7%) | multi-MB | multi-MB | ~200 KB | ~150 KB | **0** |

---

## 4. What I would NOT adopt, and why

**`@opentelemetry/sdk-node`.** It is the answer to a different question. It bundles gRPC exporters,
Zipkin, and auto-instrumentation for a deployment we do not have. It would add megabytes to a 2.4 MB
extension bundle, force native externals we spent BL-307/BL-309 avoiding, and — decisively — its
default `PeriodicExportingMetricReader` is a recurring background timer, i.e. exactly the thing
BL-345 proved starves foreground reads. Adopting the convenience package here means adopting the
failure mode.

**`@opentelemetry/auto-instrumentations-node`.** Patches `http`, `fs`, `dns` and friends at require
time via `require-in-the-middle`. Three problems: (1) monkey-patching module resolution is
fundamentally at odds with a self-contained esbuild bundle that has no module resolution left to
patch; (2) auto-instrumenting `fs` in a process whose hot path is SQLite/Turso file I/O is an
unbounded-overhead bet on a system that is already resource-starved; (3) it produces spans nobody
named, which is the opposite of the per-package ownership the owner asked for.

**`dd-trace`.** Excellent library, wrong shape. It depends on `import-in-the-middle` (same bundling
objection), assumes a Datadog Agent sink, and would put the answers to our questions behind a SaaS
vendor for a single-machine local dev store. Its span data would not reach `memory_ping`.

**A collector/backend daemon (OTLP → Jaeger / Tempo / Grafana).** *Explicitly argued, not defaulted
away from.* The case **for** is real: Jaeger's UI would have made BL-331's stage attribution a
two-minute read instead of two days of nobody looking. But the case against is stronger for this
system, on three counts. **(1)
It answers the wrong question at the wrong time.** The operator BL-334 describes is hitting
`memory_ping` at 3am on a machine that must be self-contained; "start a collector and open a browser"
is not an answer, and a metric only visible in Grafana is a metric absent from the product — which is
precisely §0 of the sandbox PLAN. **(2) It reintroduces the background job.** Shipping to OTLP means
a batch processor on a timer — BL-345 again. **(3) It adds a second source of truth** that can
disagree with `memory_ping`, and BL-334 already documents what happens when go-live questions have
two answers: several were **wrong and had to be walked back**. — Note the design keeps the door
open: the recommendation retains OTLP-shaped data, so `SOX_TRACE_OTLP_ENDPOINT` can be added later
as **opt-in, off by default**, for a deliberate debugging session. That is the right time to pay for
a collector: when a human has decided to go looking, not continuously.

**Always-on head sampling for spans, unconditionally.** Rejected for the general case but **accepted
for this workload specifically**, on measured grounds: at the observed span rate (writes near zero
per second, embeds at 0.0167/s), 859 ns/span is unmeasurable, and per §3.3 turning the sampler off
saves only 41% of an already-negligible cost. What genuinely must be bounded is **span retention**
(memory), not span creation — so the recommendation retains a bounded ring of recent/slow/errored
spans rather than sampling at creation. Sampling would discard exactly the slow outlier you needed.

**Replacing `telemetry.ts`.** It solves the hang-visibility problem (log START before awaiting) that
no general library solves for us, and it is battle-tested against the real incident that produced it.
It gets promoted, not deleted.

**Replacing `LatencyRing` with an OTel histogram.** See §3.5 — it feeds admission control, which
needs a rolling window that a cumulative histogram cannot express.

---

## 5. Recommendation — `@adhd/sox-telemetry`

A new package at `libs/observability/sox-telemetry`. **It is the only module in the repo permitted to
import `@opentelemetry/*`** (enforced by lint, §5.4). Every other package imports the wrapper.

### 5.0 Dependency shape — the load-bearing structural decision

```
libs/*  (memory-core, store-adapter, embedding-provider, graph-store, host-runtime)
   └── @adhd/sox-telemetry
         ├── dependency:      @opentelemetry/api          (53 KB bundled, 0 deps, no-op default)
         └── optionalDependency: @opentelemetry/sdk-*     (loaded ONLY by initTelemetry())

extensions/…/memory-server/src/index.ts   ← the ONLY caller of initTelemetry()
apps/sox/src/main.ts                      ← ditto, for CLI-side spans
```

Consequences, each of which is a constraint satisfied for free:

- A library can never accidentally start an exporter — it does not have the code.
- Tests, the CLI, and any consumer that never calls `initTelemetry()` pay **96 ns/span** and
  **+2.2%** bundle. Instrumentation is unconditionally safe to add anywhere.
- The SDK's 573 KB / 18.5 ms load / 13.7 MB RSS is paid **once, by one process, at the composition
  root** — and only there.

### 5.1 Initialisation — one call, nothing optional

```ts
// memory-server/src/index.ts — the composition root, once, before anything else.
import { initTelemetry } from '@adhd/sox-telemetry';

const telemetry = initTelemetry({
  service: 'memory-server',
  role: 'live-service',     // REQUIRED, closed union: 'live-service' | 'test' | 'cli' | 'harness'
  // stdout is NEVER a legal sink; the type system does not offer it.
  logSink: 'file',          // 'file' | 'stderr' | 'none'
});
```

`role` is a **required** field, not an option, and it becomes a resource attribute on every span,
every metric data point, and every log record. This directly closes BL-353's third finding: the
live server and the test suite share one log stream today with nothing to tell them apart, so their
populations have to be separated by inferring which pids touched the live store — and analysed
together they describe neither. Making it required means the ambiguity cannot be reintroduced by
omission. `initTelemetry` defaults it to `'test'` **only** when `NODE_ENV==='test'` or a vitest
worker is detected; there is no path to an unlabelled record.

`initTelemetry` — and nothing else — performs the six steps that are individually easy to forget:
registers `AsyncLocalStorageContextManager` (§3.4's silent trace-shattering bug), constructs the
`BasicTracerProvider` with the bounded-ring span processor, constructs the `MeterProvider` with the
**pull-only** reader, installs the exponential-histogram view, sets the globals, and returns the
snapshot handle for the status surface. **There is no partially-initialised state to land in**, and
no way for a caller to construct a provider without a context manager.

### 5.2 The `wait` / `work` primitive — the anti-convention

The requirement is that wait and work be distinguishable *by construction*. The API therefore does
not expose "record a duration." It exposes **one function that cannot record work without having
recorded wait**:

```ts
/**
 * A contended resource. The ONLY way to enter it. Returns work's result.
 *
 * Wait is measured from the call, work from the moment admission is granted.
 * There is no API to record one without the other — `sox.stage.wait_ms` and
 * `sox.stage.work_ms` are emitted as a pair or not at all.
 */
export function withContendedStage<T>(
  stage: StageId,                       // closed union — see 5.3
  admit: () => Promise<void>,           // the blocking part: queue slot, lock, semaphore
  work: (span: Span) => Promise<T>,     // the compute part
): Promise<T>;
```

Usage at the two sites §3.6 identified as unmeasured:

```ts
// write-queue.ts — replaces the bare queue.push at :615
return withContendedStage('write_queue',
  () => this.admissionGranted(),        // resolves when this item reaches the head
  (span) => operation(this.adapter),
);
```

Emitted, always paired, always with the same attribute set:

| Instrument | Type | Attributes |
|---|---|---|
| `sox.stage.wait_ms` | exponential histogram | `sox.package`, `sox.stage`, `sox.phase="wait"` |
| `sox.stage.work_ms` | exponential histogram | `sox.package`, `sox.stage`, `sox.phase="work"` |
| `sox.stage.count` | counter | `sox.package`, `sox.stage`, `sox.outcome` |

A consumer cannot record work-only, because there is no function that does that. That is what
"first-class primitive, not a per-consumer convention" has to mean to be worth anything.

### 5.3 Defeating the BL-319 class of mistake structurally

BL-319: `time_to_vector_ms` exists and has **0 samples** because the heal path bypasses write-path
instrumentation. *An instrument wired to one of two code paths is indistinguishable from no
instrument.* Three mechanisms, in increasing order of strength:

**(a) Stages are a closed union, declared once per package.** A package declares its stage
inventory; `StageId` is derived from it. `withContendedStage('embed_heal', …)` on an undeclared
stage is a **compile error** under TS strict. You cannot invent a stage name at a call site, and
therefore cannot silently create a second, differently-named metric for the sibling path.

```ts
export const MEMORY_CORE_STAGES = declareStages('memory-core', {
  embed:        { paths: ['write', 'heal'] },   // ← BL-319: BOTH paths named, up front
  vector_write: { paths: ['write', 'heal'] },
  write_queue:  { paths: ['write'] },
  cluster:      { paths: ['background'] },
} as const);
```

**(b) Declared paths make the omission visible, and testable.** Each stage names its code paths.
The emitted metrics carry `sox.path`. `telemetrySelfCheck()` — exposed through `memory_stats` and
assertable in CI — reports, per stage, **which declared paths have produced zero samples**:

```jsonc
"telemetry_self_check": {
  "stages_declared": 12,
  "stages_with_zero_samples": ["cluster"],
  "paths_with_zero_samples": ["embed:heal", "vector_write:heal"]   // ← BL-319, visible
}
```

Today, BL-319's defect is invisible: a `0` in a metric is indistinguishable from an idle system.
Under this design, a declared-but-never-sampled *path* is a named, machine-readable finding. **The
BL-351 acceptance test is a red→green assertion that `paths_with_zero_samples` is empty after a run
that exercises both the write and heal paths.**

**(c) Instrument at the boundary, not at the call site — generalise the Proxy.** The single most
effective mechanism already in this repo is `instrumentAdapter` (`telemetry.ts:445-478`): it wraps
the *object*, so every method — including ones written later by someone who never heard of
telemetry — is instrumented. `@adhd/sox-telemetry` promotes this to a first-class export
(`instrumentBoundary(obj, {package, stageOf})`), and the integration plan applies it to the store
adapter, the embedding provider, and the graph store. A method added tomorrow is instrumented by
construction. This is the mechanism that most directly answers what remains of BL-331: BL-353's
analysis narrowed the slowdown to *inside embed compute*, and only boundary instrumentation on the
embedding provider can narrow it further to a stage — attributable by reading one `memory_ping`
response instead of writing a script against a 17 MB/day log.

**(d) Start/finish accounting as a built-in derived metric.** BL-353 showed that
`starts − (finishes + errors)` is the cheapest hang detector we have and that it went uncomputed
for two days because it required a human to know a file existed. `withContendedStage` and
`withTimedEvent` therefore increment `sox.stage.count` with `sox.outcome ∈ {started, finished,
error}` **by construction**, and `telemetrySelfCheck()` reports the unaccounted delta per stage:

```jsonc
"unaccounted": { "store.open": {"started": 7514, "finished": 1406, "error": 1549, "open": 4559} }
```

BL-353's own caveat carries forward and must be stated in the surface, not just here: a process
killed mid-operation is indistinguishable from a hang by this method, so the number is an **upper
bound and a lead, not a verdict**. The `role` attribute from §5.1 is what makes it usable — test
runners exiting mid-op are exactly the population that inflates it, and with `role` they can be
excluded rather than guessed at.

### 5.4 Lint enforcement (the mis-integration guard rails)

Four rules, all mechanical:

1. `no-restricted-imports`: `@opentelemetry/*` is importable **only** from within
   `libs/observability/sox-telemetry/src/**`.
2. `no-restricted-syntax`: `DiagConsoleLogger`, `ConsoleMetricExporter`, `ConsoleSpanExporter`
   banned repo-wide (§3.1 — the complete stdout hazard surface, three identifiers).
3. `no-restricted-syntax`: `console.log` / `process.stdout.write` banned in any package reachable
   from an MCP stdio entrypoint. This rule should exist regardless of BL-351.
4. `PeriodicExportingMetricReader` and `BatchSpanProcessor` banned (BL-345 — no background timers).

### 5.5 What `memory_ping` gains

```jsonc
"telemetry": {
  "trace_id": "01KYX…",                       // this call's own trace, for correlation
  "role": "live-service",                     // BL-353: never infer the population again
  "stages": {
    "embed":        { "wait_ms": {"p50":  0.4, "p99":   12, "count": 3},
                      "work_ms": {"p50": 7304, "p99": 9564, "count": 3},
                      "paths":   {"write": 3, "heal": 0} },      // ← BL-319 made visible
    "write_queue":  { "wait_ms": {"p50": 0.1, "p99": 340, "count": 812},   // ← never measured before
                      "work_ms": {"p50": 2.1, "p99":  18, "count": 812} },
    "vector_write": { … },
    "cluster":      { … }
  },
  "self_check": {
    "paths_with_zero_samples": ["embed:heal"],                     // BL-319
    "unaccounted": { "store.open": 4559, "write.phaseA": 2770 }    // BL-353, upper bound
  }
}
```

`write_queue.wait_ms` is the number Theme 2's resource governance is blocked on. It has never been
observed.

---

## 6. Integration plan

**Prerequisite (blocking) — BL-344 must land first.** The four `SOX_MEMORY_LOG_*` controls are
scrubbed by allowlists duplicated in at least four places I read directly:
`libs/host-runtime/src/supervisor.ts:308-325`, `apps/sox/src/main.ts:4632-4642` (`buildOsUnitEnv`),
`apps/sox/src/main.ts:8728-8738`, and `libs/host-runtime/src/runtime-cli.ts:542`. The comment at
`main.ts:8731-8735` names the problem in the source itself: *"this is the THIRD copy of this
allowlist in this file … Adding a tunable requires remembering every one of them."*

There is a real shortcut worth noting: every copy already forwards by **prefix** for `SOX_EMBED_*`
(`k.startsWith('SOX_EMBED_')`). Naming our variables `SOX_TRACE_*` and adding one prefix clause
would work — **but it would be the fifth instance of the bug, not a fix.** The correct fix is
BL-344's single shared allowlist with a deny-list, and BL-351 should not ship a control surface that
depends on remembering four files. Verification must be on a **real spawned service**, per the
BL-351 acceptance text — the in-process path does not exercise the scrub.

**Sequencing.** Package first, then instrument in dependency order, so trace-joining is provable at
every step rather than at the end.

| # | Step | Proves |
|---|---|---|
| 0 | BL-344: single allowlist + deny-list | controls survive to a spawned service |
| 1 | Create `libs/observability/sox-telemetry`; **move** `telemetry.ts` + `latency-stats.ts` in; re-export from `memory-core` for compatibility | no behaviour change; existing specs stay green |
| 2 | Add `@opentelemetry/api` dep + `initTelemetry` (required `role`) + pull reader + `withContendedStage` + `declareStages` | unit tests: wait/work pair emitted; no active handles after init; no unlabelled-`role` record reachable |
| 3 | Wire `initTelemetry` at the memory-server composition root; add `telemetry` block (incl. `self_check`) to `memory_ping` | **BL-351 acceptance #3**: every metric reachable from a tool call. **BL-353 acceptance**: start/finish accounting reachable without reading a file |
| 4 | `store-adapter`: replace bespoke instrumentation with `instrumentBoundary` | **BL-351 acceptance #1**: memory-core + store-adapter spans join on one trace-id |
| 5 | `memory-core` `write-queue.ts`: `withContendedStage('write_queue', …)` at `:615` | **BL-351 acceptance #2**: `write_queue_wait` reported for a real write |
| 6 | `memory-core` `embed-pipeline.ts`: `embed` + `vector_write` on **both** `write` and `heal` paths | **BL-319 closed**: `paths_with_zero_samples` empty |
| 7 | `embedding-provider`: `instrumentBoundary` + `embed_enqueue_wait` | BL-331's 18x becomes stage-attributable |
| 8 | `graph-store`, `host-runtime` (supervisor spawn/verify stages) | six packages, one substrate |
| 9 | Lint rules (§5.4) + `telemetrySelfCheck` CI gate | the guard rails become permanent |

**What changes in `telemetry.ts`.** It moves, and gains three things; it loses nothing.
`newTraceId`/`withTrace`/`currentTraceId` keep their signatures but are re-implemented over OTel
context so the ULID trace-id and the OTel span context are **the same identity** rather than two
parallel correlation schemes — a `log.info` inside a span and the span itself must carry the same
id, or we have built the two-sources-of-truth problem §4 rejects. `withTimedEvent` keeps its
log-START-before-await contract and additionally opens a span. `instrumentAdapter` generalises to
`instrumentBoundary`. Env vars move to the `SOX_TRACE_*` namespace behind the BL-344 fix.

**Risk register.**

- *The ULID↔OTel trace-id unification is the one genuinely fiddly step* (step 1→2). Mitigation: it
  is internal to the wrapper, and step 4 proves it end to end.
- *573 KB on the memory-server bundle.* Accepted, measured, and confined to one process. If it ever
  matters, enabling esbuild `--minify` in `tools/bundle-extension.cjs` recovers 364 KB of it — and
  would shrink the existing 2.4 MB bundle far more.
- *Cumulative histograms never reset* within a process lifetime. Acceptable for a long-lived server;
  the status surface should label the window as "since process start" rather than implying recency,
  or BL-334's wrong-answer pattern repeats in a new place.

---

## 7. Filed backlog items

Discovered during this research (per the disclosure directive; deduped by symbol/path against
existing entries):

- **BL-354** — `WriteQueue` never measures queue wait time. `enqueue` pushes without a timestamp
  (`write-queue.ts:615`); `_recordLatencySample` (`:657`) records execution only. `estimated_wait_ms`
  is a *prediction* from work latency, not an observation. Sub-item of BL-351/BL-322; filed
  separately because it is the single concrete missing measurement Theme 2 depends on.
- **BL-355** — `tools/bundle-extension.cjs` does not minify. `memory-server/dist/index.js` is
  2,418,414 bytes unminified. Not a defect, but it makes every future dependency's footprint 2.7x
  its minified cost. LOW.

Checked for duplicates by symbol (`_recordLatencySample`, `estimated_wait_ms`), path
(`write-queue.ts`, `bundle-extension.cjs`) and string (`write_queue_wait`, `minify`) across
`BACKLOG.md` before filing. The only prior mention of the wait split is BL-351's own requirement
text, which states the need without locating the defect.

---

## 8. Citations

Citations: [wip/turso-live-metrics, architect-reviewer, claude, BL-351 / docs/reporting/memory/sandbox/PLAN.md §P1.0,
1: BACKLOG.md:1376-1399 (BL-351),
2: docs/reporting/memory/sandbox/PLAN.md §0 + §P1.0,
3: libs/memory-core/src/telemetry.ts:1-478,
4: libs/memory-core/src/telemetry.ts:288-318 (AsyncLocalStorage trace-id),
5: libs/memory-core/src/telemetry.ts:358-384 (withTimedEvent, log-START-before-await),
6: libs/memory-core/src/telemetry.ts:405-478 (instrumentQueryMethods / instrumentAdapter),
7: libs/memory-core/src/latency-stats.ts:17-114,
8: libs/memory-core/src/write-queue.ts:576-612 (admission control, recentMean),
9: libs/memory-core/src/write-queue.ts:615 (queue.push — no enqueue timestamp),
10: libs/memory-core/src/write-queue.ts:657-664 (_recordLatencySample — work only),
11: libs/host-runtime/src/supervisor.ts:308-325 (env allowlist copy 1),
12: apps/sox/src/main.ts:4632-4642 (buildOsUnitEnv — allowlist copy 2),
13: apps/sox/src/main.ts:8728-8738 (allowlist copy 3, with the in-source admission of the defect),
14: libs/host-runtime/src/runtime-cli.ts:542 (allowlist copy 4),
15: tools/bundle-extension.cjs:11-22, 66-73, 174-228 (externals + sidecar policy; no minify),
16: extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts:956-963 (status surface assembly),
16a: BACKLOG.md:1457-1500 (BL-353 — role field, start/finish accounting, BL-331 partial answer),
16b: docs/observability/README.md (event catalog, written under BL-353),
17: live memory_ping 2026-07-31 (embed_duration_ms.mean 7910 ms, embed_throughput_per_sec 0.0167, throughput_writes_per_sec 0),
18: npm registry 2026-07-31 — @opentelemetry/api 1.9.1 / sdk-trace-base 2.10.0 / sdk-metrics 2.10.0 / context-async-hooks 2.10.0 / sdk-node 0.221.0 / dd-trace 6.8.0 / pino 10.3.1 / prom-client 15.1.3 / hdr-histogram-js 3.0.1,
19: local prototype /Users/nix/.claude/jobs/1557bcef/tmp/otel-probe — bundle sizes, stdout byte counts, ns/op benchmarks, collect() latency, getActiveResourcesInfo, cross-package trace join, exponential-histogram percentile error,
20: https://opentelemetry.io/blog/2025/otel-js-sdk-2-0/ (SDK 2.0 announcement, Node engine floor),
21: https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/upgrade-to-2.x.md (2.x breaking changes),
22: https://modelcontextprotocol.io/docs/2026-07-28/tools/debugging (stdout is the protocol channel; logging must use stderr),
23: https://github.com/anthropics/claude-code/issues/48866 (stdio stdout/stderr protocol guidance)]
