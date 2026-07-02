/**
 * Memory recall backing — calls memoryRecall from @adhd/sox-memory-core
 * or falls back to importance-ranked SQL listing when no query is supplied.
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type { Database } from 'better-sqlite3';
import { memoryRecall, buildFiltersClause } from '@adhd/sox-memory-core';
import { parseTags, isSuperseded, supersedesUidForRowid, communityUidForRowid } from './db.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RecallEpisode {
  uid: string;
  content: string | null;
  score: number;
  t_valid: string | null;
  scope: string;
  provenance: string[];
  importance: number;
  content_hash: string | null;
  agent_id: string | null;
  summary: string | null;
  topic: string | null;
  tags: string[];
  project_path: string | null;
  is_superseded: boolean;
  supersedes_uid: string | null;
  community_uid: string | null;
}

export interface RecallResult {
  results: RecallEpisode[];
  provider_call_count: number;
}

export const inputSchema = {
  type: 'object' as const,
  properties: {
    query: {
      type: 'string',
      description:
        'Semantic query text. If absent or empty, returns importance-ranked results (no vec/FTS, sorted by importance DESC).',
    },
    db_path: {
      type: 'string',
      description:
        'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.',
    },
    scope: { type: 'string', description: 'Store scope name: project/user/org/local.' },
    agent_id: { type: 'string' },
    as_of: { type: 'string', description: 'ISO timestamp for point-in-time recall.' },
    token_budget: { type: 'number', default: 4000 },
    depth: { type: 'number', default: 1 },
    limit: { type: 'number', default: 10 },
    filters: {
      type: 'object',
      description: 'Optional filter object.',
      properties: {
        project_path: {
          oneOf: [
            { type: 'string', description: 'Exact match on node.project_path.' },
            {
              type: 'object',
              properties: { prefix: { type: 'string' } },
              required: ['prefix'],
              description: 'Prefix match.',
            },
          ],
        },
        topic: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'Exact topic string or array of topics (OR semantics).',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Any-match: episodes that have at least one of these tags.',
        },
        tags_match_all: { type: 'boolean', default: false },
        importance_min: {
          type: 'number',
          description: 'Only return episodes with importance >= this value.',
        },
        t_created_after: {
          type: 'string',
          description: 'ISO timestamp; only episodes created after this.',
        },
        t_created_before: {
          type: 'string',
          description: 'ISO timestamp; only episodes created before this.',
        },
      },
    },
  },
  required: [],
};

/**
 * Backing for memory_recall.
 *
 * If `query` is absent/empty, falls back to importance-ranked SQL listing.
 * Otherwise delegates to memoryRecall from @adhd/sox-memory-core and augments
 * each result with enrichment fields + supersession graph data.
 */
export async function recallMemory(
  db: Database,
  args: Record<string, unknown>,
): Promise<RecallResult> {
  const query = args['query'] as string | undefined;
  const filters = args['filters'] as Record<string, unknown> | undefined;
  const limit = (args['limit'] as number | undefined) ?? 10;

  type RecallRow = {
    rowid: number;
    uid: string;
    content: string | null;
    importance: number;
    t_valid: string | null;
    agent_id: string | null;
    content_hash: string | null;
    summary: string | null;
    topic: string | null;
    tags: string | null;
    project_path: string | null;
    t_invalid: string | null;
    t_created: string;
  };

  // ── No query → importance-ranked listing ──────────────────────────────────
  if (!query || !query.trim()) {
    const { sql: filterSql, params: filterParams } = buildFiltersClause(filters);
    const rows = db
      .prepare<unknown[], RecallRow>(
        `SELECT n.rowid, n.uid, n.content, n.importance, n.t_valid, n.agent_id,
                n.content_hash, n.summary, n.topic, n.tags, n.project_path,
                n.t_invalid, n.t_created
         FROM node n
         WHERE n.kind = 'episode' AND n.t_invalid IS NULL${filterSql}
         ORDER BY n.importance DESC, n.t_created DESC
         LIMIT ?`,
      )
      .all(...filterParams, limit);

    const results: RecallEpisode[] = rows.map((r: RecallRow) => ({
      uid: r.uid,
      content: r.content,
      score: r.importance / 10.0,
      t_valid: r.t_valid,
      scope: (args['scope'] as string | undefined) ?? 'project',
      provenance: ['importance'],
      importance: r.importance,
      content_hash: r.content_hash ?? null,
      agent_id: r.agent_id ?? null,
      summary: r.summary ?? null,
      topic: r.topic ?? null,
      tags: parseTags(r.tags),
      project_path: r.project_path ?? null,
      is_superseded: isSuperseded(db, r.rowid),
      supersedes_uid: supersedesUidForRowid(db, r.rowid),
      community_uid: communityUidForRowid(db, r.rowid),
    }));

    return { results, provider_call_count: 0 };
  }

  // ── Query present → hybrid recall via memory-core ─────────────────────────
  const recallFilters: Record<string, unknown> = {};
  if (filters) {
    const pp = filters['project_path'];
    if (pp !== undefined) recallFilters['project_path'] = pp;
    const tf = filters['topic'];
    if (tf !== undefined) recallFilters['topic'] = tf;
    const tg = filters['tags'];
    if (tg !== undefined) recallFilters['tags'] = tg;
    const tma = filters['tags_match_all'];
    if (tma !== undefined) recallFilters['tags_match_all'] = tma;
    const im = filters['importance_min'];
    if (im !== undefined) recallFilters['importance_min'] = im;
    const ta = filters['t_created_after'];
    if (ta !== undefined) recallFilters['t_created_after'] = ta;
    const tb = filters['t_created_before'];
    if (tb !== undefined) recallFilters['t_created_before'] = tb;
  }

  const recallResult = await memoryRecall(
    db,
    (args['scope'] as string) ?? 'project',
    {
      query,
      agent_id: args['agent_id'] as string | undefined,
      as_of: args['as_of'] as string | undefined,
      token_budget: args['token_budget'] as number | undefined,
      depth: args['depth'] as number | undefined,
      limit,
      filters: Object.keys(recallFilters).length > 0 ? recallFilters : undefined,
    },
  );

  // Augment each result with v1 enrichment fields
  const enrichedResults = recallResult.results.map((r) => {
    const nodeRow = db
      .prepare<
        [string],
        {
          rowid: number;
          summary: string | null;
          topic: string | null;
          tags: string | null;
          project_path: string | null;
          t_invalid: string | null;
        }
      >(
        `SELECT rowid, summary, topic, tags, project_path, t_invalid FROM node WHERE uid = ? LIMIT 1`,
      )
      .get(r.uid);

    return {
      uid: r.uid,
      content: r.content,
      score: r.score,
      t_valid: r.t_valid,
      scope: r.scope,
      provenance: r.provenance,
      importance: r.importance,
      content_hash: r.content_hash,
      agent_id: r.agent_id,
      summary: nodeRow?.summary ?? null,
      topic: nodeRow?.topic ?? null,
      tags: parseTags(nodeRow?.tags),
      project_path: nodeRow?.project_path ?? null,
      is_superseded: nodeRow ? isSuperseded(db, nodeRow.rowid) : false,
      supersedes_uid: nodeRow ? supersedesUidForRowid(db, nodeRow.rowid) : null,
      community_uid: nodeRow ? communityUidForRowid(db, nodeRow.rowid) : null,
    };
  }) as RecallEpisode[];

  // Apply filter-level post-processing for fields not handled by the core recall
  let filteredResults = enrichedResults;
  if (filters) {
    const { sql: filterSql, params: filterParams } = buildFiltersClause(filters);
    if (filterSql) {
      const uidsRaw = db
        .prepare<unknown[], { uid: string }>(
          `SELECT n.uid FROM node n WHERE n.uid IN (${enrichedResults.map(() => '?').join(',')})${filterSql}`,
        )
        .all(...enrichedResults.map((r: RecallEpisode) => r.uid), ...filterParams);
      const passingUids = new Set(uidsRaw.map((r: { uid: string }) => r.uid));
      filteredResults = enrichedResults.filter((r: RecallEpisode) => passingUids.has(r.uid));
    }
  }

  return {
    results: filteredResults,
    provider_call_count: recallResult.provider_call_count,
  };
}
