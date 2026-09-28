/**
 * _adapter_meta table infrastructure.
 *
 * Each adapter stamps an _adapter_meta table on first open, enabling
 * built-in detection when a store's adapter type changes.  The stamp
 * is idempotent (upserts), reads before it writes, and takes BEGIN
 * IMMEDIATE only when a value actually has to change.
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

const SELECT_STAMP_SQL = `SELECT key, value FROM ${META_TABLE} WHERE key IN (?, ?, ?)`;

type StampRow = { key: string; value: string };

/** Which stamp values differ from what this package would write. */
function stampDelta(
  rows: readonly StampRow[],
  type: 'sqlite' | 'turso',
): { type: boolean; version: boolean; createdAt: boolean } {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    type: map.get(ADAPTER_META_KEYS.ADAPTER_TYPE) !== type,
    version: map.get(ADAPTER_META_KEYS.ADAPTER_VERSION) !== PKG_VERSION,
    createdAt: !map.has(ADAPTER_META_KEYS.CREATED_AT),
  };
}

/**
 * (BL-1010e417 / 595e7daf) `true` when `_adapter_meta` already holds exactly
 * the stamp {@link stampAdapterMeta} would write: `adapter_type` and
 * `adapter_version` equal, and `created_at` present. A plain SELECT — no
 * transaction, no write lock, no WAL. A missing table (or any read failure)
 * reads as `false`, so the caller falls through to create-and-stamp.
 */
export async function adapterMetaIsCurrent(
  adapter: StoreAdapter,
  type: 'sqlite' | 'turso',
): Promise<boolean> {
  try {
    const { rows } = await adapter.executeAll<StampRow>(SELECT_STAMP_SQL, [
      ADAPTER_META_KEYS.ADAPTER_TYPE,
      ADAPTER_META_KEYS.ADAPTER_VERSION,
      ADAPTER_META_KEYS.CREATED_AT,
    ]);
    const d = stampDelta(rows, type);
    return !d.type && !d.version && !d.createdAt;
  } catch (err) {
    log.debug('store_adapter.meta.stamp_read_failed', {
      db_path: adapter.config.dbPath,
      error: err instanceof Error ? err.message : String(err),
      reason: 'stamp state unreadable (table missing on a fresh store is the normal case); the stamp will be written',
    });
    return false;
  }
}

/**
 * Stamp the store's adapter type and package version into `_adapter_meta`.
 *
 * (BL-1010e417 / 595e7daf) Write-free when nothing changed. Every reopen of a
 * store runs this, and a reopen happens after every idle release (about every
 * 30 s on a live server), so an unconditional `BEGIN IMMEDIATE` here took the
 * store's write lock on every reopen for a stamp that was already correct.
 * Now: a plain SELECT fast path returns with no transaction when
 * `adapter_type` and `adapter_version` match and `created_at` exists.
 * Otherwise it takes `BEGIN IMMEDIATE`, re-reads inside the lock (another
 * process may have stamped in between), and upserts only the values that
 * still differ.
 *
 * `ON CONFLICT` upserts update in place rather than duplicating a PRIMARY KEY
 * (BL-336 — see {@link STAMP_SQL}); `created_at` is written once and never
 * overwritten.
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

  if (await adapterMetaIsCurrent(adapter, type)) return;

  await adapter.transaction(async (tx) => {
    const { rows } = await tx.executeAll<StampRow>(SELECT_STAMP_SQL, [
      ADAPTER_META_KEYS.ADAPTER_TYPE,
      ADAPTER_META_KEYS.ADAPTER_VERSION,
      ADAPTER_META_KEYS.CREATED_AT,
    ]);
    const d = stampDelta(rows, type);
    if (d.type) await tx.executeRun(STAMP_SQL, [ADAPTER_META_KEYS.ADAPTER_TYPE, type]);
    if (d.version) await tx.executeRun(STAMP_SQL, [ADAPTER_META_KEYS.ADAPTER_VERSION, PKG_VERSION]);
    if (d.createdAt) {
      await tx.executeRun(STAMP_ONCE_SQL, [ADAPTER_META_KEYS.CREATED_AT, new Date().toISOString()]);
    }
  }, { mode: 'immediate' });
}

// ── Clean-shutdown marker (BL-338 crash-recovery flag) ────────────────────────

/** `_adapter_meta` key holding `'1'` when the last session closed cleanly. */
export const CLEAN_SHUTDOWN_KEY = 'clean_shutdown';

/**
 * Read-and-clear the clean-shutdown marker.
 *
 * **No adapter uses this any more (BL-fc5ab895).** Both adapters take their
 * crash signal from the per-connection dead-pid open marker
 * (`preflight.ts` `hasUncleanShutdown`). This shared flag was wrong in both
 * directions for any store with more than one connection: every open wrote
 * '0', so a healthy concurrent open read "unclean"; and the close-time write
 * back to '1' ({@link markCleanShutdown}) is a contended write that fails with
 * `database is locked` after busy_timeout whenever a peer holds the write lock
 * — 152 such failures on 2026-09-27 in the live service log, each one turning
 * the next open into a forced deep verification. Kept exported for external
 * callers of the package API.
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
    log.warn('store_adapter.meta.consume_unclean_failed', {
      db_path: adapter.config.dbPath,
      error: err instanceof Error ? err.message : String(err),
      reason: 'could not read/stamp the clean-shutdown flag; assuming clean shutdown',
    });
    return false;
  }
}

/** Record that this session is closing in an orderly fashion. Unused by the
 *  adapters since BL-fc5ab895 — see {@link consumeUncleanShutdownFlag}. */
export async function markCleanShutdown(adapter: StoreAdapter): Promise<void> {
  if (adapter.config.readonly === true) return;
  try {
    await adapter.executeRun(STAMP_SQL, [CLEAN_SHUTDOWN_KEY, '1']);
  } catch (err) {
    // Non-fatal — but the REAL error is logged: the old constant reason
    // ("table missing or transient error") hid the actual cause,
    // `database is locked` under a peer's write lock (BL-fc5ab895).
    log.warn('store_adapter.meta.mark_clean_shutdown_failed', {
      db_path: adapter.config.dbPath,
      error: err instanceof Error ? err.message : String(err),
      reason: 'clean-shutdown flag write failed; a caller relying on this flag will read the next open as unclean',
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

// ── Store-growth meta (BL-c5249cdd) ───────────────────────────────────────────

/**
 * `_adapter_meta` keys behind `memory_ping`'s store-growth gauge.
 *
 * `fts_optimize_passes_since_rebuild` counts in-service `OPTIMIZE INDEX` passes
 * (the turso adapter's idle-flush FTS maintenance). Measured on
 * `@tursodatabase/database` 0.7.1 and 0.7.2: interleaved insert+OPTIMIZE rounds
 * orphan the merged-away FTS segments, so page_count grows with this counter
 * while a single OPTIMIZE over the same corpus does not. Only an offline
 * `VACUUM INTO` rebuild (`memory fts-rebuild`) reclaims the space; the rebuild
 * resets the counter to 0 and stamps `last_rebuild_at` in the rebuilt file.
 */
export const STORE_GROWTH_META_KEYS = Object.freeze({
  FTS_OPTIMIZE_PASSES_SINCE_REBUILD: 'fts_optimize_passes_since_rebuild',
  LAST_REBUILD_AT: 'last_rebuild_at',
} as const);

/** One in-service OPTIMIZE pass: increment the persisted counter (row created
 *  at 1 when absent). A single self-contained statement so the adapter can run
 *  it through its raw driver handle without `_trackOp` (BUG-022). */
export const FTS_OPTIMIZE_PASS_INCREMENT_SQL = `INSERT INTO ${META_TABLE}(key, value) VALUES ('${STORE_GROWTH_META_KEYS.FTS_OPTIMIZE_PASSES_SINCE_REBUILD}', '1')
  ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`;

/** Upsert statement for a store-growth key (rebuild reset). Parameters: key, value. */
export const STORE_GROWTH_META_UPSERT_SQL = STAMP_SQL;

/** Create-if-missing for `_adapter_meta`, for callers holding a raw driver handle. */
export const ADAPTER_META_CREATE_SQL = CREATE_META_TABLE;

export interface StoreGrowthMeta {
  /** In-service OPTIMIZE passes since the last rebuild; `null` when never
   *  counted (a store that predates the counter, or has never optimized). */
  ftsOptimizePassesSinceRebuild: number | null;
  /** ISO timestamp of the last `memory fts-rebuild` swap; `null` when never rebuilt. */
  lastRebuildAt: string | null;
}

/**
 * Read the store-growth keys. Never throws: a missing table or a transient
 * read error is logged and reads as all-null (the gauge then reports the
 * counter as unknown, never as 0).
 */
export async function readStoreGrowthMeta(adapter: StoreAdapter): Promise<StoreGrowthMeta> {
  try {
    const { rows } = await adapter.executeAll<{ key: string; value: string }>(
      `SELECT key, value FROM ${META_TABLE} WHERE key IN (?, ?)`,
      [STORE_GROWTH_META_KEYS.FTS_OPTIMIZE_PASSES_SINCE_REBUILD, STORE_GROWTH_META_KEYS.LAST_REBUILD_AT],
    );
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const rawPasses = map.get(STORE_GROWTH_META_KEYS.FTS_OPTIMIZE_PASSES_SINCE_REBUILD);
    const passes = rawPasses === undefined ? null : Number(rawPasses);
    return {
      ftsOptimizePassesSinceRebuild: passes !== null && Number.isFinite(passes) ? passes : null,
      lastRebuildAt: map.get(STORE_GROWTH_META_KEYS.LAST_REBUILD_AT) ?? null,
    };
  } catch (err) {
    log.debug('store_adapter.meta.read_growth_failed', {
      db_path: adapter.config.dbPath,
      error: err instanceof Error ? err.message : String(err),
      reason: 'table missing or transient error; growth meta reads as unknown',
    });
    return { ftsOptimizePassesSinceRebuild: null, lastRebuildAt: null };
  }
}
