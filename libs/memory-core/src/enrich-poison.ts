/**
 * enrich-poison.ts — BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001.
 *
 * The embed/enrich heal loop previously re-attempted the SAME failing rows on
 * every tick forever: with the shared fastembed child in a "Model not
 * initialized" state (BUG-021), 235 embed errors and 212 heal-row failures were
 * recorded on 2026-08-26 while the pipeline spun on an identical head-of-queue
 * window — no forward progress, no signal, and no way for the self-heal to get
 * past the poison. A row that fails embed N times is not "still waiting to be
 * healed", it is POISONING the heal window (every tick burns its whole budget
 * re-attempting rows that will keep failing until the root cause is fixed).
 *
 * This module records per-row embed/enrich failures in an `enrich_poison` table
 * (schema.ts) and defines the threshold gate the heal scan consults to EXCLUDE
 * a poisoned row from its retry window. The row itself is NEVER dropped and
 * NEVER mutated: it stays in `node`, fully recallable via BM25/temporal.
 *
 * BOUNDED QUARANTINE (2026-08-30 correction): the exclusion is TIME-BOUNDED,
 * not permanent. A row is quarantined only while `failures >= poisonThreshold`
 * AND its `last_failed_at` is within the `poisonReentryMs` cool-down window —
 * once that window elapses it re-enters the next heal scan AUTOMATICALLY, with
 * no operator action. Re-entry also happens on cause-clear: a successful embed
 * clears the row, `reinitEmbedProvider`/`reset_pipeline` clears the whole
 * table. `unpoisonRow` remains the operator fast-path. The current quarantine
 * count is surfaced via memory_ping (`enrichment.health.poisoned_rows`) and
 * feeds the alarm, so a systemic "Model not initialized" burst is visible
 * while it lasts rather than silently parking rows forever.
 */

import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { resolveEnrichHealthConfig } from './config.js';

export interface PoisonedRow {
  uid: string;
  failures: number;
  last_error: string | null;
  first_poisoned_at: string;
  last_failed_at: string;
}

/**
 * The poison threshold: a row is excluded from the heal scan once its
 * `failures` count reaches this value. Read from the typed config (default 3).
 */
export function poisonThreshold(): number {
  return resolveEnrichHealthConfig().poisonThreshold;
}

/**
 * The cool-down window after which a poisoned row (failures >= threshold) is
 * automatically re-admitted to the heal scan WITHOUT operator action — the
 * bounded-quarantine half of the circuit breaker (see config.poisonReentryMs).
 */
export function poisonReentryMs(): number {
  return resolveEnrichHealthConfig().poisonReentryMs;
}

/**
 * The ISO timestamp boundary of the reentry window: a poisoned row whose
 * `last_failed_at` is BEFORE this boundary is no longer quarantined and
 * re-enters the next heal scan. Passed as the SQL bound in the heal scan's
 * exclusion predicate and the poison-count query.
 */
export function poisonReentryBoundary(nowMs: number): string {
  return new Date(nowMs - poisonReentryMs()).toISOString();
}

/**
 * Record a single embed/enrich failure for a row (upsert, ON CONFLICT-safe).
 * `failures` increments by 1; `last_error`/`last_failed_at` reflect this
 * failure; `first_poisoned_at` is set once and never overwritten. Returns the
 * new failure count. Never throws (bookkeeping must not fail the heal loop).
 */
export async function recordRowFailure(
  adapter: StoreAdapter,
  uid: string,
  error: string | null,
): Promise<number> {
  const now = new Date().toISOString();
  const res = await adapter.executeRun(
    `INSERT INTO enrich_poison (uid, failures, last_error, first_poisoned_at, last_failed_at)
     VALUES (?, 1, ?, ?, ?)
     ON CONFLICT(uid) DO UPDATE SET
       failures = enrich_poison.failures + 1,
       last_error = excluded.last_error,
       last_failed_at = excluded.last_failed_at`,
    [uid, error, now, now],
  );
  const row = await adapter.executeGet<{ failures: number }>(
    `SELECT failures FROM enrich_poison WHERE uid = ?`,
    [uid],
  );
  void res;
  return row?.failures ?? 1;
}

/**
 * Remove a single row from the poison table — the operator surface
 * (`memory_curate unpoison`) re-admits it to the next heal scan. Idempotent.
 */
export async function unpoisonRow(adapter: StoreAdapter, uid: string): Promise<void> {
  await adapter.executeRun(`DELETE FROM enrich_poison WHERE uid = ?`, [uid]);
}

/**
 * Remove every row from the poison table — `memory_curate reset_pipeline`
 * clears the whole poisoning ledger. Returns the number of rows removed.
 */
export async function unpoisonAll(adapter: StoreAdapter): Promise<number> {
  const res = await adapter.executeRun(`DELETE FROM enrich_poison`);
  return res.rowsAffected;
}

/**
 * List every poisoned row, most-recently-failed first. Read-only.
 */
export async function listPoisonedRows(adapter: StoreAdapter): Promise<PoisonedRow[]> {
  const res = await adapter.executeAll<PoisonedRow>(
    `SELECT uid, failures, last_error, first_poisoned_at, last_failed_at
     FROM enrich_poison ORDER BY last_failed_at DESC`,
  );
  return res.rows;
}

/**
 * Count rows CURRENTLY quarantined — `failures >= poisonThreshold` AND
 * `last_failed_at` still within the reentry cool-down window (i.e. the rows the
 * heal scan is actively skipping right now). A row whose `last_failed_at` has
 * aged past `poisonReentryMs` has re-entered the scan and is NOT counted. This
 * is the `enrichment.health.poisoned_rows` surface AND the alarm's poison input.
 */
export async function countPoisonedRows(adapter: StoreAdapter, nowMs: number = Date.now()): Promise<number> {
  const row = await adapter.executeGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM enrich_poison WHERE failures >= ? AND last_failed_at >= ?`,
    [poisonThreshold(), poisonReentryBoundary(nowMs)],
  );
  return row?.c ?? 0;
}

/**
 * True when a row is currently quarantined (failures >= threshold AND
 * `last_failed_at` within the reentry window) — i.e. the heal scan is skipping
 * it right now. A row whose reentry window has elapsed is no longer quarantined.
 * Read-only; used by tests and the `unpoison` dry-run path.
 */
export async function isRowPoisoned(adapter: StoreAdapter, uid: string, nowMs: number = Date.now()): Promise<boolean> {
  const row = await adapter.executeGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM enrich_poison WHERE uid = ? AND failures >= ? AND last_failed_at >= ?`,
    [uid, poisonThreshold(), poisonReentryBoundary(nowMs)],
  );
  return (row?.c ?? 0) > 0;
}
