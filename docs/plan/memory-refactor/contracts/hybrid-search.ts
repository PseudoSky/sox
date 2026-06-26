/**
 * hybrid-search.ts — public contract for @adhd/sox-hybrid-search.
 *
 * Package path: libs/data/search/hybrid-search/
 * Execution context: w2d-hybrid-search
 * Published: public@0.x (ADR-0006)
 *
 * Key invariants this contract encodes:
 *   [def:degrade-to-bm25] — when SearchOptions.vector is absent, search() MUST return
 *                            a BM25/FTS-ranked result (never an empty result set).
 *                            This is the read-path survivability invariant.
 *   [inv:degrade]         — same as above; tested by [w2d-hs.4].
 *   Normalize-before-combine — scores from different signals are normalized before fusion.
 *   Multiplicative boost  — field boosting is multiplicative, never additive.
 *   DI connection         — search() takes an injected Database (composer-owned).
 *   Federation out of scope — discoverStores/getFederationConnection stay in the composer.
 *   data/search deps      — imports @adhd/sox-graph-store + @adhd/sox-vector-store (both
 *                            public; data→data boundary is satisfied).
 *
 * This package does NOT re-export applyGraphSchema / applyVecSchema / upsertNode /
 * upsertVector. Consumers import those from the peer packages directly.
 *
 * Resolves demo stubs: U1, U2, U3, U4, U5.
 * See CONTRACTS.md §Stub-resolution table.
 */

import type { EmbeddingVector, InjectedDb } from './types.js';

// ── Scoring options ────────────────────────────────────────────────────────────

/**
 * Normalization strategy applied to each signal before combining.
 * Applied per signal (vec, bm25, temporal) independently.
 *
 * 'min_max' — linear rescale to [0, 1] per signal. Default.
 * 'l2'      — L2 normalization (divide by L2 norm of the signal vector).
 * 'z_score' — zero-mean, unit-variance normalization.
 *
 * SCOPE Part D: normalization is mandatory before combining signals of different scales.
 */
export type NormStrategy = 'min_max' | 'l2' | 'z_score';

/**
 * Per-field multiplicative boost weights.
 *
 * SCOPE Part D defaults: topic 2.0, tags 1.5, name 1.2, summary 1.0, content 1.0.
 * Boosting is MULTIPLICATIVE. An additive offset would be scale-blind and is forbidden.
 *
 * Merged with defaults: omitted fields use the defaults above.
 */
export interface FieldWeights {
  topic?: number;
  tags?: number;
  name?: number;
  summary?: number;
  content?: number;
}

// ── Explain breakdown ──────────────────────────────────────────────────────────

/**
 * Optional per-signal score breakdown, populated when SearchOptions.explain is true.
 *
 * Resolves U4 — explain field names (vec, bm25, temporal, fieldBoosts).
 *
 * SCOPE Part D: explain is OPT-IN only. Off by default for performance.
 * All numeric values are post-normalization scores in [0, 1].
 */
export interface SearchExplain {
  /** Normalized cosine similarity from the vector signal. Absent when no vector was provided. */
  vec?: number;
  /**
   * Normalized BM25 score from the FTS5 bm25(col_weights) query.
   * Single FTS query with per-column weights (SCOPE Part D [w2d-hs.6] — not N queries).
   */
  bm25?: number;
  /** Normalized temporal decay score (recency × importance). */
  temporal?: number;
  /** Per-field multiplicative boost factors applied (merged defaults + caller overrides). */
  fieldBoosts?: FieldWeights;
}

// ── Search result ──────────────────────────────────────────────────────────────

/**
 * A single result row from search().
 *
 * Resolves U3 — result shape.
 */
export interface SearchResult {
  uid: string;
  /**
   * Fused relevance score (post-normalize-and-combine).
   * Higher is more relevant. Not in any fixed [0, 1] range after combination.
   */
  score: number;
  content: string | null;
  name: string | null;
  topic: string | null;
  importance: number;
  t_created: string;
  /**
   * Per-signal breakdown. Only present when SearchOptions.explain is true.
   * Resolves U4.
   */
  explain?: SearchExplain;
}

// ── Structured episode filter ──────────────────────────────────────────────────

/**
 * Structured episode filter. Mirrors the MemoryFilter vocabulary from memory_recall.
 *
 * Package-local definition: do NOT import from @adhd/sox-memory-enrich (private).
 * hybrid-search and analysis each carry their own copy of this filter shape — DRY
 * at the type level, not at the package level (SCOPE w2d-analysis.md §Notes).
 */
export interface SearchFilter {
  project_path?: string | { prefix: string };
  topic?: string | string[];
  tags?: string | string[];
  tags_match_all?: boolean;
  importance_min?: number;
  t_created_after?: string;
  t_created_before?: string;
}

// ── Search options ─────────────────────────────────────────────────────────────

/**
 * Options for search(). All fields are optional.
 * A minimum call search(db, query) returns a BM25-only ranked result.
 *
 * Resolves U3 — option key names confirmed (vector, limit, explain, weights, normalize).
 */
export interface SearchOptions {
  /**
   * Pre-computed query vector for the vector signal.
   *
   * [def:degrade-to-bm25]: when ABSENT, the vector signal is skipped and search()
   * returns a BM25+temporal ranked result. This degradation is REQUIRED and must
   * return a non-empty result set for a matching query ([w2d-hs.4]).
   *
   * Callers compute this via embedding-provider.resolveProvider().embed(query)
   * and pass it here — hybrid-search does not embed internally.
   */
  vector?: EmbeddingVector;

  /** Maximum number of results. Default: 10. */
  limit?: number;

  /**
   * Enable per-signal score breakdown in result.explain.
   * OFF by default (SCOPE Part D: "opt-in explain only").
   * Resolves U4.
   */
  explain?: boolean;

  /** Per-field multiplicative boosts. Merged with defaults (see FieldWeights). */
  weights?: FieldWeights;

  /** Normalization strategy. Default: 'min_max'. */
  normalize?: NormStrategy;

  /**
   * ISO timestamp for temporal decay anchor.
   * Temporal score = decay^(hours_since_t_created). Default: now.
   */
  asOf?: string;

  /**
   * When true (default), only score episodes with t_invalid IS NULL.
   * Set false to include invalidated episodes in the result set.
   */
  liveOnly?: boolean;

  /**
   * Token budget: truncate assembled context to this many estimated tokens.
   * Estimation: 1 token ≈ 4 chars. Omit to return all results up to limit.
   */
  token_budget?: number;

  /** Structured episode filter applied before scoring. */
  filter?: SearchFilter;
}

// ── Batch search ───────────────────────────────────────────────────────────────

/**
 * A single query entry in a batchSearch() call.
 * Allows per-query vector and weight overrides.
 */
export interface BatchQuery {
  /** Query text for the BM25 / topic-boost signal. */
  query: string;
  /** Optional per-query vector. Falls back to BatchSearchOptions defaults. */
  vector?: EmbeddingVector;
  /** Per-query field weight override. Merged with BatchSearchOptions.weights. */
  weights?: FieldWeights;
}

/**
 * Options shared across all queries in a batchSearch() call.
 * Per-query overrides in BatchQuery take precedence.
 */
export interface BatchSearchOptions extends Omit<SearchOptions, 'vector'> {
  /**
   * Shared filter evaluated ONCE for all queries (shared-filter optimization).
   * SCOPE Part D: "evaluate a common filter once" to avoid O(queries×rows) scans.
   * Merged (AND) with any per-query filter.
   */
  sharedFilter?: SearchFilter;
}

/**
 * A single result from batchSearch(). Extends SearchResult with cross-query metadata.
 *
 * Resolves U5 — return shape and matched_queries field name/type.
 */
export interface BatchSearchResult extends SearchResult {
  /**
   * (experimental) Count of distinct queries in the batch that matched this result.
   *
   * SCOPE Part D: "cross-query dedup via a matched_queries count — mark experimental.
   * No production system does it; it is a differentiator, not a guarantee."
   *
   * Higher = the result is relevant to more queries in the batch.
   * Use for cross-query deduplication: prefer results with high matched_queries.
   * Do not rely on this field for correctness-critical paths.
   */
  matched_queries: number;
}

// ── Primary ranker ─────────────────────────────────────────────────────────────

/**
 * Hybrid vec+BM25+temporal ranker for a single query.
 *
 * Algorithm (SCOPE Part D):
 *   1. BM25 via FTS5 bm25(col_weights) — single ranked query, not N per-field queries.
 *      Two-phase: FTS5→exact-rescore to avoid O(rows×batch×fields) scans.
 *   2. Vector cosine via @adhd/sox-vector-store knn() — skipped when vector is absent.
 *   3. Temporal decay: recency × importance.
 *   4. Normalize each signal (NormStrategy; default min_max).
 *   5. Multiply by FieldWeights (multiplicative, not additive).
 *   6. RRF fusion (k=60) or max-score combination.
 *   7. Implicit topic boost: score query vs topic names; lift matching topics.
 *
 * [def:degrade-to-bm25]: when opts.vector is absent, steps 2 and 5 are skipped;
 * a valid BM25+temporal result is still returned. [w2d-hs.4]
 *
 * Resolves U1 (no applySchema re-export), U2 (no upsertNode/upsertVector re-export),
 * U3 (search export name + option keys).
 *
 * @param db    Injected Database (composer-owned; graph + vec schemas applied).
 * @param query Query text. Used for BM25 and topic boost.
 * @param opts  Ranking options. All optional; defaults produce a BM25+temporal ranking.
 * @returns     Results sorted by fused score descending.
 */
export declare function search(
  db: InjectedDb,
  query: string,
  opts?: SearchOptions,
): SearchResult[];

/**
 * Alias for search(). Kept for backward compatibility with legacy recall surface.
 * pack-smoke.mjs checks `m.search ?? m.hybridRecall` — both are valid entry points.
 */
export declare const hybridRecall: typeof search;

// ── Batch ranker ───────────────────────────────────────────────────────────────

/**
 * Batch search: evaluate multiple queries against the same store with:
 *   - Shared-filter optimization: a common filter is evaluated once (SCOPE Part D).
 *   - Cross-query matched_queries count: experimental differentiator (SCOPE Part D).
 *
 * Results include all unique hits across all queries, each annotated with
 * matched_queries = the number of batch queries that returned this result.
 *
 * Resolves U5 — export name (batchSearch), input shape (BatchQuery[]), matched_queries field.
 *
 * @param db      Injected Database.
 * @param queries Array of query objects (each may override vector/weights).
 * @param opts    Shared options applied to all queries unless overridden.
 * @returns       Merged result set, sorted by score descending, deduplicated by uid.
 */
export declare function batchSearch(
  db: InjectedDb,
  queries: BatchQuery[],
  opts?: BatchSearchOptions,
): BatchSearchResult[];
