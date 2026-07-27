/**
 * Session state — get/upsert JSON resume_state blobs keyed by session_id.
 *
 * Uses raw node-table lookups (no graph-store edge operations needed).
 * Session nodes are self-contained: kind='session', session_id, resume_state.
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type { StoreAdapter } from '@adhd/sox-store-adapter';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface GetSessionStateResult {
  state: unknown;
}

export interface SaveSessionStateResult {
  ok: boolean;
}

// ── get ────────────────────────────────────────────────────────────────────────

export async function memoryGetSessionState(
  adapter: StoreAdapter,
  args: Record<string, unknown>,
): Promise<GetSessionStateResult> {
  const sessionId = args['session_id'] as string;
  const row = await adapter.executeGet<{ resume_state: string | null }>(
    `SELECT resume_state FROM node WHERE kind = 'session' AND session_id = ? AND t_invalid IS NULL`,
    [sessionId],
  );

  const state = row?.resume_state ? (JSON.parse(row.resume_state) as unknown) : null;
  return { state };
}

// ── save ───────────────────────────────────────────────────────────────────────

export async function memorySaveSessionState(
  adapter: StoreAdapter,
  args: Record<string, unknown>,
): Promise<SaveSessionStateResult> {
  const sessionId = args['session_id'] as string;
  const state = JSON.stringify(args['state']);
  const now = new Date().toISOString();
  const uid = `session-${sessionId}-${now}`;

  await adapter.transaction(async (tx) => {
    await tx.executeRun(
      `UPDATE node SET t_invalid = ? WHERE kind = 'session' AND session_id = ? AND t_invalid IS NULL`,
      [now, sessionId],
    );
    await tx.executeRun(
      `INSERT INTO node (uid, kind, session_id, resume_state, t_created, t_valid)
       VALUES (?, 'session', ?, ?, ?, ?)`,
      [uid, sessionId, state, now, now],
    );
  });

  return { ok: true };
}
