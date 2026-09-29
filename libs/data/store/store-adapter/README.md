# @adhd/sox-store-adapter

Unified async database adapter — Turso Database (primary) and SQLite (backward-compatible) behind a single `StoreAdapter` interface.

```bash
pnpm add @adhd/sox-store-adapter
```

## Quick start

```typescript
import { createStoreAdapter } from '@adhd/sox-store-adapter';

// Auto-detect from env (STORE_ADAPTER=turso|sqlite, default: turso)
// TursoAdapter enables multiprocess_wal by default for concurrent readers/writers
const adapter = await createStoreAdapter({ dbPath: 'app.db' });

await adapter.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
await adapter.executeRun('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'Alice']);

const user = await adapter.executeGet<{ name: string }>(
  'SELECT name FROM users WHERE id = ?',
  [1],
);
console.log(user.name); // "Alice"

await adapter.close();
```

### Explicit adapter selection

```typescript
import { createSqliteAdapter, createTursoAdapter } from '@adhd/sox-store-adapter';

// SQLite (backward-compatible fallback, synchronous I/O, single-writer)
const sqlite = createSqliteAdapter({ dbPath: ':memory:' });

// Turso (default — async I/O, native vectors, multi-process writers via multiprocess_wal)
const turso = await createTursoAdapter({
  url: 'libsql://my-db.turso.io',
  authToken: process.env.TURSO_AUTH_TOKEN,
});
```

## Execution model

The Turso backend runs its native driver (`@tursodatabase/database`) on a **process-wide off-thread
driver worker** — the sidecar `turso-driver-worker.js` — never on the main thread. `TursoAdapter`
reaches it through a connection-shaped async RPC, so every `executeGet` / `executeRun` / `exec` /
`pragma*` call site is unchanged.

**Worker topology.** One `worker_threads.Worker` per process (per JS realm). The host holds it in a
`globalThis` slot keyed on `Symbol.for('@adhd/sox-store-adapter/turso-driver-host')`, so N copies of
this package in one process resolve to **one** worker — two worker threads driving one store is the
exact multi-open hazard this design removes. A separate realm (a forked child process, or a worker
thread) has its own `globalThis` and therefore its own host — correct, because it is a genuinely
separate isolate. The worker is spawned lazily on the first connection open and torn down when the
last connection closes. Requests cross a **versioned** protocol: a copy of this package speaking a
different protocol throws `E_TURSO_DRIVER_PROTOCOL_MISMATCH` rather than spawning a competing worker.

### What this does — and does not — fix

- **It bounds main-thread blocking, NOT operation latency.** A slow native step no longer freezes the
  whole process (an MCP server stays responsive to other work), but the operation itself still takes
  exactly as long. Moving work off the main thread does not make it faster.
- **One driver thread per process serializes all ops on that store.** Every request from every
  connection in the process is served FIFO from one port. A slow op delays the ops queued behind it;
  it does not run concurrently with them. (The worker dispatches requests fire-and-forget, so a slow
  call does not block *dequeuing* the next message — it blocks that next call's *native execution*.)
- **Same-process writers still pay the 5s busy timeout.** On the pinned `@tursodatabase/database`
  0.7.x the step loop never yields, so a writer's busy-wait runs synchronously inside one native step
  on the driver thread. When the lock holder is in the same process, the holder's own queued `COMMIT`
  waits out the full `DEFAULT_BUSY_TIMEOUT_MS` (5s). Moving the wait off the main thread removes it
  from the main thread but does not shorten it. Tracked as BL `809153d1`; upstream 0.8's `STEP_SLEEP`
  is the fix.
- **Reads queue behind a store's writes.** One connection per store serves both reads and writes, so a
  recall read queued behind a write's busy-wait waits too — even though WAL snapshot reads do not need
  the writer slot. A dedicated read connection per store is a separate, deferred connection-topology
  change (BL `56c72ccb`).

### `unwrap()` returns an async connection handle

On the Turso adapter `unwrap()` now returns a **`TursoDriverConnection`** — the off-thread proxy —
**not** the native `Database`. Its methods (`run` / `get` / `all` / `exec` / `pragma` / `close`) are
**async**; callers must `await` them. Handing it to a library that expects the synchronous native
`Database` will not work. `unwrap()` is itself still synchronous and still throws `[DEBT-003]` if
called before the first real operation has opened the connection — await a cheap op
(`executeGet('SELECT 1')`) first.

### Observing a stalled driver

`driverStatus` is a synchronous, worker-touching-free snapshot of the driver host: lifecycle state
(`not-started` / `idle` / `busy` / `stalled` / `exited`), in-flight count, the oldest pending op's
label and age, open connections, and the worker thread id. `'stalled'` is a **deadline verdict**
derived from the oldest op's age versus `driverStallAfterMs` (default
`DEFAULT_DRIVER_STALL_AFTER_MS`, 5s). Reading it never spawns or contacts the worker, so it is safe
from a watchdog or health probe. It **reports** a stalled driver; it does not cancel it — a native
call cannot be aborted, so cancellation is the consumer's policy (in `memory-server`, the
driver-stall watchdog's hard `forceExit`). `connectionHealth` is deliberately unchanged: that reports
this adapter's own connection lifecycle, not the process driver thread.

## API reference

### `StoreAdapter` interface

```typescript
interface StoreAdapter {
  // Query methods
  executeGet<T>(sql: string, args?: unknown[]): Promise<T | null>;
  executeAll<T>(sql: string, args?: unknown[]): Promise<AllResult<T>>;
  executeRun(sql: string, args?: unknown[]): Promise<RunResult>;

  // DDL / multi-statement
  exec(sql: string): Promise<void>;

  // PRAGMA shortcuts
  pragmaSet(key: string, value: string | number | boolean): Promise<void>;
  pragmaGet<T>(key: string): Promise<T>;

  // Transaction with mode support
  transaction<T>(fn: (tx: AdapterTransaction) => T | Promise<T>, opts?: TransactionOptions): Promise<T>;

  // Batch convenience (NON-ATOMIC)
  executeMany(stmts: { sql: string; args?: unknown[] }[]): Promise<RunResult[]>;

  // Lifecycle
  close(): Promise<void>;

  // Introspection
  readonly config: Readonly<AdapterConfig>;
  readonly capabilities: Readonly<AdapterCapabilities>;

  // Escape hatch
  unwrap(): unknown;
}
```

### Result types

```typescript
interface RunResult {
  rowsAffected: number;
  lastInsertRowid: number | bigint;
}

interface AllResult<T = Record<string, unknown>> {
  columns: string[];
  rows: T[];
}
```

### Transaction modes

| Mode | SQL | Lock acquired | SqliteAdapter | TursoAdapter |
|------|-----|--------------|---------------|-------------|
| `'deferred'` | `BEGIN DEFERRED` | On first write | ✓ (default) | ✓ (default) |
| `'immediate'` | `BEGIN IMMEDIATE` | RESERVED at start | ✓ | ✓ |
| `'exclusive'` | `BEGIN EXCLUSIVE` | EXCLUSIVE at start | ✓ | ✓ |
| `'concurrent'` | `BEGIN CONCURRENT` | Optimistic (commit-time) | **throws** | ✓ |

```typescript
await adapter.transaction(async (tx) => {
  const current = await tx.executeGet<{ status: string }>(
    'SELECT status FROM items WHERE id = ?', [id]
  );
  if (current.status !== 'pending') return;
  await tx.executeRun("UPDATE items SET status = 'claimed' WHERE id = ?", [id]);
}, { mode: 'immediate' }); // BEGIN IMMEDIATE — compare-and-swap primitive
```

### `AdapterTransaction` interface

Inside a transaction callback, the `tx` object provides the same query methods as the adapter — all returning Promises:

```typescript
interface AdapterTransaction {
  executeGet<T>(sql: string, args?: unknown[]): Promise<T | null>;
  executeAll<T>(sql: string, args?: unknown[]): Promise<AllResult<T>>;
  executeRun(sql: string, args?: unknown[]): Promise<RunResult>;
  exec(sql: string): Promise<void>;
}
```

### `executeMany` (non-atomic batch)

Runs statements sequentially. First failure does **not** roll back prior statements. For atomicity, use `transaction()`.

```typescript
const results = await adapter.executeMany([
  { sql: "INSERT INTO users (id, name) VALUES (1, 'Alice')" },
  { sql: "INSERT INTO users (id, name) VALUES (2, 'Bob')" },
]);
```

### Error helpers

All adapter methods throw driver-native errors (never a wrapper class). Use the portable helpers for duck-type checks:

```typescript
import { isUniqueConstraintError, isForeignKeyError, isBusyError, isDatabaseError } from '@adhd/sox-store-adapter';

try {
  await adapter.executeRun("INSERT INTO users (email) VALUES ('duplicate@test.com')");
} catch (err) {
  if (isUniqueConstraintError(err)) {
    // SQLITE_CONSTRAINT_UNIQUE
  }
  if (isDatabaseError(err)) {
    // Any recognized SQLITE_* error
  }
}
```

```typescript
function isUniqueConstraintError(err: unknown): boolean;
function isForeignKeyError(err: unknown): boolean;
function isBusyError(err: unknown): boolean;
function isConcurrentConflict(err: unknown): boolean;
function isDatabaseError(err: unknown): boolean;
function dbErrorCode(err: unknown): string | undefined;
```

### Retry utilities

```typescript
import { withRetry } from '@adhd/sox-store-adapter';

// Retry a busy operation up to 3 times with exponential backoff
const result = await withRetry(
  async () => adapter.executeRun("INSERT INTO tasks (status) VALUES ('pending')"),
  { maxRetries: 5, baseDelayMs: 10 },
);
```

### Capability flags

```typescript
interface AdapterCapabilities {
  multiprocessWrite: boolean;      // Multi-process writer support (Turso multiprocess_wal)
  nativeVectors: boolean;          // Built-in vector SQL functions
  concurrentTransactions: boolean; // BEGIN CONCURRENT (MVCC)
  /** @deprecated Use `fts` instead. */
  fts5: boolean;
  fts: boolean;                    // True when the adapter supports full-text search
  needsWriteSerialization: boolean; // True for single-sync-connection adapters that require
                                     // in-app write serialization (better-sqlite3). False for
                                     // async adapters with native concurrent I/O (Turso).
}
```

| Flag | SqliteAdapter | TursoAdapter |
|---|---|---|
| `multiprocessWrite` | `false` (inherent SQLite single-writer limitation) | `true` by default |
| `nativeVectors` | `false` | `true` |
| `concurrentTransactions` | `false` | `true` |
| `fts` | `true` (fts5 virtual table) | `true` (native Tantivy index) |
| `needsWriteSerialization` | `true` | `false` |

> **`multiprocessWrite` is `true` by default** on TursoAdapter — `multiprocess_wal` is enabled
> at connect time via the `.tshm` shared memory coordination layer, allowing concurrent readers
> and writers across multiple OS processes. Setting `experimental: { multiprocessWal: false }`
> opts out, reverting to Turso's default EXCLUSIVE file locking (single-writer).
>
> SqliteAdapter always reports `multiprocessWrite: false` (inherent SQLite single-writer limitation).
>
> **`concurrentTransactions: true` / `needsWriteSerialization: false` on TursoAdapter are the
> correct, measured defaults — not bugs and not something to "fix" by serializing writes.**
> Turso's shared connection handle has been load-tested at 50 concurrent transactions (both
> `deferred` and `immediate` modes) with zero lost writes, zero rejected commits, and isolation
> holding throughout. The only real failure mode is a loud thrown `Transaction error: cannot
> start a transaction within a transaction` when a transaction outlives the ~70ms retry budget
> (`maxRetries` × `baseDelayMs`) — fixed in-adapter via `_txMutexChain` (a promise-chain mutex
> serializing the retry-loop critical section per adapter instance), never by flipping
> `needsWriteSerialization` to `true` or disabling `concurrentTransactions`. See the doc comment
> on `TursoAdapterImpl` in `turso-adapter.ts` (BL-321).

### Full-text search per adapter

FTS implementation is adapter-specific and the two are **not** structurally alike:

- **SqliteAdapter** — classic `fts5` virtual table (`fts_node`) kept in sync with the base table
  via triggers.
- **TursoAdapter** — no `fts_node` shadow table and no sync triggers. FTS is a native Tantivy
  index, `CREATE INDEX idx_fts_node ON "node" USING fts (...)`, queried via `fts_match()` /
  `fts_score()`. This requires the `index_method` experimental flag on every connection that
  creates *or* queries the index (unconditionally enabled by this adapter — see `turso-adapter.ts`);
  without it, index creation throws a parse error that must not be silently swallowed.

### Configuration

```typescript
interface AdapterConfig {
  type: 'sqlite' | 'turso';
  dbPath?: string;
  url?: string;           // Turso remote URL
  authToken?: string;
  readonly?: boolean;
  encryption?: {
    cipher: 'aegis256' | 'aes256gcm';
    hexkey: string;
  };
  experimental?: {
    multiprocessWal?: boolean; // Default: true — set false to opt out of multiprocess_wal
  };
  defaultQueryTimeout?: number;
}
```

## Factory functions

### `createStoreAdapter(config?)`

Env-driven auto-detect. Reads `STORE_ADAPTER` env var (default: `'turso'`).

```typescript
import { createStoreAdapter } from '@adhd/sox-store-adapter';

const adapter = await createStoreAdapter({ dbPath: 'app.db' });
// returns StoreAdapter (base type — no unwrap() type narrowing)
```

### `createSqliteAdapter(opts)`

Explicit SqliteAdapter. Returns narrowed `SqliteAdapter` type with `unwrap()` returning `better-sqlite3.Database`.

```typescript
import { createSqliteAdapter } from '@adhd/sox-store-adapter';

// Option A: path config
const adapter = createSqliteAdapter({ dbPath: ':memory:' });
const db = adapter.unwrap(); // better-sqlite3.Database

// Option B: wrap an existing better-sqlite3 handle
import Database from 'better-sqlite3';
const db = new Database('app.db');
const adapter = createSqliteAdapter(db);
```

### `createTursoAdapter(opts)`

Explicit TursoAdapter. Returns narrowed `TursoAdapter` type.

```typescript
import { createTursoAdapter } from '@adhd/sox-store-adapter';

// Local file (multiprocess_wal enabled by default for concurrent readers/writers)
const local = await createTursoAdapter({ dbPath: 'app.db' });

// Remote Turso
const remote = await createTursoAdapter({
  url: 'libsql://my-db.turso.io',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Opt out of multiprocess_wal (single-writer fallback)
const single = await createTursoAdapter({
  dbPath: 'shared.db',
  experimental: { multiprocessWal: false },
});
```

### When to use which factory

| Scenario | Factory | Why |
|----------|---------|-----|
| Library code that needs to be adapter-agnostic | `createStoreAdapter()` | Env-driven selection |
| Code that hardcodes SQLite | `createSqliteAdapter()` | Narrowed type, `unwrap()` available |
| Code that hardcodes Turso | `createTursoAdapter()` | Narrowed type, `unwrap()` available |
| Wrapping an existing `better-sqlite3` handle | `createSqliteAdapter(db)` | Wrap external connection |
| Testing with MockAdapter | `new MockAdapter()` | In-memory test double |

## Consumer migration guide (better-sqlite3 → StoreAdapter)

### Mechanical 1:1 mapping

| `better-sqlite3` | `StoreAdapter` |
|---|---|
| `db.prepare(sql).get(args)` | `await adapter.executeGet<T>(sql, args)` |
| `db.prepare(sql).all(args)` | `await adapter.executeAll<T>(sql, args)` |
| `db.prepare(sql).run(args)` | `await adapter.executeRun(sql, args)` |
| `db.exec(sql)` | `await adapter.exec(sql)` |
| `db.pragma('key = value')` | `await adapter.pragmaSet('key', 'value')` |
| `db.pragma('key', { simple: true })` | `await adapter.pragmaGet<T>('key')` |
| `db.transaction(fn)()` | `await adapter.transaction(fn)` |
| `db.transaction(fn).immediate()()` | `await adapter.transaction(fn, { mode: 'immediate' })` |
| `db.close()` | `await adapter.close()` |
| `new Database(path)` | `createSqliteAdapter({ dbPath: path })` |
| `new Database(path, { readonly: true })` | `createSqliteAdapter({ dbPath: path, readonly: true })` |

### Transaction migration

```typescript
// BEFORE (better-sqlite3 — sync, immediate mode)
const result = db.transaction(() => {
  const current = db.prepare('SELECT status FROM items WHERE id = ?').get(id);
  if (current.status !== 'pending') return;
  db.prepare('UPDATE items SET status = ? WHERE id = ?').run('claimed', id);
}).immediate()();

// AFTER (StoreAdapter — async, explicit mode)
const result = await adapter.transaction(async (tx) => {
  const current = await tx.executeGet<{ status: string }>(
    'SELECT status FROM items WHERE id = ?', [id],
  );
  if (current?.status !== 'pending') return;
  await tx.executeRun("UPDATE items SET status = 'claimed' WHERE id = ?", ['claimed', id]);
}, { mode: 'immediate' });
```

### Drizzle migration

**Phase 1 — unwrap bridge (keep drizzle-orm/better-sqlite3):**

```typescript
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { createSqliteAdapter } from '@adhd/sox-store-adapter';
import type { SqliteAdapter } from '@adhd/sox-store-adapter';

const adapter = createSqliteAdapter({ dbPath: 'app.db' });
const sqlite = (adapter as SqliteAdapter).unwrap();
const db = drizzle(sqlite, { schema });
```

**Phase 2 — drizzle-orm/tursodatabase/database (beta):**

```typescript
import { drizzle } from 'drizzle-orm/tursodatabase/database';
import { createTursoAdapter } from '@adhd/sox-store-adapter';
import type { TursoAdapter } from '@adhd/sox-store-adapter';

const adapter = await createTursoAdapter({ dbPath: 'app.db' });
const client = (adapter as TursoAdapter).unwrap();
const db = drizzle({ client });
```

> **Note (off-thread driver, 862129b5):** `unwrap()` now yields a `TursoDriverConnection` — an
> async proxy — not the native `Database`. This bridge only works if the ORM accepts an
> async, connection-shaped client; otherwise use the adapter's own query methods (see the
> [Execution model](#execution-model) section).

## Testing guide

Use `MockAdapter` for unit tests — it's an in-memory `Map`-backed `StoreAdapter` implementation:

```typescript
import { MockAdapter } from '@adhd/sox-store-adapter';
import { describe, it, expect } from 'vitest';

it('my function uses the adapter', async () => {
  const adapter = new MockAdapter();
  await adapter.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
  await adapter.executeRun("INSERT INTO users (id, name) VALUES (1, 'Alice')");

  const result = await myFunction(adapter);
  expect(result).toBe('Alice');
});
```

### Contract tests

The package exports a reusable contract test suite. Import `runContractTests` to verify any `StoreAdapter` implementation:

```typescript
import { runContractTests } from '@adhd/sox-store-adapter/test/contract.test';

describe('my adapter', () => {
  runContractTests('MyAdapter', () => new MyAdapter());
});
```

## Configuration reference

| Env variable | Purpose | Default |
|---|---|---|
| `STORE_ADAPTER` | Adapter type: `'sqlite'` or `'turso'` | `'turso'` |
| `TURSO_DB_URL` | Turso remote URL (`libsql://...`) | — |
| `TURSO_AUTH_TOKEN` | Turso auth token | — |
| `SOX_CONFIG_DB_PATH` | Default dbPath fallback | — |

## Examples

### Typed queries

```typescript
interface User {
  id: number;
  name: string;
  email: string;
}

// Single row — null safe
const user = await adapter.executeGet<User>(
  'SELECT id, name, email FROM users WHERE id = ?',
  [1],
);
if (user) {
  console.log(user.name); // typed as string
}

// Multiple rows
const users = await adapter.executeAll<User>('SELECT id, name, email FROM users');
for (const u of users.rows) {
  console.log(u.name);
}

// Run with result
const result = await adapter.executeRun(
  'UPDATE users SET name = ? WHERE id = ?',
  ['Bob', 1],
);
console.log(`Updated ${result.rowsAffected} row(s)`);
```

### CAS with BEGIN IMMEDIATE

```typescript
async function claimTask(adapter: StoreAdapter, taskId: number): Promise<boolean> {
  return adapter.transaction(async (tx) => {
    const task = await tx.executeGet<{ status: string }>(
      'SELECT status FROM tasks WHERE id = ?',
      [taskId],
    );
    if (!task || task.status !== 'pending') return false;

    await tx.executeRun(
      "UPDATE tasks SET status = 'claimed', claimed_at = datetime('now') WHERE id = ?",
      [taskId],
    );
    return true;
  }, { mode: 'immediate' });
}
```

### Schema migration

```typescript
async function migrateV1(adapter: StoreAdapter): Promise<void> {
  return adapter.transaction(async (tx) => {
    await tx.exec(`
      CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT);
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    await tx.executeRun("INSERT OR REPLACE INTO migrations (version, applied_at) VALUES (1, datetime('now'))");
  }, { mode: 'exclusive' });
}
```
