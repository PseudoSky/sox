/**
 * Entity search — SQL-backed name/summary LIKE lookup on entity nodes.
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type { Database } from 'better-sqlite3';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EntityEntry {
  uid: string;
  name: string | null;
  kind: string;
  summary: string | null;
  importance: number;
}

export interface SearchEntitiesResult {
  entities: EntityEntry[];
}

export const inputSchema = {
  type: 'object' as const,
  properties: {
    query: { type: 'string' },
    db_path: {
      type: 'string',
      description:
        'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.',
    },
    entity_type: { type: 'string' },
    limit: { type: 'number', default: 10 },
  },
  required: ['query'],
};

/**
 * Backing for memory_search_entities.
 *
 * Searches entity nodes by name or summary using LIKE, ordered by importance.
 */
export async function searchEntities(
  db: Database,
  args: Record<string, unknown>,
): Promise<SearchEntitiesResult> {
  const query = args['query'] as string;
  const limit = (args['limit'] as number) ?? 10;

  const rows = db
    .prepare<
      unknown[],
      { uid: string; name: string | null; kind: string; summary: string | null; importance: number }
    >(
      `SELECT uid, name, kind, summary, importance FROM node
       WHERE kind = 'entity' AND (name LIKE ? OR summary LIKE ?)
         AND t_invalid IS NULL
       ORDER BY importance DESC LIMIT ?`,
    )
    .all(`%${query}%`, `%${query}%`, limit);

  return { entities: rows };
}
