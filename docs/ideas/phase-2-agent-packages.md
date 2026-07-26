# Audit: ADHD Agent Packages — Turso Adapter Compatibility

> **Spec reference:** `docs/ideas/turso-database-adapter.md` (the corrected architecture)  
> **Consumer:** `/Users/nix/dev/node/adhd/packages/agent/*` — 9 packages using `better-sqlite3` + `drizzle-orm`  
> **Date:** 2026-07-25  
> **Scope:** `package.json` scan + spec evaluation — no code exploration

---

## Dependencies Found

### Direct `better-sqlite3` (4 packages)
- `agent-core-env` — exports `openRegistryDb()`, returns `better-sqlite3.Database`
- `agent-engine-compiler`
- `agent-engine-orchestrator`
- `agent-store-runtime`

### `drizzle-orm` only (4 packages — no direct `better-sqlite3`)
- `agent-core-policy`
- `agent-core-provider`
- `agent-store-prompts`
- `agent-store-tools`

### Not affected (3 packages)
- `agent-base-types` — empty deps
- `agent-generator-plugin` — codegen tool, no DB
- `agent-plugin-budget`, `agent-plugin-sanitize` — pure logic, peer deps only

### No `@adhd/sox-*`, `@tursodatabase/database`, or `@libsql/client` deps found

---

## Key Architectural Observations

### Shared registry database

All 9 packages (except `agent-store-tools`) connect through `openRegistryDb()` in `agent-core-env`, which opens a single `registry.db` file. This means:

- They all share one connection pattern: `new Database(path)` → `drizzle(client)` → `BetterSQLite3Database<any>`
- A migration of `openRegistryDb()`'s return type propagates to every consumer simultaneously
- Any change must be coordinated across all 9 packages — partial adoption is not possible

### Drizzle coupling

Every store constructor takes `BetterSQLite3Database<any>` — a drizzle-orm type that wraps `better-sqlite3.Database`. The stores never touch `better-sqlite3` directly; they go through drizzle's query builder (`.select()`, `.insert()`, `.where()`).

The spec's `StoreAdapter` interface is not directly compatible with drizzle. Drizzle has its own driver adapters. The spec documents:
- `drizzle-orm/better-sqlite3` — works with `better-sqlite3.Database`
- `drizzle-orm/libsql` — works with `@libsql/client` (libSQL C fork — **not the target**)
- `drizzle-orm/tursodatabase/database` — **beta** adapter for `@tursodatabase/database` (the Rust rewrite), import: `drizzle-orm@rc`, API: `drizzle({ client })`

### Dependency topology

```
agent-core-env      ← owns openRegistryDb()
   ───┬───
Level 1   agent-core-policy      ← receives DB from openRegistryDb
           agent-core-provider    ← receives DB from openRegistryDb
           agent-store-prompts    ← receives DB from openRegistryDb
           agent-store-tools      ← standalone Drizzle (own connection)
           agent-store-runtime    ← mixes direct better-sqlite3 + Drizzle
              │
Level 2   agent-engine-compiler      ← imports Level 1 + agent-core-env
           agent-engine-orchestrator ← imports Level 1 + agent-core-env
```

---

## What the Spec Changes

The spec introduces `@adhd/sox-store-adapter` with:

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
| `drizzle(client)` (better-sqlite3) | `drizzle({ client })` (tursodatabase) |

---

## What Breaks

| Current pattern | Breaks on | Why |
|----------------|-----------|-----|
| `better-sqlite3.Database` type used everywhere | Phase 1 | `StoreAdapter` is a different interface — all type annotations referencing `better-sqlite3.Database` fail to compile |
| `drizzle(client)` construction | Phase 1 | `drizzle-orm/better-sqlite3` expects `better-sqlite3.Database`, not `StoreAdapter`. Must use `unwrap()` to extract the handle |
| Sync `openRegistryDb()` | Phase 1 | Spec's `createStoreAdapter` is async → callers need `await` |
| Sync `db.prepare().get()` | Phase 1 | All query methods are async (`Promise`-returning) → callers need `await` |
| `db.transaction(fn).immediate()` | Phase 1 | No `immediate()` in spec's `transaction()` — different locking model |
| `withImmediateRetry` / `Atomics.wait` | Phase 1 | Sync sleep pattern breaks with async adapter |
| `lastInsertRowid: number` | Phase 1 | Spec returns `number \| bigint` — union type may break strict comparisons |
| `drizzle-orm/better-sqlite3` import | Phase 2 | Must switch to `drizzle-orm/tursodatabase/database` (beta, `@rc` release) |
| `drizzle(client)` → `drizzle({ client })` | Phase 2 | Construction pattern differs between driver adapters |
| `@tursodatabase/database` not installed | Phase 2 | Must be added as explicit dependency (not transitive through store-adapter) |

---

## What's Gained

| Capability | From spec | Relevant to these packages? |
|-----------|-----------|---------------------------|
| **Multi-process writers** (`multiprocess_wal`) | Turso Database `.tshm` sidecar coordinates writers across processes | **Yes** — 5 agent packages write to the same `registry.db` concurrently |
| **Native async I/O** | io_uring / kqueue — non-blocking DB I/O | Yes — eliminates the sync-wrapped-Promise pattern |
| **Encryption at rest** | AEGIS-256, AES-256-GCM | Conditional — depends on whether registry stores secrets |
| **Built-in vectors** | `vector(N)` type, ANN indexes | No — these packages don't use vectors (vector-store is consumed from sox-ecosystem separately) |
| **MVCC / BEGIN CONCURRENT** | Row-level concurrency within a single process | Conditional — only relevant if a single process runs concurrent transactions |
| **ATTACH DATABASE** | Cross-DB queries | Future capability — not in v1 |

---

## Observations

1. **`openRegistryDb()` is the single point of change.** All 9 packages flow through it. If `openRegistryDb()` returns `StoreAdapter`, all consumers get the new interface simultaneously — no gradual migration possible within this package set.

2. **Drizzle coupling is the main friction point.** The stores use drizzle-orm's query builder, not raw SQL. The spec's `unwrap()` mechanism handles this: `(adapter as SqliteAdapter).unwrap()` → `better-sqlite3.Database` for Phase 1, then switch import to `drizzle-orm/tursodatabase/database` for Phase 2. The drizzle query API is identical end-to-end — only the import path and construction pattern change.

3. **`agent-store-tools` is the exception.** It has `@types/better-sqlite3` in devDeps but no direct `better-sqlite3` dep — suggesting the consumer provides it. If it creates its own connection independently, it wouldn't flow through `openRegistryDb()` and would need separate treatment.

4. **`agent-core-env` is the coordination bottleneck.** Because `openRegistryDb()` is the shared entrypoint, `agent-core-env` must migrate first. The other 8 packages can then migrate in parallel (Level 1) followed by Level 2.
