# Audit: ADHD Backlog — Turso Adapter Compatibility

> **Spec reference:** `docs/ideas/turso-database-adapter.md` (the corrected architecture)  
> **Consumer:** `~/dev/node/adhd/entrypoint/backlog/` — `@adhd/backlog`  
> **Date:** 2026-07-25  
> **Scope:** Spec evaluation — no code exploration

---

## Current Database Setup

The consumer's `GraphBacklogStore` uses a two-handle pattern:

```
openGraphBacklogStore(dbPath):
  new Database(dbPath)       ──►  store.db: Database.Database
    set journal_mode = WAL              │
    createGraphBackend(db)   ──►  store.graph: GraphBackend
    set busy_timeout = N                │
                                   all business logic
```

**Load-bearing concurrency primitives:**

- **`db.transaction(fn).immediate()`** in `mutate-metadata` and `ids` — `BEGIN IMMEDIATE` acquires the RESERVED lock at transaction start, blocking other writers rather than interleaving. This is the sole CAS primitive, used by every metadata-mutating operation (claim, renew, release, citation, note, transition, priority, assignment, id allocation).
- **`withImmediateRetry()`** — synchronous (`Atomics.wait`), bounded exponential backoff on `SQLITE_BUSY`.

**Direct `store.db` usage is well-bounded** — only three sites outside the CAS pattern:
1. `crud.ts` L218–220: raw SQL to sync FTS `content_hash` (graph-store API gap)
2. `structure.ts` L47: raw SQL for `DELETE FROM edge` (graph-store API gap)
3. `graph-backlog-store.ts` L57–58: `close()`

**Every non-CAS operation** goes through `store.graph.*` (GraphBackend API).

**All store code is synchronous.** `client.ts` (the API surface) is already async, wrapping sync store calls.

---

## Dependencies

| Dependency | Role |
|-----------|------|
| `@adhd/sox-graph-store: ^0.3.0` | Graph DB — receives `better-sqlite3.Database` via constructor |
| `better-sqlite3: ^12.10.0` | Raw driver — direct `new Database()`, `db.prepare()`, `db.transaction().immediate()` |

---

## Key Observations

### 1. The CAS pattern is the defining architectural feature

The consumer is built around **`BEGIN IMMEDIATE`** — a SQLite-specific locking primitive that acquires the RESERVED lock at transaction start. This prevents TOCTOU between the initial read and the subsequent write within each metadata mutation. Every claim, release, transition, and id allocation depends on this.

The spec's `TursoAdapter` uses `BEGIN`/`COMMIT`/`ROLLBACK` (or `BEGIN CONCURRENT` with MVCC), neither of which provides `BEGIN IMMEDIATE` semantics. This is the fundamental behavioral difference:

| Locking model | Current (better-sqlite3) | Spec (TursoAdapter) |
|--------------|-------------------------|---------------------|
| Lock acquisition | At transaction start (`BEGIN IMMEDIATE`) | At commit time (`BEGIN CONCURRENT`) or unspecified (`BEGIN`) |
| Contention handling | Blocking — writer waits for RESERVED lock | Optimistic — retry on commit conflict |
| Retry mechanism | `busy_timeout` + `Atomics.wait` sleep | `isConcurrentConflict()` + application-level retry |

### 2. `@adhd/sox-graph-store` is a prerequisite

The consumer depends on `@adhd/sox-graph-store: ^0.3.0` which expects `constructor(db: Database.Database)`. The spec requires graph-store's constructor to change to `constructor(adapter: StoreAdapter)` (Segment B). Until sox-ecosystem ships that change, the consumer cannot adopt the adapter pattern regardless of anything they do on their side.

### 3. All store code is sync

Every database operation is synchronous. `client.ts` wraps sync calls in async methods. The spec's `StoreAdapter` interface is entirely async. This means every store function that currently returns inline results must become async and callers must `await`.

---

## What the Spec Changes

| Current pattern | Spec replacement |
|----------------|-----------------|
| `new Database(dbPath)` | `createStoreAdapter({ type: 'turso', dbPath })` |
| `db.pragma('journal_mode = WAL')` | `adapter.pragmaSet('journal_mode', 'WAL')` |
| `db.transaction(fn).immediate()` | `adapter.transaction(fn)` |
| `db.prepare(sql).get(args)` | `adapter.executeGet(sql, args)` |
| `db.prepare(sql).run(args)` | `adapter.executeRun(sql, args)` |
| `db.close()` | `adapter.close()` |
| `createGraphBackend(db)` | `createGraphBackend(adapter)` |

---

## What Breaks

| Current pattern | Breaks because | Severity |
|----------------|---------------|----------|
| `store.db.transaction(fn).immediate()` | Spec has no `immediate()` equivalent. `BEGIN IMMEDIATE` lock-acquire-at-start behavior doesn't map to `BEGIN CONCURRENT` (optimistic) or `BEGIN` (deferred). The consumer's entire concurrency model relies on this. | **HIGH** |
| `withImmediateRetry()` (`Atomics.wait`) | Sync sleep pattern breaks with async adapter. Must become async (`setTimeout` or spec's `withRetry`). | **MEDIUM** |
| All `db.prepare(sql).get/run()` calls | Sync → async. Every query site needs `await`. | **HIGH** (mechanical) |
| `openGraphBacklogStore()` sync | → returns `Promise<StoreAdapter>` | **MEDIUM** |
| `store.db: Database.Database` field type | → `store.adapter: StoreAdapter` | **MEDIUM** |
| `@adhd/sox-graph-store` constructor | Expects `Database.Database`, spec requires `StoreAdapter` | **BLOCKING** — sox-ecosystem must ship new version first |
| `lastInsertRowid: number` | → `number \| bigint` union | LOW |
| Concurrency tests (separate handles) | Create their own `better-sqlite3` handles → need `StoreAdapter` | MEDIUM |
| Raw SQL escape hatches | `store.db.prepare(...)` → `adapter.executeRun(...)` | LOW |

---

## What's Gained (from the spec)

| Capability | Spec feature | Relevant to backlog? |
|-----------|-------------|---------------------|
| **Multi-process writers** (`multiprocess_wal`) | `.tshm` sidecar coordinates writers across processes | **HIGH** — This consumer is designed for exactly this: multiple concurrent processes (agents, CLIs, MCP servers) writing to the same backlog graph. The current `BEGIN IMMEDIATE` + `busy_timeout` + `withImmediateRetry` is a workaround for SQLite's single-writer limitation. Turso's `multiprocess_wal` is the genuine solution. |
| **Native async I/O** | io_uring/kqueue — non-blocking DB I/O | MEDIUM — Eliminates the `Atomics.wait` hack |
| **Encryption at rest** | AEGIS-256 | LOW — Not currently a requirement |
| **Adapter pattern** | Engine is a config choice | MEDIUM — Rollback at env-var level |

---

## Observations

1. **This consumer is the most reliant on the spec delivering real multiprocess-writer support.** The `BEGIN IMMEDIATE` + retry pattern is a workaround for a problem Turso's `multiprocess_wal` solves natively. If the spec delivers that, this consumer's core architectural constraint is eliminated.

2. **The `BEGIN IMMEDIATE` → `BEGIN CONCURRENT` gap is the hardest break.** The consumer's CAS pattern acquires the lock upfront to prevent TOCTOU. `BEGIN CONCURRENT` defers conflict detection to commit time. These are fundamentally different concurrency models. The retry logic around `isConcurrentConflict()` must be correct under contention or the consumer gets silent conflicts.

3. **Blocked on sox-ecosystem.** The consumer cannot start any migration until `@adhd/sox-graph-store` ships a version accepting `StoreAdapter`. This is a dependency the consumer doesn't control.

4. **Bounded direct DB usage.** Only three call sites bypass `store.graph.*` — two raw SQL escape hatches and `close()`. The rest of the DB access is through GraphBackend API, which sox-ecosystem refactors.

5. **Client API is already async.** `client.ts` wraps sync store calls with `Promise<T>`. The store migration (sync→async) is absorbed by already-async callers. No API surface breakage for external consumers of the backlog.
