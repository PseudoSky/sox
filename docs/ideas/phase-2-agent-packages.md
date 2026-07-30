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

---

## Optimized Execution Plan

> **Scope:** External consumer at `/Users/nix/dev/node/adhd/packages/agent/` — 9 packages. The sox-ecosystem side (store-adapter package) is owned by `docs/ideas/turso-database-adapter.md` — this plan covers only the agent-packages changes once the spec's Segment A (store-adapter) is shipped.

### Prerequisites

- `@adhd/sox-store-adapter` published (Segment A of the spec — store-adapter package)
- `drizzle-orm` retained at current stable version for Phase 1 unwrap bridge
- `@tursodatabase/database` available on npm (for Phase 2 — optional in Phase 1)

### Migration difficulty: **COMPLEX** (9-package simultaneous migration through `openRegistryDb()`, Drizzle coupling through 3 layers, no gradual adoption possible)

### Critical constraint: agent-core-env must migrate FIRST

Because all 8 consuming packages flow through `openRegistryDb()`, the function signature change from `Database.Database` → `Promise<StoreAdapter>` propagates simultaneously to every caller. Partial adoption is impossible — either every package has been updated or none compiles. This means:

1. `agent-core-env` defines the new interface (Packet AP-CORE-ENV)
2. All other packages change their constructor types in parallel to accept `StoreAdapter` (Level 1 wave)
3. Level 2 packages (which import Level 1) migrate second (Level 2 wave)
4. Phase 2 (actual Turso drizzle adapter) is deferred until `drizzle-orm@rc` stabilizes

### Dependency graph

```
SA-BUILD (sox-ecosystem must ship store-adapter first)
    │
    ├── AP-PREP (full audit of all 9 packages) ──► AP-CORE-ENV (THE bottleneck — must go first)
    │                                                    │
    │                         ┌──────────────────────────┼──────────────────────────┐
    │                         │                          │                          │
    │              AP-DIRECT-BETTER  ─────────────  AP-DRIZZLE-RETAIN   (both fully parallel)
    │              (4 packages: core-env,             (4 packages: policy,
    │               compiler, orchestrator,            provider, prompts, tools
    │               store-runtime)                     — store class constructor
    │               — migrate raw better-sqlite3      signature change + unwrap)
    │               calls to adapter.execute*()
    │
    └──────────────┬──────────────────────────────────┘
                   │
                   AP-LEVEL-2  ──►  AP-TESTS  ──►  REVIEW-AP  ──►  AP-SMOKE
```

**Critical path:** SA-BUILD → AP-PREP → AP-CORE-ENV → (AP-DIRECT-BETTER + AP-DRIZZLE-RETAIN, parallel) → AP-LEVEL-2 → AP-TESTS → REVIEW-AP → AP-SMOKE

**Total packets:** 12 (8 code/audit + 2 review + 1 smoke gate + 1 deferred Phase 2)

---

### Packet: AP-PREP

- **Prompt (~700 tok):** Audit all 9 agent packages. For each package, classify into one of 4 migration categories and identify every file that needs changes.

  **Per-package audit template:**

  | Package | Category | Files to audit |
  |---------|----------|---------------|
  | `agent-core-env` | Direct `better-sqlite3` (exports `openRegistryDb()`) | `src/index.ts`, `src/registry-db.ts` |
  | `agent-engine-compiler` | Direct `better-sqlite3` + imports Level 1 | All `src/*.ts` with DB calls |
  | `agent-engine-orchestrator` | Direct `better-sqlite3` + imports Level 1 | All `src/*.ts` with DB calls |
  | `agent-store-runtime` | Direct `better-sqlite3` + Drizzle | All `src/*.ts` with DB calls |
  | `agent-core-policy` | Drizzle-only | `src/*.ts` — store constructors |
  | `agent-core-provider` | Drizzle-only | `src/*.ts` — store constructors |
  | `agent-store-prompts` | Drizzle-only | `src/*.ts` — store constructors |
  | `agent-store-tools` | Drizzle-only (standalone — no `openRegistryDb()`) | `src/*.ts` — store constructors, `package.json` |
  | `agent-base-types` | Not affected | (verify — empty deps) |
  | `agent-generator-plugin` | Not affected (codegen, no DB) | (verify — no DB imports) |
  | `agent-plugin-budget` | Not affected (pure logic, peer deps only) | (verify — no DB imports) |
  | `agent-plugin-sanitize` | Not affected (pure logic, peer deps only) | (verify — no DB imports) |

  **For each affected package, identify:**
  1. Every `openRegistryDb()` call site and its current return value consumption
  2. Every `BetterSQLite3Database<any>` type annotation in store constructors
  3. Every `new Database(path)` call (direct better-sqlite3)
  4. Every `db.prepare()`, `.get()`, `.all()`, `.run()`, `.exec()` call
  5. Every `.transaction()`, `.immediate()`, `.deferred()` call site
  6. Every `lastInsertRowid` reference
  7. Every test file that creates `new Database(':memory:')`

  **Output:** `docs/migration-turso-agent-packages-audit.md` — per-package call site map with exact file:line references

- **Reserved files:** (read-only — no changes)
- **Input tokens:** ~700 (instruction) + ~5000 (reads key files across all 9 packages)
- **Output tokens:** ~600 (audit document)
- **Gate:** All 9 packages classified; per-category file list populated

---

### Packet: AP-CORE-ENV

- **Prompt (~500 tok):** Migrate `agent-core-env` — the single coordination bottleneck. This packet changes `openRegistryDb()` to return `Promise<StoreAdapter>`. Every other package depends on this change.

  **Changes to `src/registry-db.ts` or wherever `openRegistryDb()` is defined:**

  ```typescript
  // BEFORE
  import Database from 'better-sqlite3';
  import path from 'path';
  import { homedir } from 'os';

  export function openRegistryDb(): Database.Database {
    return new Database(path.join(homedir(), '.adhd', 'agent-registry', 'production', 'data', 'registry.db'));
  }

  // AFTER — Phase 1 (sqlite fallback, drizzle retained via unwrap)
  import { createStoreAdapter, type StoreAdapter } from '@adhd/sox-store-adapter';
  import path from 'path';
  import { homedir } from 'os';

  export async function openRegistryDb(): Promise<StoreAdapter> {
    const dbPath = path.join(homedir(), '.adhd', 'agent-registry', 'production', 'data', 'registry.db');
    return createStoreAdapter({
      type: (process.env.REGISTRY_STORE_ADAPTER as 'sqlite' | 'turso') ?? 'turso',
      dbPath,
    });
  }
  ```

  **Additional changes in `agent-core-env`:**
  - Any existing `closeRegistryDb()`: change from `db.close()` (sync) → `await adapter.close()` (async)
  - Any type exports: change from `export type { Database }` → `export type { StoreAdapter }`
  - Remove `import Database from 'better-sqlite3'` (or retain if SqliteAdapter needs it — better-sqlite3 stays in deps)
  - Add `@adhd/sox-store-adapter` and `@tursodatabase/database` to `package.json` dependencies

  **DO NOT** change any store class constructors in this packet — that's AP-DRIZZLE-RETAIN. This packet ONLY changes the shared connection factory.

- **Reserved files:**
  - `packages/agent-core-env/src/registry-db.ts` (or equivalent — the file defining `openRegistryDb()`)
  - `packages/agent-core-env/src/index.ts` (type re-exports, if any)
  - `packages/agent-core-env/package.json`

- **Depends on:** AP-PREP (know exact file locations)
- **Input tokens:** ~500 (instruction) + ~400 (reads 3 files)
- **Output tokens:** ~200
- **Gate:** `npx tsc --noEmit -p packages/agent-core-env/tsconfig.json` passes
- **BREAKING CHANGE:** This packet intentionally breaks compilation for all 8 consuming packages (they now receive `Promise<StoreAdapter>` instead of `Database.Database`). Compilation is restored by the next two parallel packets.

---

### Wave: Level 1 package migration (2 sub-packets, fully parallel — disjoint files, all depend on AP-CORE-ENV)

#### Packet: AP-DIRECT-BETTER

- **Prompt (~600 tok):** Migrate the 4 packages that use `better-sqlite3` directly (not just drizzle). These packages have raw `db.prepare()`, `.get()`, `.all()`, `.run()` calls that must become `adapter.execute*()`.

  **Per-package changes:**

  **1. `agent-core-env`** (already done in AP-CORE-ENV for `openRegistryDb()` — but it may have other direct `better-sqlite3` calls in other files). Migrate any remaining direct calls.

  **2. `agent-engine-compiler`:**
  - Every `db.prepare(sql).get(args)` → `await adapter.executeGet<T>(sql, args)`
  - Every `db.prepare(sql).run(args)` → `await adapter.executeRun(sql, args)`
  - Every `import Database from 'better-sqlite3'` → `import type { StoreAdapter } from '@adhd/sox-store-adapter'`
  - Constructor/factory receives `StoreAdapter` instead of `Database.Database`
  - Functions become `async`, return `Promise`
  - `package.json`: add `@adhd/sox-store-adapter` dep

  **3. `agent-engine-orchestrator`:** Same mechanical transformation.

  **4. `agent-store-runtime`:**
  - This is the trickiest package — it MIXES raw `better-sqlite3` with drizzle-orm query builder.
  - For raw SQL calls → `adapter.execute*()` (same mechanical transformation)
  - For drizzle calls → use the unwrap bridge: `(adapter as SqliteAdapter).unwrap()` → pass to `drizzle(client)` to get a `BetterSQLite3Database<any>`. Store the drizzle instance internally and leave the query builder calls untouched.
  - Constructor takes `StoreAdapter`, creates both an internal `adapter` field + an internal `drizzleDb` from the unwrapped handle.

  **Standard transformation for all 4 packages:**
  | Before | After |
  |--------|-------|
  | `import Database from 'better-sqlite3'` | `import type { StoreAdapter } from '@adhd/sox-store-adapter'` |
  | `new Database(path)` | `await createStoreAdapter({ type: 'turso', dbPath: path })` (or use the adapter passed from the caller via `openRegistryDb()`) |
  | `db.prepare(sql).get(args)` | `await adapter.executeGet<T>(sql, args)` |
  | `db.prepare(sql).run(args)` | `await adapter.executeRun(sql, args)` |
  | `db.prepare(sql).all(args)` | `await adapter.executeAll<T>(sql, args)` |
  | `db.exec(sql)` | `await adapter.exec(sql)` |
  | `db.transaction(fn)` | `await adapter.transaction(fn)` |
  | `db.transaction(fn).immediate()` | `await adapter.transaction(fn, { mode: 'immediate' })` |
  | `db.close()` | `await adapter.close()` |

- **Reserved files:**
  - `packages/agent-engine-compiler/src/**/*.ts` (all source files with DB calls)
  - `packages/agent-engine-compiler/package.json`
  - `packages/agent-engine-orchestrator/src/**/*.ts` (all source files with DB calls)
  - `packages/agent-engine-orchestrator/package.json`
  - `packages/agent-store-runtime/src/**/*.ts` (all source files with DB calls)
  - `packages/agent-store-runtime/package.json`

- **Depends on:** AP-CORE-ENV (all 4 packages import `openRegistryDb()` or receive its return value)
- **Input tokens:** ~600 (instruction) + ~3500 (reads all source files in 4 packages)
- **Output tokens:** ~1500
- **Gate:** `npx tsc --noEmit` passes for each of the 4 packages

#### Packet: AP-DRIZZLE-RETAIN

- **Prompt (~600 tok):** Migrate the 4 drizzle-only packages. These packages use only drizzle-orm's query builder (`.select()`, `.insert()`, `.where()`) and never touch `better-sqlite3` directly. The Phase 1 migration changes their constructor parameter from `BetterSQLite3Database<any>` to `StoreAdapter` and uses the unwrap bridge inside the constructor to retain drizzle.

  **Standard transformation for all 4 packages:**

  ```typescript
  // BEFORE — store class constructor
  import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

  class PolicyStore {
    constructor(private db: BetterSQLite3Database<any>) {}

    async getPolicy(id: string) {
      return this.db.select().from(policies).where(eq(policies.id, id)).get();
      //                                                  ^^^^^ drizzle query builder — unchanged
    }
  }

  // AFTER — Phase 1 unwrap bridge (drizzle query builder unchanged)
  import type { StoreAdapter, SqliteAdapter } from '@adhd/sox-store-adapter';
  import { drizzle } from 'drizzle-orm/better-sqlite3';
  import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

  class PolicyStore {
    private db: BetterSQLite3Database<any>;

    constructor(adapter: StoreAdapter) {
      const raw = (adapter as SqliteAdapter).unwrap();
      this.db = drizzle(raw);
      //     ^^^^^ drizzle-orm/better-sqlite3 retains drizzle
      //           query builder unchanged
    }

    async getPolicy(id: string) {
      return this.db.select().from(policies).where(eq(policies.id, id)).get();
      //                                                  ^^^^^ unchanged
    }
  }
  ```

  **Package-by-package file list:**

  1. **`agent-core-policy`:** `src/policy-store.ts` (or equivalent store class file)
  2. **`agent-core-provider`:** `src/provider-store.ts` (or equivalent)
  3. **`agent-store-prompts`:** `src/prompts-store.ts` (or equivalent)
  4. **`agent-store-tools`:** Requires special handling — it's standalone and doesn't use `openRegistryDb()`. It creates its own drizzle connection. The factory must be updated to accept `StoreAdapter` or create one from its own config. If it currently creates `new Database(path)` independently, replace with `createStoreAdapter({ dbPath: path })` and unwrap for drizzle.

  **Additional package.json changes for all 4:**
  - Add `@adhd/sox-store-adapter` to `dependencies`
  - `better-sqlite3` stays in transitive deps (needed by SqliteAdapter for Phase 1)
  - `@tursodatabase/database` NOT required for Phase 1 (optional)

  **Type export considerations:**
  - If any package re-exports `BetterSQLite3Database` from its index, replace with `StoreAdapter` re-export
  - If any package's public API surface changes (constructor parameter type), update `docs/` if applicable

- **Reserved files:**
  - `packages/agent-core-policy/src/**/*.ts` (store class files)
  - `packages/agent-core-policy/package.json`
  - `packages/agent-core-provider/src/**/*.ts` (store class files)
  - `packages/agent-core-provider/package.json`
  - `packages/agent-store-prompts/src/**/*.ts` (store class files)
  - `packages/agent-store-prompts/package.json`
  - `packages/agent-store-tools/src/**/*.ts` (store class files)
  - `packages/agent-store-tools/package.json`

- **Depends on:** AP-CORE-ENV (all 4 packages ultimately receive `StoreAdapter` from `openRegistryDb()`)
- **Input tokens:** ~600 (instruction) + ~2500 (reads all store class files in 4 packages)
- **Output tokens:** ~400 (the unwrap bridge pattern is add-only within constructors — minimal changes per file)
- **Gate:** `npx tsc --noEmit` passes for each of the 4 packages

---

### Packet: AP-LEVEL-2

- **Prompt (~400 tok):** Migrate Level 2 packages — `agent-engine-compiler` and `agent-engine-orchestrator` — which import Level 1 packages AND use `openRegistryDb()`.

  **Note:** These 2 packages were partially migrated in AP-DIRECT-BETTER (their own `better-sqlite3` calls). This packet covers the Level 2 package integration points:
  1. They import Level 1 packages whose constructor signatures changed to accept `StoreAdapter`
  2. They call `openRegistryDb()` and now receive `Promise<StoreAdapter>` instead of `Database.Database`

  **Changes:**
  - All `await openRegistryDb()` call sites: receive `StoreAdapter`, pass to Level 1 store constructors
  - Level 1 store constructor calls: `new PolicyStore(adapter)` instead of `new PolicyStore(db)` where `db` was the drizzle handle
  - Compiler-specific file: `src/compiler-db.ts` — the adapter is shared, not re-created per store (all stores use the same `registry.db`)
  - Orchestrator-specific file: `src/orchestrator-db.ts` — same pattern
  - All test files for these 2 packages: `new Database(':memory:')` → `createSqliteAdapter(...)` or `MockAdapter`

- **Reserved files:**
  - `packages/agent-engine-compiler/src/**/*.ts` (integration points + test files)
  - `packages/agent-engine-orchestrator/src/**/*.ts` (integration points + test files)

- **Depends on:** AP-DIRECT-BETTER (compiler and orchestrator own migration), AP-DRIZZLE-RETAIN (Level 1 packages constructor signatures are final)
- **Input tokens:** ~400 (instruction) + ~1500 (reads all Level 2 source + test files)
- **Output tokens:** ~400
- **Gate:** Full workspace `npx tsc --noEmit` passes with zero errors

---

### Packet: AP-TESTS

- **Prompt (~600 tok):** Migrate all test files across all 9 packages.

  **Standard transformations:**

  | Before | After |
  |--------|-------|
  | `import Database from 'better-sqlite3'` | `import { createSqliteAdapter, MockAdapter } from '@adhd/sox-store-adapter'` |
  | `const db = new Database(':memory:')` | `const adapter = createSqliteAdapter({ dbPath: ':memory:' })` or `const adapter = new MockAdapter()` |
  | `const store = new PolicyStore(db)` (where `db` was drizzle's `BetterSQLite3Database`) | `const store = new PolicyStore(adapter)` (constructor now accepts `StoreAdapter`, does unwrap internally) |
  | `const db = openRegistryDb()` | `const adapter = await openRegistryDb()` |
  | `db.prepare(sql).get(args)` | `await adapter.executeGet<T>(sql, args)` |
  | `db.transaction(fn).immediate()` | `await adapter.transaction(async tx => ..., { mode: 'immediate' })` |
  | Test assertion checking `lastInsertRowid` | Handle `number \| bigint` union in comparison |

  **Special considerations:**
  - Packages that previously tested drizzle query builder behavior directly (by passing a `BetterSQLite3Database`) now pass `StoreAdapter` — the unwrap is internal. Test the behavior through the store class interface.
  - `agent-store-tools` tests: if it uses a standalone connection (not through `openRegistryDb()`), the test must create its own adapter with the same config as production.
  - Concurrency tests: replace `Atomics.wait` with `await new Promise(r => setTimeout(r, N))`.

  **File discovery:** Use AP-PREP's classification of test files.

- **Reserved files:** All `**/*.spec.ts`, `**/*.test.ts` across all 9 packages
- **Depends on:** AP-LEVEL-2 (all packages must compile before tests can run)
- **Input tokens:** ~600 (instruction) + ~3000 (reads all test files)
- **Output tokens:** ~1500 (proportional to test count)
- **Gate:** `npx vitest run` or `pnpm -r test` passes across all packages

---

### Packet: REVIEW-AP

- **Prompt (~600 tok):** Read-only review of all changed files across all 9 packages.

  **Checklist:**

  **agent-core-env (the bottleneck):**
  1. `openRegistryDb()` returns `Promise<StoreAdapter>` — all callers `await`
  2. `closeRegistryDb()` is async — all callers `await`
  3. No `Database.Database` type exported from `index.ts`

  **Direct better-sqlite3 packages (AP-DIRECT-BETTER):**
  4. Zero `db.prepare()` calls remain — all are `adapter.execute*()`
  5. Zero `import Database from 'better-sqlite3'` remains in source (test files excluded)
  6. All `sync` functions → `async` returning `Promise`
  7. Every transaction has explicit `{ mode: ... }` where `.immediate()` was used

  **Drizzle-only packages (AP-DRIZZLE-RETAIN):**
  8. Store constructor takes `StoreAdapter`, not `BetterSQLite3Database`
  9. Unwrap bridge is in the constructor: `(adapter as SqliteAdapter).unwrap()` → `drizzle(raw)`
  10. Drizzle query builder calls (`.select()`, `.insert()`, `.where()`) are UNCHANGED — no query code was migrated to raw SQL
  11. No `better-sqlite3` import added in source — the unwrap bridge uses `SqliteAdapter` type from store-adapter

  **Level 2 packages (AP-LEVEL-2):**
  12. Compiler passes `StoreAdapter` to Level 1 store constructors, not `Database.Database`
  13. Orchestrator same pattern

  **Across all packages:**
  14. `package.json` files have `@adhd/sox-store-adapter` in dependencies
  15. `@tursodatabase/database` is NOT required for Phase 1 compilation (optional)
  16. `better-sqlite3` remains in dependencies (SqliteAdapter needs it for Phase 1)
  17. `npx tsc --noEmit` passes for the entire workspace (cross-package type consistency)

- **Reserved files:** (read-only — all changed files across 9 packages)
- **Depends on:** AP-TESTS
- **Input tokens:** ~600 (instruction) + ~5000 (reads all changed source files across 9 packages)
- **Output tokens:** ~500 (review report)

---

### Packet: AP-SMOKE

- **Prompt (~400 tok):** End-to-end smoke verification for all 9 packages.

  **Phase 1 verification (SqliteAdapter fallback — must pass immediately):**
  1. Set `REGISTRY_STORE_ADAPTER=sqlite` (or default, since Phase 1 doesn't enable Turso)
  2. Run `pnpm -r build` across all 9 packages — must pass
  3. Run `pnpm -r test` across all 9 packages — must pass
  4. Run integration test: create `openRegistryDb()`, create stores, write and read data through each store type
  5. Grep: `grep -r 'better-sqlite3' packages/*/src/` — must return ZERO results in source files (test files exempted)
  6. Grep: `grep -r 'BetterSQLite3Database' packages/*/src/` — ZERO in store constructors (stays only inside store class private fields after unwrap)
  7. Verify `(adapter as SqliteAdapter).unwrap()` call produces a working `better-sqlite3.Database` that drizzle-orm/better-sqlite3 accepts

  **Phase 2 readiness (TursoAdapter — precondition test, may fail):**
  8. Set `REGISTRY_STORE_ADAPTER=turso`
  9. Run `pnpm -r build` — verify the same code compiles (only the adapter type changes in `openRegistryDb()`)
  10. Run `pnpm -r test` — integration tests with Turso DB may fail if `drizzle-orm/tursodatabase/database` is still beta; this is expected for Phase 1. File a tracking issue for Phase 2.

  **Phase 2 deferred test (only when `drizzle-orm@rc` stabilizes):**
  11. After `drizzle-orm/tursodatabase/database` reaches stable: rerun AP-SMOKE with `REGISTRY_STORE_ADAPTER=turso` — full test suite must pass

- **Reserved files:** (read-only — verification only)
- **Depends on:** REVIEW-AP
- **Input tokens:** ~400 (instruction) + ~500 (reads build/test output)
- **Output tokens:** ~200

---

### Packet: AP-PHASE2 (Deferred)

- **Prompt (~400 tok):** Phase 2 drizzle migration — switch from `drizzle-orm/better-sqlite3` unwrap bridge to `drizzle-orm/tursodatabase/database` native adapter. This packet is DEFERRED until `drizzle-orm/tursodatabase/database` stabilizes (currently `drizzle-orm@rc`, beta).

  **Changes (all 4 drizzle-retaining packages from AP-DRIZZLE-RETAIN + 2 Level 2 packages):**

  ```typescript
  // BEFORE — Phase 1 unwrap bridge
  import { drizzle } from 'drizzle-orm/better-sqlite3';
  import type { StoreAdapter, SqliteAdapter } from '@adhd/sox-store-adapter';

  class PolicyStore {
    constructor(adapter: StoreAdapter) {
      const raw = (adapter as SqliteAdapter).unwrap();
      this.db = drizzle(raw);
    }
  }

  // AFTER — Phase 2 native Turso drizzle
  import { drizzle } from 'drizzle-orm/tursodatabase/database';
  import type { StoreAdapter, TursoAdapter } from '@adhd/sox-store-adapter';

  class PolicyStore {
    constructor(adapter: StoreAdapter) {
      const client = (adapter as TursoAdapter).unwrap();
      this.db = drizzle({ client });
    }
  }
  ```

  **Changes per package:**
  1. `packages/agent-core-policy/src/policy-store.ts`: Import path change + construction pattern change
  2. `packages/agent-core-provider/src/provider-store.ts`: Same
  3. `packages/agent-store-prompts/src/prompts-store.ts`: Same
  4. `packages/agent-store-tools/src/tools-store.ts`: Same
  5. `packages/agent-engine-compiler/src/compiler-db.ts`: Update import
  6. `packages/agent-engine-orchestrator/src/orchestrator-db.ts`: Update import

  **Additional changes:**
  7. All `package.json`: change `drizzle-orm` version to `drizzle-orm@rc` (or stable equivalent when available)
  8. All test files: if test creates drizzle directly, update import path and construction pattern

  **Gate condition:** Phase 2 ONLY executes after:
  - `drizzle-orm/tursodatabase/database` is confirmed stable (not `@rc`)
  - `@tursodatabase/database` is confirmed stable (not pre-1.0)
  - Phase 1 (`REGISTRY_STORE_ADAPTER=sqlite`) is verified in production
  - A canary environment runs Phase 2 for 7 days without incident

- **Reserved files:** (all 6 store class files + 6 `package.json` files)
- **Depends on:** AP-SMOKE (Phase 1 must be green before Phase 2 is attempted)
- **Input tokens:** ~400 (instruction) + ~1500 (reads all store class files)
- **Output tokens:** ~200 (import path change + construction pattern change — 4 lines per file)
- **Gate:** Full workspace `npx tsc --noEmit` passes; `REGISTRY_STORE_ADAPTER=turso` test suite passes

---

### Parallelism summary

| Wave | Packets | Max parallel | Depends on |
|------|---------|-------------|------------|
| **Prep** | AP-PREP | 1 | — |
| **Bottleneck** | AP-CORE-ENV | 1 | AP-PREP |
| **Level 1** | AP-DIRECT-BETTER, AP-DRIZZLE-RETAIN | **2 fully parallel** (disjoint file sets) | AP-CORE-ENV |
| **Level 2** | AP-LEVEL-2 | 1 | AP-DIRECT-BETTER, AP-DRIZZLE-RETAIN |
| **Tests** | AP-TESTS | 1 | AP-LEVEL-2 |
| **Review** | REVIEW-AP | 1 | AP-TESTS |
| **Smoke** | AP-SMOKE | 1 | REVIEW-AP |
| **Phase 2 (deferred)** | AP-PHASE2 | 1 | AP-SMOKE (gated on drizzle-orm/tursodatabase stability) |

**Key parallelization wins:**
- 2 Level 1 sub-packets (direct-better + drizzle-retain) run in parallel — 8 packages migrated simultaneously
- Within AP-DIRECT-BETTER, 4 packages can be migrated by one agent (same mechanical pattern, same prompt)
- Within AP-DRIZZLE-RETAIN, 4 packages can be migrated by one agent (same unwrap bridge pattern)
- REVIEW-AP hidden in AP-TESTS latency

**Total estimated output tokens:** ~6500  
**Total input tokens:** ~24000 (reads across all 9 packages)  
**Sequential chain depth:** 6 hops (PREP → CORE → LEVEL1 → LEVEL2 → TESTS → SMOKE)
