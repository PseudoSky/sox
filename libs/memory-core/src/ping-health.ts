/**
 * memory_ping health verdict — BL-373 family (ping honesty).
 *
 * The Aug-11 live incident produced a health-check false positive:
 * `memory_ping → { ok: true, status: 'ok', store: null }` while EVERY write
 * request was failing — the store had failed to open (stale WAL-index
 * sidecar), and the ping's `status` was derived ONLY from embed health,
 * ignoring the store block entirely.
 *
 * This module is the single, pure, unit-tested verdict function. It exists in
 * memory-core (not the memory-server bundle) so the semantics are testable
 * without touching the bundle artifact (deploy guard) and reusable by any
 * consumer that reports memory health.
 *
 * Contract:
 * - `store_ok` is FALSE whenever the store did not open or its connection is
 *   poisoned — a dead write path must never read as healthy.
 * - `status` is `'ok'` ONLY when BOTH the store write path is open AND the
 *   embed subsystem is real. A dead store is `'unhealthy'` (stronger than the
 *   pre-existing embed-only `'degraded'`), because a store that cannot open
 *   means every write fails.
 * - `ok` (the RPC-success field, set by the caller) keeps its unchanged
 *   meaning — "this MCP call itself succeeded" — for every tool; the verdict
 *   fields here are the health signal operators/dashboards read.
 *
 * Pure: no fs, no driver, no env — the caller supplies the observed facts.
 */

export interface PingHealthInput {
  /** True when a store was successfully opened (and queried) during the ping. */
  storeOpened: boolean;
  /** Why the store is not open: open failure message, absent-file note, or
   *  "not configured". Null when the store opened. */
  storeError: string | null;
  /** The embed subsystem state — `'real'` when the real ONNX provider is live. */
  embedState: string;
  /** Last recorded embed failure message, when one exists. */
  embedError?: string | null;
  /**
   * (BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001) The enrich/embed pipeline
   * verdict state (`computePipelineHealthVerdict`). When `'stalled'` or
   * `'regressing'`, the top-level `status` is downgraded from `'ok'` to
   * `'degraded'` even though both the store and embed subsystem read healthy —
   * a pipeline that stopped succeeding is a degraded service, never `'ok'`.
   * `'idle'` (empty backlog) and `'ok'` (and `null`/absent, for callers that do
   * not compute a pipeline verdict) leave `status` unchanged.
   */
  enrichmentState?: 'idle' | 'ok' | 'regressing' | 'stalled' | null;
  /**
   * (BL-deepverify) The store's durable deep-integrity record: whether a deep
   * pass is still OWED (`_adapter_meta.deep_verify_owed`) and the latest
   * attempt's outcome (`_adapter_meta.deep_verify_state.status`). When a deep
   * pass is owed and its last attempt ended `timed_out` / `failed` / `damaged`
   * / `inconclusive`, `status` is `'degraded'` — the store serves, but it was
   * owed a verification it could not get, and `[inv:list-never-lies]` forbids
   * reading that as `'ok'`. `running` (a pass in progress) and `cancelled` (the
   * owning adapter closed; the next open reruns it) leave `status` unchanged;
   * absent/`null` (a caller that does not read the record) also does.
   */
  deepVerify?: { owed: boolean; status: string | null; detail?: string | null } | null;
}

/** (BL-deepverify) Deep-verify outcomes that degrade `status` while a pass is owed. */
export const DEEP_VERIFY_DEGRADING_STATUSES: readonly string[] = ['timed_out', 'failed', 'damaged', 'inconclusive'];

function deepVerifyReason(input: PingHealthInput): string | null {
  const dv = input.deepVerify;
  if (dv === undefined || dv === null || !dv.owed || dv.status === null) return null;
  if (!DEEP_VERIFY_DEGRADING_STATUSES.includes(dv.status)) return null;
  return (
    `store deep integrity verification is owed and its last attempt ended '${dv.status}'` +
    (dv.detail ? `: ${dv.detail}` : '') +
    ' (see store.deep_verify)'
  );
}

export type PingHealthStatus = 'ok' | 'degraded' | 'unhealthy';

export interface PingHealthVerdict {
  /**
   * Overall verdict. `'ok'` only when the store write path is open AND the
   * embed subsystem is real AND the pipeline verdict is not regressing/stalled.
   * A store that failed to open is `'unhealthy'` (never `'ok'`, never
   * `'degraded'`). A healthy store with a degraded embed subsystem OR a
   * stalled/regressing pipeline is `'degraded'`.
   */
  status: PingHealthStatus;
  /** Machine-readable reason when `status !== 'ok'`; null otherwise. */
  status_reason: string | null;
  /** True only when the store was opened and its write path is reachable. */
  store_ok: boolean;
  /** Open-failure detail. Never null when `store_ok` is false. */
  store_error: string | null;
}

export function computePingHealthVerdict(input: PingHealthInput): PingHealthVerdict {
  const storeOk = input.storeOpened;
  const embedOk = input.embedState === 'real';

  if (storeOk && embedOk) {
    // Store and embed subsystem both healthy. The pipeline verdict is the final
    // gate: a stalled/regressing enrich/embed pipeline (stuck backlog, below-
    // floor success rate) is `degraded`, never `ok` — the exact 2026-08-26
    // false-positive this guards against (store + embed read clean while the
    // pipeline had not succeeded in >24h).
    const deepReason = deepVerifyReason(input);
    if (deepReason !== null) {
      return { status: 'degraded', status_reason: deepReason, store_ok: true, store_error: null };
    }
    const enrichment = input.enrichmentState ?? null;
    if (enrichment === 'stalled' || enrichment === 'regressing') {
      return {
        status: 'degraded',
        status_reason: `enrich/embed pipeline is '${enrichment}' (see store.enrichment.health)`,
        store_ok: true,
        store_error: null,
      };
    }
    return { status: 'ok', status_reason: null, store_ok: true, store_error: null };
  }

  if (!storeOk) {
    // The observed incident shape: store:null while the ping said ok. A store
    // that cannot open means every write request fails — 'unhealthy', never
    // 'ok', and the reason names the open failure.
    const storeError = input.storeError ?? 'store is not open (no error detail)';
    return {
      status: 'unhealthy',
      status_reason: `store write path is down: ${storeError}`,
      store_ok: false,
      store_error: storeError,
    };
  }

  // Store healthy; embed subsystem not real.
  const embedReason0 = input.embedError
    ? `embed subsystem: ${input.embedError}`
    : `embed subsystem is '${input.embedState}' (not 'real')`;
  const deepReason = deepVerifyReason(input);
  const embedReason = deepReason !== null ? `${deepReason}; ${embedReason0}` : embedReason0;
  return {
    status: 'degraded',
    status_reason: embedReason,
    store_ok: true,
    store_error: null,
  };
}
