# Handoff — drain scheduling thread (BL-382 / BL-322)

> **Written by the team lead, not the agent.** `queue-perf` hit a session limit before it could
> write its own. Everything here is from its design report; where I verified against the repo I say
> so. **Its implementation is preserved as WIP in `e9aa0cb` and is NOT verified working.**
>
> **Entry point:** [`../README.md`](../README.md) → [`../STATE.md`](../STATE.md).

**State:** design approved, implementation started, **not finished and not verified**. BL-382 open.

---

## 1. The item's premise was WRONG — fix this understanding first

BL-382 originally claimed *"a freshly written episode is unsearchable by vector until the next
tick."* **That is false on the healthy path.** `schedulePendingEmbeds()` is called fire-and-forget
right after the Phase-A queue task returns, at `memory-server/src/index.ts` **1302** (write),
**1369** (write_batch), **1772** (update). Measured on the three real writes in that backend's life:

| Phase-A finish | vector applied | time-to-vector |
|---|---|---|
| 23:34:00.364 | 23:34:01.064 | **0.70 s** |
| 23:34:00.393 | 23:34:01.383 | **0.99 s** |
| 23:34:00.421 | 23:34:01.726 | **1.31 s** |

**What genuinely has no wake is the backlog drain (`healMissingVectors`)** — and the wake it needs
is **on-drain-incomplete**, not on-write. Items reach the drain only when Phase B fails or the
process dies between phases. The item body was corrected in `e046ec4`.

---

## 2. The real defect, measured — and the part nobody had named

Over pid 69947's 1209 s life, n=701 embeds (**CONTENDED** — 9 agents on the box; ratios are the
result, absolutes are not a baseline):

| | |
|---|---|
| embed p50 / p90 / p99 / max | 580 / 1157 / 2082 / 2948 ms |
| embed wall time | 482 s (**39.9%** of span) |
| idle gaps >5 s | 467 s (**38.6%** of span) |
| throughput over span | **0.58/s** |
| throughput while embedding | **1.45/s** |

The gaps decompose exactly, **no residual**:

```
23:34:24.010 → 23:38:24.088   heal ran 240.1s → TIME BUDGET EXCEEDED (417 healed, 83 of 500 left)
23:38:24     → 23:45:49       GAP 445.0s = 145s runBatchEnrich + backlog COUNTs + 300s interval
23:45:49.116 → 23:49:51.149   heal ran 242.0s → budget again (281 healed, 219 left)
23:49:51     → 23:53:01       GAP 190.2s (same shape)
```

**The finding nobody had named: to embed 417 vectors the drain must also pay ~145 s of
`runBatchEnrich`.** The drain is coupled to the clustering pass inside one tick. **Decoupling them
is the largest single win**, and it stays strictly inside "drain only" — it *removes* clustering
from the drain's path rather than touching BL-349/BL-350.

---

## 3. The approved design — three changes, all in `memory-server/src/index.ts`

**(a) Split the drain from the enrich pass.** `runEnrichPassOnDb` currently does heal →
`runBatchEnrich` → queue-drain in one tick. Split into two independently-scheduled loops, each with
its own in-flight guard, sharing **one background-slot mutex** so only one background job runs at a
time. That mutex preserves the BL-346 anti-stampede property; the *scheduling* becomes independent.

**(b) Adaptive reschedule, backlog-driven.** After each drain pass: backlog remaining → rearm at
`SOX_EMBED_DRAIN_IDLE_MS` (**default 250 ms** — non-zero deliberately, so the loop is a chain of
macrotasks, never a spin, leaving air for foreground reads). Backlog zero → rearm at the floor.
The floor remains the post-restart / missed-path recovery trigger.

**(c) `wakeDrain(reason)` — debounced and coalescing.**
```
if (drainInFlight) { drainDirty = true; return; }   // fold into the current pass's tail
if (wakeTimer !== null) return;                     // already armed — coalesce
wakeTimer = setTimeout(runDrainGuarded, WAKE_DEBOUNCE_MS); wakeTimer.unref();
```
Call sites: the Phase-B failure path (the only write-side path that actually *creates* drain work),
plus the three `schedulePendingEmbeds` audit points.

---

## 4. BL-154 re-entrancy — the reasoning, which must not be weakened

BL-154's deadlock shape is **hold-and-wait on the same serial queue**: a task holding the slot calls
`wq.enqueue` and waits for a slot only it can release. The wake is safe by **three independent
properties**, and all three are wanted because any one alone is a call-site convention:

- **(a) Call site is outside the slot.** Every wake sits after `await wq.enqueue(...)` resolved —
  the same audit point that already licenses `schedulePendingEmbeds` at `:1302`.
- **(b) The wake never runs work synchronously.** `wakeDrain()` only arms a `setTimeout`, so the
  drain body runs on a later macrotask, after the task's await chain resumed and freed the slot.
  **This is the load-bearing guarantee** — it makes safety independent of every call site's
  discipline, which (a) alone cannot promise. Same lesson as BL-344: a call-site convention gets
  copied and then diverges. **Do not let a reviewer talk this down to (a).**
- **(c) The guard never touches the queue.** `drainInFlight` short-circuits to a dirty flag; it
  neither awaits nor holds a slot, so it cannot be a node in a wait cycle.

A re-entrancy shape unique to this change: a wake fired by the drain's own apply completions would
self-trigger forever. Prevented by (c) plus the `backlog == 0 → floor` rule.

**Never wake from inside `applyEmbedding` or any `wq.enqueue` callback.**

**Required red→green, NOT yet run:** a `memory_write` with >2000 chars (the auto-chunk path that
hung forever in BL-154) must hang with the wake moved *inside* the slot and pass with it outside.

---

## 5. BL-345 — measured, not assumed

Foreground `memory_recall` over HTTP against the **live** server while the heal ran at 99.9% CPU,
n=8: `436 420 426 422 429 423 425 427 ms` → **p50 425 ms, σ ≈ 5 ms, 0 timeouts**, provenance
`["vec"]`.

**Reads are not starved by the drain today**, and the mechanism matters: the heal's `await embed()`
yields the loop every ~580 ms. The genuine starvation source is `runBatchEnrich`'s **synchronous
SQL** — which change (a) removes from the drain's path.

**Acceptance the agent committed to, and which I care about more than the throughput number:**
re-run this identical probe against the changed build and require **no regression**.

**⚠ Cross-item tension — record on BL-322:** 425 ms is roughly one heal-embed slot of head-of-line
wait. If BL-322 raises drain concurrency on the shared fastembed child, **foreground read latency
goes up**. The drain fix and the BL-322 fix pull opposite ways on this number, so BL-322 needs its
own foreground check.

---

## 6. Re-derived constants (approved; all env-overridable)

From measured p50 580 ms / mean 688 ms contended (~450 ms uncontended per BL-331):

| constant | now | approved | why |
|---|---|---|---|
| `SOX_EMBED_HEAL_TIME_BUDGET_MS` | 240 s | **30 s** | Its only job was "finish before the next tick overlaps". With a self-chaining drain and a hard in-flight guard, overlap is impossible by construction, so it now only bounds scan staleness. 30 s ≈ 50 embeds. |
| heal batch `limit` | 500 | **64** | At 580 ms/embed a 500-row window is 290 s of work — it *always* truncates, and truncation wastes the scan. 64 ≈ 37 s. |
| drain floor | 300 s (shared) | **30 s** (`SOX_EMBED_DRAIN_FLOOR_MS`) | Only reached at backlog 0; costs one indexed COUNT. |
| `PERIODIC_ENRICH_INTERVAL_MS` | 300 s | unchanged | Stays the *enrich* floor. Not the drain's business. |

Env-overridable is deliberate: deploy-time tuning without a rebuild, on a service where a rebuild
is a whole procedure (`[inv:deploy-verified]`, service-lifecycle spec §9.4a).

**Predicted, NOT verified:** idle fraction 38.6% → <2%; sustained 0.58 → ~1.4/s; remaining ~2800
items ~81 min → ~33 min. **Verify against the live drain; do not assert.**

---

## 7. State of the implementation — read `e9aa0cb` before resuming

Preserved as WIP by the team lead after the session limit. **Verified:** `memory-server` typecheck
passes; lint 0 errors (1 pre-existing unrelated warning); contains `wakeDrain` /
`schedulePhaseBAndWake` (11 refs) and BL-381's `vectorDialect` (5 refs).

**NOT verified:** whether it is complete or correct. `drain-wake.spec.ts` was added but **not run**.
The BL-154 >2000-char repro was **not run**. No red→green was watched. **Treat it as a starting
point, not a landed fix.**

**⚠ `vectorDialect:` must be kept in that file** or `memory-core` will not compile — `fc71730` made
the dialect a required argument.

---

## 8. Measurement discipline this thread established

**Every rate claim must state its measurement window.** Four rates were quoted for the same drain
before the honest one was measured: 1.7/s (in-burst), 1.4/s (estimated over one cycle), 0.58/s
(the agent's span), **0.45/s (team lead's end-to-end over 25.8 min)**. Only the last two are
throughput; the first two are instantaneous rates generalised into steady-state claims — **the same
error as BL-331's original "18x" framing**, repeated within hours of documenting it.
