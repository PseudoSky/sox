// @adhd/sox-semantic — the semantic RAG composition layer (ADR-0016).
//
// A DI facade that wires @adhd/sox-graph-store + @adhd/sox-vector-store +
// @adhd/sox-embedding-provider into one embed/index/search/rank surface.
// It is the ADR-0006 "composer": live objects (open DB, provider instance,
// vector backend) cross in via the caller's StoreAdapter or explicit injection.
// It owns the node-join (semanticSearchNodes) and supplies the embedding-
// lifecycle observer (createEmbeddingObserver) — keeping graph-store base-tier
// and vector-store storage-tier pure.
//
// OPTIONAL LOADABILITY
// @adhd/sox-vector-store and @adhd/sox-embedding-provider are OPTIONAL
// dependencies: each drags a native chain (sqlite-vec / better-sqlite3 /
// lancedb; onnxruntime / fastembed) that must not be a load-time requirement. A
// caller that injects BOTH `embeddingProvider` and `vectorBackend` never needs
// either package, so neither specifier may be resolved on that path. Their value
// surfaces are therefore reached only through the lazy loaders below, and their
// types arrive as type-only imports (erased at emit). See the
// `optional-loadability.spec.ts` resolve-hook guard, which loads the built
// artifact in a child process and fails if either specifier is requested.

import {
  createGraphBackend,
  type GraphBackend,
  type GraphWriteObserver,
  type NodeFilter,
  type NodeMeta,
  type NodeRecord,
} from '@adhd/sox-graph-store';
import type {
  AsyncVectorBackend,
  VectorBackend,
  VectorSpace,
  VecFilter,
} from '@adhd/sox-vector-store';
import type {
  EmbeddingHealth,
  EmbeddingProvider,
  EmbeddingProviderConfig,
} from '@adhd/sox-embedding-provider';
import type { StoreAdapter } from '@adhd/sox-store-adapter';

// ── Public types ──────────────────────────────────────────────────────────────

export interface SemanticBackendConfig {
  /** The graph store's adapter — the shared connection for graph + vector tables. */
  adapter: StoreAdapter;
  /** Embedding provider config ({ type, model, options }). */
  embedding: EmbeddingProviderConfig;
  /** Vector space; defaults to provider.metadata (modelId + dimensions). */
  space?: { modelId: string; dim: number };

  // ── Extension seams (pluggability, ADR-0006 DI) ──
  /** Optional injected provider; default: createEmbeddingProvider(embedding). */
  embeddingProvider?: EmbeddingProvider;
  /** Optional injected vector backend; default: capability-probed. */
  vectorBackend?: VectorBackend | AsyncVectorBackend;
}

export type SemanticFailure =
  | { reason: 'not_installed'; detail: string }
  | { reason: 'provider_failed'; detail: string }
  | { reason: 'unsupported_adapter'; detail: string }
  | { reason: 'vector_store_failed'; detail: string };

export type SemanticBackendResult =
  | { ok: true; backend: SemanticBackend }
  | { ok: false; failure: SemanticFailure };

export interface EmbedDocumentResult {
  index: number;        // position in the input `texts` array
  vec?: Float32Array;   // present on success
  error?: string;       // present on per-document failure (never both)
}

export interface SemanticSearchOpts {
  nodeFilter?: NodeFilter;
  limit?: number;
  offset?: number;
  liveOnly?: boolean;
}

export interface SemanticBackend {
  readonly modelId: string;
  readonly dim: number;
  embedQuery(text: string): Promise<Float32Array>;
  embedDocuments(texts: string[]): AsyncIterable<EmbedDocumentResult>;
  upsertVector(nodeId: number, vec: Float32Array): Promise<void>;
  upsertVectors(items: Array<{ nodeId: number; vec: Float32Array }>): Promise<void>;
  deleteVector(nodeId: number): Promise<void>;
  semanticSearchNodes(query: string, opts?: SemanticSearchOpts): Promise<Array<{ node: NodeRecord; score: number }>>;
  health(): EmbeddingHealth;
}

// ── Lazy loading of the optional native-chain packages ────────────────────────

/**
 * The specifiers are held in VARIABLES, never written as literals at the import
 * site. A literal `import('@adhd/sox-vector-store')` is statically analysable,
 * so a bundler (esbuild/rollup) is free to hoist it back into an eager import —
 * which would silently restore the mandatory native load this package exists
 * without. A non-literal specifier is opaque to static analysis, so it can only
 * ever be a genuine runtime `import()`, resolved solely when the branch that
 * needs it is taken.
 */
const VECTOR_STORE_SPECIFIER = '@adhd/sox-vector-store';
const EMBEDDING_PROVIDER_SPECIFIER = '@adhd/sox-embedding-provider';
/**
 * `@adhd/sox-hybrid-search` is a MANDATORY dependency (the node-join's RRF
 * fusion lives there), but its entrypoint re-exports `cross-encoder.js`, which
 * statically imports `@adhd/sox-embedding-provider`. A static import here would
 * therefore resolve the optional package on EVERY path — including the injected
 * one — defeating the invariant above. It is loaded lazily instead.
 */
const HYBRID_SEARCH_SPECIFIER = '@adhd/sox-hybrid-search';

/**
 * The value surface of the optional packages, expressed as `typeof import(...)`
 * so the shape stays derived from the real package (one source of truth) rather
 * than a hand-copied interface that can drift.
 */
interface VectorStoreModule {
  SqliteVectorBackend: typeof import('@adhd/sox-vector-store').SqliteVectorBackend;
  TursoVectorBackend: typeof import('@adhd/sox-vector-store').TursoVectorBackend;
}
interface EmbeddingProviderModule {
  createEmbeddingProvider: typeof import('@adhd/sox-embedding-provider').createEmbeddingProvider;
}
interface HybridSearchModule {
  rrfFuse: typeof import('@adhd/sox-hybrid-search').rrfFuse;
}

/**
 * Resolve an optional dependency at runtime, mapping "the package is not
 * installed" onto the typed `not_installed` failure instead of letting
 * `ERR_MODULE_NOT_FOUND` escape as a throw — `createSemanticBackend` never
 * throws for a configurable failure.
 */
async function loadOptional<T>(
  specifier: string,
  neededBy: string,
): Promise<{ ok: true; mod: T } | { ok: false; failure: SemanticFailure }> {
  try {
    const mod = (await import(/* @vite-ignore */ specifier)) as T;
    return { ok: true, mod };
  } catch (err) {
    return {
      ok: false,
      failure: {
        reason: 'not_installed',
        detail:
          `"${specifier}" could not be loaded (needed by ${neededBy}). ` +
          `Inject the corresponding live object to avoid the dependency: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

/** Load the mandatory hybrid-search surface, preserving the original cause. */
async function loadHybridSearch(): Promise<HybridSearchModule> {
  try {
    return (await import(/* @vite-ignore */ HYBRID_SEARCH_SPECIFIER)) as HybridSearchModule;
  } catch (err) {
    throw new Error(
      `"${HYBRID_SEARCH_SPECIFIER}" could not be loaded; it is a mandatory dependency of ` +
        `@adhd/sox-semantic, required by semanticSearchNodes' reciprocal-rank fusion.`,
      { cause: err },
    );
  }
}

// ── Internal: sync/async vector backend normalization ─────────────────────────

interface VecOps {
  ensureSpace(space: VectorSpace): Promise<void>;
  upsert(id: number, vec: Float32Array, space: VectorSpace): Promise<void>;
  upsertVectors(items: Array<{ id: number; vec: Float32Array }>, space: VectorSpace): Promise<void>;
  delete(id: number, modelId: string): Promise<void>;
  knn(
    query: Float32Array,
    space: VectorSpace,
    k: number,
    filter?: VecFilter,
  ): Promise<Array<{ id: number; score: number }>>;
}

/** Normalize the sync `VectorBackend` and async `AsyncVectorBackend` to one
 *  async surface (the facade is uniformly async). */
function vecOps(vec: VectorBackend | AsyncVectorBackend): VecOps {
  return {
    ensureSpace: async (space) => { await vec.ensureSpace(space); },
    upsert: async (id, v, space) => { await vec.upsert(id, v, space); },
    upsertVectors: async (items, space) => { await vec.upsertVectors(items, space); },
    delete: async (id, modelId) => { await vec.delete(id, modelId); },
    knn: async (query, space, k, filter) => await vec.knn(query, space, k, filter),
  };
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * ADR-0016 — the semantic composition seam. Returns a typed result, never
 * throws for a configurable failure (provider/vector-store/adapter). The
 * caller's StoreAdapter is the shared connection; live objects cross via DI.
 */
export async function createSemanticBackend(
  config: SemanticBackendConfig,
): Promise<SemanticBackendResult> {
  const { adapter } = config;

  // 1. Embedding provider (injected, or config-derived via the OPTIONAL
  //    @adhd/sox-embedding-provider — resolved only when nothing was injected).
  let provider: EmbeddingProvider;
  if (config.embeddingProvider) {
    provider = config.embeddingProvider;
  } else {
    const loaded = await loadOptional<EmbeddingProviderModule>(
      EMBEDDING_PROVIDER_SPECIFIER,
      'the config-derived embedding-provider path (inject config.embeddingProvider to avoid it)',
    );
    if (!loaded.ok) return loaded;
    try {
      provider = await loaded.mod.createEmbeddingProvider(config.embedding);
    } catch (err) {
      return {
        ok: false,
        failure: { reason: 'provider_failed', detail: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  // 2. Vector backend (injected, or capability-probed via the OPTIONAL
  //    @adhd/sox-vector-store — resolved only when nothing was injected).
  //    nativeVectors:true → Turso (async), false → sqlite (sync), absent → unsupported.
  let vec: VectorBackend | AsyncVectorBackend;
  if (config.vectorBackend) {
    vec = config.vectorBackend;
  } else {
    const nativeVectors = adapter.capabilities.nativeVectors;
    if (nativeVectors !== true && nativeVectors !== false) {
      return {
        ok: false,
        failure: {
          reason: 'unsupported_adapter',
          detail: 'adapter reports no nativeVectors capability — cannot choose a vector backend',
        },
      };
    }
    const loaded = await loadOptional<VectorStoreModule>(
      VECTOR_STORE_SPECIFIER,
      'the capability-probed vector-backend path (inject config.vectorBackend to avoid it)',
    );
    if (!loaded.ok) return loaded;
    vec = nativeVectors
      ? new loaded.mod.TursoVectorBackend(adapter)
      : new loaded.mod.SqliteVectorBackend(adapter);
  }

  // 3. Graph backend for the node-join (semanticSearchNodes).
  const graph: GraphBackend = createGraphBackend(adapter);

  // 4. Space (explicit or derived from provider metadata).
  const space: VectorSpace = config.space ?? {
    modelId: provider.metadata.modelId,
    dim: provider.metadata.dimensions,
  };

  const ops = vecOps(vec);
  try {
    await ops.ensureSpace(space);
  } catch (err) {
    return {
      ok: false,
      failure: { reason: 'vector_store_failed', detail: err instanceof Error ? err.message : String(err) },
    };
  }

  const backend: SemanticBackend = {
    modelId: space.modelId,
    dim: space.dim,

    async embedQuery(text: string): Promise<Float32Array> {
      return provider.embedSingle(text, 'query');
    },

    async *embedDocuments(texts: string[]): AsyncIterable<EmbedDocumentResult> {
      let index = 0;
      try {
        for await (const vec of provider.embedBatch(texts)) {
          yield { index, vec };
          index += 1;
        }
      } catch (err) {
        // A batch failure mid-iteration: surface it on the current index rather
        // than silently dropping the remainder.
        yield { index, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async upsertVector(nodeId: number, v: Float32Array): Promise<void> {
      await ops.upsert(nodeId, v, space);
    },

    async upsertVectors(items: Array<{ nodeId: number; vec: Float32Array }>): Promise<void> {
      await ops.upsertVectors(items.map(({ nodeId, vec }) => ({ id: nodeId, vec })), space);
    },

    async deleteVector(nodeId: number): Promise<void> {
      await ops.delete(nodeId, space.modelId);
    },

    async semanticSearchNodes(
      query: string,
      opts?: SemanticSearchOpts,
    ): Promise<Array<{ node: NodeRecord; score: number }>> {
      const limit = opts?.limit ?? 10;
      const offset = opts?.offset ?? 0;
      const liveOnly = opts?.liveOnly ?? true;
      const qVec = await provider.embedSingle(query, 'query');

      // FEAT-022 — delegate the fusion to hybrid-search's N-signal RRF. The
      // facade owns the node-join (DEBT-011): realize the matching (live,
      // filtered) nodes once, rank them by text (graph.searchNodes) and vec
      // (knn), then RRF-fuse — no longer vector-only. A title/body text match
      // now surfaces even when its vector is not the nearest.
      const nodeFilter: NodeFilter = { ...(opts?.nodeFilter ?? {}), liveOnly };
      const matches = await graph.queryNodes(nodeFilter);
      const ids = matches.map((n) => n.id);
      const byId = new Map<number, NodeRecord>(matches.map((n) => [n.id, n]));

      const fetchLimit = limit + offset;
      const ranked = new Map<string, number[]>();

      const textResults = await graph.searchNodes(query, { limit: fetchLimit, filter: nodeFilter });
      if (textResults.length > 0) ranked.set('text', textResults.map((r) => r.id));

      if (ids.length > 0) {
        const hits = await ops.knn(qVec, space, fetchLimit, { ids });
        if (hits.length > 0) ranked.set('vec', hits.map((h) => h.id));
      }

      // Lazily loaded — see HYBRID_SEARCH_SPECIFIER. Mandatory dependency, so a
      // failure here is a broken install, not a configurable failure; the throw
      // carries the original cause.
      const { rrfFuse } = await loadHybridSearch();

      const weights = new Map<string, number>([['text', 1], ['vec', 1]]);
      const fused = rrfFuse(ranked, weights);

      return fused
        .slice(offset, offset + limit)
        .flatMap((f) => {
          const node = byId.get(f.id);
          return node ? [{ node, score: f.score }] : [];
        });
    },

    health(): EmbeddingHealth {
      return provider.health();
    },
  };

  return { ok: true, backend };
}

/**
 * FEAT-021 — the embedding-lifecycle observer the host registers on its OWN
 * graph backend (`createGraphBackend(adapter, { observers: [observer] })`).
 * Embeds on write and deletes the vector on invalidate — never throws (degrades
 * to a log), never fabricates a placeholder vector.
 */
export function createEmbeddingObserver(backend: SemanticBackend): GraphWriteObserver {
  return {
    async onNodeWritten(node: NodeRecord, _meta: NodeMeta): Promise<void> {
      try {
        const vec = await backend.embedQuery(node.content);
        await backend.upsertVector(node.id, vec);
      } catch {
        // Embedding failure must not corrupt the data write — degrade silently
        // here; the reconciliation pass (reembed/prune) catches the gap.
      }
    },
    async onNodeInvalidated(nodeId: number): Promise<void> {
      try {
        await backend.deleteVector(nodeId);
      } catch {
        // A missing vector table/vector is not an error for delete.
      }
    },
  };
}
