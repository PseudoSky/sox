/**
 * HF-3 — score_breakdown unit tests for hybrid-search.
 *
 * Acceptance criteria:
 *   (a) channel breakdown sums to the reported fused value within tolerance
 *   (b) normalised scores for two very different queries are on a comparable scale
 */
import { describe, it, expect } from 'vitest';
import { fuseWithBreakdown, fuse } from './index.js';
import type { FusionResultWithBreakdown } from './index.js';

const TOLERANCE = 1e-10;

// ── (a) breakdown sums to score ───────────────────────────────────────────────

describe('fuseWithBreakdown — channel sum invariant', () => {
  it('breakdown.total equals score for single-candidate text-only', () => {
    const results = fuseWithBreakdown([{ id: 1, textScore: 0.8 }]);
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(Math.abs(r.breakdown.total - r.score)).toBeLessThan(TOLERANCE);
  });

  it('breakdown.bm25 + breakdown.vec === breakdown.total for each result (hybrid)', () => {
    const candidates = [
      { id: 1, textScore: 0.9, vecScore: 0.85 },
      { id: 2, textScore: 0.5, vecScore: 0.95 },
      { id: 3, textScore: 0.1, vecScore: 0.2 },
    ];
    const results = fuseWithBreakdown(candidates);
    for (const r of results) {
      const channelSum = r.breakdown.bm25 + r.breakdown.vec;
      expect(Math.abs(channelSum - r.breakdown.total)).toBeLessThan(TOLERANCE);
      expect(Math.abs(r.breakdown.total - r.score)).toBeLessThan(TOLERANCE);
    }
  });

  it('breakdown.bm25 + breakdown.vec === score for vec-only candidates', () => {
    const candidates = [
      { id: 10, vecScore: 0.95 },
      { id: 11, vecScore: 0.6 },
      { id: 12, vecScore: 0.1 },
    ];
    const results = fuseWithBreakdown(candidates);
    for (const r of results) {
      expect(Math.abs(r.breakdown.bm25 + r.breakdown.vec - r.score)).toBeLessThan(TOLERANCE);
      // bm25 should be exactly 0 (channel absent)
      expect(r.breakdown.bm25).toBe(0);
    }
  });

  it('breakdown.bm25 + breakdown.vec === score for text-only candidates', () => {
    const candidates = [
      { id: 20, textScore: 0.7 },
      { id: 21, textScore: 0.4 },
    ];
    const results = fuseWithBreakdown(candidates);
    for (const r of results) {
      expect(Math.abs(r.breakdown.bm25 + r.breakdown.vec - r.score)).toBeLessThan(TOLERANCE);
      // vec should be exactly 0 (channel absent)
      expect(r.breakdown.vec).toBe(0);
    }
  });

  it('handles single candidate with both channels', () => {
    const results = fuseWithBreakdown([{ id: 1, textScore: 0.5, vecScore: 0.5 }]);
    const r = results[0]!;
    expect(Math.abs(r.breakdown.bm25 + r.breakdown.vec - r.breakdown.total)).toBeLessThan(TOLERANCE);
  });

  it('handles empty input', () => {
    const results = fuseWithBreakdown([]);
    expect(results).toHaveLength(0);
  });

  it('fuseWithBreakdown score === fuse() score for same inputs', () => {
    const candidates = [
      { id: 1, textScore: 0.9, vecScore: 0.85 },
      { id: 2, textScore: 0.5, vecScore: 0.95 },
      { id: 3, textScore: 0.1, vecScore: 0.2 },
    ];
    const fusedBaseline = fuse(candidates);
    const fusedBreakdown = fuseWithBreakdown(candidates);

    // Results must be in same order and same score
    const baselineMap = new Map(fusedBaseline.map((r) => [r.id, r.score]));
    for (const r of fusedBreakdown) {
      const baselineScore = baselineMap.get(r.id);
      expect(baselineScore).toBeDefined();
      expect(Math.abs(r.score - baselineScore!)).toBeLessThan(TOLERANCE);
    }
  });

  it('all channels are non-negative', () => {
    const candidates = [
      { id: 1, textScore: 0.9, vecScore: 0.85 },
      { id: 2, textScore: 0.5, vecScore: 0.95 },
      { id: 3, textScore: 0.1, vecScore: 0.2 },
    ];
    const results = fuseWithBreakdown(candidates);
    for (const r of results) {
      expect(r.breakdown.bm25).toBeGreaterThanOrEqual(0);
      expect(r.breakdown.vec).toBeGreaterThanOrEqual(0);
      expect(r.breakdown.total).toBeGreaterThanOrEqual(0);
    }
  });

  it('with custom weights, breakdown still sums to score', () => {
    const candidates = [
      { id: 1, textScore: 0.9, vecScore: 0.3 },
      { id: 2, textScore: 0.2, vecScore: 0.8 },
    ];
    const results = fuseWithBreakdown(candidates, {
      weights: { text: 2.0, vec: 0.5 },
    });
    for (const r of results) {
      const channelSum = r.breakdown.bm25 + r.breakdown.vec;
      expect(Math.abs(channelSum - r.score)).toBeLessThan(TOLERANCE);
    }
  });

  it('with z_score normalizer, breakdown still sums to score', () => {
    const candidates = [
      { id: 1, textScore: 0.9, vecScore: 0.85 },
      { id: 2, textScore: 0.5, vecScore: 0.5 },
      { id: 3, textScore: 0.1, vecScore: 0.2 },
    ];
    const results = fuseWithBreakdown(candidates, { normalizer: 'z_score' });
    for (const r of results) {
      const channelSum = r.breakdown.bm25 + r.breakdown.vec;
      expect(Math.abs(channelSum - r.score)).toBeLessThan(TOLERANCE);
    }
  });
});

// ── (b) cross-query score comparability ───────────────────────────────────────

describe('fuseWithBreakdown — cross-query score comparability', () => {
  /**
   * Two very different queries:
   *   Query A: highly competitive (many candidates with similar scores)
   *   Query B: winner-takes-all (one clear best, others far behind)
   *
   * With min-max normalization, both queries produce scores in [0, 1].
   * The top-ranked result from each query should be on a comparable scale
   * (both near 1.0 after fusion) rather than one being artificially inflated.
   */
  it('top-ranked scores from different query profiles are comparable (both <= 1)', () => {
    // Query A: competitive — all candidates within 0.1 of each other
    const queryACandidates = [
      { id: 1, textScore: 0.92, vecScore: 0.91 },
      { id: 2, textScore: 0.89, vecScore: 0.90 },
      { id: 3, textScore: 0.87, vecScore: 0.88 },
    ];
    const queryAResults = fuseWithBreakdown(queryACandidates);

    // Query B: winner-takes-all — top result massively outscores rest
    const queryBCandidates = [
      { id: 10, textScore: 0.99, vecScore: 0.98 },
      { id: 11, textScore: 0.10, vecScore: 0.08 },
      { id: 12, textScore: 0.02, vecScore: 0.01 },
    ];
    const queryBResults = fuseWithBreakdown(queryBCandidates);

    const topA = queryAResults[0]!;
    const topB = queryBResults[0]!;

    // Both should be in [0, 1] range (min-max normalization constraint)
    expect(topA.score).toBeGreaterThanOrEqual(0);
    expect(topA.score).toBeLessThanOrEqual(1.0 + TOLERANCE);
    expect(topB.score).toBeGreaterThanOrEqual(0);
    expect(topB.score).toBeLessThanOrEqual(1.0 + TOLERANCE);

    // Both top results should be near 1.0 (they are the best in their set)
    expect(topA.score).toBeGreaterThan(0.8);
    expect(topB.score).toBeGreaterThan(0.8);
  });

  it('last-ranked result from different queries both near 0 (comparably low)', () => {
    const queryACandidates = [
      { id: 1, textScore: 0.92, vecScore: 0.91 },
      { id: 2, textScore: 0.89, vecScore: 0.90 },
      { id: 3, textScore: 0.87, vecScore: 0.88 },
    ];
    const queryBCandidates = [
      { id: 10, textScore: 0.99, vecScore: 0.98 },
      { id: 11, textScore: 0.10, vecScore: 0.08 },
      { id: 12, textScore: 0.02, vecScore: 0.01 },
    ];
    const queryAResults = fuseWithBreakdown(queryACandidates);
    const queryBResults = fuseWithBreakdown(queryBCandidates);

    const lastA = queryAResults[queryAResults.length - 1]!;
    const lastB = queryBResults[queryBResults.length - 1]!;

    // Both lowest-ranked results should be at 0 (min-max: min → 0)
    expect(lastA.score).toBeCloseTo(0, 5);
    expect(lastB.score).toBeCloseTo(0, 5);
  });

  it('breakdown channels are proportional to signal presence', () => {
    // If only the text channel fires for a candidate, bm25 should dominate
    const candidates = [
      { id: 1, textScore: 0.9 },  // text-only
      { id: 2, vecScore: 0.9 },   // vec-only
    ];
    const results = fuseWithBreakdown(candidates);
    const textOnlyResult = results.find((r) => r.id === 1)!;
    const vecOnlyResult = results.find((r) => r.id === 2)!;

    // Text-only: vec should be 0
    expect(textOnlyResult.breakdown.vec).toBe(0);
    expect(textOnlyResult.breakdown.bm25).toBeGreaterThan(0);

    // Vec-only: bm25 should be 0
    expect(vecOnlyResult.breakdown.bm25).toBe(0);
    expect(vecOnlyResult.breakdown.vec).toBeGreaterThan(0);
  });

  it('fuseWithBreakdown result has correct TypeScript shape', () => {
    const results: FusionResultWithBreakdown[] = fuseWithBreakdown([
      { id: 1, textScore: 0.5, vecScore: 0.6 },
    ]);
    const r = results[0]!;
    expect(typeof r.id).toBe('number');
    expect(typeof r.score).toBe('number');
    expect(typeof r.breakdown.bm25).toBe('number');
    expect(typeof r.breakdown.vec).toBe('number');
    expect(typeof r.breakdown.total).toBe('number');
  });
});
