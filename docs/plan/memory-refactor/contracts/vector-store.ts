/**
 * vector-store.ts — public contract for @adhd/sox-vector-store.
 *
 * Package path: libs/data/vectors/vector-store/
 * Execution context: w2c-vector-store
 * Published: public@0.x (ADR-0006)
 *
 * Key invariants this contract encodes:
 *   [inv:space]  — upsertVector THROWS SpaceInvariantError when dim or modelId mismatches
 *                  the column's. Models cannot mix in one space.
 *   [def:connection-seam] — every function takes an injected Database; this package never
 *                  calls `new Database(...)`. openVectorStore is the ONLY exception (it is
 *                  a standalone-reuse convenience entry point for 3rd parties).
 *   data/vectors ↛ data/graph — this package does NOT import @adhd/sox-graph-store.
 *   BL-88 — per-record modelId provenance (every vec_node row stores its modelId).
 *   [def:reembed-core] — the single model-migration walk lives here; absorbs reembed-memory.mjs.
 *
 * Resolves demo stubs: U1, U2, U3.
 * See CONTRACTS.md §Stub-resolution table.
 */

import type { EmbeddingVector, ModelId, Dim, InjectedDb } from './types.js';
import type { EmbedProvider } from './embedding-provider.js';

// ── kNN result ─────────────────────────────────────────────────────────────────

/**
 * A single result from a kNN query.
 *
 * Resolves U1 — knn() result shape beyond nodeId.
 */
export interface KnnResult {
  /** node.rowid of the matching episode (= vec_node.node_id). */
  nodeId: number;
  /** Cosine similarity in [−1, 1]. Higher is more similar. */
  score: number;
  /**
   * Model under which this vector was stored (per-record provenance, BL-88).
   * Enables the caller to detect cross-model contamination if the space migrated.
   */
  modelId: ModelId;
}

// ── Schema options ─────────────────────────────────────────────────────────────

/**
 * Options for applyVecSchema.
 * [def:space-invariant]: dim + modelId define the space. All subsequent upserts
 * must carry matching dim and modelId or they are rejected.
 *
 * Resolves U2 — modelId column confirmed as per-record provenance (model_id in SQL).
 */
export interface VecSchemaOpts {
  /**
   * Vector dimension. MUST equal the active provider's dim.
   * Never hard-code 768 — derive from provider.dim after resolveProvider().
   */
  dim: Dim;
  /** Model identifier for this space (e.g. 'BAAI/bge-base-en-v1.5'). */
  modelId: ModelId;
}

// ── Upsert options ─────────────────────────────────────────────────────────────

/** Options for upsertVector. */
export interface UpsertVectorOpts {
  /**
   * Model identifier for this vector.
   * [inv:space]: MUST match the column's configured modelId; throws SpaceInvariantError otherwise.
   */
  modelId: ModelId;
}

// ── kNN filter ─────────────────────────────────────────────────────────────────

/**
 * Optional post-retrieval filter for knn().
 * Applied after sqlite-vec returns candidates, before scoring.
 */
export interface KnnFilter {
  /** Restrict results to nodeIds in this set. Useful for scope-aware search. */
  nodeIds?: Set<number>;
}

// ── Errors ─────────────────────────────────────────────────────────────────────

/**
 * Thrown when a vector violates the space invariant ([inv:space]).
 * Either dim mismatch or modelId mismatch.
 *
 * Resolves U3 — typed error with expected/actual breakdown.
 */
export class SpaceInvariantError extends Error {
  public readonly expected: { dim?: Dim; modelId?: ModelId };
  public readonly actual: { dim?: Dim; modelId?: ModelId };

  constructor(
    message: string,
    expected: { dim?: Dim; modelId?: ModelId },
    actual: { dim?: Dim; modelId?: ModelId },
  ) {
    super(message);
    this.name = 'SpaceInvariantError';
    this.expected = expected;
    this.actual = actual;
  }
}

// ── Similarity-backend seam ────────────────────────────────────────────────────

/**
 * Pluggable similarity-backend interface (SCOPE Part D — Phase-0+ seam).
 *
 * Phase 0: only the brute-force sqlite-vec implementation ships.
 * Phase 1+: usearch HNSW / simsimd SIMD can be wired in by replacing this impl —
 *           callers that use knn() from the module are unaffected.
 *
 * Resolves vector-store UNRESOLVED scope gap "REQ-003 / CAP-007 — pluggable backend."
 */
export interface SimilarityBackend {
  /**
   * Find the k nearest neighbours to query.
   * @param db      Injected Database with vec_node populated.
   * @param query   Query vector (must match the column's dim).
   * @param k       Number of results.
   * @param filter  Optional post-retrieval filter.
   * @returns       Results sorted by score descending.
   */
  knn(db: InjectedDb, query: EmbeddingVector, k: number, filter?: KnnFilter): KnnResult[];
}

// ── Re-embed result ────────────────────────────────────────────────────────────

/**
 * Result of a re-embed migration pass ([def:reembed-core]).
 */
export interface ReembedResult {
  /** Number of vec_node rows found with stored modelId ≠ active.modelId. */
  mismatchedCount: number;
  /** Number of rows re-embedded and rewritten. Zero when dryRun:true. */
  rewrittenCount: number;
  /** Whether this was a dry run. */
  dryRun: boolean;
  /** True when no rows remain with a mismatched modelId after the pass. */
  isComplete: boolean;
}

// ── Schema DDL ─────────────────────────────────────────────────────────────────

/**
 * Apply the vec_node virtual table DDL to an injected Database.
 * Idempotent (CREATE VIRTUAL TABLE IF NOT EXISTS).
 *
 * The vec0 table stores vectors at the configured dim, with a per-record model_id
 * provenance column (BL-88). The column's dim and modelId together define the space
 * ([def:space-invariant]).
 *
 * [def:connection-seam]: the composer calls this after openDb() and sqlite-vec load.
 * graph-store.applyGraphSchema() is called alongside this, never inside it.
 *
 * Resolves U2 — table name is vec_node (from schema.ts:71); model_id is the new
 * per-record provenance column (BL-88 addition; not in the legacy DDL).
 *
 * @param db   Better-sqlite3 Database, already open with sqlite-vec loaded.
 * @param opts Space parameters. dim MUST come from the active provider, never hard-coded.
 */
export declare function applyVecSchema(db: InjectedDb, opts: VecSchemaOpts): void;

// ── Write ──────────────────────────────────────────────────────────────────────

/**
 * Upsert a vector into the vec_node space.
 *
 * [inv:space]: THROWS SpaceInvariantError when:
 *   - vec.length !== the column's configured dim
 *   - opts.modelId !== the column's configured modelId
 *
 * No partial write: the error is thrown before any SQL is executed.
 *
 * @param db      Injected Database.
 * @param nodeId  node.rowid of the corresponding episode/entity.
 * @param vec     L2-normalised embedding of length == space.dim.
 * @param opts    Must carry the active modelId ([inv:space]).
 */
export declare function upsertVector(
  db: InjectedDb,
  nodeId: number,
  vec: EmbeddingVector,
  opts: UpsertVectorOpts,
): void;

// ── Read ───────────────────────────────────────────────────────────────────────

/**
 * k-Nearest-Neighbour query using the pluggable similarity backend.
 * Phase 0: brute-force cosine over vec_node (sqlite-vec).
 *
 * The query vector must match the space's dim; no modelId check is applied here
 * (the query is an ephemeral value, not a stored record).
 *
 * @param db     Injected Database.
 * @param query  Query vector.
 * @param k      Number of results.
 * @param filter Optional post-retrieval filter.
 * @returns      Results sorted by score descending.
 */
export declare function knn(
  db: InjectedDb,
  query: EmbeddingVector,
  k: number,
  filter?: KnnFilter,
): KnnResult[];

// ── Standalone opener ──────────────────────────────────────────────────────────

/**
 * Convenience standalone opener for 3rd-party use ([def:standalone-proof]).
 *
 * Opens the SQLite file (or ':memory:'), loads the sqlite-vec extension, and returns
 * a ready-to-use Database. The caller is responsible for closing it.
 *
 * DOES NOT call applyVecSchema — callers must do that separately:
 *   const db = openVectorStore(':memory:', { dim: 384 });
 *   applyVecSchema(db, { dim: 384, modelId: 'BAAI/bge-small-en-v1.5' });
 *
 * This separation matches the pack-smoke.mjs ground-truth call pattern.
 *
 * @param filePath Path to the SQLite file, or ':memory:' for in-process use.
 * @param opts     dim is required for validation; the store will reject mismatched
 *                 vectors against the schema applied via applyVecSchema.
 * @returns        Open better-sqlite3 Database with sqlite-vec loaded.
 */
export declare function openVectorStore(filePath: string, opts: { dim: Dim }): InjectedDb;

// ── Re-embed walk ──────────────────────────────────────────────────────────────

/**
 * Re-embed migration walk ([def:reembed-core]).
 *
 * Finds every vec_node row whose stored model_id ≠ active.modelId, re-embeds the
 * corresponding node.content via active.embedBatch(), and rewrites the row in place.
 * Also updates the memory_scope.embed_model + embed_dim metadata.
 *
 * Properties:
 *   Idempotent   — a second call with the same active model is a no-op (mismatchedCount=0).
 *   Non-deleting — only updates vec rows; never deletes graph rows.
 *   dryRun       — reports mismatchedCount without any writes (safe on production stores).
 *
 * Absorbs scripts/reembed-memory.mjs (which becomes a thin wrapper in w2e).
 * BL-11: delegates to active.embedBatch() which routes through the worker thread —
 * the main thread is never blocked alongside the open db.
 *
 * @param db    Injected Database (read-write when dryRun:false).
 * @param opts  active: resolved EmbedProvider; dryRun: true for a safe audit pass.
 */
export declare function reembed(
  db: InjectedDb,
  opts: { active: EmbedProvider; dryRun?: boolean },
): Promise<ReembedResult>;
