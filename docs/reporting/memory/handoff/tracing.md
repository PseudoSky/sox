# Handoff — tracing, telemetry, env propagation

> **Entry point for this program is [`../README.md`](../README.md); state is [`../STATE.md`](../STATE.md).** Read those first.
> This file is the agent-to-agent handoff for the observability/tracing thread, written 2026-07-31.
>
> **Read this before touching `libs/memory-core/src/telemetry.ts`, `libs/host-runtime/src/env-policy.ts`, or starting BL-351.**
> It exists to stop you re-measuring things that took a while to measure. Every number
> below was produced on this machine (Node v24.11.1, darwin arm64) — none is quoted from
> documentation, and in two cases the documentation is **wrong** and is called out as such.

---

## 0. Status at handoff — read this first

| Item | State | Where |
|---|---|---|
| **BL-344** duplicated env allowlists | **SHIPPED** | `ee9a0dc` · CHANGELOG |
| **BL-365** telemetry lost on hard crash | **SHIPPED** | `b43e7ba` · CHANGELOG |
| **BL-334** integrity → status surface | **SHIPPED** | `0d2d629` (co-authored with `p0-adapter-integrity`) |
| **BL-368** integrity result unreachable via proxy | **SHIPPED** | folded into the above |
| **BL-351** tracing substrate | **researched, NOT implemented** | [`../../../research/observability-substrate.md`](../../../research/observability-substrate.md) |
| **BL-375** `service enable` drops env | **approved, NOT started** | design in §6 below |
| **BL-369** suspension ledger | `p0-cluster-calibration` building it | §7 — **field names DECIDED**, see §7 |

> ⚠️ **Correction to a possibly-stale instruction.** You may have been told BL-365 is
> "approved and not started." **It is shipped** — `b43e7ba`, removed from BACKLOG, written to
> CHANGELOG, with a red→green on a real SIGKILL. Do not re-implement it. §5 documents what
> landed and what is genuinely left.

**Nothing in §0 has been deployed.** `sox` and `memory-server` are not rebuilt; the running
backend still serves the old bundle. Deploys were held deliberately during the embed backfill —
see §8.

---

## 1. BL-344 — five env allowlists became one (SHIPPED, `ee9a0dc`)

### What was wrong

Under `policy.enforced`, the child env was scrubbed to a hand-maintained allowlist that existed
as **five** independent copies across two packages. (BL-344's prose said *six*; its own numbered
list ran 1–5, and the grep fingerprint finds five. The count was corrected in the record.)

Every new tunable had to join all five. Nobody ever did, and they had **measurably drifted** —
this table is the single most valuable artifact of the investigation:

| copy | `SOX_DISABLE_EMBED_HEAL` | `SOX_DISABLE_PERIODIC_ENRICH` |
|---|---|---|
| `main.ts` `buildOsUnitEnv` | yes | yes |
| `main.ts` serve | yes | yes |
| `main.ts` `cmdExec` | yes | yes |
| `supervisor.ts` | yes | **NO** |
| `runtime-cli.ts` | **NO** | **NO** — while its comment claimed parity with supervisor |

So **which emergency brake took effect depended on which spawn path a process came through.**

### Read it together with BL-378 — they only make sense as a pair

BL-378 establishes that the two brakes were **never independent**: `healMissingVectors` has
exactly one production call site, inside the enrich tick, so `SOX_DISABLE_PERIODIC_ENRICH`
**subsumes** `SOX_DISABLE_EMBED_HEAL` and clearing the latter alone does nothing.

Combined with the drift table: an operator setting the brakes had **no reliable way to know which
background work was actually stopped, in which process.** Neither flag's documented behaviour was
accurate, and the copies disagreed about which even propagated. BL-344 fixed the propagation
half; **BL-378 is the semantics half and is still open.**

### What shipped

One module: `libs/host-runtime/src/env-policy.ts`. `grep -rn allowedKeys` returns nothing outside it.

```
SOX_*   forwarded, except the host-authoritative prefixes below
NODE_*  forwarded (scrubbing NODE_OPTIONS/NODE_PATH breaks native addon loading)
base    PATH HOME USER LOGNAME LANG LC_ALL LC_CTYPE TZ XDG_CACHE_HOME
deny    SOX_PERM_*, SOX_CONFIG_*
```

### The deny-list is load-bearing — do not simplify it away

This is the part most likely to be "cleaned up" by someone who doesn't know why it's there.

`SOX_PERM_*` is the compiled permission policy (`policy.toEnv()`: `SOX_PERM_ENFORCE` plus the
fs/net allowlist JSON). **A child inheriting it from the ambient environment would let anyone able
to set an env var before the spawn widen — or switch off — the sandbox.** That is privilege
escalation and it is the single genuinely unsafe case.

Before BL-344 that was blocked **only incidentally** — those names simply were not on the
allowlist and matched no forwarded prefix. **Broadening to a `SOX_*` prefix rule destroys that
incidental protection**, which is precisely why the deny-list has to exist and be explicit.
`SOX_CONFIG_*` is the same shape for resolved config.

Net posture: unchanged for `SOX_PERM_*`/`SOX_CONFIG_*`, unchanged for non-`SOX_` variables. Only
operator-facing tunables became forwardable.

Regression test lives on a **real spawned child** — `env-policy-spawn.spec.ts` asserts an
inherited `SOX_PERM_ENFORCE=0` does not survive into the child. A broadening change should end
with **more** security assertions than it started with.

### Why a real spawned process, and not an in-process assertion

The original defect produced a **false green** for hours: the variable *was* present in the
generated launchd `.plist` and *absent* from `ps eww <backend-pid>`. **Verifying the config file
is not verifying the running process.** `env-policy-spawn.spec.ts` therefore spawns an actual
`node` child that writes its own `process.env` to a file, which the test reads back. Keep that
shape for any future env-propagation assertion.

---

## 2. BL-351 — the recommendation, and the measurements behind it

Full document: [`../../../research/observability-substrate.md`](../../../research/observability-substrate.md).
**Researched and accepted; not implemented.** Do not re-derive the survey — re-read that doc.

**Recommendation:** `@opentelemetry/api` (1.9.1, Apache-2.0, **zero runtime deps**) as the facade
every library imports; the SDK (`sdk-trace-base` + `sdk-metrics` + `context-async-hooks`, 2.10.0)
confined to the composition root; the **existing BL-320 JSONL sink** behind a standard
`SpanExporter`/`SpanProcessor`; plus a **pull-only `MetricReader`** driven by `memory_ping`.
No collector, no daemon, no background timer.

### The measurements — these are the expensive ones

| Measurement | Result | Why it matters |
|---|---|---|
| OTel **file exporter** | **does not exist** — `npm view otlp-file-exporter` 404s; every published exporter is OTLP over http/grpc/proto, Zipkin, Prometheus, or Console | The durable sink **must be ours**. Not a preference — the standard offers none. |
| `ConsoleSpanExporter` stdout | **778 bytes written to stdout** | MCP-fatal (stdout is the JSON-RPC channel). **The only local sink OTel ships is the one we can never use.** |
| Hung operation | **2 spans started, 1 exported** | Spans emit on `end()`. A hang **never reaches disk** under plain OTel. |
| Pull-only `MetricReader` | `getActiveResourcesInfo()` → `[]`; `collect()` **0.635 ms** for 3 instruments × 10k samples | Zero timers, zero handles — satisfies BL-345. The *default* `PeriodicExportingMetricReader` would fail this. |
| Span, **no SDK registered** | **96 ns** | Libraries depending on the facade only are effectively free. |
| Span, SDK sampled-ON | **859 ns** | Against a 7,910 ms embed mean that is 1.1 × 10⁻⁵ %. |
| `histogram.record` | **42 ns**, attribute-count-independent | Metrics can be always-on, unsampled. |
| Bundle | api-only **52,962 B**; full set **573,358 B** unminified (+23.7% on the 2.4 MB memory-server bundle); **0** native `.node` refs, **0** externals | Pure JS. No BL-307/309 externals story needed. |
| Cross-package trace join | 2 tracers, separated by an `await`, no parent passed → **one trace-id** | The BL-351 acceptance, demonstrated. |

### Preserving the hang guarantee — the `onStart` seam

`SpanExporter` only sees *finished* spans, so it cannot see a hang. But **`SpanProcessor.onStart`
fires before the span body runs, and fires for hung spans** (confirmed: `onStart` 2, exported 1).
So the `.start` record is written from `onStart` and `.finish` from `onEnd` — the guarantee lives
inside the standard's own extension point rather than bolted alongside it.

This preserves `starts − (finishes + errors)`, BL-353's highest-value query and the thing that
surfaced `store.open` at 61% unaccounted.

### Why `@opentelemetry/sdk-node` is rejected

~30 direct dependencies including gRPC exporters, Zipkin, and `@opentelemetry/instrumentation`
(which pulls `require-in-the-middle`). Three independent disqualifiers:

1. Multi-MB into a 2.4 MB extension bundle, plus native externals we spent BL-307/309 avoiding.
2. `require-in-the-middle` monkey-patches module resolution — fundamentally at odds with a
   self-contained esbuild bundle that has no module resolution left to patch.
3. **Decisively:** its default `PeriodicExportingMetricReader` is a recurring background timer —
   exactly what BL-345 proved starves foreground reads. **Adopting the convenience package means
   adopting the failure mode.**

Also rejected, with reasons in the doc: `auto-instrumentations-node`, `dd-trace`, `pino`
(writes fd 1 **by default** — wrong direction for a stdio server), `prom-client` (scrape-only,
so a crash takes its counters with it), and a collector/backend daemon.

---

## 3. Three gotchas that will cost you hours if rediscovered

1. **A sampled-OFF span still costs 508 ns** — 59% of a sampled-on span. `AlwaysOffSampler` still
   allocates a `NonRecordingSpan` and manipulates context. **Turning the sampler down is not how
   you turn the cost off.** The only genuinely free configuration is *no SDK registered* (96 ns),
   which the facade-only library architecture gives you for free in tests and the CLI.

2. **OTel SDK 2.x REMOVED `View` and `ExplicitBucketHistogramAggregation`.**
   `new ExplicitBucketHistogramAggregation(...)` throws `TypeError: ... is not a constructor` on
   2.10.0. Views are plain objects; aggregation uses the `AggregationType` enum. **Any pre-2.0
   tutorial or model recall produces code that does not run** — this is the concrete reason the
   live-search directive exists.

3. **`LatencyRing` must stay.** OTel histograms are **cumulative** and cannot express "mean of the
   most recent N samples". `WriteQueue`'s admission-control estimator depends on
   `recentMean(RECENT_AVG_WINDOW)` for `estimated_wait_ms`. **The histogram replaces the
   *reporting* path only; the ring is a *control* input.** Swapping them silently changes
   admission behaviour.

### Percentile accuracy, since it will be asked

Exponential histogram (`AggregationType.EXPONENTIAL_HISTOGRAM`, maxSize 160) over a known uniform
0–999 ms distribution: p50 **512** (true 500, +2.4%), p99 **1024** (true 990, +3.4%), 81 buckets
at auto-scale 3. More than adequate — the open questions are 18x and starvation, not 3%. It is
also **cheaper in memory** than retaining 1,000 raw samples.

---

## 4. Two design caveats I found in my own recommendation

Both are recorded in [`observability-substrate.md`](../../../research/observability-substrate.md) §5.8;
repeated here because they are easy to miss and both bite at implementation time.

1. **"Metrics are recomputable by replaying the JSONL" is bounded by RETENTION, not durability.**
   `_pruneOldFiles` unlinks the oldest beyond `SOX_MEMORY_LOG_MAX_FILES` (default 7) on every
   size-triggered rotation. Recent histograms replay perfectly; **lifetime cumulative counters
   cannot be reconstructed once their early history is pruned.** Consequences: the periodic
   snapshot is *not purely a cache* past the retention horizon and **needs its own retention**, or
   checkpoints get pruned alongside the events they were meant to outlive. And any status field
   derived from a cumulative counter must be **labelled with its window**, or it becomes another
   unfalsifiable number (the BL-334 pattern).

2. **Role routing as designed would introduce a pruner prefix collision.** `_pruneOldFiles`
   selects on ``f.startsWith(`${component}-`)``. Role routing varies the component
   (`memory-core-live`, `memory-core-test`). A process still using the **legacy** component
   `memory-core` prunes on `memory-core-`, which **also matches `memory-core-live-*.jsonl`** — so
   one un-migrated writer can delete the live-service forensic logs. Mitigation: a separator that
   cannot collide (`memory-core.live`), or anchor the filter on the full `<component>-<ISO-date>`
   shape. **Not observable today** — it cannot occur until role routing lands, which is exactly
   why it is written down rather than filed.

---

## 5. BL-365 — SHIPPED (`b43e7ba`), and what is genuinely left

### What was wrong, with the numbers

The BL-320 sink *looked* durable — writes to disk continuously, 21 MB of it on the live box. It
was not. `RotatingJsonlWriter.write()` used a fire-and-forget `createWriteStream`, buffered in
userspace. Child writes N records, then `SIGKILL`s itself (no handlers, no flush):

| sink | wrote | survived SIGKILL |
|---|---|---|
| `createWriteStream` + `write()` — **before** | 100 / 1,000 / 10,000 | **0 / 0 / 0** |
| `fs.writeSync(fd, …)` — **now** | 100 / 1,000 / 10,000 | 100 / 1,000 / 10,000 |

**Honest loss window** (measured by delaying the kill): +0 ms → 1,024 of 5,000 survived; +1 ms →
1,024; **+5 ms → all 5,000**. So it was *the current synchronous burst plus roughly the last
1–5 ms* — not "everything, always."

**A *hang* loses nothing** (process alive, stream drains). What lost data was `SIGKILL`, a panic,
or a power cut — and the host lost power mid-backfill on 2026-07-30 (BL-338), so **the pre-crash
window of the one incident we most needed to analyse is simply gone.**

**Cost of the fix:** 3,254 ns/record synchronous vs 1,043 ns buffered = **+2.2 µs**, ≈ **15 ms of
CPU per day** at the projected live rate; a 100-record burst blocks the event loop for 0.33 ms.

### What shipped

Durable (`fs.writeSync`) is the **default**. `SOX_MEMORY_LOG_SYNC=0` opts back into buffering for
the test/CI population — **97.3% of log volume and ~0% of forensic value** (measured: 82,541
events, 814 pids, only 16 live; live pids = 0.57 MB of 21.43 MB). That opt-out is only reachable
because **BL-344 shipped first**; before it the variable would have been silently scrubbed.

Red→green on a real child that SIGKILLs itself, with two controls that make the greens mean
something: a **negative control** (buffered mode still loses records — otherwise the passes might
just be the OS flushing fast) and a **graceful-exit control** (both modes lose nothing on clean
exit, isolating the defect to hard kills). A test that wrote and read back *in-process* **passes
against the broken implementation** — which is why this survived unnoticed.

**Side effect:** unbiases BL-353's start/finish accounting. A `.start` still buffered when the
process died was counted as *never started* rather than *never finished*, skewing the 61%/71%
unaccounted figures in an unknown direction.

### Crash-window acceptance table (post-fix, live-service)

| Signal | Persisted how | Lost on SIGKILL |
|---|---|---|
| Logs | JSONL, `writeSync` | **nothing** |
| Span starts | written from `onStart`, before the body runs | **nothing** — a hung span's `.start` is already durable |
| Span finishes | `SimpleSpanProcessor` straight through | **nothing** |
| Metrics | recomputable from the span stream + periodic snapshot | at most deltas since the last snapshot, recoverable by replay — **bounded by retention, see §4** |
| *(banned)* `BatchSpanProcessor` | in-memory batch on a timer | **the entire batch window** (5,000 ms default) |

### What is left

**Role-routed durability is designed but not implemented** — it depends on the `role` attribute
that arrives with BL-351. Today durability is global-default-on with an env opt-out, which is the
right default but means test processes pay +2.2 µs/record unless they set the var. Harmless
(~88 ms/day) and worth revisiting when `role` exists.

---

## 6. BL-375 — approved, NOT started. Build it this way.

`soxe service enable` rebuilds the launchd unit's `EnvironmentVariables` by filtering **the
invoking shell's `process.env`**. It never reads the previously-generated unit, never diffs, never
warns. Regenerating to change one unrelated key **silently dropped both live emergency brakes
while printing success.**

**BL-344 enlarged its blast radius, and this must be stated rather than discovered.** Before,
the regeneration path could silently drop the handful of allowlisted names. **After BL-344, every
forwardable `SOX_*` tunable is droppable by the same path** — the change made the right variables
reachable; it did nothing about them being discardable.

### The argument that settles it — keep this sentence intact

> **The function's own comment says *"never hand-edit the generated plist to inject env"*, so the
> only sanctioned path is the one that loses data. A design that leaves that true has not closed
> the defect.**

That framing is what makes the case and it does not survive paraphrase.

### Approved design

Service tunables become a property of the **installation** — stored in the extension's scope
config — with the ambient-env forward **demoted to an explicit override**. Regeneration then reads
from durable config rather than from whoever's shell happened to run the command.

This is a behaviour change to the install/enable contract. It was escalated rather than assumed,
and team-lead approved it **as a defect fix**: it has already cost one live incident, and the
blast radius grew after BL-344. Credit for the argument is `p0-cluster-calibration`'s.

---

## 7. Coordination — BL-369 suspension ledger (field names DECIDED)

`p0-cluster-calibration` is building a suspension ledger in `memory-core`, **self-contained and
designed for extraction** into the tracing package. Adopt it; do not build a second one.

### The premise changed — do not reach for `hrtime`

The original BL-369 framing assumed `process.hrtime.bigint()` would give sleep-safe durations.
**It does not.** Re-measured independently rather than taken on trust, because it gets baked into
every percentile the substrate will ever emit:

```
performance.now delta ms: 249.1535
hrtime.bigint  delta ms: 249.1697
difference              : 0.0161   → the same uv_hrtime() source
```

Both include system sleep on Node 24 / darwin-arm64. **The libuv issue says macOS `uv_hrtime` uses
`mach_absolute_time`/`CLOCK_UPTIME_RAW` and excludes sleep — on Node 24 it demonstrably does not.
Take the measurement over the documentation**, and leave this note in place so nobody "fixes" it
back from the docs. There is no drop-in sleep-excluding clock in JS on macOS.

### The convention

A process-global ledger: one `.unref()`'d heartbeat; gaps larger than `interval + slack` are
suspensions, discriminated by a `process.cpuUsage()` delta over the same window (≈0 CPU ⇒ **system
suspend**; CPU consumed ⇒ **event-loop block**, a different defect and also worth emitting).

Spans emit **`duration_ms` (raw, unchanged) plus `suspended_ms`**. **Annotate, never silently
subtract** — a subtracted duration is neither wall-clock nor compute and cannot be reconciled
against the record's own `ts` fields. Percentiles can then honestly exclude `suspended_ms > 0`
samples, auditably.

⚠️ **`withContendedStage`/`withSpan` must consult the ledger.** If the wrapper records duration
without it, every percentile inherits BL-369, and fixing it later changes the meaning of a metric
consumers already depend on.

### It does not cost the zero-handle property — but state the claim precisely

```
after setInterval : ["Timeout"]
after .unref()    : []        ← getActiveResourcesInfo()
```

An `.unref()`'d interval is **invisible to `getActiveResourcesInfo()` and does not hold the event
loop open.** The BL-345 property survives.

**The honest restatement matters more than the measurement:** the property worth defending is *no
background work that starves the foreground*, not literally zero work. A 1 Hz heartbeat costs
`process.cpuUsage()` 403 ns + delta 563 ns + `performance.now()` 76 ns ≈ **104 ms of CPU per day**.
That is negligible, and "negligible" is the defensible claim — "zero" was not.

**Bonus already banked:** the event-loop-block half of the discriminator *is* the event-loop-lag
measurement. The separate lag sampler was removed from the design — **one heartbeat, not two.**

### DECIDED — these are settled, build against them

Decided by team-lead 2026-07-31. Not a negotiation; both sides build against this.

| field | unit | semantics |
|---|---|---|
| `duration_ms` | ms | unchanged meaning — wall-clock, includes suspend, **never adjusted** |
| `suspended_ms` | ms | overlap with known suspension intervals; **always present, `0` never omitted** |
| `blocked_ms` | ms | overlap with event-loop-block intervals; kept **separate** — one is the machine, one is us, different owners |

All three are `_ms` doubles, so `duration_ms - suspended_ms - blocked_ms` is arithmetic a consumer
can do without a unit conversion.

**Always-present-as-`0` is the load-bearing part.** An absent field is indistinguishable from "not
instrumented" — and that exact shape has now bitten this project **four times in one day**:
`time_to_vector_ms` existing with zero samples (BL-319), BL-347's FTS probe reading 0 whether the
index was dead or healthy, BL-376's warmup budget, and BL-378's brakes. A `0` is a positive claim
that the instrument looked and found nothing; an absent field is silence, and silence has been
wrong every time.

⚠️ **Implementation note that must land in the same commit:** switching to always-emit changes the
record shape, so `docs/observability/README.md`'s boundary note needs updating alongside it — that
document is the event catalog people read before quoting a measurement, and a stale shape there is
how the next person mis-parses the log.

Two questions still open at handoff, both for whoever implements the ledger: the **clock domain**
of the ledger's interval endpoints (must match the span domain, or overlap arithmetic silently
skews), and the **heartbeat interval/slack**, which sets the resolution floor and should be
readable at runtime so the substrate reports the floor rather than implying infinite precision.

**Related trap (BL-370):** `fork()` with `'ipc'` creates a separate channel handle that
`ChildProcess.unref()` does not release, so a process that forks once never exits.
`child.channel?.unref()` is the missing call.

---

## 8. Operational state and traps at handoff

- **Deploys are held.** `sox` and `memory-server` are **not** rebuilt; the running backend serves
  the old bundle. Everything in §0 ships in the next deploy window. Both brakes are **off** and
  the embed backfill is draining in **bursts, not continuously** (1685 → 2105 vectors on the first
  tick, then paused on the per-tick heal budget; ~1.4/s averaged). Do not restart mid-drain.
- **`nx build` is destructive** (BL-235). I rebuilt only `host-runtime` and `memory-core`, both
  **snapshotted first** with restore-on-failure. Use that pattern:
  ```
  cp -R libs/<p>/dist $SNAP && npx nx build <p> || (rm -rf libs/<p>/dist && cp -R $SNAP libs/<p>/dist)
  ```
- **⚠️ `memory-core` test counts are UNSTABLE — do not gate on them, and do not report them as
  progress.** The suite returned **109, then 95, then 91** failures across re-runs of the *same*
  configuration. The instability signature is concurrent DB access: `statement has been
  finalized`, `cannot start a transaction within a transaction`, `SQLITE_ERROR`.

  **This is broader than any one item.** Failure counts have been quoted as progress through the
  day — 265 → 178 → 162 → 138 — and if the metric moves by ±14 between identical runs then some of
  that movement is noise. It does **not** invalidate the direction of travel, and the typecheck-error
  trend (941 → 112) is a much steadier signal because it is deterministic. But **no one should gate
  on a failure count, and no one should report one as evidence of progress.**

  **Use this method instead — it is reliable and cheap:**
  ```sh
  # with your change
  npx nx test <proj> --skip-nx-cache 2>&1 | grep -E "^ FAIL" | sed 's/^ FAIL  //' | sort > after.txt
  # with the change reverted (git show HEAD:<path> > <path>, rebuild)
  ... > before.txt
  comm -13 before.txt after.txt   # fails ONLY with your change  -> yours
  comm -23 before.txt after.txt   # fails ONLY without it        -> your red->green
  ```
  Applied to BL-365 this gave **zero** tests failing only with the change and **four** failing only
  without it (the new durability tests) — a clean answer that the raw counts could not have given.

  **Ownership is unresolved and someone should take it.** If the flakiness is a property of
  BL-325's in-flight state it will resolve itself as that lands. If it is genuine concurrency
  flakiness in the suites, it is **BL-202**'s territory and needs an owner. Determining which is a
  prerequisite for trusting any count again. The ~91 baseline failures belong to
  **BL-325/BL-324**, not to telemetry.
- **`telemetry.ts` appears in most DB stack traces** at the `instrumentAdapter` Proxy
  (~lines 527/574) because it wraps every adapter call. **It is not the cause** — check the actual
  error string before attributing.
- **`grep` is a shell function here and silently returns nothing on a file containing a raw NUL
  byte.** Use `/usr/bin/grep` whenever proving something is **absent**. `integrity.ts` had one
  (BL-371, now guarded by `tools/check-no-nul-bytes.mjs`).
- **BL ids collide.** Allocate programmatically — `max(existing)+1` computed, never read by eye.
  Three collisions happened in one afternoon (BL-359); mine went 354 → 356 → 358 before landing.
- **Guards before committing:**
  ```
  node tools/check-backlog-markers.mjs      # also: headings must have exactly ONE bold span
  node tools/check-no-nul-bytes.mjs
  git diff --cached --name-only             # must be EMPTY before you stage
  ```
  The backlog header has **two** count locations that can disagree; regenerate both.

---

## 9. The highest-yield question: **"can this test fail?"**

Promoted out of a footnote because it is not a note about one bug — it is the single most
transferable finding of the day, and it has now caught **four** distinct defects.

> **A test that writes and reads back in-process passes against the broken implementation — which
> is exactly why the defect survived unnoticed.**

That is BL-365's shape, and it generalises. Four instances, all found within a day:

| defect | the test that could not fail |
|---|---|
| frozen `{skip}` | Vitest froze `{skip}` at collection time, so two cross-backend tests **never executed** — and were green |
| **BL-347** | the obvious FTS probe counted Tantivy backing-table rows, which read **0 whether FTS was dead or healthy** |
| **BL-367** | recall-parity compared `uid`s across two independent stores, which mint fresh ULIDs — **zero overlap by construction** |
| **BL-365** | telemetry written and read back **in the same process** — a graceful exit flushes, so the buffered sink passes |

**Ask it of every test you write: what implementation change would make this go red?** If the
answer is "none", or "only a change nobody would make", the test is decorative and worse than
nothing — it manufactures confidence. This is BL-167's lesson recurring in four new costumes.

### Controls are what make a green informative

BL-365's suite has two, and **both were necessary**:

- **Negative control** — assert `SOX_MEMORY_LOG_SYNC=0` *still loses* records. Without it, the
  passes might merely be the OS flushing fast on this machine, and every green would be
  uninformative about durability.
- **Graceful-exit control** — assert both modes lose nothing on a clean exit. This is what
  isolates the defect *precisely to hard kills* rather than to writing generally.

A green with no control is an assertion about an unknown. Every probe added under BL-352 carries a
negative control for the same reason; treat it as the standing bar, not as extra credit.

## 10. Method notes — the two things worth copying

Recorded because they changed outcomes, not as process commentary.

**Verify a correction to your own design instead of accepting it.** The `hrtime` correction
(§7) arrived from a teammate and was right — but it gets baked into every percentile the substrate
will emit, so it was re-measured here first. Recording the *libuv-says-otherwise* discrepancy
explicitly is what stops the next person reverting it from the documentation.

**Weaken your own claim when the precise version is the defensible one.** "Zero handles" became
"an `.unref()`'d interval is invisible to `getActiveResourcesInfo()`, and the heartbeat costs
~104 ms CPU/day — negligible, not literally zero." The strong version was load-bearing in the
design and was not quite true; the precise version survives scrutiny and is still sufficient.

**Corollary, which is where most of this document's value sits:** every claim above has a number
behind it, and where documentation and measurement disagreed (libuv's `uv_hrtime`; OTel's
"durable" reputation), the measurement is recorded *with* the disagreement so it is not
re-litigated from docs.
