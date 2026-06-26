# Memory Refactor — Interface Contracts

**Status:** Authoritative (w2a–w2d implementation target) · **Date:** 2026-06-26
**Author:** architect-reviewer
**Scope:** public contracts for the 5 PUBLIC data/* packages + shared DI connection seam.

These `.ts` files are the implementation target for the plan's w2a–w2d states.
They resolve all `⟦U#⟧` stubs the demos had to guess and encode the hard invariants
from `_shared.md`, `SCOPE.md`, and `ADR-0006`. They are NOT compiled packages — they
are the contract document that seeds the published `.d.ts`.

---

## Files

| File | Package | Published name |
|------|---------|---------------|
| `types.ts` | shared primitives + DI seam | (not a package — reference types) |
| `embedding-provider.ts` | data/embed/embedding-provider | `@adhd/sox-embedding-provider` |
| `vector-store.ts` | data/vectors/vector-store | `@adhd/sox-vector-store` |
| `graph-store.ts` | data/graph/graph-store | `@adhd/sox-graph-store` |
| `hybrid-search.ts` | data/search/hybrid-search | `@adhd/sox-hybrid-search` |
| `analysis.ts` | data/analysis/analysis | `@adhd/sox-analysis` |

---

## Cross-package coherence

### dim/modelId flow
```
resolveProvider(config) → EmbedProvider { modelId, dim }
       ↓
applyVecSchema(db, { dim: provider.dim, modelId: provider.modelId })
       ↓
upsertVector(db, nodeId, vec, { modelId: provider.modelId })   // throws SpaceInvariantError if mismatched
       ↓
knn(db, query, k)  →  KnnResult[] { nodeId, score, modelId }
       ↓
ClusterResult { community_uid, model_id: provider.modelId }    // [inv:space] provenance
```

`ModelId` and `Dim` are plain string/number type aliases (not branded) — call sites
require no casting. The constraint is encoded in runtime invariant checks (SpaceInvariantError)
and doc comments, not TypeScript structural enforcement.

### Injected-Database seam (Decision C)
All packages receive the `Database` from the composer. Neither `graph-store` nor
`vector-store` calls `new Database()`. `openVectorStore()` is the sole exception: a
convenience standalone entry point for 3rd-party use that does not involve the composer.

```
Composer (memory-core):
  const db = new Database(expandDbPath(path));
  db.exec(PRAGMAS);                           // from @adhd/sox-graph-store
  sqliteVec.load(db);                         // sqlite-vec native addon
  applyGraphSchema(db);                       // @adhd/sox-graph-store
  applyVecSchema(db, { dim, modelId });       // @adhd/sox-vector-store
```

### Boundary: data/vectors ↛ data/graph
`vector-store` does NOT import `@adhd/sox-graph-store`.
`graph-store` does NOT import `@adhd/sox-vector-store`.
Both take the same injected `Database` — the connection is shared, not the imports.
`hybrid-search` imports both (data→data, allowed).
`analysis` imports both (data→data, allowed).

### Invariant satisfiability check

| Invariant | Can ALL contracts satisfy it simultaneously? | Verdict |
|-----------|----------------------------------------------|---------|
| [inv:space] | upsertVector throws SpaceInvariantError on mismatch; ClusterResult records model_id | YES |
| [inv:loud-fail] | resolveProvider throws ProviderLoadError on real-backend failure; hash is explicit-only; no code path silently downgrades | YES |
| [inv:degrade-to-bm25] | search() with no opts.vector returns a BM25+temporal result; tested by [w2d-hs.4] | YES |
| All three simultaneously | loud-fail governs WRITE-TIME embedding; degrade-to-bm25 governs READ-PATH ranking; they are orthogonal paths | YES — no conflict |

### local‖remote leak check (EmbedProvider)
`EmbedProvider` has NO in-process assumptions:
- All methods are async.
- `embedBatch` is an `AsyncGenerator` (not a sync call returning a buffer).
- No constructor arguments, no `new Worker()` in the interface, no thread references.
- `isRemote: boolean` is metadata only, not a behavioral switch in the interface.

A remote HTTP adapter that awaits a POST to an endpoint is a valid `EmbedProvider` conformer.

### No private @adhd in public contracts
None of the 5 contract files imports from `@adhd/sox-memory-enrich` (private) or any
other `@adhd` package that is not itself public. Cross-package imports in the contracts:
- `embedding-provider.ts` imports from `./types.js` (contract-local).
- `vector-store.ts` imports from `./types.js` + `./embedding-provider.js` (both contract-local).
- `graph-store.ts` imports from `./types.js` (contract-local).
- `hybrid-search.ts` imports from `./types.js` (contract-local).
- `analysis.ts` imports from `./types.js` (contract-local).

In the PUBLISHED packages, cross-`@adhd` imports will reference the published public packages
(`@adhd/sox-graph-store`, `@adhd/sox-vector-store`, `@adhd/sox-embedding-provider`).
`better-sqlite3` is externalized in every package's build config.

---

## Stub-resolution table

Maps every `⟦U#⟧` from each demo's `UNRESOLVED.md` to the contract decision that pins it.

### @adhd/sox-embedding-provider

| Stub | Guessed | Resolution | Contract location |
|------|---------|------------|-------------------|
| U1 | `model` config key in `resolveProvider({backend, model})` | Confirmed: `ProviderConfig.model?: string`. Grounded in embed.ts:68 `model: string` in EmbedConfig. Default 'BAAI/bge-base-en-v1.5' when omitted. | `embedding-provider.ts` `ProviderConfig.model` |
| U2 | Model string IDs (`'BAAI/bge-small-en-v1.5'`, `'BAAI/bge-base-en-v1.5'`, `'intfloat/e5-large-v2'`); providerId='fastembed' | Confirmed: all 3 models documented in `ProviderConfig.model` doc comment, spanning dims 384/768/1024. `providerId:'fastembed'` for the local ONNX provider. | `embedding-provider.ts` `ProviderConfig` doc comment |
| U3 | `provider.embedBatch(texts, {batchSize})` — instance method, returns async iterable | Confirmed: `EmbedProvider.embedBatch(texts: string[], opts?: EmbedBatchOpts): AsyncGenerator<EmbeddingVector>`. `for await...of` matches. `batchSize` is in `EmbedBatchOpts`. | `embedding-provider.ts` `EmbedProvider.embedBatch` |
| U4 | Standard `Error` with human-readable message including model name | Resolved: `ProviderLoadError extends Error` with `name:'ProviderLoadError'`, `config: ProviderConfig`, `cause?: unknown`. Diagnosable by `err instanceof ProviderLoadError` and `err.config.model`. | `embedding-provider.ts` `ProviderLoadError` |
| U5 | `resolveProvider({backend:'remote'})` with no required additional config for the reference impl | Confirmed: `ProviderConfig.backend:'remote'` with optional `endpoint?: string`. Reference impl ignores `endpoint`; a live deployment sets it. | `embedding-provider.ts` `ProviderConfig.endpoint` |
| U6 | No explicit `dispose()` — GC releases ONNX session on process exit | Confirmed: `EmbedProvider` interface has NO lifecycle methods. No `dispose()` is required or defined. Implementors may expose one internally; it is not part of the public contract. | `embedding-provider.ts` `EmbedProvider` (absence noted) |
| REQ-005 | startup Map cache for hot/topic embeddings — no API name specified | Resolved: `EmbedProvider.warmCache?(texts: string[]): Promise<void>` as an OPTIONAL method. Callers check for its presence before calling. | `embedding-provider.ts` `EmbedProvider.warmCache` |

### @adhd/sox-vector-store

| Stub | Guessed | Resolution | Contract location |
|------|---------|------------|-------------------|
| U1 | knn() result shape beyond `nodeId` — `distance`, `score`, or `similarity` fields? | Resolved: `KnnResult { nodeId: number, score: number, modelId: ModelId }`. `score` is cosine similarity (higher = more similar). `modelId` is per-record BL-88 provenance. | `vector-store.ts` `KnnResult` |
| U2 | Table name `vec_items` (guessed); `model_id` column | Resolved: table name is `vec_node` (confirmed via schema.ts:71 `CREATE VIRTUAL TABLE IF NOT EXISTS vec_node USING vec0(...)`). `model_id` is the new per-record provenance column added by BL-88 (not in the legacy DDL — added in this extraction). | `vector-store.ts` `applyVecSchema` doc comment |
| U3 | Error type and message on space invariant violation | Resolved: `SpaceInvariantError extends Error` with `expected: {dim?, modelId?}` and `actual: {dim?, modelId?}`. Thrown by `upsertVector` on BOTH dim mismatch AND modelId mismatch. | `vector-store.ts` `SpaceInvariantError` |
| Scope gap: pluggable backend | By design — no exercisable API in Phase 0 | Encoded: `SimilarityBackend` interface exported as a named seam. `knn()` uses it internally. Phase 1+ swaps in usearch/simsimd without changing callers. | `vector-store.ts` `SimilarityBackend` |
| Scope gap: openVectorStore + applyVecSchema separation | pack-smoke calls them in sequence | Confirmed: `openVectorStore` does open + sqlite-vec load ONLY (not applyVecSchema). Callers must call `applyVecSchema` separately. Matches pack-smoke.mjs call pattern exactly. | `vector-store.ts` `openVectorStore` doc comment |

### @adhd/sox-graph-store

| Stub | Guessed | Resolution | Contract location |
|------|---------|------------|-------------------|
| U1 | `insertNode(db, { name, content, topic?, tags? }): { uid, contentHash, existed }` | Confirmed with additions: `insertNode(db, NodeInput): InsertNodeResult`. `NodeInput` includes all relevant fields. `InsertNodeResult` has `{uid, contentHash, existed, rowid}`. UID is a ULID (grounded in write.ts:24 `import { monotonicFactory } from 'ulid'`). | `graph-store.ts` `insertNode` |
| U2 | `invalidateNode(db, uid: string): void` — sets t_invalid | Confirmed: `invalidateNode(db, uid: string): void`. Sets `t_invalid` to current ISO timestamp. Never issues DELETE. FTS5 fts_node_ad trigger fires automatically. | `graph-store.ts` `invalidateNode` |
| U3 | `addEdge(db, { srcUid, dstUid, rel, weight? }): void` — rel as string union | Confirmed: `addEdge(db, EdgeInput): void`. `EdgeInput` includes `{srcUid, dstUid, rel: EdgeRel, weight?, meta?}`. `EdgeRel` is the full union from schema.ts + `ASSIGNED_TO` (see Escalations). | `graph-store.ts` `addEdge`, `EdgeInput`, `EdgeRel` |
| U5 | `getNeighbors(db, uid, opts?: { rel?, direction? }): NodeRow[]` | Confirmed: `getNeighbors(db, uid, opts?: GetNeighborsOpts): NodeRow[]`. `GetNeighborsOpts` adds `includingInvalidated?: boolean` (default false). `rel` accepts a single rel OR an array. | `graph-store.ts` `getNeighbors` |
| U6 | `queryAt(db, opts?: { asOf?, includingInvalidated?, topic? }): NodeRow[]` — includingInvalidated default false | Confirmed: `queryAt(db, opts?: QueryAtOpts): QueryAtOpts`. Adds `kind?: NodeKind` and `limit?: number`. `includingInvalidated` defaults to false. | `graph-store.ts` `queryAt` |
| U7 | `ftsSearch(db, query, opts?: { limit? }): { uid, name, rank }[]` — rank negative BM25 | Confirmed: `ftsSearch(db, query, opts?): FtsResult[]`. Return type is `{ uid, name, rank }`. Rank is negative (FTS5 convention: more negative = better match). Documented in `FtsResult.rank` JSDoc. | `graph-store.ts` `ftsSearch`, `FtsResult` |
| U8 | `supersessionChain(db, uid): [...{ uid, name, content, supersededBy?, supersedes? }]` oldest-first | Confirmed: `supersessionChain(db, uid): SupersessionEntry[]` ordered oldest-first. `SupersessionEntry` has `{uid, name, content, t_created, t_invalid, supersedes?, supersededBy?}`. `supersedes` = older record; `supersededBy` = newer record. | `graph-store.ts` `supersessionChain`, `SupersessionEntry` |

### @adhd/sox-hybrid-search

| Stub | Guessed | Resolution | Contract location |
|------|---------|------------|-------------------|
| U1 | `applySchema(db)` exported from hybrid-search (re-export of graph+vec schemas) | Resolved: NOT exported. hybrid-search does NOT re-export schema functions from peer packages. Consumers call `applyGraphSchema(db)` + `applyVecSchema(db, opts)` directly from the respective public peer packages. | Decision noted in `hybrid-search.ts` file-level comment |
| U2 | `upsertNode`/`upsertVector` re-exported from hybrid-search | Resolved: NOT re-exported. Consumers import from `@adhd/sox-graph-store` and `@adhd/sox-vector-store` directly. | Decision noted in `hybrid-search.ts` file-level comment |
| U3 | `search(db, query, opts?)` with `{ vector?, limit?, explain?, weights?, normalize? }` | Confirmed: `search(db, query, opts?: SearchOptions)`. Option key names: `vector` (not `queryVector`), `weights` (not `fieldWeights`), `normalize`, `limit`, `explain`, `asOf`, `liveOnly`, `token_budget`, `filter`. | `hybrid-search.ts` `search`, `SearchOptions` |
| U4 | `r.explain` shape — `{ bm25, vector, temporal }` | Resolved: `SearchExplain { vec?, bm25?, temporal?, fieldBoosts? }`. Key is `vec` (not `vector` — avoids shadowing the input option). All fields optional (absent when explain=false). | `hybrid-search.ts` `SearchExplain` |
| U5 | `batchSearch(db, queries, opts?)` — export name and `matched_queries` field | Confirmed: `batchSearch(db, queries: BatchQuery[], opts?: BatchSearchOptions): BatchSearchResult[]`. `matched_queries: number` on `BatchSearchResult` (experimental, as SCOPE Part D specifies). | `hybrid-search.ts` `batchSearch`, `BatchSearchResult` |

### @adhd/sox-analysis

| Stub | Guessed | Resolution | Contract location |
|------|---------|------------|-------------------|
| U1 | node INSERT columns for demo helper — `(uid, content, source, importance, t_created, t_valid)` | Resolved: the demo's `insertItem` helper should use `insertNode(db, NodeInput)` from `@adhd/sox-graph-store` rather than raw SQL. The authoritative DDL is in `applyGraphSchema`. Full `NodeRow` shape documented in `graph-store.ts`. | `graph-store.ts` `NodeInput`, `NodeRow` |
| U2 | `clusterSubset` second-argument filter shape (guessed as `{ uid_prefix: ... }`) | Confirmed: `AnalysisFilter` — same fields as `MemoryFilter` from filters.ts (project_path, topic, tags, tags_match_all, importance_min, t_created_after, t_created_before). NOT `{ uid_prefix }` — that was incorrect. | `analysis.ts` `AnalysisFilter`, `clusterSubset` |
| U3 | `modelId` stored in community node.meta as `$.model_id` | Confirmed: `ClusterResult.model_id: ModelId` is the TypeScript field. The implementation stores it in the community node's `meta` JSON column as `{ model_id: string }`, queryable via `json_extract(node.meta, '$.model_id')`. | `analysis.ts` `ClusterResult.model_id` |

---

## Design decisions

### Shared types package: NOT created
`EmbeddingVector`, `ModelId`, `Dim` appear across multiple packages. These are plain type
aliases (not branded) so each public package can define them locally as:
```typescript
export type ModelId = string;
export type Dim = number;
export type EmbeddingVector = Float32Array;
```
A separate `@adhd/sox-types` public package is NOT recommended: it adds another one-way
public-package door (ADR-0006 one-way door) for essentially 3 trivial aliases. The risk
of semantic divergence between packages is low because they are not branded types —
structural compatibility is preserved automatically.

### MemoryFilter duplication (two package copies)
`hybrid-search.ts` defines `SearchFilter`; `analysis.ts` defines `AnalysisFilter`. Both
are structurally identical to `MemoryFilter` from filters.ts. This is the intentional
decision from w2d-analysis.md §Notes: "DUPLICATE the tiny SQL builder into whichever
package uses it" to avoid creating a shared package mid-plan. Vocabulary changes to the
filter interface must be mirrored in both files.

### openVectorStore does NOT call applyVecSchema internally
The pack-smoke.mjs ground-truth calls them in sequence:
```js
const db = m.openVectorStore(':memory:', { dim: 4 });
m.applyVecSchema(db, { dim: 4, modelId: 'smoke' });
```
`openVectorStore` does open + sqlite-vec load ONLY. `applyVecSchema` is always an explicit
separate call. This is consistent with _shared.md "open + vec-load only".

### search() export alias
Both `search` and `hybridRecall` are exported; pack-smoke checks `m.search ?? m.hybridRecall`.
`search` is the canonical name; `hybridRecall` is an alias for backward compatibility.

### FtsResult.rank sign convention
FTS5 BM25 scores are negative (more negative = better match). `FtsResult.rank` follows
this convention. Callers must sort ascending (most-negative first) to get best matches first.

---

## Escalations to "main"

### E1 — ASSIGNED_TO missing from DDL CHECK constraint
**Finding:** `EdgeRel` in the contract includes `'ASSIGNED_TO'`. However, the current
`schema.ts` DDL CHECK constraint (line 58-59) only includes 8 rel types and omits `ASSIGNED_TO`.
The `memory_link` MCP tool's enum includes `ASSIGNED_TO` in its schema.

**Impact:** Any `memory_link` call with `rel:'ASSIGNED_TO'` against the current schema will
fail with a SQLite constraint error. This is a pre-existing gap in the schema, not introduced
by this refactor.

**Required action:** `applyGraphSchema` in the graph-store extraction MUST add `ASSIGNED_TO`
to the DDL CHECK constraint. This is a non-breaking addition (no existing data uses it, but
the MCP surface declares it). The `w2b-graph-store` implementor must confirm this and update
the DDL.

**Recommendation:** Fix in graph-store DDL during `w2b` extraction. Do not defer.

### E2 — Shared types package decision (ownership)
**Finding:** `ModelId`, `Dim`, and `EmbeddingVector` appear in `types.ts` as a cross-package
reference. If a future package outside this refactor needs these types (e.g., a 3rd-party
extension), each published package would define them locally and consumers would need to
import from a specific one.

**Question for owner:** Is there an anticipated use case where a consumer needs to import
`ModelId` / `EmbeddingVector` WITHOUT importing any of the 5 data packages? If yes, create
`@adhd/sox-types` as a sixth public package.

**Recommendation:** Do NOT create `@adhd/sox-types` now. The 5 packages already export these
types incidentally (e.g., `EmbeddingVector` is part of `EmbedProvider.embed` return type).
A consumer that depends on `@adhd/sox-embedding-provider` already has `EmbeddingVector`.
Revisit when a concrete use case demands a standalone types package.

---

## Total stub resolution count

| Package | Demo stubs | Resolved here | Unresolvable |
|---------|-----------|---------------|--------------|
| embedding-provider | 6 stubs + REQ-005 scope gap | 7 of 7 | 0 |
| vector-store | 3 stubs + 2 scope gaps | 5 of 5 | 0 |
| graph-store | 7 stubs (U1–U3, U5–U8; U4 never written) | 7 of 7 | 0 |
| hybrid-search | 5 stubs | 5 of 5 | 0 |
| analysis | 3 stubs | 3 of 3 | 0 |
| **Total** | **27** | **27** | **0** |

2 design decisions escalated (E1 schema gap, E2 shared types).
