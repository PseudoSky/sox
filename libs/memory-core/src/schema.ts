/**
 * SQLite schema DDL for sox-memory.
 * Single file per scope. Exact schema from design.md §2.2 (minus promotion_queue, deferred to P4).
 */

/**
 * CONTRACTS §C mandated pragmas for EVERY connection:
 *   - journal_mode = WAL
 *   - busy_timeout = 3000  (per contract; changed from 5000)
 *   - synchronous  = NORMAL
 *   - foreign_keys = ON
 *   - cache_size   = -64000
 *
 * Read-only connections additionally apply `query_only = ON` in openDbReadOnly().
 */
export const PRAGMAS = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 3000;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA cache_size   = -64000;
`;

export const DDL = `
-- scope metadata (one row)
CREATE TABLE IF NOT EXISTS memory_scope (
  scope        TEXT PRIMARY KEY CHECK (scope IN ('project','user','org','local')),
  scope_id     TEXT NOT NULL,
  embed_model  TEXT NOT NULL,
  embed_dim    INTEGER NOT NULL,
  schema_ver   INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL
);

-- nodes (Episode/Entity/Claim/Community/Session unified)
CREATE TABLE IF NOT EXISTS node (
  rowid        INTEGER PRIMARY KEY,
  uid          TEXT UNIQUE NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('episode','entity','claim','community','session')),
  content      TEXT, name TEXT, summary TEXT,
  meta         TEXT,  -- caller-supplied metadata (JSON); persisted, not dropped
  agent_id     TEXT,
  session_id   TEXT,
  source       TEXT CHECK (source IN ('message','tool_output','observation','document','reflection','import')),
  importance   REAL DEFAULT 1.0,
  confidence   REAL,
  content_hash TEXT,
  level        INTEGER,
  resume_state TEXT,
  t_created    TEXT NOT NULL, t_occurred TEXT,
  t_valid      TEXT,  t_invalid TEXT,
  last_access  TEXT,  access_count INTEGER DEFAULT 0,
  t_updated    TEXT
);
CREATE INDEX IF NOT EXISTS ix_node_kind       ON node(kind);
CREATE INDEX IF NOT EXISTS ix_node_hash       ON node(content_hash);
CREATE INDEX IF NOT EXISTS ix_node_agent      ON node(agent_id);
CREATE INDEX IF NOT EXISTS ix_node_session    ON node(session_id);
CREATE INDEX IF NOT EXISTS ix_node_validity   ON node(t_invalid) WHERE t_invalid IS NULL;
CREATE INDEX IF NOT EXISTS ix_node_importance ON node(importance);
CREATE INDEX IF NOT EXISTS ix_node_temporal   ON node(t_invalid, t_created DESC) WHERE t_invalid IS NULL;

-- edges (bi-temporal)
CREATE TABLE IF NOT EXISTS edge (
  rowid     INTEGER PRIMARY KEY,
  src       INTEGER NOT NULL REFERENCES node(rowid) ON DELETE CASCADE,
  dst       INTEGER NOT NULL REFERENCES node(rowid) ON DELETE CASCADE,
  rel       TEXT NOT NULL CHECK (rel IN
              ('MENTIONS','SUPPORTS','RELATES_TO','SUPERSEDES','DERIVED_FROM','MEMBER_OF','PART_OF','SAME_AS','ASSIGNED_TO')),
  weight     REAL DEFAULT 1.0, confidence REAL,
  origin     TEXT CHECK (origin IN ('extracted','inferred','user_asserted')),
  t_created  TEXT NOT NULL, t_expired TEXT,
  t_valid    TEXT,          t_invalid TEXT,
  meta       TEXT
);
CREATE INDEX IF NOT EXISTS ix_edge_src  ON edge(src, rel) WHERE t_expired IS NULL;
CREATE INDEX IF NOT EXISTS ix_edge_dst  ON edge(dst, rel) WHERE t_expired IS NULL;
CREATE INDEX IF NOT EXISTS ix_edge_live ON edge(t_invalid) WHERE t_invalid IS NULL;

-- vec0 virtual table (dim from embed_model: 768 for nomic)
CREATE VIRTUAL TABLE IF NOT EXISTS vec_node USING vec0(node_id INTEGER PRIMARY KEY, embedding FLOAT[768]);

-- FTS5 virtual table
CREATE VIRTUAL TABLE IF NOT EXISTS fts_node USING fts5(content, name, summary,
  content='node', content_rowid='rowid', tokenize='unicode61');

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

-- scope-promotion candidates (internal detail; surfaced via host ScopePromotionProposed event)
CREATE TABLE IF NOT EXISTS promotion_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  node_uid      TEXT NOT NULL, from_scope TEXT NOT NULL, to_scope TEXT NOT NULL,
  occurrences   INTEGER NOT NULL, first_seen TEXT NOT NULL, age_days INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','proposed','approved','rejected','applied')),
  decided_by    TEXT, decided_at TEXT
);
`;

/** FTS5 content table trigger for auto-sync */
export const FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS fts_node_ai AFTER INSERT ON node BEGIN
  INSERT INTO fts_node(rowid, content, name, summary)
    VALUES (new.rowid, new.content, new.name, new.summary);
END;
CREATE TRIGGER IF NOT EXISTS fts_node_ad AFTER DELETE ON node BEGIN
  INSERT INTO fts_node(fts_node, rowid, content, name, summary)
    VALUES ('delete', old.rowid, old.content, old.name, old.summary);
END;
CREATE TRIGGER IF NOT EXISTS fts_node_au AFTER UPDATE ON node BEGIN
  INSERT INTO fts_node(fts_node, rowid, content, name, summary)
    VALUES ('delete', old.rowid, old.content, old.name, old.summary);
  INSERT INTO fts_node(rowid, content, name, summary)
    VALUES (new.rowid, new.content, new.name, new.summary);
END;
`;
