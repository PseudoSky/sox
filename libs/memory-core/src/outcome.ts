/**
 * outcome.ts — D-C primitive (a), append-only half.
 *
 * An **outcome** is a new `episode` node carrying a `meta.outcome` envelope and
 * a `DERIVED_FROM` edge to the claim it speaks to. It is NEVER a `memory_update`
 * on the claim (K-I2): re-recording appends a new node, so re-verification is
 * history rather than overwrite, and the claim's bytes never change.
 *
 * The outcome records who observed it and — crucially (K-I4) — the caller's
 * `independence` ('self' vs 'independent'), plus the claim lease revision it
 * attests to (`attestation_revision`), which drives the `stale` tier.
 *
 * [inv:no-mcp] — returns plain result objects, never an MCP ToolResult.
 */

import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { getMemoryGraphBackend } from './graph-backend.js';
import { readClaimView } from './claim.js';
import type { Independence, OutcomeView } from './knowledge.js';

const INDEPENDENCE_LEVELS: readonly Independence[] = ['self', 'independent'];

export interface OutcomeAppendParams {
  /** The claim this outcome speaks to (must be a live `claim`-kind node). */
  claim_uid: string;
  observed_result: string;
  observed_by: string;
  method: string;
  /** ISO timestamp; defaults to now. */
  observed_at?: string | undefined;
  independence: Independence;
  /** Optional idempotency key — replay returns the original outcome. */
  client_request_id?: string | undefined;
}

export interface OutcomeAppendOk {
  ok: true;
  outcome: OutcomeView;
  /** True when this call replayed a prior `client_request_id`. */
  replayed: boolean;
}

export type OutcomeAppendError =
  | { ok: false; code: 'E_NOT_FOUND'; message: string }
  | { ok: false; code: 'E_INVALID'; message: string };

export type OutcomeAppendResult = OutcomeAppendOk | OutcomeAppendError;

function invalid(message: string): OutcomeAppendError {
  return { ok: false, code: 'E_INVALID', message };
}

function parseMeta(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* malformed meta — treat as empty */
  }
  return {};
}

/** Read one `meta.outcome` envelope into an OutcomeView, or null when absent/malformed. */
export function parseOutcome(
  meta: Record<string, unknown>,
  uid: string,
  claimUid: string,
): OutcomeView | null {
  const raw = meta['outcome'];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const observed_result = typeof o['observed_result'] === 'string' ? o['observed_result'] : '';
  if (!observed_result) return null;
  const independence: Independence = o['independence'] === 'independent' ? 'independent' : 'self';
  return {
    uid,
    claim_uid: typeof o['claim_uid'] === 'string' ? o['claim_uid'] : claimUid,
    observed_result,
    observed_by: typeof o['observed_by'] === 'string' ? o['observed_by'] : '',
    method: typeof o['method'] === 'string' ? o['method'] : '',
    observed_at: typeof o['observed_at'] === 'string' ? o['observed_at'] : '',
    independence,
    attestation_revision:
      typeof o['attestation_revision'] === 'number' ? o['attestation_revision'] : 1,
  };
}

async function findOutcomeByRequestId(
  adapter: StoreAdapter,
  claimUid: string,
  requestId: string,
): Promise<OutcomeView | null> {
  const row = await adapter.executeGet<{ uid: string; meta: string | null }>(
    `SELECT uid, meta FROM node
      WHERE kind = 'episode' AND t_invalid IS NULL
        AND json_valid(meta)
        AND json_extract(meta, '$.outcome.claim_uid') = ?
        AND json_extract(meta, '$.outcome.client_request_id') = ?
      LIMIT 1`,
    [claimUid, requestId],
  );
  if (!row) return null;
  return parseOutcome(parseMeta(row.meta), row.uid, claimUid);
}

/**
 * Append an outcome to a claim. Mints a NEW episode node (never updates the
 * claim), stores the outcome envelope at `meta.outcome`, and links the new node
 * `DERIVED_FROM` the claim.
 */
export async function memoryOutcomeAppend(
  adapter: StoreAdapter,
  params: OutcomeAppendParams,
): Promise<OutcomeAppendResult> {
  const claimUid = typeof params.claim_uid === 'string' ? params.claim_uid.trim() : '';
  const result = typeof params.observed_result === 'string' ? params.observed_result.trim() : '';
  const observedBy = typeof params.observed_by === 'string' ? params.observed_by.trim() : '';
  const method = typeof params.method === 'string' ? params.method.trim() : '';
  if (!claimUid || !result || !observedBy || !method) {
    return invalid('claim_uid, observed_result, observed_by and method are required');
  }
  if (!INDEPENDENCE_LEVELS.includes(params.independence)) {
    return invalid("independence must be 'self' or 'independent'");
  }
  const observedAt =
    typeof params.observed_at === 'string' && params.observed_at.length > 0
      ? params.observed_at
      : new Date().toISOString();

  const backend = getMemoryGraphBackend(adapter);
  const claimRec = await backend.getNodeByUid(claimUid);
  if (!claimRec || claimRec.kind !== 'claim') {
    return { ok: false, code: 'E_NOT_FOUND', message: `No live claim with uid: ${claimUid}` };
  }

  const clientRequestId =
    typeof params.client_request_id === 'string' && params.client_request_id.length > 0
      ? params.client_request_id
      : undefined;
  if (clientRequestId !== undefined) {
    const existing = await findOutcomeByRequestId(adapter, claimUid, clientRequestId);
    if (existing) return { ok: true, outcome: existing, replayed: true };
  }

  const claim = await readClaimView(adapter, claimUid);
  const attestation_revision = claim?.revision ?? 1;

  const rowid = await backend.writeNode(
    result,
    {
      kind: 'episode',
      projectPath: claim?.project_path ?? '',
      source: 'observation',
      metadata: {
        outcome: {
          claim_uid: claimUid,
          observed_result: result,
          observed_by: observedBy,
          method,
          observed_at: observedAt,
          independence: params.independence,
          attestation_revision,
          ...(clientRequestId !== undefined ? { client_request_id: clientRequestId } : {}),
        },
      },
    },
    { skipDedupe: true },
  );
  const rec = await backend.getNode(rowid);
  const uid = rec?.uid;
  if (!uid) return invalid('outcome node was written but could not be read back');

  await backend.writeEdge(rowid, claimRec.id, 'DERIVED_FROM');

  const outcome: OutcomeView = {
    uid,
    claim_uid: claimUid,
    observed_result: result,
    observed_by: observedBy,
    method,
    observed_at: observedAt,
    independence: params.independence,
    attestation_revision,
  };
  return { ok: true, outcome, replayed: false };
}

/**
 * Read every outcome attached to a claim, ordered by `observed_at` then uid
 * (stable only — no wall-clock dependence). Returns `[]` when the claim is
 * unknown or has no outcomes.
 */
export async function readOutcomes(
  adapter: StoreAdapter,
  claimUid: string,
): Promise<OutcomeView[]> {
  const id = typeof claimUid === 'string' ? claimUid.trim() : '';
  if (!id) return [];
  const backend = getMemoryGraphBackend(adapter);
  const claimRec = await backend.getNodeByUid(id);
  if (!claimRec) return [];

  // Outcomes link src(outcome) -DERIVED_FROM-> dst(claim).
  const edges = await backend.getEdges({ dst: claimRec.id, rel: 'DERIVED_FROM' });
  const srcIds = edges.map((e) => e.src);
  if (srcIds.length === 0) return [];

  const rows = (
    await adapter.executeAll<{ uid: string; meta: string | null }>(
      `SELECT uid, meta FROM node
        WHERE rowid IN (${srcIds.map(() => '?').join(',')})
          AND kind = 'episode' AND t_invalid IS NULL
          AND json_valid(meta)`,
      srcIds,
    )
  ).rows;

  const outcomes: OutcomeView[] = [];
  for (const r of rows) {
    const o = parseOutcome(parseMeta(r.meta), r.uid, id);
    if (o) outcomes.push(o);
  }
  outcomes.sort(
    (a, b) => a.observed_at.localeCompare(b.observed_at) || a.uid.localeCompare(b.uid),
  );
  return outcomes;
}
