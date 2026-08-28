// @adhd/sox-semantic — the semantic RAG composition layer (ADR-0016).
//
// A DI facade that wires @adhd/sox-graph-store + @adhd/sox-vector-store +
// @adhd/sox-embedding-provider into one embed/index/search/rank surface.
// It is the ADR-0006 "composer": live objects (open DB, provider instance,
// vector backend) cross in via the caller's StoreAdapter or explicit injection.
// It owns the node-join (semanticSearchNodes) and supplies the embedding-
// lifecycle observer (createEmbeddingObserver) — keeping graph-store base-tier
// and vector-store storage-tier pure.

import {
  createGraphBackend,
  type GraphBackend,
  type GraphWriteObserver,
  type NodeFilter,
  type NodeMeta,
  type NodeRecord,
} from '@adhd/sox-graph-store';
import {
  SqliteVectorBackend,
  TursoVectorBackend,
  type AsyncVectorBackend,
  type VectorBackend,
  type VectorSpace,
  type VecFilter,
} from '@adhd/sox-vector-store';
import {
  createEmbeddingProvider,
  type EmbeddingHealth,
  type EmbeddingProvider,
  type EmbeddingProviderConfig,
} from '@adhd/sox-embedding-provider';
import { rrfFuse } from '@adhd/sox-hybrid-search';
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

  // 1. Embedding provider (injected or config-derived).
  let provider: EmbeddingProvider;
  if (config.embeddingProvider) {
    provider = config.embeddingProvider;
  } else {
    try {
      provider = await createEmbeddingProvider(config.embedding);
    } catch (err) {
      return {
        ok: false,
        failure: { reason: 'provider_failed', detail: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  // 2. Vector backend (injected or capability-probed). nativeVectors:true → Turso
  //    (async), false → sqlite (sync), absent → unsupported.
  let vec: VectorBackend | AsyncVectorBackend;
  if (config.vectorBackend) {
    vec = config.vectorBackend;
  } else if (adapter.capabilities.nativeVectors === true) {
    vec = new TursoVectorBackend(adapter);
  } else if (adapter.capabilities.nativeVectors === false) {
    vec = new SqliteVectorBackend(adapter);
  } else {
    return {
      ok: false,
      failure: {
        reason: 'unsupported_adapter',
        detail: 'adapter reports no nativeVectors capability — cannot choose a vector backend',
      },
    };
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
