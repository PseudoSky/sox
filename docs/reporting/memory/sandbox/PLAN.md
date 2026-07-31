# Sandbox Harness — Implementation Plan

> Companion to [`README.md`](./README.md) (the spec). This file is the **ordered build plan**,
> including every fix that must land *before* a run can be trusted.
> **Status:** P0 dispatched 2026-07-31. Owner decisions on clustering (BL-326 → BL-349/BL-350),
> adapter self-repair (BL-352) and tracing (BL-351) are **recorded and closed** — see P0.4, P0.7, P1.0.

---

## 0. The architectural rule this plan follows

**The sandbox is not a product. It is a thin runner.**

Every metric it reports, every health verdict it renders, and every repair it exercises must be
a **shipped capability of the packages**, surfaced through the real status surface. The harness
orchestrates, samples, asserts, and writes reports. It does not own instrumentation.

The test is simple: *if a measurement only exists when the harness runs, it is in the wrong
place.* An operator hitting `memory_ping` on the live server at 3am must get the same facts the
harness gets.

This is not a purity argument — it is the direct lesson of this migration. Every question that
mattered on 2026-07-30 was answered by host archaeology (`grep` a CoreML warning out of a log,
`ps` for contending pids, poll `vec_node` COUNT from a side connection) and several of those
answers were **wrong** and had to be walked back. That is BL-334, already filed. Building those
same probes into a harness would leave production exactly as blind as it is today, while giving
us a green dashboard.

### Division of ownership

| Concern | Owner | Backlog |
|---|---|---|
| Per-span timings (`write_to_vector_ms`, `vec_insert_duration_ms`, embed throughput, drain rate) | **packages** → `memory_ping` | BL-319 |
| Capability + contention + FTS health + EP facts | **packages** → `memory_ping`/`memory_stats` | BL-334 |
| Lock/queue wait-vs-work accounting | **packages** | BL-322, BL-345 |
| Integrity detection + repair | **packages** | BL-352, BL-335/336/337/347/338/341 |
| Tracing/metrics substrate (spans, wait-vs-work, status export) | **packages** | BL-351 |
| Pipeline stage isolation (embedding never blocked or dropped) | **packages** | BL-348, BL-349 |
| Row-level resilience in aggregates | **packages** | BL-343 |
| Gate ladder, fail-fast sequencing | harness | — |
| Quiesce protocol | harness | — |
| Corpus sampling / replay through the tool surface | harness | — |
| Report, scorecard, ledger, regression ratchet | harness | — |
| Damage seeding (negative controls) | harness (fixtures) — *detection* is packages | — |

Roughly **80% of this plan is product work already on the backlog.** The harness proper is
small, and it is deliberately the last thing built.

---

## P0 — Blockers. A run before these measures a lie.

### P0.1 — BL-330: unlinked WAL silently discards committed data · **HIGH**
Proven: with the WAL unlinked, a graceful `close()` **silently discarded 90 of 140 committed
rows and threw no error.** Also: `sqlite3 .backup` of a live Turso store silently omits WAL
contents.

**Why it blocks:** the harness closes the store between gates and snapshots it on failure. If
close can silently drop writes, then *every* "row did not persist" red is unfalsifiable — we
cannot distinguish a real feature defect from teardown eating the data. This single defect
would poison the entire ladder.
**Ships:** detect unlinked/missing WAL at open, refuse-or-recover loudly; documented consistent
snapshot procedure.

### P0.2 — BL-342 + BL-343: one malformed row disables an entire tool · **HIGH**
`tags = ''` (invalid JSON) currently breaks `memory_stats` completely.

**Why it blocks:** `memory_stats` is a primary scorecard read, and §3.1 of the spec
*deliberately samples* `tags = ''` rows because that shape exists in real data. As written, the
harness would ingest a real row and take its own scorecard offline. Row-level resilience is the
real fix; skipping the shape would be hiding from it.

### P0.3 — BL-323: `sqlite-vec` load destructures a non-existent `default` export · **HIGH**
Every `openDb()` on the sqlite adapter throws.

**Why it blocks:** it kills the **sqlite control arm**. Without a control, every Turso result is
unattributable — "is this Turso or is this us?" is exactly the question that consumed this
migration. A cross-backend run is worth far more than a Turso-only run.

### P0.4 — BL-348: enrichment/clustering can block and LOSE an embedding · **CRITICAL**
*(supersedes the "owner decision required" that stood here — BL-326 is now decided; see below.)*

The write pipeline has no stage isolation. Embedding, topic enrichment, edge drawing and
clustering share one path, so a downstream failure can discard a **successfully computed
embedding**, and a slow stage blocks the pipeline behind it.

**Owner directive, verbatim:** *"the execution of clustering should never block an embedding
from being written. Failing clustering should never drop an embedding. Embedding vector loss is
a critical failure."*

**Why it blocks:** G2 and G3 assert that vectors persist — G3 specifically under concurrency,
with enrichment live. Against a pipeline where an unrelated stage can roll back a vector, a
red is unattributable and a **green is not trustworthy either**, because it only says the
downstream stages happened not to fail on this run. Embedding+vector persist must be a
committed stage before any persistence assertion means anything.

**Decision recorded (BL-326 → BL-349, BL-350).** Clustering becomes a **backgrounded
write-triggered association** — enqueued, not awaited; idempotent and coalescing; failure-
isolated from the embedding commit. The unresolved algorithmic tail (clusters are not
constant-time splits and do not self-reorganize — splits, merges, drift, orphaning) is filed
as **BL-350** for research and is explicitly *not* solved by BL-349.

**Effect on the ladder:** G4 becomes buildable once BL-349 lands. Until then it stays specified
and unbuilt, with automatic clustering marked `grey` — never a corpus-attributed red.

### P0.5 — BL-328: cluster threshold calibration · **MEASURED 2026-07-31 — see [`cluster-calibration.md`](./cluster-calibration.md)**

**Done. The suspicion recorded here was backwards, and the corpus question is answered yes.**

- **A real-content G4 cohort is viable.** Three *selected-for-distinctness* real topics × 8, drawn
  from the live store, cluster at the production default into 5 communities, 23/24 covered,
  **100% purity, zero cross-group contamination** — better than the synthetic corpus at the same
  τ. Real intra-group means (0.8144 / 0.8495) are *higher* than the hand-written corpus (0.8087);
  naturally-worded rows do not fall below the bar.
- **τ=0.82 is mis-calibrated upward, not downward.** On the live store's own 1616 production
  vectors it puts **68.4%** of the corpus in one cluster. τ=0.65 — the value
  `clustering-e2e.test.ts` calls "measured-safe" — puts **97.8%** in one cluster at purity 0.410.
  It is safe on that fixture and nowhere else.
- **BL-328's two driver claims were false** and are corrected in the item.
- **τ cannot be a constant at all** (new, **BL-356**): `minPts = 2` makes this single-linkage, so a
  fixed τ fixes edge probability and mean degree grows linearly with N. Largest-cluster ratio at
  τ=0.82 goes 0.085 → 0.684 as N goes 200 → 1616 on identical content. The degenerate guard is
  what production actually runs on, and it can exhaust its 3 retries and accept a degenerate
  partition anyway.

**Constraints this puts on G4 when it is built:** select topics for distinctness (an arbitrary
topic-labelled sample has inter-similarity ≥ intra-similarity — `topic` is enrichment, not a
semantic partition); assert *purity + dominance*, never "one community per group" (no corpus,
synthetic included, satisfies that at the default); and pin the cohort uids.

### P0.6 — Test-infrastructure integrity · BL-340, BL-325, BL-324
`typecheck-tests` target does not exist; 18 `memory-core` specs never `await` the now-async
`openDb()`; 8 reproducible `memory-server` failures.

**Why it blocks:** the harness will be written *as tests*. Building it on a suite that does not
typecheck, with a known-broken async contract, reproduces the exact conditions that let the
frozen-`{skip}` bug hide two never-executing cross-backend tests behind a green board.

### P0.7 — BL-352: adapters must verify and self-heal what they generate · **HIGH**
*(replaces "rebuild the live FTS index" — the manual fix was proposed, verified, and **rejected
by the owner**.)*

**Owner directive, verbatim:** *"the store adapter migration strategy was designed and built,
so if the tables are not 100% accurate and resolved when that auto migrator runs that is a
product defect that should not be manually corrected. … the adapters should be verifying their
store and migrating any missing data + generating missing indexes etc."*

**The live store stays broken until the adapter fixes it itself.** Hand-repairing it would
destroy the only reproduction we have of the real defect and leave the store one crash away
from an identical, equally silent outage.

**The mechanism, now understood:** `applySchema()` reconciles by **existence**, never
**integrity**. `CREATE INDEX IF NOT EXISTS idx_fts_node` **no-ops** on an index that exists
with an empty Tantivy directory, the version gate is already satisfied, and the adapter
concludes the store is fully migrated (BL-302: `targetVersion` hard-coded to `1`, no
`migrations[]`). The same shape produced BL-335 (nine unpopulated secondary indexes) and BL-336
(duplicate `_adapter_meta` PKs). **Existence is not integrity, and no `IF NOT EXISTS` DDL can
ever detect a present-but-empty derived structure.**

**Why it blocks:** the harness opens a fresh store every attempt and trusts the adapter to
produce a correct one. If the adapter cannot verify its own output, "the schema is right" is an
assumption at the base of every gate above it.

**Note carried into implementation:** every integrity probe needs a negative control. The
obvious FTS probe — counting Tantivy backing-table rows — reads **0 both when FTS is dead and
when it works**. It detects nothing.

---

## P1 — Product telemetry. The measurements, in the packages.

These are §6.2 and §6.4 of the spec, and they are **already filed**. The harness reads them; it
does not implement them.

### P1.0 — BL-351: the shared tracing/metrics package · **HIGH** · *build first in P1*

**Owner directive, verbatim:** *"All of these operations need independent tracability & metrics
at their sox package level."* / *"We should architect the tracing package so that we are
reusing and implementing the metrics + logging + function level tracing correctly."*

BL-319 and BL-334 are *fields*. This is the *substrate* they are reported through, and it does
not exist. Today BL-320's telemetry is **memory-core's alone** — `embedding-provider`,
`store-adapter`, `graph-store` and `host-runtime` have no equivalent — and its four env
controls are **silently scrubbed by the six duplicated allowlists** (BL-344), so the tracing we
do have cannot be switched on where it matters.

Two symptoms that make the case: `time_to_vector_ms` exists and has **0 samples**, because heal
bypasses write-path instrumentation (BL-319); and BL-331's 18x slowdown is *still* unexplained
because stage-level attribution is impossible.

Requires: shared structured logging, function/stage spans on a propagated trace-id (extend
BL-320's AsyncLocalStorage), counters/gauges/histograms, and uniform export **into the status
surface** rather than into a log a human must grep. The **wait-vs-work split** must be a
first-class primitive, not a per-consumer convention.

Per the DRY directive: query memory for prior internal tracing work and prior tool research
before any live search; if none, search current OpenTelemetry-compatible Node options and log
the evaluation with tags and the decision. Check the bundled-extension externals policy
(BL-307/BL-309) before adopting a dependency.

**Build this before P1.1/P1.2** — those are its first two consumers, and implementing them
first would produce exactly the per-consumer conventions this item exists to prevent.

### P1.1 — BL-319: computed throughput + timing fields · **HIGH**
Already enumerates almost exactly the spec's span set: `embed_throughput_per_sec`,
`write_to_vector_ms`, `vec_insert_duration_ms`, `embed_tokens_per_sec`, `backlog_drain_rate`.
Note the filed detail that `time_to_vector_ms` exists but has **0 samples**, because heal-path
embeddings bypass write-path instrumentation — a metric that exists and never populates is the
same as no metric.

**Gap to close beyond BL-319 as filed:** the spec additionally requires `write_queue_wait` and
`embed_enqueue_wait` — **waiting**, separated from **working**. BL-319 covers durations but not
the wait/work split. That split is the whole subject of Theme 2. Extend BL-319 rather than
filing a duplicate.

### P1.2 — BL-334: capabilities, contention, EP facts, FTS health · **HIGH**
This is the harness's primary read API. Its filed table is, almost line for line, the
scorecard.

**Correction that must be applied when implementing it:** BL-334 proposes an FTS field of
"index present + document count + last-built." **Document count is not obtainable that way.**
Measured 2026-07-31: the Tantivy backing-table row count reads **0 both when FTS is dead and
when it works.** The only sound probe is an `fts_match` against a known-present sentinel token.
Implementing BL-334 literally would ship a health field that is wrong in both directions
(BL-347).

### P1.3 — BL-322 + BL-345: contention accounting · **HIGH**
BL-345 already records that **any** in-process background job starves foreground reads — not
just embed heal. The wait-vs-work spans plus event-loop-lag sampling are the instrument that
turns that from an observation into a measurement, and they are what Theme 2's design has been
blocked on.

---

## P2 — Product health and repair.

### P2.1 — Unified repair helper · BL-335, BL-336, BL-337, BL-347
Enumerate btree indexes and reindex individually (whole-table `REINDEX` is impossible on a
table carrying a Tantivy index), **and** rebuild the FTS index via its own DDL — the step whose
omission caused BL-347.

### P2.2 — Automatic detection and recovery · BL-338, BL-341
BL-338's bar, recorded verbatim from the owner: *"In the production grade version — none of
this is manual & none of the crash data loss should be possible."* BL-341: `PRAGMA
integrity_check` caps at 100 messages, so "100 issues" means "at least 100" — a repair loop
that trusts the count will under-repair and report success.

**Detection is the load-bearing half.** A repair that works but is never invoked is what we
have today.

---

## P3 — The harness itself. Thin.

Only now, and only what nothing else can own: gate ladder + fail-fast sequencing · quiesce
protocol with unconditional restore (PID-verified, because BL-332 says `soxe list` reports a
running service as INACTIVE) · isolation manifest assertions · stratified corpus sampling and
replay through `handleToolCall` · damage-seed fixtures for negative controls · timeline
aggregation · report / scorecard / ledger / regression ratchet.

Everything here is orchestration and reporting. If a P3 task starts to look like
instrumentation, it belongs in P1 and the plan is being violated.

---

## P4 — Run, and keep running.

Execute the ladder. Every red → triage → fix → **file the BL item even if fixed within the
hour** → rebuild → fresh sandbox → new attempt. Three green attempts before any metric is
treated as a baseline.

---

## Sequencing notes

- **P0.1, P0.2, P0.3, P0.6 are strictly serial with everything else.** They are correctness
  preconditions; a run before them produces numbers that cannot be trusted in either direction.
- **P0.4 is a decision, not a task** — it gates only G4, so P1/P2 can proceed in parallel while
  it is open.
- **P1 and P2 parallelize well** — different files, different packages. They are the bulk of
  the work and the part that improves production whether or not the harness is ever run.
- **P3 is deliberately last.** Building the runner first would create pressure to put
  instrumentation in it, which is precisely the failure this plan exists to avoid.

---

## What this plan delivers even if the harness is never run

Worth stating plainly, because it is the strongest argument for this ordering: P0–P2 are
**entirely production improvements**. Silent WAL data loss fixed. One bad row no longer
darkening a tool. Real throughput and contention metrics in `memory_ping`. Working FTS health.
Automatic integrity detection and repair. Clustering resolved one way or the other.

The harness is what proves they work. It is not what makes them valuable.
