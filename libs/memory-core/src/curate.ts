/**
 * memoryCurate — dispatcher for curation operations.
 *
 * Edge operations use raw SQL with NOT EXISTS guard (graph-store's writeEdge
 * requires a UNIQUE index not present in the memory-core schema).
 * Node operations use direct SQL (SELECT/UPDATE node).
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import * as crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';
import { ENRICH_VERSION } from './enrich-version.js';
import { clusterSubset, dropSubsetLens, listSubsetLenses } from './cluster.js';
import { enqueueEnrichFull } from './outbox-queue.js';
import type { MemoryFilter } from './memory-filters.js';

const ulid = monotonicFactory();

function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as string[];
  } catch {
    /* malformed */
  }
  return [];
}

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
  /** HONEST (BL-186): true only when a full-pass trigger row was actually
   *  committed to organizer_queue. The in-process periodic tick consumes it. */
  enqueued: boolean;
  dry_run?: boolean;
  /** organizer_queue seq of the enqueued full-pass row (absent on dry_run).
   *  The pass runs on the consumer's next periodic tick; correlate with
   *  memory_ping's queue_last_done_at / enrichment verdict. */
  seq?: number;
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

export interface CurateDropEpisodesResult {
  op: 'drop-episodes';
  deleted: number;
  cascaded: {
    vec_node: number;
    edges: number;
  };
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
  | CurateDropEpisodesResult
  | CurateListLensesResult
  | { code: string; message?: string; op?: string };

// ── Main dispatcher ───────────────────────────────────────────────────────────

export async function memoryCurate(
  db: Database.Database,
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

    case 'drop-episodes':
      return curateDropEpisodes(db, args);

    case 'list_lenses':
      return { op: 'list_lenses', lenses: listSubsetLenses(db) };

    default:
      return { code: 'E_UNKNOWN_OP', op };
  }
}

// ── Sub-operation implementations ─────────────────────────────────────────────

function curateRetag(
  db: Database.Database,
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
  db: Database.Database,
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
  db: Database.Database,
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
  db: Database.Database,
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

  const sameAsEdgeUid = crypto.randomUUID();
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
  db: Database.Database,
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

  // Global recluster (BL-186): enqueue a FULL-pass `enrich` trigger row and let
  // the in-process periodic tick run `runBatchEnrich({incrementalCluster:false})`
  // — never synchronously inside this tool call. Rationale: the full pass on a
  // large store blocks the serial WriteQueue slot for its whole duration (every
  // write behind it can fast-fail E_BUSY under the time-based backpressure), and
  // the MCP recluster call itself can out-wait its client timeout. Deferring to
  // the tick costs at most one tick interval of latency and keeps the queue
  // slot short. The return value is HONEST: `enqueued: true` only after the row
  // is committed (an insert failure propagates as a tool error, never a false
  // success — [inv:list-never-lies]).
  if (dryRun) {
    return { op: 'recluster', enqueued: false, dry_run: true };
  }

  const seq = enqueueEnrichFull(db, 'memory_curate recluster');
  return { op: 'recluster', enqueued: true, seq };
}

function curateDropLens(
  db: Database.Database,
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

function curateDropEpisodes(
  db: Database.Database,
  args: Record<string, unknown>,
): CurateDropEpisodesResult | { code: string; message?: string } {
  const rawUids = args['uids'];
  const uids: string[] = Array.isArray(rawUids)
    ? rawUids.filter((u): u is string => typeof u === 'string')
    : [];
  if (uids.length === 0) {
    return { code: 'E_MISSING', message: 'uids must be a non-empty array of episode UIDs' };
  }

  // Resolve rowids for live nodes matching the given UIDs.
  // Only live nodes (t_invalid IS NULL) are eligible for deletion.
  // Non-existent or already-invalidated UIDs are silently skipped.
  const uidPlaceholders = uids.map(() => '?').join(',');
  const rows = db
    .prepare<unknown[], { rowid: number }>(
      `SELECT rowid FROM node WHERE uid IN (${uidPlaceholders}) AND t_invalid IS NULL`,
    )
    .all(...uids) as { rowid: number }[];

  if (rows.length === 0) {
    return { op: 'drop-episodes', deleted: 0, cascaded: { vec_node: 0, edges: 0 } };
  }

  const rowids = rows.map((r) => r.rowid);
  const rowidPlaceholders = rowids.map(() => '?').join(',');

  let deletedVec = 0;
  let deletedEdges = 0;

  db.transaction(() => {
    // Delete from vec_node (virtual table without FK cascade)
    const vecRes = db
      .prepare(`DELETE FROM vec_node WHERE node_id IN (${rowidPlaceholders})`)
      .run(...rowids);
    deletedVec = vecRes.changes;

    // Delete from edge — explicit cascade (src or dst references the node rowid)
    const edgeRes = db
      .prepare(`DELETE FROM edge WHERE src IN (${rowidPlaceholders}) OR dst IN (${rowidPlaceholders})`)
      .run(...rowids, ...rowids);
    deletedEdges = edgeRes.changes;

    // Delete the nodes themselves. The FTS cleanup trigger (fts_node_ad) handles
    // the fts_node virtual table automatically. Edge ON DELETE CASCADE is
    // irrelevant since edges were already removed above.
    db.prepare(`DELETE FROM node WHERE rowid IN (${rowidPlaceholders})`).run(...rowids);
  })();

  return {
    op: 'drop-episodes',
    deleted: rows.length,
    cascaded: {
      vec_node: deletedVec,
      edges: deletedEdges,
    },
  };
}
