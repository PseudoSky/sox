/**
 * SQLite schema DDL for sox-memory.
 * Single file per scope. Exact schema from design.md §2.2 (minus promotion_queue, deferred to P4).
 *
 * The canonical node/edge table DDL is owned by graph-store and imported here.
 * This module adds memory-only tables on top of the graph primitives.
 */

import { GRAPH_DDL, FTS_DDL as GraphFTS_DDL, FTS_TRIGGERS as GraphFTS_TRIGGERS } from '@adhd/sox-graph-store';
export const FTS_DDL = GraphFTS_DDL;

/**
 * CONTRACTS §C mandated pragmas for EVERY connection:
 *   - journal_mode = WAL
 *   - busy_timeout = 3000  (per contract; changed from 5000)
 *   - synchronous  = NORMAL
 *   - foreign_keys = ON
 *   - cache_size   = -64000
 *
 * (BL-391) `openDbReadOnly()` no longer applies `PRAGMA query_only = ON` —
 * on Turso that pragma blocks `fts_match`/`fts_score` the same way native
 * readonly does. Read-only enforcement instead comes from
 * `allowFtsInReadonly`'s application-level write guard on TursoAdapterImpl
 * (see turso-adapter.ts's `_assertWritable()`), and from the real OS-level
 * `readonly: true` on SqliteAdapter.
 */
export const PRAGMAS = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 3000;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA cache_size   = -64000;
`;

/** Memory-only DDL — graph primitives (node/edge/FTS) are in graph-store. */
const MEMORY_ONLY_DDL = `
-- scope metadata (one row)
CREATE TABLE IF NOT EXISTS memory_scope (
  scope        TEXT PRIMARY KEY CHECK (scope IN ('project','user','org','local')),
  scope_id     TEXT NOT NULL,
  embed_model  TEXT NOT NULL,
  embed_dim    INTEGER NOT NULL,
  schema_ver   INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL
);

-- store identity stamp (SA-5 / BL-121): written once at open-for-write, verified
-- on every subsequent open to detect version / embed-model / writer drift.
CREATE TABLE IF NOT EXISTS sox_store_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- batch-enrich trigger queue (formerly "organizer work queue").
-- 'ingest' and 'enrich' ops trigger a runBatchEnrich pass (deterministic, no LLM).
-- 'decay' and 'reindex' are handled in-daemon without the batch-enrich pass.
-- 'extract', 'link', 'consolidate' are legacy op codes accepted for backward compat.
CREATE TABLE IF NOT EXISTS organizer_queue (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  op         TEXT NOT NULL CHECK (op IN ('ingest','enrich','extract','link','consolidate','decay','reindex')),
  payload    TEXT NOT NULL,
  priority   INTEGER NOT NULL DEFAULT 100,
  enqueued   TEXT NOT NULL, claimed_at TEXT, done_at TEXT,
  attempts   INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_q_open ON organizer_queue(done_at, priority, seq) WHERE done_at IS NULL;

-- WP-4: request idempotency ledger (pruned >7 days on checkpoint tick)
CREATE TABLE IF NOT EXISTS request_ledger (
  request_id TEXT PRIMARY KEY,
  episode_uid TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_request_ledger_created_at ON request_ledger(created_at);

-- scope-promotion candidates (internal detail, surfaced via host ScopePromotionProposed event)
CREATE TABLE IF NOT EXISTS promotion_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  node_uid      TEXT NOT NULL, from_scope TEXT NOT NULL, to_scope TEXT NOT NULL,
  occurrences   INTEGER NOT NULL, first_seen TEXT NOT NULL, age_days INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','proposed','approved','rejected','applied')),
  decided_by    TEXT, decided_at TEXT
);

-- enrich_poison (BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001): rows whose embed/enrich
-- has failed >= poisonThreshold consecutive times. A poisoned row is EXCLUDED from
-- the periodic heal scan's retry window (it stays in node, still recallable via
-- BM25/temporal — the row is NEVER dropped) until an operator unpoisons it or a
-- successful embed clears it. The failure count is the ONLY gate — nothing here
-- mutates node content.
CREATE TABLE IF NOT EXISTS enrich_poison (
  uid TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  first_poisoned_at TEXT NOT NULL,
  last_failed_at TEXT NOT NULL
);
`;

/** Base DDL without both vec0 and FTS5 — what every adapter gets.
 *  FTS5 is applied separately only for adapters that report fts5 capability.
 *  vec0 DDL is produced by the VectorDialect at open time. */
export const DDL_BASE = GRAPH_DDL + '\n' + MEMORY_ONLY_DDL;

/** FTS5 content table trigger for auto-sync — re-exported from graph-store. */
export const FTS_TRIGGERS = GraphFTS_TRIGGERS;
