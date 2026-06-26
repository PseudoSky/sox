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
  `embed(text)→Float32Array` + `{providerId, modelId, dim, isDeterministic}`. The **deterministic
  variant lives here as a first-class provider** (where the BL-86 degeneracy fix goes), not a scattered
  fallback. Loud-fail enforcement: resolver throws if the configured real provider can't load.
- **`vector-store`** — `vec0` persistence + kNN/cosine; **enforces the space invariant** (rejects a
  vector whose `dim`/`modelId` ≠ the column's). Owns per-record `modelId` (→ BL-88 provenance).
- **`graph-store`** — bi-temporal nodes+edges + content-hash + FTS-sync.
- **`hybrid-search`** — the vec+BM25+temporal-decay fusion ranker (generic IR).
- **`analysis`** — clustering, near-dup, importance/link-scoring (batch derivation).
- **`ingest`** — write-path single-item transforms (content-hash, extractive-summary, tagging, future
  chunk/normalize).
- **memory domain** = what remains (session-state, scope/promotion policy, the `memory_*` tool surface)
  — composes the above; ships as the existing extensions/bundle, NOT a primitive package.

**Hard invariant:** `modelId`+`dim` define the vector space — models cannot mix in one space; a model
switch is a **re-embed migration** (the explicit upgrade path), gated by comparing each record's
`modelId` to the configured one.

## Part B — Workspace reorg (`area/group`, `--group` generator)
Two-level `area/group/package` layout (recommended over flat) so nx module-boundary tags enforce
direction (`data/*` may not import `platform/*`):
- **`platform/`** — `contract`(manifest) · `distribution`(install-engine+registry — resolves their real
  `build-index` overlap) · `host`(host-registry) · `runtime`(host-runtime+service-proxy) ·
  `protocol`(mcp-runtime) · `authoring` · `devtools`(sox-nx)
- **`data/`** — `embed` · `inference`(future) · `vectors` · `graph` · `store`(future) · `search` ·
  `analysis` · `ingest`
- **`shared/`** — `codec`(tokenguard-core)
Generator `--group` (and `--area`): place under the folder, stamp `area:*`+`group:*` nx tags
(boundary lint), keep the **published npm name decoupled from path** (a rename breaks the
content-address/registry contract).

## Part C — Agent-optimized decision-routing (layered)
- **Generated routing index** (`map.json`+`INDEX.md`, root + per-area) — discovery; harvested from the
  nx graph + per-package `sox:{area,group,concerns,invariants}` metadata; **generated with a drift gate**
  (never hand-maintained — mirror-drift is a proven failure here).
- **Hierarchical authored CLAUDE.md** (root→area→group) — execution rules + footguns; auto-scoped by cwd.
- **Impact graph** (GitNexus + `nx affected`) — debugging/blast-radius.
- **Soft project memory** (sox-memory) — learned lessons recalled at task time; advisory, never gating
  (must not depend on embedding health).
- **Intent→scope `ROUTER.md`** — hand-curated "if doing X go to Y" for top task types incl. cross-cutting.

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
