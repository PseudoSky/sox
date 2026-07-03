/**
 * memoryLinkNode — edge creation via raw SQL with NOT EXISTS guard.
 *
 * Validates rel against PUBLIC_EDGE_RELS, resolves src/dst uids to rowids,
 * inserts edge with NOT EXISTS guard (graph-store's writeEdge requires a
 * UNIQUE index not present in the memory-core schema).
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import * as crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { PUBLIC_EDGE_RELS } from '@adhd/sox-graph-store';

const VALID_RELS: readonly string[] = PUBLIC_EDGE_RELS;

export interface LinkResult {
  edge_uid?: string;
  isError?: boolean;
  message?: string;
}

export async function memoryLinkNode(
  db: Database.Database,
  args: Record<string, unknown>,
): Promise<LinkResult> {
  const rel = args['rel'] as string;
  if (!VALID_RELS.includes(rel)) {
    return { isError: true, message: `Unknown rel: ${rel}` };
  }

  const srcUid = args['src_uid'] as string;
  const dstUid = args['dst_uid'] as string;

  const srcRow = db
    .prepare<[string], { rowid: number }>('SELECT rowid FROM node WHERE uid = ?')
    .get(srcUid);
  if (!srcRow) return { isError: true, message: `src_uid not found: ${srcUid}` };

  const dstRow = db
    .prepare<[string], { rowid: number }>('SELECT rowid FROM node WHERE uid = ?')
    .get(dstUid);
  if (!dstRow) return { isError: true, message: `dst_uid not found: ${dstUid}` };

  // Check for existing edge via NOT EXISTS guard
  const now = new Date().toISOString();
  const weight = args['weight'] as number | undefined;
  const meta = args['meta'] as Record<string, unknown> | undefined;
  const metaJson = meta !== undefined ? JSON.stringify(meta) : '{}';

  db.prepare(
    `INSERT INTO edge (src, dst, rel, weight, origin, meta, t_created)
     SELECT ?, ?, ?, ?, 'user_asserted', ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM edge WHERE src=? AND dst=? AND rel=? AND t_expired IS NULL)`,
  ).run(srcRow.rowid, dstRow.rowid, rel, typeof weight === 'number' ? weight : 1.0, metaJson, now,
    srcRow.rowid, dstRow.rowid, rel);

  const edgeUid = crypto.randomUUID();
  return { edge_uid: edgeUid };
}
