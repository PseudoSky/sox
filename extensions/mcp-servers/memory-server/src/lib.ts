/**
 * sox-memory public library barrel.
 *
 * Re-exports all symbols from the compiled memory-server package sub-modules.
 * This is the single import point that replaces the hand-maintained root-level mirror (now deleted).
 *
 * Importers should use:
 *   import { openDb, memoryWrite, ... } from '@sox/extension-memory-server/lib';
 * or via relative path (for tools/):
 *   import { ... } from '../extensions/mcp-servers/memory-server/dist/lib.js';
 */

// Database connection + scope init
export { openDb, openDbReadOnly, initScope } from './db.js';
export type { ScopeKind, MemoryScope } from './db.js';

// Embedding + vector utilities
export {
  EMBED_MODEL,
  EMBED_DIM,
  getProviderCallCount,
  resetProviderCallCount,
  embedText,
  vecToJson,
  vecToBuffer,
} from './embed.js';

// Schema constants
export { PRAGMAS, DDL, FTS_TRIGGERS } from './schema.js';

// Write + invalidate
export { memoryWrite, memoryInvalidate } from './write.js';
export type {
  WriteParams,
  WriteResult,
  WriteError,
  InvalidateParams,
  InvalidateResult,
  InvalidateError,
} from './write.js';

// Recall + federation
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

// Daemon interop (enqueue + nudge)
export { enqueueIngest, nudgeDaemon, SOCKET_PATH } from './memoryd.js';
export type { OrganizerItem, OrganizerResult } from './memoryd.js';

// Extended functions: promotion, graphify, communities, entity search
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
