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

export interface SearchQuery {
  text?: string;
  vec?: Float32Array;
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
  ): Array<{
    id: number;
    textScore?: number;
    vecScore?: number;
    fields: Record<string, unknown>;
    degraded?: SearchDegradeInfo;
  }>;
}

export interface SqliteSearchOpts {
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

export function search(
  backend: SearchBackend,
  query: SearchQuery,
  opts?: SearchOpts,
): SearchResult[] {
  const limit = opts?.limit ?? 20;
  const explain = opts?.explain ?? false;
  const normalizer = opts?.normalizer ?? 'min_max';

  const fetchLimit = Math.max(limit * 2, 20);
  const candidates = backend.search(query, fetchLimit);

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
      return { ...f, score: f.score * boost };
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

// ── SqliteSearchBackend ───────────────────────────────────────────────────────

export class SqliteSearchBackend implements SearchBackend {
  private vec: VectorBackend;
  private graph: GraphBackend;

  constructor(
    vec: VectorBackend,
    graph: GraphBackend,
    _opts?: SqliteSearchOpts,
  ) {
    this.vec = vec;
    this.graph = graph;
  }

  search(
    query: SearchQuery,
    limit: number,
  ): Array<{
    id: number;
    textScore?: number;
    vecScore?: number;
    fields: Record<string, unknown>;
    degraded?: SearchDegradeInfo;
  }> {
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
      const textResults = this.graph.searchNodes(query.text!, searchOpts);

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
        // BL-294: the vector channel must honor the same NodeFilter (namespace, kind,
        // topic, project_path, …) as the text channel, or a scoped hybrid query silently
        // leaks unscoped vector hits into fusion. VecFilter only supports `ids`, so when
        // a filter is present we first resolve the matching node-id set through the
        // graph store, then constrain knn() to exactly those ids. A filter that matches
        // zero nodes must yield zero vector candidates — never "no filter applied", which
        // is what an empty `ids` array means to the vector backend (BL-294).
        let vecIdFilter: { ids: number[] } | undefined;
        let vecCandidateIds: Set<number> | undefined;
        if (hasNodeFilter) {
          const matchedIds = this.graph.queryNodes(nodeFilter).map((n) => n.id);
          vecCandidateIds = new Set(matchedIds);
          vecIdFilter = { ids: matchedIds };
        }

        const skipVecSearch = hasNodeFilter && (vecCandidateIds?.size ?? 0) === 0;
        const vecResults = skipVecSearch
          ? []
          : this.vec.knn(query.vec!, matchingSpace, limit * 2, vecIdFilter);

        for (const r of vecResults) {
          const entry = merged.get(r.id);
          if (entry) {
            entry.vecScore = r.score;
          } else {
            const node = this.graph.getNode(r.id);
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
