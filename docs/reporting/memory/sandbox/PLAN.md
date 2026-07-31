# Sandbox Harness — Implementation Plan

> Companion to [`README.md`](./README.md) (the spec). This file is the **ordered build plan**,
> including every fix that must land *before* a run can be trusted.
> **Status:** not started. **Owner decision required at P0.4 before G4 can exist.**

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
| Integrity detection + repair | **packages** | BL-335/336/337/347/338/341 |
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

### P0.4 — BL-326: clustering is inert — **OWNER DECISION REQUIRED** · **HIGH**
`cluster.ts:437-441` short-circuits unconditionally. `incrementalOnly: true` returns empty
regardless of how many valid vectors exist, and a full pass runs only when an explicit
`organizer_queue` "enrich" row is pending — which `memory_curate {op:'recluster'}` merely
*enqueues*, never runs inline.

**Net: the only clustering path an ordinary `memory_write` reaches is the dead stub.**

**This invalidates the ladder as specced.** G3's "clustering triggered and terminated cleanly"
would pass *vacuously* — the stub returns empty instantly, and a gate that green-lights a dead
code path is worse than no gate. G4's "clusters form via the ordinary write path" is red **by
design, today**, and no amount of corpus tuning changes that.

BL-326 states this needs an owner decision — it is a design gap, not a typo. The options:

- **(a)** Implement the local-neighborhood incremental check (the existing `// TODO: D1.3`).
- **(b)** Run full passes automatically on a cadence/threshold.
- **(c)** Neither — accept that clustering requires explicit curation, and G4 asserts the
  *curated* path only, with the scorecard permanently marking automatic clustering `grey`.

**This is the one thing in the plan I cannot decide for you.** Everything else is engineering.

### P0.5 — BL-328: cluster threshold 0.82 may be mis-calibrated for natural prose · **MEDIUM**
Already filed, and it directly determines §3.2's corpus question. The hand-written corpus
measures intra-group mean **0.8174 / min 0.7572** — marginal at τ=0.82 *with content engineered
to cluster*. Naturally-worded real rows will likely fall below it.

**Resolve by measurement, before G4 is built:** compute intra/inter-group cosine over candidate
real-content cohorts. Either a real cohort clears the bar, or G4 keeps the synthetic corpus and
we file what that limitation means. Do not guess this.

### P0.6 — Test-infrastructure integrity · BL-340, BL-325, BL-324
`typecheck-tests` target does not exist; 18 `memory-core` specs never `await` the now-async
`openDb()`; 8 reproducible `memory-server` failures.

**Why it blocks:** the harness will be written *as tests*. Building it on a suite that does not
typecheck, with a known-broken async contract, reproduces the exact conditions that let the
frozen-`{skip}` bug hide two never-executing cross-backend tests behind a green board.

### P0.7 — BL-347: rebuild the live FTS index · **HIGH**
Verified fix, 0.26 s, snapshot already taken
(`~/.memory/memory.db.20260731-132556.pre-fts-rebuild`).

**Fold into the quiesce window** — daemon down, no concurrent writer, snapshot in hand. It is
the correct moment and costs nothing extra.

---

## P1 — Product telemetry. The measurements, in the packages.

These are §6.2 and §6.4 of the spec, and they are **already filed**. The harness reads them; it
does not implement them.

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
