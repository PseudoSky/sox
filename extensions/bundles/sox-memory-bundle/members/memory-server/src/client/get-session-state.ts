/**
 * Session state retrieval — SQL-backed lookup of session resume_state.
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type { Database } from 'better-sqlite3';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GetSessionStateResult {
  state: unknown;
}

export const inputSchema = {
  type: 'object' as const,
  properties: {
    session_id: { type: 'string' },
    db_path: {
      type: 'string',
      description:
        'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.',
    },
  },
  required: ['session_id'],
};

/**
 * Backing for memory_get_session_state.
 *
 * Retrieves the JSON resume_state blob for a session node, or null if not found.
 */
export async function getSessionState(
  db: Database,
  args: Record<string, unknown>,
): Promise<GetSessionStateResult> {
  const sessionId = args['session_id'] as string;
  const row = db
    .prepare<[string], { resume_state: string | null }>(
      `SELECT resume_state FROM node WHERE kind = 'session' AND session_id = ? AND t_invalid IS NULL`,
    )
    .get(sessionId);

  const state = row?.resume_state ? (JSON.parse(row.resume_state) as unknown) : null;
  return { state };
}
