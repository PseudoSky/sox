/**
 * Claim invalidation — SQL transaction (bi-temporal, never deletes).
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type { Database } from 'better-sqlite3';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InvalidateResult {
  ok?: boolean;
  supersedes_edge_uid?: string;
  code?: string;
  message?: string;
  claim_uid?: string;
}

export const inputSchema = {
  type: 'object' as const,
  properties: {
    claim_uid: { type: 'string' },
    reason: { type: 'string' },
    db_path: {
      type: 'string',
      description:
        'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.',
    },
    t_transition: { type: 'string' },
    replacement_uid: { type: 'string' },
  },
  required: ['claim_uid', 'reason'],
};

/**
 * Backing for memory_invalidate.
 *
 * Sets t_invalid on the claim node and optionally creates a SUPERSEDES edge
 * from replacement → claim.
 */
export async function invalidateClaim(
  db: Database,
  args: Record<string, unknown>,
): Promise<InvalidateResult> {
  const claimUid = args['claim_uid'] as string;
  const reason = args['reason'] as string;
  const tTransition = (args['t_transition'] as string) ?? new Date().toISOString();
  const replacementUid = args['replacement_uid'] as string | undefined;

  const claim = db
    .prepare<[string], { rowid: number }>(`SELECT rowid FROM node WHERE uid = ? AND t_invalid IS NULL`)
    .get(claimUid);

  if (!claim) {
    return { code: 'E_NOT_FOUND', claim_uid: claimUid };
  }

  let supersedgesEdgeUid: string | undefined;

  db.transaction(() => {
    db.prepare(`UPDATE node SET t_invalid = ? WHERE uid = ?`).run(tTransition, claimUid);

    if (replacementUid) {
      const replacement = db
        .prepare<[string], { rowid: number }>(`SELECT rowid FROM node WHERE uid = ? AND t_invalid IS NULL`)
        .get(replacementUid);
      if (replacement) {
        supersedgesEdgeUid = `sup-${Date.now()}`;
        db.prepare(
          `INSERT INTO edge (src, dst, rel, origin, t_created, meta)
           VALUES (?, ?, 'SUPERSEDES', 'user_asserted', ?, ?)`,
        ).run(replacement.rowid, claim.rowid, tTransition, JSON.stringify({ reason }));
      }
    }
  })();

  return {
    ok: true,
    ...(supersedgesEdgeUid !== undefined ? { supersedes_edge_uid: supersedgesEdgeUid } : {}),
  };
}
