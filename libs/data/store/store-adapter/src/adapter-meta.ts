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
import { log } from '@adhd/sox-telemetry';
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
/**
 * (BL-336) UPSERT, not `INSERT OR IGNORE`.
 *
 * `INSERT OR IGNORE` relies on the PRIMARY KEY index to notice the conflict.
 * When that index is inconsistent — which is exactly what a bulk insert or a
 * crash leaves behind (BL-335) — the conflict goes unseen and the insert
 * lands, producing DUPLICATE PRIMARY KEY rows. The live store carries six rows
 * under three keys for precisely this reason: the second stamp at 17:46 landed
 * while the unique index was damaged. `ON CONFLICT DO UPDATE` also makes a
 * re-stamp refresh `adapter_version` instead of silently keeping a stale one.
 *
 * `created_at` is stamped with `DO NOTHING` — the FIRST stamp is the
 * meaningful one there, so it must not be overwritten on every open.
 */
const STAMP_SQL = `INSERT INTO ${META_TABLE}(key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
const STAMP_ONCE_SQL = `INSERT INTO ${META_TABLE}(key, value) VALUES (?, ?)
  ON CONFLICT(key) DO NOTHING`;

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
 * Uses `BEGIN IMMEDIATE` to safely serialise the stamp across processes, and
 * `ON CONFLICT` upserts so a re-stamp updates in place rather than duplicating
 * a PRIMARY KEY (BL-336 — see {@link STAMP_SQL}).
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
    await tx.executeRun(STAMP_ONCE_SQL, [ADAPTER_META_KEYS.CREATED_AT, new Date().toISOString()]);
  }, { mode: 'immediate' });
}

// ── Clean-shutdown marker (BL-338 crash-recovery flag) ────────────────────────

/** `_adapter_meta` key holding `'1'` when the last session closed cleanly. */
export const CLEAN_SHUTDOWN_KEY = 'clean_shutdown';

/**
 * Read-and-clear the clean-shutdown marker.
 *
 * Returns `true` when the PREVIOUS session did not record a clean close — the
 * store came back from a crash, a kill, or a power loss, which is exactly the
 * population that arrives with index damage nothing detects (BL-338). Callers
 * escalate verification depth on `true`.
 *
 * Always leaves the marker set to "unclean" for the duration of this session;
 * {@link markCleanShutdown} sets it back on an orderly close.
 */
export async function consumeUncleanShutdownFlag(adapter: StoreAdapter): Promise<boolean> {
  if (adapter.config.readonly === true) return false;
  try {
    const row = await adapter.executeGet<{ value: string }>(
      `SELECT value FROM ${META_TABLE} WHERE key = ?`,
      [CLEAN_SHUTDOWN_KEY],
    );
    const unclean = row !== null && row.value !== '1';
    await adapter.executeRun(STAMP_SQL, [CLEAN_SHUTDOWN_KEY, '0']);
    return unclean;
  } catch (err) {
    log.debug('store_adapter.meta.consume_unclean_failed', {
      db_path: adapter.config.dbPath,
      reason: 'table missing or transient error; assuming clean shutdown',
    });
    return false;
  }
}

/** Record that this session is closing in an orderly fashion. */
export async function markCleanShutdown(adapter: StoreAdapter): Promise<void> {
  if (adapter.config.readonly === true) return;
  try {
    await adapter.executeRun(STAMP_SQL, [CLEAN_SHUTDOWN_KEY, '1']);
  } catch (err) {
    // Non-fatal — a missing marker only escalates the next open's verify depth.
    log.debug('store_adapter.meta.mark_clean_shutdown_failed', {
      db_path: adapter.config.dbPath,
      reason: 'table missing or transient error; non-fatal, escalates next open verify depth',
    });
  }
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
  } catch (err) {
    // Table doesn't exist (or any transient I/O error) → all-null meta
    log.debug('store_adapter.meta.read_failed', {
      db_path: adapter.config.dbPath,
      reason: 'table missing or transient error; returning all-null meta',
    });
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
