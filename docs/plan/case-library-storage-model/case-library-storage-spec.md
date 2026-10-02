# Case Library on the External memory-server Graph — Storage Model

> Produced by the `architect` agent (session `ses_f25a36adbffeZa9w5zjWtlYbVj`), 2026-09-25.
> Persisted verbatim-in-substance by agent-manager. Durable home: the proposed **adhd ADR-0003**
> (case-library storage model) — owner-gated, not yet authored. Scratch copy until then.

## Verification status
- **Binding ADRs (repo `docs/decisions/`):** `adhd ADR-0001` (every adhd store is multiprocess-enabled, no env toggles, typed-config + `BEGIN IMMEDIATE` + busy-only retry) and `adhd ADR-0002` (correct the source, never work around; use documented extension points). Both constrain this design; neither is violated. ADR-0001 D7/D8 and `sox ADR-0013` ban feature flags — this spec contains **no env-var toggles**.
- **`adhd ADR-0002` D3 §2** names **`sox ADR-0010` open `kind`/`rel` typing** as a legitimate extension point — the taxonomy below is deliberately **open + versioned**, not a frozen enum.
- **Live store unreachable this session** — `memory_ping`/`memory_recall`/`memory_topics` each `-32001` timeout. The figures 1509 `tool-catalog` / 62 `technique-catalog` / 8219 total / 879 communities are **not re-measured here**; taken from backlog body `8d49cac1`. **Re-measure before implementing.**

## Summary
The library is carried entirely in the existing episodic graph — **no new node kinds, no store change.** Two orthogonal axes: a node is either a **LEARNING** (distilled prior art, no first-hand outcome) or a **CASE** (first-hand problem + solution + *verified* outcome); each carries an open **profile** facet as a *tag*, with profile-specific fields in `metadata` and a canonical rendered body in `content`. Retention is a **tag+metadata transition performed by `memory_update` on a single live episode** — the case becomes retrievable only when the verified-outcome mutation adds the eligibility tag. Ranking is a client-side weighted, min-max-normalized blend computed at Retrieve time from fields the recall surface already returns.

---

## (a) Case encoding — topic / tag / metadata / rel conventions

**Node kinds (all native):** `episode` (both CASE and LEARNING), `entity` (auto from tags), `community` (clustering), `claim` (optional principle promotion). Rels writable via `memory_link`: **`SUPPORTS`, `RELATES_TO`, `DERIVED_FROM`, `SUPERSEDES`, `SAME_AS`, `MENTIONS`, `ASSIGNED_TO`** only. `MEMBER_OF`/`PART_OF`/`DEPENDS_ON` exist but are **not in the `memory_link` enum** — not writable.

**topic** = coarse family, exactly one: `case` or `learning`. **Never bucket by facet** — bucketing by `tool-catalog` is the root cause in `8d49cac1`.

**tags** (lowercase, namespaced; every tag has a named retrieve-time reader):

| Tag | Meaning | Reader |
|---|---|---|
| `case:retained` / `learning` | node class | recall `filters.tags` gate |
| `retrieve:case` / `retrieve:learning` | **eligibility** — added *by the retain transition* | recall `filters.tags` (pre-rank hard gate) |
| `case:pending` | draft (Reuse/Revise) | excluded; never eligible |
| `case:success` / `case:failure` / `case:partial` | outcome result | outcome term `o(c)` |
| `case:superseded` / `case:retracted` | demoted | pre-rank exclusion |
| `profile:<name>` | facet extractor | recall filter + tie-break |
| `legacy:tool-catalog` | provenance of migrated rows | migration only |
| `agent:approved` / `agent:blocked` | **deprecated** | must be replaced or wired |

**metadata** (schema-on-read; readers tolerate absence):
```
case:    { state: draft|verified|retracted, profile, schema_version,
           problem, tension, context, solution,
           outcome:{result:success|partial|failure, verified_by, verified_at,
                    evidence_uid|evidence_ref, reuse_count, last_reused_at},
           provenance:{confidence: verified|high|medium|low, anchors:[…],
                        sources:[{url, fetched_at, grade}]} }
learning:{ profile, schema_version, problem, tension, confidence,
           sources:[…], corroboration:{supporting_cases, refuting_cases} }
```

**content** = deterministic canonical render (what BM25/semantic index over; must be byte-stable for content-hash dedup): leading line = the **tension** (the retrieval key, not the content type), then `PROBLEM / CONTEXT / SOLUTION / OUTCOME / PRINCIPLE` sections, **only the sections the profile needs**. LEARNINGS omit `OUTCOME`.

**rel conventions:**

| Relationship | Rel | Notes |
|---|---|---|
| new case replaces old | `SUPERSEDES` (new→old) + tag `case:superseded` | optionally `memory_invalidate(old,{reason,replacement_uid})` |
| near-duplicate | `SAME_AS` | created by async near-dup pipeline; merge via `memory_curate merge_duplicates` / `restore_neardup` |
| association | `RELATES_TO` (+ `meta`) | generic |
| parentage / provenance | `DERIVED_FROM` | adjacent discoveries → seed question; chunks → parent; principle → case |
| case is evidence for learning | `SUPPORTS` (case→learning) | **native** |
| case is evidence against learning | `RELATES_TO` + `meta:{polarity:"refutes"}` **today** | *no native `REFUTES`* → capability #2 |
| case↔principle(claim) | `SUPPORTS` | count = min-case threshold |

**Retire the orphan ranking tags:** `agent:approved`/`agent:blocked` are a *researcher verdict*, not a verified outcome. Replace with `metadata.learning.confidence` + `corroboration`; the consumer is the confidence term `κ(c)`. Any tag left without a reader is deleted.

---

## (b) Retrieval recipes + the scoring function

**Recipe (Retrieve).**
1. Query string = the **tension** in natural language.
2. `memory_recall({ query, filters:{ project_path, tags:["retrieve:case","retrieve:learning"] }, kinds:["episode"], limit:K=40, depth:1 })`. The any-match `tags` filter makes the eligibility gate **server-side**; `case:pending`/`case:superseded` carry neither tag and are excluded before ranking. **Never filter to a single profile** — Retrieve is FAN-IN across all facets.
3. `depth:1` + `memory_related(uid)` expand `SUPPORTS`/`DERIVED_FROM` neighbours for context.
4. Rerank client-side; return top-N = 3–10.
5. Run **before any external search**.

**Pre-rank hard filters (order matters):** drop anything targeted by a live `SUPERSEDES` edge, anything `t_invalid`/merge-collapsed, then de-duplicate by `SAME_AS` component identity (mirrors backlog's tested `dropSupersededResults` — the defect that occurs when the supersede predicate is missing from one rank path).

**Scoring function** (signals min-max normalized *per candidate set* before summing — Park et al. 2023, Generative Agents §A.1):
```
S(c) = w_r·r̂ + w_ρ·ρ̂ + w_o·ô + w_κ·κ̂ + w_ι·ι̂ [+ w_u·û]

r(c)  = 1/(k+rank(c)), k=60                    // RRF, Cormack 2009
ρ(c)  = 0.5^( Δt / H(profile) )                 // Δt = now − t_occurred (fallback t_created)
      H: dependency/tool 90d · process/pattern 365d · paper/none 3y
o(c)  = 1.0 success | 0.5 partial | 0.0 failure | neutral for LEARNING
      ô = o × (1 + δ·log1p(reuse_count))        // LFU fold, δ≈0.05; validate before enabling
κ(c)  = 0.7·conf_map(verified|high|med|low) + 0.3·min(1, |anchors|/3)
ι(c)  = (importance − 1)/9
u(c)  = û (reuse count), optional
```
Weights `w_*` are **typed config per retrieval mode** (ADR-0001 D3 style); default all-1 (the strong baseline); tuned only against an outcome metric. `vstash` (arXiv 2604.15484) found post-RRF frequency/decay and cross-encoder rerank often *fail* to improve NDCG — **every added term is validated against a labeled query set**, not assumed.

**Anti-degradation:** (i) eligibility tag partitions the pool so the dominant facet can't swamp search; (ii) two-stage retrieve-then-rerank caps cost; (iii) decay demotes stale package metrics; (iv) supersession/merge exclusion prevents dead near-dup accumulation; (v) per-facet community routing; (vi) min-case threshold before a principle is promoted.

---

## (c) Lifecycle state machine

```
LEARNING:  proposed ──(case SUPPORTS)──► corroborated ──(case REFUTES*)──► refuted
                └── superseded | merged ──┘

CASE:  draft ──Revise(evidence)──► draft ──verified outcome──► RETAINED
                │                                              ├─ superseded
                └─ verification fails ──► retained(failure)     └─ merged | retracted
```

| Transition | Tool | Mutation (the mint) |
|---|---|---|
| create draft | `memory_write` (topic `case`, tag `case:pending`) | **not retrievable** — no `retrieve:*` tag |
| revise | `memory_write` `derived_from_uid`=draft, `source:"tool_output"` | attaches the real test/exit-code artifact |
| **retain** | `memory_update` on the draft uid | `tags` += `retrieve:case`+`case:success|failure`; `metadata.case.state=verified`; `outcome.verified_by/verified_at`; `t_valid`=now |
| reuse | `memory_update` | `outcome.reuse_count++`, `last_reused_at`=now (feeds ρ and u) |
| supersede | `memory_link(new,old,SUPERSEDES)` (+ optional `memory_invalidate`) | old loses `retrieve:case` |
| merge | `memory_curate merge_duplicates{uid_keep,uid_drop}` / `restore_neardup` | drop invalidated |
| re-verify fails | `memory_update` | `state=retracted`, tag swap |
| reorg trigger | `memory_curate recluster` | **enqueued, not inline** — poll `memory_stats`; filtered recluster for a synchronous facet-subset pass |

**Only the `retrieve:case` tag addition mints a retrievable case.** The pending draft is a work-in-progress record, not a case. Keeps the verified-outcome invariant atomic on one node (no second node to sync under concurrent writers), preserves the full Revise history, avoids corpus inflation. *(Rejected alternative: mint a fresh uid on verify — two-node sync + double-counting.)*

---

## (d) Migration of the 1509 `tool-catalog` episodes

**Recommendation: MIGRATE — as LEARNINGS, dedupe-first.** Not as cases, not quarantined.

Reasoning: (1) they are external prior art with **no first-hand outcome**, so the verified-outcome invariant forbids them entering as cases — but under the two-node model they legitimately *are* learnings and need no outcome; (2) they are the only prior-art corpus we have, so **archiving discards usable knowledge**; (3) leaving them untyped at 24:1 **is** the recall-degradation driver and the starvation bug; (4) migration is mechanical and idempotent.

Steps: scan `memory_topics({search:"tool-catalog"})` → per row `memory_update` to topic `learning`, retag `legacy:tool-catalog` + `profile:dependency|paper`, write a schema-v1 `metadata.learning` envelope with `confidence` from the existing `data_quality`; run `memory_curate near_duplicates` + `merge_duplicates` **before** tagging eligible; only then add `retrieve:learning`. **Per-item fallback = quarantine:** rows that are pure stale download metrics with no reusable tension keep `legacy:tool-catalog` and are never tagged `retrieve:learning`. Bounded, idempotent batches — never one bulk relabel.

> **Supersedes an earlier recommendation of "quarantine"** (agent-manager, prior turn). The architect's argument is stronger: learnings require no outcome, so these fit the model directly, and quarantining our only prior-art corpus is a net loss.

---

## (e) REQUIRED MEMORY-CORE CAPABILITY (separate package change)

Per `adhd ADR-0002` D4/D5 these are **decision requests to the external owner**, not workarounds; the consumer fails loud until ruled. *(Filed: backlog `f4fa3a30`.)*

1. **`memory_recall` per-channel scores / `fields` param** — expose `_semantic_score` + `_bm25_score` so the client can compute true RRF. `memory_recall({…, fields:["_semantic_score","_bm25_score"]})`.
2. **First-class `REFUTES` rel** in `memory_link` (and `MEMBER_OF`/`PART_OF`/`DEPENDS_ON` if hierarchy is to be written). Today refutation rides `RELATES_TO`+`meta`.
3. **Metadata predicate filters** in `memory_recall` — `filters.metadata:{path:"case.outcome.result", in:[…]}` so the verified gate + profile are server-side enforceable.
4. **`memory_claim_upsert`** — create/attach a `claim` node so a promoted PRINCIPLE is a native claim with counted `SUPPORTS`, not an episode proxy.
5. **`memory_count(query|filters)`** — candidate-pool sizing for min-case thresholds / coverage checks without pulling rows.
6. **`include_superseded:false` (default)** or server-side supersession exclusion.
7. **Observable reorg ledger / `recluster --wait`** — `recluster` is enqueued; need a completion signal + a guarantee the periodic pass executes.
8. **Documented per-node CAS** for `memory_update` under concurrent processes (metadata `version` compare-and-set), or confirmation the write path is serialized — to make retain idempotent by construction.

---

## (f) Verification method (end-to-end, real components, teeth)

1. **Seed** 3 LEARNINGS + 3 CASE drafts across ≥3 profiles via the real write protocol.
2. **Gate (negative control):** a tension query with `tags:["retrieve:case"]` must **not** return any `case:pending` draft. Prove teeth: remove the tag gate → the draft *appears*.
3. **Retain proof:** run the technique for real (execute in a scratch package, capture the **process exit code**) → `memory_update` to verified → assert the case ranks top-N.
4. **Concurrency proof (two real OS processes, ADR-0001 D5 shape):** both Retain the *same* logical case (one shared `client_request_id`; a second run with a different id but byte-identical canonical `content`). Assert **exactly one** episode before/after (`memory_count`), zero raw `E_BUSY` reaches the caller, and **trust exit codes, not stdout**. Negative control: bypass dedup → count becomes 2 → RED.
5. **Ranking proof:** inject a superseded duplicate + a stale low-confidence case + a fresh verified high-confidence case answering one tension; assert order = verified/fresh/high-κ first and the superseded node is excluded **before** ranking; negative-control by re-admitting it and asserting order flips.
6. **Idempotency:** replay a write with the same `client_request_id` → assert `replayed:true`, no new episode.
7. **Degradation gate:** fixed labeled query set; measure NDCG@k at size N, then after injecting ~2N distractors into the dominant facet; assert the metric stays within a declared bound (use `@adhd/sox-hybrid-search` `fuseWithBreakdown` for per-channel explainability).
8. **Reorg proof:** filtered `recluster` (synchronous subset) → assert `MEMBER_OF` communities form and supersession exclusion survives.

**Implementation surface:** a new client-side tier `packages/agent/agent-core-cbr` (core; depends on the memory client + `@adhd/sox-hybrid-search`), holding the encoder, the resolver (ADD/UPDATE/DELETE/NOOP read-before-write, Mem0 arXiv 2504.19413), the scorer, and the reorg scheduler.

**Follow-ups requiring owner approval (not written):** this model implies a new `adhd ADR-0003` (case-library storage model) and a `sox`-side decision request for (e). Neither authored.

## Architect-surfaced bugs / deferrals
1. **memory-server unreachable** — `-32001` timeouts; live counts and the 24:1 ratio unverified this session (cited from `8d49cac1`). Re-measure; if reproducible, file against the external memory service.
2. **Backlog uid prefixes in the brief (`23bb4d3b`, `c6fa6614`) do not resolve** — they were superseded; live items are `b3b90b2b`, `8d49cac1`, `58e899b2`.
3. **`agent:approved`/`agent:blocked` have no downstream reader** — retired in (a); migration must strip or wire them.
4. **Missing native `REFUTES`** and **no metadata-filter on `memory_recall`** — required capabilities (e); do not work around.
5. **`recluster` is enqueued, not inline** — reorg verification depends on capability #7.
