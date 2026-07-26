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
