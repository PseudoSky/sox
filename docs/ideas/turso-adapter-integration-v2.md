# Turso Adapter Integration — Unified Store Backend (Round 2)

> **STATUS 2026-07-30: SUPERSEDED.** Like Round 1, this round targeted `@libsql/client`, which Round 6
> (`docs/ideas/turso-database-adapter.md`) later confirmed was wrong — the shipped adapter
> (`libs/data/store/store-adapter/`, package `@adhd/sox-store-adapter`) wraps `@tursodatabase/database`.
> The `createStoreAdapter`/`createTursoAdapter` 3rd-party example, `@sox/store-adapter` package name, and
> single-mode `transaction()` shown here were all superseded by later rounds (Round 3 renamed the package
> and split query methods; Round 6 added transaction modes). Kept as historical design record only.
>
> **See prior spec:** `docs/ideas/turso-adapter-integration.md`  
> **Round 1 feedback:** The initial design was too memory-centric. This round corrects to a general-purpose, repo-wide backing-store abstraction where the memory bundle is 1 of many consumers.

## Critique of Round 1

The Round 1 spec had these scoping issues:

1. **Memory-centric framing** — the adapter was designed around `memory-core`'s needs (sqlite-vec escape hatch, `SOX_CONFIG_DB_PATH` env var). External consumers don't care about sqlite-vec.
2. **`libs/data/` as passive consumers** — graph-store, vector-store, task-queue, blob-store, analysis were "type-widened" after the fact, not designed as equal peers.
3. **No concept of consumer-level configuration** — every consumer got its adapter from a global env var. A real 3rd party embedding `@sox/graph-store` may want SQLite while another wants Turso.
4. **Adapter was a library, not a platform abstraction** — the factory was hard-coded per-process. No registry pattern, no consumer-level override.
5. **Extension manifests treated as an afterthought** — the memory extensions drove the config shape, not a general extension config schema.

## Corrected Design Constraints

1. **`libs/data/` packages are the primary consumers** — graph-store, vector-store, task-queue, blob-store, analysis, and memory-core are equal peers that all receive a `StoreAdapter` via DI or factory. No hard-coded `better-sqlite3` anywhere outside the adapter package.
2. **3rd-party embedding is the design center** — a consumer installing `@sox/graph-store` from npm should be able to pass any `StoreAdapter` implementation (Turso, SQLite, mock, or a custom one). The sox ecosystem provides the adapters; the consumer chooses and wires.
3. **Consumer-level config, not global env-var only** — each consumer accepts an optional adapter instance. The env-var-driven factory is a convenience for the CLI/server bundles, not the only path.
4. **Adapter package is platform-neutral** — no references to `memory-core`, `sqlite-vec`, `SOX_CONFIG_DB_PATH`, or any sox-domain concept. It exports interfaces, implementations, and a factory — nothing more.
5. **Extension manifests declare their store dependency** — an extension's `extension.json` can specify `"storeAdapter": "turso"` or `"storeAdapter": "sqlite"` to opt in, with the host-runtime wiring it.

---

## Round 2 Spec (Architect, 2026-07-25)

### Core Interface: `StoreAdapter`

**File:** `libs/data/store/store-adapter/src/types.ts`

```typescript
export interface ResultSet {
  columns: string[];
  columnTypes: (string | null)[];
  rows: Record<string, unknown>[];
  rowsAffected: number;
  lastInsertRowid: number | bigint | undefined;
}

export interface AdapterTransaction {
  execute(sql: string, args?: unknown[]): Promise<ResultSet>;
  rollback(): Promise<void>;
  commit(): Promise<void>;
}

export interface AdapterConfig {
  type: 'sqlite' | 'turso';
  dbPath?: string;
  url?: string;
  authToken?: string;
}

export interface StoreAdapter {
  execute(sql: string, args?: unknown[]): Promise<ResultSet>;
  batch(stmts: { sql: string; args?: unknown[] }[]): Promise<ResultSet[]>;
  transaction<T>(fn: (tx: AdapterTransaction) => T): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  raw<T = unknown>(): T;
}
```

### SqliteAdapter

- Wraps `better-sqlite3` — sync calls wrapped in `Promise`/`process.nextTick`
- Accepts `string` path or pre-existing `Database` instance (DI path for already-open connections)
- Transaction: `db.transaction(fn)` callback wrapper — callback must be sync (better-sqlite3 constraint; all existing codebase callbacks already are)
- `raw()` returns `Database`

### TursoAdapter

- Wraps `@libsql/client` — natively async, no wrapping needed
- Local mode: `file:./data.db` — zero-config dev, no sqld server needed
- Remote mode: `libs://xxx.turso.io` + `authToken`
- Transaction: explicit `BEGIN`/`COMMIT`/`ROLLBACK` via `client.execute()`
- `raw()` returns `Client`

### Factory: `createStoreAdapter()`

**File:** `libs/data/store/store-adapter/src/factory.ts`

- Accepts optional `AdapterConfig`; falls back to env vars
- Env vars: `STORE_ADAPTER`, `SOX_CONFIG_DB_PATH`, `TURSO_DB_URL`, `TURSO_AUTH_TOKEN`
- Uses dynamic `import()` so unused drivers don't appear in bundles
- **Consumer packages should NOT call the factory** unless they want the env-var default — the preferred pattern is receiving an adapter instance from the caller

### 3rd-Party Consumer Pattern

```typescript
// Consumer chooses and wires — sox provides the pieces
import { createTursoAdapter } from '@sox/store-adapter'
import { createGraphStore } from '@sox/graph-store'
import { createTaskQueue } from '@sox/task-queue'

// Different adapters for different stores, same process
const userDb = createTursoAdapter({ url: 'file:./users.db' })
const queueDb = createSqliteAdapter({ dbPath: './queue.sqlite' })

const graph = createGraphStore({ adapter: userDb })
const queue = createTaskQueue({ adapter: queueDb })
```

### Consumer Refactors — All `libs/data/*` Packages

Every `Database.Database` parameter becomes `StoreAdapter`. Every `db.prepare().get/all/run` becomes `adapter.execute()`. Every `db.transaction(() => ...)` becomes `adapter.transaction(tx => ...)`.

| Package | Change | Est. Files |
|---------|--------|-----------|
| `graph-store` | Constructor accepts `{ adapter: StoreAdapter }` | ~6 |
| `vector-store` | Constructor accepts `{ adapter: StoreAdapter }` | ~5 |
| `task-queue` | Factory accepts `{ adapter?: StoreAdapter }` | ~5 |
| `blob-store` | Factory accepts `{ adapter?: StoreAdapter }` | ~5 |
| `analysis` | Widen type param from `Database.Database` | ~3 |
| `memory-core` | ~25 files: `db.prepare().get/all/run` → `adapter.execute()` | ~25 |
| Extensions (memory-server, -cli, -flush) | Wire adapter from extension.json config | ~6 |
| `host-runtime` | Read extension manifest `store_adapter` field, create adapter | ~3 |

### Error Handling

- Errors are NOT normalized — they propagate natively (`SqliteError` or `LibsqlError`)
- Typed helpers provided for cross-driver portability:
  ```typescript
  function isUniqueConstraintError(err: unknown): boolean
  ```
- Consumer code that needs driver-specific handling uses `adapter.raw()` for a cast

### Extension Manifest Schema

New optional field in `extension.json`:

```json
{
  "store_adapter": {
    "type": "turso",
    "env_prefix": "MY_EXT"
  }
}
```

The host-runtime reads this + `MY_EXT_DB_URL` / `MY_EXT_AUTH_TOKEN` env vars to wire the adapter. Omitting `store_adapter` means "don't provide a default adapter" (extension manages its own storage).

### Segment Decomposition (8 segments, ~55 files)

| Segment | Scope | Depends On | Est. Files |
|---------|-------|------------|-----------|
| A | `store-adapter` package — interface, SqliteAdapter, TursoAdapter, factory, errors, README, contract tests | None | ~12 NEW |
| B | `graph-store` — adapter injection, type widening, query layer migration | A | ~6 MODIFY |
| C | `vector-store` — same pattern as B | A | ~5 MODIFY |
| D | `task-queue` — factory change, query layer migration | A | ~5 MODIFY |
| E | `blob-store` — factory change, query layer migration | A | ~5 MODIFY |
| F | `memory-core` — full migration (~25 files), sqlite-vec via `.raw()`, keep `getDb()` backward compat | A | ~25 MODIFY |
| G | Extensions — memory-server, memory-cli, memory-flush wire adapter from manifest | B, C, D, E, F | ~6 MODIFY |
| H | `host-runtime` — store_adapter wiring, extension.json schema validation | G | ~3 MODIFY |

Segments B, C, D, E can be dispatched in parallel after A. F requires B+C. G requires all of B-F. H requires G.

### Key Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| `sqlite-vec` incompatible with Turso | **HIGH** | memory-core loads it via `adapter.raw()` escape hatch. Only SQLite adapter supports it; Turso mode skips vec features or falls back to FTS. Adapter interface has zero knowledge of this. |
| Transaction callback sync constraint | **MEDIUM** | All existing codebase transactions are sync. SqliteAdapter enforces at runtime. TursoAdapter has no such constraint. |
| Multiple adapters, one process | **LOW** | Graph-store and task-queue already access different DB paths. Each consumer holds its own adapter reference — no global state. |
| BigInt precision loss | **LOW** | TypeScript forces consumer to handle `number | bigint` deliberately. |
| `@libsql/client` peer dep | **MEDIUM** | Dynamic import with descriptive error message. CI tests both install paths. |
| Drizzle ORM in graph-store | **LOW** | graph-store already uses drizzle-orm on `better-sqlite3`. `adapter.raw()` casts to the expected type for a one-time migration pass. Full Drizzle/Turso compatibility documented as deferred. |

### Testing Strategy

1. **Adapter contract tests** — identical test suite runs against both SqliteAdapter (file: path) and TursoAdapter (file: path). Validates execute, batch, transaction, exec, close, error handling, concurrency.
2. **Consumer tests** — each `libs/data/*` package uses a mock adapter (`createMockStoreAdapter()`) injected via DI. No real database needed for unit tests.
3. **Integration tests** — `memory-core` integration tests run against both adapters via the contract suite. sqlite-vec tests only run on the SQLite adapter.
4. **CI** — TursoAdapter tested in local `file:` mode only (zero external deps). No sqld server needed.
5. **Benchmark gate** — async wrapping overhead benchmark comparing raw better-sqlite3 vs SqliteAdapter. Fail if >5% regression.

### Memory Episodes Written

Key architecture decisions, interface shape, factory pattern, DI approach, and risk mitigations stored to memory with tags `turso`, `adapter`, `store`, `database`, `architecture`, `round-2`.

