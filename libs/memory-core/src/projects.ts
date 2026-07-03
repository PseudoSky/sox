/**
 * memoryListProjects — domain query: list distinct project_path values
 * with episode counts.
 *
 * Uses raw SQL GROUP BY / COUNT — no graph-store needed.
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type Database from 'better-sqlite3';

export interface ProjectEntry {
  project_path: string;
  episode_count: number;
  last_written: string;
}

export interface ListProjectsResult {
  projects: ProjectEntry[];
  total: number;
}

export function memoryListProjects(
  db: Database.Database,
  args: Record<string, unknown>,
): ListProjectsResult {
  const limit = Math.min((args['limit'] as number | undefined) ?? 20, 200);
  const offset = (args['offset'] as number | undefined) ?? 0;

  const countRow = db
    .prepare<[], { cnt: number }>(
      `SELECT COUNT(DISTINCT project_path) AS cnt
       FROM node
       WHERE kind = 'episode' AND t_invalid IS NULL AND project_path IS NOT NULL`,
    )
    .get();
  const total = countRow?.cnt ?? 0;

  const rows = db
    .prepare<
      [number, number],
      { project_path: string; episode_count: number; last_written: string }
    >(
      `SELECT project_path, COUNT(*) AS episode_count, MAX(t_created) AS last_written
       FROM node
       WHERE kind = 'episode' AND t_invalid IS NULL AND project_path IS NOT NULL
       GROUP BY project_path
       ORDER BY last_written DESC
       LIMIT ? OFFSET ?`,
    )
    .all(limit, offset);

  return { projects: rows, total };
}
