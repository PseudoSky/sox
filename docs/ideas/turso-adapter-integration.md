# Turso Adapter Integration — Initial Architect Spec (Round 1)

> **STATUS 2026-07-30: SUPERSEDED.** This round targeted `@libsql/client`, which Round 6
> (`docs/ideas/turso-database-adapter.md`) later confirmed was the wrong client library — the shipped
> adapter (`libs/data/store/store-adapter/`) wraps `@tursodatabase/database`, not `@libsql/client`. The
> `StoreAdapter` interface shape, the sqlite-vec escape hatch, and the segment breakdown here were all
> superseded by later rounds. Kept as historical design record only — see `turso-database-adapter.md`
> for what actually shipped.
>
> **Context:** First-pass design produced 2026-07-25 by `architect` agent, dispatched by `dispatcher`.  
> **Feedback received:** Scope was too memory-centric. Re-dispatched with unified `libs/data/` focus + external consumer support.  
> **See also:** `docs/ideas/turso-adapter-integration-v2.md` for the corrected spec.

---

## Research (delegated to researcher agent)

### `@libsql/client` API Surface
- **`execute(sql, args?)`** → `{ columns, columnTypes, rows, rowsAffected, lastInsertRowid }` — async
- **`batch(statements[])`** → array of results — async, atomic within a transaction
- **`transaction(mode?)`** → `tx.execute()`, `tx.rollback()`, `tx.commit()` — async
- **`exec(sql)`** → void — async, no result
- **`close()`** → void — async
- **`sync()`** → sync replica from remote (remote mode only) — async
- Two connection modes:
  - **Local (file:)** — `"file:./data.db"` — embedded SQLite via libsql, sync-compatible subset
  - **Remote (wss:/https:)** — `"libs://***.turso.io"` — talks to sqld, fully async
- Auth: bearer token via `authToken` option in `createClient()`
- Config object: `{ url: string, authToken?: string, syncUrl?: string, syncInterval?: number, encryptionKey?: string }`

### `better-sqlite3` vs `@libsql/client` Comparison

| Feature | `better-sqlite3` | `@libsql/client` |
|---------|------------------|------------------|
| API style | Synchronous | Async (Promise-based) |
| Prepared statements | `.prepare(sql)` → Statement object with `.run()`, `.get()`, `.all()`, `.iterate()` | `.execute(sql, args)` — no separate statement object |
| Transactions | `db.transaction(fn)` — sync | `db.transaction().execute(fn)` — async OR `db.batch()`
| Result shape | `{ changes, lastInsertRowid }` | `{ rows, columns, columnTypes, rowsAffected, lastInsertRowid }` |
| Extensions | `.loadExtension(path)` | Not supported in remote mode; local mode via config `extension` field (limited) |
| Error handling | `SqliteError` (extends Error) | `LibsqlError` (extends Error) with `code` field |
| Close | `.close()` sync | `.close()` async |
| WAL mode | `PRAGMA journal_mode=WAL` | Fully supported (local mode) |
| `sqlite-vec` | Via `.loadExtension()` | Local mode only; not supported remotely |

### Key Finding: sqlite-vec
The `memory-core` package depends on `sqlite-vec` via `better-sqlite3.loadExtension()`. This is the **primary migration blocker**:
- Turso local mode does not support custom `.loadExtension()` the same way
- Turso remote mode cannot load C extensions at all
- **Mitigation:** Adapter needs a `.raw()` escape hatch that returns the underlying `better-sqlite3` Database instance when sqlite-vec is needed. Long-term: libsql-native vector support.

### Drizzle ORM Adapter Patterns (Reference)
- Drizzle's `better-sqlite3` adapter uses sync API; `@libsql/client` adapter uses async
- Both implement the same `BaseSQLiteDatabase` interface via a type parameter `<T extends ...>`
- Factory functions (`drizzle(client)`) normalize the result shapes
- Pattern: adapter accepts `TExtended` type param for driver-specific extras

### Turso Local Development
- No sqld server needed for local dev — just `file:` protocol URL
- `@libsql/client` in local mode uses the `libsql` core under the hood
- Local mode is API-compatible with remote mode (same async interface)
- `turso dev` no longer needed; local file mode is the recommended dev path

## Codebase Analysis

### Packages consuming `better-sqlite3` directly

| Package | File(s) | Pattern | Usage |
|---------|---------|---------|-------|
| `libs/memory-core/src/db.ts` | `db.ts` | Central connection factory | Creates `new Database()`, loads sqlite-vec extension, exports `getDb()` |
| `libs/data/graph/graph-store/src/` | Graph store | DI-injected `Database.Database` | Receives db handle via constructor |
| `libs/data/vectors/vector-store/src/` | Vector store | DI-injected `Database.Database` | Receives db handle via constructor |
| `libs/data/queue/task-queue/src/` | Task queue | Owns `new Database()` | Creates connection internally |
| `libs/data/store/blob-store/src/` | Blob store | Dynamic import | Owns connection via `better-sqlite3` dynamic import |
| `libs/data/analysis/src/` | Analysis package | Imports `Database` | Uses `better-sqlite3` type |

### Config Pattern
- `SOX_CONFIG_DB_PATH` env var with fallback `DEFAULT_DB_PATH` (~/.memory/memory.db)
- Currently hard-coded SQLite file path — no concept of connection URL or remote database

### Extension Consumers (downstream)
- `extensions/memory-server/extension.json` — manifest config
- `extensions/memory-cli/extension.json` — manifest config
- `extensions/memory-flush/extension.json` — manifest config
- These bundle the `memory-core` package and rely on its DB connection factory

## Architecture Decision

### New Package: `libs/data/store/store-adapter/`

An isolated, zero-dependency (on business logic) adapter package that provides:

```
libs/data/store/store-adapter/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                    # Re-exports
│   ├── types.ts                    # StoreAdapter interface, Result types
│   ├── sqlite-adapter.ts           # better-sqlite3 wrapper
│   ├── turso-adapter.ts            # @libsql/client wrapper
│   ├── factory.ts                  # createStoreAdapter() with env-var routing
│   └── errors.ts                   # AdapterError hierarchy
└── README.md                       # Usage, config, adapter authoring guide
```

### `StoreAdapter` Interface (all-async)

```typescript
export interface ResultSet {
  columns: string[];
  columnTypes: (string | null)[];
  rows: Record<string, unknown>[];
  rowsAffected: number;
  lastInsertRowid: bigint | number | undefined;
}

export interface AdapterTransaction {
  execute(sql: string, args?: unknown[]): Promise<ResultSet>;
  rollback(): Promise<void>;
  commit(): Promise<void>;
}

export interface StoreAdapter {
  /** Execute a single statement with optional args */
  execute(sql: string, args?: unknown[]): Promise<ResultSet>;

  /** Execute multiple statements atomically */
  batch(statements: { sql: string; args?: unknown[] }[]): Promise<ResultSet[]>;

  /** Begin a transaction */
  transaction(): Promise<AdapterTransaction>;

  /** Execute SQL with no result (DDL, pragmas) */
  exec(sql: string): Promise<void>;

  /** Close the connection */
  close(): Promise<void>;

  /**
   * Escape hatch for driver-specific functionality.
   * For SqliteAdapter: returns the raw better-sqlite3 Database.
   * For TursoAdapter: returns the raw @libsql/client client.
   */
  raw<T = unknown>(): T;
}
```

### `SqliteAdapter` — wraps `better-sqlite3` in Promises

```typescript
export class SqliteAdapter implements StoreAdapter {
  private db: Database;

  constructor(dbPath: string, options?: SqliteOptions) {
    this.db = new Database(dbPath, options);
    this.db.pragma('journal_mode = WAL');
  }

  async execute(sql: string, args?: unknown[]): Promise<ResultSet> {
    const stmt = this.db.prepare(sql);
    const result = args ? stmt.run(...args) : stmt.run();
    // ... normalize to ResultSet shape
  }

  // ... remaining methods wrapping sync better-sqlite3 in Promises

  raw<Database>() { return this.db as Database; }
}
```

### `TursoAdapter` — wraps `@libsql/client` (natively async)

```typescript
export class TursoAdapter implements StoreAdapter {
  private client: Client;

  constructor(config: TursoConfig) {
    this.client = createClient(config);
  }

  async execute(sql: string, args?: unknown[]): Promise<ResultSet> {
    return this.client.execute({ sql, args });
  }

  // ... natively async, no wrapping needed

  raw<Client>() { return this.client as Client; }
}
```

### Factory: `createStoreAdapter()`

```typescript
export type StoreAdapterType = 'sqlite' | 'turso';

export interface StoreAdapterConfig {
  type: StoreAdapterType;
  dbPath?: string;       // SQLite file path (sqlite adapter) or file: URL (turso local)
  url?: string;          // Turso remote URL (libs://...)
  authToken?: string;    // Turso auth token
}

export function createStoreAdapter(config?: StoreAdapterConfig): StoreAdapter {
  const type = config?.type ?? process.env.STORE_ADAPTER ?? 'turso';
  // ... env-var driven, turso as default
}
```

**Env-var driven config (default: `turso`):**
- `STORE_ADAPTER=turso|sqlite` — selects adapter
- `SOX_CONFIG_DB_PATH=/path/to/data.db` — used as `file:` URL for Turso local mode, or file path for SQLite mode
- `TURSO_DB_URL=libs://xxx.turso.io` — remote URL override
- `TURSO_AUTH_TOKEN=xxx` — remote auth token

When `STORE_ADAPTER=turso` and no remote URL is set, local file mode is used (`file:${SOX_CONFIG_DB_PATH}`) — zero-config local dev.

### Migration Path

1. **Phase A:** Create `store-adapter` package — no behavioral changes
2. **Phase B:** Refactor `memory-core` to consume `StoreAdapter` — internal change, same default (sqlite initially)
3. **Phase C:** Widen graph-store, vector-store, analysis types to accept `StoreAdapter`
4. **Phase D:** refactor task-queue, blob-store to consume `StoreAdapter`
5. **Phase E:** Update extension manifests, flip default to `turso`
6. **Phase F:** Remove direct `better-sqlite3` dependency from all non-adapter packages (optional cleanup)

### Testing Strategy

- **Adapter contract tests** (`store-adapter/test/`): Same test suite run against both adapters to prove behavioral equivalence
- **Local Turso mode** via file: URL — no external server needed in CI
- **sqlite-vec test** specifically validates `.raw()` escape hatch
- Each consuming package's existing test suite validates the adapter works in context

## File-by-File Breakdown

### Segment A — New `store-adapter` package (12 new files)
| File | Status | Est. Tokens |
|------|--------|-------------|
| `libs/data/store/store-adapter/package.json` | NEW | ~40 |
| `libs/data/store/store-adapter/tsconfig.json` | NEW | ~30 |
| `libs/data/store/store-adapter/src/index.ts` | NEW | ~10 |
| `libs/data/store/store-adapter/src/types.ts` | NEW | ~120 |
| `libs/data/store/store-adapter/src/sqlite-adapter.ts` | NEW | ~250 |
| `libs/data/store/store-adapter/src/turso-adapter.ts` | NEW | ~200 |
| `libs/data/store/store-adapter/src/factory.ts` | NEW | ~150 |
| `libs/data/store/store-adapter/src/errors.ts` | NEW | ~40 |
| `libs/data/store/store-adapter/README.md` | NEW | ~80 |
| `libs/data/store/store-adapter/test/contract.test.ts` | NEW | ~300 |
| `libs/data/store/store-adapter/test/sqlite-adapter.test.ts` | NEW | ~150 |
| `libs/data/store/store-adapter/test/turso-adapter.test.ts` | NEW | ~150 |

### Segment B — memory-core rewrite (5 modified files)
| File | Change | Est. Tokens |
|------|--------|-------------|
| `libs/memory-core/src/db.ts` | Rewrite to use StoreAdapter, keep `getDb()` backward compat via `.raw()` | ~200 |
| `libs/memory-core/src/vector.ts` | Update type imports | ~30 |
| `libs/memory-core/src/graph.ts` | Update type imports | ~30 |
| `libs/memory-core/package.json` | Add `@sox/store-adapter` workspace dep, remove direct better-sqlite3 | ~10 |
| `libs/memory-core/tsconfig.json` | Add path reference | ~10 |

### Segment C — data libs type widening (6 modified files)
| File | Change | Est. Tokens |
|------|--------|-------------|
| `libs/data/graph/graph-store/src/index.ts` | Widen constructor param from `Database.Database` to `StoreAdapter` | ~50 |
| `libs/data/vectors/vector-store/src/index.ts` | Same | ~50 |
| `libs/data/analysis/src/index.ts` | Same | ~50 |
| Each `package.json` | Add `@sox/store-adapter` dep | ~10 × 3 |
| Each `tsconfig.json` | Add path reference | ~10 × 3 |

### Segment D — direct-connection data libs (5 modified files)
| File | Change | Est. Tokens |
|------|--------|-------------|
| `libs/data/queue/task-queue/src/index.ts` | Replace `new Database()` with `createStoreAdapter()` | ~100 |
| `libs/data/store/blob-store/src/index.ts` | Same | ~100 |
| Each `package.json` | Add `@sox/store-adapter` dep | ~10 × 2 |
| Each `tsconfig.json` | Add path reference | ~10 × 2 |

### Segment E — extensions + downstream (18 modified files)
| File | Change | Est. Tokens |
|------|--------|-------------|
| `extensions/memory-server/src/index.ts` | Wire adapter config from env/extension manifest | ~80 |
| `extensions/memory-server/extension.json` | Add `settings` for STORE_ADAPTER | ~20 |
| `extensions/memory-cli/src/index.ts` | Same wiring | ~60 |
| `extensions/memory-cli/extension.json` | Same | ~20 |
| `extensions/memory-flush/src/index.ts` | Same | ~40 |
| `extensions/memory-flush/extension.json` | Same | ~20 |
| Various `.env.example`, `.env.template` files | Add Turso env vars | ~10 × many |
| Root `tsconfig.base.json` | Add path alias for `@sox/store-adapter` | ~10 |

## Segment Dependencies

```
A (store-adapter package)
├── B (memory-core) — depends on A
├── C (data libs type widening) — depends on A
├── D (task-queue, blob-store) — depends on A
└── E (extensions + manifests) — depends on B, C, D
```

A is root dependency. B, C, D can parallelize after A. E requires B+C+D.

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| sqlite-vec not loadable in Turso local mode | **HIGH** | `.raw()` escape hatch; long-term libsql-native vector support |
| sync→async migration breaks existing callers | **MEDIUM** | All existing callers already use `await` patterns; interface is async-first |
| Transaction semantics differ (sync `db.transaction(fn)` vs async `tx.execute()`) | **MEDIUM** | Adapter.transaction() returns an object with execute/rollback/commit — same shape for both adapters |
| `@libsql/client` peer dep not installed | **MEDIUM** | Dynamic import with clear error message ("Install @libsql/client to use Turso adapter") |
| DDL compatibility (AUTOINCREMENT, CREATE INDEX concurrency) | **LOW** | Use standard SQL subset; contract tests catch divergence |
| Async performance regression vs sync better-sqlite3 | **LOW** | Negligible for I/O-bound workloads; benchmark gate if needed |
| `better-sqlite3` type `Statement` used directly in 20+ domain functions | **MEDIUM** | Adapter returns normalized `ResultSet`; domain functions must migrate off `stmt.get()`/`stmt.all()` patterns |

## Memory Episodes Written
1. Store adapter architecture decision — importance 8, tags: `turso`, `adapter`, `store`, `database`, `architecture`
2. `@libsql/client` capability assessment — importance 7, tags: `turso`, `adapter`, `store`, `database`
3. Drizzle ORM adapter pattern analysis — importance 6, tags: `adapter`, `patterns`, `database`, `turso`
