# CONTRACTS — Deterministic Memory Graph Enrichment
<!-- API contracts for the enrichment system; authored from SPEC.md + DESIGN.md + CONSUMER-INTERFACES.md -->

**Status:** draft — ready for implementation phase review
**Author:** api-designer (agent)
**Date:** 2026-06-22
**Bases:** SPEC.md, DESIGN.md, CONSUMER-INTERFACES.md (same directory); codebase read from
`extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts`,
`libs/memory-core/src/write.ts`, `libs/memory-core/src/recall.ts`, `libs/memory-core/src/index.ts`

---

## C0. Document conventions

- **E#** — enrichment from SPEC.md §4.
- **UC#** — use case from CONSUMER-INTERFACES.md §CI2–CI11.
- **D#.#** — decision from DESIGN.md.
- **MODIFIED** — existing tool/type with changed signature (backward-compat notes inline).
- **NEW** — net-new tool or type not present today.
- **REMOVED** — surface that disappears on `memory-organizer` removal.
- All TypeScript types in this document are the *contract*; implementation must match them.
- JSON Schema in `inputSchema` blocks follows JSON Schema Draft-07 (MCP convention).
- Optional fields with no `default` key default to `undefined`/absent.

---

## C1. `@sox/memory-enrich` package API

**Package location:** `libs/memory-enrich/` (new library, `@sox/memory-enrich`).
**Consumed by:** `libs/memory-core` (write path), `memory-server` (MCP tool write/batch),
`memory-cli` (manual trigger). See DESIGN.md D4.1.

### C1.1 Canonical node type

Used as input to all enrichment functions and as the return shape from DB reads.

```typescript
// libs/memory-enrich/src/types.ts

/** Minimum node fields required by enrichment functions. */
export interface EnrichableNode {
  rowid: number;
  uid: string;
  content: string;
  /** Pre-enrichment: may be null. Post-E10: populated. */
  summary: string | null;
  /** Pre-enrichment: may be null. Post-E5: populated. */
  topic: string | null;
  /** Pre-enrichment: may be null. Post-E4: JSON string array. */
  tags: string | null;
  /** Pre-enrichment: may be null. Post-E1: populated. */
  project_path: string | null;
  /** Pre-enrichment: may be null. Post-E3: JSON object. */
  meta: string | null;
  /** Pre-enrichment: may be null. Post-E12: JSON { pass, ts }. */
  enrich_ver: string | null;
  importance: number;
  agent_id: string | null;
  session_id: string | null;
  t_created: string;
  t_invalid: string | null;
}

/** Enrichment provenance stamp written by every pass (E12). */
export interface EnrichmentProvenance {
  /** Semver of @sox/memory-enrich that produced this. e.g. "1.0.0" */
  pass: string;
  /** ISO timestamp of enrichment run. */
  ts: string;
  /** Optional: "legacy" for pre-enrichment nodes backfilled on first batch. */
  note?: string;
}
```

### C1.2 Write-path orchestrator: `enrichOnWrite`

Covers E1–E5, E8 (near-dup local KNN), E10 (extractive summary fallback), E12.
Runs synchronously in the write transaction (target: <5 ms). Does NOT run E6, E7
link-score, or E9 (batch-only).

```typescript
// libs/memory-enrich/src/enrich.ts

import type { Database } from 'better-sqlite3';

export interface EnrichOnWriteParams {
  /** Raw write params as supplied by the caller (post-insert, pre-enrichment). */
  uid: string;
  rowid: number;
  content: string;
  /** Caller-supplied summary (E2). If present, no extractive fallback runs. */
  summary: string | undefined;
  /** Caller-supplied tags array (E4). */
  tags: string[] | undefined;
  /** Caller-supplied topic override (E5 priority 1). */
  topic: string | undefined;
  /** Caller-supplied metadata (E3). */
  metadata: Record<string, unknown> | undefined;
  /** Caller-supplied project_path override (E1 priority 1).
   *  If omitted, auto-detected from cwd + git root. */
  project_path: string | undefined;
  /** Explicit parent UID for DERIVED_FROM edge (E9). */
  derived_from_uid: string | undefined;
  /** 768-dim embedding vector already computed by the write path. */
  embedding: Float32Array;
}

export interface EnrichOnWriteResult {
  /** Final topic stored (may be from prefix, caller override, or null). */
  topic: string | null;
  /** Final project_path stored (auto-detected or caller-supplied). */
  project_path: string | null;
  /** Final summary stored (E2 caller-supplied or E10 extractive fallback). */
  summary: string | null;
  /** Resolved tags array (stored as JSON on node.tags). */
  tags: string[];
  /** Enrichment provenance stamp (E12). */
  enrich_ver: EnrichmentProvenance;
  /** Near-dup detection result (E8). null = no dup found. */
  near_dup: NearDupResult | null;
}

/**
 * Run write-time enrichments (E1–E5, E8, E10, E12) on an already-inserted node.
 *
 * Determinism guarantees:
 * - Given the same params and DB state, produces identical output.
 * - No LLM, no external provider, no async I/O except the KNN query.
 * - Side effects: UPDATE node SET topic=?, project_path=?, summary=?, tags=?, enrich_ver=?
 *   and INSERT SAME_AS edge if near-dup found.
 *
 * @param db   Open better-sqlite3 Database (write-capable).
 * @param p    Write params including pre-computed embedding.
 * @returns    EnrichOnWriteResult describing what was stored.
 */
export function enrichOnWrite(
  db: Database,
  p: EnrichOnWriteParams,
): EnrichOnWriteResult;
```

**Execution tier:** Tier 1 (write-path synchronous, <5 ms). Called from `write.ts` inside
the existing write transaction (or immediately after, as a single UPDATE).

**Integration point in write.ts:** after the `INSERT INTO node` + `INSERT INTO vec_node`
block, before `enqueueIngest`, add `enrichOnWrite(db, { ...params, uid, rowid, embedding: embeddingVec })`.
The `enqueueIngest` call is subsequently renamed `enqueueEnrich` (DESIGN.md D4.2) and routes
to the batch enricher, not the LLM organizer.

### C1.3 Batch-pass orchestrator: `runBatchEnrich`

Covers E6 (clustering), E7 (link-degree + access importance update), E9 (RELATES_TO auto-links),
E11 (decay). Runs in the daemon batch loop (Tier 2).

```typescript
// libs/memory-enrich/src/batch.ts

import type { Database } from 'better-sqlite3';

export interface BatchEnrichOptions {
  /** Cosine similarity threshold for clustering (default 0.82 real, 0.70 hash). */
  clusterThreshold?: number;
  /** Near-dup threshold for SAME_AS edges (default 0.95 real, 0.98 hash). */
  nearDupThreshold?: number;
  /** Maximum episodes per full cluster pass (default 10000; soft cap per D1.7). */
  clusterNodeCap?: number;
  /** Importance blend weights (default: all 1.0, max sum = 10). */
  importanceWeights?: ImportanceWeights;
  /** Entity stoplist coverage threshold; entities in > this fraction of episodes are excluded
   *  from RELATES_TO linking (default 0.30). */
  entityStoplistThreshold?: number;
}

export interface ImportanceWeights {
  /** Weight on length_score (default 1.0). */
  length: number;
  /** Weight on link_score (default 1.0). */
  link: number;
  /** Weight on access_score (default 1.0). */
  access: number;
  /** Weight on tag_score (default 1.0). */
  tag: number;
}

export interface BatchEnrichResult {
  /** Number of community nodes created or updated (E6). */
  communities_upserted: number;
  /** Number of MEMBER_OF edges inserted or refreshed (E6). */
  member_of_edges: number;
  /** Number of nodes whose importance was updated (E7). */
  importance_updated: number;
  /** Number of RELATES_TO edges inserted (E9). */
  relates_to_edges: number;
  /** Number of nodes whose topic was backfilled from cluster label (E5 batch). */
  topics_backfilled: number;
  /** Number of nodes whose enrich_ver was set to "legacy" (first-pass backfill). */
  legacy_nodes_stamped: number;
  /** Whether the cluster pass was skipped due to the degenerate-cluster guard (D5.5). */
  cluster_pass_skipped: boolean;
  /** If skipped: the reason string. */
  cluster_skip_reason?: string;
}

/**
 * Run batch enrichments (E6, E7 link/access, E9, E11) over the entire live corpus.
 *
 * Determinism guarantees:
 * - Given the same DB state and options, produces identical output.
 * - Stable community UIDs: uid = sha256(sorted member rowids).slice(0,32).
 * - Degenerate-cluster guard: if max_cluster/total > 0.5, raises threshold by 0.05
 *   up to 3 retries; if still degenerate, skips MEMBER_OF writes (D5.5).
 * - Mixed-model guard: if any live node has enrich_ver IS NULL, skips cluster pass
 *   and enqueues a reindex op first (D5.3).
 *
 * @param db   Open better-sqlite3 Database (write-capable).
 * @param opts Optional tuning parameters.
 * @returns    BatchEnrichResult with counts of all mutations made.
 */
export function runBatchEnrich(
  db: Database,
  opts?: BatchEnrichOptions,
): BatchEnrichResult;
```

**Execution tier:** Tier 2 (daemon batch loop). Called from `memoryd.ts` in the drain loop
after `enqueueEnrich` op is dequeued (replacing `processIngestBatch` LLM branch).

### C1.4 Provenance resolution: `resolveProjectPath`

```typescript
// libs/memory-enrich/src/provenance.ts

/**
 * Resolve the caller's project root path (E1).
 *
 * Resolution order:
 *   1. If `override` is supplied and non-empty, use it as-is.
 *   2. Run `git rev-parse --show-toplevel` synchronously in `process.cwd()`.
 *      On success, use the trimmed stdout.
 *   3. If git fails (not a repo), use `process.cwd()`.
 *
 * Determinism: for a fixed `process.cwd()` and repo state, always returns the
 * same string. Side-effect free.
 *
 * @param override  Caller-supplied project_path (from write params); skips detection.
 * @returns         Absolute path string, or null if cwd resolution itself throws.
 */
export function resolveProjectPath(override?: string): string | null;
```

### C1.5 Importance scoring: `computeImportance`

```typescript
// libs/memory-enrich/src/importance.ts

export interface ImportanceInputs {
  /** Content word count. */
  word_count: number;
  /** In-degree + out-degree edge count (0 at write time; updated on batch). */
  link_degree: number;
  /** Cumulative recall access count. */
  access_count: number;
  /** Number of user-asserted tags. */
  tag_count: number;
}

/**
 * Compute a deterministic importance score in [1.0, 10.0] (E7, DESIGN D2 E7).
 *
 * Formula (weights configurable; defaults yield max=10):
 *   length_score  = min(word_count / 50, 1.0) × 4.0
 *   link_score    = min(link_degree / 5, 1.0) × 3.0
 *   access_score  = min(access_count / 10, 1.0) × 2.0
 *   tag_score     = min(tag_count / 3, 1.0) × 1.0
 *   raw           = α·length_score + β·link_score + γ·access_score + δ·tag_score
 *   importance    = clamp(raw, 1.0, 10.0)
 *
 * where α=β=γ=δ=1.0 unless overridden by weights param.
 * Deterministic: same inputs → same output.
 */
export function computeImportance(
  inputs: ImportanceInputs,
  weights?: Partial<ImportanceWeights>,
): number;
```

### C1.6 Near-duplicate detection: `detectNearDup`

```typescript
// libs/memory-enrich/src/neardup.ts

import type { Database } from 'better-sqlite3';

export interface NearDupResult {
  /** UID of the existing near-duplicate episode. */
  existing_uid: string;
  /** Cosine similarity between the new episode and the existing one. */
  cosine_sim: number;
  /** Whether the new episode should be invalidated (true if sim >= nearDupThreshold). */
  should_invalidate: boolean;
}

/**
 * Check if a newly-written episode has a semantic near-duplicate in the store (E8).
 *
 * Uses the KNN-20 result from vec_node to find the closest existing episode.
 * Compares cosine similarity against `threshold`.
 *
 * Determinism: for a fixed DB state and embedding, always returns the same result.
 * Thresholds: 0.95 for real backend; 0.98 for hash backend (D2 E8).
 * Hash-backend guard: when backend=hash, also requires content.length >= 50 AND
 *   at least one shared MENTIONS entity before treating as near-dup (D5.1).
 *
 * @param db        Open better-sqlite3 Database (read-only safe).
 * @param rowid     Rowid of the just-inserted episode.
 * @param embedding 768-dim embedding of the new episode.
 * @param threshold Cosine threshold (caller supplies the backend-appropriate value).
 * @returns         NearDupResult if a dup is found above threshold, else null.
 */
export function detectNearDup(
  db: Database,
  rowid: number,
  embedding: Float32Array,
  threshold: number,
): NearDupResult | null;
```

### C1.7 Extractive summary: `extractiveSummary`

```typescript
// libs/memory-enrich/src/extractive.ts

/**
 * Produce an extractive summary of content (E10, DESIGN D2 E10).
 *
 * Phase 1 strategy: lead-N sentences (2 sentences).
 * Sentence boundary: `.`, `?`, `!` followed by whitespace + capital letter, or newline.
 * If content < 100 chars: return content as-is.
 * Only applied when no caller summary is provided (E2 takes priority).
 *
 * Determinism: same input → same output. Pure function, no DB, no I/O.
 *
 * TODO (Phase 2): replace lead-N with TextRank per D2 E10.
 */
export function extractiveSummary(content: string): string;
```

### C1.8 Clustering: `clusterStore`

```typescript
// libs/memory-enrich/src/cluster.ts

import type { Database } from 'better-sqlite3';

export interface ClusterResult {
  /** Stable UID = sha256(sorted member rowids as hex-joined string).slice(0,32). */
  community_uid: string;
  /** Human-readable label (D1.4: centroid-nearest member label). */
  label: string;
  /** Rowids of member episodes. Sorted ascending. */
  member_rowids: number[];
  /** Mean cosine similarity of all member pairs (quality metric per D1.8). */
  mean_intra_sim: number;
  /** Rowid of the centroid-nearest member (used to derive label). */
  centroid_rowid: number;
}

export interface ClusterStoreOptions {
  /** Cosine threshold τ (default 0.82 for real embeddings, 0.70 for hash). */
  threshold?: number;
  /** Soft cap on nodes per full pass (default 10000; D1.7). */
  nodeCap?: number;
  /** If true, only run local neighborhood check for new nodes rather than full re-cluster. */
  incrementalOnly?: boolean;
}

export interface ClusterStoreResult {
  clusters: ClusterResult[];
  /** Whether the full O(n²) pass was run (false if nodeCap exceeded or incrementalOnly). */
  full_pass: boolean;
  /** Count of episodes with no cluster assignment (singletons, suppressed per D1.6). */
  unclustered_count: number;
}

/**
 * Run cosine-threshold connected-components clustering over all live episodes (E6, D1).
 *
 * Determinism guarantees:
 * - Rowids are sorted ascending before traversal (stable ordering, D1.2).
 * - Community UID = sha256(sorted member rowids joined by ','). Same members → same UID.
 * - Label derived from centroid-nearest member (D1.4). Same members → same label.
 * - Singletons suppressed (D1.6): no community node for 1-member clusters.
 * - Episodes with content.length < 50 chars are excluded from clustering (D5.1).
 * - Degenerate guard: if max_cluster_size / total > 0.5, retries with threshold+0.05
 *   up to 3 times, then skips writes and returns clusters=[] (D5.5).
 *
 * Side effects: upserts community nodes + MEMBER_OF edges in `db`.
 *
 * @param db   Open better-sqlite3 Database (write-capable).
 * @param opts Tuning parameters.
 * @returns    ClusterStoreResult with all cluster descriptors.
 */
export function clusterStore(
  db: Database,
  opts?: ClusterStoreOptions,
): ClusterStoreResult;
```

### C1.9 Auto-links: `buildAutoLinks`

```typescript
// libs/memory-enrich/src/autolink.ts

import type { Database } from 'better-sqlite3';

export interface AutoLinkResult {
  /** Number of RELATES_TO edges inserted. */
  edges_inserted: number;
  /** Entity UIDs that were added to the per-DB stoplist this pass (> 30% threshold). */
  stoplist_additions: string[];
}

/**
 * Emit RELATES_TO edges for episode pairs sharing >= 2 entity nodes (E9, D2 E9).
 *
 * Stoplist: entities present in > entityStoplistThreshold (default 0.30) of episodes
 * are excluded. Stoplist stored in memory_scope.meta JSON under key "entity_stoplist".
 * Per-episode cap: max 10 RELATES_TO edges (highest weight wins, D5.6).
 *
 * Determinism: for a fixed DB state, always produces the same edge set.
 * Only inserts edges that don't already exist (idempotent).
 *
 * @param db                       Open better-sqlite3 Database.
 * @param entityStoplistThreshold  Fraction of episodes above which an entity is muted.
 */
export function buildAutoLinks(
  db: Database,
  entityStoplistThreshold?: number,
): AutoLinkResult;
```

### C1.10 Cluster quality stats: `clusterStats`

```typescript
// libs/memory-enrich/src/cluster.ts  (same file as clusterStore)

export interface ClusterStats {
  cluster_count: number;
  total_clustered: number;
  total_unclustered: number;
  mean_intra_sim: number;
  /** Mean cosine sim between cluster centroids. */
  mean_inter_sim: number;
  largest_cluster_size: number;
  /** Fraction of all live episodes that have a MEMBER_OF assignment. */
  coverage: number;
}

/**
 * Compute structural quality metrics for the current cluster state (D1.8).
 * Read-only: no DB writes.
 */
export function clusterStats(db: Database): ClusterStats;
```

### C1.11 Package version export

```typescript
// libs/memory-enrich/src/index.ts

export const ENRICH_VERSION: string; // e.g. "1.0.0"
```

This value is written into `node.enrich_ver.pass` on every enrichment pass (E12). The version
follows semver; a breaking change to the enrichment algorithm increments the major version and
triggers re-enrichment detection (UC10).

---

## C2. MCP tool contracts

### Versioning baseline

The existing 7 tools (`memory_ping`, `memory_write`, `memory_recall`, `memory_search_entities`,
`memory_get_session_state`, `memory_save_session_state`, `memory_get_community`, `memory_invalidate`,
`memory_link`) are considered **v0** (no explicit version). The enrichment additions introduce
**v1** of the tool surface, signaled by `memory_stats` returning `{ tool_version: "1.0.0" }`.

Backward compatibility: all new fields on existing tools are **optional**. Callers omitting
new fields see identical behavior to v0. No required field is removed. New tools are additive.

The MCP server's `serve()` call version bumps from `"0.1.0"` to `"1.0.0"` when this lands.

---

### C2.1 `memory_write` — MODIFIED

**Changes from v0:**
- New optional inputs: `name`, `topic`, `project_path`, `derived_from_uid`.
- Existing `summary` and `tags` already accepted; `summary` is now persisted to `node.summary`
  (v0 silently dropped it in some paths — confirmed it is passed through in current code at
  `write.ts:110` but `WriteParams` already declares it; the gap is persistence via `enrichOnWrite`).
- Existing `metadata` already accepted by `WriteParams` and persisted as `metaJson` at
  `write.ts:71` — this is fixed in v0 code. `enrichOnWrite` copies it to `node.meta`.
- `importance` remains accepted (user-set importance is respected; batch pass skips re-scoring
  if `enrich_ver` contains `"user_override": true`).

**Traces:** E1 (`project_path`), E2 (`summary`, `name`), E3 (`metadata`), E4 (`tags`), E5 (`topic`), E9 (`derived_from_uid`).

```json
{
  "name": "memory_write",
  "description": "Write a memory episode. Runs deterministic enrichment synchronously (provenance, tags, topic, near-dup, extractive summary). Returns {episode_uid}. Batch enrichments (clustering, auto-links, importance link-score) run asynchronously in the daemon.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "content":          { "type": "string", "description": "The content to memorize. Required." },
      "db_path":          { "type": "string", "description": "Path to the .db file." },
      "summary":          { "type": "string", "description": "(E2) Human-readable summary. Persisted to node.summary; no extractive fallback runs if supplied." },
      "name":             { "type": "string", "description": "(E2) Title/name for this episode (node.name)." },
      "topic":            { "type": "string", "description": "(E5) Explicit topic override. Stored to node.topic; takes priority over [<topic>] prefix and cluster label." },
      "tags":             { "type": "array", "items": { "type": "string" }, "description": "(E4) Concept/entity tags. Persisted as node.tags JSON array AND as entity nodes + MENTIONS edges." },
      "metadata":         { "type": "object", "additionalProperties": true, "description": "(E3) Arbitrary caller metadata persisted as node.meta JSON. Queryable via json_extract." },
      "project_path":     { "type": "string", "description": "(E1) Caller project root path. Auto-detected from cwd+git if omitted." },
      "derived_from_uid": { "type": "string", "description": "(E9) UID of a parent episode; emits a DERIVED_FROM edge from this episode to parent." },
      "session_id":       { "type": "string" },
      "t_occurred":       { "type": "string", "description": "ISO timestamp when this occurred." },
      "agent_id":         { "type": "string" },
      "source":           { "type": "string", "enum": ["message", "tool_output", "observation", "document", "reflection", "import"] },
      "importance":       { "type": "number", "minimum": 1, "maximum": 10, "description": "User-asserted importance (1–10). If supplied, batch enricher will not overwrite it." },
      "chunk_size":       { "type": "number", "default": 500, "description": "Approximate tokens per chunk for auto-splitting." }
    },
    "required": ["content", "db_path"]
  }
}
```

**Output shape (success):**
```typescript
{
  episode_uid: string;
  /** Present when content was split into multiple chunks. */
  chunk_uids?: string[];
  chunk_count?: number;
  /** Enrichment fields resolved at write time. */
  enrichment?: {
    topic: string | null;
    project_path: string | null;
    summary: string | null;
    tags: string[];
    near_dup: { existing_uid: string; cosine_sim: number } | null;
  };
}
```

**Output shape (dedup):** unchanged from v0 — `{ code: "E_DEDUP", existing_uid: string }`.

**Backward compat note:** callers not passing the new fields see identical v0 behavior. The
`enrichment` field in the response is always present in v1 but its sub-fields may be null.

---

### C2.2 `memory_recall` — MODIFIED

**Changes from v0:**
- New optional `filters` object (project_path, topic, tags, importance_min, t_created_after,
  t_created_before).
- `query` relaxed to optional (null/empty = importance-ranked listing per UC7).
- Result items gain enrichment fields: `summary`, `topic`, `tags`, `project_path`,
  `is_superseded`, `supersedes_uid`, `community_uid`.

**Traces:** UC1 (`project_path` filter), UC5 (cross-project), UC7 (`query` optional), UC8 (`is_superseded`).

```json
{
  "name": "memory_recall",
  "description": "Recall memories using hybrid vec+BM25+temporal search, filtered by provenance, topic, or tags. query may be omitted for importance-ranked listing. <50ms, zero LLM.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query":        { "type": "string", "description": "Semantic query text. If absent or empty, returns importance-ranked results (no vec/FTS, sorted by importance DESC)." },
      "db_path":      { "type": "string" },
      "scope":        { "type": "string", "description": "Store scope name: project/user/org/local." },
      "agent_id":     { "type": "string" },
      "as_of":        { "type": "string", "description": "ISO timestamp for point-in-time recall." },
      "token_budget": { "type": "number", "default": 4000 },
      "depth":        { "type": "number", "default": 1 },
      "limit":        { "type": "number", "default": 10 },
      "filters": {
        "type": "object",
        "description": "Optional filter object. All fields are Phase 1 unless marked TODO.",
        "properties": {
          "project_path": {
            "oneOf": [
              { "type": "string", "description": "Exact match on node.project_path." },
              { "type": "object", "properties": { "prefix": { "type": "string" } }, "required": ["prefix"], "description": "Prefix match: node.project_path LIKE 'prefix/%'." }
            ]
          },
          "topic":           { "oneOf": [{ "type": "string" }, { "type": "array", "items": { "type": "string" } }], "description": "Exact topic string or array of topics (OR semantics)." },
          "tags":            { "type": "array", "items": { "type": "string" }, "description": "Any-match: episodes that have at least one of these tags. AND-match opt-in: set tags_match_all=true." },
          "tags_match_all":  { "type": "boolean", "default": false, "description": "If true, episode must have ALL tags in the tags array." },
          "importance_min":  { "type": "number", "description": "Only return episodes with importance >= this value." },
          "t_created_after": { "type": "string", "description": "ISO timestamp; only episodes created after this." },
          "t_created_before":{ "type": "string", "description": "ISO timestamp; only episodes created before this." }
        }
      }
    },
    "required": ["db_path"]
  }
}
```

**Output shape (v1 result item — superset of v0):**
```typescript
interface RecallResultV1 {
  uid: string;
  content: string | null;
  score: number;
  t_valid: string | null;
  scope: string;
  provenance: string[];
  importance: number;
  content_hash: string | null;
  agent_id: string | null;
  // New in v1:
  summary: string | null;
  topic: string | null;
  tags: string[];
  project_path: string | null;
  is_superseded: boolean;
  supersedes_uid: string | null;
  community_uid: string | null;
}

interface RecallResponseV1 {
  results: RecallResultV1[];
  provider_call_count: number;
}
```

**Backward compat note:** new fields are additive on the result items. Existing callers
that only read `uid`/`content`/`score` are unaffected.

---

### C2.3 `memory_topics` — NEW

**Traces:** UC2 (topic discovery), UC7 (topic summary card).

```json
{
  "name": "memory_topics",
  "description": "List topics in the memory store with episode counts and cluster backing status. Use before memory_recall to discover valid topic filters.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "db_path":      { "type": "string" },
      "project_path": { "type": "string", "description": "Filter to topics that have at least one episode from this project_path." },
      "search":       { "type": "string", "description": "Partial topic name substring filter." },
      "sort_by":      { "type": "string", "enum": ["episode_count", "avg_importance", "last_written"], "default": "episode_count" },
      "limit":        { "type": "number", "default": 20, "maximum": 200 },
      "offset":       { "type": "number", "default": 0 }
    },
    "required": ["db_path"]
  }
}
```

**Output shape:**
```typescript
interface TopicEntry {
  topic: string;
  episode_count: number;
  avg_importance: number;
  last_written: string;       // ISO timestamp
  /** UID of the embedding-derived community backing this topic, if any (E6). */
  community_uid: string | null;
  /** True if backed by a MEMBER_OF community cluster (not just [<topic>] prefix). */
  has_community: boolean;
}

interface MemoryTopicsResponse {
  topics: TopicEntry[];
  total: number;
}
```

---

### C2.4 `memory_list_projects` — NEW

**Traces:** UC1 (project listing / discovery), UC5 (cross-project discovery).

```json
{
  "name": "memory_list_projects",
  "description": "List distinct project_path values present in the store, with episode counts.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "db_path": { "type": "string" },
      "limit":   { "type": "number", "default": 20, "maximum": 200 },
      "offset":  { "type": "number", "default": 0 }
    },
    "required": ["db_path"]
  }
}
```

**Output shape:**
```typescript
interface ProjectEntry {
  project_path: string;
  episode_count: number;
  last_written: string;   // ISO timestamp of most recent episode
}

interface MemoryListProjectsResponse {
  projects: ProjectEntry[];
  total: number;
}
```

---

### C2.5 `memory_list_entities` — MODIFIED (replaces/extends `memory_search_entities`)

**Changes from v0:** adds `project_path` filter, `topic` filter, returns `mention_count`,
`first_seen`, `last_seen`. The existing tool `memory_search_entities` is **retained unchanged**
for backward compat. `memory_list_entities` is the enrichment-aware discovery variant.

**Traces:** UC3 (entity list discovery), UC5 (shared entity exploration).

```json
{
  "name": "memory_list_entities",
  "description": "List entity nodes ranked by mention count. Use for entity vocabulary discovery. For lookup by name/type, use memory_search_entities.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "db_path":      { "type": "string" },
      "project_path": { "type": "string", "description": "Only count episodes from this project_path." },
      "topic":        { "type": "string", "description": "Only count episodes in this topic." },
      "search":       { "type": "string", "description": "Substring filter on entity name." },
      "limit":        { "type": "number", "default": 20, "maximum": 200 },
      "offset":       { "type": "number", "default": 0 }
    },
    "required": ["db_path"]
  }
}
```

**Output shape:**
```typescript
interface EntityEntry {
  uid: string;
  name: string;
  mention_count: number;
  first_seen: string;    // ISO timestamp
  last_seen: string;     // ISO timestamp
}

interface MemoryListEntitiesResponse {
  entities: EntityEntry[];
  total: number;
}
```

---

### C2.6 `memory_get_community` — MODIFIED

**Changes from v0:** returns enrichment-aware fields (label, member_count, mean_intra_sim).
Old interface accepted `entity_uid`; v1 also accepts `community_uid` directly.

**Traces:** UC2 (community membership graph view).

```json
{
  "name": "memory_get_community",
  "description": "Get a community node (embedding-derived cluster) and its members.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "db_path":       { "type": "string" },
      "entity_uid":    { "type": "string", "description": "Resolve community for this episode/entity UID (via MEMBER_OF edge)." },
      "community_uid": { "type": "string", "description": "Fetch a community directly by its UID." },
      "level":         { "type": "number", "default": 0 }
    },
    "required": ["db_path"]
  }
}
```

**Open question OQ-1:** `entity_uid` and `community_uid` are mutually exclusive but the schema
does not express this with `oneOf`. Implementation should return an error if both are supplied
and treat `community_uid` as taking precedence. Consider adding a `discriminator` in a later
revision.

**Output shape:**
```typescript
interface CommunityNode {
  uid: string;
  label: string;
  member_count: number;
  mean_intra_sim: number;
  centroid_episode_uid: string;
  t_created: string;
}

interface CommunityMember {
  uid: string;
  summary: string | null;
  topic: string | null;
  importance: number;
  t_created: string;
  project_path: string | null;
  tags: string[];
}

interface MemoryGetCommunityResponse {
  community: CommunityNode;
  members: CommunityMember[];
}
```

**Backward compat note:** the v0 response `{ community: { uid, name, summary, level } }` is
replaced. The `name` field maps to `label`. Callers reading `name` will need to read `label` in v1.
This is a **minor breaking change** on `memory_get_community` only. Callers should be updated.

---

### C2.7 `memory_entity_episodes` — NEW

**Traces:** UC3 (episodes mentioning an entity).

```json
{
  "name": "memory_entity_episodes",
  "description": "Return episodes that mention a given entity (via MENTIONS edge), ranked by importance.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "db_path":     { "type": "string" },
      "entity_uid":  { "type": "string", "description": "UID of the entity node." },
      "entity_name": { "type": "string", "description": "Name of the entity (resolved to UID if entity_uid not supplied)." },
      "limit":       { "type": "number", "default": 20, "maximum": 200 },
      "offset":      { "type": "number", "default": 0 }
    },
    "required": ["db_path"]
  }
}
```

**Open question OQ-2:** `entity_uid` and `entity_name` are mutually exclusive in intent;
`entity_name` resolution should be case-insensitive exact match, returning an error if multiple
entities share the same name. Implementation team to decide on disambiguation behavior.

**Output shape:**
```typescript
interface MemoryEntityEpisodesResponse {
  entity: { uid: string; name: string };
  episodes: EpisodeSummary[];
  total: number;
}

// EpisodeSummary is the standard result item (see C3.1 below).
```

---

### C2.8 `memory_related` — NEW

**Traces:** UC3 (related episodes graph traversal).

```json
{
  "name": "memory_related",
  "description": "Return neighbor episodes of a given episode at depth=1 via graph edges (RELATES_TO, DERIVED_FROM, SUPPORTS, SAME_AS).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "db_path":  { "type": "string" },
      "uid":      { "type": "string", "description": "UID of the source episode." },
      "rel":      { "type": "array", "items": { "type": "string" }, "description": "Filter by relation type(s). Default: all live relation types." },
      "limit":    { "type": "number", "default": 20, "maximum": 100 }
    },
    "required": ["db_path", "uid"]
  }
}
```

**Output shape:**
```typescript
interface RelatedEdge {
  episode: EpisodeSummary;
  rel: string;
  weight: number;
  direction: "outbound" | "inbound";
}

interface MemoryRelatedResponse {
  source_uid: string;
  edges: RelatedEdge[];
}
```

---

### C2.9 `memory_supersession_chain` — NEW

**Traces:** UC8 (temporal history of a claim).

```json
{
  "name": "memory_supersession_chain",
  "description": "Return the supersession chain for an episode: what it supersedes and what supersedes it. Enables temporal belief-evolution tracking.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "db_path": { "type": "string" },
      "uid":     { "type": "string", "description": "Any episode UID in the chain." }
    },
    "required": ["db_path", "uid"]
  }
}
```

**Output shape:**
```typescript
interface SupersessionLink {
  uid: string;
  t_created: string;
  t_invalid: string | null;
  /** Reason string from SUPERSEDES edge.meta, if present. */
  reason: string | null;
}

interface MemorySupersessionChainResponse {
  /** The canonical (current) episode in the chain. */
  canonical_uid: string;
  /** Ordered oldest-first chain of all versions. */
  chain: SupersessionLink[];
  /** Whether the queried uid is the current canonical version. */
  is_current: boolean;
}
```

---

### C2.10 `memory_near_duplicates` — NEW

**Traces:** UC9 (near-duplicate management), UC6 (curation feed).

```json
{
  "name": "memory_near_duplicates",
  "description": "List near-duplicate episode pairs connected by SAME_AS edges. Use for manual deduplication review.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "db_path":      { "type": "string" },
      "project_path": { "type": "string" },
      "topic":        { "type": "string" },
      "threshold":    { "type": "number", "description": "Minimum cosine similarity. Default: 0.95 (real backend), 0.98 (hash backend). The server uses the active backend's default if omitted." },
      "limit":        { "type": "number", "default": 20, "maximum": 200 },
      "offset":       { "type": "number", "default": 0 }
    },
    "required": ["db_path"]
  }
}
```

**Output shape:**
```typescript
interface NearDupPair {
  uid_a: string;
  uid_b: string;
  cosine_sim: number;
  /** First 120 chars of episode A content. */
  content_preview_a: string;
  /** First 120 chars of episode B content. */
  content_preview_b: string;
  /** Whether uid_b has already been invalidated (SAME_AS + t_invalid set). */
  already_merged: boolean;
}

interface MemoryNearDuplicatesResponse {
  pairs: NearDupPair[];
  total: number;
}
```

---

### C2.11 `memory_curate` — NEW

**Traces:** UC6 (curation: merge, retag, promote/demote, set topic, force re-cluster).

```json
{
  "name": "memory_curate",
  "description": "Curation operations: retag, set topic, override importance, merge near-duplicates, or trigger a re-cluster pass.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "db_path":    { "type": "string" },
      "op": {
        "type": "string",
        "enum": ["retag", "set_topic", "set_importance", "merge_duplicates", "recluster"],
        "description": "The curation operation to perform."
      },
      "uid":        { "type": "string", "description": "Target episode UID (required for retag, set_topic, set_importance)." },
      "tags":       { "type": "array", "items": { "type": "string" }, "description": "(retag) Tags to add. Additive; duplicates are ignored." },
      "topic":      { "type": "string", "description": "(set_topic) New topic string. Overrides cluster-derived topic." },
      "importance": { "type": "number", "minimum": 1, "maximum": 10, "description": "(set_importance) User-asserted importance. Batch enricher will not overwrite this." },
      "uid_keep":   { "type": "string", "description": "(merge_duplicates) UID of the episode to keep as canonical." },
      "uid_drop":   { "type": "string", "description": "(merge_duplicates) UID of the episode to invalidate as a duplicate." },
      "dry_run":    { "type": "boolean", "default": false, "description": "If true, return proposed changes without committing them." }
    },
    "required": ["db_path", "op"]
  }
}
```

**Output shape (by op):**
```typescript
// retag
interface CurateRetagResult {
  op: "retag";
  uid: string;
  tags_added: string[];
  new_entity_uids: string[];
}

// set_topic
interface CurateSetTopicResult {
  op: "set_topic";
  uid: string;
  old_topic: string | null;
  new_topic: string;
}

// set_importance
interface CurateSetImportanceResult {
  op: "set_importance";
  uid: string;
  old_importance: number;
  new_importance: number;
}

// merge_duplicates
interface CurateMergeResult {
  op: "merge_duplicates";
  uid_kept: string;
  uid_dropped: string;
  same_as_edge_uid: string;
  dry_run: boolean;
}

// recluster
interface CurateReclusterResult {
  op: "recluster";
  enqueued: boolean;
}
```

**Open question OQ-3:** `dry_run` on `recluster` is undefined — re-cluster is a background op
and has no immediate mutation to preview. Implementation should return `{ op: "recluster", enqueued: false, dry_run: true }` without enqueuing. Document this behavior.

---

### C2.12 `memory_stats` — NEW

**Traces:** UC10 (enrichment health and introspection), UC2 (cluster stats).

```json
{
  "name": "memory_stats",
  "description": "Return enrichment coverage and cluster quality statistics. Use for health checks and CI gates.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "db_path":      { "type": "string" },
      "project_path": { "type": "string", "description": "Scope stats to episodes from this project." }
    },
    "required": ["db_path"]
  }
}
```

**Output shape:**
```typescript
interface MemoryStatsResponse {
  tool_version: string;            // e.g. "1.0.0" — signals v1 surface is present
  enrich_version: string;          // current @sox/memory-enrich ENRICH_VERSION
  embed_model: string;
  total_episodes: number;
  with_topic: number;
  with_summary: number;
  with_tags: number;
  with_project_path: number;
  with_community: number;
  /** Episodes where enrich_ver IS NULL or enrich_ver.note = "legacy". */
  legacy_episodes: number;
  /** Episodes where enrich_ver.pass < current ENRICH_VERSION (stale, need re-enrich). */
  stale_episodes: number;
  cluster_count: number;
  largest_cluster_size: number;
  mean_intra_cluster_sim: number;
  coverage: number;                // fraction of episodes with community assignment
  cluster_quality: ClusterStats;   // full ClusterStats from C1.10
}
```

---

### C2.13 `memory_enrich_trigger` — NEW

**Traces:** UC10 (re-enrich trigger), UC6 (force re-cluster).

```json
{
  "name": "memory_enrich_trigger",
  "description": "Enqueue enrichment operations for stale or specified episodes.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "db_path":  { "type": "string" },
      "op":       { "type": "string", "enum": ["reenrich_stale", "reenrich_uids", "recluster_full"], "description": "reenrich_stale: all episodes where enrich_ver is stale. reenrich_uids: specific episodes. recluster_full: full O(n²) cluster pass." },
      "uids":     { "type": "array", "items": { "type": "string" }, "description": "(reenrich_uids) Specific episode UIDs to re-enrich." }
    },
    "required": ["db_path", "op"]
  }
}
```

**Output shape:**
```typescript
interface MemoryEnrichTriggerResponse {
  op: string;
  enqueued: number;
}
```

---

### C2.14 Existing tools: no-change summary

The following 5 tools are **unchanged** in contract. New optional fields on `memory_write` and
`memory_recall` are backward-compatible. These tools are preserved as-is:

| Tool | Status | Notes |
|------|--------|-------|
| `memory_ping` | unchanged | No schema changes. |
| `memory_search_entities` | unchanged | Use `memory_list_entities` (C2.5) for enrichment-aware listing. |
| `memory_get_session_state` | unchanged | No enrichment fields on session nodes. |
| `memory_save_session_state` | unchanged | No enrichment fields on session nodes. |
| `memory_invalidate` | unchanged | Supersession chain now surfaced via `memory_supersession_chain`. |
| `memory_link` | unchanged | `SAME_AS` added to `rel` enum (see C2.14.1). |

#### C2.14.1 `memory_link` `rel` enum addition

`SAME_AS` is added to the allowed `rel` enum for `memory_link`. This is additive and does
not break existing callers. The complete v1 `rel` enum is:
`["MENTIONS", "SUPPORTS", "RELATES_TO", "DERIVED_FROM", "SUPERSEDES", "SAME_AS", "ASSIGNED_TO"]`.

---

## C3. Schema/types contract

### C3.1 `EpisodeSummary` — standard result item

Every list/discovery operation returns episodes using this shape (per CONSUMER-INTERFACES.md CI12.3).

```typescript
// libs/memory-enrich/src/types.ts

export interface EpisodeSummary {
  uid: string;
  content: string | null;
  summary: string | null;
  topic: string | null;
  tags: string[];              // empty array if node.tags IS NULL
  project_path: string | null;
  importance: number;
  t_created: string;
  agent_id: string | null;
  is_superseded: boolean;      // t_invalid IS NOT NULL AND EXISTS SUPERSEDES edge pointing here
  supersedes_uid: string | null; // UID this episode explicitly supersedes, if any
  community_uid: string | null;  // community the episode belongs to, if clustered
}
```

### C3.2 `NodeV1` — full node type with all enrichment columns

```typescript
// libs/memory-enrich/src/types.ts

/** Full node row shape post-migration. Matches the node table schema after D3.1 migration. */
export interface NodeV1 {
  rowid: number;
  uid: string;
  kind: 'episode' | 'entity' | 'community' | 'session' | 'chunk';
  name: string | null;
  content: string | null;
  summary: string | null;
  content_hash: string | null;
  importance: number;
  access_count: number;
  agent_id: string | null;
  session_id: string | null;
  source: string | null;
  t_created: string;
  t_occurred: string | null;
  t_valid: string | null;
  t_invalid: string | null;
  last_access: string | null;
  resume_state: string | null;
  level: number | null;
  // Enrichment columns (new in v1, nullable for pre-migration rows):
  tags: string | null;          // JSON string[]; parse with JSON.parse
  topic: string | null;
  project_path: string | null;
  meta: string | null;          // JSON Record<string, unknown>; parse with JSON.parse
  enrich_ver: string | null;    // JSON EnrichmentProvenance
}
```

### C3.3 `CommunityNodeV1` — community row type

```typescript
// libs/memory-enrich/src/types.ts

/** Community node as stored in the node table (kind='community'). */
export interface CommunityNodeV1 {
  rowid: number;
  uid: string;          // sha256(sorted member rowids) prefix (D1.2)
  kind: 'community';
  name: string | null;  // label (D1.4)
  summary: string | null;
  level: number;
  t_created: string;
  t_invalid: string | null;
  // Enrichment columns on community nodes:
  meta: string | null;  // JSON: { mean_intra_sim, centroid_rowid, member_count }
  enrich_ver: string | null;
}
```

**Open question OQ-4:** Community quality metrics (`mean_intra_sim`, `centroid_rowid`,
`member_count`) are stored in `community.meta` (a JSON blob). DESIGN does not define a
normalized `community_stats` table. Implementation should document the exact JSON key names.
Proposed: `{ "mean_intra_sim": number, "centroid_rowid": number, "member_count": number }`.

### C3.4 `EnrichmentProvenance` — `enrich_ver` column shape

```typescript
// libs/memory-enrich/src/types.ts (already in C1.1 — reproduced here for completeness)

export interface EnrichmentProvenance {
  pass: string;         // semver of @sox/memory-enrich, e.g. "1.0.0"
  ts: string;           // ISO timestamp of enrichment run
  note?: string;        // "legacy" for pre-migration nodes; "user_override" if importance is locked
}
```

`enrich_ver` is serialized as `JSON.stringify(EnrichmentProvenance)` and stored in `node.enrich_ver TEXT`.

### C3.5 `WriteParams` v1 — updated lib type

The `WriteParams` interface in `libs/memory-core/src/write.ts` gains three new optional fields
to match the MCP tool's enrichment-aware input:

```typescript
// libs/memory-core/src/write.ts — additions to WriteParams

export interface WriteParams {
  content: string;
  summary?: string | undefined;
  name?: string | undefined;           // NEW (E2 title)
  topic?: string | undefined;          // NEW (E5 override)
  project_path?: string | undefined;   // NEW (E1 override; auto-detected if absent)
  derived_from_uid?: string | undefined; // NEW (E9 explicit DERIVED_FROM)
  session_id?: string | undefined;
  t_occurred?: string | undefined;
  agent_id?: string | undefined;
  source?: 'message' | 'tool_output' | 'observation' | 'document' | 'reflection' | 'import' | undefined;
  metadata?: Record<string, unknown> | undefined;
  importance?: number | undefined;
  scope?: string | undefined;
  tags?: string[] | undefined;
}
```

### C3.6 SQL query patterns for enrichment fields

These are the query conventions the implementation must follow (not SQLite-dialect proposals;
these are confirmed to work with better-sqlite3 + SQLite 3.45+):

```sql
-- Filter by exact project_path
WHERE project_path = :project_path

-- Filter by project subtree (prefix match)
WHERE project_path = :exact OR project_path LIKE :prefix_pattern
-- :prefix_pattern = project_path_value || '/%'

-- Filter by topic (single)
WHERE topic = :topic

-- Filter by tags ANY-match (json_each)
WHERE EXISTS (
  SELECT 1 FROM json_each(tags) WHERE value = :tag
)

-- Filter by tags ALL-match (json_each, AND semantics)
WHERE (
  SELECT COUNT(*) FROM json_each(tags) WHERE value IN (:tag1, :tag2)
) = :required_tag_count

-- Filter stale enrichment (enrich_ver pass < current version)
-- Implementation note: semver comparison in SQL is non-trivial.
-- Recommendation: filter by enrich_ver IS NULL OR json_extract(enrich_ver, '$.pass') != :current_ver
WHERE enrich_ver IS NULL
   OR json_extract(enrich_ver, '$.pass') IS NULL
   OR json_extract(enrich_ver, '$.pass') != :current_enrich_version

-- json_extract on meta
WHERE json_extract(meta, '$.source_url') = :url
```

**Open question OQ-5:** The `tags` filter performance at >50k nodes with `json_each` table
scans is untested. DESIGN.md D3.4 deferred a FTS tag index. The implementation team should
benchmark this and add a covering index if needed before the first production deploy at scale.

---

## C4. Discovery interfaces

### C4.1 Paginated list contract (applies to all list operations)

All discovery tools (`memory_topics`, `memory_list_projects`, `memory_list_entities`,
`memory_near_duplicates`) follow this pattern:

```typescript
// Inputs (enforced by inputSchema):
interface PaginationParams {
  limit: number;   // default 20, max 200
  offset: number;  // default 0 (page-based; cursor not used in Phase 1)
}

// All list responses carry:
interface PagedResponse<T> {
  items: T[];   // named field varies by tool (topics/projects/entities/pairs)
  total: number; // total matching rows (without limit/offset)
}
```

**Phase 1:** offset-based pagination. Cursor-based pagination deferred to Phase 2 (marked TODO).
Rationale: all list operations are on bounded, indexed columns with low cardinality (topics,
projects, entities). Offset pagination is adequate at Phase 1 scale.

### C4.2 Filter composition

All query operations accept a consistent subset of the `filters` object defined in C2.2.
Each tool's `inputSchema` declares which filter fields it accepts. The minimum set for
Phase 1 across all tools is: `project_path` (exact), `topic` (exact), `tags` (any-match).

### C4.3 `list_topics` query shape

```sql
SELECT
  topic,
  COUNT(*) AS episode_count,
  AVG(importance) AS avg_importance,
  MAX(t_created) AS last_written,
  (
    SELECT n2.uid FROM node n2
    JOIN edge e ON e.dst = n2.rowid AND e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
    WHERE n2.kind = 'community' AND e.src IN (
      SELECT rowid FROM node WHERE topic = t.topic AND t_invalid IS NULL
    )
    LIMIT 1
  ) AS community_uid
FROM node t
WHERE kind = 'episode' AND t_invalid IS NULL AND topic IS NOT NULL
GROUP BY topic
ORDER BY episode_count DESC
LIMIT :limit OFFSET :offset
```

### C4.4 `list_projects` query shape

```sql
SELECT
  project_path,
  COUNT(*) AS episode_count,
  MAX(t_created) AS last_written
FROM node
WHERE kind = 'episode' AND t_invalid IS NULL AND project_path IS NOT NULL
GROUP BY project_path
ORDER BY last_written DESC
LIMIT :limit OFFSET :offset
```

### C4.5 Cluster stats query

Used by `memory_stats` and `clusterStats()`:

```sql
-- cluster_count, total_clustered
SELECT COUNT(DISTINCT n.uid) AS cluster_count
FROM node n
WHERE n.kind = 'community' AND n.t_invalid IS NULL;

SELECT COUNT(*) AS total_clustered
FROM edge e
JOIN node src ON src.rowid = e.src AND src.kind = 'episode' AND src.t_invalid IS NULL
WHERE e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL;

-- largest_cluster_size
SELECT MAX(member_count) FROM (
  SELECT COUNT(*) AS member_count
  FROM edge
  WHERE rel = 'MEMBER_OF' AND t_invalid IS NULL
  GROUP BY dst
);
```

---

## C5. Removal contract

### C5.1 Surfaces that disappear when `memory-organizer` is removed

| Surface | Type | Where | Notes |
|---------|------|-------|-------|
| `extensions/bundles/sox-memory-bundle/members/memory-organizer/` | Directory | extension source | Entire agent extension deleted. |
| `members[].id = "memory-organizer"` | Config field | `sox-memory-bundle/extension.json` | Entry removed from `members[]`. |
| `MEMORY_PROVIDER_URL` env var | Config key | `memory-daemon/extension.json` `requires` block | Removed; no replacement. |
| `MEMORY_PROVIDER_KEY` env var | Config key | `memory-daemon/extension.json` `requires` block | Removed; no replacement. |
| `MEMORY_PROVIDER_HOST` env var | Config key | `memory-daemon/extension.json` | Removed. |
| `OrganizerFn` type | TypeScript export | `libs/memory-core/src/memoryd.ts` | Removed if not reused. |
| `OrganizerItem` type | TypeScript export | `libs/memory-core/src/memoryd.ts` | Removed; see note below. |
| `OrganizerResult` type | TypeScript export | `libs/memory-core/src/memoryd.ts` | Removed. |
| `processIngestBatch` LLM branch | Code path | `memoryd.ts` | Replaced with `runBatchEnrich(db)` call. |
| `organizerFn` constructor param | API | `MemoryDaemon` constructor | Replaced with deterministic batch enricher. |
| `op='ingest'` semantics | Queue op | `organizer_queue` table comment | Renamed to `op='enrich'` in code comments + DDL comment in `schema.ts`. |
| Registry entry for `memory-organizer` | Data | `extensions/index.json` | Removed. |
| Install-registry record | Data | install-registry | Removed. |

**Note on `OrganizerItem`/`OrganizerResult`:** these are currently exported from
`libs/memory-core/src/index.ts` at line 86. If any consumer outside `memoryd.ts` imports them,
that import must be updated or the types must be replaced by analogous `EnrichBatchItem`/
`EnrichBatchResult` types before deletion. The implementation team must audit all importers.

### C5.2 Deprecated fields in existing tool schemas

No existing MCP tool field is deprecated (all fields are retained for backward compat). The only
behavioral deprecation is `memory_write`'s description string, which currently says
"Enqueues organize; never blocks on LLM." — this must be updated to
"Runs deterministic enrichment synchronously; batch enrichments run in daemon." on v1 launch.

### C5.3 Deprecation/compat note

The `memory-organizer` removal is not a gradual deprecation — it is a clean cut. There is no
transition period where both the LLM organizer and the deterministic pipeline run simultaneously.
The v0→v1 migration is:

1. Implement `@sox/memory-enrich` + update `write.ts` + update `memoryd.ts`.
2. Run the migration (idempotent `ALTER TABLE` per D3.2).
3. Remove `memory-organizer` entirely.
4. Bump MCP server version to `"1.0.0"`.

Rollback: re-adding `memory-organizer` is possible by reverting the `memoryd.ts` changes.
The new schema columns (`tags`, `topic`, `project_path`, `meta`, `enrich_ver`) do not
conflict with the organizer's schema and do not need to be rolled back.

---

## C6. Versioning

### C6.1 `@sox/memory-enrich` package versioning

Follows semver. Version is exported as `ENRICH_VERSION` (C1.11) and written to `node.enrich_ver.pass`.

| Change type | Semver bump | Re-enrichment required? |
|-------------|-------------|------------------------|
| New enrichment field, additive | minor | No (new fields are null on old episodes; populated on next batch pass) |
| Changed clustering algorithm (τ, linkage type) | minor | Yes — old communities may no longer reflect new clustering; `runBatchEnrich` detects stale via `enrich_ver.pass` mismatch |
| Changed importance formula weights | minor | Yes — importance scores are stale |
| Breaking schema change (column removal, type change) | major | Yes — migration script required |
| Bug fix in extractive summary | patch | No |

### C6.2 MCP tool surface versioning

The MCP server signals its version via the `serve()` call version string and via `memory_stats`
returning `{ tool_version }`.

| Version | Changes |
|---------|---------|
| `0.1.0` (current) | 7 tools; no enrichment fields. |
| `1.0.0` (post-enrichment) | `memory_write` + `memory_recall` enriched; 8 new tools added; `memory_get_community` response changed; `memory_link` gains `SAME_AS` rel. |

**Breaking changes in `1.0.0`:**
- `memory_get_community` response: `name` field replaced by `label`. Callers must update.

All other changes are additive.

### C6.3 `WriteParams` / `RecallParams` lib API versioning

These are internal TypeScript types not published to npm. Version is tracked by the monorepo
commit graph. New optional fields in `WriteParams` (C3.5) are backward-compatible: existing
callers passing only required fields continue to work.

---

## C7. Traceability matrix

| Contract | Spec enrichment | Use case |
|----------|----------------|----------|
| `enrichOnWrite` (C1.2) | E1–E5, E8, E10, E12 | UC1, UC4 |
| `runBatchEnrich` (C1.3) | E6, E7, E9, E11 | UC2, UC3, UC7, UC10 |
| `resolveProjectPath` (C1.4) | E1 | UC1, UC5 |
| `computeImportance` (C1.5) | E7 | UC7 |
| `detectNearDup` (C1.6) | E8 | UC9 |
| `extractiveSummary` (C1.7) | E10 | UC4 |
| `clusterStore` (C1.8) | E6 | UC2, UC10 |
| `buildAutoLinks` (C1.9) | E9 | UC3 |
| `clusterStats` (C1.10) | E6 | UC10 |
| `memory_write` v1 (C2.1) | E1–E5, E8, E10, E12 | UC1, UC4, UC6 |
| `memory_recall` v1 (C2.2) | E1, E5 (filters) | UC1, UC5, UC7, UC8 |
| `memory_topics` (C2.3) | E5, E6 | UC2, UC7 |
| `memory_list_projects` (C2.4) | E1 | UC1, UC5 |
| `memory_list_entities` (C2.5) | E4 | UC3, UC5 |
| `memory_get_community` v1 (C2.6) | E6 | UC2 |
| `memory_entity_episodes` (C2.7) | E4 | UC3 |
| `memory_related` (C2.8) | E9 | UC3 |
| `memory_supersession_chain` (C2.9) | E8 | UC8 |
| `memory_near_duplicates` (C2.10) | E8 | UC9 |
| `memory_curate` (C2.11) | E4, E5, E6, E7, E8 | UC6 |
| `memory_stats` (C2.12) | E12 | UC10 |
| `memory_enrich_trigger` (C2.13) | E12 | UC10 |
| Schema `NodeV1` (C3.2) | E1–E5, E12 | UC4 |
| Schema `CommunityNodeV1` (C3.3) | E6 | UC2 |
| `EnrichmentProvenance` (C3.4) | E12 | UC10 |
| `WriteParams` v1 (C3.5) | E1–E5, E9 | UC1, UC4 |
| Removal contract (C5) | — (organizer removal) | — |

---

## C8. Open questions for the implementation phase

The following are design gaps identified during contract authoring. Each is an explicit decision
point for the implementation team; they are not invented silently above.

| # | Question | Where it surfaces | Stakes |
|---|----------|-------------------|--------|
| OQ-1 | `memory_get_community` `entity_uid` vs `community_uid` mutual-exclusion behavior (C2.6) | Tool inputSchema; handler logic | Minor — behavioral ambiguity on bad input |
| OQ-2 | `memory_entity_episodes` entity name disambiguation when multiple entities share a name (C2.7) | Handler logic | Medium — affects correctness of entity-navigation use case |
| OQ-3 | `memory_curate` `dry_run` on `recluster` semantics (C2.11) | Handler logic | Minor |
| OQ-4 | `CommunityNodeV1.meta` JSON key names for quality metrics (C3.3) | DB schema + all cluster-read queries | Medium — must be consistent across `clusterStore`, `clusterStats`, `memory_get_community` |
| OQ-5 | `tags` filter performance at >50k nodes with `json_each` (C3.6) | Query planner; benchmark needed | High at scale — may need a covering index or generated column before production |
| OQ-6 | `memory_recall` with `query: null` path (UC7): does this route through the existing `memoryRecall()` function or a new `memoryFeed()` function? `recall.ts` currently requires `query: string`. | `recall.ts` API; MCP handler | Medium — a new code path is needed for the importance-ranked feed |
| OQ-7 | Cross-store `project_path` queries in federated recall (DESIGN.md D6.7): the `filters.project_path` field on `memory_recall` is per-store. How does the federated layer (`federatedRecall`) aggregate across stores? Is this Phase 1 or deferred? | `recall.ts` federated path | High — affects UC5 usefulness |
| OQ-8 | `memory_curate` `retag` semantics: additive-only or can tags be removed? CONSUMER-INTERFACES.md CI7 says additive. A `tags_remove` param may be needed for full curation. | `memory_curate` inputSchema | Low — additive is safe; removal can be added later |
| OQ-9 | `access_count` increment on recall: DESIGN D2 E11 says add `UPDATE node SET access_count = access_count + 1` after each recall result set. Does this apply to all results in the page, or only results the caller explicitly "opens"? Over-counting inflates importance. | `recall.ts` post-query step | Medium — affects E7 importance accuracy |
| OQ-10 | Community UID collision: sha256 truncated to 32 hex chars = 128 bits. At 10k communities, birthday collision probability is negligible (~10^-28). Acceptable. Documented here for the record; no action needed. | `clusterStore` UID generation | None — informational only |
