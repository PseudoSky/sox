/**
 * Auto-detect adapter type from env vars (STORE_ADAPTER).
 * Falls back to 'turso' if unset.
 * Source code that hardcodes the adapter type should use
 * createSqliteAdapter() or createTursoAdapter() directly.
 */
import { detectAdapterChange } from './adapter-meta.js';
import type {
  StoreAdapter,
  SqliteAdapter,
  TursoAdapter,
  AdapterConfig,
  CreateStoreOptions,
} from './types.js';
import type { StoreConcurrencyMode } from './concurrency-mode.js';
import { resolveConcurrencyMode } from './concurrency-mode.js';
import { SqliteAdapterImpl } from './sqlite-adapter.js';
import { TursoAdapterImpl } from './turso-adapter.js';

// ── createStoreAdapter — env-driven auto-detect ──────────────────────────────

export async function createStoreAdapter(
  config?: Partial<AdapterConfig>,
  options?: CreateStoreOptions,
): Promise<StoreAdapter> {
  const adapterType = (process.env.STORE_ADAPTER || 'turso').toLowerCase();

  let adapter: StoreAdapter;

  if (adapterType === 'sqlite') {
    const dbPath = config?.dbPath || process.env.SOX_CONFIG_DB_PATH;
    if (!dbPath) {
      throw new Error(
        'createStoreAdapter: type=sqlite requires a dbPath. Set SOX_CONFIG_DB_PATH or pass config.dbPath.',
      );
    }
    // (BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001) Resolve the mode
    // explicitly at the call site — declared, never the engine's implicit
    // default. SqliteAdapterImpl validates it ('single-writer' only).
    const mode: StoreConcurrencyMode = config?.concurrencyMode ?? resolveConcurrencyMode('sqlite');
    const sqliteOpts: { dbPath: string; readonly?: boolean; statementCacheSize?: number; concurrencyMode?: StoreConcurrencyMode } = { dbPath, concurrencyMode: mode };
    if (config?.readonly !== undefined) sqliteOpts.readonly = config.readonly;
    adapter = createSqliteAdapter(sqliteOpts);
  } else if (adapterType === 'turso') {
    // (BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001) Same explicit
    // resolution as the sqlite branch — TursoAdapterImpl validates it
    // ('multiprocess-wal' only) and verifies the -tshm coordinator post-open.
    const mode: StoreConcurrencyMode = config?.concurrencyMode ?? resolveConcurrencyMode('turso');
    const tursoOpts: Parameters<typeof createTursoAdapter>[0] = { concurrencyMode: mode };
    const url = config?.url || process.env.TURSO_DB_URL;
    if (url !== undefined) tursoOpts.url = url;
    if (config?.dbPath !== undefined) tursoOpts.dbPath = config.dbPath;
    const authToken = config?.authToken || process.env.TURSO_AUTH_TOKEN;
    if (authToken !== undefined) tursoOpts.authToken = authToken;
    if (config?.readonly !== undefined) tursoOpts.readonly = config.readonly;
    if (config?.allowFtsInReadonly !== undefined) tursoOpts.allowFtsInReadonly = config.allowFtsInReadonly;
    // (BL-508) The deliberate-migration path opens the store with the WRONG
    // adapter on purpose (source read for migrateStore) — the foreign-engine
    // refusal must not block it.
    if (options?.migrateOnAdapterChange) tursoOpts.allowForeignEngine = true;
    adapter = await createTursoAdapter(tursoOpts);
  } else {
    throw new Error(
      `Unknown STORE_ADAPTER value: "${adapterType}". Expected "sqlite" or "turso".`,
    );
  }

  // ── Auto-migration (BEFORE init stamps the new type) ─────────────────────

  if (options?.migrateOnAdapterChange) {
    if (!config?.dbPath) {
      throw new Error(
        'migrateOnAdapterChange requires a local file database (config.dbPath). ' +
        'Remote Turso stores cannot be auto-migrated — use the manual migration tools instead.',
      );
    }
    const changed = await detectAdapterChange(adapter, adapterType as 'sqlite' | 'turso');
    if (changed) {
      // Create a temp target store with the correct adapter type
      const tempPath = config.dbPath + '.migrate.' + Date.now() + '.db';
      const targetAdapter = await createStoreAdapter(
        { ...config, dbPath: tempPath },
        { migrateOnAdapterChange: false }, // prevent recursion
      );
      const { migrateStore } = await import('./migration.js');
      await migrateStore(adapter, targetAdapter, options.migrationOptions);
      await targetAdapter.close();
      await adapter.close();

      // Atomic swap — only runs if migration completed successfully
      const fs = await import('node:fs');
      await fs.promises.rename(tempPath, config.dbPath);

      // Re-open with the correct adapter type (no recursion)
      return createStoreAdapter(config, { migrateOnAdapterChange: false });
    }
  }

  // ── Init (stamp adapter metadata) ─────────────────────────────────────────

  if (typeof adapter.init === 'function') {
    await adapter.init();
  }

  return adapter;
}

// ── createSqliteAdapter — explicit, narrowed return type ──────────────────────

export function createSqliteAdapter(
  opts: { dbPath: string; readonly?: boolean; statementCacheSize?: number; concurrencyMode?: StoreConcurrencyMode },
): SqliteAdapter;
export function createSqliteAdapter(
  db: import('better-sqlite3').Database,
): SqliteAdapter;
export function createSqliteAdapter(
  dbOrOpts:
    | { dbPath: string; readonly?: boolean; statementCacheSize?: number; concurrencyMode?: StoreConcurrencyMode }
    | import('better-sqlite3').Database,
): SqliteAdapter {
  if (typeof dbOrOpts === 'object' && 'dbPath' in dbOrOpts) {
    const ctorOpts: { readonly?: boolean; concurrencyMode?: StoreConcurrencyMode } = {};
    if (dbOrOpts.readonly !== undefined) ctorOpts.readonly = dbOrOpts.readonly;
    if (dbOrOpts.concurrencyMode !== undefined) ctorOpts.concurrencyMode = dbOrOpts.concurrencyMode;
    return new SqliteAdapterImpl(dbOrOpts.dbPath, ctorOpts);
  }
  return new SqliteAdapterImpl(dbOrOpts);
}

// ── createTursoAdapter — explicit, narrowed return type ──────────────────────

export async function createTursoAdapter(
  opts: {
    url?: string;
    dbPath?: string;
    authToken?: string;
    readonly?: boolean;
    allowFtsInReadonly?: boolean;
    allowForeignEngine?: boolean;
    concurrencyMode?: StoreConcurrencyMode;
  },
): Promise<TursoAdapter> {
  return TursoAdapterImpl.connect(opts);
}
