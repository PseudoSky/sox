/**
 * memoryGetEntityEpisodes — episodes mentioning an entity via MENTIONS edges.
 *
 * Resolves entity by uid or name, then uses getEdges({dst, rel:'MENTIONS'})
 * to find episodes that mention it. Node details fetched via raw SQL.
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { createGraphBackend } from '@adhd/sox-graph-store';
import type { EdgeRecord } from '@adhd/sox-graph-store';
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

  const backend = createGraphBackend(adapter);

  // Get MENTIONS edges where dst = entity
  const edges = await backend.getEdges({ dst: entityRow.rowid, rel: 'MENTIONS' });
  const total = edges.length;

  // Paginate in code
  const pageEdges: EdgeRecord[] = edges.slice(offset, offset + limit);

  // Look up episode nodes for each edge src
  const episodeRowids = pageEdges.map((e) => e.src);
  const episodeMap = new Map<number, {
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
  }>();

  if (episodeRowids.length > 0) {
    const ph = episodeRowids.map(() => '?').join(',');
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
      t_invalid: string | null;
    }
    const result = await adapter.executeAll<EpRow>(
      `SELECT rowid, uid, content, summary, topic, tags, project_path,
              importance, t_created, agent_id, t_invalid
       FROM node WHERE rowid IN (${ph}) AND kind = 'episode' AND t_invalid IS NULL`,
      episodeRowids,
    );
    for (const r of result.rows) {
      episodeMap.set(r.rowid, r);
    }
  }

  const episodes: EpisodeSummary[] = [];
  for (const e of pageEdges) {
    const r = episodeMap.get(e.src);
    if (r) {
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
  }

  return {
    entity: { uid: resolvedEntityUid, name: resolvedEntityName },
    episodes,
    total,
  };
}
