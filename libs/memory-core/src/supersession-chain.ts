/**
 * memoryGetSupersessionChain — BFS bidirectional walk over SUPERSEDES edges.
 *
 * Uses getEdges({src, rel:'SUPERSEDES'}) for outbound ("this supersedes X")
 * and getEdges({dst, rel:'SUPERSEDES'}) for inbound ("Y supersedes this").
 *
 * Node details and edge reason metadata fetched via raw SQL.
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { getMemoryGraphBackend } from './graph-backend.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ChainLink {
  uid: string;
  t_created: string;
  t_invalid: string | null;
  reason: string | null;
}

export interface SupersessionChainResult {
  canonical_uid: string;
  chain: ChainLink[];
  is_current: boolean;
  code?: string;
}

// ── Main ───────────────────────────────────────────────────────────────────────

export async function memoryGetSupersessionChain(
  adapter: StoreAdapter,
  args: Record<string, unknown>,
): Promise<SupersessionChainResult> {
  const uid = args['uid'] as string;

  const allRows = new Map<
    string,
    { uid: string; t_created: string; t_invalid: string | null; rowid: number }
  >();

  // BFS from the given uid, collecting edge reason metadata inline
  const queue: string[] = [uid];
  const visited = new Set<string>();
  const edgeReasons = new Map<string, string | null>();

  const backend = getMemoryGraphBackend(adapter);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const row = await adapter.executeGet<
      { uid: string; t_created: string; t_invalid: string | null; rowid: number }
    >(`SELECT uid, t_created, t_invalid, rowid FROM node WHERE uid = ? LIMIT 1`, [current]);
    if (!row) continue;

    allRows.set(current, {
      uid: row.uid,
      t_created: row.t_created,
      t_invalid: row.t_invalid,
      rowid: row.rowid,
    });

    // Outbound: what does this episode supersede?
    const supersededEdges = await backend.getEdges({ src: row.rowid, rel: 'SUPERSEDES' });
    for (const e of supersededEdges) {
      const dstNode = await adapter.executeGet<{ uid: string }>(
        `SELECT uid FROM node WHERE rowid = ? LIMIT 1`, [e.dst],
      );
      if (dstNode) {
        queue.push(dstNode.uid);
        edgeReasons.set(dstNode.uid, (e.metadata as { reason?: string } | undefined)?.reason ?? null);
      }
    }

    // Inbound: what supersedes this episode?
    const supersederEdges = await backend.getEdges({ dst: row.rowid, rel: 'SUPERSEDES' });
    for (const e of supersederEdges) {
      const srcNode = await adapter.executeGet<{ uid: string }>(
        `SELECT uid FROM node WHERE rowid = ? LIMIT 1`, [e.src],
      );
      if (srcNode) {
        queue.push(srcNode.uid);
        edgeReasons.set(current, (e.metadata as { reason?: string } | undefined)?.reason ?? null);
      }
    }
  }

  // Build ordered chain oldest-first (by t_created). BL-505: ties broken by
  // rowid (lowest first) — the t_created-only comparator left ties to BFS
  // discovery order, which is getEdges-row-order-dependent (no ORDER BY) and
  // diverged sqlite vs turso on which uid becomes canonical_uid.
  const chain = [...allRows.values()].sort(
    (a, b) =>
      new Date(a.t_created).getTime() - new Date(b.t_created).getTime() ||
      a.rowid - b.rowid,
  );

  // Canonical = most recent non-invalidated node — i.e. the LAST live node in
  // the oldest-first ordering above (which already carries the BL-505
  // rowid tie-break), not the first. `.find` here would return the OLDEST
  // live node, the exact opposite of "most recent" — filter+last preserves
  // the existing comparator instead of re-deriving ordering via `reduce`.
  // Falls back to the most recent node overall when nothing is live.
  const liveChain = chain.filter((n) => n.t_invalid === null);
  const canonical = liveChain[liveChain.length - 1] ?? chain[chain.length - 1]!;

  // Reason strings collected during BFS from edge metadata
  const chainWithReasons: ChainLink[] = chain.map((n) => ({
    uid: n.uid,
    t_created: n.t_created,
    t_invalid: n.t_invalid,
    reason: edgeReasons.get(n.uid) ?? null,
  }));

  // is_current reflects the QUERIED node's own validity, never a proxy via
  // canonical.uid === uid. That equality coincides on well-formed chains but
  // is wrong in the degenerate single-node case: an invalidated node with no
  // SUPERSEDES edge has chain = [self], so canonical falls back to itself,
  // and canonical.uid === uid was `true` for a node that is not current.
  const queried = allRows.get(uid);
  const isCurrent = queried ? queried.t_invalid === null : false;

  return {
    canonical_uid: canonical.uid,
    chain: chainWithReasons,
    is_current: isCurrent,
  };
}
