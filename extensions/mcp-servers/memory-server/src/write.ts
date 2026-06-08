/**
 * memory_write handler — synchronous insert + embed + FTS index + SHA-256 dedup.
 * Returns {episode_uid}.
 *
 * P1 (MVP): in-process write, no daemon, no LLM.
 * importance defaults 1.0 (LLM scoring is a P2 organizer concern).
 */

import Database from 'better-sqlite3';
import * as crypto from 'node:crypto';
import { monotonicFactory } from 'ulid';
import { embedText, vecToBuffer } from './embed.js';

const ulid = monotonicFactory();

export interface WriteParams {
  content: string;
  session_id?: string | undefined;
  t_occurred?: string | undefined;
  agent_id?: string | undefined;
  source?: 'message' | 'tool_output' | 'observation' | 'document' | 'reflection' | 'import' | undefined;
  metadata?: Record<string, unknown> | undefined;
  importance?: number | undefined;
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
 * In-process: no IPC, no queue — direct synchronous write.
 * This is the MVP path; P2 will move this behind memoryd.
 */
export function memoryWrite(
  db: Database.Database,
  params: WriteParams,
): WriteResult | WriteError {
  const {
    content,
    session_id,
    t_occurred,
    agent_id,
    source = 'message',
    importance = 1.0,
  } = params;

  if (!content || !content.trim()) {
    return { code: 'E_SCOPE_RO', message: 'content must not be empty' };
  }

  // SHA-256 dedup on normalized content
  const normalized = content.trim().toLowerCase();
  const contentHash = crypto.createHash('sha256').update(normalized).digest('hex');

  // Check for duplicate
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

  // Compute embedding
  const embeddingVec = embedText(content);
  const embeddingBuf = vecToBuffer(embeddingVec);

  // Atomic transaction: insert node + vec + FTS (FTS via trigger)
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

    // Insert into vec_node (sqlite-vec accepts binary blob for the embedding)
    db.prepare('INSERT INTO vec_node(node_id, embedding) VALUES (?, ?)').run(
      rowid,
      embeddingBuf,
    );

    return uid;
  });

  const episodeUid = tx() as string;
  return { episode_uid: episodeUid };
}
