# Compiled Interfaces — memory-refactor data/* packages

> Q&A-iterated design, 2026-06-28. All outstanding questions resolved (see §Decisions log).
> These are the **generic backend interfaces** — tool/algorithm names belong in implementations,
> not here. COMPILED.md contains full per-state implementation specs.

---

## Supporting types

```ts
// External type — not defined here:
//   Database  — import type { Database } from 'better-sqlite3'
// EmbeddingProvider is defined in this file under @adhd/sox-embedding-provider

// ── Shared across packages ──────────────────────────────────────────────────

// All edges: src → dst.
// DEPENDS_ON:  A depends on B — B must reach terminal state before A becomes eligible.
//              out-direction traversal returns things A depends on; in-direction returns dependents of A.
// SUPERSEDES: A supersedes B (A is the replacement; B should no longer be considered current).
// DERIVED_FROM: A was derived / computed / inferred from B.
type EdgeRel =
  | 'MENTIONS' | 'SUPPORTS' | 'RELATES_TO' | 'DERIVED_FROM'
  | 'SUPERSEDES' | 'SAME_AS' | 'ASSIGNED_TO' | 'MEMBER_OF' | 'PART_OF'
  | 'DEPENDS_ON'

// Epistemic label — distinct from importance (ranking weight)
type Confidence = 'confirmed' | 'unverified' | 'disputed' | 'deprecated'

interface NodeMeta {
  name?: string
  summary?: string
  topic?: string
  tags?: string[]
  importance?: number
  confidence?: Confidence
  source?: string
  agentId?: string
  projectPath?: string        // provenance: where the node came from
  sessionId?: string
  namespace?: string          // logical graph partition; default: "global"
  tOccurred?: string
  tExpires?: string           // ISO timestamp; after this → isStale = true
  metadata?: Record<string, unknown>
}

interface NodeRecord {
  id: number
  content: string
  name?: string
  summary?: string
  topic?: string
  tags: string[]
  importance?: number
  confidence?: Confidence
  tCreated: string
  tValid: string
  tInvalid?: string
  tExpires?: string
  isSuperseded: boolean
  isStale: boolean            // derived: tExpires != null && now > tExpires
  namespace: string           // default: "global"
  metadata?: Record<string, unknown>
}

interface EdgeMeta {
  weight?: number
  metadata?: Record<string, unknown>
}

interface EdgeRecord {
  src: number
  dst: number
  rel: EdgeRel
  weight?: number
  tCreated: string
  metadata?: Record<string, unknown>
}

interface NodeFilter {
  ids?: number[]
  topic?: string | string[]
  tags?: string[]
  tagsMatchAll?: boolean
  importanceMin?: number
  confidence?: Confidence | Confidence[]   // OR semantics when array
  tCreatedAfter?: string
  tCreatedBefore?: string
  // Bi-temporal point-in-time. Check backend.capabilities.bitemporal before relying on this;
  // backends that don't support it will ignore it (capability flag prevents silent misuse).
  validAt?: string
  isStale?: boolean           // false = exclude stale; true = only stale; absent = all
  namespace?: string          // absent = all namespaces; present = exact match
  // Shallow equality on metadata fields (AND semantics). Check capabilities.metadataFilter
  // before relying on this — backends that don't support it will ignore it.
  metadata?: Record<string, unknown>
  orderBy?: 'importance' | 'tCreated' | 'tValid' | 'name'
  orderDir?: 'asc' | 'desc'  // default: 'desc' for importance, 'asc' for name
  limit?: number
  offset?: number
}

interface VectorSpace {
  modelId: string
  dim: number
}

interface VecFilter {
  ids?: number[]    // restrict knn/iter to this candidate set
}
```

---

## `@adhd/sox-embedding-provider` — `EmbeddingProvider`

```ts
// 'document' — text being stored/indexed
// 'query'    — text being searched with
// For symmetric models, 'query' delegates to 'document'.
// Asymmetric models inject instruction prefixes internally — callers never see them.
type EmbedRole = 'document' | 'query'

interface EmbeddingProviderMetadata {
  modelId: string         // stable identifier — used as the VectorSpace.modelId key
  dimensions: number      // output vector length; drives VectorBackend.ensureSpace()
  maxTokens: number       // advisory token limit; exceeding it triggers chunk-then-mean-pool (D7)
  isRemote: boolean       // true → network I/O; callers may adjust concurrency / retry policy
  isDeterministic: boolean // false → warmUp cache is unreliable; do not cache non-det providers
  providerUri?: string    // observability: 'local:onnx', 'https://api.example.com/v1', etc.
}

interface EmbeddingProvider {
  readonly metadata: EmbeddingProviderMetadata

  // Single-text embed. role defaults to 'document'.
  embedSingle(text: string, role?: EmbedRole): Promise<Float32Array>

  // Batch embed — AsyncIterable so callers process the first result before the last batch
  // finishes. Critical for sequential local inference. role defaults to 'document'.
  // batchSize is a hint; the provider may override based on runtime constraints.
  embedBatch(
    texts: string[],
    opts?: { role?: EmbedRole; batchSize?: number }
  ): AsyncIterable<Float32Array>

  // Pre-embed a fixed set of strings into an internal LRU/Map cache.
  // Subsequent embedSingle/embedBatch hits for these exact strings skip inference.
  // No-op when isDeterministic === false.
  warmUp(texts: string[]): Promise<void>
}
```

**Factory — async, fail-loud at resolution time (never at call time):**

```ts
interface EmbeddingProviderConfig {
  // Provider type key — identifies which adapter to load.
  // Unknown type → ResolutionError thrown before the Promise resolves.
  type: string
  // Model identifier scoped to the provider type.
  model: string
  // Provider-specific options: endpoint URL, credentials, timeout, thread count, etc.
  // Shape is defined by each adapter, not this interface.
  options?: Record<string, unknown>
}

// Async because local runtimes load models from disk asynchronously.
// Throws ResolutionError (synchronously or as rejection) if the config is invalid
// or the runtime / model cannot be loaded. Multiple instances may coexist —
// this is required for re-embed migration (old model active while new model loads).
function createEmbeddingProvider(config: EmbeddingProviderConfig): Promise<EmbeddingProvider>
```

**Error taxonomy — three tiers, no silent degradation:**

```ts
// Retry-able: rate limit, 502/503, network timeout
class TransientEmbeddingError extends Error {
  constructor(message: string, public readonly retryAfterMs?: number) {
    super(message); this.name = 'TransientEmbeddingError'
  }
}

// Not retry-able: invalid input, model not found, auth failure, dimension mismatch
class PermanentEmbeddingError extends Error {
  constructor(message: string) {
    super(message); this.name = 'PermanentEmbeddingError'
  }
}

// Misconfiguration — always thrown at createEmbeddingProvider() time, never mid-call
class ResolutionError extends Error {
  constructor(message: string) {
    super(message); this.name = 'ResolutionError'
  }
}
```

**Relationship to vector-store:** `metadata.modelId` → `VectorSpace.modelId`;
`metadata.dimensions` → `VectorSpace.dim`. The composer calls `backend.ensureSpace({ modelId, dim })`
after `createEmbeddingProvider` resolves, before the first `upsert`.

---

## `@adhd/sox-ingest` — private write-path transforms

> PRIVATE (`private: true`, never published). No backend interface — this package
> is pure stateless transform functions. The memory domain composer calls these
> before writing to graph-store.

```ts
interface IngestResult {
  contentHash: string       // hex-encoded SHA-256 of normalized content — used for graph-store write-time dedup
  summary: string           // extractive summary (sentence-scoring, no LLM)
  tags: string[]            // extracted tags (noun phrases, high-frequency terms)
  chunks?: IngestChunk[]    // only when opts.chunk is set
}

interface IngestChunk {
  index: number
  content: string
  contentHash: string
  charOffset: number        // byte offset into original content
}

interface IngestOpts {
  summaryMaxSentences?: number    // default: 3
  tagMaxCount?: number            // default: 10
  chunk?: {
    maxChars?: number             // default: 2000
    overlapChars?: number         // default: 200
  }
}

// Pure function — no I/O, no storage deps. Safe to call synchronously.
function ingest(content: string, opts?: IngestOpts): IngestResult
```

---

## `@adhd/sox-graph-store` — `GraphBackend`

```ts
interface GraphBackendCapabilities {
  bitemporal: boolean       // true → NodeFilter.validAt is honored
  fullTextSearch: boolean   // true → searchNodes() returns scored results; false → always []
  metadataFilter: boolean   // true → NodeFilter.metadata shallow-equality is applied; false → ignored
}

interface GraphBackend {
  readonly capabilities: GraphBackendCapabilities

  // Schema
  applySchema(): void

  // ── Node writes ───────────────────────────────────────────────────────────
  // All handle bi-temporal semantics + content-hash dedup + index sync.
  writeNode(content: string, meta: NodeMeta): number
  supersede(oldId: number, newContent: string, meta: NodeMeta): number
  invalidate(nodeId: number, reason?: string): void
  // Update mutable metadata on a live node without minting a new node or SUPERSEDES edge.
  // Use for re-verification (bump tExpires, set confidence). tCreated is immutable.
  // THROWS if nodeId is invalidated or does not exist.
  touch(nodeId: number, meta: Partial<NodeMeta>): void
  // Atomic multi-node write. All succeed or none do (single transaction).
  writeNodeBatch(nodes: Array<{ content: string; meta: NodeMeta }>): number[]
  // Atomic node + edge write. srcIdx/dstIdx are indices into nodes[], not existing IDs.
  // Returns written node IDs in input order. All succeed or none do.
  writeGraph(
    nodes: Array<{ content: string; meta: NodeMeta }>,
    edges: Array<{ srcIdx: number; dstIdx: number; rel: EdgeRel; meta?: EdgeMeta }>
  ): number[]

  // ── Node reads ────────────────────────────────────────────────────────────
  getNode(id: number): NodeRecord | null
  queryNodes(filter?: NodeFilter): NodeRecord[]
  // Returns [] when capabilities.fullTextSearch === false.
  // score = relevance rank; mechanism is the backend's concern (FTS5, Tantivy, trgm, …)
  searchNodes(
    query: string,
    opts?: { limit?: number; filter?: NodeFilter }
  ): Array<NodeRecord & { score: number }>
  // Returns the count of live nodes matching filter. More efficient than queryNodes().length.
  countNodes(filter?: NodeFilter): number
  // Returns all nodes in the supersession chain containing nodeId, oldest → newest.
  // nodeId may be any node in the chain. Includes invalidated nodes (for history).
  getSupersessionChain(nodeId: number): NodeRecord[]

  // ── Edge writes ───────────────────────────────────────────────────────────
  // Upsert semantics: if (src, dst, rel) exists, updates meta. Idempotent.
  writeEdge(src: number, dst: number, rel: EdgeRel, meta?: EdgeMeta): void

  // ── Edge reads ────────────────────────────────────────────────────────────
  getEdges(opts: { src?: number; dst?: number; rel?: EdgeRel }): EdgeRecord[]
  getNeighbors(
    nodeId: number,
    opts?: { rel?: EdgeRel; depth?: number; direction?: 'in' | 'out' | 'both' }
  ): NodeRecord[]
  // Same as getNeighbors but includes the connecting edge for each neighbor.
  getNeighborsWithEdges(
    nodeId: number,
    opts?: { rel?: EdgeRel; depth?: number; direction?: 'in' | 'out' | 'both' }
  ): Array<{ node: NodeRecord; edge: EdgeRecord }>

  // ── Graph traversal ───────────────────────────────────────────────────────
  // Cycle-safe reachability. Uses recursive CTE on SQLite — single query, not N round-trips.
  isReachable(
    src: number,
    dst: number,
    opts?: { rel?: EdgeRel; direction?: 'out' | 'in' }
  ): boolean
  // Returns all nodes and edges reachable from rootId. Deduplicated, cycle-safe.
  getSubgraph(
    rootId: number,
    opts?: { rel?: EdgeRel; depth?: number; direction?: 'out' | 'in' | 'both' }
  ): { nodes: NodeRecord[]; edges: EdgeRecord[] }
}
```

**Default implementation:**
```ts
class SqliteGraphBackend implements GraphBackend {
  readonly capabilities = { bitemporal: true, fullTextSearch: true, metadataFilter: true }
  constructor(db: Database) {}
  // FTS via FTS5 triggers; score is bm25() rank; validAt honored via t_valid/t_invalid columns
}

function createGraphBackend(db: Database): GraphBackend
```

**Schema-only exports (for the composer):**
```ts
export const GRAPH_DDL: string
export const FTS_DDL: string
export const FTS_TRIGGERS: string
export const PRAGMAS: string[]

// The 7 EdgeRel values accepted by the memory_link MCP tool (the public surface).
// MEMBER_OF, PART_OF, and DEPENDS_ON are internal-only — valid in the DDL CHECK but
// never exposed via memory_link. Tool handlers must validate against this set.
export const PUBLIC_EDGE_RELS: readonly EdgeRel[]
// ['MENTIONS','SUPPORTS','RELATES_TO','DERIVED_FROM','SUPERSEDES','SAME_AS','ASSIGNED_TO']
```

**Error taxonomy:**
```ts
// Thrown by writeEdge() when (src, dst, rel) violates a CHECK constraint
class ConstraintError extends Error {
  constructor(message: string) {
    super(message); this.name = 'ConstraintError'
  }
}

// Thrown by supersede() when oldId references a node that is already invalidated
class BitemporalConflictError extends Error {
  constructor(message: string, public readonly nodeId: number) {
    super(message); this.name = 'BitemporalConflictError'
  }
}

// Thrown by touch() when the target node does not exist or is invalidated
class NodeNotFoundError extends Error {
  constructor(message: string, public readonly nodeId: number) {
    super(message); this.name = 'NodeNotFoundError'
  }
}
```

**Schema migration:**
`applySchema()` is idempotent — callers invoke it on every open. It uses **drizzle-orm** + **drizzle-kit**
for migration management: migration SQL is generated offline (`npx drizzle-kit generate`) and applied
idempotently at runtime by the package. The composer just calls `applySchema()` — the package owns
versioning and migration logic internally.

**Read contract:** the stable table names (`node`, `edge`, `fts`) and their documented columns are
the published schema contract for this package. Direct SQL reads are permitted — they are the
interface. Write bypasses are not (triggers and bi-temporal logic won't fire).

---

## `@adhd/sox-vector-store` — `VectorBackend`

```ts
interface VectorBackend {
  // Space management — one backend may hold multiple spaces (one per modelId+dim pair).
  // Call ensureSpace before upsert on a new space; idempotent on existing spaces.
  ensureSpace(space: VectorSpace): void
  listSpaces(): VectorSpace[]

  // Write
  // THROWS SpaceInvariantError if vec.length !== space.dim  ([def:space-invariant])
  // This invariant is a contract requirement on ALL implementations, not just SQLite.
  upsert(id: number, vec: Float32Array, space: VectorSpace): void
  delete(id: number, modelId: string): void

  // Point read
  get(id: number, modelId: string): Float32Array | null

  // Similarity search — score semantics are the backend's concern (cosine, dot, L2)
  knn(
    query: Float32Array,
    space: VectorSpace,
    k: number,
    filter?: VecFilter
  ): Array<{ id: number; score: number }>

  // Corpus scan — required by analysis (clustering walks all vectors, reembed migrates them)
  iter(
    modelId: string,
    opts?: { filter?: VecFilter }
  ): Iterable<{ id: number; vec: Float32Array }>
}
```

**Default implementation:**
```ts
class SqliteVectorBackend implements VectorBackend {
  constructor(db: Database) {}
  // sqlite-vec vec0 tables, one virtual table per space
  // BL-91 UPDATE-then-INSERT upsert
  // Inner SimilarityBackend seam for Phase 1+ ANN swap (not exported)
}

function openVectorStore(
  path: string,
  opts: { dim: number; modelId: string }
): SqliteVectorBackend

// Thrown by upsert() when vec.length !== space.dim ([def:space-invariant])
class SpaceInvariantError extends Error {
  constructor(
    public readonly nodeId: number,
    public readonly space: VectorSpace,
    public readonly actualDim: number
  ) {
    super(`dim mismatch for node ${nodeId}: got ${actualDim}, expected ${space.dim} (${space.modelId})`)
    this.name = 'SpaceInvariantError'
  }
}

// Thrown by upsert() / ensureSpace() when underlying storage fails (disk full, WAL locked, etc.)
class StorageError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message); this.name = 'StorageError'
  }
}
```

**Cross-package op — lives in vector-store, uses embedding-provider as a parameter:**
```ts
// reembed() accepts an EmbeddingProvider instance — it does NOT import @adhd/sox-embedding-provider
// as a package dependency. Use import type { EmbeddingProvider } to keep the package graph clean;
// the instance is injected by the composer at call time.
// This keeps the dependency graph a DAG with no cycles.
```ts
interface ReembedOpts {
  // The VectorSpace to write into. Required — explicit so cross-model migration
  // (e.g. bge-small-384 → e5-large-1024) is unambiguous.
  targetSpace: VectorSpace
  // The modelId to read from (source). Defaults to the first space in listSpaces()
  // whose modelId differs from targetSpace.modelId.
  sourceModelId?: string
  dryRun?: boolean
}

interface ReembedResult {
  migrated: number
  skipped: number
  errors: Array<{ id: number; error: string }>
}

function reembed(
  backend: VectorBackend,
  provider: EmbeddingProvider,   // from @adhd/sox-embedding-provider
  opts: ReembedOpts
): Promise<ReembedResult>
// walks vec.iter(sourceModelId) → provider.embedBatch() → vec.upsert(targetSpace)
// Does NOT delete source vectors — caller decides when the old space is safe to drop.
```

---

## `@adhd/sox-analysis`

No `CorpusBackend` wrapper — functions take `VectorBackend + GraphBackend` directly.
This is honest about cross-package dependencies and lets callers compose backends
independently (Qdrant for vectors + any graph backend, for example).

**Opts and result types:**

```ts
interface ClusterOpts {
  modelId?: string            // vector space to cluster in; defaults to listSpaces()[0].modelId
  minClusterSize?: number     // min members per community (default: 2)
  threshold?: number          // similarity floor for community membership (default: 0.75)
}

interface ClusterResult {
  communities: Array<{
    id: number
    memberIds: number[]
    label?: string            // written to graph as MEMBER_OF edge target node name
  }>
  unclustered: number[]       // node IDs that didn't fit any community
  durationMs: number
}

interface SubsetClusterResult extends ClusterResult {
  filter: NodeFilter          // the filter that scoped the subset
  totalInSubset: number
}

interface NearDupOpts {
  nearDupThreshold?: number   // cosine >= this → 'near_dup'  (default: 0.95)
  distinctThreshold?: number  // cosine <  this → 'distinct'  (default: 0.70)
  modelId?: string
  limit?: number              // max pairs returned
}

// Shared by both detectNearDup (DB-integrated) and detectNearDupPairs (pure)
interface NearDupPair {
  a: number
  b: number
  cosine: number
  status: 'near_dup' | 'candidate' | 'distinct'
}

interface ImportanceOpts {
  filter?: NodeFilter         // scope to a subset of nodes; default: all unscored
  dryRun?: boolean
}

interface AutoLinkOpts {
  filter?: NodeFilter
  similarityThreshold?: number  // cosine floor for link creation (default: 0.80)
  maxLinksPerNode?: number      // default: 5
  rel?: EdgeRel                 // edge rel to write (default: RELATES_TO)
  dryRun?: boolean
}

interface BatchOpts {
  filter?: NodeFilter
  skip?: Array<'importance' | 'nearDup' | 'autoLinks' | 'clustering'>
  dryRun?: boolean
}

interface BatchResult {
  nodesProcessed: number
  nearDupPairsFound: number
  autoLinksCreated: number
  communitiesUpdated: number
  durationMs: number
}
```

**DB-integrated functions** — reads via `vec.iter` / `graph.queryNodes`; writes via
`graph.writeEdge` / `graph.writeNode`:

```ts
function clusterStore(
  vec: VectorBackend,
  graph: GraphBackend,
  opts?: ClusterOpts
): Promise<ClusterResult>

function clusterSubset(
  vec: VectorBackend,
  graph: GraphBackend,
  filter: NodeFilter,
  opts?: ClusterOpts
): Promise<SubsetClusterResult>

function detectNearDup(
  vec: VectorBackend,
  graph: GraphBackend,
  opts?: NearDupOpts
): NearDupPair[]

// Stores score at write time — never recomputes at query time ([def:deterministic-first])
function computeImportance(
  vec: VectorBackend,
  graph: GraphBackend,
  opts?: ImportanceOpts
): void

// Incremental — processes only un-scored nodes ([def:deterministic-first])
function buildAutoLinks(
  vec: VectorBackend,
  graph: GraphBackend,
  opts?: AutoLinkOpts
): void

// Orchestrates the above in dependency order; incremental by default
function runBatchEnrich(
  vec: VectorBackend,
  graph: GraphBackend,
  opts?: BatchOpts
): Promise<BatchResult>
```

**Pure algorithm exports — main entry, zero storage dependencies:**

These are exported from `@adhd/sox-analysis` directly alongside the DB-integrated functions.
Native deps (`better-sqlite3`, `sqlite-vec`) are externalized in the esbuild bundle, so a caller
that only imports `cluster` does not get native bindings in their bundle.

```ts
// import { cluster, detectNearDupPairs, scoreImportance } from '@adhd/sox-analysis'

// Callers with any storage source feed raw Float32Arrays directly.
function cluster(
  vecs: Array<{ id: number; vec: Float32Array }>,
  opts?: ClusterOpts
): ClusterResult

// Threshold semantics ([def:deterministic-first]):
//   cosine >= 0.95 → 'near_dup'
//   cosine <  0.70 → 'distinct'
//   middle range   → 'candidate'
function detectNearDupPairs(
  vecs: Array<{ id: number; vec: Float32Array }>,
  opts?: NearDupOpts
): Array<{
  a: number
  b: number
  cosine: number
  status: 'near_dup' | 'candidate' | 'distinct'
}>

function scoreImportance(node: {
  inDegree: number
  outDegree: number
  recencyMs: number
  nearDupCount: number
}): number

// ── Graph-theoretic algorithms — main entry, zero storage deps ──────────────
// import { topoSort, criticalPath, detectCycles, detectDAGStructure } from '@adhd/sox-analysis'

interface TopoSortResult {
  order: number[]             // node IDs, leaves first (Kahn BFS)
  waves: Map<number, number>  // nodeId → wave index (0 = no deps)
  cycle: number[] | null      // first cycle found, null if acyclic
}

// getEdges returns direct dependency IDs (the targets of DEPENDS_ON out-edges).
// Caller supplies adjacency from any source: GraphBackend, in-memory Map, or synthetic graph.
function topoSort(
  nodeIds: number[],
  getEdges: (id: number) => number[]
): TopoSortResult

// Longest path length from each node to terminal (reverse topological DP). O(V+E).
function criticalPath(
  nodeIds: number[],
  getEdges: (id: number) => number[],
  getWeight: (id: number) => number
): Map<number, number>  // nodeId → critical path length to terminal

// DFS with recursion-stack recovery. Returns all cycles (not just the first).
function detectCycles(
  nodeIds: number[],
  getEdges: (id: number) => number[]
): Array<number[]>

type DAGStructure = 'forest' | 'series-parallel' | 'general'

// Determines DAG topology for algorithm selection (tree-dp vs SA vs HLFET in packBatches).
function detectDAGStructure(
  nodeIds: number[],
  getEdges: (id: number) => number[]
): DAGStructure

// ── Batch scheduling — main entry, zero storage deps ─────────────────────────
// import { packBatches, setOverlapMatrix } from '@adhd/sox-analysis'

interface PackItem {
  id: number
  cost: number                       // Kᵢ — variable cost of this item alone
  resources: string[]                // Sᵢ — resource keys; shared resources paid once per batch
  resourceCost: (key: string) => number
  deps: number[]                     // items that must appear in an earlier batch (DEPENDS_ON targets)
  group?: string                     // items with different groups cannot share a batch
}

interface PackOpts {
  B: number                          // fixed overhead per batch
  W: number                          // capacity constraint per batch
  algorithm?: 'auto' | 'bitmask-dp' | 'tree-dp' | 'simulated-annealing' | 'hlfet'
}

interface PackResult {
  batches: Array<{ items: number[]; cost: number }>
  totalCost: number
  algorithm: string
}

// Bin-packing with submodular shared resource cost. Greedy splitting is incorrect
// because shared resources are paid once per batch, not per item.
function packBatches(items: PackItem[], opts: PackOpts): PackResult

interface OverlapEntry {
  a: number
  b: number
  intersection: string[]
  bytes: number
}

// Pairwise set intersections (all N*(N-1)/2 pairs). Exact for small sets;
// MinHash k=128 when |S| > 500.
function setOverlapMatrix(
  items: Array<{ id: number; keys: string[] }>,
  valueFn?: (key: string) => number
): OverlapEntry[]
```

---

## `@adhd/sox-hybrid-search` — `SearchBackend`

```ts
interface SearchQuery {
  text?: string         // text relevance signal
  vec?: Float32Array    // vector similarity signal — caller is responsible for embedding
  filters?: Record<string, unknown>
}

interface SearchBackend {
  // text absent → vecScore only; vec absent → textScore only; neither → error
  // Never throws for a missing signal — degrades to whichever signal is present.
  // [def:degrade-to-text-only] is always valid.
  search(
    query: SearchQuery,
    limit: number
  ): Array<{
    id: number
    textScore?: number    // text relevance — mechanism is the backend's concern
    vecScore?: number     // vector similarity — metric is the backend's concern
    fields: Record<string, unknown>
  }>
}
```

**Default SQLite implementation:**

```ts
// SchemaAdapter is a SQLite-level concern — lives inside SqliteSearchBackend only.
// Not exported from the package. MCP handlers pass raw filters via SearchQuery.filters;
// SqliteSearchBackend resolves them internally via its SchemaAdapter.
interface SchemaAdapter {
  buildTextQuery(query: string, opts: { limit: number }): { sql: string; params: unknown[] }
  buildVecQuery(vec: Float32Array, k: number): { sql: string; params: unknown[] }
  buildFilterClause(filters: unknown): { sql: string; params: unknown[] }
}

interface SqliteSearchOpts {
  fieldWeights?: Record<string, number>   // default: memory node preset
  schemaAdapter?: SchemaAdapter           // override for non-standard schemas (SYS-3 etc.)
}

class SqliteSearchBackend implements SearchBackend {
  constructor(
    vec: VectorBackend,
    graph: GraphBackend,
    opts?: SqliteSearchOpts
  ) {}
  // Delegates to graph.searchNodes() for textScore, vec.knn() for vecScore
  // buildFilterClause is resolved internally — not exported
}
```

**Top-level entry point — fusion math over any `SearchBackend`:**

```ts
function search(
  backend: SearchBackend,
  query: SearchQuery,
  opts?: SearchOpts
): SearchResult[]

interface SearchOpts {
  normalizer?: 'min_max' | 'L2' | 'z_score'
  // explain: true → signalScores included in results (text/vec signal breakdown).
  // Field-level breakdown (which FTS5 column matched best) is SqliteSearchOpts-internal;
  // it does not surface through this interface.
  explain?: boolean
  limit?: number
}

interface SearchResult {
  id: number
  score: number
  // Populated only when explain: true. Signal-level only — mechanism-agnostic.
  signalScores?: { text?: number; vec?: number }
  fields: Record<string, unknown>
}
```

**Pure fusion exports — main entry, zero storage dependencies:**

These are exported from `@adhd/sox-hybrid-search` directly. Same rationale as analysis:
native deps are externalized, so importing only `fuse` does not pull in bindings.

```ts
// import { fuse, normalize } from '@adhd/sox-hybrid-search'

function fuse(
  candidates: Array<{ id: number; textScore?: number; vecScore?: number }>,
  opts?: FusionOpts
): Array<{ id: number; score: number }>

function normalize(scores: number[], method: 'min_max' | 'L2' | 'z_score'): number[]

interface FusionOpts {
  normalizer?: 'min_max' | 'L2' | 'z_score'
  weights?: { text?: number; vec?: number }
}
```

---

---

## Observability contract

All data/* packages share a minimal logging surface — no dependency on a shared logger, no
framework. Packages use `console` at standard levels; callers may override via `globalThis`.

| Level | When | Example |
|---|---|---|
| `error` | Unrecoverable: binding failure, schema corruption, disk full | `console.error('[vector-store] vec0 load failed', err)` |
| `warn` | Degraded-but-functional: fallback engaged, stale cache, slow query | `console.warn('[graph-store] FTS5 index rebuild triggered')` |
| `info` | Health/state change: model loaded, space created, migration applied | `console.info('[vector-store] new space created modelId=bge-base dim=768')` |
| `debug` | Per-operation detail: SQL query, vector dims, timing | `console.debug('[hybrid-search] knn returned 42 candidates in 1.2ms')` |

Packages log with a `[package-name]` prefix. No structured logging framework is required.
The embedding-provider additionally exposes `getEmbedHealth()` / `getLastEmbedError()` for
programmatic health checks (see BL-89).

```
embedding-provider   (no runtime deps — native ONNX runtime is a peer/optional dep)
ingest               (no deps — pure stateless transforms)
graph-store          (better-sqlite3, drizzle-orm — migration layer)
vector-store         (better-sqlite3, sqlite-vec)
  reembed()          ← embedding-provider  [EmbeddingProvider param; not a package dep —
                                            callers pass the provider instance in]
analysis             ← vector-store        [VectorBackend interface + iter]
                     ← graph-store         [GraphBackend interface]
hybrid-search        ← vector-store        [VectorBackend interface → SqliteSearchBackend]
                     ← graph-store         [GraphBackend interface → SqliteSearchBackend]
```

`hybrid-search` does NOT depend on `embedding-provider`. Callers embed text themselves
and pass `vec: Float32Array` in `SearchQuery`. Absent `vec`, the backend degrades to text-only.

`vector-store` does NOT have `embedding-provider` as a package dependency. `reembed()` accepts
an `EmbeddingProvider` instance as a parameter — the caller composes them. This keeps the
package dependency graph a DAG with no cycles.

---

## Decisions log

| # | Question | Decision | Rationale |
|---|---|---|---|
| OQ-1 | `NodeFilter.validAt` — hint vs capability flag | **Capability flag** `capabilities.bitemporal` on `GraphBackend` | Silent ignore is a correctness hazard; split interface is overengineering |
| OQ-2 | `reembed` target space — implicit vs explicit | **Explicit** `targetSpace: VectorSpace` in `ReembedOpts` | Cross-model migration (384→1024) is the primary use case; implicit derivation from provider blocks it |
| OQ-3 | `explain` depth — signal-level vs field-level | **Signal-level only** at `SearchOpts`; field-level stays SQLite-internal | Field-level breakdown leaking as opaque `debugInfo` defeats the typed interface |
| OQ-4 | Pure algorithms — subpath vs separate package | **Main entry** exports alongside DB-integrated functions | TypeScript subpath exports require `moduleResolution: node16/bundler` + paired `types` in `package.json` exports — too fragile; native deps are externalized in esbuild bundle anyway so callers don't pay for bindings they don't use |
| OQ-5 | `buildFiltersClause` — public export vs internal | **Internal** to `SqliteSearchBackend`; not exported | Public export would expose SQLite-specific SQL generation at the package boundary |
| OQ-6 | `searchNodes` on non-text backends | **Capability flag** `capabilities.fullTextSearch`; return `[]` if false | Merged with OQ-1 resolution; same pattern, same object |

---

## Spec gaps — identified 2026-06-28

> Distilled from a review of the interfaces against a concrete use case
> (structured tool-capability knowledge store). Items are separated into
> **spec-level gaps** (generic omissions that any caller would hit) vs.
> **application-layer conventions** (the right place to handle them is in
> the writer, not the storage interface).

---

### What belongs in the spec

#### 1. `NodeFilter.metadata` predicate — equality match on metadata fields

`queryNodes` and `searchNodes` filter by `topic`, `tags`, `importanceMin`, and temporal bounds.
Without a metadata predicate, callers that store structured metadata (quality signals, status
flags, provenance) must fetch-then-filter in userland — full-table scans with no index support.

Added: `NodeFilter.metadata?: Record<string, unknown>` (shallow AND equality) +
`GraphBackendCapabilities.metadataFilter: boolean` (capability flag; backends that can't support
it ignore the field — same pattern as `bitemporal`/`fullTextSearch`). See Supporting types.

---

#### 2. `confidence` as a first-class field

`importance` is a ranking weight (1–10). It is not an epistemic label. A high-importance node
can be unverified; a low-importance node can be confirmed fact. Conflating the two forces callers
to bury `{ status: 'confirmed' }` in `metadata` with no consistent shape and no filter support.

Added: `type Confidence`, `NodeMeta.confidence`, `NodeRecord.confidence`,
`NodeFilter.confidence?: Confidence | Confidence[]` (OR semantics). See Supporting types.

---

#### 3. `tExpires` / staleness — time-bounded validity

`tValid`/`tInvalid` cover bi-temporal correctness (when a fact was true in the world).
They do not cover expiry: when a node should be treated as stale regardless of supersession.
`tExpires` fires automatically — the right model for any time-sensitive knowledge (tool
capabilities, rate limits, benchmark results, pricing tables).

Added: `NodeMeta.tExpires`, `NodeRecord.tExpires`, `NodeRecord.isStale` (derived),
`NodeFilter.isStale`. The daemon / batch enricher surfaces stale nodes for re-verification
the same way it surfaces low-importance nodes. See Supporting types.

---

#### 4. `getSupersessionChain(nodeId)` — full version history

`supersede()` mints a new node linked by `SUPERSEDES`. Walking the full chain currently requires
recursive `getEdges({ rel: 'SUPERSEDES' })` calls with manual cycle protection in both directions.

Added to `GraphBackend`: `getSupersessionChain(nodeId): NodeRecord[]` — returns all nodes in the
chain ordered oldest → newest; includes invalidated nodes (necessary for history reconstruction).
See `GraphBackend` interface above.

---

#### 5. `touch(nodeId, meta)` — re-verify without superseding

`supersede()` is the right operation when content changes. The re-verification case
("checked again, still true, bump `tExpires`") should not create a new node and `SUPERSEDES`
edge — that pollutes the graph with phantom version nodes and makes chain traversal noisy.

Added to `GraphBackend`: `touch(nodeId, meta: Partial<NodeMeta>): void`. See interface above.

---

#### 6. `writeNodeBatch` / `writeGraph` — atomic multi-node writes

`writeNode` is single-call — N nodes require N round-trips with no atomicity guarantee. A crash
mid-write leaves a partial graph with no record of incompleteness. Writing nodes then their edges
in separate calls has the same problem.

Added to `GraphBackend`: `writeNodeBatch(nodes)` and `writeGraph(nodes, edges)`.
See interface above.

---

### What belongs in the application layer, not the spec

These were raised in the review but are use-case conventions that the spec
should not absorb:

**Specific `metadata` shapes** — e.g. `{ status: 'confirmed', last_checked,
source }` for a tool-capability store. The spec provides `metadata:
Record<string, unknown>` and the `confidence` field. The exact keys within
`metadata` are the caller's convention.

**One-node-per-claim granularity** — the spec is claim-agnostic. Whether a
single research document is stored as one episode or split into N claim-level
nodes is a writer discipline, not a storage contract.

**Tag and topic naming conventions** — e.g. `tags: ['langgraph',
'resumption']`. The spec provides the filter surface; consistent taxonomy is
the application's responsibility.

**Writer discipline (prompt conventions)** — e.g. "always set `tExpires` when
writing a time-sensitive node." The spec provides the field; enforcing that
writers use it belongs in prompt templates or agent scaffolding, not the
storage interface.

---

## Graph features — identified from DAG mirror use case (2026-06-28)

> The dag-as-graph-mirror pattern (storing plan milestones and operations as
> graph nodes for cross-plan querying while keeping dag.json as the execution
> source of truth) surfaced a second set of generic gaps. All items below are
> generalizable — they serve any structured graph stored in this backend, not
> just plan DAGs. All methods below are now in the `GraphBackend` interface above;
> all fields below are now in `Supporting types` above. This section documents
> the rationale for each addition.

---

### 1. `writeGraph(nodes, edges)` — atomic node + edge write

Writing nodes then their connecting edges in separate calls is not atomic — a crash
between the two leaves a graph with nodes and no edges, with no record of incompleteness.
Any structured graph projected into the store (plan DAG, dependency tree, knowledge graph)
needs nodes and edges committed together. `srcIdx`/`dstIdx` are indices into the `nodes`
array so the caller does not need to know IDs before the write.

---

### 2. `writeEdge` — upsert / idempotency contract

Silent duplicate creation on an existing `(src, dst, rel)` triple makes re-projection
unsafe — a plan state change triggers re-mirroring, and every edge would be created twice.
Contract is explicit: upsert semantics, idempotent.

---

### 3. `getNeighborsWithEdges()` — traversal with edge context

`getNeighbors` discards the connecting edge. Any traversal where edge properties matter
(weight, metadata, directional confidence) requires a separate `getEdges` call per neighbor —
doubling query count. `getNeighborsWithEdges` returns both together.

---

### 4. `isReachable(src, dst)` — single-query reachability

Recursive `getNeighbors` calls in userland with manual cycle protection is O(N) round-trips.
`isReachable` uses a recursive CTE (`WITH RECURSIVE`) on SQLite — one query regardless of path
length. Common query: "is this milestone transitively blocked by that one?"

---

### 5. `getSubgraph(rootId)` — extract a connected component

Exporting a plan to a visualiser, passing a full plan structure as agent context, or computing
per-plan stats all need "all nodes and edges reachable from this root." Currently requires
recursive `getNeighbors` + `getEdges` with manual deduplication. `getSubgraph` is
deduplicated and cycle-safe.

---

### 6. `countNodes(filter)` — aggregate count

`queryNodes().length` fetches every matching `NodeRecord` to count them. `countNodes` runs
`COUNT(*)` at the DB layer — orders of magnitude faster on large stores.

---

### 7. `NodeFilter.orderBy` — explicit result ordering

`queryNodes` has unspecified order (insertion order). Callers wanting importance-ranked,
recency-ranked, or alphabetical results sort in userland after a full fetch. `orderBy` +
`orderDir` push the sort to the query.

---

### 8. `namespace` — instance isolation within a shared store

`projectPath` / `agentId` in `NodeMeta` are provenance fields (where a node came from).
They are not isolation fields (which logical graph it belongs to). Multiple graphs in the
same store need hard isolation — tag conventions (`tags: ['plan:adhd-build']`) are fragile;
a query without the tag returns nodes from all plans. `namespace` (default: `"global"`)
gives explicit partition semantics. `projectPath` is still kept for provenance.

---

### 9. `DEPENDS_ON` — add to `EdgeRel`

`RELATES_TO` is semantically too broad to carry dependency edges — `getNeighbors({ rel: 'RELATES_TO' })`
returns all related nodes, not just dependencies, forcing userland filter by `edge.metadata.kind`
to recover the dependency subgraph. `DEPENDS_ON` expresses "A depends on B (B must reach terminal
state before A becomes eligible)" — the edge points from the dependent to the requirement.
Useful beyond plan DAGs: tool dependency trees, task prerequisite graphs, any domain where "A
depends on B" is a first-class relationship. See Supporting types.

Traversal convention: `getNeighbors({ rel: 'DEPENDS_ON', direction: 'out' })` returns things the
node depends on (its requirements); `direction: 'in'` returns things that depend on the node (its
dependents). Before writing a `DEPENDS_ON` edge, callers should use `detectCycles` to confirm the
edge does not introduce a cycle.

---

### What was considered and left out

**Reactive subscriptions / change feed** — when a node is `touch()`ed,
downstream observers (CLI, orchestrator) need to know. A `subscribe(filter,
callback)` interface was considered but is a streaming concern, not a storage
concern. The right layer for this is above the backend (a pub/sub wrapper or
filesystem watch on the SQLite WAL).

**Topological sort query** — `queryNodes({ orderBy: 'topological' })` for
returning nodes in dependency order. Too domain-specific for the storage
interface; belongs in `@adhd/sox-analysis` as a pure algorithm over
`getSubgraph()` output.

**Shortest path** — similarly, best implemented as a pure algorithm over
`getSubgraph()` or via recursive CTE in userland. Does not need a storage
interface method.

---

## Algorithms — cross-use-case inventory (2026-06-28)

> Drawn from two concrete use cases: (A) tool-capability knowledge store and
> (B) plan DAG mirror (dispatch-optimizer). Algorithms already in the spec
> (`cluster`, `detectNearDupPairs`, `scoreImportance`, hybrid search fusion)
> are not repeated. This section covers what is missing and where it belongs.
>
> Three tiers:
>   **Pure** — zero storage deps; belongs in `@adhd/sox-analysis` pure exports
>   **DB-integrated** — reads/writes graph or vector store; belongs in `@adhd/sox-analysis`
>   **Storage-native** — implemented most efficiently inside the backend itself (SQL)

---

### Pure algorithms (add to `@adhd/sox-analysis` exports)

#### `topoSort(nodes, getEdges)` — topological sort + cycle detection

**Use case A:** none directly.
**Use case B:** wave assignment for plan milestones; prerequisite ordering
before dispatch.
**Generic value:** any caller that stores a DAG in the graph and wants nodes
in dependency order. Reachability, critical path, and batch assignment all
require a valid topological ordering as their first step.

```ts
interface TopoSortResult {
  order: number[]           // node IDs, leaves first
  waves: Map<number, number>  // nodeId → wave index (0 = no deps)
  cycle: number[] | null    // first cycle found, null if DAG is acyclic
}

// getEdges: the caller supplies an adjacency function so this works over any
// graph representation (in-memory, storage-backed, or synthetic)
function topoSort(
  nodeIds: number[],
  getEdges: (id: number) => number[]   // returns direct dependency IDs
): TopoSortResult
```

Complexity: O(V + E). Implementation: Kahn's BFS (produces stable wave
groupings), with DFS fallback to recover the cycle path when a cycle is detected.

---

#### `criticalPath(nodes, getEdges, getWeight)` — longest dependency chain

**Use case A:** none directly.
**Use case B:** HLFET scheduling; identifying which milestone's delay has
the largest downstream impact; prioritising dispatch order.
**Generic value:** any workflow graph where nodes have a cost and you need
to find the bottleneck chain. Equivalent to the longest path in a DAG —
polynomial because DAGs have no cycles.

```ts
function criticalPath(
  nodeIds: number[],
  getEdges: (id: number) => number[],
  getWeight: (id: number) => number     // cost of this node (e.g. ki_estimate)
): Map<number, number>                  // nodeId → critical path length from that node to terminal
```

Complexity: O(V + E) via reverse topological order DP.

---

#### `detectCycles(nodeIds, getEdges)` — cycle check with path recovery

**Use case A:** detecting circular tool dependencies in a capability graph.
**Use case B:** validating `depends_on` edges in a plan before execution.
**Generic value:** a `writeEdge(DEPENDS_ON)` guard — before persisting a
dependency edge, confirm it does not introduce a cycle.

```ts
function detectCycles(
  nodeIds: number[],
  getEdges: (id: number) => number[]
): Array<number[]>    // each inner array is one cycle, as a node ID path
```

Complexity: O(V + E). DFS with recursion stack. Returns all cycles, not just
the first — necessary for user-facing error messages that show every broken
dependency, not just one.

---

#### `packBatches(items, opts)` — bin-packing with submodular shared cost

**Use case A:** grouping tool-capability re-verification queries to minimise
cold-start overhead when each group shares a common prompt preamble.
**Use case B:** packing DAG milestones into dispatch units minimising total
cost subject to a capacity constraint, where milestones sharing source files
pay shared setup cost once per batch.
**Generic value:** any scheduling problem where items have a fixed per-batch
overhead (B), a variable per-item cost (Kᵢ), shared resource cost across items
in the same batch (submodular: `cost(∪Sᵢ) ≤ Σcost(Sᵢ)`), and a per-batch
capacity constraint (W). Task scheduling, DB query batching, API coalescing.

```ts
interface PackItem {
  id: number
  cost: number              // Kᵢ — variable cost of this item alone
  resources: string[]       // Sᵢ — resource keys; shared resources are paid once per batch
  resourceCost: (key: string) => number  // cost of one resource key
  deps: number[]            // items that must appear in an earlier batch
  group?: string            // items with different groups cannot share a batch
}

interface PackOpts {
  B: number                 // fixed overhead per batch
  W: number                 // capacity constraint per batch
  algorithm?: 'auto' | 'bitmask-dp' | 'tree-dp' | 'simulated-annealing' | 'hlfet'
  // 'auto' selects based on N and DAG structure:
  //   N ≤ 20, any DAG structure    → bitmask-dp           (exact, O(3^N))
  //   N ≤ 50, forest / SP DAG     → tree-dp               (exact, O(N²W))
  //   N ≤ 50, general DAG         → simulated-annealing   (~3-8% from optimal)
  //   N > 50                      → hlfet                 (2-1/P approximation, O(N log N))
  // Use detectDAGStructure() to determine forest/SP/general before calling with 'auto'.
}

interface PackResult {
  batches: Array<{
    items: number[]         // IDs of items in this batch
    cost: number            // total cost: B + union(resource costs) + sum(item costs)
  }>
  totalCost: number
  algorithm: string         // which algorithm was selected
}

function packBatches(items: PackItem[], opts: PackOpts): PackResult
```

The submodular union cost `cost(∪Sᵢ)` is the key non-linear term that makes
greedy splitting incorrect — shared resources paid once per batch, not per item.

---

#### `detectDAGStructure(nodeIds, getEdges)` — forest / series-parallel / general

**Use case A:** none.
**Use case B:** algorithm selection in `packBatches` — Tree DP requires
forest or series-parallel structure; falling back to SA or HLFET on a general
DAG that is actually a forest wastes the polynomial-time guarantee.
**Generic value:** any caller using `packBatches` with `algorithm: 'auto'`
benefits from this implicitly. Exposed as a standalone export for callers
that want to report DAG structure to users or route to different processing
pipelines.

```ts
type DAGStructure = 'forest' | 'series-parallel' | 'general'

function detectDAGStructure(
  nodeIds: number[],
  getEdges: (id: number) => number[]
): DAGStructure
// forest: every node has ≤1 parent
// series-parallel: Valdes-Tarjan-Lawler reduction (polynomial)
// general: fallback
```

---

#### `setOverlapMatrix(items)` — pairwise intersection for shared-cost computation

**Use case A:** computing tag overlap between tool-capability nodes to detect
redundant entries before writing.
**Use case B:** `pairwise_overlap` in the snapshot — intersection of source
file sets across milestone pairs, used by `packBatches` for `|∪Sᵢ|` estimation.
**Generic value:** any algorithm that needs pairwise set intersections. Exact
for small sets; MinHash k=128 (RMSE ≤ 8.84%) for |S| > 500 elements.

```ts
interface OverlapEntry {
  a: number                 // item ID
  b: number                 // item ID
  intersection: string[]    // keys in both sets
  bytes: number             // sum of valueFn(key) for keys in intersection
}

function setOverlapMatrix(
  items: Array<{ id: number; keys: string[] }>,
  valueFn?: (key: string) => number   // cost of one key; default: () => 1
): OverlapEntry[]
// All N*(N-1)/2 pairs. O(N²·|S|) exact. Use MinHash variant for |S| > 500.
```

---

### DB-integrated functions — note on scope

The three DB-integrated candidates initially considered (`analyseGraph`,
`crossNamespaceDeduplicate`, `scoreBottleneck`) were cut — they are not
general enough for the library.

- **`analyseGraph`** references `confidence` and `tExpires` as domain
  concepts, and returns fields like `unverifiedCount` and `staleCount` that
  only make sense given our specific schema conventions. It is a composition
  of `countNodes` + `detectCycles` + `criticalPath` + a filter — three
  lines of application code, not a library function.

- **`crossNamespaceDeduplicate`** is `detectNearDup` called twice with
  different `NodeFilter.namespace` values and the results intersected. The
  primitive (`detectNearDup` + `namespace` filter) is already in the spec.
  The cross-namespace wiring is caller logic.

- **`scoreBottleneck`** is `criticalPath` + `getNeighbors({ rel: 'DEPENDS_ON',
  direction: 'in' })` + a sort by result length. Composable from pure
  exports in three lines. The specific framing ("which node blocks the most
  downstream work") is use-case vocabulary, not a generic graph concept.

The rule: if a function's signature or return type contains a concept from
our application schema (`confidence`, `namespace`, `tExpires`, `isStale`,
`DEPENDS_ON` specifically), it belongs in the application layer. The library
exposes primitives; the application composes them.

---

### Analysis recommendations

When to run each algorithm and what to do with the result:

| When | Run | Act on result |
|---|---|---|
| Before any `writeEdge(DEPENDS_ON)` | `detectCycles` | Reject the write if a cycle would be introduced; surface the cycle path to the author |
| On graph initialisation (`writeGraph`) | `topoSort` → store wave numbers as node metadata | Wave numbers are stable for the graph's lifetime; re-run only after structure changes |
| Before each batch dispatch / scheduling pass | `criticalPath` + `packBatches` | Process the highest-critical-path eligible item first; use `packBatches` to find the optimal grouping |
| After writing new nodes from a research session | `detectNearDup(vec, graph)` | Prompt the author to merge or link near-identical claims before they diverge further |
| On a schedule (daily / per session) | `countNodes({ isStale: true })` + `queryNodes({ isStale: true })` | Surface stale nodes for re-verification; feed into `packBatches` to batch re-verification dispatches |
| Before consuming a subgraph as agent context | `getSubgraph(rootId)` → check `confidence` field distribution | If unverified ratio > threshold, annotate the context block with an uncertainty warning |
| After a batch enrich cycle | `setOverlapMatrix` over recently-updated nodes | Feed overlap results into `packBatches` to group follow-up dispatches by shared resource cost |
| Before selecting a traversal algorithm | `detectDAGStructure` | Determines which `packBatches` algorithm to pass as `algorithm` option |
