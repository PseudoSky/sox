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
}

export type PingHealthStatus = 'ok' | 'degraded' | 'unhealthy';

export interface PingHealthVerdict {
  /**
   * Overall verdict. `'ok'` only when the store write path is open AND the
   * embed subsystem is real. A store that failed to open is `'unhealthy'`
   * (never `'ok'`, never `'degraded'`). A healthy store with a degraded embed
   * subsystem is `'degraded'` (the pre-existing embed-derived semantics).
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
  const embedReason = input.embedError
    ? `embed subsystem: ${input.embedError}`
    : `embed subsystem is '${input.embedState}' (not 'real')`;
  return {
    status: 'degraded',
    status_reason: embedReason,
    store_ok: true,
    store_error: null,
  };
}
