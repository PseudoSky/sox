# Sandbox Harness — Implementation Plan

> Companion to [`sandbox/README.md`](./sandbox/README.md) (the spec). This file is the **ordered build plan**,
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

## Standing architectural rule — the storage boundary

**Owner directive (2026-07-31), verbatim:** *"None of the code outside store-adapter should be
showing sqlite or turso other than in the adapter instantiation options."*

**Adopted, with one refinement: `store-adapter` and `migration.ts` are the only modules permitted
to name a backend.** Migration legitimately converts between engines, so it must know both. A rule
with unstated exceptions gets ignored the first time someone hits a real one.

Everything else goes through **capabilities** and **dialects** (`FTSDialect`, `VectorDialect` — both
already exist). Backend choice is an *instantiation option*, nothing more.

**Four independent violations were found in a single day, all silent, all on the default backend:**

| item | violation | consequence |
|---|---|---|
| BL-377 | `(adapter as SqliteAdapter).unwrap()` | export + re-embed broken since the migration — read as test debt for weeks |
| BL-380 | six more unchecked casts (`vector-store` ×3, `memory-cli` ×3 via `as any`) | open |
| BL-364 | raw handle passed where a `StoreAdapter` is expected — the *inverse* | 15 hybrid-search tests red for 4 days |
| BL-381 | hardcoded `vec0` SQL bypassing `VectorDialect` | near-duplicate detection dead on Turso, confirmed on 3/3 live writes |

**The rule is not the fix — enforcement is.** All four passed review, typecheck and CI. A lint rule
banning backend names, `as SqliteAdapter`/`as TursoAdapter`, `.unwrap()` and raw `better-sqlite3`
imports outside the two permitted modules **encodes existing practice** (the codebase already
demonstrates the correct capability-guarded form in `db.ts`) and would have caught every one.
Tracked in BL-380.

**Two apparent exceptions are really missing capabilities, and should be named as such rather than
blessed:** `db.ts` loading `sqlite-vec`, and `backup.ts` doing `VACUUM INTO`. Both reach around the
adapter because it exposes no equivalent. "Load an extension" and "make a consistent snapshot" are
legitimate adapter operations. **`backup.ts` sidestepping this is why nobody knows whether a Turso
store can be backed up at all** — still unanswered.

---

## P0 — Blockers. A run before these measures a lie.

> **⚠️ STALENESS (2026-08-01).** This plan names 25 of the 85 currently-open items; **53 open items
> (62%) appear nowhere in it**, including everything filed on 08-01 (BL-387..BL-400). It also still
> references 11 ids that are now closed. P0.6 and P0.7 are COMPLETE. Use `BACKLOG.md` as the queue;
> use this plan for sequencing only the subset it names, and reconcile before planning from it.

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

### P0.3 — ~~BL-323: `sqlite-vec` destructure~~ · **CLOSED 2026-07-31 — and its own text was misleading**

BL-323 is **fixed and closed** (verified by *reintroducing* the bug, not by inspection: with the
`default` destructure restored the spec fails 2/3 with the original `TypeError`; restored, it
passes). It has been moved to `CHANGELOG.md`.

**It was listed here as a P0 blocker on the strength of its own overstated text**, which claimed it
was *"very likely the dominant contributor to the ~266/267 pre-existing memory-core test
failures."* **Measured, it is 16 tests** — suite failures moved 178 (bug present) → 162 (bug
absent). The remaining 162 were never BL-323 and will not collapse now that it is fixed.

Recorded rather than deleted, because the failure mode generalises: **an item's own severity claim
is not evidence.** This one shaped a plan for two days. The same caution applies to BL-342, whose
stated root cause (`tags = ''`) was also measured wrong — it is `enrich_ver = ''` — and would have
sent an agent to normalise the wrong column, watch a clean sweep, and report success while
`memory_stats` stayed dead.

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

### P0.6 — ~~Test-infrastructure integrity · BL-340, BL-325, BL-324~~ · **COMPLETE 2026-08-01**
All three closed. `typecheck-tests` exists and provably reads spec files (red arm watched: injected
`TS2322` in `errors.spec.ts`); `memory-core` is 491/491 with 0 failures; `memory-server` 184/184.
`typecheck-tests` target does not exist; 18 `memory-core` specs never `await` the now-async
`openDb()`; 8 reproducible `memory-server` failures.

**Why it blocks:** the harness will be written *as tests*. Building it on a suite that does not
typecheck, with a known-broken async contract, reproduces the exact conditions that let the
frozen-`{skip}` bug hide two never-executing cross-backend tests behind a green board.

### P0.7 — ~~BL-352: adapters must verify and self-heal what they generate~~ · **COMPLETE 2026-08-01**
`integrity.ts` implements five probes plus `repairStoreIntegrity`. Proven live: the FTS index
self-healed on open, `fts_match('memory')` 0 → 1158, with no manual DDL. **Note P0.1 (BL-330) is
NOT covered by this and remains open** — S2 in `STATE.md` previously conflated them.
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

---

# Coverage reconciliation — 2026-08-01

Everything below was written after measuring this plan against `BACKLOG.md` and finding **51 of 80
open items named nowhere in it**. The sections below give every one of them a home or an explicit
exclusion. Sequencing here is deliberately *provisional* — see [Task packets](#task-packets) — but
coverage is not: an item that appears in neither the sections below nor the exclusion list is a bug
in this document.

## P0.8 — BL-342: the malformed row was never repaired · **HIGH** · *P0, still open*

`memory_stats` on production reports `malformed_rows: {count: 1, columns: ["tags"], sample_rowids: [9284]}`.
BL-343 made the tool *survive* it (tested), which masked that the data was never fixed. Needs a
migration that finds `tags = ''` (invalid JSON, not NULL) and repairs it, plus a probe so a future
restore cannot reintroduce it silently. **Do not treat BL-343's green test as coverage of this.**

## P1.4 — BL-353: telemetry is written and never read · **HIGH**

122 MB across 8 JSONL files, ~75k events, zero analysis. This is P1.0's absence seen from the other
side: the data exists, the *semantics and aggregation* do not. Ships with P1.0 or it will not ship.

## P1.5 — BL-358 + BL-319 remainder: queue wait time and vec-insert isolation · **HIGH / partial**

`WriteQueue.estimated_wait_ms` is a prediction reported as a measurement — it never computes actual
wait. BL-319 still lacks `vec_insert_duration_ms`, the field that separates SQL time from inference
time. Both are prerequisites for ever answering "is a slow apply the database or the model?"

## P2.3 — Storage-boundary completion · BL-380, BL-388, BL-389, BL-396, BL-397 · **MEDIUM**

The `sox/no-storage-backend-leak` rule (see *Standing architectural rule*) now enumerates this class
mechanically — these are the remaining known violations, and the rule keeps the list closed.

- **BL-380** `vector-store` ×3. **Blast radius measured 2026-08-01 and it is trivial**: two spec
  files import the package at value level, everything else is a type-only re-export, and
  `agent-source` — cited for a day as the reason not to touch it — is not a package in this repo.
  ⚠️ `index.ts:196`'s `vecEnabled: … || true` is dead code whose deletion turns 15 tests green while
  fixing nothing.
- **BL-389** `LanceDbVectorBackend` takes a raw `better-sqlite3` handle in its constructor.
- **BL-388** `tools/baseline-capture` ×2. **BL-397** `memory-flush` (prod + spec; both its lint and
  typecheck are red). **BL-396** `memory-server/src/index.ts` static ESM import from CJS.
- On completion, **remove the `warn`-only exemption for `libs/data/vectors/vector-store` from
  `eslint.config.js`** — it exists only to keep the repo-wide gate honest while these are open.

## P2.4 — Turso engine constraints and their consequences · **HIGH/MEDIUM**

Not bugs in our code — properties of the engine that our code must stop being surprised by.

- **BL-391** (HIGH) a read-only Turso connection **cannot run `fts_match`**, so federated recall's
  BM25 arm is dead. Compounded by `recallFromOpenDb`'s bare `catch { return [] }`, which makes a
  whole store vanish indistinguishably from "no matches". Undetermined and must not be guessed:
  whether `memoryRecall` catches internally (BM25 silently lost) or not (store contributes zero).
- **BL-329** (HIGH) a Turso FTS index permanently blocks every better-sqlite3 fallback path.
- **BL-361** Turso PANICS and aborts the process on an FTS index row with no backing directory.
- **BL-360** permanent `PRAGMA integrity_check` false positive — already filtered, keep it named so
  the filter is never mistaken for a bug.
- **BL-362** no committable Turso FTS damage fixture, so BL-347's negative control cannot be re-run.

## P2.5 — Concurrency and admission control · **HIGH**

- **BL-394** on Turso, `_noop = true` bypasses the size cap and deadline guard, **not just
  serialization**, while `memory_ping` reports `queue_max_size`, `deadline_budget_ms` and
  `deadline_guard_enabled` as if they were active. ⛔ **This is NOT a licence to serialize Turso
  writes** — four agents have now misread this area. Hoist admission control above the bypass;
  leave FIFO behind it.
- Unexplained, do not fold in: write-queue counters read 0 after real writes despite the bypass
  calling `_trackCompletion()`. If `memory_ping` reads a different instance, every number in that
  block is suspect.
- **BL-274** there is still no concurrency stress test for parallel read/write against the server —
  and none that exercises the Turso `_noop` path at all.

## P2.6 — Deploy and artifact integrity · **HIGH**

- **BL-390** `registry:sync-index` blesses an artifact built from an uncommitted tree that no commit
  reproduces. Happened **twice in 90 minutes** to two rule-following agents; the procedure is
  unsound under concurrency, not the agents.
- **BL-393** the proxy respawns the backend onto whatever bundle is staged. Observed once; the
  trigger is **narrower than first filed and still unidentified** — a controlled rebuild did not
  reproduce it (the process survived on the old unlinked inode). Identify the killer before fixing.
- **BL-375** `service enable` rebuilds unit env from the invoking shell, silently dropping tunables.

## P2.7 — Clustering · **HIGH** · *gated on research, not on effort*

Live state: **139 communities, ZERO members** (`total_clustered: 0`, `coverage: 0`) against 4,889
episodes. Every community-dependent feature is inert.

**BL-356 and BL-350 are unresolved design questions and must land first.** BL-356 says a fixed
global cosine threshold is *not calibratable* — single-linkage chaining makes correct τ a function
of corpus size. If that conclusion holds, **BL-326 and BL-328 change shape entirely**, so scheduling
them as ordinary tasks is a mistake.

Then: **BL-326** (incremental path is a dead stub — no ordinary write can ever cluster),
**BL-349** (must be a backgrounded post-write trigger), **BL-328** (τ mis-calibrated *upward*),
**BL-327** (communities orphaned by `memory_invalidate` are never GC'd).

## P2.8 — Data-quality defects with no home · **MEDIUM**

**BL-318** ghost episodes with `content: null`. **BL-317** nothing prevents a repeat of the
2026-06-26..29 mass topic-mislabelling. **BL-383** `autolink` writes the stoplist to a
`memory_scope.meta` column that does not exist on every backend. **BL-301** the two duplicated
`node`/`edge` schemas have already drifted. **BL-400** four spec files carry hand-maintained DDL
replicas — this already caused six false test failures and sent a wrong root cause across two
handoffs. **BL-392** vec-arm KNN ties have no cross-backend order. **BL-379** post-repair
reverification skips the WAL-identity probe. **BL-215** no operator surface for `healStaleVectors`.

## P2.9 — Process defects that cost real time · **HIGH/MEDIUM**

- **BL-225** status markers record intent, not verified outcome. **Both directions**: this session
  found 12 items marked Open that were already fixed, alongside the original four marked RESOLVED
  while broken. The rule needs to bite on closure *and* on staleness.
- **BL-359** BL ids are allocated by a read-then-write race — **six collisions on 2026-08-01**, one
  of them the team lead's, from computing the max off `BACKLOG.md` while an id lived only in
  `CHANGELOG.md`. Allocate from both files, or move allocation somewhere atomic.
- **BL-378** the two emergency brakes are not independent. **BL-312** the 2026-07-18 CPU/hang
  incident was never root-caused. **BL-376** one 180 s budget covers both a network download and a
  cached load. **BL-259** `smoke-test.mjs` leaves project-scoped launchd units bootstrapped.

## P3 / P4 — **DEFERRED** (2026-08-01)

**The sandbox harness and its runs are deferred, not cancelled.** The reason is this plan's own
criterion: *"a run before these measures a lie."* P0 is not clear — BL-348 (CRITICAL) and BL-342
are open — so a clean-slate ingestion run would produce a feature scorecard that certifies a
pipeline whose isolation and data-repair guarantees do not hold. The scorecard would be confidently
wrong, which is worse than absent.

Also deferred for a second, independent reason: the harness's *measurements* are only as good as the
instrumentation, and **P1.0 (BL-351) is unbuilt**. A run today would be measured by hand-rolled
throwaway probes — exactly what produced several wrong numbers on 2026-08-01 (three different suite
failure counts, four different drain rates).

**Resume when:** P0.4 (BL-348), P0.2/P0.8 (BL-342), and P1.0 (BL-351) are done. Nothing else blocks it.
`docs/reporting/memory/sandbox/README.md` stays as the specification; it is correct and should not be
rewritten, only unblocked.

## Explicitly OUT OF SCOPE for this plan

These are open, real, and belong to other subsystems. Listed so that "not in the plan" is a decision
rather than an oversight:

- **Dispatch-optimizer / plan hygiene** — BL-99, BL-103, BL-104, BL-105, BL-228, BL-258, BL-261, BL-296, BL-298
- **Packaging, native ABI, bundling** — BL-282, BL-284, BL-285, BL-288, BL-291, BL-292, BL-305, BL-306, BL-308, BL-314, BL-333, BL-355
- **Product surface** — BL-315 (`memory-server` has no REST API)
- **OS service integration** — BL-163 (SMAppService login-items registration; already BLOCKED on its own dependency)
- **Embedding-provider internals** — BL-283 (shared `RequestResponseChannel<T>` base for the ONNX/fastembed worker clients)

