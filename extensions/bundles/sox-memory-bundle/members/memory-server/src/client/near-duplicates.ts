/**
 * Near-duplicate pairs — SQL query over SAME_AS edges with optional filters.
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type { Database } from 'better-sqlite3';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NearDuplicatePair {
  uid_a: string;
  uid_b: string;
  cosine_sim: number;
  content_preview_a: string;
  content_preview_b: string;
  already_merged: boolean;
}

export interface NearDuplicatesResult {
  pairs: NearDuplicatePair[];
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
    project_path: { type: 'string' },
    topic: { type: 'string' },
    threshold: { type: 'number', description: 'Minimum cosine similarity stored in the SAME_AS edge meta.' },
    limit: { type: 'number', default: 20, maximum: 200 },
    offset: { type: 'number', default: 0 },
  },
  required: [],
};

/**
 * Backing for memory_near_duplicates.
 *
 * Lists near-duplicate episode pairs connected by SAME_AS edges. Optional
 * filters for project_path, topic, and cosine similarity threshold.
 */
export async function getNearDuplicates(
  db: Database,
  args: Record<string, unknown>,
): Promise<NearDuplicatesResult> {
  const projectPath = args['project_path'] as string | undefined;
  const topicFilter = args['topic'] as string | undefined;
  const cosineThreshold = args['threshold'] as number | undefined;
  const limit = Math.min((args['limit'] as number | undefined) ?? 20, 200);
  const offset = (args['offset'] as number | undefined) ?? 0;

  const extraFilters: string[] = [];
  const extraParams: unknown[] = [];

  if (projectPath) {
    extraFilters.push('(na.project_path = ? OR nb.project_path = ?)');
    extraParams.push(projectPath, projectPath);
  }
  if (topicFilter) {
    extraFilters.push('(na.topic = ? OR nb.topic = ?)');
    extraParams.push(topicFilter, topicFilter);
  }
  if (typeof cosineThreshold === 'number') {
    extraFilters.push('CAST(json_extract(e.meta, \'$.cosine_sim\') AS REAL) >= ?');
    extraParams.push(cosineThreshold);
  }

  const extraSql = extraFilters.length > 0 ? 'AND ' + extraFilters.join(' AND ') : '';

  const countRow = db
    .prepare<unknown[], { cnt: number }>(
      `SELECT COUNT(*) AS cnt
       FROM edge e
       JOIN node na ON na.rowid = e.src
       JOIN node nb ON nb.rowid = e.dst
       WHERE e.rel = 'SAME_AS' AND e.t_expired IS NULL
         AND na.kind = 'episode' AND nb.kind = 'episode'
       ${extraSql}`,
    )
    .get(...extraParams);
  const total = countRow?.cnt ?? 0;

  const rows = db
    .prepare<
      unknown[],
      {
        uid_a: string;
        uid_b: string;
        content_a: string | null;
        content_b: string | null;
        invalid_b: string | null;
        meta: string | null;
      }
    >(
      `SELECT na.uid AS uid_a, nb.uid AS uid_b,
              na.content AS content_a, nb.content AS content_b,
              nb.t_invalid AS invalid_b,
              e.meta
       FROM edge e
       JOIN node na ON na.rowid = e.src
       JOIN node nb ON nb.rowid = e.dst
       WHERE e.rel = 'SAME_AS' AND e.t_expired IS NULL
         AND na.kind = 'episode' AND nb.kind = 'episode'
       ${extraSql}
       LIMIT ? OFFSET ?`,
    )
    .all(...extraParams, limit, offset);

  type NearDupRow = {
    uid_a: string;
    uid_b: string;
    content_a: string | null;
    content_b: string | null;
    invalid_b: string | null;
    meta: string | null;
  };

  const pairs: NearDuplicatePair[] = rows.map((r: NearDupRow) => {
    let cosineSim = 0;
    if (r.meta) {
      try {
        const m = JSON.parse(r.meta) as { cosine_sim?: number };
        cosineSim = m.cosine_sim ?? 0;
      } catch {
        /* malformed */
      }
    }
    return {
      uid_a: r.uid_a,
      uid_b: r.uid_b,
      cosine_sim: cosineSim,
      content_preview_a: (r.content_a ?? '').slice(0, 120),
      content_preview_b: (r.content_b ?? '').slice(0, 120),
      already_merged: r.invalid_b !== null,
    };
  });

  return { pairs, total };
}
