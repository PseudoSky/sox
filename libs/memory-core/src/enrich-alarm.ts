/**
 * enrich-alarm.ts — BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001.
 *
 * The tiered escalation state machine that replaces `checkAndEscalateEnrichStall`
 * (BL-413). The pre-fix escalation was cleared by ANY non-stalled tick, so the
 * live 2026-08-26 outage read `enrichment.state: 'ok'` with the escalation
 * cleared WHILE nothing had succeeded in >24h: the 15-min stall window plus a
 * fresh queue (rows <15min old) read healthy, and each "healthy" tick cleared
 * the one durable record that said otherwise. The escalation-cleared bug.
 *
 * This machine keys off the NEW honest verdict (`computePipelineHealthVerdict`):
 *   watch → warn → crit, one tier per consecutive non-ok tick.
 *   - 1st non-ok tick → watch; 2nd → warn;
 *   - >= critTicks (config.alarm.critTicks, default 4) OR 2 consecutive
 *     negative-drain windows with backlog → crit.
 *   - crit LATCHES while the verdict stays non-ok — a merely-running tick can
 *     never silently clear it. It clears ONLY on a genuinely ok verdict (fresh
 *     success + success-rate floor + non-negative drain) or an operator
 *     `ack_alarm`.
 *   - `ack_alarm` pauses re-escalation (state `acknowledged`); `resume` re-arms
 *     a fresh escalation cycle.
 *
 * The record is persisted to `sox_store_meta` (key `enrich_alarm`) so it
 * survives restarts, and carries the per-action auto-heal audit trail
 * (`auto_heal_actions[]`) the rate-limited self-heal records against.
 */

import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { resolveEnrichHealthConfig } from './config.js';
import { log } from './telemetry.js';
import { MEMORY_CORE_STAGES } from './stages.js';
import type { PipelineHealthState } from './enrich-health.js';

const ALARM_META_KEY = 'enrich_alarm';

export type EnrichAlarmLevel = 'watch' | 'warn' | 'crit';
export type EnrichAlarmState = EnrichAlarmLevel | 'acknowledged';

/** One rate-limited corrective action taken during an alarm window. */
export interface EnrichAutoHealAction {
  /** ISO timestamp the action was taken. */
  at: string;
  /** Action discriminator: 'reinit_embed' | 'drain' | 'isolated_pass'. */
  action: string;
  /** Whether the action reported success. */
  ok: boolean;
  /** Free-text detail (error message, drained count, etc). */
  detail?: string;
}

export interface EnrichAlarmRecord {
  /** Current escalation level (last raised). */
  level: EnrichAlarmLevel;
  /** ISO timestamp the CURRENT level was first raised. */
  raised_at: string;
  /** Consecutive non-ok ticks observed so far. */
  consecutive_non_ok_ticks: number;
  /** Live state incl. `acknowledged` (operator ack pauses re-escalation). */
  state: EnrichAlarmState;
  queue_depth: number;
  embed_backlog: number;
  /** Rows currently quarantined (poisoned) — the systemic tell for a
   *  "Model not initialized" burst that parks rows instead of failing loudly. */
  poisoned_rows: number;
  last_isolated_error: string | null;
  last_embed_error: string | null;
  acknowledged_at: string | null;
  auto_heal_actions: EnrichAutoHealAction[];
}

export interface EnrichAlarmCheckInput {
  /** The honest verdict state for this tick. */
  verdictState: PipelineHealthState;
  queueDepth: number;
  embedBacklog: number;
  /** Rows currently quarantined (poisoned) — a non-zero count is itself a
   *  regression signal that escalates the alarm (at least to warn). */
  poisonedRows: number;
  lastIsolatedError: string | null;
  lastEmbedError: string | null;
  /** The most recent pass's net drain (`backlog_before - backlog_after`). */
  netDrained: number;
}

// ── Meta-json read/write (same pattern as enrich-stall.ts / enrich-health.ts) ─

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

// ── In-process counters (a fresh process restarts its own count; the persisted
//    record's raised_at is what tells an operator how long this really is) ────

/** Consecutive negative-drain windows per dbPath — the "2 consecutive negative
 *  drains → crit" accelerator, tracked in-process (not persisted; the persisted
 *  record already captures the escalation the tick eventually takes). */
const consecutiveNegativeDrain = new Map<string, number>();

/** Test-only: reset in-process counters between spec files/cases. */
export function _resetEnrichAlarmStateForTest(): void {
  consecutiveNegativeDrain.clear();
}

// ── Read / ack / resume ───────────────────────────────────────────────────────

export async function readEnrichAlarm(adapter: StoreAdapter): Promise<EnrichAlarmRecord | null> {
  return readMetaJson<EnrichAlarmRecord>(adapter, ALARM_META_KEY);
}

/**
 * Operator acknowledgement — pauses re-escalation. Sets (or extends) the record
 * into `state: 'acknowledged'` with `acknowledged_at`. If no alarm exists, this
 * is a no-op returning null. Idempotent.
 */
export async function acknowledgeEnrichAlarm(adapter: StoreAdapter): Promise<EnrichAlarmRecord | null> {
  const existing = await readEnrichAlarm(adapter);
  if (!existing) return null;
  const now = new Date().toISOString();
  const next: EnrichAlarmRecord = {
    ...existing,
    state: 'acknowledged',
    acknowledged_at: now,
  };
  await writeMetaJson(adapter, ALARM_META_KEY, next);
  return next;
}

/**
 * Operator resume — clears the alarm record entirely (including the
 * `acknowledged` latch) so a fresh non-ok tick starts a new watch→warn→crit
 * cycle. Idempotent.
 */
export async function resumeEnrichAlarm(adapter: StoreAdapter): Promise<void> {
  await clearMeta(adapter, ALARM_META_KEY);
}

/** Clear the alarm record (used by `reset_pipeline`). */
export async function resetEnrichAlarm(adapter: StoreAdapter): Promise<void> {
  await clearMeta(adapter, ALARM_META_KEY);
}

// ── Escalation ────────────────────────────────────────────────────────────────

/**
 * Check + escalate the enrich/embed alarm once per tick. Consumes the SAME
 * honest verdict `computePipelineHealthVerdict` produced (never re-derives it),
 * so the alarm can never disagree with what memory_ping surfaces.
 *
 * Returns the (newly written) record when the verdict is non-ok, or null when
 * healthy — in which case any prior record is cleared (a genuinely-recovered
 * pipeline must not masquerade as still-alarming). A crit that latched stays
 * crit while the verdict stays non-ok, regardless of how many ticks run.
 */
export async function checkAndEscalateEnrichAlarm(
  adapter: StoreAdapter,
  dbPath: string,
  input: EnrichAlarmCheckInput,
): Promise<EnrichAlarmRecord | null> {
  // Wired into the `enrich.alarm` stage (escalate path) so the alarm plane's
  // own execution is visible to telemetrySelfCheck — an escalation that stops
  // running is the escalation-cleared bug in a different costume.
  return MEMORY_CORE_STAGES.withContendedStage(
    'enrich.alarm',
    'escalate',
    async () => { /* admission is the existing-record read, inside _escalate */ },
    () => _checkAndEscalateEnrichAlarm(adapter, dbPath, input),
  );
}

async function _checkAndEscalateEnrichAlarm(
  adapter: StoreAdapter,
  dbPath: string,
  input: EnrichAlarmCheckInput,
): Promise<EnrichAlarmRecord | null> {
  const config = resolveEnrichHealthConfig();
  const healthy = input.verdictState === 'ok' || input.verdictState === 'idle';
  const existing = await readEnrichAlarm(adapter);

  if (healthy) {
    consecutiveNegativeDrain.delete(dbPath);
    if (existing) await clearMeta(adapter, ALARM_META_KEY);
    return null;
  }

  // Track negative-drain windows (crit accelerator).
  const negativeDrain = input.netDrained < 0 && input.embedBacklog > 0;
  if (negativeDrain) {
    consecutiveNegativeDrain.set(dbPath, (consecutiveNegativeDrain.get(dbPath) ?? 0) + 1);
  } else {
    consecutiveNegativeDrain.set(dbPath, 0);
  }
  const negativeDrainWindows = consecutiveNegativeDrain.get(dbPath) ?? 0;

  // Poison is a regression signal in its own right: a non-zero quarantine
  // count escalates AT LEAST to warn (a "Model not initialized" burst that
  // parks rows must be visible, not silent), and toward crit alongside the
  // existing consecutive-tick / negative-drain rules.
  const poisonActive = input.poisonedRows > 0;

  // Acknowledged → paused: do not re-escalate, do not advance ticks. Keep the
  // acknowledged record as-is so the operator's ack survives subsequent ticks.
  if (existing?.state === 'acknowledged') {
    return existing;
  }

  const ticks = (existing?.consecutive_non_ok_ticks ?? 0) + 1;

  let level: EnrichAlarmLevel;
  if (ticks >= config.alarm.critTicks || negativeDrainWindows >= 2) {
    level = 'crit';
  } else if (ticks >= 2 || poisonActive) {
    level = 'warn';
  } else {
    level = 'watch';
  }

  // LATCH: once crit, stay crit while non-ok (a running tick must never
  // downgrade a crit it has not recovered from).
  if (existing?.level === 'crit') {
    level = 'crit';
  }

  const now = new Date().toISOString();
  const record: EnrichAlarmRecord = {
    level,
    // raised_at records when the CURRENT level was first raised (unchanged
    // when the level did not change; refreshed on a fresh escalation).
    raised_at: existing && existing.level === level ? existing.raised_at : now,
    consecutive_non_ok_ticks: ticks,
    state: level,
    queue_depth: input.queueDepth,
    embed_backlog: input.embedBacklog,
    poisoned_rows: input.poisonedRows,
    last_isolated_error: input.lastIsolatedError,
    last_embed_error: input.lastEmbedError,
    acknowledged_at: existing?.acknowledged_at ?? null,
    auto_heal_actions: existing?.auto_heal_actions ?? [],
  };

  await writeMetaJson(adapter, ALARM_META_KEY, record);

  if (level === 'crit' || level === 'warn') {
    log.error('enrich.alarm.escalated', {
      db_path: dbPath,
      level,
      consecutive_non_ok_ticks: ticks,
      queue_depth: input.queueDepth,
      embed_backlog: input.embedBacklog,
      poisoned_rows: input.poisonedRows,
      negative_drain_windows: negativeDrainWindows,
      last_isolated_error: input.lastIsolatedError,
      last_embed_error: input.lastEmbedError,
    });
  } else {
    log.warn('enrich.alarm.watch', {
      db_path: dbPath,
      level,
      consecutive_non_ok_ticks: ticks,
      queue_depth: input.queueDepth,
      embed_backlog: input.embedBacklog,
      poisoned_rows: input.poisonedRows,
    });
  }

  return record;
}

/**
 * Record one auto-heal action against the current alarm record (rate-limited by
 * the caller). Appends to `auto_heal_actions` and re-persists. No-op when no
 * alarm is currently raised. Never throws.
 */
export async function recordAutoHealAction(
  adapter: StoreAdapter,
  action: EnrichAutoHealAction,
): Promise<void> {
  const existing = await readEnrichAlarm(adapter);
  if (!existing) return;
  const next: EnrichAlarmRecord = {
    ...existing,
    auto_heal_actions: [...existing.auto_heal_actions, action],
  };
  await writeMetaJson(adapter, ALARM_META_KEY, next);
}
