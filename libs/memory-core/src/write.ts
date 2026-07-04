/**
 * memory_write handler (P2, updated BL-162; two-phase split 2026-07-04).
 *
 * ADR-0007 single-writer architecture: batch enrichment runs in-process inside the
 * memory-server writer backend — there is no separate daemon process to enqueue/nudge.
 *
 * TWO-PHASE WRITE (2026-07-04 incident — expensive compute must not block writes):
 *   - Phase A — `memoryWritePhaseA()`: FULLY SYNCHRONOUS. Dedup, node insert, FTS
 *     (trigger-driven), tags/entities, sync non-embed enrichment (E1–E5, E10, E12),
 *     transactional outbox row, commit. NO embedding, NO ONNX. This is the only part
 *     that should hold the serial WriteQueue slot.
 *   - Phase B — embed-pipeline.ts: embedding computed OFF the queue slot (worker
 *     thread), then vec_node insert + deferred E8 near-dup in a SHORT follow-up
 *     queue task. Crash between phases is healed by the periodic tick
 *     (healMissingVectors) and visible via memory_ping's `embed_backlog`.
 *   - `memoryWrite()` remains the synchronous COMPOSITION (Phase A + embed + apply,
 *     all before returning) — the SOX_SYNC_EMBED kill-switch path and the API every
 *     existing non-queue caller (memory-cli, convenience `write()`) keeps using.
 *
 * Invariants:
 *   R1: zero provider/LLM calls on write path (batch enrichment is deterministic, no LLM).
 *   R2: one .db per scope; idempotent init.
 *   R5: dedup via content_hash; never deletes existing episodes.
 *   R6: no OS advisory lock (host holds singleton via lifecycle block).
 */

import { enrichOnWrite } from './enrich.js';
import { enqueueIngest } from './outbox-queue.js';
import { applyEmbedding } from './embed-pipeline.js';
import type { PendingEmbed } from './embed-pipeline.js';
// S11 / BL-165: content-hash routed through ingest's hexSha256 (canonical ingestion layer).
// Normalization (trim + toLowerCase) is applied here before the hash call to preserve
// byte-identical dedup fingerprints with all pre-existing store rows. See parity spec:
// libs/memory-core/src/ingest-parity.spec.ts
import { hexSha256 } from '@adhd/sox-ingest';
import Database from 'better-sqlite3';
import { performance } from 'node:perf_hooks';
import { monotonicFactory } from 'ulid';
import { embed, vecToJson } from './embed.js';

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
  tags?: string[] | undefined;
  /** (WP-4) Client-supplied request idempotency key (string ≤128 chars). Replay of a
   *  known id returns the original result with `replayed: true`. */
  client_request_id?: string | undefined;
}

export interface WriteResult {
  episode_uid: string;
  /** (WP-4) True when this is a replayed idempotent request (client_request_id matched an existing ledger entry). */
  replayed?: boolean;
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

/** Outcome of the synchronous Phase-A write (two-phase split, 2026-07-04). */
export interface PhaseAOutcome {
  result: WriteResult;
  /**
   * Non-null when the embedding was NOT computed in Phase A: the caller must
   * hand this to the Phase-B pipeline (embed-pipeline.ts schedulePendingEmbeds)
   * AFTER the Phase-A queue task has returned (BL-154 — never nest enqueues).
   * Null on idempotent replays (the original write already owns the vector) and
   * when a pre-computed embedding was supplied.
   */
  pending: PendingEmbed | null;
}

/**
 * Phase A of the two-phase write: everything EXCEPT the embedding. Fully
 * synchronous (no ONNX, no awaits) — safe to run as a short serial-WriteQueue
 * task. Performs dedup, node insert, FTS (trigger), transactional outbox row,
 * tags/entities, idempotency ledger, DERIVED_FROM edges, and the non-embed
 * write-time enrichment (E1–E5, E10, E12).
 *
 * When `embedding` is supplied (SOX_SYNC_EMBED composition via `memoryWrite`),
 * the vec_node row is inserted inside the SAME transaction as the node and the
 * E8 near-dup pass runs synchronously — byte-compatible with the pre-split
 * behaviour. When absent, `result.enrichment.near_dup` is null (deferred to
 * Phase B) and `pending` carries the embed work.
 */
export function memoryWritePhaseA(
  db: Database.Database,
  params: WriteParams,
  embedding?: Float32Array,
): PhaseAOutcome | WriteError {
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

  // (WP-4) client_request_id idempotency: replay returns the original result.
  const clientRequestId = params.client_request_id;
  if (clientRequestId !== undefined) {
    if (typeof clientRequestId !== 'string' || clientRequestId.length > 128) {
      return {
        code: 'E_SCOPE_RO',
        message: 'client_request_id must be a string of at most 128 characters',
      };
    }
    const existingLedger = db
      .prepare<[string], { episode_uid: string }>(
        'SELECT episode_uid FROM request_ledger WHERE request_id = ?',
      )
      .get(clientRequestId);
    if (existingLedger) {
      return {
        result: {
          episode_uid: existingLedger.episode_uid,
          replayed: true,
        },
        pending: null,
      };
    }
  }

  // SHA-256 dedup on normalized content.
  // S11 / BL-165: delegates to ingest's hexSha256 (canonical ingestion layer).
  // Normalization: trim + toLowerCase — matches the live store's existing dedup
  // fingerprints exactly (see parity spec: ingest-parity.spec.ts).
  const normalized = content.trim().toLowerCase();
  const contentHash = hexSha256(normalized);

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

  // Two-phase split (2026-07-04): Phase A performs NO embedding. When the
  // caller pre-computed one (sync composition), it lands inside the same
  // transaction as the node — otherwise the vec insert is Phase B's job.
  const embeddingJson = embedding !== undefined ? vecToJson(embedding) : null;

  // Track rowid for post-transaction enrichOnWrite call
  let insertedRowid = 0;

  // Atomic transaction: insert node + vec + FTS (via trigger)
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

    // Insert into vec_node (accepts JSON string or binary blob) — only when the
    // embedding was pre-computed; otherwise deferred to Phase B (embed-pipeline).
    if (embeddingJson !== null) {
      db.prepare('INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)').run(
        rowid,
        embeddingJson,
      );
    }

    // Transactional outbox: the row commits with the node; the in-process periodic
    // enrichment pass consumes it, and its presence/age drives memory_ping's
    // enrichment heartbeat (BL-172). No daemon, no nudge — just the row.
    enqueueIngest(db, uid, agent_id ?? null);

    // Attach user-asserted tags as entity nodes + MENTIONS edges (write-time, synchronous)
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

    // (WP-4) Record in request_ledger for idempotent replay.
    if (clientRequestId) {
      db.prepare(
        `INSERT OR IGNORE INTO request_ledger(request_id, episode_uid, created_at) VALUES (?, ?, ?)`,
      ).run(clientRequestId, uid, now);
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

  // P2: run write-path enrichments (E1–E5, E10, E12 — plus E8 near-dup only when
  // an embedding is available) synchronously after insert.
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
    embedding, // undefined in async Phase A → E8 near-dup deferred to Phase B
    importance, // pass caller-supplied importance so enrichOnWrite respects it
  });

  return {
    result: {
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
    },
    pending:
      embedding === undefined
        ? {
            uid: episodeUid,
            rowid: insertedRowid,
            text: content,
            // time_to_vector start stamp: monotonic, captured at Phase-A
            // completion (node committed + sync enrichment done — the point
            // the episode became BM25-recallable but not yet vec-recallable).
            startedAtMs: performance.now(),
          }
        : null,
  };
}

/**
 * Write a memory episode to the database — the SYNCHRONOUS-EMBED composition.
 *
 * Composition of the two-phase split: Phase A (no embed) → embed (worker
 * thread) → applyEmbedding (vec insert + E8 near-dup), all before returning.
 * This is the SOX_SYNC_EMBED kill-switch path and the API preserved for every
 * non-queue caller (memory-cli, the convenience `write()` wrapper, batch).
 *
 * Failure-mode note (intentional post-split difference): if the embed call
 * itself fails, the node is ALREADY durably committed by Phase A — the error
 * still propagates to the caller (fail loud), but the episode exists without a
 * vector and the periodic heal (embed-pipeline.ts healMissingVectors) completes
 * it. A client retry after such an error surfaces E_DEDUP with the
 * existing_uid, which is the truthful outcome (the write landed).
 */
export async function memoryWrite(
  db: Database.Database,
  params: WriteParams,
): Promise<WriteResult | WriteError> {
  const phaseA = memoryWritePhaseA(db, params);
  if ('code' in phaseA) return phaseA;
  if (phaseA.pending === null) return phaseA.result; // replay — nothing to embed

  const vec = await embed(phaseA.pending.text);
  const applied = applyEmbedding(db, phaseA.pending, vec);
  if (applied.near_dup !== null && phaseA.result.enrichment) {
    phaseA.result.enrichment.near_dup = {
      existing_uid: applied.near_dup.existing_uid,
      cosine_sim: applied.near_dup.cosine_sim,
    };
  }
  return phaseA.result;
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

// ── Batch write (WP-3, BL-125) ──────────────────────────────────────────────

export interface BatchItem {
  content: string;
  summary?: string | undefined;
  name?: string | undefined;
  topic?: string | undefined;
  project_path?: string | undefined;
  derived_from_uid?: string | undefined;
  session_id?: string | undefined;
  t_occurred?: string | undefined;
  agent_id?: string | undefined;
  source?: 'message' | 'tool_output' | 'observation' | 'document' | 'reflection' | 'import' | undefined;
  metadata?: Record<string, unknown> | undefined;
  importance?: number | undefined;
  tags?: string[] | undefined;
  client_request_id?: string | undefined;
}

export interface BatchItemOk {
  ok: true;
  episode_uid: string;
}

export interface BatchItemError {
  ok: false;
  code: string;
  message: string;
  details?: Record<string, unknown> | { existing_uid: string };
}

export type BatchItemResult = BatchItemOk | BatchItemError;

export interface BatchResult {
  results: BatchItemResult[];
}

/**
 * Write multiple memory episodes as a single batch.
 *
 * CONTRACTS §C:
 *   - One logical queue entry (the caller should route the entire batch through
 *     WriteQueue as a single enqueue).
 *   - Per-item E_DEDUP is `ok:false, code:"E_DEDUP"` with `details.existing_uid`
 *     and is NOT a batch failure — other items still succeed.
 *   - Chunked transactions allowed (one transaction per item for isolation).
 *
 * This function does NOT queue itself — the caller (memory-server handler) is
 * responsible for enqueuing the entire batch as a single queue entry so that
 * batch writes aren't interleaved with individual writes.
 */
export async function memoryWriteBatch(
  db: Database.Database,
  items: BatchItem[],
): Promise<BatchResult> {
  const results: BatchItemResult[] = [];

  for (const item of items) {
    try {
      const r = await memoryWrite(db, item);
      if ('episode_uid' in r) {
        results.push({ ok: true, episode_uid: r.episode_uid });
      } else {
        // WriteError: E_DEDUP, E_SCOPE_RO, etc.
        results.push({
          ok: false,
          code: r.code,
          message: r.message,
          ...('existing_uid' in r ? { details: { existing_uid: r.existing_uid } as Record<string, unknown> } : {}),
        });
      }
    } catch (err) {
      // Unexpected errors (not from memoryWrite but from the async wrapper) are
      // surfaced as per-item errors so a single item cannot bring down the batch.
      const msg = err instanceof Error ? err.message : String(err ?? 'unknown error');
      results.push({ ok: false, code: 'E_IO', message: msg });
    }
  }

  return { results };
}

/** Outcome of the synchronous Phase-A batch write (two-phase split, 2026-07-04). */
export interface BatchPhaseAOutcome {
  results: BatchItemResult[];
  /** Phase-B work for every successfully-inserted item (dedups/replays excluded).
   *  Hand to schedulePendingEmbeds AFTER the queue task returns (BL-154). */
  pendings: PendingEmbed[];
}

/**
 * Phase-A batch write: all items' Phase A runs SERIALLY and SYNCHRONOUSLY (fast
 * — no ONNX in the loop), designed to be the body of ONE WriteQueue task (same
 * single-queue-entry contract as memoryWriteBatch, CONTRACTS §C). Phase-B
 * embeds for the whole batch are returned as `pendings` for off-slot,
 * pipelined processing.
 *
 * Per-item semantics are IDENTICAL to memoryWriteBatch: E_DEDUP is
 * `ok:false, code:'E_DEDUP', details.existing_uid` and never a batch failure;
 * client_request_id replays return the original uid and schedule no embed.
 */
export function memoryWriteBatchPhaseA(
  db: Database.Database,
  items: BatchItem[],
): BatchPhaseAOutcome {
  const results: BatchItemResult[] = [];
  const pendings: PendingEmbed[] = [];

  for (const item of items) {
    try {
      const r = memoryWritePhaseA(db, item);
      if ('code' in r) {
        results.push({
          ok: false,
          code: r.code,
          message: r.message,
          ...('existing_uid' in r ? { details: { existing_uid: r.existing_uid } as Record<string, unknown> } : {}),
        });
      } else {
        results.push({ ok: true, episode_uid: r.result.episode_uid });
        if (r.pending !== null) pendings.push(r.pending);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err ?? 'unknown error');
      results.push({ ok: false, code: 'E_IO', message: msg });
    }
  }

  return { results, pendings };
}

// ── Request ledger pruning (WP-4, BL-129) ──────────────────────────────────

/**
 * Prune request_ledger entries older than the given retention period.
 * Called on the checkpoint tick (WP-5); default retention = 7 days.
 *
 * Returns the number of rows deleted.
 */
export function requestLedgerPrune(
  db: Database.Database,
  retentionDays: number = 7,
): number {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const result = db
    .prepare<[string]>('DELETE FROM request_ledger WHERE created_at < ?')
    .run(cutoff);
  return result.changes;
}

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
