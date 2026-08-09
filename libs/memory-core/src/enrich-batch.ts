/**
 * batch.ts — batch-pass enrichment orchestrator (Tier 2, daemon loop).
 * CONTRACTS.md C1.3.
 *
 * Covers E6 (clustering), E7 (link/access importance update), E9 (RELATES_TO auto-links),
 * E11 (decay). Runs in the daemon batch loop.
 *
 * Uses GraphBackend for node/edge CRUD where the schema is compatible;
 * keeps raw SQL for memory-core-specific operations (enrich_ver, kind-based queries,
 * vec_node, batch edge invalidation).
 *
 * Determinism: given the same DB state and options, produces identical output.
 * No LLM, no network.
 *
 * ADAPTED: accepts StoreAdapter instead of better-sqlite3 Database so the same
 * batch pipeline works on both SqliteAdapter (sync) and TursoAdapter (async).
 * The `db` parameter was replaced by `adapter` throughout — callers that already
 * have an unwrapped better-sqlite3 Database can pass wrapRawDbAsAdapter(db).
 */

import { getMemoryGraphBackend } from './graph-backend.js';
import { buildAutoLinks } from './autolink.js';
import { clusterStore, type ClusterAdmissionStats, type ThresholdCalibration } from './cluster.js';
import { computeImportance } from './importance.js';
import type { ImportanceWeights } from './importance.js';
import { ENRICH_VERSION } from './enrich-version.js';
import type { StoreAdapter, AdapterTransaction } from '@adhd/sox-store-adapter';

export type { ImportanceWeights } from './importance.js';

export interface BatchEnrichOptions {
  /**
   * Cosine similarity threshold for clustering (default: resolveDefaultThreshold(),
   * currently 0.87 — see cluster.ts; PKT-30/BL-328 replaces this constant with
   * real target-degree calibration).
   */
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
   * for periodic/explicit triggers (memory_curate recluster / the in-process periodic
   * enrichment loop in memory-server).
   * Default false (full pass).
   */
  incrementalCluster?: boolean;
  /**
   * Metrics bucket for clustering observability — the store's `dbPath`, the
   * same string `memory_ping` resolves. Threaded through to `clusterStore` so
   * per-store cluster counters are attributable in a multi-store process. When
   * omitted, cluster.ts records into its named `(unkeyed)` bucket rather than
   * merging into an unrelated store's numbers.
   */
  storeKey?: string;
  /**
   * BL-45: Chunk size for the importance update transaction (default 500 episodes per
   * chunk). Breaks the monolithic write transaction into smaller batches so the write
   * lock is yielded between chunks rather than held across the full corpus.
   * Set to 0 or Infinity to use a single transaction (original behaviour).
   */
  importanceChunkSize?: number;
  /**
   * DEBT-MEMORY-ENRICH-001: chunk size for the auto-link (RELATES_TO) pass.
   * Default 500 episodes per outer-chunk transaction — releases the write lock
   * between chunks instead of holding it across the whole pairwise pass
   * (measured 30,558 INSERTs in one transaction, ~8s per tick). The (i, j)
   * iteration order is unchanged, so results are byte-identical to the
   * single-transaction form. 0 or Infinity → single transaction (original).
   */
  autoLinkChunkSize?: number;
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
  /**
   * BL-406: Number of live episodes whose embed_model was backfilled from
   * memory_scope.embed_model. These are pre-BL-88 rows that have a valid
   * vector but were never stamped with the model that produced it (BL-88
   * added the column without a backfill pass). Only rows WITH a vec_node row
   * are eligible — a row with no vector has no provenance to attribute (see
   * EmbedProvenanceStats.stamped_without_vector in stats.ts instead, which
   * the embed heal queue already picks up independently of this stamp).
   */
  embed_model_backfilled: number;
  /** Whether the cluster pass was skipped due to the degenerate-cluster guard (D5.5). */
  cluster_pass_skipped: boolean;
  /** If skipped: the reason string. */
  cluster_skip_reason?: string;
  /**
   * BL-349: episodes joined to an EXISTING community by the incremental
   * local-neighborhood join (incrementalCluster:true passes only; 0 on a full
   * pass, where `communities_upserted`/`member_of_edges` carry the count
   * instead). Independent traceability for clustering vs. embedding per the
   * owner's requirement — this number is never touched when embedding fails
   * or is skipped, and vice versa.
   */
  incremental_joined: number;
  /**
   * PKT-30/BL-328: the target-mean-degree calibration this full pass ran —
   * the τ it chose, the sampled edge probability, and the projected mean
   * degree that justified it. Absent on an incremental pass (which never
   * recalibrates, §2.2) and when the caller passed an explicit threshold
   * override (which is absolute).
   *
   * Surfaced rather than kept internal because BL-328 §5.4's finding was that
   * the operating threshold was "0.82 plus whatever the guard escalated to —
   * an undocumented, corpus-dependent number that no test asserts and no
   * status surface reports." A pass that cannot say what τ it ran at is the
   * defect, independently of which τ it picked.
   */
  cluster_calibration?: ThresholdCalibration;
  /**
   * How many times the D5.5 degenerate guard had to retry at τ+0.05 on this
   * pass. Should be 0 now that calibration runs in front of it: a non-zero
   * value means calibration under-shot and the guard is doing the real work
   * again, which is the exact condition BL-328 §5.4 says must not hold.
   */
  cluster_guard_retries?: number;
  /** The τ the partition was actually produced at (post-calibration, post-guard). */
  cluster_effective_threshold?: number;
  /**
   * BL-496: admission accounting from the incremental join — how many
   * candidates were considered, joined, and REJECTED BELOW τ. The last of
   * these had no representation anywhere before BL-496: a rejected episode
   * writes nothing, so it was indistinguishable from one not yet considered.
   * Absent on a full pass (which re-partitions rather than admitting).
   */
  cluster_admission?: ClusterAdmissionStats;
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
 * BL-413 / BUG-MEMORY-ENRICH-001: indexed link-degree count (live incident
 * edges on EITHER side, excluding expired). The previous form
 * `WHERE (src = ? OR dst = ?) AND t_expired IS NULL` forced a FULL scan of the
 * partial `ix_edge_dst` index per episode (EXPLAIN QUERY PLAN: `SCAN edge USING
 * INDEX ix_edge_dst`; 47,619 edge rows scanned per call, 24.3ms/call) — 4,956
 * episodes = 120.23s of the ~129s periodic pass, which blew the 120s
 * runEnrichIsolated budget on EVERY tick and froze the organizer_queue. The OR
 * predicate cannot use both partial indexes; two scalar subqueries each hit
 * their own leading-column partial index (EXPLAIN: `SEARCH ix_edge_src (src=?)`
 * + `SEARCH ix_edge_dst (dst=?)`) at 0.04ms/call measured — ~600x faster. The
 * sum is exactly equivalent to the OR only while no self-loop edge (src = dst)
 * exists — verified 0 live self-loops on the live store 2026-08-03; if a
 * self-loop ever becomes possible, switch to the UNION form (still 60x faster).
 */
export async function computeLinkDegree(tx: AdapterTransaction, rowid: number): Promise<number> {
  const linkRow = await tx.executeGet<{ cnt: number }>(
    `SELECT (SELECT COUNT(*) FROM edge WHERE src = ? AND t_expired IS NULL)
          + (SELECT COUNT(*) FROM edge WHERE dst = ? AND t_expired IS NULL) AS cnt`,
    [rowid, rowid],
  );
  return linkRow?.cnt ?? 0;
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
 * @param adapter Open StoreAdapter (write-capable) — works on both SqliteAdapter
 *                (better-sqlite3 sync) and TursoAdapter (async libSQL).
 * @param opts    Optional tuning parameters.
 * @returns       BatchEnrichResult with counts of all mutations made.
 */
export async function runBatchEnrich(
  adapter: StoreAdapter,
  opts: BatchEnrichOptions = {},
): Promise<BatchEnrichResult> {
  // GraphBackend instance for node/edge CRUD (sibling pattern)
  getMemoryGraphBackend(adapter);

  const {
    clusterThreshold,
    clusterNodeCap = 10000,
    importanceWeights,
    entityStoplistThreshold = 0.30,
    incrementalCluster = false,
    importanceChunkSize = 500,
    autoLinkChunkSize = 500,
    storeKey,
  } = opts;

  const now = new Date().toISOString();
  const result: BatchEnrichResult = {
    communities_upserted: 0,
    member_of_edges: 0,
    importance_updated: 0,
    relates_to_edges: 0,
    topics_backfilled: 0,
    legacy_nodes_stamped: 0,
    embed_model_backfilled: 0,
    cluster_pass_skipped: false,
    incremental_joined: 0,
  };

  // ── Step 1: Stamp legacy nodes (first-pass backfill, E12) ──────────────────
  const legacyStamp = JSON.stringify({ pass: 'legacy', ts: now, note: 'legacy' });
  const legacyResult = await adapter.executeRun(
    `UPDATE node SET enrich_ver = ? WHERE kind = 'episode' AND t_invalid IS NULL AND enrich_ver IS NULL`,
    [legacyStamp],
  );
  result.legacy_nodes_stamped = legacyResult.rowsAffected;

  // ── Step 1b: Backfill embed_model for unstamped legacy vectors (BL-406) ────
  // BL-88 added node.embed_model but never backfilled it, so pre-BL-88 rows
  // stay unstamped forever regardless of how many enrich passes run — and an
  // unstamped row is excluded BY CONSTRUCTION from stale_vector_count
  // (libs/memory-core/src/stats.ts), so the store can silently retain
  // old-model vectors after a model swap while reporting full freshness.
  //
  // Only rows that already HAVE a vector are eligible: we are attributing an
  // existing vector to the model it was actually produced under (the scope's
  // recorded embed_model), never re-embedding. A row with no vector has
  // nothing to attribute — see stats.ts's `stamped_without_vector` for that
  // shape, which is handled by the embed heal queue instead.
  // Defensive: some lightweight test fixtures (enrich.spec.ts) build a minimal
  // schema without a memory_scope table at all — mirrors the try/catch already
  // used for the same query in stats.ts's degradedRecordCount.
  let scopeEmbedModel: string | null = null;
  try {
    const scopeModelRow = await adapter.executeGet<{ embed_model: string | null }>(
      `SELECT embed_model FROM memory_scope LIMIT 1`,
    );
    scopeEmbedModel = scopeModelRow?.embed_model ?? null;
  } catch {
    scopeEmbedModel = null;
  }
  if (scopeEmbedModel) {
    const embedBackfillResult = await adapter.executeRun(
      `UPDATE node SET embed_model = ?
       WHERE kind = 'episode' AND t_invalid IS NULL AND embed_model IS NULL
         AND EXISTS (SELECT 1 FROM vec_node v WHERE v.node_id = node.rowid)`,
      [scopeEmbedModel],
    );
    result.embed_model_backfilled = embedBackfillResult.rowsAffected;
  }

  // ── Step 2: Mixed-model guard (D5.3) ──────────────────────────────────────
  // Check: any live episode with enrich_ver IS NULL after stamping?
  const nullVerRow = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL AND enrich_ver IS NULL`,
  );
  const hasNullEnrichVer = (nullVerRow?.cnt ?? 0) > 0;

  // ── Step 3: Clustering (E6) ────────────────────────────────────────────────
  // BL-45: write-triggered passes use incrementalCluster:true (local neighborhood
  // check only, no O(n²) full pass). Full re-cluster is reserved for periodic or
  // explicit triggers (memory_curate recluster / the in-process periodic enrichment
  // loop in memory-server, without the incremental flag).
  if (!hasNullEnrichVer) {
    const thresholdOverride = resolveClusterThreshold(clusterThreshold);
    const clusterResult = await clusterStore(adapter, {
      // Omitted (not set to undefined) when there is no override, so a full
      // pass calibrates its own τ — see `resolveClusterThreshold` above.
      ...(thresholdOverride !== undefined ? { threshold: thresholdOverride } : {}),
      nodeCap: clusterNodeCap,
      incrementalOnly: incrementalCluster,
      // Metrics bucket. Omitted (not set to undefined) when the caller supplied
      // none, so cluster.ts's own DEFAULT_STORE_KEY fallback applies rather than
      // this layer inventing a key — same "omit, don't undefined" discipline as
      // the threshold override above.
      ...(storeKey !== undefined ? { storeKey } : {}),
    });

    result.incremental_joined = clusterResult.incremental_joined ?? 0;
    if (clusterResult.calibration) result.cluster_calibration = clusterResult.calibration;
    if (clusterResult.guard_retries !== undefined) result.cluster_guard_retries = clusterResult.guard_retries;
    if (clusterResult.effective_threshold !== undefined) {
      result.cluster_effective_threshold = clusterResult.effective_threshold;
    }
    // BL-496: carry admission stats out of the isolated child so the parent
    // can register them for memory_ping. This is the ONLY channel by which
    // "considered and rejected" escapes the child before it exits.
    if (clusterResult.admission) result.cluster_admission = clusterResult.admission;

    if (clusterResult.clusters.length === 0 && !clusterResult.full_pass && result.incremental_joined === 0) {
      result.cluster_pass_skipped = true;
      result.cluster_skip_reason = clusterResult.incremental_joined !== undefined
        ? 'incremental join: no existing community within threshold (deferred to full/subset pass)'
        : 'degenerate-cluster guard: threshold retries exhausted';
    } else {
      result.communities_upserted = clusterResult.clusters.length;
      for (const cluster of clusterResult.clusters) {
        result.member_of_edges += cluster.member_rowids.length;
      }

      // E5 batch: backfill topic from cluster label for episodes with no topic
      for (const cluster of clusterResult.clusters) {
        if (!cluster.label) continue;
        const params = [cluster.label, ...cluster.member_rowids];
        const tResult = await adapter.executeRun(
          `UPDATE node SET topic = ? WHERE rowid IN (${cluster.member_rowids.map(() => '?').join(',')})
           AND kind = 'episode' AND t_invalid IS NULL AND topic IS NULL`,
          params,
        );
        result.topics_backfilled += tResult.rowsAffected;
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
  const epRows = await adapter.executeAll<EpisodeRow>(
    `SELECT rowid, uid, content, access_count, importance, enrich_ver, topic
     FROM node WHERE kind = 'episode' AND t_invalid IS NULL`,
  );
  const episodes = epRows.rows;

  /** Process one episode row and update importance if changed. */
  const processEpisode = async (tx: AdapterTransaction, ep: EpisodeRow): Promise<void> => {
    // PERF-MEMORY-004 / CONTRACTS.md C2.1: skip re-scoring when enrich_ver
    // contains user_override — the caller explicitly asserted this importance
    // value and the batch pass must preserve both the value and the note.
    if (ep.enrich_ver) {
      try {
        const parsed = JSON.parse(ep.enrich_ver) as { note?: string };
        if (parsed.note === 'user_override') return;
      } catch { /* malformed enrich_ver — fall through to recompute */ }
    }

    const wordCount = (ep.content ?? '').split(/\s+/).filter(Boolean).length;

    const linkDegree = await computeLinkDegree(tx, ep.rowid);

    const tagsRow = await tx.executeGet<{ tags: string | null }>(
      `SELECT tags FROM node WHERE rowid = ?`,
      [ep.rowid],
    );
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
      await tx.executeRun(
        `UPDATE node SET importance = ?, enrich_ver = ? WHERE rowid = ?`,
        [newImportance, newVer, ep.rowid],
      );
      result.importance_updated++;
    }
  };

  const effectiveChunkSize =
    importanceChunkSize > 0 && Number.isFinite(importanceChunkSize)
      ? importanceChunkSize
      : episodes.length; // single transaction (back-compat when set to 0/Infinity)

  // Chunked transactions: each chunk acquires and releases the write lock independently,
  // so a concurrent MCP write can interleave between chunks instead of stalling for the
  // full-corpus transaction duration. Each chunk is isolated in its own transaction via
  // the StoreAdapter's transaction API (async-compatible: works on both SqliteAdapter
  // and TursoAdapter).
  for (let i = 0; i < episodes.length; i += effectiveChunkSize) {
    const chunk = episodes.slice(i, i + effectiveChunkSize);
    await adapter.transaction(async (tx) => {
      for (const ep of chunk) {
        await processEpisode(tx, ep);
      }
    });
  }

  // ── Step 5: Auto-links (E9) ────────────────────────────────────────────────
  const autoLinkResult = await buildAutoLinks(adapter, entityStoplistThreshold, autoLinkChunkSize);
  result.relates_to_edges = autoLinkResult.edges_inserted;

  return result;
}

/**
 * Resolve cluster threshold from option or default.
 *
 * BL-349/PKT-29: this used to hardcode its own `0.82` independent of
 * cluster.ts's `resolveDefaultThreshold()` — two sources of truth for the
 * same constant, and the ONE this function owns was the one every real
 * `runBatchEnrich` call actually used (clusterStore's own internal default
 * was unreachable dead code, since this always passes an explicit
 * `threshold`). PKT-28's research proved 0.82 is degenerate at the live
 * corpus's current size (largest-cluster ratio 0.759 at N=4867).
 *
 * PKT-30/BL-328: it now returns `undefined` when the caller named no
 * override, and `clusterStore` is called WITHOUT a `threshold` in that case.
 * That is load-bearing, not tidying — `computeClusters` treats an explicit
 * `threshold` as an absolute override and only runs target-mean-degree
 * calibration when none was given, so passing a resolved constant down from
 * here would make the calibration unreachable in production exactly the way
 * BL-420 made `resolveDefaultThreshold()` itself unreachable. Same defect
 * shape, one layer up. The un-calibrated default a caller still gets from
 * `resolveDefaultThreshold()` (0.87) is the calibration FLOOR, so behaviour
 * is unchanged on any corpus small enough not to exceed the degree budget.
 */
function resolveClusterThreshold(override: number | undefined): number | undefined {
  return override;
}
