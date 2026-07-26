# Audit: Agent-MCP Authoring — Turso Adapter Compatibility

> **Spec reference:** `docs/ideas/turso-database-adapter.md` (the corrected architecture)  
> **Consumer:** `/Users/nix/dev/node/adhd/docs/plan/agent-mcp-authoring` — Plan 8 of 9: discovery+authoring MCP lane  
> **Date:** 2026-07-25  
> **Scope:** Spec evaluation + plan document review — no code exploration

---

## Current Database Architecture

The plan involves **3 separate SQLite databases** across **2 access patterns**:

### 1. Operational DB (`~/.adhd/agent-mcp/production/data/agents.db`)
- **Entry point:** `entrypoint/agent-mcp/src/db/client.ts`
- **Pattern:** `new Database(path)` → `drizzle(sqlite, { schema })` → `BetterSQLite3Database`
- **Consumers in plan:** SessionStore, TaskStore, AgentStore, UsagePlugin, DagEngine
- **Tables:** sessions, messages, tasks, task_events, task_usage, agents
- **Coupled to:** `better-sqlite3` at the driver level, `drizzle-orm/better-sqlite3` at the store level

### 2. Registry DB (`~/.adhd/agent-registry/production/data/registry.db`)
- **Entry point:** `@adhd/agent-core-env` → `openRegistryDb()` → `better-sqlite3.Database`
- **Pattern:** Shared across 5 registry-family packages (provider, prompts, tools, policy, compiler)
- **Coupled to:** `better-sqlite3` + `drizzle-orm/better-sqlite3`

### 3. Vector store (from sox packages)
- **Pattern:** `openVectorStore(path, {dim, modelId})` via `@adhd/sox-vector-store`
- **Uses:** `better-sqlite3` + sqlite-vec
- **Not a drizzle user** — direct SQL through sox-ecosystem's vector-store package

### sox package consumption

| Package | Status | DB engine |
|---------|--------|-----------|
| `@adhd/sox-vector-store` | Published 0.1.0 | better-sqlite3 + sqlite-vec |
| `@adhd/sox-graph-store` | Not yet published | better-sqlite3 + drizzle-orm |
| `@adhd/sox-hybrid-search` | Not yet published | Consumes graph-store + vector-store |
| `@adhd/sox-embedding-provider` | Published 0.1.0 | None |
| `@adhd/sox-ingest` | Published 0.1.0 | None |
| `@adhd/sox-store-adapter` | **Does not exist yet** | *This is the spec* |

---

## Key Observations

### Drizzle coupling — three layers deep

Every store constructor takes `BetterSQLite3Database<any>` — a drizzle-orm wrapper type, not a raw `better-sqlite3.Database`. The stack is:

```
better-sqlite3.Database  ← raw driver
    ↓
drizzle-orm/better-sqlite3  ← wraps with typed query builder
    ↓
BetterSQLite3Database<any>  ← what every Store constructor takes
```

`openRegistryDb()` returns `better-sqlite3.Database`, which is immediately wrapped with `drizzle(registrySqlite)` at every call site. There is no abstraction layer between stores and better-sqlite3.

### Drizzle driver compatibility

The spec documents two relevant drizzle drivers:
- **`drizzle-orm/better-sqlite3`** — works with `better-sqlite3.Database`. Current.
- **`drizzle-orm/tursodatabase/database`** — **beta** (`drizzle-orm@rc`). Works with `@tursodatabase/database`. Import: `drizzle('sqlite.db')` or `drizzle({ client })`. Separate from `drizzle-orm/libsql` (which wraps the libSQL C fork, not the target).

### Two databases, two coupling levels

| Database | Entry point | Drizzle coupled? | Can migrate independently? |
|----------|------------|-----------------|---------------------------|
| Operational DB | `db/client.ts` (in-package) | Yes | Yes — but shares drizzle pattern with registry |
| Registry DB | `openRegistryDb()` (agent-core-env) | Yes | No — 5 packages share this entry point |
| Vector store | `openVectorStore()` (sox package) | No | Yes — sox package upgrade |

The registry DB is the bottleneck: 5 packages all flow through `openRegistryDb()`, and all use `drizzle-orm/better-sqlite3`. Any change to the connection type propagates to all consumers simultaneously.

---

## What the Spec Changes

The spec's `StoreAdapter` interface replaces `better-sqlite3.Database` as the connection type. Key mappings:

| Current pattern | Spec replacement |
|----------------|-----------------|
| `new Database(path)` | `createStoreAdapter({ type: 'turso', dbPath: path })` |
| `db.prepare(sql).get(...)` | `adapter.executeGet<T>(sql, args)` |
| `db.prepare(sql).all(...)` | `adapter.executeAll<T>(sql, args)` |
| `db.prepare(sql).run(...)` | `adapter.executeRun(sql, args)` |
| `db.exec(sql)` | `adapter.exec(sql)` |
| `db.transaction(() => {...})` | `adapter.transaction(tx => {...})` |
| `db.pragma(...)` | `adapter.pragmaSet/Get(...)` |
| `drizzle(client)` (better-sqlite3) | `drizzle({ client })` (tursodatabase via `drizzle-orm/tursodatabase/database`) |
| `adapter.unwrap()` | Returns underlying driver handle for escape-hatch use (sqlite-vec loading, drizzle construction) |

---

## What Breaks

### Phase 1 — SqliteAdapter (same engine, adapter wrapper)

| Current pattern | Breaks because | Cascade |
|----------------|---------------|---------|
| `new Database(path)` | → `createStoreAdapter()` is async | Every `openRegistryDb()` call site needs `await` |
| `db.prepare(sql).get(...)` | → `adapter.executeGet(...)` is async | Every query site needs `await` |
| `db.transaction(...)` | → `adapter.transaction(tx => {...})` different signature | Callback receives `tx` object, not `db` |
| `BetterSQLite3Database<any>` constructor param | → `StoreAdapter` is incompatible type | All 8+ store classes must change constructor type |
| `drizzle(client)` construction | `drizzle-orm/better-sqlite3` expects `better-sqlite3.Database`, not `StoreAdapter` | Must use `(adapter as SqliteAdapter).unwrap()` for the handle |
| Sync `openRegistryDb()` | → returns `Promise<StoreAdapter>` | Every caller needs `await` |
| `db.pragma()` calls | → `adapter.pragmaSet/Get(...)` | Minor method rename |
| `db.close()` | → `adapter.close()` | Minor method rename |
| `withImmediateRetry` / `Atomics.wait` | Async adapter breaks sync sleep pattern | Retry logic must change |
| `lastInsertRowid: number` | → `number \| bigint` union | May break strict comparisons |

### Phase 2 — TursoAdapter (new engine)

| Current pattern | Breaks because | Cascade |
|----------------|---------------|---------|
| `drizzle-orm/better-sqlite3` import | → must switch to `drizzle-orm/tursodatabase/database` (beta, `@rc`) | Import path + construction pattern change across 5 packages |
| `drizzle(client)` | → `drizzle({ client })` object-shorthand | One-line change per drizzle instance |
| `better-sqlite3.Database` type assumptions | → `@tursodatabase/database.Database` | Any code narrowing on better-sqlite3-specific types |
| `@tursodatabase/database` not installed | Must be added as explicit dependency | `pnpm add` in each consuming package |

---

## What's Gained (from the spec)

| Capability | Spec feature | Relevant to this plan? |
|-----------|-------------|----------------------|
| **Multi-process writers** (`multiprocess_wal`) | Turso Database `.tshm` sidecar coordinates writers across processes | **Yes** — multiple agent-mcp instances writing to the same registry DB |
| **Native async I/O** | io_uring / kqueue — non-blocking DB I/O | Yes — eliminates sync-wrapped-Promise pattern |
| **Built-in vectors** | `vector(N)` type, ANN indexes | **Yes** — `@adhd/sox-vector-store` gains this through sox package upgrade |
| **Encryption at rest** | AEGIS-256 | Conditional — depends on data sensitivity |
| **ATTACH DATABASE** | Cross-DB queries | Future capability — not in v1 |

---

## Observations

1. **`@adhd/sox-store-adapter` doesn't exist yet.** This plan is blocked on sox-ecosystem delivering it (Segment A of the spec) plus the consumer package refactors (Segments B-G). The plan's 13 states are all `"pending"` — there's time to sequence the dependency.

2. **The vector store is the easiest path.** `@adhd/sox-vector-store` is a published sox package. When it's refactored to accept `StoreAdapter`, ADHD upgrades the dep and gains Turso's native vector support with zero ADHD code changes.

3. **The registry DB is the coordination challenge.** 5 packages all flow through `openRegistryDb()` in `agent-core-env`. The migration of `openRegistryDb()`'s return type from `better-sqlite3.Database` to `StoreAdapter` must happen atomically across all consumers.

4. **Drizzle can be retained through both phases** via `unwrap()` + import path swap (`drizzle-orm/better-sqlite3` → `drizzle-orm/tursodatabase/database`). The beta status of `drizzle-orm/tursodatabase/database` (`@rc` release) means the Phase 2 Drizzle path is unproven for this project's patterns.

5. **The operational DB is independent** — its connection is created in `db/client.ts` within the plan's own package, not through `openRegistryDb()`. It can migrate on its own timeline, separate from the registry DB.
