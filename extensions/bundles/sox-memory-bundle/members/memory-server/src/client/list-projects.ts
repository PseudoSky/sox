/**
 * Project listing — SQL COUNT DISTINCT aggregate.
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type { Database } from 'better-sqlite3';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProjectEntry {
  project_path: string;
  episode_count: number;
  last_written: string;
}

export interface ListProjectsResult {
  projects: ProjectEntry[];
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
    limit: { type: 'number', default: 20, maximum: 200 },
    offset: { type: 'number', default: 0 },
  },
  required: [],
};

/**
 * Backing for memory_list_projects.
 *
 * Returns distinct project_path values present in the store, with episode
 * counts and last-written timestamps.
 */
export async function listProjects(
  db: Database,
  args: Record<string, unknown>,
): Promise<ListProjectsResult> {
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
