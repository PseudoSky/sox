/**
 * libs/memory-core — shared internal library for the sox-memory subsystem.
 *
 * PROCESS BOUNDARY CONSTRAINT (BL-11):
 * `openDb()` (better-sqlite3 + sqlite-vec) and `await embed()` with the real ONNX backend
 * MUST NOT run in the same thread — both native addons share a libpthread mutex that is
 * corrupted across async boundaries ("mutex lock failed: Invalid argument").
 *
 * Safe patterns:
 *   1. Route writes through the MCP server process (memory-server handles DB writes; your
 *      process only calls the MCP tool over stdio/socket).
 *   2. Use the embed worker thread — `embed()` in this library already routes through
 *      embedWorker.ts (worker_threads), keeping ONNX isolated from the main thread.
 *   3. Set SOX_EMBED_BACKEND=hash to avoid loading onnxruntime-node entirely.
 *
 * The worker isolation (option 2) is already active in embed.ts, so direct callers of
 * `openDb()` + `await embed()` in the same process are safe as long as they go through
 * this library's `embed()` export (not a raw onnxruntime-node import). Do NOT bypass the
 * worker boundary by importing onnxruntime-node directly alongside better-sqlite3.
 *
 * Internal: not published. Consumed by the memory extensions (R9: co-located in bundle):
 *   - extensions/bundles/sox-memory-bundle/members/memory-server
 *   - extensions/bundles/sox-memory-bundle/members/memory-daemon
 *   - extensions/bundles/sox-memory-bundle/members/memory-flush
 *   - extensions/bundles/sox-memory-bundle/members/memory-cli
 *   - extensions/bundles/sox-memory-bundle (bundle manifest)
 *
 * Eliminates the cross-extension ../../../dist/ reach-in (C7, ref:no-cross-extension-reachin).
 */

// ── Database ──────────────────────────────────────────────────────────────────
export { openDb, openDbReadOnly, initScope, migrateAddColumn, expandDbPath, getDb, stampStoreMeta, verifyStoreMeta, setWriterArtifact, getWriterArtifact, EStoreMismatch, STORE_META_KEYS, STORE_SCHEMA_VERSION, closeAllDbs } from './db.js';
export type { ScopeKind, MemoryScope } from './db.js';

// ── Writer lease (SA-8, BL-128) ───────────────────────────────────────────────
export {
  acquireWriteLease,
  releaseWriteLease,
  closeDbWithLease,
  EWriterBusy,
  setLeaseInstanceId,
  getLeaseInstanceId,
  getActiveLease,
  getAllActiveLeases,
  isLeaseHeld,
  _resetAllLeasesForTest,
} from './lease.js';
export type { LeaseInfo } from './lease.js';

// ── Write queue (WP-1, BL-118) ────────────────────────────────────────────────
export { WriteQueue } from './write-queue.js';
export type { QueueBusyError, QueueError } from './write-queue.js';

// ── Error taxonomy (WP-2, BL-124) ─────────────────────────────────────────────
export { wrapDbError } from './errors.js';
export type { StorageError, StorageErrorCode } from './errors.js';

// ── Schema ────────────────────────────────────────────────────────────────────
export { PRAGMAS, DDL, FTS_TRIGGERS } from './schema.js';

// ── Embedding ─────────────────────────────────────────────────────────────────
export {
  EMBED_MODEL,
  EMBED_DIM,
  embed,
  embedText,
  vecToJson,
  vecToBuffer,
  getProviderCallCount,
  resetProviderCallCount,
  getActiveEmbedModel,
  getEmbedState,
  getLastEmbedError,
  getEmbedHealth,
  warmupEmbed,
  reembedNodes,
  _resetEmbedSingleton,
  _shutdownEmbedWorker,
} from './embed.js';
export type { EmbedBackend, EmbedConfig, EmbedState, EmbedHealth } from './embed.js';

// ── Write + invalidate + batch + idempotency ───────────────────────────────────
export { memoryWrite, memoryInvalidate, memoryWriteBatch, requestLedgerPrune } from './write.js';
export type {
  WriteParams,
  WriteResult,
  WriteError,
  InvalidateParams,
  InvalidateResult,
  InvalidateError,
  BatchItem,
  BatchItemOk,
  BatchItemError,
  BatchItemResult,
  BatchResult,
} from './write.js';

// ── Update (in-place editor) ──────────────────────────────────────────────────
export { memoryUpdate, deepMerge } from './update.js';
export type { UpdateParams, UpdateResult, UpdateError } from './update.js';

// ── Recall + federation ───────────────────────────────────────────────────────
export {
  memoryRecall,
  federatedRecall,
  getFederationConnection,
  closeFederationConnections,
  SCOPE_WEIGHTS,
  readRegistry,
  writeRegistry,
  discoverStores,
  ExpansionOverflowError,
  isSuperseded,
  supersedesUidForRowid,
  communityUidForRowid,
  rowidsToUids,
  parseTags,
  expandTilde,
} from './recall.js';
export type {
  RecallParams,
  RecallResult,
  RecallResponse,
  StoreDescriptor,
  FederatedRecallResponse,
  ParentContextConfig,
  LateChunkingConfig,
} from './recall.js';

// ── Daemon interop ────────────────────────────────────────────────────────────
export { enqueueIngest, enqueueReindex, enqueueEnrich, nudgeDaemon, MemoryDaemon, SOCKET_PATH } from './memoryd.js';

// ── Enrichment (write-time + batch) ───────────────────────────────────────────
export { enrichOnWrite } from './enrich.js';
export type { EnrichOnWriteParams, EnrichOnWriteResult } from './enrich.js';
export type { NearDupResult } from './neardup.js';
export { runBatchEnrich } from './enrich-batch.js';
export type { BatchEnrichOptions, BatchEnrichResult } from './enrich-batch.js';
export type { ImportanceWeights } from './importance.js';
export { ENRICH_VERSION } from './enrich-version.js';

// ── Internal enrichment helpers (exported for tests) ──────────────────────────
export { detectNearDup } from './neardup.js';
export { computeImportance } from './importance.js';
export { extractiveSummary } from './extractive.js';
export { resolveProjectPath } from './provenance.js';

// ── Filters ───────────────────────────────────────────────────────────────────
export { buildFiltersClause } from './memory-filters.js';
export type { MemoryFilter } from './memory-filters.js';

// ── Clustering ────────────────────────────────────────────────────────────────
export {
  clusterStats, clusterStore, clusterSubset, dropSubsetLens,
  listSubsetLenses, materializeClusters
} from './cluster.js';
export type {
  ClusterResult, ClusterStats, ClusterStoreOptions,
  ClusterStoreResult, ClusterSubsetOptions,
  ClusterSubsetResult, DropSubsetLensResult, MaterializeOptions,
  SubsetLensDescriptor
} from './cluster.js';

// ── Auto-links ────────────────────────────────────────────────────────────────
export { buildAutoLinks } from './autolink.js';
export type { AutoLinkResult } from './autolink.js';

// ── Extended functions (promotion, graphify, communities, entity search) ───────
export {
  validatePromotionConfig,
  detectPromotionCandidates,
  proposePendingCandidates,
  applyPromotion,
  rejectPromotion,
  getPromotionQueue,
  SUPPORTED_GRAPHIFY_SHAPES,
  fingerprintGraphifyShape,
  graphifyImport,
  buildCommunities,
  memoryGetCommunity,
  memorySearchEntities,
} from './extensions.js';
export type {
  PromotionConfig,
  PromotionConfigValidation,
  PromotionCandidateResult,
  ProposePendingResult,
  ApplyPromotionResult,
  RejectPromotionResult,
  GraphifyShapeSpec,
  GraphifyImportResult,
  GraphifyImportError,
  BuildCommunitiesOptions,
  BuildCommunitiesResult,
  GetCommunitySuccess,
  GetCommunityError,
  SearchEntitiesParams,
  SearchEntitiesResult,
} from './extensions.js';

// ── Markdown export mirror ────────────────────────────────────────────────────
export { exportMarkdown } from './export.js';
export type { ExportOpts, ExportResult } from './export.js';

// ── Store registry (SA-6 / BL-130) ───────────────────────────────────────────
export { readStoreRegistry, resolveStoreName, resolveStoreOrDbPath, computeFingerprint } from './store-registry.js';
export type { StoreRegistry, ResolvedStore, StoreResolveError } from './store-registry.js';

// ── Edge-based functions (graph-store backend) ────────────────────────────────
export { memoryLinkNode } from './link.js';
export type { LinkResult } from './link.js';
export { memoryGetRelated } from './related.js';
export type { RelatedResult, EdgeEntry, EpisodeBase } from './related.js';
export { memoryGetEntityEpisodes } from './entity-episodes.js';
export type { EntityEpisodesResult, EntityInfo, EpisodeSummary } from './entity-episodes.js';
export { memoryListEntities } from './list-entities.js';
export type { ListEntitiesResult, EntityListingEntry } from './list-entities.js';
export { memoryGetNearDuplicates } from './near-duplicates.js';
export type { NearDuplicatesResult, NearDuplicatePair } from './near-duplicates.js';
export { memoryGetSupersessionChain } from './supersession-chain.js';
export type { SupersessionChainResult, ChainLink } from './supersession-chain.js';
export { memoryGetSessionState, memorySaveSessionState } from './session.js';
export type { GetSessionStateResult, SaveSessionStateResult } from './session.js';

// ── Domain query functions (aggregate queries, curation, stats) ────────────────

export { memoryListTopics } from './topics.js';
export type { TopicsResult, TopicEntry } from './topics.js';
export { memoryListProjects } from './projects.js';
export type { ListProjectsResult, ProjectEntry } from './projects.js';
export { memoryCurate } from './curate.js';
export type {
  CurateResult,
  CurateRetagResult,
  CurateSetTopicResult,
  CurateSetImportanceResult,
  CurateMergeResult,
  CurateReclusterSubsetResult,
  CurateReclusterGlobalResult,
  CurateDropLensResult,
  CurateListLensesResult,
} from './curate.js';
export { memoryGetStats } from './stats.js';
export type { StatsResult } from './stats.js';

// ── Convenience wrappers (guard C5: write(dbPath, params) + recall(dbPath, params)) ──

import { openDb } from './db.js';
import { closeDbWithLease } from './lease.js';
import { memoryWrite as _write } from './write.js';
import { memoryRecall as _recall } from './recall.js';
import type { WriteParams, WriteResult, WriteError } from './write.js';
import type { RecallParams, RecallResult } from './recall.js';

/**
 * Convenience: open DB at dbPath, write an episode, close DB.
 * Returns WriteResult | WriteError.
 */
export async function write(
  dbPath: string,
  params: WriteParams,
): Promise<WriteResult | WriteError> {
  const db = openDb(dbPath);
  try {
    return await _write(db, params);
  } finally {
    closeDbWithLease(db, dbPath);
  }
}

/**
 * Convenience: open DB at dbPath, run hybrid recall, close DB.
 * Returns RecallResult[].
 */
export async function recall(
  dbPath: string,
  params: RecallParams,
): Promise<RecallResult[]> {
  const db = openDb(dbPath);
  try {
    const scope = (params.scopes && params.scopes[0]) ?? 'project';
    const res = await _recall(db, scope, params);
    return res.results;
  } finally {
    closeDbWithLease(db, dbPath);
  }
}
