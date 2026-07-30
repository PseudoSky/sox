/**
 * _adapter_meta table infrastructure.
 *
 * Each adapter stamps an _adapter_meta table on first open, enabling
 * built-in detection when a store's adapter type changes.  The stamp
 * is idempotent (INSERT OR IGNORE) and uses BEGIN IMMEDIATE to avoid
 * races on multi-process WAL stores.
 *
 * @module
 */

import { createRequire } from 'node:module';
import type { StoreAdapter, AdapterMeta } from './types.js';

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json') as { version: string };

// ── Constants ─────────────────────────────────────────────────────────────────

export const ADAPTER_META_KEYS = Object.freeze({
  ADAPTER_TYPE: 'adapter_type',
  ADAPTER_VERSION: 'adapter_version',
  CREATED_AT: 'created_at',
} as const);

// ── Table / statement SQL ────────────────────────────────────────────────────

const META_TABLE = '_adapter_meta';
const CREATE_META_TABLE = `CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
const SELECT_ALL_META = `SELECT key, value FROM ${META_TABLE}`;
const STAMP_SQL = `INSERT OR IGNORE INTO ${META_TABLE}(key, value) VALUES (?, ?)`;

// ── ensureAdapterMetaTable ────────────────────────────────────────────────────

/**
 * Create the `_adapter_meta` table if it does not already exist.
 * Called by the adapter's own `init()` lifecycle hook — not by consumers.
 */
export async function ensureAdapterMetaTable(adapter: StoreAdapter): Promise<void> {
  await adapter.exec(CREATE_META_TABLE);
}

// ── stampAdapterMeta ──────────────────────────────────────────────────────────

/**
 * Stamp the store's adapter type and package version into `_adapter_meta`.
 *
 * Uses `BEGIN IMMEDIATE` to safely serialise the stamp across processes,
 * and `INSERT OR IGNORE` for idempotency — the first writer wins.
 *
 * Silently no-ops when the adapter is opened read-only (the stamp is a
 * "first writer" marker, not a read requirement).
 */
export async function stampAdapterMeta(
  adapter: StoreAdapter,
  type: 'sqlite' | 'turso',
): Promise<void> {
  // Read-only stores must not attempt to write the stamp
  if (adapter.config.readonly === true) return;

  await adapter.transaction(async (tx) => {
    await tx.executeRun(STAMP_SQL, [ADAPTER_META_KEYS.ADAPTER_TYPE, type]);
    await tx.executeRun(STAMP_SQL, [ADAPTER_META_KEYS.ADAPTER_VERSION, PKG_VERSION]);
    await tx.executeRun(STAMP_SQL, [ADAPTER_META_KEYS.CREATED_AT, new Date().toISOString()]);
  }, { mode: 'immediate' });
}

// ── readAdapterMeta ───────────────────────────────────────────────────────────

/**
 * Read the current `_adapter_meta` values.
 *
 * Returns an `AdapterMeta` object with `null` for any key that was never
 * stamped.  Does **not** throw if the table doesn't exist — that case
 * silently returns all-null fields.
 */
export async function readAdapterMeta(adapter: StoreAdapter): Promise<AdapterMeta> {
  let rows: { key: string; value: string }[];
  try {
    const result = await adapter.executeAll<{ key: string; value: string }>(SELECT_ALL_META);
    rows = result.rows;
  } catch {
    // Table doesn't exist (or any transient I/O error) → all-null meta
    return { adapter_type: null, adapter_version: null, created_at: null };
  }

  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.key, row.value);
  }

  return {
    adapter_type: (map.get(ADAPTER_META_KEYS.ADAPTER_TYPE) ?? null) as 'sqlite' | 'turso' | null,
    adapter_version: map.get(ADAPTER_META_KEYS.ADAPTER_VERSION) ?? null,
    created_at: map.get(ADAPTER_META_KEYS.CREATED_AT) ?? null,
  };
}

// ── detectAdapterChange ───────────────────────────────────────────────────────

/**
 * Detect whether the adapter type stored in `_adapter_meta` differs from
 * the requested type — useful for catching accidental store re-open with
 * the wrong adapter.
 *
 * Returns `false` when the meta row is absent (fresh / unstamped store).
 */
export async function detectAdapterChange(
  adapter: StoreAdapter,
  requestedType: 'sqlite' | 'turso',
): Promise<boolean> {
  const meta = await readAdapterMeta(adapter);
  if (meta.adapter_type === null) return false;
  return meta.adapter_type !== requestedType;
}
