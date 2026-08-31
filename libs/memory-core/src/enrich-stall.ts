/**
 * enrich-stall.ts — DEPRECATED escalation surface (BL-413), now delegating to
 * the tiered enrich/embed alarm (enrich-alarm.ts).
 *
 * BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001 supersedes this module's original
 * design. The old `checkAndEscalateEnrichStall` persisted an escalation record
 * keyed off the queue-freshness verdict (`computeEnrichmentHealth` in
 * memory-server), which read healthy during the 2026-08-26 >24h outage because
 * the 15-min stall window + fresh queue rows looked fine while nothing had
 * SUCCEEDED in hours. It also CLEARED the escalation on every non-stalled tick,
 * so the one durable record said "resolved" the whole time — the
 * escalation-cleared bug.
 *
 * The corrective action is now the tiered alarm (enrich-alarm.ts), which keys
 * off the honest `last_successful_pass_at` verdict and LATCHES crit until the
 * verdict is genuinely ok or an operator acknowledges. This module is kept as a
 * compatibility shim: `checkAndEscalateEnrichStall` delegates to
 * `checkAndEscalateEnrichAlarm` and translates the result back to the legacy
 * `EnrichStallEscalation` shape; `readEnrichStallEscalation` delegates to
 * `readEnrichAlarm` so existing readers keep working against the new record.
 * No new code should call the escalation surface here — use enrich-alarm.ts.
 */

import type { StoreAdapter } from '@adhd/sox-store-adapter';
import {
  checkAndEscalateEnrichAlarm,
  readEnrichAlarm,
  _resetEnrichAlarmStateForTest,
  type EnrichAlarmRecord,
} from './enrich-alarm.js';

/** @deprecated superseded by EnrichAlarmRecord (enrich-alarm.ts). Kept for
 *  compatibility with readers of the pre-BUG-MEMORYSERVER-EMBED-HEAL surface. */
export interface EnrichStallEscalation {
  escalated_at: string;
  consecutive_stalled_ticks: number;
  queue_depth: number;
  oldest_pending_at: string | null;
  last_done_at: string | null;
  last_isolated_error: string | null;
}

/** @deprecated superseded by EnrichAlarmCheckInput (enrich-alarm.ts). */
export interface EnrichStallCheckInput {
  state: 'idle' | 'ok' | 'stalled';
  queueDepth: number;
  oldestPendingAt: string | null;
  lastDoneAt: string | null;
  /** The isolated cluster pass's own error for this tick, if it failed. */
  lastIsolatedError: string | null;
}

/** @deprecated delegates to _resetEnrichAlarmStateForTest. */
export function _resetEnrichStallStateForTest(): void {
  _resetEnrichAlarmStateForTest();
}

/** Translate an alarm record back to the legacy escalation shape. The alarm
 *  does not persist `oldest_pending_at`/`last_done_at` (it is driven by the
 *  honest verdict, not queue-row age), so those carry through from the input or
 *  read null when absent. */
function toEscalation(alarm: EnrichAlarmRecord, oldestPendingAt?: string | null, lastDoneAt?: string | null): EnrichStallEscalation {
  return {
    escalated_at: alarm.raised_at,
    consecutive_stalled_ticks: alarm.consecutive_non_ok_ticks,
    queue_depth: alarm.queue_depth,
    oldest_pending_at: oldestPendingAt ?? null,
    last_done_at: lastDoneAt ?? null,
    last_isolated_error: alarm.last_isolated_error,
  };
}

/**
 * @deprecated use `checkAndEscalateEnrichAlarm` (enrich-alarm.ts). Delegates to
 * the tiered alarm, mapping the legacy queue-freshness `state` onto the new
 * verdict: 'stalled' → 'stalled', 'ok'/'idle' → healthy. Returns the translated
 * escalation when the verdict is non-ok, or null when healthy (and clears any
 * prior record).
 */
export async function checkAndEscalateEnrichStall(
  adapter: StoreAdapter,
  dbPath: string,
  input: EnrichStallCheckInput,
): Promise<EnrichStallEscalation | null> {
  const verdictState = input.state === 'stalled' ? 'stalled' : input.state === 'ok' ? 'ok' : 'idle';
  const alarm = await checkAndEscalateEnrichAlarm(adapter, dbPath, {
    verdictState,
    queueDepth: input.queueDepth,
    embedBacklog: 0,
    poisonedRows: 0,
    lastIsolatedError: input.lastIsolatedError,
    lastEmbedError: null,
    netDrained: 0,
  });
  if (!alarm) return null;
  return toEscalation(alarm, input.oldestPendingAt, input.lastDoneAt);
}

/**
 * @deprecated use `readEnrichAlarm` (enrich-alarm.ts). Kept as the read surface
 * so existing `memory_ping` readers keep working against the new record. The
 * legacy `oldest_pending_at`/`last_done_at` fields read null (the alarm does
 * not persist queue-row age).
 */
export async function readEnrichStallEscalation(
  adapter: StoreAdapter,
): Promise<EnrichStallEscalation | null> {
  const alarm = await readEnrichAlarm(adapter);
  if (!alarm) return null;
  return toEscalation(alarm);
}
