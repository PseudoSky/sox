/**
 * memory_update — in-place editor for an existing node.
 *
 * Distinct from supersession (which mints a new node + invalidates the old).
 * The node's `uid` is the required selector and is IMMUTABLE by construction.
 *
 * Spec (locked):
 *   - Selector:         uid (required). E_NOT_FOUND if no live node with that uid.
 *   - Replaceable:      content, summary, name, topic, tags, importance.
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

import Database from 'better-sqlite3';
import { embed, vecToJson } from './embed.js';

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

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * In-place editor of an existing node.
 * async because re-embed may be needed when content/summary changes.
 */
export async function memoryUpdate(
  db: Database.Database,
  params: UpdateParams,
): Promise<UpdateResult | UpdateError> {
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
  } = params;

  // ── 1. Load the existing live node ──────────────────────────────────────────
  const existing = db
    .prepare<
      [string],
      {
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
      }
    >(
      `SELECT rowid, content, summary, name, topic, tags, importance, meta,
              t_occurred, t_valid
       FROM node
       WHERE uid = ? AND t_invalid IS NULL
       LIMIT 1`,
    )
    .get(uid);

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

  // ── 4. Re-embed if content or summary changed ────────────────────────────────
  const needsReembed =
    updatedFields.includes('content') || updatedFields.includes('summary');

  let embeddingJson: string | null = null;
  if (needsReembed) {
    // Use the new content if provided, otherwise fall back to the existing content.
    const embedText =
      updatedFields.includes('content') && content !== undefined
        ? content
        : (existing.content ?? '');
    const vec = await embed(embedText);
    embeddingJson = vecToJson(vec);
  }

  // ── 5. Atomic transaction: UPDATE node + refresh vec_node if needed ──────────
  db.transaction(() => {
    const sql = `UPDATE node SET ${setClauses.join(', ')} WHERE uid = ?`;
    setValues.push(uid);
    db.prepare(sql).run(...setValues);

    if (needsReembed && embeddingJson !== null) {
      // vec_node has no UPDATE trigger — must delete + re-insert.
      db.prepare(`DELETE FROM vec_node WHERE node_id = CAST(? AS INTEGER)`).run(existing.rowid);
      db.prepare(
        `INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)`,
      ).run(existing.rowid, embeddingJson);
    }
  })();
  // Note: FTS is auto-synced by the fts_node_au trigger on the node UPDATE — no manual touch needed.

  return {
    uid,
    updated_fields: updatedFields,
    reembedded: needsReembed,
  };
}
