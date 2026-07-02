/**
 * Edge creation — SQL INSERT with NOT EXISTS guard.
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type { Database } from 'better-sqlite3';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LinkResult {
  edge_uid?: string;
  isError?: boolean;
  message?: string;
}

const VALID_RELS = [
  'MENTIONS',
  'SUPPORTS',
  'RELATES_TO',
  'DERIVED_FROM',
  'SUPERSEDES',
  'SAME_AS',
  'ASSIGNED_TO',
] as const;

export const inputSchema = {
  type: 'object' as const,
  properties: {
    src_uid: { type: 'string', description: 'UID of the source node' },
    dst_uid: { type: 'string', description: 'UID of the destination node' },
    rel: {
      type: 'string',
      enum: [...VALID_RELS],
      description: 'Relationship type',
    },
    db_path: {
      type: 'string',
      description:
        'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.',
    },
    weight: { type: 'number', description: 'Optional edge weight (0–1)' },
    meta: { type: 'object', description: 'Optional JSON metadata' },
  },
  required: ['src_uid', 'dst_uid', 'rel'],
};

/**
 * Backing for memory_link.
 *
 * Creates a directed edge between two existing nodes with a NOT EXISTS guard
 * to prevent duplicate edges.
 */
export async function linkNodes(
  db: Database,
  args: Record<string, unknown>,
): Promise<LinkResult> {
  const rel = args['rel'] as string;
  if (!VALID_RELS.includes(rel as (typeof VALID_RELS)[number])) {
    return { isError: true, message: `Unknown rel: ${rel}` };
  }

  const srcUid = args['src_uid'] as string;
  const dstUid = args['dst_uid'] as string;

  const srcRow = db.prepare<[string], { rowid: number }>('SELECT rowid FROM node WHERE uid = ?').get(srcUid);
  const dstRow = db.prepare<[string], { rowid: number }>('SELECT rowid FROM node WHERE uid = ?').get(dstUid);

  if (!srcRow) return { isError: true, message: `src_uid not found: ${srcUid}` };
  if (!dstRow) return { isError: true, message: `dst_uid not found: ${dstUid}` };

  const now = new Date().toISOString();
  const edgeUid = `edge-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  db.prepare(
    `INSERT INTO edge (src, dst, rel, origin, t_created, meta)
     SELECT ?, ?, ?, 'user_asserted', ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM edge WHERE src=? AND dst=? AND rel=? AND t_expired IS NULL)`,
  ).run(
    srcRow.rowid,
    dstRow.rowid,
    rel,
    now,
    JSON.stringify(args['meta'] ?? {}),
    srcRow.rowid,
    dstRow.rowid,
    rel,
  );

  return { edge_uid: edgeUid };
}
