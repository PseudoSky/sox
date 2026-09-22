/**
 * memoryGetEntityEpisodes — episodes mentioning an entity via MENTIONS edges.
 *
 * Resolves entity by uid or name, then joins live MENTIONS edges to their
 * live episode source nodes in a single SQL query (BL: Q4 of the near-dup
 * invalidation fix plan). `total`, `invalidated_count`, and the paginated
 * page are all derived from the SAME live-filtered join — pagination never
 * slices a raw, unfiltered edge array. Results are ordered
 * `importance DESC, rowid ASC` per the tool's documented "ranked by
 * importance" contract (memory-server/src/index.ts).
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { parseTags, isSuperseded, supersedesUidForRowid, communityUidForRowid } from './recall.js';

// ── Types ──────────────────────────────────────────────────────────────────────

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
  /** Live MENTIONS edges whose source episode is invalidated. Observability
   *  only, not the fix — should trend to zero once the near-dup pass stops
   *  auto-invalidating (Q1 of the near-dup invalidation fix plan). */
  invalidated_count?: number;
  code?: string;
  message?: string;
  candidates?: string[];
}

// ── Main ───────────────────────────────────────────────────────────────────────

export async function memoryGetEntityEpisodes(
  adapter: StoreAdapter,
  args: Record<string, unknown>,
): Promise<EntityEpisodesResult> {
  const entityUid = args['entity_uid'] as string | undefined;
  const entityName = args['entity_name'] as string | undefined;
  const limit = Math.min((args['limit'] as number | undefined) ?? 20, 200);
  const offset = (args['offset'] as number | undefined) ?? 0;

  let resolvedEntityUid = entityUid;
  let resolvedEntityName = '';

  if (!resolvedEntityUid && entityName) {
    const matchResult = await adapter.executeAll<{ uid: string; name: string }>(
      `SELECT uid, name FROM node WHERE kind = 'entity' AND LOWER(name) = LOWER(?) AND t_invalid IS NULL`,
      [entityName],
    );
    const matchRows = matchResult.rows;

    if (matchRows.length === 0) {
      return {
        code: 'E_NOT_FOUND',
        episodes: [],
        total: 0,
        entity: { uid: '', name: entityName },
      };
    }
    if (matchRows.length > 1) {
      return {
        code: 'E_AMBIGUOUS',
        episodes: [],
        total: 0,
        entity: { uid: '', name: entityName },
        candidates: matchRows.map((r) => r.uid),
      };
    }
    resolvedEntityUid = matchRows[0]!.uid;
    resolvedEntityName = matchRows[0]!.name ?? entityName;
  }

  if (!resolvedEntityUid) {
    return {
      code: 'E_MISSING_INPUT',
      episodes: [],
      total: 0,
      entity: { uid: '', name: '' },
    };
  }

  if (!resolvedEntityName) {
    const nameRow = await adapter.executeGet<{ name: string | null }>(
      `SELECT name FROM node WHERE uid = ? LIMIT 1`,
      [resolvedEntityUid],
    );
    resolvedEntityName = nameRow?.name ?? resolvedEntityUid;
  }

  const entityRow = await adapter.executeGet<{ rowid: number }>(
    `SELECT rowid FROM node WHERE uid = ? LIMIT 1`,
    [resolvedEntityUid],
  );

  if (!entityRow) {
    return {
      code: 'E_NOT_FOUND',
      episodes: [],
      total: 0,
      entity: { uid: resolvedEntityUid, name: resolvedEntityName },
    };
  }

  // total/invalidated_count/page all derive from the SAME live-filtered
  // MENTIONS→episode join — pagination must never slice a raw edge array
  // (that was the defect: total counted invalid edges while pages were
  // filtered afterward, so pages came back short and offsets shifted
  // meaning as invalid rows fell in different slices).
  const totalRow = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt
       FROM edge e JOIN node n ON n.rowid = e.src
      WHERE e.dst = ? AND e.rel = 'MENTIONS' AND e.t_invalid IS NULL
        AND n.kind = 'episode' AND n.t_invalid IS NULL`,
    [entityRow.rowid],
  );
  const total = totalRow?.cnt ?? 0;

  const invalidatedRow = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt
       FROM edge e JOIN node n ON n.rowid = e.src
      WHERE e.dst = ? AND e.rel = 'MENTIONS' AND e.t_invalid IS NULL
        AND n.kind = 'episode' AND n.t_invalid IS NOT NULL`,
    [entityRow.rowid],
  );
  const invalidatedCount = invalidatedRow?.cnt ?? 0;

  interface EpRow {
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
  }
  const pageResult = await adapter.executeAll<EpRow>(
    `SELECT n.rowid, n.uid, n.content, n.summary, n.topic, n.tags, n.project_path,
            n.importance, n.t_created, n.agent_id
       FROM edge e JOIN node n ON n.rowid = e.src
      WHERE e.dst = ? AND e.rel = 'MENTIONS' AND e.t_invalid IS NULL
        AND n.kind = 'episode' AND n.t_invalid IS NULL
      ORDER BY n.importance DESC, n.rowid ASC
      LIMIT ? OFFSET ?`,
    [entityRow.rowid, limit, offset],
  );

  const episodes: EpisodeSummary[] = [];
  for (const r of pageResult.rows) {
    episodes.push({
      uid: r.uid,
      content: r.content,
      summary: r.summary ?? null,
      topic: r.topic ?? null,
      tags: parseTags(r.tags),
      project_path: r.project_path ?? null,
      importance: r.importance,
      t_created: r.t_created,
      agent_id: r.agent_id ?? null,
      is_superseded: await isSuperseded(adapter, r.rowid),
      supersedes_uid: await supersedesUidForRowid(adapter, r.rowid),
      community_uid: await communityUidForRowid(adapter, r.rowid),
    });
  }

  return {
    entity: { uid: resolvedEntityUid, name: resolvedEntityName },
    episodes,
    total,
    invalidated_count: invalidatedCount,
  };
}
