import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { StoreGraphBackend } from '@adhd/sox-graph-store';
import { SqliteVectorBackend } from '@adhd/sox-vector-store';
import type { VectorBackend } from '@adhd/sox-vector-store';
import type { GraphBackend } from '@adhd/sox-graph-store';
import { createSqliteAdapter } from '@adhd/sox-store-adapter';
import { StoreSearchBackend, rrfFuse, rrfScore, temporalRescore, RRF_K } from './index.js';

// ── Pure functions ───────────────────────────────────────────────────────────

describe('rrfFuse', () => {
  it('fuses weighted reciprocal ranks (Σ w_i/(k+rank_i))', () => {
    const ranked = new Map<string, number[]>([
      ['text', [10]],        // 10 → text rank 1
      ['vec', [20, 10]],     // 20 → vec rank 1, 10 → vec rank 2
    ]);
    const weights = new Map<string, number>([['text', 1], ['vec', 1]]);
    const fused = rrfFuse(ranked, weights);

    const byId = new Map(fused.map((f) => [f.id, f.score]));
    // 10 appears in BOTH signals (text rank 1 + vec rank 2) → higher than 20 (vec rank 1 only).
    expect(byId.get(10)).toBeCloseTo(rrfScore(1) + rrfScore(2), 10);
    expect(byId.get(20)).toBeCloseTo(rrfScore(1), 10);
    expect(byId.get(10)!).toBeGreaterThan(byId.get(20)!);
    // sorted best-first
    expect(fused[0]!.id).toBe(10);
  });

  it('weights scale a signal\'s contribution', () => {
    const ranked = new Map<string, number[]>([
      ['text', [10]],
      ['vec', [20]],
    ]);
    // text weighted 0 → only vec contributes.
    const weights = new Map<string, number>([['text', 0], ['vec', 1]]);
    const fused = rrfFuse(ranked, weights);
    expect(fused.length).toBe(2);
    expect(fused[0]!.id).toBe(20);
    const byId = new Map(fused.map((f) => [f.id, f.score]));
    expect(byId.get(10)).toBe(0);
    expect(byId.get(20)).toBeCloseTo(rrfScore(1), 10);
  });

  it('RRF_K is 60 (matches memory-core)', () => {
    expect(RRF_K).toBe(60);
    expect(rrfScore(1)).toBeCloseTo(1 / 61, 10);
  });
});

describe('temporalRescore', () => {
  const NOW = 1_000_000_000_000;

  it('is monotonic in recency — newer ranks higher, all else equal', () => {
    const results = [
      { id: 1, score: 1.0 }, // old
      { id: 2, score: 1.0 }, // new
    ];
    const recencyMs = new Map<number, number>([
      [1, NOW - 10 * 3_600_000], // 10 hours old
      [2, NOW],                  // just now
    ]);
    const res = temporalRescore(results, recencyMs, 0.1, NOW);
    const byId = new Map(res.map((r) => [r.id, r.score]));
    expect(byId.get(2)!).toBeGreaterThan(byId.get(1)!);
  });

  it('is a no-op when decay is absent or zero', () => {
    const results = [{ id: 1, score: 0.5 }];
    expect(temporalRescore(results, new Map(), undefined)).toEqual(results);
    expect(temporalRescore(results, new Map(), 0)).toEqual(results);
  });

  it('leaves ids with unknown recency unchanged', () => {
    const results = [{ id: 1, score: 1.0 }];
    const res = temporalRescore(results, new Map(), 0.1, NOW);
    expect(res[0]!.score).toBe(1.0);
  });
});

// ── StoreSearchBackend.searchRanked integration ──────────────────────────────

describe('StoreSearchBackend.searchRanked (N-signal)', () => {
  let vec: VectorBackend;
  let graph: GraphBackend;
  let backend: StoreSearchBackend;

  beforeEach(async () => {
    const db = new Database(':memory:');
    sqliteVec.load(db);
    const adapter = createSqliteAdapter(db);
    vec = new SqliteVectorBackend(adapter);
    vec.ensureSpace({ modelId: 'test-model', dim: 4 });
    graph = new StoreGraphBackend(adapter);
    await graph.applySchema();
    backend = new StoreSearchBackend(vec, graph);
  });

  it('fuses text + vec into RRF scores with signalScores present', async () => {
    // Seed two nodes: one text-match, one vec-near.
    const a = await graph.writeNode('alpha beta gamma', { kind: 'generic', topic: 'alpha' });
    const b = await graph.writeNode('completely unrelated', { kind: 'generic', topic: 'beta' });
    vec.upsert(a, new Float32Array([1, 0, 0, 0]), { modelId: 'test-model', dim: 4 });
    vec.upsert(b, new Float32Array([0, 1, 0, 0]), { modelId: 'test-model', dim: 4 });

    const results = await backend.searchRanked(
      { text: 'alpha', vec: new Float32Array([1, 0, 0, 0]), signals: [{ kind: 'text' }, { kind: 'vec' }] },
      10,
    );

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.signalScores).toBeDefined();
    // node a matches both text and vec → must outrank b.
    expect(results[0]!.id).toBe(a);
  });

  it('applies a temporal rescore over the fused candidates without error', async () => {
    const older = await graph.writeNode('shared token', { kind: 'generic', topic: 'shared' });
    const newer = await graph.writeNode('shared token', { kind: 'generic', topic: 'shared' });
    // Same content → same text score, same vec score (both near the query).
    vec.upsert(older, new Float32Array([1, 0, 0, 0]), { modelId: 'test-model', dim: 4 });
    vec.upsert(newer, new Float32Array([1, 0, 0, 0]), { modelId: 'test-model', dim: 4 });

    const results = await backend.searchRanked(
      {
        text: 'shared',
        vec: new Float32Array([1, 0, 0, 0]),
        signals: [{ kind: 'text' }, { kind: 'vec' }],
        rescore: [{ kind: 'temporal', decay: 10 }],
      },
      10,
    );

    const ids = results.map((r) => r.id);
    expect(ids).toContain(older);
    expect(ids).toContain(newer);
  });

  it('a text-only signal set returns text-scored results (distinguishing fused from vec-only)', async () => {
    const a = await graph.writeNode('unique text needle', { kind: 'generic', topic: 'needle' });
    await graph.writeNode('irrelevant', { kind: 'generic', topic: 'noise' });

    const results = await backend.searchRanked(
      { text: 'needle', signals: [{ kind: 'text' }] },
      5,
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.id).toBe(a);
    expect(results[0]!.signalScores?.text).toBeDefined();
    expect(results[0]!.signalScores?.vec).toBeUndefined();
  });
});
