/**
 * invalidation-meta.ts — the ONE shared writer for episode/claim `t_invalid`
 * (f7461993).
 *
 * BUG-CLUSTER f7461993: 89 invalidated episodes carried no recorded cause.
 * Root cause: `memoryInvalidate` (write.ts) closed the row's t_invalid
 * column with a raw, unconditional single-column UPDATE and only ever
 * persisted the caller's `reason` onto a SUPERSEDES edge — which exists ONLY when
 * `replacement_uid` is supplied. Every invalidate-without-replacement call
 * (the majority) lost its reason permanently. `curateMergeDuplicates`
 * (curate.ts) had the identical gap with no `reason` parameter at all.
 * `graph-store`'s own `invalidateInTx` already did this correctly — this
 * file is memory-core's equivalent, sharing its shape (read-merge-write,
 * deep-preserving pre-existing `node.meta`, never clobbering it).
 *
 * Every call site that sets a LIVE episode/claim's `t_invalid` to a non-NULL
 * value in memory-core MUST route through {@link invalidateEpisodeInTx} —
 * this is enforced (by allowlist, not by type system) by
 * `invalidation-always-has-reason.spec.ts`.
 */

import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import { log } from './telemetry.js';

export interface InvalidateEpisodeMetaOpts {
  /** The uid of the node being invalidated. */
  uid: string;
  /** The t_invalid value to write — NOT always "now" (a restore-reversal sets it back to a recorded prior value). */
  tInvalid: string;
  /** Caller-supplied cause. Required — every call site must pass a literal explaining why (never silently omitted). */
  reason: string;
  /** Which code path performed the invalidation — persisted so a later audit can tell them apart without re-deriving from call-site. */
  via: string;
  /** Set only when a SUPERSEDES-style replacement uid exists for this invalidation. */
  replacementUid?: string;
  /** When true, the UPDATE only touches a currently-LIVE row (`AND t_invalid IS NULL`). Default false — merge_duplicates today invalidates unconditionally, including a row that may already be invalid, and this default preserves that behavior for every existing caller. */
  onlyIfLive?: boolean;
}

/** The four top-level meta keys this helper owns. */
const INVALIDATION_META_KEYS = [
  'invalidatedReason',
  'invalidatedAt',
  'invalidatedVia',
  'invalidatedReplacement',
] as const;

/**
 * Read-merge-write `node.meta` in the SAME UPDATE that closes `t_invalid`,
 * inside the caller's transaction. Mirrors graph-store's `invalidateInTx`
 * shape: existing `meta` keys are preserved (shallow top-level merge —
 * nested objects like a pre-existing `restoredFrom` survive untouched since
 * this only adds new top-level keys), never dropped.
 *
 * A row CAN be invalidated more than once in its lifetime (revived, then
 * invalidated again — e.g. a restore_neardup reversal re-invalidating a row
 * that a prior memory_invalidate had already touched before it was restored).
 * If the row already carries a PRIOR invalidation event (any of the four
 * `invalidated*` keys from an earlier call to this same helper), that event
 * is archived as one entry onto `meta.invalidationHistory` before the new
 * one is written — never overwritten in place. Overwriting in place would
 * silently splice a new reason next to a stale `invalidatedReplacement` from
 * a DIFFERENT event, or erase a first-invalidation reason a later reversal
 * has no way to know.
 *
 * Returns the number of rows the UPDATE affected (0 or 1) so callers that
 * gate on "did this actually invalidate a still-live row" (the restore
 * reversal path) can keep that check.
 */
export async function invalidateEpisodeInTx(
  tx: AdapterTransaction,
  opts: InvalidateEpisodeMetaOpts,
): Promise<number> {
  const { uid, tInvalid, reason, via, replacementUid, onlyIfLive = false } = opts;

  const existing = await tx.executeGet<{ meta: string | null }>(
    `SELECT meta FROM node WHERE uid = ?`,
    [uid],
  );

  let metaObj: Record<string, unknown> = {};
  if (existing?.meta) {
    try {
      const parsed: unknown = JSON.parse(existing.meta);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metaObj = parsed as Record<string, unknown>;
      }
    } catch (err) {
      log.warn('invalidation_meta.parse_failed', {
        uid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Archive a prior invalidation event rather than clobber it.
  const hadPriorEvent = INVALIDATION_META_KEYS.some((k) => k in metaObj);
  if (hadPriorEvent) {
    const priorEvent: Record<string, unknown> = {};
    for (const k of INVALIDATION_META_KEYS) {
      if (k in metaObj) priorEvent[k] = metaObj[k];
    }
    const priorHistory = Array.isArray(metaObj.invalidationHistory)
      ? (metaObj.invalidationHistory as unknown[])
      : [];
    metaObj = { ...metaObj, invalidationHistory: [...priorHistory, priorEvent] };
    for (const k of INVALIDATION_META_KEYS) delete metaObj[k];
  }

  const invalidatedAt = new Date().toISOString();
  metaObj = {
    ...metaObj,
    invalidatedReason: reason,
    invalidatedAt,
    invalidatedVia: via,
    ...(replacementUid !== undefined ? { invalidatedReplacement: replacementUid } : {}),
  };

  const sql = onlyIfLive
    ? `UPDATE node SET t_invalid = ?, meta = ? WHERE uid = ? AND t_invalid IS NULL`
    : `UPDATE node SET t_invalid = ?, meta = ? WHERE uid = ?`;

  const result = await tx.executeRun(sql, [tInvalid, JSON.stringify(metaObj), uid]);
  return result.rowsAffected;
}
