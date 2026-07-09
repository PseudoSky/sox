// @adhd/sox-task-queue — retry backoff formula (SPEC §9)

export const BACKOFF_BASE_DELAY_MS = 1_000;
export const BACKOFF_MAX_DELAY_MS = 86_400_000; // 24h

/**
 * backoffDelay = min(baseDelay * 2^retryCount, maxDelay)
 *
 * `retryCount` is the PRE-increment retry count (0-indexed): the first
 * failure (retryCount=0) backs off 2^0 * 1000 = 1s, the second (retryCount=1)
 * backs off 2s, etc. This matches SPEC §9's worked example exactly.
 *
 * Spec reconciliation: the illustrative table in §9 is internally
 * inconsistent for attempts >= 10 (e.g. "10 | 1024s" implies 2^retryCount
 * with retryCount=10, not 2^9=512s implied by the attempts 1-5 rows and by
 * the textual formula + 0-indexed worked example). We implement the
 * textual formula verbatim ("backoffDelay = min(baseDelay * (2^retryCount),
 * maxDelay)", 0-indexed) plus the small worked example, which are mutually
 * consistent; we treat the larger table rows as a documentation typo.
 */
export function computeBackoffDelayMs(retryCount: number): number {
  const raw = BACKOFF_BASE_DELAY_MS * Math.pow(2, retryCount);
  return Math.min(raw, BACKOFF_MAX_DELAY_MS);
}
