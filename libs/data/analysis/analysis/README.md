# @adhd/sox-analysis

Batch-scale derivation over a corpus: clustering, near-duplicate detection, importance scoring, similarity auto-linking, and a set of pure graph algorithms (topological sort, critical path, cycle detection, bin-packing). The DB-integrated functions take a `VectorBackend` and `GraphBackend` directly — there is no `CorpusBackend` wrapper to construct — and the pure algorithm functions (`cluster`, `topoSort`, `criticalPath`, `detectCycles`, `packBatches`, `setOverlapMatrix`) work over plain in-memory data with no store at all.

This package's DB-integrated functions write into whatever `GraphBackend` you supply. When that backend is [`@adhd/sox-graph-store`](https://www.npmjs.com/package/@adhd/sox-graph-store) on its default Turso adapter, the graph-side writes a batch run makes — importance scores (`touch`), near-dup edges, auto-link edges — inherit [`@adhd/sox-store-adapter`](https://www.npmjs.com/package/@adhd/sox-store-adapter)'s `multiprocess-wal` model: many batch-enrichment runs can write into the same graph store concurrently from separate processes. The vector side is a separate concern — see "Vector backend note" below for the current constraint there.

```bash
pnpm add @adhd/sox-analysis @adhd/sox-graph-store @adhd/sox-vector-store @adhd/sox-store-adapter
```

## Quick start

```typescript
import { createSqliteAdapter } from '@adhd/sox-store-adapter';
import { createGraphBackend } from '@adhd/sox-graph-store';
import { SqliteVectorBackend } from '@adhd/sox-vector-store';
import { runBatchEnrich } from '@adhd/sox-analysis';

const SPACE = { modelId: 'my-model', dim: 4 };

// SqliteVectorBackend requires a SqliteAdapter (see "Vector backend note").
const adapter = createSqliteAdapter({ dbPath: 'corpus.db' });
const graph = createGraphBackend(adapter);
await graph.applySchema();
const vec = new SqliteVectorBackend(adapter);
vec.ensureSpace(SPACE);

const id1 = await graph.writeNode('The quick brown fox', { name: 'doc-1' });
const id2 = await graph.writeNode('A related but distinct fox', { name: 'doc-2' });
vec.upsert(id1, new Float32Array([1, 0, 0, 0]), SPACE);
vec.upsert(id2, new Float32Array([0.85, 0.527, 0, 0]), SPACE); // cosine ≈ 0.85

// Runs importance scoring, near-dup detection, auto-linking, and clustering
// in one pass over every node currently in the graph.
const result = await runBatchEnrich(vec, graph);
console.log(result);
// { nodesProcessed: 2, nearDupPairsFound: 0, autoLinksCreated: 1, communitiesUpdated: 1, durationMs: ... }
// cosine 0.85 clears the auto-link threshold (0.80) and the cluster threshold (0.75),
// but not the near-dup threshold (0.95) — the two are treated as related, not duplicates.

await adapter.close();
```

## API reference

### DB-integrated functions (take a `VectorBackend` + `GraphBackend`)

```typescript
function clusterStore(vec: VectorBackend, graph: GraphBackend, opts?: ClusterOpts): Promise<ClusterResult>;
function clusterSubset(vec: VectorBackend, graph: GraphBackend, filter: NodeFilter, opts?: ClusterOpts): Promise<SubsetClusterResult>;
function detectNearDup(vec: VectorBackend, graph: GraphBackend, opts?: NearDupOpts): Promise<NearDupPair[]>;
function computeImportance(vec: VectorBackend, graph: GraphBackend, opts?: ImportanceOpts): Promise<void>;
function buildAutoLinks(vec: VectorBackend, graph: GraphBackend, opts?: AutoLinkOpts): Promise<void>;
function runBatchEnrich(vec: VectorBackend, graph: GraphBackend, opts?: BatchOpts): Promise<BatchResult>;
```

### Pure functions (no backend required)

```typescript
function cluster(vecs: Array<{ id: number; vec: Float32Array }>, opts?: ClusterOpts): ClusterResult;
function detectNearDupPairs(vecs: Array<{ id: number; vec: Float32Array }>, opts?: NearDupOpts): NearDupPair[];
function scoreImportance(node: { inDegree: number; outDegree: number; recencyMs: number; nearDupCount: number }): number;
function topoSort(nodeIds: number[], getEdges: (id: number) => number[]): TopoSortResult;
function criticalPath(nodeIds: number[], getEdges: (id: number) => number[], getWeight: (id: number) => number): Map<number, number>;
function detectCycles(nodeIds: number[], getEdges: (id: number) => number[]): Array<number[]>;
function detectDAGStructure(nodeIds: number[], getEdges: (id: number) => number[]): DAGStructure;
function packBatches(items: PackItem[], opts: PackOpts): PackResult;
function setOverlapMatrix(items: Array<{ id: number; keys: string[] }>, valueFn?: (key: string) => number): OverlapEntry[];
```

### Option / result types

```typescript
interface ClusterOpts { modelId?: string; minClusterSize?: number; threshold?: number }
interface ClusterResult {
  communities: Array<{ id: number; memberIds: number[]; label?: string }>;
  unclustered: number[];
  durationMs: number;
}
interface SubsetClusterResult extends ClusterResult { filter: NodeFilter; totalInSubset: number }

interface NearDupOpts { nearDupThreshold?: number; distinctThreshold?: number; modelId?: string; limit?: number }
interface NearDupPair { a: number; b: number; cosine: number; status: 'near_dup' | 'candidate' | 'distinct' }

interface ImportanceOpts { filter?: NodeFilter; dryRun?: boolean }
interface AutoLinkOpts { filter?: NodeFilter; similarityThreshold?: number; maxLinksPerNode?: number; rel?: EdgeRel; dryRun?: boolean }
interface BatchOpts { filter?: NodeFilter; skip?: Array<'importance' | 'nearDup' | 'autoLinks' | 'clustering'>; dryRun?: boolean }
interface BatchResult {
  nodesProcessed: number; nearDupPairsFound: number; autoLinksCreated: number;
  communitiesUpdated: number; durationMs: number;
}

interface TopoSortResult { order: number[]; waves: Map<number, number>; cycle: number[] | null }
type DAGStructure = 'forest' | 'series-parallel' | 'general';

interface PackItem {
  id: number; cost: number; resources: string[];
  resourceCost: (key: string) => number; // cost of holding one resource, paid once per batch
  deps: number[]; group?: string;
}
interface PackOpts {
  B: number;  // fixed base cost charged once per batch
  W: number;  // max total cost per batch (capacity)
  algorithm?: 'auto' | 'bitmask-dp' | 'tree-dp' | 'simulated-annealing' | 'hlfet';
}
interface PackResult { batches: Array<{ items: number[]; cost: number }>; totalCost: number; algorithm: string }

interface OverlapEntry { a: number; b: number; intersection: string[]; bytes: number }
```

## Clustering

`cluster()` (pure, in-process `density-clustering`) groups vectors by cosine similarity. `clusterStore()` reads every live vector for a model out of the store and clusters it; `clusterSubset()` restricts to a `NodeFilter`-selected subset and reports `totalInSubset`:

```typescript
import { cluster } from '@adhd/sox-analysis';

const result = cluster(
  [
    { id: 1, vec: new Float32Array([1, 0, 0, 0]) },
    { id: 2, vec: new Float32Array([0.99, 0.14, 0, 0]) }, // cos ≈ 0.99 with id 1
    { id: 3, vec: new Float32Array([0, 1, 0, 0]) },        // orthogonal
  ],
  { threshold: 0.9, minClusterSize: 2 }, // defaults: threshold 0.75, minClusterSize 2
);
// result.communities: [{ id: 0, memberIds: [1, 2] }]
// result.unclustered: [3]
```

```typescript
import { clusterStore } from '@adhd/sox-analysis';

const result = await clusterStore(vec, graph, { threshold: 0.5 });
```

Similarity-based outputs record the `modelId` they were computed under (defaults to the vector store's first registered space) — re-cluster after a model migration rather than mixing embeddings from two models.

## Near-duplicate detection

`detectNearDupPairs()` (pure) classifies every pair by cosine similarity against two thresholds: `>= nearDupThreshold` (default `0.95`) is `'near_dup'`, `< distinctThreshold` (default `0.70`) is `'distinct'`, and everything between is `'candidate'`:

```typescript
import { detectNearDupPairs } from '@adhd/sox-analysis';

const pairs = detectNearDupPairs([
  { id: 1, vec: new Float32Array([1, 0, 0, 0]) },
  { id: 2, vec: new Float32Array([0.999, 0.045, 0, 0]) },
], { nearDupThreshold: 0.95 });
// [{ a: 1, b: 2, cosine: 0.999, status: 'near_dup' }]
```

`detectNearDup()` runs this over a store's live vectors and additionally writes a `SAME_AS` edge (`weight` = cosine, `metadata: { cosine, status, modelId }`) for every `'near_dup'` and `'candidate'` pair it finds.

## Importance scoring

`scoreImportance()` (pure) combines graph centrality, recency, and a near-dup penalty into a `[1, 10]` score:

```typescript
import { scoreImportance } from '@adhd/sox-analysis';

const score = scoreImportance({ inDegree: 5, outDegree: 2, recencyMs: 3_600_000, nearDupCount: 0 });
```

`computeImportance()` runs this over a `GraphBackend` and writes the result via `touch()`. **It is incremental only when no `filter` is given**: with no filter, a node whose `importance` is already set and positive is skipped; passing any `filter` forces every matching node to be rescored regardless of its current value.

```typescript
await computeImportance(vec, graph);                  // skips already-scored nodes
await computeImportance(vec, graph, { dryRun: true }); // computes but doesn't write
```

## Auto-linking

`buildAutoLinks()` computes every pairwise cosine similarity among the vectors for the (optionally filtered) node set, and writes an edge (default `RELATES_TO`, `weight` = cosine) for every pair at or above `similarityThreshold` (default `0.80`) — highest-similarity pairs first, capped at `maxLinksPerNode` per node (default `5`). Unlike `computeImportance`, this recomputes the full candidate set on every call; it is not incremental.

```typescript
await buildAutoLinks(vec, graph, { similarityThreshold: 0.8, maxLinksPerNode: 3 });
const edges = await graph.getEdges({ rel: 'RELATES_TO' });
```

## Batch enrichment

`runBatchEnrich()` runs importance → near-dup → auto-links → clustering in sequence over the (optionally filtered) node set, skipping any step named in `skip`:

```typescript
import { runBatchEnrich } from '@adhd/sox-analysis';

const result = await runBatchEnrich(vec, graph, {
  skip: ['clustering'],
  filter: { namespace: 'tenant-a' },
});
```

## Graph algorithms (pure — bring your own adjacency function)

`topoSort`, `criticalPath`, `detectCycles`, and `detectDAGStructure` all take a caller-supplied `getEdges(id) => number[]` returning the ids `id` **depends on** — they work over any graph representation, not just `@adhd/sox-graph-store`:

```typescript
import { topoSort, criticalPath, detectCycles, detectDAGStructure } from '@adhd/sox-analysis';

// 1 depends on 2 and 3; 2 depends on 3
const deps: Record<number, number[]> = { 1: [2, 3], 2: [3], 3: [] };
const getEdges = (id: number) => deps[id] ?? [];

const { order, waves, cycle } = topoSort([1, 2, 3], getEdges);
// order: dependency-first, e.g. [3, 2, 1]; waves.get(3) === 0, waves.get(1) === 2; cycle === null

const weights: Record<number, number> = { 1: 1, 2: 2, 3: 3 };
const longest = criticalPath([1, 2, 3], getEdges, (id) => weights[id] ?? 0);
// longest.get(1) === 6  (1 + max(path through 2, path through 3))

const cycles = detectCycles([1, 2, 3], getEdges); // [] — acyclic
const structure = detectDAGStructure([1, 2, 3], getEdges); // 'forest' | 'series-parallel' | 'general'
```

`detectCycles` reports every cycle (not just the first), which is what makes it usable for a user-facing error message rather than just a boolean check.

## Bin-packing (`packBatches`)

Packs `PackItem`s into batches under a per-batch cost cap `W`, respecting `deps` (a dependency must land in an earlier batch) and `group` (items in different groups never share a batch). Per-batch cost is `B + Σ(distinct resourceCost) + Σ(item.cost)` — a shared `resources` key is paid **once per batch**, not once per item, so grouping items that share an expensive resource together is cheaper:

```typescript
import { packBatches } from '@adhd/sox-analysis';

const items = [
  { id: 1, cost: 1, resources: ['expensive'], resourceCost: (k: string) => (k === 'expensive' ? 10 : 1), deps: [] },
  { id: 2, cost: 1, resources: ['expensive'], resourceCost: (k: string) => (k === 'expensive' ? 10 : 1), deps: [] },
];
const result = packBatches(items, { B: 1, W: 30, algorithm: 'hlfet' });
```

`algorithm: 'auto'` (the default) picks `bitmask-dp` / `tree-dp` / `simulated-annealing` / `hlfet` based on item count and DAG shape (via `detectDAGStructure`) — pass an explicit algorithm to override.

## Pairwise set overlap

`setOverlapMatrix()` computes every pairwise key intersection (e.g. shared resources, shared tags) and, optionally, a weighted "bytes" cost per shared key:

```typescript
import { setOverlapMatrix } from '@adhd/sox-analysis';

const entries = setOverlapMatrix([
  { id: 1, keys: ['a', 'b', 'c'] },
  { id: 2, keys: ['b', 'c', 'd'] },
  { id: 3, keys: ['e', 'f'] },
]);
// entries finds {a:1,b:2}: intersection ['b','c'], bytes 2 (default valueFn counts keys)
// entries finds {a:1,b:3}: intersection [], bytes 0
```

## Vector backend note

The DB-integrated functions accept any `VectorBackend`, but the concrete implementation in [`@adhd/sox-vector-store`](https://www.npmjs.com/package/@adhd/sox-vector-store) most commonly paired with this package — `SqliteVectorBackend` — requires a `SqliteAdapter` specifically, because `sqlite-vec`/`vec0` is a synchronous, SQLite-only mechanism; it throws if handed a Turso-backed adapter. So while the `GraphBackend` side of a batch run can be Turso-backed and safely written to from multiple concurrent processes, the vector similarity computations in that same run are only as concurrent as whatever `VectorBackend` you supply — check the backend you choose for its own concurrency contract.

## Invariants

- Operates over a corpus (batch), never per-query — analysis functions are not on the hot query path.
- Clustering uses an existing JS library (`density-clustering`, in-process) — not a hand-rolled DBSCAN/HDBSCAN.
- All DB-integrated functions take `(VectorBackend, GraphBackend)` directly — no `CorpusBackend` wrapper.
- Similarity-based outputs (clusters, near-dup pairs, link scores) record the `modelId` they were computed under — re-cluster after a model migration.
- `computeImportance` is incremental (skips already-scored nodes) only when called with no `filter`; `buildAutoLinks` recomputes its full candidate set on every call.
- `topoSort` / `criticalPath` / `detectCycles` / `detectDAGStructure` accept a caller-supplied adjacency function — they work over any graph representation, not just `@adhd/sox-graph-store`.
- `packBatches`'s shared-resource cost is submodular (union cost) — a resource shared by items in the same batch is paid once, not per item.

## Requires

Node >=22. DB-integrated functions expect a [`@adhd/sox-graph-store`](https://www.npmjs.com/package/@adhd/sox-graph-store) `GraphBackend` and an `@adhd/sox-vector-store` `VectorBackend`.
