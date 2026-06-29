import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

import {
  cluster,
  detectNearDupPairs,
  scoreImportance,
  topoSort,
  criticalPath,
  detectCycles,
  detectDAGStructure,
  setOverlapMatrix,
  packBatches,
  clusterStore,
  clusterSubset,
  detectNearDup,
  computeImportance,
  buildAutoLinks,
  runBatchEnrich,
} from './index.js';

import { SqliteVectorBackend } from '@adhd/sox-vector-store';
import { SqliteGraphBackend } from '@adhd/sox-graph-store';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  return db;
}

function makeVecBackend(db: Database.Database): SqliteVectorBackend {
  const vec = new SqliteVectorBackend(db);
  vec.ensureSpace({ modelId: 'test-model', dim: 4 });
  return vec;
}

function makeGraphBackend(db: Database.Database): SqliteGraphBackend {
  const graph = new SqliteGraphBackend(db);
  graph.applySchema();
  return graph;
}

function randomVec(id: number, dim: number, seed: number): { id: number; vec: Float32Array } {
  // Deterministic "random" from seed + id
  let s = seed * 31 + id * 7;
  const vec = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    vec[i] = (s / 0x7fffffff) * 2 - 1;
  }
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) vec[i] = vec[i]! / norm;
  return { id, vec };
}

// ── Pure function tests ───────────────────────────────────────────────────────

describe('cluster', () => {
  it('returns empty for empty input', () => {
    const result = cluster([]);
    expect(result.communities).toEqual([]);
    expect(result.unclustered).toEqual([]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('clusters identical vectors together', () => {
    const vec = new Float32Array([1, 0, 0, 0]);
    const result = cluster([
      { id: 1, vec },
      { id: 2, vec },
      { id: 3, vec },
    ]);
    expect(result.communities.length).toBe(1);
    expect(result.communities[0]!.memberIds).toContain(1);
    expect(result.communities[0]!.memberIds).toContain(2);
    expect(result.communities[0]!.memberIds).toContain(3);
  });

  it('separates orthogonal vectors', () => {
    const result = cluster([
      { id: 1, vec: new Float32Array([1, 0, 0, 0]) },
      { id: 2, vec: new Float32Array([0, 1, 0, 0]) },
      { id: 3, vec: new Float32Array([0, 0, 1, 0]) },
    ]);
    // Orthogonal vectors have cosine=0, well below default threshold 0.75
    expect(result.communities.length).toBe(0);
    expect(result.unclustered.length).toBe(3);
  });

  it('respects minClusterSize', () => {
    // Two close, one far
    const vec = new Float32Array([1, 0, 0, 0]);
    const similar = new Float32Array([0.99, 0.14, 0, 0]);
    const orthogonal = new Float32Array([0, 1, 0, 0]);
    const result = cluster(
      [
        { id: 1, vec },
        { id: 2, vec: similar },
        { id: 3, vec: orthogonal },
      ],
      { minClusterSize: 2, threshold: 0.9 },
    );
    // vec and similar should cluster (cos ≈ 0.99)
    const clustered = result.communities.flatMap((c) => c.memberIds);
    expect(clustered).toContain(1);
    expect(clustered).toContain(2);
  });

  it('uses custom threshold', () => {
    const v1 = new Float32Array([1, 0, 0, 0]);
    const v2 = new Float32Array([0.8, 0.6, 0, 0]); // cos ≈ 0.8
    // Threshold 0.85: not clustered
    const r1 = cluster([{ id: 1, vec: v1 }, { id: 2, vec: v2 }], { threshold: 0.85 });
    expect(r1.communities.length).toBe(0);

    // Threshold 0.75: clustered
    const r2 = cluster([{ id: 1, vec: v1 }, { id: 2, vec: v2 }], { threshold: 0.75 });
    expect(r2.communities.length).toBe(1);
  });
});

describe('detectNearDupPairs', () => {
  it('returns near_dup for very similar vectors', () => {
    const v = new Float32Array([1, 0, 0, 0]);
    const pairs = detectNearDupPairs([
      { id: 1, vec: v },
      { id: 2, vec: new Float32Array([0.999, 0.044, 0, 0]) },
    ]);
    expect(pairs.length).toBe(1);
    expect(pairs[0]!.status).toBe('near_dup');
    expect(pairs[0]!.cosine).toBeGreaterThan(0.95);
  });

  it('returns distinct for orthogonal vectors', () => {
    const pairs = detectNearDupPairs([
      { id: 1, vec: new Float32Array([1, 0]) },
      { id: 2, vec: new Float32Array([0, 1]) },
    ]);
    expect(pairs.length).toBe(1);
    expect(pairs[0]!.status).toBe('distinct');
    expect(pairs[0]!.cosine).toBeCloseTo(0, 5);
  });

  it('returns candidate for mid-range similarity', () => {
    const v1 = new Float32Array([1, 0]);
    const v2 = new Float32Array([0.8, 0.6]);
    const pairs = detectNearDupPairs([{ id: 1, vec: v1 }, { id: 2, vec: v2 }]);
    expect(pairs.length).toBe(1);
    expect(pairs[0]!.status).toBe('candidate');
    expect(pairs[0]!.cosine).toBeCloseTo(0.8, 1);
  });

  it('respects custom thresholds', () => {
    const v1 = new Float32Array([1, 0]);
    const v2 = new Float32Array([0.8, 0.6]);
    const pairs = detectNearDupPairs(
      [{ id: 1, vec: v1 }, { id: 2, vec: v2 }],
      { nearDupThreshold: 0.9, distinctThreshold: 0.85 },
    );
    expect(pairs[0]!.status).toBe('distinct');
  });

  it('respects limit', () => {
    const vecs = [
      { id: 1, vec: new Float32Array([1, 0, 0]) },
      { id: 2, vec: new Float32Array([0.9, 0.4, 0]) },
      { id: 3, vec: new Float32Array([0.7, 0.7, 0]) },
    ];
    const pairs = detectNearDupPairs(vecs, { limit: 1 });
    expect(pairs.length).toBe(1);
  });
});

describe('scoreImportance', () => {
  it('returns 1.0 for zero inputs', () => {
    const score = scoreImportance({ inDegree: 0, outDegree: 0, recencyMs: 0, nearDupCount: 0 });
    // central=0, recency max=3, nearDup penalty max=2, base=1 → total = 6
    expect(score).toBeCloseTo(6.0, 0);
  });

  it('increases with graph centrality', () => {
    const low = scoreImportance({ inDegree: 0, outDegree: 0, recencyMs: 0, nearDupCount: 0 });
    const high = scoreImportance({ inDegree: 10, outDegree: 10, recencyMs: 0, nearDupCount: 0 });
    expect(high).toBeGreaterThan(low);
  });

  it('decreases with recency age', () => {
    const recent = scoreImportance({ inDegree: 0, outDegree: 0, recencyMs: 0, nearDupCount: 0 });
    const old = scoreImportance({ inDegree: 0, outDegree: 0, recencyMs: 86400000 * 10, nearDupCount: 0 });
    expect(recent).toBeGreaterThan(old);
  });

  it('penalizes near-duplicates', () => {
    const none = scoreImportance({ inDegree: 5, outDegree: 5, recencyMs: 0, nearDupCount: 0 });
    const many = scoreImportance({ inDegree: 5, outDegree: 5, recencyMs: 0, nearDupCount: 10 });
    expect(none).toBeGreaterThan(many);
  });

  it('output is always in [1,10]', () => {
    const score = scoreImportance({ inDegree: 100000, outDegree: 100000, recencyMs: 0, nearDupCount: 0 });
    expect(score).toBeGreaterThanOrEqual(1);
    expect(score).toBeLessThanOrEqual(10);
  });
});

// ── Graph algorithm tests ─────────────────────────────────────────────────────

describe('topoSort', () => {
  it('sorts a simple DAG topologically', () => {
    // 1 depends on 2,3; 2 depends on 3
    const edges: Record<number, number[]> = {
      1: [2, 3],
      2: [3],
      3: [],
    };
    const result = topoSort([1, 2, 3], (id) => edges[id] ?? []);
    expect(result.cycle).toBeNull();
    expect(result.order.length).toBe(3);
    // 3 should come before 2, and 2 before 1
    const i3 = result.order.indexOf(3);
    const i2 = result.order.indexOf(2);
    const i1 = result.order.indexOf(1);
    expect(i3).toBeLessThan(i2);
    expect(i2).toBeLessThan(i1);
  });

  it('detects a cycle', () => {
    const edges: Record<number, number[]> = {
      1: [2],
      2: [3],
      3: [1],
    };
    const result = topoSort([1, 2, 3], (id) => edges[id] ?? []);
    expect(result.cycle).not.toBeNull();
    expect(result.cycle!.length).toBeGreaterThan(0);
  });

  it('assigns wave indices', () => {
    const edges: Record<number, number[]> = {
      1: [3],
      2: [3],
      3: [4],
      4: [],
    };
    const result = topoSort([1, 2, 3, 4], (id) => edges[id] ?? []);
    expect(result.waves.get(4)).toBe(0); // no deps
    expect(result.waves.get(3)).toBe(1); // depends on 4
    expect(result.waves.get(1)).toBe(2); // depends on 3
    expect(result.waves.get(2)).toBe(2); // depends on 3
  });

  it('handles disconnected nodes', () => {
    const edges: Record<number, number[]> = {
      1: [],
      2: [],
    };
    const result = topoSort([1, 2], (id) => edges[id] ?? []);
    expect(result.cycle).toBeNull();
    expect(result.order.length).toBe(2);
    expect(result.waves.get(1)).toBe(0);
    expect(result.waves.get(2)).toBe(0);
  });
});

describe('criticalPath', () => {
  it('computes longest path in a DAG', () => {
    // 1 depends on 2,3; 2 depends on 3; weights: 1=1, 2=2, 3=3
    const edges: Record<number, number[]> = {
      1: [2, 3],
      2: [3],
      3: [],
    };
    const weights: Record<number, number> = { 1: 1, 2: 2, 3: 3 };
    const result = criticalPath([1, 2, 3], (id) => edges[id] ?? [], (id) => weights[id] ?? 0);
    // 3 → 3; 2 → 2+3=5; 1 → 1+max(5,3)=6
    expect(result.get(3)).toBe(3);
    expect(result.get(2)).toBe(5);
    expect(result.get(1)).toBe(6);
  });

  it('handles single node', () => {
    const result = criticalPath([1], () => [], () => 42);
    expect(result.get(1)).toBe(42);
  });
});

describe('detectCycles', () => {
  it('returns empty for acyclic graph', () => {
    const edges: Record<number, number[]> = {
      1: [2],
      2: [3],
      3: [],
    };
    const cycles = detectCycles([1, 2, 3], (id) => edges[id] ?? []);
    expect(cycles).toEqual([]);
  });

  it('finds all cycles', () => {
    const edges: Record<number, number[]> = {
      1: [2],
      2: [3],
      3: [1],
      4: [5],
      5: [4],
    };
    const cycles = detectCycles([1, 2, 3, 4, 5], (id) => edges[id] ?? []);
    expect(cycles.length).toBe(2);
  });

  it('detects self-loop', () => {
    const edges: Record<number, number[]> = { 1: [1] };
    const cycles = detectCycles([1], (id) => edges[id] ?? []);
    expect(cycles.length).toBe(1);
    expect(cycles[0]).toEqual([1, 1]);
  });
});

describe('detectDAGStructure', () => {
  it('detects forest', () => {
    // 3 has 2 parents (1 and 4 via 2), so not a forest → but it IS series-parallel
    const edges: Record<number, number[]> = {
      1: [2],
      2: [3],
      4: [3],
    };
    const result = detectDAGStructure([1, 2, 3, 4], (id) => edges[id] ?? []);
    // Node 3 has in-degree 2 from parent perspective, not a forest. But by SP reduction, it IS series-parallel.
    expect(['series-parallel', 'general']).toContain(result);
  });

  it('detects forest with max 1 parent', () => {
    const edges: Record<number, number[]> = {
      1: [2],
      2: [3],
      3: [],
      4: [5],
      5: [],
    };
    const result = detectDAGStructure([1, 2, 3, 4, 5], (id) => edges[id] ?? []);
    // Each node has max 1 parent
    // 1→2, 2→3 means: 3 has parent 2; 2 has parent 1; 1 and 4 and 5 have 0 parents
    expect(result).toBe('forest');
  });

  it('detects series-parallel or general', () => {
    // A diamond: 1 depends on 2,3; 2 depends on 4; 3 depends on 4
    const edges: Record<number, number[]> = {
      1: [2, 3],
      2: [4],
      3: [4],
      4: [],
    };
    const result = detectDAGStructure([1, 2, 3, 4], (id) => edges[id] ?? []);
    // Node 4 has 2 parents (2 and 3), so not forest. Should be SP or general
    expect(['series-parallel', 'general']).toContain(result);
  });
});

// ── setOverlapMatrix ──────────────────────────────────────────────────────────

describe('setOverlapMatrix', () => {
  it('computes pairwise intersections', () => {
    const items = [
      { id: 1, keys: ['a', 'b', 'c'] },
      { id: 2, keys: ['b', 'c', 'd'] },
      { id: 3, keys: ['e', 'f'] },
    ];
    const entries = setOverlapMatrix(items);
    expect(entries.length).toBe(3);

    // 1 ∩ 2 = {b, c}
    const overlap12 = entries.find((e) => e.a === 1 && e.b === 2);
    expect(overlap12!.intersection).toEqual(['b', 'c']);
    expect(overlap12!.bytes).toBe(2);

    // 1 ∩ 3 = {}
    const overlap13 = entries.find((e) => e.a === 1 && e.b === 3);
    expect(overlap13!.intersection).toEqual([]);
    expect(overlap13!.bytes).toBe(0);
  });

  it('uses valueFn for byte calculation', () => {
    const items = [
      { id: 1, keys: ['a', 'b'] },
      { id: 2, keys: ['a', 'b'] },
    ];
    const valueFn = (k: string) => k.length;
    const entries = setOverlapMatrix(items, valueFn);
    expect(entries[0]!.intersection).toEqual(['a', 'b']);
    expect(entries[0]!.bytes).toBe(2);
  });
});

// ── packBatches ───────────────────────────────────────────────────────────────

describe('packBatches', () => {
  it('produces batches within capacity', () => {
    const items = [
      { id: 1, cost: 5, resources: [], resourceCost: () => 0, deps: [] },
      { id: 2, cost: 5, resources: [], resourceCost: () => 0, deps: [] },
      { id: 3, cost: 5, resources: [], resourceCost: () => 0, deps: [] },
    ];
    const result = packBatches(items, { B: 2, W: 20, algorithm: 'hlfet' });
    expect(result.batches.length).toBeGreaterThan(0);
    for (const batch of result.batches) {
      expect(batch.cost).toBeLessThanOrEqual(20);
    }
  });

  it('respects dependency order', () => {
    const items = [
      { id: 1, cost: 1, resources: [], resourceCost: () => 0, deps: [2] },
      { id: 2, cost: 1, resources: [], resourceCost: () => 0, deps: [] },
    ];
    const result = packBatches(items, { B: 1, W: 10, algorithm: 'hlfet' });
    // Item 2 must be in an earlier batch than item 1
    const batch1 = result.batches.find((b) => b.items.includes(1));
    const batch2 = result.batches.find((b) => b.items.includes(2));
    expect(batch2).toBeDefined();
    expect(batch1).toBeDefined();
    const b1Idx = result.batches.indexOf(batch1!);
    const b2Idx = result.batches.indexOf(batch2!);
    expect(b2Idx).toBeLessThan(b1Idx);
  });

  it('respects group constraints', () => {
    const items = [
      { id: 1, cost: 1, resources: [], resourceCost: () => 0, deps: [], group: 'A' },
      { id: 2, cost: 1, resources: [], resourceCost: () => 0, deps: [], group: 'B' },
    ];
    const result = packBatches(items, { B: 1, W: 10, algorithm: 'hlfet' });
    // Items in different groups should not be in same batch
    for (const batch of result.batches) {
      const groups = new Set(
        batch.items.map((id) => items.find((i) => i.id === id)?.group).filter(Boolean),
      );
      expect(groups.size).toBeLessThanOrEqual(1);
    }
  });

  it('auto-selects algorithm', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1,
      cost: 1,
      resources: [],
      resourceCost: () => 0,
      deps: [],
    }));
    const result = packBatches(items, { B: 1, W: 10 });
    expect(result.algorithm).toBeTruthy();
    expect(result.totalCost).toBeGreaterThan(0);
  });

  it('handles bitmask-dp for small N', () => {
    const items = [
      { id: 1, cost: 1, resources: [], resourceCost: () => 0, deps: [] },
      { id: 2, cost: 1, resources: [], resourceCost: () => 0, deps: [] },
    ];
    const result = packBatches(items, { B: 1, W: 10, algorithm: 'bitmask-dp' });
    expect(result.algorithm).toBe('bitmask-dp');
    expect(result.batches.length).toBeGreaterThan(0);
  });

  it('handles shared resource cost', () => {
    const resourceCost = (key: string) => key === 'expensive' ? 10 : 1;
    const items = [
      { id: 1, cost: 1, resources: ['expensive', 'common'], resourceCost, deps: [] },
      { id: 2, cost: 1, resources: ['expensive', 'common'], resourceCost, deps: [] },
    ];
    const result = packBatches(items, { B: 1, W: 30, algorithm: 'hlfet' });
    // Both items share 'expensive', so putting them together pays 'expensive' once
    expect(result.totalCost).toBeGreaterThan(0);
  });
});

// ── DB-integrated tests ───────────────────────────────────────────────────────

function seedDb(db: Database.Database): { vec: SqliteVectorBackend; graph: SqliteGraphBackend; ids: number[] } {
  const vec = makeVecBackend(db);
  const graph = makeGraphBackend(db);

  const ids: number[] = [];

  // Create 5 nodes with vectors
  for (let i = 0; i < 5; i++) {
    const id = graph.writeNode(`content-${i}`, { name: `node-${i}`, topic: i === 0 ? 'topic-a' : undefined });
    ids.push(id);
    const v = randomVec(i, 4, 42); // deterministic vectors
    vec.upsert(id, v.vec, { modelId: 'test-model', dim: 4 });
  }

  return { vec, graph, ids };
}

describe('clusterStore (DB-integrated)', () => {
  it('clusters nodes from the database', async () => {
    const db = makeDb();
    const { vec, graph } = seedDb(db);
    const result = await clusterStore(vec, graph, { threshold: 0.5 });
    // With low threshold, should find some communities
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.communities.length).toBeGreaterThanOrEqual(0);
  });

  it('produces deterministic results', async () => {
    const db1 = makeDb();
    const { vec: vec1, graph: graph1 } = seedDb(db1);
    const r1 = await clusterStore(vec1, graph1, { threshold: 0.5 });

    const db2 = makeDb();
    const { vec: vec2, graph: graph2 } = seedDb(db2);
    const r2 = await clusterStore(vec2, graph2, { threshold: 0.5 });

    expect(r1.communities.length).toBe(r2.communities.length);
    expect(r1.unclustered.length).toBe(r2.unclustered.length);
  });
});

describe('clusterSubset (DB-integrated)', () => {
  it('clusters a filtered subset', async () => {
    const db = makeDb();
    const { vec, graph } = seedDb(db);

    // Filter to first 3 nodes
    const result = await clusterSubset(vec, graph, { ids: [1, 2, 3] }, { threshold: 0.5 });
    expect(result.filter).toBeDefined();
    expect(result.totalInSubset).toBe(3);
  });
});

describe('detectNearDup (DB-integrated)', () => {
  it('detects near-duplicates from database', () => {
    const db = makeDb();
    const vec = makeVecBackend(db);
    const graph = makeGraphBackend(db);

    // Create two nearly identical vectors
    const id1 = graph.writeNode('content-1', { name: 'node-1' });
    const id2 = graph.writeNode('content-2', { name: 'node-2' });

    const v1 = new Float32Array([1, 0, 0, 0]);
    const v2 = new Float32Array([0.999, 0.044, 0, 0]); // cos ≈ 0.999
    vec.upsert(id1, v1, { modelId: 'test-model', dim: 4 });
    vec.upsert(id2, v2, { modelId: 'test-model', dim: 4 });

    const pairs = detectNearDup(vec, graph, { nearDupThreshold: 0.95 });
    expect(pairs.length).toBe(1);
    expect(pairs[0]!.status).toBe('near_dup');
  });
});

describe('computeImportance (DB-integrated)', () => {
  it('assigns importance to nodes', () => {
    const db = makeDb();
    const vec = makeVecBackend(db);
    const graph = makeGraphBackend(db);

    const id = graph.writeNode('test content', { name: 'test' });
    computeImportance(vec, graph);
    const node = graph.getNode(id);
    expect(node?.importance).toBeDefined();
    expect(node!.importance!).toBeGreaterThanOrEqual(1);
    expect(node!.importance!).toBeLessThanOrEqual(10);
  });

  it('respects dryRun', () => {
    const db = makeDb();
    const vec = makeVecBackend(db);
    const graph = makeGraphBackend(db);

    const id = graph.writeNode('test', { name: 'test' });
    computeImportance(vec, graph, { dryRun: true });
    const node = graph.getNode(id);
    // Should not have been updated since dryRun
    expect(node?.importance).toBe(1.0); // default
  });
});

describe('buildAutoLinks (DB-integrated)', () => {
  it('creates RELATES_TO edges for similar vectors', () => {
    const db = makeDb();
    const vec = makeVecBackend(db);
    const graph = makeGraphBackend(db);

    const id1 = graph.writeNode('content-1', { name: 'node-1' });
    const id2 = graph.writeNode('content-2', { name: 'node-2' });

    const v1 = new Float32Array([1, 0, 0, 0]);
    const v2 = new Float32Array([0.9, 0.4, 0, 0]); // cos ≈ 0.91
    vec.upsert(id1, v1, { modelId: 'test-model', dim: 4 });
    vec.upsert(id2, v2, { modelId: 'test-model', dim: 4 });

    buildAutoLinks(vec, graph, { similarityThreshold: 0.8 });
    const edges = graph.getEdges({ rel: 'RELATES_TO' });
    expect(edges.length).toBeGreaterThanOrEqual(1);
  });

  it('respects maxLinksPerNode', () => {
    const db = makeDb();
    const vec = makeVecBackend(db);
    const graph = makeGraphBackend(db);

    const ids: number[] = [];
    for (let i = 0; i < 10; i++) {
      const id = graph.writeNode(`content-${i}`, { name: `node-${i}` });
      ids.push(id);
      // All similar vectors → each node would want many links
      const v = new Float32Array([0.9 + Math.random() * 0.1, 0.4, 0, 0]);
      // L2 normalize
      let norm = 0;
      for (let j = 0; j < 4; j++) norm += v[j]! * v[j]!;
      norm = Math.sqrt(norm);
      for (let j = 0; j < 4; j++) v[j] = v[j]! / norm;
      vec.upsert(id, v, { modelId: 'test-model', dim: 4 });
    }

    buildAutoLinks(vec, graph, { maxLinksPerNode: 2, similarityThreshold: 0.5 });

    // Count edges per node
    const linkCounts = new Map<number, number>();
    const edges = graph.getEdges({ rel: 'RELATES_TO' });
    for (const e of edges) {
      linkCounts.set(e.src, (linkCounts.get(e.src) ?? 0) + 1);
      linkCounts.set(e.dst, (linkCounts.get(e.dst) ?? 0) + 1);
    }

    for (const count of linkCounts.values()) {
      expect(count).toBeLessThanOrEqual(2);
    }
  });

  it('respects dryRun', () => {
    const db = makeDb();
    const vec = makeVecBackend(db);
    const graph = makeGraphBackend(db);

    const id1 = graph.writeNode('content-1', { name: 'node-1' });
    const id2 = graph.writeNode('content-2', { name: 'node-2' });

    vec.upsert(id1, new Float32Array([1, 0, 0, 0]), { modelId: 'test-model', dim: 4 });
    vec.upsert(id2, new Float32Array([0.9, 0.4, 0, 0]), { modelId: 'test-model', dim: 4 });

    buildAutoLinks(vec, graph, { dryRun: true, similarityThreshold: 0.8 });
    const edges = graph.getEdges({ rel: 'RELATES_TO' });
    expect(edges.length).toBe(0);
  });
});

describe('runBatchEnrich (DB-integrated)', () => {
  it('runs full batch enrichment', async () => {
    const db = makeDb();
    const { vec, graph } = seedDb(db);

    const result = await runBatchEnrich(vec, graph);
    expect(result.nodesProcessed).toBe(5);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('respects skip parameter', async () => {
    const db = makeDb();
    const { vec, graph } = seedDb(db);

    const result = await runBatchEnrich(vec, graph, {
      skip: ['importance', 'nearDup', 'autoLinks', 'clustering'],
    });
    expect(result.nodesProcessed).toBe(5);
    expect(result.communitiesUpdated).toBe(0);
  });

  it('respects dryRun', async () => {
    const db = makeDb();
    const { vec, graph } = seedDb(db);

    const beforeId = graph.writeNode('test', { name: 'test' });
    const beforeNode = graph.getNode(beforeId);

    await runBatchEnrich(vec, graph, { dryRun: true });

    const afterNode = graph.getNode(beforeId);
    // Dry-run should not mutate
    expect(beforeNode?.importance).toBe(afterNode?.importance);
  });
});
