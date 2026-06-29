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

import { enrichOnWrite } from './enrich.js';
import Database from 'better-sqlite3';
import * as crypto from 'node:crypto';
import { monotonicFactory } from 'ulid';
import { embed, vecToJson } from './embed.js';
import { enqueueIngest, nudgeDaemon } from './memoryd.js';

const ulid = monotonicFactory();

export interface WriteParams {
  content: string;
  /** Human-readable summary / topic of the content (persisted to node.summary). */
  summary?: string | undefined;
  /** (E2) Title / name for this episode (node.name). */
  name?: string | undefined;
  /** (E5) Explicit topic override. Stored to node.topic; takes priority over [<topic>] prefix. */
  topic?: string | undefined;
  /** (E1) Caller project root path. Auto-detected from cwd+git if omitted. */
  project_path?: string | undefined;
  /** (E9) UID of a parent episode; emits a DERIVED_FROM edge from this episode to parent. */
  derived_from_uid?: string | undefined;
  session_id?: string | undefined;
  t_occurred?: string | undefined;
  agent_id?: string | undefined;
  source?: 'message' | 'tool_output' | 'observation' | 'document' | 'reflection' | 'import' | undefined;
  metadata?: Record<string, unknown> | undefined;
  importance?: number | undefined;
  scope?: string | undefined;
  tags?: string[] | undefined;
}

export interface WriteResult {
  episode_uid: string;
  /** Enrichment fields resolved at write time via enrichOnWrite (E1–E5, E8, E10, E12). */
  enrichment?: {
    topic: string | null;
    project_path: string | null;
    summary: string | null;
    tags: string[];
    near_dup: { existing_uid: string; cosine_sim: number } | null;
  };
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
    summary,
    name,
    topic,
    project_path,
    derived_from_uid,
    session_id,
    t_occurred,
    agent_id,
    source = 'message',
    importance = 1.0, // default; batch enricher will update on next pass
    scope = 'project',
    tags,
    metadata,
  } = params;

  // Caller-supplied metadata is persisted as JSON (previously silently dropped).
  const metaJson = metadata !== undefined ? JSON.stringify(metadata) : null;

  // (E5) Parse [<topic>] prefix from content if no explicit topic was supplied.
  // Regex matches `[<topic>]` at the start of content (up to 64 chars, no newlines).
  let resolvedTopic: string | null = topic ?? null;
  if (resolvedTopic === null) {
    const prefixMatch = /^\s*\[([^\]\n]{1,64})\]/.exec(content);
    if (prefixMatch) resolvedTopic = prefixMatch[1] ?? null;
  }

  // (E4) Tags JSON column — retain the raw string[] alongside the MENTIONS edges.
  const tagsJson = tags && tags.length > 0 ? JSON.stringify(tags) : null;

  // (E1) project_path — use caller value if supplied; auto-detection (resolveProjectPath)
  // will be wired in P2 via enrichOnWrite. For P1 we store caller-supplied value only.
  const resolvedProjectPath: string | null = project_path ?? null;

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

  // Track rowid for post-transaction enrichOnWrite call
  let insertedRowid = 0;

  // Atomic transaction: insert node + vec + FTS (via trigger) + enqueue
  const tx = db.transaction(() => {
    const result = db.prepare<unknown[], { rowid: number }>(
      `INSERT INTO node (uid, kind, content, name, summary, meta, agent_id, session_id, source,
                         importance, content_hash, t_created, t_occurred, t_valid,
                         topic, tags, project_path)
       VALUES (?, 'episode', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING rowid`,
    ).get(uid, content, name ?? null, summary ?? null, metaJson,
      agent_id ?? null, session_id ?? null, source, importance,
      contentHash, now, tOccurred, tValid,
      resolvedTopic, tagsJson, resolvedProjectPath);

    if (!result) throw new Error('Insert failed: no rowid returned');
    const rowid = result.rowid;
    insertedRowid = rowid;

    // Insert into vec_node (accepts JSON string or binary blob)
    db.prepare('INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)').run(
      rowid,
      embeddingJson,
    );

    // Enqueue for async organize (LLM step in memoryd→organizer)
    enqueueIngest(db, uid, scope, agent_id ?? null);

    // Attach user-asserted tags as entity nodes + MENTIONS edges (no organizer delay)
    if (tags && tags.length > 0) {
      for (const tag of tags) {
        const tagName = tag.trim();
        if (!tagName) continue;
        const existingEntity = db
          .prepare<[string], { rowid: number }>(
            `SELECT rowid FROM node WHERE kind = 'entity' AND name = ? AND t_invalid IS NULL`,
          )
          .get(tagName);
        const entityRowid = existingEntity?.rowid ?? (() => {
          const entityUid = ulid();
          const r = db
            .prepare<unknown[], { rowid: number }>(
              `INSERT INTO node (uid, kind, name, t_created, t_valid) VALUES (?, 'entity', ?, ?, ?) RETURNING rowid`,
            )
            .get(entityUid, tagName, now, now);
          if (!r) throw new Error(`Failed to insert entity node for tag: ${tagName}`);
          return r.rowid;
        })();
        db.prepare(
          `INSERT INTO edge (src, dst, rel, origin, t_created, meta)
           SELECT ?, ?, 'MENTIONS', 'user_asserted', ?, '{}'
           WHERE NOT EXISTS (
             SELECT 1 FROM edge WHERE src=? AND dst=? AND rel='MENTIONS' AND t_expired IS NULL
           )`,
        ).run(rowid, entityRowid, now, rowid, entityRowid);
      }
    }

    // (E9) Explicit DERIVED_FROM edge when caller supplies a parent UID.
    if (derived_from_uid) {
      const parent = db
        .prepare<[string], { rowid: number }>(`SELECT rowid FROM node WHERE uid = ?`)
        .get(derived_from_uid);
      if (parent) {
        db.prepare(
          `INSERT INTO edge (src, dst, rel, origin, t_created, meta)
           VALUES (?, ?, 'DERIVED_FROM', 'user_asserted', ?, '{}')`,
        ).run(rowid, parent.rowid, now);
      }
    }

    return uid;
  });

  const episodeUid = tx() as string;

  // P2: run write-path enrichments (E1–E5, E8, E10, E12) synchronously after insert.
  // enrichOnWrite updates node.topic/project_path/summary/tags/importance/enrich_ver.
  const enrichResult = enrichOnWrite(db, {
    uid: episodeUid,
    rowid: insertedRowid,
    content,
    summary,
    tags,
    topic,
    metadata,
    project_path,
    derived_from_uid,
    embedding: embeddingVec,
    importance, // pass caller-supplied importance so enrichOnWrite respects it
  });

  // Non-blocking nudge to memoryd via socket doorbell
  nudgeDaemon();

  return {
    episode_uid: episodeUid,
    enrichment: {
      topic: enrichResult.topic,
      project_path: enrichResult.project_path,
      summary: enrichResult.summary,
      tags: enrichResult.tags,
      near_dup: enrichResult.near_dup
        ? { existing_uid: enrichResult.near_dup.existing_uid, cosine_sim: enrichResult.near_dup.cosine_sim }
        : null,
    },
  };
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
