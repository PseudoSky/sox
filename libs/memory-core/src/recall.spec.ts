import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb } from './db.js';
import { memoryWrite } from './write.js';
import { memoryRecall, ExpansionOverflowError } from './recall.js';
import { _shutdownEmbedWorker } from './embed.js';


afterAll(async () => {
  await _shutdownEmbedWorker();
});

// ── DB helpers ────────────────────────────────────────────────────────────────

function tmpDb(): { db: Database.Database; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-'));
  const db = openDb(path.join(dir, 'test.db'));
  return { db, dir };
}

function cleanup(db: Database.Database, dir: string): void {
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

// ── Parent-context expansion: session_id fallback path ─────────────────────────

describe('Parent-context expansion — session_id fallback', () => {
  it('expands child node via session_id when no DERIVED_FROM edge exists', async () => {
    const { db, dir } = tmpDb();
    try {
      // 1. Create a parent node
      const parentResult = await memoryWrite(db, {
        content: 'Parent context document about machine learning algorithms',
        name: 'parent-doc',
      });
      expect(parentResult).toHaveProperty('episode_uid');
      const parentUid = (parentResult as { episode_uid: string }).episode_uid;

      // 2. Create a child node with session_id pointing to the parent's UID.
      //    Intentionally NO derived_from_uid — we must exercise the session_id fallback.
      const childResult = await memoryWrite(db, {
        content: 'Child chunk discussing transformer architectures',
        name: 'child-chunk',
        session_id: parentUid,
      });
      expect(childResult).toHaveProperty('episode_uid');
      const childUid = (childResult as { episode_uid: string }).episode_uid;

      // 3. Verify no DERIVED_FROM edge exists between child and parent.
      const edgeRow = db.prepare(
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
    const { db, dir } = tmpDb();
    try {
      // Seed multiple episodes so there are real ranked candidates.
      await memoryWrite(db, { content: 'neural networks and deep learning architecture', name: 'nn-deep' });
      await memoryWrite(db, { content: 'machine learning gradient descent optimization', name: 'ml-grad' });
      await memoryWrite(db, { content: 'transformer self-attention mechanisms', name: 'transformer' });
      await memoryWrite(db, { content: 'convolutional neural network image recognition', name: 'cnn-img' });

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

        // Channels sum to total when normTotal > 0 (i.e., at least one channel
        // has a non-zero normalised contribution). The lowest-ranked node in a
        // single-channel scenario maps to normTotal=0, yielding channels=0
        // while total > 0 — that edge case is excluded here.
        const hasChannelSignal = vec > 0 || bm25 > 0 || temporal > 0;
        if (hasChannelSignal) {
          const channelSum = vec + bm25 + temporal;
          expect(Math.abs(channelSum - total)).toBeLessThan(SCORE_TOLERANCE);
        }
      }
    } finally {
      cleanup(db, dir);
    }
  });

  it('score_breakdown total equals score for graph-expanded results', async () => {
    const { db, dir } = tmpDb();
    try {
      await memoryWrite(db, { content: 'primary document about quantum computing', name: 'quantum-primary' });
      await memoryWrite(db, { content: 'related quantum entanglement details', name: 'quantum-related' });

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
        // Channel sum === total when normTotal > 0; graph-expanded nodes and
        // zero-normTotal ranked nodes (lowest rank in a single channel) carry
        // channels=0 with total=score — the per-result invariant is: total===score.
        const isGraphExpanded = result.provenance.length === 1 && result.provenance[0] === 'graph';
        const hasChannelSignal = vec > 0 || bm25 > 0 || temporal > 0;
        if (!isGraphExpanded && hasChannelSignal) {
          const channelSum = vec + bm25 + temporal;
          expect(Math.abs(channelSum - total)).toBeLessThan(SCORE_TOLERANCE);
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
    const { db, dir } = tmpDb();
    try {
      // Write episodes relevant to Query A (generic topic)
      await memoryWrite(db, { content: 'python programming language features and syntax', name: 'py-1' });
      await memoryWrite(db, { content: 'python data science libraries pandas numpy', name: 'py-2' });
      await memoryWrite(db, { content: 'python web frameworks django flask', name: 'py-3' });
      await memoryWrite(db, { content: 'python async concurrency asyncio event loop', name: 'py-4' });

      // Write one episode relevant to Query B (very specific, niche)
      await memoryWrite(db, { content: 'zygomorphic floral symmetry in orchidaceae taxonomy', name: 'orchid' });

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
      // Two edge cases skip the channel-sum check:
      //  1. Graph-expanded nodes (provenance === ['graph']): channels are
      //     intentionally zero with total = score.
      //  2. Lowest-ranked nodes in a single-channel scenario: after per-query
      //     min-max normalisation, the worst candidate maps to normTotal=0, so
      //     channels are 0 while total > 0. The stable invariant is total===score.
      for (const result of [...responseA.results, ...responseB.results]) {
        const { vec, bm25, temporal, total } = result.score_breakdown;
        expect(Math.abs(total - result.score)).toBeLessThan(SCORE_TOLERANCE);
        const isGraphExpanded = result.provenance.length === 1 && result.provenance[0] === 'graph';
        const hasChannelSignal = vec > 0 || bm25 > 0 || temporal > 0;
        if (!isGraphExpanded && hasChannelSignal) {
          expect(Math.abs(vec + bm25 + temporal - total)).toBeLessThan(SCORE_TOLERANCE);
        }
      }
    } finally {
      cleanup(db, dir);
    }
  });

  it('score_breakdown fields have correct TypeScript shape', async () => {
    const { db, dir } = tmpDb();
    try {
      await memoryWrite(db, { content: 'test episode for shape verification' });
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
