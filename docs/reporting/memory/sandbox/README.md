# Memory Sandbox — Clean-Slate Ingestion Harness

> **Status:** specification, not yet implemented.
> **Owner:** memory / turso-go-live.
> **Purpose:** prove, from a blank database upward, that every memory feature actually works —
> with per-step timing, fail-fast gating, and a durable report per attempt.
> **Build order:** see [`PLAN.md`](./PLAN.md) — the harness is built *last*, after the
> instrumentation it consumes ships in the packages.

**The sandbox is not a product. It is a thin runner.** Every metric it reports and every health
verdict it renders must be a shipped capability of the packages, surfaced through the real
status surface (`memory_ping` / `memory_stats`). The harness orchestrates, asserts, and writes
reports — it does not own instrumentation. If a measurement only exists when the harness runs,
it is in the wrong place. See [`PLAN.md` §0](./PLAN.md) for the ownership split.

---

## 1. Why this exists

Every diagnosis during the Turso migration was performed against one of two things: the
already-corrupted live store, or unit tests running with mocks. Neither can answer the
question that actually matters — **does the system, as written, work?**

The cost of not being able to answer it, measured on this migration:

- Two dedicated cross-backend tests had **statically skipped on every run since they were
  written**, because Vitest freezes `{ skip }` at collection time before `beforeAll` sets the
  availability flag. They were green. They had never executed.
- Embeddings were believed written for weeks while `vec_node` was effectively empty.
- Keyword search returned zero rows for every query on the live store for at least a day
  (BL-347), silently, while the service reported healthy.
- A throughput number gathered under uncontrolled load (0.13/s) was compared against a
  clean-room number (~2.5/s) and sent an agent chasing a phantom regression.

This harness exists so that "is the memory system working?" is answered by **a run, not a
belief.**

### What this harness proves — and what it structurally cannot

It is essential to state the boundary, because our two worst outages sit on opposite sides
of it.

**Proves (behavior):** features work as written on a correct store — embeddings persist,
clustering forms, recall returns, concurrency is safe, throughput is real.

**Cannot prove (state, lifecycle, scale):**

- **State damage.** BL-347's dead FTS index would show as *perfectly healthy* here — a
  clean-room A/B confirmed `CREATE INDEX ... USING fts` backfills a populated table (50/50)
  and indexes subsequent inserts (60/60). The live index is empty because a crash repair
  skipped it. **A green run of this harness is fully compatible with FTS being dead in
  production.**
- **Migration paths.** The vec0-residue defect only exists when migrating an *existing*
  sqlite+vec0 store. A fresh db never triggers it.
- **Lifecycle.** launchd → proxy → backend, and the six `policy.enforced` env-allowlist
  copies. A sandbox runs with a full environment; the scrubbing stays untested.
- **Scale.** 9420 nodes and a 44 MB WAL do not behave like a 200-row sample. Measured instance:
  single-linkage clustering's largest-cluster ratio at τ=0.82 goes 0.085 → 0.684 as N goes
  200 → 1616 on identical content, so a small cohort looks healthy at a threshold that collapses
  the full store (§3.2, BL-356). **A green G4 is not threshold validation.**

Phase 2 (§9) closes the first two with a **damage-replay** harness. Until it lands, a green
scorecard here means *"the code is correct,"* never *"production is healthy."* Do not let a
report from this directory be cited as evidence about the live store.

---

## 2. Principles

1. **Fail fast, at the smallest possible scope.** The ladder starts at zero nodes and grows.
   A failure at gate *N* halts the run immediately — no waiting out a long ingestion to find
   out it broke in the first thirty seconds.
2. **Every gate is red-provable.** A gate that cannot fail is decorative. Detection probes
   must be shown to fail against a known-bad input (§6.3). This is the BL-167 lesson: a suite
   named for an invariant, that skips the case where the invariant breaks, is worse than no
   suite — it manufactures false confidence.
3. **Measure everything, in one timeline.** All spans, counters and samples land in a single
   ordered event log with a shared monotonic clock, so "the embed took 4 s" and "the write
   queue was 12 deep" are correlatable without joining files by hand.
4. **No claim without a measurement.** Report fields are populated from the timeline or left
   explicitly `null`. Never inferred, never carried over from a previous attempt.
5. **Every attempt is durable.** Even — especially — the failed ones. Triage must not require
   reproducing the failure.
6. **The sandbox cannot touch production.** Enforced by assertion before a single write (§4),
   not by convention.

---

## 3. Test corpus — real content, re-derived intelligence

Source rows are sampled from a **read-only copy** of the live store. Only raw authored
content crosses the boundary:

| Carried over | Regenerated inside the sandbox |
|---|---|
| `content`, `name`, `summary`, `kind`, `tags`, timestamps | embeddings, vectors, clusters, community nodes, `MEMBER_OF` edges, enrichment fields, FTS index |

Everything ML-inferred is rebuilt from scratch. That is the point — we are testing the
derivation, so importing derived state would defeat the run.

Rows are replayed **through `handleToolCall('memory_write')`** — the real MCP tool surface,
exactly as a live agent writes. Never through `memory-core` directly. A harness that bypasses
the tool surface cannot catch defects in the tool surface, and BL-249 (`memory_link` missing an
`await`, silently returning `{}`) lived precisely there.

### 3.1 Stratified sampling, not random

Random sampling will miss the shapes that actually break things. Each cohort is drawn to
include known-dangerous content:

- `content` > 2000 chars — triggers the auto-chunk path (BL-154's re-entrancy deadlock).
- Empty or `''` `tags` — the exact shape currently blocking `memory_stats` on the live store.
- Unicode / emoji / RTL.
- Very short content (< 20 chars) — degenerate embedding geometry.
- Near-duplicate pairs — exercises `memory_near_duplicates` and supersession.

### 3.2 Clustering cohorts must be *selected*, not sampled — measured, BL-328

> **This section previously argued that τ=0.82 was marginally too HIGH for real prose and that a
> real-content cohort might not clear it. That reasoning was wrong in direction and has been
> replaced with measurements (BL-328, `cluster-calibration.md`).** Retained as a correction
> because the original claim was cited while planning G4.

Clustering is cosine-threshold connected-components at **τ = 0.82**, `minClusterSize: 2`.

**A real-content G4 cohort is viable, and outperforms the synthetic fixture.** Three real topics
selected for distinctness × 8 episodes, drawn from the live store, cluster at the production
default into 5 communities, **23/24 covered, 100% purity, zero cross-group contamination** —
better than the hand-written corpus at the same τ (4 communities, 21/24, one group splits and
drops 2). G4 does not need the fixture.

**Real content does not cluster worse than synthetic.** Real intra-group means 0.8144 / 0.8495 vs
0.8087 synthetic. What differs is the *floor*: inter-group 0.64–0.68 for real content vs 0.47 for
the fixture. Less headroom, not less signal.

**τ = 0.82 is mis-calibrated UPWARD, not downward.** On the live store's own 1616 production
vectors it puts **68.4% of the corpus into a single cluster**. τ=0.65 — the value
`clustering-e2e.test.ts` calls "measured-safe" — puts **97.8%** in one cluster at 0.410 purity.
τ=0.87 is the healthy value (128 clusters, 65% coverage, 0.943 purity, 20.7% largest), and it is
exactly what the degenerate guard escalates to on its own — so **production's effective threshold
is already not 0.82, and that is undocumented**.

#### ⚠ You cannot calibrate τ on a small sample — this constrains the harness directly

`minPts = 2` makes this **single-linkage**, so a fixed τ fixes edge *probability* and mean degree
grows linearly with N. Largest-cluster ratio at τ=0.82 on identical content:

| N | 200 | 400 | 800 | 1200 | 1616 |
|---|---|---|---|---|---|
| largest-cluster ratio | 0.085 | 0.222 | 0.459 | 0.595 | **0.684** |

**A sparse sample systematically underestimates chaining.** A 24-episode G4 cohort will look
healthy at a τ that collapses the full store. So G4 proves *the clustering path executes and
produces correct groupings* — it says **nothing** about whether τ is right at production scale,
and a green G4 must never be read as threshold validation. That is a scale question (§1), and
BL-356 is the item.

#### Two constraints for whoever builds G4

- **Topics must be *selected* for distinctness, never sampled.** In a 288-row stratified sample
  across 67 topics, intra-topic cosine (0.5971) is **lower** than inter-topic (0.6125). `topic` is
  per-write enrichment, not a semantic partition — **it is not valid ground truth.**
- **Assert purity and dominance, never "one community per group."** No corpus satisfies
  one-community-per-group at the default, the synthetic fixture included.

#### The ladder split still stands

- **G3** (6 concurrent writes) proves write / embed / vector / FTS concurrency. It does **not**
  assert clusters formed — 6 rows is far below where chaining or grouping means anything.
- **G4** ingests the selected-distinct cohort and asserts clusters form, with purity and dominance
  checked.

### 3.3 ⚠ G4 is blocked on an owner decision — BL-326

`cluster.ts:437-441` short-circuits unconditionally: `incrementalOnly: true` returns empty
regardless of how many valid vectors exist, and a full pass runs only when an explicit
`organizer_queue` "enrich" row is pending — which `memory_curate {op:'recluster'}` merely
*enqueues*, never runs inline. **The only clustering path an ordinary `memory_write` reaches is
the dead stub.**

Two consequences for this ladder, both of which override the naive reading above:

- **G3 must not assert "clustering triggered and terminated cleanly."** Against the current
  code that passes *vacuously* — the stub returns empty instantly. A gate that green-lights a
  dead code path is worse than no gate. G3 asserts concurrency only.
- **G4 cannot pass via the ordinary write path today**, and no corpus tuning changes that.

BL-326 requires an owner decision (implement the incremental neighborhood check / run full
passes on a cadence / accept that clustering is curation-only). Until it is made, G4 is
specified but not buildable, and the scorecard marks automatic clustering `grey` — never
`green`, and never a misleading `red` attributed to the corpus.

---

## 4. Isolation and the quiesce protocol

### 4.1 Isolation manifest — asserted at G0, before any write

| Resource | Sandbox value |
|---|---|
| Store path | `$SANDBOX/memory.db` — **never** `~/.memory/*` |
| `HOME` | `$SANDBOX/home` |
| Server port | ephemeral, allocated per attempt |
| Embed cache | `$SANDBOX/embed-cache` |
| Log dir | `$SANDBOX/logs` |
| launchd | none — server + daemon spawned directly, supervised by the harness |

G0 **hard-fails** if any resolved path lies under `~/.memory` or `~/.adhd`, if the allocated
port is in use, or if the sandbox root already exists and is non-empty.

### 4.2 Quiescing the global daemon

The sandbox's embedding host contends with the **live** embedding host for the same Apple
Neural Engine. This is not hypothetical — it is the confound that produced the 0.13/s vs
2.5/s discrepancy and burned real investigation time. **Any throughput number gathered while
the live daemon is running is void.**

Protocol:

1. Record the live service state (`sox service status`, PIDs, launchd label).
2. Stop the global memory daemon. Wait for the backend and the embed host to actually exit —
   verified by PID absence, not by the stop command returning.
3. Write `quiesced: true` plus the pre-state into `provenance.json`.
4. Run the attempt.
5. **Restore unconditionally** — on success, on failure, on `SIGINT`, on crash. The restore
   is a trap/`finally`, and the harness re-verifies the live service is healthy afterward,
   recording the result in the report.

If the daemon cannot be stopped, or cannot be restored, the run **aborts and says so
loudly**. Leaving the user's memory service down is a worse outcome than not running.

A run that proceeds without quiescing is legal but stamps every throughput metric
`contended: true`, and those values are excluded from baselines and the regression ratchet.

---

## 5. The gate ladder

Each gate halts the run on failure. `↳` marks what is measured; **bold** marks the pass
condition.

### G0 — Preflight
Isolation manifest asserted · driver/node/git provenance captured · live daemon quiesced and
verified down · sandbox root created · disk space checked.
**All isolation assertions pass and the live daemon is confirmed stopped.**

### G1 — Blank state
Fresh db created. Schema applied. Server + daemon start. Every MCP tool is called against the
empty store.
↳ cold-start latency · schema-apply duration · per-tool response latency · RSS at idle

**Every expected table and index exists; every tool returns a well-formed empty result rather
than an error.** Notably `memory_recall` both with and without a query — the two live failures
were exactly here. `memory_stats` must return zeroes, not throw.

### G2 — Single node
One real row, written through the tool surface.
↳ **the full per-item span set (§6.2)**

**Every feature persists for that one row:** `node` row present · embedding computed ·
`vec_node` vector present with correct byte length (768 × 4 = 3072) · FTS matches a token
known to be in the content · `memory_recall` with a query returns it · without a query returns
it · `memory_stats` counts it · enrichment fields populated.

This gate is the highest-value one in the ladder. If a single node cannot make it through
every feature, nothing downstream is worth measuring.

### G3 — Concurrent batch (6 simultaneous)
Six writes issued **genuinely in parallel** — dispatched together, not awaited in sequence.
↳ per-item span set, all six · wall-clock vs sum-of-serial (proves real concurrency) ·
write-queue depth over time · txn wait / retry / busy counts · embed queue depth · RSS and CPU
sampled throughout · WAL growth

**All six land completely · zero lock/busy errors · zero lost or interleaved writes ·
concurrency demonstrably real** (wall-clock materially below serial sum).

**No clustering assertion at this gate** — see §3.2 and §3.3. Against current code any such
assertion passes vacuously off a dead stub.

### G4 — Clustering cohort · **blocked on BL-326 (§3.3)**
The semantically-grouped corpus (§3.2).
↳ enrich-pass duration broken down by step · clusters formed · sizes · coverage ·
`MEMBER_OF` edge count · group→community mapping · degenerate-guard retries

**Clusters actually form; each seeded semantic group maps to a dominant community; coverage
and `largest_cluster_size` > 0.** This is the assertion the live store currently fails.

### G5 — Soak (optional, opt-in)
Sustained ingestion at scale.
↳ steady-state throughput · latency percentiles (p50/p95/p99) · RSS/fd/WAL growth curves ·
throughput decay over time

**No unbounded resource growth; no throughput cliff.** This is the gate that produces the
evidence Theme 2 (resource governance) needs, and the only one that speaks to scale.

---

## 6. Instrumentation

> **These spans and samples are emitted by the packages, not by the harness.** §6.2 is
> substantially BL-319 (already filed, and already enumerating `write_to_vector_ms`,
> `vec_insert_duration_ms`, `embed_throughput_per_sec`, `backlog_drain_rate`); §6.4 and the
> capability/health fields are BL-334; the wait-vs-work split is BL-322/BL-345. The harness
> *consumes* them via the real status surface and correlates them on `trace_id`. An operator
> hitting `memory_ping` at 3am gets the same facts. See [`PLAN.md` §P1](./PLAN.md).

### 6.1 Timeline log

`timeline.jsonl` — one JSON object per line, append-only, ordered by a monotonic clock
(`process.hrtime.bigint()`), with wall-clock recorded once at origin so spans stay correlatable
without being vulnerable to clock adjustment.

```jsonc
{ "t_mono_ns": 1043221, "seq": 412, "kind": "span_end", "gate": "G3",
  "trace_id": "01JB...", "item": 3, "span": "embed_compute",
  "dur_ms": 412.7, "ok": true, "attrs": { "dims": 768, "backend": "coreml" } }
```

Event kinds: `gate_start` · `gate_end` · `span_start` · `span_end` · `counter` · `sample` ·
`assert` · `failure` · `note`.

Every event carries the `trace_id` already threaded by BL-320's AsyncLocalStorage, so the
harness timeline and the server's own structured logs join on one key.

### 6.2 Per-item span set

The chain the user asked to see broken out, end to end:

| Span | Boundary |
|---|---|
| `tool_call_total` | MCP request in → response out (what a caller experiences) |
| `mcp_transport` | dispatch → handler entry (isolates proxy/UDS overhead) |
| `write_queue_wait` | enqueue → task start (**contention, not work**) |
| `db_write_node` | node row insert txn |
| `embed_enqueue_wait` | queued → embed host picks up |
| `embed_compute` | embed host in → vector out |
| `embed_ipc` | host round-trip minus compute (serialization cost) |
| `db_write_vector` | `vec_node` insert txn |
| `fts_visible` | write commit → token matchable via `fts_match` |
| `recall_visible` | write commit → row returned by `memory_recall` |
| `enrich_trigger` | write → enrichment pass observes the row |
| `cluster_pass` | pass start → end, sub-spanned by step |

`write_queue_wait` and `embed_enqueue_wait` are called out deliberately: they separate *time
spent working* from *time spent waiting for a contended resource*. That distinction is the
entire subject of Theme 2, and we currently cannot measure it.

`fts_visible` and `recall_visible` measure **read-after-write visibility**, not just write
success. A write that commits but is not findable is the failure mode we shipped to
production.

### 6.3 Negative controls

At least one assertion per gate must be demonstrated to fail against a deliberately broken
input, executed as part of the run and recorded in the report. Concretely: the FTS health
probe runs against an emptied backing directory and **must** report red.

If a probe cannot be made to fail, it is not a probe. It is a comment.

**Do not use the Tantivy backing-table row count as an FTS health signal.** Measured on
2026-07-31: `SELECT COUNT(*) FROM __turso_internal_fts_dir_idx_fts_node` returns **0 both when
FTS is dead and when it is working correctly.** The only sound probe is an actual `fts_match`
against a token known to be present (BL-347).

### 6.4 Resource sampling

Sampled on a fixed interval into the same timeline: RSS (server, embed host, daemon
separately) · CPU% · open fds · db file and WAL size · write-queue and embed-queue depth ·
event-loop lag.

Event-loop lag is the direct instrument for the `hrtime`-gap experiment Theme 2 needs to
distinguish "the event loop is blocked" from "the UDS connection is serialized." Sampling it
here means that experiment stops being a separate errand.

---

## 7. Reports

```
docs/reporting/memory/sandbox/
├── README.md              ← this file
├── LEDGER.md              ← one line per attempt, newest first
└── attempts/
    └── <UTC-timestamp>-<git-sha>/
        ├── report.md          ← human-readable: scorecard, metrics, failures, follow-ups
        ├── scorecard.json     ← machine-readable feature grid
        ├── timeline.jsonl     ← full event stream
        ├── provenance.json    ← git sha, driver/node versions, quiesce state, host, config
        └── failure/           ← present only on red
            ├── gate.json         ← which gate, which assertion, expected vs actual
            ├── sandbox.db        ← the store, exactly as it failed
            ├── server.log / daemon.log / embed-host.log
            └── triage.md         ← auto-captured probe output
```

**Attempts are immutable.** A fix produces a *new* attempt directory. The point of the ledger
is the sequence.

### 7.1 Scorecard

Per feature: `green` (asserted, passing) · `red` (asserted, failing) · `grey` (not
exercised at this gate).

**There is no `yellow`, and no `green` without a citation to the timeline event that proves
it.** "Probably fine" is `grey`. This is the rule that BL-88, BL-95, BL-115 and BL-167 were
each marked RESOLVED in violation of.

Features tracked: schema · write · embed · vector persist · FTS index · FTS query · recall
(query) · recall (no query) · stats · clustering trigger · cluster formation · `MEMBER_OF`
edges · enrichment · near-duplicates · supersession · link · concurrency safety · read-after-
write visibility.

### 7.2 Report contents

Scorecard · gate-by-gate timings · per-item span table for G2/G3 · throughput with
`contended` flag · resource curves · **every failure with expected vs actual and the timeline
slice around it** · follow-ups (each either filed as a BL item with its number, or explicitly
marked "not filed, because…").

### 7.3 Regression ratchet

Each attempt is diffed against the last green one. Any feature going green → red, or a
throughput/latency regression beyond a stated tolerance, is called out at the top of the
report. Three attempts are needed before a metric is treated as a baseline — a single run's
throughput is an anecdote, and variance across attempts is itself a reported measurement.

---

## 8. Failure loop

```
run → red at gate N
    → halt immediately (no further gates)
    → capture failure/ (db, logs, timeline, probe output)
    → write report.md with the scorecard as it stood
    → append to LEDGER.md
    → triage → fix → rebuild affected projects
    → destroy sandbox → fresh sandbox → new attempt from G0
```

**Every fix gets a BL item, including the ones fixed within the hour.** The standard is: in a
production-grade system none of this is manual, and none of it should have been possible. A
defect that was hand-fixed and never filed is a defect that will be rediscovered by hand.

**Never resume a run mid-ladder after a fix.** The store carries the state the failure left in
it; a resumed run measures a store no user will ever have.

---

## 9. Phase 2 — damage replay (specified now, built next)

The complement to this harness. Seed a *known-bad* state into a copy and assert the system
**detects** it, then **repairs** it. Detection is the load-bearing assertion; a repair test
that only proves "repair fixes it" leaves the silent-failure hole wide open.

Seed states, every one drawn from something we actually hit and hand-fixed:

- Empty Tantivy FTS directory (BL-347)
- vec0 residue from a sqlite+vec0 migration
- Missing btree index rows after bulk insert (BL-335)
- Duplicate `_adapter_meta` rows (BL-336)
- `tags = ''` where `NULL` is expected
- A torn WAL from simulated power loss (BL-338)

This is the harness that would have caught BL-347 — and the one that gives BL-338's
*"recovery must be automatic"* an executable definition.

---

## 10. Open questions

Recorded rather than guessed. Each is resolved by measurement during implementation.

1. **Does `SOX_SYNC_EMBED=1` change the timing we care about?** It makes writes embed
   synchronously, which is ideal for G2 determinism but collapses `embed_enqueue_wait` — the
   very span Theme 2 needs. Likely answer: G2 synchronous, G3+ asynchronous, both stated in
   the report. To be confirmed, not assumed.
2. ~~**Real-content clustering cohort.**~~ **ANSWERED 2026-07-31 — yes, viable.** See
   [`cluster-calibration.md`](./cluster-calibration.md). A *stratified* sample does **not** work
   (intra-topic cosine 0.5971 is *lower* than inter-topic 0.6125 — `topic` is enrichment, not a
   semantic partition), but a cohort of **three real topics selected for distinctness** clusters
   at the production default into 5 communities, 23/24 covered, 100% purity, zero cross-group
   contamination — outperforming the synthetic corpus at the same τ. §3.2's "marginal at τ=0.82"
   framing is superseded: τ=0.82 is mis-calibrated *upward* (68.4% of the live store in one
   cluster), and τ=0.65 is catastrophic on real content (97.8% in one cluster). Assert purity and
   dominance, not "one community per group" — no corpus satisfies that, synthetic included.
3. **Periodic enrich is on a 5-minute interval.** Waiting it out per gate is unacceptable for
   fast feedback. Needs a test-visible trigger (`runEnrichPassOnDb` is already exported and
   used by `clustering-e2e.test.ts`) — but then the harness is not testing the *scheduler*.
   Both need coverage; they are different assertions.
4. **Can the daemon be quiesced without launchd fighting back?** `KeepAlive` semantics must be
   verified, or the restore step races the supervisor.
5. **Is CoreML actually in use, and is it faster?** The CoreML-vs-CPU A/B has never been run.
   G3/G5 with `contended: false` is the first environment where that comparison is
   trustworthy.

---

## 11. Relationship to existing work

- **Extends** `turso-clean-room.test.ts` and `clustering-e2e.test.ts` — these already
  established the fresh-db pattern, the synchronous Turso-availability check that avoids the
  frozen-`{skip}` trap, and the measured clustering corpus. This harness generalizes them from
  test files into an instrumented, reportable, service-level run.
- **Instruments** BL-320's structured JSONL telemetry — shares the trace-id, so harness spans
  and server logs join.
- **Feeds** Theme 2 (resource governance): §6.2's wait-vs-work split and §6.4's event-loop lag
  sampling are the measurements that design has been blocked on.
- **Does not replace** the smoke test (`scripts/smoke-test.mjs`), which covers extension
  install/lifecycle. Different layer, no overlap.
