/**
 * Auto-detect adapter type from env vars (STORE_ADAPTER).
 * Falls back to 'turso' if unset.
 * Source code that hardcodes the adapter type should use
 * createSqliteAdapter() or createTursoAdapter() directly.
 */
import type {
  StoreAdapter,
  SqliteAdapter,
  TursoAdapter,
  AdapterConfig,
} from './types.js';
import { SqliteAdapterImpl } from './sqlite-adapter.js';
import { TursoAdapterImpl } from './turso-adapter.js';

// ── createStoreAdapter — env-driven auto-detect ──────────────────────────────

export async function createStoreAdapter(config?: Partial<AdapterConfig>): Promise<StoreAdapter> {
  const adapterType = (process.env.STORE_ADAPTER || 'turso').toLowerCase();

  if (adapterType === 'sqlite') {
    const dbPath = config?.dbPath || process.env.SOX_CONFIG_DB_PATH;
    if (!dbPath) {
      throw new Error(
        'createStoreAdapter: type=sqlite requires a dbPath. Set SOX_CONFIG_DB_PATH or pass config.dbPath.',
      );
    }
    const sqliteOpts: { dbPath: string; readonly?: boolean; statementCacheSize?: number } = { dbPath };
    if (config?.readonly !== undefined) sqliteOpts.readonly = config.readonly;
    return createSqliteAdapter(sqliteOpts);
  }

  if (adapterType === 'turso') {
    const tursoOpts: Parameters<typeof createTursoAdapter>[0] = {};
    const url = config?.url || process.env.TURSO_DB_URL;
    if (url !== undefined) tursoOpts.url = url;
    if (config?.dbPath !== undefined) tursoOpts.dbPath = config.dbPath;
    const authToken = config?.authToken || process.env.TURSO_AUTH_TOKEN;
    if (authToken !== undefined) tursoOpts.authToken = authToken;
    if (config?.readonly !== undefined) tursoOpts.readonly = config.readonly;
    if (config?.experimental !== undefined) tursoOpts.experimental = config.experimental;
    return createTursoAdapter(tursoOpts);
  }

  throw new Error(
    `Unknown STORE_ADAPTER value: "${adapterType}". Expected "sqlite" or "turso".`,
  );
}

// ── createSqliteAdapter — explicit, narrowed return type ──────────────────────

export function createSqliteAdapter(
  opts: { dbPath: string; readonly?: boolean; statementCacheSize?: number },
): SqliteAdapter;
export function createSqliteAdapter(
  db: import('better-sqlite3').Database,
): SqliteAdapter;
export function createSqliteAdapter(
  dbOrOpts:
    | { dbPath: string; readonly?: boolean; statementCacheSize?: number }
    | import('better-sqlite3').Database,
): SqliteAdapter {
  if (typeof dbOrOpts === 'object' && 'dbPath' in dbOrOpts) {
    const ctorOpts: { readonly?: boolean } = {};
    if (dbOrOpts.readonly !== undefined) ctorOpts.readonly = dbOrOpts.readonly;
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
    experimental?: { multiprocessWal?: boolean };
  },
): Promise<TursoAdapter> {
  return TursoAdapterImpl.connect(opts);
}
