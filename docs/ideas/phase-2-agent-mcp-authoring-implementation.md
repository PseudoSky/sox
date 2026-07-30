# Updated Implementation Spec — Plan 8 Agent-MCP Authoring (StoreAdapter Edition)

> **Source plan:** `/Users/nix/dev/node/adhd/docs/plan/agent-mcp-authoring/` — 13 states, all `"pending"`  
> **Source spec:** `docs/ideas/turso-database-adapter.md` — StoreAdapter architecture (Round 6)  
> **Source audit:** `docs/ideas/phase-2-agent-mcp-authoring.md` — pre-adapter observations  
> **Date:** 2026-07-26  
> **Scope:** ADHD project code changes for Plan 8 states — sox package internals are already done

---

## Summary

Plan 8 adds a discovery + authoring MCP lane over a registry of typed prompt components. It consumes
six sox-ecosystem packages that have now been migrated to accept `StoreAdapter` instead of
`better-sqlite3.Database`. This spec updates the Plan 8 states to use the new `StoreAdapter`-based
sox package APIs. Five of the 13 states change their code signatures: the vector store and hybrid
search now accept `StoreAdapter` at construction, making the ADHD code responsible for creating
adapters. The remaining 8 states are unaffected (design docs, tests, pure wire operations).

### Key changes from the original plan

| Dimension | Original plan | Updated (StoreAdapter) |
|---|---|---|
| `openVectorStore()` call | `openVectorStore(path, {dim, modelId})` — synchronous | `openVectorStore({adapter, dim, modelId})` — adapter must be created first via async factory |
| Vector DB creation | Internal to vector-store | Caller creates `StoreAdapter` via `createStoreAdapter({type:'sqlite', dbPath})` or env-driven factory |
| FTS5 access | Via `@adhd/sox-graph-store` `searchNodes()` (Option A, rejected) | Registry owns its FTS5 table, queries via `adapter.executeAll()` raw SQL |
| Hybrid fusion | Option B: registry implements `SearchBackend`, calls `fuse()`/`normalize()` | Same Option B, but vector store + FTS5 both use `adapter.execute*()` |
| Native vector support | `sqlite-vec` only | TursoAdapter provides native `vector(N)` columns; `VectorDialect` chosen by `adapter.capabilities.nativeVectors` |
| Multi-process writers | Not supported | `TursoAdapter({experimental:{multiprocessWal:true}})` — safe for CLI + HTTP + MCP |
| Transaction modes | `BEGIN DEFERRED` only | Explicit `mode: 'immediate'` for CAS in `agent_define` |

### State impact matrix

| State | StoreAdapter impact | What changes |
|---|---|---|
| `authoring-design` | **None** | decisions.md only — no code |
| `embedding-substrate` | **Medium** | Creates `StoreAdapter` for vector DB; passes to `openVectorStore({adapter})` |
| `enrichment-pipeline` | **Medium** | Receives adapter-created vector backend; calls `adapter.transaction()` for CAS |
| `name-slug-seam` | **None** | Pure translation — no DB code |
| `discovery-tools` | **High** | Creates FTS5 table via `adapter.exec()`; vector search via adapted vector store; `fuse()` unchanged |
| `component-define` | **Low** | Thin wrapper — delegates to enrichment pipeline which already handles adapter |
| `agent-define` | **Medium** | Transactional upsert uses `adapter.transaction(fn, {mode:'immediate'})` for CAS |
| `compat-shim` | **None** | No DB code |
| `versioning` | **None** | CHANGELOG only |
| `composition-journey-e2e` | **None** | MCP wire — no DB code |
| `live-model-e2e` | **None** | MCP wire — no DB code |
| `code-review` | **None** | Read-only |
| `audit-final` | **None** | Read-only |

---

## Prequisite: sox packages post-migration API surface

These are the package APIs as they exist AFTER the StoreAdapter migration (spec Segments B–F).
Plan 8 code writes against these APIs — the sox packages have already been refactored.

### `@adhd/sox-store-adapter`

```typescript
// Factory — env-driven (STORE_ADAPTER env var, defaults 'turso')
export async function createStoreAdapter(config?: Partial<AdapterConfig>): Promise<StoreAdapter>;

// Direct constructors — use when the caller knows which backend it wants
export function createSqliteAdapter(opts: { dbPath: string }): SqliteAdapter;
export async function createTursoAdapter(opts: { dbPath?: string; url?: string; authToken?: string; experimental?: { multiprocessWal?: boolean } }): Promise<TursoAdapter>;

// Core interface
export interface StoreAdapter {
  executeGet<T>(sql: string, args?: unknown[]): Promise<T | null>;
  executeAll<T>(sql: string, args?: unknown[]): Promise<AllResult<T>>;
  executeRun(sql: string, args?: unknown[]): Promise<RunResult>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: AdapterTransaction) => T | Promise<T>, opts?: TransactionOptions): Promise<T>;
  close(): Promise<void>;
  readonly capabilities: AdapterCapabilities;
}

export interface AdapterCapabilities {
  multiprocessWrite: boolean;   // true for TursoAdapter with multiprocessWal
  nativeVectors: boolean;       // true for TursoAdapter
  concurrentTransactions: boolean; // true for TursoAdapter
}

export interface TransactionOptions {
  mode?: 'deferred' | 'immediate' | 'exclusive' | 'concurrent';
  maxRetries?: number;
  baseDelayMs?: number;
}
```

### `@adhd/sox-vector-store` (post-migration)

```typescript
// BEFORE (original):
// export function openVectorStore(path: string, opts: { dim: number; modelId: string }): SqliteVectorBackend;

// AFTER (StoreAdapter):
export function openVectorStore(opts: {
  adapter: StoreAdapter;        // NEW — replaces path parameter
  dim: number;
  modelId: string;
  dialect?: VectorDialect;      // NEW — auto-selected via adapter.capabilities.nativeVectors if absent
}): SqliteVectorBackend;

// Same VectorBackend interface
export interface VectorBackend {
  ensureSpace(space: VectorSpace): void;
  upsert(id: number, vec: Float32Array, space: VectorSpace): void;
  knn(query: Float32Array, space: VectorSpace, k: number, filter?: VecFilter): Array<{ id: number; score: number }>;
  // ... rest unchanged
}
```

### `@adhd/sox-hybrid-search` (post-migration)

The pure fusion functions are unchanged — they take `{id, textScore?, vecScore?}[]` arrays, not
database handles:

```typescript
export function fuse(candidates: FusionCandidate[], opts?: FusionOpts): FusionCandidate[];
export function normalize(scores: number[], method: 'min_max' | 'L2' | 'z_score'): number[];
```

### `@adhd/sox-embedding-provider` (unchanged)

```typescript
// No SQLite dependency — unchanged
export function createEmbeddingProvider(config: EmbeddingProviderConfig): Promise<EmbeddingProvider>;
export interface EmbeddingProvider {
  embedSingle(text: string, role?: EmbedRole): Promise<Float32Array>;
  readonly metadata: { modelId: string; dimensions: number; isDeterministic: boolean };
}
```

### `@adhd/sox-ingest` (unchanged)

```typescript
// Import from /core subpath (node:crypto only at runtime)
export function ingest(content: string, opts?: { summaryMaxSentences?: number }): {
  contentHash: string;  // SHA-256 hex
  summary: string;      // Extractive lead-N sentences
  tags: string[];       // Deterministic keyword tags
};
```

---

## State-by-state implementation changes

### State 1: `authoring-design`

**StoreAdapter impact: NONE.** This state writes `decisions.md` and records the modification
manifest. No code changes. Proceed exactly as originally planned.

**New decisions to add to `decisions.md`:**

1. **D7. StoreAdapter dependency for sox packages** `[def:store-adapter-usage]`
   — The sox packages consumed by this plan accept `StoreAdapter`. ADHD code creates adapters
   via `createSqliteAdapter()` (Phase 1) or `createTursoAdapter()` (Phase 2) and passes them
   to `openVectorStore({adapter})`. Default: `type:'sqlite'` for Phase 1; switch to
   `type:'turso'` for Phase 2. `multiprocessWal` is opt-in via
   `experimental: { multiprocessWal: true }`.

2. **D8. Adapter lifecycle** `[def:adapter-lifecycle]`
   — Each adapter instance is owned by whichever module creates it. `openVectorStore({adapter})`
   takes ownership — the caller must not close the adapter while the vector store is alive.
   For the registry's vector DB, the adapter is created in `embedding-substrate` and shared
   with `enrichment-pipeline` and `discovery-tools` via the `VectorBackend` handle (which
   internally holds the adapter). The adapter is closed by the top-level shutdown path.

---

### State 2: `embedding-substrate`

**StoreAdapter impact: MEDIUM.** This is the first state that creates database connections.
It now creates a `StoreAdapter` for the vector DB and passes it to the sox packages.

#### Interface changes

**File: `packages/agent/agent-store-prompts/src/enrich/embedding.ts`**

```typescript
// BEFORE (original plan)
import { createEmbeddingProvider, type EmbeddingProvider, type EmbeddingProviderConfig } from '@adhd/sox-embedding-provider';

export async function createRegistryEmbedder(
  config?: Partial<EmbeddingProviderConfig>,
): Promise<EmbeddingProvider>;
```

```typescript
// AFTER (StoreAdapter edition)
import { createEmbeddingProvider, type EmbeddingProvider, type EmbeddingProviderConfig } from '@adhd/sox-embedding-provider';
import type { StoreAdapter } from '@adhd/sox-store-adapter';

// Signature unchanged — embedding provider has no SQLite dependency
export async function createRegistryEmbedder(
  config?: Partial<EmbeddingProviderConfig>,
): Promise<EmbeddingProvider>;

// NEW: creates a StoreAdapter for the vector database
// Called ONCE at bootstrap — the returned adapter is passed to openVectorStore
export async function createVectorDbAdapter(
  dbPath: string,
): Promise<StoreAdapter>;
```

**File: `packages/agent/agent-store-prompts/src/enrich/usecase-anchors.ts`**

```typescript
// BEFORE (original plan)
import { openVectorStore, type VectorBackend } from '@adhd/sox-vector-store';
import type { EmbeddingProvider } from '@adhd/sox-embedding-provider';

export interface UseCaseAnchor {
  name: string;
  description: string;
  embedding: Float32Array;
}

export function seedAnchors(embedder: EmbeddingProvider): Promise<UseCaseAnchor[]>;
```

```typescript
// AFTER (StoreAdapter edition)
import { openVectorStore, type VectorBackend } from '@adhd/sox-vector-store';
import type { EmbeddingProvider } from '@adhd/sox-embedding-provider';
import type { StoreAdapter } from '@adhd/sox-store-adapter';

// Unchanged
export interface UseCaseAnchor {
  name: string;
  description: string;
  embedding: Float32Array;
}

// MODIFIED: now receives vector store and adapter
export function seedAnchors(
  embedder: EmbeddingProvider,
  vecDb: VectorBackend,  // NEW — passed in after adapter creation
): Promise<UseCaseAnchor[]>;

// NEW: top-level bootstrap — creates adapter + vector store + seeds anchors
export async function bootstrapVectorStore(
  dbPath: string,
): Promise<{ adapter: StoreAdapter; vecDb: VectorBackend; anchors: UseCaseAnchor[] }>;
```

#### Behavioral changes

1. **Vector DB creation is now externalized.** Previously `openVectorStore(path, opts)` opened
   `better-sqlite3` internally. Now the caller creates the adapter:
   ```typescript
   const adapter = await createVectorDbAdapter(dbPath);
   const vecDb = openVectorStore({ adapter, dim: 768, modelId: 'bge-base-en-v1.5' });
   ```

2. **`createVectorDbAdapter()`** — creates a `SqliteAdapter` (Phase 1) or reads `STORE_ADAPTER`
   env var for env-driven selection. For Phase 1, hardcodes `type: 'sqlite'`:
   ```typescript
   import { createSqliteAdapter } from '@adhd/sox-store-adapter';

   export async function createVectorDbAdapter(dbPath: string): Promise<StoreAdapter> {
     // Phase 1: hardcode sqlite. Phase 2: use createStoreAdapter() for env-driven.
     return createSqliteAdapter({ dbPath });
   }
   ```

3. **`bootstrapVectorStore()`** — new top-level function that combines adapter creation,
   vector store creation, and anchor seeding into one async bootstrap:
   ```typescript
   export async function bootstrapVectorStore(dbPath: string) {
     const adapter = await createVectorDbAdapter(dbPath);
     const vecDb = openVectorStore({ adapter, dim: 768, modelId: 'bge-base-en-v1.5' });
     const embedder = await createRegistryEmbedder();
     const anchors = await seedAnchors(embedder, vecDb);
     return { adapter, vecDb, anchors };
   }
   ```

4. **`seedAnchors()`** is now deterministic wrt idempotence: the `StoreAdapter` connection
   survives across calls (same adapter, same database file). Re-running on a seeded store
   must still be a no-op — gate on existing anchor names in the DB before inserting.

5. **TursoAdapter gains built-in vectors.** When `adapter.capabilities.nativeVectors === true`,
   `openVectorStore()` auto-selects `TursoVectorDialect` — no `sqlite-vec` loading. The
   `VectorBackend` interface is identical; the ADHD code doesn't branch.

#### Updated test patterns

```typescript
// BEFORE
const vecDb = openVectorStore(':memory:', { dim: 768, modelId: 'bge-base-en-v1.5' });

// AFTER — tests create adapter inline
import { createSqliteAdapter } from '@adhd/sox-store-adapter';
const adapter = createSqliteAdapter({ dbPath: ':memory:' });
const vecDb = openVectorStore({ adapter, dim: 768, modelId: 'bge-base-en-v1.5' });
// Cleanup:
afterAll(async () => { await adapter.close(); });
```

---

### State 3: `enrichment-pipeline`

**StoreAdapter impact: MEDIUM.** Receives `VectorBackend` that was created with a `StoreAdapter`.
The enrichment function itself doesn't create adapters — it receives already-constructed
dependencies. The only adapter-level change is explicit transaction modes.

#### Interface changes

**File: `packages/agent/agent-store-prompts/src/enrich/enrich-component.ts`**

```typescript
// BEFORE (original plan)
import { ingest } from '@adhd/sox-ingest/core';
import type { VectorBackend } from '@adhd/sox-vector-store';
import type { EmbeddingProvider } from '@adhd/sox-embedding-provider';

export function enrichComponent(
  embedder: EmbeddingProvider,
  vecDb: VectorBackend,
  params: EnrichComponentParams,
): Promise<EnrichComponentResult>;
```

```typescript
// AFTER (StoreAdapter edition)
import { ingest } from '@adhd/sox-ingest/core';
import type { VectorBackend } from '@adhd/sox-vector-store';
import type { EmbeddingProvider } from '@adhd/sox-embedding-provider';
import type { StoreAdapter } from '@adhd/sox-store-adapter';

// Signature ADDED: StoreAdapter for the registry DB (needed for CAS writes)
export function enrichComponent(
  embedder: EmbeddingProvider,
  vecDb: VectorBackend,
  registryAdapter: StoreAdapter, // NEW — for writing use-case links transactionally
  params: EnrichComponentParams,
): Promise<EnrichComponentResult>;
```

#### Behavioral changes

1. **`registryAdapter` parameter added.** The enrichment pipeline writes `ComponentUsageRow`s
   via the registry stores. For CAS (compare-and-swap) idempotence, the link writes must be
   transactional with `mode: 'immediate'`:
   ```typescript
   await registryAdapter.transaction(async (tx) => {
     // Read existing links
     const existing = await tx.executeAll<{use_case_name: string, weight: number}>(
       'SELECT use_case_name, weight FROM component_usage WHERE component_slug = ?',
       [slug],
     );
     if (linksAreIdentical(existing, newLinks)) {
       return { changed: false };  // Early return — no writes
     }
     // Delete old, insert new
     await tx.executeRun('DELETE FROM component_usage WHERE component_slug = ?', [slug]);
     for (const link of newLinks) {
       await tx.executeRun(
         'INSERT INTO component_usage (component_slug, use_case_name, weight) VALUES (?, ?, ?)',
         [slug, link.name, link.weight],
       );
     }
   }, { mode: 'immediate' });
   ```

2. **Vector store already adapted.** `vecDb` was created via `openVectorStore({adapter})` in
   `embedding-substrate`. Calls like `vecDb.knn()` and `vecDb.upsert()` work identically
   regardless of whether the underlying adapter is sqlite or turso.

3. **`ingest()` unchanged.** `@adhd/sox-ingest/core` has no database dependency.

4. **TursoAdapter multiprocessWal enables concurrent enrichment.** When the adapter is Turso
   with `multiprocessWal`, multiple `component_define` calls from different processes can
   write concurrently without `SQLITE_BUSY`. The `enrichComponent()` function doesn't change —
   `adapter.capabilities.multiprocessWrite` is informational, not branched on.

---

### State 4: `name-slug-seam`

**StoreAdapter impact: NONE.** Pure translation layer — `toSlug()` and `registry-bridge.ts`
wrap existing store method calls. No database code. Proceed exactly as originally planned.

---

### State 5: `discovery-tools`

**StoreAdapter impact: HIGH.** This state builds the 11 read tools including `component_search`
which uses hybrid FTS5 + vector search. The FTS5 table is created in the registry DB via
`adapter.exec()`. The vector channel uses the already-adapted `VectorBackend`.

#### Interface changes

**File: `entrypoint/agent-mcp/src/tools/discovery.ts`** (new, ADDITIVE per D3 manifest)

```typescript
// Key NEW function: component_search hybrid retrieval
export async function componentSearch(
  query: string,
  vecDb: VectorBackend,           // Adapted vector store (from embedding-substrate)
  adapter: StoreAdapter,          // Registry DB adapter for FTS5
  embedder: EmbeddingProvider,    // Embedding provider
  limit: number,
): Promise<ComponentSearchResult[]>;

// Other discovery tools are largely unchanged — they read from existing registry stores
```

#### Behavioral changes

1. **FTS5 creation at bootstrap.** The registry DB needs an FTS5 virtual table for BM25 text search.
   This is created once at bootstrap, NOT per query:
   ```typescript
   // In the discovery-tools bootstrap function:
   await adapter.exec(`
     CREATE VIRTUAL TABLE IF NOT EXISTS component_fts USING fts5(
       version_id UNINDEXED,
       name,
       type,
       content,
       summary,
       tokenize='porter unicode61'
     );
   `);
   // Triggers to keep FTS5 in sync with registry_component_versions:
   await adapter.exec(`
     CREATE TRIGGER IF NOT EXISTS component_fts_insert AFTER INSERT ON registry_component_versions
     BEGIN
       INSERT INTO component_fts(version_id, name, type, content, summary)
       SELECT NEW.version_id, c.name, NEW.type, NEW.content,
         COALESCE(NEW.summary, '')
       FROM registry_components c WHERE c.slug = NEW.component_slug;
     END;
   `);
   // ... DELETE and UPDATE triggers similarly
   ```

2. **Hybrid fusion unchanged.** The `fuse()` and `normalize()` functions from
   `@adhd/sox-hybrid-search` are pure — they take arrays, not adapters:
   ```typescript
   import { fuse, normalize } from '@adhd/sox-hybrid-search';

   // Text channel: BM25 via FTS5
   const textResults = await adapter.executeAll<{version_id: number; score: number}>(
     `SELECT version_id, bm25(component_fts, 0, 10, 5) as score
      FROM component_fts WHERE component_fts MATCH ?
      ORDER BY score LIMIT ?`,
     [ftsQuery, limit * 2],
   );

   // Vector channel: knn via adapted VectorBackend
   const queryVec = await embedder.embedSingle(query);
   const vecResults = vecDb.knn(queryVec, space, limit * 2);

   // Fuse (pure function — no adapter needed)
   const fused = fuse([
     ...textResults.rows.map(r => ({ id: r.version_id, textScore: r.score })),
     ...vecResults.map(r => ({ id: r.id, vecScore: r.score })),
   ]);
   ```

3. **TursoAdapter native vectors enable ANN indexing.** When `adapter.capabilities.nativeVectors`
   is true, the vector dialect generates `CREATE INDEX ... USING ann` DDL — the FTS5 path is
   unchanged but the vector channel benefits from native ANN acceleration.

4. **`multiprocessWal` enables concurrent reads.** With `multiprocessWal`, multiple agent-mcp
   instances can read from the same registry DB simultaneously. The `adapter` parameter is
   always a single-connection adapter; each caller opens its own.

#### Updated test patterns

```typescript
// FTS5 + vector hybrid test — uses adapter for both channels
const adapter = createSqliteAdapter({ dbPath: ':memory:' });
const vecDb = openVectorStore({ adapter, dim: 768, modelId: 'bge-base-en-v1.5' });

// Create FTS5 table via adapter
await adapter.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS component_fts USING fts5(...)`);

// Run search — FTS5 reads use adapter.executeAll, vector uses vecDb.knn
const results = await componentSearch(query, vecDb, adapter, embedder, 10);

// Cleanup
await adapter.close();
```

---

### State 6: `component-define`

**StoreAdapter impact: LOW.** This is a thin wrapper in `entrypoint/agent-mcp/src/tools/authoring.ts`
that calls `enrichComponent()` from `@adhd/agent-store-prompts`. It passes through the vector
backend and registry adapter that were created earlier. The only change is passing the
`registryAdapter` parameter to `enrichComponent()`.

```typescript
// In component-define's handler:
export async function handleComponentDefine(input: ComponentDefineInput) {
  // ... validation ...
  const result = await enrichComponent(
    embedder,
    vecDb,
    registryAdapter,  // NEW — passed through
    { rowid, content: input.content, name: input.name, type: input.type },
  );
  return { ...result, name: input.name };  // name-keyed response
}
```

The `component_delete` companion tool also needs `registryAdapter` to drop FTS5 entries and
use-case links transactionally.

---

### State 7: `agent-define`

**StoreAdapter impact: MEDIUM.** The `agent_define` tool writes across registry agent,
composition, tool-grant, and policy-attach stores. This must be atomic — all writes commit
or roll back. The `StoreAdapter.transaction(fn, {mode:'immediate'})` CAS pattern replaces
raw `db.transaction()`.

```typescript
// BEFORE (original plan — sync better-sqlite3)
db.transaction(() => {
  db.prepare('INSERT OR REPLACE INTO agents ...').run(...);
  db.prepare('DELETE FROM compositions WHERE agent_slug = ?').run(slug);
  db.prepare('INSERT INTO compositions ...').run(...);
}).immediate()();

// AFTER (StoreAdapter edition — async, explicit mode)
await registryAdapter.transaction(async (tx) => {
  // Resolve all referenced names BEFORE any writes (fail-fast)
  for (const comp of input.components) {
    const exists = await tx.executeGet<{slug: string}>(
      'SELECT slug FROM registry_components WHERE slug = ?', [toSlug(comp)],
    );
    if (!exists) throw new ComponentNotFoundError(comp);
  }
  // ... tool, policy, model resolution similarly ...

  // Write agent record
  await tx.executeRun(
    'INSERT OR REPLACE INTO agents (slug, model, ...) VALUES (?, ?, ...)',
    [slug, input.model, ...],
  );
  // Full-replace compositions
  await tx.executeRun('DELETE FROM compositions WHERE agent_slug = ?', [slug]);
  for (const comp of input.components) {
    await tx.executeRun(
      'INSERT INTO compositions (agent_slug, component_slug, position) VALUES (?, ?, ?)',
      [slug, toSlug(comp), input.components.indexOf(comp)],
    );
  }
  // ... tool grants, policy attaches ...
}, { mode: 'immediate' });
```

**Transaction mode: `'immediate'`** is critical. Without it, two concurrent `agent_define` calls
could read the same state, both decide to bump the version, and one overwrites the other. CAS
(`BEGIN IMMEDIATE`) acquires a RESERVED lock before the first read, preventing TOCTOU.

---

### States 8–13: `compat-shim` through `audit-final`

**StoreAdapter impact: NONE.** These states either modify agent-mcp's existing tool files
(compat-shim, versioning), run MCP-wire tests (e2e states), or perform audit reads
(code-review, audit-final). No database code is added or changed in these states.

---

## Independent segments (updated for StoreAdapter)

The original plan's sequencing is preserved. Only the implementation details change within
the states.

### Segment A: Embedding substrate (with StoreAdapter)

- **Files:** `packages/agent/agent-store-prompts/src/enrich/embedding.ts`,
  `packages/agent/agent-store-prompts/src/enrich/usecase-anchors.ts`,
  `packages/agent/agent-store-prompts/src/enrich/cosine.ts`,
  `packages/agent/agent-store-prompts/package.json`
- **Dependencies:** `@adhd/sox-embedding-provider`, `@adhd/sox-vector-store`, `@adhd/sox-store-adapter`
- **Output tokens:** ~400 (was ~300 — adds adapter creation)
- **Key change:** `openVectorStore()` now takes `{adapter}` instead of path. New `createVectorDbAdapter()` function.

### Segment B: Enrichment pipeline (with StoreAdapter)

- **Files:** `packages/agent/agent-store-prompts/src/enrich/enrich-component.ts`,
  `packages/agent/agent-store-prompts/src/enrich/summarize.ts`
- **Dependencies:** Segment A
- **Output tokens:** ~350 (was ~250 — adds adapter parameter + transaction mode)
- **Key change:** `registryAdapter` parameter for CAS transaction writes.

### Segment C: Discovery tools (with StoreAdapter)

- **Files:** `entrypoint/agent-mcp/src/tools/discovery.ts`,
  `entrypoint/agent-mcp/src/server.ts`
- **Dependencies:** Segments A, B, `name-slug-seam`
- **Output tokens:** ~600 (was ~450 — adds FTS5 creation + adapter-based hybrid search)
- **Key change:** FTS5 virtual table created via `adapter.exec()`. Hybrid search uses `adapter.executeAll()` for text channel.

### Segment D: Authoring tools (with StoreAdapter)

- **Files:** `entrypoint/agent-mcp/src/tools/authoring.ts`,
  `entrypoint/agent-mcp/src/registry/composition-writer.ts`
- **Dependencies:** Segment C
- **Output tokens:** ~500 (was ~400 — adds transaction mode for agent_define CAS)
- **Key change:** `registryAdapter.transaction(fn, {mode:'immediate'})` for atomic upserts.

---

## Execution strategies

### Segment A — Embedding substrate

1. Read `packages/agent/agent-store-prompts/package.json` to see existing deps.
2. Add `"@adhd/sox-store-adapter": "^0.1.0"` to `dependencies`.
3. Create `src/enrich/embedding.ts`:
   - Export `createRegistryEmbedder()` (async, unchanged from original plan).
   - **NEW:** Export `createVectorDbAdapter(dbPath)` — creates `SqliteAdapter` (Phase 1).
   - Document: Phase 2 upgrade is a one-line change: `createSqliteAdapter` → `createTursoAdapter`.
4. Create `src/enrich/usecase-anchors.ts`:
   - **MODIFIED:** `seedAnchors(embedder, vecDb)` now takes `VectorBackend` (not creates it).
   - **NEW:** `bootstrapVectorStore(dbPath)` — combines adapter + vector store + anchor seeding.
   - `UseCaseAnchor` interface unchanged.
5. Create `src/enrich/cosine.ts` — unchanged pure function.
6. Update `src/index.ts` to export new functions.
7. Gate: `npx nx test agent-store-prompts --testFile=packages/agent/agent-store-prompts/src/__tests__/embedding-substrate.test.ts`

### Segment B — Enrichment pipeline

1. Read the existing `src/enrich/enrich-component.ts` skeleton.
2. **MODIFIED signature:** Add `registryAdapter: StoreAdapter` parameter.
3. Use `registryAdapter.transaction(fn, { mode: 'immediate' })` for CAS link writes.
4. Use `ingest().contentHash` for idempotence gate (unchanged).
5. `vecDb.knn()` and `embedder.embedSingle()` calls unchanged — same API.
6. Gate: `npx nx test agent-store-prompts --testFile=packages/agent/agent-store-prompts/src/__tests__/enrichment-pipeline.test.ts`

### Segment C — Discovery tools

1. Read `entrypoint/agent-mcp/src/server.ts` to understand tool registration.
2. Create `entrypoint/agent-mcp/src/tools/discovery.ts`:
   - **NEW:** FTS5 bootstrap function: `createComponentFts(adapter: StoreAdapter): Promise<void>`.
   - **NEW:** `componentSearch(query, vecDb, adapter, embedder, limit)` — hybrid fusion.
   - Implement other 10 read tools routing through `registry-bridge` (unchanged from original plan except they now receive `StoreAdapter` for the registry DB connection).
3. Register all 11 tools in `server.ts` OUTSIDE the 11-tool delegation surface (unchanged).
4. Gate: `npx nx test agent-mcp --testFile=entrypoint/agent-mcp/src/__tests__/discovery-tools.test.ts`

### Segment D — Authoring tools

1. Create `entrypoint/agent-mcp/src/tools/authoring.ts`:
   - `component_define` handler: validate → call `enrichComponent(embedder, vecDb, registryAdapter, ...)`.
   - `agent_define` handler: validate → resolve names → `registryAdapter.transaction(fn, {mode:'immediate'})`.
2. Register in `server.ts` OUTSIDE delegation surface.
3. Gate: `npx nx test agent-mcp --testFile=entrypoint/agent-mcp/src/__tests__/component-define.test.ts`

---

## Two-phase Drizzle migration (for registry stores)

The existing registry stores (`component-store.ts`, `agent-store.ts`, etc.) use
`BetterSQLite3Database<any>` from `drizzle-orm/better-sqlite3`. Plan 8 does NOT migrate
these stores — they remain on drizzle-orm/better-sqlite3 throughout. The plan's new code
(pipeline, discovery, authoring) uses raw SQL via `adapter.execute*()` for the new operations
it introduces (FTS5, enrichment links, composition writes). This avoids coupling the plan to
drizzle's import path entirely.

If a future plan migrates the registry stores to `drizzle-orm/tursodatabase/database`, the
two-phase path is:

- **Phase 1 (now):** New code uses `adapter.execute*()` directly. Existing stores keep
  `drizzle-orm/better-sqlite3`.
- **Phase 2 (future):** Migration plan switches `openRegistryDb()` to return `StoreAdapter`,
  unwraps via `(adapter as SqliteAdapter).unwrap()` for drizzle construction, and later
  swaps to `drizzle-orm/tursodatabase/database` with `drizzle({ client })`.

---

## What does NOT change

### Existing registry DB connection

`@adhd/agent-core-env`'s `openRegistryDb()` still returns `better-sqlite3.Database`. Plan 8
does not migrate it. The plan adds a NEW `StoreAdapter` for vector operations (opened in
`embedding-substrate`) and a NEW adapter for FTS5 (opened in `discovery-tools`). These are
independent adapter instances — they share the same database file via WAL mode.

### Drizzle stores

`ComponentStore`, `AgentStore`, `UseCaseStore`, etc. still accept `BetterSQLite3Database<any>`.
Plan 8 does not change their constructors. The bridge (`registry-bridge.ts`) wraps them as-is.

### MCP wire protocol

All tool schemas, input/output shapes, and the `name`-only wire invariant (`[inv:no-slug-on-wire]`)
are unchanged. `StoreAdapter` is an internal implementation detail — it never leaks to the MCP
surface.

### Test isolation

Tests create `createSqliteAdapter({ dbPath: ':memory:' })` for isolated in-memory databases.
This is functionally identical to `new Database(':memory:')` but goes through the adapter
interface. The `adapter.close()` call replaces `db.close()`.

---

## Capability checkpoints

Check `adapter.capabilities` at key decision points rather than hardcoding backend-specific
behavior:

```typescript
// Bootstrap: select vector dialect based on capabilities
const vecDb = openVectorStore({ adapter, dim: 768, modelId: 'bge-base-en-v1.5' });
// vector-store internally does:
// const dialect = adapter.capabilities.nativeVectors ? new TursoVectorDialect() : new SqliteVecDialect();

// Log capabilities for diagnostics (optional)
if (adapter.capabilities.multiprocessWrite) {
  console.log('Multi-process writers enabled (multiprocess_wal)');
}
if (adapter.capabilities.concurrentTransactions) {
  console.log('MVCC concurrent transactions available');
}
```

---

## Test cases (updated for StoreAdapter)

### Unit tests (embedding-substrate)

- `createVectorDbAdapter(':memory:')` → returns `StoreAdapter` with `capabilities.nativeVectors === false`
- `openVectorStore({adapter, dim:768, modelId:'bge-base-en-v1.5'})` → returns `VectorBackend`
- `bootstrapVectorStore(':memory:')` → returns `{adapter, vecDb, anchors}` with anchors persisted
- Re-running `bootstrapVectorStore` on same adapter → seed is idempotent (no duplicates)
- `vecDb.knn()` on Turso native vectors → same ordering as sqlite-vec (cross-backend parity)

### Integration tests (enrichment-pipeline)

- `enrichComponent(embedder, vecDb, registryAdapter, params)` with CAS `{mode:'immediate'}` →
  idempotent on identical content (second call returns `changed: false`)
- Two concurrent `enrichComponent` calls with `mode:'immediate'` → second waits, no lost writes
- `enrichComponent` with `mode:'deferred'` (no CAS) → TOCTOU possible (demonstrated for negative control)

### Integration tests (discovery-tools)

- `componentSearch()` hybrid fusion → FTS5 textScore + vector vecScore combined via `fuse()`
- `componentSearch()` with text-only query → degrades to FTS5-only
- `componentSearch()` with vector-only query → degrades to vector-only
- nDCG@5 ≥ 0.70 over hard-negative corpus (unchanged bar from original plan)

### End-to-end tests

- Full SPEC §7 journey over MCP wire — `createStoreAdapter` never leaks to the wire surface
- TursoAdapter smoke test: `STORE_ADAPTER=turso` → vector operations work with native vectors
- SqliteAdapter smoke test: `STORE_ADAPTER=sqlite` → vector operations work with sqlite-vec

---

## Appendix A: Phase 1 → Phase 2 upgrade path

Plan 8 starts with `SqliteAdapter` (Phase 1 — backward compatible). The upgrade to
`TursoAdapter` (Phase 2 — native vectors, multiprocess_wal, async I/O) is a single
configuration change at the adapter creation site:

```typescript
// Phase 1 (current)
import { createSqliteAdapter } from '@adhd/sox-store-adapter';
const adapter = createSqliteAdapter({ dbPath });

// Phase 2 (future — one-line change)
import { createTursoAdapter } from '@adhd/sox-store-adapter';
const adapter = await createTursoAdapter({
  dbPath,
  experimental: { multiprocessWal: true },
});
```

No other code changes. The `VectorBackend` interface is identical. The `StoreAdapter` interface
is identical. The `fuse()`/`normalize()` functions are pure and unchanged. The only runtime
difference is `adapter.capabilities.nativeVectors === true`, which `openVectorStore()` uses
to auto-select `TursoVectorDialect`.

**Vector data migration** from `vec0` (sqlite-vec) to native `vector(N)` (Turso) is a one-time
operation handled by vector-store's migration utilities — not by ADHD code. The migration script
re-indexes all vectors when capabilities switch from `nativeVectors:false` to `nativeVectors:true`.

## Appendix B: Dependency graph (updated)

```
@adhd/sox-store-adapter (new dep)
    │
    ├── @adhd/sox-vector-store (adapted — takes StoreAdapter)
    │       │
    │       ├── embedding-substrate (creates adapter, opens vector store)
    │       │       │
    │       │       └── enrichment-pipeline (receives adapted vec store + registry adapter)
    │       │               │
    │       │               └── component-define (thin wrapper)
    │       │                       │
    │       │                       └── agent-define (CAS transaction writes)
    │       │
    │       └── discovery-tools (FTS5 + vector hybrid search)
    │
    ├── @adhd/sox-graph-store (adapted — takes StoreAdapter, transitive only)
    ├── @adhd/sox-hybrid-search (pure fusion — no adapter change)
    ├── @adhd/sox-embedding-provider (unchanged — no SQLite)
    └── @adhd/sox-ingest/core (unchanged — no SQLite)
```

## Appendix C: Token estimates

| Segment | Read tokens | Output tokens | States covered |
|---|---|---|---|
| A — Embedding substrate | ~500 | ~400 | `embedding-substrate` |
| B — Enrichment pipeline | ~400 | ~350 | `enrichment-pipeline` |
| C — Discovery tools | ~500 | ~600 | `name-slug-seam`, `discovery-tools` |
| D — Authoring tools | ~400 | ~500 | `component-define`, `agent-define` |
| E — Compat + versioning | ~300 | ~250 | `compat-shim`, `versioning` |
| F — E2E tests | ~400 | ~500 | `composition-journey-e2e`, `live-model-e2e` |
| G — Audit | ~200 | ~200 | `code-review`, `audit-final` |
| **Total (ADHD only)** | **~2700** | **~2800** | All 13 states |

---

## Appendix D: Optimized Execution Plan

> **Status:** Generated 2026-07-27 after live codebase investigation.  
> **Two-repo scope:** sox-ecosystem (producer of `@adhd/sox-*` packages) + adhd (consumer for Plan 8 states).  
> **Dispatch format:** packetized waves, disjoint file sets per agent, token budgets 300–800 instruction tokens.

### D.1 Actual readiness assessment (vs. spec assumption)

The spec §1 states "sox package internals are already done." A live investigation reveals this is **partially true** — the map of what's ready:

| Package | Status | Needs work? |
|---------|--------|-------------|
| `@adhd/sox-store-adapter` | **Exists** in worktree `store-adapter-a` (`libs/data/store/store-adapter/`). Built `dist/` present. Not yet merged to main. | **Merge + publish.** No API changes needed. |
| `@adhd/sox-vector-store` | **NOT adapted.** `src/index.ts` still exports `openVectorStore(path, {dim, modelId})` with `better-sqlite3.Database` internally. | **Adapt to accept `StoreAdapter`.** Change signature to `openVectorStore({adapter, dim, modelId, dialect?})`. |
| `@adhd/sox-graph-store` | Published 0.3.0, not consumed by Plan 8 directly. Transitive dependency of hybrid-search only. | Verify build. **No change unless** vector-store's `buildNodeFilterClause` import fails. |
| `@adhd/sox-hybrid-search` | Pure fusion functions (`fuse()`, `normalize()`). No `better-sqlite3` dependency. | **No change.** |
| `@adhd/sox-embedding-provider` | No SQLite dependency. Published 0.1.0 (in sox-ecosystem at `libs/data/embed/embedding-provider/`). | **No change.** |
| `@adhd/sox-ingest` | No SQLite dependency. `ingest()` + `ingest/core` subpath. | **No change.** |

**The spec's Segment assumption is wrong in a critical way:** the implementation spec treats the vector-store as already-adapted, but the actual `openVectorStore()` still takes `path: string`. Before any ADHD Plan 8 code can be written, `@adhd/sox-vector-store` must accept `StoreAdapter`.

This is biting because the vector-store is the **foundation** of 4 out of 5 affected Plan 8 states. The execution plan below accounts for this as a prerequisite wave.

### D.2 Master dependency graph

```
sox-ecosystem                                      adhd project
══════════════                                      ════════════

                     ┌─────────────────────────┐
                     │ P0: store-adapter merge  │
                     │ P1: vector-store adapt   │
                     │ P2: verify sox pkg deps  │
                     └──────────┬──────────────┘
                                │  publish
                                ▼
                   ┌──────────────────────────┐
                   │  pnpm add @adhd/sox-*    │  (done once, not a packet)
                   └──────────────────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                  ▼
   ┌──────────────────┐  ┌──────────────┐  ┌──────────────┐
   │ Wave 1: Embedding│  │ Wave 5A:     │  │ Wave 5B:     │
   │ Substrate (A)    │  │ compat-shim  │  │ versioning   │
   └───────┬──────────┘  └──────────────┘  └──────────────┘
           │              (no deps, parallel W1+W5A+W5B)
           ▼
   ┌──────────────────┐  ┌──────────────────┐
   │ Wave 2: Pipeline │  │ Wave 3: Discovery│
   │ (B)              │  │ (C + name-slug)  │
   └───────┬──────────┘  └───────┬──────────┘
           │                     │
           └──────────┬──────────┘
                      ▼
              ┌──────────────────┐
              │ Wave 4: Authoring│
              │ (D)              │
              └───────┬──────────┘
                      ▼
              ┌──────────────────┐  ┌──────────────────┐
              │ Wave 5C: E2E    │  │ Wave 6: Review   │
              │ (states 9-10)   │  │ (states 12-13)   │
              └──────────────────┘  └──────────────────┘
```

### D.3 Pre-Wave: sox-ecosystem package prerequisites

These run in the **sox-ecosystem worktree**. All 3 packets are serial (same repo, same project graph).

#### P0: Merge store-adapter branch & publish

| Field | Value |
|-------|-------|
| **Scope** | sox-ecosystem, worktree `store-adapter-a` |
| **Branch** | `feat/store-adapter-a` → `main` |
| **Files** | `libs/data/store/store-adapter/src/{index,factory,sqlite-adapter,turso-adapter,mock-adapter,types,errors}.ts`, `package.json`, `project.json`, `test/contract.test.ts` |
| **Instructions** | Review existing store-adapter package. Run `npx nx build store-adapter && npx nx test store-adapter && npx nx lint store-adapter`. Confirm `AdapterCapabilities` includes `nativeVectors`, `multiprocessWrite`, `concurrentTransactions`. Merge to `main`. Publish `@adhd/sox-store-adapter@0.1.0`. |
| **Instruction tokens** | ~400 |
| **Dependencies** | None |
| **Gate** | `npx nx run-many -t build,test,lint --projects store-adapter` |

#### P1: Adapt vector-store to StoreAdapter

| Field | Value |
|-------|-------|
| **Scope** | sox-ecosystem |
| **Files** | `libs/data/vectors/vector-store/src/index.ts` (MODIFY — `openVectorStore` signature, `SqliteVectorBackend` constructor), `libs/data/vectors/vector-store/package.json` (MODIFY — add `@adhd/sox-store-adapter` dep) |
| **Instructions** | Change `openVectorStore(path, {dim, modelId})` to `openVectorStore({adapter, dim, modelId, dialect?})`. Constructor takes `StoreAdapter` instead of `better-sqlite3.Database`. Internally use `adapter.pragmaSet()`, `adapter.executeRun()`, etc. Add `VectorDialect` auto-selection via `adapter.capabilities.nativeVectors`. Build, lint, test. |
| **Instruction tokens** | ~700 |
| **Dependencies** | P0 (store-adapter must be merged) |
| **Gate** | `npx nx run-many -t build,test,lint --projects vector-store` |

#### P2: Verify transitive sox package readiness

| Field | Value |
|-------|-------|
| **Scope** | sox-ecosystem |
| **Files** | None modified. Read-only verification of `libs/data/search/hybrid-search/src/index.ts`, `libs/data/embed/embedding-provider/src/index.ts`, `libs/data/ingest/ingest/src/index.ts`, `libs/data/graph/graph-store/src/index.ts`. |
| **Instructions** | Confirm `@adhd/sox-hybrid-search` `fuse()`/`normalize()` signatures match spec §5.2. Confirm `@adhd/sox-embedding-provider` `createEmbeddingProvider()` signature matches spec §5.4. Confirm `@adhd/sox-ingest` `ingest()` signature matches spec §5.5. For each, `npx nx build <pkg> && npx nx test <pkg>`. If any fail, file a bug — do not proceed. |
| **Instruction tokens** | ~300 |
| **Dependencies** | None (independent of P0/P1) |
| **Gate** | `npx nx run-many -t build,test,lint --projects hybrid-search,embedding-provider,ingest,graph-store` |

---

### D.4 Wave 1: Embedding Substrate (ADHD — Segment A)

**Context:** The `enrich/` directory does not yet exist. All 4 packets create new files or modify package metadata. Files are **disjoint** — all 4 packets can execute in parallel.

#### 1A: Core embedding files

| Field | Value |
|-------|-------|
| **Files** | `packages/agent/agent-store-prompts/src/enrich/embedding.ts` (NEW), `packages/agent/agent-store-prompts/src/enrich/cosine.ts` (NEW) |
| **Instructions** | Create `embedding.ts`: export `createRegistryEmbedder(config?)` (async, wraps `@adhd/sox-embedding-provider`'s `createEmbeddingProvider`), export `createVectorDbAdapter(dbPath)` (wraps `@adhd/sox-store-adapter`'s `createSqliteAdapter` for Phase 1). Create `cosine.ts`: export pure `cosineSimilarity(a, b)` function. |
| **Instruction tokens** | ~350 |
| **Dependencies** | P1 (vector-store adapted), P2 (embedding-provider verified) |
| **Disjoint from** | 1B ✓, 1C ✓, 1T ✓ |
| **Gate** | `npx nx lint agent-store-prompts` |

#### 1B: Use-case anchors

| Field | Value |
|-------|-------|
| **Files** | `packages/agent/agent-store-prompts/src/enrich/usecase-anchors.ts` (NEW) |
| **Instructions** | Create file: export `UseCaseAnchor` type, `seedAnchors(embedder, vecDb)` (async, seeded via `vecDb.knn()` dedup), `bootstrapVectorStore(dbPath)` (async, calls `createVectorDbAdapter` + `openVectorStore` + `seedAnchors`). Import `openVectorStore` from `@adhd/sox-vector-store`. |
| **Instruction tokens** | ~400 |
| **Dependencies** | P1 (vector-store adapted), 1A (uses `createVectorDbAdapter` — **logical dependency only, file is disjoint**) |
| **Disjoint from** | 1A ✓, 1C ✓, 1T ✓ |
| **Gate** | `npx nx lint agent-store-prompts` |

#### 1C: Package wiring

| Field | Value |
|-------|-------|
| **Files** | `packages/agent/agent-store-prompts/package.json` (MODIFY — add deps), `packages/agent/agent-store-prompts/src/index.ts` (MODIFY — add exports) |
| **Instructions** | Add `"@adhd/sox-store-adapter": "^0.1.0"`, `"@adhd/sox-vector-store": "^0.1.0"`, `"@adhd/sox-embedding-provider": "^0.1.0"` to `dependencies` in `package.json`. Add exports for `createRegistryEmbedder`, `createVectorDbAdapter`, `bootstrapVectorStore`, `seedAnchors`, `UseCaseAnchor`, `cosineSimilarity` to `src/index.ts`. |
| **Instruction tokens** | ~300 |
| **Dependencies** | P0, P1 (packages must be published/available) |
| **Disjoint from** | 1A ✓, 1B ✓, 1T ✓ |
| **Gate** | `npx pnpm install && npx nx lint agent-store-prompts` |

#### 1T: Embedding substrate tests

| Field | Value |
|-------|-------|
| **Files** | `packages/agent/agent-store-prompts/src/__tests__/embedding-substrate.test.ts` (NEW) |
| **Instructions** | Create test file covering: `createVectorDbAdapter(':memory:')` returns `StoreAdapter` with `nativeVectors === false`, `openVectorStore({adapter})` returns `VectorBackend`, `bootstrapVectorStore(':memory:')` returns `{adapter, vecDb, anchors}` with persisted anchors, re-running on same adapter is idempotent. Use `createSqliteAdapter({dbPath: ':memory:'})` for test isolation. Cleanup with `afterAll(async () => adapter.close())`. |
| **Instruction tokens** | ~400 |
| **Dependencies** | 1A, 1B, 1C (logical — test file is disjoint file) |
| **Disjoint from** | 1A ✓, 1B ✓, 1C ✓ |
| **Gate** | `npx nx test agent-store-prompts` (runs after all 3 source packets complete) |

> **Wave 1 serial gate** (run AFTER 1A+1B+1C+1T all report done):  
> `npx pnpm install && npx nx run-many -t build,test,lint --projects agent-store-prompts`

---

### D.5 Wave 2: Enrichment Pipeline (ADHD — Segment B)

**Context:** Receives `VectorBackend` + `StoreAdapter` from Wave 1 as constructor-injected dependencies. All 3 packets create new files — **disjoint**.

#### 2A: Core enrichment function

| Field | Value |
|-------|-------|
| **Files** | `packages/agent/agent-store-prompts/src/enrich/enrich-component.ts` (NEW) |
| **Instructions** | Create file: export `enrichComponent(embedder, vecDb, registryAdapter, params)` with CAS transaction pattern (`registryAdapter.transaction(fn, {mode:'immediate'})`). Use `ingest(params.content)` for content-hash idempotence. Write `ComponentUsageRow` links transactionally. `vecDb.knn()` and `embedder.embedSingle()` calls unchanged. |
| **Instruction tokens** | ~450 |
| **Dependencies** | Wave 1 complete (needs `VectorBackend` type + `StoreAdapter` type) |
| **Disjoint from** | 2B ✓, 2T ✓ |
| **Gate** | `npx nx lint agent-store-prompts` |

#### 2B: Summarization helper

| Field | Value |
|-------|-------|
| **Files** | `packages/agent/agent-store-prompts/src/enrich/summarize.ts` (NEW) |
| **Instructions** | Create file: export `summarizeComponent(content, {maxSentences?})` — uses `@adhd/sox-ingest/core`'s `ingest()` internally for extractive summary. Pure function, no DB. |
| **Instruction tokens** | ~250 |
| **Dependencies** | P2 (ingest verified) |
| **Disjoint from** | 2A ✓, 2T ✓ |
| **Gate** | `npx nx lint agent-store-prompts` |

#### 2T: Enrichment pipeline tests

| Field | Value |
|-------|-------|
| **Files** | `packages/agent/agent-store-prompts/src/__tests__/enrichment-pipeline.test.ts` (NEW) |
| **Instructions** | Create test file covering: `enrichComponent()` with CAS `{mode:'immediate'}` is idempotent on identical content (second call returns `changed: false`). Two concurrent calls with `mode:'immediate'` — second waits, no lost writes. Verify `mode:'deferred'` as negative control (TOCTOU possible). |
| **Instruction tokens** | ~350 |
| **Dependencies** | 2A, 2B (logical — test file is disjoint) |
| **Disjoint from** | 2A ✓, 2B ✓ |
| **Gate** | `npx nx test agent-store-prompts` |

> **Wave 2 serial gate** (run AFTER 2A+2B+2T all report done):  
> `npx nx run-many -t build,test,lint --projects agent-store-prompts`

---

### D.6 Wave 3: Discovery Tools (ADHD — Segment C + name-slug-seam)

**Context:** 4 disjoint file packets. **Can run in parallel with Wave 2** (different nx projects: agent-store-prompts vs agent-mcp).

#### 3A: Name-slug-seam

| Field | Value |
|-------|-------|
| **Files** | `packages/agent/agent-store-prompts/src/name-slug/to-slug.ts` (NEW), `packages/agent/agent-store-prompts/src/name-slug/registry-bridge.ts` (NEW) |
| **Instructions** | Create `to-slug.ts`: export `toSlug(name)` — lowercase, replace non-alphanumeric with `-`, collapse repeated hyphens, trim. Create `registry-bridge.ts`: wraps existing `ComponentStore`, `UseCaseStore`, `AgentStore` methods into slug-keyed bridge functions. Pure translation — no DB. |
| **Instruction tokens** | ~300 |
| **Dependencies** | Wave 1 (needs store types) |
| **Disjoint from** | 3B ✓, 3C ✓, 3T ✓ |
| **Gate** | `npx nx lint agent-store-prompts` |

#### 3B: Discovery tools — complete file

| Field | Value |
|-------|-------|
| **Files** | `entrypoint/agent-mcp/src/tools/discovery.ts` (NEW — entire file) |
| **Instructions** | Create file: (1) `createComponentFts(adapter)` — FTS5 table bootstrap with INSERT/UPDATE/DELETE triggers against `registry_component_versions`. (2) `componentSearch(query, vecDb, adapter, embedder, limit)` — FTS5 BM25 for text channel via `adapter.executeAll()`, `vecDb.knn()` for vector channel, `fuse()`/`normalize()` for hybrid fusion. (3) 10 other read tools routing through registry-bridge (list components, read component, list agents, read agent, list use cases, read use case, list composed prompts, list prompt types, search use cases, list contexts). |
| **Instruction tokens** | ~750 |
| **Dependencies** | Wave 1 (needs `VectorBackend` + `StoreAdapter` types), 3A (needs `registry-bridge.ts`) |
| **Disjoint from** | 3A ✓, 3C ✓, 3T ✓ |
| **Gate** | `npx nx lint agent-mcp` |

#### 3C: Server.ts — tool registration

| Field | Value |
|-------|-------|
| **Files** | `entrypoint/agent-mcp/src/server.ts` (MODIFY) |
| **Instructions** | Add discovery tool handlers (11 tools) to `CallToolRequestSchema` switch. Add tool descriptors to `ListToolsRequestSchema`. Wire `componentSearch` dependencies through `ServerDeps` (add `vecDb`, `registryAdapter`, `embedder` to `ServerDeps` interface). |
| **Instruction tokens** | ~500 |
| **Dependencies** | 3B (needs the tool handler functions to import) |
| **Disjoint from** | 3A ✓, 3T ✓ |
| **Gate** | `npx nx lint agent-mcp` |

#### 3T: Discovery tests

| Field | Value |
|-------|-------|
| **Files** | `entrypoint/agent-mcp/src/__tests__/discovery-tools.test.ts` (NEW) |
| **Instructions** | Create test file covering: `componentSearch()` hybrid fusion returns scored results, `componentSearch()` with text-only query degrades to FTS5-only, vector-only query degrades to vector-only. FTS5 create/trigger bootstrap idempotence. All 10 pure-read tools return expected shapes. |
| **Instruction tokens** | ~400 |
| **Dependencies** | 3B, 3C (logical — test file is disjoint) |
| **Disjoint from** | 3A ✓, 3B ✓, 3C ✓ |
| **Gate** | `npx nx test agent-mcp` |

> **Wave 3 serial gate** (run AFTER all 4 packets report done):  
> `npx nx run-many -t build,test,lint --projects agent-mcp`

#### Code Review Gate: After Wave 3

After Wave 3 completes, run a **mandatory code review packet** before authoring tools begin. The discovery kit is the highest-risk surface (hybrid search fusion, FTS5 schema, 11-tool registration surface).

| Field | Value |
|-------|-------|
| **Packet** | **CR-3 — Discovery tools code review** |
| **Files** | READ-ONLY: `discovery.ts`, `server.ts`, `to-slug.ts`, `registry-bridge.ts`, `discovery-tools.test.ts` |
| **Instructions** | Review for: (1) `adapter.close()` is never called inside a tool handler (adapter lifecycle owned by bootstrap, not per-request). (2) `fuse()` input shapes match `executeAll` + `knn` output shapes. (3) FTS5 triggers reference correct column names against registry schema. (4) No `store-adapter` violation — adapter unwrap not used. (5) All tool descriptors have unique names. If issues found, file backlog items. Proceed to Wave 4 only on PASS. |
| **Instruction tokens** | ~500 |
| **Dependencies** | Wave 3 complete |
| **Gate** | n/a (read-only, no gate command) |

---

### D.7 Wave 4: Authoring Tools (ADHD — Segment D)

**Context:** Thin wrapper layer above Wave 2 + Wave 3. 3 disjoint file packets.

#### 4A: Authoring tool handlers

| Field | Value |
|-------|-------|
| **Files** | `entrypoint/agent-mcp/src/tools/authoring.ts` (NEW) |
| **Instructions** | Create file: `component_define` handler — validates input, calls `enrichComponent(embedder, vecDb, registryAdapter, {rowid, content, name, type})`, returns result. `component_delete` handler — drops FTS5 entries + use-case links transactionally. `agent_define` handler — validates all component/ref names fail-fast, then `registryAdapter.transaction(fn, {mode:'immediate'})` for atomic upsert of agent record, compositions, tool grants, policy attaches. `agent_define` uses the `/full-replace composition` pattern. |
| **Instruction tokens** | ~650 |
| **Dependencies** | Wave 2 (needs `enrichComponent`), Wave 3 (needs server registration pattern) |
| **Disjoint from** | 4B ✓, 4T ✓ |
| **Gate** | `npx nx lint agent-mcp` |

#### 4B: Composition writer

| Field | Value |
|-------|-------|
| **Files** | `entrypoint/agent-mcp/src/registry/composition-writer.ts` (NEW — create parent dir if absent) |
| **Instructions** | Create file: export `CompositionWriter` — CAS record for agent↔component links. `writeComposition(tx, agentSlug, components[])` — deletes existing and inserts new positions. Called from within `agent_define`'s transaction callback. Uses `tx.executeRun()`, NOT `adapter.transaction()` — the tx is already open. |
| **Instruction tokens** | ~350 |
| **Dependencies** | Wave 2 (needs store types), 4A (needs the function signature for `writeComposition`) |
| **Disjoint from** | 4A ✓, 4T ✓ |
| **Gate** | `npx nx lint agent-mcp` |

#### 4T: Authoring tests

| Field | Value |
|-------|-------|
| **Files** | `entrypoint/agent-mcp/src/__tests__/component-define.test.ts` (NEW) |
| **Instructions** | Create test file covering: `component_define` passes `registryAdapter` to `enrichComponent`. `component_delete` drops FTS5 + use-case links atomically. `agent_define` transaction rollback on validation failure (no partial writes). CAS `{mode:'immediate'}` prevents TOCTOU between concurrent writes. |
| **Instruction tokens** | ~350 |
| **Dependencies** | 4A, 4B (logical — test file is disjoint) |
| **Disjoint from** | 4A ✓, 4B ✓ |
| **Gate** | `npx nx test agent-mcp` |

> **Wave 4 serial gate** (run AFTER all 3 packets report done):  
> `npx nx run-many -t build,test,lint --projects agent-mcp`

---

### D.8 Wave 5: Compat + Versioning + E2E (ADHD — Segments E + F)

**Context:** 3 completely independent packets — **all parallel**.

#### 5A: Compat shim

| Field | Value |
|-------|-------|
| **Files** | `entrypoint/agent-mcp/src/compat-shim.ts` (NEW) |
| **Instructions** | Create backward-compat shim for existing tool consumers: maps old tool names → new tool names (if any), adds deprecation warnings. No DB code. |
| **Instruction tokens** | ~300 |
| **Dependencies** | Wave 4 (tool names finalized) |
| **Disjoint from** | 5B ✓, 5C ✓ |
| **Gate** | `npx nx lint agent-mcp` |

#### 5B: Versioning

| Field | Value |
|-------|-------|
| **Files** | `CHANGELOG.md` (MODIFY), `packages/agent/agent-store-prompts/package.json` (bump), `entrypoint/agent-mcp/package.json` (bump) |
| **Instructions** | Write CHANGELOG entries: "### StoreAdapter migration" section — `createVectorDbAdapter()`, `bootstrapVectorStore()`, `enrichComponent(registryAdapter)`, `componentSearch()` hybrid search, FTS5 bootstrap, `agent_define` CAS transaction. Bump both packages to next minor version. |
| **Instruction tokens** | ~350 |
| **Dependencies** | All source waves complete |
| **Disjoint from** | 5A ✓, 5C ✓ |
| **Gate** | n/a (changelog only) |

#### 5C: E2E integration tests

| Field | Value |
|-------|-------|
| **Files** | `entrypoint/agent-mcp/src/__tests__/integration/composition-journey.e2e.test.ts` (NEW), `entrypoint/agent-mcp/src/__tests__/integration/live-model.e2e.test.ts` (NEW) |
| **Instructions** | `composition-journey.e2e.test.ts`: Full SPEC §7 journey over MCP wire — create component, discover via `component_search`, compose via `agent_define`, verify `component_search` finds composed agent. Assert `createStoreAdapter` never leaks to wire surface. `live-model.e2e.test.ts`: TursoAdapter smoke test — `STORE_ADAPTER=turso` env var drives `createTursoAdapter()` with native vectors. SqliteAdapter smoke test — `STORE_ADAPTER=sqlite` drives `createSqliteAdapter()` with sqlite-vec. |
| **Instruction tokens** | ~550 |
| **Dependencies** | Waves 1–4 all complete |
| **Disjoint from** | 5A ✓, 5B ✓ |
| **Gate** | `npx nx test agent-mcp` |

> **Wave 5 serial gate** (run AFTER all 3 packets report done):  
> `npx nx run-many -t build,test,lint --projects agent-mcp,agent-store-prompts`

---

### D.9 Wave 6: Code Review + Audit (states 12–13)

**Context:** Read-only review across the whole migration. 2 serial packets.

#### 6A: Cross-state code review

| Field | Value |
|-------|-------|
| **Files** | READ-ONLY: all files touched in Waves 1–4 |
| **Instructions** | Verify: (1) No `better-sqlite3.Database` import exists in any new file. (2) All `StoreAdapter` usage follows the async `executeGet/All/Run` pattern — none uses `.prepare()`. (3) All `transaction()` calls explicitly pass `{mode:'immediate'}` for CAS writes. (4) `adapter.close()` is called in shutdown paths, not per-request. (5) `adapter.capabilities.nativeVectors` is NOT hardcoded — `openVectorStore()` auto-selects dialect. (6) No Drizzle import pollution — new code uses `adapter.execute*()`, not `drizzle-orm`. |
| **Instruction tokens** | ~500 |
| **Dependencies** | Waves 1–5 complete |
| **Gate** | n/a (read-only) |

#### 6B: Final audit + backlog reconciliation

| Field | Value |
|-------|-------|
| **Files** | `docs/ideas/phase-2-agent-mcp-authoring.md` (MODIFY — update status), BACKLOG.md (update — close resolved items) |
| **Instructions** | Update audit doc: mark all 13 plan states as complete with dates. Close any backlog items resolved by this migration. Verify all 5 StoreAdapter-impacted states (embedding-substrate, enrichment-pipeline, discovery-tools, component-define, agent-define) have passing tests. Check `gitnexus_detect_changes()` confirms only expected symbols/flows moved. |
| **Instruction tokens** | ~400 |
| **Dependencies** | 6A |
| **Gate** | `npx nx run-many -t build,test,lint --projects agent-store-prompts,agent-mcp` (final project-gate) |

---

### D.10 Parallelization summary

```
P0 ── P1 ── P2
 │     │     │
 │     │     ├────────────────────────────────────────┐
 │     │     │                                        │
 │     │     │   ┌──── WAVE 1 ────┐   ┌──── WAVE 5 ──┐│
 │     │     │   │ 1A   1B   1C   │   │ 5A   5B      ││
 │     │     │   │     1T         │   │              ││
 │     │     │   └───────┬────────┘   └──────┬───────┘│
 │     │     │           │                   │        │
 │     │     │     ┌─────┴─────┐             │        │
 │     │     │     │           │             │        │
 │     │     │   WAVE 2     WAVE 3           │        │
 │     │     │   2A 2B 2T   3A 3B 3C 3T     │        │
 │     │     │     │           │             │        │
 │     │     │     └─────┬─────┘             │        │
 │     │     │           │                   │        │
 │     │     │     ┌─────┴─────┐             │        │
 │     │     │     │   CR-3    │             │        │
 │     │     │     └─────┬─────┘             │        │
 │     │     │           │                   │        │
 │     │     │     ┌─────┴─────┐             │        │
 │     │     │     │ WAVE 4    │             │        │
 │     │     │     │ 4A 4B 4T  │             │        │
 │     │     │     └─────┬─────┘             │        │
 │     │     │           │                   │        │
 │     │     │     ┌─────┴────────────────────┘       │
 │     │     │     │                                   │
 │     │     │     ├── 5C: E2E tests ──┐               │
 │     │     │     │                   │               │
 │     │     │     ├── 6A: Code review │               │
 │     │     │     │                   │               │
 │     │     │     ├── 6B: Final audit │               │
 │     │     │     │                   │               │
 │     │     │     ▼                   ▼               │
 │     │     │   ┌─────────────┐                       │
 │     │     │   │   DONE      │                       │
 │     │     │   └─────────────┘                       │
```

### D.11 Packet dispatch table

| Wave | Packet | nx project | Files | Tokens | Parallel with |
|------|--------|------------|-------|--------|---------------|
| Pre | P0 | store-adapter | `libs/data/store/store-adapter/src/*` | ~400 | — |
| Pre | P1 | vector-store | `libs/data/vectors/vector-store/src/index.ts` | ~700 | — (after P0) |
| Pre | P2 | multiple data pkgs | (read-only) | ~300 | P1 |
| W1 | 1A | agent-store-prompts | `src/enrich/embedding.ts`, `cosine.ts` | ~350 | 1B, 1C, 1T |
| W1 | 1B | agent-store-prompts | `src/enrich/usecase-anchors.ts` | ~400 | 1A, 1C, 1T |
| W1 | 1C | agent-store-prompts | `package.json`, `src/index.ts` | ~300 | 1A, 1B, 1T |
| W1 | 1T | agent-store-prompts | `src/__tests__/embedding-substrate.test.ts` | ~400 | 1A, 1B, 1C |
| W2 | 2A | agent-store-prompts | `src/enrich/enrich-component.ts` | ~450 | 2B, 2T, W3 |
| W2 | 2B | agent-store-prompts | `src/enrich/summarize.ts` | ~250 | 2A, 2T, W3 |
| W2 | 2T | agent-store-prompts | `src/__tests__/enrichment-pipeline.test.ts` | ~350 | 2A, 2B, W3 |
| W3 | 3A | agent-store-prompts | `src/name-slug/to-slug.ts`, `registry-bridge.ts` | ~300 | W2, 3B, 3C, 3T |
| W3 | 3B | agent-mcp | `src/tools/discovery.ts` | ~750 | W2, 3A, 3C, 3T |
| W3 | 3C | agent-mcp | `src/server.ts` | ~500 | W2, 3A, 3B, 3T |
| W3 | 3T | agent-mcp | `src/__tests__/discovery-tools.test.ts` | ~400 | W2, 3A, 3B, 3C |
| **CR** | CR-3 | both | (read-only review) | ~500 | — (after W3) |
| W4 | 4A | agent-mcp | `src/tools/authoring.ts` | ~650 | 4B, 4T |
| W4 | 4B | agent-mcp | `src/registry/composition-writer.ts` | ~350 | 4A, 4T |
| W4 | 4T | agent-mcp | `src/__tests__/component-define.test.ts` | ~350 | 4A, 4B |
| W5 | 5A | agent-mcp | `src/compat-shim.ts` | ~300 | 5B, 5C |
| W5 | 5B | both | `CHANGELOG.md`, `package.json` bumps | ~350 | 5A, 5C |
| W5 | 5C | agent-mcp | `src/__tests__/integration/*.e2e.test.ts` | ~550 | 5A, 5B |
| W6 | 6A | both | (read-only review) | ~500 | — (after W5) |
| W6 | 6B | both | audit docs, BACKLOG.md | ~400 | — (after 6A) |

### D.12 Maximally parallel dispatch script

```
=== PARALLEL WAVE 1 (after P0+P1+P2 complete) ===
dispatch agent-1: Packet 1A  (embedding.ts + cosine.ts)
dispatch agent-2: Packet 1B  (usecase-anchors.ts)
dispatch agent-3: Packet 1C  (package.json + index.ts)
dispatch agent-4: Packet 1T  (embedding-substrate.test.ts)
WAIT: all 4 complete
GATE: npx nx run-many -t build,test,lint --projects agent-store-prompts

=== PARALLEL WAVE 2 + WAVE 3 (after W1 gate passes) ===
dispatch agent-5: Packet 2A  (enrich-component.ts)
dispatch agent-6: Packet 2B  (summarize.ts)
dispatch agent-7: Packet 2T  (enrichment-pipeline.test.ts)
dispatch agent-8: Packet 3A  (to-slug.ts + registry-bridge.ts)
dispatch agent-9: Packet 3B  (discovery.ts)
WAIT: 2A+2B+2T (agent-store-prompts) vs 3A+3B (agent-store-prompts/agent-mcp)
NOTE: 3A touches agent-store-prompts, 3B touches agent-mcp
→ 2A/2B/2T CAN run alongside 3A (same project) but NOT alongside 3A if both write to agent-store-prompts
→ 3A and 2A/2B/2T are in agent-store-prompts but touch disjoint files (enrich/ vs name-slug/) — SAFE
→ But the test gate at the end is per-project.
   Two agents running `nx test agent-store-prompts` concurrently = RACE.
So: Pause after 2A+2B+2T+3A complete. Run `nx test agent-store-prompts`.
Then continue with 3B+3C.
  ↓

=== SERIAL SWITCH (after Wave 2 + Wave 3A complete) ===
GATE: npx nx run-many -t build,test,lint --projects agent-store-prompts
RESUME PARALLEL:
dispatch agent-9: Packet 3B  (discovery.ts)
dispatch agent-10: Packet 3C  (server.ts)
WAIT: 3B+3C complete
GATE: npx nx run-many -t build,test,lint --projects agent-mcp

=== SERIAL REVIEW GATE ===
dispatch agent-11: Packet CR-3 (code review, read-only)
WAIT: review complete
IF review fails → file bugs, fix, re-gate

=== PARALLEL WAVE 4 + WAVE 5A + WAVE 5B (after CR-3 passes) ===
dispatch agent-12: Packet 4A  (authoring.ts)
dispatch agent-13: Packet 4B  (composition-writer.ts)
dispatch agent-14: Packet 4T  (component-define.test.ts)
dispatch agent-15: Packet 5A  (compat-shim.ts)
dispatch agent-16: Packet 5B  (CHANGELOG + version bumps)
WAIT: all 5 complete
GATE: npx nx run-many -t build,test,lint --projects agent-mcp,agent-store-prompts

=== PARALLEL WAVE 5C + WAVE 6 (after W4+W5A+W5B gate passes) ===
dispatch agent-17: Packet 5C  (e2e tests)
WAIT: 5C complete
dispatch agent-18: Packet 6A  (code review, read-only)
WAIT: review complete
dispatch agent-19: Packet 6B  (final audit)
WAIT: audit complete
GATE: npx nx run-many -t build,test,lint --projects agent-mcp,agent-store-prompts
```

### D.13 Risk notes

1. **Two-repo coordination** — Pre-Wave packets (P0–P2) are in sox-ecosystem, Waves 1–6 are in the ADHD project. The ADHD project cannot begin Wave 1 until `@adhd/sox-store-adapter` and `@adhd/sox-vector-store` are both published and available. The `pnpm add` step to add these to ADHD's `agent-store-prompts/package.json` happens as part of Packet 1C — but the packages must be resolvable at that point. The cleanest approach: publish `@adhd/sox-store-adapter@0.1.0` and `@adhd/sox-vector-store@0.2.0` from the sox-ecosystem before ADHD work begins, rather than using `workspace:*` or `file:` links.

2. **Same-nx-project parallelism** — Packets 2A/2B/2T write to `agent-store-prompts` and Packets 3B/3C/3T write to `agent-mcp`. These are DIFFERENT nx projects, so their test/lint gates are independent. However, two packets writing to THE SAME nx project (`agent-store-prompts`) can run in parallel IF they touch disjoint files. Their serial gate (`npx nx test agent-store-prompts`) must run AFTER both complete — a single gate command, not two agents racing. The dispatch script above handles this.

3. **`enrich-component.ts` imports from `embedding.ts` and `usecase-anchors.ts`** — These are within the same `enrich/` directory. Packet 1A creates `embedding.ts`, Packet 1B creates `usecase-anchors.ts`, Packet 2A creates `enrich-component.ts` which imports both. **Type resolution is fine** because TypeScript resolves from source (via `tsconfig.lib.json` `paths`). The build order must be: W1 gate (build) → W2 gate (build) → W4. The nx `dependsOn: ["^build"]` ensures this automatically.

4. **`server.ts` modification risk** — Packet 3C modifies `entrypoint/agent-mcp/src/server.ts`, which is the shared spine for ALL tool registration. If another agent is working in this file concurrently (e.g., a parallel feature branch), there WILL be merge conflicts. File a reservation on `server.ts` for the duration of Wave 3. No other packet touches this file.

5. **No existent `entrypoint/agent-mcp/src/registry/` directory** — Packet 4B must `mkdir` this directory. The spec mentions `src/registry/composition-writer.ts` but directory does not exist. This is the only new directory creation outside of `enrich/`.

6. **`@adhd/sox-graph-store` is a transitive dependency** — `hybrid-search` depends on `graph-store` (for `buildNodeFilterClause`). If `graph-store` has NOT been published with StoreAdapter support, `hybrid-search` will fail to resolve at build time. Verify with `npx nx build hybrid-search` in Packet P2. If it fails, `graph-store` needs a StoreAdapter adaptation packet added between P0 and P1.
