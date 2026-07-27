/**
 * memoryListTopics — domain query: list topics in the store with episode counts
 * and community backing status.
 *
 * Uses raw SQL GROUP BY / COUNT / AVG — no graph-store needed.
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type { StoreAdapter } from '@adhd/sox-store-adapter';

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

export async function memoryListTopics(
  adapter: StoreAdapter,
  args: Record<string, unknown>,
): Promise<TopicsResult> {
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
  const countRow = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(DISTINCT n.topic) AS cnt
     FROM node n
     WHERE n.kind = 'episode' AND n.t_invalid IS NULL AND n.topic IS NOT NULL
     ${extraSql}`,
    extraParams.length > 0 ? extraParams : undefined,
  );
  const total = countRow?.cnt ?? 0;

  // Per-topic aggregate
  const topicResult = await adapter.executeAll(
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
    [...extraParams, limit, offset],
  );
  const rows = topicResult.rows as Array<{
    topic: string;
    episode_count: number;
    avg_importance: number;
    last_written: string;
  }>;

  // Enrich each topic with community_uid
  const topics: TopicEntry[] = [];
  for (const r of rows) {
    const commRow = await adapter.executeGet<{ uid: string }>(
      `SELECT n2.uid FROM node n1
       JOIN edge e ON e.src = n1.rowid AND e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
       JOIN node n2 ON n2.rowid = e.dst AND n2.kind = 'community' AND n2.t_invalid IS NULL
       WHERE n1.kind = 'episode' AND n1.t_invalid IS NULL AND n1.topic = ?
       LIMIT 1`,
      [r.topic],
    );

    topics.push({
      topic: r.topic,
      episode_count: r.episode_count,
      avg_importance: r.avg_importance,
      last_written: r.last_written,
      community_uid: commRow?.uid ?? null,
      has_community: commRow !== undefined,
    });
  }

  return { topics, total };
}
