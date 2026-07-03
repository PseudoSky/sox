/**
 * memoryListTopics — domain query: list topics in the store with episode counts
 * and community backing status.
 *
 * Uses raw SQL GROUP BY / COUNT / AVG — no graph-store needed.
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type Database from 'better-sqlite3';

export interface TopicEntry {
  topic: string;
  episode_count: number;
  avg_importance: number;
  last_written: string;
  community_uid: string | null;
  has_community: boolean;
}

export interface TopicsResult {
  topics: TopicEntry[];
  total: number;
}

const ORDER_MAP: Record<string, string> = {
  episode_count: 'episode_count DESC',
  avg_importance: 'avg_importance DESC',
  last_written: 'last_written DESC',
};

export function memoryListTopics(
  db: Database.Database,
  args: Record<string, unknown>,
): TopicsResult {
  const projectPath = args['project_path'] as string | undefined;
  const search = args['search'] as string | undefined;
  const sortBy = (args['sort_by'] as string | undefined) ?? 'episode_count';
  const limit = Math.min((args['limit'] as number | undefined) ?? 20, 200);
  const offset = (args['offset'] as number | undefined) ?? 0;

  const orderClause = ORDER_MAP[sortBy] ?? 'episode_count DESC';

  const extraFilters: string[] = [];
  const extraParams: unknown[] = [];

  if (projectPath) {
    extraFilters.push('AND n.project_path = ?');
    extraParams.push(projectPath);
  }
  if (search) {
    extraFilters.push('AND n.topic LIKE ?');
    extraParams.push(`%${search}%`);
  }

  const extraSql = extraFilters.join(' ');

  // Total count
  const countRow = db
    .prepare<unknown[], { cnt: number }>(
      `SELECT COUNT(DISTINCT n.topic) AS cnt
       FROM node n
       WHERE n.kind = 'episode' AND n.t_invalid IS NULL AND n.topic IS NOT NULL
       ${extraSql}`,
    )
    .get(...extraParams);
  const total = countRow?.cnt ?? 0;

  // Per-topic aggregate
  type TopicRow = {
    topic: string;
    episode_count: number;
    avg_importance: number;
    last_written: string;
  };

  const rows = db
    .prepare<unknown[], TopicRow>(
      `SELECT n.topic AS topic,
              COUNT(*) AS episode_count,
              AVG(n.importance) AS avg_importance,
              MAX(n.t_created) AS last_written
       FROM node n
       WHERE n.kind = 'episode' AND n.t_invalid IS NULL AND n.topic IS NOT NULL
       ${extraSql}
       GROUP BY n.topic
       ORDER BY ${orderClause}
       LIMIT ? OFFSET ?`,
    )
    .all(...extraParams, limit, offset);

  // Enrich each topic with community_uid
  const topics: TopicEntry[] = rows.map((r: TopicRow) => {
    const commRow = db
      .prepare<[string], { uid: string }>(
        `SELECT n2.uid FROM node n1
         JOIN edge e ON e.src = n1.rowid AND e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
         JOIN node n2 ON n2.rowid = e.dst AND n2.kind = 'community' AND n2.t_invalid IS NULL
         WHERE n1.kind = 'episode' AND n1.t_invalid IS NULL AND n1.topic = ?
         LIMIT 1`,
      )
      .get(r.topic);

    return {
      topic: r.topic,
      episode_count: r.episode_count,
      avg_importance: r.avg_importance,
      last_written: r.last_written,
      community_uid: commRow?.uid ?? null,
      has_community: commRow !== undefined,
    };
  });

  return { topics, total };
}
