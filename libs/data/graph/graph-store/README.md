# @adhd/sox-graph-store

A bi-temporal graph store — nodes and edges with `t_valid`/`t_invalid` correctness, TTL expiry, content-hash dedup, full-text search, namespace isolation, and supersession chains — built on [`@adhd/sox-store-adapter`](https://www.npmjs.com/package/@adhd/sox-store-adapter)'s `StoreAdapter`, not directly on SQLite.

That matters because store-adapter's default backend is Turso, and Turso's default mode is `multiprocess-wal`: **multiple OS processes hold concurrent write connections to the same store file**, serialized through a `-tshm` coordinator sidecar — there is no opt-out and no single-writer bottleneck to design around. Point many CLI invocations, many MCP servers, or many agent workers at one `graph.db` and they all write concurrently, safely. SQLite (`better-sqlite3`) remains available as a single-writer, backward-compatible fallback via the same `StoreAdapter` interface.

```bash
pnpm add @adhd/sox-graph-store @adhd/sox-store-adapter
```

## Quick start

```typescript
import { createStoreAdapter } from '@adhd/sox-store-adapter';
import { createGraphBackend } from '@adhd/sox-graph-store';

// Turso is the default backend — multiprocess_wal is on, so this same file
// can be opened by many processes with concurrent writers, no coordination
// required beyond store-adapter's own '-tshm' sidecar.
const adapter = await createStoreAdapter({ dbPath: 'graph.db' });
const graph = createGraphBackend(adapter);
await graph.applySchema();

const id = await graph.writeNode('Ravens migrate south for winter', {
  kind: 'claim',
  name: 'raven-migration',
  topic: 'ornithology',
  tags: ['birds', 'migration'],
  confidence: 'unverified',
});

const node = await graph.getNode(id);
console.log(node?.name); // "raven-migration"

// Full-text search over content/name/summary
const hits = await graph.searchNodes('migrate');
console.log(hits[0]?.score);

await adapter.close();
```

## API reference

### `createGraphBackend(adapter, opts?)`

```typescript
function createGraphBackend(adapter: StoreAdapter, opts?: GraphBackendOpts): GraphBackend;

interface GraphBackendOpts {
  /** Injected type-vocabulary policy. Defaults to the six built-in kinds / ten built-in rels. */
  typePolicy?: TypePolicy;
  /** Write observers, fired after-commit (e.g. to drive an embedding pipeline). */
  observers?: GraphWriteObserver[];
  /** Injected uniqueness check, run inside writeNode before the INSERT. */
  uniquenessPolicy?: NodeUniquenessPolicy;
}
```

### `GraphBackend` interface

```typescript
interface GraphBackend {
  readonly capabilities: GraphBackendCapabilities; // { bitemporal, fullTextSearch, metadataFilter }
  readonly engineIdentity?: EngineIdentity | null;

  applySchema(): Promise<void>;

  // Writes
  writeNode(content: string, meta: NodeMeta, opts?: WriteNodeOpts): Promise<number>;
  findOrCreateNode(kind: string, name: string, opts?: { content?: string; meta?: NodeMeta }): Promise<number>;
  supersede(oldId: number, newContent: string, meta: NodeMeta): Promise<number>;
  invalidate(nodeId: number, reason?: string): Promise<void>;
  touch(nodeId: number, meta: Partial<NodeMeta>): Promise<void>;
  writeNodeBatch(nodes: Array<{ content: string; meta: NodeMeta }>, opts?: WriteNodeOpts): Promise<number[]>;
  writeGraph(
    nodes: Array<{ content: string; meta: NodeMeta }>,
    edges: Array<{ srcIdx: number; dstIdx: number; rel: EdgeRel; meta?: EdgeMeta }>,
    opts?: WriteNodeOpts,
  ): Promise<number[]>;
  transaction<T>(fn: (tx: AdapterTransaction) => Promise<T>): Promise<T>;

  writeEdge(src: number, dst: number, rel: EdgeRel, meta?: EdgeMeta): Promise<void>;
  writeEdges(edges: Array<{ src: number; dst: number; rel: EdgeRel; meta?: EdgeMeta }>): Promise<void>;
  invalidateEdge(src: number, dst: number, rel: EdgeRel, reason?: string): Promise<void>;

  // Reads
  getNode(id: number): Promise<NodeRecord | null>;
  getNodeByUid(uid: string): Promise<NodeRecord | null>;
  getNodesByIds(ids: number[], opts?: { liveOnly?: boolean }): Promise<NodeRecord[]>;
  queryNodes(filter?: NodeFilter): Promise<NodeRecord[]>;
  searchNodes(query: string, opts?: { limit?: number; offset?: number; filter?: NodeFilter }):
    Promise<Array<NodeRecord & { score: number }>>;
  countNodes(filter?: NodeFilter): Promise<number>;
  countBy(field: 'kind' | 'namespace' | 'agentId', filter?: NodeFilter): Promise<Record<string, number>>;
  countNodesFts(query: string, filter?: NodeFilter): Promise<number>;
  getSupersessionChain(nodeId: number): Promise<NodeRecord[]>;
  getEdges(opts: { src?: number; dst?: number; rel?: EdgeRel; metadata?: Record<string, MetadataFilterValue> }): Promise<EdgeRecord[]>;

  // Traversal
  getNeighbors(nodeId: number, opts?: { rel?: EdgeRel; depth?: number; direction?: 'in' | 'out' | 'both' }): Promise<NodeRecord[]>;
  getNeighborsWithEdges(nodeId: number, opts?: { rel?: EdgeRel; depth?: number; direction?: 'in' | 'out' | 'both' }):
    Promise<Array<{ node: NodeRecord; edge: EdgeRecord }>>;
  isReachable(src: number, dst: number, opts?: { rel?: EdgeRel; direction?: 'out' | 'in' }): Promise<boolean>;
  getSubgraph(rootId: number, opts?: { rel?: EdgeRel; depth?: number; direction?: 'out' | 'in' | 'both' }):
    Promise<{ nodes: NodeRecord[]; edges: EdgeRecord[] }>;
}
```

### Core types

```typescript
type EdgeRel = 'MENTIONS' | 'SUPPORTS' | 'RELATES_TO' | 'DERIVED_FROM' | 'SUPERSEDES'
  | 'SAME_AS' | 'ASSIGNED_TO' | 'MEMBER_OF' | 'PART_OF' | 'DEPENDS_ON' | (string & {});
type Confidence = 'confirmed' | 'unverified' | 'disputed' | 'deprecated';

interface NodeMeta {
  kind?: string;          // one of DEFAULT_NODE_KINDS unless a custom TypePolicy is injected
  name?: string;
  summary?: string;
  topic?: string;
  tags?: string[];
  importance?: number;
  confidence?: Confidence;
  source?: string;
  agentId?: string;
  projectPath?: string;
  sessionId?: string;
  namespace?: string;     // hard partition; absent → "global"
  tOccurred?: string;
  tExpires?: string;      // TTL — node.isStale flips true once this passes
  metadata?: Record<string, unknown>;
}

interface NodeRecord {
  id: number;             // rowid — per-store, changes across export/rebuild
  uid: string;            // stable, exportable UUID
  kind: string;
  content: string;
  name?: string; summary?: string; topic?: string;
  tags: string[];
  importance?: number;
  confidence?: Confidence;
  tCreated: string; tValid: string; tInvalid?: string; tExpires?: string;
  isSuperseded: boolean;
  isStale: boolean;
  namespace: string;
  metadata?: Record<string, unknown>;
}

const DEFAULT_NODE_KINDS = ['episode', 'entity', 'claim', 'community', 'session', 'generic'] as const;
```

## Bi-temporal writes: nothing is ever deleted

`invalidate()` marks a node dead (`t_invalid` set) without removing it; `supersede()` mints a brand-new node linked back to the old one by a `SUPERSEDES` edge; `touch()` mutates cheap fields (name, tags, importance, `tExpires`, metadata) on the *same* node with no new row and no edge:

```typescript
const v1 = await graph.writeNode('draft policy text', { name: 'retention-policy' });

// touch() — same node, no history event, throws if v1 is already invalidated
await graph.touch(v1, { importance: 8, metadata: { reviewed: true } });

// supersede() — mints v2, writes v2 -[SUPERSEDES]-> v1, marks v1 invalid
const v2 = await graph.supersede(v1, 'final policy text', { name: 'retention-policy' });

const chain = await graph.getSupersessionChain(v2); // [v1, v2], oldest first
```

## Full-text search, gated by a capability flag

`graph.capabilities.fullTextSearch` reflects whether the underlying adapter supports it (SQLite: `fts5`; Turso: a native Tantivy index) — `searchNodes()` returns `[]`, not an error, when it's `false`:

```typescript
if (graph.capabilities.fullTextSearch) {
  const results = await graph.searchNodes('policy retention', { limit: 10 });
  for (const r of results) console.log(r.name, r.score);
}
```

## Filtering: bitemporal validity + arbitrary metadata

`NodeFilter.validAt` is honored only when `capabilities.bitemporal === true` (silently ignored otherwise). `metadata` accepts either scalar equality or an operator object (`eq`/`neq`/`in`/`gt`/`gte`/`lt`/`lte`/`between`/`exists`/`contains`), evaluated via `json_extract` so ISO-8601 timestamps and numbers compare correctly:

```typescript
await graph.writeNode('p1', { kind: 'issue', metadata: { priority: 1, status: 'open', tags: ['x'] } });
await graph.writeNode('p2', { kind: 'issue', metadata: { priority: 3, status: 'closed' } });

const highPriorityOpen = await graph.queryNodes({
  kind: 'issue',
  metadata: {
    priority: { gte: 2 },
    status: { eq: 'open' },
    tags: { contains: 'x' },
  },
  orderBy: 'importance',
  orderDir: 'desc',
  limit: 20,
});
```

For stable pagination under concurrent writers, use the keyset cursor (`after`) instead of `offset`, which is O(offset) and unstable across concurrent inserts:

```typescript
let page = await graph.queryNodes({ kind: 'issue', limit: 100 });
while (page.length > 0) {
  const lastId = page[page.length - 1]!.id;
  // ...process page...
  page = await graph.queryNodes({ kind: 'issue', limit: 100, after: lastId });
}
```

## Traversal

```typescript
const a = await graph.writeNode('task A', { kind: 'generic' });
const b = await graph.writeNode('task B', { kind: 'generic' });
await graph.writeEdge(a, b, 'DEPENDS_ON');

const deps = await graph.getNeighbors(a, { rel: 'DEPENDS_ON', direction: 'out', depth: 2 });
const reachable = await graph.isReachable(a, b, { rel: 'DEPENDS_ON', direction: 'out' });
const { nodes, edges } = await graph.getSubgraph(a, { direction: 'out', depth: 3 });
```

`DEPENDS_ON` is a first-class `EdgeRel` for typed dependency graphs (plan DAGs, tool dependency trees) — see [`@adhd/sox-analysis`](https://www.npmjs.com/package/@adhd/sox-analysis) for pure `topoSort`/`criticalPath`/`detectCycles` algorithms that consume a graph shaped this way.

## Atomic batch writes and multi-op transactions

`writeGraph()` / `writeNodeBatch()` run inside one adapter transaction — all nodes (and edges) commit together or none do. `writeEdge()` is upsert-idempotent on `(src, dst, rel)`, so replaying a projection is always safe. `transaction()` exposes the raw `AdapterTransaction` for composing your own atomic multi-step writes:

```typescript
const ids = await graph.writeGraph(
  [
    { content: 'root task', meta: { kind: 'generic', name: 'root' } },
    { content: 'child task', meta: { kind: 'generic', name: 'child' } },
  ],
  [{ srcIdx: 1, dstIdx: 0, rel: 'DEPENDS_ON' }], // child depends on root
);

await graph.transaction(async (tx) => {
  const existing = await tx.executeGet('SELECT rowid FROM node WHERE name = ?', ['root']);
  if (existing) throw new Error('already exists');
  // ...additional writes against tx...
});
```

## Idempotent business-key writes

`findOrCreateNode()` returns the existing node's id on a repeat call with the same `(kind, name)`, or creates it — useful for idempotent projections (e.g. re-running an ETL):

```typescript
const statusId = await graph.findOrCreateNode('status', 'OPEN', { content: 'Open status' });
await graph.findOrCreateNode('status', 'OPEN'); // returns the same id, writes nothing new
```

Because the store is parallel-process enabled (multiple processes may hold concurrent Turso write connections), a plain check-then-insert like this is not automatically race-free across processes — wrap it in `transaction()` or back it with your own uniqueness policy (below) if two processes might race to create the same key.

## Content-hash dedup

`writeNode()` dedups by content hash by default: writing the same content twice returns the *same* node id rather than inserting a duplicate row.

```typescript
const id1 = await graph.writeNode('hello world', {});
const id2 = await graph.writeNode('hello world', { topic: 'different' });
console.log(id1 === id2); // true — same content, same node
```

Set `skipDedupe: true` when identity is business-key-based rather than content-based (e.g. entity nodes where two entities can legitimately share content):

```typescript
await graph.writeNode('Acme Corp', { kind: 'entity', name: 'acme' }, { skipDedupe: true });
```

## Namespace isolation

`NodeMeta.namespace` is a hard partition, not a filter convention — nodes in different namespaces never match each other's queries by default. Absent namespace defaults to `"global"`.

```typescript
await graph.writeNode('doc', { namespace: 'tenant-a' });
const tenantANodes = await graph.queryNodes({ namespace: 'tenant-a' });
```

## Custom type policies and uniqueness

`createGraphBackend`'s `typePolicy` and `uniquenessPolicy` options let you replace the built-in six-kind / ten-rel vocabulary and enforce your own uniqueness rules at the write boundary, inside the same transaction as the INSERT:

```typescript
import { createGraphBackend } from '@adhd/sox-graph-store';
import type { TypePolicy } from '@adhd/sox-graph-store';

const openVocabulary: TypePolicy = {
  validateKind: () => {}, // accept any kind string
  validateRel: () => {},  // accept any rel string
};

const graph = createGraphBackend(adapter, { typePolicy: openVocabulary });
```

## Invariants

- Records are **never deleted** — `invalidate()` sets `t_invalid` (audit-preserving); `supersede()` mints a new node linked by `SUPERSEDES`.
- `touch()` updates mutable metadata without minting a new node or edge — throws if the node is invalidated or missing.
- `writeEdge()` is upsert-idempotent on `(src, dst, rel)` — safe to call on re-projection.
- `writeGraph()` / `writeNodeBatch()` are atomic — all or nothing, in one adapter transaction.
- `searchNodes()` returns `[]` (not an error) when `capabilities.fullTextSearch === false`.
- `NodeFilter.validAt` is honored only when `capabilities.bitemporal === true`; ignored silently otherwise.
- `namespace` is a hard isolation field (not a tag/filter convention) — absent → `"global"`.
- `kind` must be one of `DEFAULT_NODE_KINDS` (`episode`/`entity`/`claim`/`community`/`session`/`generic`) unless you inject a custom `TypePolicy` — an out-of-vocabulary kind throws `ConstraintError`.
- The store is **parallel-process enabled** (Turso `multiprocess-wal`, the default) — concurrent processes may hold concurrent write connections to the same store file. A caller-side check-then-write (`findOrCreateNode`, a custom `NodeUniquenessPolicy`) is not automatically race-free across processes; wrap it in `transaction()` or back it with a DDL constraint if two processes might race on the same key.

## Requires

Node >=22. Runs on [`@adhd/sox-store-adapter`](https://www.npmjs.com/package/@adhd/sox-store-adapter) — see that package's README for adapter configuration (Turso vs. SQLite, transaction modes, retry utilities).
