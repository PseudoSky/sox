# @adhd/sox-semantic

The semantic RAG composition layer — a dependency-injection facade that wires
[`@adhd/sox-graph-store`](https://www.npmjs.com/package/@adhd/sox-graph-store),
[`@adhd/sox-vector-store`](https://www.npmjs.com/package/@adhd/sox-vector-store), and
[`@adhd/sox-embedding-provider`](https://www.npmjs.com/package/@adhd/sox-embedding-provider)
into one `embed → index → search → rank` surface. You give it a
[`@adhd/sox-store-adapter`](https://www.npmjs.com/package/@adhd/sox-store-adapter)
connection and an embedding config; it hands back a `SemanticBackend` that embeds text, upserts
vectors, and runs ranked semantic search over your graph's nodes — without you having to hand-wire
the embedding provider, the vector index, and the node join yourself.

Because it is built on `@adhd/sox-store-adapter`, it inherits that adapter's concurrency model.
Turso — the default backend — runs in `multiprocess-wal` mode: multiple OS processes can hold
concurrent write connections to the *same* store file, serialized through a coordinator sidecar,
with no opt-out. Point several CLI invocations, MCP servers, or worker processes at one store file
and their embeds, upserts, and searches through `SemanticBackend` are all safe to run concurrently.
(The SQLite fallback remains genuinely single-writer, per `@adhd/sox-store-adapter`'s own
documented behavior.)

```bash
pnpm add @adhd/sox-semantic
```

## Quick start

```typescript
import { createStoreAdapter } from '@adhd/sox-store-adapter';
import { createGraphBackend } from '@adhd/sox-graph-store';
import { createSemanticBackend } from '@adhd/sox-semantic';

const adapter = await createStoreAdapter({ dbPath: 'app.db' });

const graph = createGraphBackend(adapter);
await graph.applySchema();

const result = await createSemanticBackend({
  adapter,
  embedding: { type: 'fastembed', model: 'bge-small-en-v1.5' },
});
if (!result.ok) {
  throw new Error(`semantic backend unavailable: ${result.failure.reason} — ${result.failure.detail}`);
}
const backend = result.backend;

// Write two nodes, then embed + index each one.
const id1 = await graph.writeNode('Rust is a systems language with memory safety', { kind: 'generic' });
const id2 = await graph.writeNode('Bananas are a good source of potassium', { kind: 'generic' });
await backend.upsertVector(id1, await backend.embedQuery('Rust is a systems language with memory safety'));
await backend.upsertVector(id2, await backend.embedQuery('Bananas are a good source of potassium'));

// Semantic search: embeds the query, runs vector + text ranking, joins back to graph nodes.
const results = await backend.semanticSearchNodes('memory-safe programming language', { limit: 5 });
for (const { node, score } of results) {
  console.log(score.toFixed(4), node.content);
}

await adapter.close();
```

## API reference

### `createSemanticBackend(config): Promise<SemanticBackendResult>`

The composition seam. **Never throws for a configurable failure** — it returns a typed result.

```typescript
interface SemanticBackendConfig {
  /** The shared connection for graph + vector tables. */
  adapter: StoreAdapter;
  /** Embedding provider config ({ type, model, options }). */
  embedding: EmbeddingProviderConfig;
  /** Vector space; defaults to provider.metadata (modelId + dimensions). */
  space?: { modelId: string; dim: number };
  /** Optional injected provider; default: createEmbeddingProvider(embedding). */
  embeddingProvider?: EmbeddingProvider;
  /** Optional injected vector backend; default: capability-probed from adapter.capabilities.nativeVectors. */
  vectorBackend?: VectorBackend | AsyncVectorBackend;
}

type SemanticBackendResult =
  | { ok: true; backend: SemanticBackend }
  | { ok: false; failure: SemanticFailure };

type SemanticFailure =
  | { reason: 'not_installed'; detail: string }
  | { reason: 'provider_failed'; detail: string }
  | { reason: 'unsupported_adapter'; detail: string }
  | { reason: 'vector_store_failed'; detail: string };
```

### `SemanticBackend`

```typescript
interface SemanticBackend {
  readonly modelId: string;
  readonly dim: number;

  embedQuery(text: string): Promise<Float32Array>;
  embedDocuments(texts: string[]): AsyncIterable<EmbedDocumentResult>;

  upsertVector(nodeId: number, vec: Float32Array): Promise<void>;
  upsertVectors(items: Array<{ nodeId: number; vec: Float32Array }>): Promise<void>;
  deleteVector(nodeId: number): Promise<void>;

  semanticSearchNodes(
    query: string,
    opts?: SemanticSearchOpts,
  ): Promise<Array<{ node: NodeRecord; score: number }>>;

  health(): EmbeddingHealth;
}

interface SemanticSearchOpts {
  nodeFilter?: NodeFilter;  // scope the search — see @adhd/sox-graph-store's NodeFilter
  limit?: number;           // default 10
  offset?: number;          // default 0
  liveOnly?: boolean;       // default true
}

interface EmbedDocumentResult {
  index: number;        // position in the input texts array
  vec?: Float32Array;   // present on success
  error?: string;       // present on per-document failure (never both)
}
```

`semanticSearchNodes` embeds the query, ranks candidate nodes by both text relevance
(`graph.searchNodes`) and vector similarity (`knn`), fuses the two rankings with reciprocal-rank
fusion, and returns nodes joined back from the graph — so a title/body text match surfaces even
when its vector isn't the nearest neighbor.

## Batch embedding — per-item error containment

`embedDocuments` never lets one bad document abort the batch, and it never fabricates a
placeholder vector for a failed item:

```typescript
for await (const result of backend.embedDocuments(['first doc', 'second doc', 'third doc'])) {
  if (result.error) {
    console.error(`document ${result.index} failed to embed: ${result.error}`);
    continue;
  }
  await backend.upsertVector(nodeIdForIndex(result.index), result.vec!);
}
```

## The embedding-lifecycle observer

`createEmbeddingObserver` wires embedding into your graph's write path: embed-on-write,
delete-on-invalidate. Register it on your own graph backend (not the facade's internal one):

```typescript
import { createGraphBackend } from '@adhd/sox-graph-store';
import { createEmbeddingObserver } from '@adhd/sox-semantic';

const observer = createEmbeddingObserver(backend);
const observedGraph = createGraphBackend(adapter, { observers: [observer] });

// Every writeNode() through observedGraph now embeds + upserts a vector automatically.
await observedGraph.writeNode('a new fact', { kind: 'generic' });
```

A failed embed degrades the write — it never corrupts it. No placeholder vectors are ever written,
and the original node write is never rolled back; a reconciliation pass can re-embed the gap later.
`onNodeInvalidated` deletes the corresponding vector, tolerating an already-missing vector as a
no-op rather than an error.

## Invariants

- `createSemanticBackend` returns a typed result, never throws, for any configurable failure
  (`provider_failed` / `unsupported_adapter` / `vector_store_failed`).
- A failed embed degrades the write, never corrupts it — no placeholder vectors, no rolled-back
  node write.
- `score` from `semanticSearchNodes` is a reciprocal-rank-fusion magnitude across the text and
  vector channels, not a raw cosine similarity — don't assume it's bounded to `[0, 1]`.
- Live objects (the open DB connection, the provider instance, the vector backend) cross into this
  package via dependency injection over your `StoreAdapter` — this package never opens a second,
  duplicate connection to your store.
