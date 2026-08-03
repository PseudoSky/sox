/**
 * enrich-stall.ts — BL-413: durable corrective-action recording for a stalled
 * periodic enrichment pass.
 *
 * BEFORE this file existed: memory_ping's `enrichment.state` correctly
 * reported `"stalled"` (BL-172/BL-334's queue-drain SLO) but nothing ever
 * consumed that verdict. BL-413 measured it live on 2026-08-03: `queue_depth`
 * 46, `queue_last_done_at` 22.5 hours in the past, the stall condition true
 * for ~90 consecutive 15-minute threshold windows — and the only thing that
 * ever ran on that discovery was a `console.error` line in memory-server's
 * index.ts that never reached durable telemetry (it is plain stderr, not a
 * `log.*` call), so nothing downstream — not an operator, not a script, not
 * even a later `memory_ping` caller reading history — could ever see that the
 * stall had been going on for hours rather than one tick. A correct diagnosis
 * with no response is the defect (BL-334's own framing).
 *
 * This module is that response. `checkAndEscalateEnrichStall` is called once
 * per periodic-enrich tick (see memory-server's `runEnrichPassOnDb`) and,
 * when — and only when — the queue is genuinely stalled (mirrors
 * `computeEnrichmentHealth`'s own thresholding exactly; it is never told
 * anything computeEnrichmentHealth wasn't already told), takes a durable,
 * two-part corrective action:
 *
 *   1. Persists an escalation record into `sox_store_meta` (upsert, keyed
 *      `enrich_stall_escalation`) — queryable from the store itself,
 *      independent of any log file or process lifetime, and cleared the
 *      moment the queue recovers so a resolved incident never lingers as
 *      "still open".
 *   2. Emits a durable `enrich.stall.escalated` telemetry event via this
 *      package's own `log.error` (telemetry.ts) — the JSONL sink that
 *      write.ts/embed-pipeline.ts/db.ts already write through, so an
 *      operator tailing `~/.adhd/sox-ecosystem/memory/logs/memory-core-*.jsonl`
 *      sees the exact escalation a `console.error` line never reached.
 *
 * Both actions carry a monotonic `consecutive_stalled_ticks` counter (reset
 * the moment a tick observes a non-stalled queue) so the record distinguishes
 * "just crossed the threshold" from "still broken 90 ticks later" — the
 * distinction BL-413's live measurement needed and did not have.
 */

import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { log } from './telemetry.js';

const ESCALATION_META_KEY = 'enrich_stall_escalation';

export interface EnrichStallEscalation {
  escalated_at: string;
  consecutive_stalled_ticks: number;
  queue_depth: number;
  oldest_pending_at: string | null;
  last_done_at: string | null;
  last_isolated_error: string | null;
}

/** In-process consecutive-stall counters, keyed by resolved db path. A fresh
 *  process (e.g. after a restart) starts its own count rather than trusting
 *  an in-memory value that never existed — the persisted record's own
 *  `escalated_at` is what tells an operator how long this has really been
 *  going on across restarts. */
const consecutiveStalledTicks = new Map<string, number>();

/** Test-only: reset in-memory counters between spec files/cases. */
export function _resetEnrichStallStateForTest(): void {
  consecutiveStalledTicks.clear();
}

async function readMetaJson<T>(adapter: StoreAdapter, key: string): Promise<T | null> {
  const row = await adapter.executeGet<{ value: string }>(
    `SELECT value FROM sox_store_meta WHERE key = ?`,
    [key],
  );
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

async function writeMetaJson(adapter: StoreAdapter, key: string, value: unknown): Promise<void> {
  await adapter.executeRun(
    `INSERT INTO sox_store_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, JSON.stringify(value)],
  );
}

async function clearMeta(adapter: StoreAdapter, key: string): Promise<void> {
  await adapter.executeRun(`DELETE FROM sox_store_meta WHERE key = ?`, [key]);
}

/** Read the current persisted escalation record, or null if the store has
 *  never escalated (or the last escalation was already cleared by a
 *  subsequent recovered tick). */
export async function readEnrichStallEscalation(
  adapter: StoreAdapter,
): Promise<EnrichStallEscalation | null> {
  return readMetaJson<EnrichStallEscalation>(adapter, ESCALATION_META_KEY);
}

export interface EnrichStallCheckInput {
  state: 'idle' | 'ok' | 'stalled';
  queueDepth: number;
  oldestPendingAt: string | null;
  lastDoneAt: string | null;
  /** The isolated cluster pass's own error for this tick, if it failed —
   *  distinguishes "stalled because nothing has been enqueued" from
   *  "stalled because every attempt to drain it is failing". Null when the
   *  tick's isolated pass succeeded (or was skipped/never ran). */
  lastIsolatedError: string | null;
}

/**
 * BL-413: called once per periodic-enrich tick, after the tick has computed
 * the queue's current state via the SAME predicate `computeEnrichmentHealth`
 * uses (pass its `state` straight through — this function never re-derives
 * staleness itself, so it can never disagree with what `memory_ping` reports).
 *
 * Returns the (newly written) escalation record when the queue is stalled,
 * or null when it is not — in which case any prior escalation record is
 * actively cleared, so a resolved incident cannot masquerade as still open.
 */
export async function checkAndEscalateEnrichStall(
  adapter: StoreAdapter,
  dbPath: string,
  input: EnrichStallCheckInput,
): Promise<EnrichStallEscalation | null> {
  if (input.state !== 'stalled') {
    consecutiveStalledTicks.delete(dbPath);
    const existing = await readEnrichStallEscalation(adapter);
    if (existing) await clearMeta(adapter, ESCALATION_META_KEY);
    return null;
  }

  const count = (consecutiveStalledTicks.get(dbPath) ?? 0) + 1;
  consecutiveStalledTicks.set(dbPath, count);

  const escalation: EnrichStallEscalation = {
    escalated_at: new Date().toISOString(),
    consecutive_stalled_ticks: count,
    queue_depth: input.queueDepth,
    oldest_pending_at: input.oldestPendingAt,
    last_done_at: input.lastDoneAt,
    last_isolated_error: input.lastIsolatedError,
  };

  await writeMetaJson(adapter, ESCALATION_META_KEY, escalation);

  log.error('enrich.stall.escalated', {
    db_path: dbPath,
    queue_depth: input.queueDepth,
    oldest_pending_at: input.oldestPendingAt,
    last_done_at: input.lastDoneAt,
    consecutive_stalled_ticks: count,
    last_isolated_error: input.lastIsolatedError,
  });

  return escalation;
}
