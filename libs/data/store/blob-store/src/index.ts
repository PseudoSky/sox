// @adhd/sox-blob-store — content-addressable blob storage
// Spec: docs/plan/blob-store/SPEC.md

export {
  BlobStoreError,
  BlobNotFound,
  IntegrityMismatch,
  GCInProgress,
  BlobStoreSystemError,
  BlobStoreNotOpenError,
} from './errors.js';

export type { FdGuard } from './fd-guard.js';
export { InProcessFdGuard } from './fd-guard.js';

export { applySchema, SCHEMA_SQL } from './schema.js';

export type { GCOpts, GcBlobInfo, GcResult } from './gc.js';

export {
  BlobStore,
  createBlobStore,
  sha256Hex,
  isNotFound,
} from './store.js';
export type {
  StoreConfig,
  ExportStats,
  BlobStoreMetrics,
  VerificationResult,
} from './store.js';
