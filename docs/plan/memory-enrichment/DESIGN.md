# DESIGN — Deterministic Memory Graph Enrichment
<!-- supersedes the open questions in SPEC.md §4–§8 -->

**Status:** architect-reviewed, decisions locked for API design phase
**Author:** architect-reviewer (agent)
**Date:** 2026-06-22
**Bases:** SPEC.md (same directory); codebase read from `libs/memory-core/src/` and
`extensions/bundles/sox-memory-bundle/members/memory-organizer/`

---

## D0. How to read this document

Each section maps to a SPEC deliverable item. Decisions are marked **DECIDED** with
rationale. Tradeoffs and risks are called out inline. Everything grounded in observed
source is cited `file:line`; conjecture is labeled `[conjecture]`.

---

## D1. Clustering algorithm (SPEC E6)

### D1.1 Current state

`vec_node` holds 768-dim L2-normalized embeddings for every episode node
(`schema.ts:69`). The `community` kind and `MEMBER_OF` relation are in the schema
(`schema.ts:29,57`) but have zero rows today — confirmed by `export.ts:100–108` where
the community lookup falls through to the entity/general fallback in every current run.
The embedding backend is BGE-base-en-v1.5 (real) or FNV-1a hash-projection (hash/auto
fallback) at 768 dims (`embed.ts:34,84`).

### D1.2 Decision: cosine-threshold connected-components, run in JS over fetched vectors

**DECIDED: Cosine-threshold connected-components (single-link)** with a configurable
threshold `τ` (default `τ = 0.82` for real embeddings; `τ = 0.70` for hash backend).

#### Algorithm

```
1. Fetch all live episode rowids + their 768-dim vectors from vec_node.
2. Sort rowids ascending (stable ordering — always the same traversal order).
3. Build a union-find (disjoint-set) structure over rowids.
4. For each pair (i, j) where i < j: compute cosine_sim(v_i, v_j).
   If sim >= τ: union(i, j).
5. Collect root sets → each set is a cluster.
6. Derive label from the cluster's centroid (see D1.4).
7. Upsert community node (uid stable = deterministic hash of sorted member rowids).
8. Delete MEMBER_OF edges for invalidated clusters; insert new ones.
```

#### Why not HDBSCAN

HDBSCAN is a pure-JS or WASM port problem (no mature SQLite-native binding; the only
JS port, `hdbscan-js`, is unmaintained and doesn't support typed arrays). It is also
density-based: on small corpora (<100 nodes) it tends to produce a single "core" cluster
and many noise singletons, which is the worst case for topic discovery. It requires
tuning `min_cluster_size` and `min_samples` and its output is **not** deterministically
ordered across library versions — a hidden non-determinism risk.

#### Why not agglomerative (Ward/average-link)

Agglomerative is correct but requires O(n²) space for the full linkage matrix and no
incremental update path — a full re-cluster on each new write degrades at 10k+ nodes.
Ward linkage also changes cluster membership when a single new node is added far from
any existing cluster, making the label stable but community UIDs unstable.

#### Why not k-means

k-means requires choosing k a priori, is non-deterministic (seeded randomly, different
convergence per run even with seeding in most JS implementations), and is badly suited
to corpora where k is unknown and shifts over time.

#### Why cosine-threshold connected-components

- **Reproducible**: given the same `τ` and the same sorted vector set, the algorithm
  produces the same partition. The community UID is derived from the sorted member
  rowid set (SHA-256 prefix), so it is stable across re-runs when membership is unchanged.
- **Incremental**: a new node only unions with existing roots if `sim >= τ`. Only the
  affected cluster(s) need their community nodes refreshed (see D1.3).
- **O(n²) pairs but cheap in practice**: at 768-dim with L2-normalized vectors, cosine
  sim is a dot product — vectorized in JS with typed arrays, ~2µs/pair. At 1k nodes:
  ~500k pairs ≈ 1 second. At 10k nodes: ~50M pairs ≈ 100s — too slow for synchronous
  write path, but acceptable for a scheduled batch pass (see D4.2).
  At 100k nodes: ~5G pairs — must switch to approximate pre-filtering (see D1.7).
- **No external library**: fully expressible in ~60 lines of TypeScript. No WASM, no
  native bindings, no version lock.
- **Coexists cleanly with `[<topic>]` prefix and user tags** (see D1.5).

### D1.3 Incrementality strategy

For the write-path hot case (a single new episode), run a **local neighborhood check**
instead of a full re-cluster:

```
1. Embed the new episode (already done in write.ts:93).
2. KNN(k=20) against vec_node to find the 20 nearest existing episodes.
3. If any neighbor has sim >= τ: join the new node to that neighbor's community
   (union-find merge, update MEMBER_OF edges, recompute cluster centroid + label).
4. If no neighbor clears τ: create a new singleton community (or leave unclustered
   if singleton communities are suppressed — see D1.6).
5. Invalidate the old community node if membership changed; create a new one with
   a new UID derived from the new sorted member set.
```

Full re-cluster (all pairs) runs as a scheduled batch pass in the daemon loop — see D4.

### D1.4 Label derivation

**Centroid → nearest-member label strategy:**

```
1. Compute the centroid of the cluster (mean of member vectors).
2. Find the member whose embedding is closest (highest cosine sim) to the centroid —
   this is the most "representative" episode.
3. Extract the label from the representative episode:
   a. If it has a `[<topic>]` prefix, use that.
   b. Else use the first 6 words of its content, title-cased and trimmed.
   c. Else use "cluster-<id>" (where id is the 6-char hash prefix of the community uid).
```

This is fully deterministic: the centroid is the arithmetic mean of a sorted member
set, so same members → same centroid → same representative → same label.

**Why not TF-IDF common terms:** TF-IDF requires a corpus vocabulary and is sensitive to
tokenizer choice. It produces multi-word phrases that are often redundant with FTS. The
centroid approach leverages the same embedding model already in use and adds no code
dependency.

### D1.5 Coexistence with `[<topic>]` prefix and tags

Precedence (no conflict — they are layered):

1. `node.topic` is the *authoritative structured topic*. It is set from (in priority
   order): explicit `[<topic>]` prefix (parsed at write time) → cluster label (from E6
   on the batch pass). User-supplied `topic` param overrides both.
2. `MEMBER_OF` → `community` edges are the *graph clustering artifact*. A node can
   have a `topic` without a `MEMBER_OF` edge (content-prefix case on a very new node
   that hasn't been batch-clustered yet), and it can have a `MEMBER_OF` edge whose
   community label differs from `node.topic` (the explicit prefix wins for display,
   but the community structure is retained for graph traversal).
3. Tags (E4) are independent: stored in `node.tags` (JSON array) and as entity
   `MENTIONS` edges. They do not affect clustering; clustering ignores tags.
4. Export (`export.ts`) already reads the prefix first, then community, then entity —
   this priority order is unchanged and consistent with the above.

### D1.6 Singleton communities

Singletons (one-member clusters) are **suppressed** — no community node is created
for isolated episodes. This keeps the community table meaningful. A node with no
community membership falls back to its `node.topic` for display.

### D1.7 Scalability cap

At 100k nodes, O(n²) brute-force is impractical. The plan:

- **Phase 1 (now):** full re-cluster is bounded by a soft cap of 10k nodes per full
  pass; beyond that, only the local neighborhood incremental path runs.
- **Phase 2 (deferred):** pre-filter candidates using an `ivfflat`-style approximate
  search (sqlite-vec supports approximate KNN with index structures as of vec 0.5+) to
  reduce the candidate pair count before the exact cosine threshold check. This is a
  later optimization; mark as a `TODO` in the implementation.

### D1.8 Evaluation of topic quality (deterministic)

Since there is no LLM to assess quality, the metrics are structural:

- **Intra-cluster mean cosine similarity** — higher is more cohesive. Target ≥ τ.
- **Inter-cluster mean separation** — mean cosine sim between cluster centroids.
  Target ≤ τ − 0.1.
- **Cluster count stability** — how many clusters merge/split across successive
  batch passes. A stable corpus should have <5% churn per pass.
- **Coverage** — fraction of nodes that have a community assignment.

These can be computed as a CLI command (`memory-cli cluster-stats`) without any
external oracle.

---

## D2. Determinism of other enrichments (E1–E12)

### E1 — Caller provenance: **fully deterministic**

Capture at write time from `process.cwd()` + `git rev-parse --show-toplevel` (sync,
sub-ms). Store in `node.project_path`. No heuristic involved.

**Risk**: `process.cwd()` is the caller's working directory, not a stable project
identifier across machines or Docker containers. Store as-is; the API layer can
normalize if needed.

### E2 — Client summary: **fully deterministic**

Accept `summary` and `name` from the caller; persist to `node.summary` / `node.name`
(columns already in schema, `schema.ts:31`). Zero heuristic. The `write.ts:103` INSERT
already has these columns but the `WriteParams` interface (`write.ts:25`) does not
expose them — this is the only gap to fix.

### E3 — Arbitrary metadata: **fully deterministic**

`WriteParams.metadata` (`write.ts:34`) exists but is silently dropped — the INSERT at
`write.ts:99` does not include it. Fix: add `node.meta TEXT` column (new), persist
`JSON.stringify(params.metadata)`. `json_extract` queries work on it. No heuristic.

### E4 — Durable tags: **fully deterministic**

Tags are written as entity nodes + MENTIONS edges (`write.ts:119–144`) but the raw
list is not retained. Fix: add `node.tags TEXT` column (JSON array); write alongside
the existing MENTIONS-edge path. No heuristic.

### E5 — Durable topic: **fully deterministic** (with one bounded heuristic)

Parse `[<topic>]` prefix at write time (regex, deterministic). If no prefix, use
cluster label from E6 once it's been computed (populated on batch pass). If neither,
leave null. The regex `^\s*\[([^\]\n]{1,64})\]` is already used in `export.ts:93` —
replicate at write time so `node.topic` is populated on insert when the prefix is present.

### E6 — Embedding clustering: decided above (D1).

### E7 — Importance scoring: **deterministic, but requires redesign**

Current state: default `1.0` at write time (`write.ts:62`), LLM updates it async via
organizer. The organizer's deterministic fallback (`memory-organizer/src/index.ts:197–
221`) uses word-count heuristic, capped at 8 — reasonable for CI, not production-quality.

**DECIDED blend (in-process, no LLM):**

```
importance = clamp(
  α·length_score + β·link_score + γ·access_score + δ·tag_score,
  1.0, 10.0
)

where:
  length_score  = min(content.split(/\s+/).length / 50, 1.0) × 4.0
  link_score    = min((in_degree + out_degree) / 5, 1.0) × 3.0   [computed on batch pass]
  access_score  = min(access_count / 10, 1.0) × 2.0              [updated at recall time]
  tag_score     = min(tags.length / 3, 1.0) × 1.0

α=β=γ=δ=1.0 (weights summing to 10 max)
```

`length_score` is computable at write time (synchronous). `link_score` and
`access_score` require a batch-pass update (link degree requires counting edges; access
is incremented on recall). Initial importance is `length_score + tag_score`, updated
on batch pass and on each recall access.

**This is deterministic** for a fixed DB state. The formula constants are configurable
via a `@sox/memory-enrich` config object (not env vars, to keep testability clean).

**Risk**: link degree is sparse on a new store. Early episodes will have low
`link_score`. This is acceptable: importance rises organically as knowledge grows.

### E8 — Near-duplicate / supersession: **deterministic**

- `content_hash` exact-dup detection already exists (`write.ts:73–84`).
- Semantic near-dup: cosine sim ≥ `τ_dup` (default `0.95`) between a new episode's
  embedding and existing episodes' embeddings (using KNN-20 from vec_node). At that
  similarity the content is semantically equivalent; insert a `SAME_AS` edge and set
  `t_invalid` on the older node (keep the newer one as canonical). This runs on the
  write-path local neighborhood check (same KNN pass as incremental clustering).
- Explicit `SUPERSEDES` is user-asserted via the existing `memoryInvalidate` path
  (`write.ts:179`).

**Risk with τ_dup = 0.95**: under the hash embedding backend, hash vectors from near-
synonymous but distinct content can achieve 0.95+ cosine (the FNV projection compresses
semantic space aggressively). Recommendation: raise `τ_dup` to `0.98` when backend is
`hash`; use `0.95` only when backend is `real`. Detect via `getActiveEmbedModel()`.

### E9 — Auto-links `RELATES_TO`: **deterministic, limited**

`DERIVED_FROM` (chunk→parent) is already in the schema (`schema.ts:57`) but not auto-
emitted. `RELATES_TO` via shared-entity co-occurrence: if two episodes share ≥2 entity
nodes (via `MENTIONS` edges), emit a `RELATES_TO` edge with `weight = shared_count / max_entities`.
This is a pure graph query (no embedding, no LLM). Run on batch pass.

**DERIVED_FROM**: auto-emit only when the caller explicitly passes `derived_from_uid`
in write params — do not auto-derive parenthood heuristically, as it is ambiguous.

**Risk**: `RELATES_TO` on shared entities produces a dense graph when a few high-
frequency entities appear everywhere (e.g. "JavaScript", "TypeScript" in a JS monorepo).
Mitigation: cap at top-5 entities by frequency; exclude entities that appear in >30%
of all episodes (global stoplist computed on batch pass).

### E10 — Extractive summary: **deterministic, quality-limited**

Lead-N strategy: take the first 2 sentences of `content` (sentence boundary: `. `,
`? `, `! ` followed by a capital letter, or a newline). If content < 100 chars, use
it as-is. This is deterministic and fast.

TextRank (graph-based extractive summarization): produces better summaries but requires
building a sentence similarity graph per-node — O(sentences²) per node on the batch
pass. Deferred to Phase 2 (marked TODO); lead-N is the Phase 1 implementation.

**Only applied when no client summary is provided** (E2 takes priority).

### E11 — Maintenance: **deterministic**

Recency decay already exists in `memoryd.ts:231–239`. Access count increment needs
to be added to the recall path (currently `access_count` column exists but
`recall.ts` never updates it — `schema.ts:42`). Fix: single `UPDATE node SET
access_count = access_count + 1, last_access = ? WHERE uid IN (...)` after each recall.

### E12 — Enrichment provenance: **deterministic**

Stamp each new derived field with a `meta` JSON blob on the edge (already present:
`schema.ts:63`, edge has `meta TEXT` and `origin`). For node-level enrichment provenance,
add a `node.enrich_ver TEXT` column: a JSON object `{ "pass": "v1.0.0", "ts": "..." }`.
This is written by the enrichment pipeline, not the caller. Records which enrichment
package version produced each derived field. Updated on re-enrich.

---

## D3. Schema and migration

### D3.1 New columns on `node`

```sql
ALTER TABLE node ADD COLUMN tags          TEXT;   -- JSON string[], e.g. '["auth","jwt"]'
ALTER TABLE node ADD COLUMN topic         TEXT;   -- derived topic string, e.g. "authentication"
ALTER TABLE node ADD COLUMN project_path  TEXT;   -- absolute path of caller repo root
ALTER TABLE node ADD COLUMN meta          TEXT;   -- caller-supplied metadata (JSON object)
ALTER TABLE node ADD COLUMN enrich_ver    TEXT;   -- JSON: { pass, ts } enrichment provenance
```

No normalized tables for tags or provenance in Phase 1. Rationale:

- `node.tags` as JSON: SQLite's `json_each()` allows filter queries without a join table.
  At 100k nodes this avoids a 100k-row `node_tag` join table and the index maintenance
  cost. If per-tag aggregations become a hot path, a covering index
  `ix_node_tags ON node(tags)` plus a generated column can be added without a schema
  migration.
- `node.project_path` as a flat column: the query "all episodes from project X" is
  a simple `WHERE project_path = ?`. No normalization needed at this scale.
- `node.meta` as JSON: `json_extract(meta, '$.key')` is supported natively. Avoids
  a separate EAV table for metadata.

### D3.2 Migration strategy (idempotent)

Run inside the DB init path (`memoryd.ts:MemoryDaemon constructor`, ~line 87) before
DDL. Guard each `ALTER TABLE` with a `pragma table_info` check:

```typescript
function applyMigrations(db: Database): void {
  const cols = db.prepare("PRAGMA table_info('node')").all() as { name: string }[];
  const has = (name: string) => cols.some(c => c.name === name);

  if (!has('tags'))         db.exec("ALTER TABLE node ADD COLUMN tags TEXT");
  if (!has('topic'))        db.exec("ALTER TABLE node ADD COLUMN topic TEXT");
  if (!has('project_path')) db.exec("ALTER TABLE node ADD COLUMN project_path TEXT");
  if (!has('meta'))         db.exec("ALTER TABLE node ADD COLUMN meta TEXT");
  if (!has('enrich_ver'))   db.exec("ALTER TABLE node ADD COLUMN enrich_ver TEXT");
}
```

This is idempotent: run on every startup, no version table needed for this batch of
additions (they are all `NULL`-defaulting). If future migrations are destructive
(column type change, row transforms), add a `schema_ver` bump in `memory_scope` then.

### D3.3 Backfill

On existing stores, all new columns default to `NULL`. Backfill is opportunistic:

- `node.topic`: on the next batch pass, derive from `[<topic>]` prefix or cluster label.
- `node.tags`: cannot be backfilled from entity MENTIONS edges without ambiguity
  (the raw tag list was never stored). Leave `NULL` for pre-migration episodes;
  document this as a known limitation. New writes will populate `tags` going forward.
- `node.project_path`: cannot be backfilled (the call site is gone). Leave `NULL`.
- `node.meta`: cannot be backfilled. Leave `NULL`.
- `node.enrich_ver`: set to `{ "pass": "legacy", "ts": "<migration_ts>" }` on all
  existing episodes during the first batch pass to distinguish pre-enrichment nodes.

Backfill for `topic` and `enrich_ver` runs as a single bulk UPDATE during the first
batch pass cycle (within `memoryd` drain loop; no separate migration CLI needed).

### D3.4 Index additions

```sql
CREATE INDEX IF NOT EXISTS ix_node_topic        ON node(topic)        WHERE topic IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_node_project      ON node(project_path) WHERE project_path IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_node_enrich_ver   ON node(enrich_ver)   WHERE enrich_ver IS NOT NULL;
```

`tags` does not get a B-tree index (JSON blob is not indexable as-is). `json_each()`
with a table scan is acceptable at Phase 1 scale. Add a full-text tag index later if
per-tag queries become hot.

---

## D4. Architecture and removal

### D4.1 Package boundary: `@sox/memory-enrich`

**DECIDED: extract to a new `libs/memory-enrich/` library** (`@sox/memory-enrich`).

Contents:

```
libs/memory-enrich/src/
  provenance.ts       — project_path resolution (cwd → git root)
  importance.ts       — deterministic importance blend (E7)
  neardup.ts          — near-dup cosine check (E8)
  extractive.ts       — lead-N extractive summary (E10)
  cluster.ts          — cosine-threshold connected-components (E6)
  autolink.ts         — RELATES_TO auto-link (E9)
  enrich.ts           — write-path orchestrator (calls provenance, neardup, extractive)
  batch.ts            — batch-pass orchestrator (calls cluster, autolink, importance link+access)
  index.ts            — public API re-export
```

**Why a separate library (not inline in memory-core):**

- Consumed by multiple entry points: `libs/memory-core` (write path), `memory-server`
  (MCP tool write), `memory-cli` (manual trigger), and future tooling.
- Enforces the `@nx/enforce-module-boundaries` rule already in place (`CLAUDE.md` C7):
  `memory-server` cannot reach into `memory-core/src` directly; it must go through
  the `@sox/memory-enrich` public API.
- Keeps `memory-core` focused on storage primitives (schema, write, recall, embed,
  export); enrichment logic is a higher-level concern.
- Makes unit-testing enrichment algorithms trivial (no DB required for most tests).

**memory-core dependency on memory-enrich:**

`write.ts` will call `@sox/memory-enrich`'s `enrichOnWrite(params, db, rowid)` which
is a synchronous or fast-async call covering E1–E5, E8, E10, E12 (write-time
enrichments). `memoryd.ts`'s batch loop will call `runBatchEnrich(db)` which covers E6
(clustering), E7 (link/access score update), E9 (auto-links), E11 (decay).

### D4.2 Two-tier execution model

```
Tier 1: Write-path (synchronous, <5ms target)
  - E1 provenance (cwd + git root, sync)
  - E2 summary / E3 meta / E4 tags (from params, zero cost)
  - E5 topic (parse [<topic>] prefix, sync regex)
  - E8 near-dup local KNN (uses already-computed embedding + KNN-20, sub-ms)
  - E10 extractive summary fallback (lead-N, sync)
  - E12 enrich_ver stamp

Tier 2: Batch pass (daemon loop, periodic/triggered, unbounded)
  - E6 clustering (full or incremental depending on corpus size)
  - E7 link-degree + access importance update
  - E9 RELATES_TO auto-links
  - E11 decay + reindex
```

The existing `organizer_queue` can be repurposed as a batch-trigger queue (rename
`ingest` op → `enrich` op). The `ingest` op currently causes the LLM path in `memoryd.ts:
processIngestBatch` (line 309). After the LLM organizer is removed, this drains into
the deterministic Tier 2 batch.

### D4.3 `memory-daemon` disposition: **retained, repurposed**

The daemon (`memory-daemon` service extension) remains. Its role shifts:

- **Before:** drain `organizer_queue` → call `memory-organizer` LLM → apply results.
- **After:** drain `organizer_queue` → call `@sox/memory-enrich`'s `runBatchEnrich(db)`
  → apply results (all deterministic, no provider calls).

The daemon's socket + lifecycle infrastructure is unchanged. The `organizerFn` callback
in `MemoryDaemon` constructor (`memoryd.ts:79`) is replaced with the deterministic
batch enricher. The `memory-daemon` `extension.json` description is updated to remove
references to LLM/organizer.

**Why not remove the daemon too:** the daemon provides:
1. A singleton write-serializer (prevents concurrent writes from different callers).
2. A durable queue for batch clustering (which can be expensive and should not block
   the write path).
3. The Unix socket health probe (used by `sox list` liveness check).

All three remain valuable without LLM. Removing the daemon would require rehosting
these responsibilities, which is out of scope for this phase.

### D4.4 `memory-organizer` removal checklist

When the deterministic pipeline is implemented and verified, remove in order:

1. `extensions/bundles/sox-memory-bundle/members/memory-organizer/` — entire directory.
2. `sox-memory-bundle/extension.json` `members[]` — remove `{ "id": "memory-organizer", ... }`.
3. `memoryd.ts` — replace `organizerFn` callback type + `processIngestBatch` LLM call
   with `@sox/memory-enrich` batch call. Remove `OrganizerFn` type, `OrganizerItem`,
   `OrganizerResult` exports (if not reused elsewhere).
4. `memory-daemon/extension.json` — remove `requires`/config references to
   `provider_url`/`provider_key`/`MEMORY_PROVIDER_HOST`.
5. `organizer_queue` table: rename `op='ingest'` semantics in code comments; the table
   itself stays (used for batch-enrich ops). Update `schema.ts` DDL comment.
6. Registry entries: remove `memory-organizer` from `extensions/index.json` and any
   install-registry records.
7. All doc references in `docs/`, `CLAUDE.md`, `DOD.md` (change "organizer" to
   "enrichment pipeline" where describing the behavior; leave historical mentions in
   changelogs/audit docs).

**Acceptance criteria:**
- `grep -ri "memory-organizer" extensions/ libs/ apps/ bin/` returns zero results
  (excluding historical docs and changelogs).
- `grep -i "MEMORY_PROVIDER" extensions/ libs/ apps/` returns zero results in active code.
- The bundle installs and `memoryd` runs without any provider configured.
- Enrichment output is byte-reproducible: two runs of `runBatchEnrich` on the same DB
  snapshot produce identical `node.topic`, `MEMBER_OF`, `RELATES_TO` rows.

---

## D5. ML review — risks and mitigations

### D5.1 Embedding quality on small corpora

**Risk:** BGE-base-en-v1.5 produces semantically meaningful embeddings for prose
content (episodes, observations). However, for very short content (<10 words) —
particularly tag-like or command-output episodes — the embedding space is sparse
and cosine similarities are unreliable.

**Mitigation:**
- Do not cluster episodes with `content.length < 50` chars. Leave them as singletons.
- Weight the extractive summary (E10) into the clustering text when available: cluster
  on `content + ' ' + summary` rather than `content` alone to improve embedding quality
  for short episodes.
- Under the hash backend, `τ` is lowered to 0.70 but still produces false positives
  on short content. Add an additional guard: require cluster members to have
  `content.length >= 50` AND at least one `MENTIONS` entity in common for a pair to
  be considered near-dup (E8) when using the hash backend.

### D5.2 Cold-start (empty or near-empty corpus)

**Risk:** with fewer than ~5 episodes, clustering produces no meaningful communities.
A single user who has written 2 episodes will see no community structure.

**Mitigation:**
- Suppress cluster-label assignment when a cluster has only 1 member (D1.6).
- Use `node.topic` from the `[<topic>]` prefix as the display topic regardless of
  cluster assignment. The consumer interface (CONSUMER-INTERFACES.md) must handle
  the `topic IS NOT NULL, MEMBER_OF IS NULL` case gracefully.
- Document as known behavior: communities form once ≥5 semantically related episodes
  exist (approximate threshold for τ=0.82 with real embeddings).

### D5.3 Embedding drift

**Risk:** if `SOX_EMBED_BACKEND` switches between `hash` and `real` (or between
real model versions), existing vec_node rows are incompatible with new vectors —
cosine distances become meaningless.

**Current mitigation:** `memory_scope.embed_model` records the model used
(`schema.ts:20`). A model change triggers a `reindex` op via `enqueueReindex`
(`memoryd.ts:498`).

**Gap:** there is no enforcement that prevents the clustering pass from running on a
mixed-model `vec_node` table (e.g. after a partial reindex that stalled). 

**Recommended fix:** add a guard in `runBatchEnrich` that checks all `vec_node` rows
have been indexed under the current `embed_model` before running the cluster pass.
Use a `node.enrich_ver` check: if any live node has `enrich_ver IS NULL` (pre-enrichment
or pre-reindex), skip the cluster pass and emit a `reindex` queue entry first.

### D5.4 Cluster label instability

**Risk:** when a new high-importance episode is written and becomes the new centroid-
nearest member, the cluster label changes. This would break external references to
a topic by name (e.g. bookmarks, mirror export paths).

**Mitigation:**
- Topic labels in the export use slugified names (`export.ts:60–68`). A label change
  triggers a slug change, which causes the old topic directory to be pruned and a new
  one created. This is intentional (topics should reflect current understanding).
- If label stability is required, expose a `node.topic_override TEXT` column that, if
  set, pins the community's display label regardless of the centroid computation.
  This is a Phase 2 feature; mark as TODO.

### D5.5 Degenerate clustering (single mega-cluster)

**Risk:** if `τ` is too low, all episodes join a single cluster. For the hash backend
with `τ = 0.70` on a technical monorepo, this is plausible (many episodes mention
similar tokens → similar hash vectors).

**Detection (deterministic):** compute `max_cluster_size / total_episodes`. If > 0.5,
the threshold is degenerate. Emit a warning log and skip `MEMBER_OF` edge writes for
the batch (leave existing structure intact, don't overwrite with garbage).

**Mitigation:** raise `τ` adaptively: if the single-cluster ratio > 0.5, increment `τ`
by 0.05 and retry (up to 3 retries, then log and bail).

### D5.6 `RELATES_TO` link explosion

**Risk (noted in D2, E9):** shared-entity co-occurrence can produce O(n²) `RELATES_TO`
edges if a few entities appear in many episodes.

**Mitigation:** entity stoplist + per-entity degree cap:
- Compute the global entity frequency distribution on the batch pass.
- Entities appearing in > 30% of all episodes are added to a per-DB stoplist
  (stored in `memory_scope.meta` as JSON, or in a new `enrich_config` key).
- Cap `RELATES_TO` edges per episode at 10 (highest-weight edges win).

---

## D6. Open questions escalated to API designer

The following decisions are **not resolved in this document** — they are the input to
the API design phase (`CONTRACTS.md`).

1. **`memory_write` parameter surface**: what new fields does the MCP tool accept?
   (`summary`, `name`, `topic`, `tags`, `metadata`, `project_path`, `derived_from_uid`)
   Which are optional vs required? What are the validation rules?

2. **`memory_recall` filter extensions**: how does the caller express
   `project_path = ?`, `topic = ?`, `tags contains ?` in the MCP query interface?
   Filter object structure TBD.

3. **Discovery operations**: `memory_list_topics`, `memory_list_projects`,
   `memory_list_entities` — are these new MCP tools or sub-commands of an existing tool?
   What are the pagination and ordering contracts?

4. **`@sox/memory-enrich` public TypeScript API**: the concrete function signatures,
   parameter shapes, and return types for `enrichOnWrite()`, `runBatchEnrich()`, and
   `ClusterResult`. These are design-constrained by this document but not specified here.

5. **Community node naming convention**: should `community.uid` be the SHA-256 hash of
   sorted member rowids (deterministic but opaque) or a human-readable slug + sequence
   number? The API designer should decide based on whether communities are referenced
   by UID in consumer-facing queries.

6. **Tags filter semantics**: AND-of-tags (all must match) vs OR-of-tags (any match)?
   Both are useful; the default is TBD.

7. **Cross-store project_path queries**: in federated recall, `project_path` is a
   per-store column. How does the federated layer aggregate/filter across stores?
   Does it require the caller to specify which store(s) to search?
