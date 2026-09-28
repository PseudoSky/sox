/**
 * back.ts — D-C: the `memory_back` read (decision-backing with the citation
 * contract).
 *
 * Composes the three pure/read pieces into one answer: the immutable claim, its
 * append-only outcomes, the live `REFUTES` edges into it, and the derived
 * verdict — plus the citations that make the answer checkable. This is the read
 * that turns a knowledge record into decision-backing: a caller sees not just
 * the assertion but HOW WELL it is backed (the tier) and BY WHAT (the uids).
 *
 * The refutation read is a plain SELECT, so it works on an un-migrated store
 * (which simply has no `REFUTES` edges yet) without triggering the ADR-0010 D3
 * write-side CHECK.
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { getMemoryGraphBackend } from './graph-backend.js';
import { readClaimView } from './claim.js';
import { readOutcomes } from './outcome.js';
import { deriveVerdict } from './knowledge.js';
import type { BackResult, Citation } from './knowledge.js';

export interface BackOk extends BackResult {
  ok: true;
}

export type BackError = { ok: false; code: 'E_NOT_FOUND'; message: string };

export type BackResponse = BackOk | BackError;

/**
 * Read a knowledge record as decision-backing. Returns `E_NOT_FOUND` when no
 * live `claim`-kind node carries `uid`.
 */
export async function memoryBack(
  adapter: StoreAdapter,
  uid: string,
): Promise<BackResponse> {
  const claim = await readClaimView(adapter, uid);
  if (!claim) {
    return { ok: false, code: 'E_NOT_FOUND', message: `No live claim with uid: ${uid}` };
  }

  const outcomes = await readOutcomes(adapter, uid);

  const backend = getMemoryGraphBackend(adapter);
  const claimRec = await backend.getNodeByUid(uid);
  let refutedBy: string[] = [];
  if (claimRec) {
    const edges = await backend.getEdges({ dst: claimRec.id, rel: 'REFUTES' });
    const srcIds = edges.map((e) => e.src);
    if (srcIds.length > 0) {
      const rows = (
        await adapter.executeAll<{ uid: string }>(
          `SELECT uid FROM node WHERE rowid IN (${srcIds.map(() => '?').join(',')}) AND t_invalid IS NULL`,
          srcIds,
        )
      ).rows;
      refutedBy = rows.map((r) => r.uid);
    }
  }

  const verdict = deriveVerdict(claim, outcomes, {
    refutedBy,
    currentRevision: claim.revision,
  });

  const citations: Citation[] = [
    { uid: claim.uid, context: 'claim' },
    ...outcomes.map((o) => ({ uid: o.uid, context: 'outcome' })),
    ...refutedBy.map((u) => ({ uid: u, context: 'refutes' })),
  ];

  return { ok: true, claim, outcomes, verdict, citations };
}
