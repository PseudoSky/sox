# @adhd/sox-hybrid-search

A mechanism-agnostic hybrid retrieval ranker. It fuses a text-relevance signal and a
vector-similarity signal into one ranked result list — via normalized min-max/L2/z-score fusion,
or via reciprocal-rank fusion (RRF) across an arbitrary number of ranked signals — without ever
naming BM25 or cosine in its public interface. The `SearchBackend` interface decouples ranking
logic from storage; `StoreSearchBackend` wires a
[`@adhd/sox-vector-store`](https://www.npmjs.com/package/@adhd/sox-vector-store) backend and a
[`@adhd/sox-graph-store`](https://www.npmjs.com/package/@adhd/sox-graph-store) backend together via
dependency injection. If you have your own signal sources, the pure `fuse()` / `normalize()` /
`rrfFuse()` functions carry no storage dependency at all.

`StoreSearchBackend` operates over backends that are themselves built on
[`@adhd/sox-store-adapter`](https://www.npmjs.com/package/@adhd/sox-store-adapter), so it inherits
that adapter's concurrency model at one remove: when the graph/vector backends you hand it are
backed by Turso (the adapter's default), that store runs in `multiprocess-wal` mode — multiple
processes can hold concurrent write connections to the same store file, serialized through a
coordinator sidecar, with no opt-out. Run many search-serving processes against one store file and
their reads/writes through the underlying backends stay safe concurrently.

```bash
pnpm add @adhd/sox-hybrid-search
```

## Quick start

```typescript
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createSqliteAdapter } from '@adhd/sox-store-adapter';
import { StoreGraphBackend } from '@adhd/sox-graph-store';
import { SqliteVectorBackend } from '@adhd/sox-vector-store';
import { StoreSearchBackend, search } from '@adhd/sox-hybrid-search';

// One shared connection, wired into both a graph backend and a vector backend.
const db = new Database(':memory:');
sqliteVec.load(db);
const adapter = createSqliteAdapter(db);

const graph = new StoreGraphBackend(adapter);
await graph.applySchema();

const vec = new SqliteVectorBackend(adapter);
vec.ensureSpace({ modelId: 'demo-model', dim: 4 });

const backend = new StoreSearchBackend(vec, graph);

// Seed a couple of nodes with both text content and a vector.
const pythonId = await graph.writeNode(
  'Python is a great language for AI and data science',
  { name: 'python', topic: 'python', tags: ['ai', 'programming'], importance: 5 },
);
vec.upsert(pythonId, new Float32Array([1.0, 0.0, 0.0, 0.0]), { modelId: 'demo-model', dim: 4 });

const rustId = await graph.writeNode(
  'Rust is a systems language with memory safety',
  { name: 'rust', topic: 'rust', tags: ['systems', 'programming'], importance: 5 },
);
vec.upsert(rustId, new Float32Array([0.0, 1.0, 0.0, 0.0]), { modelId: 'demo-model', dim: 4 });

// Hybrid search: fuses the text match against the vector match, normalized before combining.
const results = await search(backend, {
  text: 'python',
  vec: new Float32Array([1.0, 0.0, 0.0, 0.0]),
});
for (const r of results) {
  console.log(r.score.toFixed(4), r.fields.topic);
}
```

## API reference

### `search(backend, query, opts?): Promise<SearchResult[]>`

The top-level ranked search entry point. Degrades to text-only when `query.vec` is absent, and to
vec-only when `query.text` is absent — it never errors on a missing signal.

```typescript
interface SearchQuery {
  text?: string;
  vec?: Float32Array;
  /** Rank signals to fuse via RRF. Default: one signal per present input ({ kind: 'text' } / { kind: 'vec' }). */
  signals?: SignalSpec[];
  /** Continuous signals applied AFTER rank-signal fusion (e.g. temporal decay). Default: none. */
  rescore?: ContinuousSignalSpec[];
  filters?: Record<string, unknown>;
}

interface SearchOpts {
  normalizer?: 'min_max' | 'L2' | 'z_score';  // default 'min_max'
  explain?: boolean;                          // include per-signal score breakdown
  limit?: number;                             // default 20
}

interface SearchResult {
  id: number;
  score: number;
  signalScores?: { text?: number; vec?: number };  // present when opts.explain is true
  fields: Record<string, unknown>;
  degraded?: { unsupportedFilters: string[] };      // present when a filter key had no backend mapping
}
```

### `StoreSearchBackend`

```typescript
class StoreSearchBackend implements SearchBackend {
  constructor(vec: VectorBackend, graph: GraphBackend, opts?: StoreSearchOpts);

  // The raw per-signal candidate fetch — search() calls this and fuses the result.
  search(query: SearchQuery, limit: number): Promise<Array<{
    id: number;
    textScore?: number;
    vecScore?: number;
    fields: Record<string, unknown>;
    degraded?: SearchDegradeInfo;
  }>>;

  // N-signal reciprocal-rank fusion, applied directly (bypasses the min-max `search()` path).
  // Returns scores on the raw RRF magnitude scale, NOT comparable to search()'s [0,1] scale.
  searchRanked(query: SearchQuery, limit: number): Promise<SearchResult[]>;
}
```

`query.filters` (e.g. `{ namespace: 'tenant-a' }`) is resolved through `graph.queryNodes()` and used
to constrain the vector channel's `knn()` call to the matching id set — so a filter scopes *both*
channels identically, not just the text channel. A filter matching zero nodes yields zero vector
candidates; it is never treated as "no filter."

### Pure fusion functions (no storage dependency)

```typescript
function normalize(scores: number[], method: 'min_max' | 'L2' | 'z_score'): number[];

function fuse(
  candidates: Array<{ id: number; textScore?: number; vecScore?: number }>,
  opts?: { normalizer?: 'min_max' | 'L2' | 'z_score'; weights?: { text?: number; vec?: number } },
): Array<{ id: number; score: number }>;

// Same algorithm as fuse(), but also returns a per-channel breakdown that sums to the score.
function fuseWithBreakdown(
  candidates: Array<{ id: number; textScore?: number; vecScore?: number }>,
  opts?: FusionOpts,
): Array<{ id: number; score: number; breakdown: { bm25: number; vec: number; total: number } }>;
```

```typescript
import { fuse, normalize } from '@adhd/sox-hybrid-search';

const fused = fuse(
  [
    { id: 1, textScore: 8.2, vecScore: 0.91 },
    { id: 2, textScore: 3.1 },
    { id: 3, vecScore: 0.62 },
  ],
  { normalizer: 'min_max', weights: { text: 1.0, vec: 1.5 } },
);
```

### N-signal reciprocal-rank fusion

```typescript
const RRF_K = 60;
function rrfScore(rank: number): number;  // 1 / (RRF_K + rank)

function rrfFuse(
  rankedIdsBySignal: Map<string, number[]>,  // signal name -> ordered ids, best first
  weights: Map<string, number>,
): Array<{ id: number; score: number }>;

// Post-fusion recency multiplier — never a peer RRF signal.
function temporalRescore(
  results: Array<{ id: number; score: number }>,
  recencyMs: Map<number, number>,
  decay?: number,
  nowMs?: number,
): Array<{ id: number; score: number }>;
```

```typescript
import { rrfFuse } from '@adhd/sox-hybrid-search';

const ranked = rrfFuse(
  new Map([
    ['text', [3, 1, 2]],   // id 3 ranked best by text search
    ['vec', [1, 3, 4]],    // id 1 ranked best by vector search
  ]),
  new Map([['text', 1.0], ['vec', 1.0]]),
);
// id 1 and id 3 both appear in two channels and outrank id 2 / id 4, which appear in one.
```

### Cross-encoder reranking

`createCrossEncoder` loads a real ONNX sequence-classification model (routed through
`@adhd/sox-embedding-provider`'s shared inference worker — never a second competing
`worker_threads.Worker`) and scores query/candidate pairs directly, which is more accurate than
either channel alone for a final top-K rerank pass:

```typescript
import { createCrossEncoder } from '@adhd/sox-hybrid-search';

const encoder = await createCrossEncoder({ modelId: 'MiniCheck' });
const scores = await encoder.rerank('What is the capital of France?', [
  { id: 'a', text: 'Paris is the capital and most populous city of France.' },
  { id: 'b', text: 'Bananas are a good source of potassium and fiber.' },
]);
// scores[0] > scores[1] — passage 'a' is ranked as more relevant.
await encoder.dispose();
```

```typescript
interface CrossEncoder {
  readonly metadata: { modelId: string; maxTokens: number };
  rerank(query: string, candidates: Array<{ id: number | string; text: string }>, opts?: { timeoutMs?: number }): Promise<Float32Array>;
  rerankBatch(queries: string[], candidateSets: Array<Array<{ id: number | string; text: string }>>, opts?: { timeoutMs?: number }): Promise<Float32Array[]>;
  dispose(): Promise<void>;
}
```

## Invariants

- `search()` / `StoreSearchBackend.search()` degrade to text-only when `query.vec` is absent, and
  to vec-only when `query.text` is absent — never errors on a missing signal.
- Scores are normalized **before** combining — never a raw, scale-blind additive merge.
- `textScore` / `vecScore` are mechanism-agnostic names; BM25 and cosine are implementation details
  of the backends behind them, never surfaced through the `SearchBackend` interface itself.
- Field boosting (e.g. an exact topic match) is applied multiplicatively, never additively.
- A `NodeFilter` that matches zero nodes yields zero vector candidates — never an unfiltered `knn()`
  fallback.
- `rrfFuse` operates purely on ranks, so a continuous value (recency) can never be smuggled in as a
  peer signal — it is applied afterward, via `temporalRescore`.
