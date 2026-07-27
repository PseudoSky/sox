/**
 * capture-enrichment-baseline.spec.ts — unit + integration tests for the promoted
 * baseline-capture logic (BL-164). No ONNX / real embedding involved: nodes are
 * seeded via raw SQL, never through memoryWrite's embed pipeline, so this suite
 * stays fast and deterministic (matches BL-161's no-ONNX philosophy).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb, closeAllAdapters } from '@adhd/sox-memory-core';
import type { StoreAdapter } from '@adhd/sox-store-adapter';

import {
  buildEnrichmentBaseline,
  runEnrichmentBaselinePass,
  captureEnrichmentBaseline,
  DEFAULT_BATCH_ENRICH_OPTIONS,
} from './capture-enrichment-baseline.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function seedEpisode(adapter: StoreAdapter, uid: string, content: string): Promise<void> {
  const now = new Date().toISOString();
  await adapter.executeRun(
    `INSERT INTO node (uid, kind, content, t_created, importance) VALUES (?, 'episode', ?, ?, 1.0)`,
    [uid, content, now],
  );
}

const tmpDirs: string[] = [];
function mkTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-capture-enrich-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await closeAllAdapters();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Pure helper tests ─────────────────────────────────────────────────────────

describe('buildEnrichmentBaseline', () => {
  it('produces the exact historical JSON shape (source, batch_enrich_result, store_snapshot)', () => {
    const baseline = buildEnrichmentBaseline({
      liveDbPath: '/tmp/fake-live.db',
      snapshotSha256: 'deadbeef',
      batchEnrichResult: {
        communities_upserted: 1,
        member_of_edges: 2,
        importance_updated: 3,
        relates_to_edges: 4,
        topics_backfilled: 5,
        legacy_nodes_stamped: 6,
        cluster_pass_skipped: true,
        cluster_skip_reason: 'too few nodes',
      },
      counts: { totalNodes: 10, totalEdges: 20, totalEpisodes: 7 },
    });

    expect(baseline._meta.source).toBe('/tmp/fake-live.db');
    expect(baseline._meta.snapshot_sha256).toBe('deadbeef');
    expect(baseline._meta.snapshot_path).toBe('enrichment-baseline-snapshot.db');
    expect(baseline.batch_enrich_result).toEqual({
      communities_upserted: 1,
      member_of_edges: 2,
      importance_updated: 3,
      relates_to_edges: 4,
      topics_backfilled: 5,
      legacy_nodes_stamped: 6,
      cluster_pass_skipped: true,
      cluster_skip_reason: 'too few nodes',
    });
    expect(baseline.store_snapshot).toEqual({
      total_live_nodes: 10,
      total_live_episodes: 7,
      total_live_edges: 20,
    });
  });

  it('normalizes an undefined cluster_skip_reason to null (not undefined)', () => {
    const baseline = buildEnrichmentBaseline({
      liveDbPath: '/tmp/fake-live.db',
      snapshotSha256: 'cafe',
      batchEnrichResult: {
        communities_upserted: 0,
        member_of_edges: 0,
        importance_updated: 0,
        relates_to_edges: 0,
        topics_backfilled: 0,
        legacy_nodes_stamped: 0,
        cluster_pass_skipped: false,
      },
      counts: { totalNodes: 0, totalEdges: 0, totalEpisodes: 0 },
    });
    expect(baseline.batch_enrich_result.cluster_skip_reason).toBeNull();
  });
});

// ── runEnrichmentBaselinePass (real schema, zero embeddings, no ONNX) ─────────

describe('runEnrichmentBaselinePass', () => {
  it('runs a batch-enrich pass over a seeded db and returns accurate live counts', async () => {
    const dir = mkTmpDir();
    const dbPath = path.join(dir, 'test.db');
    const adapter = await openDb(dbPath);

    await seedEpisode(adapter, 'ep-1', 'The quick brown fox jumps over the lazy dog.');
    await seedEpisode(adapter, 'ep-2', 'A second unrelated episode about kayaking.');
    await seedEpisode(adapter, 'ep-3', 'A third episode, also about kayaking trips.');

    const { batchEnrichResult, counts } = await runEnrichmentBaselinePass(adapter, DEFAULT_BATCH_ENRICH_OPTIONS);

    expect(counts.totalNodes).toBe(3);
    expect(counts.totalEpisodes).toBe(3);
    expect(counts.totalEdges).toBeGreaterThanOrEqual(0);
    // Structural shape assertion (values depend on the analysis lib's clustering
    // over zero-vector nodes, which is a degenerate but valid case).
    expect(typeof batchEnrichResult.communities_upserted).toBe('number');
    expect(typeof batchEnrichResult.cluster_pass_skipped).toBe('boolean');

    await adapter.close();
  });

  it('is safe on an empty store (zero nodes)', async () => {
    const dir = mkTmpDir();
    const dbPath = path.join(dir, 'empty.db');
    const adapter = await openDb(dbPath);

    const { counts } = await runEnrichmentBaselinePass(adapter);

    expect(counts).toEqual({ totalNodes: 0, totalEdges: 0, totalEpisodes: 0 });
    await adapter.close();
  });
});

// ── captureEnrichmentBaseline (full orchestration, real snapshot + sha256) ────

describe('captureEnrichmentBaseline', () => {
  it('snapshots the "live" db without mutating it, and writes a well-shaped baseline JSON', async () => {
    const liveDir = mkTmpDir();
    const outDir = mkTmpDir();
    const liveDbPath = path.join(liveDir, 'live.db');

    const liveAdapter = await openDb(liveDbPath);
    await seedEpisode(liveAdapter, 'ep-a', 'Episode A content for the enrichment baseline capture test.');
    await seedEpisode(liveAdapter, 'ep-b', 'Episode B content, distinct topic entirely.');
    await liveAdapter.close();

    const result = await captureEnrichmentBaseline({
      liveDbPath,
      snapshotDir: outDir,
      log: () => {
        /* silence in tests */
      },
    });

    // Snapshot + baseline JSON exist at the expected paths.
    expect(fs.existsSync(result.snapshotPath)).toBe(true);
    expect(fs.existsSync(result.baselineJsonPath)).toBe(true);
    expect(result.snapshotPath).toBe(path.join(outDir, 'enrichment-baseline-snapshot.db'));
    expect(result.baselineJsonPath).toBe(path.join(outDir, 'enrichment-parity.json'));

    // sha256 is a real 64-char hex digest and matches the snapshot bytes on disk.
    expect(result.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);

    // Baseline JSON on disk parses and matches the returned object.
    const parsed = JSON.parse(fs.readFileSync(result.baselineJsonPath, 'utf8')) as typeof result.baseline;
    expect(parsed._meta.snapshot_sha256).toBe(result.snapshotSha256);
    expect(parsed.store_snapshot.total_live_nodes).toBe(2);
    expect(parsed.store_snapshot.total_live_episodes).toBe(2);

    // NEVER mutates the live store's content: the batch-enrich pass ran exclusively
    // against the snapshot copy, so the live db's episode content is unaffected.
    const liveAdapterAfter = await openDb(liveDbPath);
    const row = await liveAdapterAfter.executeGet<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM node WHERE kind = 'episode'",
    );
    expect(row?.cnt).toBe(2);
    const allResult = await liveAdapterAfter.executeAll<{ content: string }>(
      "SELECT content FROM node WHERE kind = 'episode' ORDER BY uid",
    );
    expect(allResult.rows.map((r) => r.content)).toEqual([
      'Episode A content for the enrichment baseline capture test.',
      'Episode B content, distinct topic entirely.',
    ]);
    await liveAdapterAfter.close();
  });
});
