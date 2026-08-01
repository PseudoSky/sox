/**
 * memory_update — in-place editor for an existing node.
 *
 * Distinct from supersession (which mints a new node + invalidates the old).
 * The node's `uid` is the required selector and is IMMUTABLE by construction.
 *
 * Spec (locked):
 *   - Selector:         uid (required). E_NOT_FOUND if no live node with that uid.
 *   - Replaceable:      content, summary, name, topic, tags, importance, project_path.
 *   - project_path:     (BL-221) added to the editable field set so a mis-attributed
 *                       episode (BL-62 — wrong provenance from a shared/long-lived
 *                       server process's env/cwd fallback) can be corrected IN PLACE.
 *                       Deliberately option (a) of the three BL-221 sketches: content-
 *                       hash dedup (write.ts content_hash) is NOT part of this change —
 *                       it stays computed over content only, so no existing store row's
 *                       dedup fingerprint changes. Does NOT trigger re-embed (the vector
 *                       is derived from content/summary only).
 *   - metadata:         DEEP-MERGE into existing meta by default (recursive for objects,
 *                       arrays REPLACED not concatenated). `metadata_merge:'replace'`
 *                       overwrites meta wholesale.
 *   - Timestamps:       t_occurred and t_valid are updatable.
 *                       t_created is IMMUTABLE (audit anchor).
 *                       t_updated is set to `now` on every successful update.
 *   - Re-embed:         content or summary change → delete+insert vec_node (virtual table
 *                       has no UPDATE trigger). Metadata/tag/importance-only → skip embed.
 *   - FTS:              fts_node_au trigger auto-syncs on node UPDATE; do NOT touch FTS manually.
 *   - Returns:          { uid, updated_fields, reembedded }
 */

import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { vectorDialectFor } from './dialect.js';
import { performance } from 'node:perf_hooks';
import { embed } from './embed.js';
import { applyEmbedding, type PendingEmbed } from './embed-pipeline.js';

// ── Deep-merge helper ─────────────────────────────────────────────────────────

/**
 * Recursively merge `source` into `target`.
 * - Nested plain objects are merged recursively.
 * - Arrays in `source` REPLACE arrays in `target` (not concatenated).
 * - All other scalar values in `source` overwrite `target`.
 * Returns a new plain object (neither `target` nor `source` is mutated).
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = result[key];
    if (
      sv !== null &&
      typeof sv === 'object' &&
      !Array.isArray(sv) &&
      tv !== null &&
      typeof tv === 'object' &&
      !Array.isArray(tv)
    ) {
      // Both sides are plain objects — merge recursively.
      result[key] = deepMerge(
        tv as Record<string, unknown>,
        sv as Record<string, unknown>,
      );
    } else {
      // Scalars, arrays, nulls — source wins.
      result[key] = sv;
    }
  }
  return result;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UpdateParams {
  /** Required selector. Error E_NOT_FOUND if no live node with this uid. */
  uid: string;

  /** Replace node.content. Triggers re-embed. */
  content?: string | undefined;
  /** Replace node.summary. Triggers re-embed. */
  summary?: string | undefined;
  /** Replace node.name. */
  name?: string | undefined;
  /** Replace node.topic. */
  topic?: string | undefined;
  /** Replace node.tags (JSON-encoded string[]). */
  tags?: string[] | undefined;
  /** Replace node.importance. */
  importance?: number | undefined;
  /**
   * (BL-221) Replace node.project_path. The sole in-place remediation path for a
   * mis-attributed episode (BL-62): re-writing the identical content with a
   * corrected project_path is rejected by E_DEDUP (content_hash ignores
   * project_path by design — see write.ts), so this field must be updatable here.
   * Compared/stored like every other scalar field (topic, name, ...): omit the
   * field to leave it untouched, or supply a string (including `''`) to replace it
   * verbatim — no implicit null-coercion.
   */
  project_path?: string | undefined;

  /**
   * Metadata to merge into (or replace) existing node.meta.
   * `metadata_merge: 'deep'` (default): recursive object merge; arrays replaced.
   * `metadata_merge: 'replace'`: overwrites meta wholesale.
   */
  metadata?: Record<string, unknown> | undefined;
  metadata_merge?: 'deep' | 'replace' | undefined;

  /** Update node.t_occurred. */
  t_occurred?: string | undefined;
  /** Update node.t_valid. */
  t_valid?: string | undefined;
}

export interface UpdateResult {
  uid: string;
  /** Names of the node columns that were actually changed. */
  updated_fields: string[];
  /** True when content or summary changed and the vec_node vector was refreshed. */
  reembedded: boolean;
}

export type UpdateError =
  | { code: 'E_NOT_FOUND'; message: string }
  | { code: 'E_NO_FIELDS'; message: string };

/** Phase-A outcome for the two-phase update (BL-189, mirrors write.ts). */
export interface UpdatePhaseAOutcome {
  result: UpdateResult;
  /**
   * Non-null when content/summary changed: Phase A committed the column
   * update and DELETED the stale vec_node row (so recall never serves a
   * stale vector, and a crashed Phase B leaves the node heal-eligible via
   * healMissingVectors). The caller schedules the re-embed off-slot via
   * schedulePendingEmbeds — never from inside the queue task (BL-154).
   */
  pending: PendingEmbed | null;
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Phase A of the two-phase update (BL-189): FULLY SYNCHRONOUS — safe to run
 * while holding the WriteQueue slot. All column updates + FTS (trigger) commit
 * here; when content/summary changed the stale vector is deleted in the same
 * transaction and the re-embed is returned as a PendingEmbed for Phase B.
 */
export async function memoryUpdatePhaseA(
  adapter: StoreAdapter,
  params: UpdateParams,
): Promise<UpdateError | UpdatePhaseAOutcome> {
  const {
    uid,
    content,
    summary,
    name,
    topic,
    tags,
    importance,
    metadata,
    metadata_merge = 'deep',
    t_occurred,
    t_valid,
    project_path,
  } = params;

  // ── 1. Load the existing live node ──────────────────────────────────────────
  const existing = await adapter.executeGet<{
    rowid: number;
    content: string | null;
    summary: string | null;
    name: string | null;
    topic: string | null;
    tags: string | null;
    importance: number;
    meta: string | null;
    t_occurred: string | null;
    t_valid: string | null;
    project_path: string | null;
  }>(
    `SELECT rowid, content, summary, name, topic, tags, importance, meta,
            t_occurred, t_valid, project_path
     FROM node
     WHERE uid = ? AND t_invalid IS NULL
     LIMIT 1`,
    [uid],
  );

  if (!existing) {
    return {
      code: 'E_NOT_FOUND',
      message: `No live node with uid: ${uid}`,
    };
  }

  // ── 2. Determine what changes ────────────────────────────────────────────────
  const setClauses: string[] = [];
  const setValues: unknown[] = [];
  const updatedFields: string[] = [];

  // content
  if (content !== undefined && content !== existing.content) {
    setClauses.push('content = ?');
    setValues.push(content);
    updatedFields.push('content');
  }

  // summary
  if (summary !== undefined && summary !== existing.summary) {
    setClauses.push('summary = ?');
    setValues.push(summary);
    updatedFields.push('summary');
  }

  // name
  if (name !== undefined && name !== existing.name) {
    setClauses.push('name = ?');
    setValues.push(name);
    updatedFields.push('name');
  }

  // topic
  if (topic !== undefined && topic !== existing.topic) {
    setClauses.push('topic = ?');
    setValues.push(topic);
    updatedFields.push('topic');
  }

  // project_path (BL-221 — the in-place remediation path for BL-62 mis-attribution)
  if (project_path !== undefined && project_path !== existing.project_path) {
    setClauses.push('project_path = ?');
    setValues.push(project_path);
    updatedFields.push('project_path');
  }

  // tags — compare by serialised form
  if (tags !== undefined) {
    const newTagsJson = JSON.stringify(tags);
    if (newTagsJson !== existing.tags) {
      setClauses.push('tags = ?');
      setValues.push(newTagsJson);
      updatedFields.push('tags');
    }
  }

  // importance
  if (importance !== undefined && importance !== existing.importance) {
    setClauses.push('importance = ?');
    setValues.push(importance);
    updatedFields.push('importance');
  }

  // metadata — merge or replace
  if (metadata !== undefined) {
    let newMeta: Record<string, unknown>;
    if (metadata_merge === 'replace') {
      newMeta = metadata;
    } else {
      // deep merge
      let existing_meta: Record<string, unknown> = {};
      if (existing.meta) {
        try {
          const parsed: unknown = JSON.parse(existing.meta);
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            existing_meta = parsed as Record<string, unknown>;
          }
        } catch { /* malformed meta — treat as empty */ }
      }
      newMeta = deepMerge(existing_meta, metadata);
    }
    const newMetaJson = JSON.stringify(newMeta);
    if (newMetaJson !== existing.meta) {
      setClauses.push('meta = ?');
      setValues.push(newMetaJson);
      updatedFields.push('meta');
    }
  }

  // t_occurred
  if (t_occurred !== undefined && t_occurred !== existing.t_occurred) {
    setClauses.push('t_occurred = ?');
    setValues.push(t_occurred);
    updatedFields.push('t_occurred');
  }

  // t_valid
  if (t_valid !== undefined && t_valid !== existing.t_valid) {
    setClauses.push('t_valid = ?');
    setValues.push(t_valid);
    updatedFields.push('t_valid');
  }

  // Guard: at least one field must change
  if (setClauses.length === 0) {
    return {
      code: 'E_NO_FIELDS',
      message: 'No updatable fields supplied or all values are identical to the existing node.',
    };
  }

  // ── 3. Always set t_updated ──────────────────────────────────────────────────
  const now = new Date().toISOString();
  setClauses.push('t_updated = ?');
  setValues.push(now);
  // t_updated is an internal audit column — not surfaced in updated_fields.

  // ── 4. Determine whether the vector must be refreshed ────────────────────────
  const needsReembed =
    updatedFields.includes('content') || updatedFields.includes('summary');
  // The vector is derived from CONTENT (new when changed, else existing) —
  // pre-BL-189 behaviour preserved: a summary-only change recomputes the
  // content vector (idempotent by value).
  const embedText =
    updatedFields.includes('content') && content !== undefined
      ? content
      : (existing.content ?? '');

  // ── 5. Atomic transaction: UPDATE node + drop stale vec_node if re-embedding ─
  await adapter.transaction(async (tx) => {
    const sql = `UPDATE node SET ${setClauses.join(', ')} WHERE uid = ?`;
    setValues.push(uid);
    await tx.executeRun(sql, setValues);

    if (needsReembed) {
      await tx.executeRun(`DELETE FROM vec_node WHERE node_id = CAST(? AS INTEGER)`, [existing.rowid]);
    }
  });
  // Note: FTS is auto-synced by the fts_node_au trigger on the node UPDATE — no manual touch needed.

  return {
    result: {
      uid,
      updated_fields: updatedFields,
      reembedded: needsReembed,
    },
    pending: needsReembed
      ? { uid, rowid: existing.rowid, text: embedText, startedAtMs: performance.now() }
      : null,
  };
}

/**
 * In-place editor of an existing node — SYNCHRONOUS-EMBED composition
 * (Phase A + inline embed + apply). Used by the SOX_SYNC_EMBED=1 kill-switch
 * path and direct library callers; the memory-server default routes Phase B
 * through schedulePendingEmbeds instead (BL-189/BL-191 — instrumented,
 * off the WriteQueue slot).
 */
export async function memoryUpdate(
  adapter: StoreAdapter,
  params: UpdateParams,
): Promise<UpdateResult | UpdateError> {
  const phaseA = await memoryUpdatePhaseA(adapter, params);
  if ('code' in phaseA) return phaseA;
  if (phaseA.pending === null) return phaseA.result;
  const pending: PendingEmbed = phaseA.pending;

  const vec = await embed(pending.text);
  const vectorDialect = await vectorDialectFor(adapter);
  await adapter.transaction(async (tx) =>
    applyEmbedding(tx, pending, vec, adapter.capabilities.nativeVectors, vectorDialect),
  );
  return phaseA.result;
}
