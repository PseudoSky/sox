/**
 * memory_write handler — enqueue + nudge (P2).
 *
 * P2 design (design.md §2.4): writes move behind memoryd.
 *   - Synchronous: insert node + embedding into DB + enqueue to organizer_queue.
 *   - Non-blocking: NO LLM calls here (importance defaults 1.0; organizer scores it).
 *   - Nudge: send doorbell to memoryd socket (sub-ms; non-blocking if daemon down).
 *   - Returns {episode_uid} immediately.
 *
 * Invariants:
 *   R1: zero provider/LLM calls on write path (organizer runs async in memoryd).
 *   R2: one .db per scope; idempotent init.
 *   R5: dedup via content_hash; never deletes existing episodes.
 *   R6: no OS advisory lock (host holds singleton via lifecycle block).
 */

import Database from 'better-sqlite3';
import * as crypto from 'node:crypto';
import { monotonicFactory } from 'ulid';
import { embed, vecToJson } from './embed.js';
import { enqueueIngest, nudgeDaemon } from './memoryd.js';

const ulid = monotonicFactory();

export interface WriteParams {
  content: string;
  session_id?: string | undefined;
  t_occurred?: string | undefined;
  agent_id?: string | undefined;
  source?: 'message' | 'tool_output' | 'observation' | 'document' | 'reflection' | 'import' | undefined;
  metadata?: Record<string, unknown> | undefined;
  importance?: number | undefined;
  scope?: string | undefined;
}

export interface WriteResult {
  episode_uid: string;
}

export type WriteError =
  | { code: 'E_SCOPE_RO'; message: string }
  | { code: 'E_DEDUP'; message: string; existing_uid: string }
  | { code: 'E_QUEUE_FULL'; message: string };

/**
 * Write a memory episode to the database.
 * P2: enqueue into organizer_queue + nudge memoryd.
 * The organizer will asynchronously score importance and extract entities/relations.
 */
export async function memoryWrite(
  db: Database.Database,
  params: WriteParams,
): Promise<WriteResult | WriteError> {
  const {
    content,
    session_id,
    t_occurred,
    agent_id,
    source = 'message',
    importance = 1.0, // default; organizer will update via LLM scoring
    scope = 'project',
  } = params;

  if (!content || !content.trim()) {
    return { code: 'E_SCOPE_RO', message: 'content must not be empty' };
  }

  // SHA-256 dedup on normalized content
  const normalized = content.trim().toLowerCase();
  const contentHash = crypto.createHash('sha256').update(normalized).digest('hex');

  // Check for duplicate (R5: never delete, dedup by hash)
  const existing = db
    .prepare<[string], { uid: string }>('SELECT uid FROM node WHERE content_hash = ?')
    .get(contentHash);
  if (existing) {
    return {
      code: 'E_DEDUP',
      message: `Duplicate content: ${contentHash}`,
      existing_uid: existing.uid,
    };
  }

  const uid = ulid();
  const now = new Date().toISOString();
  const tValid = now;
  const tOccurred = t_occurred ?? now;

  // Compute embedding locally (zero provider calls — R1)
  // Real backend: in-process ONNX inference; no per-query network.
  const embeddingVec = await embed(content);
  const embeddingJson = vecToJson(embeddingVec);

  // Atomic transaction: insert node + vec + FTS (via trigger) + enqueue
  const tx = db.transaction(() => {
    const result = db.prepare<unknown[], { rowid: number }>(
      `INSERT INTO node (uid, kind, content, agent_id, session_id, source, importance,
                         content_hash, t_created, t_occurred, t_valid)
       VALUES (?, 'episode', ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING rowid`,
    ).get(uid, content, agent_id ?? null, session_id ?? null, source, importance,
          contentHash, now, tOccurred, tValid);

    if (!result) throw new Error('Insert failed: no rowid returned');
    const rowid = result.rowid;

    // Insert into vec_node (accepts JSON string or binary blob)
    db.prepare('INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)').run(
      rowid,
      embeddingJson,
    );

    // Enqueue for async organize (LLM step in memoryd→organizer)
    enqueueIngest(db, uid, scope, agent_id ?? null);

    return uid;
  });

  const episodeUid = tx() as string;

  // Non-blocking nudge to memoryd via socket doorbell
  nudgeDaemon();

  return { episode_uid: episodeUid };
}

/**
 * Invalidate a claim (bi-temporal: sets t_invalid, never deletes — R5).
 * Writes a SUPERSEDES edge from replacement → old claim.
 */
export interface InvalidateParams {
  claim_uid: string;
  reason: string;
  t_transition?: string;
  replacement_uid?: string;
}

export interface InvalidateResult {
  ok: boolean;
  supersedes_edge_uid?: string;
}

export type InvalidateError =
  | { code: 'E_NOT_FOUND'; message: string }
  | { code: 'E_SCOPE_RO'; message: string };

export function memoryInvalidate(
  db: Database.Database,
  params: InvalidateParams,
): InvalidateResult | InvalidateError {
  const { claim_uid, reason, t_transition, replacement_uid } = params;
  const tTransition = t_transition ?? new Date().toISOString();

  const claim = db
    .prepare<[string], { rowid: number }>(`SELECT rowid FROM node WHERE uid = ? AND t_invalid IS NULL`)
    .get(claim_uid);

  if (!claim) {
    return { code: 'E_NOT_FOUND', message: `Claim not found or already invalidated: ${claim_uid}` };
  }

  let supersedgesEdgeUid: string | undefined;

  db.transaction(() => {
    // Close t_invalid (R5: never delete, invalidate instead)
    db.prepare(`UPDATE node SET t_invalid = ? WHERE uid = ?`).run(tTransition, claim_uid);

    if (replacement_uid) {
      const replacement = db
        .prepare<[string], { rowid: number }>(`SELECT rowid FROM node WHERE uid = ? AND t_invalid IS NULL`)
        .get(replacement_uid);

      if (replacement) {
        supersedgesEdgeUid = `sup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        db.prepare(
          `INSERT INTO edge (src, dst, rel, origin, t_created, meta)
           VALUES (?, ?, 'SUPERSEDES', 'user_asserted', ?, ?)`,
        ).run(replacement.rowid, claim.rowid, tTransition, JSON.stringify({ reason }));
      }
    }
  })();

  const result: InvalidateResult = { ok: true };
  if (supersedgesEdgeUid !== undefined) result.supersedes_edge_uid = supersedgesEdgeUid;
  return result;
}
