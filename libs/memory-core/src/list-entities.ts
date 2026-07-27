/**
 * memoryListEntities — entity nodes ranked by MENTIONS edge count.
 *
 * Queries entity nodes, then counts MENTIONS edges via getEdges()
 * for each entity. Supports project_path/topic/search filters.
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { createGraphBackend } from '@adhd/sox-graph-store';

// ── Types ──────────────────────────────────────────────────────────────────────

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

// ── Main ───────────────────────────────────────────────────────────────────────

export async function memoryListEntities(
  adapter: StoreAdapter,
  args: Record<string, unknown>,
): Promise<ListEntitiesResult> {
  const projectPath = args['project_path'] as string | undefined;
  const topicFilter = args['topic'] as string | undefined;
  const search = args['search'] as string | undefined;
  const limit = Math.min((args['limit'] as number | undefined) ?? 20, 200);
  const offset = (args['offset'] as number | undefined) ?? 0;

  // Fetch all live entity nodes
  let entitySql = `SELECT rowid, uid, name FROM node WHERE kind = 'entity' AND t_invalid IS NULL`;
  const params: unknown[] = [];

  if (search) {
    entitySql += ` AND name LIKE ?`;
    params.push(`%${search}%`);
  }

  entitySql += ` ORDER BY uid`;

  interface EntityRow {
    rowid: number;
    uid: string;
    name: string | null;
  }
  const entityResult = await adapter.executeAll<EntityRow>(entitySql, params.length > 0 ? params : undefined);
  const entityRows = entityResult.rows;

  if (entityRows.length === 0) {
    return { entities: [], total: 0 };
  }

  const backend = createGraphBackend(adapter);

  // For each entity, count MENTIONS edges and compute first/last seen
  const results: Array<{
    uid: string;
    name: string;
    mention_count: number;
    first_seen: string | null;
    last_seen: string | null;
  }> = [];

  for (const entity of entityRows) {
    const edges = await backend.getEdges({ dst: entity.rowid, rel: 'MENTIONS' });

    if (edges.length === 0 && !projectPath && !topicFilter) {
      continue;
    }

    const epRowids = edges.map((e) => e.src);
    if (epRowids.length === 0) continue;

    const ph = epRowids.map(() => '?').join(',');
    const epFilters: string[] = [];
    const epParams: unknown[] = [...epRowids];

    if (projectPath) {
      epFilters.push('project_path = ?');
      epParams.push(projectPath);
    }
    if (topicFilter) {
      epFilters.push('topic = ?');
      epParams.push(topicFilter);
    }
    const epFilterSql = epFilters.length > 0 ? 'AND ' + epFilters.join(' AND ') : '';

    interface EpRow {
      t_created: string;
    }
    const epResult = await adapter.executeAll<EpRow>(
      `SELECT t_created FROM node
       WHERE rowid IN (${ph}) AND kind = 'episode' AND t_invalid IS NULL ${epFilterSql}
       ORDER BY t_created`,
      epParams,
    );
    const epRows = epResult.rows;

    if (epRows.length === 0) continue;

    const mentionCount = epRows.length;
    const firstSeen = epRows[0]!.t_created;
    const lastSeen = epRows[epRows.length - 1]!.t_created;

    results.push({
      uid: entity.uid,
      name: entity.name ?? '',
      mention_count: mentionCount,
      first_seen: firstSeen,
      last_seen: lastSeen,
    });
  }

  // Sort by mention_count DESC
  results.sort((a, b) => b.mention_count - a.mention_count);
  const total = results.length;

  // Apply pagination
  const page = results.slice(offset, offset + limit);
  const entities: EntityListingEntry[] = page.map((r) => ({
    uid: r.uid,
    name: r.name,
    mention_count: r.mention_count,
    first_seen: r.first_seen ?? '',
    last_seen: r.last_seen ?? '',
  }));

  return { entities, total };
}
