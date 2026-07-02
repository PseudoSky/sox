/**
 * Related episodes — SQL-backed outbound + inbound edge queries at depth=1.
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type { Database } from 'better-sqlite3';
import { parseTags, isSuperseded, supersedesUidForRowid, communityUidForRowid } from './db.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EpisodeBase {
  uid: string;
  content: string | null;
  summary: string | null;
  topic: string | null;
  tags: string[];
  project_path: string | null;
  importance: number;
  t_created: string;
  agent_id: string | null;
  is_superseded: boolean;
  supersedes_uid: string | null;
  community_uid: string | null;
}

export interface EdgeEntry {
  episode: EpisodeBase;
  rel: string;
  weight: number;
  direction: 'outbound' | 'inbound';
}

export interface RelatedResult {
  source_uid: string;
  edges: EdgeEntry[];
  code?: string;
  message?: string;
}

export const inputSchema = {
  type: 'object' as const,
  properties: {
    db_path: {
      type: 'string',
      description:
        'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.',
    },
    uid: { type: 'string', description: 'UID of the source episode.' },
    rel: {
      type: 'array',
      items: { type: 'string' },
      description: 'Filter by relation type(s). Default: all live relation types.',
    },
    limit: { type: 'number', default: 20, maximum: 100 },
  },
  required: ['uid'],
};

/**
 * Backing for memory_related.
 *
 * Returns graph neighbors of an episode at depth=1 filtered by optional
 * relation types. Results include both outbound and inbound edges.
 */
export async function getRelated(
  db: Database,
  args: Record<string, unknown>,
): Promise<RelatedResult> {
  const uid = args['uid'] as string;
  const relFilter = args['rel'] as string[] | undefined;
  const limit = Math.min((args['limit'] as number | undefined) ?? 20, 100);

  const sourceRow = db
    .prepare<[string], { rowid: number }>(`SELECT rowid FROM node WHERE uid = ? LIMIT 1`)
    .get(uid);

  if (!sourceRow) {
    return { source_uid: uid, edges: [], code: 'E_NOT_FOUND' };
  }

  // Build rel IN clause
  const relClause =
    relFilter && relFilter.length > 0
      ? `AND e.rel IN (${relFilter.map(() => '?').join(',')})`
      : '';
  const relParams = relFilter && relFilter.length > 0 ? relFilter : [];

  type EdgeRow = {
    rowid: number;
    uid: string;
    content: string | null;
    summary: string | null;
    topic: string | null;
    tags: string | null;
    project_path: string | null;
    importance: number;
    t_created: string;
    agent_id: string | null;
    t_invalid: string | null;
    rel: string;
    weight: number | null;
  };

  // Outbound edges (src = source)
  const outRows = db
    .prepare<unknown[], EdgeRow>(
      `SELECT n.rowid, n.uid, n.content, n.summary, n.topic, n.tags, n.project_path,
              n.importance, n.t_created, n.agent_id, n.t_invalid,
              e.rel, e.weight
       FROM edge e
       JOIN node n ON n.rowid = e.dst AND n.t_invalid IS NULL
       WHERE e.src = ? AND e.t_expired IS NULL ${relClause}
       LIMIT ?`,
    )
    .all(sourceRow.rowid, ...relParams, limit);

  // Inbound edges (dst = source)
  const inRows = db
    .prepare<unknown[], EdgeRow>(
      `SELECT n.rowid, n.uid, n.content, n.summary, n.topic, n.tags, n.project_path,
              n.importance, n.t_created, n.agent_id, n.t_invalid,
              e.rel, e.weight
       FROM edge e
       JOIN node n ON n.rowid = e.src AND n.t_invalid IS NULL
       WHERE e.dst = ? AND e.t_expired IS NULL ${relClause}
       LIMIT ?`,
    )
    .all(sourceRow.rowid, ...relParams, limit);

  const toEpisode = (r: EdgeRow): EpisodeBase => ({
    uid: r.uid,
    content: r.content,
    summary: r.summary ?? null,
    topic: r.topic ?? null,
    tags: parseTags(r.tags),
    project_path: r.project_path ?? null,
    importance: r.importance,
    t_created: r.t_created,
    agent_id: r.agent_id ?? null,
    is_superseded: isSuperseded(db, r.rowid),
    supersedes_uid: supersedesUidForRowid(db, r.rowid),
    community_uid: communityUidForRowid(db, r.rowid),
  });

  const edges: EdgeEntry[] = [
    ...outRows.map((r: EdgeRow) => ({
      episode: toEpisode(r),
      rel: r.rel,
      weight: r.weight ?? 1.0,
      direction: 'outbound' as const,
    })),
    ...inRows.map((r: EdgeRow) => ({
      episode: toEpisode(r),
      rel: r.rel,
      weight: r.weight ?? 1.0,
      direction: 'inbound' as const,
    })),
  ].slice(0, limit);

  return { source_uid: uid, edges };
}
