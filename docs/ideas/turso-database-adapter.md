# Turso Database Adapter Integration — Consumer-Audited Architecture (Round 6)

> **Previous rounds:** v1–v4 (`turso-adapter-integration*.md`) targeted `@libsql/client` (WRONG).
> **Round 5:** (`turso-database-adapter.md`) corrected target to `@tursodatabase/database` — structurally correct but written without real consumer analysis.
> **This round:** Four external consumer audits now complete (`phase-2-adhd-backlog.md`, `phase-2-agent-source.md`, `phase-2-agent-mcp-authoring.md`, `phase-2-agent-packages.md`). This spec revises Round 5 to account for real-world patterns: `BEGIN IMMEDIATE` CAS transactions, Drizzle coupling through 3 layers, shared `openRegistryDb()` pattern, `Atomics.wait` retry loops, and mixed connection ownership.

---

## Summary

Replace the current `better-sqlite3`-hard-wired database layer with a capability-flagged `StoreAdapter` interface implemented by two backends: **TursoAdapter** (wrapping `@tursodatabase/database` — the Turso Database Rust rewrite, the new default) and **SqliteAdapter** (wrapping `better-sqlite3` — backward-compatible fallback). The adapter pattern is selected at composition time through a single factory call or explicit constructor. TursoAdapter unlocks multi-process writers via `multiprocess_wal`, native async I/O, built-in vector search, MVCC with `BEGIN CONCURRENT`, and encryption at rest. The `transaction()` method accepts a `mode` parameter (`deferred`, `immediate`, `exclusive`, `concurrent`) mapping to SQLite's transaction types — bridging the consumer's `BEGIN IMMEDIATE` CAS pattern. A standalone `VectorDialect` (created by vector-store, not attached to the adapter) routes between Turso's built-in vector support and sqlite-vec's extension-based API. Drizzle consumers migrate via a two-phase unwrap bridge: Phase 1 retains `drizzle-orm/better-sqlite3` through `(adapter as SqliteAdapter).unwrap()`, Phase 2 switches to `drizzle-orm/tursodatabase/database` (beta, `drizzle-orm@rc`) with `drizzle({ client })`. Each consumer manages its own adapter lifecycle — the 5-package `openRegistryDb()` pattern opens separate adapter instances to the same file path.

---

## Consumer Migration Matrix

Every consumer pattern from the audits maps to a spec feature. This table proves the spec addresses real-world usage:

| Consumer | Pattern | Spec Feature | Section |
|----------|---------|-------------|---------|
| Backlog (`phase-2-adhd-backlog`) | `db.transaction(fn).immediate()` — `BEGIN IMMEDIATE` CAS | `transaction(fn, { mode: 'immediate' })` — explicit transaction mode parameter | [Transaction modes](#transaction-modes) |
| Backlog | `withImmediateRetry()` using `Atomics.wait` | Async retry utilities: `withRetry(adapter, fn)` using `setTimeout` exponential backoff + `isConcurrentConflict()` | [Retry migration](#retry-migration-atomicswait--settimeout) |
| Backlog | `store.db: Database.Database` leaks to 3 raw SQL call sites | `adapter.executeRun()` + `adapter.close()` — 1:1 mechanical migration | [Per-package migration](#consumer-package-migration) |
| Agent-MCP (`phase-2-agent-mcp-authoring`) | `drizzle-orm/better-sqlite3` → `drizzle(client)` construction | Phase 1: `(adapter as SqliteAdapter).unwrap()` → `drizzle(client)`. Phase 2: `drizzle-orm/tursodatabase/database` → `drizzle({ client })` | [Drizzle migration](#drizzle-migration-path-two-phase) |
| Agent-MCP | 5 packages share registry DB through `openRegistryDb()` | Each package opens its own adapter to the same file — WAL mode supports concurrent readers. | [Multi-process](#multi-process-writer-architecture) |
| Agent-MCP | `BetterSQLite3Database<any>` constructor params in 8+ store classes | `StoreAdapter` replaces `BetterSQLite3Database<any>`. Stores use `adapter.execute*()` instead of drizzle query builder OR retain drizzle via `unwrap()`. | [Store class migration](#store-class-migration-drizzle-consumers) |
| Agent Packages (`phase-2-agent-packages`) | `agent-core-env` as coordination bottleneck — `openRegistryDb()` → `better-sqlite3.Database` | `openRegistryDb()` returns `Promise<StoreAdapter>` — each caller opens its own adapter to the same file path. | [Shared connections](#shared-connections-openregistrydb-pattern) |
| Agent Packages | 9 packages, 4 with direct `better-sqlite3`, 4 with drizzle-only | Two migration paths: raw SQL → `execute*()`, drizzle → `unwrap()` bridge | [Drizzle migration](#drizzle-migration-path-two-phase) |
| Agent-Source (`phase-2-agent-source`) | Mixed connection ownership: graph-store receives handle via constructor, blob-store opens own | DI path: constructor accepts `StoreAdapter`. Factory path: config accepts `adapter?` or falls back to `createSqliteAdapter({ dbPath })`. | [Mixed ownership](#mixed-connection-ownership) |
| Agent-Source | `sqliteVec.load(db)` calls | Narrow on `adapter.config.type === 'sqlite'` → `sqliteVec.load((adapter as SqliteAdapter).unwrap())` | [Vector migration](#vector-migration-sqlite-vec--turso-native-vectors) |
| Agent-Source | Three delivery surfaces (CLI, HTTP, MCP) share one DB | `multiprocess_wal` via `.tshm` sidecar — multi-process writers without SQLITE_BUSY | [Multi-process](#multi-process-writer-architecture) |
| Agent-Source | No drizzle coupling | Simpler path: all DB access through sox packages that migrate as part of this spec | [Migration difficulty tiers](#migration-difficulty-tiers) |

**Migration difficulty tiers** (consumer effort, not spec effort):

| Tier | Consumer | Effort | Why |
|------|----------|--------|-----|
| **Simple** | Agent-Source | Upgrades sox deps, changes composition root | No drizzle, all DB through sox packages |
| **Medium** | Backlog | Rewrites CAS pattern to `transaction(fn, { mode })`, asyncifies retry | `BEGIN IMMEDIATE` maps cleanly; `Atomics.wait` → `setTimeout` |
| **Complex** | Agent-MCP Authoring | Two database migrations, 8+ store class constructor changes, registry DB singleton coordination | Drizzle coupling through 3 layers; `openRegistryDb()` coordination bottleneck |
| **Complex** | Agent Packages | 9-package simultaneous migration through `openRegistryDb()` | No gradual adoption possible; `agent-core-env` must migrate first |

---

## How This Differs from Round 5

| Dimension | Round 5 (un-audited) | Round 6 (consumer-audited) |
|---|---|---|
| **Transaction mode** | `transaction(fn)` — single mode, `BEGIN` SQL | `transaction(fn, opts?)` — `mode: 'deferred' \| 'immediate' \| 'exclusive' \| 'concurrent'` — maps to `BEGIN IMMEDIATE`, `BEGIN CONCURRENT`, etc. |
| **BEGIN IMMEDIATE** | Not supported — `BEGIN CONCURRENT` suggested as alternative | First-class via `mode: 'immediate'`. Both adapters use raw `BEGIN IMMEDIATE` SQL — no `db.transaction(fn)` wrapper (SqliteAdapter drops it for interface consistency). |
| **Drizzle migration** | Mentioned only in risk table ("Drizzle incompatibility eliminated") | Full two-phase migration documented: Phase 1 unwrap bridge, Phase 2 import swap. Exact code changes shown for both paths. |
| **Shared connections** | "NOT designed to be shared" (v3) | Each package opens its own adapter to the same file — WAL mode supports concurrent readers. |
| **Async retry** | `withRetry()` shown for `BEGIN CONCURRENT` only | `withRetry()` documented for `mode: 'immediate'` too + `setTimeout` replacement for `Atomics.wait`. |
| **Consumer migration matrix** | None | Full matrix mapping every audit pattern to spec feature |
| **Connection ownership** | Factory + DI mentioned | Explicit DI (constructor receives adapter) + factory fallback (config path → create adapter internally) patterns documented per consumer |
| **`batch()` name** | `batch()` | Renamed to `executeMany()` — avoids collision with `@libsql/client.batch()` mental model (F12 from DX review) and doesn't imply atomicity |
| **SqliteAdapter tx strategy** | `db.transaction(fn)` sync wrapper | Raw `BEGIN` / `COMMIT` / `ROLLBACK` (same as TursoAdapter) — removes the sync-callback constraint and makes `AdapterTransaction` methods (all `Promise`) usable inside the callback |

Everything else from Round 5 is preserved: `VectorDialect`, capability flags, `multiprocess_wal` architecture, factory defaults, risk assessment, segment decomposition, test strategy. Round 6 adds what was missing — real consumer compatibility.

---

## Files

| Path | Change | Read tokens | Output tokens |
|------|--------|-------------|---------------|
| `libs/data/store/store-adapter/src/types.ts` | create | 0 | ~450 |
| `libs/data/store/store-adapter/src/turso-adapter.ts` | create | 0 | ~500 |
| `libs/data/store/store-adapter/src/sqlite-adapter.ts` | create | 0 | ~500 |
| `libs/data/store/store-adapter/src/vector-dialect.ts` | create | 0 | ~250 |
| `libs/data/store/store-adapter/src/factory.ts` | create | 0 | ~300 |
| `libs/data/store/store-adapter/src/retry.ts` | create | 0 | ~150 |
| `libs/data/store/store-adapter/src/errors.ts` | create | 0 | ~120 |
| `libs/data/store/store-adapter/src/mock-adapter.ts` | create | 0 | ~150 |
| `libs/data/store/store-adapter/src/index.ts` | create | 0 | ~40 |
| `libs/data/store/store-adapter/package.json` | create | 0 | ~50 |
| `libs/data/store/store-adapter/project.json` | create | 0 | ~40 |
| `libs/data/store/store-adapter/tsconfig.json` | create | 0 | ~20 |
| `libs/data/store/store-adapter/tsconfig.lib.json` | create | 0 | ~20 |
| `libs/data/store/store-adapter/README.md` | create | 0 | ~250 |
| `libs/data/store/store-adapter/test/contract.test.ts` | create | 0 | ~500 |
| `libs/data/store/store-adapter/test/turso-adapter.test.ts` | create | 0 | ~250 |
| `libs/data/store/store-adapter/test/sqlite-adapter.test.ts` | create | 0 | ~250 |
| `libs/data/store/store-adapter/test/mock-adapter.test.ts` | create | 0 | ~150 |
| `libs/data/graph/graph-store/src/index.ts` | modify | ~500 | ~600 |
| `libs/data/vectors/vector-store/src/index.ts` | modify | ~400 | ~500 |
| `libs/data/queue/task-queue/src/*.ts` | modify | ~400 | ~400 |
| `libs/data/store/blob-store/src/*.ts` | modify | ~300 | ~350 |
| `libs/memory-core/src/db.ts` | modify | ~200 | ~300 |
| `libs/memory-core/src/**/*.ts` (22 files) | modify | ~2000 | ~2500 |
| `extensions/bundles/sox-memory-bundle/members/memory-server/src/*.ts` | modify | ~100 | ~100 |
| `extensions/bundles/sox-memory-bundle/members/memory-cli/src/*.ts` | modify | ~100 | ~100 |
| `extensions/bundles/sox-memory-bundle/members/memory-flush/src/*.ts` | modify | ~80 | ~80 |
| `tools/baseline-capture/src/capture-enrichment-baseline.ts` | modify | ~250 | ~250 |
| `tools/baseline-capture/src/capture-enrichment-baseline.spec.ts` | modify | ~100 | ~50 |
| `tools/baseline-capture/package.json` | modify | ~20 | ~10 |

---

## Interface Changes

### New: `libs/data/store/store-adapter/src/types.ts`

```typescript
// ── Result types ────────────────────────────────────────────────────────────

export interface RunResult {
  rowsAffected: number;
  lastInsertRowid: number | bigint;
}

export interface AllResult<T = Record<string, unknown>> {
  columns: string[];
  rows: T[];
}

// ── Transaction mode ────────────────────────────────────────────────────────

/**
 * Maps to SQLite's transaction types:
 * - 'deferred'  → BEGIN DEFERRED (lock on first write — SQLite default)
 * - 'immediate' → BEGIN IMMEDIATE (RESERVED lock at start — CAS primitive)
 * - 'exclusive' → BEGIN EXCLUSIVE (EXCLUSIVE lock at start)
 * - 'concurrent'→ BEGIN CONCURRENT (MVCC optimistic — TursoAdapter only)
 *
 * SqliteAdapter supports deferred/immediate/exclusive via better-sqlite3's
 * db.transaction(fn).deferred()/.immediate()/.exclusive().
 * concurrent is TursoAdapter-only — SqliteAdapter throws if used.
 */
export type TransactionMode = 'deferred' | 'immediate' | 'exclusive' | 'concurrent';

// ── Transaction ─────────────────────────────────────────────────────────────

export interface AdapterTransaction {
  executeGet<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<T | null>;
  executeAll<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<AllResult<T>>;
  executeRun(sql: string, args?: unknown[]): Promise<RunResult>;
  exec(sql: string): Promise<void>;
}

export interface TransactionOptions {
  /** Transaction mode. Default: 'deferred'. Portable code SHOULD set this explicitly — do not rely on the default. */
  mode?: TransactionMode;
  /** Retry on concurrent conflict (BUSY / SQLITE_BUSY_SNAPSHOT). Default: 3. */
  maxRetries?: number;
  /** Initial backoff delay in ms. Doubles each retry. Default: 10. */
  baseDelayMs?: number;
}

// ── Capability flags ────────────────────────────────────────────────────────

export interface AdapterCapabilities {
  multiprocessWrite: boolean;
  nativeVectors: boolean;
  concurrentTransactions: boolean;
}

// ── Vector dialect ──────────────────────────────────────────────────────────

export type VectorMetric = 'cosine' | 'l2' | 'dot';

export interface VectorDialect {
  vectorColumnType(dim: number): string;
  distanceExpr(column: string, queryVec: number[]): string;
  createIndexDDL(table: string, column: string, metric: VectorMetric): string;
  topKQuery(table: string, column: string, queryVec: number[], k: number, metric: VectorMetric): { sql: string; args: unknown[] };
  /** Internal: initialize the dialect with the raw driver handle. Called by vector-store (not the adapter) after selecting which dialect to use. SqliteVecDialect uses this to call sqliteVec.load(db). TursoVectorDialect is a no-op (native vectors are always available). */
  initialize(db: unknown): Promise<void>;
}

// ── Config ──────────────────────────────────────────────────────────────────

export interface AdapterConfig {
  type: 'sqlite' | 'turso';
  /** For SqliteAdapter: path to the database file (required). For TursoAdapter: if url is also set, url takes precedence. If only dbPath is set, treated as local file: mode. */
  dbPath?: string;
  /** TursoAdapter remote URL (libsql://my-db.turso.io). Takes precedence over dbPath for remote connections. Ignored by SqliteAdapter. */
  url?: string;
  authToken?: string;
  readonly?: boolean;
  encryption?: {
    cipher: 'aegis256' | 'aes256gcm';
    hexkey: string;
  };
  /** Experimental feature flags. Currently: multiprocessWal enables multi-process write support. */
  experimental?: { multiprocessWal?: boolean };
  defaultQueryTimeout?: number;
}

// ── Main interface ──────────────────────────────────────────────────────────

export interface StoreAdapter {
  // Query methods
  executeGet<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<T | null>;
  executeAll<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<AllResult<T>>;
  executeRun(sql: string, args?: unknown[]): Promise<RunResult>;

  // DDL / multi-statement
  exec(sql: string): Promise<void>;

  // PRAGMA shortcuts. Boolean values are converted to 1 (true) / 0 (false).
  pragmaSet(key: string, value: string | number | boolean): Promise<void>;
  pragmaGet<T = unknown>(key: string): Promise<T>;

  // Transaction with mode support
  /**
   * Execute a callback within a database transaction.
   *
   * To abort a transaction, throw from the callback — the adapter automatically
   * issues ROLLBACK and re-throws. There is no explicit rollback() method.
   *
   * @param fn  The transactional body. Both adapters support sync and async callbacks.
   *            Use await on AdapterTransaction methods inside the callback — they all return Promises.
   * @param opts  Optional mode + retry config. mode defaults to 'deferred'.
   *              Use 'immediate' for CAS, 'exclusive' for schema migrations,
   *              'concurrent' for MVCC (TursoAdapter only).
   */
  transaction<T>(fn: (tx: AdapterTransaction) => T | Promise<T>, opts?: TransactionOptions): Promise<T>;

  // Batch convenience (NON-ATOMIC — runs statements sequentially; first failure does not roll back prior statements. For atomicity, use transaction().)
  executeMany(stmts: { sql: string; args?: unknown[] }[]): Promise<RunResult[]>;

  // Lifecycle
  close(): Promise<void>;

  // Introspection
  readonly config: Readonly<AdapterConfig>;
  readonly capabilities: Readonly<AdapterCapabilities>;
}

// ── Narrowed sub-types ─────────────────────────────────────────────────────

export interface SqliteAdapter extends StoreAdapter {
  readonly config: Readonly<AdapterConfig & { type: 'sqlite' }>;
  /** Escape hatch — returns the raw better-sqlite3.Database handle. Calling this breaks portability. */
  unwrap(): import('better-sqlite3').Database;
}

export interface TursoAdapter extends StoreAdapter {
  readonly config: Readonly<AdapterConfig & { type: 'turso' }>;
  /** Escape hatch — returns the raw @tursodatabase/database handle. Calling this breaks portability. */
  unwrap(): import('@tursodatabase/database').Database;
}
```

### New: `libs/data/store/store-adapter/src/errors.ts`

```typescript
/**
 * Portable error helpers that duck-type across both SqliteAdapter's SqliteError
 * (from better-sqlite3) and TursoAdapter's driver-native error. Consumers MUST
 * use these helpers for portable error handling — no `instanceof` checks against
 * driver classes. There is no base `StoreAdapterError` wrapper class.
 */

/** True if the error represents a concurrent conflict (MVCC conflict OR SQLITE_BUSY). */
export function isConcurrentConflict(err: unknown): boolean;

/** True if the error is specifically SQLITE_BUSY (writer slot contention). */
export function isBusyError(err: unknown): boolean;

/** True if the error is a UNIQUE constraint violation (SQLITE_CONSTRAINT_UNIQUE). */
export function isUniqueConstraintError(err: unknown): boolean;

/** True if the error is a FOREIGN KEY constraint violation (SQLITE_CONSTRAINT_FOREIGNKEY). */
export function isForeignKeyError(err: unknown): boolean;

/** Returns the numeric SQLite error code (e.g., 5 = BUSY, 19 = CONSTRAINT, 2067 = CONSTRAINT_UNIQUE) or null if the error is not a recognized database error. */
export function dbErrorCode(err: unknown): number | null;

/** True if err is any recognized database error (SqliteError or Turso equivalent). */
export function isDatabaseError(err: unknown): boolean;
```

### New: `libs/data/store/store-adapter/src/retry.ts`

```typescript
import type { StoreAdapter, AdapterTransaction, TransactionOptions } from './types';
import { isConcurrentConflict } from './errors';

/** Lightweight retry opts for non-transactional retries. */
export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
}

/**
 * Execute a transactional function with retry on concurrent conflict.
 * Replaces the `withImmediateRetry()` + `Atomics.wait` pattern used by the
 * backlog consumer. Uses async setTimeout-based exponential backoff.
 *
 * Retry config (maxRetries, baseDelayMs) is part of TransactionOptions.
 *
 * @param adapter   The store adapter.
 * @param fn        The transactional body. Throw to abort the transaction.
 * @param opts      Transaction mode + retry config.
 */
export async function withRetry<T>(
  adapter: StoreAdapter,
  fn: (tx: AdapterTransaction) => T | Promise<T>,
  opts?: TransactionOptions,
): Promise<T>;

/**
 * Retry a non-transactional block on concurrent conflict.
 * Simple loop: attempt fn, catch isConcurrentConflict, backoff, retry.
 */
export async function retryOnConflict<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<T>;
```

### New: `libs/data/store/store-adapter/src/factory.ts`

```typescript
/**
 * Create a StoreAdapter auto-detected from environment.
 * - STORE_ADAPTER env var: 'turso' | 'sqlite' (default: 'turso')
 * - If configured for turso, checks TURSO_URL / TURSO_AUTH_TOKEN env vars.
 * - Source code that hardcodes the adapter type should use createSqliteAdapter() or
 *   createTursoAdapter() directly to get the narrowed return type.
 */
export async function createStoreAdapter(config?: Partial<AdapterConfig>): Promise<StoreAdapter>;

export function createSqliteAdapter(opts: { dbPath: string; readonly?: boolean; statementCacheSize?: number }): SqliteAdapter;
export function createSqliteAdapter(db: import('better-sqlite3').Database): SqliteAdapter;
export async function createTursoAdapter(opts: { dbPath?: string; url?: string; authToken?: string; readonly?: boolean; encryption?: AdapterConfig['encryption']; experimental?: { multiprocessWal?: boolean }; defaultQueryTimeout?: number }): Promise<TursoAdapter>;
```

**Factory behavior:**
- Default: `turso` (set `STORE_ADAPTER=sqlite` to override).
- If no remote URL: uses local `file:` mode — zero-config dev.
- Dynamic `import()` for `@tursodatabase/database` — throws descriptive error if not installed.
- `createStoreAdapter()` is for env-driven selection. For code that hardcodes the backend,
  use `createSqliteAdapter()` or `createTursoAdapter()` directly — these return narrowed types
  with `unwrap()` available.
- `createSqliteAdapter()` is overloaded: accepts a config object (creates a new Database) or
  an existing `better-sqlite3.Database` handle (wraps an externally-managed connection).
- Each consumer manages its own adapter lifecycle — there is no shared singleton. For the
  `openRegistryDb()` pattern where multiple packages access the same database file, each
  opens its own adapter instance. SQLite WAL mode supports concurrent readers from
  separate connections.

---

## Behavioral Changes

### Transaction Modes

The most significant behavioral change from Round 5. The adapter interface now supports four transaction modes:

| Mode | SQL | Lock acquired | SqliteAdapter | TursoAdapter | Consumer use case |
|------|-----|--------------|---------------|-------------|-------------------|
| `deferred` | `BEGIN DEFERRED` | On first write | raw `BEGIN DEFERRED` SQL | raw `BEGIN DEFERRED` SQL | Read-heavy workloads (SQLite default) |
| `immediate` | `BEGIN IMMEDIATE` | RESERVED at start | raw `BEGIN IMMEDIATE` SQL | raw `BEGIN IMMEDIATE` SQL | **CAS primitive** — the backlog consumer's sole concurrency mechanism. Prevents TOCTOU between read and write. |
| `exclusive` | `BEGIN EXCLUSIVE` | EXCLUSIVE at start | raw `BEGIN EXCLUSIVE` SQL | raw `BEGIN EXCLUSIVE` SQL | Full database lock — schema migrations |
| `concurrent` | `BEGIN CONCURRENT` | Optimistic (commit-time) | **throws** — not supported | raw `BEGIN CONCURRENT` SQL | MVCC — Turso-only, requires `PRAGMA journal_mode = 'mvcc'` |

**Default mode:**
- Both adapters default to `'deferred'` (matches SQLite's native `BEGIN` default).
- `TransactionOptions.mode` is optional but **portable code SHOULD set it explicitly**
  rather than relying on the default — the default is a safe baseline, not a guarantee
  of the optimal concurrency strategy for your workload.

**`BEGIN IMMEDIATE` implementation in TursoAdapter:**
```typescript
async transaction<T>(fn: (tx: AdapterTransaction) => T | Promise<T>, opts?: TransactionOptions): Promise<T> {
  const mode = opts?.mode ?? 'deferred';
  const beginSQL = mode === 'concurrent' ? 'BEGIN CONCURRENT'
    : mode === 'exclusive' ? 'BEGIN EXCLUSIVE'
    : mode === 'immediate' ? 'BEGIN IMMEDIATE'
    : 'BEGIN DEFERRED';

  await this.db.exec(beginSQL);
  const tx = new TursoTransaction(this.db);
  try {
    const result = await fn(tx);
    await this.db.exec('COMMIT');
    return result;
  } catch (err) {
    await this.db.exec('ROLLBACK');
    throw err;
  }
}
```

**`BEGIN IMMEDIATE` implementation in SqliteAdapter:**

Both adapters use the same raw-SQL pattern — `BEGIN` / `COMMIT` / `ROLLBACK` — rather than better-sqlite3's `db.transaction(fn)` wrapper. This keeps the transaction API consistent across backends and allows async callbacks (which the `AdapterTransaction` interface requires — its methods return `Promise`). The traditional better-sqlite3 `db.transaction(fn)` pattern is a sync-only design that cannot bridge to an async `AdapterTransaction`.

```typescript
async transaction<T>(fn: (tx: AdapterTransaction) => T | Promise<T>, opts?: TransactionOptions): Promise<T> {
  const mode = opts?.mode ?? 'deferred';
  if (mode === 'concurrent') throw new TypeError('SqliteAdapter does not support BEGIN CONCURRENT');

  const beginSQL = mode === 'immediate' ? 'BEGIN IMMEDIATE'
    : mode === 'exclusive' ? 'BEGIN EXCLUSIVE'
    : 'BEGIN DEFERRED';

  this.db.exec(beginSQL);
  const tx = new SqliteTransaction(this.db); // internal class wrapping sync db.prepare() calls as Promises
  try {
    const result = await fn(tx);
    this.db.exec('COMMIT');
    return result;
  } catch (err) {
    this.db.exec('ROLLBACK');
    throw err;
  }
}
```


**Migration for the backlog consumer's CAS pattern:**
```typescript
// BEFORE (backlog consumer — sync, better-sqlite3's db.transaction(fn).immediate() wrapper)
db.transaction(() => {
  const current = db.prepare('SELECT status FROM items WHERE id = ?').get(id);
  if (current.status !== 'pending') return;
  db.prepare('UPDATE items SET status = ? WHERE id = ?').run('claimed', id);
}).immediate()();  // ← BEGIN IMMEDIATE auto-wrapped

// AFTER (with StoreAdapter — async, both adapters use raw BEGIN/COMMIT/ROLLBACK)
await adapter.transaction(async tx => {
  const current = await tx.executeGet<{ status: string }>('SELECT status FROM items WHERE id = ?', [id]);
  if (current?.status !== 'pending') return;
  return tx.executeRun('UPDATE items SET status = ? WHERE id = ?', ['claimed', id]);
}, { mode: 'immediate' });  // ← explicit mode parameter
```

### Retry Migration: `Atomics.wait` → `setTimeout`

The backlog consumer uses `withImmediateRetry()` — a synchronous retry loop using `Atomics.wait` for microsecond-level sleep. The adapter is async (all methods return `Promise`), so `Atomics.wait` cannot suspend an async call chain.

**Migration path** — the `withRetry()` utility in `retry.ts`:

```typescript
// BEFORE (backlog consumer — sync)
function withImmediateRetry<T>(db: Database, fn: () => T, maxRetries = 5): T {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return db.transaction(fn).immediate()();
    } catch (err) {
      if (!isBusy(err) || i === maxRetries - 1) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.pow(2, i) * 10);
    }
  }
}

// AFTER (adapter-based — async)
async function withRetry<T>(
  adapter: StoreAdapter,
  fn: (tx: AdapterTransaction) => T | Promise<T>,
  opts?: TransactionOptions,
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 10;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await adapter.transaction(fn, opts);
    } catch (err) {
      if (!isConcurrentConflict(err) && !isBusyError(err)) throw err;
      if (i === maxRetries - 1) throw err;
      await new Promise(r => setTimeout(r, Math.pow(2, i) * baseDelayMs));
    }
  }
}
```

**Note:** Turso's `multiprocess_wal` serializes writers at the shared-memory level — it does NOT eliminate SQLITE_BUSY entirely. Contention still occurs when the single writer slot is occupied; the retry loop remains necessary but uses `setTimeout` instead of `Atomics.wait`. The `isConcurrentConflict()` helper catches both MVCC conflicts and BUSY errors.

### Drizzle Migration Path: Two-Phase

Multiple consumers use `drizzle-orm/better-sqlite3`. There is a **beta** adapter at `drizzle-orm/tursodatabase/database` (`drizzle-orm@rc`). The migration is two-phase:

#### Phase 1 — Retain drizzle-orm/better-sqlite3 via unwrap bridge

```typescript
// BEFORE (agent-mcp-authoring, agent-packages)
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';

const sqlite = new Database('registry.db');
const db = drizzle(sqlite, { schema });

// AFTER Phase 1 — unwrap bridge
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { createStoreAdapter } from '@adhd/sox-store-adapter';

const adapter = await createStoreAdapter({ type: 'sqlite', dbPath: 'registry.db' });
const sqlite = (adapter as import('@adhd/sox-store-adapter').SqliteAdapter).unwrap();
const db = drizzle(sqlite, { schema });
//              ^^^^^ better-sqlite3.Database — drizzle-orm/better-sqlite3 is happy
```

#### Phase 2 — Switch to drizzle-orm/tursodatabase/database

```typescript
// AFTER Phase 2 — Turso-native drizzle
import { drizzle } from 'drizzle-orm/tursodatabase/database'; // ← import path change (beta, drizzle-orm@rc)
import { createStoreAdapter } from '@adhd/sox-store-adapter';

const adapter = await createStoreAdapter({ type: 'turso', dbPath: 'registry.db' });
//                                        ^^^^^^^ now Turso
const client = (adapter as import('@adhd/sox-store-adapter').TursoAdapter).unwrap();
const db = drizzle({ client });  // ← object-shorthand construction
//              ^^^^^^^^^^ @tursodatabase/database.Database
```

**Key differences:**
| | Phase 1 (better-sqlite3) | Phase 2 (tursodatabase) |
|---|---|---|
| Import | `drizzle-orm/better-sqlite3` | `drizzle-orm/tursodatabase/database` |
| Construction | `drizzle(client)` | `drizzle({ client })` |
| Drizzle version | stable | `drizzle-orm@rc` (beta) |
| Adapter type | `type: 'sqlite'` | `type: 'turso'` |
| Drizzle query API | `.select()`, `.insert()`, `.where()` — **identical** | Same API — zero query code changes |

**Store class migration** for Drizzle consumers: if a store class currently takes `BetterSQLite3Database<any>` and uses drizzle's query builder, it has two options:

1. **Stay with drizzle** — change the constructor param to `StoreAdapter`, unwrap inside the constructor, construct drizzle from the unwrapped handle. The store's internal query code is untouched.
2. **Drop drizzle** — change all `.select()/.insert()/.where()` calls to raw `adapter.execute*()` SQL. More work but removes the drizzle dependency. Only needed if the package wants to be engine-agnostic (no drizzle at all).

For the neurodiverse agent packages (agent-mcp-authoring, agent-packages), option 1 is recommended — the drizzle query API is identical end-to-end, only the import path and construction pattern change.

### Shared Connections: `openRegistryDb()` Pattern

The v3 spec stated "Adapter instances are NOT designed to be shared across consumers." This is wrong for the real consumer topology. The agent packages share one registry DB through `openRegistryDb()` — 5 packages must access the same database file.

Each consumer opens its own adapter instance to the same file path. SQLite WAL mode supports multiple concurrent readers from separate connections — no singleton coordination is needed. The adapter owns its own connection lifecycle; each consumer is responsible for opening and closing its own adapter.

**Migration for `openRegistryDb()`:**
```typescript
// BEFORE (agent-core-env)
import Database from 'better-sqlite3';

export function openRegistryDb(): Database.Database {
  return new Database(path.join(home(), '.adhd', 'agent-registry', 'production', 'data', 'registry.db'));
}

// AFTER (agent-core-env)
import { createStoreAdapter } from '@adhd/sox-store-adapter';

export async function openRegistryDb(): Promise<StoreAdapter> {
  return createStoreAdapter({
    type: process.env.REGISTRY_STORE_ADAPTER as 'sqlite' | 'turso' ?? 'turso',
    dbPath: path.join(home(), '.adhd', 'agent-registry', 'production', 'data', 'registry.db'),
  });
}
```

**This means:**
- Every caller gets its own `StoreAdapter` instance for the same `dbPath`.
- Each consumer is responsible for its own lifecycle — call `close()` when done.
- WAL mode multi-reader is safe: multiple readers can use separate adapters concurrently (SQLite WAL supports this).
- This pattern works for both SqliteAdapter and TursoAdapter.

### Mixed Connection Ownership

Different consumers have different connection ownership patterns. The adapter supports both:

**Pattern A — DI (receive adapter via constructor):**
```typescript
// Graph-store, vector-store — receive StoreAdapter from caller
const graphStore = createGraphBackend(adapter);
const vectorStore = openVectorStore({ adapter });
```

**Pattern B — Factory fallback (create internally from path):**
```typescript
// Task-queue, blob-store — accept optional adapter, fall back to path
const queue = createTaskQueue({ adapter });         // uses provided adapter
const queue = createTaskQueue({ dbPath: 'tasks.db' }); // creates own internally
```

**Pattern C — Separate adapters to same file (multiple packages share a DB):**
```typescript
// Registry DB — each package opens its own adapter to the same file
const registry = await openRegistryDb();
// agent-core-policy, agent-core-provider, agent-store-prompts, etc.
// all call openRegistryDb() and get independent adapters to the same WAL-mode database
```

**Pattern D — Own connection (application-level direct DB):**
```typescript
// Agent-source's own better-sqlite3 calls
const adapter = await createStoreAdapter({ type: 'turso', dbPath: 'data/agents.db' });
const row = await adapter.executeGet<AgentRow>('SELECT * FROM agents WHERE id = ?', [id]);
```

### Multi-Process Writer Architecture

Unchanged from Round 5. Turso Database's `multiprocess_wal` via `.tshm` sidecar is the headline feature. The adapter exposes it via `capabilities.multiprocessWrite` and accepts `experimental: { multiprocessWal: true }` at construction:

```typescript
const adapter = await createTursoAdapter({
  dbPath: 'file:mydb.db',
  experimental: { multiprocessWal: true },
});

if (adapter.capabilities.multiprocessWrite) {
  // CLI, HTTP server, and MCP server can all write safely
}
```

**What multiprocess_wal solves (for real consumers):**
- Agent-source: CLI + HTTP server + MCP server all writing to `data/agents.db`
- Agent-mcp-authoring: multiple agent-mcp instances writing to the same operational DB
- Backlog: multiple agent processes writing to the same backlog graph

**What it does NOT solve:**
- Writers are serialized through a single writer slot — contention still occurs
- `multiprocess_wal` is experimental (pre-1.0)
- Not compatible with MVCC (`BEGIN CONCURRENT`)

### Vector Migration: sqlite-vec → Turso Native Vectors

The `VectorDialect` pattern abstracts vector SQL across backends. The migration path for existing `vec0` virtual tables:

**Current state (sqlite-vec):**
```sql
CREATE VIRTUAL TABLE vec_node USING vec0(
  node_id INTEGER PRIMARY KEY,
  embedding FLOAT[768]
);
SELECT rowid, distance FROM vec_node WHERE embedding MATCH vec_f32(?) AND k = ? ORDER BY distance;
```

**Target state (Turso native vectors, via VectorDialect):**
```typescript
// The dialect is created by vector-store based on adapter capabilities, not accessed from the adapter.
// vector-store checks adapter.capabilities.nativeVectors and selects the appropriate dialect:
const dialect = adapter.capabilities.nativeVectors
  ? new TursoVectorDialect()
  : new SqliteVecDialect();
const { sql, args } = dialect.topKQuery('vec_node', 'embedding', queryVec, 10, 'cosine');
const results = await adapter.executeAll<VecRow>(sql, args);
```

**Data migration** from `vec0` to native `vector(N)` columns requires re-indexing because the BLOB formats differ. The migration script lives in vector-store's migration utilities and is invoked once when switching from SqliteAdapter to TursoAdapter:

```typescript
// In vector-store's migration:
if (oldAdapter.capabilities.nativeVectors === false && newAdapter.capabilities.nativeVectors === true) {
  await migrateVec0ToNativeVectors(oldAdapter, newAdapter);
}
```

---

## Consumer Package Migration

### Per-Package Migration Map

| Current pattern | → New pattern | Package |
|---|---|---|
| `new Database(dbPath, { readonly: true })` | `createSqliteAdapter({ dbPath, readonly: true })` | memory-core openDbReadOnly |
| `db.prepare(sql).get(args)` | `adapter.executeGet<T>(sql, args)` | all |
| `db.prepare(sql).all(args)` | `adapter.executeAll<T>(sql, args)` | all |
| `db.prepare(sql).run(args)` | `adapter.executeRun(sql, args)` | all |
| `db.exec(sql)` | `adapter.exec(sql)` | all |
| `db.pragma('journal_mode = WAL')` | `adapter.pragmaSet('journal_mode', 'WAL')` | blob-store |
| `db.transaction(fn).immediate()()` | `adapter.transaction(fn, { mode: 'immediate' })` | backlog consumer |
| `db.transaction(fn)()` | `adapter.transaction(fn)` (default: deferred) | all |
| `withImmediateRetry(db, fn)` | `withRetry(adapter, fn)` — async, setTimeout backoff | backlog consumer |
| `sqliteVec.load(db)` | `(adapter as SqliteAdapter).unwrap()` → `sqliteVec.load()` | vector-store, memory-core |
| `vec0` SQL inline | `vectorDialect.topKQuery(...)` — dialect created by vector-store, not on the adapter | vector-store |
| `drizzle(client)` (better-sqlite3) | Phase 1: `drizzle((adapter as SqliteAdapter).unwrap())`. Phase 2: `drizzle({ client })` with `drizzle-orm/tursodatabase/database` | agent-mcp-authoring, agent-packages |
| `createGraphBackend(db)` | `createGraphBackend(adapter)` | memory-core |
| `openRegistryDb()` → `Database.Database` | `openRegistryDb()` → `Promise<StoreAdapter>` — each caller opens its own adapter | agent-packages |
| `new Database(dbPath)` (own connection) | `createStoreAdapter({ type: 'turso', dbPath })` | agent-source direct DB calls |

### Store Class Migration (Drizzle Consumers)

For store classes that take `BetterSQLite3Database<any>` and use drizzle's query builder internally:

```typescript
// BEFORE
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

class ProviderStore {
  constructor(private db: BetterSQLite3Database<any>) {}

  async getProvider(id: string) {
    return this.db.select().from(providers).where(eq(providers.id, id)).get();
  }
}

// AFTER — Phase 1: unwrap bridge, drizzle unchanged
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { StoreAdapter, SqliteAdapter } from '@adhd/sox-store-adapter';

class ProviderStore {
  private db: BetterSQLite3Database<any>;

  constructor(adapter: StoreAdapter) {
    const sqlite = (adapter as SqliteAdapter).unwrap();
    this.db = drizzle(sqlite);
  }

  // All query methods unchanged — still using drizzle query builder
  async getProvider(id: string) {
    return this.db.select().from(providers).where(eq(providers.id, id)).get();
  }
}

// AFTER — Phase 2: switch to tursodatabase drizzle
import { drizzle } from 'drizzle-orm/tursodatabase/database'; // ← import swap
import type { StoreAdapter, TursoAdapter } from '@adhd/sox-store-adapter';

class ProviderStore {
  private db: ReturnType<typeof drizzle>;

  constructor(adapter: StoreAdapter) {
    const client = (adapter as TursoAdapter).unwrap();
    this.db = drizzle({ client }); // ← object shorthand
  }

  // Query methods still unchanged — drizzle API is identical
}
```

---

## Independent Segments

### Segment A: store-adapter package — foundation

- **Files:** `libs/data/store/store-adapter/` (18 new files: types, turso-adapter, sqlite-adapter, vector-dialect, factory, retry, errors, mock-adapter, index, package.json, project.json, tsconfig.json, tsconfig.lib.json, README.md, 4 test files)
- **Dependencies:** none (standalone package)
- **Read tokens:** 0
- **Output tokens:** ~3800
- **Required context:** none — new package from scratch
- **Key constraint:** NO dependency on `@tursodatabase/database` in `package.json` — use dynamic `import()` in factory only. `better-sqlite3` IS a regular `dependency` (SqliteAdapter imports and wraps it; since it's already installed workspace-wide, adding it as a dependency simply links the existing installation — no new native compilation needed).

### Segment B: graph-store adapter injection + Drizzle removal

- **Files:** `libs/data/graph/graph-store/src/index.ts` (all query sites), `package.json`
- **Dependencies:** Segment A
- **Read tokens:** ~500
- **Output tokens:** ~600

### Segment C: vector-store adapter + dialect injection

- **Files:** `libs/data/vectors/vector-store/src/index.ts`, `package.json`
- **Dependencies:** Segment A
- **Read tokens:** ~400
- **Output tokens:** ~500
- **Parallel with:** Segment B, D, E

### Segment D: task-queue adapter injection

- **Files:** `libs/data/queue/task-queue/src/task-queue.ts`, `src/scheduler.ts`, `package.json`
- **Dependencies:** Segment A
- **Read tokens:** ~400
- **Output tokens:** ~400
- **Parallel with:** Segment B, C, E

### Segment E: blob-store adapter injection

- **Files:** `libs/data/store/blob-store/src/store.ts`, `package.json`
- **Dependencies:** Segment A
- **Read tokens:** ~300
- **Output tokens:** ~350
- **Parallel with:** Segment B, C, D

### Segment F: memory-core full migration

- **Files:** `libs/memory-core/src/db.ts`, 22 domain source files, 25 test files
- **Dependencies:** Segments A, B (memory-core imports `createGraphBackend` from graph-store)
- **Read tokens:** ~2200
- **Output tokens:** ~2800
- **Parallel with:** Segment C, D, E (memory-core does NOT import vector-store directly)

### Segment G: extensions + host-runtime wiring

- **Files:** `extensions/bundles/sox-memory-bundle/members/memory-server/src/main.ts`, memory-cli, memory-flush, `libs/host-runtime/src/loader.ts`
- **Dependencies:** B, C, D, E, F
- **Read tokens:** ~280
- **Output tokens:** ~280

### Segment H: baseline-capture dev tool migration

- **Files:** `tools/baseline-capture/src/capture-enrichment-baseline.ts`, `tools/baseline-capture/src/capture-enrichment-baseline.spec.ts`, `tools/baseline-capture/package.json`
- **Dependencies:** Segments A (store-adapter), F (memory-core's `openDb()` returns `StoreAdapter`, `runBatchEnrich` accepts `StoreAdapter`)
- **Read tokens:** ~350 (source + test)
- **Output tokens:** ~400
- **Type:** Private dev tool (`"private": true` in `package.json`, not published to npm). Migration is simpler than production packages — this tool consumes memory-core's already-adapted interface. No separate adapter factory needed.

**Migration scope:**

Only `capture-enrichment-baseline.ts` needs migration. `capture-write-perf-baseline.ts` already uses `openDb()` + `memoryWrite()` from `@adhd/sox-memory-core` — it imports zero direct `better-sqlite3` or `sqlite-vec` — and will work unchanged after Segment F.

**What changes in `capture-enrichment-baseline.ts`:**

| Before | After |
|--------|-------|
| `import Database from 'better-sqlite3'` | `import { createStoreAdapter } from '@adhd/sox-store-adapter'` |
| `import * as sqliteVec from 'sqlite-vec'` | (removed — adapter handles vec loading internally) |
| `runEnrichmentBaselinePass(db: InstanceType<typeof Database>, ...)` | `async runEnrichmentBaselinePass(adapter: StoreAdapter, ...): Promise<...>` |
| `db.prepare(sql).get()` → `{ cnt: number }` | `await adapter.executeGet<{ cnt: number }>(sql)` |
| `runBatchEnrich(db, opts)` | `await runBatchEnrich(adapter, opts)` (after Segment F, memory-core already accepts adapter) |
| `new Database(liveDbPath)` (WAL checkpoint) | `createStoreAdapter({ dbPath: liveDbPath })` → `await adapter.exec('PRAGMA wal_checkpoint(TRUNCATE)')` → `await adapter.close()` |
| `new Database(snapshotPath)` + `sqliteVec.load(db)` + pragmas | `openDb(snapshotPath)` from memory-core (returns `StoreAdapter` after Segment F, handles vec loading + pragmas + DDL internally) |
| `captureEnrichmentBaseline(opts): CaptureEnrichmentBaselineResult` (sync) | `async captureEnrichmentBaseline(opts): Promise<CaptureEnrichmentBaselineResult>` |
| `db.close()` (sync) | `await adapter.close()` |

**Env var configuration:**

The tool accepts `STORE_ADAPTER` to select between `'sqlite'` (default) and `'turso'` for the snapshot connection, consistent with the rest of the spec. The WAL-checkpoint connection on the live store always uses `createStoreAdapter` (no env override needed — it's a throwaway handle for a single pragma).

**Package.json changes:**
- Remove `"better-sqlite3"` from `dependencies` (comes transitively through memory-core → sqlite-adapter)
- Remove `"sqlite-vec"` from `dependencies` (vec loading is internal to memory-core's `openDb()` and the vector dialect)
- Add `"@adhd/sox-store-adapter": "workspace:*"` to `devDependencies` (needed for `createStoreAdapter` import for the WAL checkpoint throwaway connection)

### Dependency Graph

```
A (store-adapter) ──────────────────────────────┐
  ├── B (graph-store) ──┐                       │
  ├── C (vector-store) ─┤ (parallel)             │
  ├── D (task-queue) ───┤                       │
  └── E (blob-store) ───┘                       │
        └──┬──┘                                  │
           │                                     │
  F (memory-core) ← depends on B only of B/C/D/E │
           │                                     │
  G (extensions + host-runtime) ← depends on all │
           │                                     │
  H (baseline-capture dev tool) ← depends on A, F │
```

**Critical path:** A → B → F → G. C, D, E are parallel and cannot delay the critical path. H is a leaf dev tool — it depends on A+F but nothing depends on it. Can be executed any time after F is complete.

---

## Execution Strategies

### Segment A — store-adapter package

1. Scaffold `libs/data/store/store-adapter/` with `package.json` (name: `@adhd/sox-store-adapter`, no `@tursodatabase/database` dep), `project.json` (nx project config: `"sourceRoot": "libs/data/store/store-adapter/src"`, `"targets": { "build": ..., "test": ..., "lint": ..., "typecheck": ... }`, `"tags": ["type:lib", "area:data", "platform:node"]`), `tsconfig.json`, `tsconfig.lib.json`.
2. Create `src/types.ts` with `StoreAdapter`, `AdapterTransaction`, `TransactionMode`, `TransactionOptions`, `AdapterCapabilities`, `AdapterConfig`, `RunResult`, `AllResult`, `VectorDialect`, `VectorMetric`, `SqliteAdapter`, `TursoAdapter` types exactly as spec'd.
3. Create `src/vector-dialect.ts` with `TursoVectorDialect` and `SqliteVecDialect` classes.
4. Create `src/errors.ts` with duck-typed error helpers (`isUniqueConstraintError`, `isForeignKeyError`, `dbErrorCode`, `isDatabaseError`, `isConcurrentConflict`). Errors thrown by adapter methods are driver-native (`SqliteError` or the Turso equivalent); consumers MUST use these helpers for portable error handling — no `instanceof` checks against driver classes. There is no base `StoreAdapterError` wrapper class.
5. Create `src/retry.ts` with `withRetry()` and `retryOnConflict()` utilities.
6. Create `src/mock-adapter.ts` — in-memory implementation of `StoreAdapter` for unit tests. Stores data in a `Map<string, any[]>`. Implements all `StoreAdapter` methods including `transaction()` (with full mode support, including `mode: 'immediate'`). No `unwrap()` or vector dialect methods (testing code should use the adapter interface, not escape hatches). Exported as `class MockAdapter implements StoreAdapter`.
7. Create `src/sqlite-adapter.ts` — wraps `better-sqlite3` with Promise wrapping + LRU statement cache (configurable via `statementCacheSize` in constructor opts). `transaction()` uses raw `BEGIN`/`COMMIT`/`ROLLBACK` SQL (like TursoAdapter — no `db.transaction(fn)` wrapper, maintaining cross-adapter consistency). `SqliteTransaction` is an internal class that wraps sync `db.prepare()`/`.all()`/`.get()`/`.run()` + `db.exec()` calls as `Promise`-returning `AdapterTransaction` methods. Exposes `unwrap()` returning `better-sqlite3.Database`.
8. Create `src/turso-adapter.ts` — wraps `@tursodatabase/database` with dynamic import. `transaction()` uses raw `BEGIN IMMEDIATE`/`BEGIN CONCURRENT` SQL based on `opts.mode`. Default mode: `'deferred'`. Exposes `unwrap()` returning the Turso Database handle.
9. Create `src/factory.ts` — `createStoreAdapter()`, `createSqliteAdapter()` (overloaded — config or existing handle), `createTursoAdapter()`. No shared singleton — each consumer manages its own lifecycle.
10. Create `src/index.ts` — re-exports.
11. Create `test/contract.test.ts` — shared test suite run against all three adapters. Include `mode: 'immediate'` tests.
12. Create `test/turso-adapter.test.ts` + `test/sqlite-adapter.test.ts` + `test/mock-adapter.test.ts`.
13. Create `README.md` — **consumer-facing API reference** (the canonical public documentation). Covers types, factory functions, transaction modes, query methods, error handling, Drizzle migration guide, and 3rd-party integration examples. This document is the primary reference; the architecture spec (this file) is for implementers.
14. **Do NOT add `@tursodatabase/database` to `package.json` dependencies or devDependencies.**
15. Gate: `npx nx lint store-adapter && npx nx build store-adapter && npx nx test store-adapter`.

### Segments B–G

Same as Round 5 with one addition: **transaction call sites that currently use `.immediate()`** (graph-store's backlog SQL, memory-core's write paths) must add `{ mode: 'immediate' }` to `adapter.transaction(fn, { mode: 'immediate' })`.

### Segment H — baseline-capture dev tool migration

**Gate:** Segment A (store-adapter package built + passing) AND Segment F (memory-core's `openDb()` returns `StoreAdapter`, `runBatchEnrich` accepts `StoreAdapter`, both built + passing).

1. **Read** `tools/baseline-capture/src/capture-enrichment-baseline.ts` fully (245 lines). Also read `tools/baseline-capture/src/capture-enrichment-baseline.spec.ts` (the companion test).

2. **Update `package.json`:** Remove `"better-sqlite3"` and `"sqlite-vec"` from `dependencies`. Add `"@adhd/sox-store-adapter": "workspace:*"` to `devDependencies`. Run `pnpm install` after to relink.

3. **Rewrite `runEnrichmentBaselinePass`:** Change signature from `db: InstanceType<typeof Database>` to `adapter: StoreAdapter`. Make it `async`. Replace all three `db.prepare(sql).get() as { cnt: number }` calls with `await adapter.executeGet<{ cnt: number }>(sql)`. The `runBatchEnrich` call already accepts `StoreAdapter` after Segment F — keep the call, just pass `adapter` instead of `db`. NEVER modify the return type shape (`{ batchEnrichResult: BatchEnrichResult; counts: EnrichmentPassCounts }`).

4. **Rewrite `captureEnrichmentBaseline`:** Make it `async` and return `Promise<CaptureEnrichmentBaselineResult>`.
   - **WAL checkpoint step:** Replace the `new Database(liveDbPath)` + `exec` + `close` block with:
      ```typescript
      const tmpAdapter = await createStoreAdapter({ dbPath: liveDbPath });
      await tmpAdapter.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      await tmpAdapter.close();
      ```
      This is a throwaway connection — config is minimal. `createStoreAdapter` auto-detects 'sqlite' from the file path since there's no Turso URL.
   - **Snapshot open step (lines 201–206):** Replace `new Database(snapshotPath)` + `sqliteVec.load(db)` + three `PRAGMA` exec calls with `openDb(snapshotPath)` from `@adhd/sox-memory-core`. After Segment F, `openDb()` returns a `StoreAdapter` and handles vec loading, WAL journalling, busy timeout, and synchronous pragmas internally — the three explicit `db.exec(PRAGMA ...)` lines are now redundant.
   - **Enrichment pass (lines 208–222):** Replace the `try/finally` block's `db.close()` with `await adapter.close()`. The `runEnrichmentBaselinePass` call is already `await`-able since step 3 made it async. Logging (console.log calls) is unchanged.
   - NEVER modify: `copyFileSync`, `readFileSync` snapshot creation, `createHash('sha256')`, `buildEnrichmentBaseline`, or `writeFileSync` — these are pure file I/O and unchanged.

5. **Update imports:** Remove `import Database from 'better-sqlite3'` and `import * as sqliteVec from 'sqlite-vec'`. Add `import { createStoreAdapter } from '@adhd/sox-store-adapter'`. Keep `import { runBatchEnrich, type BatchEnrichOptions, type BatchEnrichResult } from '@adhd/sox-memory-core'` but add `openDb` to that import.

6. **CLI entry point:** `captureEnrichmentBaseline()` is now async — wrap in an async IIFE or add `.catch()` at the call site.

7. **Update the companion test** (`capture-enrichment-baseline.spec.ts`): After Segment A and F are done, the test should use `createStoreAdapter({ type: 'sqlite', dbPath: ':memory:' })` or `MockAdapter` instead of `new Database(':memory:')`. All `runEnrichmentBaselinePass` calls become `await`. `runBatchEnrich` is already stubbable/mockable — ensure the test passes with the adapter interface.

8. **Gate:** `npx nx lint baseline-capture && npx nx build baseline-capture && npx nx test baseline-capture`.

9. **DO NOT** touch `capture-write-perf-baseline.ts` — it has zero direct `better-sqlite3` or `sqlite-vec` imports and uses `openDb()` + `memoryWrite()` from memory-core which already work with `StoreAdapter` after Segment F.

10. **DO NOT** add `@tursodatabase/database` to baseline-capture's dependencies. The adapter selection is env-var-driven through `createStoreAdapter` and memory-core's `openDb`.

---

## Risk Assessment

| Risk | Severity | Detail | Mitigation |
|------|----------|--------|------------|
| `@tursodatabase/database` is beta (v0.7.1) | **HIGH** | Pre-1.0, on-disk format may change, API may break. | Adapter pattern is the mitigation. `STORE_ADAPTER=sqlite` swaps the entire engine. |
| `multiprocess_wal` is experimental | **HIGH** | `.tshm` format versioned, 64-bit Unix only, incompatible with MVCC. | `capabilities.multiprocessWrite` flag. Document experimental status. |
| `BEGIN IMMEDIATE` → `concurrent` semantic mismatch | **HIGH** | Lock-at-start vs optimistic commit-time are fundamentally different concurrency models. | Both adapters default to `'deferred'`. Consumers who need CAS behavior must explicitly pass `mode: 'immediate'`. `mode: 'concurrent'` is opt-in for MVCC workloads. |
| Drizzle beta adapter (`drizzle-orm@rc`) | **HIGH** | `drizzle-orm/tursodatabase/database` is beta — may break or change. | Phase 1 unwrap bridge keeps drizzle-orm/better-sqlite3 working. Phase 2 is deferred until drizzle-orm/tursodatabase/database stabilizes. |
| Async `openDb()` / `openRegistryDb()` breaks CJS module load | **CRITICAL** | All callers must `await`. No TLA needed — verified all callers are already async. | Document async contract. `getDb()` becomes async — all callers already `await` it. |
| SqliteAdapter sync constraint is runtime-only | **MEDIUM** | `transaction()` uses raw `BEGIN`/`COMMIT`/`ROLLBACK` (same pattern as TursoAdapter) — async callbacks ARE supported. However, the underlying better-sqlite3 calls still block the event loop (synchronous I/O; Promise wrapping is microtask-level, not thread-level). | Long-running transactions should use TursoAdapter (native async I/O, no event-loop blocking). SqliteAdapter is fine for the many short transactions common in the codebase. |
| Vector data migration (sqlite-vec → native) | **MEDIUM** | BLOB formats differ; must re-index all vectors. For memory-core's vec_node (~10K vectors), this is a one-time migration. | Migration script in vector-store. Run once when switching adapters. |
| `drizzle-orm/tursodatabase/database` no `unwrap()` pattern | **LOW** | The PG/MySQL drizzle adapters use `unwrap()` but the tursodatabase adapter doesn't — it directly uses `drizzle({ client })` construction. | Documented in migration guide. Misleading naming — "unwrap" means different things across drizzle adapters. |
| `lastInsertRowid` is `bigint` in Turso, `number` in better-sqlite3 | **LOW** | Union type forces consumers to handle both. Current callers discard `lastInsertRowid`. Requires ES2020+ target (`bigint` literal support). | Honest union type. Package tsconfig must set `"target": "ES2020"` or later. |
| Event-loop blocking (SqliteAdapter) | **MEDIUM** | SqliteAdapter wraps sync `better-sqlite3` calls in Promises but the underlying I/O still blocks the event loop per call. This is unchanged from the current codebase (it already uses sync better-sqlite3 everywhere). | TursoAdapter provides true async I/O (io_uring on Linux). For high-throughput servers, prefer TursoAdapter. For short queries, the microtask overhead is negligible. |

---

## Test Cases

### Adapter contract tests (`test/contract.test.ts`)

Run against SqliteAdapter (file:), TursoAdapter (file: mode), and MockAdapter:

- `executeGet<T>(sql, args)` → single row with typed result, null for no match
- `executeAll<T>(sql, args)` → multi-row with typed rows, empty array for no match
- `executeRun(sql, args)` → INSERT returns `rowsAffected=1, lastInsertRowid`
- `transaction(fn, { mode: 'immediate' })` → writes acquire RESERVED lock before first read. Two concurrent transactions on same adapter: second one waits, not interleaves.
- `transaction(fn, { mode: 'deferred' })` → default behavior, lock on first write
- `transaction(fn, { mode: 'concurrent' })` → TursoAdapter only; SqliteAdapter throws
- `transaction(fn, { mode: 'exclusive' })` → both adapters support
- `withRetry(adapter, fn)` → retries on conflict, succeeds within maxRetries, throws on exhaustion
- `pragmaSet(key, value)` + `pragmaGet(key)` → round-trip; boolean values round-trip as 1/0
- `executeMany(stmts[])` → sequential, first failure does not undo previous (non-atomic)
- `close()` → subsequent operations throw, `close()` idempotent
- `vectorDialect.topKQuery()` (standalone dialect) → returns results in distance order, both dialects return same ordering
- Error helpers with real constraint-violating SQL
- Statement cache (SqliteAdapter only): 500× same SQL → cache hit count ≥ 450

### Consumer-specific integration tests

- **graph-store + mock adapter**: insert nodes, query by edge, FTS triggers fire, transaction atomicity with `mode: 'immediate'`
- **vector-store + dialect routing**: Turso dialect generates correct native vector SQL, SqliteVec dialect generates correct vec0 SQL
- **task-queue + mock adapter**: enqueue, dequeue, scheduler tick with `mode: 'immediate'`
- **blob-store + mock adapter**: put, get, integrity check

### End-to-end smoke test

- `STORE_ADAPTER=turso` → memory-server starts, `memory_ping` returns `{ ok: true, store: { adapter: 'turso' } }`
- `STORE_ADAPTER=sqlite` → memory-server starts, sqlite-vec operations work
- Two extensions opening the same `dbPath` each get their own adapter instance, writes from one visible to the other via WAL

---

## Documentation Updates

1. **`docs/ideas/turso-database-adapter.md`** — this spec (replaces Round 5).
2. **`libs/data/store/store-adapter/README.md`** — consumer-facing API reference: types, factory functions, transaction modes, query methods, error handling, Drizzle migration guide.
3. **`libs/data/CLAUDE.md`** — StoreAdapter boundary rule: data packages MUST NOT import `better-sqlite3` directly.
4. **`CHANGELOG.md`** — breaking change: `createGraphBackend`, `createTaskQueue`, `createBlobStore`, `openVectorStore`, `openRegistryDb` signatures now accept `StoreAdapter`.
5. **`docs/routing/ROUTER.md`** — add `store-adapter` to data-layer routing table.
6. **External consumer migration guides** — one-page per external consumer (backlog, agent-source, agent-mcp-authoring, agent-packages) documenting the exact changes needed for their specific pattern.

---

## Optimized Execution Plan

> Replaces the "Independent Segments" and "Execution Strategies" sections above. This plan is organized for **maximum parallelization and minimum token consumption per task packet**. Each packet is independently dispatchable, specifies its file reservations, and carries a self-contained agent prompt.

### Key structural changes from the previous segment decomposition

| Before (package-ordered) | After (dependency-ordered + parallel) |
|---|---|
| A (store-adapter, sequential 18 files) | SA-* foundation: 6 sub-waves, max 5 packets parallel |
| B–E (data packages, imprecisely scoped) | Wave 1: 4 fully parallel packets with exact file lists |
| F (memory-core, monolithic 47+ files, ~5000 tok) | Wave 2: 6 parallel packets, each ≤400 instruction tok |
| G (extensions, post-F) | Wave 3a: extensions (depends on Wave 2) |
| H (baseline-capture) | Wave 3b: baseline-capture (parallel with 3a) |
| No review packets | Review packets after each wave, hidden in next wave's latency |
| — | Per-packet `reserved_files` guarantees no write conflicts |
| — | Concrete nx test gates per packet cluster |
| — | Sub-wave ordering within foundation (real internal deps) |

### Dependency graph (true — only type/import edges)

```
SA-TYPES ───► SA-SQLITE ──► SA-FACTORY ──► SA-INDEX
           ├► SA-TURSO ───┘
           ├► SA-RETRY
           ├► SA-DIALECT
           └► SA-MOCK
                │
     ┌──────────┼──────────┬──────────┐
     ▼          ▼          ▼          ▼
  B-GRAPH    C-VECTOR   D-QUEUE    E-BLOB
     │
     └──► F-CORE ──► F-MECH-1 ──► F-TESTS-*
         F-CORE ──► F-MECH-2 ──► F-TESTS-*
         F-CORE ──► F-META   ──► F-TESTS-*
                │
     ┌──────────┤
     ▼          ▼
  G-EXTS     H-BASELINE
     │          │
     └──► SMOKE ◄──┘
```

**Critical path:** SA-TYPES → SA-SQLITE → SA-FACTORY → SA-INDEX → B-GRAPH → F-CORE → any F-* → G-EXTS → SMOKE. C/D/E/H are off the critical path — fully parallel.

---

### Wave 0: Foundation — store-adapter package

The `@adhd/sox-store-adapter` package does not yet exist. It has internal dependency ordering (kernel → implementations → factory → barrel). Within each subwave, packets are fully parallel.

#### Subwave 0a: Package scaffolding

**Packet: SA-SCAFFOLD**
- **Prompt (~200 tok):** Scaffold the package at `libs/data/store/store-adapter/`. Create `package.json` (name `@adhd/sox-store-adapter`, no `@tursodatabase/database` dep, `better-sqlite3` in `dependencies`), `project.json` (nx project with tags `["type:lib", "area:data", "platform:node"]`, targets `build` via `atomic-tsc`, `test` via `vitest`, `lint`), `tsconfig.json` (extends root, `ES2022`, `NodeNext`), `tsconfig.lib.json` (declaration output). Create `src/` and `test/` directories.
- **Reserved files:**
  - `libs/data/store/store-adapter/package.json`
  - `libs/data/store/store-adapter/project.json`
  - `libs/data/store/store-adapter/tsconfig.json`
  - `libs/data/store/store-adapter/tsconfig.lib.json`
- **Input tokens:** ~200 (prompt only — no files exist yet)
- **Output tokens:** ~110
- **Gate:** `ls libs/data/store/store-adapter/package.json`

#### Subwave 0b: Type kernel

**Packet: SA-TYPES**
- **Prompt (~400 tok):** Create `src/types.ts` with full `StoreAdapter` interface, `AdapterTransaction`, `TransactionMode`, `TransactionOptions`, `AdapterConfig`, `AdapterCapabilities`, `RunResult`, `AllResult`, `VectorDialect`, `VectorMetric`, `SqliteAdapter` (with `unwrap(): better-sqlite3.Database`), `TursoAdapter` (with `unwrap()`). Create `src/errors.ts` with duck-typed error helpers: `isConcurrentConflict()`, `isBusyError()`, `isUniqueConstraintError()`, `isForeignKeyError()`, `dbErrorCode()`, `isDatabaseError()`. No wrapper error class.
- **Reserved files:**
  - `libs/data/store/store-adapter/src/types.ts`
  - `libs/data/store/store-adapter/src/errors.ts`
- **Input tokens:** ~400 (instruction) + 0 (files don't exist yet)
- **Output tokens:** ~570
- **Depends on:** SA-SCAFFOLD

#### Subwave 0c: Implementations (5 packets fully parallel — disjoint files, all depend only on SA-TYPES)

**Packet: SA-SQLITE**
- **Prompt (~350 tok):** Create `src/sqlite-adapter.ts` implementing `SqliteAdapter`. Uses raw `BEGIN`/`COMMIT`/`ROLLBACK` SQL for `transaction()` (not `db.transaction(fn)` wrapper). Internal `SqliteTransaction` class wraps sync better-sqlite3 calls as Promises. LRU statement cache (default: 100). `mode: 'concurrent'` throws `TypeError`. Exposes `unwrap(): better-sqlite3.Database`. Imports `RunResult`, `AllResult` etc. from `./types.js`.
- **Reserved files:** `libs/data/store/store-adapter/src/sqlite-adapter.ts`
- **Input tokens:** ~350 (instruction) + ~800 (reads types.ts, errors.ts)
- **Output tokens:** ~500
- **Depends on:** SA-TYPES

**Packet: SA-TURSO**
- **Prompt (~300 tok):** Create `src/turso-adapter.ts` implementing `TursoAdapter`. Dynamic `import('@tursodatabase/database')` only — never static import. `transaction()` maps `mode` to `BEGIN DEFERRED`/`BEGIN IMMEDIATE`/`BEGIN EXCLUSIVE`/`BEGIN CONCURRENT` SQL. Default: `'deferred'`. Exposes `unwrap()`. Capabilities: `multiprocessWrite: true` with `experimental.multiprocessWal`, `nativeVectors: true`, `concurrentTransactions: true`.
- **Reserved files:** `libs/data/store/store-adapter/src/turso-adapter.ts`
- **Input tokens:** ~300 (instruction) + ~800 (reads types.ts, errors.ts)
- **Output tokens:** ~500
- **Depends on:** SA-TYPES

**Packet: SA-DIALECT**
- **Prompt (~250 tok):** Create `src/vector-dialect.ts` with `TursoVectorDialect` and `SqliteVecDialect` implementing `VectorDialect`. Turso: `vector_distance_cos()`, `vector(N)` column DDL, `CREATE INDEX` with `cosine_distance`. SqliteVec: `vec0` virtual table DDL, `MATCH`/`k` queries. Both produce identical `topKQuery()` shapes. `initialize(db)` — no-op for Turso, `sqliteVec.load(db)` for SqliteVec.
- **Reserved files:** `libs/data/store/store-adapter/src/vector-dialect.ts`
- **Input tokens:** ~250 (instruction) + ~400 (reads types.ts)
- **Output tokens:** ~250
- **Depends on:** SA-TYPES

**Packet: SA-RETRY**
- **Prompt (~200 tok):** Create `src/retry.ts` — `withRetry(adapter, fn, opts?)` wraps `adapter.transaction()` with exponential backoff on `isConcurrentConflict`/`isBusyError`. `retryOnConflict(fn, opts?)` is a simpler non-transactional loop. Both use `setTimeout` (not `Atomics.wait`). Default: 3 retries, 10ms base delay, doubles each attempt.
- **Reserved files:** `libs/data/store/store-adapter/src/retry.ts`
- **Input tokens:** ~200 (instruction) + ~700 (reads types.ts, errors.ts)
- **Output tokens:** ~150
- **Depends on:** SA-TYPES

**Packet: SA-MOCK**
- **Prompt (~200 tok):** Create `src/mock-adapter.ts` — in-memory `Map<string, any[]>`-backed `StoreAdapter` for unit tests. `transaction()` supports all 4 modes including `'immediate'` for CAS testing. No `unwrap()`. Idempotent `close()`.
- **Reserved files:** `libs/data/store/store-adapter/src/mock-adapter.ts`
- **Input tokens:** ~200 (instruction) + ~400 (reads types.ts)
- **Output tokens:** ~150
- **Depends on:** SA-TYPES

#### Subwave 0d: Factory

**Packet: SA-FACTORY**
- **Prompt (~300 tok):** Create `src/factory.ts`. `createStoreAdapter(config?)` — env-driven (`STORE_ADAPTER` env var, defaults `'turso'`). `createSqliteAdapter(opts)` — overloaded: config object or existing `better-sqlite3.Database` handle. `createTursoAdapter(opts)` — async. No singleton — each call creates a new instance.
- **Reserved files:** `libs/data/store/store-adapter/src/factory.ts`
- **Input tokens:** ~300 (instruction) + ~1000 (reads types.ts, sqlite-adapter.ts, turso-adapter.ts)
- **Output tokens:** ~300
- **Depends on:** SA-SQLITE, SA-TURSO

#### Subwave 0e: Barrel + tests + README (4 packets fully parallel)

**Packet: SA-INDEX**
- **Prompt (~100 tok):** Create `src/index.ts` barrel — re-export all public types and functions.
- **Reserved files:** `libs/data/store/store-adapter/src/index.ts`
- **Input tokens:** ~100 (instruction) + ~500 (reads all src/*.ts)
- **Output tokens:** ~40
- **Depends on:** All subwave 0b–0d source files

**Packet: SA-TEST-CONTRACT**
- **Prompt (~400 tok):** Create `test/contract.test.ts`. Shared contract test suite exported as `function runContractTests(createAdapter: () => StoreAdapter | Promise<StoreAdapter>): void`. Tests for: executeGet/execteAll/executeRun round-trips; `transaction(fn, { mode: 'immediate' })` RESERVED-lock semantics; `mode: 'concurrent'` throws on SqliteAdapter; `withRetry` success/exhaustion; `pragmaSet`/`pragmaGet`; `executeMany` non-atomic; error helpers with real constraint-violating SQL.
- **Reserved files:** `libs/data/store/store-adapter/test/contract.test.ts`
- **Input tokens:** ~400 (instruction) + ~600 (reads types.ts, errors.ts, mock-adapter.ts)
- **Output tokens:** ~500
- **Depends on:** SA-MOCK, SA-TYPES, SA-ERRORS

**Packet: SA-TEST-IMPLS**
- **Prompt (~250 tok):** Create `test/turso-adapter.test.ts`, `test/sqlite-adapter.test.ts`, `test/mock-adapter.test.ts`. Each imports `runContractTests` from `./contract.test.js` and calls it with its adapter's factory. SqliteAdapter additionally tests statement cache (500× same SQL → cache hit ≥ 450). TursoAdapter tests `multiprocessWal` config passthrough. MockAdapter tests in-memory isolation.
- **Reserved files:**
  - `libs/data/store/store-adapter/test/turso-adapter.test.ts`
  - `libs/data/store/store-adapter/test/sqlite-adapter.test.ts`
  - `libs/data/store/store-adapter/test/mock-adapter.test.ts`
- **Input tokens:** ~250 (instruction) + ~500 (reads contract.test.ts)
- **Output tokens:** ~650
- **Depends on:** SA-TEST-CONTRACT

**Packet: SA-README**
- **Prompt (~200 tok):** Create `README.md` — consumer-facing API reference. Sections: Quick start, Factory functions, Transaction modes, Query methods, Error handling, Drizzle migration guide.
- **Reserved files:** `libs/data/store/store-adapter/README.md`
- **Input tokens:** ~200 (instruction) + ~500 (reads all src/*.ts)
- **Output tokens:** ~250
- **Depends on:** All subwave 0b–0d source files

#### Subwave 0f: Gate

**Packet: SA-BUILD**
- **Prompt (~100 tok):** Run `npx nx lint store-adapter && npx nx build store-adapter && npx nx test store-adapter`. Fix any compilation or test failures.
- **Reserved files:** (read-only — reads all store-adapter files)
- **Input tokens:** ~100 (instruction) + ~500 (reads build/test output)
- **Output tokens:** ~0 (just gate result)
- **Depends on:** All subwaves 0a–0e complete
- **Gate exit condition:** `npx nx lint store-adapter && npx nx build store-adapter && npx nx test store-adapter` all pass

---

### Wave 1: Consumer data package migrations (4 packets fully parallel)

All 4 packets read `StoreAdapter` types from store-adapter (built in Wave 0) and modify files in their own package only. No write conflicts. No imports between these packages.

**Packet: B-GRAPH**
- **Description:** Migrate `@adhd/sox-graph-store` from `better-sqlite3.Database` to `StoreAdapter`.
- **Changes:**
  - `src/index.ts` (~1500 lines): Replace `import Database from 'better-sqlite3'` with `import type { StoreAdapter } from '@adhd/sox-store-adapter'`. Change `createGraphBackend(db: Database.Database): GraphBackend` → `createGraphBackend(adapter: StoreAdapter): GraphBackend`. All `db.exec(sql)`, `db.prepare(sql).run()`, `.get()`, `.all()` become adapter methods. Drizzle setup uses `(adapter as SqliteAdapter).unwrap()` for Phase 1 bridge.
  - `src/rebuild-table.ts` (~128 lines): `rebuildTable(db: Database.Database, ...)` → `rebuildTable(adapter: StoreAdapter, ...)`. All internal calls updated.
- **Reserved files:**
  - `libs/data/graph/graph-store/src/index.ts`
  - `libs/data/graph/graph-store/src/rebuild-table.ts`
  - `libs/data/graph/graph-store/package.json`
- **Depends on:** SA-BUILD
- **Input tokens:** ~400 (instruction) + ~900 (reads 3 files)
- **Output tokens:** ~700
- **Gate:** `npx nx lint graph-store && npx nx build graph-store && npx nx test graph-store`

**Packet: C-VECTOR**
- **Description:** Migrate `@adhd/sox-vector-store` from `better-sqlite3.Database` + `sqlite-vec` to `StoreAdapter` + `VectorDialect`.
- **Changes:**
  - `src/index.ts` (~491 lines): Replace `import Database from 'better-sqlite3'` + `import * as sqliteVec from 'sqlite-vec'` with `import type { StoreAdapter, VectorDialect } from '@adhd/sox-store-adapter'`. Constructor/factory accepts `StoreAdapter`. Internally stores adapter + `VectorDialect` (selected via `adapter.capabilities.nativeVectors`). SQL generation goes through dialect. All `db.prepare()` → `adapter.execute*()`. LanceDB bridge path unchanged (no `better-sqlite3` there).
- **Reserved files:**
  - `libs/data/vectors/vector-store/src/index.ts`
  - `libs/data/vectors/vector-store/package.json`
- **Depends on:** SA-BUILD
- **Input tokens:** ~400 (instruction) + ~700 (reads index.ts + vector-store.spec.ts)
- **Output tokens:** ~500
- **Gate:** `npx nx lint vector-store && npx nx build vector-store && npx nx test vector-store`

**Packet: D-QUEUE**
- **Description:** Migrate `@adhd/sox-task-queue` from `better-sqlite3.Database` to `StoreAdapter`.
- **Changes:**
  - `src/task-queue.ts` (~677 lines): Constructor: `Database.Database` → `StoreAdapter`. All `db.prepare(sql).run/get/all` → `adapter.execute*()`. Method signatures change to return `Promise`.
  - `src/scheduler.ts`: Change parameter type. Propagate.
  - `src/schema.ts`: `applySchema(db: import('better-sqlite3').Database)` → `applySchema(adapter: StoreAdapter)`.
- **Reserved files:**
  - `libs/data/queue/task-queue/src/task-queue.ts`
  - `libs/data/queue/task-queue/src/scheduler.ts`
  - `libs/data/queue/task-queue/src/schema.ts`
  - `libs/data/queue/task-queue/package.json`
- **Depends on:** SA-BUILD
- **Input tokens:** ~400 (instruction) + ~800 (reads 4 files)
- **Output tokens:** ~500
- **Gate:** `npx nx lint task-queue && npx nx build task-queue && npx nx test task-queue`

**Packet: E-BLOB**
- **Description:** Migrate `@adhd/sox-blob-store` from `better-sqlite3.Database` (type-only) to `StoreAdapter`.
- **Changes:**
  - `src/store.ts` (~1241 lines): `import type Database from 'better-sqlite3'` → `import type { StoreAdapter } from '@adhd/sox-store-adapter'`. Constructor: `createBlobStore(opts)` accepts `StoreAdapter` (or creates from `dbPath` fallback). All `db.prepare()`/`db.exec()` → `adapter.execute*()`.
  - `src/schema.ts`: `applySchema(db: Database.Database)` → `applySchema(adapter: StoreAdapter)`.
- **Reserved files:**
  - `libs/data/store/blob-store/src/store.ts`
  - `libs/data/store/blob-store/src/schema.ts`
  - `libs/data/store/blob-store/package.json`
- **Depends on:** SA-BUILD
- **Input tokens:** ~350 (instruction) + ~500 (reads 3 files)
- **Output tokens:** ~350
- **Gate:** `npx nx lint blob-store && npx nx build blob-store && npx nx test blob-store`

**Status note on blob-store:** Per `libs/data/store/blob-store/AGENTS.md`, blob-store has zero live consumers (BL-166). Migration is still correct for interface consistency. If BL-166 resolves as "remove", this packet is wasted but harmless.

**Code review (hidden in Wave 2a latency):**

**Packet: REVIEW-WAVE0**
- **Scope (read-only):** All `libs/data/store/store-adapter/src/*.ts`, `test/*.ts`, `package.json`, `project.json`.
- **Validate:**
  1. `StoreAdapter` has ALL methods from spec: `executeGet`, `executeAll`, `executeRun`, `exec`, `pragmaSet`, `pragmaGet`, `transaction`, `executeMany`, `close`, `config`, `capabilities`
  2. `transaction()` supports all 4 modes, default `'deferred'`
  3. SqliteAdapter throws `TypeError` for `mode: 'concurrent'`
  4. TursoAdapter uses dynamic `import()` — no static import
  5. No `@tursodatabase/database` in `package.json` deps
  6. No wrapper error class in `errors.ts`
  7. MockAdapter supports all 4 modes including `'immediate'`
  8. All 4 test files call `runContractTests()`
- **Input tokens:** ~300 (instruction) + ~2500 (reads all store-adapter files)
- **Depends on:** SA-BUILD complete
- **Scheduled in:** Wave 2a (runs in parallel with F-CORE — hides its latency)

---

### Wave 2: memory-core migration (6 packets, depends on B-GRAPH)

`@adhd/sox-memory-core` has **71 .ts files** importing `better-sqlite3.Database` across 36 source files (~1470 LOC) and 35 test/spec files. Every file follows the same mechanical pattern:

1. `import Database from 'better-sqlite3'` → `import type { StoreAdapter } from '@adhd/sox-store-adapter'`
2. `import * as sqliteVec from 'sqlite-vec'` → (remove; vec loading is internal to adapter)
3. `function foo(db: Database.Database, ...)` → `function foo(adapter: StoreAdapter, ...)`
4. `db.prepare(sql).get(args)` → `await adapter.executeGet<RowType>(sql, args)`
5. `db.prepare(sql).all(args)` → `await adapter.executeAll<RowType>(sql, args)`
6. `db.prepare(sql).run(args)` → `await adapter.executeRun(sql, args)`
7. `db.exec(sql)` → `await adapter.exec(sql)`
8. `db.transaction(fn)` → `await adapter.transaction(fn)` (add `{ mode: 'immediate' }` where CAS semantics are needed)
9. Functions that were sync become `async` (return `Promise`)

These changes are purely mechanical — no file has cross-dependency on another file's migration (they all converge on `StoreAdapter` from store-adapter, which is already built). All 6 packets can execute in parallel once `db.ts` (F-CORE) defines the new `openDb(): Promise<StoreAdapter>` signature.

#### Wave 2a: Core connection layer (F-CORE executes first; then 2b starts)

**Packet: F-CORE**
- **Description:** Migrate the 5 files that define memory-core's database interface.
- **Changes:**
  - `db.ts` (~470 lines) — The critical file. Replace `import Database from 'better-sqlite3'` with `import { createSqliteAdapter } from '@adhd/sox-store-adapter'` and `import type { StoreAdapter }`. Change `openDb(dbPath): Database.Database` → `async openDb(dbPath): Promise<StoreAdapter>`. Replace `new Database(dbPath)` with `createSqliteAdapter({ dbPath })`. Remove `sqliteVec.load(db)` — adapter handles it. Change `stampStoreMeta`, `verifyStoreMeta`, `getDb`, `openDbReadOnly` to `StoreAdapter`. Keep `closeAllDbs` but use `adapter.close()`.
  - `schema.ts`: DDL strings are already imports from graph-store — validate no `Database` import.
  - `errors.ts`: Re-export from `@adhd/sox-store-adapter`'s error helpers.
  - `lease.ts`: `closeDbWithLease(db: Database.Database, ...)` → `closeDbWithLease(adapter: StoreAdapter, ...)`.
  - `backup.ts`: Replace `Database` + `sqliteVec` imports. `adapter.exec('VACUUM ...')`, `adapter.exec('PRAGMA wal_checkpoint(...)')`.
- **Reserved files:**
  - `libs/memory-core/src/db.ts`
  - `libs/memory-core/src/schema.ts`
  - `libs/memory-core/src/errors.ts`
  - `libs/memory-core/src/lease.ts`
  - `libs/memory-core/src/backup.ts`
- **Depends on:** B-GRAPH (memory-core imports `createGraphBackend`, `rebuildTable` from graph-store)
- **Input tokens:** ~500 (instruction) + ~1500 (reads 5 files)
- **Output tokens:** ~700
- **Gate (soft):** `npx nx lint memory-core` — source-level validation; full gate is after all Wave 2b packets.

#### Wave 2b: Domain files (5 packets fully parallel, all depend on F-CORE, disjoint file sets)

**Packet: F-MECH-1** (14 files — write/embed/enrich path)
- **Prompt (~300 tok):** Migrate these files per the standard mechanical pattern:
  - `write.ts`, `write-queue.ts`, `outbox-queue.ts`, `enrich.ts`, `enrich-batch.ts`, `enrich-version.ts`, `enrich-types.ts`, `embed-pipeline.ts`, `embed.ts`, `embed-test-provider.ts`, `neardup.ts`, `latency-stats.ts`, `reembed.ts`, `extractive.ts`
- **Reserved files:**
  - `libs/memory-core/src/write.ts`, `write-queue.ts`, `outbox-queue.ts`, `enrich.ts`, `enrich-batch.ts`, `enrich-version.ts`, `enrich-types.ts`, `embed-pipeline.ts`, `embed.ts`, `embed-test-provider.ts`, `neardup.ts`, `latency-stats.ts`, `reembed.ts`, `extractive.ts`
- **Depends on:** F-CORE
- **Input tokens:** ~300 (instruction) + ~3500 (reads 14 files)
- **Output tokens:** ~1200

**Packet: F-MECH-2** (20 files — read/query + mutation path)
- **Prompt (~300 tok):** Migrate these files per the standard mechanical pattern:
  - `recall.ts`, `related.ts`, `entity-episodes.ts`, `near-duplicates.ts`, `memory-filters.ts`, `list-entities.ts`, `topics.ts`, `projects.ts`, `stats.ts`, `quota.ts`, `cluster.ts`, `autolink.ts`, `compaction.ts`, `importance.ts`, `link.ts`, `curate.ts`, `update.ts`, `supersession-chain.ts`, `session.ts`, `extensions.ts`
- **Reserved files:**
  - `libs/memory-core/src/recall.ts`, `related.ts`, `entity-episodes.ts`, `near-duplicates.ts`, `memory-filters.ts`, `list-entities.ts`, `topics.ts`, `projects.ts`, `stats.ts`, `quota.ts`, `cluster.ts`, `autolink.ts`, `compaction.ts`, `importance.ts`, `link.ts`, `curate.ts`, `update.ts`, `supersession-chain.ts`, `session.ts`, `extensions.ts`
- **Depends on:** F-CORE
- **Input tokens:** ~300 (instruction) + ~3000 (reads 20 files)
- **Output tokens:** ~1000

**Packet: F-META** (4 files — barrel, export, meta)
- **Prompt (~200 tok):** Migrate these files per the standard pattern:
  - `index.ts` (~376 lines): Update all re-exports. `openDb()` now returns `Promise<StoreAdapter>`. Add `export type { StoreAdapter }`.
  - `provenance.ts`, `store-registry.ts`: Likely no `Database` type import — validate and update function signatures.
  - `export.ts`: `exportMarkdown(db: Database.Database, ...)` → `exportMarkdown(adapter: StoreAdapter, ...)`.
- **Reserved files:**
  - `libs/memory-core/src/index.ts`, `provenance.ts`, `store-registry.ts`, `export.ts`
- **Depends on:** F-CORE
- **Input tokens:** ~200 (instruction) + ~1000 (reads 4 files)
- **Output tokens:** ~400

**Packet: F-TESTS-SMALL** (22 files — core unit tests)
- **Prompt (~250 tok):** Migrate these test files. For each file: replace `import Database from 'better-sqlite3'` with `import { createSqliteAdapter }` (or `MockAdapter`). Replace `new Database(':memory:')` with `createSqliteAdapter({ dbPath: ':memory:' })`. Replace `import * as sqliteVec from 'sqlite-vec'` with dialect setup. All `db.prepare()` → `await adapter.execute*()`. Add `await` to all calls.
  - Files: `db.spec.ts`, `write.spec.ts`, `recall.spec.ts`, `enrich.spec.ts`, `embed.spec.ts`, `link.spec.ts`, `update.spec.ts`, `lease.spec.ts`, `stats.spec.ts`, `quota.spec.ts`, `topics.spec.ts`, `projects.spec.ts`, `list-entities.spec.ts`, `session.spec.ts`, `compaction.spec.ts`, `backup.spec.ts`, `export.spec.ts`, `errors.spec.ts`, `cluster-subset.spec.ts`, `invalidate.spec.ts`, `reembed.spec.ts`, `store-registry.spec.ts`
- **Reserved files:** All 22 spec files listed above
- **Depends on:** F-CORE
- **Input tokens:** ~250 (instruction) + ~3000 (reads 22 files)
- **Output tokens:** ~1200

**Packet: F-TESTS-ADVANCED** (19 files — integration, chaos, soak)
- **Prompt (~300 tok):** Migrate these test files per the same pattern.
  - **Integration:** `embed-pipeline-metrics.spec.ts`, `embed-provenance.spec.ts`, `extensions.spec.ts`, `ingest-parity.spec.ts`, `write-queue.spec.ts`, `write-queue-backpressure.spec.ts`, `write-pipeline.spec.ts`, `outbox-queue.spec.ts`, `near-duplicates.spec.ts`, `entity-episodes.spec.ts`, `related.spec.ts`, `concurrency-harness.spec.ts`
  - **Chaos:** `chaos/kill9-recovery.chaos.spec.ts`, `chaos/queue-overflow.chaos.spec.ts`, `chaos/disk-full.chaos.spec.ts`
  - **Soak:** `soak/soak-runner.ts`, `soak/metrics-exporter.ts`, `soak/soak.spec.ts`
  - Special: Chaos tests open real files + subprocesses — use `createSqliteAdapter({ dbPath })`, not MockAdapter. Soak imports `openDb()` — change to `await openDb()`.
- **Reserved files:** All 19 test/chaos/soak files listed above
- **Depends on:** F-CORE
- **Input tokens:** ~300 (instruction) + ~2500 (reads 19 files)
- **Output tokens:** ~800

#### Wave 2c: Gate

**Packet: F-BUILD**
- **Prompt (~100 tok):** Run `npx nx lint memory-core && npx nx build memory-core && npx nx test memory-core`. Fix failures.
- **Depends on:** All Wave 2a + 2b packets complete
- **Gate exit condition:** `lint+build+test` all pass

**Code review (hidden in Wave 3 latency):**

**Packet: REVIEW-WAVE1**
- **Scope (read-only):** B-GRAPH, C-VECTOR, D-QUEUE, E-BLOB changed files.
- **Validate:**
  1. All 4 packages import `StoreAdapter`, not `better-sqlite3.Database`
  2. `createGraphBackend` accepts `StoreAdapter`
  3. vector-store uses `VectorDialect` selected via `adapter.capabilities.nativeVectors`
  4. task-queue method signatures return `Promise` (async)
  5. All `package.json` have `@adhd/sox-store-adapter` dep (where needed)
  6. `npx nx test <pkg>` passes for all 4
- **Input tokens:** ~200 (instruction) + ~2500 (reads all changed files)
- **Depends on:** Wave 1 writes + tests complete
- **Scheduled in:** Wave 2b (alongside F-MECH-*/F-TESTS-* — hides latency)

---

### Wave 3: Integration — extensions + baseline-capture (2 packets parallel + code review + smoke)

All 4 Wave 3 items (G-EXTENSIONS, H-BASELINE, REVIEW-WAVE2, SMOKE) are independent and can run in parallel truth be told, but G and H must complete before SMOKE runs.

**Packet: G-EXTENSIONS**
- **Prompt (~300 tok):** Migrate extension sources that import `better-sqlite3` or receive `Database.Database` from memory-core.
  - `memory-server/src/index.ts`: `import Database from 'better-sqlite3'` → `import type { StoreAdapter }`. All `openDb()` calls become `await openDb()`. Backend class `private db` → `private adapter`.
  - `memory-server/src/backend.ts`: Update `closeAllDbs()` call.
  - `memory-flush/src/index.ts`: `Database` → `StoreAdapter`, `openDb()` → `await openDb()`.
  - `memory-cli/src/index.ts`: Validate — may only use `openDb()` through memory-core; if so, just add `await`.
  - All extension spec files (11 files): migrate tests per standard pattern.
- **Reserved files:**
  - `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts`
  - `extensions/bundles/sox-memory-bundle/members/memory-server/src/backend.ts`
  - `extensions/bundles/sox-memory-bundle/members/memory-flush/src/index.ts`
  - `extensions/bundles/sox-memory-bundle/members/memory-cli/src/index.ts` (if needed)
  - 11 extension spec files in memory-server/cli/flush
- **Depends on:** F-BUILD
- **Input tokens:** ~300 (instruction) + ~1500 (reads all extension files)
- **Output tokens:** ~400
- **Gate:** `npx nx lint memory-server memory-cli memory-flush && npx nx build memory-server memory-cli memory-flush`

**Packet: H-BASELINE**
- **Prompt (~400 tok):** Per the Architecture spec §"Segment H".
  - `capture-enrichment-baseline.ts`: Replace `Database` and `sqliteVec` imports with `createStoreAdapter`. `runEnrichmentBaselinePass(db, ...)` → `async runEnrichmentBaselinePass(adapter: StoreAdapter, ...)`. WAL checkpoint: `createStoreAdapter({ dbPath })` → `exec('PRAGMA wal_checkpoint(TRUNCATE)')` → `close()`. Snapshot: `await openDb(snapshotPath)` (now returns `StoreAdapter`).
  - `capture-enrichment-baseline.spec.ts`: Replace `new Database(':memory:')` with `createSqliteAdapter({ dbPath: ':memory:' })`. Add `await`.
  - `package.json`: Remove `better-sqlite3` and `sqlite-vec`. Add `@adhd/sox-store-adapter` to `devDependencies`.
  - Do NOT touch `capture-write-perf-baseline.ts`.
- **Reserved files:**
  - `tools/baseline-capture/src/capture-enrichment-baseline.ts`
  - `tools/baseline-capture/src/capture-enrichment-baseline.spec.ts`
  - `tools/baseline-capture/package.json`
- **Depends on:** F-BUILD, SA-BUILD
- **Input tokens:** ~400 (instruction) + ~550 (reads 3 files)
- **Output tokens:** ~400
- **Gate:** `npx nx lint baseline-capture && npx nx build baseline-capture && npx nx test baseline-capture`

**Packet: REVIEW-WAVE2**
- **Scope (read-only):** `libs/memory-core/src/` key files after migration.
- **Validate:**
  1. `openDb()` returns `Promise<StoreAdapter>`, not `Database.Database`
  2. Zero files import `better-sqlite3` or `sqlite-vec` directly (except sqlite-adapter.ts)
  3. Every `db: Database.Database` parameter → `adapter: StoreAdapter`
  4. Every `db.prepare(sql).get(args)` → `adapter.executeGet<T>(sql, args)` with `await`
  5. Functions that were sync are now `async` (return `Promise`)
  6. `index.ts` re-exports `StoreAdapter` type + updated signatures
  7. Test files use `MockAdapter` or `createSqliteAdapter`, not `new Database(':memory:')`
  8. `npx nx test memory-core` passes
- **Input tokens:** ~250 (instruction) + ~4000 (reads key files)
- **Depends on:** F-BUILD
- **Scheduled in:** Wave 3 (alongside G-EXTS and H-BASELINE — hides latency)

**Packet: REVIEW-SMOKE** (final exit gate)
- **Validate:**
  1. `npx nx run-many -t lint build test -p store-adapter graph-store vector-store task-queue blob-store memory-core memory-server memory-cli memory-flush baseline-capture` passes
  2. grep check: no dangling `better-sqlite3` import in memory-core source files
  3. grep check: no dangling `sqlite-vec` import in memory-core source files (test files may still use it — validate they go through VectorDialect)
  4. `npx nx run registry:sync-index` if extension dist checksums changed
  5. `rm -rf dist/smoke && node scripts/smoke-test.mjs` passes with 0 failures
- **Input tokens:** ~150 (instruction) + ~500 (reads test output, grep results)
- **Depends on:** G-EXTENSIONS, H-BASELINE, REVIEW-WAVE2 all complete
- **Gate exit condition:** Smoke test 0 failures

---

### Execution order (visual time sequence)

```
Time ──────────────────────────────────────────────────────────────────────────────►

Wave 0a: SA-SCAFFOLD (1 packet)
Wave 0b: SA-TYPES      (1)
Wave 0c: SA-SQLITE  SA-TURSO  SA-DIALECT  SA-RETRY  SA-MOCK     (5 parallel)
Wave 0d: SA-FACTORY                (1, depends on SA-SQLITE + SA-TURSO)
Wave 0e: SA-INDEX  SA-TEST-CONTRACT  SA-TEST-IMPLS  SA-README  (4 parallel)
Wave 0f: SA-BUILD gate
         │
         ├───────────────────────────────────────────────────────────────────┐
Wave 1:  │ B-GRAPH  C-VECTOR  D-QUEUE  E-BLOB  (4 parallel)                │
         │                                                                   │
         └──── REVIEW-WAVE0 (hidden in Wave 2a latency) ─────────────────────┘
         │
Wave 2a: F-CORE (1, must complete before 2b)
         │
         └──── REVIEW-WAVE1 (hidden in Wave 2b latency) ─────────────────────┐
         │                                                                    │
Wave 2b: F-MECH-1  F-MECH-2  F-META  F-TESTS-SMALL  F-TESTS-ADV  (5 para)   │
         │                                                                    │
Wave 2c: F-BUILD gate (all 2b done)                                           │
         │                                                                    │
Wave 3:  G-EXTENSIONS  H-BASELINE  (2 parallel)                              │
         │                                                                    │
         └──── REVIEW-WAVE2 (hidden in Wave 3 latency) ───────────────────────┘
         │
Final:   REVIEW-SMOKE + SMOKE gate
```

### Parallelism summary

| Dimension | Original segments | Optimized plan |
|-----------|-------------------|----------------|
| Sequential chain depth | A → B → F → G → H (5 hops) | SA-TYPES → SA-SQLITE → SA-FACTORY → SA-INDEX → B-GRAPH → F-CORE → G → SMOKE (8 hops, but shorter wall time due to wide parallel fan-out at each level) |
| Max parallel packets | 0 (all sequential) | 5 (Wave 0c), 4 (Wave 0e, 1), 5 (Wave 2b), 2 (Wave 3) |
| Total packets | 8 segments | ~27 packets |
| Max instruction tok per packet | ~3800 (Segment A combined) | ~500 (F-CORE) — most are 200–400 |
| Code review packets | 0 | 3 (+1 final smoke review) |
| Test gates per packet | 0 (one gate per segment) | 1 per subwave/wave cluster + per-packet validation |
| File collision risk | None (disjoint packages) | None guaranteed by `reserved_files` contracts |
| Token-optimized | No — Segment A alone was ~3800 output | Yes — each packet is 150–1200 output, median ~500 |
