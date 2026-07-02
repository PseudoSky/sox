/**
 * Session state save — SQL upsert (close old, insert new).
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type { Database } from 'better-sqlite3';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SaveSessionStateResult {
  ok: boolean;
}

export const inputSchema = {
  type: 'object' as const,
  properties: {
    session_id: { type: 'string' },
    state: { type: 'object' },
    db_path: {
      type: 'string',
      description:
        'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.',
    },
  },
  required: ['session_id', 'state'],
};

/**
 * Backing for memory_save_session_state.
 *
 * Atomically closes the previous active session node (t_invalid = now) and
 * inserts a new session node with the new state.
 */
export async function saveSessionState(
  db: Database,
  args: Record<string, unknown>,
): Promise<SaveSessionStateResult> {
  const sessionId = args['session_id'] as string;
  const state = JSON.stringify(args['state']);
  const now = new Date().toISOString();
  const uid = `session-${sessionId}-${now}`;

  db.transaction(() => {
    db.prepare(
      `UPDATE node SET t_invalid = ? WHERE kind = 'session' AND session_id = ? AND t_invalid IS NULL`,
    ).run(now, sessionId);
    db.prepare(
      `INSERT INTO node (uid, kind, session_id, resume_state, t_created, t_valid)
       VALUES (?, 'session', ?, ?, ?, ?)`,
    ).run(uid, sessionId, state, now, now);
  })();

  return { ok: true };
}
