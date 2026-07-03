/**
 * memoryGetStats — aggregate enrichment coverage and cluster quality statistics.
 *
 * Composes clusterStats(), getEmbedHealth(), and embed subsystem queries.
 *
 * [inv:no-mcp] — returns a plain result object, never an MCP ToolResult.
 */

import type Database from 'better-sqlite3';
import * as fs from 'node:fs';
import { ENRICH_VERSION } from './enrich-version.js';
import { clusterStats } from './cluster.js';
import type { ClusterStats } from './cluster.js';
import { getActiveEmbedModel, getEmbedState, getLastEmbedError } from './embed.js';
import { WriteQueue } from './write-queue.js';

export interface StatsResult {
  tools: string[];
  enrich_version: string;
  embed_model: string;
  embed_backend_configured: string;
  embed_state: string;
  embed_on_hash_fallback: boolean;
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
}

export async function memoryGetStats(
  db: Database.Database,
  args: Record<string, unknown>,
  toolNames: string[],
): Promise<StatsResult> {
  const projectPath = args['project_path'] as string | undefined;

  const ppFilter = projectPath ? 'AND project_path = ?' : '';
  const ppParams = projectPath ? [projectPath] : [];

  const totalRow = db
    .prepare<unknown[], { cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL ${ppFilter}`,
    )
    .get(...ppParams);
  const totalEpisodes = totalRow?.cnt ?? 0;

  const withTopicRow = db
    .prepare<unknown[], { cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL AND topic IS NOT NULL ${ppFilter}`,
    )
    .get(...ppParams);

  const withSummaryRow = db
    .prepare<unknown[], { cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL AND summary IS NOT NULL ${ppFilter}`,
    )
    .get(...ppParams);

  const withTagsRow = db
    .prepare<unknown[], { cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL AND tags IS NOT NULL ${ppFilter}`,
    )
    .get(...ppParams);

  const withProjectPathRow = db
    .prepare<unknown[], { cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL AND project_path IS NOT NULL ${ppFilter}`,
    )
    .get(...ppParams);

  // with_community: episodes with a MEMBER_OF edge to a live GLOBAL community
  const withCommunityRow = db
    .prepare<unknown[], { cnt: number }>(
      `SELECT COUNT(DISTINCT n.rowid) AS cnt
       FROM node n
       JOIN edge e ON e.src = n.rowid AND e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
       JOIN node c ON c.rowid = e.dst AND c.kind = 'community' AND c.t_invalid IS NULL
         AND (json_extract(c.meta, '$.cluster_scope.kind') IS NULL
              OR json_extract(c.meta, '$.cluster_scope.kind') = 'global')
       WHERE n.kind = 'episode' AND n.t_invalid IS NULL ${ppFilter.replace('AND project_path', 'AND n.project_path')}`,
    )
    .get(...ppParams);

  // Legacy: enrich_ver IS NULL or note = "legacy"
  const legacyRow = db
    .prepare<unknown[], { cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM node
       WHERE kind = 'episode' AND t_invalid IS NULL
         AND (enrich_ver IS NULL
           OR json_extract(enrich_ver, '$.note') = 'legacy')
       ${ppFilter}`,
    )
    .get(...ppParams);

  // Stale: enrich_ver.pass != current ENRICH_VERSION
  const staleRow = db
    .prepare<unknown[], { cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM node
       WHERE kind = 'episode' AND t_invalid IS NULL AND enrich_ver IS NOT NULL
         AND json_extract(enrich_ver, '$.pass') != ?
       ${ppFilter}`,
    )
    .get(ENRICH_VERSION, ...ppParams);

  const qStats = clusterStats(db);

  // Embed health
  const resolvedEmbedModel = getActiveEmbedModel();
  const configuredBackend = process.env['SOX_EMBED_BACKEND'] ?? 'auto';
  const resolvedEmbedState = getEmbedState();
  const onHashFallback = configuredBackend !== 'hash' && resolvedEmbedState === 'hash';

  // Degraded record count
  let degradedRecordCount = 0;
  try {
    const scopeModel = db
      .prepare<[], { embed_model: string }>(`SELECT embed_model FROM memory_scope LIMIT 1`)
      .get();
    if (scopeModel && scopeModel.embed_model !== resolvedEmbedModel) {
      degradedRecordCount =
        db
          .prepare<[], { cnt: number }>(
            `SELECT COUNT(*) as cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL`,
          )
          .get()?.cnt ?? 0;
    }
  } catch {
    degradedRecordCount = 0;
  }

  // (WP-5) WAL file bytes + last checkpoint time
  let walBytes = 0;
  try {
    const walPath = db.name + '-wal';
    const st = fs.statSync(walPath, { throwIfNoEntry: false });
    walBytes = st?.size ?? 0;
  } catch {
    walBytes = 0;
  }
  const lastCkptEpoch = WriteQueue.lastCheckpointAtForPath(db.name);
  const lastCheckpointAt = lastCkptEpoch > 0 ? new Date(lastCkptEpoch).toISOString() : null;

  return {
    tools: toolNames,
    enrich_version: ENRICH_VERSION,
    embed_model: resolvedEmbedModel,
    embed_backend_configured: configuredBackend,
    embed_state: resolvedEmbedState,
    embed_on_hash_fallback: onHashFallback,
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
  };
}
