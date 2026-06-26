/**
 * analysis.ts — public contract for @adhd/sox-analysis.
 *
 * Package path: libs/data/analysis/analysis/
 * Execution context: w2d-analysis
 * Published: public@0.x (ADR-0006, promoted for external demand SYS-6/7/1/5/10)
 *
 * Key invariants this contract encodes:
 *   [inv:space]      — similarity-derived outputs (ClusterResult) record the modelId
 *                      they were computed under; a re-embed invalidates stale derivations.
 *   corpus-not-query — all functions here are batch operations over a corpus; there is
 *                      no per-query path.
 *   Clustering = JS  — delegates to a JS clustering lib (density-clustering / hdbscanjs),
 *                      NOT a hand-rolled algorithm, NOT a SQLite extension (SCOPE Part A).
 *   data/analysis boundary — imports @adhd/sox-vector-store (cosine) and
 *                      @adhd/sox-graph-store (corpus reads); both public/data→data.
 *                      Does NOT import from @adhd/sox-memory-enrich (private).
 *   MemoryFilter duplication — the AnalysisFilter type mirrors MemoryFilter from
 *                      filters.ts but is defined here to avoid importing a private package.
 *                      hybrid-search carries its own copy (SearchFilter). Both are
 *                      structurally identical; changes to the vocabulary must be mirrored.
 *
 * Resolves demo stubs: U1, U2, U3.
 * See CONTRACTS.md §Stub-resolution table.
 */

import type { InjectedDb, ModelId } from './types.js';

// ── Importance scoring ─────────────────────────────────────────────────────────

/**
 * Blend weights for the importance formula. All default to 1.0.
 * Grounded in importance.ts ImportanceWeights.
 */
export interface ImportanceWeights {
  /** Weight on length_score (default 1.0). */
  length?: number;
  /** Weight on link_score (default 1.0). */
  link?: number;
  /** Weight on access_score (default 1.0). */
  access?: number;
  /** Weight on tag_score (default 1.0). */
  tag?: number;
}

/**
 * Raw input signals for computeImportance. Grounded in importance.ts ImportanceInputs.
 *
 * Resolves U1 — node table columns used by importance scoring:
 * word_count from content, link_degree from edge count, access_count from node, tag_count from tags.
 */
export interface ImportanceInputs {
  /** Content word count. */
  word_count: number;
  /** In-degree + out-degree edge count (0 at write time; updated on batch pass). */
  link_degree: number;
  /** Cumulative recall access count (node.access_count). */
  access_count: number;
  /** Number of user-asserted tags (parsed from node.tags JSON array). */
  tag_count: number;
}

/**
 * Compute a deterministic importance score in [1.0, 10.0].
 *
 * Pure function — no DB, no I/O, no network. Same inputs → same output always.
 * Grounded in importance.ts:51.
 *
 * Formula:
 *   length_score  = min(word_count / 50, 1.0) × 4.0
 *   link_score    = min(link_degree / 5, 1.0) × 3.0
 *   access_score  = min(access_count / 10, 1.0) × 2.0
 *   tag_score     = min(tag_count / 3, 1.0) × 1.0
 *   raw           = α·length + β·link + γ·access + δ·tag  (α=β=γ=δ=1.0 by default)
 *   result        = clamp(raw, 1.0, 10.0)
 *
 * @param inputs  Raw signal inputs.
 * @param weights Optional blend weight overrides. Unset keys default to 1.0.
 */
export declare function computeImportance(
  inputs: ImportanceInputs,
  weights?: ImportanceWeights,
): number;

// ── Near-duplicate detection ───────────────────────────────────────────────────

/**
 * Result of a near-duplicate probe. Grounded in neardup.ts NearDupResult.
 */
export interface NearDupResult {
  /** UID of the existing near-duplicate episode. */
  existing_uid: string;
  /** Cosine similarity in [0, 1] between the new episode and the existing one. */
  cosine_sim: number;
  /** True if cosine_sim >= the threshold supplied by the caller. */
  should_invalidate: boolean;
}

/**
 * Check whether a newly-written episode has a semantic near-duplicate in the store.
 *
 * Deterministic for a fixed DB state and embedding. No LLM, no network.
 * Uses kNN-20 from vec_node then computes cosine similarity against the threshold.
 *
 * Returns null when no near-duplicate is found (all cosine similarities < threshold).
 *
 * @param db        Injected Database (read-only safe).
 * @param rowid     Rowid of the just-inserted episode.
 * @param embedding Its L2-normalised embedding.
 * @param threshold Cosine similarity threshold (caller supplies backend-appropriate value:
 *                  0.95 for the real ONNX model, 0.98 for the hash provider).
 */
export declare function detectNearDup(
  db: InjectedDb,
  rowid: number,
  embedding: Float32Array,
  threshold: number,
): NearDupResult | null;

// ── Clustering ─────────────────────────────────────────────────────────────────

/**
 * A community cluster produced by a cluster pass.
 *
 * Grounded in cluster.ts ClusterResult, extended with model_id for [inv:space].
 *
 * Resolves U3 — model_id recorded on ClusterResult (stored in community node.meta as
 * json_extract(meta, '$.model_id') per [w2d-analysis.3]).
 */
export interface ClusterResult {
  /** Stable UID: sha256(sorted member rowids as comma-joined string).slice(0,32). */
  community_uid: string;
  /** Human-readable label (centroid-nearest member's name/content). */
  label: string;
  /** Rowids of member episodes. Sorted ascending. */
  member_rowids: number[];
  /** Mean cosine similarity of all member pairs (quality metric). */
  mean_intra_sim: number;
  /** Rowid of the centroid-nearest member (used to derive label). */
  centroid_rowid: number;
  /**
   * [inv:space] — modelId under which cosine similarities were computed.
   * Stored in the community node's meta JSON as { model_id: string }.
   * A re-embed of the store invalidates communities computed under the old modelId.
   */
  model_id: ModelId;
}

/** Options for cluster passes. */
export interface ClusterOpts {
  /**
   * Cosine similarity threshold τ.
   * Default 0.82 for the real ONNX model, 0.70 for the hash provider.
   * Degenerate-cluster guard (D5.5): if max_cluster/total > 0.5, threshold += 0.05, retry up to 3×.
   */
  threshold?: number;
  /**
   * Soft cap on nodes per full pass. Default 10000 (D1.7).
   * When exceeded, full O(n²) pass is skipped; ClusterStoreResult.full_pass is false.
   */
  nodeCap?: number;
  /**
   * When true, run incremental clustering only (local neighborhood check for newly-added
   * nodes). Skips the full O(n²) re-cluster. Default false (full pass).
   */
  incrementalOnly?: boolean;
}

/**
 * Structured filter for a subset cluster pass.
 * Mirrors MemoryFilter from filters.ts (same field vocabulary).
 *
 * Package-local definition: do NOT import from @adhd/sox-memory-enrich (private).
 * Any vocabulary change here must be mirrored in hybrid-search.ts SearchFilter.
 *
 * Resolves U2 — clusterSubset filter shape (was guessed as MemoryFilter; confirmed).
 */
export interface AnalysisFilter {
  project_path?: string | { prefix: string };
  topic?: string | string[];
  tags?: string | string[];
  tags_match_all?: boolean;
  importance_min?: number;
  t_created_after?: string;
  t_created_before?: string;
}

/** Result of a clusterStore() call. */
export interface ClusterStoreResult {
  clusters: ClusterResult[];
  /** Whether the full O(n²) pass ran (false when nodeCap exceeded or incrementalOnly). */
  full_pass: boolean;
  /** Episode count with no cluster assignment (singletons suppressed per D1.6). */
  unclustered_count: number;
}

/**
 * Metadata for a provenance-scoped community slice (subset lens).
 * A subset lens does not replace the global partition.
 */
export interface SubsetLens {
  /** 16-hex provenance hash identifying this lens (for drop by hash). */
  provenanceHash: string;
  filter: AnalysisFilter;
  communities: ClusterResult[];
  createdAt: string;
}

/** Quality statistics for the current cluster partition. Grounded in cluster.ts ClusterStats. */
export interface ClusterStats {
  cluster_count: number;
  total_clustered: number;
  total_unclustered: number;
  mean_intra_sim: number;
  /** Mean cosine similarity between cluster centroids. */
  mean_inter_sim: number;
  largest_cluster_size: number;
}

/**
 * Run a full cluster pass over the live corpus.
 *
 * Delegates to a JS clustering library (density-clustering / hdbscanjs).
 * NOT a hand-rolled DBSCAN/HDBSCAN, NOT a SQLite extension (SCOPE Part A).
 * Writes community nodes and MEMBER_OF edges; updates node.meta with model_id.
 *
 * Deterministic: same DB state + same opts → same cluster assignments.
 * No LLM, no network.
 *
 * @param db   Injected Database (read-write).
 * @param opts Clustering options.
 */
export declare function clusterStore(
  db: InjectedDb,
  opts?: ClusterOpts,
): Promise<ClusterStoreResult>;

/**
 * Run a subset/filtered cluster pass. Produces a provenance-scoped community slice
 * that does not replace the global partition. Stored as a subset lens queryable via
 * listSubsetLenses() and removable via dropSubsetLens().
 *
 * Resolves U2 — filter type confirmed as AnalysisFilter (same vocabulary as MemoryFilter).
 *
 * @param db     Injected Database.
 * @param filter Predicate selecting the episode subset (AnalysisFilter).
 * @param opts   Same clustering options as clusterStore.
 */
export declare function clusterSubset(
  db: InjectedDb,
  filter: AnalysisFilter,
  opts?: ClusterOpts,
): Promise<SubsetLens>;

/**
 * Retrieve quality statistics for the current global cluster partition.
 * Read-only; does not trigger a cluster pass.
 */
export declare function clusterStats(db: InjectedDb): ClusterStats;

/**
 * List all active subset lenses (provenance-scoped community slices).
 * Returns an empty array when no subset pass has been run.
 * Corresponds to memory_curate op:'list_lenses' on the MCP surface.
 */
export declare function listSubsetLenses(db: InjectedDb): SubsetLens[];

/**
 * Drop a subset lens by its provenance hash.
 * No-op if the lens does not exist.
 * Corresponds to memory_curate op:'drop_lens' on the MCP surface.
 *
 * @param db            Injected Database.
 * @param provenanceHash 16-hex hash from SubsetLens.provenanceHash.
 */
export declare function dropSubsetLens(db: InjectedDb, provenanceHash: string): void;

// ── Auto-linking ───────────────────────────────────────────────────────────────

/** Options for buildAutoLinks. */
export interface AutoLinkOpts {
  /**
   * Entities in > this fraction of episodes are excluded (entity stoplist).
   * Prevents high-frequency entities (e.g. 'the', common abbreviations) from
   * generating spurious RELATES_TO edges. Default 0.30.
   */
  entityStoplistThreshold?: number;
}

/** Result of a buildAutoLinks pass. */
export interface AutoLinkResult {
  /** Number of RELATES_TO edges inserted. */
  relates_to_edges: number;
}

/**
 * Insert RELATES_TO edges between episodes that share entity MENTIONS edges.
 *
 * Batch operation — not per-query. No LLM, no network.
 * High-frequency entities are excluded via the stoplist threshold.
 *
 * @param db   Injected Database (read-write).
 * @param opts Optional configuration.
 */
export declare function buildAutoLinks(db: InjectedDb, opts?: AutoLinkOpts): AutoLinkResult;

// ── Batch orchestrator ─────────────────────────────────────────────────────────

/**
 * Options for runBatchEnrich.
 * Grounded in batch.ts BatchEnrichOptions.
 */
export interface BatchEnrichOptions {
  /** Cosine similarity threshold for clustering. Default 0.82 real, 0.70 hash. */
  clusterThreshold?: number;
  /** Near-dup threshold for SAME_AS edges. Default 0.95 real, 0.98 hash. */
  nearDupThreshold?: number;
  /** Maximum episodes per full cluster pass. Default 10000. */
  clusterNodeCap?: number;
  /** Importance blend weights. Default: all 1.0. */
  importanceWeights?: ImportanceWeights;
  /** Entity stoplist threshold. Default 0.30. */
  entityStoplistThreshold?: number;
  /**
   * When true, run incremental cluster pass only (BL-45 optimization).
   * Skip the full O(n²) re-cluster. Default false.
   */
  incrementalCluster?: boolean;
  /**
   * Importance update transaction chunk size (BL-45 write-lock yield).
   * Default 500 episodes per transaction. Set 0 or Infinity for a single transaction.
   */
  importanceChunkSize?: number;
}

/**
 * Result summary from runBatchEnrich.
 * Grounded in batch.ts BatchEnrichResult (all fields preserved for backward compat).
 */
export interface BatchEnrichResult {
  /** Community nodes created or updated (E6). */
  communities_upserted: number;
  /** MEMBER_OF edges inserted or refreshed (E6). */
  member_of_edges: number;
  /** Nodes whose importance was updated (E7). */
  importance_updated: number;
  /** RELATES_TO edges inserted (E9). */
  relates_to_edges: number;
  /** Nodes whose topic was backfilled from cluster label (E5 batch). */
  topics_backfilled: number;
  /** Nodes whose enrich_ver was set to 'legacy' (first-pass backfill). */
  legacy_nodes_stamped: number;
  /** True when the cluster pass was skipped (degenerate-cluster guard D5.5). */
  cluster_pass_skipped: boolean;
  /** Reason string when cluster_pass_skipped is true. */
  cluster_skip_reason?: string;
}

/**
 * Run the full batch-enrichment pass over the live corpus (E6, E7, E9, E11).
 *
 * Covers: clustering (E6, MEMBER_OF edges), importance scoring (E7 link/access update),
 * auto-links (E9, RELATES_TO edges), topic backfill (E5 batch), enrich_ver stamping.
 *
 * Corpus-scoped, never per-query. Deterministic: same DB state + opts → same result.
 * No LLM, no network.
 *
 * Resolves U1 — node table columns used for importance scoring; those are word_count
 * (from content), link_degree (edge count), access_count (node), tag_count (from tags).
 * The demo's insertItem helper should use graph-store.insertNode() for schema-correct inserts.
 *
 * @param db   Injected Database (read-write).
 * @param opts Orchestration options. Defaults produce a standard enrichment pass.
 */
export declare function runBatchEnrich(
  db: InjectedDb,
  opts?: BatchEnrichOptions,
): Promise<BatchEnrichResult>;
