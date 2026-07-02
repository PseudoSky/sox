/**
 * Entity listing — SQL join of entity + MENTIONS edge with mention count.
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type { Database } from 'better-sqlite3';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EntityListingEntry {
  uid: string;
  name: string;
  mention_count: number;
  first_seen: string;
  last_seen: string;
}

export interface ListEntitiesResult {
  entities: EntityListingEntry[];
  total: number;
}

export const inputSchema = {
  type: 'object' as const,
  properties: {
    db_path: {
      type: 'string',
      description:
        'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.',
    },
    project_path: { type: 'string', description: 'Only count episodes from this project_path.' },
    topic: { type: 'string', description: 'Only count episodes in this topic.' },
    search: { type: 'string', description: 'Substring filter on entity name.' },
    limit: { type: 'number', default: 20, maximum: 200 },
    offset: { type: 'number', default: 0 },
  },
  required: [],
};

/**
 * Backing for memory_list_entities.
 *
 * Returns entity nodes ranked by mention count, with first/last seen timestamps.
 */
export async function listEntities(
  db: Database,
  args: Record<string, unknown>,
): Promise<ListEntitiesResult> {
  const projectPath = args['project_path'] as string | undefined;
  const topicFilter = args['topic'] as string | undefined;
  const search = args['search'] as string | undefined;
  const limit = Math.min((args['limit'] as number | undefined) ?? 20, 200);
  const offset = (args['offset'] as number | undefined) ?? 0;

  // Build episode filter for project_path and topic
  const epFilters: string[] = [];
  const epParams: unknown[] = [];
  if (projectPath) {
    epFilters.push('ep.project_path = ?');
    epParams.push(projectPath);
  }
  if (topicFilter) {
    epFilters.push('ep.topic = ?');
    epParams.push(topicFilter);
  }
  const epFilterSql = epFilters.length > 0 ? 'AND ' + epFilters.join(' AND ') : '';

  const nameFilter = search ? 'AND e_node.name LIKE ?' : '';
  if (search) epParams.push(`%${search}%`);

  // Count distinct entities
  const countSql = `
    SELECT COUNT(DISTINCT e_node.rowid) AS cnt
    FROM node e_node
    WHERE e_node.kind = 'entity' AND e_node.t_invalid IS NULL
    ${nameFilter}
    AND EXISTS (
      SELECT 1 FROM edge ment
      JOIN node ep ON ep.rowid = ment.src AND ep.kind = 'episode' AND ep.t_invalid IS NULL
      WHERE ment.dst = e_node.rowid AND ment.rel = 'MENTIONS' AND ment.t_expired IS NULL
      ${epFilterSql}
    )`;

  const countRow = db.prepare<unknown[], { cnt: number }>(countSql).get(...epParams);
  const total = countRow?.cnt ?? 0;

  // Fetch entities with mention count and time range
  type EntityRow = {
    uid: string;
    name: string | null;
    mention_count: number;
    first_seen: string;
    last_seen: string;
  };

  const rowSql = `
    SELECT e_node.uid,
           e_node.name,
           COUNT(ment.rowid) AS mention_count,
           MIN(ep.t_created)  AS first_seen,
           MAX(ep.t_created)  AS last_seen
    FROM node e_node
    JOIN edge ment ON ment.dst = e_node.rowid AND ment.rel = 'MENTIONS' AND ment.t_expired IS NULL
    JOIN node ep   ON ep.rowid = ment.src AND ep.kind = 'episode' AND ep.t_invalid IS NULL
    WHERE e_node.kind = 'entity' AND e_node.t_invalid IS NULL
    ${nameFilter}
    ${epFilterSql}
    GROUP BY e_node.rowid
    ORDER BY mention_count DESC
    LIMIT ? OFFSET ?`;

  const rows = db.prepare<unknown[], EntityRow>(rowSql).all(...epParams, limit, offset);

  const entities: EntityListingEntry[] = rows.map((r: EntityRow) => ({
    uid: r.uid,
    name: r.name ?? '',
    mention_count: r.mention_count,
    first_seen: r.first_seen,
    last_seen: r.last_seen,
  }));

  return { entities, total };
}
