/**
 * store-growth — the `memory_ping` store-growth gauge (BL-c5249cdd).
 *
 * Reports the physical size of a store against the content it holds, plus the
 * persisted count of in-service FTS `OPTIMIZE` passes since the last offline
 * rebuild — the driver of the Turso 0.7.x segment leak (see
 * store-adapter/src/store-rebuild.ts). Alarms on typed, numeric thresholds
 * (`StoreGrowthConfig`, ADR-0013 D3). Read-only: PRAGMA reads, one COUNT, one
 * `_adapter_meta` read through the already-open adapter.
 */
import type { StoreAdapter, StorePageStats } from '@adhd/sox-store-adapter';
import { resolveStoreGrowthConfig, type StoreGrowthConfig } from './config.js';
import { log } from './telemetry.js';

export interface StoreGrowthGauge extends StorePageStats {
  /** `page_count × page_size` — equals `file_bytes` while the WAL is empty. */
  page_bytes: number;
  /** Live nodes (`t_invalid IS NULL`), every kind. */
  live_nodes: number;
  /** `file_bytes / live_nodes`; `null` with no live nodes. */
  bytes_per_live_node: number | null;
  /** In-service OPTIMIZE passes since the last rebuild; `null` = never counted. */
  fts_optimize_passes_since_rebuild: number | null;
  last_rebuild_at: string | null;
  thresholds: {
    bytes_per_live_node: number;
    optimize_passes_since_rebuild: number;
    min_live_nodes: number;
  };
  alarm: boolean;
  alarm_reasons: string[];
  /** The operator action when `alarm` is true. */
  remedy: string | null;
  /** Malformed D3 env tuning values (defaults were used). */
  config_errors: string[];
}

export const STORE_GROWTH_REMEDY =
  'soxe service disable memory-server, then `memory fts-rebuild --dry-run` and `memory fts-rebuild` ' +
  '(offline VACUUM INTO compaction; the pre-swap file is kept as the backup)';

/**
 * Pure alarm evaluation — exported so the thresholds are testable without a store.
 */
export function evaluateStoreGrowthAlarm(
  facts: { bytes_per_live_node: number | null; live_nodes: number; fts_optimize_passes_since_rebuild: number | null },
  config: StoreGrowthConfig,
): string[] {
  const reasons: string[] = [];
  if (
    facts.bytes_per_live_node !== null &&
    facts.live_nodes >= config.minLiveNodes &&
    facts.bytes_per_live_node > config.bytesPerLiveNodeAlarm
  ) {
    reasons.push(
      `bytes_per_live_node ${Math.round(facts.bytes_per_live_node)} > ${config.bytesPerLiveNodeAlarm} ` +
        `(${facts.live_nodes} live nodes)`,
    );
  }
  if (
    facts.fts_optimize_passes_since_rebuild !== null &&
    facts.fts_optimize_passes_since_rebuild > config.optimizePassesSinceRebuildAlarm
  ) {
    reasons.push(
      `fts_optimize_passes_since_rebuild ${facts.fts_optimize_passes_since_rebuild} > ${config.optimizePassesSinceRebuildAlarm}`,
    );
  }
  return reasons;
}

let alarmWarned = new Set<string>();

/** Test seam: forget which stores already warned. */
export function _resetStoreGrowthAlarmWarningsForTest(): void {
  alarmWarned = new Set<string>();
}

/**
 * Read the gauge for `dbPath` through its open `adapter`.
 */
export async function readStoreGrowthGauge(
  adapter: StoreAdapter,
  dbPath: string,
  overrides?: Partial<StoreGrowthConfig>,
): Promise<StoreGrowthGauge> {
  const { readStorePageStats, readStoreGrowthMeta } = await import('@adhd/sox-store-adapter');
  const { config, errors } = resolveStoreGrowthConfig(overrides);
  for (const e of errors) log.warn('store.growth.config_invalid', { db_path: dbPath, error: e });
  const stats = await readStorePageStats(adapter, dbPath);
  const row = await adapter.executeGet<{ n: number }>('SELECT COUNT(*) AS n FROM node WHERE t_invalid IS NULL');
  const liveNodes = Number(row?.n ?? 0);
  const meta = await readStoreGrowthMeta(adapter);
  const bytesPerLiveNode = liveNodes > 0 ? stats.file_bytes / liveNodes : null;
  const reasons = evaluateStoreGrowthAlarm(
    {
      bytes_per_live_node: bytesPerLiveNode,
      live_nodes: liveNodes,
      fts_optimize_passes_since_rebuild: meta.ftsOptimizePassesSinceRebuild,
    },
    config,
  );
  if (reasons.length > 0 && !alarmWarned.has(dbPath)) {
    alarmWarned.add(dbPath);
    log.warn('store.growth.alarm', { db_path: dbPath, reasons: reasons.join('; '), remedy: STORE_GROWTH_REMEDY });
  } else if (reasons.length === 0) {
    alarmWarned.delete(dbPath);
  }
  return {
    ...stats,
    page_bytes: stats.page_count * stats.page_size,
    live_nodes: liveNodes,
    bytes_per_live_node: bytesPerLiveNode === null ? null : Math.round(bytesPerLiveNode),
    fts_optimize_passes_since_rebuild: meta.ftsOptimizePassesSinceRebuild,
    last_rebuild_at: meta.lastRebuildAt,
    thresholds: {
      bytes_per_live_node: config.bytesPerLiveNodeAlarm,
      optimize_passes_since_rebuild: config.optimizePassesSinceRebuildAlarm,
      min_live_nodes: config.minLiveNodes,
    },
    alarm: reasons.length > 0,
    alarm_reasons: reasons,
    remedy: reasons.length > 0 ? STORE_GROWTH_REMEDY : null,
    config_errors: errors,
  };
}
