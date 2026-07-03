/**
 * memoryGetRelated — graph neighbors at depth=1 using graph-store edge queries.
 *
 * Uses getEdges({src}) for outbound, getEdges({dst}) for inbound.
 * Node details fetched via raw SQL (uid not in NodeRecord).
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type Database from 'better-sqlite3';
import { createGraphBackend } from '@adhd/sox-graph-store';
import type { EdgeRecord } from '@adhd/sox-graph-store';
import { parseTags, isSuperseded, supersedesUidForRowid, communityUidForRowid } from './recall.js';

// ── Types ──────────────────────────────────────────────────────────────────────

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
}

interface NodeRow {
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

function nodeRowToEpisode(db: Database.Database, r: NodeRow): EpisodeBase {
  return {
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
  };
}

// ── Main ───────────────────────────────────────────────────────────────────────

export async function memoryGetRelated(
  db: Database.Database,
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

  const backend = createGraphBackend(db);
  const srcRowid = sourceRow.rowid;

  // Outbound edges
  const outEdgesRaw = backend.getEdges({ src: srcRowid });
  // Inbound edges
  const inEdgesRaw = backend.getEdges({ dst: srcRowid });

  // Filter by rel if provided
  const relSet = relFilter && relFilter.length > 0 ? new Set(relFilter) : null;
  const filterByRel = (e: EdgeRecord) => !relSet || relSet.has(e.rel);

  const outEdges = outEdgesRaw.filter(filterByRel).slice(0, limit);
  const inEdges = inEdgesRaw.filter(filterByRel).slice(0, limit);

  // Collect all neighbor rowids
  const neighborRowids = new Set<number>();
  for (const e of outEdges) neighborRowids.add(e.dst);
  for (const e of inEdges) neighborRowids.add(e.src);

  // Batch look up nodes
  const nodeMap = new Map<number, NodeRow>();
  if (neighborRowids.size > 0) {
    const ph = Array.from(neighborRowids, () => '?').join(',');
    const rows = db
      .prepare<unknown[], NodeRow>(
        `SELECT rowid, uid, content, summary, topic, tags, project_path,
                importance, t_created, agent_id, t_invalid
         FROM node WHERE rowid IN (${ph}) AND t_invalid IS NULL`,
      )
      .all(...neighborRowids);
    for (const r of rows) {
      nodeMap.set(r.rowid, r);
    }
  }

  // Build edges
  const edges: EdgeEntry[] = [];
  for (const e of outEdges) {
    const node = nodeMap.get(e.dst);
    if (node) {
      edges.push({
        episode: nodeRowToEpisode(db, node),
        rel: e.rel,
        weight: e.weight ?? 1.0,
        direction: 'outbound',
      });
    }
  }
  for (const e of inEdges) {
    const node = nodeMap.get(e.src);
    if (node) {
      edges.push({
        episode: nodeRowToEpisode(db, node),
        rel: e.rel,
        weight: e.weight ?? 1.0,
        direction: 'inbound',
      });
    }
  }

  return { source_uid: uid, edges: edges.slice(0, limit) };
}
