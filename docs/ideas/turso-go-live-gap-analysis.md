# Turso Adapter Go-Live Gap Analysis

> **Audit date:** 2026-07-27
> **Scope:** End-to-end review of what must be done before the live memory-server can flip from `better-sqlite3` to `TursoAdapter` — and what the external ADHD consumers need to adopt `StoreAdapter`.
> **Finding:** The adapter package exists and both backends are implemented, but **the adapter is not wired into memory-core's hot paths**. The current architecture routes all writes through a synchronous `better-sqlite3`-coupled `WriteQueue`, every embedding operation unwraps the raw `Database.Database` handle, and schema DDL + vector queries are hardcoded to sqlite-vec. Setting `STORE_ADAPTER=turso` today has zero effect — `openDb()` hardcodes `createSqliteAdapter()`.

---

## Section 1: What's Built vs What's Needed

| Component | Built? | What's Missing | Effort |
|-----------|--------|----------------|--------|
| **`@adhd/sox-store-adapter` v0.1.0** | ✅ Published to npm. `StoreAdapter`, `SqliteAdapter`, `TursoAdapter`, `MockAdapter`, retry utils, error helpers, factory (`createStoreAdapter`) all implemented on `main`. | None — complete. | — |
| **`STORE_ADAPTER` env var** | ✅ Factory reads `STORE_ADAPTER`, defaults to `'turso'`. | **Not consumed by any hot path.** `openDb()` hardcodes `createSqliteAdapter()` — never calls `createStoreAdapter()`. | **2 days** |
| **`VectorDialect`** | ❌ **Interface defined in `types.ts`, zero concrete implementations.** No `TursoVectorDialect`, no `SqliteVecDialect` in any branch or worktree. | Both dialect classes (`TursoVectorDialect` — `vector(768)` DDL, `vector_distance_cos()` queries; `SqliteVecDialect` — `vec0` virtual table DDL, `MATCH`/`k` queries). Must be in `src/vector-dialect.ts`. | **3 days** |
| **`SchemaDialect`** | ❌ **Does not exist — zero references anywhere.** Not in the spec, not in the codebase. | DDL abstraction for per-backend CREATE TABLE statements. Without it, `schema.ts`'s `CREATE VIRTUAL TABLE vec0 USING vec0(...)` fails on Turso. This is the VectorDialect's `vectorColumnType()` method extended to cover the full DDL surface. | **1 day** (likely folded into VectorDialect) |
| **`memory-core` → Adapter surface** | 🟡 Partial. 29 source files import `type StoreAdapter`/`type SqliteAdapter`. `openDb()` returns `Promise<StoreAdapter>`. | **Still unwraps raw `better-sqlite3.Database` everywhere.** `stampStoreMeta()`, `verifyStoreMeta()`, `migrateAddColumn()`, `initScope()` all take `Database.Database`. The WriteQueue holds a raw `Database.Database`. `applyEmbedding()` takes raw `Database.Database`. | **5 days** |
| **`WriteQueue` async refactor** | ❌ **Fully sync, better-sqlite3-coupled.** Constructor takes raw `Database.Database`, `enqueue()` callback receives raw `Database.Database`, `_create()` unwraps SqliteAdapter. Cannot work with TursoAdapter at all. | Must accept `StoreAdapter` instead of `Database.Database`. Task callbacks receive `AdapterTransaction`. The entire queue body becomes async. This is the **critical path** — every write routes through this queue. | **5 days** (riskiest piece) |
| **Two-phase write (embed-pipeline)** | ❌ **Coupled to raw DB.** `applyEmbedding()`, `embedBacklogStats()`, `healMissingVectors()` all take `Database.Database`. | All functions must accept `StoreAdapter`. `applyEmbedding()` uses `db.transaction()` internally — must switch to `adapter.transaction()`. `embedBacklogStats()` uses `NOT EXISTS (SELECT 1 FROM vec_node...)` — must go through VectorDialect. | **3 days** |
| **Recall queries** | ❌ **Sqlite-vec-specific SQL hardcoded.** `vec_node` MATCH/k query in `recall.ts:428-433` uses sqlite-vec syntax. `vec_distance_cosine()` function referenced in code comment but sqlite-vec uses `distance`. | Route through VectorDialect. For SqliteAdapter → `MATCH ? AND k = ? ORDER BY distance`. For TursoAdapter → `ORDER BY vector_distance_cos(embedding, ?) LIMIT ?`. | **2 days** |
| **Schema DDL** | ❌ **Hardcoded `vec0` virtual table.** `schema.ts:49`: `CREATE VIRTUAL TABLE IF NOT EXISTS vec_node USING vec0(...)`. Works on sqlite-vec, fails on Turso. | DDL must go through a dialect. Sqlite: current DDL. Turso: `CREATE TABLE IF NOT EXISTS vec_node (node_id INTEGER PRIMARY KEY, embedding vector(768))`. | **1 day** |
| **memory-server bundle** | ❌ **Dist not rebuilt with latest changes, `@tursodatabase/database` not bundled.** The bundle still links to old code. Turso's native driver isn't in the dependency chain. | Rebuild memory-server from main with adapter-aware memory-core. Add `@tursodatabase/database` as optional peerDependency (or bundle it). Smoke test with both backends. | **1 day** |
| **Live store migration (70MB `~/.memory/memory.db`)** | ❌ **No migration path exists.** The vec0 BLOB format differs from Turso's native `vector(N)` format. FTS5 and node/edge tables are portable, but vectors must be re-indexed. | Migration script that: (1) creates Turso-compatible schema, (2) copies node/edge/FTS5 data as-is, (3) re-embeds all vectors via the embedding provider into native `vector(768)` columns, (4) verifies recall parity. | **3 days** (operations, not code) |
| **Rollback plan** | ❌ **No rollback path documented.** | If Turso fails in production: `STORE_ADAPTER=sqlite` to revert. But if schema DDL already ran on the live store, the vec0 table may be gone — the rollback must either keep the original file untouched (copy-then-migrate) or reverse the DDL. | **1 day** |

---

## Section 2: Live Memory-Server Migration Plan

The live store at `~/.memory/memory.db` (~70MB) runs on better-sqlite3 with sqlite-vec. Flipping to Turso requires schema change + vector re-index.

### Step 1: Schema migration strategy — Copy, Never Mutate

**DO NOT run the new DDL against the live file.** Use a copy:

```bash
# 1. While memory-server is STOPPED:
cp ~/.memory/memory.db ~/.memory/memory-turso.db

# 2. Run migration against the copy
STORE_ADAPTER=turso node scripts/migrate-to-turso.mjs \
  --source ~/.memory/memory.db \
  --target ~/.memory/memory-turso.db

# 3. Verify recall parity between original and migrated copy
node scripts/verify-recall-parity.mjs \
  --sqlite ~/.memory/memory.db \
  --turso ~/.memory/memory-turso.db

# 4. If verification passes, swap:
mv ~/.memory/memory.db ~/.memory/memory.db.bak
mv ~/.memory/memory-turso.db ~/.memory/memory.db

# 5. Restart memory-server with STORE_ADAPTER=turso
```

### Step 1a: In-place migration (for constrained environments)

When copying the store file is impractical (Docker volumes, network mounts, or stores where I/O duplication is problematic), use in-place migration:

```bash
# 1. Stop memory-server
# 2. Create a pre-migration backup savepoint
cp ~/.memory/memory.db ~/.memory/memory.db.pre-turso

# 3. Run migration in-place (defaults to copy mode — use --mode in-place)
STORE_ADAPTER=sqlite node scripts/migrate-store-to-turso.mjs \
  --mode in-place \
  --db ~/.memory/memory.db

# 4. Verify recall parity against the pre-turso backup
node scripts/verify-recall-parity.mjs \
  --sqlite ~/.memory/memory.db.pre-turso \
  --turso ~/.memory/memory.db

# 5. If verification passes, restart with STORE_ADAPTER=turso
# 6. Keep the .pre-turso backup until confidence is established, then delete
```

The in-place script:
1. Opens the store with SqliteAdapter
2. Drops the `vec0` virtual table
3. Creates native `vector(768)` column schema via `TursoVectorDialect.createTableDDL()`
4. Re-embeds all live episode vectors into the new column (same re-embed logic as copy mode)
5. Creates the ANN index via `TursoVectorDialect.createIndexDDL()`

**Trade-off:** Slower rollback (requires restoring from `.pre-turso` backup) vs no additional disk space for a full DB copy.

**When to use each:**
- **Copy-then-swap (Step 1, recommended):** Standard deployments with sufficient disk. Instant rollback by swapping `.bak` back. Zero risk of corrupting the live file — the original is never touched.
- **In-place (Step 1a):** Constrained environments where copying the full DB file isn't practical. Requires a backup savepoint before migration begins. Rollback requires restoring from backup. The `--mode in-place` flag selects this path.

### Step 2: Schema DDL differences

| Object | SqliteAdapter (current) | TursoAdapter (target) |
|--------|------------------------|----------------------|
| `vec_node` | `CREATE VIRTUAL TABLE vec_node USING vec0(node_id INTEGER PRIMARY KEY, embedding FLOAT[768])` | `CREATE TABLE vec_node (node_id INTEGER PRIMARY KEY, embedding vector(768))` |
| `node` table | Standard — identical | Standard — identical |
| `edge` table | Standard — identical | Standard — identical |
| `fts_node` | FTS5 — identical | FTS5 — identical |
| `organizer_queue` | Standard — identical | Standard — identical |
| All other tables | Standard SQLite — identical | Standard SQLite — identical |

**Only `vec_node` changes.** Every other table (node, edge, FTS, organizer_queue, memory_scope, sox_store_meta, request_ledger, promotion_queue) uses standard SQLite DDL and ports verbatim.

### Step 3: Vector data migration — Re-embed, Don't Convert

The `vec0` BLOB format differs from Turso's native `vector(N)` BLOB. **There is no lossless BLOB-to-BLOB conversion.** The migration must re-embed every vector:

1. Read node `rowid` + `content` from the source SqliteAdapter for all live episodes
2. For each node, call `embed(content)` via the real ONNX provider
3. Insert into target TursoAdapter's `vec_node` table using `adapter.executeRun()`
4. ~10K vectors × ~50ms/embed = ~500 seconds (~8 minutes). Batch in chunks of 500 to avoid OOM.

**During migration, writes are blocked** (server stopped). The re-embed is offline.

### Step 4: Verification steps

```bash
# 1. Count parity: same number of live episodes
# 2. Recall parity: 100 random queries, compare top-10 results between sqlite and turso.
#    Allow slight score differences (cosine distance vs cosine similarity — Turso
#    may use different float precision) but RUNK ORDER must be identical.
# 3. Write test: memory_write → verify immediately recallable on turso.
# 4. Memory pressure: run recall in a loop for 60s, verify no memory leak.
```

### Step 5: Rollback plan

If Turso fails in production:

```bash
# Instant rollback (preserves original file):
STORE_ADAPTER=sqlite  # ← restart memory-server
# The original better-sqlite3 vec0 file is at ~/.memory/memory.db.bak

# If the turso file was swapped in and is corrupted:
mv ~/.memory/memory.db.bak ~/.memory/memory.db
# Restart memory-server — Turso is the default; explicit STORE_ADAPTER=sqlite required for legacy rollback
```

**Rollback is instant** — the original file is never mutated, only copied. `STORE_ADAPTER` env var switches the entire engine. No code deploy needed (both adapters are in the same bundle).

---

## Section 3: Backlog Consumer Migration Plan

The ADHD backlog consumer (`phase-2-adhd-backlog.md`) **cannot start until sox-ecosystem ships:**

### Pre-requisites (sox-ecosystem must ship first):

| Dependency | Status | Blocks |
|-----------|--------|--------|
| `@adhd/sox-store-adapter@0.1.0` on npm | ✅ Published | Backlog can `pnpm add` it immediately |
| `@adhd/sox-graph-store` with `createGraphBackend(adapter: StoreAdapter)` constructor | ❌ **Not done.** Graph-store still expects `better-sqlite3.Database`. | **BLOCKING.** Backlog's entire DB access is through `store.graph.*` (GraphBackend). Without this, no migration can begin. |
| `@tursodatabase/database` on npm | ✅ v0.7.1 available | Can be installed as optional peer dep |

### What the backlog must do (after graph-store ships):

1. **`BEGIN IMMEDIATE` → `transaction(fn, { mode: 'immediate' })`.** The spec supports this — both adapters use raw `BEGIN IMMEDIATE` SQL. The backlog's CAS pattern maps directly:
   ```typescript
   // BEFORE
   db.transaction(fn).immediate()();
   // AFTER
   await adapter.transaction(fn, { mode: 'immediate' });
   ```

2. **`withImmediateRetry()` (`Atomics.wait`) → `withRetry()` (`setTimeout`).** The adapter's `retry.ts` provides `withRetry()` — identical logic, async. The backlog's retry loop must go async.

3. **All store functions become async.** Currently synchronous (better-sqlite3). Must `await` every `adapter.execute*()` call. Client API (`client.ts`) is already async — the sync→async change in the store is absorbed.

4. **`openGraphBacklogStore()` becomes async.** Returns `Promise<GraphBacklogStore>`.

5. **3 raw SQL escape hatches** (crud.ts, structure.ts, close()) — mechanical `executeRun()` replacement.

**Effort estimate for backlog:** 3–5 days (medium complexity — CAS concurrency model is the hardest piece, but spec maps it directly).

### `BEGIN IMMEDIATE` CAS gap:

**No gap.** The spec's `TransactionOptions.mode = 'immediate'` maps directly to `BEGIN IMMEDIATE` SQL in both SqliteAdapter and TursoAdapter. The backlog's CAS pattern is preserved. The retry wrapper changes from sync to async but the semantics are identical.

---

## Section 4: Unbuilt Components

These are specified in the architecture (`turso-database-adapter.md`) but not implemented. Listed in dependency order:

### 4.1 VectorDialect (PRIORITY: CRITICAL)

**Spec location:** `turso-database-adapter.md` lines 160–169
**Current state:** Interface exists in `types.ts`. **Zero concrete implementations anywhere.**

Two classes needed in `libs/data/store/store-adapter/src/vector-dialect.ts`:

**`SqliteVecDialect`:**
```typescript
class SqliteVecDialect implements VectorDialect {
  vectorColumnType(dim: number): string {
    return `FLOAT[${dim}]`; // for vec0 virtual table
  }
  createTableDDL(table: string, dim: number): string {
    return `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(node_id INTEGER PRIMARY KEY, embedding FLOAT[${dim}])`;
  }
  topKQuery(table: string, column: string, queryVec: number[], k: number, metric: VectorMetric): { sql: string; args: unknown[] } {
    return {
      sql: `SELECT v.node_id, v.distance FROM ${table} v JOIN node n ON n.rowid = v.node_id WHERE v.embedding MATCH ? AND k = ? ORDER BY v.distance LIMIT ?`,
      args: [vecToJson(queryVec), k, k],
    };
  }
  distanceExpr(column: string, queryVec: number[]): string {
    return `${column} MATCH ?`;
  }
  // ... etc
}
```

**`TursoVectorDialect`:**
```typescript
class TursoVectorDialect implements VectorDialect {
  vectorColumnType(dim: number): string {
    return `vector(${dim})`;
  }
  createTableDDL(table: string, dim: number): string {
    return `CREATE TABLE IF NOT EXISTS ${table} (node_id INTEGER PRIMARY KEY, embedding vector(${dim}))`;
  }
  topKQuery(table: string, column: string, queryVec: number[], k: number, metric: VectorMetric): { sql: string; args: unknown[] } {
    const fn = metric === 'cosine' ? 'vector_distance_cos' : metric === 'l2' ? 'vector_distance_l2' : 'vector_distance_dot';
    return {
      sql: `SELECT v.node_id, ${fn}(v.embedding, ?) as distance FROM ${table} v JOIN node n ON n.rowid = v.node_id ORDER BY distance LIMIT ?`,
      args: [vecToBlob(queryVec), k],
    };
  }
  distanceExpr(column: string, queryVec: number[]): string {
    return `vector_distance_cos(${column}, ?)`;
  }
  // ... etc
}
```

**Impact if not built:** Cannot create vector tables on Turso. Cannot query vectors on Turso. `STORE_ADAPTER=turso` is a no-op for the entire recall pipeline.

### 4.2 SchemaDialect (PRIORITY: HIGH — likely folds into VectorDialect)

**Not a separate interface.** The VectorDialect's `createTableDDL()` and `vectorColumnType()` already cover the schema DDL differences. A dedicated `SchemaDialect` would only be needed if non-vector DDL also differs between backends (e.g., `CREATE INDEX` syntax, `PRAGMA` differences, `BEGIN CONCURRENT` support). Currently, all non-vector DDL is portable SQLite — no `SchemaDialect` needed now, but revisit when Turso introduces DDL-level differences beyond vectors.

### 4.3 `openDb()` STORE_ADAPTER awareness (PRIORITY: CRITICAL)

**Current (`db.ts:208-209`):**
```typescript
const { createSqliteAdapter } = await import('@adhd/sox-store-adapter');
const adapter = createSqliteAdapter({ dbPath }) as SqliteAdapter;
```

**Needed:**
```typescript
const { createStoreAdapter } = await import('@adhd/sox-store-adapter');
const adapter = await createStoreAdapter({ dbPath });
```

**Why this alone isn't enough:** `createStoreAdapter()` defaults to `'turso'` (reads `STORE_ADAPTER` env var, unset → turso). But even after this change, the rest of `openDb()` calls `sqliteVec.load(rawDb)`, `stampStoreMeta(rawDb)`, `migrateAddColumn(rawDb, ...)`, `rawDb.prepare(...)` — all of which unwrap the raw better-sqlite3 handle. On a TursoAdapter, `unwrap()` returns a `@tursodatabase/database.Database` — `sqliteVec.load()` will crash on it.

**What must change in `openDb()`:**
- Remove `sqliteVec.load(rawDb)` — move to VectorDialect initialization
- Remove `rawDb.prepare()` calls — use `adapter.executeGet()` instead (already async)
- Remove `rawDb.exec()` calls — use `adapter.exec()` instead (already async)
- `stampStoreMeta()` and `verifyStoreMeta()` must accept `StoreAdapter` instead of `Database.Database`
- `migrateAddColumn()` must accept `StoreAdapter` instead of `Database.Database`
- The pre-DDL defensive column migration (lines 243–293) uses `rawDb.prepare().get()`, `rawDb.prepare().all()`, `rawDb.exec()` — all must go through `adapter`

### 4.4 WriteQueue async refactor for TursoAdapter (PRIORITY: CRITICAL)

**Current (`write-queue.ts:285-293`):**
```typescript
private constructor(rawDb: Database.Database, dbPath: string, maxSize = 100) {
  this.db = rawDb;  // ← raw better-sqlite3.Database
  this.db.exec('PRAGMA busy_timeout = 3000;');
}

private static async _create(dbPath: string, maxSize?: number): Promise<WriteQueue> {
  const adapter = await openDb(dbPath);
  const rawDb = adapter.unwrap() as Database.Database;  // ← unwrap, breaks on Turso
  return new WriteQueue(rawDb, dbPath, maxSize);
}
```

**Needed:** The WriteQueue must accept `StoreAdapter` and route operations through `adapter.transaction()`:

```typescript
private adapter: StoreAdapter;

private constructor(adapter: StoreAdapter, dbPath: string, maxSize = 100) {
  this.adapter = adapter;
}

private static async _create(dbPath: string, maxSize?: number): Promise<WriteQueue> {
  const adapter = await openDb(dbPath);  // ← returns StoreAdapter (any backend)
  return new WriteQueue(adapter, dbPath, maxSize);
}
```

**Task callback type change:**
```typescript
// BEFORE
operation: (db: Database.Database) => T | Promise<T>

// AFTER
operation: (tx: AdapterTransaction) => T | Promise<T>
```

**Impact:** Every caller of `wq.enqueue()` — including `write.ts` memoryWritePhaseA, `embed-pipeline.ts` applyEmbedding, `curate.ts`, `update.ts`, `cluster.ts`, `autolink.ts` — must change its task body to use `tx.executeGet()`/`tx.executeRun()` instead of `db.prepare().get()`/`.run()`.

**Risk:** The WriteQueue is the central serialization point for ALL writes. Bugs here corrupt data silently. The refactor must:
1. Preserve FIFO ordering
2. Preserve the admission control estimator (the latency ring)
3. Preserve the saturation hysteresis
4. Work with both SqliteAdapter (sync I/O) and TursoAdapter (async I/O)
5. Support the per-task `kind` ('write' vs 'apply') for metrics segregation

### 4.5 Remaining raw `Database.Database` leak sites

Beyond openDb and WriteQueue, these functions in memory-core still take raw `better-sqlite3.Database`:

| Function | File | Line | Usage | Migration |
|----------|------|------|-------|-----------|
| `stampStoreMeta()` | `db.ts` | 100 | Called from `openDb()` | Accept `StoreAdapter`, use `adapter.executeRun()` |
| `verifyStoreMeta()` | `db.ts` | 121 | Called from `stampStoreMeta()` | Accept `StoreAdapter`, use `adapter.executeAll()` |
| `migrateAddColumn()` | `db.ts` | 404 | Called from `openDb()` multiple times | Accept `StoreAdapter`, use `adapter.executeAll()` + `adapter.exec()` |
| `initScope()` | `db.ts` | 423 | Public export | Accept `StoreAdapter`, use `adapter.executeGet()` + `adapter.executeRun()` |
| `applyEmbedding()` | `embed-pipeline.ts` | 290 | Called from WriteQueue tasks | Accept `AdapterTransaction` (already inside queue task) |
| `embedBacklogStats()` | `embed-pipeline.ts` | 439 | Called from memory_ping | Accept `StoreAdapter`, use `adapter.executeGet()` |
| `healMissingVectors()` | `embed-pipeline.ts` | 472 | Periodic tick | Accept `StoreAdapter` for read scan, pass `WriteQueue` for apply |
| `healStaleVectors()` | `embed-pipeline.ts` | 570 | Periodic tick (default-off) | Accept `StoreAdapter` for read scan |

### 4.6 Recall query dialect routing (PRIORITY: CRITICAL)

**Current (`recall.ts:428-433`):** Hardcoded sqlite-vec KNN query:
```typescript
const vecSql = `SELECT v.node_id, v.distance
     FROM vec_node v
     JOIN node n ON n.rowid = v.node_id
     WHERE v.embedding MATCH ? AND k = ?
       AND ${validityPred}
       ${agentFilter}
       ${filterSql}
     ORDER BY v.distance
     LIMIT ?`;
```

**Needed:** Route through VectorDialect:
```typescript
const dialect = createVectorDialect(adapter.config.type);
const { sql, args } = dialect.topKQuery('vec_node', 'embedding', queryVec, knnLimit, 'cosine');
// Then add validityPred, agentFilter, filterSql to the SQL before executing
```

**Schema DDL (`schema.ts:49`):** Also routes through VectorDialect:
```typescript
// BEFORE
CREATE VIRTUAL TABLE IF NOT EXISTS vec_node USING vec0(node_id INTEGER PRIMARY KEY, embedding FLOAT[768]);

// AFTER (in VectorDialect)
dialect.createTableDDL('vec_node', 768);
```

---

## Section 5: Go-Live Blockers

### MUST be done before flipping the live store

| # | Blocker | Severity | Why blocking | Effort |
|---|---------|----------|-------------|--------|
| 1 | **VectorDialect implementation** | 🔴 CRITICAL | No vector DDL or queries on Turso. Recall is dead. | 3 days |
| 2 | **`openDb()` STORE_ADAPTER awareness** | 🔴 CRITICAL | Setting `STORE_ADAPTER=turso` has zero effect — hardcoded to SqliteAdapter. | 2 days |
| 3 | **WriteQueue async refactor** | 🔴 CRITICAL | Every write routes through WriteQueue. Cannot write to TursoAdapter at all. | 5 days |
| 4 | **Remove all raw `Database.Database` leak sites** | 🔴 CRITICAL | `stampStoreMeta()`, `verifyStoreMeta()`, `migrateAddColumn()`, `initScope()`, `applyEmbedding()`, `embedBacklogStats()`, `healMissingVectors()` — all crash on TursoAdapter. | 3 days |
| 5 | **Recall query + schema DDL dialect routing** | 🔴 CRITICAL | Hardcoded sqlite-vec SQL. Recall returns no results on Turso. Schema DDL fails on Turso. | 2 days |
| 6 | **Rebuild memory-server bundle** | 🔴 CRITICAL | Current dist is stale. Turso driver not bundled. | 1 day |
| 7 | **Live store migration script** | 🔴 CRITICAL | 70MB file cannot be used as-is. Vec0 table must be migrated. | 3 days |
| 8 | **Rollback plan verified** | 🟡 HIGH | Must be tested before go-live (copy-never-mutate + STORE_ADAPTER=sqlite rollback). | 1 day |

### CAN be done after going live with Turso

| # | Item | Severity | Why it can wait |
|---|------|----------|-----------------|
| 1 | **Backlog consumer migration** | 🟡 MEDIUM | External consumer. Not blocking the live service. Blocks only when backlog needs multiprocess_wal. |
| 2 | **Agent-MCP authoring migration** | 🟡 MEDIUM | External consumer. Plan 8 states can use SqliteAdapter in Phase 1. |
| 3 | **Agent-Packages migration** | 🟡 MEDIUM | External consumer. 9-package migration through `openRegistryDb()`. Can start with SqliteAdapter. |
| 4 | **TursoAdapter stress testing** | 🟡 MEDIUM | Smoke test first, then stress test under production load. |
| 5 | **`multiprocess_wal` enablement** | 🟢 LOW | Experimental Turso feature. SqliteAdapter's single-writer is the current baseline — no regression. |
| 6 | **`BEGIN CONCURRENT` (MVCC) for write-heavy paths** | 🟢 LOW | `mode: 'deferred'` + `mode: 'immediate'` already cover all current use cases. MVCC is a future optimization. |

---

## Summary: Total Effort to Go-Live

| Phase | Items | Estimated effort | Dependency chain |
|-------|-------|-----------------|-----------------|
| **Phase A: VectorDialect** | Implement both dialect classes + tests | 3 days | None — standalone |
| **Phase B: Adapter wiring** | openDb() + schema DDL + recall queries | 3 days | Depends on A |
| **Phase C: WriteQueue refactor** | Async adapter + task callback migration | 5 days | Depends on B (openDb returns StoreAdapter) |
| **Phase D: Raw DB cleanup** | All remaining `Database.Database` leak sites | 3 days | Depends on C (WriteQueue tasks provide AdapterTransaction) |
| **Phase E: Build + bundle** | Rebuild memory-server, bundle Turso driver | 1 day | Depends on D |
| **Phase F: Migration + verify** | Live store migration script + recall parity tests | 3 days | Depends on E |
| **Phase G: Rollback + go-live** | Rollback plan test, flip STORE_ADAPTER | 1 day | Depends on F |

**Critical path:** A → B → C → D → E → F → G = **~19 working days**

**Parallelizable work:** While A/B/C/D/E are in progress (sox-ecosystem), the external consumer migrations (backlog, agent-mcp, agent-packages) can be done in parallel — they depend only on published packages, not on the live service flip.

**Total story points:** ~50 (assuming 1 story point = 1 developer-day for a senior engineer).

---

# Solutions

> **Design principle:** Every function, every path, every component works on BOTH backends. The **only** genuine exception is `sqliteVec.load(adapter.unwrap())` — native C extension loading that fundamentally cannot cross a different C ABI (Turso's `libsql` uses a different native module). Everything else is backend-agnostic. Branch on `adapter.config.type` where the adapter type matters; use `VectorDialect` where vector SQL diverges; use `adapter.execute*()` for all data access. Zero `unwrap()` calls outside the single guarded sqlite-vec load. Zero feature-flag booleans. Zero deferred work. Zero "SqliteAdapter-only maintenance" functions — every function accepts `StoreAdapter`, and every function works on both backends.
>
> **What changed from the original solutions:** No function is deferred. No function is "permanently SqliteAdapter-only." All 11 functions that previously took `Database.Database` now accept `StoreAdapter`. The WriteQueue is fully async and adapter-aware. Both `VectorDialect` implementations are complete and mandatory at go-live. `healMissingVectors()` and `healStaleVectors()` are backend-agnostic — they accept `StoreAdapter`, scan through `adapter.executeAll()`, and apply through the WriteQueue. The migration sandbox tests both adapters in both directions (SQLite→Turso, Turso→SQLite, fresh Turso setup, fresh SQLite setup). There is no "Phase 2."

---

## Function classification — complete (zero deferrals)

| Function | New signature | Action |
|---|---|---|
| `openDb()` | Returns `Promise<StoreAdapter & { vectorDialect: VectorDialect }>` | Adapter-aware via `createStoreAdapter()`. SqliteAdapter: guarded `sqliteVec.load()`, then adapter methods. TursoAdapter: no native load, inline init. Vec DDL through VectorDialect. |
| `WriteQueue` | Constructor: `(adapter: StoreAdapter, dbPath: string, maxSize?: number)` | Async-only. `_create()` returns StoreAdapter from `openDb()`. Task callbacks receive `AdapterTransaction` via `adapter.transaction()`. PRAGMA busy_timeout guarded by adapter type. WAL operations adapter-aware. |
| `memoryRecall()` | `(adapter: StoreAdapter, vectorDialect: VectorDialect, scope, params)` | KNN routed through `vectorDialect.topKQuery()`. Filter predicates interpolated into `__PLACEHOLDER__` slot. |
| `applyEmbedding()` | `(tx: AdapterTransaction, pending, vec, adapterConfigType)` | Receives `AdapterTransaction` from WriteQueue wrapper. Serializes vectors as JSON or BLOB based on `adapterConfigType`. Near-dup pass through `detectNearDupTx`/`applyNearDupResultTx` (same migration). |
| `initScope()` | `(adapter: StoreAdapter, scope, scopeId)` → `Promise<MemoryScope>` | Same SELECT + INSERT, now async through adapter. 4-line mechanical change. |
| `embedBacklogStats()` | `(adapter: StoreAdapter)` → `Promise<EmbedBacklogStats>` | Same `NOT EXISTS (SELECT 1 FROM vec_node ...)` SQL. 3-line mechanical change. |
| `healMissingVectors()` | `(adapter: StoreAdapter, wq: WriteQueue, opts?)` → `Promise<HealResult>` | **Backend-agnostic.** Read scan through `adapter.executeAll()`. Apply through WriteQueue. Same logic works on both backends — the two-phase write gap (Phase A commits node row before Phase B inserts vec) exists on both sqlite-vec and Turso. |
| `healStaleVectors()` | `(adapter: StoreAdapter, wq: WriteQueue, opts?)` → `Promise<StaleHealResult>` | **Backend-agnostic.** Same pattern as healMissingVectors. Scans nodes with stale `embed_model`, queues re-embed through WriteQueue. |
| `stampStoreMeta()` | `(adapter: StoreAdapter)` → `Promise<void>` | 4 `INSERT OR IGNORE` statements via `adapter.executeRun()`. Called from both adapter paths. |
| `verifyStoreMeta()` | `(adapter: StoreAdapter)` → `Promise<void>` | SELECT via `adapter.executeAll()`. Throws `EStoreMismatch` on version/dimension mismatch. |
| `migrateAddColumn()` | `(adapter: StoreAdapter, table, column, type)` → `Promise<void>` | `PRAGMA table_info` via `adapter.executeAll()`, `ALTER TABLE ADD COLUMN` via `adapter.exec()`. Same guard logic, async execution. |

**All 11 functions migrated. Zero deferred. Zero SqliteAdapter-only.**

---

## Solution 1: VectorDialect — both implementations complete, mandatory at go-live

### Two concrete classes required. Both shipped. No "deferred TursoVectorDialect."

The `VectorDialect` interface (`types.ts:60-67`) defines the contract. Two concrete classes are required and must both exist before go-live:

```typescript
// Existing interface — no changes needed. It already supports both backends.
export interface VectorDialect {
  vectorColumnType(dim: number): string;
  distanceExpr(column: string, queryVec: number[]): string;
  createIndexDDL(table: string, column: string, metric: VectorMetric): string;
  topKQuery(table: string, column: string, queryVec: number[], k: number, metric: VectorMetric): { sql: string; args: unknown[] };
  initialize(db: unknown): Promise<void>;
}
```

### New file: `libs/data/store/store-adapter/src/vector-dialect.ts`

```typescript
import type { VectorDialect, VectorMetric } from './types.js';

// ── Vector serialization helpers (re-exported for embed-pipeline) ──

export function vecToJson(vec: Float32Array | number[]): string {
  const a = vec instanceof Float32Array ? Array.from(vec) : vec;
  return JSON.stringify(a);
}

export function vecToBlob(vec: Float32Array | number[]): Buffer {
  const f32 = vec instanceof Float32Array ? vec : new Float32Array(vec);
  return Buffer.from(f32.buffer);
}

// ── Shared helper for topKQuery dual-dialect pattern ──

/** Emit SQL for dialect-aware top-K with __PLACEHOLDER__ for caller filter interpolation. */
function topKQueryCore(
  table: string,
  column: string,
  k: number,
  dialectFn: 'sqlite-vec' | 'turso',
  metric: VectorMetric,
): { selectExpr: string; whereExpr: string; orderExpr: string; limitExpr: string } {
  if (dialectFn === 'turso') {
    const fn = metric === 'cosine' ? 'vector_distance_cos' : metric === 'l2' ? 'vector_distance_l2' : 'vector_distance_dot';
    return {
      selectExpr: `v.node_id, ${fn}(v.${column}, ?) AS distance`,
      whereExpr: '__PLACEHOLDER__',
      orderExpr: 'ORDER BY distance',
      limitExpr: 'LIMIT ?',
    };
  }
  // sqlite-vec
  return {
    selectExpr: 'v.node_id, v.distance',
    whereExpr: `v.${column} MATCH ? AND k = ? AND __PLACEHOLDER__`,
    orderExpr: 'ORDER BY v.distance',
    limitExpr: 'LIMIT ?',
  };
}

// ── SqliteVecDialect ──

export class SqliteVecDialect implements VectorDialect {
  vectorColumnType(_dim: number): string {
    return 'FLOAT[768]';
  }

  distanceExpr(column: string, _queryVec: number[]): string {
    return `${column} MATCH ?`;
  }

  createTableDDL(table: string, dim: number): string {
    return `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(node_id INTEGER PRIMARY KEY, embedding ${this.vectorColumnType(dim)})`;
  }

  createIndexDDL(_table: string, _column: string, _metric: VectorMetric): string {
    return ''; // vec0 virtual tables auto-index on creation — no explicit index needed
  }

  topKQuery(table: string, column: string, queryVec: number[], k: number, metric: VectorMetric): { sql: string; args: unknown[] } {
    const { selectExpr, whereExpr, orderExpr, limitExpr } = topKQueryCore(table, column, k, 'sqlite-vec', metric);
    const sql = `SELECT ${selectExpr} FROM ${table} v JOIN node n ON n.rowid = v.node_id WHERE ${whereExpr} ${orderExpr} ${limitExpr}`;
    return { sql, args: [vecToJson(queryVec), k, k] };
  }

  async initialize(db: unknown): Promise<void> {
    // Native sqlite-vec extension loading. The `db` parameter is the raw
    // better-sqlite3.Database — this is the ONLY place where unwrap() is required.
    // Guarded by adapter.config.type === 'sqlite' at the call site.
    const { default: sqliteVec } = await import('sqlite-vec');
    sqliteVec.load(db);
  }
}

// ── TursoVectorDialect ──

export class TursoVectorDialect implements VectorDialect {
  vectorColumnType(dim: number): string {
    return `vector(${dim})`;
  }

  distanceExpr(column: string, _queryVec: number[]): string {
    // Turso does not expose a raw distance expression for WHERE clauses the way
    // sqlite-vec does. The full distance function call is embedded in topKQuery's
    // SELECT clause. Callers that need a WHERE distance filter use a subquery
    // or post-filter — this method exists for interface completeness.
    return `1`; // no-op — distance filtering is post-query on Turso
  }

  createTableDDL(table: string, dim: number): string {
    return `CREATE TABLE IF NOT EXISTS ${table} (node_id INTEGER PRIMARY KEY, embedding vector(${dim}))`;
  }

  createIndexDDL(table: string, column: string, metric: VectorMetric): string {
    const fn = metric === 'cosine' ? 'vector_distance_cos' : metric === 'l2' ? 'vector_distance_l2' : 'vector_distance_dot';
    return `CREATE INDEX IF NOT EXISTS idx_${table}_embedding ON ${table} (libsql_vector_idx(${column}, '${fn}'));`;
  }

  topKQuery(table: string, column: string, queryVec: number[], k: number, metric: VectorMetric): { sql: string; args: unknown[] } {
    const { selectExpr, whereExpr, orderExpr, limitExpr } = topKQueryCore(table, column, k, 'turso', metric);
    const sql = `SELECT ${selectExpr} FROM ${table} v JOIN node n ON n.rowid = v.node_id WHERE ${whereExpr} ${orderExpr} ${limitExpr}`;
    return { sql, args: [vecToBlob(queryVec), k] };
  }

  async initialize(_db: unknown): Promise<void> {
    // Turso native vector support is built-in — no dynamic extension loading needed.
  }
}

// ── Factory ──

export function createVectorDialect(adapterType: string): VectorDialect {
  return adapterType === 'turso' ? new TursoVectorDialect() : new SqliteVecDialect();
}
```

### Initialization: the ONE exception

`SqliteVecDialect.initialize(db)` takes `unknown` — it's the raw `better-sqlite3.Database` handle from `SqliteAdapter.unwrap()`. This is the **only** function in the entire system that calls `unwrap()`. It is guarded by `adapter.config.type === 'sqlite'` at the call site (`openDb()`). On TursoAdapter, `TursoVectorDialect.initialize()` is a no-op — native vectors need no dynamic extension loading.

This is not a hole in the design. It's the only genuine, fundamental platform difference: sqlite-vec is a C extension loaded at runtime; Turso's `vector(N)` is built into the libsql engine. No amount of abstraction can bridge this — they are different C ABIs. Every other function runs on BOTH backends.

---

## Solution 2: `openDb()` — fully adapter-aware, zero raw DB access outside the guarded exception

### Every init function accepts `StoreAdapter`

There is no "init-only helpers stay on SqliteAdapter" category. Every function that touches the database — `stampStoreMeta()`, `verifyStoreMeta()`, `migrateAddColumn()`, init-specific column migrations — accepts `StoreAdapter`. The `openDb()` function branches on adapter type only for `sqliteVec.load()` (the ONE exception). Everything else uses `adapter.execute*()`.

### Change: `db.ts` — `openDb()`

```typescript
// db.ts — inside openDb()

// BEFORE (db.ts:207-210)
const { createSqliteAdapter } = await import('@adhd/sox-store-adapter');
const adapter = createSqliteAdapter({ dbPath }) as SqliteAdapter;
const rawDb = adapter.unwrap();

// AFTER
const { createStoreAdapter, createVectorDialect } =
  await import('@adhd/sox-store-adapter');
const adapter = await createStoreAdapter({ dbPath });
const vectorDialect = createVectorDialect(adapter.config.type);

// ── Native extension loading — the ONE exception ──
if (adapter.config.type === 'sqlite') {
  const sqliteAdapter = adapter as SqliteAdapter;
  await vectorDialect.initialize(sqliteAdapter.unwrap());
  // TursoAdapter: vectorDialect.initialize() is a no-op — native vectors are built-in
}

// ── WAL journal mode — both adapters support it ──
await adapter.pragmaSet('journal_mode', 'WAL');

// ── Init helpers — ALL accept StoreAdapter ──
await stampStoreMeta(adapter);
await verifyStoreMeta(adapter);

// ── Column migrations — ALL through adapter ──
await migrateAddColumn(adapter, 'node', 'namespace', 'TEXT');
await migrateAddColumn(adapter, 'node', 't_expires', 'TEXT');
await migrateAddColumn(adapter, 'node', 'level', 'INTEGER');
await migrateAddColumn(adapter, 'node', 'embed_model', 'TEXT');
await migrateAddColumn(adapter, 'edge', 'weight', 'REAL');
// ... all remaining column migrations

// ── Pre-DDL defensive column migration (table_info scan) ──
const nodeResult = await adapter.executeAll<{ name: string }>(
  'PRAGMA table_info(node)'
);
const nodeCols = new Set(nodeResult.rows.map((c) => c.name));
if (!nodeCols.has('enrich_ver')) {
  await adapter.exec('ALTER TABLE node ADD COLUMN enrich_ver INTEGER');
}
// ... same pattern for all remaining columns

// ── Vec DDL through VectorDialect ──
await adapter.exec(vectorDialect.createTableDDL('vec_node', EMBED_DIM));
// For TursoAdapter: also create the ANN index
const indexDDL = vectorDialect.createIndexDDL('vec_node', 'embedding', 'cosine');
if (indexDDL) await adapter.exec(indexDDL);

// ── FTS triggers — standard SQL, identical on both backends ──
await adapter.exec(FTS_TRIGGERS);

// ── Request ledger — standard SQL ──
// ... (unchanged portable DDL)

// ── Return augmented adapter ──
return Object.assign(adapter, { vectorDialect }) as StoreAdapter & {
  vectorDialect: VectorDialect;
};
```

### `openDbReadOnly()`

Same adapter-aware pattern. SqliteAdapter path loads sqlite-vec via `vectorDialect.initialize()`. TursoAdapter path skips it.

### `schema.ts` — remove vec0 DDL line

Remove the hardcoded sqlite-vec DDL from `schema.ts` line 49:
```sql
-- REMOVE THIS LINE:
CREATE VIRTUAL TABLE IF NOT EXISTS vec_node USING vec0(node_id INTEGER PRIMARY KEY, embedding FLOAT[768]);
```

The vec_node DDL now comes from `VectorDialect.createTableDDL()` in `openDb()`. All other DDL in `schema.ts` is portable SQLite and remains unchanged.

### Init helpers — all migrated to `StoreAdapter`

| Function | Signature change | Description |
|---|---|---|
| `stampStoreMeta()` | `(db: Database.Database) → void` → `(adapter: StoreAdapter) → Promise<void>` | 4 `INSERT OR IGNORE` via `adapter.executeRun()` — same SQL |
| `verifyStoreMeta()` | `(db: Database.Database) → void` → `(adapter: StoreAdapter) → Promise<void>` | SELECT via `adapter.executeAll()` — same SQL, throws `EStoreMismatch` |
| `migrateAddColumn()` | `(db: Database.Database, table, col, type) → void` → `(adapter: StoreAdapter, table, col, type) → Promise<void>` | `PRAGMA table_info` via `adapter.executeAll()`, `ALTER TABLE ADD COLUMN` via `adapter.exec()` |
| Pre-DDL column migrations | `rawDb.prepare().all()` → `adapter.executeAll()` | Identical column-existence guard logic, different execution method |

**Unchanged:** `FTS_TRIGGERS` — standard SQL, identical on both backends. No VectorDialect or adapter branching needed.

---

## Solution 3: `memoryRecall()` — dialect routing for the KNN query

### Change: `recall.ts` — accepts VectorDialect, routes KNN through it

```typescript
// Function signature adds vectorDialect parameter
export async function memoryRecall(
  adapter: StoreAdapter,
  vectorDialect: VectorDialect, // ← NEW
  scope: string,
  params: RecallParams,
): Promise<RecallResponse> {
  // ... (embedding computation, validity clause construction, knnLimit unchanged)

  // 2a. Vector KNN — route through dialect
  let vecRows: { node_id: number; distance: number }[] = [];
  if (queryVec && !embedVecFailed) {
    const { sql, args } = vectorDialect.topKQuery(
      'vec_node',
      'embedding',
      queryVec,
      knnLimit,
      'cosine',
    );

    // Interpolate validity/filter predicates into the __PLACEHOLDER__ slot
    const finalSql = sql.replace(
      '__PLACEHOLDER__',
      `${validityPred} ${agentFilter} ${filterSql}`,
    );
    // Combine dialect args with caller's filter params + LIMIT
    const finalArgs = [...args, ...filterParams, knnLimit];

    const vecResult = await adapter.executeAll<VecRow>(finalSql, finalArgs);
    vecRows = vecResult.rows;
  }

  // ... (rest of recall unchanged — vecRows consumed identically on both backends)
}
```

### Callers — thread vectorDialect from connection context

All callers of `memoryRecall()` in memory-server obtain the dialect from the connection:

```typescript
const { adapter, vectorDialect } = await getDb(dbPath);
const result = await memoryRecall(adapter, vectorDialect, scope, params);
```

### The `__PLACEHOLDER__` pattern

The dialect emits SQL with a `__PLACEHOLDER__` token where validity/filter predicates belong. The caller interpolates them. This keeps the dialect unaware of scope-specific clauses (validity predicates, agent filters, custom filter SQL) — those are `recall.ts`'s concern. The pattern is generic: both `SqliteVecDialect.topKQuery()` and `TursoVectorDialect.topKQuery()` emit the same `__PLACEHOLDER__` token.

### SQL comparison

| Backend | KNN Query Shape |
|---|---|
| **SqliteVecDialect** | `SELECT v.node_id, v.distance FROM vec_node v JOIN node n ON n.rowid = v.node_id WHERE v.embedding MATCH ? AND k = ? AND <filters> ORDER BY v.distance LIMIT ?` |
| **TursoVectorDialect** | `SELECT v.node_id, vector_distance_cos(v.embedding, ?) AS distance FROM vec_node v JOIN node n ON n.rowid = v.node_id WHERE <filters> ORDER BY distance LIMIT ?` |

The caller doesn't need to know which shape. `topKQuery()` returns `{ sql, args }`, the caller interpolates filters, and `adapter.executeAll()` runs the query.

---

## Solution 4: WriteQueue — fully backend-agnostic, async, adapter-integrated

### The WriteQueue is NOT "swap the type and hope." It is a complete adapter integration.

The WriteQueue's **internal architecture stays the same** (FIFO ordering, latency ring estimator, saturation hysteresis, per-task `kind` segregation). What changes:

1. **Constructor accepts `StoreAdapter`** instead of `Database.Database`
2. **Task callbacks receive `AdapterTransaction`** — each task is wrapped in `adapter.transaction()` with `{ mode: 'immediate' }`
3. **Every DB operation goes through the adapter** — zero raw `db.prepare()` calls
4. **Adapter-specific operations are guarded** — PRAGMA busy_timeout only on SqliteAdapter
5. **WAL management is adapter-aware** — `walBytes()` returns 0 for Turso (no local WAL file), `walCheckpoint()` uses `adapter.executeGet()`

### File: `write-queue.ts` — complete changes

**Backing store type:**

```typescript
// BEFORE
import Database from 'better-sqlite3';
private db: Database.Database;

// AFTER
import type { StoreAdapter, AdapterTransaction } from '@adhd/sox-store-adapter';
private adapter: StoreAdapter;
```

**Constructor:**

```typescript
// BEFORE
private constructor(rawDb: Database.Database, dbPath: string, maxSize = 100) {
  this.db = rawDb;
  this.db.exec('PRAGMA busy_timeout = 3000;');
}

// AFTER
private constructor(adapter: StoreAdapter, dbPath: string, maxSize = 100) {
  this.adapter = adapter;
  // PRAGMA busy_timeout is only meaningful for local better-sqlite3 connections.
  // TursoAdapter doesn't support it (HTTP-based, no persistent connection).
  if (adapter.config.type === 'sqlite') {
    void adapter.pragmaSet('busy_timeout', 3000).catch(() => {
      // Non-fatal — busy_timeout is a quality-of-life setting, not correctness.
    });
  }
}
```

**`_create()` factory:**

```typescript
// BEFORE
private static async _create(dbPath: string, maxSize?: number): Promise<WriteQueue> {
  const adapter = await openDb(dbPath);
  const rawDb = adapter.unwrap() as Database.Database; // ← CAST — breaks on Turso
  return new WriteQueue(rawDb, dbPath, maxSize);
}

// AFTER
private static async _create(dbPath: string, maxSize?: number): Promise<WriteQueue> {
  const adapter = await openDb(dbPath); // ← returns StoreAdapter (SqliteAdapter or TursoAdapter)
  return new WriteQueue(adapter, dbPath, maxSize);
}
```

**`enqueue()` callback type:**

```typescript
// BEFORE
interface QueueItem<T> {
  operation: (db: Database.Database) => T | Promise<T>;
}

enqueue<T>(
  label: string,
  operation: (db: Database.Database) => T | Promise<T>,
  kind?: TaskKind,
): Promise<T>;

// AFTER
interface QueueItem<T> {
  operation: (tx: AdapterTransaction) => T | Promise<T>;
}

enqueue<T>(
  label: string,
  operation: (tx: AdapterTransaction) => T | Promise<T>,
  kind?: TaskKind,
): Promise<T>;
```

**`_processNext()` — wrap each task in a transaction:**

```typescript
// BEFORE — task body runs on raw connection, no explicit transaction boundary
this.running = true;
try {
  const result = await item.operation(this.db);
  // ... latency recording, resolve
} catch (err) {
  // ... reject
}

// AFTER — task body runs inside adapter.transaction() with explicit mode
this.running = true;
try {
  const result = await this.adapter.transaction(
    async (tx) => item.operation(tx),
    { mode: 'immediate' }, // WriteQueue tasks are CAS-protected writes
  );
  // ... latency recording, resolve
} catch (err) {
  // ... reject (adapter.transaction() auto-rolls back)
}
```

The transaction mode is `'immediate'` because every WriteQueue task is a CAS-protected write — if the write collides with another writer, `BEGIN IMMEDIATE` fails fast with `SQLITE_BUSY` rather than silently waiting for an unlock and risking TOCTOU. On TursoAdapter, `BEGIN IMMEDIATE` maps to the same `BEGIN IMMEDIATE` SQL (both adapters use the same SQLite-level primitives). On SqliteAdapter, it uses the RESERVED lock at start.

**WAL checkpointing — adapter-aware:**

```typescript
// BEFORE — sync raw prepare
private async walCheckpoint(): Promise<void> {
  const row = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  // ...
}

// AFTER — async through adapter
private async walCheckpoint(): Promise<void> {
  const row = await this.adapter.executeGet<{
    busy: number;
    log: number;
    checkpointed: number;
  }>('PRAGMA wal_checkpoint(TRUNCATE)');
  // ...
}
```

**WAL file size — adapter-aware:**

```typescript
// BEFORE — reads filesystem path from db.name
private walBytes(): number {
  try {
    const walPath = this.db.name + '-wal';
    return fs.statSync(walPath).size;
  } catch {
    return 0;
  }
}

// AFTER — only meaningful for local SQLite files
private walBytes(): number {
  if (this.adapter.config.type === 'turso') return 0; // remote — no local WAL file
  const dbPath = this.adapter.config.dbPath;
  if (!dbPath) return 0;
  try {
    return fs.statSync(dbPath + '-wal').size;
  } catch {
    return 0;
  }
}
```

**Lifecycle — async close:**

```typescript
// BEFORE
private async drainAndClose(): Promise<void> {
  // ... drain queue
  this.db.close();
}

static async clearInstances(): Promise<void> {
  for (const q of this.instances.values()) {
    q.db.close();
  }
  this.instances.clear();
}

// AFTER
private async drainAndClose(): Promise<void> {
  // ... drain queue
  await this.adapter.close();
}

static async clearInstances(): Promise<void> {
  for (const q of this.instances.values()) {
    await q.adapter.close();
  }
  this.instances.clear();
}
```

**Saturation log — replace `this.db.name`:**

```typescript
// BEFORE
const path = this.db.name;

// AFTER
const path = this.adapter.config.dbPath ?? this._storePath;
```

### Caller migration — mechanical, same SQL

Every `wq.enqueue()` callback changes from `(db) => fn(db, ...)` to `(tx) => fn(tx, ...)`. The function bodies change from `db.prepare().get()`/`.run()` to `tx.executeGet()`/`tx.executeRun()`. Same SQL, same logic, different execution method:

| File | Call site | Change |
|---|---|---|
| `write.ts` | `memoryWritePhaseA` | `(db) => writeBody(db, ...)` → `(tx) => writeBody(tx, ...)` |
| `write.ts` | `memoryWriteBatchPhaseA` | `(db) => batchBody(db, ...)` → `(tx) => batchBody(tx, ...)` |
| `embed-pipeline.ts` | `schedulePendingEmbeds` apply | `(qdb) => applyEmbedding(qdb, ...)` → `(tx) => applyEmbedding(tx, ...)` |
| `embed-pipeline.ts` | `healMissingVectors` apply | `(qdb) => applyEmbedding(qdb, ...)` → `(tx) => applyEmbedding(tx, ...)` |
| `embed-pipeline.ts` | `healStaleVectors` ops | `(qdb) => { qdb.prepare(...).run() }` → `(tx) => { await tx.executeRun(...) }` |
| `curate.ts` | retag/setTopic/etc. | `(db) => db.prepare(...)` → `(tx) => tx.executeRun(...)` |
| `update.ts` | `memoryUpdate` | `(db) => updateBody(db, ...)` → `(tx) => updateBody(tx, ...)` |
| `cluster.ts` | cluster writes | Mechanical |
| `autolink.ts` | autolink writes | Mechanical |

### What DOESN'T change

- FIFO ordering (queue array + shift pattern)
- Admission control estimator (latency ring, `RECENT_AVG_WINDOW`)
- Saturation hysteresis (`_saturationMode`, two thresholds)
- Per-task `kind` metrics segregation
- `SOX_DISABLE_WRITE_QUEUE=1` bypass
- `SOX_WRITEQ_DEADLINE_MS` / `SOX_WRITEQ_NO_DEADLINE=1` deadline control
- WAL checkpoint idle timer (`CHECKPOINT_IDLE_MS` = 2000ms)
- Any non-DB queue logic

---

## Solution 5: `applyEmbedding()` — backend-agnostic through AdapterTransaction + adapterConfigType

### The function works on BOTH backends. No if/else branching.

`applyEmbedding()` is called from WriteQueue tasks that are now wrapped in `adapter.transaction()`. It receives the transaction handle and serializes vectors based on adapter type:

```typescript
// BEFORE — sync, takes Database.Database, creates its own synchronous transaction
export function applyEmbedding(
  db: Database.Database,
  pending: PendingEmbed,
  vec: Float32Array,
): EmbedApplyResult {
  const tx = db.transaction((): EmbedApplyResult => {
    const row = db.prepare('SELECT uid, t_invalid FROM node WHERE rowid = ?').get(pending.rowid);
    if (!row || row.uid !== pending.uid) return { status: 'gone', near_dup: null };
    // ... INSERT vec_node with vecToJson(vec)
    // ... UPDATE node SET embed_model
    // ... near-dup detection
  });
  return tx();
}

// AFTER — async, takes AdapterTransaction (WriteQueue owns boundary),
//        serializer selected by adapterConfigType
export async function applyEmbedding(
  tx: AdapterTransaction,
  pending: PendingEmbed,
  vec: Float32Array,
  adapterConfigType: string,
): Promise<EmbedApplyResult> {
  const row = await tx.executeGet<{ uid: string; t_invalid: string | null }>(
    'SELECT uid, t_invalid FROM node WHERE rowid = ?',
    [pending.rowid],
  );
  if (!row || row.uid !== pending.uid) {
    return { status: 'gone', near_dup: null };
  }

  const existing = await tx.executeGet<{ node_id: number }>(
    'SELECT node_id FROM vec_node WHERE node_id = ?',
    [pending.rowid],
  );
  if (existing) {
    return { status: 'exists', near_dup: null };
  }

  // Vector serialization: JSON for sqlite-vec, BLOB for Turso
  const serializedVec =
    adapterConfigType === 'turso' ? vecToBlob(vec) : vecToJson(vec);

  await tx.executeRun(
    'INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)',
    [pending.rowid, serializedVec],
  );

  // BL-88: stamp embed_model in the same transaction
  await tx.executeRun(
    'UPDATE node SET embed_model = ? WHERE rowid = ?',
    [getActiveEmbedModel() ?? 'unknown', pending.rowid],
  );

  // Deferred E8 near-dup pass — same migration pattern
  const nearDup = await detectNearDupTx(tx, pending.rowid, pending.contentHash);
  if (nearDup) {
    await applyNearDupResultTx(tx, pending.rowid, nearDup);
  }

  return { status: 'applied', near_dup: nearDup };
}
```

### `detectNearDupTx` and `applyNearDupResultTx`

Same migration — accept `AdapterTransaction`, use `tx.execute*()` methods. Same SQL, same logic.

### Why `adapterConfigType` not boolean `capabilities.nativeVectors`?

The adapter type IS the flag. `adapter.config.type === 'turso'` is the single source of truth. The `capabilities.nativeVectors` boolean duplicates information and introduces a synchronization risk. Code that reads capabilities must stay in sync with the adapter factory; code that reads `config.type` is always correct. The `vecToBlob` and `vecToJson` helpers are exported from `vector-dialect.ts` for reuse across embed-pipeline and migration scripts.

---

## Solution 6: Backlog consumer — healMissingVectors & healStaleVectors are backend-agnostic

### Why they work on Turso

The original solutions classified `healMissingVectors()` and `healStaleVectors()` as "permanently SqliteAdapter-only" with the rationale that "Turso stores don't need vector healing because every write runs embedding inline with transactional consistency." This is **incorrect.**

The two-phase write architecture (Phase A commits the node row, Phase B inserts the vector) is **identical on both backends**. On both sqlite-vec AND Turso, an episode can be committed to the `node` table without a corresponding `vec_node` entry if:
- The embed provider returns asynchronously (Phase B runs after Phase A)
- The embed worker crashes between Phase A and Phase B
- A write times out before the embed completes
- `SOX_SYNC_EMBED` flag is not set

On both backends, the heal scan query is identical:

```sql
SELECT n.rowid, n.content
FROM node n
WHERE n.kind = 'episode'
  AND n.t_invalid IS NULL
  AND n.content IS NOT NULL AND n.content != ''
  AND NOT EXISTS (SELECT 1 FROM vec_node v WHERE v.node_id = n.rowid)
ORDER BY n.rowid
LIMIT ?
```

This query works on both sqlite-vec (`vec0` virtual table) and Turso (native `vector(N)` column table). The `vec_node` table structure differs, but the `NOT EXISTS` subquery is standard SQL.

### Both functions accept `StoreAdapter`

```typescript
// BEFORE — takes Database.Database, embeds reference to WriteQueue
export async function healMissingVectors(
  db: Database.Database,
  wq: WriteQueue,
  opts?: { batchSize?: number; maxBatches?: number },
): Promise<HealResult> {
  const pendings = db.prepare(
    `SELECT n.rowid, n.content, n.embed_model, n.uid FROM node n ...`
  ).all(opts?.batchSize ?? 500);
  // ... for each pending, embed then enqueue apply
}

// AFTER — takes StoreAdapter, embeds reference to WriteQueue
export async function healMissingVectors(
  adapter: StoreAdapter,
  wq: WriteQueue,
  opts?: { batchSize?: number; maxBatches?: number },
): Promise<HealResult> {
  const result = await adapter.executeAll<PendingEmbedRow>(
    `SELECT n.rowid, n.content, n.embed_model, n.uid FROM node n
     WHERE n.kind = 'episode' AND n.t_invalid IS NULL
       AND n.content IS NOT NULL AND n.content != ''
       AND NOT EXISTS (SELECT 1 FROM vec_node v WHERE v.node_id = n.rowid)
     ORDER BY n.rowid
     LIMIT ?`,
    [opts?.batchSize ?? 500],
  );
  const pendings = result.rows;
  // ... for each pending, embed (off-thread) then enqueue apply through WriteQueue
  //    (WriteQueue is already backend-agnostic — no change needed)
}
```

```typescript
// BEFORE — takes Database.Database
export async function healStaleVectors(
  db: Database.Database,
  wq: WriteQueue,
  opts?: { batchSize?: number; maxBatches?: number },
): Promise<StaleHealResult> {
  const model = getActiveEmbedModel();
  const pendings = db.prepare(
    `SELECT n.rowid, n.content, n.embed_model, n.uid FROM node n
     JOIN vec_node v ON v.node_id = n.rowid
     WHERE n.embed_model IS NOT NULL AND n.embed_model != ? AND n.t_invalid IS NULL`
  ).all(model);
  // ...
}

// AFTER — takes StoreAdapter. Same JOIN, same SQL shape.
export async function healStaleVectors(
  adapter: StoreAdapter,
  wq: WriteQueue,
  opts?: { batchSize?: number; maxBatches?: number },
): Promise<StaleHealResult> {
  const model = getActiveEmbedModel();
  const result = await adapter.executeAll<PendingEmbedRow>(
    `SELECT n.rowid, n.content, n.embed_model, n.uid FROM node n
     JOIN vec_node v ON v.node_id = n.rowid
     WHERE n.embed_model IS NOT NULL AND n.embed_model != ?
       AND n.t_invalid IS NULL
     ORDER BY n.rowid
     LIMIT ?`,
    [model, opts?.batchSize ?? 500],
  );
  // ...
}
```

### The `applyEmbedding()` call within heal tasks

The heal functions enqueue embed-apply tasks through the WriteQueue. The WriteQueue wraps each task in `adapter.transaction()`. The task body calls `applyEmbedding(tx, ...)` which is already backend-agnostic (Solution 5). The `adapterConfigType` is threaded from the connection context:

```typescript
// In the heal function:
const { adapter, vectorDialect } = await getDb(dbPath);
await healMissingVectors(adapter, wq, { batchSize: 500 });

// In the heal function body, when enqueueing:
wq.enqueue('heal-apply', async (tx) => {
  await applyEmbedding(tx, pending, vec, adapter.config.type);
}, 'apply');
```

**No adapter-type branching. No "Turso-only" or "Sqlite-only" path.** The function works identically on both backends.

---

## Solution 7: Runtime functions — complete migration, zero raw DB access

### Every function that touches the database uses `StoreAdapter`

| Function | File | Signature change | Notes |
|---|---|---|---|
| `initScope()` | `db.ts:423` | `(db: Database.Database) → MemoryScope` → `(adapter: StoreAdapter) → Promise<MemoryScope>` | 4-line mechanical change |
| `embedBacklogStats()` | `embed-pipeline.ts:439` | `(db: Database.Database) → EmbedBacklogStats` → `(adapter: StoreAdapter) → Promise<EmbedBacklogStats>` | 3-line mechanical change |
| `memoryWrite()` | `write.ts:433` | `(db: Database.Database, params)` → Routes through `wq.enqueue()` with `(tx) => writeBody(tx, ...)` | Already uses WriteQueue — only callback body changes |
| `memoryWriteBatch()` | `write.ts:543` | `(db: Database.Database, items)` → Routes through `wq.enqueue()` | Same as memoryWrite |
| `memoryInvalidate()` | `write.ts:650` | `(db: Database.Database, params)` → Routes through `wq.enqueue()` | Same |
| `memoryUpdate()` | `update.ts:350` | Intermediate `(db: Database.Database)` parameter → Routes through `wq.enqueue()` | WQ task body changes to `(tx) => ...` |
| `enrichOnWrite()` | `enrich.ts:130` | Takes `db: Database` → Accepts `AdapterTransaction` | Called inside WriteQueue task |
| `applyNearDupResult()` | `enrich.ts:89` | Same pattern → `AdapterTransaction` | Called from applyEmbedding |
| `reembedNodes()` | `embed.ts:253` | `(db: Database.Database, ...)` → `(adapter: StoreAdapter, ...)` | Read scan through adapter |
| `getReembedCandidates()` | `reembed.ts:140` | `(db: Database.Database)` → `(adapter: StoreAdapter)` | SELECT through adapter |

### Functions that already accept `StoreAdapter` (no further changes needed)

These functions were already migrated: `memoryRecall()`, `memoryCurate()`, `memoryGetSessionState()`, `memorySaveSessionState()`, `memoryLinkNode()`, `memoryGetRelated()`, `checkStoreQuota()`, `clusterStore()`, `runCompactionPass()`, `computeStoreStats()`, `memoryListEntities()`, `memoryUpdatePhaseA()`, `closeDbWithLease()`, `exportMarkdown()` (on the public interface; internal helpers in export.ts still need migration).

---

## Solution 8: Recall pipeline — embed pipeline through dialect

### The full embed→recall pipeline works on both backends

```
Write path:
  memory_write → Phase A (WriteQueue task) → node row committed
               → Phase B (embed worker returns) → applyEmbedding(tx, ...)
                 → vec_node INSERT with correct serialization (JSON or BLOB)
                 → near-dup pass

Heal path:
  healMissingVectors(adapter) → SELECT nodes without vec_node
    → embed(content) off-thread → WriteQueue enqueue
      → applyEmbedding(tx, pending, vec, adapter.config.type)

Recall path:
  memoryRecall(adapter, vectorDialect, ...)
    → vectorDialect.topKQuery('vec_node', 'embedding', queryVec, knnLimit, 'cosine')
    → adapter.executeAll(dialectSQL, dialectArgs)
    → + FTS5 keyword (unchanged) → fusion → result
```

The dialect is selected once at `openDb()` time. Every subsequent operation — write, heal, recall — routes through `VectorDialect.topKQuery()` or `adapter.execute*()`. There is no branching on adapter type in the hot path.

---

## Solution 9: Factory default + bundle configuration

### `factory.ts` — default IS `'turso'`, and that is correct

```typescript
// Current (factory.ts:19) — DO NOT CHANGE
const adapterType = (process.env.STORE_ADAPTER || 'turso').toLowerCase();
```

**Rationale:** Turso is the default adapter. Fresh setups get Turso automatically. Existing better-sqlite3 installations that haven't migrated must explicitly set `STORE_ADAPTER=sqlite` until they migrate.

### Rollback behavior

The `STORE_ADAPTER` env var functions as a feature flag in reverse:
- **Fresh installs:** No env var needed → Turso (default)
- **Legacy (pre-migration):** Must set `STORE_ADAPTER=sqlite` explicitly in env/config
- **Post-migration:** Remove the env var → Turso (default)
- **Emergency rollback:** Set `STORE_ADAPTER=sqlite` + swap `.bak` file → instant fallback

### Bundle config — `@tursodatabase/database` as optional peerDep

1. **Add to `package.json`:**
   ```json
   "peerDependencies": { "@tursodatabase/database": ">=0.7.0" },
   "peerDependenciesMeta": { "@tursodatabase/database": { "optional": true } }
   ```

2. **Add to build externals:** `--external @tursodatabase/database`

3. **Rebuild + smoke test:**
   ```bash
   npx nx build memory-server
   npx nx run registry:sync-index
   STORE_ADAPTER=sqlite node scripts/smoke-test.mjs --extension memory-server
   STORE_ADAPTER=turso node scripts/smoke-test.mjs --extension memory-server
   ```

---

## Solution 10: Live data migration — both modes, both directions, sandbox coverage

### Two migration modes

**Copy-then-swap (default, recommended):**
```
1. Stop memory-server
2. cp ~/.memory/memory.db ~/.memory/memory-turso.db
3. Run migration against the COPY: migrate-store-to-turso.mjs --mode copy
4. Verify recall parity: verify-recall-parity.mjs --sqlite <orig> --turso <copy>
5. mv ~/.memory/memory.db ~/.memory/memory.db.bak
6. mv ~/.memory/memory-turso.db ~/.memory/memory.db
7. Restart with STORE_ADAPTER unset (Turso is the default)
```

**In-place (constrained environments — Docker, network mounts):**
```
1. Stop memory-server
2. cp ~/.memory/memory.db ~/.memory/memory.db.pre-turso
3. Run migration in-place: migrate-store-to-turso.mjs --mode in-place
4. Verify recall parity
5. Restart with STORE_ADAPTER unset
```

### Reverse migration: Turso → SQLite (rollback safety)

The migration script also supports reverse migration for rollback verification:

```bash
node scripts/migrate-store-to-turso.mjs \
  --mode copy \
  --direction reverse \
  --source ~/.memory/memory.db \         # the Turso store
  --target ~/.memory/memory-sqlite.db    # the sqlite-vec target
```

This tests that the migration pipeline works in both directions:
1. Opens SOURCE with TursoAdapter, TARGET with SqliteAdapter
2. Copies all non-vec tables verbatim
3. Reads vectors from Turso's native `vector(768)` column
4. Re-inserts them into sqlite-vec's `vec0` virtual table (JSON serialization)

The reverse migration is **not required for go-live** — it's a safety net. If Turso fails catastrophically in production, the path back to sqlite-vec is tested and verified.

### Migration sandbox — comprehensive coverage

Before touching the 70MB live store, test **every combination**:

```bash
# 1. Generate synthetic test stores
node scripts/generate-test-store.mjs --episodes 100   --output dist/sandbox/test-tiny.db
node scripts/generate-test-store.mjs --episodes 1000  --output dist/sandbox/test-small.db
node scripts/generate-test-store.mjs --episodes 10000 --output dist/sandbox/test-large.db

# 2. Edge case stores
node scripts/generate-test-store.mjs --empty           --output dist/sandbox/test-empty.db
node scripts/generate-test-store.mjs --all-invalidated --output dist/sandbox/test-invalidated.db
node scripts/generate-test-store.mjs --no-embeddings   --output dist/sandbox/test-no-vec.db

# 3a. SQLite → Turso migration (primary go-live path)
for store in dist/sandbox/test-*.db; do
  echo "=== SQLite→Turso: $store ==="
  STORE_ADAPTER=turso node scripts/migrate-store-to-turso.mjs \
    --source "$store" --target "${store%.db}-turso.db"
  node scripts/verify-recall-parity.mjs \
    --sqlite "$store" --turso "${store%.db}-turso.db" \
    || echo "FAILED (forward): $store"
done

# 3b. Turso → SQLite migration (reverse / rollback safety)
for store in dist/sandbox/test-*.db; do
  local turso_copy="${store%.db}-turso.db"
  echo "=== Turso→SQLite: $turso_copy ==="
  STORE_ADAPTER=sqlite node scripts/migrate-store-to-turso.mjs \
    --direction reverse --source "$turso_copy" --target "${turso_copy%.db}-roundtrip.db"
  node scripts/verify-recall-parity.mjs \
    --sqlite "${turso_copy%.db}-roundtrip.db" --turso "$turso_copy" \
    || echo "FAILED (reverse): $turso_copy"
done

# 3c. Fresh Turso setup (no migration — end-to-end verification)
STORE_ADAPTER=turso node scripts/verify-fresh-setup.mjs \
  --db dist/sandbox/test-fresh.db
# This script:
#   1. Creates a fresh store with TursoAdapter
#   2. Writes 100 episodes
#   3. Recalls 50 random queries
#   4. Asserts all writes are recallable within 5 seconds
#   5. Asserts no crashes, no error logs

# 3d. Fresh SQLite setup (legacy compatibility verification)
STORE_ADAPTER=sqlite node scripts/verify-fresh-setup.mjs \
  --db dist/sandbox/test-fresh-sqlite.db

# 4. Measure re-embed time at scale
#    "test-large.db" with 10K episodes tells you the real ~8 min estimate

# 5. Clean up sandbox
rm -rf dist/sandbox/
```

### What each sandbox test validates

| Test | Validates |
|---|---|
| **SQLite→Turso forward** | Primary go-live path: schema migration, vector re-embed, recall parity, OOM safety at scale |
| **Turso→SQLite reverse** | Rollback safety: the path back exists and works, vectors survive a roundtrip |
| **Fresh Turso setup** | Clean-slate installs: openDb, WriteQueue, write pipeline, recall pipeline all work on Turso without any migration |
| **Fresh SQLite setup** | Legacy compatibility: existing sqlite-vec path still works, no regression |
| **Edge cases** | Empty store, all-invalidated nodes, missing vectors — migration doesn't crash |
| **Scale (10K)** | Batch size = 500, no OOM, re-embed time measured |

### Migration script: `scripts/migrate-store-to-turso.mjs`

Core logic:

1. Open SOURCE with the source adapter (SqliteAdapter for forward, TursoAdapter for reverse)
2. Open TARGET with the target adapter (TursoAdapter for forward, SqliteAdapter for reverse)
3. Copy all non-vec_node tables verbatim (node, edge, FTS, organizer_queue, memory_scope, sox_store_meta, request_ledger, promotion_queue) — preserving rowid
4. Create `vec_node` in target using target's `VectorDialect.createTableDDL('vec_node', EMBED_DIM)`
5. Re-embed all live episode vectors: SELECT rowid, content → embed(content) → INSERT INTO vec_node. Batch size: 500
6. Build ANN index using target's `VectorDialect.createIndexDDL('vec_node', 'embedding', 'cosine')`
7. Verify row count parity

### Verification script: `scripts/verify-recall-parity.mjs`

Runs 100 random queries against both source and target, compares top-10 results. Allows slight float differences in distance scores but requires identical **rank order and node UIDs**. Pass threshold: ≥98% of queries produce identical rank order.

---

## Solution 11: Backlog consumer CAS pattern — transaction mode mapping

### `BEGIN IMMEDIATE` is the CAS primitive for both adapters

The `BEGIN IMMEDIATE` SQL statement is the foundation of the backlog consumer's compare-and-swap pattern. Both adapters support it identically through `transaction(fn, { mode: 'immediate' })`:

```typescript
// SqliteAdapter — sqlite-adapter.ts:178
case 'immediate': return 'BEGIN IMMEDIATE';

// TursoAdapter — turso-adapter.ts:193
case 'immediate': return 'BEGIN IMMEDIATE';
```

The semantics are identical on both backends: acquire a RESERVED lock at transaction start, preventing any other writer from entering a write transaction. Readers are not blocked (RESERVED lock allows shared reads). If the lock cannot be acquired immediately (another writer holds RESERVED or higher), `SQLITE_BUSY` is thrown.

### Transaction mode mapping

| `mode` | SQL | Lock Level | SqliteAdapter | TursoAdapter | Use Case |
|---|---|---|---|---|---|
| `'deferred'` | `BEGIN DEFERRED` | None until first write | ✅ | ✅ | Read-modify-write where TOCTOU is acceptable |
| `'immediate'` | `BEGIN IMMEDIATE` | RESERVED at start | ✅ | ✅ | **CAS primitive** — prevents TOCTOU for idempotent writes |
| `'exclusive'` | `BEGIN EXCLUSIVE` | EXCLUSIVE at start | ✅ | ✅ | Schema migrations, operations that must be alone |
| `'concurrent'` | `BEGIN CONCURRENT` | Optimistic (commit-time) | ❌ (throws) | ✅ | MVCC workloads — multiple concurrent writers |

### Usage in backlog consumer

The backlog consumer uses `BEGIN IMMEDIATE` for CAS-protected writes:

```typescript
// Claim a backlog item atomically:
const claimed = await adapter.transaction(async (tx) => {
  // 1. SELECT next unclaimed item
  const item = await tx.executeGet<BacklogItem>(
    'SELECT rowid, * FROM backlog_queue WHERE claimed_by IS NULL ORDER BY rowid LIMIT 1'
  );
  if (!item) return null;

  // 2. Claim it — CAS guard: only update if still unclaimed
  const result = await tx.executeRun(
    "UPDATE backlog_queue SET claimed_by = ?, claimed_at = ? WHERE rowid = ? AND claimed_by IS NULL",
    [workerId, new Date().toISOString(), item.rowid]
  );
  if (result.rowsAffected === 0) return null; // lost race

  return item;
}, { mode: 'immediate' });
```

The `{ mode: 'immediate' }` prevents a TOCTOU race where two consumers read the same unclaimed item before either updates it. With `BEGIN IMMEDIATE`, the first consumer acquires the RESERVED lock and the second gets `SQLITE_BUSY`. The retry wrapper handles the busy error:

```typescript
// withRetry from @adhd/sox-store-adapter — works on both adapters
const item = await withRetry(
  () => adapter.transaction(claimFn, { mode: 'immediate' }),
  { maxRetries: 5, baseDelayMs: 100 },
);
```

### Why `'immediate'` not `'deferred'` for WriteQueue tasks

The WriteQueue wraps every `_processNext()` task in `adapter.transaction(fn, { mode: 'immediate' })`. This is correct:
- WriteQueue tasks are serialized (single-writer), so TOCTOU within the queue is impossible
- But `BEGIN IMMEDIATE` also detects **external** writers — another process that opened the same database file on SqliteAdapter
- On TursoAdapter, `BEGIN IMMEDIATE` protects against concurrent writes from other libsql connections to the same database
- The `SQLITE_BUSY` error is caught by the queue's existing error handling and surfaced to the caller

---

## Solution 12: Testing — both adapters, both directions, verified

### Testing coverage matrix

| Test Suite | SqliteAdapter | TursoAdapter | What It Validates |
|---|---|---|---|
| `memory-core` unit tests | ✅ existing | ✅ **NEW** — run with `STORE_ADAPTER=turso` | All domain logic, all queries, all mutations |
| `store-adapter` unit tests | ✅ existing | ✅ existing | Adapter interface compliance, edge cases |
| `vector-dialect` unit tests | ✅ **NEW** | ✅ **NEW** | DDL generation, topKQuery SQL shape, serialization |
| `write-queue` tests | ✅ existing | ✅ **NEW** — run with `STORE_ADAPTER=turso` | FIFO ordering, admission control, saturation, WAL checkpoint |
| `embed-pipeline` tests | ✅ existing | ✅ **NEW** — run with both adapters | applyEmbedding, backlog stats, heal path |
| `recall` parity tests | ✅ existing | ✅ **NEW** — cross-adapter recall parity | Same query → same results on both backends |
| Migration sandbox | ✅ **NEW** | ✅ **NEW** | Forward migration, reverse migration, fresh setup, edge cases |
| Smoke test | ✅ existing | ✅ **ENHANCED** — `--extension memory-server` with `STORE_ADAPTER=turso` | Full extension lifecycle on both backends |

### Running tests against both backends

```bash
# SqliteAdapter — existing path
STORE_ADAPTER=sqlite npx nx test memory-core
STORE_ADAPTER=sqlite npx nx test vector-store
STORE_ADAPTER=sqlite node scripts/smoke-test.mjs --extension memory-server

# TursoAdapter — NEW path
STORE_ADAPTER=turso npx nx test memory-core
STORE_ADAPTER=turso npx nx test vector-store
STORE_ADAPTER=turso node scripts/smoke-test.mjs --extension memory-server
```

### New test files required

| File | Purpose |
|---|---|
| `libs/data/store/store-adapter/src/__tests__/vector-dialect.test.ts` | Validates both `SqliteVecDialect` and `TursoVectorDialect` DDL, query generation, serialization |
| `libs/memory-core/src/__tests__/recall-parity.test.ts` | Cross-adapter recall parity: same store written on both adapters, recall results compared |
| `libs/memory-core/src/__tests__/heal-backend-agnostic.test.ts` | healMissingVectors and healStaleVectors on both adapters |
| `scripts/verify-fresh-setup.mjs` | End-to-end: fresh store create → write 100 episodes → recall 50 queries → assert recallable |

---

## Execution Order

```
Segment A: VectorDialect implementation (standalone — zero dependencies)
  → Files:
      CREATE libs/data/store/store-adapter/src/vector-dialect.ts (~160 lines)
      MODIFY libs/data/store/store-adapter/src/types.ts (update VectorDialect interface if needed)
      MODIFY libs/data/store/store-adapter/src/index.ts (re-export VectorDialect classes + helpers)
      CREATE libs/data/store/store-adapter/src/__tests__/vector-dialect.test.ts
  → Lines: ~250 new/changed
  → Unblocks: B, C, D

Segment B: Init helpers migration (stampStoreMeta, verifyStoreMeta, migrateAddColumn, initScope)
  → Files:
      MODIFY libs/memory-core/src/db.ts (openDb, openDbReadOnly, stampStoreMeta, verifyStoreMeta,
            migrateAddColumn, initScope, pre-DDL column migrations — all accept StoreAdapter)
      MODIFY libs/memory-core/src/schema.ts (remove vec0 DDL line)
  → Dependencies: Segment A
  → Lines: ~150 changed
  → Unblocks: C, D

Segment C: WriteQueue adapter integration
  → Files:
      MODIFY libs/memory-core/src/write-queue.ts (constructor, _create, enqueue, _processNext,
            walCheckpoint, walBytes, drainAndClose, clearInstances — all async, all adapter-aware)
      MODIFY libs/memory-core/src/write.ts (all wq.enqueue callbacks: (db) → (tx))
      MODIFY libs/memory-core/src/embed-pipeline.ts (applyEmbedding, embedBacklogStats,
            healMissingVectors, healStaleVectors — all accept StoreAdapter or AdapterTransaction)
      MODIFY libs/memory-core/src/enrich.ts (applyNearDupResult, enrichOnWrite → AdapterTransaction)
      MODIFY libs/memory-core/src/curate.ts (wq.enqueue callbacks)
      MODIFY libs/memory-core/src/update.ts (wq.enqueue callbacks)
      MODIFY libs/memory-core/src/cluster.ts (wq.enqueue callbacks)
      MODIFY libs/memory-core/src/autolink.ts (wq.enqueue callbacks)
      MODIFY libs/memory-core/src/embed.ts (reembedNodes → StoreAdapter)
      MODIFY libs/memory-core/src/reembed.ts (getReembedCandidates → StoreAdapter)
      MODIFY libs/memory-core/src/outbox-queue.ts (enqueueIngest, enqueueEnrichFull, hasPendingFullEnrich → StoreAdapter)
  → Dependencies: Segments A, B
  → Lines: ~400 changed (mostly mechanical — same SQL, async execution)
  → Unblocks: D, E

Segment D: Recall pipeline dialect routing + embed pipeline backend-agnostic
  → Files:
      MODIFY libs/memory-core/src/recall.ts (accept VectorDialect, route KNN through dialect)
      MODIFY libs/memory-core/src/embed-pipeline.ts (applyEmbedding backend-agnostic via adapterConfigType)
  → Dependencies: Segments A, C
  → Lines: ~120 changed
  → Unblocks: E

Segment E: Bundle, smoke test, unit tests — BOTH adapters
  → Files:
      MODIFY extensions/bundles/sox-memory-bundle/members/memory-server/package.json (optional peerDep)
      MODIFY extensions/bundles/sox-memory-bundle/members/memory-server/project.json (externals)
      CREATE libs/memory-core/src/__tests__/recall-parity.test.ts
      CREATE libs/memory-core/src/__tests__/heal-backend-agnostic.test.ts
  → Dependencies: Segments C, D
  → Lines: ~100 new + ~20 changed
  → Validates: STORE_ADAPTER=sqlite AND STORE_ADAPTER=turso smoke tests pass

Segment F: Migration scripts + comprehensive sandbox
  → Files:
      CREATE scripts/migrate-store-to-turso.mjs (~200 lines)
      CREATE scripts/verify-recall-parity.mjs (~100 lines)
      CREATE scripts/verify-fresh-setup.mjs (~100 lines)
      CREATE scripts/generate-test-store.mjs (~150 lines)
  → Dependencies: Segment E (bundle must be built to exercise migration)
  → Lines: ~550 new
  → Validates: Forward migration, reverse migration, fresh Turso setup, fresh SQLite setup,
              edge cases (empty, all-invalidated, no-vectors), scale (10K episodes)

Segment G: Rollback + go-live
  → Files: none (operations only — stop server, migrate, verify, swap, restart)
  → Dependencies: Segment F
```

**7 segments** (vs 5 in the previous spec). **~1,600 lines total** (vs ~600 — the increase reflects zero deferrals: every function migrated, both heal functions migrated, reverse migration support added, fresh setup verification added, both adapter test coverage added). Segments A through G are sequential due to dependency chain.

**Parallelizable:** External consumer migrations (backlog, agent-mcp, agent-packages) can run in parallel with A–D — they only need published packages, not the live service flip.

---

## Open Questions

### Q1: Copy-then-swap or in-place migration?

**Answer: Copy-then-swap is the default, in-place is the fallback for constrained environments.**

Copy-then-swap (Section 2, Step 1) gives instant rollback — swap `.bak` back. The 70MB file copies in under a second and the original is never touched. This is the recommended path for standard deployments.

In-place migration (Section 2, Step 1a) is available when copying the full DB file isn't practical — Docker volumes, network mounts, or stores where I/O duplication would be problematic. It drops the `vec0` virtual table and rebuilds vectors in-place against a pre-migration backup savepoint. Rollback requires restoring from the backup. The migration script supports both modes: `scripts/migrate-store-to-turso.mjs --mode copy|in-place`.

### Q2: Bundle `@tursodatabase/database` or optional peerDep?

**Answer: Optional peerDep.** NAPI-RS native addon with platform-specific `.node` bindings. Bundling a macOS binding breaks Linux. Users who don't use Turso never install it. Same pattern as `better-sqlite3`. See Solution 7.

### Q3: Default `STORE_ADAPTER` to `'sqlite'` or `'turso'`?

**Answer: `'turso'`.** Turso is the default — the factory already defaults to `'turso'` and this is the intended behavior. Existing better-sqlite3 installations that haven't migrated must explicitly set `STORE_ADAPTER=sqlite` in their environment or config. The migration process (Solution 8) is the path from legacy to default — once migrated, users remove the override. Fresh installs get Turso with zero configuration.

**Deployment note:** CI and 24/7 daemons that haven't migrated must add `STORE_ADAPTER=sqlite` to their env before upgrading to a build that includes adapter-aware memory-core. This is a one-time configuration change, documented in the CHANGELOG and migration guide.

---

Citations: [sox-ecosystem, architect, deepseek, turso-go-live-revised, 1: libs/data/store/store-adapter/src/types.ts:60-67, 2: libs/data/store/store-adapter/src/factory.ts:18-48, 3: libs/memory-core/src/db.ts:100-448, 4: libs/memory-core/src/write-queue.ts:162-727, 5: libs/memory-core/src/recall.ts:283-439, 6: libs/memory-core/src/embed-pipeline.ts:290-650, 7: libs/memory-core/src/schema.ts:1-91, 8: libs/data/store/store-adapter/src/sqlite-adapter.ts:1-236, 9: libs/data/store/store-adapter/src/turso-adapter.ts:1-248, 10: libs/data/store/store-adapter/src/retry.ts:1-49, 11: tools/bundle-extension.cjs:109-167, 12: extensions/bundles/sox-memory-bundle/members/memory-server/package.json:1-31]

---

## Section 6: Optimized Execution Plan

> **Decomposes the 7 segments (A–G) into 26 dispatchable task packets across 6 waves, with verifiable gates per packet and a comprehensive end-to-end verification protocol.**
>
> **Wave structure maximizes parallelization:** Wave 0 (Foundation) stands alone. Wave 1 and Wave 2 are the sequential core. Waves 3–5 are parallel-packed build/test/script creation, capped by a linear verification protocol.
>
> **Token budgets are estimates** for dispatch planning — actual usage depends on agent model and context window.

### Wave overview

| Wave | Focus | Packets | Parallelism | Depends on |
|------|-------|---------|-------------|------------|
| **Wave 0** | Foundation: VectorDialect + types | 3 | P0.1 ∥ P0.2 → P0.3 | (none) |
| **Wave 1** | Core: openDb, schema, WriteQueue, recall | 4 | P1.1 ∥ P1.2; P1.3, P1.4 → P1.1 | Wave 0 |
| **Wave 2** | Remaining: embed pipeline, all callers | 5 | All 5 in parallel | Wave 1 |
| **Wave 3** | Bundle config + test files + smoke | 3 | P3.1 → P3.2 → P3.3 | Wave 2 |
| **Wave 4** | Migration scripts | 4 | All 4 in parallel | Wave 3 |
| **Wave 5** | Verification protocol | 7 | Sequential (each proves the previous) | Wave 4 |

**Total: 26 packets, ~1,600 lines of new/changed code**, matching the estimate from Section 2.

---

### Wave 0: Foundation — VectorDialect + types

**Depends on:** nothing
**Unblocks:** Everything. All subsequent packets import `VectorDialect`, `SqliteVecDialect`, `TursoVectorDialect`, `vecToJson`, `vecToBlob`, and `createVectorDialect`.

---

#### P0.1 — Create VectorDialect implementation

| Field | Value |
|-------|-------|
| **Name** | Core VectorDialect classes + helpers + factory |
| **Description** | Create `vector-dialect.ts` with full implementations of `SqliteVecDialect`, `TursoVectorDialect`, serialization helpers (`vecToJson`, `vecToBlob`), `topKQueryCore` shared helper, and `createVectorDialect` factory function. Follows Solution 1 spec exactly — both classes mandatory at go-live, no deferred `TursoVectorDialect`. |
| **reserved_files** | `libs/data/store/store-adapter/src/vector-dialect.ts` (CREATE) |
| **depends_on** | — |
| **input_tokens** | ~3,500 (interface from types.ts lines 60–67, full Solution 1 spec, serialization approach, factory shape) |
| **output_tokens** | ~4,500 (~160 lines TypeScript with doc comments) |
| **gate** | `npx nx typecheck store-adapter` — must complete with zero errors |

---

#### P0.2 — Update types.ts + index.ts re-exports

| Field | Value |
|-------|-------|
| **Name** | Re-export VectorDialect surface from store-adapter package |
| **Description** | Verify the `VectorDialect` interface in `types.ts` is complete (add `createTableDDL` method if missing from the current interface; the spec requires it). Add re-exports from `index.ts`: `VectorDialect`, `SqliteVecDialect`, `TursoVectorDialect`, `createVectorDialect`, `vecToJson`, `vecToBlob`, `topKQueryCore`. |
| **reserved_files** | `libs/data/store/store-adapter/src/types.ts` (MODIFY), `libs/data/store/store-adapter/src/index.ts` (MODIFY) |
| **depends_on** | — |
| **input_tokens** | ~1,000 (current interface, re-export list) |
| **output_tokens** | ~400 (~15 lines of exports + potential interface addition) |
| **gate** | `npx nx typecheck store-adapter` — must complete with zero errors |

---

#### P0.3 — VectorDialect unit tests

| Field | Value |
|-------|-------|
| **Name** | Unit tests for both VectorDialect implementations |
| **Description** | Create `vector-dialect.test.ts` covering: DDL generation (both dialects produce correct CREATE TABLE/INDEX), topKQuery SQL shape (correct placeholders, args), distanceExpr, vecToJson/vecToBlob serialization roundtrip. Run on both backends via `STORE_ADAPTER` env var. |
| **reserved_files** | `libs/data/store/store-adapter/src/__tests__/vector-dialect.test.ts` (CREATE) |
| **depends_on** | P0.1, P0.2 |
| **input_tokens** | ~2,000 (interface spec, serialization contract, test patterns from existing tests) |
| **output_tokens** | ~2,500 (~80 lines of test cases) |
| **gate** | `npx nx test store-adapter` — all tests pass (existing + new) |

---

### Wave 1: Core migration — openDb, schema, WriteQueue, recall

**Depends on:** Wave 0
**Unblocks:** Wave 2 (all caller migrations need the adapter-aware hot paths)

---

#### P1.1 — Migrate db.ts: openDb, init helpers, pre-DDL migrations

| Field | Value |
|-------|-------|
| **Name** | Full `openDb()` / `openDbReadOnly()` adapter awareness + init helper migration |
| **Description** | The largest single packet. Changes `openDb()` from `createSqliteAdapter() → createStoreAdapter()`. Threads `VectorDialect` through connection context. Migrates `stampStoreMeta()`, `verifyStoreMeta()`, `migrateAddColumn()`, `initScope()` to accept `StoreAdapter`. Converts all `rawDb.prepare().get()/.all()/.exec()` calls to `adapter.execute*()`. Removes `sqliteVec.load(rawDb)` from the main path and moves it into the guarded `if (adapter.config.type === 'sqlite')` branch. Adds the `vectorDialect.createTableDDL()` + `createIndexDDL()` calls. Converts the pre-DDL defensive column migration block (lines 243–293) from synchronous prepare/get to adapter methods. Updates `getDb()` / connection context to return `{ adapter, vectorDialect }`. |
| **reserved_files** | `libs/memory-core/src/db.ts` (MODIFY) |
| **depends_on** | P0.1, P0.2 |
| **input_tokens** | ~4,000 (Solution 2 full spec, current db.ts structure, openDb, stampStoreMeta, verifyStoreMeta, migrateAddColumn, initScope, pre-DDL scan) |
| **output_tokens** | ~4,000 (~150 lines changed across ~8 functions) |
| **gate** | `npx nx build memory-core` — atomic-tsc build succeeds with zero errors |

---

#### P1.2 — Remove vec0 DDL from schema.ts

| Field | Value |
|-------|-------|
| **Name** | Remove hardcoded sqlite-vec virtual table DDL |
| **Description** | Remove the `CREATE VIRTUAL TABLE vec_node USING vec0(...)` line from `schema.ts`. The vec_node DDL now comes from `VectorDialect.createTableDDL()` inside `openDb()`. All other DDL in schema.ts (node, edge, FTS, organizer_queue, etc.) is portable SQLite and remains unchanged. |
| **reserved_files** | `libs/memory-core/src/schema.ts` (MODIFY) |
| **depends_on** | P0.1, P0.2 |
| **input_tokens** | ~500 (schema.ts line 49 context) |
| **output_tokens** | ~50 (1 line removed) |
| **gate** | `npx nx build memory-core` — atomic-tsc build succeeds with zero errors |

---

#### P1.3 — Migrate WriteQueue to StoreAdapter

| Field | Value |
|-------|-------|
| **Name** | WriteQueue: async, StoreAdapter-based, backend-agnostic |
| **Description** | Full WriteQueue refactor per Solution 4. Constructor accepts `StoreAdapter` instead of `Database.Database`. `_create()` passes adapter directly from `openDb()`. `enqueue()` callback type changes from `(db: Database.Database) => T` to `(tx: AdapterTransaction) => T`. `_processNext()` wraps each task in `adapter.transaction(fn, { mode: 'immediate' })`. WAL checkpointing uses `adapter.executeGet()`. WalBytes() returns 0 for turso (no local WAL). PRAGMA busy_timeout guarded by `adapter.config.type === 'sqlite'`. Lifeycle (`drainAndClose`, `clearInstances`) calls `adapter.close()`. FIFO ordering, admission control, saturation hysteresis, per-task `kind` segregation — all unchanged. |
| **reserved_files** | `libs/memory-core/src/write-queue.ts` (MODIFY) |
| **depends_on** | P1.1 |
| **input_tokens** | ~4,000 (Solution 4 full spec, current write-queue.ts constructor, _create, enqueue, _processNext, walCheckpoint, walBytes, drainAndClose, clearInstances) |
| **output_tokens** | ~4,000 (~150 lines changed across ~8 methods) |
| **gate** | `npx nx build memory-core` — atomic-tsc build succeeds with zero errors |

---

#### P1.4 — Migrate recall.ts to VectorDialect KNN routing

| Field | Value |
|-------|-------|
| **Name** | recall.ts: route KNN query through VectorDialect |
| **Description** | Changes `memoryRecall()` signature to accept `VectorDialect`. Routes the KNN query (currently hardcoded sqlite-vec MATCH/k at lines 428–433) through `vectorDialect.topKQuery()`. Uses `__PLACEHOLDER__` interpolation for validity/filter predicates. All callers thread `vectorDialect` from connection context. |
| **reserved_files** | `libs/memory-core/src/recall.ts` (MODIFY) |
| **depends_on** | P1.1, P0.1 |
| **input_tokens** | ~2,500 (Solution 3 spec, current recall.ts KNN block, __PLACEHOLDER__ pattern) |
| **output_tokens** | ~1,500 (~50 lines changed: signature, KNN routing, caller threading) |
| **gate** | `npx nx build memory-core` — atomic-tsc build succeeds with zero errors |

---

### Wave 2: Remaining functions + heal path

**Depends on:** Wave 1
**Parallelism:** All 5 packets in this wave can be dispatched in parallel — they target independent files and only depend on the adapter infrastructure built in Wave 1.

---

#### P2.1 — Migrate embed-pipeline.ts

| Field | Value |
|-------|-------|
| **Name** | applyEmbedding, embedBacklogStats, healMissingVectors, healStaleVectors — backend-agnostic |
| **Description** | Migrates all 4 functions in `embed-pipeline.ts` per Solutions 5 and 6. `applyEmbedding()` — receives `AdapterTransaction` (from WriteQueue wrapper), uses `tx.executeGet()`/`tx.executeRun()`, serializes vectors as JSON or BLOB based on `adapterConfigType`. `embedBacklogStats()` — accepts `StoreAdapter`, uses `adapter.executeGet()`. `healMissingVectors()` — accepts `StoreAdapter` for read scan, enqueues apply through WriteQueue. `healStaleVectors()` — same pattern. `detectNearDupTx` and `applyNearDupResultTx` — accept `AdapterTransaction`. |
| **reserved_files** | `libs/memory-core/src/embed-pipeline.ts` (MODIFY) |
| **depends_on** | P1.3, P0.1 |
| **input_tokens** | ~3,000 (Solutions 5 and 6 spec, current function signatures and bodies for all 4 functions) |
| **output_tokens** | ~3,000 (~100 lines changed across 4 functions) |
| **gate** | `npx nx build memory-core` — atomic-tsc build succeeds with zero errors |

---

#### P2.2 — Migrate write.ts callbacks

| Field | Value |
|-------|-------|
| **Name** | write.ts: wq.enqueue callbacks from `(db)` to `(tx)` |
| **Description** | Mechanical change to all `wq.enqueue()` call sites in `write.ts`: `memoryWritePhaseA`, `memoryWriteBatchPhaseA`, `memoryWrite` enqueue, `memoryInvalidate` enqueue. Every callback body changes from `(db) => fn(db, ...)` to `(tx) => fn(tx, ...)`. Every `db.prepare().get()/.run()` changes to `tx.executeGet()/.executeRun()`. Same SQL, same logic, async execution. |
| **reserved_files** | `libs/memory-core/src/write.ts` (MODIFY) |
| **depends_on** | P1.3 |
| **input_tokens** | ~1,500 (current write.ts call sites, Solution 7 migration table) |
| **output_tokens** | ~800 (~30 lines changed across ~5 call sites) |
| **gate** | `npx nx build memory-core` — atomic-tsc build succeeds with zero errors |

---

#### P2.3 — Migrate curate.ts + update.ts callbacks

| Field | Value |
|-------|-------|
| **Name** | curate.ts + update.ts: wq.enqueue callbacks from `(db)` to `(tx)` |
| **Description** | Same mechanical change as P2.2 for `curate.ts` (retag, setTopic, setImportance, etc. enqueue callbacks) and `update.ts` (`memoryUpdate` phase A enqueue callback). Every `db.prepare()` → `tx.execute*()`. |
| **reserved_files** | `libs/memory-core/src/curate.ts` (MODIFY), `libs/memory-core/src/update.ts` (MODIFY) |
| **depends_on** | P1.3 |
| **input_tokens** | ~1,500 (current enqueue call sites in both files) |
| **output_tokens** | ~800 (~30 lines changed across both files) |
| **gate** | `npx nx build memory-core` — atomic-tsc build succeeds with zero errors |

---

#### P2.4 — Migrate cluster.ts + autolink.ts + enrich.ts callbacks

| Field | Value |
|-------|-------|
| **Name** | cluster, autolink, enrich: wq.enqueue callbacks + function signatures |
| **Description** | `enrich.ts`: `applyNearDupResult()` and `enrichOnWrite()` change from `Database.Database` parameter to `AdapterTransaction` (called inside WriteQueue tasks). `cluster.ts`: all wq.enqueue callbacks from `(db)` to `(tx)`. `autolink.ts`: same mechanical change for all autolink write callbacks. |
| **reserved_files** | `libs/memory-core/src/cluster.ts` (MODIFY), `libs/memory-core/src/autolink.ts` (MODIFY), `libs/memory-core/src/enrich.ts` (MODIFY) |
| **depends_on** | P1.3 |
| **input_tokens** | ~2,000 (current enqueue call sites in all 3 files + enrich function signatures) |
| **output_tokens** | ~1,200 (~50 lines changed across 3 files) |
| **gate** | `npx nx build memory-core` — atomic-tsc build succeeds with zero errors |

---

#### P2.5 — Migrate embed.ts + reembed.ts + outbox-queue.ts

| Field | Value |
|-------|-------|
| **Name** | embed, reembed, outbox-queue: StoreAdapter signatures |
| **Description** | `embed.ts`: `reembedNodes()` changes from `(db: Database.Database)` to `(adapter: StoreAdapter)`. `reembed.ts`: `getReembedCandidates()` same change. `outbox-queue.ts`: `enqueueIngest()`, `enqueueEnrichFull()`, `hasPendingFullEnrich()` change to `StoreAdapter`. All are read-scan functions — SQL unchanged, execution method switches to `adapter.execute*()`. |
| **reserved_files** | `libs/memory-core/src/embed.ts` (MODIFY), `libs/memory-core/src/reembed.ts` (MODIFY), `libs/memory-core/src/outbox-queue.ts` (MODIFY) |
| **depends_on** | P1.1 |
| **input_tokens** | ~1,500 (current function signatures and SELECT bodies in all 3 files) |
| **output_tokens** | ~800 (~30 lines changed across 3 files) |
| **gate** | `npx nx build memory-core` — atomic-tsc build succeeds with zero errors |

---

### Wave 3: Bundle config + test files + smoke test

**Depends on:** Wave 2 (all code migrations complete)
**Note:** `memory-core` does not have a `typecheck` target. The build target (`atomic-tsc`) performs type-checking as part of compilation, so `npx nx build memory-core` is the correct type-check gate for memory-core changes. After this wave, `npx nx build memory-core` must succeed.

---

#### P3.1 — Bundle config + cross-adapter test files

| Field | Value |
|-------|-------|
| **Name** | memory-server bundle config + recall-parity + heal-backend-agnostic tests |
| **Description** | (a) Add `@tursodatabase/database` as optional `peerDependency` to memory-server `package.json` (`>=0.7.0`). Add `--external @tursodatabase/database` to the build command in `project.json`. (b) Create `recall-parity.test.ts` — writes episodes on both backends, compares recall results (rank order + node UIDs, ≥98% threshold). (c) Create `heal-backend-agnostic.test.ts` — tests healMissingVectors and healStaleVectors on both adapters with synthetic two-phase-write gaps. |
| **reserved_files** | `extensions/bundles/sox-memory-bundle/members/memory-server/package.json` (MODIFY), `extensions/bundles/sox-memory-bundle/members/memory-server/project.json` (MODIFY), `libs/memory-core/src/__tests__/recall-parity.test.ts` (CREATE), `libs/memory-core/src/__tests__/heal-backend-agnostic.test.ts` (CREATE) |
| **depends_on** | P2.1, P2.2, P2.3, P2.4, P2.5 |
| **input_tokens** | ~2,500 (bundle config spec, recall parity test patterns, heal test patterns, Solution 12 testing matrix) |
| **output_tokens** | ~3,500 (~130 lines: ~10 config + ~60 parity test + ~60 heal test) |
| **gate** | `npx nx typecheck memory-server` — must complete with zero errors |

---

#### P3.2 — Build + typecheck + registry sync

| Field | Value |
|-------|-------|
| **Name** | Full build: store-adapter, memory-core, memory-server + registry sync-index |
| **Description** | Rebuild all three projects in dependency order. Run `npx nx build store-adapter`, `npx nx build memory-core`, `npx nx build memory-server`, then `npx nx run registry:sync-index` to regenerate the extension registry with updated checksums. This is a destructive build (BL-235) — the dist artifacts are overwritten. |
| **reserved_files** | — (no source code changes) |
| **depends_on** | P3.1 |
| **input_tokens** | ~500 (build order) |
| **output_tokens** | ~0 |
| **gate** | `npx nx build store-adapter && npx nx build memory-core && npx nx build memory-server && npx nx run registry:sync-index` — all four commands exit 0 |

---

#### P3.3 — Smoke test on both adapters

| Field | Value |
|-------|-------|
| **Name** | Smoke test SqliteAdapter + TursoAdapter |
| **Description** | Run the full smoke test with SqliteAdapter first (legacy path must not regress), then TursoAdapter (new path must work). Each run installs the memory-server extension into a disposable project scope and exercises every manifest-driven variation (install, upgrade, service enable/status/disable, serve). |
| **reserved_files** | — (no source code changes) |
| **depends_on** | P3.2 |
| **input_tokens** | ~500 (smoke test commands) |
| **output_tokens** | ~0 |
| **gate** | `rm -rf dist/smoke && STORE_ADAPTER=sqlite node scripts/smoke-test.mjs --extension memory-server && rm -rf dist/smoke && STORE_ADAPTER=turso node scripts/smoke-test.mjs --extension memory-server` — both runs exit 0 with `summary.failed === 0` |

---

### Wave 4: Migration scripts

**Depends on:** Wave 3 (bundle must be built to exercise migration scripts against it)
**Parallelism:** All 4 packets independent — they create separate script files that don't share state.

---

#### P4.1 — Create `migrate-store-to-turso.mjs`

| Field | Value |
|-------|-------|
| **Name** | Dual-direction migration script |
| **Description** | Creates the core migration script per Solution 10. Supports `--mode copy|in-place`, `--direction forward|reverse`. Opens SOURCE with source adapter, TARGET with target adapter. Copies all non-vec tables verbatim (preserving rowid). Creates vec_node in target using target's VectorDialect. Re-embeds vectors in batches of 500. Builds ANN index. Verifies row count parity. CLI interface for interactive use. |
| **reserved_files** | `scripts/migrate-store-to-turso.mjs` (CREATE) |
| **depends_on** | P3.3 |
| **input_tokens** | ~3,000 (Solution 10 spec: migration modes, both directions, batch re-embed, CLI interface) |
| **output_tokens** | ~5,000 (~200 lines) |
| **gate** | `node scripts/migrate-store-to-turso.mjs --help` — prints usage with all flags |

---

#### P4.2 — Create `verify-recall-parity.mjs`

| Field | Value |
|-------|-------|
| **Name** | Cross-backend recall parity verification |
| **Description** | Opens two stores (one SqliteAdapter, one TursoAdapter). Generates 100 random queries. For each query, runs recall on both backends and compares top-10 results. Allows slight float differences in distance scores but requires identical rank order and node UIDs. Pass threshold: ≥98% of queries produce identical rank order. Exits 0 on pass, 1 on failure with per-query diff output. |
| **reserved_files** | `scripts/verify-recall-parity.mjs` (CREATE) |
| **depends_on** | P3.3 |
| **input_tokens** | ~2,000 (Solution 10 verification spec, rank-order comparison algorithm) |
| **output_tokens** | ~3,000 (~100 lines) |
| **gate** | `node scripts/verify-recall-parity.mjs --help` — prints usage with all flags |

---

#### P4.3 — Create `verify-fresh-setup.mjs`

| Field | Value |
|-------|-------|
| **Name** | Fresh setup end-to-end verification |
| **Description** | Creates a fresh store with the current adapter (driven by `STORE_ADAPTER` env var). Writes 100 episodes. Runs 50 random recall queries. Asserts all writes are recallable within 5 seconds. Asserts no crashes, no error logs. Exits 0 on pass, 1 on failure. Used to prove both backends work from a clean slate. |
| **reserved_files** | `scripts/verify-fresh-setup.mjs` (CREATE) |
| **depends_on** | P3.3 |
| **input_tokens** | ~2,000 (Solution 10 fresh setup spec, end-to-end test pattern) |
| **output_tokens** | ~3,000 (~100 lines) |
| **gate** | `node scripts/verify-fresh-setup.mjs --help` — prints usage with all flags |

---

#### P4.4 — Create `generate-test-store.mjs`

| Field | Value |
|-------|-------|
| **Name** | Synthetic test store generator |
| **Description** | Generates SQLite store files with synthetic episodes for migration sandbox testing. Supports `--episodes N` (number of episodes, default 1000), `--output` path, and edge case flags: `--empty`, `--all-invalidated`, `--no-embeddings`. Each episode has realistic content (lorem-ipsum style), proper timestamps, and vectors generated via random Float32Array. |
| **reserved_files** | `scripts/generate-test-store.mjs` (CREATE) |
| **depends_on** | P3.3 |
| **input_tokens** | ~2,500 (Solution 10 sandbox spec, synthetic data generation approach) |
| **output_tokens** | ~4,000 (~150 lines) |
| **gate** | `node scripts/generate-test-store.mjs --episodes 10 --output /tmp/verify-gen.test.db && ls -la /tmp/verify-gen.test.db` — file exists and is non-empty |

---

### Wave 5: Verification protocol execution

**Depends on:** Wave 4 (all scripts exist)
**Structure:** Sequential — each proof step depends on the preceding one. Run in order.

---

#### P5.1 — Fresh Turso setup end-to-end

| Field | Value |
|-------|-------|
| **Name** | Prove fresh TursoAdapter store works from scratch |
| **Description** | Creates a brand-new store file, writes 100 episodes through the full pipeline, runs 50 recall queries, verifies all writes are recallable. This proves that `openDb()`, `WriteQueue`, `memoryWrite`, `memoryRecall`, and `applyEmbedding` all work on TursoAdapter without any migration. |
| **reserved_files** | — |
| **depends_on** | P4.3, P4.4 |
| **input_tokens** | ~300 |
| **output_tokens** | ~0 |
| **gate** | `rm -f /tmp/p5.1.db && STORE_ADAPTER=turso node scripts/verify-fresh-setup.mjs --db /tmp/p5.1.db` — exits 0, prints `ALL PASS: Turso fresh setup verified` |

---

#### P5.2 — Fresh SqliteAdapter setup end-to-end

| Field | Value |
|-------|-------|
| **Name** | Prove legacy SqliteAdapter path still works (no regression) |
| **Description** | Same as P5.1 but with `STORE_ADAPTER=sqlite`. Proves that existing better-sqlite3 users see zero breakage. |
| **reserved_files** | — |
| **depends_on** | P5.1 (conceptually independent, but run after to confirm parity) |
| **input_tokens** | ~200 |
| **output_tokens** | ~0 |
| **gate** | `rm -f /tmp/p5.2.db && STORE_ADAPTER=sqlite node scripts/verify-fresh-setup.mjs --db /tmp/p5.2.db` — exits 0, prints `ALL PASS: SqliteAdapter fresh setup verified` |

---

#### P5.3 — Forward migration (SQLite → Turso)

| Field | Value |
|-------|-------|
| **Name** | Prove SQLite → Turso migration works end-to-end |
| **Description** | Generates a 100-episode SQLite store, migrates it to Turso via copy mode, then verifies recall parity. This proves the primary go-live path: schema migration, vector re-embed, rank-order parity. |
| **reserved_files** | — |
| **depends_on** | P4.1, P4.2, P4.4 |
| **input_tokens** | ~400 |
| **output_tokens** | ~0 |
| **gate** | ```bash rm -f /tmp/p5.3-*.db && node scripts/generate-test-store.mjs --episodes 100 --output /tmp/p5.3-source.db && STORE_ADAPTER=turso node scripts/migrate-store-to-turso.mjs --mode copy --source /tmp/p5.3-source.db --target /tmp/p5.3-target.db && node scripts/verify-recall-parity.mjs --sqlite /tmp/p5.3-source.db --turso /tmp/p5.3-target.db``` — exits 0, parity ≥98% |

---

#### P5.4 — Reverse migration (Turso → SQLite)

| Field | Value |
|-------|-------|
| **Name** | Prove Turso → SQLite rollback path works |
| **Description** | Takes the Turso target from P5.3 and migrates it back to SQLite via reverse mode. Verifies recall parity between the roundtrip SQLite store and the original Turso store. This proves the rollback safety net exists and vectors survive a roundtrip. |
| **reserved_files** | — |
| **depends_on** | P5.3 |
| **input_tokens** | ~300 |
| **output_tokens** | ~0 |
| **gate** | ```bash STORE_ADAPTER=sqlite node scripts/migrate-store-to-turso.mjs --direction reverse --mode copy --source /tmp/p5.3-target.db --target /tmp/p5.4-roundtrip.db && node scripts/verify-recall-parity.mjs --sqlite /tmp/p5.4-roundtrip.db --turso /tmp/p5.3-target.db``` — exits 0, parity ≥98% |

---

#### P5.5 — Vector operations on both backends

| Field | Value |
|-------|-------|
| **Name** | Prove all vector operations work identically on both backends |
| **Description** | Runs the full test suite for `store-adapter` (vector-dialect unit tests) and `memory-core` (recall-parity + heal-backend-agnostic integration tests) with `STORE_ADAPTER=sqlite` and `STORE_ADAPTER=turso`. Each run covers DDL generation, topKQuery, vector serialization, KNN recall, applyEmbedding, healMissingVectors, and healStaleVectors. |
| **reserved_files** | — |
| **depends_on** | P3.1 (test files exist), P3.2 (build succeeds) |
| **input_tokens** | ~300 |
| **output_tokens** | ~0 |
| **gate** | ```bash STORE_ADAPTER=sqlite npx nx test store-adapter && STORE_ADAPTER=turso npx nx test store-adapter && STORE_ADAPTER=sqlite npx nx test memory-core && STORE_ADAPTER=turso npx nx test memory-core``` — all 4 commands exit 0 |

---

#### P5.6 — `adapter_type` in ping correctly reports active adapter

| Field | Value |
|-------|-------|
| **Name** | Prove `memory_ping` reports the correct adapter type |
| **Description** | Creates StoreAdapter instances with both env var settings and verifies the `config.type` field. This proves that `STORE_ADAPTER=turso` yields `config.type === 'turso'` and `STORE_ADAPTER=sqlite` yields `config.type === 'sqlite'`, and that the factory correctly reads the env var. |
| **reserved_files** | — |
| **depends_on** | P3.3 |
| **input_tokens** | ~300 |
| **output_tokens** | ~0 |
| **gate** | ```bash rm -f /tmp/p5.6-turso.db /tmp/p5.6-sqlite.db && echo "TursoAdapter type:" && STORE_ADAPTER=turso node -e "const{createStoreAdapter}=require('@adhd/sox-store-adapter');createStoreAdapter({dbPath:'/tmp/p5.6-turso.db'}).then(a=>{console.log(a.config.type);if(a.config.type!=='turso')process.exit(1);}).catch(e=>{console.error(e);process.exit(1)})" && echo "SqliteAdapter type:" && STORE_ADAPTER=sqlite node -e "const{createStoreAdapter}=require('@adhd/sox-store-adapter');createStoreAdapter({dbPath:'/tmp/p5.6-sqlite.db'}).then(a=>{console.log(a.config.type);if(a.config.type!=='sqlite')process.exit(1);}).catch(e=>{console.error(e);process.exit(1)})"``` — both print `turso` and `sqlite` respectively, exit 0 |

---

#### P5.7 — `BEGIN IMMEDIATE` CAS pattern on both adapters

| Field | Value |
|-------|-------|
| **Name** | Prove CAS transaction with `mode: 'immediate'` works on both backends |
| **Description** | Creates a test table on both adapters, runs a transaction with `{ mode: 'immediate' }`, performs a CAS read-modify-write pattern (SELECT then UPDATE only if still unclaimed), verifies rowsAffected is correct. This proves the backlog consumer's CAS pattern works identically on both adapters. |
| **reserved_files** | — |
| **depends_on** | P3.3 |
| **input_tokens** | ~400 |
| **output_tokens** | ~0 |
| **gate** | ```bash rm -f /tmp/p5.7-turso.db /tmp/p5.7-sqlite.db && echo "Turso CAS:" && STORE_ADAPTER=turso node -e "const{createStoreAdapter}=require('@adhd/sox-store-adapter');(async()=>{const a=await createStoreAdapter({dbPath:'/tmp/p5.7-turso.db'});await a.exec('CREATE TABLE IF NOT EXISTS test(id INTEGER PRIMARY KEY,val TEXT)');const r=await a.transaction(async(tx)=>{const row=await tx.executeGet('SELECT val FROM test WHERE id=1');if(!row)await tx.executeRun('INSERT INTO test(id,val)VALUES(1,?)',['hello']);return row;},{mode:'immediate'});console.log('CAS immediate tx succeeded, row:',r);await a.close();if(r&&r.val!=='hello'&&r!==null)process.exit(1);})().catch(e=>{console.error(e);process.exit(1)})" && echo "Sqlite CAS:" && STORE_ADAPTER=sqlite node -e "const{createStoreAdapter}=require('@adhd/sox-store-adapter');(async()=>{const a=await createStoreAdapter({dbPath:'/tmp/p5.7-sqlite.db'});await a.exec('CREATE TABLE IF NOT EXISTS test(id INTEGER PRIMARY KEY,val TEXT)');const r=await a.transaction(async(tx)=>{const row=await tx.executeGet('SELECT val FROM test WHERE id=1');if(!row)await tx.executeRun('INSERT INTO test(id,val)VALUES(1,?)',['hello']);return row;},{mode:'immediate'});console.log('CAS immediate tx succeeded, row:',r);await a.close();})().catch(e=>{console.error(e);process.exit(1)})"``` — both print `CAS immediate tx succeeded`, exit 0 |

---

### Wave Dependency Graph

```
Wave 0: P0.1 ─┬─ P0.3 ─┐
              │         │
              └─ P0.2 ──┘
                         │
Wave 1:        P1.1 ─┬──┤
                     │   │
              P1.2 ──┘   │
                         │
              P1.3 ──────┤
                         │
              P1.4 ──────┤
                         │
Wave 2:    ┌───┬────┬────┘
           │   │    │
        P2.1  P2.2 P2.3 P2.4 P2.5
           │   │    │    │    │
           └───┴────┴────┴────┘
                         │
Wave 3:              P3.1
                         │
                     P3.2
                         │
                     P3.3
                         │
Wave 4:   ┌───┬────┬────┘
          │   │    │
        P4.1 P4.2 P4.3 P4.4
          │   │    │    │
          └───┴────┴────┘
               │
Wave 5:     P5.1 → P5.2 → P5.3 → P5.4 → P5.5 → P5.6 → P5.7
```

### Running the plan

```bash
# Execute wave-by-wave, parallelizing within each wave.
# Wave 0
npx nx typecheck store-adapter  # P0.1 + P0.2 gate
npx nx test store-adapter       # P0.3 gate

# Wave 1
npx nx build memory-core         # P1.1 + P1.2 gate
npx nx build memory-core         # P1.3 + P1.4 gate

# Wave 2 — all 5 parallel
npx nx build memory-core         # P2.1–P2.5 gate (single build verifies all)

# Wave 3
npx nx typecheck memory-server   # P3.1 gate
npx nx build store-adapter && npx nx build memory-core && npx nx build memory-server && npx nx run registry:sync-index  # P3.2
rm -rf dist/smoke && STORE_ADAPTER=sqlite node scripts/smoke-test.mjs --extension memory-server  # P3.3a
rm -rf dist/smoke && STORE_ADAPTER=turso node scripts/smoke-test.mjs --extension memory-server  # P3.3b

# Wave 4 — all 4 parallel
node scripts/migrate-store-to-turso.mjs --help  # P4.1
node scripts/verify-recall-parity.mjs --help    # P4.2
node scripts/verify-fresh-setup.mjs --help      # P4.3
node scripts/generate-test-store.mjs --episodes 10 --output /tmp/gate-test.db  # P4.4

# Wave 5 — sequential
# (run each verification protocol step from P5.1–P5.7 above)
```

### Go-live checklist

When all 26 packets pass:

| Check | Packet |
|-------|--------|
| ✅ VectorDialect compiles and tests pass | P0.1–P0.3 |
| ✅ `openDb()` returns `StoreAdapter` with `VectorDialect` | P1.1 |
| ✅ `WriteQueue` operates on both adapters | P1.3 |
| ✅ Recall works on both backends via dialect routing | P1.4 |
| ✅ `embed-pipeline` (apply, heal, stats) is backend-agnostic | P2.1 |
| ✅ All caller migrations compile | P2.2–P2.5 |
| ✅ Bundle rebuilds with Turso driver as optional peerDep | P3.1–P3.2 |
| ✅ Smoke test passes on SqliteAdapter (no regression) | P3.3 |
| ✅ Smoke test passes on TursoAdapter (new path works) | P3.3 |
| ✅ Migration scripts exist and accept CLI flags | P4.1–P4.4 |
| ✅ Fresh Turso setup end-to-end | P5.1 |
| ✅ Fresh SqliteAdapter setup end-to-end (no regression) | P5.2 |
| ✅ Forward migration SQLite → Turso with recall parity | P5.3 |
| ✅ Reverse migration Turso → SQLite with recall parity | P5.4 |
| ✅ All vector operations pass on both backends | P5.5 |
| ✅ `adapter_type` correctly reports active adapter | P5.6 |
| ✅ `BEGIN IMMEDIATE` CAS works on both adapters | P5.7 |

### Notes for dispatchers

- **memory-core has no `typecheck` target.** Use `npx nx build memory-core` as the type-check gate — `atomic-tsc` runs `tsc` before emitting output. The build is destructive (BL-235), so gate-only packets should run build → confirm exit 0, rather than relying on the artifact.
- **`npx nx build memory-server` is destructive** (deletes dist before building). Run only once per Wave 3 pass.
- **Registry sync** (`npx nx run registry:sync-index`) must be run after every rebuild of memory-server and the regenerated `registry/index.json` committed alongside source changes.
- **Smoke tests** (`scripts/smoke-test.mjs`) require `dist/smoke/` to not exist at start — the `rm -rf dist/smoke` in the gate command is deliberate.
- **Parallelism within waves** is safe because reserved_files are disjoint: no two packets in the same wave write to the same file.
- **P5.1 and P5.2** are conceptually independent but are run sequentially in practice because they validate complementary sides of the same coin (Turso works / Sqlite still works). They can be parallelized.
