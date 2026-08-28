import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalize,
  fuse,
  search,
  StoreSearchBackend,
} from './index.js';
import type {
  SearchBackend,
  SearchQuery,
} from './index.js';
import { buildFilterClause } from './filter-utils.js';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { StoreGraphBackend } from '@adhd/sox-graph-store';
import { SqliteVectorBackend } from '@adhd/sox-vector-store';
import type { VectorBackend } from '@adhd/sox-vector-store';
import type { GraphBackend } from '@adhd/sox-graph-store';
import { createSqliteAdapter } from '@adhd/sox-store-adapter';

// ── Mock SearchBackend for testing ─────────────────────────────────────────────

interface MockCandidate {
  id: number;
  textScore?: number;
  vecScore?: number;
  fields: Record<string, unknown>;
}

class MockSearchBackend implements SearchBackend {
  private candidates: MockCandidate[];

  constructor(candidates: MockCandidate[]) {
    this.candidates = candidates;
  }

  async search(
    _query: SearchQuery,
    _limit: number,
  ): Promise<Array<{
    id: number;
    textScore?: number;
    vecScore?: number;
    fields: Record<string, unknown>;
  }>> {
    return this.candidates;
  }
}

// ── normalize ─────────────────────────────────────────────────────────────────

describe('normalize', () => {
  describe('min_max', () => {
    it('normalizes values to [0, 1]', () => {
      const result = normalize([1, 2, 3, 4, 5], 'min_max');
      expect(result).toEqual([0, 0.25, 0.5, 0.75, 1]);
    });

    it('returns 1.0 for all when all scores are the same', () => {
      const result = normalize([7, 7, 7], 'min_max');
      expect(result).toEqual([1.0, 1.0, 1.0]);
    });

    it('handles negative scores', () => {
      const result = normalize([-5, 0, 5], 'min_max');
      expect(result).toEqual([0, 0.5, 1]);
    });

    it('handles single element', () => {
      const result = normalize([42], 'min_max');
      expect(result).toEqual([1.0]);
    });

    it('handles empty array', () => {
      const result = normalize([], 'min_max');
      expect(result).toEqual([]);
    });
  });

  describe('L2', () => {
    it('normalizes by Euclidean norm', () => {
      const result = normalize([3, 4], 'L2');
      expect(result[0]).toBeCloseTo(0.6, 5);
      expect(result[1]).toBeCloseTo(0.8, 5);
    });

    it('returns zeros when all scores are zero', () => {
      const result = normalize([0, 0, 0], 'L2');
      expect(result).toEqual([0, 0, 0]);
    });

    it('handles single element', () => {
      const result = normalize([5], 'L2');
      expect(result).toEqual([1.0]);
    });

    it('handles empty array', () => {
      const result = normalize([], 'L2');
      expect(result).toEqual([]);
    });

    it('handles large values', () => {
      const result = normalize([100, 100], 'L2');
      expect(result[0]).toBeCloseTo(0.7071, 3);
      expect(result[1]).toBeCloseTo(0.7071, 3);
    });
  });

  describe('z_score', () => {
    it('standardizes values', () => {
      const result = normalize([1, 2, 3, 4, 5], 'z_score');
      const avg = 3;
      const sd = Math.sqrt(2.5);
      expect(result[0]).toBeCloseTo((1 - avg) / sd, 5);
      expect(result[1]).toBeCloseTo((2 - avg) / sd, 5);
      expect(result[2]).toBeCloseTo((3 - avg) / sd, 5);
      expect(result[3]).toBeCloseTo((4 - avg) / sd, 5);
      expect(result[4]).toBeCloseTo((5 - avg) / sd, 5);
    });

    it('returns 0.0 when stddev is zero', () => {
      const result = normalize([5, 5, 5], 'z_score');
      expect(result).toEqual([0.0, 0.0, 0.0]);
    });

    it('handles single element', () => {
      const result = normalize([42], 'z_score');
      expect(result).toEqual([0.0]);
    });

    it('handles empty array', () => {
      const result = normalize([], 'z_score');
      expect(result).toEqual([]);
    });

    it('handles two elements', () => {
      const result = normalize([0, 10], 'z_score');
      expect(result[0]).toBeCloseTo(-0.7071, 3);
      expect(result[1]).toBeCloseTo(0.7071, 3);
    });
  });
});

// ── fuse ──────────────────────────────────────────────────────────────────────

describe('fuse', () => {
  const candidates = [
    { id: 1, textScore: 0.9, vecScore: 0.8 },
    { id: 2, textScore: 0.5, vecScore: 0.9 },
    { id: 3, textScore: 0.1, vecScore: 0.2 },
  ];

  it('combines text + vec scores with default weights', () => {
    const results = fuse(candidates);
    expect(results).toHaveLength(3);
    expect(results[0]!.id).toBeDefined();
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it('sorts by fused score descending', () => {
    const results = fuse(candidates);
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.score).toBeLessThanOrEqual(results[i - 1]!.score);
    }
  });

  it('degrades to text-only when vec absent on all candidates', () => {
    const textOnly = [
      { id: 1, textScore: 0.9 },
      { id: 2, textScore: 0.5 },
      { id: 3, textScore: 0.1 },
    ];
    const results = fuse(textOnly);
    expect(results).toHaveLength(3);
    expect(results[0]!.id).toBe(1);
  });

  it('degrades to vec-only when text absent on all candidates', () => {
    const vecOnly = [
      { id: 1, vecScore: 0.8 },
      { id: 2, vecScore: 0.9 },
      { id: 3, vecScore: 0.2 },
    ];
    const results = fuse(vecOnly);
    expect(results).toHaveLength(3);
    expect(results[0]!.id).toBe(2);
  });

  it('handles empty candidates', () => {
    const results = fuse([]);
    expect(results).toEqual([]);
  });

  it('applies custom weights', () => {
    const results = fuse(candidates, {
      weights: { text: 2.0, vec: 0.5 },
    });
    expect(results).toHaveLength(3);
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it('applies custom normalizer', () => {
    const results = fuse(candidates, { normalizer: 'z_score' });
    expect(results).toHaveLength(3);
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it('handles single candidate', () => {
    const results = fuse([{ id: 1, textScore: 0.5, vecScore: 0.3 }]);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(1);
  });

  it('handles mix of signals (some text-only, some vec-only)', () => {
    const mixed = [
      { id: 1, textScore: 0.9 },
      { id: 2, vecScore: 0.8 },
      { id: 3, textScore: 0.5, vecScore: 0.6 },
    ];
    const results = fuse(mixed);
    expect(results).toHaveLength(3);
  });
});

// ── search() with mock backend ────────────────────────────────────────────────

describe('search() with mock backend', () => {
  const mockCandidates = [
    {
      id: 1,
      textScore: 0.95,
      vecScore: 0.85,
      fields: { topic: 'python', content: 'Python async guide' },
    },
    {
      id: 2,
      textScore: 0.8,
      vecScore: 0.92,
      fields: { topic: 'rust', content: 'Rust ownership' },
    },
    {
      id: 3,
      textScore: 0.3,
      vecScore: 0.4,
      fields: { topic: 'typescript', content: 'TS generics' },
    },
  ];

  it('returns SearchResult[] with scores', async () => {
    const backend = new MockSearchBackend(mockCandidates);
    const results = await search(
      backend,
      { text: 'python', vec: new Float32Array([0.1, 0.2]) },
    );
    expect(results).toHaveLength(mockCandidates.length);
    expect(results[0]!.score).toBeGreaterThan(0);
    expect(results[0]!.id).toBeDefined();
    expect(results[0]!.fields).toBeDefined();
  });

  it('with explain: true returns signalScores', async () => {
    const backend = new MockSearchBackend(mockCandidates);
    const results = await search(
      backend,
      { text: 'python', vec: new Float32Array([0.1, 0.2]) },
      { explain: true },
    );
    expect(results).toHaveLength(mockCandidates.length);
    for (const r of results) {
      expect(r.signalScores).toBeDefined();
    }
    expect(results[0]!.signalScores!.text).toBe(0.95);
    expect(results[0]!.signalScores!.vec).toBe(0.85);
  });

  it('degrades to text-only when vec is absent', async () => {
    const backend = new MockSearchBackend(mockCandidates);
    const results = await search(
      backend,
      { text: 'python' },
    );
    expect(results.length).toBeGreaterThan(0);
  });

  it('degrades to vec-only when text is absent', async () => {
    const backend = new MockSearchBackend(mockCandidates);
    const results = await search(
      backend,
      { vec: new Float32Array([0.1, 0.2]) },
    );
    expect(results.length).toBeGreaterThan(0);
  });

  it('handles neither text nor vec gracefully', async () => {
    const backend = new MockSearchBackend(mockCandidates);
    const results = await search(backend, {});
    expect(results.length).toBeGreaterThan(0);
  });

  // ── topic boost ────────────────────────────────────────────────────────────
  // topicBoost() is applied by THIS function (fusion), never by
  // StoreSearchBackend.search(). Until now nothing tested it: the only test bearing
  // its name called the backend, which has no boost code in it at all.
  //
  // Three candidates, not two, on purpose. Under min_max the lowest candidate
  // normalises to exactly 0, and the boost is MULTIPLICATIVE — so in any 2-candidate
  // set the loser is pinned at 0 and no boost can ever move it. A 2-candidate fixture
  // would therefore assert a reordering that cannot happen regardless of the boost.
  it('topic boost on an exact topic match reorders results above a higher-scoring candidate', async () => {
    const backend = new MockSearchBackend([
      { id: 1, textScore: 1.0, fields: { content: 'a', topic: 'unrelated-high' } },
      { id: 2, textScore: 0.8, fields: { content: 'b', topic: 'python' } },
      { id: 3, textScore: 0.0, fields: { content: 'c', topic: 'unrelated-low' } },
    ]);

    // Control: with a query text that matches NO topic, every boost is 1.0 and the
    // raw score order stands. This is what makes the experiment below attributable.
    const unboosted = await search(backend, { text: 'zzz-matches-no-topic' });
    expect(unboosted.map((r) => r.id)).toEqual([1, 2, 3]);

    // Experiment: query text === node 2's topic -> 2.0x, which must lift it past
    // node 1 (0.8 * 2.0 = 1.6 > 1.0 * 1.0).
    const boosted = await search(backend, { text: 'python' });
    expect(boosted.map((r) => r.id)).toEqual([2, 1, 3]);
    expect(boosted[0]!.score).toBeCloseTo(1.6, 5);
  });

  it('topic boost is 1.5x for a substring topic match and 1.0x for no match', async () => {
    const backend = new MockSearchBackend([
      { id: 1, textScore: 1.0, fields: { content: 'a', topic: 'python-async' } },
      { id: 2, textScore: 0.5, fields: { content: 'b', topic: 'rust' } },
      { id: 3, textScore: 0.0, fields: { content: 'c', topic: 'go' } },
    ]);
    const results = await search(backend, { text: 'python' });
    const byId = new Map(results.map((r) => [r.id, r.score]));
    // id 1 normalises to 1.0 and its topic CONTAINS the query -> 1.5x.
    expect(byId.get(1)).toBeCloseTo(1.5, 5);
    // id 2 normalises to 0.5 and its topic does not match at all -> unchanged.
    expect(byId.get(2)).toBeCloseTo(0.5, 5);
  });

  // BL-437 (FIXED). search() now floors the normalised fused score at
  // TOPIC_BOOST_FLOOR (0.1) before applying the multiplicative topic boost, so a
  // candidate that min_max maps to exactly 0 is no longer structurally un-boostable.
  //
  // A genuine 2-candidate race is still a hard case by construction: the winner
  // always normalises to exactly 1.0, so overtaking it would require
  // TOPIC_BOOST_FLOOR > 0.5 — deliberately rejected (see the A/B note on
  // TOPIC_BOOST_FLOOR in index.ts) as far too aggressive a floor for every query.
  // This test therefore keeps asserting the order is unchanged for a 2-candidate
  // set, but proves the underlying defect (score pinned to LITERAL zero, boost
  // provably inert) is fixed: the floor candidate's score is now nonzero and
  // reflects the boost actually engaging.
  it('BL-437: an exact topic match on the LOWEST-scoring candidate is no longer pinned to a literal-zero floor', async () => {
    const backend = new MockSearchBackend([
      { id: 1, textScore: 1.0, fields: { content: 'a', topic: 'unrelated' } },
      { id: 2, textScore: 0.2, fields: { content: 'b', topic: 'python' } },
    ]);
    const results = await search(backend, { text: 'python' });
    const byId = new Map(results.map((r) => [r.id, r.score]));
    // floor(0, 0.1) * 2.0x boost === 0.2 — the boost now actually engages,
    // where before it was mathematically inert (0 * 2.0 === 0).
    expect(byId.get(2)).toBeCloseTo(0.2, 5);
    expect(byId.get(2)).not.toBe(0);
    // A genuine 2-candidate set still can't flip — the winner is always exactly
    // 1.0 under min_max with 2 points, a structural property, not the bug.
    expect(results.map((r) => r.id)).toEqual([1, 2]);
  });

  // BL-437 continued: prove the fix isn't merely cosmetic (score != 0) but
  // functionally moves rankings in the common multi-candidate case where the floor
  // candidate's boosted score can clear a close higher-ranked neighbor.
  it('BL-437: the floor is high enough for an exact topic match to overtake a close neighbor in a larger set', async () => {
    const backend = new MockSearchBackend([
      { id: 1, textScore: 1.0, fields: { content: 'a', topic: 'x' } },
      { id: 2, textScore: 0.9, fields: { content: 'b', topic: 'x' } },
      { id: 3, textScore: 0.8, fields: { content: 'c', topic: 'x' } },
      { id: 4, textScore: 0.71, fields: { content: 'd', topic: 'x' } },
      { id: 5, textScore: 0.70, fields: { content: 'e', topic: 'python' } },
    ]);
    const results = await search(backend, { text: 'python' });
    // id 5 is both the lowest raw scorer AND the exact topic match:
    // floor(0, 0.1) * 2.0 = 0.2, which clears id 4's norm score of
    // (0.71 - 0.70) / (1.0 - 0.70) = 0.0333... — a real reorder, not just a
    // nonzero score.
    expect(results.map((r) => r.id)).toEqual([1, 2, 3, 5, 4]);
    const byId = new Map(results.map((r) => [r.id, r.score]));
    expect(byId.get(5)).toBeCloseTo(0.2, 5);
    expect(byId.get(4)).toBeCloseTo(0.0333, 3);
  });

  it('respects limit option', async () => {
    // Deterministic scores, not Math.random(): a random fixture under a hard-cap
    // assertion is how a real cap violation gets written off as flake.
    const largeList = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      textScore: (50 - i) / 50,
      vecScore: (i + 1) / 50,
      fields: { content: `item ${i}` },
    }));
    const backend = new MockSearchBackend(largeList);
    const results = await search(
      backend,
      { text: 'test', vec: new Float32Array([0.1, 0.2]) },
      { limit: 10 },
    );
    expect(results).toHaveLength(10);
  });

  it('defaults limit to 20', async () => {
    // Deterministic scores, not Math.random() — see 'respects limit option'.
    const largeList = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      textScore: (50 - i) / 50,
      fields: { content: `item ${i}` },
    }));
    const backend = new MockSearchBackend(largeList);
    const results = await search(backend, { text: 'test' });
    // `toBeLessThanOrEqual(20)` was satisfied by a default of 1, and by zero results.
    // 50 candidates are supplied, so the default is observable EXACTLY.
    expect(results).toHaveLength(20);
  });

  it('respects normalizer option', async () => {
    const backend = new MockSearchBackend(mockCandidates);
    const resultsMinMax = await search(
      backend,
      { text: 'test', vec: new Float32Array([0.1, 0.2]) },
      { normalizer: 'min_max' },
    );
    const resultsZ = await search(
      backend,
      { text: 'test', vec: new Float32Array([0.1, 0.2]) },
      { normalizer: 'z_score' },
    );
    expect(resultsMinMax[0]!.score).toBeGreaterThan(0);
    expect(resultsZ[0]!.score).toBeGreaterThan(0);
  });
});

// ── buildFilterClause ─────────────────────────────────────────────────────────

describe('buildFilterClause', () => {
  it('handles topic as string', () => {
    const result = buildFilterClause({ topic: 'python' });
    expect(result.nodeFilter.topic).toBe('python');
  });

  it('handles topic as array', () => {
    const result = buildFilterClause({ topic: ['python', 'rust'] });
    expect(result.nodeFilter.topic).toEqual(['python', 'rust']);
  });

  it('handles kind as string (BL-295)', () => {
    const result = buildFilterClause({ kind: 'component' });
    expect(result.nodeFilter.kind).toBe('component');
  });

  it('handles kind as array (BL-295)', () => {
    const result = buildFilterClause({ kind: ['component', 'entity'] });
    expect(result.nodeFilter.kind).toEqual(['component', 'entity']);
  });

  it('handles tags', () => {
    const result = buildFilterClause({ tags: ['ai', 'ml'] });
    expect(result.nodeFilter.tags).toEqual(['ai', 'ml']);
  });

  it('handles importance_min', () => {
    const result = buildFilterClause({ importance_min: 5 });
    expect(result.nodeFilter.importanceMin).toBe(5);
  });

  it('handles project_path as a first-class nodeFilter field, not a dropped extra clause (BL-294)', () => {
    const result = buildFilterClause({ project_path: '/home/user/project' });
    expect(result.nodeFilter.projectPath).toBe('/home/user/project');
    expect(result.extraClauses.sql).toBe('');
    expect(result.unsupportedFilters).toEqual([]);
  });

  it('handles agent_id as a first-class nodeFilter field, not a dropped extra clause (BL-294)', () => {
    const result = buildFilterClause({ agent_id: 'agent-1' });
    expect(result.nodeFilter.agentId).toBe('agent-1');
    expect(result.extraClauses.sql).toBe('');
    expect(result.unsupportedFilters).toEqual([]);
  });

  it('handles namespace', () => {
    const result = buildFilterClause({ namespace: 'test-ns' });
    expect(result.nodeFilter.namespace).toBe('test-ns');
  });

  it('handles ids', () => {
    const result = buildFilterClause({ ids: [1, 2, 3] });
    expect(result.nodeFilter.ids).toEqual([1, 2, 3]);
  });

  it('handles confidence', () => {
    const result = buildFilterClause({ confidence: 'confirmed' });
    expect(result.nodeFilter.confidence).toBe('confirmed');
  });

  it('handles combination of fields', () => {
    const result = buildFilterClause({
      topic: 'python',
      tags: ['ai'],
      importance_min: 3,
      project_path: '/test',
      agent_id: 'agent-42',
    });
    expect(result.nodeFilter.topic).toBe('python');
    expect(result.nodeFilter.tags).toEqual(['ai']);
    expect(result.nodeFilter.importanceMin).toBe(3);
    expect(result.nodeFilter.projectPath).toBe('/test');
    expect(result.nodeFilter.agentId).toBe('agent-42');
    expect(result.unsupportedFilters).toEqual([]);
  });

  it('handles empty filters', () => {
    const result = buildFilterClause({});
    expect(result.extraClauses.sql).toBe('');
    expect(result.extraClauses.params).toEqual([]);
    expect(result.unsupportedFilters).toEqual([]);
  });

  it('passes through unknown filter keys but flags them as unsupported (BL-294)', () => {
    const result = buildFilterClause({ custom_field: 'value' });
    expect(result.extraClauses.sql).toContain('custom_field');
    expect(result.extraClauses.params).toEqual(['value']);
    expect(result.unsupportedFilters).toEqual(['custom_field']);
  });
});

// ── StoreSearchBackend integration ───────────────────────────────────────────

describe('StoreSearchBackend integration', () => {
  let vec: VectorBackend;
  let graph: GraphBackend;
  let backend: StoreSearchBackend;

  function createTestDb() {
    const db = new Database(':memory:');
    sqliteVec.load(db);
    db.pragma('journal_mode = WAL');
    return db;
  }

  function createTestVecStore(db: Database.Database): VectorBackend {
    // BL-364: SqliteVectorBackend's constructor takes a StoreAdapter (it
    // reads adapter.config.type / adapter.capabilities internally, BL-380) —
    // a raw better-sqlite3.Database has neither, and used to crash with
    // "Cannot read properties of undefined (reading 'nativeVectors')".
    // createSqliteAdapter(db) wraps the SAME handle the graph store below
    // shares, rather than opening a second connection.
    const adapter = createSqliteAdapter(db);
    const store = new SqliteVectorBackend(adapter);
    store.ensureSpace({ modelId: 'test-model', dim: 4 });
    return store;
  }

  async function createTestGraphStore(db: Database.Database): Promise<GraphBackend> {
    // Same BL-364/BL-380 shape as createTestVecStore above: StoreGraphBackend
    // also takes a StoreAdapter now (`this.adapter.executeAll`/`executeGet`),
    // not a raw better-sqlite3.Database — and applySchema() is async, so it
    // must be awaited before any node write races the DDL.
    const adapter = createSqliteAdapter(db);
    const store = new StoreGraphBackend(adapter);
    await store.applySchema();
    return store;
  }

  beforeEach(async () => {
    const db = createTestDb();
    vec = createTestVecStore(db);
    graph = await createTestGraphStore(db);
    backend = new StoreSearchBackend(vec, graph);
  });

  // graph.writeNode() is async (StoreAdapter-backed, BL-364/BL-380) — seedNode
  // must be awaited by every caller, or `id` is a Promise silently coerced
  // into vec.upsert()'s node-id parameter instead of a number.
  async function seedNode(
    content: string,
    topic: string,
    tags: string[],
    vecValues: number[],
  ): Promise<number> {
    const id = await graph.writeNode(content, {
      name: topic,
      topic,
      tags,
      summary: content.slice(0, 100),
      importance: 5,
    });
    vec.upsert(id, new Float32Array(vecValues), { modelId: 'test-model', dim: 4 });
    return id;
  }

  it('performs text-only search', async () => {
    await seedNode('Python is a great language for AI and data science', 'python', ['ai', 'programming'], [1.0, 0.0, 0.0, 0.0]);
    await seedNode('Rust is a systems language with memory safety', 'rust', ['systems', 'programming'], [0.0, 1.0, 0.0, 0.0]);
    await seedNode('TypeScript adds types to JavaScript', 'typescript', ['web', 'programming'], [0.0, 0.0, 1.0, 0.0]);

    const results = await backend.search({ text: 'python' }, 10);
    expect(results.length).toBeGreaterThan(0);
    const pythonResult = results.find((r) => r.fields.topic === 'python');
    expect(pythonResult).toBeDefined();
    expect(pythonResult!.textScore).toBeGreaterThan(0);
  });

  it('performs vec-only search', async () => {
    await seedNode('Vector A — should match', 'topic-a', ['test'], [1.0, 0.5, 0.3, 0.1]);
    await seedNode('Vector B — far away', 'topic-b', ['test'], [-1.0, -0.5, -0.3, -0.1]);

    const queryVec = new Float32Array([1.0, 0.5, 0.3, 0.1]);
    const results = await backend.search({ vec: queryVec }, 10);
    expect(results.length).toBeGreaterThan(0);
  });

  it('performs hybrid text + vec search', async () => {
    await seedNode('Python async programming guide', 'python', ['programming'], [1.0, 0.0, 0.0, 0.0]);
    await seedNode('Rust programming guide', 'rust', ['programming'], [0.0, 1.0, 0.0, 0.0]);

    const queryVec = new Float32Array([1.0, 0.1, 0.0, 0.0]);
    const results = await backend.search(
      { text: 'programming', vec: queryVec },
      10,
    );
    expect(results.length).toBeGreaterThan(0);
  });

  // NB: this deliberately no longer claims to test the topic boost. `topicBoost` is
  // applied by the fusion `search()` function, NOT by StoreSearchBackend.search() —
  // so the previous version of this test, named 'applies topic boost on exact match',
  // called a code path that contains no boost at all and could not have failed for the
  // reason its name gave. The real boost coverage now lives in
  // 'search() with mock backend' -> 'topic boost ... reorders'.
  it('returns the topic-matching row for a text query, with its topic field intact', async () => {
    const id = await seedNode('Python language details', 'python', ['programming'], [1.0, 0.0, 0.0, 0.0]);
    await seedNode('Other topics for contrast', 'other', ['misc'], [0.1, 0.1, 0.1, 0.1]);

    const results = await backend.search({ text: 'python' }, 10);
    const pythonResult = results.find((r) => r.id === id);
    expect(pythonResult).toBeDefined();
    expect(pythonResult!.fields.topic).toBe('python');
  });

  it('respects limit', async () => {
    for (let i = 0; i < 20; i++) {
      await seedNode(`Content ${i}`, `topic-${i}`, ['test'], [i * 0.05, (i % 4) * 0.25, 0, 0]);
    }

    const results = await backend.search({ text: 'Content' }, 5);
    // 20 rows match; `toBeLessThanOrEqual(5)` also passed on zero results, i.e. on a
    // backend that returned nothing at all.
    expect(results).toHaveLength(5);
  });

  it('filters by topic via graph backend', async () => {
    const pyId = await seedNode('Python async guide', 'python', ['ai'], [1.0, 0.0, 0.0, 0.0]);
    await seedNode('Rust ownership guide', 'rust', ['systems'], [0.0, 1.0, 0.0, 0.0]);

    const results = await backend.search(
      { text: 'guide', filters: { topic: 'python' } },
      10,
    );
    // Two holes in the previous form, both of which made this unable to fail:
    //   1. the guard `if (r.fields.topic !== 'python')` made the assertion body
    //      unreachable in exactly the case where the filter WORKS, so on a passing
    //      run nothing was ever asserted;
    //   2. with no non-empty guard, a filter that excluded *everything* — including
    //      the row it was asked for — iterated zero times and passed.
    // Both rows match the text 'guide', so the filter is the only thing that can
    // exclude the rust row.
    expect(results.map((r) => r.id)).toEqual([pyId]);
    for (const r of results) {
      expect(r.fields.topic).toBe('python');
    }
  });

  it('returns fields for each result', async () => {
    await seedNode('Test content here', 'test-topic', ['demo'], [0.5, 0.5, 0.0, 0.0]);

    const results = await backend.search({ text: 'Test' }, 10);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.fields).toBeDefined();
      expect(r.fields.content).toBeDefined();
      expect(r.fields.tags).toBeDefined();
    }
  });

  it('handles no matching results', async () => {
    const results = await backend.search({ text: 'zzz_nonexistent_zzz' }, 10);
    expect(Array.isArray(results)).toBe(true);
  });

  it('returns results with correct id types', async () => {
    const id = await seedNode('Number test', 'num', ['test'], [1.0, 0.0, 0.0, 0.0]);

    const results = await backend.search({ text: 'Number' }, 10);
    expect(results.map((r) => r.id)).toContain(id);
    for (const r of results) {
      expect(typeof r.id).toBe('number');
    }
  });

  // ── BL-294: filter/namespace must constrain the vector channel too ───────────

  describe('vector channel filter isolation (BL-294)', () => {
    async function seedNodeInNamespace(
      content: string,
      namespace: string,
      vecValues: number[],
    ): Promise<number> {
      const id = await graph.writeNode(content, { namespace, importance: 5 });
      vec.upsert(id, new Float32Array(vecValues), { modelId: 'test-model', dim: 4 });
      return id;
    }

    it('does not leak cross-namespace vector hits into a namespace-scoped vec-only search', async () => {
      await seedNodeInNamespace('tenant A secret', 'tenant-a', [1.0, 0.0, 0.0, 0.0]);
      const bId = await seedNodeInNamespace('tenant B secret', 'tenant-b', [1.0, 0.0, 0.0, 0.0]);

      // Identical vector, DIFFERENT namespace — a caller scoped to tenant-b must never
      // see tenant-a's node, even though it is the nearest (in fact identical) vector.
      const queryVec = new Float32Array([1.0, 0.0, 0.0, 0.0]);
      const results = await backend.search(
        { vec: queryVec, filters: { namespace: 'tenant-b' } },
        10,
      );

      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.fields.namespace).toBe('tenant-b');
      }
      expect(results.some((r) => r.id === bId)).toBe(true);
    });

    it('does not leak cross-namespace vector hits into a namespace-scoped hybrid (text+vec) search', async () => {
      const aId = await graph.writeNode('shared phrase alpha', { namespace: 'tenant-a' });
      vec.upsert(aId, new Float32Array([1.0, 0.0, 0.0, 0.0]), { modelId: 'test-model', dim: 4 });
      const bId = await graph.writeNode('shared phrase beta', { namespace: 'tenant-b' });
      vec.upsert(bId, new Float32Array([1.0, 0.0, 0.0, 0.0]), { modelId: 'test-model', dim: 4 });

      const results = await backend.search(
        { text: 'shared phrase', vec: new Float32Array([1.0, 0.0, 0.0, 0.0]), filters: { namespace: 'tenant-b' } },
        10,
      );

      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.fields.namespace).toBe('tenant-b');
      }
    });

    it('returns zero vector candidates (not unfiltered results) when the filter matches no nodes', async () => {
      await seedNodeInNamespace('only node', 'tenant-a', [1.0, 0.0, 0.0, 0.0]);

      const results = await backend.search(
        { vec: new Float32Array([1.0, 0.0, 0.0, 0.0]), filters: { namespace: 'nonexistent-tenant' } },
        10,
      );

      expect(results).toEqual([]);
    });

    it('surfaces a degrade signal when a filter key cannot be enforced by either channel', async () => {
      await seedNodeInNamespace('some content', 'tenant-a', [1.0, 0.0, 0.0, 0.0]);

      const backendResults = await backend.search(
        { vec: new Float32Array([1.0, 0.0, 0.0, 0.0]), filters: { totally_unrecognized_key: 'x' } },
        10,
      );
      expect(backendResults.length).toBeGreaterThan(0);
      for (const r of backendResults) {
        expect(r.degraded?.unsupportedFilters).toEqual(['totally_unrecognized_key']);
      }

      // The degrade signal must also propagate through the top-level search() function.
      const topLevelResults = await search(
        backend,
        { vec: new Float32Array([1.0, 0.0, 0.0, 0.0]), filters: { totally_unrecognized_key: 'x' } },
        { limit: 10 },
      );
      expect(topLevelResults.length).toBeGreaterThan(0);
      for (const r of topLevelResults) {
        expect(r.degraded?.unsupportedFilters).toEqual(['totally_unrecognized_key']);
      }
    });

    it('does NOT set a degrade signal when all filter keys are recognized', async () => {
      await seedNodeInNamespace('clean filter node', 'tenant-a', [1.0, 0.0, 0.0, 0.0]);

      const results = await backend.search(
        { vec: new Float32Array([1.0, 0.0, 0.0, 0.0]), filters: { namespace: 'tenant-a' } },
        10,
      );
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.degraded).toBeUndefined();
      }
    });
  });

  // ── BL-295 criterion 3: kind:'generic' storage + hybrid FTS5+vector retrieval, end to end ──
  //
  // Per sox-ecosystem's own BL-295 resolution (Option A): the node.kind CHECK constraint
  // is never extended per consumer. A non-memory reuse case (e.g. a component registry)
  // writes with kind:'generic' and carries its own sub-kind (here: 'component') in
  // tags/metadata. This proves the actual consumer-facing outcome BL-295 asks for — not
  // just a schema-level CHECK pass — using the DEFAULT createGraphBackend(db) with no
  // constructor options at all.

  describe('kind:"generic" end-to-end via StoreSearchBackend (BL-295 criterion 3)', () => {
    it('stores AND retrieves a kind:"generic" (sub-kind:"component") node through real hybrid FTS5(BM25)+vector search', async () => {
      const db = createTestDb();
      const genericVec = createTestVecStore(db);
      // BL-364/BL-380: StoreGraphBackend takes a StoreAdapter, not a raw
      // Database — wrap the same handle genericVec's adapter shares.
      const genericGraphAdapter = createSqliteAdapter(db);
      const genericGraph = new StoreGraphBackend(genericGraphAdapter);
      await genericGraph.applySchema();
      const genericBackend = new StoreSearchBackend(genericVec, genericGraph);

      const id = await genericGraph.writeNode(
        'A reusable Button component with primary and secondary variants',
        {
          kind: 'generic',
          name: 'Button',
          topic: 'ui-primitives',
          importance: 5,
          tags: ['component'],
          metadata: { subKind: 'component' },
        },
      );
      genericVec.upsert(id, new Float32Array([1.0, 0.0, 0.0, 0.0]), {
        modelId: 'test-model',
        dim: 4,
      });

      // (a) it is genuinely a graph-store `node` row of kind='generic' carrying its
      // sub-kind in tags/metadata — the sanctioned non-memory reuse contract.
      const stored = await genericGraph.getNode(id);
      expect(stored).not.toBeNull();
      expect(stored!.kind).toBe('generic');
      expect(stored!.tags).toContain('component');
      expect(stored!.metadata).toEqual({ subKind: 'component' });

      // (b) real hybrid FTS5(BM25) + vector-kNN search finds it via StoreSearchBackend,
      // filterable by kind:'generic' through the public filter surface.
      const results = await genericBackend.search(
        { text: 'Button component', vec: new Float32Array([1.0, 0.0, 0.0, 0.0]), filters: { kind: 'generic' } },
        10,
      );
      expect(results.length).toBeGreaterThan(0);
      const found = results.find((r) => r.id === id);
      expect(found).toBeDefined();
      expect(found!.fields.kind).toBe('generic');
      expect(found!.textScore).toBeGreaterThan(0);
      expect(found!.vecScore).toBeGreaterThan(0);

      db.close();
    });
  });
});


