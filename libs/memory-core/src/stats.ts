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

/**
 * (BL-343) Rows whose JSON columns do not parse, and which were therefore
 * excluded from the JSON-dependent aggregates above.
 *
 * This field is the load-bearing half of the BL-343 fix. Making the aggregates
 * skip a malformed row without reporting it would trade a loud failure for a
 * quietly wrong number, which is strictly worse — the counts would silently
 * understate and nothing would ever say so.
 */
export interface MalformedRowStats {
  /** Distinct live episodes with at least one unparseable JSON column. */
  count: number;
  /** Which columns were affected, e.g. `['enrich_ver']`. Empty when count is 0. */
  columns: string[];
  /**
   * Up to 10 offending rowids, so an operator can go straight to the rows.
   * Diagnosing BL-342 required a bespoke `json_valid()` sweep because the raw
   * error named neither the row nor the column; this exists so that never
   * happens again. Capped — `count` is the authoritative total.
   */
  sample_rowids: number[];
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
  /** (BL-343) Rows excluded from the JSON-dependent aggregates because they do not parse. */
  malformed_rows: MalformedRowStats;
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

  // ── BL-343: row-level resilience ────────────────────────────────────────────
  // Every json_extract() below is gated on json_valid(). Without the gate a
  // SINGLE row whose JSON column holds an unparseable value — `''`, the exact
  // shape BL-342's restore wrote — aborts the whole statement with
  // "Parse error: malformed JSON" and takes the entire tool offline.
  //
  // Gating alone is not the fix; the skipped rows must also be counted and
  // reported, or the aggregates just get quietly wrong. See malformedRows below.

  // with_community: episodes with a MEMBER_OF edge to a live GLOBAL community.
  // A community whose meta does not parse has no readable scope, so it is
  // treated exactly like one with no scope recorded: global.
  const withCommunityRow = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(DISTINCT n.rowid) AS cnt
     FROM node n
     JOIN edge e ON e.src = n.rowid AND e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
     JOIN node c ON c.rowid = e.dst AND c.kind = 'community' AND c.t_invalid IS NULL
       AND (c.meta IS NULL
            OR NOT json_valid(c.meta)
            OR json_extract(c.meta, '$.cluster_scope.kind') IS NULL
            OR json_extract(c.meta, '$.cluster_scope.kind') = 'global')
     WHERE n.kind = 'episode' AND n.t_invalid IS NULL ${ppFilter.replace('AND project_path', 'AND n.project_path')}`,
    ppParams.length > 0 ? ppParams : undefined,
  );

  // Legacy: enrich_ver IS NULL or note = "legacy".
  // An unparseable enrich_ver is NOT counted as legacy — we cannot read its
  // note, and guessing would silently inflate the count. It is reported via
  // malformed_rows instead.
  const legacyRow = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM node
     WHERE kind = 'episode' AND t_invalid IS NULL
       AND (enrich_ver IS NULL
         OR (json_valid(enrich_ver) AND json_extract(enrich_ver, '$.note') = 'legacy'))
     ${ppFilter}`,
    ppParams.length > 0 ? ppParams : undefined,
  );

  // Stale: enrich_ver.pass != current ENRICH_VERSION
  const staleRow = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM node
     WHERE kind = 'episode' AND t_invalid IS NULL AND enrich_ver IS NOT NULL
       AND json_valid(enrich_ver)
       AND json_extract(enrich_ver, '$.pass') != ?
     ${ppFilter}`,
    [ENRICH_VERSION, ...ppParams],
  );

  // The report half of BL-343. Counted per column so an operator can see WHICH
  // column is corrupt (the live store's is `enrich_ver`, not `tags` — BL-342
  // named the wrong column), and as distinct rows so `count` is not inflated by
  // a row that is malformed in two columns at once.
  const malformedRow = await adapter.executeGet<{
    bad_tags: number;
    bad_enrich_ver: number;
    bad_meta: number;
    bad_total: number;
  }>(
    `SELECT
       SUM(CASE WHEN tags       IS NOT NULL AND NOT json_valid(tags)       THEN 1 ELSE 0 END) AS bad_tags,
       SUM(CASE WHEN enrich_ver IS NOT NULL AND NOT json_valid(enrich_ver) THEN 1 ELSE 0 END) AS bad_enrich_ver,
       SUM(CASE WHEN meta       IS NOT NULL AND NOT json_valid(meta)       THEN 1 ELSE 0 END) AS bad_meta,
       SUM(CASE WHEN (tags       IS NOT NULL AND NOT json_valid(tags))
                  OR (enrich_ver IS NOT NULL AND NOT json_valid(enrich_ver))
                  OR (meta       IS NOT NULL AND NOT json_valid(meta))
                THEN 1 ELSE 0 END) AS bad_total
     FROM node
     WHERE kind = 'episode' AND t_invalid IS NULL ${ppFilter}`,
    ppParams.length > 0 ? ppParams : undefined,
  );

  const malformedColumns: string[] = [];
  if ((malformedRow?.bad_tags ?? 0) > 0) malformedColumns.push('tags');
  if ((malformedRow?.bad_enrich_ver ?? 0) > 0) malformedColumns.push('enrich_ver');
  if ((malformedRow?.bad_meta ?? 0) > 0) malformedColumns.push('meta');

  const malformedCount = malformedRow?.bad_total ?? 0;
  let malformedSample: number[] = [];
  if (malformedCount > 0) {
    const sampleRows = await adapter.executeAll<{ rowid: number }>(
      `SELECT rowid FROM node
       WHERE kind = 'episode' AND t_invalid IS NULL
         AND ((tags       IS NOT NULL AND NOT json_valid(tags))
           OR (enrich_ver IS NOT NULL AND NOT json_valid(enrich_ver))
           OR (meta       IS NOT NULL AND NOT json_valid(meta)))
         ${ppFilter}
       LIMIT 10`,
      ppParams.length > 0 ? ppParams : undefined,
    );
    malformedSample = sampleRows.rows.map((r) => r.rowid);
  }

  const malformedRows: MalformedRowStats = {
    count: malformedCount,
    columns: malformedColumns,
    sample_rowids: malformedSample,
  };

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
    malformed_rows: malformedRows,
  };
}
