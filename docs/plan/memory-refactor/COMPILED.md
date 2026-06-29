# Memory Refactor — Compiled Coding Tasks

> Extracted from the plan-state-machine contexts. Audit/verification states omitted.
> Ordered by wave (execution dependency order). Parallel waves noted.
> Last updated: 2026-06-28.

---

## Backlog triage — memory-server open issues

All open memory-related BL items assessed against the plan. Items marked ✅ are solved by existing plan states with no change. Items marked ⚠️/❌ have amendments added to the relevant task section below.

| BL | Summary | Severity | Disposition |
|---|---|---|---|
| BL-86 | `hashEmbed` degenerate vectors (~0.99 cosine on unrelated strings) | HIGH | ✅ Solved — `w2a deterministic.ts` carries the cosine-sanity fix; test asserts `\|cos\| < 0.5` |
| BL-87 | Published `memory-server` missing `fastembed`/`onnxruntime-node` deps | HIGH | ⚠️ Precondition only — quickfix must land before `p0-baseline`; `embedWorker.js` sibling-bundle requirement **added to `w2a`** |
| BL-88 | No per-record embedding provenance; no auto-heal when real backend returns | MEDIUM | ✅ Mostly solved — w2c `upsertVector` stores `modelId`; `reembed` heals mismatched rows; `degraded_record_count` in `memory_stats` **added to `w2e`** |
| BL-89 | Worker warmup fails silently → auto→hash fallback | HIGH | ✅ Solved — w2a `[def:loud-fail]` eliminates silent fallback; quickfix health surface (`last_embed_error`) **preservation added to `w2e`** |
| BL-91 | `INSERT OR REPLACE` fails on sqlite-vec `vec0` tables → `reembedNodes` silently broken | (Fixed in worktree) | ⚠️ Not captured — **UPDATE-then-INSERT pattern added to `w2c`** |
| BL-92 | Live store is a HASH/real mix because scope-level `embed_model` tag is unreliable | (Observed) | ✅ Solved — BL-88/w2c per-record `modelId` makes the tag per-row and reliable |
| BL-93 | `edge.rel` CHECK constraint missing `ASSIGNED_TO` → `memory_link({rel:'ASSIGNED_TO'})` fails at DB | (Fixed at source; schema must travel) | ⚠️ Not in plan — **10-value `EdgeRel` CHECK (incl. `DEPENDS_ON`) and test added to `w2b`** |
| BL-94 | `better-sqlite3` native binding missing for new Node ABI → mid-session crash | HIGH | ⚠️ Partial — `postinstall` rebuild script in `p0-baseline`; startup binding probe **added to `w2e`** |
| BL-95 | `memory-cli status/list` never find `~/.memory/memory.db` (scope-name mismatch) | MEDIUM | ❌ Not in plan — **bare-db scan in `cmdStatus` added to `w2e`** |
| BL-100 | `memoryRecall` silently ignores `filters` param — only the MCP server layer applies them | HIGH | ❌ Not in plan — filters wired into `SqliteSearchBackend.search()` internally (not a public export); wiring into `memoryRecall` via `SearchQuery.filters` **added to `w2e`** |
| BL-90 | Memory skills lack recall recipes and filter-first guidance for degraded embeddings | MEDIUM | Out of scope — docs/skill fix, no memory-server code change |
| BL-62 | Shared-backend `project_path` attribution is single-valued across multiple projects | MEDIUM | Out of scope — service-proxy concern, not memory-server internals |

---

## Key invariants (honor in every task)

- **Never hand-edit `registry/index.json`** — run `npx nx run registry:sync-index` after artifact changes.
- **Never `git add -A`** — stage by explicit path only.
- **Build via nx targets only** — never bare `tsc`/`vitest`/`eslint`. Always `npx nx build <project>`.
- **Before any memory test** — `npx nx build memory-core && npx nx build memory-server` first (BL-4 stale-dist).
- **No silent embedding fallback** — `resolveProvider` throws on load failure; hash provider is explicit-only.
- **Space invariant** — `upsertVector` rejects any vector whose `dim` or `modelId` ≠ the column's.
- **Tool contract stable** — the 19 `memory_*` MCP tool names + schemas must be byte-unchanged end-to-end.
- **data→data|shared only** — no `data/*` package may import `platform/*` or the domain composer (`memory-core`).
- **Fixes travel with the code** — BL-11 worker seam, BL-27 migration, BL-41 `expandDbPath`, BL-86 hash-degeneracy repair must all survive extraction intact.
- **Lifecycle spec** — any daemon/service touch must conform to `docs/spec/service-lifecycle.md §13`.

---

## Wave 0 — `p0-baseline`

**Depends on:** nothing (root). **Blocks:** `audit-baseline` → everything else.

### Goal
Freeze a trustworthy green baseline and author the machine check for the plan's hardest invariant. No source refactor — capture reality and build a guardrail.

### Entry gate
Do not start until the live user-scope `memory-server` reports `embed_on_hash_fallback:false` AND `embed_model:"bge-base-en-v1.5"`. Verify with `memory_ping` / `memory_stats`. If the server is still on hash, stop and report — do not work around with `SOX_EMBED_BACKEND=hash`.

### Files to create

**`docs/plan/memory-refactor/baseline/baseline.md`**
- Run each gate below and record: command + exit code + headline counts.
  ```
  npx nx run-many -t build,lint,test    # project counts
  npx nx run host-runtime:test-e2e      # pass/total + orphan count (note: BL-63 false-positive — a live local memory-server proxy shows as a leaked orphan; reconcile against that known baseline, do not chase it)
  npx nx run registry:check-sync        # sync result
  ```
- Also record the `[fix:cosine-sanity]` probe result: embed two unrelated strings via the live built server and record the cosine similarity (must be `< 0.5`, not `> 0.95`).
- Do not "fix" anything found — log it to BACKLOG.md and proceed.

**`docs/plan/memory-refactor/baseline/tool-snapshot.json`**
- Shape: `{ "tools": [{ "name": string, "inputSchema": object }] }`
- Source: a live `tools/list` call against the **built** `memory-server` (not from source). Must list exactly 19 `memory_*` tools, each with a non-empty `inputSchema`.
- This is the diff target for the tool-contract-stable invariant at `audit-extraction` and `audit-final`.

**`docs/plan/memory-refactor/scripts/space_invariant_check.mjs`**
- Node ESM, no new dependencies.
- Opens a DB read-only, joins `vec_node → node → memory_scope`, flags any vector whose implied model ≠ the scope model.
- Exits non-zero on a violation.
- `--self-test` flag: builds a tiny in-memory better-sqlite3 store and proves a mismatched-dim insert throws.
- Run against a **copy** of `~/.memory/memory.db` (never the live file) — `[fix:memory-db]`.

**`postinstall` / native rebuild fix (in-scope deliverable)**
- Add a root `package.json` `postinstall` script or a dedicated nx `rebuild-native` target so `pnpm install` on a new Node version rebuilds native bindings automatically (BL-94):
  ```json
  "postinstall": "pnpm rebuild better-sqlite3 sqlite-vec"
  ```
  This prevents the `Could not locate the bindings file` failure on new Node ABIs without a manual `node-gyp rebuild`.

### Read-only sources
```
libs/memory-core/src/schema.ts
libs/memory-core/src/embed.ts
registry/index.json
```

---

## Wave 2 — `p1-layout`

**Depends on:** `audit-baseline`. **Blocks:** all extraction states.

### Goal
Make the `area/group` taxonomy real — create the six `data/*` skeleton packages, wire the lint boundary, and tag existing libs in place. No code carved yet; this enables the extraction phase.

### Task 1 — Scaffold the six `data/*` packages

Prefer the external generator if it has shipped:
```bash
nx g @adhd/sox-nx:library --area data --group embed       embedding-provider
nx g @adhd/sox-nx:library --area data --group vectors     vector-store
nx g @adhd/sox-nx:library --area data --group graph       graph-store
nx g @adhd/sox-nx:library --area data --group search      hybrid-search
nx g @adhd/sox-nx:library --area data --group analysis    analysis
nx g @adhd/sox-nx:library --area data --group ingest      ingest
```

Otherwise run:
```bash
node scripts/scaffold-data-packages.mjs
```

Each skeleton must land at `libs/data/<group>/<name>/` with:
- `package.json` `name: "@adhd/sox-<name>"` (name decoupled from path — never change the published name if you rename/move the folder)
- `sox: { area: "data", group: "<g>", concerns: [...], invariants: [...], entrypoints: ["dist/index.js"] }` metadata
- nx tags `["type:lib", "area:data", "group:<g>"]`
- A compiling skeleton (`src/index.ts` exporting a stub; `nx build <name>` exits 0)

(`store` and `inference` groups stay **reserved** — no skeleton.)

### Task 2 — Add area depConstraints to `eslint.config.js`

Insert these **before** the `{ sourceTag: '*', onlyDependOnLibsWithTags: ['*'] }` catch-all — in **both** the `*.ts` block and the `*.js/.mjs/...` block:

```js
{ sourceTag: 'area:data',     onlyDependOnLibsWithTags: ['area:data','area:shared'] },
{ sourceTag: 'area:platform', onlyDependOnLibsWithTags: ['area:platform','area:shared'] },
{ sourceTag: 'area:shared',   onlyDependOnLibsWithTags: ['area:shared'] },
```

The existing `type:*` constraints and the permissive `{ '*': ['*'] }` catch-all are retained. The new positive `area:data` allowlist is what makes `data→platform` fail regardless of the target's tags.

### Task 3 — Tag existing libs in their `project.json`

Tags only — **no folder moves, no import changes, no registry churn**:

| Lib | Add tags |
|---|---|
| `tokenguard-core` | `area:shared`, `group:codec` |
| `manifest` | `area:platform`, `group:contract` |
| `install-engine` | `area:platform`, `group:distribution` |
| `registry` | `area:platform`, `group:distribution` |
| `host-registry` | `area:platform`, `group:host` |
| `host-runtime` | `area:platform`, `group:runtime` |
| `service-proxy` | `area:platform`, `group:runtime` |
| `mcp-runtime` | `area:platform`, `group:protocol` |
| `authoring` | `area:platform`, `group:authoring` |
| `sox-nx` (`packages/sox-nx`) | `area:platform`, `group:devtools` |
| `memory-core` | **NO `area:` tag** |
| `memory-enrich` | **NO `area:` tag** |

> ⚠️ Do NOT add `area:` tags to `memory-core` or `memory-enrich`. If you do, the composer can no longer import `data/*` and every extraction state fails lint.

Before committing: run `nx graph` / `nx lint` to confirm no latent `area:platform` cross-area edge surfaces. If one does, flag the orchestrator rather than force a red tag.

### Task 4 — Registry walker (if needed)

If the scaffold introduces a new directory the registry/index walker must know about, mirror the change in **both** `build-index.ts` and `check-registry-sync.ts` (BL-33 byte-mirror pair). Libs are not registry extensions, so this is typically a no-op — verify before assuming.

### Files mutated
```
eslint.config.js
libs/data/**
libs/tokenguard-core/project.json
libs/manifest/project.json
libs/install-engine/project.json
libs/registry/project.json
libs/host-registry/project.json
libs/host-runtime/project.json
libs/service-proxy/project.json
libs/mcp-runtime/project.json
libs/authoring/project.json
packages/sox-nx/project.json
```

### Read-only sources
```
scripts/scaffold-data-packages.mjs
docs/plan/memory-refactor/NX-GENERATOR-HANDOFF.md
```

---

## Wave 4 — `w2a-embedding-provider` ‖ `w2b-graph-store` (parallel)

**Depends on:** `audit-layout`. **These two states run concurrently — disjoint source files.**

---

### `w2a-embedding-provider`

**Mutates:** `libs/data/embed/embedding-provider/src/**`
**Read-only:** `libs/memory-core/src/embed.ts`, `libs/memory-core/src/embedWorker.ts`

#### Goal
Carve text→vector out of `memory-core` into `@adhd/sox-embedding-provider`. This state **copies/transforms** the embed logic into the new package — it does NOT yet delete `embed.ts` from `memory-core` (that happens in `w2e-domain-rewire`).

#### What to implement

**Interface** (export from `dist/index.js`):
```ts
interface EmbeddingProvider {
  readonly providerId: string;
  readonly modelId: string;
  readonly dim: number;
  readonly isDeterministic: boolean;
  readonly isRemote: boolean;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[], opts?: { batchSize?: number }): AsyncGenerator<Float32Array>;  // default batchSize 256
  queryEmbed?(text: string): Promise<Float32Array>;  // optional, query-optimized
}

function resolveProvider(config): EmbeddingProvider
// THROWS if the configured real provider cannot load — NO silent hash downgrade
// hash/deterministic selected only via explicit config (SOX_EMBED_BACKEND=hash), never as implicit fallback
```

**`src/fastembed.ts`** — the real provider
- Bundled-ONNX via `fastembed-js` / `onnxruntime-node`
- Ship **≥3 local models spanning dims** from the gate: e.g. `bge-small-en-v1.5` (384), `bge-base-en-v1.5` (768), `e5-large-v2` (1024)
- This is non-optional: the 1024 model makes the legacy hard-coded `FLOAT[768]` a hard failure, forcing `dim` parameterization to be real
- Real `embed()` must run in the **worker thread** (BL-11 boundary) — route through `embedWorker.ts`, never call onnxruntime inline on the main thread alongside `openDb`
- Externalize `fastembed` + `onnxruntime-node` (`engines: ">=22"`)

**`src/deterministic.ts`** — first-class deterministic provider
- Not a fallback — selected only by explicit config
- Carries the BL-86 degeneracy fix: two unrelated strings must produce cosine `< 0.5` (not ~0.99)
- `isDeterministic: true`

**`src/remote.ts`** — remote provider adapter (typed reference impl)
- Implements `EmbeddingProvider` against the same async+batch-first contract
- **NOT wired to a live/paid endpoint** — proves context-agnosticism without spend
- `isRemote: true`

**`src/cache.ts`** (or inline) — startup Map cache for hot/topic embeddings

**Key constraint:** `reembedNodes` logic does NOT live here — that is `[def:reembed-core]` in `vector-store` (`w2c`). This package only provides `embed`/`embedBatch` that the walk calls.

#### Backlog fixes required in this task

**BL-87 — Worker bundle not traced by esbuild (must emit `embedWorker.js` as a sibling)**

The real `embed()` dispatches to a worker via `new Worker(path.join(__dirname, 'embedWorker.js'))`. esbuild does **not** trace this runtime string-path reference — it is not a static import. When the `embedding-provider` package is bundled into `memory-server`, `embedWorker.js` must be emitted as a **separate sibling bundle** alongside `dist/index.js`. Without it, the Worker spawn fails silently and `embed()` falls back to hash.

The fix landed in the quickfix worktree as a `--worker <entry>` flag in `tools/bundle-extension.cjs`. When implementing `fastembed.ts` here:
- Ensure the worker entry point (`src/embedWorker.ts`) is the boundary where fastembed is lazy-required at runtime (not statically imported at bundle top level)
- Confirm `dist/embedWorker.js` exists in the package output after `nx build embedding-provider`
- Add a build-time assertion (in the nx target or a post-build script) that `dist/embedWorker.js` is present — a missing sibling is a silent regression with no immediate error

---

### `w2b-graph-store`

**Mutates:** `libs/data/graph/graph-store/src/**`
**Read-only:** `libs/memory-core/src/schema.ts`, `libs/memory-core/src/db.ts`, `libs/memory-core/src/write.ts`

#### Goal
Carve the bi-temporal graph substrate into `@adhd/sox-graph-store`. Operates on an **injected `Database`** — does NOT own `openDb`, does NOT import `vector-store`. This state copies/transforms; does NOT delete from `memory-core` yet.

#### What to implement

**`GraphBackend` interface (export from `dist/index.js`):**

```ts
// The storage abstraction — implement this to use graph-store logic against any backend.
// All write methods handle bi-temporal semantics, content-hash dedup, and FTS sync
// internally. Callers must never bypass these methods with raw SQL writes.
interface GraphBackend {
  applySchema(): void                                                   // idempotent DDL init
  writeNode(content: string, meta: NodeMeta): number                   // returns node_id; hash-dedup + FTS sync
  writeEdge(src: number, dst: number, rel: EdgeRel, meta?: EdgeMeta): void
  supersede(oldId: number, newContent: string, meta: NodeMeta): number // bi-temporal sequence
  invalidate(nodeId: number, reason?: string): void                    // sets t_invalid, never deletes
}

// Default SQLite implementation — ships with the package:
class SqliteGraphBackend implements GraphBackend {
  constructor(db: Database) {}
  // internally handles: FTS sync triggers, content-hash check-before-insert,
  // BL-27 organizer_queue migration, BL-93 edge.rel 10-value CHECK
}

// Convenience factory:
function createGraphBackend(db: Database): GraphBackend

// Schema-only exports (for the composer to apply directly):
export const PRAGMAS: string[]
export const GRAPH_DDL: string
export const FTS_TRIGGERS: string

// The 7 EdgeRel values exposed via memory_link MCP tool.
// MEMBER_OF, PART_OF, DEPENDS_ON are DDL-valid but internal-only.
export const PUBLIC_EDGE_RELS: readonly EdgeRel[]

// Error types:
//   ConstraintError      — writeEdge CHECK violation (wrong rel value, etc.)
//   BitemporalConflictError — supersede() on an already-invalidated node
//   NodeNotFoundError    — touch() on missing/invalidated node

// Schema migration:
//   applySchema() detects current version via PRAGMA user_version and applies
//   pending migrations idempotent. Composer just calls it on every open; the
//   package owns the migration logic internally.
```

**Read path:**
The stable table names (`node`, `edge`, `fts`) and their documented column sets ARE the read API contract — callers doing `SELECT ... FROM node WHERE ...` are using the published interface, not leaking an abstraction. The `GraphBackend` interface covers writes only (where bi-temporal integrity and FTS sync must be enforced). Raw reads against the stable schema are permitted and expected.

**Connection rules:**
- `SqliteGraphBackend` takes an injected `db: Database` — NO `new Database(...)` inside this package
- NO `sqlite-vec` load (composer/vector-store concern)
- NO import of `@adhd/sox-vector-store`

**Packaging:** PUBLIC (`private:false`, `publishConfig.access: "public"`, owner-gated). Externalize `better-sqlite3`; ship bundled `.d.ts`. After build, `check-publishable` must show zero `@adhd/sox-*` private runtime deps.

#### Backlog fixes required in this task

**BL-93 — `edge.rel` CHECK constraint must use the full 10-value `EdgeRel` union**

Three different `edge.rel` value sets were in play before the refactor:
- `memory_link` MCP tool `VALID_RELS`: `MENTIONS, SUPPORTS, RELATES_TO, DERIVED_FROM, SUPERSEDES, SAME_AS, ASSIGNED_TO` (7 — no `MEMBER_OF`/`PART_OF`)
- `schema.ts` CHECK (pre-fix): `MENTIONS, SUPPORTS, RELATES_TO, SUPERSEDES, DERIVED_FROM, MEMBER_OF, PART_OF, SAME_AS` (8 — no `ASSIGNED_TO`)
- Contract `EdgeRel` (10 values = union + `DEPENDS_ON`)

The source fix (2026-06-26) added `ASSIGNED_TO` to `schema.ts`. The extracted `graph-store` DDL **must use the full 10-value union**:

```sql
CHECK (rel IN ('MENTIONS','SUPPORTS','RELATES_TO','DERIVED_FROM','SUPERSEDES','SAME_AS','ASSIGNED_TO','MEMBER_OF','PART_OF','DEPENDS_ON'))
```

`MEMBER_OF` and `PART_OF` are intentional internal relations (used by the community/clustering layer) that are not exposed via the `memory_link` tool but must be DDL-accepted.

Add a vitest asserting that inserting an edge with every value accepted by the `memory_link` tool enum succeeds without a SQLite CHECK constraint error. This test must stay in sync with the tool's `VALID_RELS` set.

---

## Wave 5 — `w2c-vector-store` ‖ `w2d-ingest` (parallel)

**Depends on:** `w2a-embedding-provider` + `w2b-graph-store`.

---

### `w2c-vector-store`

**Mutates:** `libs/data/vectors/vector-store/src/**`
**Read-only:** `libs/memory-core/src/schema.ts`, `libs/memory-core/src/embed.ts`, `libs/memory-core/src/write.ts`, `libs/memory-core/src/recall.ts`, `scripts/reembed-memory.mjs`

#### Goal
Carve the vector substrate into `@adhd/sox-vector-store`. This is the riskiest carve — it depends on both prior extractions and owns the plan's hardest invariant (space invariant). Does NOT delete from `memory-core` yet.

#### What to implement

**`VectorBackend` interface (export from `dist/index.js`):**

See `COMPILED_INTERFACES.md §@adhd/sox-vector-store` for the full canonical interface.
Key implementation notes for this task:

```ts
// Multi-space design — one backend holds vectors from multiple models/dims.
// Call ensureSpace before the first upsert into a new space; idempotent thereafter.
// THROWS SpaceInvariantError if vec.length !== space.dim ([def:space-invariant]).
interface VectorBackend {
  ensureSpace(space: VectorSpace): void   // { modelId: string; dim: number }
  listSpaces(): VectorSpace[]
  upsert(id: number, vec: Float32Array, space: VectorSpace): void
  delete(id: number, modelId: string): void
  get(id: number, modelId: string): Float32Array | null
  knn(query: Float32Array, space: VectorSpace, k: number, filter?: VecFilter): Array<{ id: number; score: number }>
  iter(modelId: string, opts?: { filter?: VecFilter }): Iterable<{ id: number; vec: Float32Array }>
}

// Default SQLite implementation — no opts at construction; spaces are declared per-upsert:
class SqliteVectorBackend implements VectorBackend {
  constructor(db: Database) {}
  // sqlite-vec vec0 virtual tables, one per space; BL-91 UPDATE-then-INSERT upsert
  // SimilarityBackend is an inner seam within this class (Phase 1+ ANN swap point)
}

// Standalone convenience opener (3rd-party use):
function openVectorStore(path: string, opts: { dim: number; modelId: string }): SqliteVectorBackend

// Cross-package migration op — caller provides explicit target space:
function reembed(
  backend: VectorBackend,
  provider: EmbeddingProvider,      // from @adhd/sox-embedding-provider — passed in, not imported
  opts: {
    targetSpace: VectorSpace        // required — explicit to support cross-model migration
    sourceModelId?: string          // defaults to first space whose modelId !== targetSpace.modelId
    dryRun?: boolean
  }
): Promise<ReembedResult>
// [def:reembed-core] — walks vec.iter(sourceModelId) → provider.embedBatch() → vec.upsert(targetSpace)
// Does NOT delete source vectors — caller decides when the old space is safe to drop.
```

**`SimilarityBackend`** (inner seam inside `SqliteVectorBackend`, NOT part of the public `VectorBackend` interface):
```ts
// SQLite-internal only — for swapping brute-force → quantized → HNSW (Phase 1+)
interface SimilarityBackend {
  search(query: Float32Array, k: number, filter?: VecFilter): Array<{ nodeId: number; score: number }>
}
// Build BruteForceBackend only now. SqliteVectorBackend accepts optional SimilarityBackend injection.
```

**Key constraints:**
- `vec0` dim derived from `opts.dim` — with 384 and 1024 models in the suite (from w2a), the legacy `FLOAT[768]` hard-code is a **hard failure**, not latent
- `reembed` calls `active.embedBatch(...)` (worker-backed batch API from w2a) — must NOT load onnxruntime inline alongside open db (BL-11)
- Does NOT import `@adhd/sox-graph-store`

#### Backlog fixes required in this task

**BL-91 — Do NOT use `INSERT OR REPLACE` on `vec0` tables**

sqlite-vec `vec0` virtual tables do not implement OR-REPLACE conflict resolution. `INSERT OR REPLACE INTO vec_node(node_id, embedding)` raises `SqliteError: UNIQUE constraint failed on vec_node primary key` and rolls back the entire transaction — vectors remain unchanged with no visible error. This was the root cause of `reembedNodes()` being silently non-functional in the existing code.

Both `upsertVector` and `reembed` must use the UPDATE-then-INSERT pattern:

```ts
function writeVec(db: Database, nodeId: number, vec: Float32Array): void {
  const updated = db.prepare('UPDATE vec_node SET embedding=? WHERE node_id=?').run(vec, nodeId);
  if (updated.changes === 0) {
    db.prepare('INSERT INTO vec_node(node_id, embedding) VALUES(?,?)').run(nodeId, vec);
  }
}
```

Never use `INSERT OR REPLACE`, `INSERT OR IGNORE`, or `ON CONFLICT` clauses against `vec_node`. Add a test that calls `upsertVector` twice on the same `nodeId` (UPDATE path) and once on a new `nodeId` (INSERT path) to prove both branches work.

**Packaging:** PUBLIC. Externalize `better-sqlite3`, `sqlite-vec`. Ship bundled `.d.ts`. `check-publishable` must show zero private `@adhd` runtime deps.

---

### `w2d-ingest`

**Mutates:** `libs/data/ingest/ingest/src/**`
**Read-only:** `libs/memory-enrich/src/extractive.ts`, `libs/memory-enrich/src/enrich.ts`

#### Goal
Extract the write-path single-item transforms from `memory-enrich` into `@adhd/sox-ingest`. Deterministic, zero-LLM, byte-reproducible. Does NOT delete from `memory-enrich` yet (that happens in `w2e`).

**Split rule:** anything that needs only THIS item → ingest; anything that needs OTHER items (cluster, near-dup, importance link-score, auto-link) → analysis (`w2d-analysis`).

#### What to implement

**Public API — export from `dist/index.js`:**

```ts
function ingest(content: string, opts?: IngestOpts): IngestResult
// Unified pure transform: content-hash (hex-encoded SHA-256), extractive summary, tags, optional chunking.
// Calls the individual helpers below — those are internal, not re-exported.
```

**Internal helpers (extracted from `memory-enrich`, not exported directly):**

```ts
function contentHash(content: string): string
// hex-encoded SHA-256 of normalized content — used for graph-store write-time dedup

function extractiveSummary(text: string, opts?: {...}): string
// moved from extractive.ts

function deterministicTags(content: string): string[]
// zero-LLM tagging — extracted from the write-path of enrich.ts enrichOnWrite

function deriveTopic(...): string
// zero-LLM topic derivation — write-path portion of enrich.ts
```

**Stubs only (future seam — do not implement now):**
```ts
// Called internally by ingest() when opts.chunk is set. Stub returns whole content as single chunk.
function chunk(content: string, opts?: ChunkOpts): IngestChunk[]  // stub
function normalize(content: string): string                        // stub
```

**Dependencies:** none — pure stateless transforms, zero runtime deps.

**Packaging:** PRIVATE (`private:true`, never published — no use case pulled it externally).

---

## Wave 6 — `w2d-analysis` ‖ `w2d-hybrid-search` (parallel)

**Depends on:** `w2c-vector-store`.

---

### `w2d-analysis`

**Mutates:** `libs/data/analysis/analysis/src/**`
**Read-only:** `libs/memory-enrich/src/cluster.ts`, `libs/memory-enrich/src/neardup.ts`, `libs/memory-enrich/src/importance.ts`, `libs/memory-enrich/src/autolink.ts`, `libs/memory-enrich/src/batch.ts`, `libs/memory-enrich/src/filters.ts`, `libs/memory-enrich/src/types.ts`

#### Goal
Extract batch derivation over a corpus from `memory-enrich` into `@adhd/sox-analysis`: clustering, near-dup, importance/link-scoring, auto-linking. Batch-only — never per-query. Does NOT delete from `memory-enrich` yet.

#### What to implement

**Export from `dist/index.js`** (moved from the source files listed above):

```ts
// From cluster.ts:
function clusterStore(db: Database, opts?: ClusterOpts): ClusterResult
function clusterSubset(db: Database, filters: MemoryFilter, opts?: ClusterOpts): SubsetClusterResult
function clusterStats(db: Database): ClusterStats
function materializeClusters(db: Database, result: ClusterResult): void
function dropSubsetLens(db: Database, provenanceHash: string): void
function listSubsetLenses(db: Database): SubsetLens[]

// From neardup.ts:
function detectNearDup(db: Database, opts?: NearDupOpts): NearDupPair[]

// From importance.ts:
function computeImportance(db: Database, opts?: ImportanceOpts): void

// From autolink.ts:
function buildAutoLinks(db: Database, opts?: AutoLinkOpts): void

// From batch.ts — the corpus orchestrator:
function runBatchEnrich(db: Database, opts?: BatchOpts): BatchResult
// calls cluster/neardup/importance/autolink over the corpus

// modelId provenance on all similarity-derived outputs:
// every output record must carry the modelId it was computed under
// (so a re-embed invalidates stale derivations)
```

**Clustering implementation:**
- Use an existing JS lib (`density-clustering` / `hdbscanjs`) — do NOT hand-roll DBSCAN/HDBSCAN
- Read vectors out of vector-store → cluster via the JS lib → write labels back
- Pure JS, in-process — NOT a SQLite extension
- Batch/daemon op, not on the query hot path — Phase-0 perf is acceptable at <50K

#### Implementation constraints from research (memory 01KVP1Z15W8H2J6FFR5MF8554R — deterministic-first)

These are behavioral design constraints, not just signature notes. The executor must honor them or the analysis package becomes a token cost rather than a cost saver.

**`computeImportance` — write-time, store, reuse; never recompute at query time**
- Score importance ONCE per node when it enters the corpus (one deterministic computation: graph centrality + recency + link count + near-dup weight).
- Write the score to `node.importance` in the DB.
- The recall ranker reads the stored score from the DB; it NEVER calls `computeImportance` on the query hot path.
- `runBatchEnrich` must filter to un-scored nodes only (e.g. `WHERE node.importance IS NULL`). Do not re-score the full corpus on every batch run.
- Expose `{ force: true }` to override (e.g., after a model switch that invalidates importance scores).

**`runBatchEnrich` — incremental by default**
- Track enrichment state per node. Default: process only newly ingested (un-enriched) nodes — those that haven't passed through the full cluster/neardup/importance/autolink cycle yet.
- Implementation: a `WHERE enriched_at IS NULL OR enriched_at < ?` filter or equivalent epoch marker on the node. NOT a full-corpus re-scan.
- Full corpus rebuild is opt-in via `{ full: true }` — expensive, for after a model migration or structural change.

**`buildAutoLinks` — label propagation on affected neighborhood, not full-graph rebuild**
- When called for a newly ingested batch: only re-run auto-link discovery on the neighborhood of the new nodes (their 1-hop and 2-hop neighbors), not the entire graph.
- Accept an optional scope param: `{ nodeIds?: number[]; since?: string }` — if provided, constrain traversal to affected subgraph. If absent, full rebuild (expensive; flag it in the log).
- This pattern: incremental graph update via label propagation reduces auto-link cost from O(corpus²) to O(new_nodes × avg_degree).

**`detectNearDup` — threshold-gated at the extremes; return `candidate` band, not LLM call**
- This package is zero-LLM. Escalation to LLM is NOT in scope here — the caller decides.
- Similarity thresholds (configurable, these are defaults):
  - `cosine ≥ 0.95` → `status: 'near_dup'` (deterministic; write SAME_AS edge automatically)
  - `cosine < 0.70` → `status: 'distinct'` (deterministic; no edge)
  - `0.70 ≤ cosine < 0.95` → `status: 'candidate'` (uncertain band; write SAME_AS edge with `meta.status: 'candidate'`; let the caller escalate to LLM if they want disambiguation)
- Return includes the similarity score and which band each pair fell into so callers can set their own threshold policy without re-running the scan.

**Community summaries — stored at cluster time, retrieved at query time**
- If `clusterStore` / `clusterSubset` generates a label or summary for a community, write it to the community node's `summary` column in the graph store at clustering time.
- At query time (e.g. in hybrid-search recall), retrieve the pre-stored summary — do NOT re-run the clusterer to produce it. Summaries are paid once, reused indefinitely (GraphRAG pattern: 2–3% of naive full-context cost).

**`filters.ts` decision:** `MemoryFilter` types live with hybrid-search (the query side); the batch filter SQL builder (`buildFiltersClause`) lives here. If it proves load-bearing and both packages need it, flag the orchestrator; default is to duplicate the tiny SQL builder rather than create a new shared package mid-plan.

**Analysis exports (`dist/index.js`):**

See `COMPILED_INTERFACES.md §@adhd/sox-analysis` for the full canonical interface.
Key implementation notes for this task:

There is no `CorpusBackend` wrapper. All DB-integrated functions take `VectorBackend + GraphBackend`
directly — this is honest about cross-dependencies and lets callers compose backends independently.
No raw SQL inside analysis source: reads go via `vec.iter` / `graph.queryNodes`, writes via
`graph.writeEdge` / `graph.writeNode` / `graph.touch`.

```ts
// DB-integrated functions — main export:
function clusterStore(vec: VectorBackend, graph: GraphBackend, opts?: ClusterOpts): Promise<ClusterResult>
function clusterSubset(vec: VectorBackend, graph: GraphBackend, filter: NodeFilter, opts?: ClusterOpts): Promise<SubsetClusterResult>
function detectNearDup(vec: VectorBackend, graph: GraphBackend, opts?: NearDupOpts): NearDupPair[]
function computeImportance(vec: VectorBackend, graph: GraphBackend, opts?: ImportanceOpts): void
function buildAutoLinks(vec: VectorBackend, graph: GraphBackend, opts?: AutoLinkOpts): void
function runBatchEnrich(vec: VectorBackend, graph: GraphBackend, opts?: BatchOpts): Promise<BatchResult>

// Pure algorithm exports — also main entry (NOT a /algorithms subpath; TS subpath exports
// require moduleResolution: node16/bundler — too fragile for this setup):
function cluster(vecs: Array<{ id: number; vec: Float32Array }>, opts?: ClusterOpts): ClusterResult
function detectNearDupPairs(vecs: Array<{ id: number; vec: Float32Array }>, opts?: NearDupOpts): NearDupPair[]
function scoreImportance(node: { inDegree: number; outDegree: number; recencyMs: number; nearDupCount: number }): number
// Uses density-clustering / hdbscanjs — NOT hand-rolled DBSCAN/HDBSCAN

// Graph-theoretic algorithms — pure, zero storage deps:
function topoSort(nodeIds: number[], getEdges: (id: number) => number[]): TopoSortResult
function criticalPath(nodeIds: number[], getEdges: (id: number) => number[], getWeight: (id: number) => number): Map<number, number>
function detectCycles(nodeIds: number[], getEdges: (id: number) => number[]): Array<number[]>
function detectDAGStructure(nodeIds: number[], getEdges: (id: number) => number[]): DAGStructure

// Batch scheduling — pure, zero storage deps:
function packBatches(items: PackItem[], opts: PackOpts): PackResult
function setOverlapMatrix(items: Array<{ id: number; keys: string[] }>, valueFn?: (key: string) => number): OverlapEntry[]
```

**Dependencies:** imports `@adhd/sox-vector-store` (VectorBackend) + `@adhd/sox-graph-store` (GraphBackend). Both PUBLIC — normal deps, not bundled. Pure algorithm functions have zero storage deps but share the same entry point.

**Packaging:** PUBLIC. Externalize native deps + the JS clustering lib; ship bundled `.d.ts`. `check-publishable` must show zero private `@adhd` runtime deps.

---

### `w2d-hybrid-search`

**Mutates:** `libs/data/search/hybrid-search/src/**`
**Read-only:** `libs/memory-core/src/recall.ts`

#### Goal
Extract the vec+BM25+temporal-decay fusion ranker from `recall.ts` into `@adhd/sox-hybrid-search`. Generic IR — no domain coupling. Leave federation/registry (multi-store) in the domain composer. Does NOT delete from `memory-core` yet.

**The line is ranking vs federation:** single-store fusion ranking → hybrid-search; cross-store federation + the store registry → domain composer. Do not drag `discoverStores` / `getFederationConnection` / `readRegistry` / `writeRegistry` into this package.

#### What to implement

**`SearchBackend` interface and exports (`dist/index.js`):**

See `COMPILED_INTERFACES.md §@adhd/sox-hybrid-search` for the full canonical interface.
Key implementation notes for this task:

```ts
// Generic — score field names are mechanism-agnostic (not bm25/cosine).
// Degrade contract: text absent → vecScore only; vec absent → textScore only. Never throws.
interface SearchBackend {
  search(
    query: SearchQuery,   // { text?, vec?: Float32Array, filters?: Record<string, unknown> }
    limit: number
  ): Array<{ id: number; textScore?: number; vecScore?: number; fields: Record<string, unknown> }>
}

// Default SQLite implementation — takes VectorBackend + GraphBackend (not raw Database):
class SqliteSearchBackend implements SearchBackend {
  constructor(vec: VectorBackend, graph: GraphBackend, opts?: SqliteSearchOpts) {}
  // delegates to graph.searchNodes() for textScore, vec.knn() for vecScore
}

interface SqliteSearchOpts {
  fieldWeights?: Record<string, number>   // default: memory node preset
  schemaAdapter?: SchemaAdapter           // full SQL override; SQLite-internal only, not exported
}

// SchemaAdapter is NOT exported from the package — it is SQLite-internal.
// MCP server passes raw filters via SearchQuery.filters; SqliteSearchBackend resolves internally.
interface SchemaAdapter {
  buildTextQuery(query: string, opts: { limit: number }): { sql: string; params: unknown[] }
  buildVecQuery(vec: Float32Array, k: number): { sql: string; params: unknown[] }
  buildFilterClause(filters: unknown): { sql: string; params: unknown[] }
}

// Top-level entry point — fusion math over any SearchBackend:
function search(backend: SearchBackend, query: SearchQuery, opts?: SearchOpts): SearchResult[]

interface SearchOpts {
  normalizer?: 'min_max' | 'L2' | 'z_score'
  explain?: boolean     // signal-level only (textScore/vecScore); field-level stays SQLite-internal
  limit?: number
}

interface SearchResult {
  id: number
  score: number
  signalScores?: { text?: number; vec?: number }  // only when explain: true
  fields: Record<string, unknown>
}
```

**Call-site examples:**

```ts
// Memory domain:
const backend = new SqliteSearchBackend(vec, graph)
search(backend, { text: query, vec: queryVec, filters: { topic: 'agents' } }, { limit: 20 })

// SYS-1 prompt catalog (custom fieldWeights, still SQLite):
const backend = new SqliteSearchBackend(vec, graph, {
  fieldWeights: { title: 2.0, intent: 1.5, body: 1.0 },
})
search(backend, { text: taskQuery, vec: taskVec }, opts)

// SYS-3 code search (custom join logic, SQLite escape hatch):
const backend = new SqliteSearchBackend(vec, graph, { schemaAdapter: new SymbolGraphAdapter(db) })
search(backend, { text: query }, opts)

// Non-SQLite caller (pgvector + tsvector):
class PgSearchBackend implements SearchBackend { ... }
search(new PgSearchBackend(pool), { text: query, vec: qVec }, opts)
```

**Pure fusion exports — main entry (NOT a `/fusion` subpath; TS subpath exports require
`moduleResolution: node16/bundler` — too fragile; native deps are externalized anyway):**

```ts
// import { fuse, normalize } from '@adhd/sox-hybrid-search'

function normalize(scores: number[], method: 'min_max' | 'L2' | 'z_score'): number[]

function fuse(
  candidates: Array<{ id: number; textScore?: number; vecScore?: number }>,
  opts?: FusionOpts
): Array<{ id: number; score: number }>
// Degrade: when vecScore absent/zero across all candidates → textScore only

interface FusionOpts {
  normalizer?: 'min_max' | 'L2' | 'z_score'
  weights?: { text?: number; vec?: number }
}
```

**Behaviour requirements:**

- **Normalization:** always normalize before combining (min_max default) — never combine raw scores
- **Boosting:** multiplicative only; `fieldWeights` are caller-supplied; memory preset is a domain default not a package default
- **FTS5 (SqliteSearchBackend):** `bm25(col_weights)` rank config derived from `fieldWeights`; two-phase FTS5→exact-rescore; RRF normalization
- **Degrade-to-text:** `[def:degrade-to-bm25]` — when `SearchQuery.vec` absent or `vecScore` absent across all candidates, fusion returns text-only results; never throws. Write the test first.
- **Topic boost:** implicit lift for results whose `topic` field matches query; only when `fieldWeights` has a `topic` key
- **Explain:** `{ explain: true }` populates `SearchResult.signalScores: { text?, vec? }`; signal-level only; off by default
- **Phase-0 scope:** FTS5 + sqlite-vec brute-force, <50K. Leave seams for Phase 1+, build none of it.

**Dependencies:** `SqliteSearchBackend` takes injected `VectorBackend` + `GraphBackend` — both PUBLIC, normal deps not bundled. Pure fusion functions (`fuse`, `normalize`) are exported from the main entry alongside the DB-integrated code; native deps are externalized so callers who only import `fuse` don't get bindings.

#### Backlog fixes required in this task

**BL-100 — filters must be applied inside `SqliteSearchBackend`, not as a public export**

`buildFiltersClause` currently lives in `@adhd/sox-memory-enrich` and is applied as a SQL
pre-filter inside the MCP server handler **before** calling `memoryRecall`. `memoryRecall` itself
accepts `params.filters` but silently ignores it — any direct caller (REPL, tests,
`federatedRecall`, lib consumers) gets unfiltered results regardless of what they pass.

`memory-enrich` dissolves in `w2e`. The fix is **not** to export `buildFiltersClause` publicly —
that would expose SQLite-specific SQL generation at the package boundary. Instead:

- `SqliteSearchBackend.search()` accepts `SearchQuery.filters: Record<string, unknown>` and
  resolves them internally via `SchemaAdapter.buildFilterClause()` before the vec+BM25 ranking pass
- The MCP server passes raw filter values in `SearchQuery.filters` — it does not call any clause
  builder directly
- The domain composer maps `MemoryFilter` → `Record<string, unknown>` before constructing the
  `SearchQuery` — no SQL generation outside the backend

The filter pre-application must occur **before** the ranking pass (not post-filter), so that
non-matching nodes are excluded from the candidate set before scoring.

**Packaging:** PUBLIC. Externalize native deps; ship bundled `.d.ts`. `check-publishable`: every `@adhd/sox-*` dep it declares must be PUBLIC (no private `@adhd` runtime dep).

---

## Wave 7 — `w2e-domain-rewire`

**Depends on:** `w2d-ingest` + `w2d-analysis` + `w2d-hybrid-search`.
**Blocks:** `audit-extraction`.

### Goal
Re-point the memory domain onto the six extracted packages via facade-then-dissolve, leaving a slim `memory-core` and fully dissolving `memory-enrich`. The external 19-tool `memory_*` contract must be byte-unchanged. Do the three sub-steps **in order** — each must be independently green.

### Step 1 — Facade (green checkpoint #1)

Rewrite `memory-core` + `memory-enrich` internals to **re-export** from `data/*`. Zero consumer change — the 4 bundle members still import `@adhd/sox-memory-core`/`-enrich` and behave identically.

Examples:
```ts
// In memory-core/src/embed.ts (now a facade):
export { resolveProvider, EmbeddingProvider } from '@adhd/sox-embedding-provider';

// In memory-core/src/db.ts (openDb composes data/* per the connection seam):
import { applyGraphSchema } from '@adhd/sox-graph-store';
import { applyVecSchema } from '@adhd/sox-vector-store';
export function openDb(path: string, opts: { dim: number; modelId: string }): Database {
  const db = new Database(expandDbPath(path));   // BL-41 expandDbPath stays here
  sqliteVec.load(db);                            // sqlite-vec load stays in composer
  // apply pragmas (from PRAGMAS exported by graph-store)
  applyGraphSchema(db);
  applyVecSchema(db, opts);
  return db;
}
```

Run `npx nx run-many -t test` + e2e — must be green before moving to step 2.

### Step 2 — Flip (green checkpoint #2)

Change the 4 bundle members to import `data/*` directly where appropriate:
- `memory-server`, `memory-daemon`, `memory-cli`, `memory-flush` → import from `@adhd/sox-vector-store`, `@adhd/sox-graph-store`, `@adhd/sox-embedding-provider`, `@adhd/sox-hybrid-search`, `@adhd/sox-analysis`, `@adhd/sox-ingest`
- Import slim `memory-core` only for domain glue (session-state, scope/promotion, federation, `openDb`, `memory_*` composition)

**Wire the reembed daemon op** in `memory-daemon`:
- Use `vector-store.reembed(db, { active, dryRun })` — the single core from `w2c`
- Conform to `docs/spec/service-lifecycle.md §13` for the daemon op wiring

**Thin wrapper** for `scripts/reembed-memory.mjs`:
```js
// delegates to vector-store.reembed — does NOT re-implement the SQL walk
import { reembed } from '@adhd/sox-vector-store';
// ... parse args, open db, call reembed, print result
```

Run `npx nx run-many -t test` + e2e — must be green before step 3.

### Step 3 — Dissolve (green checkpoint #3)

- Delete the dead facade re-exports from `memory-core`
- **Delete `@adhd/sox-memory-enrich` entirely** — the package, its `project.json`, and all source. After this, zero `import '@adhd/sox-memory-enrich'` should exist anywhere:
  ```bash
  # Verify:
  grep -rl "@adhd/sox-memory-enrich" --include=*.ts libs apps extensions packages
  # Must return nothing
  ```
- Leave `memory-core` slim — verify nothing in it belongs in `data/*`
- Boundary check: no `data/*` package imports `memory-core`

### Step 4 — Rebuild + resync

```bash
# Build the affected trio + bundle members:
npx nx build memory-core
npx nx build memory-server
npx nx build memory-daemon
npx nx build memory-cli
npx nx build memory-flush

# Sync the registry (NEVER hand-edit registry/index.json):
npx nx run registry:sync-index

# Stage by explicit path and commit source + registry/index.json together:
git add libs/memory-core/... libs/memory-enrich/... \
        extensions/bundles/sox-memory-bundle/... \
        scripts/reembed-memory.mjs \
        registry/index.json

# Upgrade all consumers:
node bin/soxe upgrade --all
# Note: stdio MCP (memory-server) respawns on the client's next connection — user must reconnect/reload plugins
```

### Backlog fixes required in this task

**BL-100 — Wire `memoryRecall` to honor `params.filters` via `hybrid-search.buildFiltersClause`**

After the flip (Step 2), `memoryRecall` in slim `memory-core` must apply `buildFiltersClause` from `@adhd/sox-hybrid-search` as a SQL pre-filter when `params.filters` is present. The current MCP server workaround (applying the clause before the `memoryRecall` call) is NOT sufficient — it silently breaks every direct caller: `federatedRecall`, tests, REPL, any lib consumer.

In the rewired `memory-core/src/recall.ts`:
```ts
import { buildFiltersClause } from '@adhd/sox-hybrid-search';

export async function memoryRecall(db, scope, params) {
  // ...
  const { sql: filterSql, params: filterParams } = params.filters
    ? buildFiltersClause(params.filters)
    : { sql: '', params: [] };
  // pass filterSql as a pre-filter to the hybrid-search call
  // ...
  return { results, filterStats: { candidates_before_filter, candidates_after_filter } };
}
```

Add `filterStats: { candidates_before_filter: number; candidates_after_filter: number }` to `RecallResponse` so callers can distinguish a filtered empty result from an empty corpus. This is an additive output field — it does not change the `inputSchema` checked by `[inv:tool-contract-stable]`.

The MCP server's existing pre-filter logic can then be simplified to call `memoryRecall` with the filters directly (removing the duplicated `buildFiltersClause` call from `memory-server/src/index.ts:954–1034`).

---

**BL-88 — Add `degraded_record_count` to `memory_stats` output**

`w2c-vector-store` stores `embed_model` per-record via `upsertVector`. The slim `memory-core` must wire a `degraded_record_count` field into the `memory_stats` MCP tool response: the count of `vec_node` rows whose stored `modelId` ≠ the currently active provider's `modelId`.

```ts
// In the memory_stats handler (memory-server/src/index.ts):
const { count: degraded_record_count } = db
  .prepare('SELECT COUNT(*) as count FROM vec_node WHERE modelId != ?')
  .get(activeProvider.modelId);
// Include in the stats output object
```

This surfaces how many records are candidates for `reembed` — essential for operators to know after a model switch or after recovering from hash fallback (BL-92: the live store has a HASH/real mix). This is an additive stats field, not a tool contract change.

---

**BL-89 — Preserve embed health surface from the quickfix**

The quickfix adds `last_embed_error`, `warmupEmbed()`, `getEmbedHealth()`, `getLastEmbedError()` to the embed layer. These must survive the flip:

- `memory_ping` must include `last_embed_error: string | null` (the cause of the most recent warmup failure)
- `memory_stats` must include `embed_on_hash_fallback`, `last_embed_error` (already in baseline snapshot — must not be removed)
- The `embedding-provider` package (`fastembed.ts`) must preserve the configurable warmup timeout (`SOX_EMBED_WARMUP_TIMEOUT_MS`, default 60s) so an indefinite ONNX hang can't wedge callers
- `backend=real` must fail-LOUD (throws, never downgrades); `auto` fallback records the cause

These are additive fields on existing tools — they travel in the tool's output object, not its `inputSchema`. They will be present in `baseline/tool-snapshot.json` (captured from the quickfix-landed server) and must remain in the rebuilt server's output at `[w2e.3]`.

---

**BL-94 — Add startup binding probe to `memory-server`**

Currently `memory_ping` succeeds even when `better-sqlite3` bindings are absent (it bypasses the DB), masking the failure until the first DB operation mid-session. Add a binding probe that runs at startup before the MCP server begins accepting connections:

```ts
// In memory-server/src/index.ts — before server.listen() / stdio attachment:
try {
  require('better-sqlite3');
} catch (err) {
  process.stderr.write(
    `FATAL: better-sqlite3 native binding missing for this Node.js ABI.\n` +
    `Run: pnpm rebuild better-sqlite3 from the sox-ecosystem root, then restart.\n` +
    `Error: ${err.message}\n`
  );
  process.exit(1);
}
```

Exit 1 immediately — a clear error is better than a mid-session crash after an agent has already written several episodes. The `[inv:tool-contract-stable]` diff at `[w2e.3]` will reveal if this changes the server's MCP init behavior (it should not — the probe runs before `initialize`).

---

**BL-95 — `memory-cli cmdStatus` must surface bare `memory.db` stores**

`cmdStatus` resolves stores from `registry.json` (which is `{}` for most installs) and the cwd's `.memory/` dir. A live store at `~/.memory/memory.db` that predates the scope-naming convention is silently skipped, producing "No memory stores found." even when `memory_ping` returns `ok:true`.

In `memory-cli/src/index.ts` `cmdStatus` handler, add a scan of known store dirs:
```ts
const KNOWN_STORE_DIRS = [path.join(os.homedir(), '.memory'), path.join(process.cwd(), '.memory')];

for (const dir of KNOWN_STORE_DIRS) {
  const bare = path.join(dir, 'memory.db');
  if (fs.existsSync(bare) && !registeredPaths.includes(bare)) {
    stores.push({ path: bare, scope: '(unregistered)', registered: false });
  }
}
```

Surface unregistered stores with an `(unregistered)` marker and a note to run `memory init --scope user --path <dir>` to register them. This is a `memory-cli` source change in Step 2 (Flip) — it does not affect the MCP tool contract.

---

### Files mutated
```
libs/memory-core/src/**
libs/memory-enrich/**  (deleted)
extensions/bundles/sox-memory-bundle/members/memory-server/src/**
extensions/bundles/sox-memory-bundle/members/memory-daemon/src/**
extensions/bundles/sox-memory-bundle/members/memory-cli/src/**
extensions/bundles/sox-memory-bundle/members/memory-flush/src/**
scripts/reembed-memory.mjs
registry/index.json
```

### Read-only sources
```
docs/plan/memory-refactor/baseline/tool-snapshot.json
docs/spec/service-lifecycle.md
```

---

## Wave 9 — `p4-routing`

**Depends on:** `audit-extraction`. **Final coding wave.**

### Goal
Build the layered agent decision-routing surface on top of the now-real `area/group` taxonomy. A generated routing index (behind a drift gate), hierarchical authored `CLAUDE.md`, a curated `ROUTER.md`, and a soft sox-memory advisory.

**Hard rule:** `map.json` / `INDEX.md` are **generated**, never hand-maintained. The drift gate is the whole point. Model it on the BL-33 `build-index.ts` ↔ `check-registry-sync.ts` byte-mirror pattern.

### Task 1 — `scripts/build-routing-index.ts` + `scripts/check-routing-drift.ts`

**`build-routing-index.ts`:**
- Walk the nx project graph + each package's `sox.{area,group,concerns,invariants,entrypoints}` metadata
- Emit `docs/routing/map.json` (machine-readable) — every data/* package + tagged lib with its concerns/invariants
- Emit `docs/routing/INDEX.md` (human-readable) at root
- Emit a per-area `INDEX.md` (e.g. `libs/data/INDEX.md`)
- Wire as nx target `routing:build-index`

**`check-routing-drift.ts`:**
- Regenerate into a temp dir and diff against the committed outputs
- Exits non-zero on any drift
- Wire as nx target `routing:check-drift`

### Task 2 — Hierarchical `CLAUDE.md`

**Root `CLAUDE.md`** — add a routing pointer section only. Do NOT rewrite or remove the existing `AGENT CONSTRAINT` sections — they are load-bearing. Add a brief section pointing to `docs/routing/ROUTER.md` and `libs/data/CLAUDE.md`.

**`libs/data/CLAUDE.md`** — area-level, carrying:
- Boundary rules (`data→data|shared` only; any `data→platform` import fails `nx lint`)
- Build rules (`npx nx build <package>` — never bare `tsc`)
- The BL-11 note (real `embed()` runs in a worker thread — do not load onnxruntime alongside `openDb`)
- Key footguns (dim hard-coding, silent embedding fallback, space invariant enforcement)

(The group-level stubs should already exist from the scaffold; fill them in minimally.)

### Task 3 — `docs/routing/ROUTER.md`

Hand-curated intent→scope mapping for the top task types. Required entries:

| If you're doing... | Go to |
|---|---|
| Change embedding model / add a new model | `libs/data/embed/embedding-provider/` |
| Tune recall ranking / scoring / normalization | `libs/data/search/hybrid-search/` |
| Change node/edge schema, add graph columns | `libs/data/graph/graph-store/` + plan a re-embed (modelId mismatch check) |
| Add a write-time transform (new tagging, summary) | `libs/data/ingest/ingest/` |
| Tune clustering / near-dup / importance | `libs/data/analysis/analysis/` |
| Fix the kNN / space invariant / re-embed migration | `libs/data/vectors/vector-store/` |
| Change the 19 memory_* tool surface | `extensions/bundles/sox-memory-bundle/members/memory-server/` |
| Change the memory domain policy (scope, promotion, federation) | `libs/memory-core/` |
| Add a new data/* package | Run `nx g @adhd/sox-nx:library --area data --group <g> <name>`; see `NX-GENERATOR-HANDOFF.md` |
| Cross-cutting: new model breaks something | Check `[def:space-invariant]`; run `scripts/space_invariant_check.mjs`; route to `vector-store` + `embedding-provider` |

### Task 4 — Soft sox-memory advisory

Document (in `docs/routing/ROUTER.md` or `libs/data/CLAUDE.md`) that at task time, agents may recall learned lessons from sox-memory via `memory_recall` — advisory only, never gating. The advisory must not depend on embedding health: if recall is down or embeddings are off, routing still works (the advisory degrades, never blocks).

### Files mutated
```
scripts/build-routing-index.ts
scripts/check-routing-drift.ts
docs/routing/**
CLAUDE.md
libs/data/CLAUDE.md
```

### Read-only sources
```
docs/plan/memory-refactor/NX-GENERATOR-HANDOFF.md
libs/data/**/package.json
```

---

## Dependency graph summary

```
p0-baseline
  └─ audit-baseline
       └─ p1-layout
            └─ audit-layout
                 ├─ w2a-embedding-provider ─┐
                 └─ w2b-graph-store ────────┼─ w2c-vector-store ─┬─ w2d-analysis ──────┐
                                            └─ w2d-ingest ───────┘                     ├─ w2e-domain-rewire
                                                                  └─ w2d-hybrid-search ─┘
                                                                                              └─ audit-extraction
                                                                                                    └─ p4-routing
                                                                                                         └─ audit-routing
                                                                                                               └─ audit-final
```

---

## Package output summary

| Package | Path | Published | Npm name |
|---|---|---|---|
| `embedding-provider` | `libs/data/embed/embedding-provider/` | PUBLIC @0.x | `@adhd/sox-embedding-provider` |
| `vector-store` | `libs/data/vectors/vector-store/` | PUBLIC @0.x | `@adhd/sox-vector-store` |
| `graph-store` | `libs/data/graph/graph-store/` | PUBLIC @0.x | `@adhd/sox-graph-store` |
| `hybrid-search` | `libs/data/search/hybrid-search/` | PUBLIC @0.x | `@adhd/sox-hybrid-search` |
| `analysis` | `libs/data/analysis/analysis/` | PUBLIC @0.x | `@adhd/sox-analysis` |
| `ingest` | `libs/data/ingest/ingest/` | PRIVATE | `@adhd/sox-ingest` (not published) |
