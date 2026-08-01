/**
 * Capture enrichment-parity baseline (RS-0).
 *
 * Promoted from the loose `scripts/capture-enrichment-baseline.mjs` into this typed,
 * nx-graph-aware `baseline-capture` project (BL-164) — same remediation pattern BL-160
 * used to promote `scripts/reembed-memory.mjs` into `libs/memory-core/src/reembed.ts`.
 * The old .mjs reached into `libs/memory-core/dist/index.js` via a raw relative
 * `require()` from the repo-root `scripts` glob, which had zero typecheck/lint/test
 * coverage. This module imports `@adhd/sox-memory-core` as a normal workspace
 * dependency instead.
 *
 * CONTRACTS §K: copies the live store, runs one full daemon-driven batch pass
 * over the snapshot, and records counters + sha256.
 *
 * NEVER modifies the live store (~/.memory/memory.db) — all mutation happens on a
 * throwaway copy.
 *
 * Usage (unchanged from the original script's invocation surface):
 *   node tools/baseline-capture/dist/capture-enrichment-baseline.js
 *   npx nx run baseline-capture:capture-enrichment-baseline
 */

import { createHash } from 'node:crypto';
import { readFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSqliteAdapter } from '@adhd/sox-store-adapter';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { runBatchEnrich, openDb, type BatchEnrichOptions, type BatchEnrichResult } from '@adhd/sox-memory-core';

// ── Public types ──────────────────────────────────────────────────────────────

export interface CaptureEnrichmentBaselineOptions {
  /** Absolute path to the live store to snapshot. Default: ~/.memory/memory.db. */
  liveDbPath?: string;
  /**
   * Directory the snapshot db + baseline JSON are written into. Default:
   * `<repo root>/docs/plan/runtime-productionization/_shared/baselines` (resolved
   * from process.cwd(), matching the original script's cwd-relative behavior when
   * invoked from the repo root).
   */
  snapshotDir?: string;
  /** Batch-enrich options passed through to runBatchEnrich. */
  batchEnrichOptions?: BatchEnrichOptions;
  /** Structured logger. Defaults to console.log. */
  log?: (...args: unknown[]) => void;
}

export interface EnrichmentBaseline {
  _meta: {
    description: string;
    captured_at: string;
    snapshot_sha256: string;
    snapshot_path: string;
    source: string;
    build: string;
  };
  batch_enrich_result: {
    communities_upserted: number;
    member_of_edges: number;
    importance_updated: number;
    relates_to_edges: number;
    topics_backfilled: number;
    legacy_nodes_stamped: number;
    cluster_pass_skipped: boolean;
    cluster_skip_reason: string | null;
  };
  store_snapshot: {
    total_live_nodes: number;
    total_live_episodes: number;
    total_live_edges: number;
  };
}

export interface EnrichmentPassCounts {
  totalNodes: number;
  totalEdges: number;
  totalEpisodes: number;
}

export interface CaptureEnrichmentBaselineResult {
  snapshotPath: string;
  snapshotSha256: string;
  baselineJsonPath: string;
  batchEnrichResult: BatchEnrichResult;
  counts: EnrichmentPassCounts;
  baseline: EnrichmentBaseline;
}

export const DEFAULT_BATCH_ENRICH_OPTIONS: BatchEnrichOptions = {
  clusterThreshold: 0.82,
  clusterNodeCap: 10000,
  importanceChunkSize: 500,
  entityStoplistThreshold: 0.30,
  incrementalCluster: false,
};

// ── Pure helpers (unit-testable without touching any store) ──────────────────

/**
 * Run one batch-enrich pass over an already-open store and count live nodes/edges/
 * episodes. Pure with respect to I/O beyond the supplied adapter — does not
 * open, close, copy, or checksum anything.
 */
export async function runEnrichmentBaselinePass(
  adapter: StoreAdapter,
  batchEnrichOptions: BatchEnrichOptions = DEFAULT_BATCH_ENRICH_OPTIONS,
): Promise<{ batchEnrichResult: BatchEnrichResult; counts: EnrichmentPassCounts }> {
  const batchEnrichResult = await runBatchEnrich(adapter, batchEnrichOptions);

  const nodeCountRow = await adapter.executeGet<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM node WHERE t_invalid IS NULL',
  );
  const edgeCountRow = await adapter.executeGet<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM edge WHERE t_expired IS NULL',
  );
  const episodeCountRow = await adapter.executeGet<{ cnt: number }>(
    "SELECT COUNT(*) AS cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL",
  );

  return {
    batchEnrichResult,
    counts: {
      totalNodes: nodeCountRow?.cnt ?? 0,
      totalEdges: edgeCountRow?.cnt ?? 0,
      totalEpisodes: episodeCountRow?.cnt ?? 0,
    },
  };
}

/** Build the baseline JSON object (exact shape preserved from the original script). */
export function buildEnrichmentBaseline(params: {
  liveDbPath: string;
  snapshotSha256: string;
  batchEnrichResult: BatchEnrichResult;
  counts: EnrichmentPassCounts;
  build?: string;
}): EnrichmentBaseline {
  const { liveDbPath, snapshotSha256, batchEnrichResult, counts, build } = params;
  return {
    _meta: {
      description: 'Pre-migration enrichment baseline captured by RS-0.',
      captured_at: new Date().toISOString(),
      snapshot_sha256: snapshotSha256,
      snapshot_path: 'enrichment-baseline-snapshot.db',
      source: liveDbPath,
      build: build ?? 'pre-change (memory-core current, before any context 02 migration)',
    },
    batch_enrich_result: {
      communities_upserted: batchEnrichResult.communities_upserted,
      member_of_edges: batchEnrichResult.member_of_edges,
      importance_updated: batchEnrichResult.importance_updated,
      relates_to_edges: batchEnrichResult.relates_to_edges,
      topics_backfilled: batchEnrichResult.topics_backfilled,
      legacy_nodes_stamped: batchEnrichResult.legacy_nodes_stamped,
      cluster_pass_skipped: batchEnrichResult.cluster_pass_skipped,
      cluster_skip_reason: batchEnrichResult.cluster_skip_reason ?? null,
    },
    store_snapshot: {
      total_live_nodes: counts.totalNodes,
      total_live_episodes: counts.totalEpisodes,
      total_live_edges: counts.totalEdges,
    },
  };
}

// ── Orchestration (integration entry point) ───────────────────────────────────

/**
 * Snapshot the live store (WAL-checkpointed copy — never mutates the live DB), run one
 * full batch-enrich pass over the snapshot, and write a baseline JSON capturing the
 * result counters + node/edge/episode totals + snapshot sha256.
 */
export async function captureEnrichmentBaseline(
  opts: CaptureEnrichmentBaselineOptions = {},
): Promise<CaptureEnrichmentBaselineResult> {
  const {
    liveDbPath = join(homedir(), '.memory', 'memory.db'),
    snapshotDir = join(process.cwd(), 'docs/plan/runtime-productionization/_shared/baselines'),
    batchEnrichOptions = DEFAULT_BATCH_ENRICH_OPTIONS,
    log = (...args: unknown[]) => console.log(...args),
  } = opts;

  const snapshotPath = join(snapshotDir, 'enrichment-baseline-snapshot.db');
  const baselineJsonPath = join(snapshotDir, 'enrichment-parity.json');

  // ── Step 1: Create a consistent snapshot ────────────────────────────────────
  log('Step 1: Creating consistent snapshot...');
  {
    const tmpAdapter = createSqliteAdapter({ dbPath: liveDbPath });
    await tmpAdapter.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    await tmpAdapter.close();
    log('  WAL checkpointed on live DB.');
  }

  mkdirSync(snapshotDir, { recursive: true });
  copyFileSync(liveDbPath, snapshotPath);
  log(`  Snapshot copied to: ${snapshotPath}`);

  const snapshotBuf = readFileSync(snapshotPath);
  const snapshotSha256 = createHash('sha256').update(snapshotBuf).digest('hex');
  log(`  Snapshot sha256: ${snapshotSha256}`);

  // ── Step 2: Open snapshot and run batch enrich ──────────────────────────────
  log('Step 2: Running batch enrich...');
  const adapter = await openDb(snapshotPath);

  let batchEnrichResult: BatchEnrichResult;
  let counts: EnrichmentPassCounts;
  try {
    const pass = await runEnrichmentBaselinePass(adapter, batchEnrichOptions);
    batchEnrichResult = pass.batchEnrichResult;
    counts = pass.counts;
    log('  Batch enrich result:', JSON.stringify(batchEnrichResult, null, 2));

    log('Step 3: Counting nodes and edges...');
    log(`  Total live nodes: ${counts.totalNodes}`);
    log(`  Total live edges: ${counts.totalEdges}`);
    log(`  Total live episodes: ${counts.totalEpisodes}`);
  } finally {
    await adapter.close();
  }

  // ── Step 4: Write baseline JSON ──────────────────────────────────────────────
  log('Step 4: Writing baseline JSON...');
  const baseline = buildEnrichmentBaseline({ liveDbPath, snapshotSha256, batchEnrichResult, counts });
  writeFileSync(baselineJsonPath, JSON.stringify(baseline, null, 2) + '\n');
  log(`  Written to: ${baselineJsonPath}`);
  log('Done. Enrichment baseline captured successfully.');

  return { snapshotPath, snapshotSha256, baselineJsonPath, batchEnrichResult, counts, baseline };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

/* c8 ignore start -- exercised via direct node invocation, not unit tests */
if (require.main === module) {
  (async () => {
    try {
      await captureEnrichmentBaseline();
    } catch (err) {
      console.error('[capture-enrichment-baseline] FAILED:', err instanceof Error ? err.stack ?? err.message : err);
      process.exitCode = 1;
    }
  })();
}
/* c8 ignore stop */
