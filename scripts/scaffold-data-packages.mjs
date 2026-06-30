#!/usr/bin/env node
/**
 * scaffold-data-packages.mjs — pre-create the memory-refactor `data/*` package skeletons.
 *
 * STOPGAP until the nx workspace generator (separate team) ships. It produces output conformant to
 * docs/plan/memory-refactor/NX-GENERATOR-HANDOFF.md so agents executing the refactor don't have to
 * scaffold packages by hand. Once `nx g @adhd/sox-nx:library --area data --group <g> <name>` exists,
 * prefer that and retire this script.
 *
 * Generated per package (tsc-built LIBRARY pattern, modeled on libs/memory-core):
 *   libs/data/<group>/<name>/{package.json, project.json, tsconfig.lib.json, vitest.config.ts,
 *                             src/index.ts, README.md, CLAUDE.md}
 *
 * The src/index.ts is a TypeScript ambient-declaration skeleton — all interfaces match the
 * authoritative spec at docs/plan/memory-refactor/COMPILED_INTERFACES.md. It compiles with
 * zero errors once the workspace deps are scaffolded; the implementation lands via the plan.
 *
 * Usage:
 *   node scripts/scaffold-data-packages.mjs            # create (public-ready), skip existing
 *   node scripts/scaffold-data-packages.mjs --dry-run  # print what would be written
 *   node scripts/scaffold-data-packages.mjs --private  # scaffold all as private (overrides default)
 *   node scripts/scaffold-data-packages.mjs --force    # overwrite existing files
 *
 * NB: `ingest` is ALWAYS private (`private:true`) regardless of --private.
 *     All other packages default to public. --private forces everything to private.
 *
 * Publish posture: 5 PUBLIC (embedding-provider, vector-store, graph-store, hybrid-search, analysis)
 *                  1 PRIVATE (ingest — never published, per SCOPE.md + ADR-0006).
 *
 * Dep graph (for context; no circular deps):
 *   embedding-provider   standalone  (fastembed → onnxruntime-node transitively)
 *   vector-store         standalone  (better-sqlite3, sqlite-vec)
 *   graph-store          standalone  (better-sqlite3)
 *   hybrid-search      ← vector-store, graph-store  (workspace:*)
 *   analysis           ← vector-store, graph-store  (workspace:*) + density-clustering
 *   ingest               standalone  (pure JS, no deps)
 *
 * NB: reembed() in vector-store takes EmbeddingProvider as a DI param (not a package dep).
 *     The skeleton defines a local EmbedderLike interface for duck-typing.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const GLOBAL_PRIVATE = args.has('--private');
const FORCE = args.has('--force');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns true if this package should be private (always-private override OR --private flag). */
const isPrivate = (p) => p.alwaysPrivate || GLOBAL_PRIVATE;

// ── The package manifest ──────────────────────────────────────────────────────
// engines: native carriers (fastembed/better-sqlite3/sqlite-vec) → >=22 (no Node-20 prebuild).
// Packages with workspace deps on native carriers inherit the >=22 constraint.
// alwaysPrivate: true → private regardless of --private flag (ingest only).
// Concerns + invariants → harvested into soxe routing metadata + CLAUDE.md footguns.
const PACKAGES = [
  // ── embedding-provider ────────────────────────────────────────────────────
  {
    name: 'embedding-provider',
    group: 'embed',
    engines: '>=22',
    alwaysPrivate: false,
    description:
      'Pluggable text→vector embedding provider — generic EmbeddingProvider interface,' +
      ' config-driven model resolution, async batch-first API (AsyncIterable), symmetric + asymmetric' +
      ' encoding via role param. Default: fastembed (local ONNX, >=3 model dims proven).' +
      ' Loud-fail: createEmbeddingProvider() throws ResolutionError if config is invalid or model' +
      ' cannot load — no silent hash downgrade.',
    deps: {
      fastembed: '^2.1.0',
    },
    concerns: [
      'text→vector (EmbeddingProvider interface)',
      'config-driven model resolution (createEmbeddingProvider factory)',
      'async batch embed (AsyncIterable<Float32Array>)',
      'asymmetric encoding via role param (document | query)',
      'warmUp cache for hot/topic texts',
      'loud-fail ResolutionError at factory time (never mid-call)',
      'three-tier error taxonomy (Transient / Permanent / Resolution)',
      'deterministic hash provider as first-class alternative',
    ],
    invariants: [
      'createEmbeddingProvider() THROWS ResolutionError synchronously or as a rejection if the config' +
      ' is invalid or the model/runtime cannot load — never silently downgrades to hash',
      'every provider advertises { modelId, dimensions, isRemote, isDeterministic, providerUri? }' +
      ' via metadata — callers never hardcode dims',
      'embedBatch() returns AsyncIterable<Float32Array> — callers receive first result before last' +
      ' batch finishes (critical for sequential local inference)',
      'warmUp() is a no-op when isDeterministic === false',
      'TransientEmbeddingError → caller may retry; PermanentEmbeddingError → caller must not retry;' +
      ' ResolutionError → factory-time only, never thrown mid-call',
    ],
  },

  // ── vector-store ──────────────────────────────────────────────────────────
  {
    name: 'vector-store',
    group: 'vectors',
    engines: '>=22',
    alwaysPrivate: false,
    description:
      'Multi-space vector persistence (sqlite-vec vec0) + kNN/cosine search.' +
      ' Enforces the embedding space invariant: one (modelId, dim) pair per vec0 virtual table,' +
      ' rejects any upsert whose vec.length ≠ space.dim.' +
      ' Owns per-record modelId provenance. reembed() migrates vectors between spaces.',
    deps: {
      'better-sqlite3': '^12.10.0',
      'sqlite-vec': '^0.1.9',
    },
    concerns: [
      'multi-space vec0 persistence (one virtual table per VectorSpace)',
      'kNN/cosine search (VectorBackend.knn)',
      'space invariant enforcement (SpaceInvariantError on dim mismatch)',
      'per-record modelId provenance (VectorSpace.modelId)',
      'corpus scan for clustering + reembed (iter)',
      'reembed() — cross-space migration (walks old space, re-embeds, writes into target space)',
    ],
    invariants: [
      'ensureSpace(space) MUST be called before the first upsert on any new (modelId, dim) pair' +
      ' — idempotent on existing spaces',
      'upsert() THROWS SpaceInvariantError when vec.length !== space.dim' +
      ' ([def:space-invariant] — all implementations must enforce this)',
      'a model switch is a re-embed migration (explicit reembed() call),' +
      ' never a hot-swap into the same vec0 table',
      'reembed() does NOT delete source vectors — caller decides when the old space is safe to drop',
      'delete(id, modelId) is scoped to a single space — does not delete the node from other spaces',
    ],
  },

  // ── graph-store ───────────────────────────────────────────────────────────
  {
    name: 'graph-store',
    group: 'graph',
    engines: '>=22',
    alwaysPrivate: false,
    description:
      'Bi-temporal graph store — nodes + edges over SQLite with t_valid/t_invalid correctness,' +
      ' tExpires TTL, content-hash dedup, FTS5 sync, namespace isolation, and supersession chains.' +
      ' Uses drizzle-orm + drizzle-kit for schema migration.' +
      ' GraphBackendCapabilities flags prevent silent misuse of bitemporal / FTS / metadata-filter features.',
    deps: {
      'better-sqlite3': '^12.10.0',
      'drizzle-orm': '^0.42.0',
    },
    concerns: [
      'schema migration via drizzle-orm + drizzle-kit (generated offline, applied idempotently at runtime)',
      'bi-temporal nodes (t_valid / t_invalid) + tExpires TTL + isStale derived field',
      'namespace isolation (NodeMeta.namespace — hard graph partition, default: "global")',
      'content-hash dedup (writeGraph / writeNodeBatch atomic transactions)',
      'FTS5 sync triggers (searchNodes scored by mechanism-agnostic score field)',
      'supersession chains (supersede / touch / getSupersessionChain)',
      'edge upsert idempotency (writeEdge — safe for re-projection)',
      'graph traversal (getNeighbors / getNeighborsWithEdges / isReachable / getSubgraph)',
      'GraphBackendCapabilities (bitemporal / fullTextSearch / metadataFilter flags)',
      'confidence as first-class epistemic field (distinct from importance ranking weight)',
      'DEPENDS_ON edge rel for typed dependency graphs (plan DAGs, tool dep trees)',
    ],
    invariants: [
      'records are NEVER deleted — invalidate() sets t_invalid (audit-preserving),' +
      ' supersede() mints a new node linked by SUPERSEDES',
      'touch() updates mutable metadata (tExpires, confidence, name, tags) without minting' +
      ' a new node or SUPERSEDES edge — THROWS if nodeId is invalidated or missing',
      'writeEdge() is upsert-idempotent on (src, dst, rel) — safe to call on re-projection',
      'writeGraph() / writeNodeBatch() are atomic (single SQLite transaction) — all or nothing',
      'searchNodes() returns [] (not an error) when capabilities.fullTextSearch === false',
      'NodeFilter.validAt is honored only when capabilities.bitemporal === true,' +
      ' ignored silently otherwise',
      'namespace is a hard isolation field (not a tag/filter convention) — absent → "global"',
    ],
  },

  // ── hybrid-search ─────────────────────────────────────────────────────────
  {
    name: 'hybrid-search',
    group: 'search',
    engines: '>=22',
    alwaysPrivate: false,
    description:
      'Generic hybrid retrieval ranker — fuses vector similarity + text relevance signals' +
      ' (mechanism-agnostic: textScore / vecScore) via normalized RRF/max-score fusion.' +
      ' SearchBackend interface decouples ranking logic from storage. SqliteSearchBackend' +
      ' wires VectorBackend + GraphBackend via DI. Pure fuse() + normalize() functions' +
      ' are exported for callers with any signal source.',
    deps: {
      '@adhd/sox-vector-store': 'workspace:*',
      '@adhd/sox-graph-store': 'workspace:*',
    },
    concerns: [
      'SearchBackend interface (mechanism-agnostic: textScore / vecScore, not BM25 / cosine)',
      'SqliteSearchBackend — DI constructor (VectorBackend, GraphBackend)',
      'hybrid fusion: normalize-before-combine (min_max / L2 / z_score)',
      'degrade-to-text when vec signal absent ([def:degrade-to-text-only])',
      'pure fuse() + normalize() exports (no storage dep)',
      'explain mode (signal-level breakdown only — not field-level)',
      'SchemaAdapter is SQLite-internal (NOT exported — filters wired into SqliteSearchBackend)',
    ],
    invariants: [
      'SearchBackend.search() degrades to text-only when query.vec is absent,' +
      ' degrades to vec-only when query.text is absent — never errors on a missing signal',
      'scores are normalized BEFORE combining (never raw scale-blind additive merge)',
      'textScore / vecScore are mechanism-agnostic names — BM25 / cosine are implementation details' +
      ' inside backends (never surfaced through SearchBackend interface)',
      'SchemaAdapter is an internal SQLite concern — NOT exported; MCP handlers pass raw' +
      ' filters via SearchQuery.filters; SqliteSearchBackend resolves them internally',
      'fuse() weights must be multiplicative (field boosting), never additive (scale-blind)',
    ],
  },

  // ── analysis ──────────────────────────────────────────────────────────────
  {
    name: 'analysis',
    group: 'analysis',
    engines: '>=22',
    alwaysPrivate: false,
    description:
      'Batch derivation over a corpus — clustering (density-clustering, in-process JS),' +
      ' near-dup detection, importance + link scoring, and a suite of pure graph algorithms' +
      ' (topoSort, criticalPath, detectCycles, packBatches). No CorpusBackend wrapper:' +
      ' DB-integrated functions take VectorBackend + GraphBackend directly.',
    deps: {
      '@adhd/sox-vector-store': 'workspace:*',
      '@adhd/sox-graph-store': 'workspace:*',
      'density-clustering': '^1.3.0',
    },
    concerns: [
      'clustering / community detection (density-clustering, in-process JS — NOT a SQLite extension)',
      'near-dup detection (NearDupPair with near_dup / candidate / distinct status)',
      'importance scoring (inDegree, outDegree, recencyMs, nearDupCount)',
      'auto-linking (similarity-threshold edge creation, RELATES_TO by default)',
      'batch enrichment orchestration (runBatchEnrich — incremental, skip-list)',
      'pure topoSort + wave assignment (Kahn BFS, cycle detection + recovery)',
      'criticalPath (longest-path DP for dispatch/scheduling prioritization)',
      'detectCycles (all cycles, not just first — for user-facing error messages)',
      'packBatches (bin-packing with submodular shared cost; algorithm auto-selects by N + DAG structure)',
      'detectDAGStructure (forest / series-parallel / general — determines packBatches algorithm)',
      'setOverlapMatrix (pairwise intersection; MinHash for |S| > 500)',
    ],
    invariants: [
      'operates over a corpus (batch), never per-query — analysis functions are not on the' +
      ' hot query path',
      'clustering uses an existing JS lib (density-clustering / hdbscanjs)' +
      ' — NOT hand-rolled DBSCAN/HDBSCAN',
      'all DB-integrated functions take (VectorBackend, GraphBackend) directly' +
      ' — no CorpusBackend wrapper',
      'similarity-based outputs (clusters, near-dup pairs, link scores) MUST record the' +
      ' modelId they were computed under — re-clustering after a model migration is required',
      'computeImportance / buildAutoLinks are incremental by default' +
      ' ([def:deterministic-first] — processes only un-scored nodes)',
      'topoSort / criticalPath / detectCycles accept a caller-supplied adjacency function' +
      ' (getEdges) so they work over any graph representation, not just graph-store',
      'packBatches shared resource cost is submodular (union cost) — shared resources are' +
      ' paid once per batch; callers must not compute additive per-item resource cost',
    ],
  },

  // ── ingest ────────────────────────────────────────────────────────────────
  {
    name: 'ingest',
    group: 'ingest',
    engines: '>=20',
    alwaysPrivate: true, // ALWAYS private — never published (SCOPE.md §publish-posture)
    description:
      'Write-path single-item transforms for the memory domain — content-hash (SHA-256),' +
      ' extractive summary (sentence-scoring, zero LLM), deterministic tag extraction,' +
      ' and chunking/normalization. Pure stateless functions; no storage deps.' +
      ' Private: only the memory domain composer calls these before graph-store writes.',
    deps: {},
    concerns: [
      'content-hash (SHA-256 of normalized content — used for graph-store dedup)',
      'extractive summary (sentence-scoring, summaryMaxSentences, zero LLM)',
      'deterministic tag extraction (noun phrases, high-frequency terms, tagMaxCount)',
      'chunking (maxChars / overlapChars sliding window)',
      'per-chunk contentHash for dedup at the chunk level',
    ],
    invariants: [
      'zero-LLM, zero-I/O, synchronous — ingest() is a pure function, always safe to call' +
      ' in the write path without latency budget concerns',
      'deterministic + byte-reproducible — same input always produces the same hash, summary,' +
      ' and tags (no random or time-based components)',
      'PRIVATE — never published to npm; only the memory domain composer may call this package',
    ],
  },
];

// ── TypeScript interface stubs ─────────────────────────────────────────────────
// Each stub is a valid TypeScript file using ambient declarations (declare function / declare class).
// Interfaces and types compile to nothing — no implementation required for the skeleton to pass tsc.
// Full authoritative spec: docs/plan/memory-refactor/COMPILED_INTERFACES.md

const STUBS = {
  'embedding-provider': `\
// @adhd/sox-embedding-provider — embed (area:data)
// SKELETON — implementation lands via the memory-refactor plan.
// Authoritative interface spec: docs/plan/memory-refactor/COMPILED_INTERFACES.md
//
// Concerns: ${PACKAGES.find((p) => p.name === 'embedding-provider').concerns.join('; ')}

// 'document' — text being stored/indexed
// 'query'    — text being searched with
// For symmetric models, 'query' delegates to 'document' internally.
export type EmbedRole = 'document' | 'query';

export interface EmbeddingProviderMetadata {
  /** Stable model identifier — used as VectorSpace.modelId key */
  modelId: string;
  /** Output vector length; drives VectorBackend.ensureSpace() */
  dimensions: number;
  /** true → network I/O; callers may adjust concurrency / retry policy */
  isRemote: boolean;
  /** false → warmUp cache is unreliable; do not cache non-det providers */
  isDeterministic: boolean;
  /** Observability: 'local:onnx', 'https://api.example.com/v1', etc. */
  providerUri?: string;
}

export interface EmbeddingProvider {
  readonly metadata: EmbeddingProviderMetadata;

  /** Single-text embed. role defaults to 'document'. */
  embedSingle(text: string, role?: EmbedRole): Promise<Float32Array>;

  /**
   * Batch embed — AsyncIterable so callers process the first result before the last
   * batch finishes. Critical for sequential local inference. batchSize is a hint.
   */
  embedBatch(
    texts: string[],
    opts?: { role?: EmbedRole; batchSize?: number },
  ): AsyncIterable<Float32Array>;

  /**
   * Pre-embed a fixed set of strings into an internal LRU/Map cache.
   * No-op when isDeterministic === false.
   */
  warmUp(texts: string[]): Promise<void>;
}

export interface EmbeddingProviderConfig {
  /** Provider type key — unknown type → ResolutionError thrown before Promise resolves */
  type: string;
  /** Model identifier scoped to the provider type */
  model: string;
  /** Provider-specific options (endpoint URL, credentials, timeout, thread count, etc.) */
  options?: Record<string, unknown>;
}

/**
 * Async factory — fail-loud at resolution time (never at call time).
 * Throws ResolutionError if config is invalid or the runtime/model cannot load.
 * Multiple instances may coexist (required for re-embed migration).
 */
export declare function createEmbeddingProvider(
  config: EmbeddingProviderConfig,
): Promise<EmbeddingProvider>;

// ── Error taxonomy — three tiers, no silent degradation ──────────────────────

/** Retry-able: rate limit, 502/503, network timeout */
export declare class TransientEmbeddingError extends Error {
  readonly retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number);
}

/** Not retry-able: invalid input, model not found, auth failure, dimension mismatch */
export declare class PermanentEmbeddingError extends Error {
  constructor(message: string);
}

/** Misconfiguration — always thrown at createEmbeddingProvider() time, never mid-call */
export declare class ResolutionError extends Error {
  constructor(message: string);
}
`,

  'vector-store': `\
// @adhd/sox-vector-store — vectors (area:data)
// SKELETON — implementation lands via the memory-refactor plan.
// Authoritative interface spec: docs/plan/memory-refactor/COMPILED_INTERFACES.md
//
// Concerns: ${PACKAGES.find((p) => p.name === 'vector-store').concerns.join('; ')}

import type { Database } from 'better-sqlite3';

export interface VectorSpace {
  /** Stable model identifier — links vectors to the model that produced them */
  modelId: string;
  /** Expected output vector length — enforced by upsert() via SpaceInvariantError */
  dim: number;
}

export interface VecFilter {
  /** Restrict knn/iter to this candidate set */
  ids?: number[];
}

export interface VectorBackend {
  // ── Space management ─────────────────────────────────────────────────────
  /** Idempotent — call before first upsert on any new (modelId, dim) pair */
  ensureSpace(space: VectorSpace): void;
  listSpaces(): VectorSpace[];

  // ── Write ────────────────────────────────────────────────────────────────
  /** THROWS SpaceInvariantError when vec.length !== space.dim ([def:space-invariant]) */
  upsert(id: number, vec: Float32Array, space: VectorSpace): void;
  /** Scoped to a single space — does not delete from other spaces */
  delete(id: number, modelId: string): void;

  // ── Point read ───────────────────────────────────────────────────────────
  get(id: number, modelId: string): Float32Array | null;

  // ── Similarity search ────────────────────────────────────────────────────
  /** Score semantics are the backend's concern (cosine, dot, L2) */
  knn(
    query: Float32Array,
    space: VectorSpace,
    k: number,
    filter?: VecFilter,
  ): Array<{ id: number; score: number }>;

  // ── Corpus scan ──────────────────────────────────────────────────────────
  /** Required by analysis (clustering) and reembed() */
  iter(
    modelId: string,
    opts?: { filter?: VecFilter },
  ): Iterable<{ id: number; vec: Float32Array }>;
}

/** Thrown by upsert() when vec.length !== space.dim ([def:space-invariant]) */
export declare class SpaceInvariantError extends Error {
  readonly nodeId: number;
  readonly space: VectorSpace;
  readonly actualDim: number;
  constructor(nodeId: number, space: VectorSpace, actualDim: number);
}

/** Thrown by upsert() / ensureSpace() when underlying storage fails (disk full, WAL locked, etc.) */
export declare class StorageError extends Error {
  readonly cause?: Error;
  constructor(message: string, cause?: Error);
}

export declare class SqliteVectorBackend implements VectorBackend {
  /** sqlite-vec vec0 tables, one virtual table per VectorSpace */
  constructor(db: Database);
  ensureSpace(space: VectorSpace): void;
  listSpaces(): VectorSpace[];
  upsert(id: number, vec: Float32Array, space: VectorSpace): void;
  delete(id: number, modelId: string): void;
  get(id: number, modelId: string): Float32Array | null;
  knn(
    query: Float32Array,
    space: VectorSpace,
    k: number,
    filter?: VecFilter,
  ): Array<{ id: number; score: number }>;
  iter(
    modelId: string,
    opts?: { filter?: VecFilter },
  ): Iterable<{ id: number; vec: Float32Array }>;
}

export declare function openVectorStore(
  path: string,
  opts: { dim: number; modelId: string },
): SqliteVectorBackend;

// ── reembed — cross-space migration ──────────────────────────────────────────
// EmbeddingProvider is accepted as a DI param — @adhd/sox-vector-store does NOT depend on
// @adhd/sox-embedding-provider as a package. Duck-typed locally for structural compatibility.

/** Minimal interface duck-compatible with @adhd/sox-embedding-provider's EmbeddingProvider */
interface EmbedderLike {
  readonly metadata: { modelId: string; dimensions: number };
  embedBatch(
    texts: string[],
    opts?: { role?: 'document' | 'query'; batchSize?: number },
  ): AsyncIterable<Float32Array>;
}

export interface ReembedOpts {
  /** Target VectorSpace to write into. Explicit — required for unambiguous cross-model migration */
  targetSpace: VectorSpace;
  /** Source modelId to read from. Defaults to first space whose modelId !== targetSpace.modelId */
  sourceModelId?: string;
  dryRun?: boolean;
}

export interface ReembedResult {
  migrated: number;
  skipped: number;
  errors: Array<{ id: number; error: string }>;
}

/**
 * Walks vec.iter(sourceModelId) → provider.embedBatch() → vec.upsert(targetSpace).
 * Does NOT delete source vectors — caller decides when the old space is safe to drop.
 */
export declare function reembed(
  backend: VectorBackend,
  provider: EmbedderLike,
  opts: ReembedOpts,
): Promise<ReembedResult>;
`,

  'graph-store': `\
// @adhd/sox-graph-store — graph (area:data)
// SKELETON — implementation lands via the memory-refactor plan.
// Authoritative interface spec: docs/plan/memory-refactor/COMPILED_INTERFACES.md
//
// Concerns: ${PACKAGES.find((p) => p.name === 'graph-store').concerns.join('; ')}

import type { Database } from 'better-sqlite3';

// ── Shared types ─────────────────────────────────────────────────────────────

/** All edges: src → dst.
 *  DEPENDS_ON:  A depends on B — B must reach terminal state before A becomes eligible.
 *               out-direction traversal returns things A depends on; in-direction returns dependents.
 *  SUPERSEDES: A supersedes B (A is the replacement; B is no longer current).
 *  DERIVED_FROM: A was derived / computed / inferred from B. */
export type EdgeRel =
  | 'MENTIONS'
  | 'SUPPORTS'
  | 'RELATES_TO'
  | 'DERIVED_FROM'
  | 'SUPERSEDES'
  | 'SAME_AS'
  | 'ASSIGNED_TO'
  | 'MEMBER_OF'
  | 'PART_OF'
  | 'DEPENDS_ON';

/** Epistemic label — distinct from importance (importance is a ranking weight) */
export type Confidence = 'confirmed' | 'unverified' | 'disputed' | 'deprecated';

export interface NodeMeta {
  name?: string;
  summary?: string;
  topic?: string;
  tags?: string[];
  importance?: number;
  /** Epistemic label — separate from importance weight */
  confidence?: Confidence;
  source?: string;
  agentId?: string;
  /** Provenance — where the node came from (not the same as namespace) */
  projectPath?: string;
  sessionId?: string;
  /** Logical graph partition; default: "global" — hard isolation, not a tag convention */
  namespace?: string;
  tOccurred?: string;
  /** ISO timestamp; when now > tExpires the node is treated as stale */
  tExpires?: string;
  metadata?: Record<string, unknown>;
}

export interface NodeRecord {
  id: number;
  content: string;
  name?: string;
  summary?: string;
  topic?: string;
  tags: string[];
  importance?: number;
  confidence?: Confidence;
  tCreated: string;
  tValid: string;
  tInvalid?: string;
  tExpires?: string;
  isSuperseded: boolean;
  /** Derived: tExpires != null && now > tExpires */
  isStale: boolean;
  /** Defaults to "global" */
  namespace: string;
  metadata?: Record<string, unknown>;
}

export interface EdgeMeta {
  weight?: number;
  metadata?: Record<string, unknown>;
}

export interface EdgeRecord {
  src: number;
  dst: number;
  rel: EdgeRel;
  weight?: number;
  tCreated: string;
  metadata?: Record<string, unknown>;
}

export interface NodeFilter {
  ids?: number[];
  topic?: string | string[];
  tags?: string[];
  tagsMatchAll?: boolean;
  importanceMin?: number;
  /** OR semantics when array */
  confidence?: Confidence | Confidence[];
  tCreatedAfter?: string;
  tCreatedBefore?: string;
  /** Bi-temporal point-in-time. Check capabilities.bitemporal — ignored if false */
  validAt?: string;
  /** false = exclude stale; true = stale only; absent = all */
  isStale?: boolean;
  /** Absent = all namespaces; present = exact match */
  namespace?: string;
  /** Shallow AND equality on metadata fields. Check capabilities.metadataFilter */
  metadata?: Record<string, unknown>;
  orderBy?: 'importance' | 'tCreated' | 'tValid' | 'name';
  /** Default: 'desc' for importance, 'asc' for name */
  orderDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

// ── GraphBackend ──────────────────────────────────────────────────────────────

export interface GraphBackendCapabilities {
  /** true → NodeFilter.validAt is honored */
  bitemporal: boolean;
  /** true → searchNodes() returns scored results; false → always [] */
  fullTextSearch: boolean;
  /** true → NodeFilter.metadata shallow-equality is applied; false → ignored */
  metadataFilter: boolean;
}

export interface GraphBackend {
  readonly capabilities: GraphBackendCapabilities;

  applySchema(): void;

  // ── Node writes ───────────────────────────────────────────────────────────

  writeNode(content: string, meta: NodeMeta): number;
  supersede(oldId: number, newContent: string, meta: NodeMeta): number;
  invalidate(nodeId: number, reason?: string): void;
  /** Update mutable metadata without minting a new node or SUPERSEDES edge.
   *  Use for re-verification (bump tExpires, set confidence). tCreated is immutable.
   *  THROWS if nodeId is invalidated or does not exist. */
  touch(nodeId: number, meta: Partial<NodeMeta>): void;
  /** Atomic multi-node write (single transaction). All succeed or none do. */
  writeNodeBatch(nodes: Array<{ content: string; meta: NodeMeta }>): number[];
  /** Atomic node + edge write. srcIdx/dstIdx are indices into nodes[]. All succeed or none do. */
  writeGraph(
    nodes: Array<{ content: string; meta: NodeMeta }>,
    edges: Array<{ srcIdx: number; dstIdx: number; rel: EdgeRel; meta?: EdgeMeta }>,
  ): number[];

  // ── Node reads ────────────────────────────────────────────────────────────

  getNode(id: number): NodeRecord | null;
  queryNodes(filter?: NodeFilter): NodeRecord[];
  /** Returns [] when capabilities.fullTextSearch === false. */
  searchNodes(
    query: string,
    opts?: { limit?: number; filter?: NodeFilter },
  ): Array<NodeRecord & { score: number }>;
  /** COUNT(*) at DB layer — more efficient than queryNodes().length */
  countNodes(filter?: NodeFilter): number;
  /** Returns all nodes in the chain ordered oldest → newest; includes invalidated nodes. */
  getSupersessionChain(nodeId: number): NodeRecord[];

  // ── Edge writes ───────────────────────────────────────────────────────────

  /** Upsert semantics: if (src, dst, rel) exists, updates meta. Idempotent. */
  writeEdge(src: number, dst: number, rel: EdgeRel, meta?: EdgeMeta): void;

  // ── Edge reads ────────────────────────────────────────────────────────────

  getEdges(opts: { src?: number; dst?: number; rel?: EdgeRel }): EdgeRecord[];
  getNeighbors(
    nodeId: number,
    opts?: { rel?: EdgeRel; depth?: number; direction?: 'in' | 'out' | 'both' },
  ): NodeRecord[];
  /** Same as getNeighbors but includes the connecting edge for each neighbor. */
  getNeighborsWithEdges(
    nodeId: number,
    opts?: { rel?: EdgeRel; depth?: number; direction?: 'in' | 'out' | 'both' },
  ): Array<{ node: NodeRecord; edge: EdgeRecord }>;

  // ── Graph traversal ───────────────────────────────────────────────────────

  /** Cycle-safe reachability via recursive CTE — single query, not N round-trips. */
  isReachable(
    src: number,
    dst: number,
    opts?: { rel?: EdgeRel; direction?: 'out' | 'in' },
  ): boolean;
  /** Returns all nodes and edges reachable from rootId. Deduplicated, cycle-safe. */
  getSubgraph(
    rootId: number,
    opts?: { rel?: EdgeRel; depth?: number; direction?: 'out' | 'in' | 'both' },
  ): { nodes: NodeRecord[]; edges: EdgeRecord[] };
}

export declare class SqliteGraphBackend implements GraphBackend {
  /** capabilities = { bitemporal: true, fullTextSearch: true, metadataFilter: true } */
  readonly capabilities: GraphBackendCapabilities;
  constructor(db: Database);
  applySchema(): void;
  writeNode(content: string, meta: NodeMeta): number;
  supersede(oldId: number, newContent: string, meta: NodeMeta): number;
  invalidate(nodeId: number, reason?: string): void;
  touch(nodeId: number, meta: Partial<NodeMeta>): void;
  writeNodeBatch(nodes: Array<{ content: string; meta: NodeMeta }>): number[];
  writeGraph(
    nodes: Array<{ content: string; meta: NodeMeta }>,
    edges: Array<{ srcIdx: number; dstIdx: number; rel: EdgeRel; meta?: EdgeMeta }>,
  ): number[];
  getNode(id: number): NodeRecord | null;
  queryNodes(filter?: NodeFilter): NodeRecord[];
  searchNodes(
    query: string,
    opts?: { limit?: number; filter?: NodeFilter },
  ): Array<NodeRecord & { score: number }>;
  countNodes(filter?: NodeFilter): number;
  getSupersessionChain(nodeId: number): NodeRecord[];
  writeEdge(src: number, dst: number, rel: EdgeRel, meta?: EdgeMeta): void;
  getEdges(opts: { src?: number; dst?: number; rel?: EdgeRel }): EdgeRecord[];
  getNeighbors(
    nodeId: number,
    opts?: { rel?: EdgeRel; depth?: number; direction?: 'in' | 'out' | 'both' },
  ): NodeRecord[];
  getNeighborsWithEdges(
    nodeId: number,
    opts?: { rel?: EdgeRel; depth?: number; direction?: 'in' | 'out' | 'both' },
  ): Array<{ node: NodeRecord; edge: EdgeRecord }>;
  isReachable(
    src: number,
    dst: number,
    opts?: { rel?: EdgeRel; direction?: 'out' | 'in' },
  ): boolean;
  getSubgraph(
    rootId: number,
    opts?: { rel?: EdgeRel; depth?: number; direction?: 'out' | 'in' | 'both' },
  ): { nodes: NodeRecord[]; edges: EdgeRecord[] };
}

export declare function createGraphBackend(db: Database): GraphBackend;

/** Schema-only exports — for the composer to apply DDL directly */
export declare const GRAPH_DDL: string;
export declare const FTS_DDL: string;
export declare const FTS_TRIGGERS: string;
export declare const PRAGMAS: string[];

/** The 7 EdgeRel values exposed via memory_link MCP tool.
 *  MEMBER_OF, PART_OF, DEPENDS_ON are DDL-valid but internal-only. */
export declare const PUBLIC_EDGE_RELS: readonly EdgeRel[];

/** Schema migration via drizzle-orm + drizzle-kit. Migration SQL is generated
 *  offline and applied idempotently at runtime by applySchema(). The composer
 *  just calls applySchema() on every open — the package owns versioning internally. */

// ── Error taxonomy ────────────────────────────────────────────────────────────

/** Thrown by writeEdge() when (src, dst, rel) violates a CHECK constraint */
export declare class ConstraintError extends Error {
  constructor(message: string);
}

/** Thrown by supersede() when oldId is already invalidated */
export declare class BitemporalConflictError extends Error {
  readonly nodeId: number;
  constructor(message: string, nodeId: number);
}

/** Thrown by touch() when the target node does not exist or is invalidated */
export declare class NodeNotFoundError extends Error {
  readonly nodeId: number;
  constructor(message: string, nodeId: number);
}
`,

  'hybrid-search': `\
// @adhd/sox-hybrid-search — search (area:data)
// SKELETON — implementation lands via the memory-refactor plan.
// Authoritative interface spec: docs/plan/memory-refactor/COMPILED_INTERFACES.md
//
// Concerns: ${PACKAGES.find((p) => p.name === 'hybrid-search').concerns.join('; ')}
//
// NOTE: SqliteSearchBackend constructor takes VectorBackend + GraphBackend via DI.
// hybrid-search depends on @adhd/sox-vector-store + @adhd/sox-graph-store as normal
// public deps (no bundling — both are PUBLIC per SCOPE.md publish posture).
//
// SchemaAdapter is NOT exported. Filters are passed as raw SearchQuery.filters;
// SqliteSearchBackend resolves them internally.

import type { VectorBackend } from '@adhd/sox-vector-store';
import type { GraphBackend } from '@adhd/sox-graph-store';

// Re-export the types callers need from the storage packages
export type { VectorBackend, VectorSpace, VecFilter } from '@adhd/sox-vector-store';
export type { GraphBackend, NodeRecord, NodeFilter } from '@adhd/sox-graph-store';

// ── SearchBackend ─────────────────────────────────────────────────────────────

export interface SearchQuery {
  /** Text relevance signal */
  text?: string;
  /** Vector similarity signal — caller embeds the text; absent → degrade to text-only */
  vec?: Float32Array;
  /** Backend-specific filters; resolved internally by SqliteSearchBackend */
  filters?: Record<string, unknown>;
}

export interface SearchBackend {
  /**
   * text absent → vecScore only; vec absent → textScore only; neither → error.
   * Scores are mechanism-agnostic: textScore / vecScore (not BM25 / cosine).
   * [def:degrade-to-text-only] is always valid.
   */
  search(
    query: SearchQuery,
    limit: number,
  ): Array<{
    id: number;
    /** Text relevance — mechanism is the backend's concern */
    textScore?: number;
    /** Vector similarity — metric is the backend's concern */
    vecScore?: number;
    fields: Record<string, unknown>;
  }>;
}

export interface SqliteSearchOpts {
  /** Field relevance multipliers. Default: memory node preset (topic 2.0 / tags 1.5 / name 1.2 / ...) */
  fieldWeights?: Record<string, number>;
  // schemaAdapter is intentionally not exposed — callers cannot inject schema adapters
  // through this public interface (it is a SqliteSearchBackend implementation detail)
}

export declare class SqliteSearchBackend implements SearchBackend {
  /** DI constructor — pass pre-opened backends; does not own their lifecycle */
  constructor(vec: VectorBackend, graph: GraphBackend, opts?: SqliteSearchOpts);
  search(
    query: SearchQuery,
    limit: number,
  ): Array<{
    id: number;
    textScore?: number;
    vecScore?: number;
    fields: Record<string, unknown>;
  }>;
}

// ── Top-level entry point — fusion math over any SearchBackend ────────────────

export interface SearchOpts {
  normalizer?: 'min_max' | 'L2' | 'z_score';
  /** explain: true → signalScores included (text/vec breakdown only, not field-level) */
  explain?: boolean;
  limit?: number;
}

export interface SearchResult {
  id: number;
  score: number;
  /** Populated only when explain: true. Signal-level only — mechanism-agnostic. */
  signalScores?: { text?: number; vec?: number };
  fields: Record<string, unknown>;
}

export declare function search(
  backend: SearchBackend,
  query: SearchQuery,
  opts?: SearchOpts,
): SearchResult[];

// ── Pure fusion exports — zero storage deps ───────────────────────────────────

export interface FusionOpts {
  normalizer?: 'min_max' | 'L2' | 'z_score';
  /** Multiplicative field boosting weights (never additive — additive is scale-blind) */
  weights?: { text?: number; vec?: number };
}

export declare function fuse(
  candidates: Array<{ id: number; textScore?: number; vecScore?: number }>,
  opts?: FusionOpts,
): Array<{ id: number; score: number }>;

export declare function normalize(
  scores: number[],
  method: 'min_max' | 'L2' | 'z_score',
): number[];
`,

  analysis: `\
// @adhd/sox-analysis — analysis (area:data)
// SKELETON — implementation lands via the memory-refactor plan.
// Authoritative interface spec: docs/plan/memory-refactor/COMPILED_INTERFACES.md
//
// Concerns: ${PACKAGES.find((p) => p.name === 'analysis').concerns.join('; ')}
//
// NOTE: DB-integrated functions take (VectorBackend, GraphBackend) directly — no CorpusBackend
// wrapper. analysis depends on @adhd/sox-vector-store + @adhd/sox-graph-store as normal
// public deps (both are PUBLIC per SCOPE.md). Clustering uses density-clustering (in-process JS).

import type { VectorBackend } from '@adhd/sox-vector-store';
import type { GraphBackend, NodeFilter, EdgeRel } from '@adhd/sox-graph-store';

export type { VectorBackend, VectorSpace, VecFilter } from '@adhd/sox-vector-store';
export type { GraphBackend, NodeRecord, NodeFilter, EdgeRel } from '@adhd/sox-graph-store';

// ── DB-integrated opts / result types ────────────────────────────────────────

export interface ClusterOpts {
  /** Vector space to cluster in; defaults to listSpaces()[0].modelId */
  modelId?: string;
  minClusterSize?: number;
  threshold?: number;
}

export interface ClusterResult {
  communities: Array<{
    id: number;
    memberIds: number[];
    /** Written to graph as MEMBER_OF edge target node name */
    label?: string;
  }>;
  unclustered: number[];
  durationMs: number;
}

export interface SubsetClusterResult extends ClusterResult {
  filter: NodeFilter;
  totalInSubset: number;
}

export interface NearDupOpts {
  /** cosine >= this → 'near_dup' (default: 0.95) */
  nearDupThreshold?: number;
  /** cosine <  this → 'distinct' (default: 0.70) */
  distinctThreshold?: number;
  modelId?: string;
  limit?: number;
}

export interface NearDupPair {
  a: number;
  b: number;
  cosine: number;
  status: 'near_dup' | 'candidate' | 'distinct';
}

export interface ImportanceOpts {
  filter?: NodeFilter;
  dryRun?: boolean;
}

export interface AutoLinkOpts {
  filter?: NodeFilter;
  similarityThreshold?: number;
  maxLinksPerNode?: number;
  /** Edge rel to write (default: RELATES_TO) */
  rel?: EdgeRel;
  dryRun?: boolean;
}

export interface BatchOpts {
  filter?: NodeFilter;
  skip?: Array<'importance' | 'nearDup' | 'autoLinks' | 'clustering'>;
  dryRun?: boolean;
}

export interface BatchResult {
  nodesProcessed: number;
  nearDupPairsFound: number;
  autoLinksCreated: number;
  communitiesUpdated: number;
  durationMs: number;
}

// ── DB-integrated functions ───────────────────────────────────────────────────
// Reads via vec.iter / graph.queryNodes; writes via graph.writeEdge / graph.writeNode.
// Incremental by default ([def:deterministic-first]).

export declare function clusterStore(
  vec: VectorBackend,
  graph: GraphBackend,
  opts?: ClusterOpts,
): Promise<ClusterResult>;

export declare function clusterSubset(
  vec: VectorBackend,
  graph: GraphBackend,
  filter: NodeFilter,
  opts?: ClusterOpts,
): Promise<SubsetClusterResult>;

export declare function detectNearDup(
  vec: VectorBackend,
  graph: GraphBackend,
  opts?: NearDupOpts,
): NearDupPair[];

/** Stores score at write time — never recomputes at query time ([def:deterministic-first]) */
export declare function computeImportance(
  vec: VectorBackend,
  graph: GraphBackend,
  opts?: ImportanceOpts,
): void;

/** Incremental — processes only un-scored nodes ([def:deterministic-first]) */
export declare function buildAutoLinks(
  vec: VectorBackend,
  graph: GraphBackend,
  opts?: AutoLinkOpts,
): void;

/** Orchestrates the above in dependency order; incremental by default */
export declare function runBatchEnrich(
  vec: VectorBackend,
  graph: GraphBackend,
  opts?: BatchOpts,
): Promise<BatchResult>;

// ── Pure algorithm exports — zero storage deps ────────────────────────────────
// These work with raw Float32Arrays from any source. Native deps are externalized in
// the esbuild bundle so importing only 'cluster' does not pull in native bindings.

export declare function cluster(
  vecs: Array<{ id: number; vec: Float32Array }>,
  opts?: ClusterOpts,
): ClusterResult;

export declare function detectNearDupPairs(
  vecs: Array<{ id: number; vec: Float32Array }>,
  opts?: NearDupOpts,
): NearDupPair[];

export declare function scoreImportance(node: {
  inDegree: number;
  outDegree: number;
  recencyMs: number;
  nearDupCount: number;
}): number;

// ── Graph algorithm exports ───────────────────────────────────────────────────
// Accept caller-supplied adjacency functions — work over any graph representation
// (in-memory, storage-backed, or synthetic), not just graph-store.

export interface TopoSortResult {
  /** Node IDs, leaves first */
  order: number[];
  /** nodeId → wave index (0 = no deps) */
  waves: Map<number, number>;
  /** First cycle found; null if DAG is acyclic */
  cycle: number[] | null;
}

/** O(V+E). Kahn's BFS for stable wave groupings; DFS fallback to recover the cycle path. */
export declare function topoSort(
  nodeIds: number[],
  getEdges: (id: number) => number[],
): TopoSortResult;

/** O(V+E). Reverse topological order DP. Returns nodeId → critical path length to terminal. */
export declare function criticalPath(
  nodeIds: number[],
  getEdges: (id: number) => number[],
  getWeight: (id: number) => number,
): Map<number, number>;

/** O(V+E). DFS with recursion stack. Returns ALL cycles (not just first — for user-facing errors). */
export declare function detectCycles(
  nodeIds: number[],
  getEdges: (id: number) => number[],
): Array<number[]>;

// ── packBatches — bin-packing with submodular shared cost ─────────────────────

export interface PackItem {
  id: number;
  /** Kᵢ — variable cost of this item alone */
  cost: number;
  /** Sᵢ — resource keys; shared resources are paid once per batch (submodular union) */
  resources: string[];
  /** cost of one resource key */
  resourceCost: (key: string) => number;
  /** Items that must appear in an earlier batch */
  deps: number[];
  /** Items with different groups cannot share a batch */
  group?: string;
}

export interface PackOpts {
  /** B — fixed overhead per batch */
  B: number;
  /** W — capacity constraint per batch */
  W: number;
  /**
   * Algorithm selection (default: 'auto'):
   *   N ≤ 20, any DAG     → 'bitmask-dp'            (exact, O(3^N))
   *   N ≤ 50, forest/SP  → 'tree-dp'                (exact, O(N²W))
   *   N ≤ 50, general    → 'simulated-annealing'     (~3-8% from optimal)
   *   N > 50             → 'hlfet'                   (2-1/P approx, O(N log N))
   * Use detectDAGStructure() to classify before calling with 'auto'.
   */
  algorithm?: 'auto' | 'bitmask-dp' | 'tree-dp' | 'simulated-annealing' | 'hlfet';
}

export interface PackResult {
  batches: Array<{
    items: number[];
    /** B + union(resource costs) + sum(item costs) */
    cost: number;
  }>;
  totalCost: number;
  algorithm: string;
}

export declare function packBatches(items: PackItem[], opts: PackOpts): PackResult;

// ── detectDAGStructure — for algorithm selection ──────────────────────────────

export type DAGStructure = 'forest' | 'series-parallel' | 'general';

/**
 * forest: every node has ≤1 parent
 * series-parallel: Valdes-Tarjan-Lawler reduction (polynomial)
 * general: fallback
 */
export declare function detectDAGStructure(
  nodeIds: number[],
  getEdges: (id: number) => number[],
): DAGStructure;

// ── setOverlapMatrix — pairwise intersection ──────────────────────────────────

export interface OverlapEntry {
  a: number;
  b: number;
  intersection: string[];
  /** sum of valueFn(key) for keys in intersection */
  bytes: number;
}

/**
 * All N*(N-1)/2 pairs. O(N²·|S|) exact.
 * valueFn default: () => 1 (unweighted count).
 */
export declare function setOverlapMatrix(
  items: Array<{ id: number; keys: string[] }>,
  valueFn?: (key: string) => number,
): OverlapEntry[];
`,

  ingest: `\
// @adhd/sox-ingest — ingest (area:data) — PRIVATE, never published
// SKELETON — implementation lands via the memory-refactor plan.
// Authoritative interface spec: docs/plan/memory-refactor/COMPILED_INTERFACES.md
//
// Concerns: ${PACKAGES.find((p) => p.name === 'ingest').concerns.join('; ')}
//
// Pure stateless functions — no I/O, no storage deps. Safe to call synchronously.
// Only the memory domain composer should call this package.

export interface IngestChunk {
  index: number;
  content: string;
  /** SHA-256 of this chunk's content */
  contentHash: string;
  /** Byte offset into original content */
  charOffset: number;
}

export interface IngestResult {
  /** SHA-256 of normalized content — used for graph-store dedup */
  contentHash: string;
  /** Extractive summary (sentence-scoring, no LLM) */
  summary: string;
  /** Extracted tags (noun phrases, high-frequency terms) */
  tags: string[];
  /** Populated only when opts.chunk is set */
  chunks?: IngestChunk[];
}

export interface IngestOpts {
  /** default: 3 */
  summaryMaxSentences?: number;
  /** default: 10 */
  tagMaxCount?: number;
  chunk?: {
    /** default: 2000 */
    maxChars?: number;
    /** default: 200 */
    overlapChars?: number;
  };
}

/** Pure function — no I/O, no storage deps. Safe to call synchronously. */
export declare function ingest(content: string, opts?: IngestOpts): IngestResult;
`,
};

// ── Generator functions ───────────────────────────────────────────────────────

const REL = '../../../../'; // libs/data/<group>/<name> → repo root (4 levels)

function pkgJson(p) {
  const priv = isPrivate(p);
  const j = {
    name: `@adhd/sox-${p.name}`,
    version: '0.1.0',
    description: p.description,
    license: 'MIT',
    ...(priv
      ? { private: true }
      : { private: false, publishConfig: { access: 'public' } }),
    engines: { node: p.engines },
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    files: ['dist'],
    ...(Object.keys(p.deps).length ? { dependencies: p.deps } : {}),
    // Routing metadata harvested by the routing-index generator (see NX-GENERATOR-HANDOFF.md §5).
    sox: {
      area: 'data',
      group: p.group,
      concerns: p.concerns,
      invariants: p.invariants,
      entrypoints: ['dist/index.js'],
    },
  };
  return JSON.stringify(j, null, 2) + '\n';
}

function projectJson(p) {
  const root = `libs/data/${p.group}/${p.name}`;
  return (
    JSON.stringify(
      {
        $schema: `${REL}node_modules/nx/schemas/project-schema.json`,
        name: p.name,
        projectType: 'library',
        root,
        sourceRoot: `${root}/src`,
        tags: ['type:lib', 'area:data', `group:${p.group}`],
        targets: {
          build: {
            executor: 'nx:run-commands',
            outputs: [`{workspaceRoot}/${root}/dist`],
            options: {
              command:
                `tsc --project ${root}/tsconfig.lib.json && ` +
                `echo '{"type":"module"}' > ${root}/dist/package.json`,
              cwd: '.',
            },
            cache: true,
            inputs: ['{projectRoot}/src/**/*.ts', '{projectRoot}/tsconfig.lib.json'],
          },
          test: {
            executor: 'nx:run-commands',
            options: {
              command: `vitest run --config ${root}/vitest.config.ts`,
              cwd: '.',
            },
            cache: true,
            inputs: ['default', '^production'],
          },
          lint: {
            executor: '@nx/eslint:lint',
            options: { lintFilePatterns: [`${root}/**/*.ts`] },
          },
        },
      },
      null,
      2,
    ) + '\n'
  );
}

const tsconfigLib = () =>
  JSON.stringify(
    {
      extends: `${REL}tsconfig.base.json`,
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'nodenext',
        outDir: './dist',
        rootDir: './src',
        declaration: true,
        declarationMap: true,
        sourceMap: true,
        esModuleInterop: true,
      },
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/**/*.test.ts', 'node_modules', 'dist'],
    },
    null,
    2,
  ) + '\n';

const vitestConfig = (p) =>
  `import { defineConfig } from 'vitest/config';\n` +
  `export default defineConfig({\n` +
  `  test: {\n` +
  `    root: '${`libs/data/${p.group}/${p.name}`}',\n` +
  `    include: ['src/**/*.{spec,test}.ts'],\n` +
  `  },\n` +
  `});\n`;

const indexTs = (p) => STUBS[p.name] ?? `// @adhd/sox-${p.name} — skeleton (no stubs defined)\nexport const __scaffold__ = '${p.name}';\n`;

const readme = (p) => {
  const pub = isPrivate(p) ? 'PRIVATE — not published to npm' : 'PUBLIC (`private: false`, publish owner-gated)';
  return (
    `# @adhd/sox-${p.name}\n\n` +
    `${p.description}\n\n` +
    `- **area:** data · **group:** ${p.group} · **publish:** ${pub}\n` +
    `- **engines:** Node ${p.engines}\n` +
    `- **concerns:** ${p.concerns.join(', ')}\n\n` +
    `## Invariants\n\n` +
    p.invariants.map((i) => `- ${i}`).join('\n') +
    `\n\n` +
    `## Interface spec\n\n` +
    `See [COMPILED_INTERFACES.md](../../../../docs/plan/memory-refactor/COMPILED_INTERFACES.md) for the` +
    ` authoritative interface contract. \`src/index.ts\` is a compileable ambient-declaration skeleton;\n` +
    `implementation is extracted from \`libs/memory-core\` / \`libs/memory-enrich\` by the memory-refactor plan.\n`
  );
};

const claudeMd = (p) => {
  const privNote = isPrivate(p)
    ? '\n## Publish posture\n\nPRIVATE — `private: true`. Never publish this package. Only the memory domain composer may import it.\n'
    : '';
  return (
    `# CLAUDE.md — data/${p.group}/${p.name}\n\n` +
    `Rules for working in this package (agent-routing layer; keep authoritative + minimal).\n\n` +
    `## Interface contract\n\n` +
    `The authoritative interface spec for this package is:\n` +
    `**[docs/plan/memory-refactor/COMPILED_INTERFACES.md](../../../../docs/plan/memory-refactor/COMPILED_INTERFACES.md)**\n\n` +
    `\`src/index.ts\` is a compileable skeleton of the interfaces — all types match that spec.\n` +
    `Do not add implementation code to \`src/index.ts\` directly; implementation lands via the\n` +
    `memory-refactor plan states.\n\n` +
    `## Invariants (do not violate)\n\n` +
    p.invariants.map((i) => `- ${i}`).join('\n') +
    `\n\n` +
    `## Boundaries\n\n` +
    `- \`area:data\` may import \`area:data\` + \`area:shared\` only — NEVER \`area:platform\`\n` +
    `  (enforced by nx module-boundary lint).\n` +
    `- Published npm name (\`@adhd/sox-${p.name}\`) is decoupled from this folder path —\n` +
    `  never rename the package name on a folder move.\n` +
    (Object.keys(p.deps).length
      ? `- Declared deps: \`${Object.keys(p.deps).join('`, `')}\`.\n` +
        `  Do not add undeclared deps without updating package.json + COMPILED_INTERFACES.md.\n`
      : '') +
    `\n## Build / test\n\n` +
    `- \`npx nx build ${p.name}\` · \`npx nx test ${p.name}\` · \`npx nx lint ${p.name}\`\n` +
    `- Build via nx targets only — bare \`tsc\` emits into \`src/\` and bypasses project graph.\n` +
    `- This is a data-layer library; it is NOT registered in \`registry/index.json\` —\n` +
    `  skip \`npx nx run registry:sync-index\` after changes here.\n` +
    privNote
  );
};

// ── Write ─────────────────────────────────────────────────────────────────────

let created = 0, skipped = 0;
for (const p of PACKAGES) {
  const dir = path.join(ROOT, 'libs', 'data', p.group, p.name);
  const files = {
    'package.json':      pkgJson(p),
    'project.json':      projectJson(p),
    'tsconfig.lib.json': tsconfigLib(),
    'vitest.config.ts':  vitestConfig(p),
    'src/index.ts':      indexTs(p),
    'README.md':         readme(p),
    'CLAUDE.md':         claudeMd(p),
  };
  for (const [rel, content] of Object.entries(files)) {
    const fp = path.join(dir, rel);
    const exists = fs.existsSync(fp);
    if (exists && !FORCE) { skipped++; continue; }
    if (DRY) {
      console.log(`${exists ? 'OVERWRITE' : 'CREATE  '} ${path.relative(ROOT, fp)}`);
      created++;
      continue;
    }
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content);
    created++;
  }
}

console.log(
  `\nscaffold-data-packages: ${DRY ? '[dry-run] ' : ''}` +
  `${created} file(s) ${DRY ? 'planned' : 'written'}, ${skipped} skipped (existing).`,
);
console.log(`packages: ${PACKAGES.map((p) => `data/${p.group}/${p.name}`).join(', ')}`);

const privateNames = PACKAGES.filter(isPrivate).map((p) => p.name);
const publicNames  = PACKAGES.filter((p) => !isPrivate(p)).map((p) => p.name);
if (publicNames.length)  console.log(`public  (private:false + publishConfig): ${publicNames.join(', ')}`);
if (privateNames.length) console.log(`private (private:true, never published):  ${privateNames.join(', ')}`);

if (!DRY) {
  console.log('\nnext steps:');
  console.log('  1. pnpm install       — resolve workspace deps (hybrid-search, analysis)');
  console.log('  2. npx nx build <name> — verify each skeleton compiles (no implementation yet)');
  console.log('  Note: registry:sync-index is NOT needed (data libs are not registry extensions)');
}
