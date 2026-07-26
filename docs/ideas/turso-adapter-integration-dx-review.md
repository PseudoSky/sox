# Turso Adapter Integration — DX & TypeScript Interface Review

**Reviewer:** Typescript agent  
**Spec:** `docs/ideas/turso-adapter-integration-v3.md`  
**Date:** 2026-07-25  
**Status:** Review complete — 12 findings, 7 recommendations

---

## 1. TypeScript Interface Review — Line-by-Line Critique

### 1.1 `RunResult` (lines 40–45)

```typescript
export interface RunResult {
  rowsAffected: number;
  lastInsertRowid: number | bigint;
}
```

**Verdict:** ✅ Correct. Matches better-sqlite3's `info.changes` and `info.lastInsertRowid`. The `number | bigint` union is honest — better-sqlite3 returns `number` (≤ 2^53), `@libsql/client` returns `bigint`. **However**, consumers currently cast `lastInsertRowid as number` in 3 places (outbox-queue.ts:66, reembed.spec.ts:131, embed-provenance.spec.ts:116). The migration will need to handle these casts; the spec doesn't mention this.

### 1.2 `GetResult` (lines 50–51)

```typescript
export type GetResult = Record<string, unknown> | null;
```

**Finding F1 (type erasure):** This is an **information-losing type**. The current codebase uses `db.prepare<Params, RowType>(sql).get(args)` with a generic `RowType` parameter that carries the actual column shapes:

- graph-store/index.ts:853 — `db.prepare<unknown[], { rowid: number }>(sql).get(...)` returning `{ rowid: number } | undefined`
- graph-store/index.ts:1089 — `db.prepare<unknown[], { cnt: number }>(sql).get(...)` returning `{ cnt: number } | undefined`
- graph-store/index.ts:131 — `db.prepare<[string], { name: string }>(sql).get(name)` returning `{ name: string } | undefined`
- task-queue/scheduler.ts:209 — `db!.prepare('SELECT * FROM scheduler_entries WHERE id = ?').get(id) as SchedulerEntryRow | undefined`
- task-queue/task-queue.ts:237 — `db.prepare(...).get(TaskStatus.Running) as { n: number }`

With `GetResult = Record<string, unknown>`, every call site loses its concrete row type and must cast. The TypeScript `as` keyword proliferates. This is one of the highest-DX-impact changes in the spec.

**Recommendation:** Make `StoreAdapter` generic over a row type, or make `executeGet` generic:

```typescript
executeGet<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string, args?: unknown[]
): Promise<T | null>;
```

Better yet, since the existing codebase already has explicit row types (nearly every call site passes typed arguments), preserve the generic:

```typescript
// Option A: Generic method
executeGet<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<T | null>;

// Option B: Accept a row-parsing callback
executeGet<R>(sql: string, args: unknown[], map: (row: Record<string, unknown>) => R): Promise<R | null>;
```

Option A is minimal and preserves the existing pattern. The tradeoff: without explicit type arguments, the inference defaults to `Record<string, unknown>` — same as the current spec. But consumers that already have `interface MyRow { id: number }` can write `adapter.executeGet<MyRow>(sql, args)` and get full type safety.

### 1.3 `AllResult` (lines 56–59)

```typescript
export interface AllResult {
  columns: string[];
  rows: Record<string, unknown>[];
}
```

Same type-erasure problem as `GetResult`. The existing code returns typed arrays directly:

- `db.prepare<[], DbNodeRow>(sql).all()` → `DbNodeRow[]` — typed columns
- `db.prepare<[number], SchedulerEntryRow>(sql).all(id)` → `SchedulerEntryRow[]`

**Recommendation:** Same generic treatment:
```typescript
executeAll<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<T[]>;
```

**Perf note:** The current `columns: string[]` property enables dynamic column introspection (useful for debugging, data export). If we drop `columns` in favor of `T[]`, we lose that. **Option:** keep the `columns` field on the return type but also type the rows:

```typescript
export interface AllResult<T = Record<string, unknown>> {
  columns: string[];
  rows: T[];
}
```

### 1.4 `AdapterTransaction` (lines 74–81)

```typescript
export interface AdapterTransaction {
  executeGet(sql: string, args?: unknown[]): Promise<GetResult>;
  executeAll(sql: string, args?: unknown[]): Promise<AllResult>;
  executeRun(sql: string, args?: unknown[]): Promise<RunResult>;
  executeValues(sql: string, args?: unknown[]): Promise<ValuesResult>;
  rollback(): Promise<void>;
}
```

**Finding F2 (no `exec` on transaction):** The `AdapterTransaction` interface has no `exec()` method, but existing transaction callbacks use `db.exec()` for DDL/index creation. For example, graph-store/index.ts `ensureCheckConstraints()` runs `this.db.exec(ddl)` inside a transaction callback. In the spec's own migration map, the transaction callback gets `tx`, but there's no `tx.exec()` — the consumer would need to hold a reference to the outer adapter.

**Recommendation:** Add `exec(sql: string): Promise<void>` to `AdapterTransaction`.

### 1.5 `StoreAdapter.transaction<T>(fn: (tx: AdapterTransaction) => T): Promise<T>` (line 141)

**Finding F3 (sync constraint not expressible in TypeScript):** The spec says SqliteAdapter's callback MUST be synchronous, TursoAdapter's CAN be async. But the type signature `(tx: AdapterTransaction) => T` accepts both `T` and `Promise<T>` uniformly — TypeScript cannot distinguish "not a Promise" at the type level without a `NoInfer` or branded-type trick.

At runtime, SqliteAdapter checks for a `.then` property and throws `TypeError`. This means a call like:

```typescript
await adapter.transaction(async (tx) => {
  // This works with TursoAdapter but THROWS with SqliteAdapter
  await tx.executeRun('UPDATE ...');
});
```

...compiles cleanly and fails at runtime. The consumer has to **know which adapter** they're using and mentally switch coding style — a major footgun.

**Recommendation (two options):**

1. **Split interfaces:** `SyncStoreAdapter.transaction<T>(fn: (tx: SyncTransaction) => T): T` (no Promise wrapper, sync callback required) vs `AsyncStoreAdapter.transaction<T>(fn: (tx: AdapterTransaction) => T | Promise<T>): Promise<T>` (supports both). Consumers pick the right one at compile time. The base `StoreAdapter` could be one or the other, with a type guard to narrow.

2. **Document as runtime contract** (current approach) but add a lint rule or ESLint plugin that flags async callbacks inside `transaction()`. This is weaker but easier.

Given the existing codebase has 17 sync-only transaction callbacks (verified), option 1 is cleaner. But it's a bigger interface split. For pragmatic purposes, keep the current approach but **add a JSDoc `@throws` tag** and consider a branded type for the callback return.

### 1.6 `unwrap(): unknown` (line 179)

```typescript
unwrap(): unknown;
```

**Finding F4 (type narrowing burden):** The spec says consumers should check `adapter.config.type` before calling driver-specific APIs, giving this example:

```typescript
if (adapter.config.type === 'sqlite') { sqliteVec.load(adapter.unwrap()); }
```

But `adapter.config.type` doesn't narrow the `unwrap()` return type. Even after checking `type === 'sqlite'`, the compiler still types `unwrap()` as `unknown`. The consumer must write `adapter.unwrap() as any` — the spec's own migration table shows exactly this: `sqliteVec.load(adapter.unwrap() as any)`.

**Recommendation:** Use a discriminated union or branded return type:

```typescript
interface SqliteAdapter extends StoreAdapter {
  readonly config: Readonly<AdapterConfig & { type: 'sqlite' }>;
  unwrap(): Database.Database;
}

interface TursoAdapter extends StoreAdapter {
  readonly config: Readonly<AdapterConfig & { type: 'turso' }>;
  unwrap(): Client;
}
```

Then consumer code type-narrows naturally:
```typescript
if (adapter.config.type === 'sqlite') {
  sqliteVec.load(adapter.unwrap()); // TypeScript knows unwrap() returns Database.Database
}
```

### 1.7 `Readonly<AdapterConfig>` (line 183)

```typescript
readonly config: Readonly<AdapterConfig>;
```

**Verdict:** ✅ Correct. `Readonly<AdapterConfig>` prevents consumers from mutating config after construction. No issues.

**Edge case:** `AdapterConfig` has `type: 'sqlite' | 'turso'` as a union. If a consumer creates a partial config and passes it through the factory, the `type` field might be auto-detected from env vars. But the return type is `Readonly<AdapterConfig>` — consumers who want to check `adapter.config.type` will get proper narrowing only if they also check whether the concrete type is `SqliteAdapter`. See F4 above.

### 1.8 `ValuesResult` (lines 65–68)

```typescript
export interface ValuesResult {
  columns: string[];
  rows: unknown[][];
}
```

**Finding F5 (zero call sites, zero spec justification):** The spec claims this is needed for `db.prepare(sql).raw().all(...args)` patterns in "reembed/iter patterns."

**Multi-source verification (not just `libs/`):**
- All `.ts` source files in the repo: **zero** `.prepare().raw()`, `.raw().all()`, `.raw().get()`, or `.pluck()` calls
- All compiled `dist/` `.js` outputs: **zero** matches
- All published npm tarballs (`@adhd/sox-memory-core`, `@adhd/sox-graph-store`, `@adhd/sox-task-queue`, `@adhd/sox-vector-store`, `@adhd/sox-blob-store`, `@adhd/sox-hybrid-search`, `@adhd/sox-analysis`): **zero** matches
- `CHANGELOG.md`: **zero** mentions of `.raw()` or `.pluck()` as a shipped pattern
- All `docs/plan/*` files: **zero** references to this pattern
- Git history (deleted files): **zero** instances of removed `.raw()` usage
- **External consumer `agent-source`** (BL-166 verified, `/Users/nix/dev/ai/agent-source/`, which imports `@adhd/sox-vector-store`, `@adhd/sox-blob-store`, `@adhd/sox-task-queue`, `@adhd/sox-graph-store`, `@adhd/sox-hybrid-search`, and others as `file:` deps): **zero** `.prepare().raw()` or `.pluck()` calls — all use standard `.get()`/`.run()`/`.all()`

The vector-store `iter()` method uses `this.db.prepare(...).all()` which returns typed rows (`{ node_id: number; embedding: Buffer }[]`), not `unknown[][]`. The `executeValues` method adds API surface and testing burden with no existing consumer — in-source, compiled, published, or planned.

The vector-store `iter()` method uses `this.db.prepare(...).all()` which returns typed rows (`{ node_id: number; embedding: Buffer }[]`), not `unknown[][]`. The `executeValues` method adds API surface and testing burden with no existing consumer.

**Recommendation:** Remove `executeValues` and `ValuesResult` from the initial interface. If a future consumer genuinely needs raw value arrays, add it then. YAGNI.

---

## 2. Consumer Code Walkthrough

### 2.1 Basic 3rd-party usage (from spec)

```typescript
import { createSqliteAdapter, createTursoAdapter } from '@adhd/sox-store-adapter';
import { createGraphBackend } from '@adhd/sox-graph-store';
import { createTaskQueue } from '@adhd/sox-task-queue';

const userDb = createSqliteAdapter({ dbPath: './users.db' });
const queueDb = createSqliteAdapter({ dbPath: './queue.sqlite' });

const graph = createGraphBackend(userDb);
const queue = createTaskQueue({ adapter: queueDb });
```

**Compile-check notes:**

1. **`createSqliteAdapter` return type:** The spec says it returns `SqliteAdapter` (concrete). Does this match `StoreAdapter` structurally? Depends on whether `SqliteAdapter` declares all the same methods. If `StoreAdapter` has `unwrap(): unknown` and `SqliteAdapter` has `unwrap(): Database.Database`, TypeScript's structural typing says yes. ✅

2. **`createGraphBackend` signature:** The spec says `createGraphBackend(adapter: StoreAdapter)`. Currently: `createGraphBackend(db: Database.Database)`. This is a breaking change. Consumer must update all call sites. ⚠️

3. **`createTaskQueue` config:** Currently accepts `TaskQueueConfig` with `dbPath: string`. Spec adds `adapter?: StoreAdapter` optionally. Backward-compatible. ✅

### 2.2 Transaction with type confusion

```typescript
import { createSqliteAdapter } from '@adhd/sox-store-adapter';

const db = createSqliteAdapter({ dbPath: './app.db' });

// THIS COMPILES BUT THROWS at runtime with SqliteAdapter:
await db.transaction(async (tx) => {
  await tx.executeRun('UPDATE accounts SET balance = balance - 100 WHERE id = ?', [1]);
  await tx.executeRun('UPDATE accounts SET balance = balance + 100 WHERE id = ?', [2]);
});
```

**Footgun:** The `async` callback returns `Promise<void>`. The SqliteAdapter detects the `.then` and throws `TypeError`. The consumer gets a **runtime crash**, not a compile error. The only signal is the JSDoc "MUST be synchronous."

### 2.3 Custom adapter implementation

```typescript
import { StoreAdapter, AdapterTransaction, RunResult, AllResult, GetResult } from '@adhd/sox-store-adapter';

class PostgresAdapter implements StoreAdapter {
  // Must implement ALL of:
  executeGet(sql: string, args?: unknown[]): Promise<GetResult>;
  executeAll(sql: string, args?: unknown[]): Promise<AllResult>;
  executeRun(sql: string, args?: unknown[]): Promise<RunResult>;
  executeValues(sql: string, args?: unknown[]): Promise<ValuesResult>;
  exec(sql: string): Promise<void>;
  pragmaSet(key: string, value: string | number | boolean): Promise<void>;
  pragmaGet(key: string): Promise<string | number | undefined>;
  transaction<T>(fn: (tx: AdapterTransaction) => T): Promise<T>;
  batch(stmts: { sql: string; args?: unknown[] }[]): Promise<RunResult[]>;
  close(): Promise<void>;
  unwrap(): unknown;
  readonly config: Readonly<AdapterConfig>;
}
```

**Verdict:** 12 methods to implement for a custom adapter. For an in-memory mock (testing), this is reasonable. For a Postgres adapter, `pragmaSet`/`pragmaGet` don't have equivalents — the consumer would stub them as no-ops, which is misleading. The interface is **not minimal** for third-party adapter authors.

---

## 3. Migration Spot-Check

### 3.1 Graph-store: `RETURNING rowid` (index.ts:844–878)

**Current (typed):**
```typescript
const result = this.db
  .prepare<unknown[], { rowid: number }>(
    `INSERT INTO node (...) VALUES (...)
     RETURNING rowid`,
  )
  .get(...args);
if (!result) throw new Error('Insert failed: no rowid returned');
return result.rowid;
```

**After migration (with spec's types):**
```typescript
const result = await this.adapter.executeGet(
  `INSERT INTO node (...) VALUES (...)
   RETURNING rowid`,
  [...args],
);
if (!result) throw new Error('Insert failed: no rowid returned');
return result.rowid;
```

**Problem:** `result.rowid` is typed as `unknown` (because `GetResult = Record<string, unknown> | null`). The consumer must cast:
```typescript
return (result as { rowid: number }).rowid;
// or
return Number(result.rowid as string);
```

**With generic fix (see F1):**
```typescript
const result = await this.adapter.executeGet<{ rowid: number }>(
  `INSERT INTO node (...) VALUES (...) RETURNING rowid`,
  [...args],
);
// result.rowid is number — no cast needed
```

**Intrusiveness:** 1:1 mapping on line count, but introduces type assertions at every `RETURNING` call site (~2 in current codebase). With generics, zero type assertions.

### 3.2 Graph-store: `transaction()` in `ensureCheckConstraints` (index.ts:777–801)

**Current:**
```typescript
this.db.transaction(() => {
  if (nodeNeedsRebuild) {
    rebuildTable(this.db, 'node', NODE_TABLE_DDL, NODE_COLUMNS, { skipDrop: true });
  }
  if (edgeNeedsRebuild) {
    rebuildTable(this.db, 'edge', EDGE_TABLE_DDL, EDGE_COLUMNS, { skipDrop: true });
  }
  if (nodeNeedsRebuild) this.db.exec(`DROP TABLE node_old`);
  if (edgeNeedsRebuild) this.db.exec(`DROP TABLE edge_old`);
  // ...
})();
```

**After migration:**
```typescript
await this.adapter.transaction(tx => {
  if (nodeNeedsRebuild) {
    rebuildTable(this.adapter, 'node', NODE_TABLE_DDL, NODE_COLUMNS, { skipDrop: true });
  }
  if (edgeNeedsRebuild) {
    rebuildTable(this.adapter, 'edge', EDGE_TABLE_DDL, EDGE_COLUMNS, { skipDrop: true });
  }
  if (nodeNeedsRebuild) this.adapter.exec(`DROP TABLE node_old`);
    // ^^^ BUT: AdapterTransaction has no exec() method!
  // ...
});
```

**Finding F6:** The `AdapterTransaction` has no `exec()` method, but `ensureCheckConstraints` calls `this.db.exec()` inside the transaction. The consumer must either:
- Use the outer `this.adapter.exec()` (but `this` inside the callback refers to the class, not the transaction — and more critically, the SqliteAdapter wraps `db.transaction()` which uses one connection; calling `adapter.exec()` from inside would execute inside the same connection & transaction implicitly. But it's confusing.)
- Pass the transaction handle to `rebuildTable()` which currently takes `Database.Database`.

### 3.3 Memory-core `openDb()` (db.ts:192–332)

**Current (sync):**
```typescript
export function openDb(dbPath: string): Database.Database {
  dbPath = expandDbPath(dbPath);
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  sqliteVec.load(db);
  for (const pragma of PRAGMAS.trim().split('\n').filter(Boolean)) {
    const line = pragma.trim();
    if (line) db.exec(line);
  }
  // ...
  return db;
}
```

**Verdict:** The migration from sync to async is the most impactful change in the whole spec. Every call site that calls `openDb()` or `getDb()` must add `await`. The spec claims "no call site calls `openDb()` at module scope without `await`" — but `getDb()` is used in module-level initializers in `memory-server`, `memory-cli`, and `memory-flush`. The spec acknowledges this in segment G.

**Mechanical diff:** Truly mechanical (1:1 mapping) for all query methods. The sync→async change for `openDb()` is also mechanical but touches every file that constructs a database. Verified: all existing transaction callbacks are sync (confirmed by grep: 20 matches, all return synchronously). The graph-store `this.db.transaction(() => { ... })()` pattern becomes `await this.adapter.transaction(tx => { ... })` — purely mechanical.

---

## 4. Findings — Complete List

### F1 (HIGH) — Type erasure on `executeGet`/`executeAll`

`GetResult = Record<string, unknown> | null` and `AllResult.rows = Record<string, unknown>[]` lose all column typing. Every existing call site uses typed generics (`db.prepare<Params, RowType>`) and would need casts. ~70 call sites across the codebase affected.

**Fix:** Add generic type parameter defaulting to `Record<string, unknown>`.

### F2 (MEDIUM) — `AdapterTransaction` missing `exec()`

Transaction callbacks in existing code (especially graph-store's `ensureCheckConstraints`) call `db.exec()` inside transactions. `AdapterTransaction` has `executeGet/All/Run/Values` but no `exec`. Forces consumers to awkwardly reference the outer adapter or use `executeRun` for DDL.

**Fix:** Add `exec(sql: string): Promise<void>` to `AdapterTransaction`.

### F3 (HIGH) — Sync constraint unenforceable at type level

`StoreAdapter.transaction<T>(fn: (tx: AdapterTransaction) => T): Promise<T>` accepts both sync and async callbacks. The SqliteAdapter throws `TypeError` at runtime if the callback is async. This is a runtime-only failure mode with no compile-time warning. The TursoAdapter supports both — creating driver-dependent behavior behind the same interface.

**Fix:** Type-level discrimination or branded callback type. See recommendations.

### F4 (MEDIUM) — `unwrap(): unknown` doesn't narrow with `config.type`

Even after `if (adapter.config.type === 'sqlite')`, TypeScript doesn't narrow `unwrap()`'s return type. Consumer must write `as any` cast. The spec's own migration table uses `adapter.unwrap() as any`.

**Fix:** Make `SqliteAdapter` and `TursoAdapter` narrow `unwrap()` return type.

### F5 (LOW) — `executeValues` is YAGNI

Zero call sites use `.raw()` or `.pluck()` in the entire `libs/` tree. The `executeValues` method and `ValuesResult` type add interface surface area with no existing consumer. The spec claims "reembed/iter patterns" but memory-core's reembed path writes directly to `vec_node`, not through raw arrays.

**Recommendation:** Remove or defer to v2.

### F6 (MEDIUM) — `READONLY` mode not in `AdapterConfig`

Memory-core's `openDbReadOnly()` creates `new Database(dbPath, { readonly: true })`. The spec mentions adding `readonly?: boolean` to `AdapterConfig` in a risk table row but doesn't include it in the interface definition.

**Fix:** Add `readonly?: boolean` to `AdapterConfig` in the interface definition (not just in risk mitigation).

### F7 (LOW) — `RETURNING` query semantics

`executeGet` is defined as "for SELECT that expects exactly one row" but is also used for `INSERT ... RETURNING` and `DELETE ... RETURNING`. The naming mismatch ("Get" implies SELECT) is minor but could confuse new readers. Consider documenting that `executeGet` captures any single-row-result call.

### F8 (LOW) — `pragmaGet` return type is `string | number | undefined`

better-sqlite3's `db.pragma(key, { simple: true })` returns `unknown` — it could be a string, number, boolean, or undefined depending on the pragma. The spec's `string | number | undefined` might be too narrow for pragmas that return booleans or arrays (e.g., `PRAGMA compile_options` returns multiple rows). Consider widening to `unknown`.

### F9 (VERIFIED CLAIM) — Graph-store Drizzle dependency

**Spec claim:** graph-store uses Drizzle at runtime in `applySchema()` via `drizzle(this.db)`.  
**Verified:** ✅ Lines 5–6 import `drizzle(from 'drizzle-orm/better-sqlite3')` and `migrate`. Line 701 calls `drizzle(this.db)`. The DDL inlining plan is correct.

### F10 (VERIFIED CLAIM) — No `.raw()` call sites

**Spec claim:** `.raw().all()` is used in memory-core's reembed/iter patterns (justifying `executeValues`).  
**Verified:** ❌ Zero matches for `.raw(` or `.pluck(` across all `libs/` source. The claim is false. `executeValues` has no existing consumer.

### F11 (VERIFIED CLAIM) — All transactions are sync

**Spec claim:** All 17 existing transaction callbacks are sync.  
**Verified:** ✅ Grep found 20 `db.transaction(` call sites. All callbacks are synchronous (no `await` or `async` inside the lambda, returns `void` or value, not Promise).

### F12 (LOW) — `batch()` naming collision with map/filter mental model

The spec documents `batch()` as "NON-ATOMIC convenience" with driver-dependent semantics. A consumer reading `adapter.batch([...])` might expect the same semantics as `@libsql/client.batch()` or better-sqlite3's batch mode — neither of which the SqliteAdapter implements natively (SqliteAdapter calls `executeRun` sequentially). Consider naming it `executeBatch` to reduce ambiguity with `batch()` in other SQL libraries.

---

## 5. Recommendations — Ranked by Impact

### P0 — Must fix before shipping

| # | Recommendation | Effort | Impact |
|---|---|---|---|
| R1 | **Make `executeGet`/`executeAll` generic** — add `<T = Record<string, unknown>>` to preserve typed row access | Low | Eliminates ~70 `as` casts |
| R2 | **Add `exec()` to `AdapterTransaction`** — transaction callbacks need DDL execution | Low | Prevents impossible migration pattern for graph-store |
| R3 | **Narrow `unwrap()` per implementation** — `SqliteAdapter.unwrap(): Database.Database`, `TursoAdapter.unwrap(): Client` | Low | Eliminates `as any` cast for sqlite-vec loading |
| R4 | **Add `readonly?: boolean` to `AdapterConfig`** — listed in risk table but missing from interface | Low | Memory-core's openDbReadOnly needs it |
| R5 | **Remove `executeValues` / `ValuesResult`** — zero call sites, YAGNI | Low | Reduces interface surface area by 2 types |

### P1 — Strongly consider

| # | Recommendation | Effort | Impact |
|---|---|---|---|
| R6 | **Document transaction sync constraint** with a branded type or lint rule. At minimum, add `@throws {TypeError}` to JSDoc and consider a stricter type for the callback parameter. | Medium | Prevents runtime crash class |
| R7 | **Rename `batch()` to `executeBatch()`** to avoid collision with `@libsql/client.batch()` mental model | Low | Better API discoverability |

### P2 — Nice to have

| # | Recommendation | Effort | Impact |
|---|---|---|---|
| R8 | **Widen `pragmaGet` return type** to `unknown` | Low | Prevents false type narrowing |
| R9 | **Add `SqliteAdapter`/`TursoAdapter` branded sub-interfaces** to the public exports so 3rd-party consumers can narrow on `config.type` | Low | Better IDE autocomplete |

### 5.1 Revised core interface (if R1–R5 are adopted)

```typescript
// Package: @adhd/sox-store-adapter

export interface RunResult {
  rowsAffected: number;
  lastInsertRowid: number | bigint;
}

export type GetResult<T = Record<string, unknown>> = T | null;

export interface AllResult<T = Record<string, unknown>> {
  columns: string[];
  rows: T[];
}

export interface AdapterTransaction {
  executeGet<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<GetResult<T>>;
  executeAll<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<AllResult<T>>;
  executeRun(sql: string, args?: unknown[]): Promise<RunResult>;
  exec(sql: string): Promise<void>;
  rollback(): Promise<void>;
}

export interface AdapterConfig {
  type: 'sqlite' | 'turso';
  dbPath?: string;
  url?: string;
  authToken?: string;
  readonly?: boolean;
}

export interface StoreAdapter {
  executeGet<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<GetResult<T>>;
  executeAll<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<AllResult<T>>;
  executeRun(sql: string, args?: unknown[]): Promise<RunResult>;

  /** @deprecated Use executeGet<T>/executeAll<T> instead. Removed in v2. */
  executeValues?(sql: string, args?: unknown[]): Promise<ValuesResult>;

  exec(sql: string): Promise<void>;
  pragmaSet(key: string, value: string | number | boolean): Promise<void>;
  pragmaGet(key: string): Promise<unknown>;

  transaction<T>(fn: (tx: AdapterTransaction) => T): Promise<T>;
  executeBatch(stmts: { sql: string; args?: unknown[] }[]): Promise<RunResult[]>;

  close(): Promise<void>;
  unwrap(): unknown;
  readonly config: Readonly<AdapterConfig>;
}

// Narrowed sub-types (R3):

export interface SqliteAdapter extends StoreAdapter {
  readonly config: Readonly<AdapterConfig & { type: 'sqlite' }>;
  unwrap(): Database.Database;
}

export interface TursoAdapter extends StoreAdapter {
  readonly config: Readonly<AdapterConfig & { type: 'turso' }>;
  unwrap(): import('@libsql/client').Client;
}
```

---

## Appendix A: File-level Verification Summary

| Spec Claim | File | Verdict |
|---|---|---|
| Graph-store uses `drizzle(this.db)` at runtime | `libs/data/graph/graph-store/src/index.ts:701` | ✅ Confirmed — lines 5–6 import drizzle+migrate |
| Graph-store DDL inlining is feasible | Same file, lines 25–87 | ✅ `GRAPH_DDL`, `FTS_DDL`, `FTS_TRIGGERS` already exist as string constants |
| Memory-core `openDb()` returns `Database.Database` sync | `libs/memory-core/src/db.ts:192` | ✅ Confirmed — sync `new Database(dbPath)` |
| Memory-core transactions are all sync | 20 grepped call sites in `libs/memory-core/src/` | ✅ Confirmed — no async patterns inside |
| Blob-store uses dynamic `import('better-sqlite3')` | `libs/data/store/blob-store/src/store.ts:112` | ✅ Confirmed — `new (await import('better-sqlite3')).default(dbPath)` |
| Task-queue opens own `new Database()` | `libs/data/queue/task-queue/src/task-queue.ts:197` | ✅ Confirmed — `new Database(this.config.dbPath)` |
| Task-queue scheduler opens own `new Database()` | `libs/data/queue/task-queue/src/scheduler.ts:91` | ✅ Confirmed — `new Database(this.dbPath)` |
| Vector-store loads `sqlite-vec` directly | `libs/data/vectors/vector-store/src/index.ts:2,346` | ✅ Confirmed — `import * as sqliteVec from 'sqlite-vec'` + `sqliteVec.load(db)` |
| No `.raw()` patterns exist in the codebase | Entire `libs/` tree | ❌ **Zero matches** — `executeValues` has no consumer |
| No `.pluck()` patterns exist in the codebase | Entire `libs/` tree | ✅ Confirmed — zero matches |
| `db.pragma()` only used in blob-store | `libs/data/store/blob-store/src/store.ts:113–115` | ✅ Confirmed — also in vector-store line 347 and hybrid-search spec |
| `info.changes` used in task-queue | `libs/data/queue/task-queue/src/task-queue.ts:381,514,645,671` | ✅ Confirmed — 4 call sites mapping to `rowsAffected` |
| `lastInsertRowid` used with `as number` casts | `libs/memory-core/src/outbox-queue.ts:66`, `reembed.spec.ts:131`, `embed-provenance.spec.ts:116` | ✅ Confirmed — 3 call sites, all cast `as number` |

---

## Disclosure — Unacknowledged Bugs & Deferrals

**No open bugs or deferrals** from this session. All findings are documented above and filed in the review artifact. The spec is thorough and well-researched — the issues found are all fixable pre-shipment.

**Items that must be resolved before Segment A ships:**
1. Generic type parameter on `executeGet`/`executeAll` (F1)
2. `exec()` on `AdapterTransaction` (F2)
3. `readonly` in `AdapterConfig` (F6)
4. Remove or defer `executeValues` (F5)
5. Narrowed `unwrap()` types per implementation (F4)

**Items that should be resolved before Segment B ships (graph-store migration):**
6. Sync callback constraint documentation (F3) — graph-store has the most complex transaction patterns and will hit this first
