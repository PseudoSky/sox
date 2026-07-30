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

---

## Optimized Execution Plan

> **Scope:** External consumer at `~/dev/node/adhd/entrypoint/backlog/`. The sox-ecosystem side (store-adapter package + graph-store `StoreAdapter` constructor) is owned by `docs/ideas/turso-database-adapter.md` — this plan covers only the backlog changes required once the spec's Segment A (store-adapter) and Segment B (graph-store) are shipped.

### Prerequisites

- `@adhd/sox-store-adapter` published (Segment A)
- `@adhd/sox-graph-store ^0.4.0` published with `createGraphBackend(adapter: StoreAdapter)` constructor (Segment B)
- `@tursodatabase/database` available on npm

### Migration difficulty: **MEDIUM** (CAS concurrency model is the hardest break; bounded direct DB usage)

### Critical risk: `BEGIN IMMEDIATE` → `transaction(fn, { mode: 'immediate' })`

The backlog's entire concurrency model depends on `BEGIN IMMEDIATE` acquiring the RESERVED lock at transaction start. The spec now supports `mode: 'immediate'` on both adapters, which maps to raw `BEGIN IMMEDIATE` SQL. The migration is a mechanical substitution at every CAS call site. However, the associated `withImmediateRetry()` loop changes from synchronous (`Atomics.wait`) to async (`setTimeout`), which changes call-site semantics: every call site that previously ran synchronously now needs `await` or `.catch()`.

### Dependency graph

```
SA-BUILD ──► B-GRAPH  (sox-ecosystem must ship store-adapter + graph-store first)
   │             │
   └─────────────┘
         │
   BL-PREREQ-CHECK  ──►  BL-PREP (audit)
         │
         ├─────────────────────────────────────────────────────────┐
         │                                                         │
   BL-CAS-AUDIT  ──►  BL-COMPOSITION  ──►  BL-CAS-TRANSACTIONS     │
   (sub-packet:          (1 packet)            (4 sub-wave packets  │
    map every .immediate()                         fully parallel)  │
    call site)                                                      │
         │                                                         │
         └───────────┬─────────────────────────────────────────────┘
                     │
               BL-RAW-ESCAPE  ──►  BL-TESTS  ──►  REVIEW-CAS  ──►  BL-SMOKE
```

**Critical path:** BL-PREP → BL-COMPOSITION → BL-CAS-TRANSACTIONS → BL-TESTS → REVIEW-CAS → BL-SMOKE

**Total packets:** 10 (7 code/audit + 2 review + 1 smoke gate)

---

### Packet: BL-PREREQ-CHECK

- **Prompt (~150 tok):** Verify that sox-ecosystem has shipped the required dependency updates before starting migration work.
  - Check: can `require('@adhd/sox-store-adapter')` resolve?
  - Check: does `require('@adhd/sox-graph-store')` expose `createGraphBackend(adapter: StoreAdapter)`?
  - Check: can `require('@tursodatabase/database')` resolve?
  - Output: gates.yaml — dependency readiness gate (pass/block)
- **Reserved files:** (read-only — node_modules check only)
- **Input tokens:** ~150 (instruction) + ~0 (node resolution check)
- **Output tokens:** ~50
- **Gate:** All 3 dependency checks pass

---

### Packet: BL-PREP

- **Prompt (~600 tok):** Audit the backlog codebase for every call site that must change. Read all relevant source files. Produce a classified audit document.

  **Categories:**

  1. **CAS transaction call sites** — every `db.transaction(fn).immediate()` or `transactionImmediate()` call. This is the highest-impact category. Map:
     - `mutate-metadata.ts` — claim, renew, release, citation, note
     - `transitions.ts` — status transitions
     - `priorities.ts` — priority assignment
     - `assignments.ts` — agent assignment
     - `ids.ts` — ID allocation
     - `mutate.ts` — general mutation operations

  2. **`withImmediateRetry()` call sites** — every usage of the synchronous retry wrapper

  3. **Raw SQL escape hatches** — the 3 known direct `store.db.prepare()` calls:
     - `crud.ts` L218–220 (FTS content_hash sync)
     - `structure.ts` L47 (DELETE FROM edge)
     - `graph-backlog-store.ts` L57–58 (close)

  4. **Constructor injection sites** — files that create `new Database(dbPath)` and pass to `createGraphBackend(db)`, plus the `openGraphBacklogStore()` factory

  5. **Type references** — files referencing `store.db: Database.Database` or `better-sqlite3.Database`

  6. **Test files** — files creating `new Database(':memory:')` for concurrency tests

  **Reads required:**
  - `src/graph-backlog-store.ts` (factory + `store.db` field)
  - `src/mutate-metadata.ts` (CAS transaction call sites)
  - `src/transitions.ts`
  - `src/priorities.ts`
  - `src/assignments.ts`
  - `src/ids.ts`
  - `src/mutate.ts`
  - `src/crud.ts` (raw SQL escape hatches)
  - `src/structure.ts` (raw SQL escape hatches)
  - `src/client.ts` (API surface — validate already-async callers)
  - All `test/*.ts` files (concurrency tests with separate handles)

- **Reserved files:** (read-only audit — no changes)
- **Output:** `docs/migration-turso-backlog-audit.md` — per-category call site map with file:line references
- **Input tokens:** ~600 (instruction) + ~3000 (reads all relevant files)
- **Output tokens:** ~400 (audit document)

---

### Packet: BL-COMPOSITION

- **Prompt (~500 tok):** Migrate the backlog's database composition root — `graph-backlog-store.ts`.

  **Changes to `openGraphBacklogStore(dbPath): GraphBacklogStore`:**

  | Current | After |
  |---------|-------|
  | `new Database(dbPath)` | `const adapter = await createStoreAdapter({ type: 'turso', dbPath })` |
  | `db.pragma('journal_mode = WAL')` | `await adapter.pragmaSet('journal_mode', 'WAL')` |
  | `createGraphBackend(db)` | `createGraphBackend(adapter)` |
  | `db.busy_timeout = N` | `await adapter.pragmaSet('busy_timeout', N)` |
  | `return { db, graph }` | `return { adapter, graph }` |
  | `store.db: Database.Database` (field type) | `store.adapter: StoreAdapter` (rename field + change type) |
  | Sync `openGraphBacklogStore()` | `async openGraphBacklogStore(): Promise<GraphBacklogStore>` |

  **Changes to `close()`:**
  | Current | After |
  |---------|-------|
  | `store.db.close()` | `await store.adapter.close()` |
  | Sync | `async` (returns `Promise`) |

  **Import changes:**
  - Remove `import Database from 'better-sqlite3'`
  - Add `import { createStoreAdapter, type StoreAdapter } from '@adhd/sox-store-adapter'`

- **Reserved files:**
  - `src/graph-backlog-store.ts`
- **Depends on:** BL-PREREQ-CHECK, BL-PREP (know exact line references)
- **Input tokens:** ~500 (instruction) + ~400 (reads graph-backlog-store.ts)
- **Output tokens:** ~300
- **Gate:** TypeScript compilation passes — `StoreAdapter` interface is satisfied

---

### Wave: CAS migration (4 sub-packets fully parallel — disjoint file sets, all depend only on BL-COMPOSITION)

#### Packet: BL-CAS-METADATA

- **Prompt (~500 tok):** Migrate all CAS transaction call sites in `mutate-metadata.ts`.

  **Mechanical transformation:**
  ```typescript
  // BEFORE
  function claim(id: string, agent: string) {
    return withImmediateRetry(store.db, () => {
      const current = store.db.prepare('SELECT status FROM items WHERE id = ?').get(id);
      if (current.status !== 'pending') return;
      store.db.prepare('UPDATE items SET claimed_by = ? WHERE id = ?').run(agent, id);
    });
  }

  // AFTER
  async function claim(id: string, agent: string) {
    return withRetry(store.adapter, async tx => {
      const current = await tx.executeGet<{ status: string }>('SELECT status FROM items WHERE id = ?', [id]);
      if (current?.status !== 'pending') return;
      return tx.executeRun('UPDATE items SET claimed_by = ? WHERE id = ?', [agent, id]);
    }, { mode: 'immediate' });
  }
  ```

  **Category list (from BL-PREP):**
  - `claim()` — acquire lock, read status, write if pending
  - `renew()` — read expiry, write new expiry
  - `release()` — read owner, write unclaimed
  - `addCitation()` — read existing citations, append
  - `addNote()` — read existing notes, append
  - `transition()` — read current status, validate transition, write new status
  - `setPriority()` — read current priority, write new priority
  - `assignAgent()` — read assignment, write new assignment

  **Key rules:**
  - Every `withImmediateRetry(store.db, fn)` → `withRetry(store.adapter, fn, { mode: 'immediate' })`
  - Every `store.db.prepare(sql).get(args)` inside the CAS → `tx.executeGet<T>(sql, args)`
  - Every `store.db.prepare(sql).run(args)` inside the CAS → `tx.executeRun(sql, args)`
  - Functions become `async` (return `Promise`)
  - `withImmediateRetry`'s `Atomics.wait` sleep is eliminated — `withRetry` uses `setTimeout` internally
  - Retry defaults: maxRetries=3, baseDelayMs=10, exponential backoff

- **Reserved files:**
  - `src/mutate-metadata.ts`
- **Depends on:** BL-COMPOSITION (`store.adapter` field must exist before callers can use it)
- **Input tokens:** ~500 (instruction) + ~800 (reads mutate-metadata.ts)
- **Output tokens:** ~400

#### Packet: BL-CAS-IDS

- **Prompt (~300 tok):** Migrate CAS transaction call sites in `ids.ts` — ID allocation.

  **Changes:**
  - `withImmediateRetry(store.db, ...)` → `withRetry(store.adapter, async tx => ..., { mode: 'immediate' })`
  - `db.prepare('SELECT next_id FROM id_sequences WHERE ...').get()` → `tx.executeGet(...)`
  - `db.prepare('UPDATE id_sequences SET next_id = ... WHERE ...').run()` → `tx.executeRun(...)`
  - Function becomes `async`, returns `Promise<number>`

- **Reserved files:**
  - `src/ids.ts`
- **Depends on:** BL-COMPOSITION
- **Input tokens:** ~300 (instruction) + ~300 (reads ids.ts)
- **Output tokens:** ~200

#### Packet: BL-CAS-TRANSITIONS

- **Prompt (~350 tok):** Migrate CAS transaction call sites in `transitions.ts`, `priorities.ts`, `assignments.ts`.

  **Changes (same pattern) — 3 files, same mechanical transformation.**

- **Reserved files:**
  - `src/transitions.ts`
  - `src/priorities.ts`
  - `src/assignments.ts`
- **Depends on:** BL-COMPOSITION
- **Input tokens:** ~350 (instruction) + ~600 (reads 3 files)
- **Output tokens:** ~300

#### Packet: BL-CAS-GENERAL

- **Prompt (~250 tok):** Migrate CAS transaction call sites in `mutate.ts` and any remaining files identified by BL-PREP category 1. Same mechanical transformation.

- **Reserved files:**
  - `src/mutate.ts`
  - (any additional files from BL-PREP)
- **Depends on:** BL-COMPOSITION
- **Input tokens:** ~250 (instruction) + ~300 (reads each additional file)
- **Output tokens:** ~200

---

### Packet: BL-RAW-ESCAPE

- **Prompt (~250 tok):** Migrate the 3 known raw SQL escape hatches that bypass `store.graph.*`.

  **Sites:**
  1. `crud.ts` L218–220: `store.db.prepare('UPDATE fts_content SET content_hash = ...').run(...)` → `store.adapter.executeRun(...)`
  2. `structure.ts` L47: `store.db.prepare('DELETE FROM edge WHERE ...').run(...)` → `store.adapter.executeRun(...)`
  3. `graph-backlog-store.ts` L57–58: `store.db.close()` → `await store.adapter.close()`

  **All 3 sites are non-CAS** — no transaction mode needed. Simple `executeRun` replacement.

- **Reserved files:**
  - `src/crud.ts`
  - `src/structure.ts`
  - `src/graph-backlog-store.ts` (close() already covered in BL-COMPOSITION but verify)
- **Depends on:** BL-COMPOSITION ()`store.adapter` field must exist
- **Input tokens:** ~250 (instruction) + ~200 (reads 3 files, specific lines)
- **Output tokens:** ~100
- **Gate:** `npx tsc --noEmit` passes

---

### Packet: BL-TESTS

- **Prompt (~500 tok):** Migrate all test files.

  **Changes per test file:**
  - `import Database from 'better-sqlite3'` → `import { createSqliteAdapter, MockAdapter } from '@adhd/sox-store-adapter'`
  - `new Database(':memory:')` → `createSqliteAdapter({ dbPath: ':memory:' })` (for tests that need SQL execution) or `new MockAdapter()` (for tests that only test interface behavior)
  - All concurrency tests that create multiple `better-sqlite3` handles → create multiple `SqliteAdapter` or `MockAdapter` instances
  - `store.db.transaction(fn).immediate()` → `store.adapter.transaction(async tx => ..., { mode: 'immediate' })` in test assertions
  - `withImmediateRetry(store.db, fn)` → `await withRetry(store.adapter, async tx => ..., { mode: 'immediate' })`
  - Test assertions that check `lastInsertRowid` → handle `number | bigint` union
  - All `store.db` references → `store.adapter`
  - All sync test functions that call migrated store methods → `async` test functions with `await`
  - For tests that use `openGraphBacklogStore()`: add `await`

  **Special: concurrency tests** — these create separate handles to the same DB file and run concurrent operations to verify CAS semantics. With Turso's `multiprocess_wal`, the writer coordination is handled at the shared-memory level. The tests should still run with multiple adapters (each gets its own handle). The assertion should verify that `mode: 'immediate'` provides the same CAS guarantee as the current `BEGIN IMMEDIATE` + retry.

- **Reserved files:** All `test/*.ts` files
- **Depends on:** All BL-CAS-* packets, BL-RAW-ESCAPE
- **Input tokens:** ~500 (instruction) + ~2000 (reads all test files)
- **Output tokens:** ~1000
- **Gate:** `npm test` passes

---

### Packet: REVIEW-CAS

- **Prompt (~500 tok):** Read-only review of every CAS transaction call site migrated in BL-CAS-* packets.

  **Checklist:**
  1. **Every `withImmediateRetry()` call** replaced with `withRetry()` + `{ mode: 'immediate' }`
  2. **Every `db.transaction(fn).immediate()`** replaced with `store.adapter.transaction(fn, { mode: 'immediate' })`
  3. **No bare `transaction(fn)` without mode** where `.immediate()` was used — explicit `{ mode: 'immediate' }` at every CAS site
  4. **`withRetry()` uses `setTimeout` async sleep** — no `Atomics.wait` remains
  5. **`isConcurrentConflict()` and `isBusyError()`** are both caught by `withRetry` — retry handles both BASE (BUSY) and MVCC (SNAPSHOT) conflicts
  6. **`store.adapter` replaces `store.db`** in every location (field rename)
  7. **`openGraphBacklogStore()` is async** and returns `Promise<GraphBacklogStore>` — all callers `await`
  8. **Client API surface unchanged** — `client.ts` was already async; the sync→async change in the store is absorbed
  9. **No raw `better-sqlite3` imports** remain in `src/` (test files may still have them — need AS-* pattern for test migration)

- **Reserved files:** (read-only — all modified source files)
- **Depends on:** BL-TESTS (reviews after test compilation validates interface compatibility)
- **Input tokens:** ~500 (instruction) + ~3500 (reads all modified source files)
- **Output tokens:** ~250 (review report: pass/fail per item)

---

### Packet: BL-SMOKE

- **Prompt (~300 tok):** End-to-end smoke verification.

  **Steps:**
  1. `STORE_ADAPTER=sqlite` — full test suite must pass (validates SqliteAdapter fallback with `mode: 'immediate'` CAS support)
  2. `STORE_ADAPTER=turso` — full test suite must pass (validates TursoAdapter with `mode: 'immediate'` CAS support)
  3. Concurrency stress test: 10 concurrent agents claiming/releasing/transitioning items. Verify zero lost updates (CAS invariant holds). Run with both adapter types.
  4. Rollback test: Remove `@adhd/sox-store-adapter` and `@tursodatabase/database`, revert to `better-sqlite3` — verify the codebase can still compile and the original interface is intact (proves migration is opt-in).
  5. Grep: `grep -r 'better-sqlite3' src/` — zero results (confirming full migration of every non-test file).
  6. Multi-process test (Turso only): Launch 2 processes writing to the same DB file with `experimental: { multiprocessWal: true }`. Verify writes from process A are visible to process B.

- **Reserved files:** (read-only — verification only)
- **Depends on:** REVIEW-CAS
- **Input tokens:** ~300 (instruction) + ~500 (reads test/grep output)
- **Output tokens:** ~100

---

### Parallelism summary

| Wave | Packets | Max parallel | Depends on |
|------|---------|-------------|------------|
| **Prep** | BL-PREREQ-CHECK, BL-PREP | 1 (PREREQ first) | — |
| **Foundation** | BL-COMPOSITION | 1 | BL-PREP |
| **CAS migration** | BL-CAS-METADATA, BL-CAS-IDS, BL-CAS-TRANSITIONS, BL-CAS-GENERAL | **4 fully parallel** | BL-COMPOSITION |
| **Escape hatches** | BL-RAW-ESCAPE | 1 (can run parallel with CAS wave — no file overlap) | BL-COMPOSITION |
| **Tests** | BL-TESTS | 1 | All CAS + RAW |
| **Review** | REVIEW-CAS | 1 | BL-TESTS |
| **Smoke** | BL-SMOKE | 1 | REVIEW-CAS |

**Key parallelization wins:**
- 4 CAS sub-packets run in parallel (disjoint file sets, all depend only on BL-COMPOSITION)
- BL-RAW-ESCAPE runs parallel with CAS wave (disjoint file sets)
- REVIEW-CAS hidden in BL-TESTS latency

**Total estimated output tokens:** ~3300  
**Total input tokens:** ~12500 (reads across all files)  
**Sequential chain depth:** 5 hops (PREP → COMPOSITION → CAS metadata → TESTS → SMOKE, but CAS wave is wide)
