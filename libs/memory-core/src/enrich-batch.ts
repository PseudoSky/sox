/**
 * batch.ts — batch-pass enrichment orchestrator (Tier 2, daemon loop).
 * CONTRACTS.md C1.3.
 *
 * Covers E6 (clustering), E7 (link/access importance update), E9 (RELATES_TO auto-links),
 * E11 (decay). Runs in the daemon batch loop.
 *
 * Determinism: given the same DB state and options, produces identical output.
 * No LLM, no network.
 */

import type { Database } from 'better-sqlite3';
import { buildAutoLinks } from './autolink.js';
import { clusterStore } from './cluster.js';
import { computeImportance } from './importance.js';
import type { ImportanceWeights } from './importance.js';
import { ENRICH_VERSION } from './enrich-version.js';

export type { ImportanceWeights } from './importance.js';

export interface BatchEnrichOptions {
  /** Cosine similarity threshold for clustering (default 0.82 real, 0.70 hash). */
  clusterThreshold?: number;
  /** Near-dup threshold for SAME_AS edges (default 0.95 real, 0.98 hash). */
  nearDupThreshold?: number;
  /** Maximum episodes per full cluster pass (default 10000; soft cap per D1.7). */
  clusterNodeCap?: number;
  /** Importance blend weights (default: all 1.0, max sum = 10). */
  importanceWeights?: ImportanceWeights;
  /** Entity stoplist coverage threshold; entities in > this fraction of episodes are excluded
   *  from RELATES_TO linking (default 0.30). */
  entityStoplistThreshold?: number;
  /**
   * BL-45: When true, run incremental clustering only (local neighborhood check for
   * newly-added nodes). Skip the full O(n²) re-cluster pass. Reserve the full pass
   * for periodic/explicit triggers (memory_curate recluster / enqueueEnrich).
   * Default false (full pass).
   */
  incrementalCluster?: boolean;
  /**
   * BL-45: Chunk size for the importance update transaction (default 500 episodes per
   * chunk). Breaks the monolithic write transaction into smaller batches so the write
   * lock is yielded between chunks rather than held across the full corpus.
   * Set to 0 or Infinity to use a single transaction (original behaviour).
   */
  importanceChunkSize?: number;
}

export interface BatchEnrichResult {
  /** Number of community nodes created or updated (E6). */
  communities_upserted: number;
  /** Number of MEMBER_OF edges inserted or refreshed (E6). */
  member_of_edges: number;
  /** Number of nodes whose importance was updated (E7). */
  importance_updated: number;
  /** Number of RELATES_TO edges inserted (E9). */
  relates_to_edges: number;
  /** Number of nodes whose topic was backfilled from cluster label (E5 batch). */
  topics_backfilled: number;
  /** Number of nodes whose enrich_ver was set to "legacy" (first-pass backfill). */
  legacy_nodes_stamped: number;
  /** Whether the cluster pass was skipped due to the degenerate-cluster guard (D5.5). */
  cluster_pass_skipped: boolean;
  /** If skipped: the reason string. */
  cluster_skip_reason?: string;
}

interface EpisodeRow {
  rowid: number;
  uid: string;
  content: string | null;
  access_count: number;
  importance: number;
  enrich_ver: string | null;
  topic: string | null;
}

/**
 * Run batch enrichments (E6, E7 link/access, E9, E11) over the entire live corpus.
 *
 * Determinism guarantees:
 * - Given the same DB state and options, produces identical output.
 * - Stable community UIDs: uid = sha256(sorted member rowids).slice(0,32).
 * - Degenerate-cluster guard: if max_cluster/total > 0.5, raises threshold by 0.05
 *   up to 3 retries; if still degenerate, skips MEMBER_OF writes (D5.5).
 * - Mixed-model guard: if any live node has enrich_ver IS NULL, skips cluster pass
 *   and enqueues a reindex op first (D5.3).
 *
 * @param db   Open better-sqlite3 Database (write-capable).
 * @param opts Optional tuning parameters.
 * @returns    BatchEnrichResult with counts of all mutations made.
 */
export function runBatchEnrich(
  db: Database,
  opts: BatchEnrichOptions = {},
): BatchEnrichResult {
  const {
    clusterThreshold,
    clusterNodeCap = 10000,
    importanceWeights,
    entityStoplistThreshold = 0.30,
    incrementalCluster = false,
    importanceChunkSize = 500,
  } = opts;

  const now = new Date().toISOString();
  const result: BatchEnrichResult = {
    communities_upserted: 0,
    member_of_edges: 0,
    importance_updated: 0,
    relates_to_edges: 0,
    topics_backfilled: 0,
    legacy_nodes_stamped: 0,
    cluster_pass_skipped: false,
  };

  // ── Step 1: Stamp legacy nodes (first-pass backfill, E12) ──────────────────
  const legacyStamp = JSON.stringify({ pass: 'legacy', ts: now, note: 'legacy' });
  const legacyUpdate = db.prepare(
    `UPDATE node SET enrich_ver = ? WHERE kind = 'episode' AND t_invalid IS NULL AND enrich_ver IS NULL`,
  ).run(legacyStamp) as unknown as { changes: number };
  result.legacy_nodes_stamped = legacyUpdate.changes;

  // ── Step 2: Mixed-model guard (D5.3) ──────────────────────────────────────
  // Check: any live episode with enrich_ver IS NULL after stamping?
  const nullVerRow = db
    .prepare<[], { cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL AND enrich_ver IS NULL`,
    )
    .get();
  const hasNullEnrichVer = (nullVerRow?.cnt ?? 0) > 0;

  // ── Step 3: Clustering (E6) ────────────────────────────────────────────────
  // BL-45: write-triggered passes use incrementalCluster:true (local neighborhood
  // check only, no O(n²) full pass). Full re-cluster is reserved for periodic or
  // explicit triggers (memory_curate recluster / enqueueEnrich without the flag).
  if (!hasNullEnrichVer) {
    const defaultThreshold = resolveClusterThreshold(clusterThreshold);
    const clusterResult = clusterStore(db, {
      threshold: defaultThreshold,
      nodeCap: clusterNodeCap,
      incrementalOnly: incrementalCluster,
    });

    if (clusterResult.clusters.length === 0 && !clusterResult.full_pass) {
      result.cluster_pass_skipped = true;
      result.cluster_skip_reason = 'degenerate-cluster guard: threshold retries exhausted';
    } else {
      result.communities_upserted = clusterResult.clusters.length;
      for (const cluster of clusterResult.clusters) {
        result.member_of_edges += cluster.member_rowids.length;
      }

      // E5 batch: backfill topic from cluster label for episodes with no topic
      for (const cluster of clusterResult.clusters) {
        if (!cluster.label) continue;
        const updateCount = db.prepare(
          `UPDATE node SET topic = ? WHERE rowid IN (${cluster.member_rowids.map(() => '?').join(',')})
           AND kind = 'episode' AND t_invalid IS NULL AND topic IS NULL`,
        ).run(cluster.label, ...cluster.member_rowids) as unknown as { changes: number };
        result.topics_backfilled += updateCount.changes;
      }
    }
  } else {
    result.cluster_pass_skipped = true;
    result.cluster_skip_reason = 'mixed-model guard: null enrich_ver episodes detected; reindex required (D5.3)';
  }

  // ── Step 4: Importance update (E7) ────────────────────────────────────────
  // Recompute importance for all live episodes using current link degree + access count.
  // BL-45: Process in chunks (importanceChunkSize, default 500) to yield the write
  // lock between chunks rather than holding it across the full corpus in one transaction.
  const episodes = db
    .prepare<[], EpisodeRow>(
      `SELECT rowid, uid, content, access_count, importance, enrich_ver, topic
       FROM node WHERE kind = 'episode' AND t_invalid IS NULL`,
    )
    .all();

  const updateImportance = db.prepare(
    `UPDATE node SET importance = ?, enrich_ver = ? WHERE rowid = ?`,
  );

  /** Process one episode row and update importance if changed. */
  const processEpisode = (ep: EpisodeRow): void => {
    const wordCount = (ep.content ?? '').split(/\s+/).filter(Boolean).length;

    const linkRow = db
      .prepare<[number, number], { cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM edge WHERE (src = ? OR dst = ?) AND t_expired IS NULL`,
      )
      .get(ep.rowid, ep.rowid);
    const linkDegree = linkRow?.cnt ?? 0;

    const tagsRow = db
      .prepare<[number], { tags: string | null }>(
        `SELECT tags FROM node WHERE rowid = ?`,
      )
      .get(ep.rowid);
    const tagCount = tagsRow?.tags
      ? (JSON.parse(tagsRow.tags) as string[]).length
      : 0;

    const newImportance = computeImportance(
      {
        word_count: wordCount,
        link_degree: linkDegree,
        access_count: ep.access_count,
        tag_count: tagCount,
      },
      importanceWeights,
    );

    // Only update if the value changed (avoid unnecessary writes)
    if (Math.abs(newImportance - ep.importance) > 0.001) {
      const newVer = JSON.stringify({ pass: ENRICH_VERSION, ts: now });
      updateImportance.run(newImportance, newVer, ep.rowid);
      result.importance_updated++;
    }
  };

  const effectiveChunkSize =
    importanceChunkSize > 0 && Number.isFinite(importanceChunkSize)
      ? importanceChunkSize
      : episodes.length; // single transaction (back-compat when set to 0/Infinity)

  // Chunked transactions: each chunk acquires and releases the write lock independently,
  // so a concurrent MCP write can interleave between chunks instead of stalling for the
  // full-corpus transaction duration.
  for (let i = 0; i < episodes.length; i += effectiveChunkSize) {
    const chunk = episodes.slice(i, i + effectiveChunkSize);
    const chunkTx = db.transaction(() => {
      for (const ep of chunk) {
        processEpisode(ep);
      }
    });
    chunkTx();
  }

  // ── Step 5: Auto-links (E9) ────────────────────────────────────────────────
  const autoLinkResult = buildAutoLinks(db, entityStoplistThreshold);
  result.relates_to_edges = autoLinkResult.edges_inserted;

  return result;
}

/** Resolve cluster threshold from option or environment/default. */
function resolveClusterThreshold(override: number | undefined): number {
  if (override !== undefined) return override;
  const backend = process.env['SOX_EMBED_BACKEND'];
  if (backend === 'hash') return 0.70;
  if (backend === 'real') return 0.82;
  // auto / undefined: use hash threshold (conservative)
  return 0.70;
}
