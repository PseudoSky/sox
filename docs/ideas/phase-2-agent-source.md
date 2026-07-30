# Audit: Agent-Source — Turso Adapter Compatibility

> **Spec reference:** `docs/ideas/turso-database-adapter.md` (the corrected architecture)  
> **Consumer:** `/Users/nix/dev/ai/agent-source` — ASP (Approved Source Platform), a governed-session agent lifecycle platform  
> **Date:** 2026-07-25  
> **Scope:** Spec evaluation + package.json/directory structure review — no code exploration

---

## Dependencies Found

| Dependency | Type | How consumed |
|-----------|------|-------------|
| `@adhd/sox-graph-store` | `file:` local | graph DB — receives `better-sqlite3.Database` via constructor |
| `@adhd/sox-vector-store` | `file:` local | vector search — receives `Database.Database`, uses sqlite-vec |
| `@adhd/sox-blob-store` | `file:` local | blob storage — opens own `better-sqlite3` connection |
| `@adhd/sox-task-queue` | `file:` local | task scheduling — opens own `better-sqlite3` connection |
| `@adhd/sox-hybrid-search` | `file:` local | hybrid search — reads from graph/vector stores |
| `@adhd/sox-ingest` | `file:` local | ingestion pipeline — reads/writes stores |
| `@adhd/sox-embedding-provider` | `file:` local | embedding generation — writes to vector store |
| `@adhd/sox-claim-verification` | `file:` local | P3 claim verification |
| `@adhd/sox-source-provider` | `file:` local | source document provider |
| `@adhd/sox-manifest` | `file:` local | manifest management |
| `better-sqlite3` | direct dep (npm) | raw `better-sqlite3` for direct DB access |
| `@types/better-sqlite3` | devDep | type support |

**Does NOT consume:** `@adhd/sox-memory-core`, `@adhd/sox-store-adapter` (doesn't exist yet), `@tursodatabase/database`, `@libsql/client`

---

## Architecture

**Monorepo type:** nx/pnpm, all sox packages linked via `file:` protocol (windows to the sox-ecosystem checkout)

**Databases on disk:** `data/agents.db` (WAL+SHM), `data/registry.db` (WAL+SHM)

**Delivery surfaces:** HTTP server (`/agent/sessions`, `/agent/search`), MCP server (`asp_search`, `asp_get`), CLI (`asp`), wired through a gateway composing P2 (search/catalog) and P3 (session/claim/output lifecycle) services.

**Database access pattern:** Mixed — some packages receive `better-sqlite3.Database` via constructor (graph-store, vector-store via sox), others open their own connections (blob-store, task-queue), and the application has its own direct `better-sqlite3` calls.

---

## Key Observations

### 1. Pure sox-package consumer

Unlike the ADHD agent packages (which use drizzle-orm internally), agent-source consumes sox-ecosystem **published packages** as `file:` deps. This means:

- The sox packages control the DB access pattern
- When sox-ecosystem refactors graph-store, vector-store, blob-store, etc. to accept `StoreAdapter` (Segments B-E of the spec), agent-source upgrades the dep — the change is in the dependency, not in agent-source's own store code
- Agent-source's own code that directly calls `better-sqlite3` is separate from the sox-package-mediated paths

### 2. No drizzle coupling

None of agent-source's declared deps include `drizzle-orm`. The sox packages (graph-store, vector-store) use raw `better-sqlite3` or sqlite-vec internally. When they're refactored to accept `StoreAdapter`, agent-source won't face the Drizzle migration problem that the ADHD agent packages face.

### 3. Mixed connection ownership

| Pattern | Packages | Migration path |
|---------|----------|---------------|
| Receives `better-sqlite3.Database` via constructor | graph-store, vector-store, hybrid-search | Constructor changes to `StoreAdapter` — agent-source changes the type at the call site |
| Opens own `better-sqlite3` connection | blob-store, task-queue | Replace `new Database(dbPath)` with `createSqliteAdapter({ dbPath })` — sox package change, not agent-source's |
| Direct `better-sqlite3` calls | Agent-source's own code | Agent-source must migrate these — `db.prepare()` → `adapter.execute*()` |

---

## What the Spec Changes

The spec's `StoreAdapter` interface and factory change how connections are created and queries are made:

| Current pattern | Spec replacement |
|----------------|-----------------|
| `new Database(path)` | `createStoreAdapter({ type: 'turso', dbPath: path })` |
| `db.prepare(sql).get(...)` | `adapter.executeGet<T>(sql, args)` |
| `db.prepare(sql).all(...)` | `adapter.executeAll<T>(sql, args)` |
| `db.prepare(sql).run(...)` | `adapter.executeRun(sql, args)` |
| `db.exec(sql)` | `adapter.exec(sql)` |
| `db.transaction(() => {...})` | `adapter.transaction(tx => {...})` |
| `db.pragma(...)` | `adapter.pragmaSet/Get(...)` |
| `db.close()` | `adapter.close()` |
| `graphStore = createGraphBackend(db)` | `graphStore = createGraphBackend(adapter)` |
| `sqliteVec.load(db)` | `sqliteVec.load((adapter as SqliteAdapter).unwrap())` (SQLite only) |

---

## What Breaks

### From sox-package constructor changes

| Agent-source wiring code | Breaks because | Current pattern |
|------------------------|----------------|-----------------|
| `createGraphBackend(db)` | Constructor changes from `Database.Database` to `StoreAdapter` | `const db = new Database(path); createGraphBackend(db)` |
| `openVectorStore(path, opts)` | Factory change | Currently returns sqlite-vec backed backend |
| `createBlobStore({ refDbPath })` | Config adds `adapter?: StoreAdapter` | Currently opens its own better-sqlite3 |
| `createTaskQueue({ dbPath })` | Config adds `adapter?: StoreAdapter` | Currently opens its own better-sqlite3 |
| `createHybridSearch(...)` | Underlying stores change type | Currently consumes graph-store + vector-store |

### From agent-source's own `better-sqlite3` calls

| Pattern | Breaks because | Cascade |
|---------|---------------|---------|
| `new Database(path)` | → `createStoreAdapter(...)` is async | Add `await` |
| `db.prepare(sql).get(...)` | → `adapter.executeGet(...)` is async | Add `await` |
| `db.transaction(() => {...})` | → `adapter.transaction(tx => {...})` | Callback receives `tx` not `db` |
| `db.pragma(...)` | → `adapter.pragmaSet/Get(...)` | Method rename |
| `lastInsertRowid: number` | → `number \| bigint` | Union type |

### From engine swap (Phase 2)

| Pattern | Breaks because | Cascade |
|---------|---------------|---------|
| `sqliteVec.load(db)` | Turso doesn't support C extensions | Must narrow: `if (adapter.config.type === 'sqlite')` |
| sqlite-vec `vec0` tables | Turso uses `vector(N)` column type instead | Vector indexes must be rebuilt |
| `@tursodatabase/database` not installed | Must be added as explicit dependency | `pnpm add` |

---

## What's Gained (from the spec)

| Capability | Spec feature | Relevant to agent-source? |
|-----------|-------------|--------------------------|
| **Multi-process writers** (`multiprocess_wal`) | Turso Database `.tshm` sidecar coordinates writers across processes | **Yes** — CLI, HTTP server, and MCP server could each run as independent processes writing to the same DB |
| **Native async I/O** | io_uring / kqueue | Yes — eliminates sync-wrapped-Promise pattern across all query sites |
| **Built-in vectors** | `vector(N)` type, ANN indexes | **Yes** — `@adhd/sox-vector-store` gains this through sox package upgrade, agent-source uses vector search for component discovery |
| **Encryption at rest** | AEGIS-256 | Conditional — depends on whether agent data requires encryption |
| **Adapter pattern** | Engine is a config choice | `STORE_ADAPTER=sqlite` rollback at any time |

---

## Observations

1. **Agent-source is the simplest consumer of the three audited.** It has no drizzle coupling, all DB access goes through sox packages (which migrate as part of the spec), and its own direct `better-sqlite3` calls are bounded.

2. **The migration is mostly a sox-package upgrade.** When sox-ecosystem ships `@adhd/sox-store-adapter` and refactors graph-store, vector-store, blob-store, etc., agent-source's primary change is updating its composition root to pass `StoreAdapter` instead of `better-sqlite3.Database`. The heavy lifting is in sox-ecosystem, not agent-source.

3. **Direct `better-sqlite3` calls need auditing.** Agent-source's `package.json` declares `better-sqlite3` as a direct dependency and `@types/better-sqlite3` as a devDep, suggesting it has code that bypasses sox packages and calls `better-sqlite3` directly. Every such call site needs migration to `adapter.execute*()`.

4. **Three delivery surfaces share the same DB.** HTTP server, MCP server, and CLI all write to `data/agents.db`. This is the exact multi-process writer pattern Turso's `multiprocess_wal` is designed for — the `.tshm` sidecar coordinates writers across these three surfaces.

---

## Optimized Execution Plan

> **Scope:** External consumer at `/Users/nix/dev/ai/agent-source`. The sox-ecosystem side (store-adapter package + data package refactoring) is owned by `docs/ideas/turso-database-adapter.md` — this plan covers only the agent-source changes required once Segments A–H of the spec are shipped.

### Prerequisites

- `@adhd/sox-store-adapter` published to registry (or available via local `file:` dep matching sox-ecosystem's checked-out revision)
- `@adhd/sox-graph-store`, `@adhd/sox-vector-store`, `@adhd/sox-blob-store`, `@adhd/sox-task-queue` all upgraded to versions accepting `StoreAdapter`
- `@adhd/sox-hybrid-search` upgraded to accept `StoreAdapter` from its dependency stores
- `@tursodatabase/database` available on npm (v0.7+)

### Migration difficulty: **SIMPLE** (no drizzle, all DB through sox packages)

### Dependency graph

```
SA-BUILD (sox-ecosystem completes Segments A–H — prerequisite, not agent-source work)
    │
    └── AS-AUDIT ──► AS-DEPS ──► AS-COMPOSITION ──► AS-DIRECT-DB ──► AS-VECTOR ──► AS-TESTS
            │                       │                                    │
            │         ┌─────────────┘                                    │
            │         ▼                                                  │
            │    AS-DIRECT-DB-AUDIT    ──►  AS-DIRECT-DB-MIGRATE          │
            │    (sub-packet of AS-AUDIT)   (sub-packet of AS-DIRECT-DB)  │
            │                                                             │
            └──────────────────── REVIEW ────◄────────────────────────────┘
                                                                        │
                                                                   AS-SMOKE
```

**Critical path:** AS-AUDIT → AS-DEPS → AS-COMPOSITION → AS-DIRECT-DB → AS-VECTOR → AS-TESTS → AS-SMOKE

**Total packets:** 10 (7 code + 2 review + 1 smoke gate)

---

### Packet: AS-AUDIT

- **Prompt (~500 tok):** Audit the entire agent-source codebase for every `better-sqlite3` direct usage. Search all `src/`, `lib/`, `extensions/`, `bin/` directories. Classify each call site:
  1. **Constructor injection sites** — files that create `new Database(path)` and pass the handle to sox packages (`createGraphBackend(db)`, `openVectorStore(path, opts)`, `createBlobStore({ refDbPath })`, `createTaskQueue({ dbPath })`, `createHybridSearch(...)`)
  2. **Direct DB calls** — files that call `db.prepare()`, `.get()`, `.all()`, `.run()`, `.exec()`, `.pragma()`, `.transaction()`, `.close()`, `sqliteVec.load()` directly
  3. **Type references** — files that type-import `Database.Database` from `better-sqlite3`
  4. **Test files** — files that create `new Database(':memory:')`
- **Reserved files:** (read-only audit — no changes)
- **Output:** `docs/migration-turso-audit.md` with per-file classified call sites
- **Input tokens:** ~500 (instruction) + ~2000 (reads all relevant source files via grep + file reads)
- **Output tokens:** ~300 (markdown audit report)
- **Gate:** Verify audit report's 4 classification categories are populated

---

### Packet: AS-DEPS

- **Prompt (~350 tok):** Update `package.json` to add Turso adapter dependencies and upgrade sox packages.

  **Changes:**
  - Add `"@adhd/sox-store-adapter": "^1.0.0"` to `dependencies`
  - Add `"@tursodatabase/database": "^0.7.1"` to `dependencies` (Turso runtime)
  - Add `"@tursodatabase/database": { "optional": true }` or peer dep so consuming packages that don't use Turso aren't forced
  - Update `"@adhd/sox-graph-store"` to the new version (must accept `StoreAdapter`)
  - Update `"@adhd/sox-vector-store"` to the new version
  - Update `"@adhd/sox-blob-store"` to the new version
  - Update `"@adhd/sox-task-queue"` to the new version
  - Update `"@adhd/sox-hybrid-search"` to the new version
  - Keep `"better-sqlite3"` in deps — SqliteAdapter still requires it. Optional if agent-source only uses SqliteAdapter transitively through sox packages.
  - Run `pnpm install`

  **Reads before edit:**
  - `package.json` (to understand existing dependency tree)
  - `pnpm-lock.yaml` (to understand transitive resolutions)

- **Reserved files:**
  - `package.json`
  - `pnpm-lock.yaml` (auto-generated by `pnpm install`)

- **Depends on:** AS-AUDIT (know which sox packages are used)
- **Input tokens:** ~350 (instruction) + ~200 (reads package.json)
- **Output tokens:** ~100
- **Gate:** `pnpm install` exits 0; `node -e "require('@adhd/sox-store-adapter')"` resolves

---

### Packet: AS-COMPOSITION

- **Prompt (~600 tok):** Migrate agent-source's composition root — the code that creates database connections and wires them into sox packages. This is typically in a `src/db.ts`, `src/services.ts`, or `src/gateway.ts` file.

  **Changes per site classification from AS-AUDIT:**

  | Current | After |
  |---------|-------|
  | `const db = new Database(dbPath);` | `const adapter = await createStoreAdapter({ type: 'turso', dbPath });` |
  | `createGraphBackend(db)` | `createGraphBackend(adapter)` |
  | `openVectorStore(path, opts)` | `openVectorStore({ adapter })` |
  | `createBlobStore({ refDbPath })` | `createBlobStore({ adapter })` |
  | `createTaskQueue({ dbPath })` | `createTaskQueue({ adapter })` |
  | `createHybridSearch(...)` | works unchanged — underlying stores already adapted |
  | `db.close()` | `await adapter.close()` |

  **Rules:**
  - All dependencies (HTTP server, MCP server, CLI) receive `StoreAdapter`, not `Database.Database`
  - For multi-process writer support: set `experimental: { multiprocessWal: true }` in the `createStoreAdapter` call
  - Each of the 3 delivery surfaces (CLI, HTTP, MCP) calls `createStoreAdapter()` independently — they each get their own adapter to the same `dbPath`; WAL handles concurrent readers, `.tshm` sidecar coordinates writers
  - If a surface previously received a single shared `db` singleton, replace with each surface creating its own adapter
  - The `STORE_ADAPTER` env var controls engine selection (default: `'turso'`); `'sqlite'` for rollback

- **Reserved files:** (classified by AS-AUDIT — files containing constructor injection sites)
  - `src/db.ts` (expected — composition root)
  - `src/services/gateway.ts` (expected — wires dependencies)
  - `src/http-server/index.ts` (expected — receives adapter)
  - `src/mcp-server/index.ts` (expected — receives adapter)
  - `bin/asp-cli.ts` (expected — receives adapter)
  - (any additional files identified by AS-AUDIT)

- **Depends on:** AS-DEPS
- **Input tokens:** ~600 (instruction) + ~2000 (reads all composition root files)
- **Output tokens:** ~800
- **Gate:** `npx nx build` passes (if nx monorepo) or `node -e "require('./dist/main')"` loads without type errors on `StoreAdapter` interface

---

### Packet: AS-DIRECT-DB

- **Prompt (~700 tok):** Migrate every direct `better-sqlite3` call site in agent-source's own code (bypassing sox packages). Use the AS-AUDIT classification as the source of truth.

  **Mechanical transformations:**

  | Before | After |
  |--------|-------|
  | `const db = new Database(path)` | `const adapter = await createStoreAdapter({ type: 'turso', dbPath: path })` |
  | `db.prepare(sql).get(args)` | `await adapter.executeGet<T>(sql, args)` |
  | `db.prepare(sql).all(args)` | `await adapter.executeAll<T>(sql, args)` |
  | `db.prepare(sql).run(args)` | `await adapter.executeRun(sql, args)` |
  | `db.exec(sql)` | `await adapter.exec(sql)` |
  | `db.pragma('journal_mode = WAL')` | `await adapter.pragmaSet('journal_mode', 'WAL')` |
  | `db.transaction(fn)` | `await adapter.transaction(fn)` |
  | `db.transaction(fn).immediate()` | `await adapter.transaction(fn, { mode: 'immediate' })` |
  | `db.transaction(fn).deferred()` | `await adapter.transaction(fn, { mode: 'deferred' })` |
  | `db.close()` | `await adapter.close()` |
  | `lastInsertRowid as number` | `lastInsertRowid as number \| bigint` |
  | `function foo(db: Database.Database)` | `function foo(adapter: StoreAdapter)` |
  | `import Database from 'better-sqlite3'` | `import type { StoreAdapter } from '@adhd/sox-store-adapter'` |

  **Lock-in rules for `transaction()`:**
  - If the existing call uses `.immediate()` → `{ mode: 'immediate' }` (CAS semantics — lock RESERVED at start)
  - If the existing call uses `.deferred()` → `{ mode: 'deferred' }` (lock on first write)
  - If the existing call is bare `.default()` or `()` → `{ mode: 'deferred' }` (safe default)
  - Agent-source should NOT use `mode: 'concurrent'` unless it has explicit MVCC workload — `'concurrent'` is Turso-only and SqliteAdapter throws

  **Scan for `typeof Database` / `Database.Database` / `better-sqlite3.Database`** — replace every type annotation with `StoreAdapter`.

- **Reserved files:** (all files identified by AS-AUDIT category 2 — direct DB calls)
  - Usually 3–10 files; exact set from AS-AUDIT output
- **Depends on:** AS-AUDIT, AS-COMPOSITION
- **Input tokens:** ~700 (instruction) + ~500 (reads each classified file)
- **Output tokens:** variable, proportional to call site count (typically ~300–600)
- **Gate:** `npx nx build` passes; verify zero remaining `better-sqlite3` references in source (not test) files via grep

---

### Packet: AS-VECTOR

- **Prompt (~350 tok):** Migrate `sqliteVec.load(db)` calls to the adapter-native vector dialect.

  **Changes:**
  - Find all `import * as sqliteVec from 'sqlite-vec'` call sites
  - Replace with engine-narrowed activation:
    ```typescript
    import { sqliteVec } from 'sqlite-vec';
    import type { StoreAdapter, SqliteAdapter } from '@adhd/sox-store-adapter';

    // In initialization:
    if (adapter.config.type === 'sqlite') {
      const raw = (adapter as SqliteAdapter).unwrap();
      sqliteVec.load(raw);
    }
    // Turso handles vector initialization natively — no activation needed
    ```
  - Remove `sqlite-vec` from direct `dependencies` if it was one; sox-ecosystem's vector-store now handles dialect selection
  - Verify no `sqlite-vec` calls remain outside the type-narrowed guard

- **Reserved files:** (files identified by AS-AUDIT category 2 that contain `sqliteVec.*`)
- **Depends on:** AS-AUDIT (identifies exact files), AS-DEPS (adapter package available)
- **Input tokens:** ~350 (instruction) + ~300 (reads each classified vector file)
- **Output tokens:** ~100–200
- **Gate:** `npx nx build` passes with `sqlite-vec` import only behind type guard

---

### Packet: REVIEW-AS

- **Prompt (~450 tok):** Validate agent-source migration. Read-only review of all changed files.

  **Checklist:**
  1. **Zero `better-sqlite3.Database` or `Database.Database` type annotations** remain in source files (test files exempted for now — covered in AS-TESTS)
  2. **Zero `new Database(` calls** remain outside test files
  3. **Every `db.prepare()` call** replaced with `adapter.executeGet|All|Run()`
  4. **Every `db.exec()` call** replaced with `adapter.exec()`
  5. **Every `db.transaction()` call** has explicit `{ mode: ... }` where `transaction(fn).immediate()` was the pattern
  6. **`sqliteVec.load()`** is behind `adapter.config.type === 'sqlite'` guard
  7. **`openRegistryDb()` or equivalent** returns `Promise<StoreAdapter>` and all callers `await`
  8. **3 delivery surfaces each get their own adapter** — no shared singleton (shared file path is fine; WAL handles it)
  9. **`multiprocessWal`** is opted into via `experimental: { multiprocessWal: true }` if agent-source needs it
  10. **No drizzle imports changed** (agent-source has no drizzle — confirm)
  11. **`package.json`** has `@adhd/sox-store-adapter` and `@tursodatabase/database` deps; `better-sqlite3` retained for SqliteAdapter

- **Reserved files:** (read-only — all changed files)
- **Depends on:** AS-VECTOR (all code migration packets complete)
- **Scheduled in:** After AS-VECTOR, before AS-TESTS (finds issues before test migration)
- **Input tokens:** ~450 (instruction) + ~3000 (reads all changed source files)
- **Output tokens:** ~200 (review report: pass/fail per checklist item)

---

### Wave: Tests (AS unit test migration — 2 packets fully parallel)

#### Packet: AS-TESTS-UNIT

- **Prompt (~400 tok):** Migrate all unit test files that use `better-sqlite3` directly.

  **Changes per file:**
  - `import Database from 'better-sqlite3'` → `import { createSqliteAdapter, MockAdapter } from '@adhd/sox-store-adapter'`
  - `new Database(':memory:')` → `createSqliteAdapter({ dbPath: ':memory:' })` or `new MockAdapter()`
  - For tests that test sox packages (graph-store, vector-store, etc.): pass `MockAdapter` or `createSqliteAdapter()` — sox packages now accept `StoreAdapter`
  - For tests testing agent-source's own DB code: every `db.prepare(...)` → `await adapter.execute*(...)`
  - For concurrency tests: replace `Atomics.wait` with `await new Promise(r => setTimeout(r, N))`
  - For tests using `sqliteVec.load()`: add type-narrowed guard if needed, or use `MockAdapter` which doesn't require vec loading

  **Files to migrate:**
  - All test files identified by AS-AUDIT category 4

- **Reserved files:** Test files matching `**/*.spec.ts`, `**/*.test.ts`, `**/*.test.tsx`
- **Depends on:** REVIEW-AS (code issues fixed before test migration)
- **Input tokens:** ~400 (instruction) + ~1500 (reads all test files)
- **Output tokens:** ~800 (proportional to test count)
- **Gate:** `npx vitest run` or `npm test` passes (depending on test runner)

#### Packet: AS-SMOKE

- **Prompt (~300 tok):** End-to-end smoke verification of the migration.

  **Steps:**
  1. `STORE_ADAPTER=sqlite` — run the full test suite. All tests must pass. This validates the SqliteAdapter fallback works correctly.
  2. `STORE_ADAPTER=turso` — run the full test suite. All tests must pass. This validates TursoAdapter integration works correctly.
  3. Multi-process write test: Start HTTP server + MCP server + CLI writing to the same `agents.db`. Verify no `SQLITE_BUSY` errors under concurrent writes. Use `experimental: { multiprocessWal: true }`.
  4. Vector search: Verify vector search works under both adapter backends.
  5. Rollback test: Set `STORE_ADAPTER=sqlite`, verify all features work (proves migration can be rolled back without code changes).
  6. Regression: Verify no `better-sqlite3` imports remain in source (grep).

- **Reserved files:** (read-only — verification only)
- **Depends on:** AS-TESTS-UNIT
- **Input tokens:** ~300 (instruction) + ~500 (reads test output)
- **Output tokens:** ~100 (smoke test result)

---

### Parallelism summary

| Wave | Packets | Max parallel | Depends on |
|------|---------|-------------|------------|
| **Prep** | AS-AUDIT | 1 | — |
| **Deps** | AS-DEPS | 1 | AS-AUDIT |
| **Code** | AS-COMPOSITION, AS-DIRECT-DB, AS-VECTOR | 1 (sequential — each changes overlapping call sites) | AS-DEPS |
| **Review** | REVIEW-AS | 1 | AS-VECTOR |
| **Tests** | AS-TESTS-UNIT | 1 | REVIEW-AS |
| **Smoke** | AS-SMOKE | 1 | AS-TESTS-UNIT |

**Note on parallelization:** Unlike the ADHD agent packages (which have disjoint store classes in separate packages), agent-source's DB access is centralized in a single composition root + direct DB calls in the same codebase. The migration must be sequential within agent-source because files share type references. Parallelization is limited to 1 active packet at a time.

**Total estimated output tokens:** ~2600  
**Total input tokens:** ~7500 (reads across all files)  
**Sequential chain depth:** 6 hops (AS-AUDIT → AS-DEPS → AS-COMPOSITION → AS-DIRECT-DB → AS-VECTOR → REVIEW-AS → AS-TESTS-UNIT → AS-SMOKE)
