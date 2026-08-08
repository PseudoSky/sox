# Session state — 2026-08-08

## Owner rulings (binding)

1. Embedding quality is not negotiable. bge-small swap refused (jaccard 0.498 vs bge-base, +49% edge density). No quantization/distillation without a jaccard number first.
2. Budget boundary for the <600ms target is `memory write → clustered recall`. The write is **inside** the budget.
3. Kind/edge typing is the **consumer's** responsibility. memory-server not doing it is a consumer failure, not an ADR-0010 design gap. Restoring a DDL CHECK is off the table. Not a blocker on the 600ms work.
4. Do not file a defect that is being fixed in the same session; put the evidence in the commit message.
5. **The outbox-row/queue wake design for wake-on-vector is rejected.** Not to be re-proposed in that form.
6. Tracing is a required deliverable.

## Merged and live (earlier this session, before the dispatch phase)

- BUG-MEMORY-001 + BUG-001 + ADR-0012 — Turso error taxonomy, Proxy re-entrancy fix. Full gate green, smoke 7/0. Live artifact `937a57b1e5d1`.
- BUG-MEMORY-002/003/004.
- Five typecheck branches — 16 projects, 214 previously unchecked files. 32 projects typechecking (was 20). Found BL-493, BL-494.

## In flight — NOT merged, NOT deployed

All four worktrees verified clean (`git status --porcelain` empty) — no orphan staged or uncommitted work anywhere.

| branch | worktree | HEAD | ahead of main | contents |
|---|---|---|---|---|
| `feat/cluster-time-to-community` | `.worktrees/cluster-time-to-community` | `6ff3ddc9` | 3 | BL-496 clustering instrument (`cluster-metrics.ts`, `cluster_pipeline` in `memory_ping`). Verified, fork-proven, rebased. Chain: `2a6c0516` → `99ddc9a2` → `6ff3ddc9`. The `ever_clustered_fraction` + `EVER_CLUSTERED_GRACE_MS` work orphaned by `cluster-latency` **was adopted and committed** as `6ff3ddc9`; worktree now clean. |
| `feat/cluster-tracing` | `.worktrees/cluster-tracing` | `453058c7` (on `a87cef86`) | 2 | Guard's instrument — 5-outcome taxonomy, `stages.ts` integration, lifecycle counters, backlog off `edge` rows; reframed at `453058c7` as the acceptance criterion. Green (memory-core 633 passed, memory-server 230). **Conflicts with BL-496 on 7 files**; does not merge mechanically. |

`453058c7` specifics: percentiles named `time_to_community_ms_among_joined` so the qualifier survives a grep; `never_clustered` reported both as a scalar and as the terminal bucket of a log-scale histogram (100ms…24h, `never`); `join_rate` accompanies every percentile and is `null` rather than a fabricated `1.0` when nothing has been censused; the durable `cluster.pass` event carries latency and denominator on one line. Test asserts the gaming direction — same joined count, more censored ⇒ `join_rate` falls. `quality` block (coverage, `mean_intra_sim`, `mean_inter_sim`, `largest_cluster_size`, `community_count`, `single_member_clusters`) gated to full passes on cost (~443 per-community queries); coverage and censored census are plain COUNTs on every pass. Instrument cost measured at 0.224µs/candidate against a 63µs budget; no additions to the inner cosine loop.

**Gap guard flagged rather than claimed:** it shipped the edge-insert clock (`time_to_member_edge_ms`, what the subsystem controls). True handler visibility (`time_to_community_visible_ms`, what a caller experiences) needs a harness polling the real MCP seam — not built. The difference between the two is itself the read-path diagnostic, non-zero today because of BUG-MEMORY-010.
| `feat/bug-memory-006-community-affordance` | `.worktrees/bug-memory-006-community-affordance` | `8c2c96a1` | 5 | Wave HH. Review verdict **NOT MERGEABLE**: ships a hard reject where an advisory was ruled; `SPEC-BUG-MEMORY-006.md:316` §1b still factually wrong ("only site" that mints a community uid). Neither finding fixed. |
| `feat/sub600-cluster` | `.worktrees/sub600-cluster` | `c9540072` | 5 | `tools/profile-phase-a.ts` (`5e01cfe0`), measurement only; Phase-A fold-in (`c9540072`) — `enrich.ts` extracts `computeWriteEnrichment()`/`detectAndApplyNearDup()`, `write.ts` folds enrichment into the INSERT; 4→3 SQL calls, 2→1 transactions. Needs a changeset (two additive exports). |

Fold-in measured on a store copy, same harness, n=12 each: Phase-A wall p50 241.1 → 120.2ms (−50.1%); DB time 236.3 → 110.3ms. Predicted ~134ms saving, actual ~121ms — the enlarged INSERT rises 102.91 → 113.05ms/call. Remaining INSERT is 99.7% of Phase-A DB time. Copy-measured only; live is 919ms p50 (n=11); the ~3.8× gap is unexplained and no concurrent writers were present. Structure defended, absolute number not.

Regression guard: a statement-count assertion (`issues exactly ONE node-write statement per write`) is the only detector — the three behaviour tests pass in both arms by design, so without it a re-added enrichment UPDATE would restore the cost silently. Counter excludes entity-node inserts (`write.ts:395`) and Phase-B's `embed_model` stamp (`embed-pipeline.ts:452`).

`a068ef0e` landed on `main`: a `tools/plan-status.mjs` derived-count resync (4 lines) demanded by the pre-commit hook. Drift originated from BL-495/496/497, not from the perf work; committed separately.

Ordering decided: BL-496 merges first, guard rebases on top. Neither has landed.

Reconciliation scope: the two branches conflict **specifically because both rewrote `incrementalJoin`'s rejection path** — grafting the five-outcome taxonomy forward is expected to be the whole of the manual work. The rest of `feat/cluster-tracing` (stage declaration, lifecycle counters, backlog-off-`edge`-rows) touches different regions and should apply more easily.

`feat/cluster-tracing` HEAD `453058c7` on `a87cef86`; `git status --porcelain` empty, no orphan staged entries. `memory-server/src/index.ts` is free — no uncommitted edits hold it.

## Verified facts

- **Double write in Phase-A.** `write.ts:336-345` INSERT writes `summary`/`tags`/`topic`/`project_path`/`importance`; `write.ts:430-444` then runs `enrichOnWrite` in a **second transaction** updating the same columns. `summary`/`tags` are FTS-indexed, so FTS maintenance runs twice. No triggers exist — `idx_fts_node` is a native Turso FTS index. Comment at `write.ts:333` ("via trigger") is wrong. Fix: compute enrichment before the INSERT and fold in. Not implemented.
- **`incrementalJoin` can JOIN but never CREATE** (`cluster.ts:653-666`, `:757-762`, `:525`). Communities are born only in a full pass; full passes are manual-only. → BL-495.
- **Vocabulary enforcement is nil.** `typePolicy` consulted only at `graph-store/src/index.ts:1032,1241` inside `writeNode`/`writeEdgeInternal`. `libs/memory-core/src` has **zero** non-spec call sites of those. All 20 node/edge writes are raw `INSERT INTO`. → BUG-MEMORY-011.
- **Live store carries no CHECK constraints of any family.** `kind`/`rel` (authorised, ADR-0010), `source`/`origin` (never authorised — present in all three node-DDL variants including `NODE_TABLE_DDL_OPEN` at `:75,275,330`), BL-430 `json_valid` on `tags`/`meta` (never authorised). BL-447's rebuild targets DDLs carrying *more* constraints, so it cannot be the mechanism. Turso conversion inferred, **unverified**. → BUG-MEMORY-012.
- **Vectors land in the main process; clustering runs in a forked child** (`runEnrichIsolated`). Any in-memory wake signal or counter that must cross that boundary fails in production while passing tests. BL-496 survives it (IPC + DB-derived); a naive wake trigger would not.
- Clustering compute is ~50ms and has never been a constraint.

## Measurement caveat

No standing instrument exists. Every timing produced this session came from a one-off harness against a store copy, n in the tens. Five reported conclusions were overturned by subsequent measurement: time-to-community bracket, "embedding forecloses 600ms", "the write forecloses 600ms", "enrichment dominates Phase-A", and the fork-safety ruling. Isolated Phase-A profiles (210ms / 241ms, two independent implementations) do not reconcile with live `write_latency_ms` p50 919ms (n=11); the gap is unexplained. `apply_latency_ms` p99 13,247ms vs p50 6.6ms is the visible suspect. **Treat every number in this session as directional.**

## Open — owner decisions

BUG-MEMORY-008 (CRITICAL, `buildCommunities` unscoped level-0 wipe), BUG-MEMORY-012, BUG-MEMORY-011, BL-495, BUG-MEMORY-007, BUG-MEMORY-010 (fix must not land before BL-496 deploys — `meta.member_count` drift is the only historical join-rate record), BL-497 (`selectEpisodes` `LENGTH(content) < 50` floor), CHORE-MEMORY-001, τ recalibration (τ=0.80 admits 60%, 0.85 → 21%, 0.86 → 12%), `t_expired`/`t_invalid` reconciliation.

BUG-MEMORY-009 marked DUPLICATE of BL-495; its singleton constraint (`meanIntraSim()` returns 1.0 for single-member clusters, feeding store-wide `mean_intra_sim`) and the D8 re-open condition were copied to BL-495 first.

## Filed late in session

- **PERF-MEMORY-003** (HIGH) — the Phase-A fold-in, with the copy-vs-live caveat recorded.
- **PERF-MEMORY-004** (HIGH) — E7 `computeImportance` is unreachable on the write path. `write.ts:197` destructures `importance = 1.0`, so `p.importance !== undefined` is always true downstream. Every episode without explicit importance stores `1.0` rather than a content-derived score, and is falsely stamped `enrich_ver.note = "user_override"` (~5,155 live episodes). `memory_recall` with no query is documented as importance-ranked and `filters.importance_min` filters that column, so both are near-meaningless if nearly everything is 1.0. Whether the false `user_override` stamp causes the batch enricher to preserve a value the user never chose is **untraced** — first thing to check. Pre-existing; not fixed.

## Tooling defect, unfiled

The workflow harness returned `"mergeable": true` for Wave HH while its own reviewer's prose read "Verdict: NOT MERGEABLE".
