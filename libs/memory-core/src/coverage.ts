/**
 * coverage.ts — D-C primitive (c): coverage-aware retrieval.
 *
 * ## The obligation
 *
 * A retriever that returns "the nearest thing held" for a query the store does
 * not cover is silently wrong: it manufactures a confident answer where the
 * honest one is "I have nothing in scope". This module is the boundary check
 * that makes absence first-class — the retriever either answers, or ABSTAINS and
 * names why, so the gap is visible and actionable instead of invisible.
 *
 * ## Cheap, model-agnostic signals (D-C spec §D4.3)
 *
 * The signals are computed from a normal retriever's own output — no second
 * model, no extra embedding:
 *   - `max_similarity`          — the top candidate's absolute similarity (the
 *                                 raw vector `1 − cosine_distance` when the vec
 *                                 channel ran; the fused score otherwise);
 *   - `distribution_flatness`   — topK_min / topK_max ∈ [0,1] (1 = flat);
 *   - `topk_entropy`            — normalised Shannon entropy of softmax(topK)
 *                                 ∈ [0,1] (1 = uniform);
 *   - `decay_rate`              — (top1 − topK) / top1 ∈ [0,1].
 *
 * ## Policy, not a constant (ADR-0013)
 *
 * Every threshold is a typed field on {@link KnowledgeConfig}; the shipped
 * defaults are permissive (abstain only on the clearest no-coverage case — an
 * empty set; each signal default sits outside its own signal range so it is
 * disabled until tuned) and `threshold_source` on every envelope NAMES the
 * config field that decided the verdict. Threshold calibration against a
 * labeled query set is a tuning decision, logged on the envelope — never an env
 * var.
 *
 * ## Negative control
 *
 * `coverage.spec.ts` asserts the abstention invariant unconditionally; a
 * deliberately-always-answer variant (the pre-fix shape) returns a candidate
 * where the real assessor abstains, turning the assertion RED. That proves the
 * boundary check is load-bearing.
 */

import type { KnowledgeConfig } from './config.js';

export type CoverageReason =
  | 'no-coverage'
  | 'flat-distribution'
  | 'high-entropy'
  | 'fast-decay';

export interface CoverageSignals {
  /** Top candidate's absolute similarity (see module doc). */
  max_similarity: number;
  /** topK_min / topK_max ∈ [0,1]; 1 = perfectly flat. */
  distribution_flatness: number;
  /** Normalised Shannon entropy of softmax(topK) ∈ [0,1]; 1 = uniform. */
  topk_entropy: number;
  /** (top1 − topK) / top1 ∈ [0,1]. */
  decay_rate: number;
}

export interface CoverageEnvelope {
  /** True when the retriever refused to answer (results are empty). */
  abstained: boolean;
  /** Present iff `abstained`. */
  reason?: CoverageReason;
  signals: CoverageSignals;
  /**
   * Names the typed config field that decided the verdict (ADR-0013 D2). On
   * abstention this is the first threshold that fired; on a pass it is
   * `'coverage:no-threshold-exceeded'`. Never a constant "ok" with no source.
   */
  threshold_source: string;
}

/** The minimal per-candidate shape assessCoverage needs. */
export interface CoverageCandidate {
  score: number;
}

export interface CoverageOptions {
  /**
   * The top candidate's ABSOLUTE similarity (raw `1 − cosine_distance`), when
   * the vec channel produced one. When null/absent, the fused top score is used
   * as a weaker proxy — the envelope's `max_similarity` reports whichever was
   * used, so a caller can tell.
   */
  topSimilarity?: number | null | undefined;
}

/** How many top candidates the distribution signals look at. */
export const COVERAGE_TOPK = 10;

/**
 * Normalised Shannon entropy of `softmax(values)` — 0 when one value dominates,
 * 1 when the distribution is uniform. Empty/single-value input yields 0.
 */
export function normalizedEntropy(values: readonly number[]): number {
  const n = values.length;
  if (n <= 1) return 0;
  const max = Math.max(...values);
  // softmax with max-subtraction for numerical stability.
  const exps = values.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return 0;
  const probs = exps.map((e) => e / sum);
  let h = 0;
  for (const p of probs) {
    if (p > 0) h -= p * Math.log(p);
  }
  return h / Math.log(n);
}

/**
 * PURE over the candidate set. Assesses whether `candidates` show any coverage
 * of the query, and abstains when they do not. Never reads a store, never calls
 * a model.
 *
 * Decision order (first match wins; the reason names it):
 *   1. empty candidate set                → `no-coverage`
 *   2. abs similarity < minMaxSimilarity  → `no-coverage`
 *   3. flatness > maxFlatness             → `flat-distribution`
 *   4. entropy > maxEntropy               → `high-entropy`
 *   5. decay > maxDecay                   → `fast-decay`
 *   else                                  → not abstained
 */
export function assessCoverage(
  candidates: readonly CoverageCandidate[],
  cfg: KnowledgeConfig,
  opts: CoverageOptions = {},
): CoverageEnvelope {
  const top = candidates
    .map((c) => c.score)
    .filter((s) => Number.isFinite(s))
    .sort((a, b) => b - a)
    .slice(0, COVERAGE_TOPK);

  const top1 = top.length > 0 ? top[0]! : 0;
  const topK = top.length > 0 ? top[top.length - 1]! : 0;

  const rawTop =
    opts.topSimilarity !== undefined && opts.topSimilarity !== null
      ? opts.topSimilarity
      : top1;

  const signals: CoverageSignals = {
    max_similarity: rawTop,
    distribution_flatness: top1 > 0 ? topK / top1 : 1,
    topk_entropy: normalizedEntropy(top),
    decay_rate: top1 > 0 ? (top1 - topK) / top1 : 0,
  };

  if (candidates.length === 0) {
    return { abstained: true, reason: 'no-coverage', signals, threshold_source: 'coverage.minMaxSimilarity' };
  }
  if (signals.max_similarity < cfg.coverage.minMaxSimilarity) {
    return { abstained: true, reason: 'no-coverage', signals, threshold_source: 'coverage.minMaxSimilarity' };
  }
  if (signals.distribution_flatness > cfg.coverage.maxFlatness) {
    return { abstained: true, reason: 'flat-distribution', signals, threshold_source: 'coverage.maxFlatness' };
  }
  if (signals.topk_entropy > cfg.coverage.maxEntropy) {
    return { abstained: true, reason: 'high-entropy', signals, threshold_source: 'coverage.maxEntropy' };
  }
  if (signals.decay_rate > cfg.coverage.maxDecay) {
    return { abstained: true, reason: 'fast-decay', signals, threshold_source: 'coverage.maxDecay' };
  }
  return { abstained: false, signals, threshold_source: 'coverage:no-threshold-exceeded' };
}
