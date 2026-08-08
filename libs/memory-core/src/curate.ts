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
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { monotonicFactory } from 'ulid';
import { ENRICH_VERSION } from './enrich-version.js';
import { clusterSubset, dropSubsetLens, listSubsetLenses } from './cluster.js';
import { gcOrphanedCommunityState } from './community-gc.js';
import { enqueueEnrichFull } from './outbox-queue.js';
import type { MemoryFilter } from './memory-filters.js';
import type { WriteQueue } from './write-queue.js';
import { healStaleVectors } from './embed-pipeline.js';
import { getActiveEmbedModel } from './embed.js';

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

/**
 * BL-215: operator surface for `healStaleVectors` (BL-88). See §2.1.2 of
 * SPEC-PKT-18.md for the full field rationale.
 */
export interface CurateRehealStaleResult {
  op: 'reheal_stale';
  /** Rows the pass examined this call (bounded by `limit`). */
  scanned: number;
  /** Rows successfully re-embedded and committed. */
  healed: number;
  /** Fresh COUNT of still-stale rows AFTER this pass — run it again while > 0. */
  remaining: number;
  /** Rows whose rowid no longer resolved to the scanned uid (benign race). */
  gone: number;
  /** Rows whose embed or apply threw. */
  failed: number;
  /** True when SOX_HEAL_STALE_VECTORS was not '1' — the pass did not run; `remaining` still reports honestly. */
  disabled: boolean;
  /** The active embed model resolved for this call. */
  active_model: string;
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
  | CurateRehealStaleResult
  | { code: string; message?: string; op?: string };

// ── Main dispatcher ───────────────────────────────────────────────────────────

export async function memoryCurate(
  adapter: StoreAdapter,
  args: Record<string, unknown>,
  wq?: WriteQueue,
): Promise<CurateResult> {
  const op = args['op'] as string;
  const dryRun = args['dry_run'] === true;
  const now = new Date().toISOString();

  switch (op) {
    case 'retag':
      return await curateRetag(adapter, args, now, dryRun);

    case 'set_topic':
      return await curateSetTopic(adapter, args, dryRun);

    case 'set_importance':
      return await curateSetImportance(adapter, args, now, dryRun);

    case 'merge_duplicates':
      return await curateMergeDuplicates(adapter, args, now, dryRun);

    case 'recluster':
      return await curateRecluster(adapter, args, dryRun);

    case 'drop_lens':
      return await curateDropLens(adapter, args, dryRun);

    case 'drop-episodes':
      return await curateDropEpisodes(adapter, args);

    case 'list_lenses':
      return { op: 'list_lenses', lenses: await listSubsetLenses(adapter) };

    case 'reheal_stale':
      return await curateRehealStale(adapter, args, wq);

    default:
      return { code: 'E_UNKNOWN_OP', op };
  }
}

// ── Sub-operation implementations ─────────────────────────────────────────────

async function curateRetag(
  adapter: StoreAdapter,
  args: Record<string, unknown>,
  now: string,
  dryRun: boolean,
): Promise<CurateRetagResult | { code: string; message?: string }> {
  const uid = args['uid'] as string | undefined;
  const newTags = args['tags'] as string[] | undefined;
  if (!uid) {
    return { code: 'E_MISSING', message: 'uid required for retag' };
  }

  const row = await adapter.executeGet<{ rowid: number; tags: string | null }>(
    `SELECT rowid, tags FROM node WHERE uid = ? AND t_invalid IS NULL LIMIT 1`,
    [uid],
  );
  if (!row) {
    return { code: 'E_NOT_FOUND' };
  }

  const existingTags = parseTags(row.tags);
  const tagsToAdd = (newTags ?? []).filter((t) => !existingTags.includes(t));
  const mergedTags = [...existingTags, ...tagsToAdd];

  const newEntityUids: string[] = [];

  if (!dryRun) {
    await adapter.transaction(async (tx) => {
      await tx.executeRun(
        `UPDATE node SET tags = ? WHERE uid = ?`,
        [JSON.stringify(mergedTags), uid],
      );

      for (const tag of tagsToAdd) {
        const tagName = tag.trim();
        if (!tagName) continue;
        const existing = await tx.executeGet<{ rowid: number; uid: string }>(
          `SELECT rowid, uid FROM node WHERE kind = 'entity' AND name = ? AND t_invalid IS NULL`,
          [tagName],
        );
        let entityRowid: number;
        let entityUid: string;
        if (existing) {
          entityRowid = existing.rowid;
          entityUid = existing.uid;
        } else {
          entityUid = ulid();
          const insResult = await tx.executeRun(
            `INSERT INTO node (uid, kind, name, t_created, t_valid) VALUES (?, 'entity', ?, ?, ?)`,
            [entityUid, tagName, now, now],
          );
          entityRowid = Number(insResult.lastInsertRowid);
          newEntityUids.push(entityUid);
        }
        await tx.executeRun(
          `INSERT INTO edge (src, dst, rel, origin, t_created, meta)
           SELECT ?, ?, 'MENTIONS', 'user_asserted', ?, '{}'
           WHERE NOT EXISTS (SELECT 1 FROM edge WHERE src=? AND dst=? AND rel='MENTIONS' AND t_expired IS NULL)`,
          [row.rowid, entityRowid, now, row.rowid, entityRowid],
        );
      }
    });
  }

  return { op: 'retag', uid, tags_added: tagsToAdd, new_entity_uids: newEntityUids };
}

async function curateSetTopic(
  adapter: StoreAdapter,
  args: Record<string, unknown>,
  dryRun: boolean,
): Promise<CurateSetTopicResult | { code: string; message?: string }> {
  const uid = args['uid'] as string | undefined;
  const newTopic = args['topic'] as string | undefined;
  if (!uid || !newTopic) {
    return { code: 'E_MISSING', message: 'uid and topic required for set_topic' };
  }

  const row = await adapter.executeGet<{ topic: string | null }>(
    `SELECT topic FROM node WHERE uid = ? AND t_invalid IS NULL LIMIT 1`,
    [uid],
  );
  if (row === undefined || row === null) {
    return { code: 'E_NOT_FOUND' };
  }

  const oldTopic = row.topic ?? null;
  if (!dryRun) {
    await adapter.executeRun(`UPDATE node SET topic = ? WHERE uid = ?`, [newTopic, uid]);
  }

  return { op: 'set_topic', uid, old_topic: oldTopic, new_topic: newTopic };
}

async function curateSetImportance(
  adapter: StoreAdapter,
  args: Record<string, unknown>,
  now: string,
  dryRun: boolean,
): Promise<CurateSetImportanceResult | { code: string; message?: string }> {
  const uid = args['uid'] as string | undefined;
  const newImportance = args['importance'] as number | undefined;
  if (!uid || newImportance === undefined) {
    return { code: 'E_MISSING', message: 'uid and importance required for set_importance' };
  }

  const row = await adapter.executeGet<{ importance: number }>(
    `SELECT importance FROM node WHERE uid = ? AND t_invalid IS NULL LIMIT 1`,
    [uid],
  );
  if (row === undefined || row === null) {
    return { code: 'E_NOT_FOUND' };
  }

  const oldImportance = row.importance;
  if (!dryRun) {
    const enrichVer = JSON.stringify({ pass: ENRICH_VERSION, ts: now, note: 'user_override' });
    await adapter.executeRun(
      `UPDATE node SET importance = ?, enrich_ver = ? WHERE uid = ?`,
      [newImportance, enrichVer, uid],
    );
  }

  return { op: 'set_importance', uid, old_importance: oldImportance, new_importance: newImportance };
}

async function curateMergeDuplicates(
  adapter: StoreAdapter,
  args: Record<string, unknown>,
  now: string,
  dryRun: boolean,
): Promise<CurateMergeResult | { code: string; message?: string }> {
  const uidKeep = args['uid_keep'] as string | undefined;
  const uidDrop = args['uid_drop'] as string | undefined;
  if (!uidKeep || !uidDrop) {
    return { code: 'E_MISSING', message: 'uid_keep and uid_drop required for merge_duplicates' };
  }

  const keepRow = await adapter.executeGet<{ rowid: number }>(
    `SELECT rowid FROM node WHERE uid = ? LIMIT 1`, [uidKeep],
  );
  const dropRow = await adapter.executeGet<{ rowid: number }>(
    `SELECT rowid FROM node WHERE uid = ? LIMIT 1`, [uidDrop],
  );

  if (!keepRow) return { code: 'E_NOT_FOUND', message: `uid_keep not found: ${uidKeep}` };
  if (!dropRow) return { code: 'E_NOT_FOUND', message: `uid_drop not found: ${uidDrop}` };

  const sameAsEdgeUid = crypto.randomUUID();
  if (!dryRun) {
    await adapter.transaction(async (tx) => {
      await tx.executeRun(`UPDATE node SET t_invalid = ? WHERE uid = ?`, [now, uidDrop]);
      // BUG-CLUSTER-ORPHANED-COMMUNITIES-NEVER-GC-001: merge_duplicates
      // invalidates the dropped episode — GC its community state too.
      await gcOrphanedCommunityState(tx, dropRow.rowid, now);
      // BL-398: the SAME_AS edge for a MANUAL merge must carry weight NULL —
      // the graph-store column default `weight REAL DEFAULT 1.0` silently
      // filled it with 1.0, and memoryGetNearDuplicates misreported that as a
      // fabricated cosine_sim: 1.0. No detector measured this pair's
      // similarity, so weight is NULL (unknown); meta records the provenance.
      await tx.executeRun(
        `INSERT INTO edge (src, dst, rel, origin, weight, t_created, meta)
         SELECT ?, ?, 'SAME_AS', 'user_asserted', NULL, ?, '{"merge":"manual"}'
         WHERE NOT EXISTS (SELECT 1 FROM edge WHERE src=? AND dst=? AND rel='SAME_AS' AND t_expired IS NULL)`,
        [keepRow.rowid, dropRow.rowid, now, keepRow.rowid, dropRow.rowid],
      );
    });
  }

  return { op: 'merge_duplicates', uid_kept: uidKeep, uid_dropped: uidDrop, same_as_edge_uid: sameAsEdgeUid, dry_run: dryRun };
}

async function curateRecluster(
  adapter: StoreAdapter,
  args: Record<string, unknown>,
  dryRun: boolean,
): Promise<CurateReclusterSubsetResult | CurateReclusterGlobalResult | { code: string; message?: string }> {
  const filters = args['filters'] as Record<string, unknown> | undefined;
  const threshold = args['threshold'];

  // Filtered recluster
  if (filters && Object.keys(filters).length > 0) {
    const res = await clusterSubset(adapter, {
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

  const seq = await enqueueEnrichFull(adapter, 'memory_curate recluster');
  return { op: 'recluster', enqueued: true, seq };
}

async function curateDropLens(
  adapter: StoreAdapter,
  args: Record<string, unknown>,
  dryRun: boolean,
): Promise<CurateDropLensResult | { code: string; message?: string }> {
  const provenanceHash = args['provenance_hash'] as string | undefined;
  if (!provenanceHash) {
    return { code: 'E_MISSING', message: 'provenance_hash required for drop_lens' };
  }

  if (dryRun) {
    const lenses = await listSubsetLenses(adapter);
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

  const result = await dropSubsetLens(adapter, provenanceHash);
  return {
    op: 'drop_lens',
    provenance_hash: result.provenance_hash,
    communities_dropped: result.communities_dropped,
    edges_dropped: result.edges_dropped,
    dry_run: false,
  };
}

async function curateDropEpisodes(
  adapter: StoreAdapter,
  args: Record<string, unknown>,
): Promise<CurateDropEpisodesResult | { code: string; message?: string }> {
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
  const uidResult = await adapter.executeAll<{ rowid: number }>(
    `SELECT rowid FROM node WHERE uid IN (${uidPlaceholders}) AND t_invalid IS NULL`,
    uids,
  );
  const rows = uidResult.rows;

  if (rows.length === 0) {
    return { op: 'drop-episodes', deleted: 0, cascaded: { vec_node: 0, edges: 0 } };
  }

  const rowids = rows.map((r) => r.rowid);
  const rowidPlaceholders = rowids.map(() => '?').join(',');

  let deletedVec = 0;
  let deletedEdges = 0;

  await adapter.transaction(async (tx) => {
    // Delete from vec_node (virtual table without FK cascade)
    const vecRes = await tx.executeRun(
      `DELETE FROM vec_node WHERE node_id IN (${rowidPlaceholders})`,
      rowids,
    );
    deletedVec = vecRes.rowsAffected;

    // Delete from edge — explicit cascade (src or dst references the node rowid)
    const edgeRes = await tx.executeRun(
      `DELETE FROM edge WHERE src IN (${rowidPlaceholders}) OR dst IN (${rowidPlaceholders})`,
      [...rowids, ...rowids],
    );
    deletedEdges = edgeRes.rowsAffected;

    // Delete the nodes themselves. The FTS cleanup trigger (fts_node_ad) handles
    // the fts_node virtual table automatically. Edge ON DELETE CASCADE is
    // irrelevant since edges were already removed above.
    await tx.executeRun(`DELETE FROM node WHERE rowid IN (${rowidPlaceholders})`, rowids);
  });

  return {
    op: 'drop-episodes',
    deleted: rows.length,
    cascaded: {
      vec_node: deletedVec,
      edges: deletedEdges,
    },
  };
}

// ── reheal_stale (BL-88/BL-215) ─────────────────────────────────────────────

const REHEAL_DEFAULT_LIMIT = 50;
const REHEAL_MAX_LIMIT = 2000;

async function curateRehealStale(
  adapter: StoreAdapter,
  args: Record<string, unknown>,
  wq: WriteQueue | undefined,
): Promise<CurateRehealStaleResult | { code: string; message?: string }> {
  if (args['dry_run'] === true) {
    return {
      code: 'E_UNSUPPORTED',
      message:
        'reheal_stale does not support dry_run — it always performs the heal when enabled. ' +
        'Preview the candidate count via memory_stats.embed_provenance.stale_vector_count first.',
    };
  }
  if (!wq) {
    return {
      code: 'E_MISSING',
      message: 'reheal_stale requires an active WriteQueue (internal wiring error — the ' +
        'memory_curate MCP handler must pass one; see index.ts case memory_curate).',
    };
  }

  const rawLimit = args['limit'];
  const numericLimit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? rawLimit : REHEAL_DEFAULT_LIMIT;
  const limit = Math.min(REHEAL_MAX_LIMIT, Math.max(1, Math.floor(numericLimit)));

  const pass = await healStaleVectors(adapter, wq, { limit });

  const activeModel = getActiveEmbedModel() ?? 'unknown';
  const remainingRow = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt
     FROM node n
     WHERE n.kind = 'episode'
       AND n.t_invalid IS NULL
       AND n.embed_model IS NOT NULL
       AND n.embed_model != ?
       AND EXISTS (SELECT 1 FROM vec_node v WHERE v.node_id = n.rowid)`,
    [activeModel],
  );

  return {
    op: 'reheal_stale',
    scanned: pass.scanned,
    healed: pass.healed,
    remaining: remainingRow?.cnt ?? 0,
    gone: pass.gone,
    failed: pass.failed,
    disabled: pass.disabled,
    active_model: activeModel,
  };
}
