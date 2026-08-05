# BL-432 — the embed `wait` ≈ `work` lead does not survive a real sample

> **Verdict: retracted, and replaced by a sharper structural finding.**
> Warm steady-state `wait_ms` is **0 ms** (max 4 ms over n = 360), not 890 ms. The 890 ms was cold
> model load. More importantly: **`wait_ms` cannot answer BL-331's head-of-line-blocking question
> at all** — the queueing it was built to measure happens on the other side of the split, inside
> `work_ms`. A retracted lead is the outcome here, and the structural reason it was never
> measurable is worth more than the number would have been.

*Measured 2026-08-04/05, branch `wip/turso-live-metrics`. Live artifact `172384a93ddf`, pid 22347.*

---

## 1. The lead being tested

The BL-401 stage migration split `embed` into a `wait` half (`admit`) and a `work` half
(`_embedWork`), and its own source comment states the purpose:

> "`admit` is acquiring the shared fastembed child process, `work` is the inference. That split is
> the direct measurement of BL-331's open question — cold model load and head-of-line blocking
> behind the single shared child land in `wait_ms`, inference lands in `work_ms`."[1]

The commit that landed it measured `wait_ms` mean **890 ms** vs `work_ms` mean **784 ms** and read
that as *roughly half of embed latency is acquiring the shared child, not inference*[2] — which, if
true, is a direct confirmation of BL-331 and an argument against the single-shared-child design.

That sample was **n = 2 and cold-start-inclusive**.

---

## 2. What `admit` actually contains

```ts
MEMORY_CORE_STAGES.withContendedStage(
  'embed', stagePath,
  async () => {                       // ← the `wait` half, in full
    _configCache ??= resolveConfig();
    await getOrCreateProvider();
  },
  () => _embedWork(text),             // ← the `work` half
);
```
[1]

`getOrCreateProvider()` memoises into `_provider` and returns it on every subsequent call[1]. So
after the first embed in a process, the `wait` half is **an already-resolved promise and a null
coalesce** — it has no dependency on the child's queue depth at all.

The queueing is one level down, inside the `work` half:

```ts
async embedSingle(text) {
  await this.ensureReady();
  const res = await this.shared.request({ type: 'embed', text });   // ← the actual wait
  ...
}
```
[3]

`SharedFastembedProcessClient.request()` sends on the IPC channel and awaits a correlated reply[4].
Every millisecond spent behind another caller's in-flight request — the literal definition of
head-of-line blocking on the shared child — elapses **inside `embedSingle`, inside `_embedWork`, and
is therefore recorded in `work_ms`.**

**This is the finding.** The split is not mismeasuring head-of-line blocking; it is structurally
incapable of measuring it, because both halves of the question land in `work_ms`. The 890 ms was
cold model load, which is the *one* thing `admit` does capture — on the first call only.

---

## 3. The sample

### 3.1 Live service — organic traffic, no synthetic writes

`~/.adhd/sox-ecosystem/memory-server/logs/memory-server.live-service-2026-08-05.jsonl`,
pid 22347, `role: live-service`:

| path | `wait_ms` | `work_ms` | note |
|---|---:|---:|---|
| write | **24** | 672 | first embed after deploy — cold |
| write | **0** | 649 | warm |
| heal | **0** | 753 | warm |

Warm `wait_ms` is **0 ms in every live sample**, against `work_ms` of 649–753 ms.

### 3.2 Controlled harness — interleaved concurrency arms

`embed()` driven directly against the real fastembed provider. **No store is opened** —
nothing under `~/.memory` is read or written. Arms interleaved round-by-round rather than
A-then-B, per the standing methodology (machine load swings hundreds of percent within
minutes)[5]. Cold start excluded and reported separately; medians only, because `duration_ms` is
wall-clock and accrues during system sleep (BL-369).

**Run A — n = 210** (14 rounds; load 8.62 → 20.84; 3–4 competing fastembed hosts):

| concurrency | n | `wait_ms` median | `work_ms` median |
|---|---:|---:|---:|
| 1 | 14 | **0** | 304 |
| 2 | 28 | **0** | 593 |
| 4 | 56 | **0** | 875 |
| 8 | 112 | **0** | 1521 |
| **all** | **210** | **0** | 928 |

**Run B — n = 150**, same harness with the full `wait_ms` distribution rather than just the median
(10 rounds; load 16.67 → 21.50; 3–4 competing hosts):

| concurrency | n | `wait_ms` median | `wait_ms` **max** | `wait_ms` > 0 | `work_ms` median |
|---|---:|---:|---:|---:|---:|
| 1 | 10 | 0 | **0** | 0 / 10 | 332 |
| 2 | 20 | 0 | **0** | 0 / 20 | 514 |
| 4 | 40 | 0 | **1** | 3 / 40 | 963 |
| 8 | 80 | 0 | **4** | 8 / 80 | 1506 |
| **all** | **150** | **0** | **4** | **11 / 150** | 966 |

Cold start, excluded from both tables and reported separately: `warmupEmbed()` 828–1016 ms, first
post-warmup embed 335–360 ms.

**Across n = 360 warm embeds and an 8× concurrency sweep, `wait_ms` never exceeded 4 ms** — while
`work_ms` rose 5.0× (304 → 1521 ms) over the same sweep. If the `wait` half measured contention for
the shared child, this is precisely the sweep that would move it. It does not move.

> ⚠️ **The absolute `work_ms` numbers are not a baseline.** Load average ran 8.6 → 21.5 (10 CPUs)
> with **3–4 concurrent `fastembedProcessHost` processes** on the machine — one belonging to the
> live service, one to another agent's vitest run measured at 455 % CPU. Cross-process onnxruntime
> CoreML/ANE execution is itself a known 25–50× latency hazard, which the host warns about on
> startup. Read the `work_ms` column only as *"rises with concurrency"*, nothing finer.
> **The `wait_ms` column is the result**, and it is robust to exactly this contamination: load
> inflates work, and no amount of load makes an already-resolved promise take longer than 4 ms.
> The machine did not become quiet at any point during this session (8 agents active); rather than
> withhold the result, the conclusion is stated in the form load cannot affect.

---

## 4. What this means

- **BL-331's head-of-line-blocking question is not answered in the negative — it is still
  unanswered.** The instrument that was supposed to answer it does not observe the thing.
- **The 890 ms figure is retracted.** It was one cold model load averaged with one warm embed.
- **`wait_ms` is still worth keeping.** Flat-0 in steady state with a nonzero value on the first
  call is a clean cold-start detector, which is precisely what BL-376's cache-hit/cache-miss
  warmup budgets need. It is simply not a contention signal.

### What would actually answer BL-331

The measurement has to happen where the queue is — inside `SharedFastembedProcessClient`:

1. **Queue depth at admission**: `this.pending.size` sampled when `request()` is called. This is
   the direct head-of-line-blocking signal and it is one field on an existing map.
2. **Time-to-first-response vs. time-in-queue**: stamp `request()` entry and the `child.send()`
   that follows, so a request that sat behind three others is distinguishable from one that the
   child was simply slow to answer.
3. **Competing-host count.** A second `fastembedProcessHost` on the machine changes embed latency
   by 25–50×, and nothing in the telemetry currently records whether one was present. Any embed
   latency number gathered without it is unlabelled — the same defect class as BL-433: a value
   whose meaning cannot be recovered after the fact.

All three go through `@adhd/sox-telemetry` at the existing `instrumentBoundary` seam; none of them
needs a second telemetry mechanism.

---

Citations: [wip/turso-live-metrics, telemetry-gaps agent, claude, BL-432,
1: libs/memory-core/src/embed.ts:228-248 (the `withContendedStage` split, its stated purpose, and
the `admit` body) and :186-200 (`getOrCreateProvider` memoising `_provider`),
2: commit c81c0b7 message,
3: libs/data/embed/embedding-provider/src/fastembed.ts:143-159 (`embedSingle` → `shared.request`),
4: libs/data/embed/embedding-provider/src/sharedFastembedProcess.ts:185-216 (`request()`: correlated
IPC send/await, `pending` map),
5: docs/reporting/memory/handoff/perf.md:100-118 (§2.1 interleave arms; §2.3 spawn-method axis),
6: ~/.adhd/sox-ecosystem/memory-server/logs/memory-server.live-service-2026-08-05.jsonl (the three
live `sox.stage.embed.finish` records quoted in §3.1)]
