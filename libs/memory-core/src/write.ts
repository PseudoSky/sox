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
 *
 * BL-62 (project_path attribution — RESOLVED 2026-07-18 by requiring, not inferring):
 * the E1 precedence chain (provenance.ts: explicit arg > SOX_CONFIG_PROJECT_PATH env >
 * cwd-git) can only ever reflect the CALLER's real project when the caller passes
 * `project_path` explicitly. For a long-lived server process (the shared proxy backend,
 * or any stdio shim whose spawn cwd differs from the caller's LIVE working directory at
 * call time — e.g. an agent that `cd`s mid-session, or a shim spawned from inside a
 * throwaway git worktree) the env/cwd tiers observe the SERVER's fixed process cwd, not
 * the caller's — Node's `process.cwd()` cannot change per-request within one process,
 * and a worktree cwd has zero prior episodes, so the mis-attribution is silent and
 * permanent once written. Originally mitigated by stamping
 * `WriteResult.enrichment.project_path_source` ('explicit' | 'inferred') so an operator
 * COULD detect low-confidence attribution after the fact — but detection after the fact
 * still means bad data landed. `memoryWritePhaseA` now REJECTS a write with no explicit
 * `project_path` outright (`E_MISSING_PROJECT_PATH`) rather than falling through to any
 * inference tier: the calling agent must always know and state which project an episode
 * belongs to. `project_path_source` stays on `WriteResult` for API stability but is now
 * always `'explicit'` — the `'inferred'` value is unreachable in practice, since
 * inference no longer happens on this path. (Reads are UNCHANGED: omitting
 * `project_path` on `memory_recall`/`memory_topics`/etc. is a deliberate, valid "search
 * every project" request — this only applies to writes, where inference risks silent,
 * permanent data corruption rather than a merely-wrong query result.)
 */

import { enrichOnWrite } from './enrich.js';
import { enqueueIngest } from './outbox-queue.js';
import { applyEmbedding } from './embed-pipeline.js';
import { vectorDialectFor } from './dialect.js';
import type { PendingEmbed } from './embed-pipeline.js';
// S11 / BL-165: content-hash routed through ingest's hexSha256 (canonical ingestion layer).
// Normalization (trim + toLowerCase) is applied here before the hash call to preserve
// byte-identical dedup fingerprints with all pre-existing store rows. See parity spec:
// libs/memory-core/src/ingest-parity.spec.ts
import { hexSha256 } from '@adhd/sox-ingest/core';
import { performance } from 'node:perf_hooks';
import { monotonicFactory } from 'ulid';
import { embed, vecToJson, vecToBuffer } from './embed.js';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { log, traceIdOrNew } from './telemetry.js';

const ulid = monotonicFactory();

/**
 * BL-62 / BL-233: 'explicit' iff a non-empty `project_path` argument was
 * supplied on THIS call — the only tier of the E1 precedence chain
 * (provenance.ts: override > env > cwd-git) guaranteed to reflect the
 * CALLER's real project rather than the server process's fixed cwd/env.
 * Shared by the single-item (`memoryWritePhaseA`) and batch
 * (`memoryWriteBatch`/`memoryWriteBatchPhaseA`) write paths so the two never
 * drift (BL-233 parity fix).
 */
function projectPathSourceFor(project_path: string | undefined): 'explicit' | 'inferred' {
  return project_path !== undefined && project_path.length > 0 ? 'explicit' : 'inferred';
}

export interface WriteParams {
  content: string;
  /** Human-readable summary / topic of the content (persisted to node.summary). */
  summary?: string | undefined;
  /** (E2) Title / name for this episode (node.name). */
  name?: string | undefined;
  /** (E5) Explicit topic override. Stored to node.topic; takes priority over [<topic>] prefix. */
  topic?: string | undefined;
  /** (E1) Caller project root path. REQUIRED (BL-62) — no cwd/env inference; a
   *  write with no explicit project_path is rejected with E_MISSING_PROJECT_PATH. */
  project_path: string;
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
    /**
     * BL-62 (safe, in-scope mitigation — see libs/memory-core/src/write.ts comment
     * above `memoryWritePhaseA`): whether `project_path` came from an EXPLICIT
     * caller-supplied argument ('explicit') or from provenance.ts's env/cwd
     * fallback chain ('inferred'). 'inferred' does NOT mean wrong — most callers
     * run with a stable, correct cwd — but for a shared/long-lived server process
     * (proxy backend, or a shim whose spawn cwd differs from the caller's live
     * working directory) the fallback chain cannot distinguish "the server's
     * fixed process cwd" from "the caller's actual current project" (that
     * distinction requires either an explicit `project_path` arg or the MCP
     * `roots` capability, which this server does not currently negotiate — see
     * the BL-62 write-up in BACKLOG.md). Surfacing the source lets a caller (or
     * an operator auditing `memory_stats`/`memory_recall` output) detect
     * low-confidence attribution and correct it via `memory_update`'s
     * `project_path` field (BL-221) instead of the episode being silently,
     * permanently mis-filed.
     */
    project_path_source: 'explicit' | 'inferred';
    summary: string | null;
    tags: string[];
    near_dup: { existing_uid: string; cosine_sim: number } | null;
  };
}

export type WriteError =
  | { code: 'E_SCOPE_RO'; message: string }
  | { code: 'E_DEDUP'; message: string; existing_uid: string }
  | { code: 'E_QUEUE_FULL'; message: string }
  | { code: 'E_MISSING_PROJECT_PATH'; message: string };

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
 * Phase A of the two-phase write: everything EXCEPT the embedding. Makes
 * ZERO calls to the embedding provider (no ONNX) — safe to run as a short
 * serial-WriteQueue task, which is the entire point of the two-phase split.
 * Performs dedup, node insert, FTS (trigger), transactional outbox row,
 * tags/entities, idempotency ledger, DERIVED_FROM edges, and the non-embed
 * write-time enrichment (E1–E5, E10, E12).
 *
 * NOT wall-clock synchronous: this function is `async` and every StoreAdapter
 * call inside it awaits (dbd874f, "turso adapter compatibility" — Turso's
 * .get()/.run() are Promise-based, and even SqliteAdapterImpl.transaction()
 * itself is async — sqlite-adapter.ts:245 — so this holds on both backends,
 * not just Turso). It used to be a true synchronous function pre-StoreAdapter;
 * that guarantee is gone by design and cannot be restored without reverting
 * the async adapter migration. "No embed calls while holding the slot" is the
 * invariant that matters and is what write-pipeline.spec.ts's seam-level test
 * (getProviderCallCount()) actually proves.
 *
 * When `embedding` is supplied (SOX_SYNC_EMBED composition via `memoryWrite`),
 * the vec_node row is inserted inside the SAME transaction as the node and the
 * E8 near-dup pass runs synchronously — byte-compatible with the pre-split
 * behaviour. When absent, `result.enrichment.near_dup` is null (deferred to
 * Phase B) and `pending` carries the embed work.
 */
export async function memoryWritePhaseA(
  adapter: StoreAdapter,
  params: WriteParams,
  embedding?: Float32Array,
): Promise<PhaseAOutcome | WriteError> {
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

  // BL-320: request-arrival observability. Never logs `content` itself — only
  // its length. `traceId` reuses the write-queue's task trace context when
  // this call runs inside a WriteQueue task (the normal path), or mints a
  // fresh one for direct/test callers — either way it is what gets stamped
  // onto the Phase-B `PendingEmbed` below so embed/apply logs correlate.
  const traceId = traceIdOrNew();
  const phaseAStartMs = performance.now();
  log.info('write.phaseA.start', {
    trace_id: traceId,
    project_path,
    content_len: content?.length ?? 0,
    has_tags: !!(tags && tags.length),
    source,
    session_id: session_id ?? null,
    client_request_id: params.client_request_id ?? null,
  });

  // BL-62: project_path is REQUIRED — reject before any DB work or enrichment runs,
  // rather than falling through to enrichOnWrite's env/cwd inference tiers. Runtime
  // check (not just the WriteParams.project_path: string type) because callers cross
  // an untyped JSON boundary (MCP tool args) before constructing this object.
  if (!project_path || project_path.length === 0) {
    log.warn('write.phaseA.error', {
      trace_id: traceId,
      code: 'E_MISSING_PROJECT_PATH',
      duration_ms: Math.round(performance.now() - phaseAStartMs),
    });
    return {
      code: 'E_MISSING_PROJECT_PATH',
      message:
        'project_path is required — the calling agent\'s actual workspace root, passed ' +
        'explicitly. No cwd/env inference: a long-lived server process\'s cwd reflects ' +
        'wherever it happened to be spawned, not the caller\'s real project, and a wrong ' +
        'guess here permanently mis-attributes the episode.',
    };
  }

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

  // (E1) project_path is guaranteed non-empty by the guard above (BL-62) — always
  // stored as the caller's explicit value, never inferred.
  const resolvedProjectPath: string = project_path;

  if (!content || !content.trim()) {
    log.warn('write.phaseA.error', { trace_id: traceId, code: 'E_SCOPE_RO', duration_ms: Math.round(performance.now() - phaseAStartMs) });
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
    const existingLedger = await adapter.executeGet<{ episode_uid: string }>(
      'SELECT episode_uid FROM request_ledger WHERE request_id = ?',
      [clientRequestId],
    );
    if (existingLedger) {
      log.info('write.phaseA.finish', {
        trace_id: traceId, replayed: true, episode_uid: existingLedger.episode_uid,
        duration_ms: Math.round(performance.now() - phaseAStartMs),
      });
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
  const existing = await adapter.executeGet<{ uid: string }>(
    'SELECT uid FROM node WHERE content_hash = ?',
    [contentHash],
  );
  if (existing) {
    log.info('write.phaseA.dedup', {
      trace_id: traceId, existing_uid: existing.uid,
      duration_ms: Math.round(performance.now() - phaseAStartMs),
    });
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
  // TursoAdapter uses F32_BLOB columns that expect binary float32 data;
  // SqliteAdapter (vec0) uses JSON array strings. The serialization format
  // is chosen based on adapter.capabilities.nativeVectors.
  const useBinaryFormat = adapter.capabilities.nativeVectors;
  const embeddingSerialized = embedding !== undefined
    ? (useBinaryFormat ? vecToBuffer(embedding) : vecToJson(embedding))
    : null;

  // Track rowid for post-transaction enrichOnWrite call
  let insertedRowid = 0;

  // Atomic transaction: insert node + vec + FTS (via trigger)
  const episodeUid: string = await adapter.transaction(async (tx) => {
    const result = await tx.executeGet<{ rowid: number }>(
      `INSERT INTO node (uid, kind, content, name, summary, meta, agent_id, session_id, source,
                         importance, content_hash, t_created, t_occurred, t_valid,
                         topic, tags, project_path)
       VALUES (?, 'episode', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING rowid`,
      [uid, content, name ?? null, summary ?? null, metaJson,
       agent_id ?? null, session_id ?? null, source, importance,
       contentHash, now, tOccurred, tValid,
       resolvedTopic, tagsJson, resolvedProjectPath],
    );

    if (!result) throw new Error('Insert failed: no rowid returned');
    const rowid = result.rowid;
    insertedRowid = rowid;

    // Insert into vec_node (accepts JSON string or binary blob) — only when the
    // embedding was pre-computed; otherwise deferred to Phase B (embed-pipeline).
    if (embeddingSerialized !== null) {
      await tx.executeRun(
        'INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)',
        [rowid, embeddingSerialized],
      );
    }

    // Transactional outbox: the row commits with the node; the in-process periodic
    // enrichment pass consumes it, and its presence/age drives memory_ping's
    // enrichment heartbeat (BL-172). No daemon, no nudge — just the row.
    await enqueueIngest(adapter, uid, agent_id ?? null);

    // Attach user-asserted tags as entity nodes + MENTIONS edges (write-time, synchronous)
    if (tags && tags.length > 0) {
      for (const tag of tags) {
        const tagName = tag.trim();
        if (!tagName) continue;
                const existingEntity = await tx.executeGet<{ rowid: number }>(
                  `SELECT rowid FROM node WHERE kind = 'entity' AND name = ? AND t_invalid IS NULL`,
                  [tagName],
                );
                let entityRowid = existingEntity?.rowid;
                if (entityRowid === undefined) {
                  const entityUid = ulid();
                  // Use the async adapter API instead of the synchronous
                  // adapter.unwrap().prepare().get() pattern which breaks on Turso/libSQL
                  // (its .get() returns a Promise, not a row — so entityRowid would be
                  // the Promise itself, and the subsequent edge INSERT's dst=undefined
                  // would trigger a silent FK constraint failure).
                  const r = await tx.executeGet<{ rowid: number }>(
                    `INSERT INTO node (uid, kind, name, t_created, t_valid) VALUES (?, 'entity', ?, ?, ?) RETURNING rowid`,
                    [entityUid, tagName, now, now],
                  );
                  if (!r) throw new Error(`Failed to insert entity node for tag: ${tagName}`);
                  entityRowid = r.rowid;
                }
        await tx.executeRun(
          `INSERT INTO edge (src, dst, rel, origin, t_created, meta)
           SELECT ?, ?, 'MENTIONS', 'user_asserted', ?, '{}'
           WHERE NOT EXISTS (
             SELECT 1 FROM edge WHERE src=? AND dst=? AND rel='MENTIONS' AND t_expired IS NULL
           )`,
          [rowid, entityRowid, now, rowid, entityRowid],
        );
      }
    }

    // (WP-4) Record in request_ledger for idempotent replay.
    if (clientRequestId) {
      await tx.executeRun(
        `INSERT OR IGNORE INTO request_ledger(request_id, episode_uid, created_at) VALUES (?, ?, ?)`,
        [clientRequestId, uid, now],
      );
    }

    // (E9) Explicit DERIVED_FROM edge when caller supplies a parent UID.
    if (derived_from_uid) {
      const parent = await tx.executeGet<{ rowid: number }>(
        `SELECT rowid FROM node WHERE uid = ?`,
        [derived_from_uid],
      );
      if (parent) {
        await tx.executeRun(
          `INSERT INTO edge (src, dst, rel, origin, t_created, meta)
           VALUES (?, ?, 'DERIVED_FROM', 'user_asserted', ?, '{}')`,
          [rowid, parent.rowid, now],
        );
      }
    }

    return uid;
  });

  // P2: run write-path enrichments (E1–E5, E10, E12 — plus E8 near-dup only when
  // an embedding is available) synchronously after insert.
  // enrichOnWrite updates node.topic/project_path/summary/tags/importance/enrich_ver.
  // Runs inside a short adapter transaction to provide AdapterTransaction to enrichOnWrite.
  const enrichResult = await adapter.transaction(async (tx) =>
    enrichOnWrite(tx, {
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
      vectorDialect: await vectorDialectFor(adapter),
    }),
  );

  // BL-62: see WriteResult.enrichment.project_path_source doc comment above for
  // the full rationale and the BL-221 remediation path.
  const projectPathSource = projectPathSourceFor(project_path);

  log.info('write.phaseA.finish', {
    trace_id: traceId,
    episode_uid: episodeUid,
    has_pending_embed: embedding === undefined,
    duration_ms: Math.round(performance.now() - phaseAStartMs),
  });

  return {
    result: {
      episode_uid: episodeUid,
      enrichment: {
        topic: enrichResult.topic,
        project_path: enrichResult.project_path,
        project_path_source: projectPathSource,
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
            // BL-320: carry this write's trace id onto Phase B so embed/apply
            // logs correlate with the originating write end to end.
            traceId,
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
  adapter: StoreAdapter,
  params: WriteParams,
): Promise<WriteResult | WriteError> {
  const phaseA = await memoryWritePhaseA(adapter, params);
  if ('code' in phaseA) return phaseA;
  if (phaseA.pending === null) return phaseA.result; // replay — nothing to embed
  const pending: PendingEmbed = phaseA.pending;

  const vec = await embed(pending.text);
  const vectorDialect = await vectorDialectFor(adapter);
  const applied = await adapter.transaction(async (tx) =>
    applyEmbedding(tx, pending, vec, adapter.capabilities.nativeVectors, vectorDialect),
  );
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
  | { code: 'E_SCOPE_RO'; message: string }
  /**
   * BL-247: raised when `replacement_uid` is supplied but does not resolve to
   * a LIVE node (nonexistent uid OR a uid that has itself already been
   * invalidated). Previously this was a silent no-op — invalidation
   * "succeeded" with `ok:true` and the caller-requested SUPERSEDES edge was
   * simply never written, with no signal anything was wrong. A caller that
   * explicitly asked for a supersession link and didn't get one needs to
   * know, so this now fails the whole call (the claim is NOT invalidated
   * either — see the BL-247 write-up above `memoryInvalidate`).
   */
  | { code: 'E_REPLACEMENT_NOT_FOUND'; message: string };

// ── Batch write (WP-3, BL-125) ──────────────────────────────────────────────

export interface BatchItem {
  content: string;
  summary?: string | undefined;
  name?: string | undefined;
  topic?: string | undefined;
  /** REQUIRED (BL-62) — no cwd/env inference; see WriteParams.project_path. */
  project_path: string;
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
  /**
   * BL-233 (parity with single-item WriteResult.enrichment.project_path_source):
   * 'explicit' iff THIS item supplied a non-empty `project_path`; 'inferred'
   * otherwise (the shim/env/cwd fallback chain — see the BL-62 doc comment
   * above `memoryWritePhaseA`). Computed identically to the single-item path
   * so batch writers can detect low-confidence attribution per item.
   */
  project_path_source: 'explicit' | 'inferred';
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
  adapter: StoreAdapter,
  items: BatchItem[],
): Promise<BatchResult> {
  const results: BatchItemResult[] = [];

  for (const item of items) {
    try {
      const r = await memoryWrite(adapter, item);
      if ('episode_uid' in r) {
        results.push({
          ok: true,
          episode_uid: r.episode_uid,
          project_path_source: projectPathSourceFor(item.project_path),
        });
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
export async function memoryWriteBatchPhaseA(
  adapter: StoreAdapter,
  items: BatchItem[],
): Promise<BatchPhaseAOutcome> {
  const results: BatchItemResult[] = [];
  const pendings: PendingEmbed[] = [];

  for (const item of items) {
    try {
      const r = await memoryWritePhaseA(adapter, item);
      if ('code' in r) {
        results.push({
          ok: false,
          code: r.code,
          message: r.message,
          ...('existing_uid' in r ? { details: { existing_uid: r.existing_uid } as Record<string, unknown> } : {}),
        });
      } else {
        results.push({
          ok: true,
          episode_uid: r.result.episode_uid,
          project_path_source: projectPathSourceFor(item.project_path),
        });
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
export async function requestLedgerPrune(
  adapter: StoreAdapter,
  retentionDays: number = 7,
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const result = await adapter.executeRun(
    'DELETE FROM request_ledger WHERE created_at < ?',
    [cutoff],
  );
  return result.rowsAffected;
}

export async function memoryInvalidate(
  adapter: StoreAdapter,
  params: InvalidateParams,
): Promise<InvalidateResult | InvalidateError> {
  const { claim_uid, reason, t_transition, replacement_uid } = params;
  const tTransition = t_transition ?? new Date().toISOString();

  const claim = await adapter.executeGet<{ rowid: number }>(
    `SELECT rowid FROM node WHERE uid = ? AND t_invalid IS NULL`,
    [claim_uid],
  );

  if (!claim) {
    return { code: 'E_NOT_FOUND', message: `Claim not found or already invalidated: ${claim_uid}` };
  }

  // BL-247: resolve (and validate) replacement_uid BEFORE mutating anything.
  // A caller who supplies `replacement_uid` is explicitly asking for a
  // SUPERSEDES edge — a mistyped, nonexistent, or already-invalidated uid
  // must fail the WHOLE call (including the claim's own invalidation)
  // rather than silently dropping the edge and reporting ok:true. Validating
  // up front — outside the transaction, before any write — guarantees this
  // is all-or-nothing: no half-invalidated claim left behind on a bad uid.
  let replacementRowid: number | undefined;
  if (replacement_uid) {
    const replacement = await adapter.executeGet<{ rowid: number }>(
      `SELECT rowid FROM node WHERE uid = ? AND t_invalid IS NULL`,
      [replacement_uid],
    );
    if (!replacement) {
      return {
        code: 'E_REPLACEMENT_NOT_FOUND',
        message: `replacement_uid not found or already invalidated: ${replacement_uid}`,
      };
    }
    replacementRowid = replacement.rowid;
  }

  let supersedgesEdgeUid: string | undefined;

  await adapter.transaction(async (tx) => {
    // Close t_invalid (R5: never delete, invalidate instead)
    await tx.executeRun(`UPDATE node SET t_invalid = ? WHERE uid = ?`, [tTransition, claim_uid]);

    if (replacementRowid !== undefined) {
      supersedgesEdgeUid = `sup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await tx.executeRun(
        `INSERT INTO edge (src, dst, rel, origin, t_created, meta)
         VALUES (?, ?, 'SUPERSEDES', 'user_asserted', ?, ?)`,
        [replacementRowid, claim.rowid, tTransition, JSON.stringify({ reason })],
      );
    }
  }, { mode: 'immediate' });

  const result: InvalidateResult = { ok: true };
  if (supersedgesEdgeUid !== undefined) result.supersedes_edge_uid = supersedgesEdgeUid;
  return result;
}
