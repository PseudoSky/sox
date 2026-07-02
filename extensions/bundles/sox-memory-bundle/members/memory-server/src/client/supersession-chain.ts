/**
 * Supersession chain — SQL + BFS walk over SUPERSEDES edges.
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type { Database } from 'better-sqlite3';

// ── Types ─────────────────────────────────────────────────────────────────────

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

export const inputSchema = {
  type: 'object' as const,
  properties: {
    db_path: {
      type: 'string',
      description:
        'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.',
    },
    uid: { type: 'string', description: 'Any episode UID in the chain.' },
  },
  required: ['uid'],
};

/**
 * Backing for memory_supersession_chain.
 *
 * Walks SUPERSEDES edges bidirectionally from the given UID to build the full
 * chain. Edge convention: src supersedes dst.
 */
export async function getSupersessionChain(
  db: Database,
  args: Record<string, unknown>,
): Promise<SupersessionChainResult> {
  const uid = args['uid'] as string;

  const allRows = new Map<
    string,
    { uid: string; t_created: string; t_invalid: string | null }
  >();

  // BFS from the given uid
  const queue: string[] = [uid];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const row = db
      .prepare<
        [string],
        { uid: string; t_created: string; t_invalid: string | null; rowid: number }
      >(`SELECT uid, t_created, t_invalid, rowid FROM node WHERE uid = ? LIMIT 1`)
      .get(current);
    if (!row) continue;

    allRows.set(current, {
      uid: row.uid,
      t_created: row.t_created,
      t_invalid: row.t_invalid,
    });

    // What does this episode supersede? (outbound SUPERSEDES edge)
    const supersededRows = db
      .prepare<[number], { uid: string }>(
        `SELECT n.uid FROM edge e JOIN node n ON n.rowid = e.dst WHERE e.src = ? AND e.rel = 'SUPERSEDES'`,
      )
      .all(row.rowid);
    for (const s of supersededRows) queue.push(s.uid);

    // What supersedes this episode? (inbound SUPERSEDES edge)
    const supersederRows = db
      .prepare<[number], { uid: string }>(
        `SELECT n.uid FROM edge e JOIN node n ON n.rowid = e.src WHERE e.dst = ? AND e.rel = 'SUPERSEDES'`,
      )
      .all(row.rowid);
    for (const s of supersederRows) queue.push(s.uid);
  }

  // Build ordered chain oldest-first (by t_created)
  const chain = [...allRows.values()].sort(
    (a, b) => new Date(a.t_created).getTime() - new Date(b.t_created).getTime(),
  );

  // Canonical = most recent non-invalidated node, or latest by t_created
  const canonical = chain.find((n) => n.t_invalid === null) ?? chain[chain.length - 1]!;

  // Fetch reason strings from SUPERSEDES edge metas
  const chainWithReasons: ChainLink[] = chain.map((n) => {
    const edgeRow = db
      .prepare<[string], { meta: string | null }>(
        `SELECT e.meta FROM edge e
         JOIN node src ON src.rowid = e.src
         JOIN node dst ON dst.rowid = e.dst
         WHERE dst.uid = ? AND e.rel = 'SUPERSEDES'
         LIMIT 1`,
      )
      .get(n.uid);
    let reason: string | null = null;
    if (edgeRow?.meta) {
      try {
        const m = JSON.parse(edgeRow.meta) as { reason?: string };
        reason = m.reason ?? null;
      } catch {
        /* malformed */
      }
    }
    return {
      uid: n.uid,
      t_created: n.t_created,
      t_invalid: n.t_invalid,
      reason,
    };
  });

  return {
    canonical_uid: canonical.uid,
    chain: chainWithReasons,
    is_current: canonical.uid === uid,
  };
}
