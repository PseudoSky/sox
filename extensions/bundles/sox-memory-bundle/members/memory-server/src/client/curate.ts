/**
 * Curation operations — dispatch by op field: retag, set_topic, set_importance,
 * merge_duplicates, recluster, drop_lens, list_lenses.
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type { Database } from 'better-sqlite3';
import { monotonicFactory } from 'ulid';
import {
  ENRICH_VERSION,
  clusterSubset,
  dropSubsetLens,
  listSubsetLenses,
  enqueueEnrich,
} from '@adhd/sox-memory-core';
import type { MemoryFilter } from '@adhd/sox-memory-core';
import { parseTags } from './db.js';

const ulid = monotonicFactory();

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CurateRetagResult {
  op: 'retag';
  uid: string;
  tags_added: string[];
  new_entity_uids: string[];
}

export interface CurateSetTopicResult {
  op: 'set_topic';
  uid: string;
  old_topic: string | null;
  new_topic: string;
}

export interface CurateSetImportanceResult {
  op: 'set_importance';
  uid: string;
  old_importance: number;
  new_importance: number;
}

export interface CurateMergeResult {
  op: 'merge_duplicates';
  uid_kept: string;
  uid_dropped: string;
  same_as_edge_uid: string;
  dry_run: boolean;
}

export interface CurateReclusterSubsetResult {
  op: 'recluster';
  scope: 'subset';
  dry_run: boolean;
  persisted: boolean;
  provenance_hash?: string;
  candidate_count: number;
  cluster_count: number;
  unclustered_count: number;
  full_pass: boolean;
  clusters: Array<{
    community_uid: string;
    label: string;
    size: number;
    mean_intra_sim: number;
    members: string[];
  }>;
}

export interface CurateReclusterGlobalResult {
  op: 'recluster';
  enqueued: boolean;
  dry_run?: boolean;
}

export interface CurateDropLensResult {
  op: 'drop_lens';
  provenance_hash: string;
  dry_run: boolean;
  communities_to_drop?: number;
  found?: boolean;
  communities_dropped?: number;
  edges_dropped?: number;
}

export interface CurateListLensesResult {
  op: 'list_lenses';
  lenses: unknown[];
}

export type CurateResult =
  | CurateRetagResult
  | CurateSetTopicResult
  | CurateSetImportanceResult
  | CurateMergeResult
  | CurateReclusterSubsetResult
  | CurateReclusterGlobalResult
  | CurateDropLensResult
  | CurateListLensesResult
  | { code: string; message?: string; op?: string };

export const inputSchema = {
  type: 'object' as const,
  properties: {
    db_path: {
      type: 'string',
      description:
        'Optional. Path to the SQLite memory store. Defaults to the bundle-configured store (host-injected SOX_CONFIG_DB_PATH, normally ~/.memory/memory.db). Must be within the ~/.memory/** fs allowlist; out-of-allowlist paths are denied by the permission guard with no side effects.',
    },
    op: {
      type: 'string',
      enum: ['retag', 'set_topic', 'set_importance', 'merge_duplicates', 'recluster', 'drop_lens', 'list_lenses'],
      description:
        'The curation operation to perform. drop_lens removes a persisted subset lens by provenance_hash. list_lenses returns all live subset lenses.',
    },
    uid: { type: 'string', description: 'Target episode UID (required for retag, set_topic, set_importance).' },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: '(retag) Tags to add. Additive; duplicates are ignored.',
    },
    topic: { type: 'string', description: '(set_topic) New topic string.' },
    importance: {
      type: 'number',
      minimum: 1,
      maximum: 10,
      description: '(set_importance) User-asserted importance.',
    },
    uid_keep: { type: 'string', description: '(merge_duplicates) UID of the episode to keep.' },
    uid_drop: { type: 'string', description: '(merge_duplicates) UID of the episode to invalidate.' },
    filters: {
      type: 'object',
      description:
        '(recluster) Restrict clustering to the matching subset of episodes. Same filter vocabulary as memory_recall: project_path, topic, tags, tags_match_all, importance_min, t_created_after/before. When present, recluster runs SYNCHRONOUSLY over the subset and returns the resulting communities. Combined with dry_run: dry_run=true returns communities without writing; dry_run=false persists them as a provenance-scoped community slice that leaves the global partition untouched. Absent: global async re-cluster via the daemon (unchanged).',
    },
    threshold: {
      type: 'number',
      description: '(recluster, filtered) Optional cosine similarity threshold override for the subset pass.',
    },
    provenance_hash: {
      type: 'string',
      description: '(drop_lens) The 16-hex provenance hash of the subset lens to drop (obtain from a prior recluster response).',
    },
    dry_run: { type: 'boolean', default: false, description: 'If true, return proposed changes without committing them.' },
  },
  required: ['op'],
};

/**
 * Backing for memory_curate.
 *
 * Dispatches to the curation sub-operation specified by `args.op`.
 */
export async function curate(
  db: Database,
  args: Record<string, unknown>,
): Promise<CurateResult> {
  const op = args['op'] as string;
  const dryRun = args['dry_run'] === true;
  const now = new Date().toISOString();

  switch (op) {
    case 'retag':
      return curateRetag(db, args, now, dryRun);

    case 'set_topic':
      return curateSetTopic(db, args, dryRun);

    case 'set_importance':
      return curateSetImportance(db, args, now, dryRun);

    case 'merge_duplicates':
      return curateMergeDuplicates(db, args, now, dryRun);

    case 'recluster':
      return curateRecluster(db, args, dryRun);

    case 'drop_lens':
      return curateDropLens(db, args, dryRun);

    case 'list_lenses':
      return { op: 'list_lenses', lenses: listSubsetLenses(db) };

    default:
      return { code: 'E_UNKNOWN_OP', op };
  }
}

// ── Sub-operation implementations ─────────────────────────────────────────────

function curateRetag(
  db: Database,
  args: Record<string, unknown>,
  now: string,
  dryRun: boolean,
): CurateRetagResult | { code: string; message?: string } {
  const uid = args['uid'] as string | undefined;
  const newTags = args['tags'] as string[] | undefined;
  if (!uid) {
    return { code: 'E_MISSING', message: 'uid required for retag' };
  }

  const row = db
    .prepare<[string], { rowid: number; tags: string | null }>(
      `SELECT rowid, tags FROM node WHERE uid = ? AND t_invalid IS NULL LIMIT 1`,
    )
    .get(uid);
  if (!row) {
    return { code: 'E_NOT_FOUND' };
  }

  const existingTags = parseTags(row.tags);
  const tagsToAdd = (newTags ?? []).filter((t) => !existingTags.includes(t));
  const mergedTags = [...existingTags, ...tagsToAdd];

  const newEntityUids: string[] = [];
  if (!dryRun) {
    db.transaction(() => {
      db.prepare(`UPDATE node SET tags = ? WHERE uid = ?`).run(JSON.stringify(mergedTags), uid);

      for (const tag of tagsToAdd) {
        const tagName = tag.trim();
        if (!tagName) continue;
        const existing = db
          .prepare<[string], { rowid: number; uid: string }>(
            `SELECT rowid, uid FROM node WHERE kind = 'entity' AND name = ? AND t_invalid IS NULL`,
          )
          .get(tagName);
        let entityRowid: number;
        let entityUid: string;
        if (existing) {
          entityRowid = existing.rowid;
          entityUid = existing.uid;
        } else {
          entityUid = ulid();
          const ins = db
            .prepare<unknown[], { rowid: number }>(
              `INSERT INTO node (uid, kind, name, t_created, t_valid) VALUES (?, 'entity', ?, ?, ?) RETURNING rowid`,
            )
            .get(entityUid, tagName, now, now);
          if (!ins) continue;
          entityRowid = ins.rowid;
          newEntityUids.push(entityUid);
        }
        db.prepare(
          `INSERT INTO edge (src, dst, rel, origin, t_created, meta)
           SELECT ?, ?, 'MENTIONS', 'user_asserted', ?, '{}'
           WHERE NOT EXISTS (SELECT 1 FROM edge WHERE src=? AND dst=? AND rel='MENTIONS' AND t_expired IS NULL)`,
        ).run(row.rowid, entityRowid, now, row.rowid, entityRowid);
      }
    })();
  }

  return { op: 'retag', uid, tags_added: tagsToAdd, new_entity_uids: newEntityUids };
}

function curateSetTopic(
  db: Database,
  args: Record<string, unknown>,
  dryRun: boolean,
): CurateSetTopicResult | { code: string; message?: string } {
  const uid = args['uid'] as string | undefined;
  const newTopic = args['topic'] as string | undefined;
  if (!uid || !newTopic) {
    return { code: 'E_MISSING', message: 'uid and topic required for set_topic' };
  }

  const row = db
    .prepare<[string], { topic: string | null }>(
      `SELECT topic FROM node WHERE uid = ? AND t_invalid IS NULL LIMIT 1`,
    )
    .get(uid);
  if (row === undefined) {
    return { code: 'E_NOT_FOUND' };
  }

  const oldTopic = row.topic ?? null;
  if (!dryRun) {
    db.prepare(`UPDATE node SET topic = ? WHERE uid = ?`).run(newTopic, uid);
  }

  return { op: 'set_topic', uid, old_topic: oldTopic, new_topic: newTopic };
}

function curateSetImportance(
  db: Database,
  args: Record<string, unknown>,
  now: string,
  dryRun: boolean,
): CurateSetImportanceResult | { code: string; message?: string } {
  const uid = args['uid'] as string | undefined;
  const newImportance = args['importance'] as number | undefined;
  if (!uid || newImportance === undefined) {
    return { code: 'E_MISSING', message: 'uid and importance required for set_importance' };
  }

  const row = db
    .prepare<[string], { importance: number }>(
      `SELECT importance FROM node WHERE uid = ? AND t_invalid IS NULL LIMIT 1`,
    )
    .get(uid);
  if (row === undefined) {
    return { code: 'E_NOT_FOUND' };
  }

  const oldImportance = row.importance;
  if (!dryRun) {
    const enrichVer = JSON.stringify({ pass: ENRICH_VERSION, ts: now, note: 'user_override' });
    db.prepare(`UPDATE node SET importance = ?, enrich_ver = ? WHERE uid = ?`).run(
      newImportance,
      enrichVer,
      uid,
    );
  }

  return { op: 'set_importance', uid, old_importance: oldImportance, new_importance: newImportance };
}

function curateMergeDuplicates(
  db: Database,
  args: Record<string, unknown>,
  now: string,
  dryRun: boolean,
): CurateMergeResult | { code: string; message?: string } {
  const uidKeep = args['uid_keep'] as string | undefined;
  const uidDrop = args['uid_drop'] as string | undefined;
  if (!uidKeep || !uidDrop) {
    return { code: 'E_MISSING', message: 'uid_keep and uid_drop required for merge_duplicates' };
  }

  const keepRow = db
    .prepare<[string], { rowid: number }>(`SELECT rowid FROM node WHERE uid = ? LIMIT 1`)
    .get(uidKeep);
  const dropRow = db
    .prepare<[string], { rowid: number }>(`SELECT rowid FROM node WHERE uid = ? LIMIT 1`)
    .get(uidDrop);

  if (!keepRow) return { code: 'E_NOT_FOUND', message: `uid_keep not found: ${uidKeep}` };
  if (!dropRow) return { code: 'E_NOT_FOUND', message: `uid_drop not found: ${uidDrop}` };

  const sameAsEdgeUid = `same-${Date.now()}`;
  if (!dryRun) {
    db.transaction(() => {
      db.prepare(`UPDATE node SET t_invalid = ? WHERE uid = ?`).run(now, uidDrop);
      db.prepare(
        `INSERT INTO edge (src, dst, rel, origin, t_created, meta)
         SELECT ?, ?, 'SAME_AS', 'user_asserted', ?, '{"merge":"manual"}'
         WHERE NOT EXISTS (SELECT 1 FROM edge WHERE src=? AND dst=? AND rel='SAME_AS' AND t_expired IS NULL)`,
      ).run(keepRow.rowid, dropRow.rowid, now, keepRow.rowid, dropRow.rowid);
    })();
  }

  return { op: 'merge_duplicates', uid_kept: uidKeep, uid_dropped: uidDrop, same_as_edge_uid: sameAsEdgeUid, dry_run: dryRun };
}

function curateRecluster(
  db: Database,
  args: Record<string, unknown>,
  dryRun: boolean,
): CurateReclusterSubsetResult | CurateReclusterGlobalResult | { code: string; message?: string } {
  const filters = args['filters'] as Record<string, unknown> | undefined;
  const threshold = args['threshold'];

  // Filtered recluster
  if (filters && Object.keys(filters).length > 0) {
    const res = clusterSubset(db, {
      filter: filters as MemoryFilter,
      persist: !dryRun,
      ...(typeof threshold === 'number' ? { threshold } : {}),
    });

    const clusters = res.clusters.map((c) => ({
      community_uid: c.community_uid,
      label: c.label,
      size: c.member_rowids.length,
      mean_intra_sim: c.mean_intra_sim,
      members: c.member_rowids.map(String),
    }));

    return {
      op: 'recluster',
      scope: 'subset',
      dry_run: dryRun,
      persisted: res.persisted,
      provenance_hash: res.provenance_hash,
      candidate_count: res.candidate_count,
      cluster_count: clusters.length,
      unclustered_count: res.unclustered_count,
      full_pass: res.full_pass,
      clusters,
    };
  }

  // Global recluster
  if (dryRun) {
    return { op: 'recluster', enqueued: false, dry_run: true };
  }

  try {
    enqueueEnrich(db);
  } catch {
    // daemon not available
  }

  return { op: 'recluster', enqueued: true };
}

function curateDropLens(
  db: Database,
  args: Record<string, unknown>,
  dryRun: boolean,
): CurateDropLensResult | { code: string; message?: string } {
  const provenanceHash = args['provenance_hash'] as string | undefined;
  if (!provenanceHash) {
    return { code: 'E_MISSING', message: 'provenance_hash required for drop_lens' };
  }

  if (dryRun) {
    const lenses = listSubsetLenses(db);
    const lens = Array.isArray(lenses)
      ? lenses.find(
          (l: { provenance_hash: string }) => l.provenance_hash === provenanceHash,
        )
      : undefined;
    return {
      op: 'drop_lens',
      provenance_hash: provenanceHash,
      dry_run: true,
      communities_to_drop: (lens as { community_count?: number })?.community_count ?? 0,
      found: lens !== undefined,
    };
  }

  const result = dropSubsetLens(db, provenanceHash);
  return {
    op: 'drop_lens',
    provenance_hash: result.provenance_hash,
    communities_dropped: result.communities_dropped,
    edges_dropped: result.edges_dropped,
    dry_run: false,
  };
}
