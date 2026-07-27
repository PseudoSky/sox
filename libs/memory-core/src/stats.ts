/**
 * memoryGetStats — aggregate enrichment coverage and cluster quality statistics.
 *
 * Composes clusterStats(), getEmbedHealth(), and embed subsystem queries.
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import * as fs from 'node:fs';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { ENRICH_VERSION } from './enrich-version.js';
import { clusterStats } from './cluster.js';
import type { ClusterStats } from './cluster.js';
import {
  getActiveEmbedModel,
  getConfiguredEmbedBackend,
  getEmbedState,
  getLastEmbedError,
} from './embed.js';
import { WriteQueue } from './write-queue.js';

/**
 * BL-88: per-record embedding provenance counts over live episodes with vectors.
 * Additive field — existing callers do not need to handle it unless they want it.
 */
export interface EmbedProvenanceStats {
  /** Live episodes with embed_model IS NOT NULL (stamped since BL-88). */
  stamped: number;
  /** Live episodes with embed_model IS NULL (pre-BL-88 or not yet embedded). */
  unstamped: number;
  /**
   * Live episodes with a vec_node row and a non-null embed_model that differs
   * from the currently active model. These are re-embeddable via healStaleVectors
   * when SOX_HEAL_STALE_VECTORS=1 is set.
   */
  stale_vector_count: number;
  /** The active embedding model at the time of this stats query. */
  active_model: string;
}

export interface StatsResult {
  tools: string[];
  enrich_version: string;
  embed_model: string;
  embed_backend_configured: string;
  embed_state: string;
  last_embed_error: string | null;
  degraded_record_count: number;
  total_episodes: number;
  with_topic: number;
  with_summary: number;
  with_tags: number;
  with_project_path: number;
  with_community: number;
  legacy_episodes: number;
  stale_episodes: number;
  cluster_count: number;
  largest_cluster_size: number;
  mean_intra_cluster_sim: number;
  coverage: number;
  cluster_quality: ClusterStats;
  /** (WP-5) Size of the WAL file in bytes. 0 if the file does not exist or is unavailable. */
  wal_bytes: number;
  /** (WP-5) ISO timestamp of the last successful WAL checkpoint, or null if never checkpointed. */
  last_checkpoint_at: string | null;
  /** (BL-88) Per-record embedding provenance counts. */
  embed_provenance: EmbedProvenanceStats;
}

export async function memoryGetStats(
  adapter: StoreAdapter,
  args: Record<string, unknown>,
  toolNames: string[],
): Promise<StatsResult> {
  const projectPath = args['project_path'] as string | undefined;
  const dbPath = adapter.config.dbPath ?? '';

  const ppFilter = projectPath ? 'AND project_path = ?' : '';
  const ppParams = projectPath ? [projectPath] : [];

  const totalRow = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL ${ppFilter}`,
    ppParams.length > 0 ? ppParams : undefined,
  );
  const totalEpisodes = totalRow?.cnt ?? 0;

  const withTopicRow = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL AND topic IS NOT NULL ${ppFilter}`,
    ppParams.length > 0 ? ppParams : undefined,
  );

  const withSummaryRow = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL AND summary IS NOT NULL ${ppFilter}`,
    ppParams.length > 0 ? ppParams : undefined,
  );

  const withTagsRow = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL AND tags IS NOT NULL ${ppFilter}`,
    ppParams.length > 0 ? ppParams : undefined,
  );

  const withProjectPathRow = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL AND project_path IS NOT NULL ${ppFilter}`,
    ppParams.length > 0 ? ppParams : undefined,
  );

  // with_community: episodes with a MEMBER_OF edge to a live GLOBAL community
  const withCommunityRow = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(DISTINCT n.rowid) AS cnt
     FROM node n
     JOIN edge e ON e.src = n.rowid AND e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
     JOIN node c ON c.rowid = e.dst AND c.kind = 'community' AND c.t_invalid IS NULL
       AND (json_extract(c.meta, '$.cluster_scope.kind') IS NULL
            OR json_extract(c.meta, '$.cluster_scope.kind') = 'global')
     WHERE n.kind = 'episode' AND n.t_invalid IS NULL ${ppFilter.replace('AND project_path', 'AND n.project_path')}`,
    ppParams.length > 0 ? ppParams : undefined,
  );

  // Legacy: enrich_ver IS NULL or note = "legacy"
  const legacyRow = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM node
     WHERE kind = 'episode' AND t_invalid IS NULL
       AND (enrich_ver IS NULL
         OR json_extract(enrich_ver, '$.note') = 'legacy')
     ${ppFilter}`,
    ppParams.length > 0 ? ppParams : undefined,
  );

  // Stale: enrich_ver.pass != current ENRICH_VERSION
  const staleRow = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM node
     WHERE kind = 'episode' AND t_invalid IS NULL AND enrich_ver IS NOT NULL
       AND json_extract(enrich_ver, '$.pass') != ?
     ${ppFilter}`,
    [ENRICH_VERSION, ...ppParams],
  );

  const qStats = await clusterStats(adapter);

  // BL-88: embed provenance counts (additive field).
  // Counts over ALL live episodes (no project_path filter) — provenance is a
  // store-wide data-integrity signal, not a per-project coverage metric.
  const resolvedEmbedModel = getActiveEmbedModel() ?? 'unknown';

  const stampedRow = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL AND embed_model IS NOT NULL`,
  );
  const unstampedRow = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL AND embed_model IS NULL`,
  );
  const staleVecRow = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt
     FROM node n
     WHERE n.kind = 'episode'
       AND n.t_invalid IS NULL
       AND n.embed_model IS NOT NULL
       AND n.embed_model != ?
       AND EXISTS (SELECT 1 FROM vec_node v WHERE v.node_id = n.rowid)`,
    [resolvedEmbedModel],
  );

  const embedProvenance: EmbedProvenanceStats = {
    stamped: stampedRow?.cnt ?? 0,
    unstamped: unstampedRow?.cnt ?? 0,
    stale_vector_count: staleVecRow?.cnt ?? 0,
    active_model: resolvedEmbedModel,
  };

  // Embed health (resolvedEmbedModel already set above)
  // BL-250: validated against the live union instead of a raw unchecked env read —
  // an unknown SOX_EMBED_BACKEND value throws here rather than being silently reported.
  const configuredBackend = getConfiguredEmbedBackend();
  const resolvedEmbedState = getEmbedState();

  // Degraded record count
  let degradedRecordCount = 0;
  try {
    const scopeModel = await adapter.executeGet<{ embed_model: string }>(
      `SELECT embed_model FROM memory_scope LIMIT 1`,
    );
    if (scopeModel && scopeModel.embed_model !== resolvedEmbedModel) {
      degradedRecordCount =
        (await adapter.executeGet<{ cnt: number }>(
          `SELECT COUNT(*) as cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL`,
        ))?.cnt ?? 0;
    }
  } catch {
    degradedRecordCount = 0;
  }

  // (WP-5) WAL file bytes + last checkpoint time
  let walBytes = 0;
  try {
    if (dbPath) {
      const walPath = dbPath + '-wal';
      const st = fs.statSync(walPath, { throwIfNoEntry: false });
      walBytes = st?.size ?? 0;
    }
  } catch {
    walBytes = 0;
  }
  const lastCkptEpoch = WriteQueue.lastCheckpointAtForPath(dbPath);
  const lastCheckpointAt = lastCkptEpoch > 0 ? new Date(lastCkptEpoch).toISOString() : null;

  return {
    tools: toolNames,
    enrich_version: ENRICH_VERSION,
    embed_model: resolvedEmbedModel,
    embed_backend_configured: configuredBackend,
    embed_state: resolvedEmbedState,
    last_embed_error: getLastEmbedError(),
    degraded_record_count: degradedRecordCount,
    total_episodes: totalEpisodes,
    with_topic: withTopicRow?.cnt ?? 0,
    with_summary: withSummaryRow?.cnt ?? 0,
    with_tags: withTagsRow?.cnt ?? 0,
    with_project_path: withProjectPathRow?.cnt ?? 0,
    with_community: withCommunityRow?.cnt ?? 0,
    legacy_episodes: legacyRow?.cnt ?? 0,
    stale_episodes: staleRow?.cnt ?? 0,
    cluster_count: qStats.cluster_count,
    largest_cluster_size: qStats.largest_cluster_size,
    mean_intra_cluster_sim: qStats.mean_intra_sim,
    coverage: qStats.coverage,
    cluster_quality: qStats,
    wal_bytes: walBytes,
    last_checkpoint_at: lastCheckpointAt,
    embed_provenance: embedProvenance,
  };
}
