import type { VectorBackend } from '@adhd/sox-vector-store';
import type { GraphBackend } from '@adhd/sox-graph-store';
import type { NodeRecord, NodeFilter } from '@adhd/sox-graph-store';
import { buildFilterClause } from './filter-utils.js';

export { buildFilterClause } from './filter-utils.js';
export { createCrossEncoder } from './cross-encoder.js';
export type {
  CrossEncoder,
  CrossEncoderMetadata,
  CrossEncoderConfig,
  CrossEncoderRerankerConfig,
} from './cross-encoder.js';

export type { VectorBackend, VectorSpace, VecFilter } from '@adhd/sox-vector-store';
export type { GraphBackend, NodeRecord, NodeFilter } from '@adhd/sox-graph-store';

// ── Public interfaces ─────────────────────────────────────────────────────────

/**
 * FEAT-022 — a RANK signal (fused via reciprocal-rank fusion). `kind` names the
 * channel; `weight` (default 1.0) scales that channel's RRF contribution as
 * `Σ w_i / (RRF_K + rank_i)`. Rank signals are the ONLY things RRF fuses —
 * continuous scores (e.g. recency) are NOT rank signals and never enter the
 * RRF term (they are a post-fusion rescore, {@link ContinuousSignalSpec}).
 */
export interface SignalSpec {
  kind: 'text' | 'vec';
  weight?: number;
}

/**
 * FEAT-022 — a CONTINUOUS signal, applied as a post-fusion rescore (never a
 * peer RRF term). `kind: 'temporal'` rescales the fused score by a recency
 * factor that decays with the candidate's age; `decay` is the decay rate per
 * hour (higher = older items fall off faster). Monotonic in recency: all else
 * equal, newer ranks higher.
 */
export interface ContinuousSignalSpec {
  kind: 'temporal';
  decay?: number;
}

export interface SearchQuery {
  text?: string;
  vec?: Float32Array;
  /** FEAT-022 — rank signals to fuse via RRF. Default: [{text}, {vec}] (one per present input). */
  signals?: SignalSpec[];
  /** FEAT-022 — continuous signals applied AFTER rank-signal fusion. Default: none. */
  rescore?: ContinuousSignalSpec[];
  filters?: Record<string, unknown>;
}

/**
 * Signals that a query's stated filters could not be fully honored (BL-294) — e.g. a
 * filter key with no mapping onto the backing store's queryable fields. Callers should
 * treat a search flagged `degraded` as scoped more loosely than requested, not as an error
 * (per the "never error on a missing signal" invariant).
 */
export interface SearchDegradeInfo {
  unsupportedFilters: string[];
}

export interface SearchBackend {
  search(
    query: SearchQuery,
    limit: number,
  ): Promise<Array<{
    id: number;
    textScore?: number;
    vecScore?: number;
    fields: Record<string, unknown>;
    degraded?: SearchDegradeInfo;
  }>>;
}

export interface StoreSearchOpts {
  fieldWeights?: Record<string, number>;
}

export interface SearchOpts {
  normalizer?: 'min_max' | 'L2' | 'z_score';
  explain?: boolean;
  limit?: number;
}

export interface SearchResult {
  id: number;
  score: number;
  signalScores?: { text?: number; vec?: number } | undefined;
  fields: Record<string, unknown>;
  degraded?: SearchDegradeInfo | undefined;
}

export interface FusionOpts {
  normalizer?: 'min_max' | 'L2' | 'z_score';
  weights?: { text?: number; vec?: number };
}

/**
 * Per-channel contribution breakdown for a single fused result.
 *
 * All channel values are non-negative and sum to `total`, which equals the
 * fused score returned in the parent result.  Missing channels (signal not
 * present for this candidate) are 0.
 *
 * Normalization context: every channel is first independently normalised
 * across all candidates (same method as the parent `fuse()` call), then
 * weighted and divided by the total active weight so the final score lives
 * in [0, 1] for min_max/L2 normalisers.  The per-channel values are that
 * weighted-normalised contribution — they are proportional to their share of
 * the fused score, and their sum equals `total` exactly (within fp tolerance).
 */
export interface FusionBreakdown {
  /** Weighted normalised contribution from the BM25 / text channel. */
  bm25: number;
  /** Weighted normalised contribution from the vector / cosine channel. */
  vec: number;
  /** Sum of all channel contributions — equals the fused score for this result. */
  total: number;
}

/**
 * Extended result returned by `fuseWithBreakdown()`.
 * `score` is byte-identical to what `fuse()` would return; `breakdown` is
 * additive (breakdown.bm25 + breakdown.vec === breakdown.total === score).
 */
export interface FusionResultWithBreakdown {
  id: number;
  score: number;
  breakdown: FusionBreakdown;
}

// ── Pure functions (zero storage deps) ────────────────────────────────────────

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
  }
  return sum / values.length;
}

function stddev(values: number[], avg: number): number {
  if (values.length <= 1) return 0;
  let sumSqDiff = 0;
  for (let i = 0; i < values.length; i++) {
    const diff = values[i]! - avg;
    sumSqDiff += diff * diff;
  }
  return Math.sqrt(sumSqDiff / (values.length - 1));
}

export function normalize(
  scores: number[],
  method: 'min_max' | 'L2' | 'z_score',
): number[] {
  if (scores.length === 0) return [];

  switch (method) {
    case 'min_max': {
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < scores.length; i++) {
        const s = scores[i]!;
        if (s < min) min = s;
        if (s > max) max = s;
      }
      if (max === min) {
        return scores.map(() => 1.0);
      }
      const range = max - min;
      return scores.map((s) => (s - min) / range);
    }
    case 'L2': {
      let sumSq = 0;
      for (let i = 0; i < scores.length; i++) {
        sumSq += scores[i]! * scores[i]!;
      }
      const norm = Math.sqrt(sumSq);
      if (norm === 0) return scores.map(() => 0);
      return scores.map((s) => s / norm);
    }
    case 'z_score': {
      const avg = mean(scores);
      const sd = stddev(scores, avg);
      if (sd === 0) return scores.map(() => 0.0);
      return scores.map((s) => (s - avg) / sd);
    }
  }
}

export function fuse(
  candidates: Array<{ id: number; textScore?: number; vecScore?: number }>,
  opts?: FusionOpts,
): Array<{ id: number; score: number }> {
  if (candidates.length === 0) return [];

  const normalizer = opts?.normalizer ?? 'min_max';
  const textWeight = opts?.weights?.text ?? 1.0;
  const vecWeight = opts?.weights?.vec ?? 1.0;

  const textIndices: number[] = [];
  const textVals: number[] = [];
  const vecIndices: number[] = [];
  const vecVals: number[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    if (c.textScore !== undefined) {
      textIndices.push(i);
      textVals.push(c.textScore);
    }
    if (c.vecScore !== undefined) {
      vecIndices.push(i);
      vecVals.push(c.vecScore);
    }
  }

  const textNormVals = normalize(textVals, normalizer);
  const vecNormVals = normalize(vecVals, normalizer);

  const textNormMap = new Map<number, number>();
  for (let j = 0; j < textIndices.length; j++) {
    const idx = textIndices[j]!;
    const val = textNormVals[j]!;
    textNormMap.set(idx, val);
  }
  const vecNormMap = new Map<number, number>();
  for (let j = 0; j < vecIndices.length; j++) {
    const idx = vecIndices[j]!;
    const val = vecNormVals[j]!;
    vecNormMap.set(idx, val);
  }

  const results: Array<{ id: number; score: number }> = [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    let score = 0;
    let totalWeight = 0;

    const tn = textNormMap.get(i);
    if (tn !== undefined) {
      score += textWeight * tn;
      totalWeight += textWeight;
    }
    const vn = vecNormMap.get(i);
    if (vn !== undefined) {
      score += vecWeight * vn;
      totalWeight += vecWeight;
    }

    results.push({
      id: candidate.id,
      score: totalWeight > 0 ? score / totalWeight : 0,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Same fusion algorithm as `fuse()` but also returns a per-channel breakdown
 * for every result.  The `score` field is byte-identical to `fuse()`'s output;
 * `breakdown.bm25 + breakdown.vec === breakdown.total === score` within
 * floating-point tolerance (< 1e-10).
 *
 * Algorithm (matches `fuse()` exactly — never diverge):
 *   1. Collect raw text / vec scores from candidates.
 *   2. Normalise each channel independently with the chosen normaliser.
 *   3. For each candidate compute:
 *        textContrib = textWeight × normText   (0 if channel absent)
 *        vecContrib  = vecWeight  × normVec    (0 if channel absent)
 *        totalWeight = sum of weights for present channels
 *        score = (textContrib + vecContrib) / totalWeight
 *   4. Breakdown stores the per-weight, per-totalWeight contributions so they
 *      sum to score: bm25 = textContrib / totalWeight, vec = vecContrib / totalWeight.
 */
export function fuseWithBreakdown(
  candidates: Array<{ id: number; textScore?: number; vecScore?: number }>,
  opts?: FusionOpts,
): FusionResultWithBreakdown[] {
  if (candidates.length === 0) return [];

  const normalizer = opts?.normalizer ?? 'min_max';
  const textWeight = opts?.weights?.text ?? 1.0;
  const vecWeight = opts?.weights?.vec ?? 1.0;

  const textIndices: number[] = [];
  const textVals: number[] = [];
  const vecIndices: number[] = [];
  const vecVals: number[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    if (c.textScore !== undefined) {
      textIndices.push(i);
      textVals.push(c.textScore);
    }
    if (c.vecScore !== undefined) {
      vecIndices.push(i);
      vecVals.push(c.vecScore);
    }
  }

  const textNormVals = normalize(textVals, normalizer);
  const vecNormVals = normalize(vecVals, normalizer);

  const textNormMap = new Map<number, number>();
  for (let j = 0; j < textIndices.length; j++) {
    textNormMap.set(textIndices[j]!, textNormVals[j]!);
  }
  const vecNormMap = new Map<number, number>();
  for (let j = 0; j < vecIndices.length; j++) {
    vecNormMap.set(vecIndices[j]!, vecNormVals[j]!);
  }

  const results: FusionResultWithBreakdown[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    let textContrib = 0;
    let vecContrib = 0;
    let totalWeight = 0;

    const tn = textNormMap.get(i);
    if (tn !== undefined) {
      textContrib = textWeight * tn;
      totalWeight += textWeight;
    }
    const vn = vecNormMap.get(i);
    if (vn !== undefined) {
      vecContrib = vecWeight * vn;
      totalWeight += vecWeight;
    }

    const score = totalWeight > 0 ? (textContrib + vecContrib) / totalWeight : 0;
    // Scale each channel contribution by the same divisor so they sum to score.
    const bm25 = totalWeight > 0 ? textContrib / totalWeight : 0;
    const vec = totalWeight > 0 ? vecContrib / totalWeight : 0;

    results.push({
      id: candidate.id,
      score,
      breakdown: { bm25, vec, total: score },
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

// ── FEAT-022 — N-signal reciprocal-rank fusion + temporal rescore ─────────────

/** RRF smoothing constant (k). Matches memory-core's `RRF_K` so a 3-channel
 *  cutover produces the same rank magnitudes. */
export const RRF_K = 60;

/** RRF per-signal contribution for a 1-based rank: `1 / (RRF_K + rank)`. */
export function rrfScore(rank: number): number {
  return 1 / (RRF_K + rank);
}

/**
 * FEAT-022 — N-signal reciprocal-rank fusion. Each signal contributes an
 * ordered id list (index 0 = best → rank 1); the fused score is the weighted
 * sum `Σ w_i / (RRF_K + rank_i)` over the signals that produced that id.
 * Returns results sorted by fused score descending. This is rank-based, not
 * score-based — it only ever sees ranks, so a continuous value (recency) can
 * never be smuggled in as a peer signal.
 */
export function rrfFuse(
  rankedIdsBySignal: Map<string, number[]>,
  weights: Map<string, number>,
): Array<{ id: number; score: number }> {
  const scoreMap = new Map<number, number>();
  for (const [signal, ids] of rankedIdsBySignal) {
    const w = weights.get(signal) ?? 1.0;
    ids.forEach((id, idx) => {
      const rank = idx + 1; // 1-based
      scoreMap.set(id, (scoreMap.get(id) ?? 0) + w * rrfScore(rank));
    });
  }
  return [...scoreMap.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

/**
 * FEAT-022 — temporal (recency) rescore, applied AFTER rank-signal fusion.
 * Multiplies each fused score by `1 + exp(-decay * ageHours)` so a fresh
 * candidate (age 0) gains up to a +1.0 boost that decays exponentially with
 * age. Monotonic in recency. Ids with no known creation time are left
 * unchanged (no fabricated recency).
 */
export function temporalRescore(
  results: Array<{ id: number; score: number }>,
  recencyMs: Map<number, number>,
  decay?: number,
  nowMs?: number,
): Array<{ id: number; score: number }> {
  if (decay === undefined || decay === 0) return results;
  const now = nowMs ?? Date.now();
  return results.map((r) => {
    const created = recencyMs.get(r.id);
    if (created === undefined) return r;
    const ageHours = Math.max(0, (now - created) / 3_600_000);
    const recency = Math.exp(-decay * ageHours);
    return { id: r.id, score: r.score * (1 + recency) };
  });
}

/** FEAT-022 — default rank signals: one per present input (text, vec), in that order. */
function defaultSignals(query: SearchQuery): SignalSpec[] {
  const signals: SignalSpec[] = [];
  if (query.text !== undefined && query.text.length > 0) signals.push({ kind: 'text' });
  if (query.vec !== undefined) signals.push({ kind: 'vec' });
  return signals;
}

// ── Top-level search ──────────────────────────────────────────────────────────

function topicBoost(
  queryText: string | undefined,
  fields: Record<string, unknown>,
): number {
  if (!queryText || typeof fields.topic !== 'string') return 1.0;
  const lowerQuery = queryText.toLowerCase();
  const topic = fields.topic.toLowerCase();
  if (topic === lowerQuery) return 2.0;
  if (topic.includes(lowerQuery)) return 1.5;
  return 1.0;
}

// BL-437: topicBoost() is applied multiplicatively (per this package's invariant —
// field boosting is never additive/scale-blind). Under min_max normalisation the
// lowest-scoring candidate in ANY result set maps to exactly 0, and boost * 0 === 0
// regardless of boost — so the last-placed candidate was structurally un-boostable,
// and in a 2-candidate set the loser (always the min) could never be reordered at
// all. Fixed by flooring the normalised fused score at TOPIC_BOOST_FLOOR before the
// multiplicative boost is applied, so a literal-zero floor no longer defeats every
// multiplicative modifier applied downstream of fusion.
//
// TOPIC_BOOST_FLOOR = 0.1 chosen from a synthetic A/B across representative
// candidate-count / score-distribution shapes (linear-5/10, clustered-top, near-
// uniform, close/far 2-candidate) measuring, for each epsilon in
// {0, 0.01, 0.02, 0.05, 0.1, 0.15, 0.2}, whether a 2.0x exact-topic-match boost on
// the floor candidate overtakes its immediate higher-ranked neighbor:
//   - eps <= 0.02: never overtakes any scenario tested — too small to matter, the
//     defect would remain effectively unfixed.
//   - eps = 0.1: overtakes in multi-candidate sets (5-10+) where the neighbor's
//     margin above the floor is small (the common "long tail" shape), while leaving
//     every non-floor score untouched (only candidates AT the exact 0 floor are
//     affected) and never letting a boosted floor candidate overtake a genuine
//     2-candidate winner (which always normalises to exactly 1.0 — would need
//     eps > 0.5 to flip, which was deliberately rejected as too aggressive).
//   - eps >= 0.15: starts overtaking in wider-margin scenarios too, growing the
//     blast radius of the change without a clear additional benefit measured here.
// This is a synthetic measurement (representative score-distribution shapes), not
// a live-traffic A/B — no production recall query log was available in this
// environment. If real recall telemetry becomes available, re-validate against it.
const TOPIC_BOOST_FLOOR = 0.1;

export async function search(
  backend: SearchBackend,
  query: SearchQuery,
  opts?: SearchOpts,
): Promise<SearchResult[]> {
  const limit = opts?.limit ?? 20;
  const explain = opts?.explain ?? false;
  const normalizer = opts?.normalizer ?? 'min_max';

  const fetchLimit = Math.max(limit * 2, 20);
  const candidates = await backend.search(query, fetchLimit);

  // A query-level degrade signal (BL-294) — one query's filters either apply or they
  // don't, so every candidate from a single backend.search() call carries the same
  // `degraded` value; take it from the first candidate that has one.
  const queryDegraded = candidates.find((c) => c.degraded !== undefined)?.degraded;

  const textPresent = query.text !== undefined && query.text.length > 0;
  const vecPresent = query.vec !== undefined;

  let fused: Array<{ id: number; score: number }>;
  const signalScoresMap = new Map<number, { text?: number; vec?: number }>();

  if (textPresent && vecPresent) {
    const fusionCandidates: Array<{ id: number; textScore?: number; vecScore?: number }> = [];
    for (const c of candidates) {
      const scores: { text?: number; vec?: number } = {};
      if (c.textScore !== undefined) scores.text = c.textScore;
      if (c.vecScore !== undefined) scores.vec = c.vecScore;
      signalScoresMap.set(c.id, scores);

      const fc: { id: number; textScore?: number; vecScore?: number } = { id: c.id };
      if (c.textScore !== undefined) fc.textScore = c.textScore;
      if (c.vecScore !== undefined) fc.vecScore = c.vecScore;
      fusionCandidates.push(fc);
    }
    fused = fuse(fusionCandidates, { normalizer });
  } else if (textPresent) {
    const textCandidates = candidates.filter((c) => c.textScore !== undefined);
    if (textCandidates.length > 0) {
      const textScoresRaw = textCandidates.map((c) => c.textScore!);
      const textNorm = normalize(textScoresRaw, normalizer);
      const normMap = new Map<number, number>();
      for (let i = 0; i < textCandidates.length; i++) {
        normMap.set(textCandidates[i]!.id, textNorm[i]!);
      }
      fused = candidates.map((c) => {
        const scores: { text?: number; vec?: number } = {};
        if (c.textScore !== undefined) scores.text = c.textScore;
        signalScoresMap.set(c.id, scores);
        return { id: c.id, score: normMap.get(c.id) ?? 0 };
      });
    } else {
      fused = candidates.map((c) => {
        signalScoresMap.set(c.id, {});
        return { id: c.id, score: 0 };
      });
    }
  } else if (vecPresent) {
    const vecCandidates = candidates.filter((c) => c.vecScore !== undefined);
    if (vecCandidates.length > 0) {
      const vecScoresRaw = vecCandidates.map((c) => c.vecScore!);
      const vecNorm = normalize(vecScoresRaw, normalizer);
      const normMap = new Map<number, number>();
      for (let i = 0; i < vecCandidates.length; i++) {
        normMap.set(vecCandidates[i]!.id, vecNorm[i]!);
      }
      fused = candidates.map((c) => {
        const scores: { text?: number; vec?: number } = {};
        if (c.vecScore !== undefined) scores.vec = c.vecScore;
        signalScoresMap.set(c.id, scores);
        return { id: c.id, score: normMap.get(c.id) ?? 0 };
      });
    } else {
      fused = candidates.map((c) => {
        signalScoresMap.set(c.id, {});
        return { id: c.id, score: 0 };
      });
    }
  } else {
    fused = candidates.map((c) => {
      signalScoresMap.set(c.id, {});
      return { id: c.id, score: 0 };
    });
  }

  const fieldMap = new Map<number, Record<string, unknown>>();
  for (const c of candidates) {
    fieldMap.set(c.id, c.fields);
  }

  const boosted = fused
    .map((f) => {
      const fields = fieldMap.get(f.id) ?? {};
      const boost = topicBoost(query.text, fields);
      // BL-437: floor before boosting — see TOPIC_BOOST_FLOOR above. Only the
      // candidate(s) sitting at the EXACT min_max floor (score === 0) are affected —
      // this is `=== 0`, not `Math.max`, deliberately: a near-zero-but-nonzero score
      // (e.g. 0.0333) already carries real signal from normalisation and must not be
      // clamped up to TOPIC_BOOST_FLOOR, only the literal-zero case that the boost
      // math can never escape from is corrected.
      const flooredScore = f.score === 0 ? TOPIC_BOOST_FLOOR : f.score;
      return { ...f, score: flooredScore * boost };
    });

  boosted.sort((a, b) => b.score - a.score);

  const results: SearchResult[] = [];
  for (const b of boosted.slice(0, limit)) {
    const result: SearchResult = {
      id: b.id,
      score: b.score,
      fields: fieldMap.get(b.id) ?? {},
    };
    if (explain) {
      result.signalScores = signalScoresMap.get(b.id);
    }
    if (queryDegraded) {
      result.degraded = queryDegraded;
    }
    results.push(result);
  }

  return results;
}

// ── StoreSearchBackend ───────────────────────────────────────────────────────

export class StoreSearchBackend implements SearchBackend {
  private vec: VectorBackend;
  private graph: GraphBackend;

  constructor(
    vec: VectorBackend,
    graph: GraphBackend,
    _opts?: StoreSearchOpts,
  ) {
    this.vec = vec;
    this.graph = graph;
  }

  async search(
    query: SearchQuery,
    limit: number,
  ): Promise<Array<{
    id: number;
    textScore?: number;
    vecScore?: number;
    fields: Record<string, unknown>;
    degraded?: SearchDegradeInfo;
  }>> {
    const textPresent = query.text !== undefined && query.text.length > 0;
    const vecPresent = query.vec !== undefined;
    const filters = query.filters ?? {};

    const { nodeFilter, unsupportedFilters } = buildFilterClause(filters);
    const hasNodeFilter = Object.keys(nodeFilter).length > 0;

    const merged = new Map<
      number,
      {
        textScore?: number;
        vecScore?: number;
        fields: Record<string, unknown>;
      }
    >();

    const textLimit = textPresent && !vecPresent ? limit : limit * 2;

    if (textPresent) {
      const searchOpts: { limit: number; filter?: NodeFilter } = {
        limit: textLimit,
      };
      if (hasNodeFilter) {
        searchOpts.filter = nodeFilter;
      }
      const textResults = await this.graph.searchNodes(query.text!, searchOpts);

      for (const r of textResults) {
        const entry = merged.get(r.id);
        if (entry) {
          entry.textScore = r.score;
          Object.assign(entry.fields, this.nodeRecordToFields(r));
        } else {
          merged.set(r.id, {
            textScore: r.score,
            fields: this.nodeRecordToFields(r),
          });
        }
      }
    }

    if (vecPresent) {
      const spaces = this.vec.listSpaces();
      const matchingSpace = spaces.find((s) => s.dim === query.vec!.length);
      if (matchingSpace) {
        // DEBT-011: the vector store's filter contract is pure `{ ids }` (it knows
        // nothing about the graph `node` table). hybrid-search owns the node-join
        // here — resolve the matching ids from the graph, then knn over that id
        // set. A filter that matches zero nodes yields zero vector candidates
        // (BL-294's invariant, preserved by construction, not a special case).
        let matchingIds: number[] | undefined;
        let zeroMatches = false;
        if (hasNodeFilter) {
          matchingIds = (await this.graph.queryNodes(nodeFilter)).map((n) => n.id);
          zeroMatches = matchingIds.length === 0;
        }

        if (!zeroMatches) {
          const vecResults = this.vec.knn(
            query.vec!,
            matchingSpace,
            limit * 2,
            matchingIds ? { ids: matchingIds } : undefined,
          );

          for (const r of vecResults) {
            const entry = merged.get(r.id);
            if (entry) {
              entry.vecScore = r.score;
            } else {
              const node = await this.graph.getNode(r.id);
              if (node) {
                merged.set(r.id, {
                  vecScore: r.score,
                  fields: this.nodeRecordToFields(node),
                });
              }
            }
          }
        }
      }
    }

    const degraded: SearchDegradeInfo | undefined =
      unsupportedFilters.length > 0 ? { unsupportedFilters } : undefined;

    return Array.from(merged.entries())
      .map(([id, data]) => {
        const entry: {
          id: number;
          textScore?: number;
          vecScore?: number;
          fields: Record<string, unknown>;
          degraded?: SearchDegradeInfo;
        } = { id, fields: data.fields };
        if (data.textScore !== undefined) entry.textScore = data.textScore;
        if (data.vecScore !== undefined) entry.vecScore = data.vecScore;
        if (degraded) entry.degraded = degraded;
        return entry;
      })
      .slice(0, limit);
  }

  /**
   * FEAT-022 — N-signal ranker. Executes each RANK signal (`graph.searchNodes`
   * for text, `vec.knn` for vec), fuses their ranked id lists via reciprocal-rank
   * fusion (`Σ w_i/(RRF_K + rank_i)`), then applies CONTINUOUS signals
   * (`rescore`) as a post-fusion multiplier. Returns fused {@link SearchResult}s,
   * best-first. RRF operates on ranks, not continuous scores — so a continuous
   * signal (temporal recency) is a rescore here, never a peer RRF term.
   *
   * Back-compat: the existing 2-signal `search()` (min-max normalisation fusion)
   * is unchanged; this is the additive N-signal entry point.
   *
   * SCALE NOTE: `score` here is on the raw RRF magnitude scale (`Σ w_i/(60+rank_i)`,
   * ~0.016..0.033 per signal) — NOT the [0,1] min-max scale the existing
   * `search()` returns. The two entry points are not score-comparable; do not
   * mix results from both into one sorted set.
   */
  async searchRanked(query: SearchQuery, limit: number): Promise<SearchResult[]> {
    const signals = query.signals ?? defaultSignals(query);
    const filters = query.filters ?? {};
    const { nodeFilter, unsupportedFilters } = buildFilterClause(filters);
    const hasNodeFilter = Object.keys(nodeFilter).length > 0;

    const fetchLimit = Math.max(limit * 2, 20);

    const rankedIdsBySignal = new Map<string, number[]>();
    const weights = new Map<string, number>();
    const fieldsById = new Map<number, Record<string, unknown>>();
    const signalScores = new Map<number, { text?: number; vec?: number }>();

    for (const signal of signals) {
      weights.set(signal.kind, signal.weight ?? 1.0);

      if (signal.kind === 'text') {
        if (query.text === undefined || query.text.length === 0) continue;
        const searchOpts: { limit: number; filter?: NodeFilter } = { limit: fetchLimit };
        if (hasNodeFilter) searchOpts.filter = nodeFilter;
        const textResults = await this.graph.searchNodes(query.text, searchOpts);
        rankedIdsBySignal.set('text', textResults.map((r) => r.id));
        for (const r of textResults) {
          fieldsById.set(r.id, this.nodeRecordToFields(r));
          const s = signalScores.get(r.id) ?? {};
          s.text = r.score;
          signalScores.set(r.id, s);
        }
      } else {
        if (query.vec === undefined) continue;
        const spaces = this.vec.listSpaces();
        const matchingSpace = spaces.find((s) => s.dim === query.vec!.length);
        if (!matchingSpace) continue;
        // DEBT-011 — the vector store is pure `{ ids }`; resolve matching ids
        // from the graph first (hybrid-search owns the node-join).
        let matchingIds: number[] | undefined;
        let zeroMatches = false;
        if (hasNodeFilter) {
          matchingIds = (await this.graph.queryNodes(nodeFilter)).map((n) => n.id);
          zeroMatches = matchingIds.length === 0;
        }
        if (zeroMatches) continue;
        const vecResults = this.vec.knn(
          query.vec!,
          matchingSpace,
          fetchLimit,
          matchingIds ? { ids: matchingIds } : undefined,
        );
        rankedIdsBySignal.set('vec', vecResults.map((r) => r.id));
        for (const r of vecResults) {
          if (!fieldsById.has(r.id)) {
            const node = await this.graph.getNode(r.id);
            if (node) fieldsById.set(r.id, this.nodeRecordToFields(node));
          }
          const s = signalScores.get(r.id) ?? {};
          s.vec = r.score;
          signalScores.set(r.id, s);
        }
      }
    }

    let scored = rrfFuse(rankedIdsBySignal, weights);

    // Continuous signals — post-fusion rescore, never a peer RRF term.
    for (const cs of query.rescore ?? []) {
      if (cs.kind === 'temporal') {
        const recencyMs = new Map<number, number>();
        for (const [id, fields] of fieldsById) {
          if (typeof fields.tCreated === 'string') {
            const ms = Date.parse(fields.tCreated);
            if (!Number.isNaN(ms)) recencyMs.set(id, ms);
          }
        }
        scored = temporalRescore(scored, recencyMs, cs.decay);
      }
    }
    scored.sort((a, b) => b.score - a.score);

    const degraded: SearchDegradeInfo | undefined =
      unsupportedFilters.length > 0 ? { unsupportedFilters } : undefined;

    return scored.slice(0, limit).map((f) => {
      const result: SearchResult = {
        id: f.id,
        score: f.score,
        fields: fieldsById.get(f.id) ?? {},
      };
      result.signalScores = signalScores.get(f.id);
      if (degraded) result.degraded = degraded;
      return result;
    });
  }

  private nodeRecordToFields(node: NodeRecord): Record<string, unknown> {
    const fields: Record<string, unknown> = {
      kind: node.kind,
      content: node.content,
      tags: node.tags,
      namespace: node.namespace,
      isSuperseded: node.isSuperseded,
      isStale: node.isStale,
      tCreated: node.tCreated,
      tValid: node.tValid,
    };
    if (node.name !== undefined) fields.name = node.name;
    if (node.summary !== undefined) fields.summary = node.summary;
    if (node.topic !== undefined) fields.topic = node.topic;
    if (node.importance !== undefined) fields.importance = node.importance;
    if (node.confidence !== undefined) fields.confidence = node.confidence;
    if (node.tInvalid !== undefined) fields.tInvalid = node.tInvalid;
    if (node.tExpires !== undefined) fields.tExpires = node.tExpires;
    if (node.metadata !== undefined) fields.metadata = node.metadata;
    return fields;
  }
}
