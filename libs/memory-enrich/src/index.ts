/**
 * @sox/memory-enrich — deterministic memory graph enrichment.
 * No LLM, no provider, no network. Byte-reproducible outputs.
 *
 * Public API per CONTRACTS.md C1.
 */

// ── Package version (C1.11) ───────────────────────────────────────────────────

/**
 * Semver of @sox/memory-enrich. Written into node.enrich_ver.pass on every enrichment pass.
 * A breaking change to the enrichment algorithm increments the major version and
 * triggers re-enrichment detection (UC10).
 */
export const ENRICH_VERSION = '1.0.0';

// ── Types (C1.1, C3.1–C3.4) ──────────────────────────────────────────────────

export type {
  EnrichableNode,
  EnrichmentProvenance,
  EpisodeSummary,
  NodeV1,
  CommunityNodeV1,
} from './types.js';

// ── C1.4 provenance ───────────────────────────────────────────────────────────

export { resolveProjectPath } from './provenance.js';

// ── C1.5 importance ───────────────────────────────────────────────────────────

export { computeImportance } from './importance.js';
export type { ImportanceInputs, ImportanceWeights } from './importance.js';

// ── C1.6 near-dup detection ───────────────────────────────────────────────────

export { detectNearDup } from './neardup.js';
export type { NearDupResult } from './neardup.js';

// ── C1.7 extractive summary ───────────────────────────────────────────────────

export { extractiveSummary } from './extractive.js';

// ── C1.8 + C1.10 clustering ───────────────────────────────────────────────────

export { clusterStore, clusterStats, clusterSubset, materializeClusters } from './cluster.js';
export type {
  ClusterResult,
  ClusterStoreOptions,
  ClusterStoreResult,
  ClusterStats,
  ClusterSubsetOptions,
  ClusterSubsetResult,
  MaterializeOptions,
} from './cluster.js';

// ── C1.11 structured filter + SQL builder ─────────────────────────────────────

export { buildFiltersClause } from './filters.js';
export type { MemoryFilter } from './filters.js';

// ── C1.9 auto-links ───────────────────────────────────────────────────────────

export { buildAutoLinks } from './autolink.js';
export type { AutoLinkResult } from './autolink.js';

// ── C1.2 write-path orchestrator ─────────────────────────────────────────────

export { enrichOnWrite } from './enrich.js';
export type { EnrichOnWriteParams, EnrichOnWriteResult } from './enrich.js';

// ── C1.3 batch-pass orchestrator ─────────────────────────────────────────────

export { runBatchEnrich } from './batch.js';
export type { BatchEnrichOptions, BatchEnrichResult } from './batch.js';
