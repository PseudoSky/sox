// ── SQLite schema for @adhd/sox-blob-store ────────────────────────────────────
// STRICT tables per ADR/design convention. Schema matches §5 of SPEC.md.

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS refs (
  blob_hash    TEXT    NOT NULL,
  referrer     TEXT    NOT NULL,
  t_created    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  t_touched    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  context      TEXT,
  PRIMARY KEY (blob_hash, referrer),
  FOREIGN KEY (blob_hash) REFERENCES blob_meta(hash) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS blob_meta (
  hash         TEXT    PRIMARY KEY,
  size         INTEGER NOT NULL,
  pinned       INTEGER NOT NULL DEFAULT 0,
  mime_type    TEXT,
  t_created    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_refs_referrer ON refs(referrer);
CREATE INDEX IF NOT EXISTS idx_refs_t_created ON refs(t_created);
CREATE INDEX IF NOT EXISTS idx_blob_meta_t_created ON blob_meta(t_created);
CREATE INDEX IF NOT EXISTS idx_blob_meta_pinned ON blob_meta(pinned);

CREATE TABLE IF NOT EXISTS gc_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  t_started      TEXT    NOT NULL,
  t_ended        TEXT,
  dry_run        INTEGER NOT NULL DEFAULT 0,
  blobs_marked   INTEGER NOT NULL DEFAULT 0,
  blobs_deleted  INTEGER NOT NULL DEFAULT 0,
  bytes_freed    INTEGER NOT NULL DEFAULT 0,
  error          TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_gc_runs_t_started ON gc_runs(t_started);
` as const;

import type { StoreAdapter } from '@adhd/sox-store-adapter';

/**
 * Apply the blob store schema to an open SQLite database.
 * Idempotent — uses IF NOT EXISTS for all tables and indexes.
 */
export async function applySchema(adapter: StoreAdapter): Promise<void> {
  await adapter.exec(SCHEMA_SQL);
}
