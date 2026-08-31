/**
 * enrich-health.ts — BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001.
 *
 * The embed/enrich pipeline's HONEST health ledger and verdict. The pre-fix
 * verdict (`computeEnrichmentHealth` in memory-server's index.ts) derived
 * `ok`/`stalled` from queue freshness alone — the age of the NEWEST pending
 * row — so a >24h outage read `ok` the whole time: the 15-min stall window plus
 * queue rows <15min old looked healthy while nothing had SUCCEEDED in hours
 * (127 enrich.pass.failed, 235 embed.error, 212 heal-row failures on
 * 2026-08-26). Fresh rows can never prove the pipeline works; only a recent
 * SUCCESSFUL pass can.
 *
 * The honest signal is `last_successful_pass_at`. `ok` now REQUIRES all of:
 *   - `last_successful_pass_at` within `stallThresholdMs` (a real success, recently);
 *   - success-rate (passes_ok / passes_total) >= `successRateFloor` once
 *     `minPasses` passes have run;
 *   - `net_drained >= 0` while backlog > 0 (the backlog is not growing).
 * A non-empty backlog with a stale (or never-set) `last_successful_pass_at`
 * reads `stalled`; a fresh success but a below-floor success rate or a negative
 * drain reads `regressing`. Backlog 0 reads `idle`. Fresh rows alone can NEVER
 * read `ok` — they are not consulted for freshness at all.
 *
 * The ledger lives in `sox_store_meta` (key `enrich_health_ledger`), so it
 * survives process restarts and is readable independently of the in-process
 * tick that wrote it — the same read/write pattern enrich-stall.ts established
 * (readMetaJson/writeMetaJson copied here rather than imported, keeping this
 * module side-effect-free of enrich-stall's deprecation transition).
 */

import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { resolveEnrichHealthConfig, type EnrichHealthConfig } from './config.js';
import { log } from './telemetry.js';
import { MEMORY_CORE_STAGES } from './stages.js';

const LEDGER_META_KEY = 'enrich_health_ledger';

// ── Ledger shape ──────────────────────────────────────────────────────────────

export interface EnrichHealthLedger {
  /** ISO timestamp of the most recent enrich/embed pass (success or failure). */
  last_pass_at: string | null;
  /** Whether the most recent pass succeeded (its isolated cluster stage did not fail). */
  last_pass_ok: boolean;
  /** ISO timestamp of the most recent pass that actually SUCCEEDED — the honest
   *  freshness signal. null until the first success (or after a reset). */
  last_successful_pass_at: string | null;
  /** ISO timestamp of the most recent embed that completed (any row). */
  last_successful_embed_at: string | null;
  // ── window counters (cumulative since the last reset) ──────────────────────
  passes_ok: number;
  passes_failed: number;
  embeds_completed: number;
  embeds_failed: number;
  heals_applied: number;
  heals_failed: number;
  /** Rows the most recent pass SKIPPED because they were quarantined (poisoned).
   *  Distinct from `heals_applied`/`heals_failed` — poison is parking, not
   *  healing, and must never read as progress. */
  poisoned_skipped: number;
  /** Backlog count at the START and END of the most recent pass. */
  backlog_before: number;
  backlog_after: number;
  /** `backlog_before - backlog_after` of the most recent pass: negative means
   *  the backlog GREW during that pass — the regression signal. Poison-skipped
   *  rows remain in `backlog_after`, so they are NOT counted as drained. */
  net_drained: number;
}

export const EMPTY_ENRICH_HEALTH_LEDGER: EnrichHealthLedger = {
  last_pass_at: null,
  last_pass_ok: false,
  last_successful_pass_at: null,
  last_successful_embed_at: null,
  passes_ok: 0,
  passes_failed: 0,
  embeds_completed: 0,
  embeds_failed: 0,
  heals_applied: 0,
  heals_failed: 0,
  poisoned_skipped: 0,
  backlog_before: 0,
  backlog_after: 0,
  net_drained: 0,
};

// ── Meta-json read/write (copied from enrich-stall.ts's pattern) ──────────────

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

// ── Read / record ─────────────────────────────────────────────────────────────

/** Read the current persisted health ledger, or the empty ledger when the store
 *  has never recorded a pass. */
export async function readEnrichHealthLedger(adapter: StoreAdapter): Promise<EnrichHealthLedger> {
  const existing = await readMetaJson<EnrichHealthLedger>(adapter, LEDGER_META_KEY);
  if (!existing) return { ...EMPTY_ENRICH_HEALTH_LEDGER };
  return {
    ...EMPTY_ENRICH_HEALTH_LEDGER,
    ...existing,
  };
}

/** The inputs a completed enrich/embed pass reports back for the ledger. */
export interface EnrichPassRecord {
  /** Whether the pass's isolated cluster stage succeeded (the "pass" outcome). */
  ok: boolean;
  embeds_completed: number;
  embeds_failed: number;
  heals_applied: number;
  heals_failed: number;
  /** Rows skipped due to poison this pass (parked, not healed). */
  poisoned_skipped: number;
  backlog_before: number;
  backlog_after: number;
}

/**
 * Record one completed pass into the durable ledger and return the updated
 * ledger. Pure bookkeeping: called once per enrich tick AFTER the tick's work
 * has landed. A pass that embeds ≥1 row also advances `last_successful_embed_at`.
 * Never throws — bookkeeping must not fail the tick.
 */
export async function recordEnrichPass(
  adapter: StoreAdapter,
  record: EnrichPassRecord,
): Promise<EnrichHealthLedger> {
  const prev = await readEnrichHealthLedger(adapter);
  const now = new Date().toISOString();
  const ok = record.ok;

  const next: EnrichHealthLedger = {
    last_pass_at: now,
    last_pass_ok: ok,
    last_successful_pass_at: ok ? now : prev.last_successful_pass_at,
    last_successful_embed_at:
      record.embeds_completed > 0 ? now : prev.last_successful_embed_at,
    passes_ok: prev.passes_ok + (ok ? 1 : 0),
    passes_failed: prev.passes_failed + (ok ? 0 : 1),
    embeds_completed: prev.embeds_completed + record.embeds_completed,
    embeds_failed: prev.embeds_failed + record.embeds_failed,
    heals_applied: prev.heals_applied + record.heals_applied,
    heals_failed: prev.heals_failed + record.heals_failed,
    poisoned_skipped: record.poisoned_skipped,
    backlog_before: record.backlog_before,
    backlog_after: record.backlog_after,
    net_drained: record.backlog_before - record.backlog_after,
  };

  await writeMetaJson(adapter, LEDGER_META_KEY, next);
  return next;
}

/** Clear the persisted ledger — `memory_curate reset_pipeline`. Returns void. */
export async function resetEnrichHealthLedger(adapter: StoreAdapter): Promise<void> {
  await clearMeta(adapter, LEDGER_META_KEY);
}

// ── Verdict ───────────────────────────────────────────────────────────────────

export type PipelineHealthState = 'idle' | 'ok' | 'regressing' | 'stalled';

export interface ComputePipelineHealthInput {
  /** Epoch ms the verdict is being computed at. */
  nowMs: number;
  /** Current embed backlog (live episodes missing their vec_node row). */
  backlog: number;
  /** The persisted ledger (read via readEnrichHealthLedger). */
  ledger: EnrichHealthLedger;
  /**
   * (BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001) Rows CURRENTLY quarantined
   * (poisoned, within the reentry window) — from `countPoisonedRows`. When > 0
   * the pipeline is PARKING rows, not healing them, so the verdict can never
   * read `ok`. Optional (defaults 0) so pure-ledger callers/tests are unchanged.
   */
  poisonedRows?: number;
  /** Optional config override (tests; defaults via resolveEnrichHealthConfig). */
  config?: EnrichHealthConfig;
}

export interface PipelineHealthVerdict {
  state: PipelineHealthState;
  /** Human-readable reasons the verdict is not `ok`/`idle` (empty when healthy). */
  reasons: string[];
}

/**
 * Compute the honest pipeline-health verdict. Pure (no I/O — the caller supplies
 * the ledger). The freshness signal is `ledger.last_successful_pass_at`, never
 * the age of the newest queue row — a fresh queue with a stale success reads
 * `stalled`, exactly the 2026-08-26 outage shape the pre-fix verdict missed.
 *
 * BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001 (honest progress): a non-zero
 * `poisonedRows` count forces the verdict to at worst `regressing` (or `stalled`
 * if also stale) — a zero-poison pipeline is the ONLY one that can read `ok`.
 * Poison is parking, not healing: a queue of parked rows must never masquerade
 * as "ok, draining".
 */
export function computePipelineHealthVerdict(input: ComputePipelineHealthInput): PipelineHealthVerdict {
  const config = input.config ?? resolveEnrichHealthConfig();
  const reasons: string[] = [];
  const poisonedRows = input.poisonedRows ?? 0;
  const poisonReason = (): string =>
    `${poisonedRows} row(s) poisoned/quarantined — parked, not healing`;

  // Empty backlog: nothing pending — idle, regardless of past failures.
  // (Poisoned rows normally keep the backlog non-zero, but handle the edge
  // defensively: parked rows with no backlog still can't read idle/ok.)
  if (input.backlog <= 0) {
    if (poisonedRows > 0) {
      return { state: 'regressing', reasons: [poisonReason()] };
    }
    return { state: 'idle', reasons: [] };
  }

  const ledger = input.ledger;
  const lastSuccessMs = ledger.last_successful_pass_at === null
    ? NaN
    : Date.parse(ledger.last_successful_pass_at);
  const lastSuccessFresh =
    Number.isFinite(lastSuccessMs) && input.nowMs - lastSuccessMs <= config.stallThresholdMs;

  // No recent success at all → stalled. This is the honest signal the pre-fix
  // verdict lacked: fresh queue rows cannot paper over a stale last success.
  if (!lastSuccessFresh) {
    if (ledger.last_successful_pass_at === null) {
      reasons.push('no successful pass has ever been recorded');
    } else {
      reasons.push(
        `last successful pass was ${Math.round((input.nowMs - lastSuccessMs) / 1000)}s ago ` +
          `(threshold ${config.stallThresholdMs}ms)`,
      );
    }
    // Stalled dominates, but still name the poison count so an operator sees it.
    if (poisonedRows > 0) reasons.push(poisonReason());
    return { state: 'stalled', reasons };
  }

  // Recent success, but the success rate is below the floor (only judged once
  // enough passes have run) → regressing.
  const totalPasses = ledger.passes_ok + ledger.passes_failed;
  if (totalPasses >= config.minPasses) {
    const successRate = totalPasses === 0 ? 0 : ledger.passes_ok / totalPasses;
    if (successRate < config.successRateFloor) {
      reasons.push(
        `success rate ${(successRate * 100).toFixed(0)}% below floor ${(config.successRateFloor * 100).toFixed(0)}% ` +
          `(${ledger.passes_ok}/${totalPasses} passes succeeded)`,
      );
    }
  }

  // Backlog growing (negative net drain) → regressing.
  if (ledger.net_drained < 0) {
    reasons.push(
      `backlog grew by ${-ledger.net_drained} during the last pass ` +
        `(${ledger.backlog_before} → ${ledger.backlog_after})`,
    );
  }

  // Honest progress: parked rows are a regression, never `ok`.
  if (poisonedRows > 0) {
    reasons.push(poisonReason());
  }

  if (reasons.length > 0) {
    return { state: 'regressing', reasons };
  }

  return { state: 'ok', reasons: [] };
}

/**
 * Compute + record + log the verdict in one tick-side call. Returns the verdict.
 * The caller passes the SAME facts memory_ping will later read, so the tick's
 * escalation never disagrees with the surfaced verdict. Never throws.
 */
export async function recordPipelineHealthVerdict(
  input: ComputePipelineHealthInput,
): Promise<PipelineHealthVerdict> {
  // Wired into the `enrich.health` stage (verdict path) so the health plane's
  // own execution is visible to telemetrySelfCheck — a health plane that stops
  // running is the exact silent failure this item exists to surface.
  return MEMORY_CORE_STAGES.withContendedStage(
    'enrich.health',
    'verdict',
    async () => { /* no admission resource — pure compute over the caller-supplied ledger */ },
    async () => {
      const verdict = computePipelineHealthVerdict(input);
      if (verdict.state !== 'ok' && verdict.state !== 'idle') {
        log.warn('enrich.health.verdict', {
          state: verdict.state,
          reasons: verdict.reasons,
          backlog: input.backlog,
          poisoned_rows: input.poisonedRows ?? 0,
          last_successful_pass_at: input.ledger.last_successful_pass_at,
        });
      }
      return verdict;
    },
  );
}
