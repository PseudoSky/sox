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
 * Internal: not published. Consumed by the 4 memory extensions (R9: co-located in bundle):
 *   - extensions/bundles/sox-memory-bundle/members/memory-server
 *   - extensions/bundles/sox-memory-bundle/members/memory-organizer
 *   - extensions/bundles/sox-memory-bundle/members/memory-flush
 *   - extensions/bundles/sox-memory-bundle/members/memory-cli
 *   - extensions/bundles/sox-memory-bundle (bundle manifest)
 *
 * Eliminates the cross-extension ../../../dist/ reach-in (C7, ref:no-cross-extension-reachin).
 */

// ── Database ──────────────────────────────────────────────────────────────────
export { openDb, openDbReadOnly, initScope } from './db.js';
export type { ScopeKind, MemoryScope } from './db.js';

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
  reembedNodes,
  _resetEmbedSingleton,
} from './embed.js';
export type { EmbedBackend, EmbedConfig } from './embed.js';

// ── Write + invalidate ────────────────────────────────────────────────────────
export { memoryWrite, memoryInvalidate } from './write.js';
export type {
  WriteParams,
  WriteResult,
  WriteError,
  InvalidateParams,
  InvalidateResult,
  InvalidateError,
} from './write.js';

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
} from './recall.js';
export type {
  RecallParams,
  RecallResult,
  RecallResponse,
  StoreDescriptor,
  FederatedRecallResponse,
} from './recall.js';

// ── Daemon interop ────────────────────────────────────────────────────────────
export { enqueueIngest, enqueueReindex, nudgeDaemon, MemoryDaemon, SOCKET_PATH } from './memoryd.js';
export type { OrganizerItem, OrganizerResult } from './memoryd.js';

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

// ── Convenience wrappers (guard C5: write(dbPath, params) + recall(dbPath, params)) ──

import { openDb } from './db.js';
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
    db.close();
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
    db.close();
  }
}
