# SCOPE — Memory subsystem decomposition + agent-optimized workspace

**Status:** proposed (input to plan authoring) · **Date:** 2026-06-26
**Companion quickfix:** `docs/plan/memory-embedding-quickfix/SCOPE.md` (do first; repairs the running system).
**Intent:** this SCOPE is the strategic brief a plan-builder turns into an execution-ready
plan-state-machine plan, collaborating with the orchestrator. It is deliberately decision-bearing, not
yet sequenced.

## Goal
Decompose the memory subsystem into **reusable, independently-versioned packages** organized for **agent
discovery/debugging/execution**, with embeddings as a **swappable provider** and a **vector store that
enforces its space invariant** — so the heavy, broadly-useful parts (embeddings, vector index, hybrid
search, graph store) are reusable by other projects / 3rd parties via plain `npm i`, and "memory" shrinks
to its genuinely-unique domain glue.

## Part A — Package decomposition (`memory-core`/`memory-enrich` dissolve)
Extract along verb/substrate seams (each independently reusable, no "memory" in its name):
- **`embedding-provider`** — text→vector; model **resolution** (config-driven swap); runtime; exposes
  `embed(text)→Float32Array` (+ batch `string[]→async generator`) + `{providerId, modelId, dim,
  isDeterministic, isRemote}`. The **deterministic variant lives here as a first-class provider** (where
  the BL-86 degeneracy fix goes), not a scattered fallback. Loud-fail: resolver throws if the configured
  real provider can't load.
  **Multi-model + multi-context from the gate (owner directive):** the contract is designed + implemented
  to be valid for BOTH **local** (in-process) and **remote** (network) providers — async, batch-first, no
  in-process assumptions. Ship **≥3 local fastembed models spanning dims** now (e.g. bge-small 384,
  bge-base 768, e5-large 1024) — real + tested — to prove the interface is genuinely model-agnostic AND
  to force `dim` parameterization (see invariant). Implement a **remote provider adapter against the same
  contract but NOT wired to a live/paid endpoint** (typed reference impl; no F3 spend, not live-tested) —
  enough to prove context-agnosticism, not to incur remote cost.
- **`vector-store`** — `vec0` persistence + kNN/cosine; **enforces the space invariant** (rejects a
  vector whose `dim`/`modelId` ≠ the column's). Owns per-record `modelId` (→ BL-88 provenance).
- **`graph-store`** — bi-temporal nodes+edges + content-hash + FTS-sync.
- **`hybrid-search`** — the vec+BM25+temporal-decay fusion ranker (generic IR).
- **`analysis`** — clustering, near-dup, importance/link-scoring (batch derivation). **Clustering runs in
  pure JS, in-process — NOT a SQLite extension:** read vectors out of vector-store → cluster via an
  existing JS lib (`density-clustering`/`hdbscanjs`), don't hand-roll DBSCAN/HDBSCAN. The package's value
  is the deterministic, zero-LLM, `modelId`-provenance-aware *integration*, not reimplementing the algorithm.
- **`ingest`** — write-path single-item transforms (content-hash, extractive-summary, tagging, future
  chunk/normalize).
- **memory domain** = what remains (session-state, scope/promotion policy, the `memory_*` tool surface)
  — composes the above; ships as the existing extensions/bundle, NOT a primitive package.

**Hard invariant:** `modelId`+`dim` define the vector space — models cannot mix in one space; a model
switch is a **re-embed migration** (the explicit upgrade path), gated by comparing each record's
`modelId` to the configured one.

## Part B — Workspace layout + existing-tooling migration (generator is EXTERNAL)
**Re-scoped (2026-06-26):** a separate team is building the nx workspace generator that hooks all
generation + enforces standards. So this plan does **NOT build the generator** — it (1) **defines the
layout standard** and hands it off (`docs/plan/memory-refactor/NX-GENERATOR-HANDOFF.md`), (2) **consumes**
that generator, and (3) uses **`scripts/scaffold-data-packages.mjs`** to pre-create the new `data/*`
package skeletons so executors don't scaffold by hand. This plan's own work is **establishing the future
layout + migrating the existing tooling/code into it efficiently.**

Two-level `area/group/package` layout (so nx module-boundary tags enforce `data/* ↛ platform/*`):
- **`platform/`** — `contract`(manifest) · `distribution`(install-engine+registry — resolves their real
  `build-index` overlap) · `host`(host-registry) · `runtime`(host-runtime+service-proxy) ·
  `protocol`(mcp-runtime) · `authoring` · `devtools`(sox-nx)
- **`data/`** — `embed` · `inference`(reserved) · `vectors` · `graph` · `store`(reserved) · `search` ·
  `analysis` · `ingest`
- **`shared/`** — `codec`(tokenguard-core)

Layout standard (the contract both the external generator and the scaffold script honor — full detail in
the handoff packet): place under `libs/<area>/<group>/<name>/`; stamp `area:*`+`group:*` nx tags +
`sox:{area,group,concerns,invariants,entrypoints}` metadata; **published npm name decoupled from path**
(a rename breaks the content-address/registry contract). Module-boundary depConstraints:
`data→data|shared`, `platform→platform|shared`, `shared→shared`.

**Publish posture — 5 PUBLIC / 1 PRIVATE (refines F1; governed by ADR-0006; revised 2026-06-26 on
external use-case demand — `USE_CASES.md` SYS-1..10).** **PUBLIC = `embedding-provider`, `vector-store`,
`graph-store`, `hybrid-search`, `analysis`** (public@0.x, publish owner-gated). **PRIVATE = `ingest`**
(`private:true`, never published — no use case pulled it; thinnest). graph-store + analysis were
**promoted** because real consumer systems require them (catalog/notes/agent-memory → graph-store;
dedup/clustering/drift → analysis). **Since graph-store + vector-store are public, `hybrid-search`
depends on them as normal public deps — it no longer bundles them.** `analysis` depends on a JS
clustering lib + (public) `vector-store`/`graph-store`. The **bundle-a-private-dep** rule (ADR-0006)
still stands for any future private dep, but has **no active instance** in this refactor now (nothing
public depends on `ingest`; only the private memory domain does). Live objects (DB connection, provider,
vectors) still cross via **DI** over shared externalized native deps — decision C unchanged.

**Removed from this plan's scope:** building the `--area`/`--group` generator (now the external team's).
This plan consumes it + the scaffold script; its migration states relocate existing libs into the layout
and extract `data/*` from `memory-core`/`memory-enrich`.

## Part C — Agent-optimized decision-routing (layered)
- **Generated routing index** (`map.json`+`INDEX.md`, root + per-area) — discovery; harvested from the
  nx graph + per-package `sox:{area,group,concerns,invariants}` metadata; **generated with a drift gate**
  (never hand-maintained — mirror-drift is a proven failure here).
- **Hierarchical authored CLAUDE.md** (root→area→group) — execution rules + footguns; auto-scoped by cwd.
- **Impact graph** (GitNexus + `nx affected`) — debugging/blast-radius.
- **Soft project memory** (sox-memory) — learned lessons recalled at task time; advisory, never gating
  (must not depend on embedding health).
- **Intent→scope `ROUTER.md`** — hand-curated "if doing X go to Y" for top task types incl. cross-cutting.

## Part D — Research-informed design constraints (workflow-researcher findings)
Folded from persisted research (memory uids `01KW2CC69129D16M8X7Q27DA83`, `01KW2E1N4NG5V4K8W59ABQJF66`,
`01KW2FNQGPCYPEKNTB5J0WEMRQ`, `01KW2G95V61N31TEV6PKN7JJWK`; topic `hybrid-search-api-design`). These
sharpen the `data/*` package contracts and bound what to build NOW vs later.

**`embedding-provider`**
- Expose a **batch** embed API (`string[] → async generator of Float32[]`, default batchSize 256) in
  addition to single — `fastembed-js` (the runtime the quickfix wires in) solves serial-inference; a
  per-query single embed is the N×latency footgun.
- Optional `queryEmbed` (query-optimized) + a **startup Map cache** for hot/topic embeddings.
- Models are bundled-ONNX; **ship ≥3 spanning dims (384/768/1024) from the gate** so the interface is
  validated against >1 model and `dim` is provably parameterized. The contract is **local‖remote-agnostic**
  (async, batch, `isRemote`); the remote provider is a contract-conformant adapter, not a live/paid impl.
- **`dim` parameterization is now MANDATORY, not latent:** with a 384 and a 1024 model in the suite, the
  legacy hard-coded `vec0 FLOAT[768]` MUST be derived from the active provider's `dim` (the latent bug the
  plan flagged becomes a real failure the moment a non-768 model is exercised).

**`vector-store`**
- **Don't build ANN now.** `sqlite-vec` brute-force is sub-ms at <50K rows; the dominant cost is
  batch×multi-field scan *count*, not the scan. Quantization (`sqlite-vector`, ~17× at 100K) is the first
  scale lever; true ANN (`usearch` HNSW + `simsimd` SIMD, via NAPI) is a **deferred Phase-1+** at 50K+.
- Design the store with a **pluggable similarity-backend seam** so brute-force→quantized→ANN is a swap,
  not a rewrite. Keep the per-record `modelId` + space invariant (Part A).

**`hybrid-search`** (richer than "the recall ranker" — this is its design spec)
- **Normalize before combining** (min_max / L2 / z_score); **multiplicative** field boosting, never
  additive (additive is scale-blind). Multi-field weights (topic 2.0 / tags 1.5 / name 1.2 / summary 1.0
  / content 1.0 as defaults).
- **FTS5 `bm25(col_weights)` + rank config collapses N per-field BM25 queries to 1**; two-phase
  FTS5→exact-rescore avoids O(rows×batch×fields) scans; RRF / max-score normalization avoids full-scan
  stats.
- **Batch queries with shared-filter optimization** (evaluate a common filter once); **cross-query
  dedup via a `matched_queries` count** is a *novel* extension (no production system does it) — a
  differentiator, mark experimental. **Opt-in `explain`** only (per-field breakdown off by default).
- Implicit **topic boost** (score query vs topic names; lift matching topics) — Weaviate named-vector
  pattern.
- **Must degrade to BM25/FTS when vectors are unavailable** (the degraded-embedding survivability rule).

**Phased scale roadmap (explicit non-goals NOW):** Phase 0 = pure-JS FTS5 + sqlite-vec (current,
<50K) — *this refactor targets Phase 0*; Phase 1 = usearch + worker-threads (~50K); Phase 2 = simsimd +
optional GPU sidecar (~200K); Phase 3 = Tantivy BM25 (~500K). The plan should leave **seams** for these,
not build them. (Open research gaps the researcher flagged: non-JS embedding runtimes, optimal candidate
window, Bayesian-BM25 Node port, libSQL migration, SQLite batch-filter reuse.)

## Decisions to resolve (orchestrator + plan-builder)
1. Grouping vocabulary: confirm `platform`/`data`/`shared` + the group set above (vs the store/search or
   inference/retrieval variants analysed).
2. `--group` flat vs two-level (recommended: two-level for boundary tags).
3. `embed` vs `inference` split naming (recommended: keep both, output-is-a-vector rule).
4. Defer `knowledge` group until a 2nd member exists (recommended: yes).
5. Re-embed/migration UX (script vs daemon op vs both) + provenance schema (per-record `modelId`).
6. Default embedding backend policy (recommended: `real`-enforced, opt-in hash).
7. Sequencing vs the quickfix (quickfix lands first; refactor extracts its changes cleanly).

## Financial-impact flags (escalate before committing)
- **Publishing more public `@adhd` packages** (6–8 new) = ongoing supply-chain + semver/maintenance
  surface (one-way door per package). Decide which are public SDK vs internal.
- **Native prebuild matrix / CI compute** for onnxruntime-node + better-sqlite3 across Node×OS×arch.
- **Any remote/paid embedding-provider option** (if `inference`/remote providers are in scope) = a real
  recurring-cost decision — do NOT add a paid provider path without explicit owner sign-off.

## Non-goals
The quickfix's runtime repair (separate); changing the memory domain's external tool contract; OS-kernel
sandboxing; rewriting host-runtime lifecycle (governed by its own spec).
