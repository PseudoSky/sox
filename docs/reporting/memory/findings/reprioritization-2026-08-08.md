# Reprioritization of the memory-restoration queue — 2026-08-08

> **Read-only analysis.** No code was written, no packet body edited, no graph priority changed.
> Every number below was read from the running server, the backlog graph, or a file opened this
> session. Where I could not verify a claim, I say so rather than repeating the item's own text.

**Measured against:** live `memory-server` pid **50744**, artifact **`7d622e0d4390`**, up since
2026-08-08T01:14:28Z, store `~/.memory/memory.db`, adapter turso, **5056 live episodes** (5055 before
my probe write). Backlog graph, repo `sox-ecosystem`. `PLAN.md` derived ledger at 53 done / 4 partial
/ 28 open of 85.

---

## 0. Method note — I probed the live server, and it changed two conclusions

Two things in `memory_stats` looked like live regressions on first read and were **not**. Both were
artefacts of measuring a 68-minute-old process that had served zero writes:

| First read (02:22Z) | After one `memory_write` (02:23Z) | Verdict |
|---|---|---|
| `telemetry_self_check.stages_with_zero_samples: ["memory-core.write_queue","memory-core.embed"]` | `[]`, with `write_queue` wait/work count 3 and `embed` count 2 | Stage instrumentation is **live and correct**. BL-401 gap 6 works. |
| `wal_bytes: 24752`, `last_checkpoint_at: null` | `wal_bytes: 0`, `last_checkpoint_at: 2026-08-08T02:23:33Z` | BL-405's idle checkpoint is **live and correct**. |

I am recording this because the failure mode it nearly produced — filing two false live-regression
items off a cold process — is the same shape as the stale items catalogued in §2. **A zero-sample
telemetry surface on an idle server is not evidence of a dead instrument.** Probe it before you file.

---

## 1. What the ranking is actually measuring

The HIGH/MEDIUM labels are historical and I did not use them. I ranked on: live production harm →
data-loss risk → silently-wrong answers → leverage → symptomless debt. One structural finding
dominates the result and belongs at the top rather than buried in a list:

> **Roughly a quarter of the "28 open packets" contain no work.** I confirmed **seven** beyond the
> two the brief already knew about. The queue's own size is the most misleading number in the
> program, and it has now cost at least three dispatches (PKT-02 and PKT-28 per the brief; PKT-41 and
> PKT-19 per `STATE.md`'s own warning box, which records a session acting on two already-DONE
> entries).

---

## 2. Packets that are secretly done — named, with proof

These are **not** ranked work. Each one is a closure action, not a packet. Six of the seven need no
code at all: the fix is merged, the acceptance test exists and was watched red→green, and the only
thing standing between the item and `RESOLVED` is somebody running `backlog_transition_status`.

### PKT-54 / BL-413 — the enrichment stall. **The single most misleading entry in the queue.**

The brief flags this as the possible #1 ("zero items in 22.5 hours"). It is **fixed and deployed.**

- Live now: `enrichment.state: "ok"`, `queue_depth: 1` (the row my own probe write created 40s
  earlier), `embed_backlog: 0`, `enrich_stall_escalation: null`.
- `STATE.md` records the two deploys that fixed it: `d016b63 → 709069137504` (link-degree OR-COUNT
  rewritten as indexed two-scalar `computeLinkDegree`; tick **129.46s → 11.3s**; frozen queue drained,
  `queue_completed: 58`) and `dae9733 → 32f7cdac3c00` (per-pass-type isolation budget, full passes
  600s via `SOX_ENRICH_FULL_TIMEOUT_MS`; recluster then completed in 74.4s).
- The acceptance test exists and its red arm was watched: BL-413's own body records
  `bl413-enrich-stall-escalation.spec.ts`, 4 cases, "Confirmed RED by temporarily stubbing
  `checkAndEscalateEnrichStall` to `return null` — 3 of 4 cases failed exactly as expected". File
  confirmed present at
  `extensions/bundles/sox-memory-bundle/members/memory-server/src/bl413-enrich-stall-escalation.spec.ts`.

**Do not dispatch PKT-54.** Close BL-413 with a citation to the two deploys and the spec.

*(One residual worth a re-measure, not a packet: `queue_last_done_at` reads 2026-08-07T00:09:20Z —
26 hours before the sample — while `enrichment_watermark` reads `{"pass":"legacy","ts":
"2026-07-28T21:56:46Z"}`, which is **earlier** than the `2026-07-31T17:27:11Z` `STATE.md` recorded.
The store grew only ~17 episodes in 2.5 days, so a 26-hour gap between completions is consistent with
"no work arrived", and `state` is `ok` not `stalled`. I could not distinguish "idle" from "quietly
not completing" inside one session. Re-measure `queue_last_done_at` an hour after any write burst
before treating it as either.)*

### PKT-47 / BL-404 — telemetry composition root

- Wired: `initTelemetry(MEMORY_SERVER_TELEMETRY_INIT_OPTIONS)` at
  `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts:3075`, with the
  composition-root comment at `:3062-3063`.
- Spec exists: `.../src/bl404-telemetry-composition-root.spec.ts:150`.
- The **live half** of its acceptance — the half the packet says "is not optional" — is satisfied
  right now: `memory_stats.telemetry_self_check.role === "live-service"`, and
  `metric_persistence.file` resolves to
  `~/.adhd/sox-ecosystem/memory-server/logs/memory-server.live-service.metrics-snapshot-2026-08-08.jsonl`.

### PKT-31 / BL-327 — orphaned-community GC

- `libs/memory-core/src/community-gc.ts` exists; `gcOrphanedCommunityState` is called by
  `memoryInvalidate`, `curateMergeDuplicates` and `applyNearDupResult` (call graph confirmed).
- `libs/memory-core/src/invalidate.spec.ts` exists and is the packet's named red→green.
- The acceptance is *"invalidate every member of a community, assert the community node is no longer
  live, without running a full pass"* — that is precisely what the invalidate call site does.

### PKT-35 / BL-398 — fabricated `cosine_sim: 1.0`

- Writer fixed: `libs/memory-core/src/curate.ts:331-335` now inserts `'SAME_AS', 'user_asserted',
  NULL` with the comment *"fabricated cosine_sim: 1.0. No detector measured this pair's …"*.
- Reader spec fixed: `libs/memory-core/src/near-duplicates-bl386-cosine.spec.ts:133` —
  `describe('BL-398 — manual-merge pairs report cosine_sim: null, never a fabricated value')`, with
  the RED/GREEN contract written into the comment block at `:126-132`.
- `STATE.md`'s live table independently records **BL-398 resolved 2026-08-04**.

### PKT-09 / BL-396 — static ESM import from CJS

- Its acceptance is *"root `npx tsc --noEmit` reports zero errors in `index.ts` — currently reports
  exactly TS1541 + TS1479 at the named lines."* The brief states `nx run-many -t
  build,lint,test,typecheck` is green across 34 projects. I read the cited lines: `index.ts:86` is
  now `WriteQueue,` inside a plain `from '@adhd/sox-memory-core'` import and `:97` is a comment.
  **The condition the acceptance describes cannot currently be true.**

### PKT-02 / BL-351 — tracing substrate *(brief already knew; restated for completeness)*

Its own body: **`tier: … — **DONE.** Planned opus; ran on claude-sonnet-5 in fact`** and
**`tier-note: **COMPLETE** — dispatched before the no-opus constraint. Do not re-dispatch at this
tier.`** BL-351's residue is PKT-45.

### PKT-28 / BL-356 — clustering research *(brief already knew)*

**`Remaining as of 2026-08-05 — the research is finished; this packet has no work left in it.`**

### PKT-45 / BL-401 — *substantively* done, one gap genuinely open

Distinct from the six above; do not blanket-close it. Landed: `bl401-telemetry-substrate.spec.ts`,
`bl401-stage-migration.spec.ts`, `bl401-stages-declared-live.spec.ts`, and live
`stages_declared: 2` with `stages_with_zero_samples: []` **verified under load this session**.
`STATE.md`'s own "what to do next" says the remainder is *"closing it against its own acceptance with
a red→green test per BL-225, not another deploy."* Treat as a closure task with one small test, not
a 42-turn packet.

**Net effect of §2: the open-packet count is 28 on paper and ~20 in reality.** One agent, one
session, closes seven items and removes six packets from the board.

---

## 3. The CRITICAL tier is entirely stale and is poisoning triage

All 7 CRITICAL items predate the restoration program (filed 2026-07-30) and none is a `BL-*` item.
Three are demonstrably fixed:

| Item | Claim | Live/code evidence it is stale |
|---|---|---|
| `BUG-DB-OPENDB-MISSING-FTS-VEC-DDL-001` | `openDb()` never creates `fts_node`/`vec_node`; live store missing both | Live `fts_index_live` probe: *"All 3 sentinel rows round-tripped through `idx_fts_node`"*. `embed_provenance.stamped: 5056, unstamped: 0`. |
| `BUG-EMBED-ENRICH-TICK-STAMPEDE-001` | bare `setInterval` with **no reentrancy guard**; overlapping ticks | `_enrichPassInFlight` (`index.ts:2492`), `runPeriodicEnrichPassGuarded()` (`:2435`), `isEnrichPassInFlight()` test seam (`:2501`), and a dedicated `enrich-reentrancy.spec.ts`. The exact guard it asked for. |
| `DEBT-BACKLOG-TOOL-MARKDOWN-SPLIT-BRAIN-001` | 45 `BL-*` items split-brained; import authorized-not-run | Superseded by ADR-0011 Stage 3 — `BACKLOG.md`/`CHANGELOG.md` deleted, graph authoritative, `plan-status.mjs` sources from the graph. Its own notes record the reconciliation executed 2026-08-06. |

Not verified either way: `BUG-STOREADAPTER-MIGRATE-UNSAFE-001` (migration safety — the *code* concern
looks live, but the store has been migrated for a week and the script is not on any hot path) and
`BUG-MEMORY-DATALOSS-716-NODES-001` (the 716-node loss — **this one deserves a real answer**, see
rank 6).

**Recommendation:** sweep the CRITICAL tier before the next triage. Anyone sorting this backlog by
priority currently gets four fixed items at the top of the list, which trains readers to ignore the
priority field — the exact dynamic that produced BL-225.

---

## 4. Ranked list — top 15

Category legend: **HARM** = live production harm · **LOSS** = data/work-loss risk ·
**WRONG** = silently-wrong answer or a guard passing for the wrong reason · **LEV** = leverage ·
**DEBT** = real but symptomless.

| # | Packet / item | What it actually fixes | Cat | Leverage | Why here |
|---|---|---|---|---|---|
| **1** | *(no packet)* **Closure sweep of §2** | Closes BL-413, BL-404, BL-327, BL-398, BL-396, BL-351, BL-356 | **LEV** | **removes 6 packets, unblocks PKT-29 (BL-356), PKT-45 (BL-351)** | Highest value-per-turn in the entire queue. One session. The queue is currently lying about its own size by ~25%, and that lie has already burned ≥3 dispatches. Nothing else should be ranked above making the board readable. |
| **2** | **PKT-38 / BL-375** — `service enable` rebuilds unit env from the invoking shell | Silently drops any tunable absent from your shell, while printing success | **HARM** | 1 (guards every future deploy) | `README.md` calls this *"the highest-consequence trap on the list right now."* It dropped **both emergency brakes** on 2026-07-31, caught only by diffing the plist. **Verified still unfixed:** `BL-375` appears in `os-unit.ts:487` and `:1321` only as *prose warning* others away from `unload()+load()`; there is no test naming BL-375 anywhere in the repo. The blast radius has grown since filing — `SOX_ENRICH_FULL_TIMEOUT_MS` and `SOX_CLUSTER_TARGET_DEGREE` are now load-bearing tunables that this silently deletes. |
| **3** | **PKT-55 / BL-202** — memory-core suites flake under load | 109/95/91 failures across three runs of one config | **WRONG** | **all of them** — every count-based verification claim | This is the meta-defect. `STATE.md` carries a standing rule ("never gate on a failure COUNT") that no code enforces, so every packet's evidence is admissible only by convention. Until this lands, "the suite is green" is not a fact about the code. Ranked above every individual correctness bug because it is what makes the others' fixes provable. |
| **4** | **PKT-56 / BL-422** — commits stranded on disposable worktree branches | Work reachable from exactly one auto-removable ref | **LOSS** | 1 | The brief treats worktree isolation as the structural fix for BL-409; this is the hole in that fix. **Scale check, measured this session: 24 live directories under `.worktrees/`** (`pkt45-`, `pkt57-`…`pkt79-`, `bl447-`, `bl460-`, `bl466-`, `bl472-`, `bl474-`, `adr0011-*`, …). Every one is an unswept surface. The original incident recovered two commits "by a hunch". Small packet (~22 turns), fully disjoint. |
| **5** | **PKT-80 / BL-450 + BL-455** — calibrated τ is a coin flip at the boundary | Same corpus, same data → τ ∈ {0.87, 0.88, 0.89}, partition 443…506 | **WRONG** | 2 (PKT-30, PKT-29) | **Live evidence it matters, and it is stronger than the item states.** `STATE.md` says PKT-30's calibration shipped in `61e4ff0` and predicted 506 clusters / largest-ratio 0.048. Live *right now*: `cluster_count: 443`, `largest_cluster_size: 879`, `coverage: 0.714` — i.e. **the pre-calibration shape**. 879/5056 = **17.4% of the entire corpus sits in one community**. So the calibration is deployed and has never actually run in production, and the mechanism that will run it is the one BL-450 says is unstable at this exact operating point (*"the budget is ≤32.16 qualifying pairs and the corpus sits at exactly 32"*). Carries an explicit **owner decision** — see §6. |
| **6** | `BUG-MEMORY-DATALOSS-716-NODES-001` | 716 nodes / ~3027 edges missing vs the pre-swap backup; salvage "in flight" 2026-07-30 | **LOSS** | 0 | Nine days old, filed CRITICAL, **status unchanged, no resolution note, no citation**. Either the 712-node `.recover` salvage landed and nobody closed it, or 669 live/valid user memories are still gone. Both readings are bad and the second is unrecoverable. This needs **one hour of determination**, not a packet — but it must not stay unanswered while we tune clustering thresholds on the corpus it is missing from. |
| **7** | **PKT-13 / BL-378** — emergency brakes are not independent | `SOX_DISABLE_PERIODIC_ENRICH=1` silently no-ops `SOX_DISABLE_EMBED_HEAL` | **HARM** (latent) | 1 (half of PKT-34) | **Verified still unfixed** — BL-378 appears only in a comment in `suspension.spec.ts:133`; no test names it. Latent rather than active: the brakes are currently absent from the live plist and both subsystems are healthy. It becomes live harm the moment anyone reaches for a brake in an incident — which is the only time anyone ever does. Pairs naturally with #2. |
| **8** | **PKT-34 / BL-387** — integrity blind to semantic completeness | A 34%-unvectorised store reported `overall: ok, healthy: true` for ~13h | **WRONG** | 1 | The whole integrity surface is structural. Live `integrity.overall: ok` is true today (`embed_backlog: 0`), so this is currently a *dormant* instrument defect — but it is the instrument the operator trusts during an outage, i.e. exactly when it will be wrong. Blocked-ish on PKT-25; see §6 for why I think that dependency should be cut. |
| **9** | **PKT-29 / BL-326 + BL-349** — write-triggered background clustering | The incremental path is a dead stub; no ordinary write can cluster | **WRONG** | 2 (PKT-30, PKT-81) | Live: **1446 of 5056 episodes unclustered** and my own probe write landed with no community. `requires: PKT-28` is satisfied in substance (research delivered, `findings/pkt28-clustering-strategy.md` exists) — the marker, not the work, is the blocker. Ranked below #5 deliberately: building the trigger on top of a threshold function that is a coin flip ships instability faster. |
| **10** | **PKT-66 / BL-274** — concurrency harness through the real transport | Nothing exercises the Turso `_noop` bypass under concurrency via UDS | **DEBT**→WRONG | 1 (confirms PKT-65) | The bypass is what production takes: live `write_queue.mode: "bypass"`, `admission_control: "inactive"`, `deadline_guard_enabled: false`. That is the least-tested and most-used path in the system. Its safety arm ("refuse to start against `~/.memory`") is itself worth shipping — a stress harness pointed at the owner's live corpus is a data-loss event. Needs the `Files:` fork ruled (§6). |
| **11** | **PKT-18 / BL-215** — operator surface for `healStaleVectors` | No way to force a re-heal pass | **DEBT** | 0 | Small, self-contained, disjoint, no decision needed. Live `stamped_without_vector: 1` — one row that nothing can currently be told to fix. Ranked here purely as a clean wave-filler, not because it is urgent. |
| **12** | **PKT-42 / BL-318 + BL-317** — ghost episodes / mass-mislabel guard | `content: null` episodes; no guard against a repeat topic mislabelling | **DEBT** | 0 | **I would rank this DOWN from its filing.** Live: `legacy_episodes: 1`, `stale_episodes: 1`, `degraded_record_count: 0`, `malformed_rows.count: 0`. The population it describes is two rows and shrinking. BL-317's half (a dormant repeat-guard) is real but is insurance, not a defect. |
| **13** | **PKT-12 / BL-301** — unify the drifted `node`/`edge` schema | Two schema definitions, drifted columns + `edge.rel` CHECK | **DEBT** | 1 (PKT-11) | **Partly overtaken and needs re-reading before dispatch.** PKT-58 (BL-439, `kind` opens) and PKT-74 (BL-448, `edge.rel` opens) both shipped in Wave J, and `edge.rel` CHECK divergence is literally half of BL-301's stated drift. Live ontology now reports 6 kinds / 10 rels including `DEPENDS_ON` — the exact value BL-301's acceptance says "throws today". **Someone should check whether BL-301 is a third secretly-done item before it is scheduled.** |
| **14** | **PKT-11 / BL-400** — four spec files' hand-maintained schema replicas | Fixture DDL can silently diverge from real DDL | **WRONG** (latent) | 1 (PKT-12) | Genuine and cheap. This is the "test passes for the wrong reason" family in its purest form: four fixtures that will keep passing after the real schema moves. Low urgency, high tidiness. |
| **15** | **PKT-24 / BL-358 + BL-319** — wait-vs-work stamping; `estimated_wait_ms` is a prediction reported as an observation | | **WRONG** | 2 (PKT-25, PKT-26) | Textbook silently-wrong instrument, and it is the primitive PKT-25/26 are specified to *read*. But live `write_queue.mode: "bypass"` means the queue this instruments **is not on the production path at all** — the fields it fixes are `null` in production by design. That drops it from "instrument lying to the operator" to "instrument lying in a code path we don't take", which is why it sits at 15 rather than 5. |

### Items I judge misranked, in both directions

- **Up:** PKT-55 (BL-202) — labelled as suite flake, is actually the credibility of every verification
  claim in the program. PKT-80 (BL-450) — labelled a calibration nicety, is the reason 17.4% of the
  live corpus is in one blob.
- **Up:** the CRITICAL sweep (§3) and `BUG-MEMORY-DATALOSS-716-NODES-001` (rank 6) — a nine-day-old
  unanswered CRITICAL about 669 live user memories should not be quieter than a τ threshold.
- **Down:** PKT-54 (BL-413) — the brief's candidate #1; it is finished. PKT-42 (BL-318) — filed
  against a population that is now two rows. PKT-24 (BL-358) — instruments a path production bypasses.
- **Down / re-read first:** PKT-12 (BL-301), likely partly closed by PKT-58/PKT-74.

---

## 5. The next wave — 4 packets, file-disjoint, dependency-clean

Ordered as I would dispatch. **Precede it with the closure sweep (rank 1)**, which is a single agent
and touches no source file — it can run concurrently with the whole wave without collision risk.

| Slot | Packet | Files it touches | Tier / budget |
|---|---|---|---|
| **A** | **PKT-38 — BL-375** | `libs/host-runtime/src/os-unit.ts`, `libs/host-runtime/src/env-policy.ts`, `apps/sox/src/main.ts` (`cmdServiceEnable` only) | sonnet, ~14 turns |
| **B** | **PKT-55 — BL-202** | `libs/memory-core/src/export.spec.ts`, `libs/memory-core/src/concurrency-harness.spec.ts`, + the shared per-suite store fixture | sonnet, ~28 turns |
| **C** | **PKT-56 — BL-422** | `tools/commit-mine.mjs`, + one new sweep script under `tools/` | sonnet, ~22 turns |
| **D** | **PKT-18 — BL-215** | `libs/memory-core/src/curate.ts`, `extensions/bundles/sox-memory-bundle/members/memory-cli/src/index.ts` | sonnet, ~14 turns |

### Disjointness — checked pairwise, not asserted

- **No packet touches `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts`.**
  That is the worst collision file in the repo (8 packets contend for it) and this wave stays out of
  it entirely.
- **No packet touches `libs/memory-core/src/cluster.ts`** (the second-worst — PKT-29/30/80/81).
- A ∩ B/C/D = ∅ — A is the only packet in `libs/host-runtime/**` and the only one in `apps/sox/**`.
- C ∩ everything = ∅ — C is the only packet in `tools/**`.
- **B ∩ D is the one non-trivial pair.** Both live in `libs/memory-core/src/`. Named files are
  disjoint (B: two `*.spec.ts`; D: `curate.ts`). B's `Files:` line has a wildcard — *"plus whatever
  shared fixture opens the store per-suite"* — which is the only way these two can collide.
  **Constraint to hand B on dispatch:** *B may edit `*.spec.ts` files and a shared test fixture only.
  If the fix requires editing non-test source in `libs/memory-core/src/`, stop and report rather than
  editing — D holds `curate.ts`.* With that constraint stated, the pair is safe.
- `curate.ts` (D) is contended by PKT-29 and PKT-35 on paper. PKT-35 is **secretly done** (§2) and
  PKT-29 is deliberately excluded from this wave, so the file is free.

### Dependency check

All four declare `requires: none`. None of the four is superseded (PKT-16 and PKT-43 are; neither is
in this wave). None carries an unresolved owner decision — that is why PKT-80 and PKT-66 are out.

### What I deliberately left out, and why

- **PKT-54 (BL-413), PKT-47, PKT-31, PKT-35, PKT-09** — no work in them. Dispatching any of these is
  the wasted-dispatch failure the brief opened with. They go to the closure sweep instead.
- **PKT-80 (BL-450)** — ranked #5, excluded on purpose. Its own body says *"Decision needed, do not
  self-approve — BL-450 changes default clustering behaviour"*, and offers three candidates where
  option (1) *"alone does not remove the boundary"*. Dispatching it before the ruling produces an
  agent that either stalls or self-approves a default-behaviour change to the owner's live corpus.
  **It should be the first packet of the *next* wave, immediately after the ruling.**
- **PKT-29 (BL-326/349)** — ranked #9, excluded. Two reasons: it touches both `cluster.ts` and
  `memory-server/src/index.ts` (the two worst collision files simultaneously), and building the
  write-trigger on top of a threshold function that is a coin flip (#5) ships instability at higher
  throughput. Sequence PKT-80 → PKT-30 → PKT-29 → PKT-81, serially, as its own wave.
- **PKT-13 (BL-378)** — ranked #7 and genuinely open, excluded only because it is an `index.ts`
  packet and this wave's value is that it contends for nothing. It is the natural slot-A of the next
  wave, paired with PKT-34.
- **PKT-66 (BL-274)** — ranked #10, excluded pending the `Files:` fork (§6). It is otherwise perfectly
  disjoint and would be my fifth pick the moment that is ruled.
- **PKT-12 (BL-301)** — ranked #13, excluded because it may already be partly closed by PKT-58/74.
  Verify before scheduling; do not dispatch an agent to fix a CHECK constraint that Wave J removed.
- **PKT-51 (BL-409)** — excluded despite looking cheap. Its `Files:` line permits *"a guard script
  under `tools/`"*, which would race slot C in the one directory C owns; and PKT-76 (DONE) already
  landed substantial `commit-mine.mjs` hardening for BL-457/BL-463/BL-465. Re-scope it against what
  PKT-76 shipped before dispatching, or it duplicates work.

### One caution on slot A

PKT-38's stated orientation is **~155k**, the largest in the wave, driven almost entirely by
`apps/sox/src/main.ts` being a 100k file. Given the brief's note that two agents died on session
limits, hand slot A a scoped instruction: *read `os-unit.ts` and `env-policy.ts` in full; reach
`main.ts` by targeted grep for `cmdServiceEnable` only.* Otherwise this packet spends its entire
budget orienting.

---

## 6. Decisions the owner has to make before the wave after this one

Three, all of which currently block ranked work and none of which an agent may self-approve:

1. **BL-450 τ stability (PKT-80).** Widen the estimator 400→1200, hysteresis on the decision, or
   persist-and-require-two-passes. The packet is explicit that the first alone does not fix it.
2. **BL-452 release cascade (PKT-79).** Accept-and-script the cascade / caret ranges / fewer coarser
   packages. Caret ranges change the published compatibility contract and are hard to walk back.
3. **BL-274 harness home (PKT-66).** The packet recommends `tools/baseline-capture` (option a) and
   warns option (c) recreates the shape BL-164 was filed to end. This is a one-word ruling that
   unblocks a ranked packet.

I would also **cut PKT-34's `requires: PKT-25`**. PKT-34 adds a completeness dimension to the
integrity verdict; PKT-25 surfaces execution-provider and contention facts. They share a response
*surface*, not a dependency. Coupling them means a dormant-but-real instrument defect waits on an
unrelated 16-turn observability packet that itself waits on nothing anyone is scheduling.

---

## 7. What the plan is missing

I was asked whether the packet structure optimises for the wrong thing. Three answers, in order of
how much I believe them.

### 7a. The ledger measures item closure, not delivered value — and it is now a lagging, noisy signal

`plan-status.mjs` derives packet status from whether every `BL-*` id it names is closed. That was the
right call when items and code moved together. They no longer do: **seven of 28 open packets have
merged, tested, deployed code** (§2). The result is a board where `OPEN` means *either* "nobody has
started this" *or* "this shipped days ago and nobody ran a status transition" — and an agent cannot
tell which without reading the packet body, the source tree, and the live server. That is exactly the
read I just spent a session performing, and it is the read the brief describes having already paid
for twice.

BL-225 is the standing rule that a status marker must record a verified outcome. It is currently
enforced in one direction only — you may not mark DONE without a red→green. Nothing at all enforces
the reverse, so *"Open while already fixed"* is free, and PLAN.md's own note records **twelve** such
items found in one session. The rule bites both ways and the tooling only catches one.

**Concrete suggestion:** give each packet a second derived field alongside `status:` — something like
`code_landed:`, computed from whether the packet's named acceptance spec file exists in the tree. A
packet reading `status: OPEN, code_landed: yes` is a *closure task*; `OPEN / no` is a *work packet*.
That is one glob per packet and it would have caught all seven of §2 mechanically. Today the
distinction exists only in prose that a dispatcher does not read.

### 7b. Nothing in 85 packets measures whether recall actually got better

This is the finding I would most want acted on, and it is a product observation rather than an
engineering one.

Every packet in this plan is an internal-correctness item: does the instrument report a true number,
does the guard fail closed, does the write survive a SIGKILL. All necessary. But the product is *"an
agent asks a question and gets back the memories that matter."* **No packet, no backlog item, and no
metric anywhere in this program measures that.**

The one thing that ever tried — BL-367, cross-backend recall parity, described in `STATE.md` for a
long time as *"the biggest open unknown in the project"* — turned out to compare `RecallResult.uid`
across two stores that mint fresh ULIDs per episode, so *"overlap was **0 by construction** and the
test could never have passed."* It was archived, and nothing replaced it.

What the live surface says about retrieval quality today, none of which any packet owns:

| Measure | Live value | Reading |
|---|---|---|
| `with_tags` | **1366 / 5056 (27%)** | Tag-filtered recall reaches roughly a quarter of the corpus. |
| `with_summary` | 3448 / 5056 (68%) | A third of episodes have no summary to rank or display. |
| `with_project_path` | 3448 / 5056 (68%) | Project-scoped recall silently misses a third of memories. |
| `coverage` (clustered) | **0.714** — 1446 unclustered | Community-based expansion is unavailable for 29% of the store. |
| `largest_cluster_size` | **879 (17.4% of corpus)** | The largest "topic" is a sixth of everything, i.e. not a topic. |
| `mean_intra_sim` / `mean_inter_sim` | 0.882 / 0.629 | Separation is genuinely good *where clustering ran*. |

Those are all plausibly fine. The point is that **nobody knows**, because there is no golden query
set, no recall@k, no relevance judgement, and no regression ratchet on retrieval quality anywhere in
the plan — while there are five separate packets on telemetry plumbing. A restoration program can
finish every packet, close every item, turn the board green, and still ship a memory system that
returns the wrong episodes. That is the risk the current structure cannot see.

**Concrete suggestion:** one research packet — *"a frozen 30-query golden set against a snapshot of
the live corpus, with human-judged relevance, run as a non-gating report."* It is small, it is the
only thing here that measures the product rather than the plumbing, and it would give #5 (τ
stability) and #9 (clustering trigger) an acceptance bar that is about outcomes instead of ratios.
Right now PKT-80 and PKT-30 argue about `largest_cluster_ratio` with no evidence that ratio predicts
better recall.

### 7c. Two smaller structural notes

- **24 live worktrees is unmanaged state, and no packet owns it.** PKT-56 (BL-422) covers commits
  stranded *on* those branches. Nothing covers the directories themselves — each carries a full
  `node_modules`-less checkout, `STATE.md` records that worktree dispatch *"inherits neither
  `node_modules` nor git hooks"* and that two agents consequently committed with `--no-verify`. The
  isolation mechanism the program adopted as its structural fix for BL-409 has an
  operational cost nobody is tracking.
- **Orientation is still ~27% of fleet spend and the plan says so, then keeps growing.** PLAN.md's
  own dispatch section measures the 36k-per-packet documentation floor and notes *"the documentation
  effort directly inflated every agent's floor."* PLAN.md is now 3200 lines. This document adds to
  the pile. The §7a `code_landed:` field is partly a mitigation: it lets a dispatcher skip a packet
  without reading its body.

---

## 8. Return value — the short version

**Wave:** PKT-38 (BL-375) · PKT-55 (BL-202) · PKT-56 (BL-422) · PKT-18 (BL-215) — file-disjoint,
`requires: none` on all four, all sonnet. Plus a **closure sweep** agent (no source files) closing
BL-413, BL-404, BL-327, BL-398, BL-396, BL-351, BL-356.

**Do not dispatch:** PKT-54, PKT-47, PKT-31, PKT-35, PKT-09, PKT-02, PKT-28 — no work in them.

**Decisions needed:** BL-450 τ stability · BL-452 release cascade · BL-274 harness home.

**Unanswered and nine days old:** `BUG-MEMORY-DATALOSS-716-NODES-001` — 669 live/valid user memories,
salvage reported "in flight" on 2026-07-30, no note since.

Citations: [main, product-manager, claude, reprioritization-2026-08-08, 1: live `memory_ping` + `memory_stats`, pid 50744 / artifact `7d622e0d4390`, sampled 02:22Z and 02:23Z 2026-08-08 (before/after one probe `memory_write`), 2: docs/reporting/memory/PLAN.md:14-119 (derived ledger), :680-707 (PKT-45), :721-736 (PKT-47), :787-891 (PKT-51/52/53/54/55/56), :1258-1300 (PKT-02/03), :1353-1364 (PKT-09), :1378-1495 (PKT-11/12/13/16/18), :1575-1712 (PKT-24/25/26/27/28/29/30/31), :1758-1804 (PKT-34/35/36), :1810-1841 (PKT-37/38), :1957-1977 (PKT-66), :3058-3092 (PKT-79/80/81), 3: docs/reporting/memory/STATE.md:54-133 (live-service table), :137-184 (what to do next), :376-395 (2026-08-03/04 deploys), 4: docs/reporting/memory/README.md:84-94 (BL-375 trap), 5: extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts:80-113, :2432-2503 (`runPeriodicEnrichPass` / `_enrichPassInFlight` / `runPeriodicEnrichPassGuarded`), :3037-3075 (`initTelemetry` composition root), 6: .../memory-server/src/bl404-telemetry-composition-root.spec.ts:150, .../bl413-enrich-stall-escalation.spec.ts, .../bl401-stages-declared-live.spec.ts:133, 7: libs/memory-core/src/curate.ts:331-335, libs/memory-core/src/near-duplicates-bl386-cosine.spec.ts:126-133, libs/memory-core/src/community-gc.ts (`gcOrphanedCommunityState`, called by memoryInvalidate/curateMergeDuplicates/applyNearDupResult), libs/memory-core/src/invalidate.spec.ts, libs/memory-core/src/suspension.spec.ts:133, 8: libs/host-runtime/src/os-unit.ts:487, :1321 (BL-375 referenced in prose only, no test), 9: backlog graph via backlog_get_item — BL-413, BL-327, BL-398, BL-462, BL-468; backlog_list_items (status:open, priority:CRITICAL) — 7 items, all pre-2026-07-31, none family BL; backlog_spotlight repo sox-ecosystem, 10: 24 directories under .worktrees/ enumerated via Glob 2026-08-08]
