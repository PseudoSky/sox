# Turso Adapter Integration — Unified Store Backend (Round 3)

> **STATUS 2026-07-30: SUPERSEDED.** This round (and v1/v2 before it) targeted `@libsql/client`, which
> Round 6 (`docs/ideas/turso-database-adapter.md`) later confirmed was the wrong client library — the
> shipped adapter (`libs/data/store/store-adapter/`, package `@adhd/sox-store-adapter`) wraps
> `@tursodatabase/database`. Much of this round's *interface design work* did carry forward (the
> `executeGet`/`executeAll`/`executeRun` split, the `unwrap()` escape hatch, `readonly` on
> `AdapterConfig`, dropping `executeValues`) — see `types.ts`/`sqlite-adapter.ts`/`turso-adapter.ts` in
> `libs/data/store/store-adapter/src/` for the shipped shape. But the driver target, `transaction()`
> (now takes an explicit `mode`), and `batch()` (renamed `executeMany()`) all changed in later rounds.
> Kept as historical design record only.
>
> **See prior spec:** `docs/ideas/turso-adapter-integration-v2.md`  
> **Round 2 review:** 2026-07-25 — Read the actual codebase (all `libs/data/*` packages, memory-core, host-runtime, manifest schema). Several interface gaps, an impossible segment dependency, a dangerous Drizzle assumption, and a host-runtime DI hole were discovered. This round corrects them all.
>
> **Round 3 DX review (2026-07-25):** TypeScript interface UX audit (`docs/ideas/turso-adapter-integration-dx-review.md`) — 4 P0 fixes applied to this spec: (1) `<T>` generics on `executeGet`/`executeAll` to preserve typed row shapes, (2) `exec()` on `AdapterTransaction` for DDL inside transactions, (3) narrowed `unwrap()` return types per adapter subclass, (4) `readonly?: boolean` on `AdapterConfig`. Plus `ValuesResult`/`executeValues` removed (YAGNI — zero consumers across source, published packages, and external consumer `agent-source`).

## Critique of Round 2 (code-verified)

The Round 2 spec had these issues, discovered by reading actual source:

1. **`execute()` overload ambiguity** — Round 2 collapsed `.prepare().get()`, `.all()`, and `.run()` into one `execute()` returning `ResultSet`. But `.get()` returns a single row while `.all()` returns all rows, and `.run()` is used for INSERT/UPDATE/DELETE where the result is primarily `changes`/`lastInsertRowid` — not rows. Consumers that currently call `.get()` must add `[0]` indexing everywhere, making the migration noisier and error-prone. Fixed by splitting into `executeGet()` / `executeAll()` / `executeRun()`.

2. **Segment F dependency on C was a phantom** — memory-core does NOT import `@adhd/sox-vector-store` at all (grep found only comment references in `reembed.ts`). Memory-core embeds vectors directly into its own `vec_node` table via raw `db.prepare()`. The v2 spec's "F requires B+C" artificially serialized work. Correct: F requires B only — C can parallelize with F.

3. **Drizzle+Turso is structurally impossible, not LOW risk** — graph-store's `applySchema()` calls `drizzle(this.db)` which takes `better-sqlite3.Database`, NOT `@libsql/client.Client`. If `adapter.raw()` returns a Turso client, the call fails. Dismissing this as "LOW risk" is wrong — graph-store literally cannot initialize against a Turso adapter without remediation. Fixed: graph-store ships its own DDL inline (it already has FTS_DDL, FTS_TRIGGERS), removes the Drizzle runtime dependency, and makes `applySchema()` driver-agnostic via `adapter.exec()`.

4. **Host-runtime has no DI infrastructure for adapters** — The Round 2 "store_adapter wiring" segment H assumes the host-runtime can create an adapter and inject it into an extension. But the host-runtime only activates extensions via process-spawn (mcp-server, service) or file-import (command, hook). Neither path supports passing a live database adapter across the boundary. For spawned processes, you can only pass config strings (env vars). For in-process imports, you'd need a known export name. Segment H redesigned: the host-runtime reads `manifest.store_adapter` and sets env vars; the extension's own startup code creates the adapter from those env vars via the factory.

5. **`batch()` atomicity semantics differ between drivers** — Round 2's `batch(stmts[])` maps to `@libsql/client.batch()` (non-atomic — each statement is a separate HTTP request) but the SqliteAdapter implementation wraps it in `db.transaction()` (atomic). This makes batch behavior silently driver-dependent. Fixed: `batch()` is documented as NOT atomic; a separate `transaction()` wrapper is the only atomic path.

6. **Missing `pragma()` method** — Current code uses `.pragma('journal_mode = WAL')` (blob-store) or `db.exec('PRAGMA journal_mode = WAL')` (others). Round 2 has only `exec()`, which works but loses the convenience. Fixed: add dedicated `pragmaSet()` and `pragmaGet()` methods to the interface.

7. **`ResultSet` conflates multi-row and single-row returns** — `.get()` returns one row, `.all()` returns many, `.run()` returns no rows (just changes + lastInsertRowid). Round 2's single `execute()` forces all callers to do `result.rows[0]` for single-row queries. Fixed: interface exposes three execute variants.

8. **Factory functions need explicit exports** — The 3rd-party code example uses `createTursoAdapter()` and `createSqliteAdapter()` but the Round 2 spec only defines `createStoreAdapter()`. Fixed: explicit exports with typed constructors.

---

## Round 3 Spec (Architect, 2026-07-25)

### Core Interface: `StoreAdapter`

**Package:** `libs/data/store/store-adapter/` (published as `@adhd/sox-store-adapter`)

**File:** `libs/data/store/store-adapter/src/types.ts`

```typescript
/**
 * Result of executeRun() — for INSERT / UPDATE / DELETE / DDL.
 */
export interface RunResult {
  /** Rows changed (or created, for INSERT). */
  rowsAffected: number;
  /** Last inserted rowid — number for SQLite, bigint for Turso libsql. */
  lastInsertRowid: number | bigint;
}

/**
 * Result of executeGet() — for SELECT that expects exactly one row.
 * Returns null if no matching row.
 * Generic T carries the column shape inferred by the caller.
 */
export type GetResult<T = Record<string, unknown>> = T | null;

/**
 * Result of executeAll() — for SELECT returning zero or more rows.
 * Generic T carries the row shape inferred by the caller.
 */
export interface AllResult<T = Record<string, unknown>> {
  columns: string[];
  rows: T[];
}

/**
 * Transaction-scoped adapter. Provides execute methods + explicit rollback.
 * Commit is implicit when the callback returns without throwing.
 */
export interface AdapterTransaction {
  executeGet<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<GetResult<T>>;
  executeAll<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<AllResult<T>>;
  executeRun(sql: string, args?: unknown[]): Promise<RunResult>;
  /** DDL / index creation inside a transaction. */
  exec(sql: string): Promise<void>;
  /** Explicit rollback — throws to abort the transaction. */
  rollback(): Promise<void>;
}

/**
 * Optional adapter config passed to factory constructors.
 */
export interface AdapterConfig {
  type: 'sqlite' | 'turso';
  /** SQLite: file path. Turso: `file:./data.db` or `libsql://...` */
  dbPath?: string;
  /** Turso remote only */
  url?: string;
  /** Turso remote only */
  authToken?: string;
  /** Open the database in read-only mode (SqliteAdapter: passes { readonly: true } to better-sqlite3; TursoAdapter file: mode also supported). */
  readonly?: boolean;
}

/**
 * The unified store adapter interface. All libs/data/* packages consume this
 * as their sole database abstraction. Implementations: SqliteAdapter, TursoAdapter.
 *
 * METHOD MAP (replacing better-sqlite3 patterns):
 *   db.prepare(sql).get(...args)        → adapter.executeGet(sql, args)
 *   db.prepare(sql).all(...args)        → adapter.executeAll(sql, args)
 *   db.prepare(sql).run(...args)        → adapter.executeRun(sql, args)
 *   db.exec(sql)                        → adapter.exec(sql)
 *   db.pragma('x = y')                  → adapter.pragmaSet('x', 'y')
 *   db.pragma('x')                      → adapter.pragmaGet('x')
 *   db.transaction(fn)(args)            → adapter.transaction(tx => { ... fn(tx, args) })
 *   db.close()                          → adapter.close()
 *   db (raw handle)                     → adapter.unwrap()  [ESCAPE HATCH — narrowed per implementation]
 *   sqliteVec.load(db)                  → sqliteVec.load((adapter as SqliteAdapter).unwrap())  [memory-core only]
 */
export interface StoreAdapter {
  // ── Query methods ──────────────────────────────────────────────────────
  executeGet<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<GetResult<T>>;
  executeAll<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<AllResult<T>>;
  executeRun(sql: string, args?: unknown[]): Promise<RunResult>;

  // ── Multi-statement / DDL ──────────────────────────────────────────────
  exec(sql: string): Promise<void>;

  // ── PRAGMA shortcuts ───────────────────────────────────────────────────
  pragmaSet(key: string, value: string | number | boolean): Promise<void>;
  pragmaGet(key: string): Promise<string | number | undefined>;

  // ── Transaction ────────────────────────────────────────────────────────
  /**
   * Execute a callback within a database transaction.
   *
   * SqliteAdapter wraps better-sqlite3's db.transaction() — the callback
   * MUST be synchronous (returns T, not Promise<T>). Async callbacks
   * throw TypeError at runtime.
   *
   * TursoAdapter uses explicit BEGIN/COMMIT/ROLLBACK and supports both
   * sync and async callbacks.
   *
   * BATCH WARNING: batch() is NOT atomic across drivers. The only portable
   * way to execute multiple statements atomically is transaction().
   */
  transaction<T>(fn: (tx: AdapterTransaction) => T): Promise<T>;

  // ── Batch (NON-ATOMIC convenience) ─────────────────────────────────────
  /**
   * Execute multiple statements in one round-trip.
   *
   * SqliteAdapter: runs each statement sequentially within one connection
   * (atomic only when wrapped in transaction()).
   * TursoAdapter (remote): each statement is a separate HTTP request
   * (NOT atomic even within transaction() for libsql HTTP planner).
   * TursoAdapter (file:): sequential within one connection, like SQLite.
   *
   * For portable atomic multi-statement execution, use transaction().
   */
  batch(stmts: { sql: string; args?: unknown[] }[]): Promise<RunResult[]>;

  // ── Lifecycle ──────────────────────────────────────────────────────────
  close(): Promise<void>;

  // ── Escape hatch ───────────────────────────────────────────────────────
  /**
   * Returns the underlying driver handle.
   *
   * SqliteAdapter.unwrap() → better-sqlite3.Database  (narrowed on SqliteAdapter type)
   * TursoAdapter.unwrap()  → @libsql/client.Client     (narrowed on TursoAdapter type)
   *
   * USE ONLY FOR:
   * 1. sqlite-vec loading (sqliteVec.load((adapter as SqliteAdapter).unwrap()))
   * 2. Driver-specific features your codebase understands are non-portable.
   *
   * Consumer SHOULD narrow to the concrete adapter type before calling unwrap():
   *   const sa = adapter as SqliteAdapter; sqliteVec.load(sa.unwrap());
   *
   * On the StoreAdapter interface the return type is `unknown` —
   * each concrete subclass narrows it to its driver type.
   */
  unwrap(): unknown;

  // ── Introspection ──────────────────────────────────────────────────────
  /** Read-only copy of the config used to create this adapter. */
  readonly config: Readonly<AdapterConfig>;
}
```

### SqliteAdapter

**File:** `libs/data/store/store-adapter/src/sqlite-adapter.ts`

- Wraps `better-sqlite3` (sync) in Promises. Does NOT defer to the event loop — uses `Promise.resolve()` wrapping for single-statement methods, `setImmediate` for long-running operations.
- Internally caches prepared statements (LRU, max 256 by default) keyed by SQL string. This avoids re-parsing SQL on every `execute*()` call, matching better-sqlite3's `.prepare()` performance.
- Transaction: wraps `db.transaction(fn)` — callback MUST be sync. Throws `TypeError` if `fn` returns a thenable.
- `unwrap()`: `unwrap(): Database.Database` (narrowed from `unknown` on the interface).
- Constructor: `new SqliteAdapter(dbPath: string, opts?: { readonly?: boolean })` opens a new connection (read-only if `opts.readonly` is true). `new SqliteAdapter(db: Database.Database)` wraps an existing connection (DI path for memory-core's `WriteQueue` which opens its own `greatest-sqlite3` connections).

### TursoAdapter

**File:** `libs/data/store/store-adapter/src/turso-adapter.ts`

- Wraps `@libsql/client` — natively async, no wrapping needed.
- Local mode: `file:./data.db` — zero-config dev, uses bundled libsql C library. No sqld server needed.
- Remote mode: `libsql://xxx.turso.io` + `authToken`.
- Transaction: explicit `BEGIN`/`COMMIT`/`ROLLBACK` via `client.execute()`. Supports both sync and async callbacks.
- `unwrap()`: `unwrap(): import('@libsql/client').Client` (narrowed from `unknown` on the interface).
- Constructor: `new TursoAdapter(config: { url: string; authToken?: string; readonly?: boolean })`.
- Note: `file:` URL mode is powered by `@libsql/client`'s own bundled SQLite library, NOT `better-sqlite3`. This means `sqlite-vec` CANNOT be loaded — different native binding, different extension ABI. This is an ABI constraint, not solvable at the adapter layer. Memory-core documents which features are vec-only vs FTS-fallback.

### Factory: `createStoreAdapter()`

**File:** `libs/data/store/store-adapter/src/factory.ts`

```typescript
function createStoreAdapter(config?: Partial<AdapterConfig>): Promise<StoreAdapter>;
```

- Accepts optional `AdapterConfig`; falls back to env vars: `STORE_ADAPTER`, `SOX_CONFIG_DB_PATH`, `TURSO_DB_URL`, `TURSO_AUTH_TOKEN`.
- Uses dynamic `import()` so unused drivers don't appear in bundles.
- Consumer packages should NOT call the factory unless they want the env-var default — the preferred pattern is receiving an adapter instance from the caller.

**Explicit constructors** (no factory indirection needed):

```typescript
function createSqliteAdapter(opts: { dbPath: string; readonly?: boolean }): SqliteAdapter;
function createSqliteAdapterFromHandle(db: Database.Database): SqliteAdapter;
function createTursoAdapter(opts: { url: string; authToken?: string; readonly?: boolean }): TursoAdapter;
```

### Consumer-Specific Query Migration Maps

Each `libs/data/*` package replaces a different subset of `better-sqlite3` patterns.

| better-sqlite3 pattern | StoreAdapter equivalent | Used by |
|---|---|---|
| `db.prepare(sql).get(...args)` | `adapter.executeGet(sql, args)` | graph-store, task-queue, blob-store, memory-core |
| `db.prepare(sql).all(...args)` | `adapter.executeAll(sql, args)` | all packages |
| `db.prepare(sql).run(...args)` | `adapter.executeRun(sql, args)` | all packages |
| `db.exec(sql)` | `adapter.exec(sql)` | all packages (DDL, multi-statement) |
| `db.pragma('journal_mode = WAL')` | `adapter.pragmaSet('journal_mode', 'WAL')` | blob-store (only package using `.pragma()`) |
| `db.transaction(() => { ... })(args)` | `adapter.transaction(tx => { ... })` | graph-store, task-queue, blob-store, memory-core |
| `new Database(dbPath)` | `createSqliteAdapter({ dbPath })` | task-queue, blob-store, memory-core (factory) |
| `createGraphBackend(db)` | `createGraphBackend(adapter)` | memory-core |
| `new Database(dbPath, { readonly: true })` | `createSqliteAdapter({ dbPath, readonly: true })` | memory-core (federated recall) |
| `sqliteVec.load(db)` | `sqliteVec.load((adapter as SqliteAdapter).unwrap())` | memory-core only |

---

### Consumer Refactors — Per-Package Details

#### A. graph-store (`libs/data/graph/graph-store/`)

**Current:** `constructor(db: Database.Database)` — receives raw handle. Uses Drizzle for migration (`drizzle(this.db)` + `migrate()`), raw SQL for all runtime queries, and `db.exec()` for FTS DDL + triggers.

**Change:**
1. Constructor becomes `constructor(adapter: StoreAdapter)`.
2. `applySchema()` is refactored to no longer require Drizzle at runtime:
   - The Drizzle migration SQL (`drizzle/migrations/0000_sad_onslaught.sql`) is **inlined as a string constant** alongside `FTS_DDL` and `FTS_TRIGGERS`.
   - `applySchema()` calls `adapter.exec(INLINE_MIGRATION_DDL)` instead of `migrate(drizzle(this.db), ...)`.
   - The `__drizzle_migrations` tracking table is replaced by `_schema_version` (already present in memory-core's schema pattern).
   - `drizzle-orm` and `drizzle-orm/better-sqlite3` are removed from `package.json` dependencies. `drizzle-kit` remains as a devDependency for generating future migrations (pre-generated SQL is copied into the inline constant).
3. All `this.db.prepare(sql).get/all/run()` → `this.adapter.executeGet/All/Run(sql, args)`.
4. All `this.db.exec()` → `this.adapter.exec()`.
5. `this.db` field renamed to `this.adapter`.
6. `createGraphBackend(db)` → `createGraphBackend(adapter)` — factory signature changes.

**blob-store** and **task-queue** packages import graph-store's `FTS_DDL`, `buildNodeFilterClause`, etc. — these are re-exports, not connections. No change needed at the import site.

#### B. vector-store (`libs/data/vectors/vector-store/`)

**Current:** `constructor(db: SQLiteDB, similarity?: SimilarityBackend)` — receives raw handle. Loads sqlite-vec in `openVectorStore()`.

**Change:**
1. Constructor becomes `constructor(adapter: StoreAdapter, similarity?: SimilarityBackend)`.
2. `sqlite-vec` loading is REMOVED from the vector-store package — it's the caller's responsibility. If the caller uses a SqliteAdapter, they call `sqliteVec.load(adapter.unwrap())` before constructing the store. If TursoAdapter, vec features are unavailable (the constructor detects this and sets `capabilities.vecEnabled = false`).
3. All `this.db.exec()` → `this.adapter.exec()`.
4. All `this.db.prepare(sql).get/all/run()` → `this.adapter.executeGet/All/Run()`.
5. `openVectorStore(path, opts)` → accepts `AdapterConfig | StoreAdapter` — creates adapter if string given, or uses provided adapter.
6. `BruteForceBackend` receives `StoreAdapter` instead of `Database.Database`.

#### C. task-queue (`libs/data/queue/task-queue/`)

**Current:** Owns its connection — `new Database(this.config.dbPath)` in `open()`. `Scheduler` independently opens its own `new Database()`.

**Change:**
1. `TaskQueueConfig` adds `adapter?: StoreAdapter`.
2. If `adapter` is provided, `open()` uses it directly (skips `new Database()`). If not, creates a `SqliteAdapter` internally from `config.dbPath`.
3. `getDatabase()` → `getAdapter()` — returns the adapter, NOT the raw handle.
4. `Scheduler` config adds `adapter?: StoreAdapter` OR `dbPath?: string`. If adapter provided, uses it; if not, creates own adapter from `dbPath`.
5. All `this.db.transaction(() => ...)()` → `this.adapter.transaction(tx => { ... })`.
6. All `this.db.prepare(sql).get/all/run()` → `adapter.executeGet/All/Run()`.
7. The reaper, scheduler tick, and worker pool all share the adapter instance — no change to the WAL multi-connection pattern (the Scheduler still opens its own adapter).

#### D. blob-store (`libs/data/store/blob-store/`)

**Current:** Dynamic import: `new (await import('better-sqlite3')).default(dbPath)` in `open()`.

**Change:**
1. `StoreConfig` adds `adapter?: StoreAdapter`.
2. If `adapter` provided, `open()` uses it directly. If not, lazy-creates a `SqliteAdapter` from `config.refDbPath`.
3. Remove the dynamic import — the adapter handles driver loading.
4. All `this.db!.prepare(sql).run/get/all()` → `this.adapter.executeRun/Get/All()`.
5. `db.pragma('journal_mode = WAL')` → `adapter.pragmaSet('journal_mode', 'WAL')`.
6. `this.db!.transaction(...)` → `this.adapter.transaction(...)`.

#### E. memory-core (`libs/memory-core/`)

**Current:** `openDb(dbPath)` creates a raw `Database.Database`, loads sqlite-vec, applies pragmas + schema, returns it. ~25 files accept `db: Database.Database` parameter.

**Change:**
1. `openDb(dbPath)` → `openDb(dbPath)` now returns `Promise<StoreAdapter>`:
   - Creates `SqliteAdapter` (or TursoAdapter, based on config).
   - If adapter is SqliteAdapter, narrows and calls `sqliteVec.load((adapter as SqliteAdapter).unwrap())`.
   - Applies pragmas via `adapter.pragmaSet()`.
   - Applies DDL via `adapter.exec()`.
   - Stamps store meta via `adapter.executeRun()`.
2. `getDb(dbPath)` becomes `async getDb(dbPath)` — returns cached adapter.
3. `openDbReadOnly(dbPath)` → creates a read-only SqliteAdapter via `createSqliteAdapter({ dbPath, readonly: true })`. TursoAdapter read-only mode deferred (remote tokens can restrict writes; file: mode supports `readonly` flag).
4. All domain functions (`write.ts`, `recall.ts`, `enrich.ts`, `cluster.ts`, `curate.ts`, etc.) change their `db: Database.Database` parameter to `adapter: StoreAdapter`.
5. All `db.prepare(sql).get/all/run()` → `adapter.executeGet/All/Run()`.
6. All `db.exec()` → `adapter.exec()`.
7. All `db.transaction(() => ...)()` → `adapter.transaction(tx => ...)`. **Constraint**: transaction callbacks MUST remain synchronous — they currently are, so no change needed.
8. `createGraphBackend(db)` in enrich.ts, related.ts, etc. → `createGraphBackend(adapter)`.
9. Memory-core **never** calls `adapter.unwrap()` except in `openDb()` for sqlite-vec loading and for passing to `createGraphBackend()` (which now also takes `StoreAdapter`).
10. `WriteQueue` opens its own dedicated adapter (via `openDb()` internally) — same pattern as before.

#### F. Extensions (memory-server, memory-cli, memory-flush)

**Change:**
1. Each extension's entrypoint calls `openDb()` (now async) instead of constructing a `Database` directly.
2. The adapter instance is passed through to all domain functions.
3. No change to extension.json manifests (they don't declare a store adapter — the server bundle bundles the dependency statically).

#### G. host-runtime (`libs/host-runtime/`)

**Current:** No database wiring at all. Activates extensions by spawning processes or importing entrypoints.

**Change:**
1. **Do NOT add adapter creation to the host-runtime.** The host-runtime cannot inject a live adapter across a process boundary. Instead:
2. The extension manifest `store_adapter` field (see below) is **read by the host-runtime only to SET ENV VARS** before spawning the extension process.
3. The extension's own startup code reads these env vars and creates its adapter via `createStoreAdapter()`.
4. This is strictly a "config passthrough" pattern — the host-runtime is a config broker, not a DI container.
5. Segment H is eliminated as a separate segment — the env-var passthrough is part of segment G (extensions wiring), and adds ~5 lines to `processEntry()` in `loader.ts`.

---

### Extension Manifest Schema — `store_adapter`

The v2 manifest schema already has `additionalProperties: true` (line 780), so `store_adapter` is accepted without schema changes. However, for documentation and tooling, the field is formally declared:

```typescript
// Added to Manifest type and ManifestSchema.properties
store_adapter?: {
  /** 'sqlite' | 'turso' — which adapter to create. */
  type: 'sqlite' | 'turso';
  /** Prefix for env vars (defaults to extension id, uppercased, hyphens→underscores).
   *  The host-runtime sets {prefix}_DB_PATH, {prefix}_TURSO_URL, {prefix}_TURSO_AUTH_TOKEN
   *  by reading the extension's resolved config. */
  env_prefix?: string;
}
```

Host-runtime behavior in `processEntry()` (loader.ts, line ~253, after manifest parse):

```typescript
// If manifest declares a store adapter, inject env vars from resolved config
if (manifest.store_adapter) {
  const prefix = (manifest.store_adapter.env_prefix ?? baseId.toUpperCase().replace(/-/g, '_'));
  const dbPath = resolvedConfig.db_path;
  const tursoUrl = resolvedConfig.turso_url;
  const tursoAuthToken = resolvedConfig.turso_auth_token;

  if (dbPath) configEnv[`${prefix}_DB_PATH`] = dbPath;
  if (tursoUrl) configEnv[`${prefix}_TURSO_URL`] = tursoUrl;
  if (tursoAuthToken) configEnv[`${prefix}_TURSO_AUTH_TOKEN`] = tursoAuthToken;
}
```

The extension's entrypoint reads these env vars and calls `createStoreAdapter()`. This is the same pattern already used for `SOX_CONFIG_DB_PATH` (loader.ts line 290-320).

---

### Error Helpers

**File:** `libs/data/store/store-adapter/src/errors.ts`

```typescript
/**
 * Duck-type checks — works across SqliteAdapter (SqliteError / TypeError from better-sqlite3)
 * and TursoAdapter (LibsqlError from @libsql/client) WITHOUT importing either driver.
 */

/** better-sqlite3: err.code === 'SQLITE_CONSTRAINT_UNIQUE'
 *  @libsql/client:  err.code === 'SQLITE_CONSTRAINT' + msg includes 'UNIQUE' */
function isUniqueConstraintError(err: unknown): boolean;

/** better-sqlite3: err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY'
 *  @libsql/client: err.code === 'SQLITE_CONSTRAINT' + msg includes 'FOREIGN KEY' */
function isForeignKeyError(err: unknown): boolean;

/** Extracts a numeric/symbolic error code from either driver's error object.
 *  Returns undefined if the error is not a recognized database error. */
function dbErrorCode(err: unknown): string | undefined;

/** Returns true if err is a known database driver error from either better-sqlite3 or @libsql/client. */
function isDatabaseError(err: unknown): boolean;
```

No normalization — errors remain native. These helpers are for `instanceof`-style branching in consumer code.

---

### Adapter Lifecycle and Instance Sharing

**Adapter instances are NOT designed to be shared across consumers.** Each consumer should create its own adapter instance, even if both point to the same database file. This is safe because:

- SQLite WAL mode supports multiple concurrent readers and one writer — each adapter is a separate connection, which is the standard pattern.
- Sharing a single adapter would mean sharing transaction scope, pragma state, and prepared-statement cache — dangerous and surprising.
- The task-queue already uses two connections to the same DB (TaskQueue + Scheduler) — this is the verified pattern.

`createSqliteAdapter({ dbPath })` is idempotent at the filesystem level (creates the file if needed, opens if exists). It is NOT idempotent at the connection level — each call creates a new connection. Create once, pass by reference.

---

### 3rd-Party Consumer Pattern (Corrected)

```typescript
// Consumer chooses and wires — sox provides the pieces
import { createSqliteAdapter, createTursoAdapter } from '@adhd/sox-store-adapter';
import { createGraphBackend } from '@adhd/sox-graph-store';
import { createTaskQueue } from '@adhd/sox-task-queue';

// Different adapters for different stores, same process
const userDb = createSqliteAdapter({ dbPath: './users.db' });
const queueDb = createSqliteAdapter({ dbPath: './queue.sqlite' });

const graph = createGraphBackend(userDb);       // signature: (adapter: StoreAdapter) => GraphBackend
const queue = createTaskQueue({ adapter: queueDb }); // config.adapter?: StoreAdapter

// Typed queries carry row shapes via generics:
interface UserRow { id: number; name: string; email: string }
const user = await userDb.executeGet<UserRow>('SELECT * FROM users WHERE id = ?', [42]);
//    ^? UserRow | null — no `as` cast needed
const all = await userDb.executeAll<UserRow>('SELECT * FROM users');
//    ^? { columns: string[]; rows: UserRow[] }
```

Key corrections from Round 2:
1. `@sox/store-adapter` → `@adhd/sox-store-adapter` (actual published name).
2. `createGraphStore()` → `createGraphBackend()` (actual export name).
3. `createTursoAdapter({ url: 'file:./users.db' })` was wrong — `file:` URLs go to TursoAdapter, but for local files use `createSqliteAdapter`.

---

### Segment Decomposition (7 segments, ~58 files)

| Segment | Scope | Depends On | Est. Files | Token Est. |
|---------|-------|------------|-----------|------------|
| A | `store-adapter` package: interface, SqliteAdapter, TursoAdapter, factory, errors, contract tests, README | None | ~14 NEW | ~2000 |
| B | `graph-store`: constructor + applySchema DDL inlining + query migration | A | ~6 MODIFY | ~1800 |
| C | `vector-store`: constructor + factory + query migration + sqlite-vec removal | A | ~5 MODIFY | ~1200 |
| D | `task-queue`: TaskQueue + Scheduler + schema adapter injection | A | ~6 MODIFY | ~1400 |
| E | `blob-store`: factory + query migration + dynamic import removal | A | ~5 MODIFY | ~1300 |
| F | `memory-core`: full migration (~22 source files, ~25 test files). sqlite-vec via `unwrap()`. `getDb()` → async. All domain functions. | A, B | ~47 MODIFY | ~3500 |
| G | Extensions + host-runtime: memory-server/cli/flush wire adapter from env. Host-runtime passthrough. Manifest type update. | B, C, D, E, F | ~9 MODIFY | ~800 |

**Corrected parallelism:** Segments B, C, D, E all depend only on A — they can dispatch in parallel after A. Segment F depends on B (memory-core imports `createGraphBackend`, `GRAPH_DDL`, `FTS_TRIGGERS` from graph-store) but NOT on C, D, or E. Segment G depends on all of B–F.

**Critical path:** A → B → F → G (graph-store blocks memory-core, memory-core blocks extensions). C, D, E are on parallel paths and cannot delay the critical path.

### Key Risks & Mitigations (code-verified)

| Risk | Severity | Discovery | Mitigation |
|------|----------|-----------|------------|
| `sqlite-vec` incompatible with Turso | **HIGH** | sqlite-vec uses better-sqlite3's native addon ABI; @libsql/client has its own bundled SQLite with no extension support. Applies to both `file:` and remote modes. | memory-core narrows to `(adapter as SqliteAdapter).unwrap()` ONLY when `adapter.config.type === 'sqlite'`. Turso mode uses FTS5 keyword search + brute-force JS cosine (already implemented in `BruteForceBackend`). Vec features are conditionally disabled, not "falls back" silently. |
| Transaction callback sync constraint | **MEDIUM** | better-sqlite3's `db.transaction()` requires a sync callback — returning a Promise passes the Promise object as the return value, silently breaking all callers. All 17 existing transaction callbacks in the codebase are sync — verified by reading every `db.transaction()` call site. | SqliteAdapter's `transaction()` wraps the callback and throws `TypeError` if the return value is thenable. TypeScript signature uses `T` (not `Promise<T>`) to signal sync-at-compile-time. TursoAdapter has no such constraint — it uses explicit BEGIN/COMMIT/ROLLBACK. |
| Drizzle incompatibility with TursoAdapter | **CRITICAL → ELIMINATED** | graph-store's `applySchema()` passes `this.db` to `drizzle(this.db)` which requires `better-sqlite3.Database`. A TursoAdapter's `unwrap()` returns `@libsql/client.Client` — calling `drizzle()` on it throws. | graph-store inlines its DDL (the single Drizzle migration SQL) alongside existing `FTS_DDL`/`FTS_TRIGGERS`. `drizzle-orm` removed from runtime dependencies. `drizzle-kit` retained as devDependency for future migration generation — generated SQL is manually copied into the inline constant. |
| Host-runtime can't inject live adapters | **HIGH** | The host-runtime spawns extensions as child processes (mcp-server, service) — live JavaScript objects can't cross process boundaries. In-process types (command, hook) could theoretically receive an adapter, but none currently consume databases. | Host-runtime reads `manifest.store_adapter` and sets env vars only. Extensions create their own adapters via `createStoreAdapter()` at startup — the same pattern already used for `SOX_CONFIG_DB_PATH`. |
| Batch atomicity driver divergence | **MEDIUM** | `@libsql/client.batch()` sends each statement as a separate HTTP request — non-atomic even within a transaction for the HTTP planner. SqliteAdapter's batch IS atomic within a transaction. | Document `batch()` as NOT portable-atomic. The only portable atomic path is `transaction()`. TursoAdapter (file: mode) and SqliteAdapter both support atomic transactions — divergence is only in remote mode. |
| `executeGet` result always allocates an array internally | **LOW** | For SqliteAdapter, `.get()` returns the single row directly; for TursoAdapter, `.execute()` returns `{ rows: [...] }` — `executeGet` must extract `rows[0]`, allocating the full array unnecessarily for single-row queries. | SqliteAdapter calls `.get()` directly; TursoAdapter calls `.execute()` which returns all rows anyway (HTTP protocol limitation). The adapter abstracts over this — SqliteAdapter gets the optimization, TursoAdapter takes the hit. Document in adapter README. |
| memory-core's `openDbReadOnly()` needs adapter support | **LOW** | `openDbReadOnly()` creates `new Database(dbPath, { readonly: true })`. | `AdapterConfig.readonly?: boolean` is now part of the interface (R4 fix). SqliteAdapter passes it to better-sqlite3; TursoAdapter file: mode also supports it. |
| BigInt vs number `lastInsertRowid` | **LOW** | TypeScript forces consumer to handle both. Verified: all current codebase callers of `.run()` discard `lastInsertRowid` (use `changes` only) except for the `write.ts` RETURNING path, which reads the row directly — no `lastInsertRowid` dependency. | RunResult type uses `number | bigint`. Consumer code that needs `lastInsertRowid` must narrow. |

### New Risks Discovered (not in Round 2)

| Risk | Severity | Discovery | Mitigation |
|------|----------|-----------|------------|
| Prepared statement cache in SqliteAdapter is new mutable state per adapter instance | **MEDIUM** | better-sqlite3's `.prepare()` is the primary perf primitive — replacing it with per-call `execute()` loses that optimization unless the adapter internally caches. The LRU cache (256 entries, keyed by SQL) is new code that didn't exist before. | Contract tests verify cache hit rate ≥ 90% on repeated queries. Cache is TTL-bounded (10 min) to prevent stale query planning after ANALYZE. Optional: adapter constructor accepts `{ statementCacheSize?: number }` — set to 0 to disable. |
| `processEntry()` env var injection must happen before `dispatchToAdapter()` | **LOW** | If `store_adapter` env vars are set after `spawnEnv` is constructed, they won't reach the child process. | Env var passthrough occurs in the same block as existing config injection (loader.ts line 299-323), BEFORE `dispatchToAdapter()` at line 344. No reordering needed — just insert the new code. |
| Adapter factory dynamic imports break CJS consumers | **CRITICAL** | memory-core compiles to CJS (`tsconfig.lib.json`: `module: CommonJS`). A dynamic `import()` inside the adapter factory would work at runtime (CJS supports async import), but the factory returns `Promise<StoreAdapter>` — requiring all callers to add `await`. All existing callers are already async (MCP handlers, enrichment pipelines) — but `openDb()` is called at module load time in some paths. | `openDb()` becomes `async`: callers must `await openDb(dbPath)`. The only sync callers are in test setup (`beforeAll`), which already supports async. `module.exports` top-level is unaffected. Verified: no call site calls `openDb()` at module scope without `await` (all are inside async functions). |
| Memory-core's `openDbReadOnly` for federated recall opens a second adapter on the same file | **LOW** | Currently opens a second `new Database(dbPath, { readonly: true })`. With adapter, opens a second `SqliteAdapter({ dbPath, readonly: true })`. Same connection count — no regression. | No special handling needed. Two adapters = two connections = same as current. |

### Testing Strategy

1. **Adapter contract tests** (`store-adapter/contract/`) — shared test suite that runs against both SqliteAdapter (file: path) and TursoAdapter (file: path). Validates:
   - `executeGet` (single-row), `executeGet` (no rows → null)
   - `executeAll` (multi-row), `executeAll` (empty → [])
   - `executeRun` (INSERT → rowsAffected=1, lastInsertRowid), `executeRun` (UPDATE → rowsAffected=N), `executeRun` (DELETE → rowsAffected)
   - `exec` (DDL multi-statement)
   - `pragmaSet` / `pragmaGet` (round-trip: cache_size, journal_mode)
   - `transaction` (commit path, rollback-on-error path, nested-transaction detection)
   - `batch` (non-atomic multi-statement convenience)
   - `close` (subsequent operations throw), `close` (idempotent)
   - Error helpers (`isUniqueConstraintError`, `isForeignKeyError`, etc.) with real constraint-violating SQL
   - Prepared statement cache verification (SqliteAdapter only): same SQL called 500× → cache hit count
   - Read-only mode (writes throw, reads succeed)
2. **Consumer tests** — each `libs/data/*` package uses a mock adapter (`createMockStoreAdapter()`) injected via DI. No real database needed for unit tests. The mock adapter implements the full interface in-memory.
3. **Integration tests** — `memory-core` integration tests run against both adapters via the contract suite. sqlite-vec tests only run on the SqliteAdapter (skip when `adapter.config.type !== 'sqlite'`).
4. **CI** — TursoAdapter tested in local `file:` mode only (zero external deps). No sqld server needed.
5. **Benchmark gate** — async wrapping overhead benchmark comparing raw `better-sqlite3` vs `SqliteAdapter`. Tests:
   - Single-row get (1000 iterations): overhead < 5%
   - Multi-row all (1000 rows): overhead < 5%
   - Insert transaction (1000 inserts in one txn): overhead < 5%
   - Prepared statement cache hit rate (1000 × same SQL): hit rate ≥ 95%

### Execution Strategies

#### Segment A — store-adapter package (foundation)

1. Create `libs/data/store/store-adapter/` with `package.json`, `tsconfig.json`, `project.json`.
2. Create `src/types.ts` with the `StoreAdapter` interface exactly as spec'd.
3. Create `src/sqlite-adapter.ts` — wraps better-sqlite3:
   - Constructor: `dbPath: string` OR `db: Database.Database`.
   - `executeGet`: calls `db.prepare(sql).get(...args)` wrapped in `Promise.resolve()`.
   - `executeAll`: calls `db.prepare(sql).all(...args)`.
    - `executeRun`: calls `db.prepare(sql).run(...args)`, returns `{ rowsAffected: info.changes, lastInsertRowid: info.lastInsertRowid }`.
   - `exec`: calls `db.exec(sql)`.
   - `pragmaSet`: `db.pragma(`${key} = ${value}`)`.
   - `pragmaGet`: `db.pragma(key, { simple: true })`.
   - `transaction`: wraps `db.transaction(fn)`, detects async by checking return value for `.then`.
   - `batch`: calls each statement via `executeRun()` sequentially (non-atomic).
   - `unwrap()`: returns `this.db`.
   - Statement LRU cache: `Map<string, { stmt: Statement, lastUsed: number }>`, max 256 entries.
4. Create `src/turso-adapter.ts` — wraps `@libsql/client`.
5. Create `src/factory.ts` — `createStoreAdapter()`, `createSqliteAdapter()`, `createTursoAdapter()`, `createSqliteAdapterFromHandle()`.
6. Create `src/errors.ts` — duck-typed error helpers.
7. Create `src/mock-adapter.ts` — in-memory implementation for tests (no real DB).
8. Create `contract/` test suite directory — runs against both adapters.
9. Write `README.md` — public API docs, migration guide, 3rd-party examples.
10. `npx nx lint store-adapter && npx nx build store-adapter && npx nx test store-adapter`.

#### Segment B — graph-store adapter injection

1. Read `libs/data/graph/graph-store/src/index.ts` lines 680-740 (constructor + applySchema).
2. Inline the DDL from `drizzle/migrations/0000_sad_onslaught.sql` as a string constant `GRAPH_STORE_BASELINE_DDL` in `src/schema-ddl.ts`.
3. Remove `import { drizzle } from 'drizzle-orm/better-sqlite3'` and `import { migrate } from 'drizzle-orm/better-sqlite3/migrator'`.
4. Change `applySchema()` to call `this.adapter.exec(GRAPH_STORE_BASELINE_DDL)` instead of the drizzle migration path. The DDL uses `CREATE TABLE IF NOT EXISTS` — idempotent on repeat calls.
5. Keep FTS_DDL, FTS_TRIGGERS, FTS index rebuild, and `ensureCheckConstraints()` — all use `adapter.exec()`.
6. Change field `private db: Database.Database` → `private adapter: StoreAdapter`.
7. Change constructor to `constructor(adapter: StoreAdapter)`.
8. Migrate all `this.db.prepare(...)` calls (~35 locations) to `this.adapter.executeGet/All/Run()`.
9. Update `createGraphBackend(db)` → `createGraphBackend(adapter: StoreAdapter)`.
10. Update `package.json`: remove `drizzle-orm`, `drizzle-orm/better-sqlite3` from deps. Keep `drizzle-kit` in devDeps only.
11. Run graph-store tests: `npx nx test graph-store`. Apply contract test suite with mock adapter.

#### Segment C — vector-store adapter injection

1. Change `SqliteVectorBackend` constructor to accept `adapter: StoreAdapter`.
2. Remove `import * as sqliteVec from 'sqlite-vec'` — the adapter caller now loads it.
3. Remove `import Database from 'better-sqlite3'` — replace with adapter.
4. `openVectorStore()` now creates adapter internally if given a path string; otherwise uses provided adapter.
5. All `this.db.exec(...)` → `this.adapter.exec(...)`.
6. All `this.db.prepare(...)` → `this.adapter.execute*()`.
7. `BruteForceBackend` receives `StoreAdapter` — `iter()` reads vectors via `adapter.executeAll<{ node_id: number; embedding: Buffer }>()`.
8. Tests: create mock adapter, inject via constructor.

#### Segments D, E — task-queue, blob-store

Same pattern: `adapter` field replaces `db` field. Lazy creation when adapter not provided. Query migration is mechanical.

**task-queue note:** `enqueue()` and `enqueueBatch()` use `this.db!.transaction(() => ...)()` — these become `await this.adapter.transaction(tx => { ... })`. The callback content is identical — only the wrapper changes. The `Scheduler` independently creates its own adapter.

**blob-store note:** Remove `new (await import('better-sqlite3')).default(dbPath)` — the dynamic import moves to the adapter factory. If no adapter is provided, `open()` calls `createSqliteAdapter({ dbPath })` instead.

#### Segment F — memory-core full migration

1. `db.ts`: `openDb()` returns `Promise<StoreAdapter>`. Creates adapter, loads sqlite-vec (only if SqliteAdapter), applies pragmas/schema/DDL via adapter methods.
2. `db.ts`: `getDb()` becomes async — add `await` to all callers.
3. `db.ts`: `openDbReadOnly()` creates read-only SqliteAdapter.
4. All domain files (22 source files): change `db: Database.Database` param to `adapter: StoreAdapter`.
5. Mechanical query migration in each file:
   - `db.prepare(sql).get(...args)` → `await adapter.executeGet(sql, args)`
   - `db.prepare(sql).all(...args)` → `await adapter.executeAll(sql, args)`
   - `db.prepare(sql).run(...args)` → `await adapter.executeRun(sql, args)`
   - `db.exec(sql)` → `await adapter.exec(sql)`
   - `db.transaction(() => { ... })(args)` → `await adapter.transaction(tx => { ... using tx.execute*() ... })`
   - `createGraphBackend(db)` → `createGraphBackend(adapter)`
6. **Transaction translation rule:** Within a transaction callback, `db` references become `tx` references:
   ```typescript
   // BEFORE
   this.db!.transaction(() => {
     this.db!.prepare('UPDATE ...').run(args);
     this.db!.prepare('INSERT ...').run(args);
   })();
   // AFTER
   await this.adapter!.transaction(tx => {
     tx.executeRun('UPDATE ...', args);
     tx.executeRun('INSERT ...', args);
   });
   ```
7. All tests (25 spec files): create adapter via mock adapter or `createSqliteAdapter({ dbPath: tempDir + '/test.db' })`. Tests that currently use `sqliteVec.load(db)` must use `sqliteVec.load((adapter as SqliteAdapter).unwrap())` when testing against SqliteAdapter, or skip vec features when testing against TursoAdapter.
8. `write-queue.ts`: `WriteQueue` opens its own adapter via `openDb()` — same pattern, but now returns `Promise<StoreAdapter>`.
9. Run full test suite: `npx nx test memory-core`. Verify all pass.

#### Segment G — Extensions + host-runtime wiring

1. `memory-server/src/main.ts`, `memory-cli/src/main.ts`, `memory-flush/src/main.ts`: replace `new Database(dbPath)` / `openDb(dbPath)` with `await openDb(dbPath)`. The returned value is now a `StoreAdapter` — pass it to all domain functions.
2. `libs/host-runtime/src/loader.ts`: in `processEntry()`, after manifest parse (line ~260), add `store_adapter` env var injection before `dispatchToAdapter()`.
3. `libs/manifest/src/index.ts`: add `store_adapter` to the `Manifest` TypeScript type and `ManifestSchema.properties`.
4. `schemas/extension/v2.json`: if maintaining static schema copy, add `store_adapter` there too.
5. Run smoke test: `node scripts/smoke-test.mjs`. Verify memory-server starts with both SqliteAdapter and TursoAdapter (file: mode).

---

### Documentation Updates

1. **`docs/standards/store-adapter.md`** (new) — 3rd-party integration guide with examples.
2. **`libs/data/CLAUDE.md`** — add summary of adapter pattern, boundary rules.
3. **`libs/data/store/store-adapter/README.md`** — public API reference.
4. **`CHANGELOG.md`** — breaking change: `createGraphBackend`, `createTaskQueue`, `createBlobStore`, `openVectorStore` signatures changed.

---

### Memory Episodes Written

Key codebase discoveries, corrected segment dependencies, interface design decisions, verified risk levels, and migration patterns stored to memory with tags `turso`, `adapter`, `store`, `architecture`, `codebase-discovery`, `round-3`.
