# @adhd/sox-* Substrate — Published Surface

Complete reference for the **11 substrate packages** (8 core + 2 extended + 1 utility) that form the foundation of the sox ecosystem: source abstraction, task durability, vector persistence, semantic chunking, hybrid retrieval, embeddings, blob storage, claim verification, knowledge graphs, and batch analysis.

**Status:** All packages are shipped (v0.1.0+), real-backend implementations, zero stubs.

**All packages are ESM.** See [Consuming from another workspace](#consuming-from-another-workspace) if your repo is a monorepo peer (agent-source, project-xyz, etc.).

---

## Quick reference

### Core packages (8)

| Package | Purpose | Entrypoint |
|---------|---------|-----------|
| **source-provider** | Unified SCM/filesystem abstraction (GitHub, Bitbucket, local) — no clone | `@adhd/sox-source-provider` |
| **task-queue** | Durable SQLite task queue + worker pool + scheduler | `@adhd/sox-task-queue` |
| **vector-store** | Multi-space vector persistence (sqlite-vec + LanceDB ANN) | `@adhd/sox-vector-store` |
| **ingest** | Semantic chunking (tree-sitter AST + heading), content hashing, summarization | `@adhd/sox-ingest` |
| **embedding-provider** | Text→vector ONNX embeddings (fastembed local default) | `@adhd/sox-embedding-provider` |
| **hybrid-search** | Vector + text fusion ranker (mechanism-agnostic RRF/max-score) | `@adhd/sox-hybrid-search` |
| **blob-store** | Content-addressable storage, mark-and-sweep GC, integrity verification | `@adhd/sox-blob-store` |
| **claim-verification** | NLI-based claim grounding (worker-thread ONNX inference) | `@adhd/sox-claim-verification` |

### Extended packages (2)

| Package | Purpose | Entrypoint |
|---------|---------|-----------|
| **graph-store** | Bi-temporal knowledge graph (drizzle-orm, FTS5, supersession chains) | `@adhd/sox-graph-store` |
| **analysis** | Clustering, near-dup detection, graph algorithms (topoSort, criticalPath, packBatches) | `@adhd/sox-analysis` |

### Utilities (1)

| Package | Purpose | Entrypoint |
|---------|---------|-----------|
| **manifest** | Extension manifest schema + validation | `@adhd/sox-manifest` |

---

## Package details

### @adhd/sox-source-provider

**Purpose:** Unified abstraction for enumerating and retrieving file content from GitHub, Bitbucket, and the local filesystem—**without cloning**. No `git clone`, no working copy, no `.git` directory: pure API + filesystem reads.

**Public API:**

```typescript
interface SourceRef {
  scheme: string      // 'github.com', 'bitbucket.org', 'local'
  authority: string   // 'owner', 'workspace'
  path: string        // 'repo[@ref]'
  toString(): string  // 'github.com/owner/repo[@ref]'
}

interface Manifest {
  revision: string
  defaultBranch?: string
  rootUri: SourceRef
  truncated: boolean           // true if entry list is incomplete
  entries: FileEntry[]
  metadata: ManifestMetadata
  fetchedAt: string
}

interface SourceProvider {
  fileTree(ref: SourceRef, path?: string): Promise<Manifest>
  content(ref: SourceRef, path: string): Promise<string | null>
  contentStream?(ref: SourceRef, path: string): Promise<ReadableStream<Uint8Array> | null>
  isAvailable(): boolean
}

interface ProviderRegistry {
  register(scheme: string, factory: ProviderFactory): void
  getProvider(ref: SourceRef): SourceProvider
}
```

**Quickstart:**

```typescript
import { SourceRef, ProviderRegistry, createGitHubProvider, createLocalProvider } from '@adhd/sox-source-provider'

const registry = new ProviderRegistry()
registry.register('github.com', () => createGitHubProvider({ token: process.env.GH_TOKEN }))
registry.register('local', () => createLocalProvider({ basePath: '/repos/my-project' }))

// Enumerate a GitHub repo without cloning
const ref = SourceRef.parse('github.com/anthropics/anthropic-sdk-python@main')
const provider = registry.getProvider(ref)
const manifest = await provider.fileTree(ref, 'src/')

console.log(`Found ${manifest.entries.length} entries`)
for (const entry of manifest.entries) {
  if (entry.type === 'file') {
    const content = await provider.content(ref, entry.path)
    console.log(`${entry.path}: ${content?.length} bytes`)
  }
}
```

**Error hierarchy:** All errors extend `SourceProviderError`. Specific types: `InvalidSourceRefError`, `ProviderAuthenticationError`, `ProviderRateLimitError`, `FileNotFoundError`, `ManifestTooLargeError`.

---

### @adhd/sox-task-queue

**Purpose:** Durable SQLite-backed task queue with atomic priority-aware FIFO claiming, exponential backoff retry, heartbeat-based lease management, worker pool, and croner-backed cron scheduler.

**Public API:**

```typescript
enum TaskStatus {
  Queued = 'queued',
  Running = 'running',
  Completed = 'completed',
  Failed = 'failed',
  Cancelled = 'cancelled',
  Scheduled = 'scheduled',
}

interface Task<T = unknown> {
  id: string
  type: string
  status: TaskStatus
  priority: number
  payload: T
  retryCount: number
  maxRetries: number
  scheduledAt: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  error: string | null
  dead: boolean
  clientRequestId: string | null
  result: string | null
  leaseExpiresAt: string | null
  workerId: string | null
  ttlMs: number | null
}

interface TaskQueue {
  open(): Promise<void>
  close(opts?: { drainTimeoutMs?: number }): Promise<void>
  readonly isOpen: boolean
  enqueue(task: Partial<Task> & { type: string; payload: unknown }): Promise<EnqueueResult>
  enqueueBatch(tasks: Array<...>): Promise<EnqueueResult[]>
  dequeue(workerId: string): Promise<DequeueResult[]>
  complete(taskId: string, result?: unknown): Promise<void>
  fail(taskId: string, error: string): Promise<void>
  heartbeat(taskId: string): Promise<boolean>
  cancel(taskId: string): Promise<boolean>
  get(taskId: string): Promise<Task | null>
  listTasks(filter?: TaskFilter): Promise<Task[]>
  stats(): Promise<QueueStats>
}

interface WorkerPool {
  start(): void
  stop(): Promise<void>
  readonly isRunning: boolean
  readonly activeCount: number
}

function createWorkerPool(config: {
  queue: TaskQueue
  handler: (task: Task) => Promise<void>
  concurrency?: number
  pollIntervalMs?: number
  heartbeatIntervalMs?: number
}): WorkerPool

class Scheduler {
  add(id: string, entry: ScheduledEntry): Promise<void>
  remove(id: string): Promise<void>
  list(): Promise<ScheduledEntry[]>
}
```

**Quickstart:**

```typescript
import { TaskQueue, createWorkerPool, Scheduler } from '@adhd/sox-task-queue'

const queue = new TaskQueue({ dbPath: './queue.db' })
await queue.open()

// Enqueue a task
const result = await queue.enqueue({
  type: 'email-notification',
  payload: { userId: '123', subject: 'Hello' },
  priority: 10,
  maxRetries: 3,
})

console.log(`Task ${result.id} queued (${result.deduplicated ? 'deduped' : 'new'})`)

// Start a worker pool
const pool = createWorkerPool({
  queue,
  concurrency: 4,
  handler: async (task) => {
    console.log(`Processing ${task.type}:${task.id}`)
    // Your handler logic here
    // Call queue.complete(task.id, result) or queue.fail(task.id, error)
  },
})

pool.start()

// Query stats
const stats = await queue.stats()
console.log(`Queue: ${stats.total} tasks, ${stats.runningCount} running, avg latency ${stats.avgProcessingLatencyMs}ms`)

await pool.stop()
await queue.close()
```

**Backoff formula:** `delay = min(1000 * 2^retryCount, 86_400_000)`. On `fail()`, if `retryCount < maxRetries`, the task is requeued with `scheduled_at = now + delay`.

---

### @adhd/sox-vector-store

**Purpose:** Multi-space vector persistence with two real, swappable backends: **sqlite-vec** (brute-force kNN, synchronous, production default) and **@lancedb/lancedb** (on-disk HNSW/IVF-PQ ANN, bridged to sync via worker_threads + synckit).

**Public API:**

```typescript
interface VectorSpace {
  modelId: string
  dim: number
}

interface VectorBackend {
  ensureSpace(space: VectorSpace): void
  listSpaces(): VectorSpace[]
  upsert(id: number, vec: Float32Array, space: VectorSpace): void
  delete(id: number, modelId: string): void
  get(id: number, modelId: string): Float32Array | null
  knn(query: Float32Array, space: VectorSpace, k: number, filter?: VecFilter): Array<{ id: number; score: number }>
  iter(modelId: string, opts?: { filter?: VecFilter }): Iterable<{ id: number; vec: Float32Array }>
}

interface LanceDbVectorBackendConfig {
  lancedbPath: string
  index?: {
    type: 'hnsw' | 'ivf-pq'
    M?: number                   // HNSW default 16
    efConstruction?: number      // HNSW default 200
    numPartitions?: number       // IVF-PQ default sqrt(n)
    numSubVectors?: number       // IVF-PQ default dim/4
    bitsPerSubVector?: number    // IVF-PQ default 8
    metric?: 'cosine' | 'l2' | 'dot'  // default 'cosine'
  }
}

async function reembed(
  backend: VectorBackend,
  provider: EmbedderLike,
  opts: ReembedOpts,
): Promise<ReembedResult>
```

**Quickstart:**

```typescript
import { VectorBackend, openSqliteVecStore, openLanceDbVectorStore } from '@adhd/sox-vector-store'
import Database from 'better-sqlite3'

const db = new Database('./vectors.db')

// Use sqlite-vec (production default, brute-force)
const backend = openSqliteVecStore({ db })

// OR use LanceDB (HNSW/IVF-PQ ANN)
// const backend = openLanceDbVectorStore({
//   db,
//   lancedbPath: './lancedb',
//   index: { type: 'hnsw', M: 16, efConstruction: 200 }
// })

// Ensure a space exists
const space = { modelId: 'text-embedding-3-small', dim: 1536 }
backend.ensureSpace(space)

// Upsert vectors
const vec1 = new Float32Array([0.1, 0.2, 0.3, /* ... */ ])
backend.upsert(1, vec1, space)

// kNN search
const queryVec = new Float32Array([0.15, 0.25, 0.35, /* ... */ ])
const results = backend.knn(queryVec, space, k: 5)
console.log('Top 5 neighbors:', results)

// Iterate all vectors in a space
for (const { id, vec } of backend.iter('text-embedding-3-small')) {
  console.log(`ID: ${id}, vector dims: ${vec.length}`)
}
```

**Key invariant:** `upsert()` throws `SpaceInvariantError` if `vec.length !== space.dim`. A model switch is always an explicit `reembed()` migration, never a hot-swap.

---

### @adhd/sox-ingest

**Purpose:** Write-path transformations for semantic content: SHA-256 hashing, extractive summarization (lead-N sentences, zero LLM), deterministic tag extraction, and **real tree-sitter AST chunking** (cAST algorithm: parse → top-level declarations → never split a function/class).

**Public API:**

```typescript
interface SourceMap {
  sourceStartLine: number
  sourceEndLine: number
  sourceUrl?: string
  sourceSha?: string
}

interface Chunk {
  text: string
  sourceMap: SourceMap
  metadata: {
    chunkerId: string
    language?: string
    heading?: string
    parentDocId?: string
    chunkIndex: number
    isHeadingRoot?: boolean
  }
  embedding?: Float32Array
}

interface Chunker {
  readonly id: string
  readonly supportedLanguages: string[]
  chunk(document: string, options?: ChunkerOptions): Chunk[]
  estimate(document: string): number
}

class ChunkerRegistry {
  register(id: string, factory: ChunkerFactory, languages: string[]): void
  seal(): void
  get(id: string): Chunker | undefined
  getForLanguage(language: string): Chunker[]
}

export const globalChunkerRegistry: ChunkerRegistry

// Pure stateless functions
export function contentHash(text: string): string  // SHA-256 hex
export function extractSummary(text: string, maxSentences?: number): string
export function extractTags(text: string, maxCount?: number): string[]
```

**Quickstart:**

```typescript
import { globalChunkerRegistry, contentHash, extractSummary } from '@adhd/sox-ingest'

// Get the AST chunker for TypeScript
const chunker = globalChunkerRegistry.get('ast:treesitter:ts')
if (!chunker) throw new Error('Tree-sitter chunker not available')

const tsCode = `
export function greet(name: string): string {
  return \`Hello, \${name}!\`
}

export class User {
  constructor(public id: string) {}
}
`

// Chunk by top-level declarations (never splits a function/class)
const chunks = chunker.chunk(tsCode, {
  sourceUrl: 'https://example.com/lib.ts',
  language: 'typescript',
  minFunctionLines: 3,  // Declarations shorter than this merge into the preceding chunk
})

for (const chunk of chunks) {
  console.log(`Chunk ${chunk.metadata.chunkIndex}:`)
  console.log(`  Lines: ${chunk.sourceMap.sourceStartLine}-${chunk.sourceMap.sourceEndLine}`)
  console.log(`  Text: ${chunk.text.substring(0, 50)}...`)
}

// Summarize content
const largeDoc = '...'  // 10,000 words
const summary = extractSummary(largeDoc, 3)  // First 3 sentences, no LLM

// Content hash
const hash = contentHash(largeDoc)
console.log(`SHA-256: ${hash}`)
```

**Supported languages (tree-sitter AST chunker):** TypeScript, Python, Java, C#, Go, Rust, JavaScript (via TypeScript grammar).

**Heading chunker (separate):** Markdown, MDX, reStructuredText, AsciiDoc.

---

### @adhd/sox-embedding-provider

**Purpose:** Pluggable text→vector embedding provider. Config-driven model resolution, async batch-first API (`AsyncIterable`). Default: **fastembed** (local ONNX, deterministic, ≥3M models proven).

**Public API:**

```typescript
interface EmbeddingProvider {
  readonly metadata: {
    modelId: string
    dimensions: number
    isRemote: boolean
    isDeterministic: boolean
    providerUri?: string
  }
  embedSingle(text: string, role?: 'document' | 'query'): Promise<Float32Array>
  embedBatch(texts: string[], role?: 'document' | 'query'): AsyncIterable<Float32Array>
  warmUp(): Promise<void>  // No-op when isDeterministic=false
  dispose(): Promise<void>
}

async function createEmbeddingProvider(config: {
  modelId: string
  provider?: 'fastembed' | 'huggingface'  // default: fastembed
  huggingfaceToken?: string
}): Promise<EmbeddingProvider>
```

**Error types:** `ResolutionError` (factory time only), `TransientEmbeddingError` (retriable), `PermanentEmbeddingError` (not retriable).

**Quickstart:**

```typescript
import { createEmbeddingProvider } from '@adhd/sox-embedding-provider'

// Create a local ONNX embedder
const embedder = await createEmbeddingProvider({
  modelId: 'BAAI/bge-small-en-v1.5',
  provider: 'fastembed',
})

console.log(`Using model: ${embedder.metadata.modelId} (${embedder.metadata.dimensions} dims)`)

// Embed a single text
const vec = await embedder.embedSingle('What is the meaning of life?', 'query')
console.log(`Vector shape: ${vec.length}`)

// Batch embed (async iterable — low memory footprint)
const texts = ['Doc 1', 'Doc 2', 'Doc 3']
const embeddings: Float32Array[] = []
for await (const vec of embedder.embedBatch(texts, 'document')) {
  embeddings.push(vec)
  console.log(`Embedded: ${embeddings.length}/${texts.length}`)
}

await embedder.dispose()
```

**Note:** `embedRole` parameter (`'document' | 'query'`) is accepted for interface compatibility but not yet applied by the fastembed provider.

---

### @adhd/sox-hybrid-search

**Purpose:** Mechanism-agnostic hybrid retrieval ranker: fuses vector + text signals via RRF or max-score normalization. Decoupled backend storage (SQLite backend wires VectorBackend + GraphBackend via dependency injection).

**Public API:**

```typescript
interface SearchQuery {
  text?: string
  vec?: Float32Array
  filters?: Record<string, unknown>
}

interface SearchResult {
  id: number | string
  score: number
  textScore?: number
  vecScore?: number
  explain?: Record<string, unknown>
}

interface SearchBackend {
  search(query: SearchQuery, opts?: { topK?: number }): Promise<SearchResult[]>
}

class SqliteSearchBackend implements SearchBackend {
  constructor(config: {
    vectorBackend: VectorBackend
    graphBackend: GraphBackend
    normalizer?: 'minmax' | 'l2' | 'zscore'  // default: minmax
    fusionMode?: 'rrf' | 'maxscore'          // default: rrf
  })
  search(query: SearchQuery, opts?: { topK?: number }): Promise<SearchResult[]>
}

// Pure fusion functions (no storage dep)
export function fuse(
  signals: Array<{ name: string; values: number[] }>,
  weights: Record<string, number>,
  mode: 'rrf' | 'maxscore',
): number[]

export function normalize(scores: number[], strategy: 'minmax' | 'l2' | 'zscore'): number[]
```

**Quickstart:**

```typescript
import { SqliteSearchBackend } from '@adhd/sox-hybrid-search'

const backend = new SqliteSearchBackend({
  vectorBackend,    // from @adhd/sox-vector-store
  graphBackend,     // from @adhd/sox-graph-store
  normalizer: 'minmax',
  fusionMode: 'rrf',
})

// Hybrid search: vector + text
const results = await backend.search({
  text: 'How to implement a singleton pattern',
  vec: embeddingVec,  // from @adhd/sox-embedding-provider
  filters: { language: 'typescript' },
}, { topK: 10 })

for (const result of results) {
  console.log(`${result.id}: score=${result.score.toFixed(3)}`)
  console.log(`  text=${result.textScore?.toFixed(3)}, vec=${result.vecScore?.toFixed(3)}`)
}

// Degrade gracefully if one signal missing:
// - No vec? Falls back to text-only search.
// - No text? Falls back to vec-only search.
// - Both absent? Throws.
```

**Fusion modes:**
- **RRF (Reciprocal Rank Fusion):** Converts rankings to scores, more stable.
- **max-score:** Combines normalized scores directly.

---

### @adhd/sox-blob-store

**Purpose:** Content-addressable blob storage (SHA-256 CAS). Two-phase atomic write, SQLite reference tracking, mark-and-sweep GC with grace periods, in-process FD guard, integrity verification.

**Public API:**

```typescript
interface StoreConfig {
  basePath: string
  tempDir?: string
  refDbPath?: string
  maxBlobSize?: number                // default: 1GB
  gc?: {
    gracePeriodMs?: number
    maxDeletePerCycle?: number
    autoGcIntervalMs?: number
  }
  verifyOnRead?: boolean
  verifyOnWrite?: boolean
}

class BlobStore {
  readonly isOpen: boolean
  open(): Promise<void>
  close(): Promise<void>
  put(data: Uint8Array): Promise<string>                     // returns SHA-256 hex
  putStream(stream: ReadableStream<Uint8Array>): Promise<string>
  get(hash: string): Promise<Uint8Array | null>
  getStream(hash: string): Promise<ReadableStream<Uint8Array> | null>
  delete(hash: string): Promise<boolean>
  exists(hash: string): Promise<boolean>
  verify(hash: string): Promise<VerificationResult>          // THROWS IntegrityMismatch
  addRef(blobHash: string, referrer: string): Promise<void>
  removeRef(blobHash: string, referrer: string): Promise<void>
  getRefsForReferrer(referrer: string): Promise<string[]>
  gc(opts?: { dryRun?: boolean }): Promise<GcResult>
}

function createBlobStore(config: StoreConfig): BlobStore
```

**Quickstart:**

```typescript
import { createBlobStore } from '@adhd/sox-blob-store'

const store = createBlobStore({
  basePath: './blobs',
  tempDir: './blobs/temp',
  gc: { gracePeriodMs: 86400000 },  // 24h grace period
})

await store.open()

// Store content (idempotent CAS)
const data = Buffer.from('Hello, world!')
const hash = await store.put(data)
console.log(`Stored at: ${hash}`)

// Track references
await store.addRef(hash, 'document:123')
await store.addRef(hash, 'document:456')

// Retrieve
const retrieved = await store.get(hash)
console.log(`Retrieved: ${retrieved?.toString()}`)

// Verify integrity
const verification = await store.verify(hash)
if (verification.match) {
  console.log('Integrity check passed')
} else {
  console.log('Corruption detected!')
}

// Run garbage collection
const gcResult = await store.gc({ dryRun: false })
console.log(`GC freed ${gcResult.bytesFreed} bytes`)

await store.close()
```

**Invariants:**
- `put()` is always idempotent (content-hash dedup).
- `get()` returns `null` for not-found; throws `IntegrityMismatch` only on corruption.
- GC never deletes a blob with an open FD in the in-process guard.

---

### @adhd/sox-claim-verification

**Purpose:** NLI-based (Natural Language Inference) claim grounding. Cross-encoder reranking via ONNX worker thread, embedding pre-filter for topic gating, LRU result cache.

**Public API:**

```typescript
interface Claim {
  id: string
  text: string
  language?: string
  context?: string
  metadata?: Record<string, unknown>
}

interface SourceRef {
  id: string
  text: string
  language?: string
  title?: string
  url?: string
  metadata?: Record<string, unknown>
}

type EntailmentLabel = 'entails' | 'contradicts' | 'neutral' | 'unverifiable'

interface VerificationResult {
  claimId: string
  sourceResults: Array<{
    sourceId: string
    entailment: EntailmentLabel
    confidence: number
    preFilterSkipped: boolean
    timingMs: number
  }>
  aggregateConfidence: number
  modelId: string
  totalTimingMs: number
}

interface ClaimVerifierConfig {
  modelId: string
  modelVersion: string
  workerCount?: number                // default: 2
  maxQueueDepth?: number
  embeddingProvider?: EmbeddingProvider
  cache?: { maxSize?: number; ttlMs?: number }
}

async function createClaimVerifier(config: ClaimVerifierConfig): Promise<ClaimVerifier>

interface ClaimVerifier {
  readonly isReady: boolean
  verify(claim: Claim, source: SourceRef): Promise<VerificationResult>
  verifyBatch(pairs: Array<{ claim: Claim; sources: SourceRef[] }>): Promise<VerificationResult[]>
  healthCheck(): Promise<VerifierHealth>
  shutdown(): Promise<void>
}
```

**Quickstart:**

```typescript
import { createClaimVerifier } from '@adhd/sox-claim-verification'

const verifier = await createClaimVerifier({
  modelId: 'cross-encoder/nli-deberta-v3-large',
  modelVersion: '1.0.0',
  workerCount: 2,
  cache: { maxSize: 10000 },
})

// Verify a claim against a source
const result = await verifier.verify(
  { id: '1', text: 'Paris is the capital of France', language: 'en' },
  { id: 'src1', text: 'France is located in Western Europe, with Paris as its capital.' }
)

console.log(`Entailment: ${result.sourceResults[0].entailment}`)
console.log(`Confidence: ${result.sourceResults[0].confidence.toFixed(3)}`)

// Verify multiple claims at once
const claims = [
  { id: '1', text: 'Claim A' },
  { id: '2', text: 'Claim B' },
]
const sources = [
  { id: 's1', text: 'Source 1 text' },
  { id: 's2', text: 'Source 2 text' },
]

const batchResults = await verifier.verifyBatch([
  { claim: claims[0], sources: [sources[0], sources[1]] },
  { claim: claims[1], sources: [sources[0]] },
])

// Health check
const health = await verifier.healthCheck()
console.log(`Ready: ${health.isReady}, Active jobs: ${health.activeJobs}`)

await verifier.shutdown()
```

**Note:** ONNX inference runs exclusively in worker threads (never on the main thread).

---

### @adhd/sox-analysis

**Purpose:** Batch corpus derivation: density-based clustering, near-duplicate detection, importance scoring, auto-linking, and pure graph algorithms (topological sort, critical path, cycle detection, batch bin-packing).

**Public API:**

```typescript
interface ClusterOpts {
  modelId?: string
  minClusterSize?: number
  threshold?: number
}

interface ClusterResult {
  communities: Array<{
    id: number
    memberIds: number[]
    label?: string
  }>
  unclustered: number[]
  durationMs: number
}

interface NearDupOpts {
  nearDupThreshold?: number
  distinctThreshold?: number
  modelId?: string
  limit?: number
}

interface NearDupPair {
  a: number
  b: number
  cosine: number
  status: 'near_dup' | 'candidate' | 'distinct'
}

interface ImportanceOpts {
  filter?: NodeFilter
  dryRun?: boolean
}

interface AutoLinkOpts {
  filter?: NodeFilter
  similarityThreshold?: number
  maxLinksPerNode?: number
  rel?: EdgeRel
  dryRun?: boolean
}

interface TopoSortResult {
  order: number[]
  waves: Map<number, number>     // wave assignment for parallel execution
  cycle: number[] | null
}

interface PackItem {
  id: number
  cost: number
  resources: string[]
  deps: number[]
  group?: string
}

interface PackResult {
  batches: Array<{ items: number[]; cost: number }>
  totalCost: number
}

// DB-integrated functions take VectorBackend + GraphBackend directly
async function clusterVectors(
  backend: VectorBackend,
  opts?: ClusterOpts,
): Promise<ClusterResult>

async function detectNearDups(
  backend: VectorBackend,
  opts?: NearDupOpts,
): Promise<NearDupPair[]>

async function computeImportance(
  graph: GraphBackend,
  opts?: ImportanceOpts,
): Promise<{ nodesScored: number }>

async function buildAutoLinks(
  graph: GraphBackend,
  vectorBackend: VectorBackend,
  opts?: AutoLinkOpts,
): Promise<{ linksCreated: number }>

async function runBatchEnrich(
  graph: GraphBackend,
  vectorBackend: VectorBackend,
  opts?: BatchOpts,
): Promise<BatchResult>

// Pure graph algorithms (work over any graph, not just graph-store)
function topoSort(
  nodeIds: number[],
  getEdges: (nodeId: number) => number[],
): TopoSortResult

function criticalPath(
  nodeIds: number[],
  getEdges: (nodeId: number) => number[],
  getWeight?: (nodeId: number) => number,
): number[]

function detectCycles(
  nodeIds: number[],
  getEdges: (nodeId: number) => number[],
): number[][]  // array of cycles (each cycle is a path of node IDs)

function packBatches(items: PackItem[], opts: { B: number; W: number }): PackResult
```

**Quickstart:**

```typescript
import {
  clusterVectors,
  detectNearDups,
  computeImportance,
  topoSort,
  criticalPath,
  packBatches,
} from '@adhd/sox-analysis'

// Cluster vectors in-process (density-based)
const clusters = await clusterVectors(vectorBackend, {
  modelId: 'BAAI/bge-small-en-v1.5',
  minClusterSize: 5,
  threshold: 0.85,
})

for (const community of clusters.communities) {
  console.log(`Cluster ${community.id}: ${community.memberIds.length} members`)
}

// Find near-duplicates (cosine similarity threshold)
const nearDups = await detectNearDups(vectorBackend, {
  nearDupThreshold: 0.95,
  distinctThreshold: 0.8,
})

for (const pair of nearDups) {
  if (pair.status === 'near_dup') {
    console.log(`Likely duplicate: ${pair.a} ≈ ${pair.b} (${pair.cosine.toFixed(3)})`)
  }
}

// Score node importance (in-degree, out-degree, recency, near-dup count)
const importanceResult = await computeImportance(graphBackend)
console.log(`Scored ${importanceResult.nodesScored} nodes`)

// Topological sort with wave assignment (for parallel dispatch)
const sorted = topoSort(nodeIds, (id) => getOutgoingEdgeIds(id))
console.log(`Waves: ${sorted.waves.size}`)
for (let w = 0; w < sorted.waves.size; w++) {
  const waveNodes = [...sorted.waves.entries()]
    .filter(([_, wave]) => wave === w)
    .map(([id, _]) => id)
  console.log(`  Wave ${w}: [${waveNodes.join(', ')}]`)
}

// Critical path for scheduling
const critPath = criticalPath(nodeIds, (id) => getOutgoingEdgeIds(id))
console.log(`Critical path (longest): ${critPath.join(' → ')}`)

// Detect all cycles (for error reporting)
const cycles = detectCycles(nodeIds, (id) => getOutgoingEdgeIds(id))
if (cycles.length > 0) {
  console.warn(`Found ${cycles.length} cycle(s):`)
  for (const cycle of cycles) {
    console.warn(`  ${cycle.join(' → ')} → ${cycle[0]}`)
  }
}

// Bin-packing for batch dispatch (submodular shared resource cost)
const batches = packBatches(items, { B: 3, W: 1000 })  // 3 batches, 1000ms window
console.log(`Packed into ${batches.batches.length} batches`)
for (const batch of batches.batches) {
  console.log(`  Batch: ${batch.items.length} items, cost ${batch.cost}`)
}
```

**Key invariants:**
- **Corpus-level only:** Analysis functions operate over a batch, never per-query. Not on the hot path.
- **Deterministic under model:** Clustering, near-dup detection, and importance scoring must record the `modelId` they were computed under. A model switch requires re-analysis.
- **Incremental by default:** `computeImportance()` and `buildAutoLinks()` skip already-scored nodes ([def:deterministic-first]).
- **DB-integrated, not wrapped:** Functions take `VectorBackend` and `GraphBackend` directly; no `CorpusBackend` wrapper.
- **Pure graph algorithms:** `topoSort()`, `criticalPath()`, `detectCycles()` accept a caller-supplied `getEdges()` callback, so they work over any graph representation.
- **Submodular packing:** `packBatches()` assumes shared resource cost is paid once per batch, not per-item.

**Error types:**
- `ClusteringError`: density-clustering failure (memory, numerical).
- `GraphTopologyError`: cycle detected in an expected DAG.
- `PackingError`: impossible packing (item cost > batch capacity).

---

### @adhd/sox-graph-store

**Purpose:** Bi-temporal knowledge graph over SQLite. Nodes + edges with `t_valid`/`t_invalid` correctness, TTL (`tExpires`), content-hash dedup, FTS5 sync, namespace isolation, and supersession chains (audit-preserving mutations).

**Public API:**

```typescript
interface NodeMeta {
  namespace?: string       // default: 'global'
  nodeType?: string
  tags?: string[]
  metadata?: Record<string, unknown>
  confidence?: number
  tExpires?: string
  importance?: number
}

interface Node {
  id: string
  name: string
  content: string
  metadata: NodeMeta
  t_created: string
  t_valid: string | null
  t_invalid: string | null
  isStale: boolean
}

interface Edge {
  src: string
  dst: string
  rel: string                   // e.g., 'MENTIONS', 'DEPENDS_ON', 'SUPERSEDES'
  metadata?: Record<string, unknown>
}

interface GraphBackend {
  writeNode(node: Partial<Node> & { id: string; name: string }): Promise<string>
  writeNodeBatch(nodes: Array<...>): Promise<string[]>
  writeEdge(src: string, dst: string, rel: string, metadata?: unknown): Promise<void>
  getNode(id: string, opts?: { validAt?: string }): Promise<Node | null>
  getNodes(ids: string[], opts?: { validAt?: string }): Promise<Node[]>
  getNeighbors(nodeId: string, rels?: string[]): Promise<Node[]>
  searchNodes(query: string, opts?: { limit?: number }): Promise<Node[]>
  invalidate(nodeId: string, reason?: string): Promise<void>
  supersede(oldNodeId: string, newNode: Partial<Node>): Promise<string>
  touch(nodeId: string, metadata: Partial<NodeMeta>): Promise<void>
}

function openGraphBackend(config: {
  dbPath: string
  namespaces?: string[]
  capabilities?: GraphBackendCapabilities
}): GraphBackend
```

**Quickstart:**

```typescript
import { openGraphBackend } from '@adhd/sox-graph-store'

const backend = openGraphBackend({
  dbPath: './graph.db',
  namespaces: ['global', 'local'],
  capabilities: { bitemporal: true, fullTextSearch: true },
})

// Write a node
const nodeId = await backend.writeNode({
  id: 'claim:001',
  name: 'Paris is the capital of France',
  content: 'This is a geographic claim about France and its capital city.',
  metadata: {
    namespace: 'claims',
    nodeType: 'claim',
    tags: ['geography', 'france'],
    confidence: 0.95,
  },
})

// Link it to sources via edges
await backend.writeEdge(nodeId, 'source:wikipedia', 'GROUNDED_IN', {
  strength: 'strong',
})

// Search nodes by full-text
const results = await backend.searchNodes('capital France', { limit: 10 })
for (const node of results) {
  console.log(`${node.name} (confidence: ${node.metadata.confidence})`)
}

// Retrieve with temporal constraint
const node = await backend.getNode(nodeId, { validAt: '2026-01-01T00:00:00Z' })

// Update metadata without mutating (no SUPERSEDES edge)
await backend.touch(nodeId, {
  confidence: 0.98,
  tExpires: new Date(Date.now() + 86400000).toISOString(),
})

// Supersede (creates new node + SUPERSEDES edge)
const newNodeId = await backend.supersede(nodeId, {
  name: 'Updated: Paris is the capital of France',
  content: 'Updated content with new evidence.',
  metadata: { confidence: 0.99 },
})

// Fetch supersession chain
const chain = await backend.getSupersessionChain(nodeId)
console.log(`Chain length: ${chain.length}`)
```

**Invariants:**
- Records are never deleted; `invalidate()` sets `t_invalid`.
- `touch()` updates mutable metadata without creating a new node.
- `supersede()` mints a new node with a `SUPERSEDES` edge.

---

### @adhd/sox-manifest

**Purpose:** Single source of truth for extension manifest schema. Validation and type enforcement for manifest configuration files.

**Public API:**

```typescript
interface ExtensionManifest {
  id: string                    // must match package.json name field
  name: string
  version: string
  description?: string
  author?: string
  license?: string
  main?: string
  exports?: Record<string, string | Record<string, string>>
  keywords?: string[]
  homepage?: string
  repository?: { type: string; url: string }
  bugs?: { url: string } | string
  publishConfig?: { access: 'public' | 'restricted' }
}

function validate(manifest: unknown): ExtensionManifest  // THROWS ValidationError on invalid input
function validatePartial(manifest: Partial<ExtensionManifest>): Partial<ExtensionManifest>
```

**Error types:** `ValidationError` (schema mismatch), `SchemaVersionMismatch`.

**Quickstart:**

```typescript
import { validate, ValidationError } from '@adhd/sox-manifest'
import * as fs from 'fs'

// Load and validate a manifest
const rawManifest = JSON.parse(fs.readFileSync('extension.json', 'utf-8'))

try {
  const manifest = validate(rawManifest)
  console.log(`Valid: ${manifest.name} v${manifest.version}`)

  // Use typed fields
  if (manifest.exports) {
    for (const [exportPath, target] of Object.entries(manifest.exports)) {
      console.log(`  ${exportPath} → ${target}`)
    }
  }
} catch (error) {
  if (error instanceof ValidationError) {
    console.error(`Manifest validation failed: ${error.message}`)
    console.error(`Failed at field: ${error.path}`)
  } else {
    throw error
  }
}

// Partial validation (for incremental builds)
const partial = validatePartial({
  name: 'my-extension',
  version: '1.0.0',
})
console.log(`Partial: ${partial.name}`)
```

**Key invariant:**
- `id` field must match the `package.json` `name` field (enforced by validator).

---

## Integration example

Here's a complete example wiring multiple substrate packages together for a semantic search + claim verification pipeline:

```typescript
import { SourceRef, ProviderRegistry, createGitHubProvider } from '@adhd/sox-source-provider'
import { TaskQueue, createWorkerPool } from '@adhd/sox-task-queue'
import { openSqliteVecStore } from '@adhd/sox-vector-store'
import { globalChunkerRegistry, contentHash } from '@adhd/sox-ingest'
import { createEmbeddingProvider } from '@adhd/sox-embedding-provider'
import { SqliteSearchBackend } from '@adhd/sox-hybrid-search'
import { createBlobStore } from '@adhd/sox-blob-store'
import { createClaimVerifier } from '@adhd/sox-claim-verification'
import { openGraphBackend } from '@adhd/sox-graph-store'
import Database from 'better-sqlite3'

async function main() {
  // Initialize stores
  const db = new Database('./substrate.db')
  const vectorBackend = openSqliteVecStore({ db })
  const graphBackend = openGraphBackend({ dbPath: './graph.db' })
  const blobStore = createBlobStore({ basePath: './blobs' })

  await blobStore.open()

  // Initialize providers
  const embedder = await createEmbeddingProvider({ modelId: 'BAAI/bge-small-en-v1.5' })
  const verifier = await createClaimVerifier({ modelId: 'cross-encoder/nli-deberta-v3-large' })

  // Initialize search
  const search = new SqliteSearchBackend({ vectorBackend, graphBackend })

  // Initialize source provider
  const registry = new ProviderRegistry()
  registry.register('github.com', () => createGitHubProvider({ token: process.env.GH_TOKEN }))
  const provider = registry.getProvider(SourceRef.parse('github.com/anthropics/anthropic-sdk-python'))

  // Initialize task queue
  const queue = new TaskQueue({ dbPath: './queue.db' })
  await queue.open()

  // Set up worker pool to process documents
  const pool = createWorkerPool({
    queue,
    handler: async (task) => {
      const { repoPath, language } = task.payload
      const manifest = await provider.fileTree(SourceRef.parse(repoPath))

      // Process each file
      for (const entry of manifest.entries) {
        if (entry.type === 'file' && entry.language === language) {
          const content = await provider.content(SourceRef.parse(repoPath), entry.path)
          if (!content) continue

          // Store in blob store
          const blobHash = await blobStore.put(Buffer.from(content))

          // Chunk the document
          const chunker = globalChunkerRegistry.getForLanguage(language)[0]
          const chunks = chunker.chunk(content, { sourceUrl: entry.path, language })

          // Embed and store chunks
          const space = { modelId: 'BAAI/bge-small-en-v1.5', dim: 384 }
          vectorBackend.ensureSpace(space)

          for (const chunk of chunks) {
            const vec = await embedder.embedSingle(chunk.text)
            const chunkId = contentHash(chunk.text)
            vectorBackend.upsert(parseInt(chunkId.substring(0, 8), 16), vec, space)

            // Store in graph
            await graphBackend.writeNode({
              id: `chunk:${chunkId}`,
              name: chunk.text.substring(0, 100),
              content: chunk.text,
              metadata: { language, file: entry.path, tags: ['code-chunk'] },
            })
          }

          await queue.complete(task.id)
        }
      }
    },
  })

  pool.start()

  // Enqueue processing tasks
  await queue.enqueue({
    type: 'process-repo',
    payload: { repoPath: 'github.com/anthropics/anthropic-sdk-python', language: 'python' },
    priority: 10,
  })

  // Wait a bit for processing
  await new Promise((r) => setTimeout(r, 5000))

  // Perform hybrid search
  const queryVec = await embedder.embedSingle('How do I authenticate with the Anthropic API?')
  const results = await search.search({ text: 'authenticate API', vec: queryVec }, { topK: 5 })

  console.log(`Search results: ${results.length}`)
  for (const result of results) {
    console.log(`  ${result.id}: ${result.score.toFixed(3)}`)
  }

  // Verify a claim
  const claim = { id: 'test', text: 'The API requires an authentication token' }
  const source = { id: 'src1', text: results[0].id.toString() }
  const verification = await verifier.verify(claim, source)
  console.log(`Claim verification: ${verification.sourceResults[0].entailment}`)

  await pool.stop()
  await queue.close()
  await blobStore.close()
  await embedder.dispose()
  await verifier.shutdown()
}

main().catch(console.error)
```

---

## Consuming from another workspace

**Important:** Because the substrate packages use internal `workspace:*` dependencies, consuming them from another repo (e.g., `agent-source`) requires:

1. **File-link the packages** in your `package.json`:

```json
{
  "dependencies": {
    "@adhd/sox-source-provider": "file:../sox-ecosystem/libs/source-provider",
    "@adhd/sox-task-queue": "file:../sox-ecosystem/libs/data/queue/task-queue",
    "@adhd/sox-vector-store": "file:../sox-ecosystem/libs/data/vectors/vector-store",
    "@adhd/sox-ingest": "file:../sox-ecosystem/libs/data/ingest/ingest",
    "@adhd/sox-hybrid-search": "file:../sox-ecosystem/libs/data/search/hybrid-search",
    "@adhd/sox-embedding-provider": "file:../sox-ecosystem/libs/data/embed/embedding-provider",
    "@adhd/sox-blob-store": "file:../sox-ecosystem/libs/data/store/blob-store",
    "@adhd/sox-claim-verification": "file:../sox-ecosystem/libs/data/verify/claim-verification",
    "@adhd/sox-graph-store": "file:../sox-ecosystem/libs/data/graph/graph-store",
    "@adhd/sox-manifest": "file:../sox-ecosystem/libs/manifest"
  }
}
```

2. **Add `pnpm.overrides` in the root `package.json`** to map internal workspace deps to your file-linked paths:

```json
{
  "pnpm": {
    "overrides": {
      "@adhd/sox-source-provider": "file:../sox-ecosystem/libs/source-provider",
      "@adhd/sox-task-queue": "file:../sox-ecosystem/libs/data/queue/task-queue",
      "@adhd/sox-vector-store": "file:../sox-ecosystem/libs/data/vectors/vector-store",
      "@adhd/sox-ingest": "file:../sox-ecosystem/libs/data/ingest/ingest",
      "@adhd/sox-hybrid-search": "file:../sox-ecosystem/libs/data/search/hybrid-search",
      "@adhd/sox-embedding-provider": "file:../sox-ecosystem/libs/data/embed/embedding-provider",
      "@adhd/sox-blob-store": "file:../sox-ecosystem/libs/data/store/blob-store",
      "@adhd/sox-claim-verification": "file:../sox-ecosystem/libs/data/verify/claim-verification",
      "@adhd/sox-graph-store": "file:../sox-ecosystem/libs/data/graph/graph-store",
      "@adhd/sox-manifest": "file:../sox-ecosystem/libs/manifest"
    }
  }
}
```

**Why?** The substrate packages internally depend on each other via `workspace:*`. When you `file:`-link them, pnpm will resolve `workspace:*` refs inside the linked packages to external npm versions (which don't exist yet in the public registry). The `pnpm.overrides` directive forces pnpm to map all internal `@adhd/sox-*` references **to your file-linked copies**, ensuring the entire transitive closure stays consistent.

**Example in agent-source:**

```bash
# In agent-source root
cat package.json | grep '"@adhd/sox-'
# "dependencies": {
#   "@adhd/sox-source-provider": "file:../sox-ecosystem/libs/source-provider",
#   ...
# }

pnpm install
# pnpm applies overrides, resolves workspace:* to file: paths
# Result: all internal deps point to your checked-out sox-ecosystem
```

---

## Testing and examples

All packages have comprehensive test suites (100+ tests per package). Run them with:

```bash
cd sox-ecosystem
pnpm test                    # All packages
pnpm test @adhd/sox-source-provider   # Single package
```

Real usage examples are in:

- **Integration tests:** `libs/data/integration/` (multi-package e2e)
- **Tool scripts:** `tools/substrate-smoke.ts` (smoke test for all 8 packages)

---

## Error handling by package

All errors are typed and throw on failure (no silent downgrade). Always check error type before deciding to retry.

### @adhd/sox-source-provider

| Error Type | Cause | Retriable | Action |
|-----------|-------|-----------|--------|
| `InvalidSourceRefError` | Unparseable ref (malformed URL) | No | Validate ref format before calling |
| `ProviderAuthenticationError` | Missing/expired token | Possibly | Refresh token, retry |
| `ProviderRateLimitError` | Rate limit hit | Yes | Exponential backoff, retry |
| `FileNotFoundError` | File/ref not found | No | Verify ref + path exist |
| `ManifestTooLargeError` | Repo tree exceeds limits | No | Filter path to a subdirectory |
| `ProviderTransientError` | Network timeout, server error | Yes | Exponential backoff, retry |

### @adhd/sox-task-queue

| Error Type | Cause | Retriable | Action |
|-----------|-------|-----------|--------|
| `TaskQueueNotOpenError` | Called before `open()` or after `close()` | No | Ensure `open()` before operations |
| `QueueFullError` | Queue at capacity | Yes | Wait, retry enqueue |
| `TaskNotFoundError` | Task ID missing | No | Verify task exists |
| `TaskNotRunningError` | Task not claimed | No | Check task status before completing |
| `TaskPermanentlyFailedError` | Retries exhausted (dead letter) | No | Review error, enqueue replacement task |
| `QueueShutdownTimeout` | `close()` drain timeout | No | Increase `drainTimeoutMs` or force close |

### @adhd/sox-vector-store

| Error Type | Cause | Retriable | Action |
|-----------|-------|-----------|--------|
| `SpaceInvariantError` | Vector dim ≠ space.dim | No | Call `ensureSpace()` first, verify vec dims |
| `BlobStoreSystemError` | Disk I/O failure | Yes | Retry after brief delay |

**Retry strategy:** On `BlobStoreSystemError`, retry up to 3 times with exponential backoff (500ms → 1s → 2s).

### @adhd/sox-ingest

| Error Type | Cause | Retriable | Action |
|-----------|-------|-----------|--------|
| `PermanentChunkingError` | Unsupported language | No | Use heading chunker for markdown, verify language tag |
| `TransientChunkingError` | WASM grammar load timeout | Yes | Retry, increase timeout |

**Note:** `chunk()` is synchronous (no network I/O), so transient errors are rare.

### @adhd/sox-embedding-provider

| Error Type | Cause | Retriable | Action |
|-----------|-------|-----------|--------|
| `ResolutionError` | Invalid config, model unavailable | No | Thrown at factory time; verify `modelId` + `provider` config |
| `TransientEmbeddingError` | Network timeout, OOM on model load | Yes | Exponential backoff, retry |
| `PermanentEmbeddingError` | Unsupported model, corrupt weights | No | Choose different model, verify ONNX runtime |

**Key behavior:** `createEmbeddingProvider()` throws `ResolutionError` synchronously if config invalid—never mid-call.

### @adhd/sox-hybrid-search

| Error Type | Cause | Retriable | Action |
|-----------|-------|-----------|--------|
| `SearchError` (generic) | Backend query failed | Depends on backend | Check VectorBackend + GraphBackend errors |

**Degradation:** If vector signal missing, search falls back to text-only (no error). If both missing, throws.

### @adhd/sox-blob-store

| Error Type | Cause | Retriable | Action |
|-----------|-------|-----------|--------|
| `BlobStoreNotOpenError` | Called before `open()` or after `close()` | No | Ensure `open()` before operations |
| `BlobNotFound` | Hash not in store | No | Verify hash, check reference tracking |
| `IntegrityMismatch` | Corruption detected (hash mismatch on read) | No | Blob is corrupted; check disk health, restore from backup |
| `GCInProgress` | GC already running | Yes | Wait for GC to complete, retry |
| `BlobStoreSystemError` | Disk I/O, permission denied | Yes | Check permissions, disk space, retry |

**Note:** `get()` returns `null` for not-found; throws only on corruption. Never throws on missing blob.

### @adhd/sox-claim-verification

| Error Type | Cause | Retriable | Action |
|-----------|-------|-----------|--------|
| `ModelNotLoadedError` | ONNX model failed to load | No | Verify model files, ONNX runtime version |
| `VerifierBusyError` | Queue depth exceeded | Yes | Throttle incoming claims, wait for backlog to drain |
| `UnsupportedLanguageError` | Claim/source language not supported | No | Translate claim + source to supported language, or accept downgrade to 'neutral' |
| `PreFilterSkippedError` | Pre-filter score below threshold | No | Not an error; result will have `preFilterSkipped=true` + `entailment='unverifiable'` |
| `InvalidClaimInputError` | Claim text missing or malformed | No | Verify claim.text is non-empty string |

**Language mismatch strategy:** If claim and source languages differ, the verifier downgrades result to `entailment='neutral'` with `languageMismatch=true` flag—never throws.

### @adhd/sox-graph-store

| Error Type | Cause | Retriable | Action |
|-----------|-------|-----------|--------|
| `GraphBackendError` | Generic DB error | Depends | Check SQLite error, retry transient errors |
| `NodeNotFoundError` | Node ID missing | No | Verify node exists via `getNode(id)` first |
| `EdgeNotFoundError` | Edge (src, dst, rel) missing | No | Verify edge exists via neighbors query first |
| `InvalidationError` | Attempt to touch/supersede an invalidated node | No | Check `t_invalid` before mutating |

**Audit-preserving mutations:** `invalidate()` sets `t_invalid`, never deletes (bi-temporal correctness preserved).

### @adhd/sox-analysis

| Error Type | Cause | Retriable | Action |
|-----------|-------|-----------|--------|
| `ClusteringError` | DBSCAN failure (memory, numerical instability) | Possibly | Reduce corpus size, increase `minClusterSize`, retry |
| `GraphTopologyError` | Cycle detected in expected DAG | No | Check graph for cycles via `detectCycles()`, resolve |
| `PackingError` | Impossible packing (item cost > batch capacity) | No | Increase batch capacity `B` or split items |

**Determinism requirement:** Re-run clustering after a model migration to ensure consistency.

### @adhd/sox-manifest

| Error Type | Cause | Retriable | Action |
|-----------|-------|-----------|--------|
| `ValidationError` | Schema mismatch (missing required field, wrong type) | No | Fix manifest fields per schema, retry `validate()` |
| `SchemaVersionMismatch` | Manifest schema version too old | No | Update manifest to current schema version |

---

## TypeScript support

All packages are **ESM-only** (except `@adhd/sox-ingest/core`, which is CJS-safe). Full TypeScript support via:

- `"type": "module"` in package.json
- `"exports"` map for dual ESM/types
- `.d.ts` files generated from source

```typescript
// ESM import (recommended)
import { TaskQueue } from '@adhd/sox-task-queue'

// Named re-export (CommonJS consumer of @adhd/sox-ingest only)
import { ingest } from '@adhd/sox-ingest/core'  // CJS-safe
```

---

## License

All substrate packages are **MIT licensed**. See individual `LICENSE` files in each package root.

---

## Support and documentation

- **API reference:** JSDoc comments in each package's `src/index.ts`
- **Source specs:** `docs/plan/` in the agent-source repo
- **Examples:** `libs/data/integration/` and `tools/substrate-smoke.ts` in sox-ecosystem

---

**Status:** Complete, shipped, real backends. Ready for integration.
