/**
 * claim.ts — SR-7: `memory_claim_upsert` and a memory-side, queryable claim.
 *
 * ## What this is
 *
 * A **claim** is a first-class record that a caller holds a node for processing
 * ("I am the writer working this node"), stored on the node itself at
 * `node.meta.claim = { caller, claimed_at, updated_at }`. It is:
 *
 *   1. **Atomic** — `memoryClaimUpsert` claims a node for a caller, or updates
 *      it if that caller already holds it, as ONE compare-and-swap. Two callers
 *      racing for one node yield exactly one winner; a distinct caller is
 *      refused with a typed `E_CLAIM_HELD` conflict; the same caller
 *      re-claiming is idempotent (same holder, no duplicate claim).
 *   2. **Queryable** — `memoryClaimGet` / `memoryClaimList` read the record
 *      back, so a claim is a record you can ask about, not merely a write.
 *   3. **Durable** — the record lives in `node.meta`, so it survives a store
 *      close/reopen; a reader in a later process sees the same holder.
 *
 * ## Correctness is the store primitive, never an advisory lock (ADR-0012)
 *
 * The parallel-process invariant (sox ADR-0012) forbids carrying correctness on
 * a lock. The claim guard is therefore a **conditional UPDATE** evaluated by the
 * store itself:
 *
 *     UPDATE node SET meta = ?
 *      WHERE uid = ?
 *        AND t_invalid IS NULL
 *        AND ( <live claim.caller> IS NULL OR <live claim.caller> = :caller )
 *
 * The UPDATE is executed inside an `IMMEDIATE` transaction. On SQLite
 * `BEGIN IMMEDIATE` takes the write lock up front, so two racing connections
 * serialize: the loser's `WHERE` re-evaluates against the winner's committed
 * claim and matches zero rows. The `rowsAffected` count is the CAS verdict:
 * `1` = we hold the claim, `0` = we lost the race (re-read to classify as
 * `E_CLAIM_HELD`) or the node is gone (`E_NOT_FOUND`). Two adapters on
 * independent processes/connections contend at the storage layer — no
 * in-process lock is involved, so this is safe under the multi-writer model.
 *
 * ## Scope note (SR-6)
 *
 * A node-level monotonic `revision` + `compareAndSwapRevision` (sox SR-6) does
 * not exist on the store yet. Per the D-C spec's own migration note, the claim
 * degrades to `E_CLAIM_HELD`-on-conflict until SR-6 lands: correctness here
 * comes from the conditional predicate, not from a revision comparison.
 * `ClaimRecord.revision` below is the CLAIM's own upsert counter, deliberately
 * independent of the (not-yet-existing) node revision.
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { deepMerge } from './update.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** The persisted claim record (node.meta.claim). */
export interface ClaimRecord {
  /** The holder. A claim is owned by exactly one caller. */
  caller: string;
  /** ISO timestamp the claim was FIRST acquired by `caller` (stable across re-claims). */
  claimed_at: string;
  /** ISO timestamp of the most recent claim/upsert by `caller` (heartbeat). */
  updated_at: string;
  /**
   * Claim-local upsert counter — incremented on every successful
   * `memoryClaimUpsert` by the holder. This is NOT the node-level `revision`
   * of SR-6 (which does not exist yet); it exists so each upsert is
   * observable. The claim's IDENTITY is `caller` (+ `claimed_at`), which is
   * what idempotency preserves.
   */
  revision: number;
}

export interface ClaimUpsertParams {
  /** The node to claim. Required. */
  uid: string;
  /** The caller claiming the node. Required — a distinct caller is refused. */
  caller: string;
  /**
   * Optional metadata upserted into the node alongside the claim (deep-merged
   * into the existing `meta`, arrays replaced — same contract as
   * `memory_update`'s `metadata`). Applied on acquire AND on a same-caller
   * re-claim. The `claim` key is owned by this module and always overwritten
   * with the current holder's record; a `patch.metadata.claim` is ignored.
   */
  patch?: { metadata?: Record<string, unknown> } | undefined;
}

export interface ClaimUpsertOk {
  ok: true;
  uid: string;
  claim: ClaimRecord;
  /** Node columns/keys actually written this call (e.g. `meta` when the claim or patch changed). */
  updated_fields: string[];
  /** True when this call ACQUIRED a previously-unheld node. */
  acquired: boolean;
  /** True when the caller already held the node (an idempotent re-claim). */
  refreshed: boolean;
}

export type ClaimUpsertError =
  | { ok: false; code: 'E_CLAIM_HELD'; message: string; held_by: string; claimed_at: string }
  | { ok: false; code: 'E_NOT_FOUND'; message: string }
  | { ok: false; code: 'E_INVALID'; message: string };

export type ClaimUpsertResult = ClaimUpsertOk | ClaimUpsertError;

export interface ClaimGetOk {
  ok: true;
  uid: string;
  /** The live claim, or null when the node is unheld. */
  claim: ClaimRecord | null;
}

export type ClaimGetResult =
  | ClaimGetOk
  | { ok: false; code: 'E_NOT_FOUND'; message: string };

export interface ClaimListEntry {
  uid: string;
  claim: ClaimRecord;
}

export interface ClaimListResult {
  claims: ClaimListEntry[];
  count: number;
}

// ── Internals ─────────────────────────────────────────────────────────────────

function parseMeta(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* malformed meta — treat as empty rather than throw; the JSON_CHECKS guard
       is new-stores-only, so a legacy store may carry a non-JSON meta blob. */
  }
  return {};
}

/** Read a well-formed claim record off a parsed meta blob, or null. */
function readClaim(meta: Record<string, unknown>): ClaimRecord | null {
  const raw = meta['claim'];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  if (typeof c['caller'] !== 'string' || c['caller'].length === 0) return null;
  return {
    caller: c['caller'],
    claimed_at: typeof c['claimed_at'] === 'string' ? c['claimed_at'] : '',
    updated_at: typeof c['updated_at'] === 'string' ? c['updated_at'] : '',
    revision: typeof c['revision'] === 'number' ? c['revision'] : 0,
  };
}

/**
 * The live-claim caller expression. Guards `json_extract` behind `json_valid`
 * so a legacy malformed `meta` yields NULL (no claim) rather than a hard
 * "malformed JSON" throw from SQLite/Turso. `json_valid(NULL)` is NULL
 * (falsy), so a NULL meta also yields the ELSE branch → NULL.
 */
const LIVE_CALLER_SQL =
  `(CASE WHEN json_valid(meta) THEN json_extract(meta, '$.claim.caller') END)`;

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Claim `uid` for `caller`, or update it if already held by `caller` — atomically.
 *
 * @returns `{ok:true, claim, acquired, refreshed}` on success; `E_CLAIM_HELD`
 *   (with the current holder) when a distinct caller holds it; `E_NOT_FOUND`
 *   when no live node has `uid`; `E_INVALID` on a missing uid/caller.
 */
export async function memoryClaimUpsert(
  adapter: StoreAdapter,
  params: ClaimUpsertParams,
): Promise<ClaimUpsertResult> {
  const uid = typeof params.uid === 'string' ? params.uid.trim() : '';
  const caller = typeof params.caller === 'string' ? params.caller.trim() : '';
  if (!uid || !caller) {
    return { ok: false, code: 'E_INVALID', message: 'uid and caller are required' };
  }

  const now = new Date().toISOString();

  // `@adhd/sox-store-adapter` is a LAZY-loaded dependency in memory-core (see
  // the module-boundary rule; the type-only import above is erased). Load
  // `withRetry` on demand — bounded retry absorbs a cross-connection write
  // conflict (BUSY / BUSY_SNAPSHOT on an MVCC backend): the retry re-BEGINs,
  // re-reads the now-committed winner's claim and returns the TYPED
  // `E_CLAIM_HELD` — never a raw driver error. On a single-writer backend the
  // guarded UPDATE simply affects 0 rows (no conflict, no retry).
  const { withRetry } = await import('@adhd/sox-store-adapter');
  return withRetry(() => adapter.transaction(async (tx): Promise<ClaimUpsertResult> => {
    const row = await tx.executeGet<{ meta: string | null }>(
      `SELECT meta FROM node WHERE uid = ? AND t_invalid IS NULL LIMIT 1`,
      [uid],
    );
    if (!row) {
      return { ok: false, code: 'E_NOT_FOUND', message: `No live node with uid: ${uid}` };
    }

    const existing = parseMeta(row.meta);
    const held = readClaim(existing);
    if (held && held.caller !== caller) {
      return {
        ok: false,
        code: 'E_CLAIM_HELD',
        message: `Node ${uid} is already claimed by "${held.caller}"`,
        held_by: held.caller,
        claimed_at: held.claimed_at,
      };
    }

    const acquired = held === null;
    const nextClaim: ClaimRecord = {
      caller,
      claimed_at: acquired ? now : held.claimed_at,
      updated_at: now,
      revision: (held?.revision ?? 0) + 1,
    };

    const patchMeta = params.patch?.metadata;
    const merged =
      patchMeta !== undefined
        ? deepMerge(existing, patchMeta as Record<string, unknown>)
        : { ...existing };
    // The claim key is owned by this module — never let a patch forge it.
    merged['claim'] = nextClaim as unknown as Record<string, unknown>;
    const nextMetaJson = JSON.stringify(merged);

    const updatedFields: string[] = [];
    if (nextMetaJson !== (row.meta ?? '')) updatedFields.push('meta');

    // The CAS. Evaluated by the store: only a node that is unheld OR held by
    // THIS caller matches. rowsAffected is the verdict.
    const res = await tx.executeRun(
      `UPDATE node SET meta = ?, t_updated = ?
        WHERE uid = ? AND t_invalid IS NULL
          AND (${LIVE_CALLER_SQL} IS NULL OR ${LIVE_CALLER_SQL} = ?)`,
      [nextMetaJson, now, uid, caller],
    );

    if (res.rowsAffected !== 1) {
      // Lost the race (a distinct caller's claim committed first), or the node
      // was invalidated between our read and our write. Re-read to classify.
      const after = await tx.executeGet<{ meta: string | null }>(
        `SELECT meta FROM node WHERE uid = ? AND t_invalid IS NULL LIMIT 1`,
        [uid],
      );
      if (!after) {
        return { ok: false, code: 'E_NOT_FOUND', message: `No live node with uid: ${uid}` };
      }
      const winner = readClaim(parseMeta(after.meta));
      return {
        ok: false,
        code: 'E_CLAIM_HELD',
        message: `Node ${uid} is already claimed by "${winner?.caller ?? 'unknown'}"`,
        held_by: winner?.caller ?? 'unknown',
        claimed_at: winner?.claimed_at ?? '',
      };
    }

    return {
      ok: true,
      uid,
      claim: nextClaim,
      updated_fields: updatedFields,
      acquired,
      refreshed: !acquired,
    };
  }, { mode: 'immediate' }), { maxRetries: 6 });
}

/**
 * Read the live claim on a node. `claim: null` means the node is live but
 * unheld; `E_NOT_FOUND` means no live node has that uid.
 */
export async function memoryClaimGet(
  adapter: StoreAdapter,
  uid: string,
): Promise<ClaimGetResult> {
  const id = typeof uid === 'string' ? uid.trim() : '';
  if (!id) return { ok: false, code: 'E_NOT_FOUND', message: 'uid is required' };
  const row = await adapter.executeGet<{ meta: string | null }>(
    `SELECT meta FROM node WHERE uid = ? AND t_invalid IS NULL LIMIT 1`,
    [id],
  );
  if (!row) return { ok: false, code: 'E_NOT_FOUND', message: `No live node with uid: ${id}` };
  return { ok: true, uid: id, claim: readClaim(parseMeta(row.meta)) };
}

/**
 * List live claims, optionally narrowed to one `caller`. The queryable half of
 * SR-7: a claim is a record a caller can enumerate, not a write with no read.
 *
 * Pure read (SELECT only); safe against a live store.
 */
export async function memoryClaimList(
  adapter: StoreAdapter,
  opts: { caller?: string } = {},
): Promise<ClaimListResult> {
  const caller = typeof opts.caller === 'string' && opts.caller.length > 0 ? opts.caller : undefined;
  const rows = (
    await adapter.executeAll<{ uid: string; meta: string | null }>(
      caller === undefined
        ? `SELECT uid, meta FROM node
            WHERE t_invalid IS NULL AND json_valid(meta) AND json_extract(meta, '$.claim.caller') IS NOT NULL
            ORDER BY json_extract(meta, '$.claim.claimed_at') ASC`
        : `SELECT uid, meta FROM node
            WHERE t_invalid IS NULL AND json_valid(meta) AND json_extract(meta, '$.claim.caller') = ?
            ORDER BY json_extract(meta, '$.claim.claimed_at') ASC`,
      caller === undefined ? [] : [caller],
    )
  ).rows;

  const claims: ClaimListEntry[] = [];
  for (const r of rows) {
    const claim = readClaim(parseMeta(r.meta));
    if (claim) claims.push({ uid: r.uid, claim });
  }
  return { claims, count: claims.length };
}
