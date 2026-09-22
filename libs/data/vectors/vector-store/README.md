# @adhd/sox-vector-store

Multi-space vector persistence: `ensureSpace({ modelId, dim })`, `upsert(id, vec, space)`, `knn(query, space, k)`.
One virtual table per `(modelId, dim)` pair (a "space"), so you can hold embeddings from several
models side by side without them colliding, and `reembed()` migrates vectors from one space to
another when you switch models. Three real, swappable backends implement the same contract:

- **`SqliteVectorBackend`** — [`sqlite-vec`](https://github.com/asg017/sqlite-vec)'s `vec0` virtual
  table, brute-force cosine kNN, synchronous. The production default. Requires a `SqliteAdapter`.
- **`TursoVectorBackend`** — native async vector columns (`F32_BLOB`) over your existing
  [`@adhd/sox-store-adapter`](https://www.npmjs.com/package/@adhd/sox-store-adapter) `StoreAdapter`
  connection. No second connection is opened — it reuses the adapter you pass it, so when that
  adapter is Turso-backed, this backend inherits store-adapter's `multiprocess-wal` mode: multiple
  OS processes can `upsert()`/`knn()` against the same store file concurrently, writes serialized
  through store-adapter's `-tshm` coordinator. This is the path to reach for many worker
  processes/CLI invocations embedding into and querying one shared vector store at once.
- **`LanceDbVectorBackend`** — real [`@lancedb/lancedb`](https://lancedb.github.io/lancedb/) on-disk
  tables with genuine HNSW / IVF-PQ ANN indexes (not brute-force), bridged to the synchronous
  `VectorBackend` interface via a `worker_threads` + [`synckit`](https://github.com/un-ts/synckit)
  RPC. Reach for this when brute-force cosine over `sqlite-vec` stops scaling and you need a real
  ANN index; LanceDB manages its own on-disk concurrency, independent of `store-adapter`.

Every backend enforces the same invariant: an `upsert()` whose vector length doesn't match the
space's `dim` throws `SpaceInvariantError` before any I/O happens.

```bash
pnpm add @adhd/sox-vector-store
```

## Quick start

```typescript
import { openVectorStore } from '@adhd/sox-vector-store';

const store = openVectorStore('./data/vectors.db', { modelId: 'text-embedding-3-small', dim: 3 });

store.upsert(1, new Float32Array([1, 0, 0]), { modelId: 'text-embedding-3-small', dim: 3 });
store.upsert(2, new Float32Array([0, 1, 0]), { modelId: 'text-embedding-3-small', dim: 3 });
store.upsert(3, new Float32Array([0.9, 0.1, 0]), { modelId: 'text-embedding-3-small', dim: 3 });

const results = store.knn(
  new Float32Array([1, 0, 0]),
  { modelId: 'text-embedding-3-small', dim: 3 },
  2, // top 2
);
console.log(results); // [{ id: 1, score: 1 }, { id: 3, score: ~0.994 }] — highest score first
```

## API reference

### Shared types

```typescript
interface VectorSpace {
  modelId: string;
  dim: number;
}

interface VecFilter {
  ids?: number[]; // restrict a knn()/iter() call to this id set
}

interface VectorBackend {
  ensureSpace(space: VectorSpace): void;
  listSpaces(): VectorSpace[];
  upsert(id: number, vec: Float32Array, space: VectorSpace): void;
  upsertVectors(items: Array<{ id: number; vec: Float32Array }>, space: VectorSpace): void; // batch, transactional
  delete(id: number, modelId: string): void;
  get(id: number, modelId: string): Float32Array | null;
  knn(query: Float32Array, space: VectorSpace, k: number, filter?: VecFilter): Array<{ id: number; score: number }>;
  iter(modelId: string, opts?: { filter?: VecFilter }): Iterable<{ id: number; vec: Float32Array }>;
  deleteMany(ids: number[], modelId: string): number; // returns count removed
}

// Additive capability interface — NOT part of the pinned VectorBackend contract.
// Narrow to it (typeof backend.hasVectors === 'function') when you need a cheap
// "does this space hold any vectors?" answer. Same shape on the async mirror
// (AsyncVectorExistenceProbe), with Promise<boolean>.
interface VectorExistenceProbe {
  hasVectors(modelId: string): boolean;
}

class SpaceInvariantError extends Error {
  constructor(nodeId: number, space: VectorSpace, actualDim: number);
}
class StorageError extends Error {
  constructor(message: string, cause?: Error);
}
```

`score` from every backend's `knn()` is cosine **similarity** (higher is better, `1` = identical),
not distance — `TursoVectorBackend` converts its native `vector_distance_cos` distance internally so
all three backends return directly-comparable scores.

### Existence probe — `hasVectors` (use this, never `iter`, for a readiness check)

`iter()` is a **full corpus scan** and is not lazy on every backend: `TursoVectorBackend.iter` is
backed by the adapter's `executeAll` (`db.all`), which materializes every row *including the full
embedding BLOB* before its first yield. A "does this space have anything?" check built on
`iter`-first-row therefore reads the entire vector table.

All three backends also expose `hasVectors(modelId)`, a bounded `SELECT 1 … LIMIT 1` existence
probe: it projects no `embedding` column (no blob read) and stops at the first row — O(1) in the
size of the space. An absent table (a space never `ensureSpace`d) is `false`, not an error.

```typescript
// Sync backends: SqliteVectorBackend / LanceDbVectorBackend
backend.hasVectors('text-embedding-3-small'); // boolean

// Async backend: TursoVectorBackend
await backend.hasVectors('text-embedding-3-small'); // Promise<boolean>
```

It lives on each concrete backend and on the additive `VectorExistenceProbe` /
`AsyncVectorExistenceProbe` capability interfaces — deliberately **not** on the pinned
`VectorBackend` / `AsyncVectorBackend` contracts, so widening is opt-in for a caller rather than
mandatory for every implementor. A caller holding a `VectorBackend | AsyncVectorBackend` narrows
first:

```typescript
import type { AsyncVectorBackend, AsyncVectorExistenceProbe } from '@adhd/sox-vector-store';

const probe = backend as Partial<AsyncVectorExistenceProbe>;
const populated =
  typeof probe.hasVectors === 'function'
    ? await probe.hasVectors(modelId)
    : false; // older backend without the primitive
```

### `SqliteVectorBackend` (default, synchronous)

```typescript
function openVectorStore(
  adapterOrPath: string | StoreAdapter, // a bare path opens its own SqliteAdapter for you
  opts: { dim: number; modelId: string },
): SqliteVectorBackend;

class SqliteVectorBackend implements VectorBackend {
  readonly capabilities: { vecEnabled: boolean };
  constructor(adapter: StoreAdapter); // must be a SqliteAdapter — throws otherwise
  // ...VectorBackend methods
}
```

```typescript
import { createSqliteAdapter } from '@adhd/sox-store-adapter';
import { SqliteVectorBackend } from '@adhd/sox-vector-store';

// Construct directly when you already own the adapter (e.g. sharing one
// connection with other stores):
const adapter = createSqliteAdapter({ dbPath: './data/app.db' });
const backend = new SqliteVectorBackend(adapter);
backend.ensureSpace({ modelId: 'text-embedding-3-small', dim: 1536 });
```

### `TursoVectorBackend` (async, native, multiprocess-write-capable)

```typescript
interface AsyncVectorBackend {
  ensureSpace(space: VectorSpace): Promise<void>;
  listSpaces(): Promise<VectorSpace[]>;
  upsert(id: number, vec: Float32Array, space: VectorSpace): Promise<void>;
  upsertVectors(items: Array<{ id: number; vec: Float32Array }>, space: VectorSpace): Promise<void>;
  delete(id: number, modelId: string): Promise<void>;
  get(id: number, modelId: string): Promise<Float32Array | null>;
  knn(query: Float32Array, space: VectorSpace, k: number, filter?: VecFilter): Promise<Array<{ id: number; score: number }>>;
  iter(modelId: string, opts?: { filter?: VecFilter }): AsyncIterable<{ id: number; vec: Float32Array }>;
  deleteMany(ids: number[], modelId: string): Promise<number>;
}

class TursoVectorBackend implements AsyncVectorBackend {
  constructor(adapter: StoreAdapter); // reuses this exact connection — never opens a second one
}

function openTursoVectorStore(
  adapter: StoreAdapter, // required — this backend has no "give me a path" shortcut
  opts: { dim: number; modelId: string },
): Promise<TursoVectorBackend>;
```

```typescript
import { createStoreAdapter } from '@adhd/sox-store-adapter';
import { openTursoVectorStore } from '@adhd/sox-vector-store';

// createStoreAdapter defaults to Turso — multiprocess_wal is on by default,
// so N processes can all call this against the same dbPath concurrently.
const adapter = await createStoreAdapter({ dbPath: './data/vectors.db' });
const store = await openTursoVectorStore(adapter, { modelId: 'text-embedding-3-small', dim: 1536 });

await store.upsert(1, new Float32Array(1536).fill(0.01), { modelId: 'text-embedding-3-small', dim: 1536 });
const results = await store.knn(
  new Float32Array(1536).fill(0.01),
  { modelId: 'text-embedding-3-small', dim: 1536 },
  10,
);
```

### `LanceDbVectorBackend` (real ANN index)

```typescript
interface LanceDbVectorBackendConfig {
  lancedbPath: string;
  index?: {
    type: 'hnsw' | 'ivf-pq';
    M?: number;                 // hnsw: graph degree
    efConstruction?: number;    // hnsw: build-time search width
    numPartitions?: number;     // ivf-pq: IVF partition count
    numSubVectors?: number;     // ivf-pq: PQ subvector count
    bitsPerSubVector?: number;  // ivf-pq: PQ bits per subvector
    metric?: 'cosine' | 'l2' | 'dot';
  };
}

class LanceDbVectorBackend implements VectorBackend {
  constructor(config: LanceDbVectorBackendConfig & { adapter: StoreAdapter });
}

function openLanceDbVectorStore(
  config: LanceDbVectorBackendConfig & { adapter: StoreAdapter },
): LanceDbVectorBackend & VectorBackend;
```

```typescript
import { createSqliteAdapter } from '@adhd/sox-store-adapter';
import { openLanceDbVectorStore } from '@adhd/sox-vector-store';

const store = openLanceDbVectorStore({
  lancedbPath: './data/lancedb',
  adapter: createSqliteAdapter({ dbPath: ':memory:' }), // any StoreAdapter satisfies the constructor
  index: { type: 'hnsw', M: 16, efConstruction: 100, metric: 'cosine' },
});

store.ensureSpace({ modelId: 'text-embedding-3-small', dim: 1536 });
store.upsert(1, new Float32Array(1536).fill(0.01), { modelId: 'text-embedding-3-small', dim: 1536 });
```

### `reembed` — migrate between spaces (and backends)

```typescript
interface ReembedOpts {
  targetSpace: VectorSpace;
  sourceModelId?: string;                    // default: the only other space present
  dryRun?: boolean;
  getText?: (id: number) => string | null;   // required unless dryRun
}
interface ReembedResult {
  migrated: number;
  skipped: number;
  errors: Array<{ id: number; error: string }>;
}

function reembed(
  backend: VectorBackend,
  provider: { metadata: { modelId: string; dimensions: number }; embedBatch(texts: string[], opts?: { role?: 'document' | 'query'; batchSize?: number }): AsyncIterable<Float32Array> },
  opts: ReembedOpts,
): Promise<ReembedResult>;
```

```typescript
import { reembed } from '@adhd/sox-vector-store';

// Preview how many vectors would migrate, without writing anything.
const preview = await reembed(backend, embedder, {
  targetSpace: { modelId: 'text-embedding-3-large', dim: 3072 },
  dryRun: true,
});
console.log(`${preview.migrated} vectors would migrate`);

// Real migration — re-embeds each source vector's text and upserts into the new space.
const result = await reembed(backend, embedder, {
  targetSpace: { modelId: 'text-embedding-3-large', dim: 3072 },
  getText: (id) => corpus.get(id) ?? null,
});
console.log(`migrated ${result.migrated}, skipped ${result.skipped}, ${result.errors.length} errors`);
```

`reembed()` never deletes the source space's vectors — decide separately when it's safe to drop them
(e.g. after confirming `result.errors` is empty).

## Choosing a backend

| Backend | Sync/async | Index | Multiprocess writers | When |
|---|---|---|---|---|
| `SqliteVectorBackend` | sync | brute-force cosine | no (SQLite, single-writer) | default; small-to-medium corpora, embedded/local use |
| `TursoVectorBackend` | async | native, index-accelerated cosine | **yes**, when the adapter is Turso-backed | many processes writing/querying one shared store |
| `LanceDbVectorBackend` | sync (worker-bridged) | real HNSW / IVF-PQ ANN | LanceDB's own on-disk concurrency, not `store-adapter`'s | large corpora needing sub-linear kNN |

## Invariants

- `ensureSpace(space)` must be called before the first `upsert()` on any new `(modelId, dim)` pair —
  idempotent on a space that already exists.
- `upsert()`/`upsertVectors()` throw `SpaceInvariantError` when a vector's length doesn't match
  `space.dim` — enforced before any write, on every backend.
- Switching models is a `reembed()` migration, never a hot-swap of vectors into an existing table.
- `delete(id, modelId)` / `deleteMany(ids, modelId)` are scoped to a single space — they do not touch
  the same `id` in a different model's space.
- `SqliteVectorBackend` requires a `SqliteAdapter` and throws if handed a Turso-backed adapter (the
  reverse of `TursoVectorBackend`, which requires the async native path) — pick the backend that
  matches your adapter, or use `LanceDbVectorBackend`, which accepts either.
