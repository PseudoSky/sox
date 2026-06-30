// ── GC types for @adhd/sox-blob-store ─────────────────────────────────────────
// The mark-and-sweep algorithm lives in BlobStore.gc() in store.ts.
// This module exports the types consumed by the public API.

export interface GCOpts {
  /** When true, identify orphaned blobs but do NOT delete them. */
  dryRun?: boolean;
  /** Override the configured grace period for this GC run. */
  gracePeriodMs?: number;
  /** Maximum blobs to delete in this run. */
  maxDelete?: number;
}

export interface GcBlobInfo {
  hash: string;
  size: number;
  lastRefRemoved: string | null;
  tCreated: string;
}

export interface GcResult {
  dryRun: boolean;
  tStarted: string;
  tEnded: string;
  durationMs: number;

  /** Phase 1: mark — identified orphans */
  orphans: GcBlobInfo[];
  totalOrphanBytes: number;

  /** Phase 2: sweep — actually deleted */
  deleted: number;
  bytesFreed: number;

  /** Per-blob errors during sweep */
  errors: Array<{ hash: string; error: string }>;
}

/** Internal row shape from the gc_runs table. */
export interface GcResultRow {
  id: number;
  t_started: string;
  t_ended: string | null;
  dry_run: number;
  blobs_marked: number;
  blobs_deleted: number;
  bytes_freed: number;
  error: string | null;
}
