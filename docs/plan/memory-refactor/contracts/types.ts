/**
 * types.ts — shared primitive types and the DI connection seam.
 *
 * These are the authoritative type definitions for the public data/* packages.
 * Each published package imports from here or declares these locally as type-only
 * aliases — they are structurally identical across packages (not nominal/branded).
 *
 * Packaging note: these aliases are so thin that creating a separate @adhd/sox-types
 * package is NOT recommended (see CONTRACTS.md §Design Decisions). Each public package
 * defines ModelId/Dim/EmbeddingVector locally; this file is the reference document that
 * ensures they stay consistent.
 *
 * Decision C / [def:connection-seam]: the composer (memory-core) owns openDb().
 * graph-store and vector-store each accept an INJECTED Database — they never call
 * `new Database(...)` themselves.
 */

// ── Embedding primitive ────────────────────────────────────────────────────────

/**
 * A single L2-normalised embedding vector.
 * Concretely a Float32Array; the alias documents the semantic role.
 */
export type EmbeddingVector = Float32Array;

// ── Space-identity primitives ──────────────────────────────────────────────────

/**
 * Model identifier string (e.g. 'BAAI/bge-base-en-v1.5').
 * Not a branded type — plain string at the call site (no casting required).
 * Shared across embedding-provider, vector-store, and analysis.
 */
export type ModelId = string;

/**
 * Vector dimension (e.g. 384, 768, 1024).
 * Not branded — plain number at the call site.
 * MUST match the active provider's dim; enforced at runtime by [inv:space].
 */
export type Dim = number;

// ── Provider metadata ──────────────────────────────────────────────────────────

/**
 * Metadata carried by every resolved EmbedProvider.
 * The {providerId, modelId, dim, isDeterministic, isRemote} tuple the SCOPE names.
 */
export interface ProviderMetadata {
  /** Stable identifier for the provider implementation, e.g. 'fastembed', 'remote'. */
  readonly providerId: string;
  /** Model identifier string, e.g. 'BAAI/bge-base-en-v1.5'. */
  readonly modelId: ModelId;
  /** Output dimension of this model. MUST equal the vec0 column dim ([inv:space]). */
  readonly dim: Dim;
  /** True for the hash/deterministic provider. False for ONNX/remote providers. */
  readonly isDeterministic: boolean;
  /** True when the provider makes network calls (remote adapter). False for local ONNX. */
  readonly isRemote: boolean;
}

// ── DI connection seam (Decision C / [def:connection-seam]) ───────────────────

/**
 * The injected-connection type.
 *
 * The composer (memory-core) opens the SQLite file via openDb(), loads sqlite-vec,
 * applies pragmas, then passes the resulting Database to graph-store.applyGraphSchema()
 * and vector-store.applyVecSchema(). Neither store opens the file itself.
 *
 * Concretely: better-sqlite3's Database. Every public package that accepts an injected
 * connection uses this alias so the seam is named at one source of truth.
 *
 * NOTE: the actual import in each package is:
 *   import type { Database as InjectedDb } from 'better-sqlite3';
 * better-sqlite3 is declared external in every public package's build config.
 */
export type { Database as InjectedDb } from 'better-sqlite3';
