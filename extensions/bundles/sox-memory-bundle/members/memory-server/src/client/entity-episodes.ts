/**
 * Entity episodes — SQL join of MENTIONS edge with entity resolution.
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type { Database } from 'better-sqlite3';
import { parseTags, isSuperseded, supersedesUidForRowid, communityUidForRowid } from './db.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EntityInfo {
  uid: string;
  name: string;
}

export interface EpisodeSummary {
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

export interface EntityEpisodesResult {
  entity?: EntityInfo;
  episodes?: EpisodeSummary[];
  total?: number;
  code?: string;
  message?: string;
  candidates?: string[];
}

export const inputSchema = {
  type: 'object' as const,
  properties: {
    db_path: {
      type: 'string',
      description:
        'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.',
    },
    entity_uid: { type: 'string', description: 'UID of the entity node.' },
    entity_name: { type: 'string', description: 'Name of the entity (resolved to UID if entity_uid not supplied).' },
    limit: { type: 'number', default: 20, maximum: 200 },
    offset: { type: 'number', default: 0 },
  },
  required: [],
};

/**
 * Backing for memory_entity_episodes.
 *
 * Returns episodes that mention a given entity via MENTIONS edges, ranked by
 * importance. Entity can be specified by UID or resolved by name.
 */
export async function getEntityEpisodes(
  db: Database,
  args: Record<string, unknown>,
): Promise<EntityEpisodesResult> {
  const entityUid = args['entity_uid'] as string | undefined;
  const entityName = args['entity_name'] as string | undefined;
  const limit = Math.min((args['limit'] as number | undefined) ?? 20, 200);
  const offset = (args['offset'] as number | undefined) ?? 0;

  // Resolve entity uid
  let resolvedEntityUid = entityUid;
  let resolvedEntityName = '';

  if (!resolvedEntityUid && entityName) {
    const matchRows = db
      .prepare<[string], { uid: string; name: string }>(
        `SELECT uid, name FROM node WHERE kind = 'entity' AND LOWER(name) = LOWER(?) AND t_invalid IS NULL`,
      )
      .all(entityName);

    if (matchRows.length === 0) {
      return { code: 'E_NOT_FOUND', episodes: [], total: 0, entity: { uid: '', name: entityName } };
    }
    if (matchRows.length > 1) {
      return {
        code: 'E_AMBIGUOUS',
        episodes: [],
        total: 0,
        entity: { uid: '', name: entityName },
        candidates: matchRows.map((r: { uid: string }) => r.uid),
      };
    }
    resolvedEntityUid = matchRows[0]!.uid;
    resolvedEntityName = matchRows[0]!.name ?? entityName;
  }

  if (!resolvedEntityUid) {
    return { code: 'E_MISSING_INPUT', episodes: [], total: 0, entity: { uid: '', name: '' } };
  }

  // Fetch entity name if not already resolved
  if (!resolvedEntityName) {
    const nameRow = db
      .prepare<[string], { name: string | null }>(`SELECT name FROM node WHERE uid = ? LIMIT 1`)
      .get(resolvedEntityUid);
    resolvedEntityName = nameRow?.name ?? resolvedEntityUid;
  }

  const entityRow = db
    .prepare<[string], { rowid: number }>(`SELECT rowid FROM node WHERE uid = ? LIMIT 1`)
    .get(resolvedEntityUid);

  if (!entityRow) {
    return { code: 'E_NOT_FOUND', episodes: [], total: 0, entity: { uid: resolvedEntityUid, name: resolvedEntityName } };
  }

  const countRow = db
    .prepare<[number], { cnt: number }>(
      `SELECT COUNT(*) AS cnt
       FROM edge e
       JOIN node ep ON ep.rowid = e.src AND ep.kind = 'episode' AND ep.t_invalid IS NULL
       WHERE e.dst = ? AND e.rel = 'MENTIONS' AND e.t_expired IS NULL`,
    )
    .get(entityRow.rowid);
  const total = countRow?.cnt ?? 0;

  type EpisodeRow = {
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
  };

  const rows = db
    .prepare<[number, number, number], EpisodeRow>(
      `SELECT ep.rowid, ep.uid, ep.content, ep.summary, ep.topic, ep.tags, ep.project_path,
              ep.importance, ep.t_created, ep.agent_id, ep.t_invalid
       FROM edge e
       JOIN node ep ON ep.rowid = e.src AND ep.kind = 'episode' AND ep.t_invalid IS NULL
       WHERE e.dst = ? AND e.rel = 'MENTIONS' AND e.t_expired IS NULL
       ORDER BY ep.importance DESC
       LIMIT ? OFFSET ?`,
    )
    .all(entityRow.rowid, limit, offset);

  const episodes: EpisodeSummary[] = rows.map((r: EpisodeRow) => ({
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
  }));

  return {
    entity: { uid: resolvedEntityUid, name: resolvedEntityName },
    episodes,
    total,
  };
}
