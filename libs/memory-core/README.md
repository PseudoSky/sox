# @adhd/sox-memory-core

The storage and query engine behind sox-memory: a bi-temporal, hybrid-search episodic memory
store. It turns raw text into embedded, tagged, clustered, graph-linked episodes and answers
recall queries by fusing vector similarity, full-text search, temporal recency, and graph
expansion into a single ranked result set — all with zero network/LLM calls on the write or read
path (embeddings are computed locally via ONNX).

It is built directly on [`@adhd/sox-store-adapter`](https://www.npmjs.com/package/@adhd/sox-store-adapter)
and inherits that adapter's concurrency architecture: the default Turso backend runs in
`multiprocess-wal` mode, where **multiple OS processes hold concurrent write connections to the
same store file**, serialized through a `-tshm` coordinator sidecar — there is no opt-out on this
adapter. In practice that means you can point many CLI invocations, many MCP server instances, and
many independent agent processes at one `.db` file and write to it concurrently, without an
external lock service and without funneling every write through a single owning process. A
same-process, single-connection SQLite (`better-sqlite3`) backend remains available as a
backward-compatible, genuinely single-writer fallback.

```bash
pnpm add @adhd/sox-memory-core
```

## Quick start

```typescript
import { write, recall } from '@adhd/sox-memory-core';

// write() and recall() open the store, run one operation, and close it —
// the simplest way to get an episode in and back out.
const result = await write('~/.memory/project.db', {
  content: 'Bi-temporal edges supersede facts rather than overwriting them.',
  project_path: '/Users/me/dev/my-project',
  summary: 'graph supersession model',
  tags: ['graph', 'design'],
});

if ('episode_uid' in result) {
  console.log('wrote episode', result.episode_uid);
}

const hits = await recall('~/.memory/project.db', {
  query: 'how do we handle superseded facts?',
  filters: { project_path: '/Users/me/dev/my-project' },
  limit: 5,
});

for (const hit of hits) {
  console.log(hit.score.toFixed(3), hit.content);
}
```

### Managing your own adapter (multiple operations, one connection)

`write()`/`recall()` open and close a fresh connection per call, which is wasteful for a server or
long-running process that performs many operations. Open a `StoreAdapter` once and pass it to the
lower-level `memory*` functions instead:

```typescript
import { openDb, memoryWrite, memoryRecall, closeDbWithLease } from '@adhd/sox-memory-core';

const adapter = await openDb('~/.memory/project.db');
try {
  const w = await memoryWrite(adapter, {
    content: 'The write queue admits exactly one task per slot in FIFO mode.',
    project_path: '/Users/me/dev/my-project',
  });

  const response = await memoryRecall(adapter, 'project', {
    query: 'write queue admission',
    filters: { project_path: '/Users/me/dev/my-project' },
  });
  console.log(response.results.map((r) => r.uid));
} finally {
  await closeDbWithLease(adapter, '~/.memory/project.db');
}
```

`openDb()` creates the file if it does not exist, applies pragmas + schema DDL idempotently, and
returns a ready-to-use `StoreAdapter` — sqlite or turso, selected by the `STORE_ADAPTER` env var,
same as the adapter package itself. `StoreAdapter` is **not** re-exported by this package: it is a
type defined in `@adhd/sox-store-adapter` and every `memory*` function below merely accepts the
value `openDb()` gives you back. If you need the type itself (e.g. to annotate your own function's
parameter), import it directly from that package:

```typescript
import type { StoreAdapter } from '@adhd/sox-store-adapter';
```

## API reference

### Database & lifecycle

```typescript
function openDb(dbPath: string): Promise<StoreAdapter>;
function openDbReadOnly(dbPath: string): Promise<StoreAdapter>;
function closeDbWithLease(adapter: StoreAdapter, dbPath: string): Promise<void>;
function initScope(adapter: StoreAdapter, scope: ScopeKind, scopeId: string): Promise<MemoryScope>;
function expandDbPath(dbPath: string): string; // expands a leading `~` to $HOME
function migrateAddColumn(adapter: StoreAdapter, table: string, column: string, type: string): Promise<void>;

type ScopeKind = 'project' | 'user' | 'org' | 'local';
```

### Write, update, invalidate

```typescript
interface WriteParams {
  content: string;
  project_path: string;        // REQUIRED — never inferred from cwd/env, to avoid silent mis-attribution
  summary?: string;
  name?: string;
  topic?: string;
  tags?: string[];
  importance?: number;
  metadata?: Record<string, unknown>;
  derived_from_uid?: string;   // emits a DERIVED_FROM edge to a parent episode
  client_request_id?: string;  // idempotency key — replaying it returns the original result
  session_id?: string;
  agent_id?: string;
  source?: 'message' | 'tool_output' | 'observation' | 'document' | 'reflection' | 'import';
}
interface WriteResult {
  episode_uid: string;
  replayed?: boolean;          // true when client_request_id matched an existing write
  enrichment?: { topic: string | null; project_path: string | null; project_path_source: 'explicit' | 'inferred' };
}

function memoryWrite(adapter: StoreAdapter, params: WriteParams): Promise<WriteResult | WriteError>;
function memoryWriteBatch(adapter: StoreAdapter, items: BatchItem[]): Promise<BatchResult>;
function memoryUpdate(adapter: StoreAdapter, params: UpdateParams): Promise<UpdateResult | UpdateError>;
function memoryInvalidate(adapter: StoreAdapter, params: InvalidateParams): Promise<InvalidateResult | InvalidateError>;
```

`memoryWrite` embeds and enriches (tags, topic, near-dup detection) synchronously before
returning. A write is deduplicated by `content_hash`: writing identical content twice never
inserts a second row.

```typescript
// Idempotent write — replaying the same client_request_id returns the original result
// instead of creating a duplicate episode, even across process restarts.
const first = await memoryWrite(adapter, {
  content: 'Deploy completed for v2.3.0.',
  project_path: '/Users/me/dev/my-project',
  client_request_id: 'deploy-notify-v2.3.0',
});
const replay = await memoryWrite(adapter, {
  content: 'Deploy completed for v2.3.0.',
  project_path: '/Users/me/dev/my-project',
  client_request_id: 'deploy-notify-v2.3.0',
});
// 'episode_uid' in replay && replay.replayed === true
```

`memoryUpdate` edits a node in place by `uid` (content/summary changes trigger a re-embed);
`memoryInvalidate` closes an episode's validity window without deleting it — the store is
bi-temporal, so history is never destroyed, only marked invalid as of a point in time.

### Recall (hybrid search)

```typescript
interface RecallParams {
  query: string;
  scopes?: string[];           // default: ['project']
  agent_id?: string;           // hard filter on memoryRecall; a scoring boost on federatedRecall
  filters?: Record<string, unknown>; // shaped like MemoryFilter: { project_path, topic, tags, importance_min, ... }
  as_of?: string;               // bi-temporal point-in-time query
  token_budget?: number;
  depth?: number;                // graph-expansion depth (default 1)
  limit?: number;
  vec_weight?: number; fts_weight?: number; temporal_weight?: number;
}
interface RecallResult {
  uid: string;
  content: string | null;
  score: number;
  score_breakdown: { vec: number; bm25: number; temporal: number; total: number };
  importance: number;
  t_valid: string | null;
  expandedText: string;         // content plus depth-1 graph-expanded neighbor context
}

function memoryRecall(adapter: StoreAdapter, scope: string, params: RecallParams): Promise<RecallResponse>;
function federatedRecall(stores: StoreDescriptor[], params: RecallParams): Promise<FederatedRecallResponse>;
```

Every result carries a `score_breakdown` — the vector (cosine KNN), BM25 (FTS5), and
temporal-recency channels that were fused (via reciprocal rank fusion, k=60) into `score`, so a
caller can see *why* a result ranked where it did, not just that it did.

```typescript
// Federated recall across multiple scoped stores (project + user + org), with
// per-scope weighting and agent_id as a ranking boost rather than a hard filter.
import { federatedRecall } from '@adhd/sox-memory-core';

const federated = await federatedRecall(
  [
    { scope: 'project', dbPath: '~/.memory/project.db' },
    { scope: 'user', dbPath: '~/.memory/user.db' },
  ],
  { query: 'deployment runbook', agent_id: 'deploy-bot', limit: 10 },
);
```

### Clustering & communities

Deterministic, byte-reproducible connected-components clustering over cosine similarity — no LLM,
no network:

```typescript
import { clusterStore, clusterStats } from '@adhd/sox-memory-core';

const result = await clusterStore(adapter, { threshold: 0.87 });
console.log(result); // { clusters: [...], full_pass, unclustered_count, ... }

const stats = await clusterStats(adapter);
```

Each `ClusterResult` carries a stable `community_uid` (`sha256` of the sorted member rowids), a
centroid-derived label, and a mean intra-cluster similarity quality metric.

### Curation

```typescript
function memoryCurate(adapter: StoreAdapter, args: Record<string, unknown>, wq?: WriteQueue): Promise<CurateResult>;
```

A single dispatcher for maintenance operations against a live store: retagging, merging
near-duplicates, re-clustering a subset or the whole store, re-healing stale/missing vectors,
draining the embed backlog, and unpoisoning/acknowledging rows or alarms that a health check
flagged. `CurateResult` is a discriminated union — inspect `result.op` to see which operation ran.

### Graph reads

```typescript
function memoryLinkNode(adapter: StoreAdapter, args: Record<string, unknown>): Promise<LinkResult>;
function memoryGetRelated(adapter: StoreAdapter, args: Record<string, unknown>): Promise<RelatedResult>;
function memoryGetEntityEpisodes(adapter: StoreAdapter, args: Record<string, unknown>): Promise<EntityEpisodesResult>;
function memoryListEntities(adapter: StoreAdapter, args: Record<string, unknown>): Promise<ListEntitiesResult>;
function memoryGetNearDuplicates(adapter: StoreAdapter, args: Record<string, unknown>): Promise<NearDuplicatesResult>;
function memoryGetSupersessionChain(adapter: StoreAdapter, args: Record<string, unknown>): Promise<SupersessionChainResult>;
function memoryGetSessionState(adapter: StoreAdapter, args: Record<string, unknown>): Promise<GetSessionStateResult>;
function memorySaveSessionState(adapter: StoreAdapter, args: Record<string, unknown>): Promise<SaveSessionStateResult>;
```

`memoryGetRelated` walks depth-1 graph neighbors; `memoryGetSupersessionChain` does a bidirectional
BFS over `SUPERSEDES` edges to reconstruct the full history of a fact that has been revised
multiple times.

### Domain queries

```typescript
function memoryListTopics(adapter: StoreAdapter, args: Record<string, unknown>): Promise<TopicsResult>;
function memoryListProjects(adapter: StoreAdapter, args: Record<string, unknown>): Promise<ListProjectsResult>;
function memoryGetStats(adapter: StoreAdapter, args: Record<string, unknown>, toolNames: string[]): Promise<StatsResult>;
```

`memoryGetStats` composes cluster stats, embed pipeline health, and per-record embed provenance
counts (how many live episodes are stamped/unstamped/stale/orphaned) into one aggregate — the
health surface a monitoring loop should poll.

### Extended functions — promotion, graphify, communities, entity search

```typescript
function detectPromotionCandidates(adapter: StoreAdapter, config: PromotionConfig | null | undefined, fromScope: string, toScope: string): Promise<PromotionCandidateResult>;
function applyPromotion(srcAdapter: StoreAdapter, dstAdapter: StoreAdapter, nodeUid: string, fromScope: string, toScope: string): Promise<ApplyPromotionResult>;
function graphifyImport(adapter: StoreAdapter, graphJson: unknown, options?: { agent_id?: string }): Promise<GraphifyImportResult | GraphifyImportError>;
function buildCommunities(adapter: StoreAdapter, options?: BuildCommunitiesOptions): Promise<BuildCommunitiesResult>;
function memoryGetCommunity(adapter: StoreAdapter, entity_uid: string, level?: number): Promise<GetCommunitySuccess | GetCommunityError>;
function memorySearchEntities(adapter: StoreAdapter, params: SearchEntitiesParams): Promise<SearchEntitiesResult>;
```

Promotion detects episodes accessed/mentioned often enough to graduate from one scope to a
broader one (e.g. project → org); `buildCommunities` runs deterministic label-propagation
community detection over the graph.

### Embedding

```typescript
function embed(text: string): Promise<Float32Array>;        // 768-dim, L2-normalized
function warmupEmbed(timeoutMs?: number): Promise<EmbedHealth>;
function getEmbedHealth(): EmbedHealth;
function getActiveEmbedModel(): string | null;
```

`embed()` delegates to `@adhd/sox-embedding-provider`, which runs the real ONNX model
(`bge-base-en-v1.5` by default) off the main thread in a worker/child process — no network call is
made per embed, and the ONNX runtime is deliberately kept out of the same thread as
`better-sqlite3` (the two native addons cannot safely share one thread; see the "Process
isolation" note below).

### Operations — backup, quota, compaction

```typescript
function backupStore(dbPath: string, destPath: string, opts?: BackupStoreOptions): Promise<BackupStoreResult | BackupStoreError>;
function checkStoreQuota(adapter: StoreAdapter, config?: QuotaConfig): Promise<QuotaCheckResult>;
function runCompactionPass(adapter: StoreAdapter, opts?: CompactionOptions): Promise<CompactionResult>;
function startCompactionTick(adapter: StoreAdapter, opts?: CompactionOptions): () => void; // returns a stop function
```

```typescript
import { backupStore } from '@adhd/sox-memory-core';

// VACUUM INTO a compacted, single-file copy, then verify its integrity —
// destPath must live under ~/.memory/** (the same allowlist as the write path).
const backup = await backupStore('~/.memory/project.db', '~/.memory/backups/project-2026-08-28.db');
```

```typescript
import { checkStoreQuota, isQuotaRefusal } from '@adhd/sox-memory-core';

// Call before a write path proceeds — E_IO refuses the write outright over the hard limit,
// never attempting it.
const quota = await checkStoreQuota(adapter, { softBytes: 512 * 1024 * 1024, hardBytes: 1024 * 1024 * 1024 });
if (isQuotaRefusal(quota)) {
  throw new Error(`store over quota: ${quota.message}`);
}
```

## Process isolation (read before running writes + embeddings in one thread)

`openDb()` (better-sqlite3 + sqlite-vec) and a real ONNX embedding call must never run on the same
thread in the same process — the two native addons share a libpthread mutex that corrupts across
an async boundary. This library's own `embed()` already delegates to `@adhd/sox-embedding-provider`,
which hosts ONNX in a forked child process / `worker_threads` worker, so a normal call sequence —
`openDb()` then `await embed(...)` via `memoryWrite`/`memoryRecall` in the same process — is safe as
long as you go through this package's exports. Do not bypass that isolation by importing
`onnxruntime-node` directly into a process that also holds a `better-sqlite3` handle.

## Error taxonomy

Every `memory*` function that can fail returns a structured `StorageError` rather than throwing a
raw driver exception:

```typescript
type StorageErrorCode = 'E_BUSY' | 'E_IO' | 'E_ALLOWLIST' | 'E_DEDUP' | 'E_NOT_FOUND' | 'E_STORE_MISMATCH';
interface StorageError {
  code: StorageErrorCode;
  message: string;
  retryable: boolean;
  retry_after_ms?: number;
  details?: Record<string, unknown>;
}
```

`wrapDbError(err)` is the single place raw driver exceptions (SQLite- or Turso-shaped) get
translated into this taxonomy — used internally by every write/update/invalidate path.

## Invariants / gotchas

- **`project_path` is required on every write, never inferred.** A write with no explicit
  `project_path` is rejected with `E_MISSING_PROJECT_PATH` rather than falling back to
  `cwd`/env-based inference — a long-lived server process's `process.cwd()` cannot reflect a
  caller's live working directory, and silent mis-attribution is worse than a loud rejection.
  (Reads are unaffected — omitting `project_path` on a recall/topics/etc. call is a valid "search
  every project" request.)
- **Writes are two-phase.** `memoryWrite()` is the synchronous composition most callers want, but
  internally Phase A (dedup, node insert, FTS, sync enrichment) commits before embedding runs;
  Phase B computes the vector off the write-queue slot. A crash between phases is healed by the
  periodic `healMissingVectors` tick, and the current backlog is visible via `embedBacklogStats(adapter)`.
- **Dedup is by `content_hash`, and a write never deletes.** Writing identical content twice
  returns the original episode; correcting a fact mints a new episode and links it via
  `SUPERSEDES` rather than mutating history.
- **`multiprocessWrite`/`needsWriteSerialization` come from the underlying adapter, not from this
  package** — see `@adhd/sox-store-adapter`'s capability flags to check which mode a given
  `StoreAdapter` instance is actually running in.

## License

MIT
