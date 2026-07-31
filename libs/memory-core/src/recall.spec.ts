import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb } from './db.js';
import { memoryWrite } from './write.js';
import { memoryRecall, ExpansionOverflowError } from './recall.js';
import { _shutdownEmbedWorker } from './embed.js';

/**
 * BL-325: openDb() returns a StoreAdapter, not a raw better-sqlite3 handle.
 * These specs' own verification reads use raw SQL against the sqlite backend,
 * so unwrap once here rather than rewriting every assertion.
 */
function raw(a: StoreAdapter): Database.Database {
  return a.unwrap() as Database.Database;
}


afterAll(async () => {
  await _shutdownEmbedWorker();
});

// ── DB helpers ────────────────────────────────────────────────────────────────

async function tmpDb(): Promise<{ db: StoreAdapter; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-'));
  const db = await openDb(path.join(dir, 'test.db'));
  return { db, dir };
}

function cleanup(db: StoreAdapter, dir: string): void {
  try { db.close(); } catch { /* ignore */ }
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
      cleanup(db, dir);
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
      cleanup(db, dir);
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
      cleanup(db, dir);
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
      cleanup(db, dir);
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
      const edgeRow = raw(db).prepare(
        `SELECT e.rowid FROM edge e
         JOIN node n_src ON n_src.rowid = e.src
         JOIN node n_dst ON n_dst.rowid = e.dst
         WHERE n_src.uid = ? AND n_dst.uid = ? AND e.rel = 'DERIVED_FROM' AND e.t_expired IS NULL`,
      ).get(childUid, parentUid);
      expect(edgeRow).toBeUndefined();

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
      expect(childResultEntry!.expansionSources[0].depth).toBe(0);
      expect(childResultEntry!.expansionSources[0].chunk.uid).toBe(childUid);
      expect(childResultEntry!.expansionSources[1].depth).toBe(1);
      expect(childResultEntry!.expansionSources[1].chunk.uid).toBe(parentUid);
      expect(childResultEntry!.expansionSources[1].chunk.content).toContain('machine learning');
    } finally {
      cleanup(db, dir);
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
      cleanup(db, dir);
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
      cleanup(db, dir);
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
      raw(db).prepare(`UPDATE node SET t_created = ? WHERE uid = ?`).run(tenDaysAgo, aUid);

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
      cleanup(db, dir);
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
      cleanup(db, dir);
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
      cleanup(db, dir);
    }
  });
});
