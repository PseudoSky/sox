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
to name a backend.** *(Refined again 2026-08-01: `migration.ts` lives inside
`libs/data/store/store-adapter/**`, so the permitted set is that one directory — there is no second
exemption path to keep in sync.)*

> **ENFORCEMENT — this rule is now mechanical, not advisory (2026-08-01).** `sox/no-storage-backend-leak`
> (`tools/eslint-local/no-storage-backend-leak.cjs`) bans, outside that directory: `as SqliteAdapter` /
> `as TursoAdapter`, `.unwrap()`, `'sqlite'`/`'turso'` used as a discriminator, and raw
> `better-sqlite3`/`@tursodatabase/*` imports. Object-literal config (`{ type: 'sqlite' }`) is
> explicitly allowed — that is the "instantiation option" the directive carves out.
>
> **Legitimate engine-behaviour branches are a named, cited allowlist inside the rule**, keyed on
> *enclosing function + source text + occurrence count* — never line numbers. A line-numbered
> allowlist fails **open**: an edit above a blessed line slides the exemption onto whatever moved
> into that slot, waving through a real leak while the genuine exception starts erroring. The
> content key fails **closed** — change the code and the exemption stops applying, so a rewritten
> guard must be re-blessed deliberately.
>
> **The distinction the rule encodes, and which reviewers keep collapsing:** a *dialect leak* (what
> SQL to emit) is banned; an *engine-behaviour branch* (how the engine behaves — no local WAL on a
> remote store, Turso cannot DROP a `vec0` table) is legitimate. Conflating them makes the rule
> noise, and noise gets disabled. Migration legitimately converts between engines, so it must know both. A rule
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

> **TARGET ARCHITECTURE, MADE EXPLICIT 2026-08-01.** The thing to replace is a single process-wide
> mutex: `_bgSlot` / `_bgSlotHolder` in `memory-server/src/index.ts` (~:2312). Every background job
> acquires it, so the embed drain and the clustering pass are **mutually exclusive by construction**
> — and `drain-wake.spec.ts` asserts exactly that (*"the background slot is a mutex: the drain and
> the enrich tick never hold it at once"*).
>
> **BL-382 improved cadence, not isolation, and must not be mistaken for this item.** It split the
> drain out of the enrich tick and added a wake, which removed the ~145 s of clustering the drain
> was paying per pass. It deliberately **kept** the mutex, to preserve BL-346's anti-stampede
> property. So the owner's directive — *"the execution of clustering should never block an embedding
> from being written"* — is still unmet.
>
> The target is **separate execution contexts** (worker thread or child process) with an isolation
> boundary, such that a clustering failure cannot drop or delay an embedding, and neither waits on
> the other. Roughly half of BL-382's work is subsumed by doing this properly; the wake itself is
> still needed for cadence.
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

> **⚠️ SEQUENCING, REVISED 2026-08-01 — build P1.0 FIRST, before the rest of P0.**
> The original P0→P1→P2 ordering was correct in principle and was **inverted in practice** on
> 08-01, at measurable cost. With no shared measurement substrate, a full day of work was
> instrumented by hand-rolled throwaway probes, and the numbers were wrong repeatedly: three agents
> reported three different suite failure counts for the same suite (92 / 86 / ~19; actual **37**);
> the drain rate was quoted four times before being measured honestly; a live SQL error (BL-399)
> remains **undiagnosable** because `store.error` logs the driver's message but not the statement.
> BL-353's 122 MB of unread telemetry is the same gap from the other side.
>
> P1.0's design **already exists** — `docs/research/observability-substrate.md`, 76 KB, 41 sections,
> marked unblocked. It was never built. Everything downstream of it is cheaper *and more accurate*
> once it is, which is why it now precedes the remaining P0 items rather than following them.
> The exception is BL-348: it is CRITICAL and loses data, so it does not wait for instrumentation.

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

### PKT-45 — BL-401: finish BL-351 — consumer migration, status-surface wiring, live-spawn verification
**Goal:** PKT-02 published `@adhd/sox-telemetry`'s interface (correctly prioritised — five packets block on that contract) but stopped short of BL-351's stated acceptance. **The scope cut was caused by a budget error on my part, not by the work being larger than thought**: PKT-02 was given a 130k ceiling against a ~60k orientation cost. This packet is the remainder, filed honestly by that agent rather than papered over.
**Closes:** BL-401
**Files:** `libs/memory-core/src/telemetry.ts` (migrate off its own `RotatingJsonlWriter` — a near-duplicate of the new `DurableJsonlSink`; **delete, do not leave both**), the status-surface wiring in `memory-server/src/index.ts`, and at least one second consumer package.
**requires:** none
**sequencing:** PKT-02's published contract already exists — read the interface, not the research doc. **Serialize with the other `index.ts` packets** (PKT-01, 09, 13, 19, 25, 32, 34).
**tier:** sonnet, ~140k tokens / ~42 turns
**orientation:** ~51k unavoidable before any edit — 39k mandated docs (README+STATE+PLAN) + ~8k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~261k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number** — that is precisely what produced this packet. Commit incrementally by explicit path; if the fix sketch proves wrong, say so and stop. **You may sub-dispatch** once oriented, with PRE-DIGESTED context only.
> **⚠️ THE REAL HAZARD, from the agent that stopped rather than rush it — this is why the migration was not a drive-by.**
> `memory-core/src/telemetry.ts`'s crash-durability spec depends on a **per-call env re-read**. The
> new `DurableJsonlSink` deliberately does NOT do that: env resolution moved to the composition root
> per the research doc's dependency-shape design. **A naive swap therefore breaks BL-365's regression
> test** — the one proving 0 of 10,000 records survived `SIGKILL` before the fix. Decide the env
> contract *first* (either the sink re-reads, or the BL-365 test is re-expressed against the
> composition root), and say which you chose. Do not discover this by watching BL-365 go red.
>
> Also note `@opentelemetry/api` is a **declared but currently unused** dependency — the substrate
> emits its own records matching the documented wire format. Wiring the OTel SDK
> (`BasicTracerProvider`, `SpanProcessor`, pull-only `MeterReader`) is gap 4 of 5 and is optional to
> BL-351's acceptance; do not let it expand this packet.

**Produces:** BL-351 actually satisfied end-to-end: one JSONL sink (not two), spans from two different packages joining on one trace-id, and every emitted metric visible through the status surface on a **live-spawned** server — not only under test.
**acceptance:** a test naming BL-401 asserting two different packages emit spans that join on a single trace-id, and that `memory-core` no longer contains a second `RotatingJsonlWriter`. Then a live check against a spawned server, since "works under vitest" was never the claim BL-351 made.

### PKT-41 — BL-391: federated recall's BM25 arm is dead on Turso, and the failure is swallowed whole-store
**Goal:** a read-only Turso connection cannot run `fts_match` (measured: `readonly:false` → 1158 hits; `readonly:true` → `step failed: Error: Resource is read-only`; plain `COUNT(*)` works identically on both). `openDbReadOnly` passes `readonly: true` unconditionally and its **only** production caller is `getFederationConnection` (`recall.ts:1208`) — so single-store recall is unaffected (live recall still returns `provenance: ["vec","fts","temporal"]`) but federated recall is not.
**Closes:** BL-391
**Files:** `libs/memory-core/src/db.ts` (`openDbReadOnly`, ~:886), `libs/memory-core/src/recall.ts` (`getFederationConnection` ~:1208, `recallFromOpenDb` ~:1226-1237), + a new spec.
**requires:** none
**tier:** opus, ~70k tokens / ~25 turns — step 1 is an open determination; a prior probe crashed settling it
**orientation:** ~65k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~25k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~280k / ~75 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~490k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**Produces:** **first, a determination** — whether `memoryRecall` catches the FTS throw internally (BM25 silently lost for every Turso store) or not (every Turso store contributes zero results). Record it before editing; it decides both severity and fix. Then the fix, plus a logging change so `recallFromOpenDb`'s bare catch can never again make a whole store vanish silently.
**acceptance:** four steps, and step 1 is a determination that must be recorded before any edit.
1. **Determine, do not guess**, whether `memoryRecall` catches the FTS throw internally. The two outcomes differ enormously and both are silent: if it catches → federated recall silently loses BM25 for every Turso store and returns plausible vector+temporal results; if it does not → `recallFromOpenDb`'s bare `catch { return [] }` makes **every Turso store contribute zero results**, indistinguishable from "no matches". A prior probe crashed spawning the embed provider; use a seam or a direct unit test instead. **Record which it is before changing anything — it decides the severity and the fix.**
2. Then fix: stop opening federation connections read-only where that disables FTS (keep `query_only`, which is the actual write guard), or expose the constraint as an adapter capability so callers stop assuming read-only is free.
3. `recallFromOpenDb`'s bare catch MUST log. A whole store vanishing from a federated result is the same silent-failure family as BL-381, BL-384, BL-385 and BL-399 — each survived weeks for exactly this reason.
4. Red→green naming BL-391: a federated recall across a Turso store returns BM25-provenanced results; with the fix reverted, that store contributes nothing **and the log line proves it** (not merely an empty array).

### PKT-42 — BL-318 + BL-317: ghost episodes, and no guard against a repeat mass-mislabelling
**Goal:** BL-318 — the enrichment pipeline creates episodes with `content: null` / degenerate importance. BL-317 — nothing prevents a repeat of the 2026-06-26..29 mass topic-mislabelling; it is dormant, not fixed.
**Closes:** BL-318, BL-317
**Files:** `libs/memory-core/src/enrich.ts`, `libs/memory-core/src/write.ts`, + specs.
**requires:** none
**tier:** sonnet, ~35k tokens / ~14 turns
**orientation:** ~50k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~10k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~260k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** a test naming BL-318 asserting a write that would produce `content: null` is rejected or repaired at the boundary rather than persisted; a test naming BL-317 asserting the mislabelling shape is refused. Live cross-check: `memory_stats` currently reports `legacy_episodes: 2`, `stale_episodes: 2` — state whether these are the same rows.

### PKT-43 — BL-362: no committable Turso FTS damage fixture
**Goal:** BL-347's negative control exists only against the live store, so the single most expensive regression this migration produced cannot be re-tested in CI. Build a committable fixture that reproduces an `idx_fts_node` with an empty Tantivy directory.
**Closes:** BL-362
**Files:** `libs/data/store/store-adapter/src/__tests__/` fixtures + test.
**requires:** none
**tier:** sonnet, ~35k tokens / ~14 turns
**orientation:** ~40k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~0k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~250k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** the fixture makes `fts_index_live` report damaged, and the repair path returns it to healthy — both asserted, naming BL-362. ⚠️ Note BL-361: Turso **PANICS and aborts the process** on an FTS index row with no backing directory, so the fixture must produce empty-but-present, not absent, or it will kill the test runner.

### PKT-44 — BL-312: the 2026-07-18 CPU/hang incident was never root-caused
**Goal:** service was restored; cause was never found. 73%+ CPU with 50–90 s tool-call hangs. It is now plausible this was an instance of BL-345 (any in-process background job starves foreground reads) or BL-346's `enrich.tick.start` with no `.finish` — but that is a hypothesis, not a finding.
**Closes:** BL-312
**Files:** analysis only — `~/.adhd/sox-ecosystem/memory/logs/*.jsonl` and the item's cited evidence. No source change unless the cause is found.
**requires:** PKT-02
**sequencing:** — this is precisely the kind of question the telemetry substrate exists to answer, and attempting it with hand-rolled log parsing is what produced several wrong numbers on 08-01.
**tier:** sonnet, ~35k tokens / ~14 turns
**orientation:** ~40k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~0k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~250k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**Produces:** a root cause for the 2026-07-18 CPU/hang, **or** an explicit written finding that retained telemetry is insufficient to determine it. The second is an accepted terminal outcome — do not leave this open indefinitely pending a cause that the data cannot supply.
**acceptance:** either a root cause with evidence and a filed/linked defect, or an explicit written finding that the retained telemetry is insufficient to determine it — **which is a valid and useful outcome, and must be stated rather than left open indefinitely.**


## Explicitly OUT OF SCOPE for this plan

These are open, real, and belong to other subsystems. Listed so that "not in the plan" is a decision
rather than an oversight:

- **Dispatch-optimizer / plan hygiene** — BL-99, BL-103, BL-104, BL-105, BL-228, BL-258, BL-261, BL-296, BL-298
- **Packaging, native ABI, bundling** — BL-282, BL-284, BL-285, BL-288, BL-291, BL-292, BL-305, BL-306, BL-308, BL-314, BL-333, BL-355
- **Product surface** — BL-315 (`memory-server` has no REST API)
- **Bundler / CI packaging** — BL-307 (`@lancedb/lancedb` missing from the bundler externals policy), BL-309 (no CI gate that every native dep in a bundled extension is `--external`)

### Open, but deliberately NO packet

- **BL-225** — *status markers record intent, not verified outcome.* This is a **standing discipline, not a fixable task**, and it is already the acceptance standard for every packet above ("a watched red→green naming the BL id — never *tests pass*"). It stays open permanently by design. This session demonstrated it bites in **both** directions: four items were once marked RESOLVED while broken, and twelve were found marked Open while already fixed. Writing a packet for it would be a category error; leaving it unlisted would read as an oversight.
- **OS service integration** — BL-163 (SMAppService login-items registration; already BLOCKED on its own dependency)
- **Embedding-provider internals** — BL-283 (shared `RequestResponseChannel<T>` base for the ONNX/fastembed worker clients)


---


## Dispatch protocol — orientation is 27% of fleet spend, and most of it is avoidable

**Measured 2026-08-01, after every packet in the first dispatch immediately blew past its budget.**
The cause was not agent inefficiency. It was that each packet's prompt mandated reading
`README.md` + `STATE.md` + `PLAN.md` — **a 36k floor per packet, on all 44** — before a single line
of work. `PLAN.md` alone is 30k, and it nearly doubled in size on 2026-08-01 *because of this
reconciliation work*. The documentation effort directly inflated every agent's floor.

| | |
|---|---|
| fleet orientation, if every packet runs standalone | **~2,748k** |
| fleet work (post-4x) | ~7,180k |
| **orientation share** | **27%** |

Worst cases: **PKT-17 needs ~239k of orientation** — more than most packets' entire work budget.
`apps/sox/src/main.ts` is 100k and is read by 2 packets; `memory-server/src/index.ts` is 35k and is
read by **7**.

### Rule 1 — inline the packet, never mandate the plan. *(saves ~1,320k)*

**Do NOT write "read `PLAN.md` and `STATE.md`" into a dispatch prompt.** Paste the packet's own text
into the prompt and add only the specific facts it needs. An agent reading a 30k plan to find its
own 1k packet is paying 30x for retrieval. Name **line ranges**, not whole files, wherever the packet
already knows them.

### Rule 2 — batch packets that share a large file. *(saves ~468k)*

One oriented agent running several related packets pays the read once. The obvious batches:

- **`memory-server/src/index.ts` (35k, 7 packets)** — PKT-01, 09, 13, 19, 25, 32, 34. These are
  *already* mutually exclusive via `serialize_with`, so batching costs no parallelism it did not
  already lack. **Largest single win: ~210k.**
- **`store-adapter/src/integrity.ts` (16k, 6 packets)** — ~80k.
- **`apps/sox/src/main.ts` (100k, 2 packets)** — ~100k.
- **`cluster.ts` (4 packets)**, **`embed-pipeline.ts` (3)** — ~42k.

Serialising a hotspot file is not a loss: those packets could never have run concurrently anyway.

### Rule 3 — sub-dispatch downward, with pre-digested context

An agent that has paid orientation may spawn subagents for separable work, **but must hand over the
exact file, exact change, and exact assertion**. Telling a subagent to "read `PLAN.md`" re-pays the
whole cost and is the precise mistake made in the first dispatch.

### Rule 4 — budgets are guidance; the real failure is an uncommitted buffer

The first dispatch set hard ceilings *below the orientation cost* — PKT-01 was given 120k against a
93k orientation, leaving 27k for a CRITICAL architectural change. That is a trap, not a budget.
**Do not truncate work to hit a number.** Commit incrementally by explicit path; the failure being
guarded against is an agent cycled holding 27 files of uncommitted work, which is independent of
token count.

**Applying rules 1 and 2 removes ~1,788k of ~2,748k — about 65% of orientation, ~18% of total
fleet spend.**

# Task packets

> **ESTIMATION BASIS (revised 2026-08-01).** The first pass estimated from *today's observed
> per-item cost*, which was dominated by **discovery**: five root causes were confidently stated and
> wrong (BL-324 twice, BL-342, BL-381, BL-385's entire premise), each fix built throwaway
> instruments, and every claim was re-verified. **These packets encode that work** — root cause
> found, files named, fix sketch written, acceptance stated. Estimating implementation from
> discovery cost double-counts the expensive part.
>
> Two corrections, in opposite directions:
> - **Tiers came down.** Five packets were opus on *danger*, not difficulty — most clearly PKT-40,
>   which is "hoist two checks above an early return" and was tiered high because four agents
>   misread that area. Danger is handled by the ⛔ banner in the packet, not by the model.
> - **Volumes went up.** A packet is read → edit → spec → watch red → restore green →
>   lint/typecheck/test → backlog + changelog → commit. That is 12–16 turns and ~35–45k, not the
>   8–25k first stated. Floors applied: sonnet 35k, haiku 20k.
>
> **Contingency, running the other way:** the fix sketches are *hypotheses, not verified designs*.
> If ~20% discover their sketch is wrong mid-flight they revert to discovery cost. Carry **+25% on
> the sonnet tier** and expect **2–3 packets to escalate back to opus**. Which ones is not
> predictable — that is the nature of the bias.

> Built 2026-08-01, against the coverage reconciliation above (80 open, verified against `BACKLOG.md`
> headings, not the exclusion list — see method note at the bottom). **Two items were found
> uncovered by neither a plan section above nor the exclusion list and are fixed here rather than
> re-derived: BL-202 (added to exclusions below) and BL-398 (packet PKT-33).** BL-387/BL-399 were
> named only in passing text above; they get real packets here (PKT-32, PKT-34).
>
> **Re-sequenced from the P0/P1/P2/P3/P4 numbering above** for dependency correctness and maximum
> parallel width, per the two hard constraints: **PKT-02 (BL-351) is built first** among the
> substantive work, and **PKT-01 (BL-348, CRITICAL) does not wait for it** — both are Wave A.
>
> **Model tier is sized to judgement required, not item size.** A packet is `opus` if it requires
> cross-file design judgement, an uncertain root cause needing investigation, or correctness
> reasoning about concurrency/isolation. It is `sonnet` if the fix shape is already fully specified
> (most of the backlog, because these items were filed with a "Fix sketch" and an "Acceptance"
> already written). It is `haiku` ONLY for single-file, mechanical, fully-specified changes — three
> packets qualify. Today's fleet gave haiku judgement work and 4 of 6 produced nothing; that mistake
> is not repeated here.

## How to read a packet

Each states: **id**, **goal**, **closes** (BL ids), **files** (exact set touched), **depends_on**
(other packet ids — none means startable immediately), **tier** + rough token budget, **acceptance**
(the specific red→green per BL-225 — never "tests pass").

## ⚠️ File-contention hotspot — read before parallelizing

`extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts` is touched by **eight**
packets below (PKT-01, PKT-13, PKT-19, PKT-24, PKT-26, PKT-27, PKT-32, PKT-34). It is a single
~2400-line file. Disjoint *sections* of it are not disjoint enough to dispatch blind — two agents
editing different functions in the same file will still collide on imports, shared constants, and
diff context. **Treat every pair of packets that both list this file as serial, in the order given
by their wave**, even though nothing here calls `nx build` on it. `libs/memory-core/src/cluster.ts`
has the same shape across PKT-01, PKT-30, PKT-31, PKT-35 (clustering wave). Where a wave lists
multiple packets touching one of these two files, the wave's own text says so explicitly and gives
the required order.

**No packet below runs `nx build` on a shipped extension.** Several land in `libs/memory-core` or
`libs/data/*`, which `memory-server`'s bundle depends on — per the standing safety rule, **do not
build memory-server, memory-cli, memory-flush, tokenguard, or sox** while any Wave A/B/C packet is
in flight; that is a repo-global operation and must be serialized against all of them by the human
or lead orchestrating dispatch, not by an agent's own judgement mid-task. Live artifact is
`5e8e1fcc8625`, pid 18521 — every packet must leave it unchanged; verify by `memory_ping` on
completion, don't just assume no build ran.

---

## Wave A — start immediately, no dependencies (max parallel width: 13)

### PKT-01 — BL-348: committed-stage boundary so clustering/enrichment can never block or lose an embedding
**Goal:** split the write path so vector persist is a committed stage; downstream enrichment/clustering runs off a durable queue, isolated, never inline, never able to roll back a written vector.
**Closes:** BL-348 (CRITICAL)
**Files:** `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts` (`_bgSlot`/`_bgSlotHolder` mutex removal, ~:2312), `libs/memory-core/src/embed-pipeline.ts`, `libs/memory-core/src/curate.ts` (`organizer_queue` consumer), `libs/memory-core/src/cluster.ts` (entry point only — do not touch threshold logic, that's Wave D).
**requires:** none
**sequencing:** **Does not wait on PKT-02** per the owner's explicit exception — it is CRITICAL and loses data today.
**tier:** opus, ~80k tokens / ~30 turns — target named (separate execution contexts) but BL-154 re-entrancy makes it genuinely delicate
**orientation:** ~96k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~56k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~320k / ~90 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~580k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**Produces:** a committed-stage boundary with **separate execution contexts** for embedding vs enrichment/clustering, replacing the process-wide `_bgSlot` mutex. Consumed by PKT-29, which schedules clustering behind it. Output must state explicitly whether `_bgSlot` is deleted or retained for a narrower purpose — PKT-29 needs to know which.
**acceptance:** two tests, both named for BL-348: (1) write an episode with a clustering/enrichment stage forced to throw; assert the embedding is still durably present in `vec_node` after the failure — must fail today. (2) a deliberately slow enrichment stage does not increase `write_to_vector_ms` for concurrent writes — proves the blocking boundary is real, not nominal.
**Note:** BL-349 (PKT-30) and BL-326 build on the isolation boundary this lands — do not start those until this merges.

### PKT-02 — BL-351: shared tracing/metrics substrate (build first — everything in Waves B/E consumes it)
**Goal:** implement the researched OTel-facade + JSONL-sink design from `docs/research/observability-substrate.md` as a shared package every sox data package depends on: structured logging, function/stage spans on a propagated trace-id, counters/gauges/histograms, wait-vs-work as a first-class primitive, uniform export into the status surface.
**Closes:** BL-351 (HIGH)
**Files:** new package (per the research doc's recommendation — likely `libs/observability/tracing-core` or similar; the doc names the exact target), `libs/memory-core/src/telemetry.ts` (migrate off, don't duplicate), env-policy wiring (`libs/*/src/env-policy.ts`, now single-sourced per BL-344 — confirm before editing, do not reintroduce a 2nd copy).
**requires:** none
**tier:** opus, ~85k tokens / ~35 turns — high turn count, low reasoning-per-turn — the 76KB design already exists; this is implementation of a written spec
**orientation:** ~46k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~6k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~340k / ~105 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~560k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**Produces:** the tracing/metrics substrate as a consumable package surface: a span/metric emitter with **stable event names and units**, a durable sink, and a documented API that PKT-24/25/26/27/44 import instead of hand-rolling. **This is the interface contract for five downstream packets — publish it (names, units, cardinality limits) before they start, or they will each invent their own and the substrate will have failed at its one job.** Design is already written: `docs/research/observability-substrate.md`.
**acceptance:** a test naming BL-351 that writes a span through the new package from two different consumer packages (e.g. `memory-core` and `store-adapter`) and asserts both appear correctly attributed on a shared trace-id in the exported status surface — proving it is a shared substrate, not per-consumer.

### PKT-03 — BL-342/BL-343 residual: repair the live malformed `enrich_ver=''` row + migration guard
**Goal:** BL-343 made `memory_stats` survive the shape (tested); the actual bad data was never repaired. Ship a migration that finds `enrich_ver = ''` (invalid JSON) and repairs it, plus a probe so restore can't reintroduce it silently.
**Closes:** BL-342, BL-387's P0.8 duplicate note (do not treat BL-343's green test as coverage — this packet is the repair BL-343 didn't do)
**Files:** `libs/memory-core/src/stats.ts`, `libs/data/store/store-adapter/src/integrity.ts` (new probe), new migration file (find existing migration mechanism location — likely `libs/data/store/store-adapter/src/migration.ts`).
**requires:** none
**tier:** sonnet, ~35k tokens / ~14 turns
**orientation:** ~64k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~24k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~280k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** against a copy of the live store (rowid 9284 shape), run the migration, assert `memory_stats` no longer reports `malformed_rows`, and a fresh probe test named for BL-342 fails on an unrepaired fixture and passes after.

### PKT-04 — BL-380 + BL-364: unchecked `unwrap()` casts in `vector-store`, and the crash they cause
**Goal:** replace the six unchecked `(adapter as SqliteAdapter).unwrap()` casts in `vector-store/src/index.ts` with capability-gated or StoreAdapter-native calls; this is the strong candidate root cause for BL-364's 15 red `hybrid-search` tests — verify and fix together, one root cause.
**Closes:** BL-380 (vector-store portion only, not memory-cli — see PKT-05), BL-364
**Files:** `libs/data/vectors/vector-store/src/index.ts` (lines 143, 200, 359, and the dead `|| true` at :196 — delete it, it turns 15 tests green while fixing nothing per the measured blast radius), `libs/data/vectors/vector-store/hybrid-search.spec.ts` (helper only, not the assertions).
**requires:** none
**sequencing:** Blast radius already measured as trivial (2026-08-01): two spec files at value level, everything else type-only, `agent-source` is not a package in this repo.
**tier:** sonnet, ~35k tokens / ~14 turns
**orientation:** ~44k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~4k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~260k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** `npx nx test hybrid-search` at 82/82 with the 15 previously-red integration tests actually executing (not skipped) — name BL-364 in the test names already present.

### PKT-05 — BL-380 (memory-cli portion): `as any` casts through the storage boundary
**Goal:** the three `(adapter as any).unwrap()` sites in `memory-cli` — worse than PKT-04's shape because the cast is through `any`, so the compiler catches nothing.
**Closes:** BL-380 (remainder)
**Files:** `extensions/bundles/sox-memory-bundle/members/memory-cli/src/index.ts` (lines 180, 218, 322).
**requires:** none
**sequencing:** Disjoint from PKT-04 (different package).
**tier:** sonnet, ~35k tokens / ~14 turns
**orientation:** ~45k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~5k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~260k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** a test naming BL-380 that runs each affected `memory-cli` command against a Turso-backed store (not the sqlite default) and asserts no raw-handle type error.

### PKT-06 — BL-388: `tools/baseline-capture` same-shape casts
**Closes:** BL-388
**Files:** `tools/baseline-capture/src/capture-enrichment-baseline.ts:109`, `tools/baseline-capture/src/capture-write-perf-baseline.ts:165`.
**requires:** none
**tier:** sonnet, ~35k tokens / ~14 turns
**orientation:** ~44k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~4k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~260k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** run each entry point with no `STORE_ADAPTER` set (default Turso) and assert it completes without a raw-handle type error — must fail today, name BL-388.

### PKT-07 — BL-389: `LanceDbVectorBackend` constructor typed against raw `better-sqlite3`
**Closes:** BL-389
**Files:** `libs/data/vectors/vector-store/src/lancedb.ts`.
**requires:** none
**sequencing:** Same package as PKT-04 but a different file (`lancedb.ts` vs `index.ts`) — genuinely disjoint, no shared symbols.
**tier:** sonnet, ~35k tokens / ~14 turns
**orientation:** ~41k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~1k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~260k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** a test naming BL-389 constructing `LanceDbVectorBackend` from a `StoreAdapter` (not a raw handle) and exercising one query end to end.

### PKT-08 — BL-397: `memory-flush` reaches around StoreAdapter in prod and test
**Closes:** BL-397
**Files:** `extensions/bundles/sox-memory-bundle/members/memory-flush/src/index.ts:20`, `.../memory-flush/src/index.spec.ts:55-60`.
**requires:** none
**tier:** sonnet, ~35k tokens / ~14 turns
**orientation:** ~43k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~3k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~260k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** `nx lint memory-flush` and `nx typecheck memory-flush` both green (currently both red — this is the acceptance already, per the item's own two named failures).

### PKT-09 — BL-396: static ESM import from CJS in `memory-server/src/index.ts`
**Closes:** BL-396
**Files:** `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts` (lines 86, 97 only — the two named TS1541/TS1479 sites; convert to the dynamic-import pattern `dialect.ts` already documents and follows).
**requires:** none
**sequencing:** — land this one FIRST since it's the smallest and most mechanical, so nobody else has to rebase around it.
**tier:** haiku, ~20k tokens / ~8 turns
**orientation:** ~75k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~35k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~80k / ~24 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~200k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** root `npx tsc --noEmit` (the whole-repo `sox-ecosystem:typecheck`) reports zero errors in `index.ts` — currently reports exactly TS1541 + TS1479 at the named lines.

### PKT-10 — BL-383: `autolink` writes to a `memory_scope.meta` column that exists on no backend
**Closes:** BL-383
**Files:** `libs/memory-core/src/autolink.ts` (lines 58-67 — either add the column via a real migration, or stop persisting the stoplist there and pick a column that exists; the swallowed `catch {}` must go regardless).
**requires:** none
**tier:** sonnet, ~35k tokens / ~14 turns
**orientation:** ~41k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~1k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~260k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** a test naming BL-383 that runs `autolink` against a Turso store and asserts no `store.error` is logged for `memory_scope` — currently fires twice per 20-minute window on the live store.

### PKT-11 — BL-400: four spec files' hand-maintained schema replicas
**Closes:** BL-400
**Files:** `libs/data/graph/graph-store/src/index.ts` (export a `createSchema(adapter)` helper — no behavior change, just export what already exists), `libs/memory-core/src/{backup,cluster-subset,enrich,write}.spec.ts` (replace each hand-written DDL with a call to the exported helper).
**requires:** none
**tier:** sonnet, ~35k tokens / ~14 turns
**orientation:** ~51k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~11k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~270k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** a test naming BL-400 asserting each of the four specs' fixture schema is byte-identical to `graph-store`'s real DDL (trivially true once they call the same helper); all four spec files still pass their existing assertions unchanged.

### PKT-12 — BL-301 + BL-302: unify the drifted `node`/`edge` schema, and build the migration runner that makes it shippable to the live store
**Goal:** BL-301's drift (columns, `confidence` type, `edge.rel` CHECK) can only be fixed on a store with existing rows via a real migration — which does not exist (BL-302: `targetVersion` hard-coded to 1, no `migrations[]`, SQLite can't `ALTER` a CHECK in place). These are one piece of work: build the migration runner, then use it to unify the schema.
**Closes:** BL-301, BL-302
**Files:** `libs/data/graph/graph-store/src/index.ts` (`applySchema`, `GRAPH_DDL`), `libs/memory-core/src/schema.ts`, new migration runner module (table-rebuild helper: `PRAGMA foreign_keys=OFF; CREATE TABLE new; INSERT...SELECT; DROP; RENAME; recreate indexes; foreign_keys=ON`, transactional).
**requires:** none
**sequencing:** — schedule early since PKT-11 exports from the same file (`graph-store/src/index.ts`) and should land first (smaller, no schema shape change) to avoid a rebase.
**tier:** opus, ~65k tokens / ~25 turns — a migration mechanism genuinely does not exist yet
**orientation:** ~51k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~11k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~260k / ~75 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~450k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** two tests. BL-302, must name it: create a v1 DB with a row, register a v2 migration that alters a CHECK via table-rebuild, reopen, assert the pre-existing row survived AND a formerly-illegal value now inserts; a negative control against the current stub must fail. BL-301, must name it: `createGraphBackend(memoryCoreDb).writeEdge(..., rel:'DEPENDS_ON')` throws today, passes after unification; `PRAGMA table_info(node)` identical across both packages' freshly-applied schemas post-fix.

### PKT-13 — BL-378: emergency brakes are not independent
**Goal:** `SOX_DISABLE_PERIODIC_ENRICH=1` silently makes `SOX_DISABLE_EMBED_HEAL` a no-op because `healMissingVectors`'s only caller is nested under the enrich tick. Decouple: give heal its own trigger path, or make the nesting explicit in status (BL-334) so the dead-brake state is visible.
**Closes:** BL-378
**Files:** `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts` (the `scheduleNextEnrichTick` → `runPeriodicEnrichPassGuarded` → `runEnrichPassOnDb` → `healMissingVectors` chain, ~:2086-2265).
**requires:** none
**serialize_with:** PKT-09, PKT-01, PKT-30, PKT-32, PKT-34 — MUTUAL EXCLUSION on `memory-server/src/index.ts`, not a dependency. This packet needs no other packet's output and may start in wave 1; it must simply never edit that file concurrently with those. Run after PKT-09, before the rest. Check current state before editing — live hotspot.
**tier:** sonnet, ~35k tokens / ~14 turns
**orientation:** ~75k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~35k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~290k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** a test naming BL-378 asserting that with `SOX_DISABLE_PERIODIC_ENRICH=1` set and `SOX_DISABLE_EMBED_HEAL` unset, embed healing still runs — must fail today (measured live: 0 vector growth over 90s under exactly this combination).

### PKT-14 — BL-376: one warmup timeout budget covers a cold download and a cached load
**Closes:** BL-376
**Files:** `libs/data/embed/embedding-provider/src/index.ts` (`warmupTimeoutMs`, lines 261-264, and its two callers).
**requires:** none
**tier:** sonnet, ~35k tokens / ~14 turns
**orientation:** ~42k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~2k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~260k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** a test naming BL-376 asserting a cache-hit warmup fails fast (single-digit-second budget) on an injected 15s+ delay, while a cache-miss warmup still tolerates the existing 180s budget — proving the two are actually split, not just renamed.

### PKT-15 — BL-259: `smoke-test.mjs` leaves launchd units bootstrapped, breaking the next run
**Closes:** BL-259
**Files:** `scripts/smoke-test.mjs`.
**requires:** none
**tier:** sonnet, ~35k tokens / ~14 turns
**orientation:** ~45k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~5k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~260k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** run the smoke suite twice back to back (no manual `bootout` between runs); both runs report the same pass count — currently the second run fails `*-project-enable` with `Bootstrap failed: 5`.

### PKT-16 — BL-274: no concurrency stress test for parallel read/write through the proxy
**Closes:** BL-274
**Files:** new `tools/stress/proxy-concurrency.mjs`.
**requires:** none
**sequencing:** (Independent of BL-394/PKT-24 — this packet may incidentally reproduce BL-394's admission-control bypass, which is fine; do not fix it here, file confirmation as a comment on BL-394 and let PKT-24 fix it.)
**tier:** sonnet, ~35k tokens / ~14 turns
**orientation:** ~40k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~0k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~250k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**Produces:** a concurrency stress harness exercising parallel read/write against a **Turso-backed** server, including the `_noop` bypass path that no existing test covers. Consumed by PKT-40, which may reuse its reproduction rather than build one.
**acceptance:** interleaved `memory_write` + `memory_recall` over UDS through the live proxy, assert no timeouts, no busy errors that shouldn't happen, read-your-writes holds under concurrency.

### PKT-17 — BL-359: BL-id allocation race + pre-commit guard
**Closes:** BL-359
**Files:** new `tools/allocate-bl-id.mjs` (reads max across both `BACKLOG.md` and `CHANGELOG.md`, atomically reserves via a placeholder heading in one write), pre-commit hook wiring (check existing hook location — likely `.git/hooks/pre-commit` or a package.json `husky`/`simple-git-hooks` entry — confirm before adding).
**requires:** none
**tier:** sonnet, ~35k tokens / ~14 turns
**orientation:** ~239k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~199k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~450k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** a pre-commit hook test naming BL-359 that stages a commit introducing a duplicate `### BL-<n>` heading and asserts the commit is rejected; a second commit with a unique id succeeds.

### PKT-18 — BL-215: operator surface for `healStaleVectors`
**Closes:** BL-215
**Files:** `libs/memory-core/src/curate.ts` (new `memory_curate` op `reheal_stale`), `extensions/bundles/sox-memory-bundle/members/memory-cli/src/index.ts` (optional `soxe memory reembed` loop — do only if the curate op alone doesn't satisfy the acceptance cleanly).
**requires:** none
**tier:** sonnet, ~35k tokens / ~14 turns
**orientation:** ~49k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~9k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~260k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** `memory_curate({op:'reheal_stale'})` runs one bounded pass against a store with model-swap-stale vectors and reports `{scanned, healed, remaining}` — never tick-wired, must be explicit per the item.

### PKT-19 — BL-329: better-sqlite3 open on a Turso-native store must fail loudly, not with an opaque schema-parse error
**Closes:** BL-329
**Files:** `libs/memory-core/src/db.ts` (guard at the better-sqlite3 open path — around `_openDbInner`, :646, and the two other fallback sites named in the item: :198, :259).
**requires:** none
**sequencing:** **Serialize after PKT-09/PKT-13 on `index.ts`** — wait, this touches `db.ts` not `index.ts`, genuinely disjoint from the index.ts cluster; no serialization needed against those.
**tier:** sonnet, ~35k tokens / ~14 turns
**orientation:** ~51k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~11k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~270k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** a test naming BL-329: create a Turso store with `idx_fts_node`, attempt a better-sqlite3 open, assert a clear diagnostic error (not `malformed database schema`).

### PKT-20 — BL-360: Turso `integrity_check` false-positive — report upstream, pin driver version
**Closes:** BL-360
**Files:** `libs/data/store/store-adapter/src/integrity.ts` (pin the driver version the existing `isKnownFalsePositive()` suppression is valid for), no upstream-report file needed in-repo but note the report was filed (external — do via WebSearch/issue tracker as part of this packet, not a separate step).
**requires:** none
**tier:** haiku, ~20k tokens / ~8 turns
**orientation:** ~56k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~16k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~80k / ~24 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~180k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** the existing guard test (already documented as failing if Turso stops emitting the message) stays green; a version pin constant is added and asserted against the installed `@tursodatabase/database` version at test time.

### PKT-21 — BL-361: Turso panics and kills the process on a malformed FTS index row — needs an out-of-process pre-flight
**Closes:** BL-361
**Files:** new pre-flight module (likely in `libs/data/store/store-adapter/src/`) that runs a cheap out-of-process schema sanity check before the first `connect()` on a store flagged unclean; wire into `openDb`'s Turso branch.
**requires:** none
**tier:** sonnet, ~40k tokens / ~14 turns — DEMOTED from opus: validate-before-open guard; failure mode fully characterised
**orientation:** ~40k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~0k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~160k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~280k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** a test naming BL-361: reproduce the panic-inducing store state (reinstate an `idx_fts_node` `sqlite_master` row without its directory table via `writable_schema`), assert the store either opens with a catchable error or is repaired by the pre-flight before `connect()` — must crash the test process today without the fix (run in a child process so the harness itself survives the panic).

### PKT-22 — BL-392: vec-arm KNN distance metric never declared on sqlite
**Closes:** BL-392
**Files:** `libs/data/store/store-adapter/src/{sqlite-vec-dialect,fts-dialect}.ts` — specifically `SqliteVecDialect.createTableDDL` (add `distance_metric=cosine` to the `vec0` DDL) and the `topKQuery` metric parameter (stop silently ignoring `metric='cosine'`).
**requires:** none
**tier:** haiku, ~20k tokens / ~8 turns
**orientation:** ~40k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~0k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~80k / ~24 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~160k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** a test naming BL-392 asserting `SqliteVecDialect.createTableDDL` output contains `distance_metric=cosine`, and that `topKQuery` with `metric='cosine'` actually changes the computed distance (not just sort direction) versus the current default.

### PKT-23 — BL-379: post-repair reverification silently skips the WAL-identity probe
**Closes:** BL-379
**Files:** `libs/data/store/store-adapter/src/integrity.ts` (`repairStoreIntegrity`'s reverify call — forward `walBaseline` through `RepairOptions`, or have `verifyStoreIntegrity` emit an explicit `unknown` finding when a probe can't run).
**requires:** none
**tier:** haiku, ~20k tokens / ~8 turns
**orientation:** ~56k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~16k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~80k / ~24 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~180k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** a test naming BL-379: unlink the WAL between the damage and the repair, assert the post-repair report contains a `wal_identity` finding (not silent omission) — must fail today.

---

## Wave B — depends on PKT-02 (BL-351 substrate)

> These are BL-351's first real consumers, per the plan's own note that building them first would
> produce exactly the per-consumer conventions BL-351 exists to prevent. **Do not start any of these
> before PKT-02 merges.**

### PKT-24 — BL-358 + P1.1 remainder (BL-319): wait-vs-work stamping in `WriteQueue`, plus `vec_insert_duration_ms`
**Goal:** stamp enqueue time on every `WriteQueue` item, record `wait_ms` alongside existing work latency as a paired emission (per BL-351 §5.2), report both plus estimator error through the status surface. Add `vec_insert_duration_ms` — the vec_node INSERT time isolated from embed time.
**Closes:** BL-358, BL-319 (remainder — `embed_throughput_per_sec` and `time_to_vector_ms` already shipped, do not redo)
**Files:** `libs/memory-core/src/write-queue.ts` (enqueue timestamp, paired wait/work emission — **do not** replace `LatencyRing` with an OTel histogram for the admission-control estimator, it needs the rolling-window `recentMean`, not a cumulative histogram), `libs/memory-core/src/embed-pipeline.ts` (vec_insert isolation), `libs/memory-core/src/latency-stats.ts`.
**requires:** PKT-02
**tier:** sonnet, ~35k tokens / ~14 turns
**orientation:** ~58k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~18k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~270k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**Produces:** wait-vs-work stamping in the write queue: real queue wait time (replacing `estimated_wait_ms`, a prediction reported as a measurement) plus `vec_insert_duration_ms`. Read by PKT-26 for contention accounting — **PKT-26 reads, does not write, these primitives**, so the field names are the contract.
**acceptance:** BL-358, must name it: enqueue N tasks against a queue with a deliberately slow head-of-line task, assert `write_queue.wait_ms` for trailing tasks is non-zero and >> their `work_ms` — must fail today (no such field exists); second assertion, idle queue → `wait_ms ≈ 0` while `work_ms > 0`. BL-319 remainder: `vec_insert_duration_ms` populated and measurably smaller than total embed+insert time on a real write.

### PKT-25 — P1.2 remainder (BL-334): capability flags, EP health, contention facts
**Goal:** the integrity half of BL-334 already shipped. Ship the rest: which ONNX execution provider is active + measured throughput, graph partitioning (`partitioned: true` + fallback ops), contending-process detection (named pids), ambient-load sampling alongside latency metrics, multiprocess-WAL capability flag, write-concurrency capability + measured figure.
**Closes:** BL-334 (remainder)
**Files:** `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts` (`memory_ping`/`memory_stats` response shape), `libs/data/embed/embedding-provider/src/*` (EP health, partition detection), `libs/data/store/store-adapter/src/turso-adapter.ts` (capability flags — read-only, these already exist as internal state per BL-322's note that `multiprocess_wal` is on by default; surface them).
**requires:** PKT-02
**sequencing:** **Serialize on `index.ts` after PKT-09/PKT-13/PKT-18(if it touches index.ts)/PKT-01** — this is deep in the hotspot file; land last among the Wave A/B index.ts packets.
**tier:** sonnet, ~45k tokens / ~16 turns — DEMOTED from opus: surfacing fields once PKT-02 exists
**orientation:** ~80k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~40k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~180k / ~48 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~350k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**Produces:** the remaining `memory_ping`/`memory_stats` fields: capability flags, execution-provider health, contention facts. Consumed by PKT-34 (integrity/coverage probe reads the same response shape). Output must state the final response schema so PKT-34 does not restructure it a second time.
**acceptance:** a test naming BL-334 asserting `memory_ping` reports (at minimum) `active_execution_provider`, `partitioned: boolean`, `contending_pids: []`, `ambient_load` alongside a real latency metric, `multiprocess_wal_enabled: boolean`, `write_concurrency_supported: boolean` — all populated from live measurement, none hardcoded.

### PKT-26 — P1.3 (BL-322 + BL-345): contention accounting via wait-vs-work + event-loop-lag sampling
**Goal:** turn BL-345's observation ("any in-process background job starves foreground reads") into a measurement — the instrument Theme 2's resource governance design has been blocked on.
**Closes:** BL-322, BL-345
**Files:** `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts` (background job scheduler — the enrich tick loop), `libs/memory-core/src/embed-pipeline.ts`.
**requires:** PKT-02
**sequencing:** , and reads (not writes) the wait-vs-work primitive PKT-24 lands — **safe to run in parallel with PKT-24** since PKT-24 touches `write-queue.ts`/`embed-pipeline.ts`(vec_insert only)/`latency-stats.ts` and this touches `index.ts`(scheduler)/`embed-pipeline.ts`(tick, disjoint section) — but coordinate the `embed-pipeline.ts` edit, both packets touch it. **Serialize PKT-24 before PKT-26 on that one file.**
**tier:** sonnet, ~40k tokens / ~14 turns — DEMOTED from opus: accounting on primitives PKT-24 provides
**orientation:** ~84k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~44k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~160k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~330k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** a test naming BL-345: with `SOX_DISABLE_EMBED_HEAL=1` set and the periodic enrichment tick running against a realistic backlog, assert `memory_ping`/`memory_topics` remain responsive (single-digit seconds) throughout a full tick — must fail today.

### PKT-27 — P1.4 (BL-353): telemetry is written and never read — build the analysis tooling
**Goal:** 122 MB / ~75k events across 8 JSONL files with zero aggregation tooling. Ship the semantics + aggregation layer, not just a parser — this is the gap BL-351 leaves from the reading side.
**Closes:** BL-353
**Files:** new `tools/telemetry-analyze/` (start/finish accounting per operation, the queue-wait/compute-time separation BL-353's own driver already demonstrates by hand), `docs/observability/README.md` (extend, don't rewrite — it already documents the format).
**requires:** PKT-02, PKT-02
**tier:** sonnet, ~35k tokens / ~14 turns
**orientation:** ~44k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~4k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~260k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** a test naming BL-353 running the analysis tool against a fixture JSONL with a known start/finish/error distribution and asserting the reported "unaccounted" count matches the fixture's deliberately-planted hang.

---

## Wave C — clustering, gated on research (BL-356/BL-350) before implementation

> Per the owner's directive: **BL-356 and BL-350 must land first.** If a fixed global τ is not
> calibratable (BL-356's measurement already says it isn't), BL-326/BL-328 change shape entirely.
> Scheduling BL-326/328/349 as ordinary implementation tasks before this research completes is the
> mistake the team lead's brief explicitly warned against.

### PKT-28 — RESEARCH: BL-356 + BL-350 — corpus-size-adaptive clustering strategy
**Goal:** BL-356 has already measured that a fixed τ is not calibratable (mean degree grows linearly with N under single-linkage chaining — 0.085 → 0.684 largest-cluster ratio as N goes 200→1616 at τ=0.82). BL-350 asks for the maintenance strategy (split/merge/drift/orphan) this implies. Produce ONE recommendation covering both: either a corpus-size-adaptive τ function, a different algorithm (not single-linkage — e.g. raise `minPts`), or a periodic-reconciliation hybrid — with a measurable drift metric and a maintenance cadence/trigger.
**Closes:** BL-356, BL-350
**Files:** none (research item — output is a written recommendation, per the item's own acceptance; may include a small standalone measurement script under `~/.adhd/sox-ecosystem/memory/` per the existing `bl328-*.mjs` convention, not committed to the repo).
**requires:** none
**sequencing:** **Blocks PKT-29 and PKT-31.**
**tier:** opus, ~90k tokens / ~30 turns — real research: tau must be MEASURED across >=2 corpus sizes, not chosen
**orientation:** ~40k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~0k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~360k / ~90 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~580k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**Produces:** **a written decision, not code**: whether a fixed global cosine τ is viable at all, and if not, the replacement strategy (corpus-size-adaptive τ, a different linkage, or bounded cluster size). Must state a recommendation *and* its measurement basis across ≥2 corpus sizes. PKT-29/PKT-30/PKT-31 are blocked on this artifact; **if the answer is 'fixed τ is not viable', PKT-30 (re-calibrate the threshold) becomes invalid and must be re-scoped rather than executed.**
**acceptance:** BL-350's own bar: a written recommendation with a measurable drift metric (incremental-vs-full-pass divergence, computable on a real corpus) and a maintenance trigger. BL-356 is satisfied by the recommendation resolving what a "calibrated" τ (or its replacement) means at production scale — no code acceptance, this is a decision record.

### PKT-29 — BL-349 + BL-326: write-triggered background clustering (implementation)
**Goal:** implement the chosen strategy from PKT-28 as an enqueued, idempotent, coalescing post-write trigger, failure-isolated from the embedding commit. Resolves BL-326's dead stub by construction (the incremental path becomes reachable).
**Closes:** BL-349, BL-326
**Files:** `libs/memory-core/src/cluster.ts` (the dead-stub short-circuit at :437-441), `libs/memory-core/src/curate.ts` (`organizer_queue` trigger wiring), `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts` (write-path trigger point — must build on the PKT-01 committed-stage boundary).
**requires:** PKT-01, PKT-28
**sequencing:** — the near-term mechanism must not contradict it). **Serialize on `cluster.ts` after PKT-01, before PKT-30/PKT-33.**
**tier:** opus, ~55k tokens / ~20 turns — re-scoped: after PKT-28 this is implementation, not design
**orientation:** ~87k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~47k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~220k / ~60 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~420k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**Produces:** write-triggered background clustering that runs behind PKT-01's boundary. Consumed by PKT-30 (threshold work lands on the same function area). Output must name the trigger point and the backpressure rule.
**acceptance:** BL-326/BL-349's shared bar, must name both: write N clusterable episodes through the ordinary write/enrich path only (no explicit recluster row, no manual pass), assert `total_clustered > 0` — must fail today. Additionally assert the write's `write_to_vector_ms` is unaffected by clustering work, and a thrown clustering error leaves vectors intact (this half restates PKT-01's second acceptance in the clustering-specific path — do not skip re-proving it here, the boundary must hold for the real trigger, not just the isolated test harness).

### PKT-30 — BL-328: implement PKT-28's calibration function (NOT "pick a corrected constant" — see below)
**⚠️ RE-SCOPED by PKT-28 (2026-08-01), per its own explicit instruction.** PKT-28's answer is
"a fixed τ is not viable at all" (confirmed at the true full corpus, 4867 vectors: 0.85 has now
crossed into degenerate too). The recommended replacement is **target-mean-degree calibration
computed at cluster time**, not a corrected constant — so `resolveDefaultThreshold()` changes from
a nullary function to one taking sampled data + target N. Read
`docs/reporting/memory/findings/pkt28-clustering-strategy.md` §2 and §5 before starting; this
packet's `Goal`/title below predate that decision and are stale on the word "value."
**Goal:** τ=0.82 is measured degenerate at production scale (75.9% in one cluster at true full
scale, 68.4% on the earlier 1616-sample); implement PKT-28's target-mean-degree calibration
function and remove the silent 3-retry degenerate-guard fallback that currently does the real
calibration undocumented (the guard becomes a pure safety net that should rarely fire).
**Closes:** BL-328
**Files:** `libs/memory-core/src/cluster.ts` (`resolveDefaultThreshold()`, the retry-at-+0.05 guard at :465-484).
**requires:** PKT-28, PKT-29
**sequencing:** — land after).
**tier:** sonnet, ~35k tokens / ~14 turns
**orientation:** ~48k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~8k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~260k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** a test naming BL-328 running the live-store-scale sweep methodology from `cluster-calibration.md` against the new threshold strategy and asserting largest-cluster ratio stays below the degenerate bound (whatever PKT-28 sets, e.g. <0.5) across the full measured N range (200→1616+), not just at one fixture size.

### PKT-31 — BL-327: garbage-collect communities orphaned by `memory_invalidate`
**Goal:** `memory_invalidate` (the everyday bi-temporal path) never touches the community node or its `MEMBER_OF` edges, so ordinary churn decays `total_clustered` toward 0 while `cluster_count` stays fixed. Retire a community when its live member count reaches zero.
**Closes:** BL-327
**Files:** `libs/memory-core/src/invalidate.ts` (or wherever `memory_invalidate`'s implementation lives — confirm exact path before editing), `libs/memory-core/src/cluster.ts` (read-only reference to `materializeClusters`'s retirement logic at :274-296 — reuse it, don't duplicate).
**requires:** none
**sequencing:** — this does NOT need PKT-28's τ decision, it's orthogonal to threshold calibration. **But serialize on `cluster.ts` against PKT-29/PKT-30** since all three touch that file; land this one independently timed, whichever is ready first, just not concurrently.
**tier:** sonnet, ~35k tokens / ~14 turns
**orientation:** ~48k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~8k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~260k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** a test naming BL-327: invalidate every member of a community, assert the community node is no longer live, without running a full pass — must fail today.

---

## Wave D — repair helper + crash recovery (depends on nothing above, but internally ordered)

### PKT-32 — BL-337 + BL-341: unified repair helper (REINDEX workaround) + backup integrity-check cap handling
**Goal:** BL-335/336/347 are already shipped (verify: CHANGELOG.md, do not redo). What remains is BL-337 (`REINDEX <table>` is impossible on a table carrying a Tantivy index — enumerate btree indexes and reindex individually, skip the FTS index, rebuild it via its own DDL) and BL-341 (`backup.ts`'s post-`VACUUM INTO` check doesn't detect the 100-message integrity_check cap, plus the still-open spike on whether Turso exposes any integrity-check equivalent at all).
**Closes:** BL-337, BL-341
**Files:** `libs/data/store/store-adapter/src/integrity.ts` (repair helper: enumerate + reindex btrees, rebuild FTS via DDL), `libs/memory-core/src/backup.ts` (lines 59-60, 196-197 — cap detection + explicit "capped, additional damage may exist" flag).
**requires:** none
**tier:** sonnet, ~35k tokens / ~14 turns
**orientation:** ~59k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~19k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~270k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**Produces:** a unified repair helper covering the REINDEX workaround (BL-337) and the post-`VACUUM INTO` integrity path (BL-341), callable from the adapter. Consumed by PKT-33, whose acceptance asserts the **auto-repaired** half — so this must expose a programmatic entry point, not only a CLI path.
**acceptance:** BL-337, must name it: a repair routine returns a table with a Tantivy index to a clean `integrity_check` (filtered for BL-360's known false positive per that item's own amendment). BL-341, must name it: VACUUM INTO-backup a store seeded with >100 independent integrity violations, assert the backup's reported result is explicitly flagged as capped/incomplete, not silently reported as a bounded "100 issues."

### PKT-33 — BL-338: crash-recovery test — SIGKILL under sustained write load
**Goal:** the owner's bar verbatim: "none of this is manual & none of the crash data loss should be possible." Build the test that has never existed: kill -9 the server mid-write, restart, assert zero lost committed writes and auto-repaired integrity, with evidence visible in status/logs without human investigation.
**Closes:** BL-338
**Files:** new `libs/data/store/store-adapter/crash-recovery.spec.ts` (or equivalent location — confirm test conventions), reads (does not modify) `libs/data/store/store-adapter/src/integrity.ts`'s repair path from PKT-32.
**requires:** PKT-32
**sequencing:** **Also depends on BL-365 already being shipped** (it is — telemetry is crash-durable per STATE.md; confirm before writing the test, since the item's own text says the test's log-evidence assertion is meaningless without it).
**tier:** sonnet, ~40k tokens / ~14 turns — DEMOTED from opus: it is a test, against a helper that will already exist
**orientation:** ~56k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~16k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~160k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~300k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** a test naming BL-338: SIGKILL the server under sustained write load, restart, assert (a) zero lost committed writes, (b) `integrity_check` clean or auto-repaired to clean after filtering BL-360's known false positive, (c) damage and repair both visible in status/logs without manual investigation.

---

## Wave E — remaining P1.2 items, integrity-surface follow-ons (depend on Wave A/B landing)

### PKT-34 — BL-387: integrity verdict is blind to semantic completeness (embed backlog can be 100% and still report `overall: ok`)
**Goal:** the five integrity probes are entirely structural; none asks "is the content complete?" A 34%-unvectorised store reported healthy for ~13 hours. Add a completeness dimension: surface `embed_backlog` (already published) as an integrity-affecting signal, and report explicitly when the automatic-recovery mechanism (embed heal) is braked — a brake that hides itself is worse than no brake (this is also half of BL-378's fix, coordinate with PKT-13).
**Closes:** BL-387
**Files:** `libs/data/store/store-adapter/src/integrity.ts` (new `embed_completeness` probe, or extend the `IntegrityProbe` union), `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts` (surface whether `SOX_DISABLE_EMBED_HEAL` is active in the same response).
**requires:** PKT-25
**sequencing:** — same surface, avoid two agents both restructuring `memory_ping`'s response shape independently). **Serialize on `index.ts` after PKT-25.**
**tier:** sonnet, ~35k tokens / ~14 turns
**orientation:** ~91k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~51k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~310k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** a test naming BL-387: seed a store with a known embed backlog (e.g. 30% unvectorised), assert `memory_ping`'s `integrity.overall` is NOT `ok` (or a new field explicitly flags degraded semantic completeness) — must currently report `ok` regardless of backlog size.

### PKT-35 — BL-398: near-duplicate `weight`-as-cosine fabricates `1.0` for manually-merged pairs
**Goal:** BL-386's fix (read `edge.weight` as cosine) is correct for `applyNearDupResult`-written edges but wrong for `memory_curate merge_duplicates`-written edges, which carry `weight = 1.0` as a column default, not a measurement — so manual merges outrank real 0.96 inferred pairs.
**Closes:** BL-398
**Files:** `libs/memory-core/src/curate.ts` (or wherever `memoryNearDuplicates`'s weight-read lives — the item cites the read site but not an exact path; locate via the `e.weight`/`e.metadata` fallback described in BL-386's fix).
**requires:** none
**sequencing:** Independent of PKT-36 despite sharing a suspected call path — do not block on it, the fix here is narrow (gate on `origin === 'inferred'`).
**tier:** sonnet, ~35k tokens / ~14 turns
**orientation:** ~44k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~4k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~260k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**Produces:** a corrected `cosine_sim` read gated on `origin === 'inferred'`, with `user_asserted` edges reporting **null rather than 0 or 1.0**. Consumed by PKT-36 only as a confirm-or-rule-out signal on the shared query path.
**acceptance:** a test naming BL-398: a `memory_curate merge_duplicates` pair must NOT report `cosine_sim: 1.0` and must NOT outrank a genuine 0.96 inferred pair — an ordering assertion, not just a value check (a value check alone would pass on any non-1.0 placeholder, per the item's own note). Report `cosine_sim: null` for `user_asserted` edges, not `0` (would recreate BL-386's original bug) and not `1.0` (fabricates).

### PKT-36 — BL-399: swallowed `store.error: no such column: meta` on the graph tables
**Goal:** first make `store.error` log the failing statement (or a fingerprint), not just the driver message — the current gap is what made this hard to place at all. Then determine which of the three named hypotheses holds (live schema drift / query targets a table missing the column / Turso misreports an unrelated rejection) by querying a **copy** of the live store's actual columns, per BL-330's copy-both-files rule. Fix accordingly — do not assume schema drift and hand-repair the live store.
**Closes:** BL-399
**Files:** `libs/data/store/store-adapter/src/*` (wherever `store.error` is emitted — add statement/fingerprint logging), then the actual query/migration fix once the hypothesis is confirmed (likely `libs/memory-core/src/curate.ts` or `graph-store`'s `getEdges`, per the item's own lead — `getEdges` selects `e.meta AS e_meta` at :1130).
**requires:** PKT-35
**sequencing:** — confirm or rule out before duplicating investigation effort).
**tier:** opus, ~55k tokens / ~20 turns — cause unknown; needs statement logging before it is even observable
**orientation:** ~44k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~4k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~220k / ~60 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~380k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**Produces:** statement-level (or fingerprint) logging on `store.error` **first** — the current line records the driver's message but not the SQL, which is why BL-399 is undiagnosable — then the root cause and fix. A written finding of 'live schema drift' vs 'query defect' vs 'Turso misreporting' is a required output even if the fix is trivial.
**acceptance:** a test naming BL-399: the identified failing query no longer throws `no such column: meta` against a copy of the live store's actual schema, AND `store.error` for any future prepare-failure of this shape logs the statement — assert both, since the swallow itself (not just the root cause) is named as part of the fix.

---

## Wave F — deploy/artifact integrity and admission control (independent of clustering/tracing)

### PKT-37 — BL-390 + BL-393: `registry:sync-index` unsoundness under concurrency + the proxy's silent respawn-onto-staged-bundle
**Goal:** two failure modes on the deploy path, related but distinct. BL-390: `registry:sync-index` blesses a checksum from a dirty tree with no reproducing commit — make it refuse to run dirty (or stamp provenance as provisional) and record the commit sha an artifact was built from. BL-393: a build's `rm -rf dist` prelude can kill the live backend, which the proxy then silently respawns onto the new bundle — nobody chose that deploy. Narrow the actual trigger (a controlled rebuild did NOT reproduce it — pid survived on the old unlinked inode) before proposing a fix; do not guess.
**Closes:** BL-390, BL-393
**Files:** `tools/bundle-extension.cjs`, the `registry:sync-index` nx target implementation (locate under `tools/` or a dedicated nx executor), `libs/host-runtime/src/supervisor.ts` (respawn logic — read-only investigation first for BL-393's trigger).
**requires:** none
**sequencing:** **This packet must NOT run `nx build` on any shipped extension as part of its own testing** — reproduce the dirty-tree scenario against a disposable scratch package, never the live `memory-server` bundle. Flag to the human orchestrator before any test step that would build a real extension.
**tier:** opus, ~70k tokens / ~25 turns — BL-393's trigger is unidentified — reproduction IS the work
**orientation:** ~52k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~12k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~280k / ~75 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~480k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**Produces:** the identified **trigger** for BL-393 (a controlled rebuild did NOT reproduce it — the backend survived on the old unlinked inode), plus the `sync-index` dirty-tree refusal and a build-provenance stamp. If the trigger cannot be identified, that finding is the output and the fix must be scoped to detection rather than prevention.
**acceptance:** BL-390, must name it: `registry:sync-index` run against a deliberately dirty tree (scratch package, not a live extension) either refuses or stamps the entry as provisional with a commit sha field that can be verified against `git log`. BL-393, must name it: once the actual trigger is identified (not assumed), a test reproducing that exact trigger and asserting the backend does NOT silently respawn onto an unreviewed bundle — or, if full prevention isn't feasible, that the respawn is loudly logged and reflected in `soxe service status` rather than invisible.

### PKT-38 — BL-375: `service enable` rebuilds unit env from the invoking shell, silently dropping tunables
**Closes:** BL-375
**Files:** `libs/host-runtime/src/os-unit.ts` (or wherever `buildOsUnitEnv` lives — confirm exact path), the `soxe service enable` command in `apps/sox/src/main.ts`.
**requires:** none
**sequencing:** Independent of PKT-37 (different subsystem — env composition, not build/deploy identity) but both touch host-runtime's service-lifecycle surface; no file overlap expected, verify before dispatching in parallel.
**tier:** sonnet, ~35k tokens / ~14 turns
**orientation:** ~155k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~115k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~370k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** a test naming BL-375: regenerate a unit's env with a shell missing a previously-set tunable, assert the regeneration either preserves the missing key (diffed from the prior unit) or fails loudly/warns rather than silently dropping it and reporting success — must currently silently drop and report success.

### PKT-39 — BL-332: `soxe list` reports a running service as INACTIVE
**Closes:** BL-332
**Files:** `apps/sox/src/main.ts` (`cmdList` — route its status column through the same reality-verification `cmdStatus`/`service status` already uses; this is the exact BL-95 shape, fixed once already for a different command).
**requires:** none
**tier:** sonnet, ~35k tokens / ~14 turns
**orientation:** ~140k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~100k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~42 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~350k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** a test naming BL-332: start a service, assert `soxe list` reports it RUNNING with the correct pid — currently reports INACTIVE with an empty pid column.

### PKT-40 — BL-394: Turso write-serialization bypass also skips admission control (size cap + deadline guard)
**⛔ NOT a licence to serialize Turso writes — read the item's own warning before touching `write-queue.ts`. Three agents have already misread this.**
**Goal:** `WriteQueue._noop = true` on Turso is correct and must stay. What's wrong is that the bypass path (`write-queue.ts:502-540`) also skips the size-cap and deadline-guard checks that have nothing to do with serialization — hoist those two checks above the bypass so they apply regardless of whether serialization is active, and leave FIFO serialization behind the bypass exactly as it is.
**Closes:** BL-394
**Files:** `libs/memory-core/src/write-queue.ts` (lines 371-373 the `_noop` gate, 502-540 the bypass block — hoist admission checks only, do not touch the serialization decision).
**requires:** PKT-16
**sequencing:** — check its output before writing a new one from scratch, don't duplicate).
**tier:** sonnet, ~35k tokens / ~12 turns — DEMOTED from opus: hoist two checks above an early return. Was tiered on the fact that four agents misread this area — that is a CARE signal, handled by the banner, not a complexity signal
**orientation:** ~49k unavoidable before any edit — 36k mandated docs (README+STATE+PLAN) + ~9k cited source + ~4k backlog bodies. **This is fixed cost and does not shrink with the size of the change.**
**budget:** work ~140k / ~36 turns (4x the first estimate — see ESTIMATION BASIS). Guidance ceiling ~260k including orientation; **it is guidance, not a stop.** **Do not truncate the work to hit a number.** The failure this guards is an uncommitted buffer, not a token count: commit incrementally by explicit path, and if the fix sketch proves wrong, say so and stop — that is a success outcome. **You may sub-dispatch** once oriented, but hand the subagent PRE-DIGESTED context (exact file, exact change, exact assertion) — never tell it to read PLAN.md or BACKLOG.md, that is the cost you already paid.
**acceptance:** a test naming BL-394: with Turso's `_noop` bypass active, saturate the queue past `_maxSize`, assert `E_BUSY`/`rejections_busy_size` still fires — must fail today (not reached). Second assertion: `memory_ping`'s `write_queue.queue_max_size`/`deadline_budget_ms`/`deadline_guard_enabled` fields are proven live (not decorative) by the same test. **Explicitly assert concurrent Turso writes still complete without serialization** — a regression guard proving this packet did not reintroduce serialization.

---

## Explicitly out of scope / no packet (in addition to the exclusion list already in this plan)

- **BL-202** — memory-core suite flakiness under CPU load (`export.spec.ts`, `concurrency-harness.spec.ts`). Its own marker is explicit: **"NOT REPRODUCIBLE... do not `fix` until it reproduces."** ~30+ runs across serial/parallel/CPU-oversubscription produced zero failures. No packet — filing one would violate the item's own instruction. Leave open, revisit only if it reproduces again with a captured failure.

## Coverage method note

Verified by diffing every packet's `Closes:` line against `grep -oE '^### BL-[0-9]+.*\*\*(Open|REOPENED|BLOCKED)' BACKLOG.md` (80 ids) — every id appears in exactly one packet or the exclusion list above (including the pre-existing exclusion list at the top of this reconciliation section). BL-347, BL-335, BL-336 are correctly absent from both — verified RESOLVED in `CHANGELOG.md`, not orphaned.

## Wave summary — parallel width and tier distribution

| Wave | Packets | Max parallel width | Gate |
|---|---|---|---|
| A | PKT-01 .. PKT-23 (23) | 13 (after respecting the index.ts/cluster.ts serialization notes inline) | none — start now |
| B | PKT-24 .. PKT-27 (4) | 3 (PKT-24 before PKT-26 on `embed-pipeline.ts`) | PKT-02 |
| C | PKT-28 .. PKT-31 (4) | 1 then 2 (PKT-28 research is a hard gate; PKT-29/PKT-31 can run parallel after, PKT-30 last) | PKT-28 (research), PKT-01 (isolation) |
| D | PKT-32 .. PKT-33 (2) | 1 (PKT-33 depends on PKT-32) | none / PKT-32 |
| E | PKT-34 .. PKT-36 (3) | 2 (PKT-36 depends on PKT-35) | PKT-25 (PKT-34 only) |
| F | PKT-37 .. PKT-40 (4) | 3 | PKT-16 (PKT-40 only) |

**Total: 40 packets.** Tier distribution: **opus 10** (PKT-01, 02, 12, 21, 25, 26, 28, 29, 33, 36, 37, 40 — actually 12, see list), **sonnet 25**, **haiku 3** (PKT-09, PKT-20, PKT-22, PKT-23 — 4, see list). Exact counts: opus = {01,02,12,21,25,26,28,29,33,36,37,40} = 12; haiku = {09,20,22,23} = 4; sonnet = the remaining 24.

**Maximum achievable parallel width at any single instant is 13**, in Wave A, before any dependency resolves — the largest wave, and the one carrying both hard constraints (PKT-01 CRITICAL, PKT-02 the substrate). Wall-clock-critical path runs through PKT-02 → PKT-25 → PKT-34 (Wave A→B→E) and independently through PKT-01 → PKT-28 → PKT-29 → PKT-30 (Wave A→C), whichever research (PKT-28) and substrate (PKT-02) finish later determines the program's overall floor.
