# SPEC — retrieval-infrastructure data/* packages

> Q&A-iterated design, 2026-06-29. Covers 5 packages in the data/retrieval pipeline.
> All outstanding questions resolved (see §Decisions log).

---

## Table of Contents

1. [`@adhd/sox-embedding-provider` — BGE-M3 & CodeXEmbed-400M models](#1-adhdsox-embedding-provider--bge-m3--codexembed-400m-models)
2. [`@adhd/sox-vector-store` — LanceDB backend (adapter)](#2-adhdsox-vector-store--lancedb-backend-adapter)
3. [`@adhd/sox-ingest` — AST-aware & heading-aware chunkers](#3-adhdsox-ingest--ast-aware--heading-aware-chunkers)
4. [`@adhd/sox-hybrid-search` — Cross-encoder reranker](#4-adhdsox-hybrid-search--cross-encoder-reranker)
5. [`@adhd/sox-memory-core` — Parent-context & late chunking](#5-adhdsox-memory-core--parent-context--late-chunking)
6. [Decisions log](#6-decisions-log)

---

## 1. `@adhd/sox-embedding-provider` — BGE-M3 & CodeXEmbed-400M models

**Feature changes:**
- BGE-M3 (570M params, 8192-token context, 100+ languages) via ONNX INT8 through `fastembed` worker thread
- CodeXEmbed-400M (code-only CPU, ~1.6GB RAM) via same worker thread pattern
- Model metadata grows `maxTokens` field; existing `EmbeddingProviderMetadata.dimensions` is sufficient for dimension tracking
- Provider factory resolves `type: 'fastembed'` + `model: 'bge-m3' | 'codexembed-400m'` to the correct ONNX binary

### 1A. Use cases & design drivers

| Use case | Context length need | Language requirement | Deployment target |
|---|---|---|---|
| **Enterprise code search** | 8192 tokens — whole-file single pass | English-only (code) | Developer laptop + server |
| **Multilingual document retrieval** | 512–2048 tokens | 100+ languages | Server GPU + CPU |
| **Regulatory document analysis** | 8192 tokens — single-pass filing | English + legal terminology | Server CPU |

**Cross-cutting requirements:**
- All ONNX inference runs in a dedicated worker thread — never on main thread (BL-11)
- `fastembed` worker thread pool shared across all models; `embedBatch` concurrency limited to available workers
- `maxTokens` is advisory — exceeding it triggers chunk-then-mean-pool, not truncation

### 1B. Interfaces

```ts
// Existing EmbeddingProviderMetadata gains one field:
interface EmbeddingProviderMetadata {
  modelId: string
  dimensions: number
  maxTokens: number             // NEW — maximum tokens per single embed call
  isRemote: boolean
  isDeterministic: boolean
  providerUri?: string
}

// ── Model-specific registration ──────────────────────────────────────────────

interface FastEmbedModelConfig {
  modelId: string               // 'bge-m3' | 'codexembed-400m' | etc.
  hfRepoId: string              // HuggingFace repo for ONNX binary download
  dim: number
  maxTokens: number
  description: string           // human-readable label for observability / tooling
}

// Models are registered in a static registry inside the fastembed adapter.
// Creating a new provider with type: 'fastembed' and an unknown modelId throws
// ResolutionError at createEmbeddingProvider() time.

// ── Worker thread pool config ────────────────────────────────────────────────

interface FastEmbedPoolConfig {
  // Maximum number of ONNX inference workers. Each worker loads the full model.
  // Default: navigator.hardwareConcurrency / 2 (browser) or os.cpus().length / 2 (node).
  // Minimum: 1.
  maxWorkers?: number

  // Models to preload at pool init. Lazy-load on first use if omitted.
  preloadModels?: string[]

  // Per-model batch size hint. Overrides the default 32.
  batchSizes?: Record<string, number>
}

// ── Model cache ───────────────────────────────────────────────────────────────

interface ModelCache {
  // Download and verify model binary. Returns once the model is ready.
  // Throws ResolutionError on SHA-256 mismatch.
  ensure(modelId: string): Promise<void>

  // Check whether the model binary is already in local cache.
  cached(modelId: string): boolean

  // Remove a single model from cache. Does not affect other models.
  clear(modelId: string): Promise<void>

  // Streaming download with progress. Returns an async iterable that yields
  // byte-level progress updates. Useful for large models (>500 MB).
  ensureStream(modelId: string): AsyncIterable<{ bytesDownloaded: number; totalBytes: number }>
}

// Model binaries are cached at:
//   <dataRoot>/models/<modelId>/<version>/
// with a sidecar `.sha256` file. SHA-256 verification runs automatically after
// every download and throws ResolutionError on mismatch.

**Relationship to vector-store:** `EmbeddingProviderMetadata.modelId` → `VectorSpace.modelId`;
`EmbeddingProviderMetadata.dimensions` → `VectorBackend.ensureSpace(dim)`;
`EmbeddingProviderMetadata.maxTokens` governs the chunking boundary for documents exceeding the context window.

### 1D. Model migration strategy

When switching from one embedding model to another (e.g., bge-base → BGE-M3), old embeddings
remain queryable with their original model. New documents use the target model. Stored vectors
from the old model are gradually re-embedded via `reembed()`. Both models coexist in the model
registry until the old model's reference count reaches zero.

```ts
interface ReembedPolicy {
  sourceModel: string     // modelId of the old model whose vectors need re-embedding
  targetModel: string     // modelId of the new model
  batchSize: number       // number of vectors to re-embed per batch (default: 64)
  dryRun: boolean         // when true, report what would be re-embedded without executing
}
```

The re-embed process:
1. Enumerate all vector spaces referencing `sourceModel`.
2. For each space, iterate stored vectors in batches of `batchSize`.
3. Re-embed each batch using `targetModel` and upsert into the same space.
4. Decrement `sourceModel` ref count. When it reaches zero, the model is eligible for cache eviction.

---

## 2. `@adhd/sox-vector-store` — LanceDB backend (adapter)

**Feature changes:**
- `LanceDbVectorBackend` implementing the existing `VectorBackend` interface — the adapter pattern already defined by `SqliteVectorBackend`
- HNSW and IVF-PQ ANN indexes, configurable per-space
- Separate factory function `openLanceDbVectorStore()` — callers choose which backend to instantiate based on their scale requirements
- The `VectorBackend` interface is the contract: both backends are swappable without changing callers
- The existing `reembed()` function handles cross-backend vector copies (source → target space via `iter()` + `upsert()`) when a caller needs to migrate

### 2A. Use cases & design drivers

| Use case | Vector count | Dimension | Query latency target | Write throughput |
|---|---|---|---|---|
| **Product catalog similarity** | 5M | 768 | <10ms P50 | Batch daily refresh |
| **Recommendation embeddings** | 2M | 1024 | <50ms P99 with metadata filter | Streaming writes |
| **Multi-modal training pipelines** | 500K–10M | 384 / 768 / 1024 | <100ms | Bulk ingest |

**Cross-cutting requirements:**
- `VectorBackend` is the adapter interface — both `SqliteVectorBackend` and `LanceDbVectorBackend` implement it
- Space invariance (dimension) is enforced at `upsert` time; mismatched dimension throws `PermanentVectorError`
- LanceDB tables are naturally isolated by dimension — no cross-dimension vector leakage
- Caller chooses backend at space creation via factory selection, not auto-config

### 2B. Interfaces

```ts
// ── LanceDB config (extends VectorBackendConfig semantics) ──────────────────

interface LanceDbVectorBackendConfig {
  // Path to LanceDB database directory. Example: "/data/lancedb"
  // Each dimension gets its own LanceDB table within this directory.
  lancedbPath: string

  // ANN index configuration.
  index?: {
    type: 'hnsw' | 'ivf-pq'

    // HNSW parameters
    M?: number                     // default: 16
    efConstruction?: number        // default: 200

    // IVF-PQ parameters
    numPartitions?: number         // default: sqrt(n) — auto-calculated if omitted
    numSubVectors?: number         // PQ compression; default: dim / 4
    bitsPerSubVector?: number      // default: 8

    // Shared
    metric?: 'cosine' | 'l2' | 'dot'  // default: 'cosine'
  }
}

// ── Convenience factory (parallel to existing openVectorStore for sqlite-vec) ─

function openLanceDbVectorStore(
  config: LanceDbVectorBackendConfig & { db: Database }
): LanceDbVectorBackend & VectorBackend
```

**Relationship to hybrid-search:** `VectorBackend.knnSearch()` returns `ScoredVec[]` — each `(id, score)` pair
is consumed by the hybrid-search RRF fusion step.

---

## 3. `@adhd/sox-ingest` — AST-aware & heading-aware chunkers

**Feature changes:**
- AST-aware chunker (cAST algorithm, tree-sitter backed): Python, Java, C#, TypeScript
- Heading-aware chunker: Markdown, MDX, RST, AsciiDoc
- Source-map on every chunk: `sourceStartLine`, `sourceEndLine`, `sourceUrl`, `sourceSha`
- Chunker registry — new chunkers added by registering a factory, not editing the pipeline
- Registry is populated at build time via static constructors; no runtime reflection

### 3A. Use cases & design drivers

| Use case | Input format | Chunk boundary | Source-map requirement |
|---|---|---|---|
| **API documentation generator** | TypeScript / Python / Java | Function/class/trait | Line range per symbol |
| **Corporate wiki ingestion** | Markdown / RST / AsciiDoc | Heading section | Document URL + heading |
| **E-discovery document processing** | Plain text + line numbers | Paragraph / page | Start/end line for FRCP Rule 34 |

**Cross-cutting requirements:**
- Every chunk carries a source map — zero chunks without provenance
- AST chunker never splits a function across two chunks (semantic unit preservation)
- Heading chunker produces parent-pointer back to document root for context reconstruction
- Chunker registry is append-only at build time — no runtime registration from untrusted sources

### 3B. Interfaces

```ts
// ── Chunk shape ──────────────────────────────────────────────────────────────

interface SourceMap {
  sourceStartLine: number        // 0-based, inclusive
  sourceEndLine: number          // 0-based, inclusive
  sourceUrl?: string             // URL or file path; absent for ephemeral text
  sourceSha?: string             // SHA-256 of source document at time of chunking
}

interface Chunk {
  text: string                   // chunk content — the retrievable unit
  sourceMap: SourceMap
  metadata: {
    chunkerId: string            // which chunker produced this — e.g. 'ast:treesitter:ts'
    language?: string            // 'typescript' | 'python' | 'markdown' | etc.
    heading?: string             // heading path for heading-aware chunkers, e.g. "Installation > Prerequisites"
    parentDocId?: string         // document-level grouping key
    chunkIndex: number           // position within document
    isHeadingRoot?: boolean      // true for the first heading of a document
  }
  embedding?: Float32Array       // populated after vectorization; empty at chunking time
}

// ── Chunker interface ────────────────────────────────────────────────────────

interface Chunker {
  readonly id: string            // unique identifier — e.g. 'ast:treesitter:ts'
  readonly supportedLanguages: string[]

  // Chunk a single document. Returns zero or more chunks.
  // For languages not in supportedLanguages, throws PermanentChunkingError.
  chunk(document: string, options?: ChunkerOptions): Chunk[]

  // Estimate the number of chunks without executing the full chunking pass.
  // Used for progress reporting and memory pre-allocation.
  estimate(document: string): number
}

interface ChunkerOptions {
  sourceUrl?: string
  sourceSha?: string
  parentDocId?: string

  // AST chunker: minimum function body lines to produce a standalone chunk.
  // Functions shorter than this are merged into the preceding chunk.
  minFunctionLines?: number      // default: 3

  // Heading chunker: minimum heading depth to split on.
  // depth 1 = split on h1 only; depth 2 = h1 + h2; etc.
  maxHeadingDepth?: number       // default: 6 (all headings)
}

// ── Registry ─────────────────────────────────────────────────────────────────

type ChunkerFactory = () => Chunker

interface ChunkerRegistry {
  register(id: string, factory: ChunkerFactory, languages: string[]): void
  get(id: string): Chunker | undefined
  getForLanguage(language: string): Chunker[]  // returns all chunkers supporting this language
  list(): string[]                              // returns all registered chunker IDs
}

// The global registry is populated at module load time via static constructors:
//   ChunkerRegistry.register('ast:treesitter:ts', () => new TreeSitterChunker({ language: 'typescript' }), ['typescript'])
//   ChunkerRegistry.register('heading:markdown',  () => new HeadingChunker({ syntax: 'markdown' }), ['markdown'])
```

// ── Chunker selection strategy for mixed-format documents ──────────────────────

interface ChunkerPriority {
  chunkerId: string     // registered chunker ID
  order: number         // execution order (lower runs first)
}

// For mixed-format documents (e.g., a .md file with TypeScript code blocks):
// 1. The heading chunker runs first (order: 0), producing section-level chunks.
// 2. The AST chunker runs on any section detected as fenced code blocks (order: 1).
// 3. If both chunkers produce chunks, heading chunks are the parent and AST chunks
//    are nested children. Headings that contain no code blocks remain as heading-only chunks.

// ── Source-map invalidation ────────────────────────────────────────────────────

type ChunkStaleReason = 'source_updated' | 'chunker_upgraded' | 'ttl_expired'

interface StaleChunkConfig {
  // Chunks with sourceSha older than this threshold (in days) are re-chunked
  // on the next ingest pass. Default: 30.
  staleThresholdDays: number
}

// When a source document's SHA changes, existing chunks with the old sourceSha
// are stale. On ingest, stale chunks are re-chunked and replaced.

**Error taxonomy:**

```ts
class PermanentChunkingError extends Error {
  constructor(message: string, public readonly chunkerId: string) {
    super(message); this.name = 'PermanentChunkingError'
  }
}

class TransientChunkingError extends Error {
  constructor(message: string, public readonly chunkerId: string) {
    super(message); this.name = 'TransientChunkingError'
  }
}
```

---

## 4. `@adhd/sox-hybrid-search` — Cross-encoder reranker

**Feature changes:**
- Cross-encoder reranker as an optional refinement step after hybrid (BM25 + vector) fusion
- Configurable mode: `always-on` / `threshold-gated` / `skip`
- Reranker runs in a worker thread (BL-11: ONNX never on main thread)
- Threshold-gated mode: only rerank when the top-1 hybrid score is below a configurable threshold
- Cross-encoder is a separate ONNX model from the embedding model — loaded on demand, not at startup
- Primary reranker: MiniCheck (flan-t5-large, 770M params, 64–110ms/claim). Alternatives: `cross-encoder/nli-deberta-v3-base` (90.04% MNLI — accuracy-optimized) and `cross-encoder/nli-MiniLM2-L6-H768` (86.89% MNLI — throughput-optimized)

### 4A. Use cases & design drivers

| Use case | Candidate count | Rerank mode | Latency budget | Recall gain |
|---|---|---|---|---|
| **Enterprise legal search** | 50K docs → top-50 candidates | always-on | <500ms | +17.4% Recall@5 |
| **Customer support FAQ** | 50K entries → top-20 candidates | threshold-gated | <200ms | Catches paraphrases |
| **Academic paper retrieval** | 10M papers → top-50 candidates | always-on | <200ms | Improves claim-support precision |

**Cross-cutting requirements:**
- Reranker never changes the candidate pool — it re-orders only; filtered candidates stay filtered
- `threshold-gated` mode uses hybrid fusion score (RRF-normalized [0,1]); threshold applies to the highest-scored candidate
- Cross-encoder model is specified independently from the bi-encoder embedding model
- Reranker latency is included in the total search latency metric — never hidden

### 4B. Interfaces

```ts
// ── Reranker config (embedded in HybridSearchConfig) ─────────────────────────

interface CrossEncoderConfig {
  mode: 'always-on' | 'threshold-gated' | 'skip'

  // ONNX model identifier for the cross-encoder.
  // Separate from the bi-encoder used for initial vector retrieval.
  // Primary: MiniCheck (flan-t5-large, 770M params). Alternatives:
  //   accuracy-optimized — cross-encoder/nli-deberta-v3-base (90.04% MNLI accuracy)
  //   throughput-optimized — cross-encoder/nli-MiniLM2-L6-H768 (86.89% MNLI accuracy)
  modelId: string                // e.g. 'MiniCheck'

  // Maximum candidates to pass to the reranker.
  // Reranking is O(n²) in cross-encoder — cap to control latency.
  maxCandidates?: number         // default: 50

  // Threshold-gated mode: rerank only when max(hybridScores) < threshold.
  // Range: [0, 1]. Default: 0.4.
  gateThreshold?: number

  // Worker thread pool size for cross-encoder inference.
  // Default: 1 (cross-encoders are memory-heavy; one worker is usually sufficient).
  // Must be at least 1 if mode !== 'skip'.
  workers?: number
}

// ── Reranker interface ───────────────────────────────────────────────────────

interface CrossEncoder {
  readonly metadata: {
    modelId: string
    maxTokens: number            // cross-encoders have tight token limits (typically 512)
  }

  // Score query-candidate pairs. Returns scores in same order as candidates.
  // Higher score = more relevant.
  // Throws TransientEmbeddingError on ONNX worker failure.
  rerank(
    query: string,
    candidates: Array<{ id: number | string; text: string }>,
    opts?: { timeoutMs?: number }
  ): Promise<Float32Array>

  // Batch rerank — multiple queries against their respective candidate sets.
  // Each entry in the result array corresponds to one query's scores.
  rerankBatch(
    queries: string[],
    candidateSets: Array<Array<{ id: number | string; text: string }>>,
    opts?: { timeoutMs?: number }
  ): Promise<Float32Array[]>

  // Release the ONNX model from memory. After calling, rerank() throws
  // ResolutionError until the model is reloaded.
  dispose(): Promise<void>
}

// ── Factory ──────────────────────────────────────────────────────────────────

interface CrossEncoderConfig {
  modelId: string
  options?: {
    maxTokens?: number           // default: 512
    workers?: number             // default: 1
  }
}

function createCrossEncoder(config: CrossEncoderConfig): Promise<CrossEncoder>
```

**Error taxonomy** — reuses `TransientEmbeddingError`, `PermanentEmbeddingError`, `ResolutionError`
from `@adhd/sox-embedding-provider`. Cross-encoder errors are a subset: no new error classes.

**Relationship to vector-store and embedding-provider:**
- Cross-encoder uses the same `fastembed` worker thread pool (separate worker instance, same pool manager)
- `createCrossEncoder` internally calls `createEmbeddingProvider({ type: 'fastembed', model: modelId })` — the cross-encoder is an embedding provider with different semantics
- `maxTokens` for cross-encoders is typically 512 — documents exceeding this are truncated (not chunked)

---

## 5. `@adhd/sox-memory-core` — Parent-context & late chunking

**Feature changes:**
- Parent-context chunk expansion in `memoryRecall()`: retrieve small chunks for precision, inflate to parent document/granule for LLM context
- Late chunking aggregation option: encode full document, mean-pool per chunk boundary at retrieval time
- Expansion strategy is configurable per-query via `MemoryRecallOptions`
- Late chunking trades storage efficiency for recall-time compute; off by default

### 5A. Use cases & design drivers

| Use case | Chunk size | Expansion target | Late chunking value |
|---|---|---|---|
| **Legal brief generation** | Clause (50–200 tokens) | Contract section (1000–4000 tokens) | None — clauses are pre-chunked by headings |
| **Medical literature review** | Finding (100–300 tokens) | Study abstract + methodology (500–1500 tokens) | High — full-text encoding avoids chunk boundary information loss |
| **Code migration assistant** | Function call (20–80 tokens) | Enclosing function (100–500 tokens) | Medium — AST boundaries are clean but late chunking adds context |

**Cross-cutting requirements:**
- Parent-context expansion must remain within the LLM context window — hard cap at `maxContextTokens`
- Late chunking stores one vector per document; retrieval-time mean-pooling produces per-chunk vectors on the fly
- Expansion is recursive: chunk → parent granule → parent document → ... up to `maxDepth`
- Both features are opt-in at query time — default behavior is unchanged from current `memoryRecall()`

### 5B. Interfaces

```ts
// ── Parent-context expansion ─────────────────────────────────────────────────

interface ParentContextConfig {
  // Maximum depth of parent expansion. 0 = no expansion (current behavior).
  // 1 = expand to immediate parent only. 2 = expand to grandparent, etc.
  maxDepth: number               // default: 0

  // Maximum total tokens across all expanded chunks.
  // Expansion stops adding chunks once this limit is reached.
  maxContextTokens: number       // default: 4096

  // How to aggregate expanded text into the LLM prompt.
  joinStrategy: 'contiguous' | 'separator' | 'structured' | 'truncate-tail'
  // 'truncate-tail' cuts expanded text from the end when maxContextTokens is exceeded,
  // sets MemoryRecallResult.metadata.expansionTruncated = true, and continues
  // normally instead of throwing ExpansionOverflowError.

  // Separator for 'separator' strategy. Default: '\n\n---\n\n'.
  separator?: string

  // Whether to include the original (small) chunk text even when expansion
  // duplicates it. Default: true (original chunk is always included).
  includeOriginal?: boolean
}

// ── Late chunking ────────────────────────────────────────────────────────────

interface LateChunkingConfig {
  // Enable late chunking for this query.
  enabled: boolean               // default: false

  // Chunk boundaries to use for mean-pooling at retrieval time.
  // These are stored alongside the full-document embedding.
  boundaries: Array<{ startToken: number; endToken: number; metadata?: Record<string, unknown> }>

  // Overlap between adjacent chunks in tokens. Default: 0.
  overlapTokens?: number
}

// ── Extended recall options ──────────────────────────────────────────────────

interface MemoryRecallOptions {
  // Existing fields...
  query: string
  topK?: number
  filter?: NodeFilter

  // NEW — parent-context expansion
  parentContext?: ParentContextConfig

  // NEW — late chunking
  lateChunking?: LateChunkingConfig
}

// ── Recall result with expansion ─────────────────────────────────────────────

interface MemoryRecallResult {
  chunks: Array<{
    chunk: Chunk
    score: number

    // Expanded context for LLM consumption. Empty string if no expansion configured.
    expandedText: string

    // All chunks that were merged into expandedText (including the original).
    expansionSources: Array<{
      chunk: Chunk
      depth: number              // 0 = original retrieved chunk; 1 = parent; 2 = grandparent; etc.
    }>
  }>

  metadata: {
    totalChunksRetrieved: number
    totalChunksAfterExpansion: number
    lateChunkingApplied: boolean
    totalTokensAfterExpansion: number
    expansionTruncated: boolean   // true when joinStrategy 'truncate-tail' cut text
  }
}

**Error taxonomy:**

```ts
class ExpansionOverflowError extends Error {
  constructor(
    message: string,
    public readonly requestedTokens: number,
    public readonly maxTokens: number
  ) {
    super(message); this.name = 'ExpansionOverflowError'
  }
}
// ExpansionOverflowError is thrown only when joinStrategy !== 'truncate-tail'.
// With 'truncate-tail', expansion proceeds with truncation instead of throwing.
```

**Relationship to ingest and hybrid-search:**
- `Chunk.sourceMap` (from ingest package) provides the line-range key for parent lookups
- `Chunk.parentDocId` is the join key for parent-context expansion — chunks sharing a `parentDocId` form the expansion pool
- Hybrid search scores flow into `MemoryRecallResult.chunks[].score` unchanged; expansion does not re-rank

---

## 6. Decisions log

| # | Decision | Rationale | Affected packages |
|---|---|---|---|
| D1 | All ONNX workloads use the same `fastembed` worker thread pattern from embedding-provider | Prevents thread-pool multiplication; worker lifecycle (load → warm → infer → dispose) is already production-proven in the existing provider | embed, vector-store, hybrid-search |
| D2 | Cross-encoder reuses `TransientEmbeddingError` / `PermanentEmbeddingError` from embedding-provider | Cross-encoder is semantically an embedding model (text → scores); adding parallel error hierarchies creates unnecessary surface area | hybrid-search |
| D3 | `VectorBackend` IS the adapter — no auto-select needed | Both `SqliteVectorBackend` and `LanceDbVectorBackend` implement the same interface. Callers choose the backend by which factory they call. The existing `reembed()` function handles cross-backend copies. No auto-select, no migration logic, no config-driven backend switching. | vector-store |
| D4 | Chunker registry is populated at build time via static constructors | No runtime reflection, no dynamic registration from untrusted sources; IDEs and `tsc` can tree-shake unused chunkers | ingest |
| D5 | Parent-context expansion uses `Chunk.parentDocId` as the join key | `parentDocId` is the only cross-package identifier already present in every chunk; avoids adding a new foreign-key field | ingest, memory-core |
| D6 | Late chunking boundaries are stored alongside the full-document embedding, not in a separate table | The boundaries array is small (<1KB per document); a separate table would double the join overhead at recall time | memory-core |
| D7 | `maxTokens` on embedding provider is advisory — exceeding it triggers chunk-then-mean-pool, not truncation | Truncation silently loses tail-of-text signal (the most common location for conclusions/citations); mean-pool preserves all token information at a small compute cost | embed, ingest |
| D8 | Auto-select never down-shifts from ANN to brute-force by default | Once the index is built, switching back would require a full re-index; `allowRevert` exists as an explicit escape hatch | vector-store |
| D9 | Reranker mode `threshold-gated` evaluates the max hybrid fusion score [0,1] | RRF fusion normalizes scores to [0,1]; a low max score indicates the top candidate is weakly relevant — precisely the scenario where reranking adds value | hybrid-search |
| D10 | Cross-encoder is loaded on demand, not at startup | Cross-encoders are large (300M–1B params) and used only on a subset of queries; pre-loading wastes RAM for deployments that rarely rerank | hybrid-search |

---

## 7. Metrics & observability

Each package exposes the following key metrics. Metric names follow the
OpenMetrics convention (gauge / counter / histogram). The plan defines WHAT
to instrument, not how — no specific metric SDK is required.

### `@adhd/sox-embedding-provider`

| Metric | Type | Labels | Description |
|---|---|---|---|
| `sox_embed_count` | counter | `model`, `status` | Total embed calls, tagged by model and success/error |
| `sox_embed_latency_ms` | histogram | `model` | Embed latency distribution per model |
| `sox_embed_tokens_total` | counter | `model` | Cumulative tokens processed per model |

### `@adhd/sox-vector-store`

| Metric | Type | Labels | Description |
|---|---|---|---|
| `sox_vector_count` | gauge | `backend`, `model` | Current vector count per backend+model |
| `sox_vector_search_latency_ms` | histogram | `backend` | Search latency distribution per backend |
| `sox_vector_space_count` | gauge | — | Number of active vector spaces |

### `@adhd/sox-ingest`

| Metric | Type | Labels | Description |
|---|---|---|---|
| `sox_chunk_count` | counter | `chunker` | Total chunks produced per chunker |
| `sox_chunk_bytes_total` | counter | `chunker` | Cumulative bytes chunked per chunker |
| `sox_chunk_error_count` | counter | `chunker` | Total chunking errors per chunker |

### `@adhd/sox-hybrid-search`

| Metric | Type | Labels | Description |
|---|---|---|---|
| `sox_search_latency_ms` | histogram | `reranked`, `backend` | End-to-end search latency, flagged by whether reranking was applied |
| `sox_search_rerank_fraction` | gauge | — | Fraction of queries that triggered reranking (threshold-gated mode) |
| `sox_search_recall_at_k` | histogram | `k` | Recall@k distribution (requires ground-truth eval set) |

### `@adhd/sox-memory-core`

| Metric | Type | Labels | Description |
|---|---|---|---|
| `sox_expansion_depth` | gauge | `maxDepth` | Distribution of expansion depths used |
| `sox_expansion_tokens_total` | counter | — | Cumulative tokens emitted by parent-context expansion |
| `sox_expansion_overflow_count` | counter | — | Count of expansions that hit maxContextTokens (non-truncating strategies) |

---

## 8. Spec gaps

- LanceDB remote (cloud) backend not yet specified — current scope is local filesystem only
- Chunker hot-reload (watch mode for development) deferred to post-MVP
- Parent-context expansion caching (memoize expansion for repeated queries) deferred — requires eviction policy design
- Cross-encoder model download progress / streaming model fetch not yet specified
