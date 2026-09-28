import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import type { EmbeddingProvider, EmbeddingHealth, EmbeddingProviderMetadata, EmbedRole } from '@adhd/sox-embedding-provider';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb } from './db.js';
import { memoryWrite, memoryWritePhaseA } from './write.js';
import { memoryRecall, ExpansionOverflowError, __resetRecallVecCircuitForTest } from './recall.js';
import { _shutdownEmbedWorker, _setEmbedProviderForTest } from './embed.js';
import { WriteQueue } from './write-queue.js';
import { DeterministicTestProvider, featureHashEmbed } from './embed-test-provider.js';



afterAll(async () => {
  await _shutdownEmbedWorker();
});

// ── DB helpers ────────────────────────────────────────────────────────────────

async function tmpDb(): Promise<{ db: StoreAdapter; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-'));
  const db = await openDb(path.join(dir, 'test.db'));
  return { db, dir };
}

async function cleanup(db: StoreAdapter, dir: string): Promise<void> {
  try { await db.close(); } catch { /* ignore */ }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Unit tests ────────────────────────────────────────────────────────────────

describe('ExpansionOverflowError', () => {
  it('has correct name and properties', () => {
    const err = new ExpansionOverflowError('too much', 10000, 4096);
    expect(err.name).toBe('ExpansionOverflowError');
    expect(err.requestedTokens).toBe(10000);
    expect(err.maxTokens).toBe(4096);
    expect(err.message).toContain('too much');
  });
});

describe('ParentContextConfig', () => {
  it('has expected shape', () => {
    const config = {
      maxDepth: 1,
      maxContextTokens: 4096,
      joinStrategy: 'separator' as const,
      separator: '\n\n---\n\n',
      includeOriginal: true,
    };
    expect(config.maxDepth).toBe(1);
    expect(config.joinStrategy).toBe('separator');
  });
});

describe('LateChunkingConfig', () => {
  it('has expected shape', () => {
    const config = {
      enabled: true,
      boundaries: [{ startToken: 0, endToken: 100 }],
      overlapTokens: 0,
    };
    expect(config.enabled).toBe(true);
    expect(config.boundaries).toHaveLength(1);
  });
});

// ── BL-117: late chunking must NOT lie about being applied ────────────────────
//
// Before this fix, `params.lateChunking?.enabled` unconditionally set
// `lateChunkingApplied = true` regardless of whether any chunking actually
// happened (recall.ts:851-852, pre-fix). These tests exercise the REAL
// memoryRecall() behavior (not just a config object's shape, which cannot
// catch this class of defect) and prove the flag now honestly reports
// non-application with a machine-readable reason.
describe('memoryRecall — BL-117 late chunking honesty', () => {
  it('reports lateChunkingApplied=false with a skip reason when requested (not silently true)', async () => {
    const { db, dir } = await tmpDb();
    try {
      await memoryWrite(db, { content: 'a document about distributed systems and consensus', project_path: '/test/project' });

      const response = await memoryRecall(db, 'project', {
        query: 'distributed systems',
        lateChunking: {
          enabled: true,
          boundaries: [{ startToken: 0, endToken: 50 }],
        },
      });

      expect(response.metadata.lateChunkingApplied).toBe(false);
      expect(response.metadata.lateChunkingSkipReason).toBeDefined();
      expect(response.metadata.lateChunkingSkipReason).toMatch(/late_chunking_unsupported/);
    } finally {
      await cleanup(db, dir);
    }
  });

  it('reports lateChunkingApplied=false with a skip reason even on the empty-corpus path', async () => {
    const { db, dir } = await tmpDb();
    try {
      // No writes at all — allRowids.size === 0, exercising the early-return branch.
      const response = await memoryRecall(db, 'project', {
        query: 'nothing has ever been written to this store',
        lateChunking: {
          enabled: true,
          boundaries: [{ startToken: 0, endToken: 10 }],
        },
      });

      expect(response.results).toHaveLength(0);
      expect(response.metadata.lateChunkingApplied).toBe(false);
      expect(response.metadata.lateChunkingSkipReason).toBeDefined();
      expect(response.metadata.lateChunkingSkipReason).toMatch(/late_chunking_unsupported/);
    } finally {
      await cleanup(db, dir);
    }
  });

  it('does NOT set lateChunkingSkipReason when late chunking was not requested', async () => {
    const { db, dir } = await tmpDb();
    try {
      await memoryWrite(db, { content: 'a document with no late chunking request', project_path: '/test/project' });

      const response = await memoryRecall(db, 'project', { query: 'no late chunking request' });

      expect(response.metadata.lateChunkingApplied).toBe(false);
      expect(response.metadata.lateChunkingSkipReason).toBeUndefined();
    } finally {
      await cleanup(db, dir);
    }
  });

  it('does NOT set lateChunkingSkipReason when enabled is explicitly false', async () => {
    const { db, dir } = await tmpDb();
    try {
      await memoryWrite(db, { content: 'a document with late chunking explicitly disabled', project_path: '/test/project' });

      const response = await memoryRecall(db, 'project', {
        query: 'explicitly disabled',
        lateChunking: { enabled: false, boundaries: [] },
      });

      expect(response.metadata.lateChunkingApplied).toBe(false);
      expect(response.metadata.lateChunkingSkipReason).toBeUndefined();
    } finally {
      await cleanup(db, dir);
    }
  });
});

// ── Parent-context expansion: session_id fallback path ─────────────────────────

describe('Parent-context expansion — session_id fallback', () => {
  it('expands child node via session_id when no DERIVED_FROM edge exists', async () => {
    const { db, dir } = await tmpDb();
    try {
      // 1. Create a parent node
      const parentResult = await memoryWrite(db, {
        content: 'Parent context document about machine learning algorithms',
        name: 'parent-doc',
        project_path: '/test/project',
      });
      expect(parentResult).toHaveProperty('episode_uid');
      const parentUid = (parentResult as { episode_uid: string }).episode_uid;

      // 2. Create a child node with session_id pointing to the parent's UID.
      //    Intentionally NO derived_from_uid — we must exercise the session_id fallback.
      const childResult = await memoryWrite(db, {
        content: 'Child chunk discussing transformer architectures',
        name: 'child-chunk',
        session_id: parentUid,
        project_path: '/test/project',
      });
      expect(childResult).toHaveProperty('episode_uid');
      const childUid = (childResult as { episode_uid: string }).episode_uid;

      // 3. Verify no DERIVED_FROM edge exists between child and parent.
      const edgeRow = await db.executeGet(`SELECT e.rowid FROM edge e
         JOIN node n_src ON n_src.rowid = e.src
         JOIN node n_dst ON n_dst.rowid = e.dst
         WHERE n_src.uid = ? AND n_dst.uid = ? AND e.rel = 'DERIVED_FROM' AND e.t_expired IS NULL`, [childUid, parentUid]);
      // StoreAdapter.executeGet's "no row" sentinel is null, not undefined
      // (better-sqlite3's raw .get() returned undefined pre-migration).
      expect(edgeRow).toBeNull();

      // 4. Run recall with parent-context expansion.
      const response = await memoryRecall(db, 'project', {
        query: 'transformer architectures',
        parentContext: {
          maxDepth: 1,
          maxContextTokens: 10000,
          joinStrategy: 'contiguous',
        },
      });

      // 5. Find the child result entry.
      const childResultEntry = response.results.find(r => r.uid === childUid);
      expect(childResultEntry).toBeDefined();
      expect(childResultEntry!.expandedText).toBeTruthy();

      // 6. Verify expandedText includes both child content and parent content.
      expect(childResultEntry!.expandedText).toContain('transformer architectures');
      expect(childResultEntry!.expandedText).toContain('machine learning');

      // 7. Verify expansionSources has depth=0 (child) and depth=1 (parent).
      expect(childResultEntry!.expansionSources).toHaveLength(2);
      expect(childResultEntry!.expansionSources[0]!.depth).toBe(0);
      expect(childResultEntry!.expansionSources[0]!.chunk.uid).toBe(childUid);
      expect(childResultEntry!.expansionSources[1]!.depth).toBe(1);
      expect(childResultEntry!.expansionSources[1]!.chunk.uid).toBe(parentUid);
      expect(childResultEntry!.expansionSources[1]!.chunk.content).toContain('machine learning');
    } finally {
      await cleanup(db, dir);
    }
  });
});

// ── HF-3 score_breakdown tests ────────────────────────────────────────────────

const SCORE_TOLERANCE = 1e-9;

describe('score_breakdown — channel sum invariant (HF-3)', () => {
  /**
   * Acceptance criterion (a): channel breakdown sums to the reported fused
   * value within tolerance for every result returned by memoryRecall.
   */
  it('breakdown.vec + breakdown.bm25 + breakdown.temporal === score for all results', async () => {
    const { db, dir } = await tmpDb();
    try {
      // Seed multiple episodes so there are real ranked candidates.
      await memoryWrite(db, { content: 'neural networks and deep learning architecture', name: 'nn-deep', project_path: '/test/project' });
      await memoryWrite(db, { content: 'machine learning gradient descent optimization', name: 'ml-grad', project_path: '/test/project' });
      await memoryWrite(db, { content: 'transformer self-attention mechanisms', name: 'transformer', project_path: '/test/project' });
      await memoryWrite(db, { content: 'convolutional neural network image recognition', name: 'cnn-img', project_path: '/test/project' });

      const response = await memoryRecall(db, 'project', {
        query: 'neural network architectures',
        limit: 10,
      });

      expect(response.results.length).toBeGreaterThan(0);

      for (const result of response.results) {
        expect(result.score_breakdown).toBeDefined();
        const { vec, bm25, temporal, total } = result.score_breakdown;

        // All channels must be non-negative
        expect(vec).toBeGreaterThanOrEqual(0);
        expect(bm25).toBeGreaterThanOrEqual(0);
        expect(temporal).toBeGreaterThanOrEqual(0);

        // total must equal score (the stable per-result invariant)
        expect(Math.abs(total - result.score)).toBeLessThan(SCORE_TOLERANCE);

        // BL-167: vec + bm25 + temporal === total unconditionally, including
        // the previously-degenerate zero-normTotal case (min-max normalisation
        // collapsing every channel to 0 while total > 0). See the dedicated
        // "BL-167 — ScoreBreakdown invariant" describe block below for the
        // targeted red→green regression covering that exact scenario.
        const channelSum = vec + bm25 + temporal;
        expect(Math.abs(channelSum - total)).toBeLessThan(SCORE_TOLERANCE);
      }
    } finally {
      await cleanup(db, dir);
    }
  });

  it('score_breakdown total equals score for graph-expanded results', async () => {
    const { db, dir } = await tmpDb();
    try {
      await memoryWrite(db, { content: 'primary document about quantum computing', name: 'quantum-primary', project_path: '/test/project' });
      await memoryWrite(db, { content: 'related quantum entanglement details', name: 'quantum-related', project_path: '/test/project' });

      const response = await memoryRecall(db, 'project', {
        query: 'quantum',
        limit: 10,
        depth: 1,
      });

      for (const result of response.results) {
        expect(result.score_breakdown).toBeDefined();
        const { vec, bm25, temporal, total } = result.score_breakdown;
        // total must always equal score (both ranked and graph-expanded nodes)
        expect(Math.abs(total - result.score)).toBeLessThan(SCORE_TOLERANCE);
        // BL-167: for ranked (non-graph-expanded) nodes, channel sum === total
        // unconditionally now — including the previously-degenerate
        // zero-normTotal case. Graph-expanded neighbors are a separate,
        // intentional design (recall.ts ~L634): they carry a zero breakdown
        // by construction since they originate from graph traversal, not a
        // ranked channel signal, so total (their score) is deliberately not
        // decomposed into vec/bm25/temporal — that exception is unrelated to
        // BL-167 and stays excluded here.
        const isGraphExpanded = result.provenance.length === 1 && result.provenance[0] === 'graph';
        if (!isGraphExpanded) {
          const channelSum = vec + bm25 + temporal;
          expect(Math.abs(channelSum - total)).toBeLessThan(SCORE_TOLERANCE);
        }
      }
    } finally {
      await cleanup(db, dir);
    }
  });
});

describe('BL-167 — ScoreBreakdown invariant (normTotal === 0 degenerate case)', () => {
  /**
   * Red→green regression for BL-167.
   *
   * Before the fix: `libs/memory-core/src/recall.ts:526-531` computed the
   * proportional channel split purely from per-query min-max-normalised
   * values. A node whose raw per-channel value equals that channel's minimum
   * on ALL THREE channels simultaneously normalises to vecNorm=ftsNorm=
   * tempNorm=0, so normTotal===0 — even though its raw RRF total (and
   * therefore `finalScore`/`total`) is > 0. The old code left all three
   * *Contrib fields at 0 in that branch, violating the documented invariant
   * `vec + bm25 + temporal === total` (recall.ts:508-513) for that node.
   *
   * This test deterministically engineers that exact scenario using the
   * feature-hash DeterministicTestProvider (shared tokens → high cosine,
   * disjoint tokens → near-zero cosine, wired globally via vitest.setup.ts):
   *
   *   - Nodes B and C share the query token "widget" → both rank ahead of A
   *     on the vec channel AND match on the FTS channel.
   *   - Node A shares no tokens with the query or with B/C ("giraffe canyon
   *     nebula quartz") → excluded entirely from the FTS channel (ftsRaw=0,
   *     which is trivially that channel's array minimum) and ranks last
   *     (worst/smallest raw contribution) on the vec channel.
   *   - Node A is additionally backdated (t_created 10 days in the past,
   *     recency multiplier still comfortably nonzero) so it also ranks last
   *     on the temporal channel — its raw temporal contribution is that
   *     channel's array minimum too.
   *
   * Node A's raw value is therefore simultaneously the per-channel minimum on
   * vec, fts, AND temporal → normTotal(A) === 0 by construction, while its
   * raw RRF total (vecRaw + tempRaw, both > 0) drives finalScore/total > 0.
   * This reproduces the invariant violation exactly; the fixed code must
   * still satisfy vec + bm25 + temporal === total for node A.
   */
  it('channel sum equals total even when min-max normalisation collapses every channel to 0', async () => {
    const { db, dir } = await tmpDb();
    try {
      const bResult = await memoryWrite(db, { content: 'widget alpha assembly', name: 'node-b', importance: 5, project_path: '/test/project' });
      const cResult = await memoryWrite(db, { content: 'widget beta assembly', name: 'node-c', importance: 5, project_path: '/test/project' });
      const aResult = await memoryWrite(db, { content: 'giraffe canyon nebula quartz', name: 'node-a', importance: 5, project_path: '/test/project' });

      const aUid = (aResult as { episode_uid: string }).episode_uid;

      // Backdate node A so it is strictly the oldest → worst (highest rank
      // number, smallest rrfScore) on the temporal channel. 10 days keeps the
      // recency multiplier (0.995^hours) comfortably away from fp underflow.
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      await db.executeRun(`UPDATE node SET t_created = ? WHERE uid = ?`, [tenDaysAgo, aUid]);

      const response = await memoryRecall(db, 'project', {
        query: 'widget',
        limit: 10,
        depth: 0, // no graph expansion — keep this test focused on the ranked path
      });

      const resultA = response.results.find((r) => r.uid === aUid);
      expect(resultA).toBeDefined();

      const { vec, bm25, temporal, total } = resultA!.score_breakdown;

      // Precondition sanity check: this test only proves what it claims to
      // prove if node A actually landed in the degenerate normTotal===0
      // scenario (all channels non-negative, total strictly positive). If a
      // future embedding/ranking change breaks this precondition the test
      // should fail loudly here rather than silently passing on a
      // no-longer-degenerate case.
      expect(total).toBeGreaterThan(0);
      expect(vec).toBeGreaterThanOrEqual(0);
      expect(bm25).toBeGreaterThanOrEqual(0);
      expect(temporal).toBeGreaterThanOrEqual(0);

      // The core BL-167 assertion: the additive identity holds exactly, even
      // in the degenerate normTotal===0 case.
      expect(Math.abs(vec + bm25 + temporal - total)).toBeLessThan(SCORE_TOLERANCE);
      expect(Math.abs(total - resultA!.score)).toBeLessThan(SCORE_TOLERANCE);

      // bm25 must be exactly 0 (node A never matched the FTS query "widget"),
      // while vec/temporal carry the (raw-proportional) remainder — proving
      // the fallback split by raw contribution, not a trivial all-zero or
      // equal three-way split.
      expect(bm25).toBe(0);
      expect(vec + temporal).toBeCloseTo(total, 9);

      // Sanity: nodes B and C (which share tokens with the query and are
      // fresh) should NOT hit the degenerate branch — confirms the fix
      // didn't regress the common path.
      for (const uid of [(bResult as { episode_uid: string }).episode_uid, (cResult as { episode_uid: string }).episode_uid]) {
        const r = response.results.find((res) => res.uid === uid);
        if (r) {
          const bd = r.score_breakdown;
          expect(Math.abs(bd.vec + bd.bm25 + bd.temporal - bd.total)).toBeLessThan(SCORE_TOLERANCE);
        }
      }
    } finally {
      await cleanup(db, dir);
    }
  });
});

describe('score_breakdown — cross-query comparability (HF-3)', () => {
  /**
   * Acceptance criterion (b): normalised scores for two very different queries
   * are on a comparable scale.
   *
   * Strategy: run two queries — one with many relevant results, one with a
   * single highly relevant result — and verify that:
   *   1. Top-result scores from both queries are in [0, 1] (per-query min-max).
   *   2. The top result from each query is not orders-of-magnitude different.
   */
  it('top scores from dissimilar queries are on comparable scale', async () => {
    const { db, dir } = await tmpDb();
    try {
      // Write episodes relevant to Query A (generic topic)
      await memoryWrite(db, { content: 'python programming language features and syntax', name: 'py-1', project_path: '/test/project' });
      await memoryWrite(db, { content: 'python data science libraries pandas numpy', name: 'py-2', project_path: '/test/project' });
      await memoryWrite(db, { content: 'python web frameworks django flask', name: 'py-3', project_path: '/test/project' });
      await memoryWrite(db, { content: 'python async concurrency asyncio event loop', name: 'py-4', project_path: '/test/project' });

      // Write one episode relevant to Query B (very specific, niche)
      await memoryWrite(db, { content: 'zygomorphic floral symmetry in orchidaceae taxonomy', name: 'orchid', project_path: '/test/project' });

      // Query A: common term, many relevant results
      const responseA = await memoryRecall(db, 'project', {
        query: 'python programming',
        limit: 10,
      });

      // Query B: niche term, few or one relevant result
      const responseB = await memoryRecall(db, 'project', {
        query: 'orchid floral symmetry',
        limit: 10,
      });

      expect(responseA.results.length).toBeGreaterThan(0);
      expect(responseB.results.length).toBeGreaterThan(0);

      const topA = responseA.results[0]!;
      const topB = responseB.results[0]!;

      // Both top scores must be in [0, 1] — per-query min-max ensures this
      expect(topA.score).toBeGreaterThanOrEqual(0);
      expect(topA.score).toBeLessThanOrEqual(1.0 + SCORE_TOLERANCE);
      expect(topB.score).toBeGreaterThanOrEqual(0);
      expect(topB.score).toBeLessThanOrEqual(1.0 + SCORE_TOLERANCE);

      // The ratio of scores should not be extreme (within 10×)
      // Both represent "best result for this query" so both should be meaningful
      if (topA.score > 0 && topB.score > 0) {
        const ratio = Math.max(topA.score, topB.score) / Math.min(topA.score, topB.score);
        expect(ratio).toBeLessThan(10);
      }

      // score_breakdown must still sum correctly for cross-query results.
      // Graph-expanded nodes (provenance === ['graph']) are the one documented
      // exception: their channels are intentionally zero with total = score
      // (recall.ts ~L634 — they originate from graph traversal, not a ranked
      // channel signal). BL-167: every other (ranked) node now satisfies
      // vec + bm25 + temporal === total unconditionally, including the
      // previously-degenerate zero-normTotal case.
      for (const result of [...responseA.results, ...responseB.results]) {
        const { vec, bm25, temporal, total } = result.score_breakdown;
        expect(Math.abs(total - result.score)).toBeLessThan(SCORE_TOLERANCE);
        const isGraphExpanded = result.provenance.length === 1 && result.provenance[0] === 'graph';
        if (!isGraphExpanded) {
          expect(Math.abs(vec + bm25 + temporal - total)).toBeLessThan(SCORE_TOLERANCE);
        }
      }
    } finally {
      await cleanup(db, dir);
    }
  });

  it('score_breakdown fields have correct TypeScript shape', async () => {
    const { db, dir } = await tmpDb();
    try {
      await memoryWrite(db, { content: 'test episode for shape verification', project_path: '/test/project' });
      const response = await memoryRecall(db, 'project', { query: 'test episode' });

      if (response.results.length > 0) {
        const result = response.results[0]!;
        expect(result.score_breakdown).toBeDefined();
        expect(typeof result.score_breakdown.vec).toBe('number');
        expect(typeof result.score_breakdown.bm25).toBe('number');
        expect(typeof result.score_breakdown.temporal).toBe('number');
        expect(typeof result.score_breakdown.total).toBe('number');
      }
    } finally {
      await cleanup(db, dir);
    }
  });
});

// ── BUG-MEMORY-003: memory_recall pads results with null-content entity nodes ─
//
// Root cause (two independent entry points, both fixed in recall.ts):
//   1a. Temporal channel (recall.ts ~L623) had no `n.kind` predicate — every
//       live node (episode/entity/community/session/generic) was a candidate
//       ordered by recency.
//   1b. Depth-1 graph-expansion neighbor fetch (recall.ts ~L834, DEFAULT_DEPTH=1)
//       also had no kind predicate — every tagged episode has a live MENTIONS
//       edge to its own entity node(s) (write.ts:365-390), so those entities
//       are the episode's own depth-1 neighbors and got pulled in regardless
//       of the temporal-channel fix.
//
// Fix: `filters.kinds` (default ['episode']) applied at all SQL candidate-
// admission points (temporal, vec, FTS×2, graph-expansion). See
// SPEC-BUG-MEMORY-003.md for the full ruling.
//
// Every assertion below is `content !== null` for ALL results, never merely
// "the expected episode is present" — the item is explicit that the weaker
// assertion is exactly what let this ship (BL-167/BL-319/BL-469 shape).
describe('BUG-MEMORY-003 — memory_recall excludes non-episode node kinds by default', () => {
  it('AC1: temporal-channel entry point closed (depth: 0)', async () => {
    const { db, dir } = await tmpDb();
    try {
      // Real memoryWrite() with tags — tags create real entity nodes via the
      // real write.ts:365-390 path (no hand-inserted kind='entity' rows).
      await memoryWrite(db, { content: 'widget calibration procedure alpha revision', name: 'widget-alpha', tags: ['widget-alpha-tag'], project_path: '/test/project' });
      await memoryWrite(db, { content: 'widget calibration procedure beta revision', name: 'widget-beta', tags: ['widget-beta-tag'], project_path: '/test/project' });
      await memoryWrite(db, { content: 'widget calibration procedure gamma revision', name: 'widget-gamma', tags: ['widget-gamma-tag'], project_path: '/test/project' });

      const response = await memoryRecall(db, 'project', {
        query: 'widget calibration procedure',
        depth: 0,
        limit: 10,
      });

      expect(response.results.every((r) => r.content !== null)).toBe(true);
      expect(response.results.length).toBe(3);
    } finally {
      await cleanup(db, dir);
    }
  });

  it('AC2: graph-expansion entry point closed (default depth, i.e. DEFAULT_DEPTH=1)', async () => {
    const { db, dir } = await tmpDb();
    try {
      await memoryWrite(db, { content: 'widget calibration procedure alpha revision', name: 'widget-alpha', tags: ['widget-alpha-tag'], project_path: '/test/project' });
      await memoryWrite(db, { content: 'widget calibration procedure beta revision', name: 'widget-beta', tags: ['widget-beta-tag'], project_path: '/test/project' });
      await memoryWrite(db, { content: 'widget calibration procedure gamma revision', name: 'widget-gamma', tags: ['widget-gamma-tag'], project_path: '/test/project' });

      // No depth override — DEFAULT_DEPTH = 1 applies, exercising the graph-
      // expansion neighbor fetch (§1b) independently of the temporal fix (§1a).
      const response = await memoryRecall(db, 'project', {
        query: 'widget calibration procedure',
        limit: 10,
      });

      expect(response.results.every((r) => r.content !== null)).toBe(true);
      expect(response.results.length).toBe(3);
    } finally {
      await cleanup(db, dir);
    }
  });

  it('AC3: opt-in still works via filters.kinds', async () => {
    const { db, dir } = await tmpDb();
    try {
      await memoryWrite(db, { content: 'widget calibration procedure alpha revision', name: 'widget-alpha', tags: ['widget-alpha-tag'], project_path: '/test/project' });
      await memoryWrite(db, { content: 'widget calibration procedure beta revision', name: 'widget-beta', tags: ['widget-beta-tag'], project_path: '/test/project' });
      await memoryWrite(db, { content: 'widget calibration procedure gamma revision', name: 'widget-gamma', tags: ['widget-gamma-tag'], project_path: '/test/project' });

      // Confirm the fixed default excludes entities first, in the same run,
      // to prove the opt-in below is doing the work — not corpus luck.
      const defaultResponse = await memoryRecall(db, 'project', {
        query: 'widget calibration procedure',
        limit: 20,
      });
      expect(defaultResponse.results.every((r) => r.content !== null)).toBe(true);

      const optInResponse = await memoryRecall(db, 'project', {
        query: 'widget calibration procedure',
        filters: { kinds: ['episode', 'entity'] },
        limit: 20,
      });
      expect(optInResponse.results.some((r) => r.content === null)).toBe(true);
    } finally {
      await cleanup(db, dir);
    }
  });

  it('AC4: token budget is spent on usable (episode) rows, not entity padding', async () => {
    const { db, dir } = await tmpDb();
    try {
      // Size content precisely via estimateTokens' documented Math.ceil(text.length/4)
      // formula so the token_budget can be set to admit exactly one real
      // episode's tokens and no more.
      const content = 'widget calibration procedure delta revision ' + 'x'.repeat(400);
      await memoryWrite(db, { content, name: 'widget-delta', tags: ['widget-delta-tag'], project_path: '/test/project' });

      // addResult() (recall.ts) estimates tokens from
      // `[node.content, node.name, node.summary].filter(Boolean).join(' ')` —
      // node.summary is auto-populated by write-time enrichment (often equal
      // to the full content for short docs), so the real per-row token cost
      // is larger than `content` alone. Read the actual persisted row back
      // to size the budget against the true formula rather than guessing.
      const episodeRow = await db.executeGet<{ content: string | null; name: string | null; summary: string | null }>(
        `SELECT content, name, summary FROM node WHERE kind = 'episode' AND content = ?`,
        [content],
      );
      expect(episodeRow).toBeDefined();
      const episodeText = [episodeRow!.content, episodeRow!.name, episodeRow!.summary]
        .filter(Boolean)
        .join(' ');
      const episodeTokens = Math.ceil(episodeText.length / 4);

      // Budget = exactly the real episode's token cost + a small margin that
      // comfortably fits the entity's (name-only, content=null) tiny token
      // footprint — enough for "one real episode, plus room the bug would
      // spend on an entity row", but nowhere near two full episodes.
      const tokenBudget = episodeTokens + 40;

      const response = await memoryRecall(db, 'project', {
        query: 'widget calibration procedure delta',
        token_budget: tokenBudget,
        limit: 10,
      });

      expect(response.results.length).toBe(1);
      expect(response.results[0]!.content).not.toBeNull();
    } finally {
      await cleanup(db, dir);
    }
  });
});

// ── f2237d6d: score_breakdown must report 0 for a channel that contributed
//    nothing, not fabricate an equal share (recall.ts minMaxNorm) ────────────
//
// Root cause: `minMaxNorm()` (recall.ts) collapsed ANY constant array
// (range === mx - mn === 0) to `1.0` for every element, with no check on
// whether that constant value was itself 0. Two real scenarios hit this:
//   (a) the vec channel is skipped for the WHOLE recall (breaker open / embed
//       timeout) → every candidate's raw vec contribution is 0 → the whole
//       array is `[0, 0, ..., 0]` → range 0 → normalised to `[1.0, 1.0, ...]`
//       → score_breakdown reports a vec share that never existed.
//   (b) a single-candidate recall where that candidate never matched the vec
//       channel (e.g. its embedding hasn't landed yet) → array is `[0]` →
//       same collapse-to-1.0 bug → an "equal thirds" split across vec/bm25
//       /temporal even though vec contributed nothing.
// Fix: `minMaxNorm()` now distinguishes "every candidate tied on a genuine
// non-zero signal" (collapse to 1.0, unchanged) from "the channel's raw
// value is constantly 0" (collapse to 0). Ranking (`finalScore`/`score`,
// sort order) is untouched — it is driven by raw RRF magnitudes, never by
// the normalised breakdown values.
class ControllableEmbedProvider implements EmbeddingProvider {
  delayMs = 0;
  calls = 0;
  readonly metadata: EmbeddingProviderMetadata = {
    modelId: 'controllable-recall-breakdown-test',
    dimensions: 768,
    maxTokens: 512,
    isRemote: false,
    isDeterministic: true,
  };

  async embedSingle(text: string, _role?: EmbedRole): Promise<Float32Array> {
    this.calls++;
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
    return featureHashEmbed(text);
  }

  async *embedBatch(
    texts: string[],
    _opts?: { role?: EmbedRole; batchSize?: number },
  ): AsyncIterable<Float32Array> {
    for (const text of texts) {
      yield featureHashEmbed(text);
    }
  }

  async warmUp(_texts: string[]): Promise<void> {
    // no-op — test double, always "warm"
  }

  health(): EmbeddingHealth {
    return {
      configured: `test:${this.metadata.modelId}`,
      active: this.metadata.modelId,
      state: 'real',
      dimensions: this.metadata.dimensions,
      last_error: null,
    };
  }
}

describe('score_breakdown — absent channel contributes 0 (f2237d6d)', () => {
  describe('1) vec channel skipped for the whole recall (embed timeout → circuit open)', () => {
    const EMBED_TIMEOUT_MS = 40;
    const COOLDOWN_MS = 5000; // stay open for the duration of this test
    let ctx: { dir: string; dbPath: string; db: StoreAdapter };
    let provider: ControllableEmbedProvider;
    let priorAdapterEnv: string | undefined;
    let prevTimeout: string | undefined;
    let prevCooldown: string | undefined;

    beforeEach(async () => {
      priorAdapterEnv = process.env['STORE_ADAPTER'];
      process.env['STORE_ADAPTER'] = 'sqlite';
      prevTimeout = process.env['SOX_RECALL_EMBED_TIMEOUT_MS'];
      prevCooldown = process.env['SOX_RECALL_VEC_COOLDOWN_MS'];
      process.env['SOX_RECALL_EMBED_TIMEOUT_MS'] = String(EMBED_TIMEOUT_MS);
      process.env['SOX_RECALL_VEC_COOLDOWN_MS'] = String(COOLDOWN_MS);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-breakdown-vecfail-'));
      const dbPath = path.join(dir, 'm.db');
      const db = await openDb(dbPath);
      ctx = { dir, dbPath, db };
      await WriteQueue.clearInstances();
      WriteQueue.setBypass(false);
      provider = new ControllableEmbedProvider();
      _setEmbedProviderForTest(provider);
    });

    afterEach(async () => {
      await WriteQueue.clearInstances();
      await cleanup(ctx.db, ctx.dir);
      _setEmbedProviderForTest(new DeterministicTestProvider());
      // The per-process circuit breaker (recall.ts module-level state) is NOT
      // reset between tests by vitest (module scope survives within a file) —
      // without this, the circuit this test deliberately opened would leak
      // into every later test/describe block in this file that expects the
      // vec channel to actually run.
      __resetRecallVecCircuitForTest();
      if (prevTimeout === undefined) delete process.env['SOX_RECALL_EMBED_TIMEOUT_MS'];
      else process.env['SOX_RECALL_EMBED_TIMEOUT_MS'] = prevTimeout;
      if (prevCooldown === undefined) delete process.env['SOX_RECALL_VEC_COOLDOWN_MS'];
      else process.env['SOX_RECALL_VEC_COOLDOWN_MS'] = prevCooldown;
      if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
      else process.env['STORE_ADAPTER'] = priorAdapterEnv;
    });

    it('every result has vec===0, "vec" absent from provenance, and the channel sum invariant holds', async () => {
      // Seed with fast (no-delay) writes so the corpus itself has real vectors.
      provider.delayMs = 0;
      await memoryWrite(ctx.db, { content: 'alpine glacier retreat measurements', name: 'glacier-1', project_path: '/test/project' });
      await memoryWrite(ctx.db, { content: 'glacier ice core sample analysis', name: 'glacier-2', project_path: '/test/project' });
      await memoryWrite(ctx.db, { content: 'mountain glacier melt rate study', name: 'glacier-3', project_path: '/test/project' });

      // Force the QUERY embed for this recall to time out → circuit opens →
      // embedVecFailed=true for this call → every candidate's raw vec value
      // is 0 for the entire recall.
      provider.delayMs = EMBED_TIMEOUT_MS + 200;
      const response = await memoryRecall(ctx.db, 'project', {
        query: 'glacier melt measurements',
        limit: 10,
      });

      expect(response.results.length).toBeGreaterThan(0);
      expect(response.degradations ?? []).toEqual(
        expect.arrayContaining([expect.stringMatching(/^vec: /)]),
      );

      for (const result of response.results) {
        const { vec, bm25, temporal, total } = result.score_breakdown;
        expect(result.provenance).not.toContain('vec');
        expect(vec).toBe(0);
        expect(Math.abs(vec + bm25 + temporal - total)).toBeLessThan(1e-9);
        expect(Math.abs(total - result.score)).toBeLessThan(1e-9);
      }
    });
  });

  describe('2) single candidate with fts+temporal only (no vec row yet)', () => {
    let ctx: { dir: string; dbPath: string; db: StoreAdapter };
    let priorAdapterEnv: string | undefined;

    beforeEach(async () => {
      priorAdapterEnv = process.env['STORE_ADAPTER'];
      process.env['STORE_ADAPTER'] = 'sqlite';
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-breakdown-singlecand-'));
      const dbPath = path.join(dir, 'm.db');
      const db = await openDb(dbPath);
      ctx = { dir, dbPath, db };
      await WriteQueue.clearInstances();
      WriteQueue.setBypass(false);
    });

    afterEach(async () => {
      await WriteQueue.clearInstances();
      await cleanup(ctx.db, ctx.dir);
      // Genuine leak fixed here: STORE_ADAPTER was set unconditionally in
      // beforeEach but never restored, so it leaked 'sqlite' into every
      // later test/file in the same process. Mirror the sibling describe
      // block's afterEach above.
      if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
      else process.env['STORE_ADAPTER'] = priorAdapterEnv;
    });

    it('vec===0 and the split is NOT an equal three-way share', async () => {
      // Phase A only — committed, FTS-indexed, but NO vec row: this is the
      // single candidate in the whole DB, so every per-query min-max array
      // (vecRaw/ftsRaw/tempRaw) has length 1 → range === 0 for all three.
      const outcome = await memoryWritePhaseA(ctx.db, {
        content: 'quokka sanctuary breeding program annual report',
        name: 'quokka-report',
        project_path: '/test/project',
      });
      expect('code' in outcome).toBe(false);

      const response = await memoryRecall(ctx.db, 'project', {
        query: 'quokka sanctuary breeding',
        limit: 10,
      });

      expect(response.results.length).toBe(1);
      const result = response.results[0]!;
      expect(result.provenance).not.toContain('vec');
      expect(result.provenance).toContain('fts');

      const { vec, bm25, temporal, total } = result.score_breakdown;
      expect(vec).toBe(0);
      expect(total).toBeGreaterThan(0);
      expect(Math.abs(vec + bm25 + temporal - total)).toBeLessThan(1e-9);

      // The bug fabricated an equal three-way split (each channel === total/3)
      // even though vec never contributed. Assert the actual split is NOT
      // that degenerate equal-thirds pattern.
      const third = total / 3;
      expect(Math.abs(vec - third)).toBeGreaterThan(1e-6);
    });
  });

  describe('3) provenance <-> breakdown invariant over an ordinary mixed recall', () => {
    it('every channel absent from provenance reports exactly 0, present channels sum to total', async () => {
      const { db, dir } = await tmpDb();
      try {
        await memoryWrite(db, { content: 'coral reef bleaching event data', name: 'coral-1', project_path: '/test/project' });
        await memoryWrite(db, { content: 'coral reef temperature monitoring', name: 'coral-2', project_path: '/test/project' });
        await memoryWrite(db, { content: 'ocean acidification effects on coral', name: 'coral-3', project_path: '/test/project' });
        await memoryWrite(db, { content: 'unrelated topic about kitchen appliances', name: 'unrelated-1', project_path: '/test/project' });

        const response = await memoryRecall(db, 'project', {
          query: 'coral reef bleaching',
          limit: 10,
        });

        expect(response.results.length).toBeGreaterThan(0);

        // Preconditions: this test only proves the invariant over a genuinely
        // MIXED recall — not vacuously, e.g. if every channel happened to be
        // absent from every result (which would make every `if` below a
        // no-op). Assert the corpus actually exercises the vec channel AND
        // that at least one result is missing at least one channel.
        const rankedResults = response.results.filter(
          (r) => !(r.provenance.length === 1 && r.provenance[0] === 'graph'),
        );
        expect(rankedResults.some((r) => r.provenance.includes('vec'))).toBe(true);
        expect(
          rankedResults.some(
            (r) =>
              !r.provenance.includes('vec') ||
              !r.provenance.includes('fts') ||
              !r.provenance.includes('temporal'),
          ),
        ).toBe(true);

        for (const result of rankedResults) {
          const { vec, bm25, temporal, total } = result.score_breakdown;

          if (!result.provenance.includes('vec')) expect(vec).toBe(0);
          if (!result.provenance.includes('fts')) expect(bm25).toBe(0);
          if (!result.provenance.includes('temporal')) expect(temporal).toBe(0);

          expect(Math.abs(vec + bm25 + temporal - total)).toBeLessThan(1e-9);
          expect(Math.abs(total - result.score)).toBeLessThan(1e-9);
        }
      } finally {
        await cleanup(db, dir);
      }
    });
  });

  describe('4) ranking is unaffected by the breakdown normalisation fix', () => {
    /**
     * Real before/after fixture, not merely a repeat-call idempotency check.
     *
     * GOLDEN was captured against this exact corpus/query with a temporary
     * capture harness, run TWICE: once against the fixed `minMaxNorm()`
     * (`v === 0 ? 0 : 1.0`) and once against the pre-fix code
     * (`() => 1.0` unconditionally). Both runs produced the IDENTICAL name
     * order (sat-1, sat-4, sat-3, sat-2) and scores agreeing to ~1e-8 (the
     * residual delta is wall-clock recency drift between runs, not the fix —
     * see the channel-sum-invariant tests above for the same magnitude of
     * drift between two back-to-back calls of unmodified code). This proves
     * `finalScore`/`score` and sort order are driven by raw RRF magnitudes
     * (baseRrf × rerank), never by the normalised score_breakdown values the
     * fix changes — exactly as documented at recall.ts's ranked/breakdown
     * comment block (~L980-1004).
     */
    const GOLDEN: Array<{ name: string; score: number }> = [
      { name: 'sat-1', score: 0.019667005650027533 },
      { name: 'sat-4', score: 0.019574297922542356 },
      { name: 'sat-3', score: 0.019262670960423396 },
      { name: 'sat-2', score: 0.01896081140642256 },
    ];

    it('matches the golden name order and score magnitudes captured both with and without the minMaxNorm fix', async () => {
      const { db, dir } = await tmpDb();
      try {
        await memoryWrite(db, { content: 'satellite orbital mechanics and propulsion', name: 'sat-1', project_path: '/test/project' });
        await memoryWrite(db, { content: 'satellite communication link budget analysis', name: 'sat-2', project_path: '/test/project' });
        await memoryWrite(db, { content: 'rocket propulsion thermodynamics overview', name: 'sat-3', project_path: '/test/project' });
        await memoryWrite(db, { content: 'orbital debris tracking satellite network', name: 'sat-4', project_path: '/test/project' });

        const response = await memoryRecall(db, 'project', {
          query: 'satellite orbital propulsion',
          limit: 10,
        });

        expect(response.results.length).toBe(GOLDEN.length);

        const withNames = await Promise.all(
          response.results.map(async (r) => {
            const node = await db.executeGet<{ name: string | null }>('SELECT name FROM node WHERE uid = ?', [r.uid]);
            return { name: node?.name ?? null, score: r.score };
          }),
        );

        expect(withNames.map((r) => r.name)).toEqual(GOLDEN.map((g) => g.name));
        withNames.forEach((r, i) => {
          // Loose enough to absorb wall-clock recency drift between the
          // golden capture and this run, tight enough that a ranking-
          // affecting regression (e.g. normalisation leaking into score)
          // would still fail it.
          expect(r.score).toBeCloseTo(GOLDEN[i]!.score, 4);
        });
      } finally {
        await cleanup(db, dir);
      }
    });

    it('repeat calls against the same corpus are stable (order identical, score stable within fp/recency tolerance)', async () => {
      const { db, dir } = await tmpDb();
      try {
        await memoryWrite(db, { content: 'satellite orbital mechanics and propulsion', name: 'sat-1', project_path: '/test/project' });
        await memoryWrite(db, { content: 'satellite communication link budget analysis', name: 'sat-2', project_path: '/test/project' });
        await memoryWrite(db, { content: 'rocket propulsion thermodynamics overview', name: 'sat-3', project_path: '/test/project' });
        await memoryWrite(db, { content: 'orbital debris tracking satellite network', name: 'sat-4', project_path: '/test/project' });

        const params = { query: 'satellite orbital propulsion', limit: 10 };
        const first = await memoryRecall(db, 'project', params);
        const second = await memoryRecall(db, 'project', params);

        expect(first.results.length).toBeGreaterThan(0);
        expect(second.results.map((r) => r.uid)).toEqual(first.results.map((r) => r.uid));
        second.results.forEach((r, i) => {
          expect(r.score).toBeCloseTo(first.results[i]!.score, 6);
        });
      } finally {
        await cleanup(db, dir);
      }
    });
  });
});
