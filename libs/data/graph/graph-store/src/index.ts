// @adhd/sox-graph-store — Bi-temporal graph store over StoreAdapter
import {
  createFTSDialect,
  deleteSchemaRowsViaBetterSqlite3,
  RepairDeclinedLivePeersError,
} from '@adhd/sox-store-adapter';
import { assertStoreEngineSync, getEngineIdentitySync } from '@adhd/sox-store-adapter';
import type { AdapterTransaction, EngineIdentity, StoreAdapter, TursoAdapter } from '@adhd/sox-store-adapter';
import { log } from '@adhd/sox-telemetry';
import * as crypto from 'node:crypto';
import { rebuildTable } from './rebuild-table.js';
export { rebuildTable };

/**
 * Connection PRAGMAs applied by applySchema(). BUG-SOXGRAPH-002: `busy_timeout`
 * is deliberately NOT here — the write-contention contract is adapter-owned.
 * SqliteAdapter sets `PRAGMA busy_timeout = 3000` at connect (sqlite-adapter.ts);
 * Turso no-ops unknown PRAGMAs and the driver default applies. A second
 * graph-store-level busy_timeout would clobber the adapter's chosen value on
 * every applySchema and split the knob between two owners.
 */
export const PRAGMAS: string[] = [
  'PRAGMA journal_mode = WAL;',
  'PRAGMA synchronous = NORMAL;',
  'PRAGMA foreign_keys = ON;',
  'PRAGMA cache_size = -64000;',
];

/**
 * BL-430 — every JSON-bearing column carries `CHECK (col IS NULL OR json_valid(col))`.
 *
 * BL-342 wrote the empty string `''` into `node.tags` / `node.enrich_ver`. `''`
 * is not valid JSON, so any statement whose `json_extract` / `json_each`
 * touched it aborted — which took `memory_stats` offline entirely until BL-343
 * made the aggregate row-resilient. BL-343 makes the store *survive* the shape;
 * this constraint stops it being writable in the first place.
 *
 * **Scope: new stores only, and that is a deliberate decision, not an
 * omission.** `CREATE TABLE IF NOT EXISTS` no-ops against an existing `node` /
 * `edge` table, so an existing store keeps exactly the schema it has and
 * nothing about this change touches its data. SQLite cannot
 * `ALTER TABLE … ADD CONSTRAINT`; acquiring the constraint on a populated store
 * would require create-new / copy / drop / rename on a table carrying a Turso
 * FTS index — which BL-337 records as un-`REINDEX`-able, BL-361 records as able
 * to PANIC the process, and BL-313 records as having already caused one
 * CRITICAL data-loss incident on this very store. Existing stores are covered
 * by the detective control instead: `json_column_valid` (BL-342) runs in the
 * `fast` integrity pass on every open, detects the shape, and repairs it.
 *
 * The constraint spells only `json_valid`. It deliberately does NOT also
 * forbid `'[]'` (the BL-428 residue shape): `'[]'` is valid JSON, so rejecting
 * it would turn any writer that has not yet been taught the NULL convention
 * into a hard write failure. That normalisation belongs in the repair path
 * (`json_empty_array_null`), where it is corrective rather than fatal.
 */
const JSON_COLUMN_CHECK = (column: string): string =>
  ` CHECK (${column} IS NULL OR json_valid(${column}))`;

/**
 * The node/edge DDL. `jsonChecks: false` yields the **pre-BL-430 shape** —
 * byte-for-byte what every store created before 2026-08-04 carries.
 *
 * Both forms come from this one template on purpose. The legacy form exists
 * solely so fixtures can construct a genuine legacy store (see
 * {@link GRAPH_DDL_PRE_BL430}); generating it from the same source is what
 * stops the fixture's idea of "a store without the constraint" drifting away
 * from the real population it is standing in for.
 */
function graphDdl(opts: { jsonChecks: boolean }): string {
  const jsonCheck = (column: string): string =>
    opts.jsonChecks ? JSON_COLUMN_CHECK(column) : '';
  return `
CREATE TABLE IF NOT EXISTS node (
  rowid        INTEGER PRIMARY KEY,
  uid          TEXT UNIQUE NOT NULL,
  kind         TEXT NOT NULL,
  content      TEXT,
  name         TEXT,
  summary      TEXT,
  topic        TEXT,
  tags         TEXT${jsonCheck('tags')},
  importance   REAL DEFAULT 1.0,
  confidence   REAL,
  content_hash TEXT,
  namespace    TEXT DEFAULT 'global',
  meta         TEXT${jsonCheck('meta')},
  agent_id     TEXT,
  session_id   TEXT,
  source       TEXT CHECK (source IN ('message','tool_output','observation','document','reflection','import')),
  project_path TEXT,
  level        INTEGER,
  resume_state TEXT,
  t_occurred   TEXT,
  t_expires    TEXT,
  t_created    TEXT NOT NULL,
  t_valid      TEXT,
  t_invalid    TEXT,
  is_superseded INTEGER DEFAULT 0,
  access_count INTEGER DEFAULT 0,
  last_access  TEXT,
  t_updated    TEXT
);

CREATE TABLE IF NOT EXISTS edge (
  rowid     INTEGER PRIMARY KEY,
  src       INTEGER NOT NULL REFERENCES node ON DELETE CASCADE,
  dst       INTEGER NOT NULL REFERENCES node ON DELETE CASCADE,
  rel       TEXT NOT NULL,
  weight    REAL DEFAULT 1.0,
  confidence REAL,
  origin    TEXT CHECK (origin IN ('extracted','inferred','user_asserted')),
  meta      TEXT${jsonCheck('meta')},
  t_created TEXT NOT NULL,
  t_expired TEXT,
  t_valid   TEXT,
  t_invalid TEXT
);

CREATE INDEX IF NOT EXISTS ix_node_kind       ON node(kind);
CREATE INDEX IF NOT EXISTS ix_node_hash       ON node(content_hash);
CREATE INDEX IF NOT EXISTS ix_node_agent      ON node(agent_id);
CREATE INDEX IF NOT EXISTS ix_node_session    ON node(session_id);
CREATE INDEX IF NOT EXISTS ix_node_validity   ON node(t_invalid) WHERE t_invalid IS NULL;
CREATE INDEX IF NOT EXISTS ix_node_importance ON node(importance);
CREATE INDEX IF NOT EXISTS ix_node_temporal   ON node(t_invalid, t_created DESC) WHERE t_invalid IS NULL;
CREATE INDEX IF NOT EXISTS ix_node_topic      ON node(topic) WHERE topic IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_node_project    ON node(project_path) WHERE project_path IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_node_namespace  ON node(namespace);
CREATE INDEX IF NOT EXISTS ix_node_expires    ON node(t_expires) WHERE t_expires IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_edge_src        ON edge(src, rel) WHERE t_expired IS NULL;
CREATE INDEX IF NOT EXISTS ix_edge_dst        ON edge(dst, rel) WHERE t_expired IS NULL;
CREATE INDEX IF NOT EXISTS ix_edge_live       ON edge(t_invalid) WHERE t_invalid IS NULL;
-- (PERF-MEMORY-002) The two indexes above are partial on t_expired IS NULL, but
-- essentially every hot traversal filters on t_invalid IS NULL -- a DIFFERENT
-- column. SQLite may only use a partial index when the query's WHERE provably
-- implies the index predicate, and t_invalid IS NULL does not imply
-- t_expired IS NULL, so those indexes are UNUSABLE for live-edge queries and
-- the planner falls back to a scan.
--
-- Measured on the production store (61,694 edges), 2026-08-14:
--   WHERE src=? AND rel=? AND t_invalid IS NULL -> SEARCH USING ix_edge_unique (src=?)  [rel unusable]
--   WHERE src=? AND rel=? AND t_expired IS NULL -> SEARCH USING ix_edge_src (src=? AND rel=?)
--   NOT EXISTS (... e.dst=? AND e.t_invalid IS NULL) -> SCAN edge USING ix_edge_live
-- That SCAN runs once per candidate community row inside community GC, which is
-- why a single memory_invalidate cost ~11.9s against a ~1.4s write and ~0.5s
-- recall. After adding the two indexes below: 11,638ms -> 15ms, a 775x drop,
-- and the plan becomes SEARCH e USING ix_edge_dst_live (dst=? AND rel=?).
-- enrich-batch.ts:164-170 documents the identical pathology from the other
-- direction (47,619 rows scanned per call) -- it was fixed at that ONE call
-- site and never in the schema.
--
-- NOTE FOR FUTURE EDITORS: this DDL is inside a JS template literal. Do not use
-- backticks in these comments -- they terminate the literal and break the file.
--
-- Additive and non-destructive: no existing index is dropped, so every planner
-- choice that was valid before remains available.
CREATE INDEX IF NOT EXISTS ix_edge_src_live   ON edge(src, rel) WHERE t_invalid IS NULL;
CREATE INDEX IF NOT EXISTS ix_edge_dst_live   ON edge(dst, rel) WHERE t_invalid IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ix_edge_unique ON edge(src, dst, rel);
-- (PERF-MEMORY-005) ix_node_kind above is a plain (non-partial) index on
-- kind alone, and ix_node_validity is a plain (non-partial) index scoped to
-- t_invalid alone -- neither covers the extremely common
-- "kind = ? AND t_invalid IS NULL" shape used throughout memory-core
-- (stats.ts, autolink.ts, cluster.ts, cluster-metrics.ts, list-entities.ts,
-- entity-episodes.ts, topics.ts, enrich-batch.ts, community-gc.ts -- dozens
-- of call sites). Measured on the production store (11,757 nodes),
-- 2026-08-14: SELECT COUNT(*) FROM node WHERE kind='episode' AND
-- t_invalid IS NULL planned as SCAN node USING INDEX ix_node_validity
-- (row-by-row kind filter over all ~11,613 live nodes, ~186ms) instead of a
-- direct SEARCH. A partial index whose predicate matches the query's
-- t_invalid IS NULL clause turns that into SEARCH node USING INDEX
-- ix_node_kind_live (kind=?): 186ms -> 0.6ms measured, ~300x. Additive only.
-- No existing index is dropped.
--
-- WARNING TO FUTURE EDITORS: applySchema splits this template on the statement
-- separator character, so ANY occurrence of that character inside a SQL comment
-- here silently becomes a phantom statement. An earlier wording of this comment
-- ended with "Additive only" followed by that character and the word "nothing",
-- which split into a fragment starting with "nothing" and made every openDb()
-- against a fresh store die with 'failed to consume stmt' -- taking 6
-- memory-core tests down. The replacement warning then repeated the mistake by
-- quoting the character itself. Keep every comment in this template free of it.
CREATE INDEX IF NOT EXISTS ix_node_kind_live  ON node(kind) WHERE t_invalid IS NULL;
`;
}

/** The canonical graph schema. Carries the BL-430 `json_valid` CHECKs. */
export const GRAPH_DDL = graphDdl({ jsonChecks: true });

/**
 * The schema **as it was before BL-430** — no `json_valid` CHECK on any column.
 *
 * This is not dead code and it is not a fallback: it is the shape every store
 * created before 2026-08-04 still has, and it exists so a test can construct a
 * genuine legacy store rather than pretend one. `stats-bl343-row-resilience.spec.ts`
 * has to insert `tags = ''` — the BL-342 shape — to prove `memory_stats` stays
 * up on a store that already contains it. Under the constrained schema that
 * INSERT is (correctly) rejected, so the fixture pre-creates `node` from this
 * DDL and lets the store's own `CREATE TABLE IF NOT EXISTS` no-op over it.
 *
 * That is deliberately the *same* mechanism by which a real legacy store keeps
 * its unconstrained schema, so the fixture cannot drift from the population it
 * stands in for — and it needs no raw-SQL escape hatch, no test-only pragma,
 * and no ability to defeat the constraint on a store that has it.
 */
export const GRAPH_DDL_PRE_BL430 = graphDdl({ jsonChecks: false });

export const FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS fts_node USING fts5(content, name, summary,
  content='node', content_rowid='rowid', tokenize='unicode61');
`;

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

/**
 * Drizzle-generated create-if-absent DDL for standalone `GraphStore` consumers.
 * Carries the same BL-430 `json_valid` CHECKs as {@link GRAPH_DDL}, on the same
 * new-stores-only terms — `IF NOT EXISTS` no-ops against an existing table.
 *
 * `NODE_TABLE_DDL` / `EDGE_TABLE_DDL` below deliberately do **not** carry them:
 * those feed `rebuildTable`, which copies an existing populated table's rows
 * into a fresh one. A CHECK there would abort the migration on any store that
 * already holds the BL-342 shape — turning a schema upgrade into an outage on
 * exactly the stores that need it most.
 */
export const INLINE_MIGRATION_DDL = `
CREATE TABLE IF NOT EXISTS "node" (
  "rowid" integer PRIMARY KEY NOT NULL,
  "uid" text NOT NULL,
  "kind" text NOT NULL,
  "content" text,
  "name" text,
  "summary" text,
  "topic" text,
  "tags" text CHECK ("tags" IS NULL OR json_valid("tags")),
  "importance" real DEFAULT 1.0,
  "confidence" real,
  "content_hash" text,
  "namespace" text DEFAULT 'global',
  "meta" text CHECK ("meta" IS NULL OR json_valid("meta")),
  "agent_id" text,
  "session_id" text,
  "source" text CHECK ("source" IN ('message','tool_output','observation','document','reflection','import')),
  "project_path" text,
  "level" integer,
  "resume_state" text,
  "t_occurred" text,
  "t_expires" text,
  "t_created" text NOT NULL,
  "t_valid" text,
  "t_invalid" text,
  "is_superseded" integer DEFAULT 0,
  "access_count" integer DEFAULT 0,
  "last_access" text,
  "t_updated" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "edge" (
  "rowid" integer PRIMARY KEY NOT NULL,
  "src" integer NOT NULL REFERENCES "node" ON DELETE CASCADE,
  "dst" integer NOT NULL REFERENCES "node" ON DELETE CASCADE,
  "rel" text NOT NULL,
  "weight" real DEFAULT 1.0,
  "confidence" real,
  "origin" text CHECK ("origin" IN ('extracted','inferred','user_asserted')),
  "meta" text CHECK ("meta" IS NULL OR json_valid("meta")),
  "t_created" text NOT NULL,
  "t_expired" text,
  "t_valid" text,
  "t_invalid" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "node_uid_unique" ON "node" ("uid");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_node_kind" ON "node" ("kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_node_hash" ON "node" ("content_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_node_agent" ON "node" ("agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_node_session" ON "node" ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_node_validity" ON "node" ("t_invalid") WHERE "t_invalid" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_node_importance" ON "node" ("importance");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_node_temporal" ON "node" ("t_invalid", "t_created" DESC) WHERE "t_invalid" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_node_topic" ON "node" ("topic") WHERE "topic" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_node_project" ON "node" ("project_path") WHERE "project_path" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_node_namespace" ON "node" ("namespace");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_node_expires" ON "node" ("t_expires") WHERE "t_expires" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_edge_src" ON "edge" ("src", "rel") WHERE "t_expired" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_edge_dst" ON "edge" ("dst", "rel") WHERE "t_expired" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_edge_live" ON "edge" ("t_invalid") WHERE "t_invalid" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_edge_src_live" ON "edge" ("src", "rel") WHERE "t_invalid" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_edge_dst_live" ON "edge" ("dst", "rel") WHERE "t_invalid" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ix_edge_unique" ON "edge" ("src", "dst", "rel");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_node_kind_live" ON "node" ("kind") WHERE "t_invalid" IS NULL;
`;

export const DEFAULT_NODE_KINDS = ['episode', 'entity', 'claim', 'community', 'session', 'generic'] as const;

export const NODE_TABLE_DDL = `CREATE TABLE node (
  rowid        INTEGER PRIMARY KEY,
  uid          TEXT UNIQUE NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('episode','entity','claim','community','session','generic')),
  content      TEXT,
  name         TEXT,
  summary      TEXT,
  topic        TEXT,
  tags         TEXT,
  importance   REAL DEFAULT 1.0,
  confidence   REAL,
  content_hash TEXT,
  namespace    TEXT DEFAULT 'global',
  meta         TEXT,
  agent_id     TEXT,
  session_id   TEXT,
  source       TEXT CHECK (source IN ('message','tool_output','observation','document','reflection','import')),
  project_path TEXT,
  level        INTEGER,
  resume_state TEXT,
  t_occurred   TEXT,
  t_expires    TEXT,
  t_created    TEXT NOT NULL,
  t_valid      TEXT,
  t_invalid    TEXT,
  is_superseded INTEGER DEFAULT 0,
  access_count INTEGER DEFAULT 0,
  last_access  TEXT,
  t_updated    TEXT
)`;

export const EDGE_TABLE_DDL = `CREATE TABLE edge (
  rowid     INTEGER PRIMARY KEY,
  src       INTEGER NOT NULL REFERENCES node ON DELETE CASCADE,
  dst       INTEGER NOT NULL REFERENCES node ON DELETE CASCADE,
  rel       TEXT NOT NULL CHECK (rel IN ('MENTIONS','SUPPORTS','RELATES_TO','SUPERSEDES','DERIVED_FROM','MEMBER_OF','PART_OF','SAME_AS','ASSIGNED_TO','DEPENDS_ON')),
  weight    REAL DEFAULT 1.0,
  confidence REAL,
  origin    TEXT CHECK (origin IN ('extracted','inferred','user_asserted')),
  meta      TEXT,
  t_created TEXT NOT NULL,
  t_expired TEXT,
  t_valid   TEXT,
  t_invalid TEXT
)`;

/**
 * PKT-61 (BL-442) — the operator open-schema migration's target DDL for `node`.
 *
 * Byte-identical to {@link NODE_TABLE_DDL} with only the `CHECK (kind IN (...))` clause removed
 * — `kind` becomes plain `TEXT NOT NULL`, matching {@link INLINE_MIGRATION_DDL}'s shape. Copied
 * verbatim from `ensure-check-constraints.bl447.spec.ts`'s `OPEN_SCHEMA_NODE_DDL` (proven-correct
 * 28-column fixture; see SPEC-PKT-61.md §2.1) rather than derived by regex-stripping the CHECK out
 * of `NODE_TABLE_DDL` — do not "simplify" this into a derivation, per that spec's explicit ruling.
 */
export const NODE_TABLE_DDL_OPEN = `CREATE TABLE node (
  rowid        INTEGER PRIMARY KEY,
  uid          TEXT UNIQUE NOT NULL,
  kind         TEXT NOT NULL,
  content      TEXT,
  name         TEXT,
  summary      TEXT,
  topic        TEXT,
  tags         TEXT,
  importance   REAL DEFAULT 1.0,
  confidence   REAL,
  content_hash TEXT,
  namespace    TEXT DEFAULT 'global',
  meta         TEXT,
  agent_id     TEXT,
  session_id   TEXT,
  source       TEXT CHECK (source IN ('message','tool_output','observation','document','reflection','import')),
  project_path TEXT,
  level        INTEGER,
  resume_state TEXT,
  is_superseded INTEGER DEFAULT 0,
  t_occurred   TEXT,
  t_expires    TEXT,
  t_created    TEXT NOT NULL,
  t_valid      TEXT,
  t_invalid    TEXT,
  access_count INTEGER DEFAULT 0,
  last_access  TEXT,
  t_updated    TEXT
)`;

/**
 * PKT-61 (BL-442) — the operator open-schema migration's target DDL for `edge`.
 *
 * Byte-identical to {@link EDGE_TABLE_DDL} with only the `CHECK (rel IN (...))` clause removed —
 * `rel` becomes plain `TEXT NOT NULL`. Copied verbatim from
 * `ensure-check-constraints.bl447.spec.ts`'s `OPEN_SCHEMA_EDGE_DDL`; see {@link NODE_TABLE_DDL_OPEN}.
 */
export const EDGE_TABLE_DDL_OPEN = `CREATE TABLE edge (
  rowid     INTEGER PRIMARY KEY,
  src       INTEGER NOT NULL REFERENCES node ON DELETE CASCADE,
  dst       INTEGER NOT NULL REFERENCES node ON DELETE CASCADE,
  rel       TEXT NOT NULL,
  weight    REAL DEFAULT 1.0,
  confidence REAL,
  origin    TEXT CHECK (origin IN ('extracted','inferred','user_asserted')),
  meta      TEXT,
  t_created TEXT NOT NULL,
  t_expired TEXT,
  t_valid   TEXT,
  t_invalid TEXT
)`;

export const NODE_COLUMNS = [
  'rowid', 'uid', 'kind', 'content', 'name', 'summary', 'topic', 'tags',
  'importance', 'confidence', 'content_hash', 'namespace', 'meta', 'agent_id',
  'session_id', 'source', 'project_path', 'level', 'resume_state', 't_occurred',
  't_expires', 't_created', 't_valid', 't_invalid', 'is_superseded',
  'access_count', 'last_access', 't_updated',
];

export const EDGE_COLUMNS = [
  'rowid', 'src', 'dst', 'rel', 'weight', 'confidence', 'origin', 'meta',
  't_created', 't_expired', 't_valid', 't_invalid',
];

export const NODE_INDEX_DDLS = [
  `CREATE INDEX IF NOT EXISTS ix_node_kind       ON node(kind)`,
  `CREATE INDEX IF NOT EXISTS ix_node_hash       ON node(content_hash)`,
  `CREATE INDEX IF NOT EXISTS ix_node_agent      ON node(agent_id)`,
  `CREATE INDEX IF NOT EXISTS ix_node_session    ON node(session_id)`,
  `CREATE INDEX IF NOT EXISTS ix_node_validity   ON node(t_invalid) WHERE t_invalid IS NULL`,
  `CREATE INDEX IF NOT EXISTS ix_node_importance ON node(importance)`,
  `CREATE INDEX IF NOT EXISTS ix_node_temporal   ON node(t_invalid, t_created DESC) WHERE t_invalid IS NULL`,
  `CREATE INDEX IF NOT EXISTS ix_node_topic      ON node(topic) WHERE topic IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS ix_node_project    ON node(project_path) WHERE project_path IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS ix_node_namespace  ON node(namespace)`,
  `CREATE INDEX IF NOT EXISTS ix_node_expires    ON node(t_expires) WHERE t_expires IS NOT NULL`,
  // (PERF-MEMORY-005) Partial index matching the extremely common
  // "kind = ? AND t_invalid IS NULL" shape -- see the matching comment next
  // to CREATE INDEX ix_node_kind_live in graphDdl() for the measured
  // before/after (SCAN ix_node_validity, ~186ms -> SEARCH ix_node_kind_live,
  // ~0.6ms on the production store). Additive only.
  `CREATE INDEX IF NOT EXISTS ix_node_kind_live  ON node(kind) WHERE t_invalid IS NULL`,
];

export const EDGE_INDEX_DDLS = [
  `CREATE INDEX IF NOT EXISTS ix_edge_src        ON edge(src, rel) WHERE t_expired IS NULL`,
  `CREATE INDEX IF NOT EXISTS ix_edge_dst        ON edge(dst, rel) WHERE t_expired IS NULL`,
  `CREATE INDEX IF NOT EXISTS ix_edge_live       ON edge(t_invalid) WHERE t_invalid IS NULL`,
  // (PERF-MEMORY-002 follow-up) This array is the one actually re-applied by
  // this class's own ensureCheckConstraints() self-heal rebuild (BL-507/
  // BL-508) AND by the sibling operator-invoked CHECK-removal migration
  // module -- i.e. every legacy/turso store that rebuilds its edge table at
  // open. graphDdl()'s inline template literal got the ix_edge_src_live/
  // ix_edge_dst_live fix (see the comment above CREATE INDEX ix_edge_src_live
  // in graphDdl()); this standalone array did not, so any store that
  // rebuilds edge via one of THOSE paths -- which BL-507's own comment says
  // the live backlog.db does -- would silently regress back to the 11.9s
  // SCAN this pair fixes. Additive only; nothing above is dropped.
  `CREATE INDEX IF NOT EXISTS ix_edge_src_live   ON edge(src, rel) WHERE t_invalid IS NULL`,
  `CREATE INDEX IF NOT EXISTS ix_edge_dst_live   ON edge(dst, rel) WHERE t_invalid IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ix_edge_unique ON edge(src, dst, rel)`,
];

/**
 * Split a multi-statement DDL string into individual `;`-terminated statements,
 * stripping Drizzle's `--> statement-breakpoint` marker lines.
 *
 * Turso/libSQL validates each index definition against the live schema and
 * rejects `CREATE INDEX IF NOT EXISTS` on an object that already exists
 * (unlike SQLite, which no-ops) — so a multi-statement exec() aborts at the
 * first existing index on a re-opened store. applySchema() runs each
 * statement separately and treats "already exists" as benign (the same
 * pattern memory-core's openDb() uses). The DDL here is hand-maintained and
 * contains no semicolons inside string literals.
 */
function splitSqlStatements(ddl: string): string[] {
  return ddl
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const lines = s.split('\n').filter((l) => !/^\s*-->\s*statement-breakpoint\s*$/i.test(l.trim()));
      return `${lines.join('\n').trim()};`;
    })
    .filter((s) => s.trim().length > 1);
}

export class ConstraintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConstraintError';
  }
}

export class BitemporalConflictError extends Error {
  public readonly nodeId: number;
  constructor(message: string, nodeId: number) {
    super(message);
    this.name = 'BitemporalConflictError';
    this.nodeId = nodeId;
  }
}

export class NodeNotFoundError extends Error {
  public readonly nodeId: number;
  constructor(message: string, nodeId: number) {
    super(message);
    this.name = 'NodeNotFoundError';
    this.nodeId = nodeId;
  }
}

/**
 * The branded-string widening pattern (ADR-0010 D4, BL-444, BL-448/PKT-74): the ten known rels
 * still autocomplete in every parameter position (`writeEdge(src, dst, rel: EdgeRel, ...)`,
 * `getEdges({ rel })`, etc. — `(string & {})` prevents TypeScript from collapsing the union to
 * bare `string`), while any other string is still assignable — the SQL `rel` CHECK is gone from
 * the fresh-store DDL (see `graphDdl()`/`INLINE_MIGRATION_DDL` above) and an injected `TypePolicy`
 * is the only remaining vocabulary gate (PKT-59/BL-440).
 *
 * This is source-breaking in RETURN position, not additive: a consumer that exhaustively
 * `switch`es on `EdgeRecord.rel` (or otherwise narrows `EdgeRel` to `never` in a default arm)
 * stops compiling once this widens, because the `default` arm's type is no longer `never` — it is
 * `string & {}`. No in-repo consumer does this today (confirmed by grep against
 * `libs/memory-core/src` and this package's own `src`), but `@adhd/sox-graph-store` is published
 * (`private: false`) and BL-444 records this as a real risk for an external consumer. See
 * `open-rel-check.bl448.spec.ts`'s AC-Type for a demonstrated (not merely asserted) compile break.
 */
export type EdgeRel =
  | 'MENTIONS'
  | 'SUPPORTS'
  | 'RELATES_TO'
  | 'DERIVED_FROM'
  | 'SUPERSEDES'
  | 'SAME_AS'
  | 'ASSIGNED_TO'
  | 'MEMBER_OF'
  | 'PART_OF'
  | 'DEPENDS_ON'
  | (string & {});

export type Confidence = 'confirmed' | 'unverified' | 'disputed' | 'deprecated';

export interface NodeMeta {
  kind?: string;
  name?: string;
  summary?: string;
  topic?: string;
  tags?: string[];
  importance?: number;
  confidence?: Confidence;
  source?: string;
  agentId?: string;
  projectPath?: string;
  sessionId?: string;
  namespace?: string;
  tOccurred?: string;
  tExpires?: string;
  metadata?: Record<string, unknown>;
}

export interface NodeRecord {
  id: number;
  kind: string;
  content: string;
  name?: string;
  summary?: string;
  topic?: string;
  tags: string[];
  importance?: number;
  confidence?: Confidence;
  tCreated: string;
  tValid: string;
  tInvalid?: string;
  tExpires?: string;
  isSuperseded: boolean;
  isStale: boolean;
  namespace: string;
  metadata?: Record<string, unknown>;
}

export interface EdgeMeta {
  weight?: number;
  metadata?: Record<string, unknown>;
}

export interface EdgeRecord {
  src: number;
  dst: number;
  rel: EdgeRel;
  weight?: number;
  tCreated: string;
  metadata?: Record<string, unknown>;
}

/**
 * FEAT-014 — the complete metadata filter operator set. A metadata value is an
 * operator object iff it is a plain object carrying at least one of these keys;
 * otherwise it is a scalar equality (back-compat). Bounds are compared via
 * `json_extract`, so ISO-8601 strings sort chronologically and numbers compare
 * numerically. All present operators on one key AND together.
 */
export interface MetadataFilter {
  eq?: MetadataScalar;                        // = ?            (eq: null → IS NULL)
  neq?: MetadataScalar;                       // != ?           (neq: null → IS NOT NULL)
  in?: MetadataScalar[];                      // IN (?, …)
  gt?: string | number;                       // >
  gte?: string | number;                      // >=
  lt?: string | number;                       // <
  lte?: string | number;                      // <=
  between?: [string | number, string | number]; // >= a AND <= b
  /** `exists: true` → IS NOT NULL; `false` → IS NULL. Presence/absence of the key. */
  exists?: boolean;
  /** Array membership (or scalar equality) via `json_each(meta, '$.key')`. */
  contains?: MetadataScalar;
}

export type MetadataScalar = string | number | boolean | null;

export type MetadataFilterValue = MetadataScalar | MetadataFilter;

/** A sort target: a named node column, or a metadata key resolved via `json_extract`. */
export type SortField =
  | 'importance'
  | 'tCreated'
  | 'tValid'
  | 'name'
  | { metadata: string };

export type SortDirection = 'asc' | 'desc';

export interface NodeFilter {
  ids?: number[];
  kind?: string | string[];
  topic?: string | string[];
  tags?: string[];
  tagsMatchAll?: boolean;
  importanceMin?: number;
  confidence?: Confidence | Confidence[];
  tCreatedAfter?: string;
  tCreatedBefore?: string;
  tUpdatedAfter?: string;
  tUpdatedBefore?: string;
  validAt?: string;
  isStale?: boolean;
  namespace?: string;
  projectPath?: string;
  agentId?: string;
  /** FEAT-011 — filter on the `name` column (equality, or `IN` when an array). */
  name?: string | string[];
  /** FEAT-010 — include invalidated (soft-deleted) nodes. Default `true`. */
  liveOnly?: boolean;
  metadata?: Record<string, MetadataFilterValue>;
  /** Single sort field, or an array for a multi-key ORDER BY. */
  orderBy?: SortField | SortField[];
  /** Per-key direction; an array aligns by index with `orderBy`. Defaults per field. */
  orderDir?: SortDirection | SortDirection[];
  limit?: number;
  offset?: number;
  /**
   * FEAT-024 (C) — keyset cursor. When set, the query compiles to
   * `WHERE rowid > ? ORDER BY rowid ASC` (ignoring `orderBy`/`offset`) for a
   * stable, O(1)-per-page scan. `offset` is O(offset) and unstable under
   * concurrent writes; keyset is the pagination primitive.
   */
  after?: number;
}

export interface GraphBackendCapabilities {
  bitemporal: boolean;
  fullTextSearch: boolean;
  metadataFilter: boolean;
}

/**
 * BUG-040 — write options. `skipDedupe` opts a write out of the global
 * case-insensitive content-hash dedupe (default false, back-compat). Entity
 * nodes identified by a business key MUST set this; the unique (kind, name)
 * index (FEAT-012) is the real uniqueness guard.
 */
export interface WriteNodeOpts {
  skipDedupe?: boolean;
}

export interface GraphBackend {
  readonly capabilities: GraphBackendCapabilities;

  /**
   * (BL-508) Engine identity of the backing store — the `_sox_engine` marker
   * row (`engine`, `sox_version`, `driver_version`, `first_opened_at`,
   * `last_opened_at`), or `null` when the store is in-memory or predates the
   * marker scheme. The open result of `createGraphBackend` carries it so a
   * graph-store consumer can surface client/engine version tracking without
   * re-probing. Accessing it runs the foreign-engine guard once per adapter
   * instance (fail-closed on a marker mismatch for turso-owned stores).
   */
  readonly engineIdentity?: EngineIdentity | null;

  applySchema(): Promise<void>;

  writeNode(content: string, meta: NodeMeta, opts?: WriteNodeOpts): Promise<number>;
  /** FEAT-011 — idempotent find-or-create by business key (kind, name). */
  findOrCreateNode(kind: string, name: string, opts?: { content?: string; meta?: NodeMeta }): Promise<number>;
  supersede(oldId: number, newContent: string, meta: NodeMeta): Promise<number>;
  invalidate(nodeId: number, reason?: string): Promise<void>;
  touch(nodeId: number, meta: Partial<NodeMeta>): Promise<void>;
  writeNodeBatch(nodes: Array<{ content: string; meta: NodeMeta }>, opts?: WriteNodeOpts): Promise<number[]>;
  writeGraph(
    nodes: Array<{ content: string; meta: NodeMeta }>,
    edges: Array<{ srcIdx: number; dstIdx: number; rel: EdgeRel; meta?: EdgeMeta }>,
    opts?: WriteNodeOpts,
  ): Promise<number[]>;

  /**
   * FEAT-024 (A1) — expose atomic multi-operation composition. The v2 "create
   * issue" is one logical write over existing nodes (writeNode + edges); this
   * is the mechanism that makes FEAT-023's uniqueness check + multi-op writes
   * atomic, and it removes the need for a consumer to reach the raw adapter.
   */
  transaction<T>(fn: (tx: AdapterTransaction) => Promise<T>): Promise<T>;
  /** FEAT-024 (A2) — set `edge.t_invalid`. Idempotent; `writeEdge` with the same (src,dst,rel) re-livens it. */
  invalidateEdge(src: number, dst: number, rel: EdgeRel, reason?: string): Promise<void>;
  /** FEAT-024 (A3) — bulk edge write between existing nodes in one transaction. */
  writeEdges(edges: Array<{ src: number; dst: number; rel: EdgeRel; meta?: EdgeMeta }>): Promise<void>;

  getNode(id: number): Promise<NodeRecord | null>;
  /** FEAT-024 (B4) — ordered batch read, one query, in the requested id order (missing/tombstones omitted per `liveOnly`). */
  getNodesByIds(ids: number[], opts?: { liveOnly?: boolean }): Promise<NodeRecord[]>;
  queryNodes(filter?: NodeFilter): Promise<NodeRecord[]>;
  searchNodes(
    query: string,
    opts?: { limit?: number; offset?: number; filter?: NodeFilter },
  ): Promise<Array<NodeRecord & { score: number }>>;
  countNodes(filter?: NodeFilter): Promise<number>;
  /** FEAT-024 (B5) — single GROUP BY over a node column instead of N `countNodes` calls. */
  countBy(field: 'kind' | 'namespace' | 'agentId', filter?: NodeFilter): Promise<Record<string, number>>;
  countNodesFts(query: string, filter?: NodeFilter): Promise<number>;
  getSupersessionChain(nodeId: number): Promise<NodeRecord[]>;

  writeEdge(src: number, dst: number, rel: EdgeRel, meta?: EdgeMeta): Promise<void>;

  getEdges(opts: { src?: number; dst?: number; rel?: EdgeRel; metadata?: Record<string, MetadataFilterValue> }): Promise<EdgeRecord[]>;
  getNeighbors(
    nodeId: number,
    opts?: { rel?: EdgeRel; depth?: number; direction?: 'in' | 'out' | 'both' },
  ): Promise<NodeRecord[]>;
  getNeighborsWithEdges(
    nodeId: number,
    opts?: { rel?: EdgeRel; depth?: number; direction?: 'in' | 'out' | 'both' },
  ): Promise<Array<{ node: NodeRecord; edge: EdgeRecord }>>;

  isReachable(
    src: number,
    dst: number,
    opts?: { rel?: EdgeRel; direction?: 'out' | 'in' },
  ): Promise<boolean>;
  getSubgraph(
    rootId: number,
    opts?: { rel?: EdgeRel; depth?: number; direction?: 'out' | 'in' | 'both' },
  ): Promise<{ nodes: NodeRecord[]; edges: EdgeRecord[] }>;
}

export const PUBLIC_EDGE_RELS: readonly EdgeRel[] = [
  'MENTIONS',
  'SUPPORTS',
  'RELATES_TO',
  'DERIVED_FROM',
  'SUPERSEDES',
  'SAME_AS',
  'ASSIGNED_TO',
];

/**
 * The rels baked into every store's CHECK (rel IN (...)) clause today — the full ten-member
 * EdgeRel vocabulary (index.ts:364-374), NOT PUBLIC_EDGE_RELS (which is memory-core's own
 * 7-member tool-surface subset, unrelated to this constant and untouched by this packet).
 * This is DEFAULT_TYPE_POLICY's validateRel() vocabulary — see BL-440.
 */
export const DEFAULT_EDGE_RELS: readonly EdgeRel[] = [
  'MENTIONS',
  'SUPPORTS',
  'RELATES_TO',
  'SUPERSEDES',
  'DERIVED_FROM',
  'MEMBER_OF',
  'PART_OF',
  'SAME_AS',
  'ASSIGNED_TO',
  'DEPENDS_ON',
];

/**
 * Injected type-vocabulary policy (ADR-0010 D2). graph-store owns no vocabulary of its own —
 * a TypePolicy is pure in-process validation with NO reference to DDL, rebuildTable, or the
 * adapter. It is called at the write boundary (writeNode / writeEdgeInternal) and throws
 * ConstraintError to reject. See BL-440's "no path to DDL" requirement — a TypePolicy
 * implementation MUST NOT be able to alter the schema under any input.
 */
export interface TypePolicy {
  validateKind(kind: string): void;
  validateRel(rel: string): void;
  /**
   * FEAT-013 — OPTIONAL. Validate an edge with its endpoint kinds resolved.
   * Called by writeEdgeInternal AFTER resolving src/dst kinds. When absent,
   * the store falls back to `validateRel(rel)` — preserving the current API
   * and the DEFAULT_TYPE_POLICY closed-vocabulary behavior byte-for-byte.
   * Purity contract (BL-440 "no path to DDL") remains in force: this is a
   * pure predicate over three strings — no adapter, no DDL, no I/O.
   */
  validateEdge?(srcKind: string, rel: string, dstKind: string): void;
}

/**
 * The default TypePolicy every StoreGraphBackend gets when no typePolicy is supplied. This is
 * deliberately the CLOSED six-kind / ten-rel vocabulary the CHECK constraints enforce today —
 * NOT the "syntactic-only" default ADR-0010 D2 describes as graph-store's eventual built-in
 * default. That eventual shift only becomes safe once every memory-core call site injects its
 * own MemoryOntologyPolicy explicitly (PKT-60) — until then, a caller supplying no typePolicy
 * (all 8 memory-core call sites, today) MUST see byte-identical behaviour to pre-PKT-59. Do not
 * widen this default in this packet.
 */
export const DEFAULT_TYPE_POLICY: TypePolicy = {
  validateKind(kind: string): void {
    if (!DEFAULT_NODE_KINDS.includes(kind as (typeof DEFAULT_NODE_KINDS)[number])) {
      throw new ConstraintError(
        `Unknown node kind "${kind}". Allowed kinds: ${DEFAULT_NODE_KINDS.join(', ')}.`,
      );
    }
  },
  validateRel(rel: string): void {
    if (!DEFAULT_EDGE_RELS.includes(rel as EdgeRel)) {
      throw new ConstraintError(
        `Unknown edge rel "${rel}". Allowed rels: ${DEFAULT_EDGE_RELS.join(', ')}.`,
      );
    }
  },
  // FEAT-013 — the default policy has no endpoint-context vocabulary; delegate
  // to validateRel so the closed six-kind/ten-rel behavior is unchanged for
  // callers that inject nothing.
  validateEdge(_srcKind: string, rel: string, _dstKind: string): void {
    this.validateRel(rel);
  },
};

/** Options accepted by createGraphBackend() / the StoreGraphBackend constructor. */
/**
 * FEAT-021 — dependency-inversion write observer. graph-store DEFINES this
 * interface and imports nothing for it; a higher-tier composer (the semantic
 * facade) IMPLEMENTS it to do embed-on-write / delete-on-invalidate. This is the
 * same DI idiom as TypePolicy — it keeps graph-store base-tier-pure while
 * letting the embedding lifecycle be owned by the composition layer. Observers
 * fire inline, right after the write's INSERT/UPDATE (inside the surrounding
 * transaction for batched writes — a slow observer therefore holds that
 * transaction open), and their failures degrade (logged) rather than corrupt the
 * data write.
 */
export interface GraphWriteObserver {
  onNodeWritten?(node: NodeRecord, meta: NodeMeta): void | Promise<void>;
  onNodeInvalidated?(nodeId: number): void | Promise<void>;
  onNodeUpdated?(node: NodeRecord, changed: Partial<NodeMeta>): void | Promise<void>;
}

/**
 * FEAT-023 — injectable, transaction-scoped uniqueness seam. Replaces
 * FEAT-012's global `(kind, name)` unique index, which was wrong on three
 * counts: (1) too broad — it forced "name is identity" on every kind, and the
 * analysis package's community nodes collided (BUG-042); (2) wrong layer —
 * relational uniqueness is edge-scoped (component names unique *within* a
 * project), inexpressible as a column index; (3) unnecessary — the store is
 * single-writer (ADR-0007 memory-single-writer, ADR-0015
 * backlog-single-writer-daemon), so a check-then-INSERT is already atomic with
 * no DDL index.
 *
 * The policy runs inside `writeNode` BEFORE the INSERT, with read access to the
 * store's read path (the `tx` handle). Under single-writer the check-then-INSERT
 * is atomic and no transaction wrapper is opened (the Turso adapter refuses
 * nested transactions). Consumers own the semantics:
 *   - flat catalog -> `SELECT … WHERE kind = ? AND name = ?`
 *   - components   -> edge-scoped `SELECT` through the `MEMBER_OF`/`owns_project` edge
 *
 * A policy rejects a write by throwing {@link ConstraintError}. This is the
 * same DI idiom as {@link TypePolicy} and {@link GraphWriteObserver}: graph-store
 * owns no uniqueness semantics of its own — the consumer declares them.
 */
export interface NodeUniquenessPolicy {
  check(meta: NodeMeta, tx: AdapterTransaction): Promise<void>;
}

export interface GraphBackendOpts {
  /** Injected type-vocabulary policy. Defaults to DEFAULT_TYPE_POLICY (today's six kinds, ten rels). */
  typePolicy?: TypePolicy;
  /** FEAT-021 — write observers, fired after-commit. Additive; default empty. */
  observers?: GraphWriteObserver[];
  /** FEAT-023 — injectable uniqueness policy, run inside writeNode before the INSERT. Default undefined = the store enforces nothing. */
  uniquenessPolicy?: NodeUniquenessPolicy;
}

interface DbNodeRow {
  rowid: number;
  uid: string;
  kind: string;
  content: string | null;
  name: string | null;
  summary: string | null;
  topic: string | null;
  tags: string | null;
  importance: number | null;
  confidence: number | null;
  content_hash: string | null;
  namespace: string | null;
  meta: string | null;
  agent_id: string | null;
  session_id: string | null;
  source: string | null;
  project_path: string | null;
  t_occurred: string | null;
  t_expires: string | null;
  t_created: string;
  t_valid: string | null;
  t_invalid: string | null;
  is_superseded: number | null;
  access_count: number | null;
  last_access: string | null;
  t_updated: string | null;
}

interface DbEdgeRow {
  rowid: number;
  src: number;
  dst: number;
  rel: string;
  weight: number | null;
  confidence: number | null;
  origin: string | null;
  meta: string | null;
  t_created: string;
  t_valid: string | null;
  t_invalid: string | null;
}

function parseJson<T>(val: string | null, fallback: T): T {
  if (val === null || val === undefined) return fallback;
  try {
    return JSON.parse(val) as T;
  } catch (err) {
    // A stored row whose JSON column does not parse = data corruption; the row
    // degrades to the fallback but the defect must be visible.
    log.warn('graph_store.row.json_parse_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  }
}

function parseJsonOptional(val: string | null): Record<string, unknown> | undefined {
  if (val === null || val === undefined) return undefined;
  try {
    return JSON.parse(val) as Record<string, unknown>;
  } catch (err) {
    log.warn('graph_store.row.json_parse_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

function isStale(tExpires: string | null | undefined): boolean {
  if (!tExpires) return false;
  return new Date(tExpires).getTime() <= Date.now();
}

function rowToNodeRecord(row: DbNodeRow): NodeRecord {
  const rec: NodeRecord = {
    id: row.rowid,
    kind: row.kind,
    content: row.content ?? '',
    tags: parseJson<string[]>(row.tags, []),
    tCreated: row.t_created,
    tValid: row.t_valid ?? row.t_created,
    isSuperseded: row.is_superseded === 1,
    isStale: isStale(row.t_expires),
    namespace: row.namespace ?? 'global',
  };
  if (row.name != null) rec.name = row.name;
  if (row.summary != null) rec.summary = row.summary;
  if (row.topic != null) rec.topic = row.topic;
  if (row.importance != null) rec.importance = row.importance;
  if (row.confidence != null) rec.confidence = row.confidence as unknown as Confidence;
  if (row.t_invalid != null) rec.tInvalid = row.t_invalid;
  if (row.t_expires != null) rec.tExpires = row.t_expires;
  const meta = parseJsonOptional(row.meta);
  if (meta !== undefined) rec.metadata = meta;
  return rec;
}

function rowToEdgeRecord(row: DbEdgeRow): EdgeRecord {
  const rec: EdgeRecord = {
    src: row.src,
    dst: row.dst,
    rel: row.rel as EdgeRel,
    tCreated: row.t_created,
  };
  if (row.weight != null) rec.weight = row.weight;
  const meta = parseJsonOptional(row.meta);
  if (meta !== undefined) rec.metadata = meta;
  return rec;
}

function hashContent(content: string): string {
  const normalized = content.trim().toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function generateUid(): string {
  return crypto.randomUUID();
}

function nowISO(): string {
  return new Date().toISOString();
}

/** FEAT-014 — a metadata filter value is an operator object iff it is a plain
 *  object carrying at least one operator key. Arrays and null are not operators. */
function isMetadataFilter(value: unknown): value is MetadataFilter {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'between', 'exists', 'contains'];
  return keys.some((k) => k in (value as Record<string, unknown>));
}

export interface FilterClause {
  where: string;
  params: unknown[];
}

/**
 * FEAT-014 / FEAT-024 (B6) — shared metadata filter clause builder, reused by
 * the node filter ({@link buildNodeFilterClause}) and the edge filter
 * ({@link StoreGraphBackend.getEdges}). The full operator set applies to
 * `json_extract(<alias>meta, '$.key')`. `alias` is already column-dotted (e.g.
 * `n.` or `e.`), so this is dialect-free and shared across both tables.
 */
function appendMetadataFilterClauses(
  alias: string,
  metadata: Record<string, MetadataFilterValue>,
  clauses: string[],
  params: unknown[],
): void {
  for (const [key, value] of Object.entries(metadata)) {
    if (isMetadataFilter(value)) {
      const path = `$.${key}`;
      if (value.eq !== undefined) {
        if (value.eq === null) {
          clauses.push(`json_extract(${alias}meta, ?) IS NULL`);
          params.push(path);
        } else {
          clauses.push(`json_extract(${alias}meta, ?) = ?`);
          params.push(path, value.eq);
        }
      }
      if (value.neq !== undefined) {
        if (value.neq === null) {
          clauses.push(`json_extract(${alias}meta, ?) IS NOT NULL`);
          params.push(path);
        } else {
          clauses.push(`json_extract(${alias}meta, ?) != ?`);
          params.push(path, value.neq);
        }
      }
      if (value.in !== undefined && value.in.length > 0) {
        clauses.push(`json_extract(${alias}meta, ?) IN (${value.in.map(() => '?').join(',')})`);
        params.push(path, ...value.in);
      }
      if (value.gt !== undefined) { clauses.push(`json_extract(${alias}meta, ?) > ?`); params.push(path, value.gt); }
      if (value.gte !== undefined) { clauses.push(`json_extract(${alias}meta, ?) >= ?`); params.push(path, value.gte); }
      if (value.lt !== undefined) { clauses.push(`json_extract(${alias}meta, ?) < ?`); params.push(path, value.lt); }
      if (value.lte !== undefined) { clauses.push(`json_extract(${alias}meta, ?) <= ?`); params.push(path, value.lte); }
      if (value.between !== undefined) {
        clauses.push(`json_extract(${alias}meta, ?) >= ?`); params.push(path, value.between[0]);
        clauses.push(`json_extract(${alias}meta, ?) <= ?`); params.push(path, value.between[1]);
      }
      if (value.exists !== undefined) {
        clauses.push(value.exists
          ? `json_extract(${alias}meta, ?) IS NOT NULL`
          : `json_extract(${alias}meta, ?) IS NULL`);
        params.push(path);
      }
      if (value.contains !== undefined) {
        clauses.push(`EXISTS (SELECT 1 FROM json_each(${alias}meta, ?) WHERE value = ?)`);
        params.push(path, value.contains);
      }
    } else {
      clauses.push(`json_extract(${alias}meta, ?) = ?`);
      params.push(`$.${key}`, value);
    }
  }
}

export function buildNodeFilterClause(
  filter: NodeFilter | undefined,
  liveOnly: boolean,
  tableAlias: string,
): FilterClause {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const alias = tableAlias ? `${tableAlias}.` : '';

  if (liveOnly) {
    clauses.push(`${alias}t_invalid IS NULL`);
  }

  if (filter) {
    if (filter.ids !== undefined && filter.ids.length > 0) {
      clauses.push(`${alias}rowid IN (${filter.ids.map(() => '?').join(',')})`);
      params.push(...filter.ids);
    }

    if (filter.kind !== undefined) {
      if (Array.isArray(filter.kind)) {
        clauses.push(`${alias}kind IN (${filter.kind.map(() => '?').join(',')})`);
        params.push(...filter.kind);
      } else {
        clauses.push(`${alias}kind = ?`);
        params.push(filter.kind);
      }
    }

    if (filter.topic !== undefined) {
      if (Array.isArray(filter.topic)) {
        clauses.push(`${alias}topic IN (${filter.topic.map(() => '?').join(',')})`);
        params.push(...filter.topic);
      } else {
        clauses.push(`${alias}topic = ?`);
        params.push(filter.topic);
      }
    }

    if (filter.tags !== undefined && filter.tags.length > 0) {
      if (filter.tagsMatchAll) {
        clauses.push(
          `(SELECT COUNT(DISTINCT value) FROM json_each(${alias}tags) WHERE value IN (${filter.tags.map(() => '?').join(',')})) = ?`,
        );
        params.push(...filter.tags, filter.tags.length);
      } else {
        clauses.push(
          `EXISTS (SELECT 1 FROM json_each(${alias}tags) WHERE value IN (${filter.tags.map(() => '?').join(',')}))`,
        );
        params.push(...filter.tags);
      }
    }

    if (filter.importanceMin !== undefined) {
      clauses.push(`${alias}importance >= ?`);
      params.push(filter.importanceMin);
    }

    if (filter.confidence !== undefined) {
      if (Array.isArray(filter.confidence)) {
        clauses.push(`${alias}confidence IN (${filter.confidence.map(() => '?').join(',')})`);
        params.push(...filter.confidence);
      } else {
        clauses.push(`${alias}confidence = ?`);
        params.push(filter.confidence);
      }
    }

    if (filter.tCreatedAfter !== undefined) {
      clauses.push(`${alias}t_created >= ?`);
      params.push(filter.tCreatedAfter);
    }

    if (filter.tCreatedBefore !== undefined) {
      clauses.push(`${alias}t_created <= ?`);
      params.push(filter.tCreatedBefore);
    }

    if (filter.tUpdatedAfter !== undefined) {
      clauses.push(`${alias}t_updated >= ?`);
      params.push(filter.tUpdatedAfter);
    }

    if (filter.tUpdatedBefore !== undefined) {
      clauses.push(`${alias}t_updated <= ?`);
      params.push(filter.tUpdatedBefore);
    }

    if (filter.validAt !== undefined) {
      clauses.push(`${alias}t_valid <= ?`);
      clauses.push(`(${alias}t_invalid IS NULL OR ${alias}t_invalid > ?)`);
      params.push(filter.validAt, filter.validAt);
    }

    if (filter.isStale === true) {
      clauses.push(`${alias}t_expires IS NOT NULL AND ${alias}t_expires <= ?`);
      params.push(nowISO());
    } else if (filter.isStale === false) {
      clauses.push(`(${alias}t_expires IS NULL OR ${alias}t_expires > ?)`);
      params.push(nowISO());
    }

    if (filter.namespace !== undefined) {
      clauses.push(`${alias}namespace = ?`);
      params.push(filter.namespace);
    }

    if (filter.projectPath !== undefined) {
      clauses.push(`${alias}project_path = ?`);
      params.push(filter.projectPath);
    }

    if (filter.agentId !== undefined) {
      clauses.push(`${alias}agent_id = ?`);
      params.push(filter.agentId);
    }

    if (filter.name !== undefined) {
      if (Array.isArray(filter.name)) {
        clauses.push(`${alias}name IN (${filter.name.map(() => '?').join(',')})`);
        params.push(...filter.name);
      } else {
        clauses.push(`${alias}name = ?`);
        params.push(filter.name);
      }
    }

    if (filter.metadata !== undefined) {
      appendMetadataFilterClauses(alias, filter.metadata, clauses, params);
    }
  }

  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function buildOrderClause(
  filter: NodeFilter | undefined,
  tableAlias: string,
): { sql: string; params: unknown[] } {
  if (!filter?.orderBy) return { sql: '', params: [] };
  const alias = tableAlias ? `${tableAlias}.` : '';
  const params: unknown[] = [];

  // FEAT-014 — normalize to a list of {expr, defaultDir} sort terms. A metadata
  // sort key resolves to `json_extract(meta, ?)` with the `$.key` path BOUND
  // (review MINOR — parameterized like appendMetadataFilterClauses, never
  // interpolated, so a quote in the key cannot break the query).
  const fields = Array.isArray(filter.orderBy) ? filter.orderBy : [filter.orderBy];
  const terms: Array<{ expr: string; defaultDir: 'ASC' | 'DESC' }> = [];
  for (const field of fields) {
    if (typeof field === 'string') {
      switch (field) {
        case 'importance': terms.push({ expr: `${alias}importance`, defaultDir: 'DESC' }); break;
        case 'tCreated': terms.push({ expr: `${alias}t_created`, defaultDir: 'DESC' }); break;
        case 'tValid': terms.push({ expr: `${alias}t_valid`, defaultDir: 'DESC' }); break;
        case 'name': terms.push({ expr: `${alias}name`, defaultDir: 'ASC' }); break;
        default: break;
      }
    } else {
      // { metadata: key } — sort by a JSON field.
      terms.push({ expr: `json_extract(${alias}meta, ?)`, defaultDir: 'ASC' });
      params.push(`$.${field.metadata}`);
    }
  }
  if (terms.length === 0) return { sql: '', params: [] };

  const dirs = Array.isArray(filter.orderDir) ? filter.orderDir : (filter.orderDir ? [filter.orderDir] : []);
  const ordered = terms.map((t, i) => {
    const d = dirs[i] ?? t.defaultDir;
    return `${t.expr} ${d.toUpperCase()}`;
  });
  return { sql: `ORDER BY ${ordered.join(', ')}`, params };
}

/**
 * BL-447 — structural presence check, not a literal-value probe.
 *
 * True iff the live DDL text declares a CHECK constraint on `column` at all — true for both
 * quoting styles this file emits: `INLINE_MIGRATION_DDL`'s Drizzle-quoted
 * `CHECK ("kind" IN (...))` and `NODE_TABLE_DDL`/`EDGE_TABLE_DDL`'s bare `CHECK (kind IN (...))`
 * (the shape a table has after `rebuildTable` has run against it). False once BL-438 D1/D4 drop
 * the CHECK from the fresh-creation DDLs (`graphDdl()`, `INLINE_MIGRATION_DDL`) — at that point
 * every freshly created or already-open-schema store reports `false` here, forever, and
 * `ensureCheckConstraints` never rebuilds it again.
 *
 * This replaces a literal-value search (`sql.includes("'generic'")` /
 * `sql.includes("'DEPENDS_ON'")`) that could not tell "CHECK absent because this store predates
 * the enum value" from "CHECK absent because this store is deliberately on the open schema" —
 * both looked identical to a literal search, which is what armed a rebuild-on-every-open loop the
 * moment the CHECK was removed from fresh DDL (BL-447). A structural presence check has no such
 * ambiguity: an open-schema store simply has no CHECK clause on this column.
 */
function hasEnumCheckConstraint(sql: string, column: 'kind' | 'rel'): boolean {
  return new RegExp(`CHECK\\s*\\(\\s*"?${column}"?\\s+IN\\b`).test(sql);
}

/**
 * BL-507 — detects the legacy explicit-rowid FK form on `edge`.
 *
 * Stores whose `node`/`edge` schema was authored by a Drizzle migration that
 * no longer exists in this repo (the 2026-07-11 `0000_sad_onslaught.sql`; the
 * live backlog.db is one) carry `REFERENCES node(rowid)` — the parent's
 * `rowid` alias named explicitly as the FK target column. `node`/`edge` are
 * LIBRARY-domain schema (this package owns their DDL — Drizzle is a live
 * dependency in this ecosystem and owns only app tables), so the library may
 * rebuild `edge` to heal this form. Verified against the real Turso engine
 * (2026-08-11, repro in .worktrees/c-fix-fts): with `PRAGMA foreign_keys = ON`,
 * libSQL fails to resolve that form and EVERY write referencing the FK dies
 * with `Runtime error: foreign key mismatch referencing "node"` — the exact
 * production outage recorded in the triage. The same DDL works on stock
 * SQLite (better-sqlite3 resolves `rowid` as the INTEGER PRIMARY KEY alias),
 * and the implicit form `REFERENCES node ON DELETE CASCADE` (what
 * graph-store's own DDL emits) works on BOTH engines — so this is a
 * legacy-schema compatibility defect, not a fresh-store one.
 *
 * Matches any `REFERENCES <table>(...)` clause whose column list contains
 * `rowid` (any quoting). `REFERENCES node(uid)` — the other explicit-column
 * form, which resolves fine on both engines — does NOT match.
 */
function hasExplicitRowidForeignKey(sql: string): boolean {
  return /\breferences\s+(?:"|`|\[)?[\w]+(?:"|`|\])?\s*\(\s*(?:"|`|\[)?\s*rowid\s*(?:"|`|\])?\s*\)/i.test(
    sql,
  );
}

export class StoreGraphBackend implements GraphBackend {
  readonly capabilities: GraphBackendCapabilities;

  private adapter: StoreAdapter;
  private schemaApplied = false;
  private typePolicy: TypePolicy;
  private observers: GraphWriteObserver[];
  private uniquenessPolicy: NodeUniquenessPolicy | undefined;
  /**
   * Whether the underlying engine accepts `WITH RECURSIVE` at prepare. True on
   * SQLite and Turso Database Rust >= 0.8.0; FALSE on Turso 0.7.x (probed
   * once at connect by store-adapter, see `AdapterCapabilities.recursiveCte`).
   * When false, the five recursive-graph methods below switch to iterative
   * BFS fallbacks that produce the same results (empirically pinned by the
   * "recursive-cte fallback parity" tests). External adapters that omit the
   * capability default to true — only Turso 0.7.x sets it false.
   *
   * (BL-580, DEBT-003 lazy-connect) This is a LIVE getter, not a
   * constructor-snapshotted field, deliberately: `TursoAdapterImpl.connect()`
   * seeds `capabilities.recursiveCte` with a conservative `false` guess on a
   * never-opened adapter and only corrects it to the real probed value once
   * the adapter's first real operation completes (`_reconnect()` reassigns
   * `capabilities` in place — the getter it exposes, `turso-adapter.ts`'s
   * `get capabilities()`, is itself live). `createGraphBackend()` constructs
   * this class eagerly, right after `connect()`, before any operation has
   * run — a constructor-time snapshot (the pre-BL-580 shape) would freeze the
   * conservative `false` guess for this instance's entire lifetime, forever
   * forcing the iterative BFS fallback even on a Turso 0.8.x+ store that had
   * long since corrected `recursiveCte: true`. Reading `adapter.capabilities`
   * fresh on every access is a plain in-memory field read (no I/O), so there
   * is no cost to staying live the way there is for `engineIdentity`.
   */
  private get supportsRecursiveCte(): boolean {
    return this.adapter.capabilities.recursiveCte ?? true;
  }

  /** (BL-508) Cached engine identity — see the `engineIdentity` getter. */
  private _engineIdentity: EngineIdentity | null | undefined;

  constructor(adapter: StoreAdapter, opts?: GraphBackendOpts) {
    this.adapter = adapter;
    this.typePolicy = opts?.typePolicy ?? DEFAULT_TYPE_POLICY;
    this.observers = opts?.observers ?? [];
    this.uniquenessPolicy = opts?.uniquenessPolicy;
    // BUG-SOXGRAPH-001: fullTextSearch DERIVES from the adapter's fts
    // capability instead of being hardcoded true — an adapter reporting
    // fts:false must not advertise an FTS surface that would then throw.
    this.capabilities = {
      bitemporal: true,
      fullTextSearch: adapter.capabilities.fts,
      metadataFilter: true,
    };
    this._engineIdentity = undefined;
  }

  /** FEAT-021 — run a write-observer callback across all observers, degrading
   *  (logged) on failure rather than corrupting the data write. */
  private async notifyObservers(fn: (o: GraphWriteObserver) => void | Promise<void>): Promise<void> {
    if (this.observers.length === 0) return;
    for (const o of this.observers) {
      try {
        await fn(o);
      } catch (err) {
        log.warn('graph_store.observer_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** FEAT-021 — build a minimal-but-valid NodeRecord for observer callbacks
   *  from the write args, without a re-select. */
  private buildNodeRecord(id: number, kind: string, content: string, meta: NodeMeta, now: string): NodeRecord {
    const rec: NodeRecord = {
      id,
      kind,
      content,
      tags: meta.tags ?? [],
      tCreated: now,
      tValid: now,
      isSuperseded: false,
      isStale: false,
      namespace: meta.namespace ?? 'global',
    };
    if (meta.name !== undefined) rec.name = meta.name;
    if (meta.summary !== undefined) rec.summary = meta.summary;
    if (meta.topic !== undefined) rec.topic = meta.topic;
    if (meta.metadata !== undefined) rec.metadata = meta.metadata;
    return rec;
  }

  /**
   * (BL-508) The backing store's engine identity (marker row), computed once
   * per adapter instance and cached. The foreign-engine guard runs on the
   * FIRST access: a turso-owned store with a SQLite marker FAILS CLOSED here
   * (typed `ESqliteNativeStore`) — defense-in-depth under the turso adapter's
   * own connect-time refusal, for direct-adapter consumers. Access cost is
   * per-connection, never per-op (adapter handles are long-lived — memory-core
   * caches them in `getDb`).
   *
   * (BL-580, DEBT-003 lazy-connect) `TursoAdapterImpl.connect()` is now lazy:
   * it opens no driver connection and stamps NO `_sox_engine` marker until the
   * first real operation (see turso-adapter.ts `connect()`'s doc comment).
   *
   * (BUG-026) For a TURSO store this getter never resolves identity through
   * the sync better-sqlite3 path — that readonly open creates the classic
   * `-shm` on the turso store on every construction (the 'exp9 poisoner'
   * cross-engine class, engine-guard.ts), which is exactly how the store
   * became reachable by a foreign engine in the first place. Turso identity
   * resolution is async-only via `readEngineIdentityViaAdapter` (wired through
   * memory-core's `getStoreEngineIdentity`); this sync getter returns the
   * cached identity or `null` (left uncached, per the BL-580 pattern) so an
   * async resolver can populate it without a poisoner open here. For a
   * non-turso adapter the sync `getEngineIdentitySync` read remains — its
   * marker is stamped synchronously at construction/`init()` time, so a `null`
   * there means a real unmarked legacy store, not "not yet opened".
   *
   * This does not weaken the fail-closed MISMATCH guard below: unlike the
   * marker row, `assertStoreEngineSync` reads the `application_id` SQLite
   * header via `readApplicationId` — a pure filesystem read independent of
   * whether `_sox_engine` has been stamped — and `TursoAdapterImpl.connect()`
   * already runs that identical eager header check before ever returning the
   * lazy shell (turso-adapter.ts, `connect()`, BL-508 foreign-engine
   * refusal). A genuine mismatch still refuses at construction time, before
   * this getter is even reached; only "identity resolution" (which requires
   * the marker row) is provisional pre-open, never "mismatch detection".
   */
  get engineIdentity(): EngineIdentity | null {
    const isTurso = this.adapter.config.type === 'turso';
    if (this._engineIdentity !== undefined && (this._engineIdentity !== null || !isTurso)) {
      return this._engineIdentity;
    }
    const dbPath = this.adapter.config.dbPath;
    if (!dbPath) {
      this._engineIdentity = null;
      return null;
    }
    if (isTurso) {
      // Fail-closed on a marker mismatch (unmarked legacy stays allowed).
      assertStoreEngineSync(dbPath, 'turso');
      // (BUG-026) Do NOT read the identity through the sync better-sqlite3
      // path for a turso store — that readonly open creates the classic `-shm`
      // on the turso store on every construction (the 'exp9 poisoner'
      // cross-engine class, engine-guard.ts). Turso identity resolution is
      // async-only, through `readEngineIdentityViaAdapter` (already exported,
      // wired via memory-core `getStoreEngineIdentity`). This sync getter
      // returns whatever is cached, or leaves a null uncached (BL-580
      // pattern) so an async resolver can populate it later without a
      // poisoner open here.
      return this._engineIdentity ?? null;
    }
    const identity = getEngineIdentitySync(dbPath);
    // (BL-580) Only cache a settled answer — see doc comment above.
    this._engineIdentity = identity;
    return identity;
  }

  async applySchema(): Promise<void> {
    if (this.schemaApplied) return;

    for (const pragma of PRAGMAS) {
      await this.adapter.exec(pragma);
    }

    // INLINE_MIGRATION_DDL is a multi-statement string. Turso/libSQL rejects
    // `CREATE INDEX IF NOT EXISTS` when the index already exists (unlike
    // SQLite, which treats it as a no-op), so on a re-opened store the whole
    // batch would abort at the first existing index. Execute statement by
    // statement and treat an "already exists" on any one as a benign no-op —
    // the identical pattern memory-core's openDb() uses (db.ts:515-527).
    for (const stmt of splitSqlStatements(INLINE_MIGRATION_DDL)) {
      try {
        await this.adapter.exec(stmt);
      } catch (err) {
        if (err instanceof Error && /already exists/i.test(err.message)) continue;
        throw err;
      }
    }

    await this.applyFtsSchema();

    await this.ensureCheckConstraints();

    this.schemaApplied = true;
  }

  /**
   * FTS schema creation — A2 (FEAT-SOXGRAPH-001): delegated to the adapter's
   * `ensureFtsIndex`, which owns the per-backend mechanics (fts5 virtual
   * table + triggers + backfill on SQLite, Tantivy `CREATE INDEX … USING fts`
   * on Turso, BL-461 adoption of a non-canonical existing index, legacy
   * residue cleanup) and gates on `capabilities.fts` itself. graph-store
   * supplies the schema data (weights + the FTS_DDL/FTS_TRIGGERS constants
   * that ARE its FTS5 schema) and stays out of the SQL.
   */
  private async applyFtsSchema(): Promise<void> {
    await this.adapter.ensureFtsIndex('node', ['content', 'name', 'summary'], {
      weights: { content: 1.0, name: 1.0, summary: 1.0 },
      sqliteDDL: [FTS_DDL, FTS_TRIGGERS],
      backfill: true,
    });
  }

  /** FTS re-sync after a node-table rebuild — same dialect rules as
   *  {@link applyFtsSchema}, executed against the transaction handle. */
  private async reapplyFtsInTx(tx: { exec(sql: string): Promise<void> }): Promise<void> {
    const dialect = createFTSDialect(this.adapter.config.type);
    if (!dialect.supported || !this.adapter.capabilities.fts) return;
    const ftsColumns = ['content', 'name', 'summary'];
    for (const stmt of dialect.createIndexDDL(
      'node',
      ftsColumns,
      { content: 1.0, name: 1.0, summary: 1.0 },
      [FTS_TRIGGERS],
    )) {
      try {
        await tx.exec(stmt);
      } catch (err) {
        if (err instanceof Error && /already exists/i.test(err.message)) continue;
        throw err;
      }
    }
    if (this.adapter.capabilities.fts5) {
      await tx.exec(
        `INSERT INTO fts_node(rowid, content, name, summary)
         SELECT rowid, content, name, summary FROM node`,
      );
    }
  }

  private async ensureCheckConstraints(): Promise<void> {
    await this.addColumnIfMissing('node', 'level', 'INTEGER');
    await this.addColumnIfMissing('node', 'resume_state', 'TEXT');
    await this.addColumnIfMissing('node', 'is_superseded', 'INTEGER DEFAULT 0');
    await this.addColumnIfMissing('edge', 't_expired', 'TEXT');

    const nodeRow = await this.adapter.executeGet<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='node'`,
    );
    const nodeNeedsRebuild =
      !!nodeRow && hasEnumCheckConstraint(nodeRow.sql, 'kind') && !nodeRow.sql.includes("'generic'");

    const edgeRow = await this.adapter.executeGet<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='edge'`,
    );
    // BL-507: the legacy `REFERENCES node(rowid)` explicit-column FK form
    // (authored by a Drizzle migration that no longer exists in this repo —
    // the 2026-07-11 `0000_sad_onslaught.sql`) breaks every write on TURSO
    // when foreign_keys=ON (verified against the real engine; the live
    // backlog.db carries this shape). Rebuild `edge` with
    // the canonical implicit form — same rebuild machinery as the enum-check
    // normalization below — so a legacy store self-heals at open (ADR-0007).
    // `edge` is LIBRARY-domain schema (Drizzle owns only app tables), so the
    // rebuild stays within this package's ownership. Gated on the engine:
    // stock SQLite resolves `rowid` as the INTEGER PRIMARY KEY alias, so a
    // sqlite store carrying the form is fine and must keep its identity
    // byte-identical (BL-448 AC-3 — applySchema never churns a store that is
    // not broken).
    const edgeNeedsRebuild =
      (!!edgeRow && hasEnumCheckConstraint(edgeRow.sql, 'rel') && !edgeRow.sql.includes("'DEPENDS_ON'")) ||
      (!!edgeRow && this.adapter.config.type === 'turso' && hasExplicitRowidForeignKey(edgeRow.sql));

    if (nodeNeedsRebuild || edgeNeedsRebuild) {
      // (BL-506) The rebuild below ALTER-RENAMEs a NEW `edge` sqlite_master row
      // to a rowid after every existing row. On a legacy store whose node/edge
      // schema was authored by a long-removed Drizzle migration (the 2026-07-11
      // `0000_sad_onslaught.sql` — the explicit-rowid FK + fts5 residue both
      // came from it), the dead fts5 residue rows sit mid-catalog; a rebuilt
      // row landing after them would never register (BL-508's silent catalog
      // abort — the live outage). Drop the residue FIRST.
      await this.dropFts5ResidueBeforeRebuild();
      await this.adapter.transaction(async (tx) => {
        if (nodeNeedsRebuild) {
          await rebuildTable(this.adapter, 'node', NODE_TABLE_DDL, NODE_COLUMNS, { skipDrop: true, tx });
        }
        if (edgeNeedsRebuild) {
          await rebuildTable(this.adapter, 'edge', EDGE_TABLE_DDL, EDGE_COLUMNS, { skipDrop: true, tx });
        }

        if (nodeNeedsRebuild) await tx.exec(`DROP TABLE node_old`);
        if (edgeNeedsRebuild) await tx.exec(`DROP TABLE edge_old`);

        if (nodeNeedsRebuild) {
          for (const ddl of NODE_INDEX_DDLS) await tx.exec(ddl);
          await this.reapplyFtsInTx(tx);
        }
        if (edgeNeedsRebuild) {
          for (const ddl of EDGE_INDEX_DDLS) await tx.exec(ddl);
        }
      });
    }
  }

  /**
   * (BL-506) Before a schema rebuild moves a table's `sqlite_master` row,
   * delete any dead fts5 residue the store carries — turso stores only.
   *
   * Legacy stores whose `node`/`edge` schema was authored by a Drizzle
   * migration that no longer exists in this repo (the 2026-07-11
   * `0000_sad_onslaught.sql`; the live backlog.db is one) carry the SQLite-era
   * FTS5 stack (`fts_node` virtual table + 4 shadow tables + 3 content-sync
   * triggers) at `sqlite_master` rows after `node`/`edge`. `node`/`edge` and
   * their FTS objects are LIBRARY-domain schema — Drizzle is a live dependency
   * in this ecosystem and owns only app tables, so removing the residue and
   * rebuilding `edge` stays within this package's ownership and touches
   * nothing Drizzle owns. graph-store's FTS
   * is dialect-driven — on turso the FTS is Tantivy — so those fts5 rows are
   * dead weight. But their presence makes the Turso engine's catalog build
   * abort SILENTLY at the first unparseable row, so every schema object whose
   * `sqlite_master` row lands after them never registers on open (BL-508).
   * A rebuild of `edge` (BL-507's explicit-rowid-FK heal) ALTER-RENAMEs a new
   * `edge` row to a rowid after the residue — turning a working store into
   * one that opens with `no such table: edge` (BL-506, proven on the live
   * store 2026-08-11; this class of break is invisible to DDL-normalization
   * acceptance because the catalog abort is silent).
   *
   * Deleting the residue FIRST keeps the rebuilt row in a parseable region.
   * The deletion goes through the sanctioned better-sqlite3 escape hatch
   * (store-adapter's {@link deleteSchemaRowsViaBetterSqlite3} —
   * `unsafeMode` + `PRAGMA writable_schema=ON` + `DELETE FROM sqlite_master`):
   * the Turso driver hard-refuses `sqlite_master` writes and its DROPs
   * against fts5 objects silently no-op. better-sqlite3 writing the file
   * requires the turso connection CLOSED — cross-engine WAL coordination is
   * exactly what destroys stores (BL-508) — hence close → drop → reopen,
   * mirroring memory-core's openDb() (db.ts:630-632). The name-based DELETE
   * also removes any duplicate `fts_node_ai` trigger a `CREATE TRIGGER IF
   * NOT EXISTS` replay created (Turso does not dedupe it — BL-507).
   *
   * Never makes the heal worse: a failed presence probe skips the drop (the
   * pre-BL-506 behavior), and a failed drop is logged loudly before the
   * reopen still runs.
   */
  private async dropFts5ResidueBeforeRebuild(): Promise<void> {
    const cfg = this.adapter.config;
    if (cfg.type !== 'turso' || cfg.dbPath === undefined) return;

    // (BL-563) A readonly-open adapter must NEVER mutate the store file. The
    // drop is a WRITE through better-sqlite3, which opens the file WRITABLE —
    // bypassing the adapter's own readonly enforcement, which is closed during
    // the repair (the readonly layer is the adapter's connection, and it is
    // exactly what `withConnectionClosedForRepair` closes). On a readonly open
    // of a legacy store the rebuild below throws on readonly, but the residue
    // drop runs BEFORE that throw — a read-only open silently mutating the
    // store. Mirror preflight's `opts.readonly !== true` gate (turso-adapter
    // connect): readonly opens are scans, never repairs.
    if (cfg.readonly === true) return;

    const residueNames = createFTSDialect('turso').legacyResidueNames('node');
    if (residueNames.length === 0) return;

    // Presence check through the open adapter — `sqlite_master` SELECTs work
    // on turso; only writes are refused.
    let present: number;
    try {
      const placeholders = residueNames.map(() => '?').join(', ');
      const res = await this.adapter.executeGet<{ c: number }>(
        `SELECT COUNT(*) AS c FROM sqlite_master WHERE name IN (${placeholders})`,
        residueNames,
      );
      present = res?.c ?? 0;
    } catch (err) {
      log.warn('graph_store.heal.fts5_residue_probe_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (present === 0) return;

    log.warn('graph_store.heal.fts5_residue_drop', {
      db_path: cfg.dbPath,
      residue_count: present,
    });

    const dbPath = cfg.dbPath;
    const drop = async (): Promise<void> => {
      const repair = deleteSchemaRowsViaBetterSqlite3(dbPath, residueNames);
      if (repair.failed !== null) {
        // (BUG-017 review fix) A DECLINED drop here is a designed DEFERRAL,
        // not a repair failure: the outer `withConnectionClosedForRepair`
        // gate above already proved the store quiescent (excluding this
        // instance's own lease), so an inner-gate decline means either the
        // own lease entry lingered after close()'s best-effort release (the
        // stale entry counts as a live peer) or a new peer landed in the
        // probe window — both conservative false-declines that leave the
        // drop skipped, which is safe degradation per SPEC §T1. Label the
        // decline as such (warn, deferral semantics — INV-5: still logged
        // loudly, never a silent skip). Only a genuine non-decline failure
        // keeps the failure event.
        if (repair.failed.startsWith('declined:')) {
          log.warn('graph_store.heal.fts5_residue_drop_deferred_inner_quiescence', {
            db_path: dbPath,
            error: repair.failed,
          });
        } else {
          log.error('graph_store.heal.fts5_residue_drop_failed', {
            db_path: dbPath,
            error: repair.failed,
          });
        }
      }
    };

    // Same-instance reconnect around the out-of-band drop (BL-508: a
    // better-sqlite3 write must never run while the turso connection holds
    // the file) — the caller's adapter handle stays valid.
    const recyclable = this.adapter as TursoAdapter & {
      withConnectionClosedForRepair?: <T>(fn: () => Promise<T>) => Promise<T>;
    };
    if (typeof recyclable.withConnectionClosedForRepair === 'function') {
      try {
        await recyclable.withConnectionClosedForRepair(drop);
      } catch (err) {
        // (BUG-017, INV-1) A WRITABLE classic-engine open while live turso
        // multiprocess peers hold the store is the exp9 poisoner (classic
        // SQLite cannot see `-tshm` clients; a writable open+close deletes
        // the WAL out from under the live peers). The adapter's repair hook
        // declined with a typed error — log loudly (INV-5) and SKIP the drop:
        // the rebuild proceeds without it, the pre-BL-506 degradation, which
        // is safe. The hook's `finally` reopens the connection, so this
        // adapter handle stays live.
        if (err instanceof RepairDeclinedLivePeersError) {
          log.warn('graph_store.heal.fts5_residue_drop_deferred_live_peers', {
            db_path: dbPath,
            live_peer_count: err.livePeers.length,
            live_peer_pids: err.livePeers.map((p) => p.pid).join(','),
          });
          return;
        }
        throw err;
      }
      return;
    }

    // (BUG-017) No same-instance repair hook (foreign turso adapter). The
    // previous close-then-drop fallback was REMOVED: it performed the
    // better-sqlite3 WRITE with no quiescence gate at all — the exact exp9
    // poisoner shape, and worse for being reachable outside
    // `withConnectionClosedForRepair`'s gated path. Skip the drop; the rebuild
    // proceeds without it (safe degradation). Every real turso adapter
    // (`TursoAdapterImpl`) implements the hook, so this branch is synthetic.
    log.warn('graph_store.heal.fts5_residue_drop_skipped_no_repair_hook', {
      db_path: dbPath,
    });
  }

  private async addColumnIfMissing(table: string, column: string, type: string): Promise<void> {
    const cols = (await this.adapter.executeAll<{ name: string }>(`PRAGMA table_info(${table})`))
      .rows.map((c) => c.name);
    if (!cols.includes(column)) {
      await this.adapter.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  async writeNode(content: string, meta: NodeMeta, opts?: WriteNodeOpts): Promise<number> {
    // Standalone (non-transactional) path. When called inside `transaction()`,
    // the callers below route through writeNodeInTx with the LIVE transaction
    // handle so the uniqueness policy + dedupe + INSERT all see the same
    // in-transaction state — Turso's tx handle is a separate session, so using
    // `this.adapter` inside a transaction would read committed state and miss
    // intra-batch/intra-transaction writes (review MAJOR #1).
    return this.writeNodeInTx(content, meta, opts, this.adapter);
  }

  private async writeNodeInTx(
    content: string,
    meta: NodeMeta,
    opts: WriteNodeOpts | undefined,
    db: AdapterTransaction,
  ): Promise<number> {
    const kind = meta.kind ?? 'episode';
    this.typePolicy.validateKind(kind);

    // FEAT-023 — the injectable uniqueness policy runs BEFORE the INSERT, with
    // read access to the SAME handle the INSERT goes through (the transaction
    // handle when writeNodeInTx is called inside transaction(), else the
    // adapter). Under single-writer (ADR-0007 / ADR-0015) a check-then-INSERT is
    // atomic without any DDL index, and the Turso adapter refuses nested
    // transactions, so no transaction wrapper is opened here. The policy throws
    // ConstraintError to reject a write.
    if (this.uniquenessPolicy) {
      await this.uniquenessPolicy.check(meta, db);
    }

    const hash = hashContent(content);
    // BUG-040 — the content-hash dedupe is the WRONG identity key for entity
    // nodes: it is global (ignores kind) and case-insensitive, so distinct
    // (kind, name) entities with identical content collapse. `skipDedupe` opts
    // out (default false = dedupe on, back-compat); business-key identity goes
    // through findOrCreateNode (FEAT-011) and — where the consumer declares one
    // — the NodeUniquenessPolicy (FEAT-023) instead.
    if (!opts?.skipDedupe) {
      const existing = await db.executeGet<{ rowid: number }>(
        'SELECT rowid FROM node WHERE content_hash = ?', [hash],
      );
      if (existing) return existing.rowid;
    }

    const uid = generateUid();
    const now = nowISO();
    const tOccurred = meta.tOccurred ?? now;
    const tagsJson = meta.tags && meta.tags.length > 0 ? JSON.stringify(meta.tags) : null;
    const metaJson = meta.metadata !== undefined ? JSON.stringify(meta.metadata) : null;

    const result = await db.executeGet<{ rowid: number }>(
      `INSERT INTO node (uid, kind, content, name, summary, topic, tags, importance,
        confidence, content_hash, namespace, meta, agent_id, session_id, source,
        project_path, t_occurred, t_expires, t_created, t_valid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING rowid`,
      [
        uid, kind, content,
        meta.name ?? null, meta.summary ?? null, meta.topic ?? null, tagsJson,
        meta.importance ?? 1.0, meta.confidence ?? null, hash,
        meta.namespace ?? 'global', metaJson,
        meta.agentId ?? null, meta.sessionId ?? null, meta.source ?? null,
        meta.projectPath ?? null, tOccurred, meta.tExpires ?? null, now, now,
      ],
    );

    if (!result) throw new Error('Insert failed: no rowid returned');
    // FEAT-021 — after-commit observer (fire-and-forget, degrades on failure).
    await this.notifyObservers((o) =>
      o.onNodeWritten?.(this.buildNodeRecord(result.rowid, kind, content, meta, now), meta),
    );
    return result.rowid;
  }

  /**
   * FEAT-011 — the business-key primitive. Return the id of the existing
   * (kind, name) node, or create it. Idempotent. Under single-writer a plain
   * SELECT-then-INSERT is race-free WITHOUT the FEAT-012 unique index (reverted
   * by FEAT-023) — there is no concurrent writer to slip between the two.
   * Deliberately does NOT route identity through the content-hash dedupe — two
   * distinct (kind, name) entities with identical content must remain distinct
   * (BUG-040).
   */
  async findOrCreateNode(
    kind: string,
    name: string,
    opts?: { content?: string; meta?: NodeMeta },
  ): Promise<number> {
    const existing = await this.adapter.executeGet<{ rowid: number }>(
      'SELECT rowid FROM node WHERE kind = ? AND name = ? LIMIT 1', [kind, name],
    );
    if (existing) return existing.rowid;
    return this.writeNode(opts?.content ?? name, { ...(opts?.meta ?? {}), kind, name }, { skipDedupe: true });
  }

  async supersede(oldId: number, newContent: string, meta: NodeMeta): Promise<number> {
    const oldNode = await this.adapter.executeGet<DbNodeRow>('SELECT * FROM node WHERE rowid = ?', [oldId]);
    if (!oldNode) {
      throw new NodeNotFoundError(`Node not found: ${oldId}`, oldId);
    }
    if (oldNode.t_invalid !== null) {
      throw new BitemporalConflictError(`Node ${oldId} is already invalidated`, oldId);
    }

    return this.adapter.transaction(async (tx) => {
      const newId = await this.writeNodeInTx(newContent, meta, undefined, tx);
      await tx.executeRun(`UPDATE node SET is_superseded = 1 WHERE rowid = ?`, [oldId]);
      await this.writeEdge(newId, oldId, 'SUPERSEDES', {
        metadata: { reason: `superseded by node ${newId}`, supersededAt: nowISO() },
      });
      return newId;
    });
  }

  async invalidate(nodeId: number, reason?: string): Promise<void> {
    const node = await this.adapter.executeGet<{ rowid: number }>(
      'SELECT rowid FROM node WHERE rowid = ?', [nodeId],
    );
    if (!node) throw new NodeNotFoundError(`Node not found: ${nodeId}`, nodeId);

    const now = nowISO();
    const existingMeta = await this.adapter.executeGet<{ meta: string | null }>(
      'SELECT meta FROM node WHERE rowid = ?', [nodeId],
    );

    let metaObj: Record<string, unknown> = parseJson(existingMeta?.meta ?? null, {});
    if (reason) {
      metaObj = { ...metaObj, invalidatedReason: reason, invalidatedAt: now };
    } else {
      metaObj = { ...metaObj, invalidatedAt: now };
    }

    await this.adapter.executeRun(
      `UPDATE node SET t_invalid = ?, meta = ? WHERE rowid = ?`,
      [now, JSON.stringify(metaObj), nodeId],
    );
    // FEAT-021 — after-commit observer (delete-on-invalidate).
    await this.notifyObservers((o) => o.onNodeInvalidated?.(nodeId));
  }

  async touch(nodeId: number, meta: Partial<NodeMeta>): Promise<void> {
    const node = await this.adapter.executeGet<DbNodeRow>('SELECT * FROM node WHERE rowid = ?', [nodeId]);
    if (!node || node.t_invalid !== null) {
      throw new NodeNotFoundError(`Node not found or invalidated: ${nodeId}`, nodeId);
    }

    const now = nowISO();
    const updates: string[] = [];
    const params: unknown[] = [];

    if (meta.name !== undefined) { updates.push('name = ?'); params.push(meta.name); }
    if (meta.summary !== undefined) { updates.push('summary = ?'); params.push(meta.summary); }
    if (meta.topic !== undefined) { updates.push('topic = ?'); params.push(meta.topic); }
    if (meta.tags !== undefined) { updates.push('tags = ?'); params.push(meta.tags.length > 0 ? JSON.stringify(meta.tags) : null); }
    if (meta.importance !== undefined) { updates.push('importance = ?'); params.push(meta.importance); }
    if (meta.confidence !== undefined) { updates.push('confidence = ?'); params.push(meta.confidence); }
    if (meta.tExpires !== undefined) { updates.push('t_expires = ?'); params.push(meta.tExpires); }
    if (meta.metadata !== undefined) { updates.push('meta = ?'); params.push(JSON.stringify(meta.metadata)); }
    updates.push('t_updated = ?');
    params.push(now);

    if (updates.length > 0) {
      await this.adapter.executeRun(
        `UPDATE node SET ${updates.join(', ')} WHERE rowid = ?`,
        [...params, nodeId],
      );
      // FEAT-021 — after-commit observer (re-embed on content-bearing field change).
      const updated = await this.getNode(nodeId);
      if (updated) await this.notifyObservers((o) => o.onNodeUpdated?.(updated, meta));
    }
  }

  async writeNodeBatch(nodes: Array<{ content: string; meta: NodeMeta }>, opts?: WriteNodeOpts): Promise<number[]> {
    return this.adapter.transaction(async (tx) => {
      const ids: number[] = [];
      for (const n of nodes) ids.push(await this.writeNodeInTx(n.content, n.meta, opts, tx));
      return ids;
    });
  }

  async writeGraph(
    nodes: Array<{ content: string; meta: NodeMeta }>,
    edges: Array<{ srcIdx: number; dstIdx: number; rel: EdgeRel; meta?: EdgeMeta }>,
    opts?: WriteNodeOpts,
  ): Promise<number[]> {
    return this.adapter.transaction(async (tx) => {
      const nodeIds: number[] = [];
      for (const n of nodes) {
        nodeIds.push(await this.writeNodeInTx(n.content, n.meta, opts, tx));
      }
      // Resolve the ACTUAL endpoint kinds in one query (review MINOR): the old
      // fast-path recorded the *requested* kind during insertion, which is wrong
      // when writeNode returned a content-dedupe hit (skipDedupe false) whose
      // stored kind differs from the requested kind.
      const { rows } = await this.adapter.executeAll<{ rowid: number; kind: string }>(
        `SELECT rowid, kind FROM node WHERE rowid IN (${nodeIds.map(() => '?').join(',')})`,
        nodeIds,
      );
      const kindByRowid = new Map<number, string>();
      for (const row of rows) kindByRowid.set(row.rowid, row.kind);
      for (const edge of edges) {
        if (edge.srcIdx < 0 || edge.srcIdx >= nodeIds.length)
          throw new ConstraintError(`Invalid srcIdx: ${edge.srcIdx}`);
        if (edge.dstIdx < 0 || edge.dstIdx >= nodeIds.length)
          throw new ConstraintError(`Invalid dstIdx: ${edge.dstIdx}`);
        const srcId = nodeIds[edge.srcIdx];
        const dstId = nodeIds[edge.dstIdx];
        if (srcId === undefined || dstId === undefined)
          throw new ConstraintError('Node ID resolution failed');
        await this.writeEdgeInternal(srcId, dstId, edge.rel, edge.meta, kindByRowid);
      }
      return nodeIds;
    });
  }

  async getNode(id: number): Promise<NodeRecord | null> {
    const row = await this.adapter.executeGet<DbNodeRow>('SELECT * FROM node WHERE rowid = ?', [id]);
    return row ? rowToNodeRecord(row) : null;
  }

  /**
   * FEAT-024 (A1) — expose the adapter's transaction so consumers can compose
   * atomic multi-operation writes over *existing* nodes (the v2 "create issue"
   * = writeNode + edges + transition). This is also what makes FEAT-023's
   * uniqueness check + a multi-op write atomic. The callback receives the
   * adapter's AdapterTransaction; throwing from it rolls the whole thing back.
   */
  async transaction<T>(fn: (tx: AdapterTransaction) => Promise<T>): Promise<T> {
    return this.adapter.transaction(fn);
  }

  /**
   * FEAT-024 (A3) — bulk edge write between existing nodes in one transaction.
   * The migration writes thousands of edges; `writeGraph` bundles nodes+edges
   * and cannot target existing nodes. Endpoint kinds are resolved in a single
   * query up front (not one per edge) and threaded through `writeEdgeInternal`
   * for validateEdge.
   */
  async writeEdges(edges: Array<{ src: number; dst: number; rel: EdgeRel; meta?: EdgeMeta }>): Promise<void> {
    if (edges.length === 0) return;
    return this.adapter.transaction(async () => {
      const ids = new Set<number>();
      for (const e of edges) { ids.add(e.src); ids.add(e.dst); }
      const { rows } = await this.adapter.executeAll<{ rowid: number; kind: string }>(
        `SELECT rowid, kind FROM node WHERE rowid IN (${[...ids].map(() => '?').join(',')})`, [...ids],
      );
      const kindByRowid = new Map<number, string>();
      for (const row of rows) kindByRowid.set(row.rowid, row.kind);
      for (const e of edges) {
        await this.writeEdgeInternal(e.src, e.dst, e.rel, e.meta, kindByRowid);
      }
    });
  }

  /** FEAT-024 (B4) — ordered batch read, one query, in the requested id order. */
  async getNodesByIds(ids: number[], opts?: { liveOnly?: boolean }): Promise<NodeRecord[]> {
    if (ids.length === 0) return [];
    const liveOnly = opts?.liveOnly ?? true;
    const liveClause = liveOnly ? ' AND t_invalid IS NULL' : '';
    const { rows } = await this.adapter.executeAll<DbNodeRow>(
      `SELECT * FROM node WHERE rowid IN (${ids.map(() => '?').join(',')})${liveClause}`, ids,
    );
    const byId = new Map<number, NodeRecord>();
    for (const row of rows) byId.set(row.rowid, rowToNodeRecord(row));
    return ids.map((id) => byId.get(id)).filter((n): n is NodeRecord => n !== undefined);
  }

  async queryNodes(filter?: NodeFilter): Promise<NodeRecord[]> {
    const { where, params } = buildNodeFilterClause(filter, filter?.liveOnly ?? true, 'n');
    const allParams = [...params];
    let whereClause = where;
    const orderClause = buildOrderClause(filter, 'n');
    let order = orderClause.sql;
    allParams.push(...orderClause.params);

    // FEAT-024 (C) — keyset cursor: stable rowid scan. When `after` is set the
    // query compiles to `WHERE rowid > ? ORDER BY rowid ASC`, ignoring `orderBy`
    // and `offset` (keyset replaces offset pagination — offset is O(offset) and
    // unstable under writes).
    if (filter?.after !== undefined) {
      whereClause = whereClause ? `${whereClause} AND n.rowid > ?` : 'WHERE n.rowid > ?';
      allParams.push(filter.after);
      order = 'ORDER BY n.rowid ASC';
    }

    let limitClause = '';
    if (filter?.limit !== undefined) {
      limitClause = 'LIMIT ?';
      allParams.push(filter.limit);
      if (filter.offset !== undefined && filter.after === undefined) {
        limitClause += ' OFFSET ?';
        allParams.push(filter.offset);
      }
    }
    const sql = `SELECT n.* FROM node n ${whereClause} ${order} ${limitClause}`;
    const { rows } = await this.adapter.executeAll<DbNodeRow>(sql, allParams);
    return rows.map(rowToNodeRecord);
  }

  async searchNodes(
    query: string,
    opts?: { limit?: number; offset?: number; filter?: NodeFilter },
  ): Promise<Array<NodeRecord & { score: number }>> {
    // BUG-SOXGRAPH-001: capability guard — fts:false → [], never throw. The
    // value derives from adapter.capabilities.fts (constructor).
    if (!this.capabilities.fullTextSearch) return [];
    const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return [];
    const nodeFilter = buildNodeFilterClause(opts?.filter, opts?.filter?.liveOnly ?? true, 'n');
    const nodeWhere = nodeFilter.where ? `AND ${nodeFilter.where.replace(/^WHERE /, '')}` : '';
    // A2 (FEAT-SOXGRAPH-001): delegate to the adapter's ftsSearch, which owns
    // the per-backend SQL (fts5 shadow join vs Tantivy fts_match), the BL-367
    // `"tok1" OR "tok2"` normalization, and the empty-query guards.
    const ftsOpts: { limit: number; where: string; params: unknown[]; offset?: number } = {
      limit: opts?.limit ?? 50,
      where: nodeWhere,
      params: nodeFilter.params,
    };
    if (opts?.offset !== undefined) ftsOpts.offset = opts.offset;
    const rows = await this.adapter.ftsSearch<DbNodeRow & { score: number }>(
      'node',
      ['content', 'name', 'summary'],
      query,
      ftsOpts,
    );
    return rows.map((r) => ({ ...rowToNodeRecord(r as unknown as DbNodeRow), score: r.score }));
  }

  async countNodes(filter?: NodeFilter): Promise<number> {
    const { where, params } = buildNodeFilterClause(filter, filter?.liveOnly ?? true, 'n');
    const row = await this.adapter.executeGet<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM node n ${where}`, params);
    return row?.cnt ?? 0;
  }

  /**
   * FEAT-024 (B5) — single `GROUP BY` over a node column instead of N
   * `countNodes` calls. `field` maps to a real node column; `status`/`priority`
   * counting is deliberately NOT here — in the v2 model those are edge-scoped
   * (`has_status` / a metadata key), not a node column, and belong to the app
   * layer. A NULL key (e.g. `agentId` unset) is keyed `'(null)'`.
   */
  async countBy(
    field: 'kind' | 'namespace' | 'agentId',
    filter?: NodeFilter,
  ): Promise<Record<string, number>> {
    const column = field === 'kind' ? 'kind' : field === 'namespace' ? 'namespace' : 'agent_id';
    const { where, params } = buildNodeFilterClause(filter, filter?.liveOnly ?? true, 'n');
    const { rows } = await this.adapter.executeAll<{ key: string | null; cnt: number }>(
      `SELECT ${column} AS key, COUNT(*) AS cnt FROM node n ${where} GROUP BY ${column}`,
      params,
    );
    const out: Record<string, number> = {};
    for (const r of rows) out[r.key ?? '(null)'] = r.cnt;
    return out;
  }

  async countNodesFts(query: string, filter?: NodeFilter): Promise<number> {
    // BUG-SOXGRAPH-001: capability guard — fts:false → 0, never throw.
    if (!this.capabilities.fullTextSearch) return 0;
    const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return 0;
    const nodeFilter = buildNodeFilterClause(filter, filter?.liveOnly ?? true, 'n');
    const nodeWhere = nodeFilter.where ? `AND ${nodeFilter.where.replace(/^WHERE /, '')}` : '';
    // A2 (FEAT-SOXGRAPH-001): delegate to the adapter's ftsCount.
    return this.adapter.ftsCount('node', ['content', 'name', 'summary'], query, {
      where: nodeWhere,
      params: nodeFilter.params,
    });
  }

  async getSupersessionChain(nodeId: number): Promise<NodeRecord[]> {
    if (!this.supportsRecursiveCte) return this.getSupersessionChainIterative(nodeId);
    // BL-504 (Segment D): ORDER BY ch.depth, n.rowid — the recursive SQL must
    // match the iterative fallback's (depth, rowid) sort exactly. Equal-depth
    // ties were engine-order dependent before; n.rowid is the deterministic
    // tiebreaker both paths share.
    const sql = `
      WITH RECURSIVE
      connected(rowid) AS (
        SELECT ? AS rowid
        UNION SELECT e.src FROM edge e JOIN connected c ON e.dst = c.rowid WHERE e.rel = 'SUPERSEDES'
        UNION SELECT e.dst FROM edge e JOIN connected c ON e.src = c.rowid WHERE e.rel = 'SUPERSEDES'
      ),
      head(rowid) AS (
        SELECT c.rowid FROM connected c
        WHERE NOT EXISTS (SELECT 1 FROM edge WHERE rel = 'SUPERSEDES' AND src = c.rowid) LIMIT 1
      ),
      chain(rowid, depth) AS (
        SELECT h.rowid, 0 FROM head h
        UNION SELECT e.src, ch.depth + 1 FROM edge e JOIN chain ch ON e.dst = ch.rowid WHERE e.rel = 'SUPERSEDES'
      )
      SELECT n.* FROM node n JOIN chain ch ON n.rowid = ch.rowid ORDER BY ch.depth, n.rowid
    `;
    const { rows } = await this.adapter.executeAll<DbNodeRow>(sql, [nodeId]);
    return rows.map(rowToNodeRecord);
  }

  /**
   * Iterative fallback for {@link getSupersessionChain} — the same CTE
   * phases as the recursive SQL, walked with getEdges: (1) bidirectional
   * `connected` set from `nodeId`, discovered FIFO so the Set's insertion
   * order IS the recursive CTE's BFS scan order (seed first, then per
   * dequeued node the incoming arm before the outgoing arm, mirroring the
   * CTE's two UNION arms); (2) `head` = FIRST connected node in that BFS
   * discovery order with no outbound SUPERSEDES (the recursive `head` CTE
   * is `LIMIT 1` over the connected scan — BFS order from the seed, NOT
   * rowid order, which is what picks the head on multi-root components);
   * (3) `chain` BFS from head via dst → src with depth; (4) collect
   * (rowid, depth), sort (depth, rowid), fetch nodes.
   *
   * Produces the SAME oldest-first ordering as the recursive SQL on linear
   * chains (pinned by the parity tests: [v1, v2, v3]) and the SAME set AND
   * order on multi-root components (pinned by the two-root parity test:
   * getSupersessionChain(v9) → [v9, v2, v3] on both paths). Neither path
   * filters node liveness — the recursive CTEs never join `node`, so
   * invalidated chain members are returned by both. Edges are walked via
   * getEdges (live edges only, `t_invalid IS NULL`) — the recursive SQL
   * also walks only live edges; no public path invalidates SUPERSEDES
   * edges, so the two cannot diverge in practice.
   */
  private async getSupersessionChainIterative(nodeId: number): Promise<NodeRecord[]> {
    // (1) connected set — bidirectional reachability over SUPERSEDES edges,
    //     FIFO queue so discovery order = the recursive `connected` CTE's
    //     scan order. For each dequeued node the CTE emits the incoming arm
    //     (`SELECT e.src … ON e.dst = c.rowid`) before the outgoing arm
    //     (`SELECT e.dst … ON e.src = c.rowid`) — the getEdges calls below
    //     are in that same arm order.
    const connected = new Set<number>([nodeId]);
    const frontier = [nodeId];
    while (frontier.length > 0) {
      const current = frontier.shift()!;
      for (const e of await this.getEdges({ dst: current, rel: 'SUPERSEDES' })) {
        if (!connected.has(e.src)) { connected.add(e.src); frontier.push(e.src); }
      }
      for (const e of await this.getEdges({ src: current, rel: 'SUPERSEDES' })) {
        if (!connected.has(e.dst)) { connected.add(e.dst); frontier.push(e.dst); }
      }
    }

    // (2) head — FIRST connected node in BFS discovery order with no
    // outbound SUPERSEDES. The recursive `head` CTE is `LIMIT 1` over the
    // `connected` scan, which SQLite produces in BFS order from the seed
    // (FIFO queue, UNION dedup) — NOT rowid order. Iterating the Set
    // preserves its insertion order, so both paths pick the same head even
    // when a component has multiple no-outbound roots. (A connected node
    // with no outbound edge always exists: the seed itself has none unless
    // a cycle closes on it — and a cycle is still handled, the walk just
    // never finds a true head.)
    let head: number | null = null;
    for (const id of connected) {
      const outbound = await this.getEdges({ src: id, rel: 'SUPERSEDES' });
      if (outbound.length === 0) { head = id; break; }
    }
    if (head === null) return [];

    // (3) chain — BFS from head over dst → src children, level-tracked,
    // visited set for cycle termination (the recursive SQL terminates via
    // UNION dedup; this is the iterative equivalent).
    const chain = new Map<number, number>(); // rowid → depth
    chain.set(head, 0);
    let level = [head];
    let depth = 0;
    while (level.length > 0) {
      depth += 1;
      const next: number[] = [];
      for (const current of level) {
        for (const e of await this.getEdges({ dst: current, rel: 'SUPERSEDES' })) {
          if (!chain.has(e.src)) { chain.set(e.src, depth); next.push(e.src); }
        }
      }
      level = next;
    }

    // (4) collect (rowid, depth), sort (depth, rowid), fetch node rows.
    const ordered = [...chain.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const nodes: NodeRecord[] = [];
    for (const [id] of ordered) {
      const row = await this.adapter.executeGet<DbNodeRow>('SELECT * FROM node WHERE rowid = ?', [id]);
      if (row) nodes.push(rowToNodeRecord(row));
    }
    return nodes;
  }

  async writeEdge(src: number, dst: number, rel: EdgeRel, meta?: EdgeMeta): Promise<void> {
    await this.writeEdgeInternal(src, dst, rel, meta);
  }

  /**
   * FEAT-024 (A2) — set `edge.t_invalid` (soft-delete). Idempotent: an edge
   * that is already invalidated (or absent) is a no-op. The v2 model re-assigns
   * status/priority/component by invalidating the old edge + writing the new
   * one. `writeEdge` with the same (src, dst, rel) re-livens it (`t_invalid =
   * NULL`) via the existing upsert. `reason`, when present, is merged into the
   * edge's `meta` alongside `invalidatedAt`.
   */
  async invalidateEdge(src: number, dst: number, rel: EdgeRel, reason?: string): Promise<void> {
    const existing = await this.adapter.executeGet<{ rowid: number; meta: string | null }>(
      'SELECT rowid, meta FROM edge WHERE src = ? AND dst = ? AND rel = ? AND t_invalid IS NULL',
      [src, dst, rel],
    );
    if (!existing) return; // already invalidated or absent — idempotent
    const now = nowISO();
    const metaObj: Record<string, unknown> = {
      ...parseJson(existing.meta, {}),
      invalidatedAt: now,
      ...(reason !== undefined ? { invalidatedReason: reason } : {}),
    };
    await this.adapter.executeRun(
      'UPDATE edge SET t_invalid = ?, meta = ? WHERE rowid = ?',
      [now, JSON.stringify(metaObj), existing.rowid],
    );
  }

  /**
   * FEAT-013 — resolve endpoint kinds, then validate the edge with endpoint
   * context when the injected TypePolicy provides `validateEdge`. Falls back to
   * `validateRel` (byte-identical to the pre-FEAT-013 behavior) when the policy
   * has no `validateEdge`. `resolvedKinds` is the writeGraph fast-path: kinds
   * already captured during node insertion, avoiding a per-edge SELECT.
   */
  private async writeEdgeInternal(
    src: number,
    dst: number,
    rel: EdgeRel,
    meta?: EdgeMeta,
    resolvedKinds?: Map<number, string>,
  ): Promise<void> {
    let srcKind: string | undefined;
    let dstKind: string | undefined;
    if (resolvedKinds) {
      srcKind = resolvedKinds.get(src);
      dstKind = resolvedKinds.get(dst);
    } else {
      const { rows } = await this.adapter.executeAll<{ rowid: number; kind: string }>(
        'SELECT rowid, kind FROM node WHERE rowid IN (?, ?)', [src, dst],
      );
      for (const row of rows) {
        if (row.rowid === src) srcKind = row.kind;
        if (row.rowid === dst) dstKind = row.kind;
      }
    }
    if (srcKind === undefined) throw new NodeNotFoundError(`Node not found (edge src): ${src}`, src);
    if (dstKind === undefined) throw new NodeNotFoundError(`Node not found (edge dst): ${dst}`, dst);

    if (this.typePolicy.validateEdge) {
      this.typePolicy.validateEdge(srcKind, rel, dstKind);
    } else {
      this.typePolicy.validateRel(rel);
    }

    try {
      const now = nowISO();
      const metaJson = meta?.metadata !== undefined ? JSON.stringify(meta.metadata) : null;
      await this.adapter.executeRun(
        `INSERT INTO edge (src, dst, rel, weight, origin, meta, t_created, t_valid)
         VALUES (?, ?, ?, ?, 'user_asserted', ?, ?, ?)
         ON CONFLICT(src, dst, rel) DO UPDATE SET
           meta = excluded.meta, weight = excluded.weight,
           t_invalid = NULL, t_valid = excluded.t_valid`,
        [src, dst, rel, meta?.weight ?? 1.0, metaJson, now, now],
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('CHECK constraint failed'))
        throw new ConstraintError(err.message);
      if (err instanceof Error && err.message.includes('FOREIGN KEY constraint failed'))
        throw new ConstraintError(err.message);
      throw err;
    }
  }

  async getEdges(opts: { src?: number; dst?: number; rel?: EdgeRel; metadata?: Record<string, MetadataFilterValue> }): Promise<EdgeRecord[]> {
    const clauses: string[] = ['t_invalid IS NULL'];
    const params: unknown[] = [];
    if (opts.src !== undefined) { clauses.push('src = ?'); params.push(opts.src); }
    if (opts.dst !== undefined) { clauses.push('dst = ?'); params.push(opts.dst); }
    if (opts.rel !== undefined) { clauses.push('rel = ?'); params.push(opts.rel); }
    // FEAT-024 (B6) — edge metadata filtering (same operator surface as
    // NodeFilter.metadata, FEAT-014). The v2 transition-edge queries filter by
    // `sha`/`agent`.
    if (opts.metadata !== undefined) {
      appendMetadataFilterClauses('', opts.metadata, clauses, params);
    }
    const { rows } = await this.adapter.executeAll<DbEdgeRow>(
      `SELECT * FROM edge WHERE ${clauses.join(' AND ')}`, params,
    );
    return rows.map(rowToEdgeRecord);
  }

  async getNeighbors(nodeId: number, opts?: { rel?: EdgeRel; depth?: number; direction?: 'in' | 'out' | 'both' }): Promise<NodeRecord[]> {
    const direction = opts?.direction ?? 'out';
    const depth = opts?.depth ?? 1;
    if (depth <= 0) return [];
    if (depth === 1) return this.getNeighborsDepth1(nodeId, opts?.rel, direction);
    return this.getNeighborsRecursive(nodeId, opts?.rel, depth, direction);
  }

  private async getNeighborsDepth1(nodeId: number, rel?: EdgeRel, direction: 'in' | 'out' | 'both' = 'out'): Promise<NodeRecord[]> {
    if (direction === 'both') {
      const outgoing = await this.getNeighborsDepth1(nodeId, rel, 'out');
      const incoming = await this.getNeighborsDepth1(nodeId, rel, 'in');
      const seen = new Set(outgoing.map((n) => n.id));
      for (const n of incoming) { if (!seen.has(n.id)) { seen.add(n.id); outgoing.push(n); } }
      return outgoing;
    }
    const clauses: string[] = ['e.t_invalid IS NULL', 'n.t_invalid IS NULL'];
    const params: unknown[] = [];
    if (direction === 'out') clauses.push('e.src = ?'); else clauses.push('e.dst = ?');
    params.push(nodeId);
    if (rel) { clauses.push('e.rel = ?'); params.push(rel); }
    const joinCol = direction === 'out' ? 'e.dst' : 'e.src';
    const { rows } = await this.adapter.executeAll<DbNodeRow>(
      `SELECT DISTINCT n.* FROM node n JOIN edge e ON n.rowid = ${joinCol} WHERE ${clauses.join(' AND ')}`, params,
    );
    return rows.map(rowToNodeRecord);
  }

  private async getNeighborsRecursive(nodeId: number, rel: EdgeRel | undefined, depth: number, direction: 'in' | 'out' | 'both'): Promise<NodeRecord[]> {
    if (!this.supportsRecursiveCte) return this.getNeighborsIterative(nodeId, rel, depth, direction);
    const relFilter = rel ? `AND rel = '${rel.replace(/'/g, "''")}'` : '';
    if (direction === 'both') {
      const out = await this.getNeighborsRecursive(nodeId, rel, depth, 'out');
      const inNodes = await this.getNeighborsRecursive(nodeId, rel, depth, 'in');
      const seen = new Set(out.map((n) => n.id));
      for (const n of inNodes) { if (!seen.has(n.id)) { seen.add(n.id); out.push(n); } }
      return out;
    }
    const joinCol = direction === 'out' ? 'e.dst' : 'e.src';
    // BL-504: `NOT INDEXED` forces the rowid-PK path — without it the planner
    // scans the partial index ix_node_validity (all live nodes) and the join
    // goes super-linear (98.6s @ 2.8k nodes). Revisit if this query ever gains
    // an ORDER BY on a node column.
    const { rows } = await this.adapter.executeAll<DbNodeRow>(
      `WITH RECURSIVE neighbors(rowid) AS (
        SELECT ? UNION SELECT ${joinCol} FROM edge e JOIN neighbors n ON e.${direction === 'out' ? 'src' : 'dst'} = n.rowid
        WHERE e.t_invalid IS NULL ${relFilter} LIMIT ?
      )
      SELECT DISTINCT n.* FROM node n NOT INDEXED JOIN neighbors nb ON n.rowid = nb.rowid WHERE n.t_invalid IS NULL`,
      [nodeId, depth * 100],
    );
    return rows.map(rowToNodeRecord).filter((n) => n.id !== nodeId);
  }

  /**
   * Iterative fallback for {@link getNeighborsRecursive} — BFS with a visited
   * set (cycle termination), excluding the seed. Mirrors the recursive path
   * exactly in the two places that matter:
   *
   * - **Budget semantics (empirical, real sqlite, 2026-08-10):** the
   *   recursive CTE's `LIMIT depth*100` is a TOTAL row budget across the whole
   *   recursion INCLUDING the seed row — NOT a per-step cap (probe: LIMIT 25
   *   over a level-1 fanout of 25 returned exactly 25 rows = seed + 24; LIMIT
   *   30 returned seed + 25 + 4; LIMIT 100000 over a 30-chain returned all 30).
   *   `depth` bounds the BUDGET, not the walk depth — the recursive walk is
   *   depth-unbounded and stops only when the budget binds or the graph is
   *   exhausted. The iterative counter counts total discovered rows (seed
   *   included), so both paths truncate identically.
   * - **Liveness:** edges walked live-only (getEdges = `t_invalid IS NULL`,
   *   same as the CTE's WHERE); the RESULT filters `node.t_invalid IS NULL`
   *   (same as the outer SELECT) while the walk itself crosses invalidated
   *   nodes (the CTE never joins node).
   *
   * direction 'both' runs out and in as two independent budgeted walks, then
   * union-dedups — byte-for-byte what the recursive 'both' branch does.
   */
  private async getNeighborsIterative(
    nodeId: number,
    rel: EdgeRel | undefined,
    depth: number,
    direction: 'in' | 'out' | 'both',
  ): Promise<NodeRecord[]> {
    if (direction === 'both') {
      const out = await this.getNeighborsIterative(nodeId, rel, depth, 'out');
      const inNodes = await this.getNeighborsIterative(nodeId, rel, depth, 'in');
      const seen = new Set(out.map((n) => n.id));
      for (const n of inNodes) { if (!seen.has(n.id)) { seen.add(n.id); out.push(n); } }
      return out;
    }
    const budget = depth * 100;
    const visited = new Set<number>([nodeId]);
    let frontier = [nodeId];
    let discovered = 1; // the seed counts against the recursive LIMIT budget
    while (frontier.length > 0 && discovered < budget) {
      const next: number[] = [];
      for (const current of frontier) {
        const edgeOpts: { src?: number; dst?: number; rel?: EdgeRel } = {};
        if (rel !== undefined) edgeOpts.rel = rel;
        if (direction === 'out') edgeOpts.src = current; else edgeOpts.dst = current;
        const edges = await this.getEdges(edgeOpts);
        for (const e of edges) {
          if (discovered >= budget) break;
          const nid = direction === 'out' ? e.dst : e.src;
          if (visited.has(nid)) continue;
          visited.add(nid);
          next.push(nid);
          discovered += 1;
        }
        if (discovered >= budget) break;
      }
      frontier = next;
    }
    const ids = [...visited].filter((id) => id !== nodeId);
    if (ids.length === 0) return [];
    const { rows } = await this.adapter.executeAll<DbNodeRow>(
      `SELECT n.* FROM node n WHERE n.rowid IN (${ids.map(() => '?').join(',')}) AND n.t_invalid IS NULL`,
      ids,
    );
    return rows.map(rowToNodeRecord);
  }

  async getNeighborsWithEdges(
    nodeId: number, opts?: { rel?: EdgeRel; depth?: number; direction?: 'in' | 'out' | 'both' },
  ): Promise<Array<{ node: NodeRecord; edge: EdgeRecord }>> {
    const direction = opts?.direction ?? 'out';
    const depth = opts?.depth ?? 1;
    if (depth <= 0) return [];
    if (depth > 1) {
      const neighbors = await this.getNeighbors(nodeId, opts);
      const result: Array<{ node: NodeRecord; edge: EdgeRecord }> = [];
      for (const node of neighbors) {
        const edgeOpts: { src?: number; dst?: number; rel?: EdgeRel } = {};
        if (opts?.rel !== undefined) edgeOpts.rel = opts.rel;
        if (direction === 'in') { edgeOpts.src = node.id; edgeOpts.dst = nodeId; }
        else { edgeOpts.src = nodeId; edgeOpts.dst = node.id; }
        const edges = await this.getEdges(edgeOpts);
        for (const edge of edges) result.push({ node, edge });
      }
      return result;
    }
    if (direction === 'both') {
      const outgoing = await this.getNeighborsWithEdges(nodeId, { ...opts, direction: 'out' });
      const incoming = await this.getNeighborsWithEdges(nodeId, { ...opts, direction: 'in' });
      const seen = new Map<string, number>();
      const result: Array<{ node: NodeRecord; edge: EdgeRecord }> = [];
      for (const item of outgoing) {
        const key = `${item.edge.src}:${item.edge.dst}:${item.edge.rel}`;
        if (!seen.has(key)) { seen.set(key, result.length); result.push(item); }
      }
      for (const item of incoming) {
        const key = `${item.edge.src}:${item.edge.dst}:${item.edge.rel}`;
        if (!seen.has(key)) { seen.set(key, result.length); result.push(item); }
      }
      return result;
    }
    const clauses: string[] = ['e.t_invalid IS NULL', 'n.t_invalid IS NULL'];
    const params: unknown[] = [];
    if (direction === 'out') clauses.push('e.src = ?'); else clauses.push('e.dst = ?');
    params.push(nodeId);
    if (opts?.rel) { clauses.push('e.rel = ?'); params.push(opts.rel); }
    const joinCol = direction === 'out' ? 'e.dst' : 'e.src';
    interface NeighborRow extends DbNodeRow {
      e_rowid: number; e_src: number; e_dst: number; e_rel: string;
      e_weight: number | null; e_t_created: string; e_meta: string | null;
    }
    const { rows } = await this.adapter.executeAll<NeighborRow>(
      `SELECT n.*, e.rowid AS e_rowid, e.src AS e_src, e.dst AS e_dst, e.rel AS e_rel,
              e.weight AS e_weight, e.t_created AS e_t_created, e.meta AS e_meta
       FROM node n JOIN edge e ON n.rowid = ${joinCol} WHERE ${clauses.join(' AND ')}`, params,
    );
    return rows.map((r) => {
      const edgeRec: EdgeRecord = { src: r.e_src, dst: r.e_dst, rel: r.e_rel as EdgeRel, tCreated: r.e_t_created };
      if (r.e_weight != null) edgeRec.weight = r.e_weight;
      const edgeMeta = parseJsonOptional(r.e_meta);
      if (edgeMeta !== undefined) edgeRec.metadata = edgeMeta;
      return { node: rowToNodeRecord(r as unknown as DbNodeRow), edge: edgeRec };
    });
  }

  async isReachable(src: number, dst: number, opts?: { rel?: EdgeRel; direction?: 'out' | 'in' }): Promise<boolean> {
    const direction = opts?.direction ?? 'out';
    if (!this.supportsRecursiveCte) {
      // Iterative BFS from src with early exit on discovering dst — unbounded,
      // NO node-liveness filter (the recursive `path` CTE never joins node;
      // only edge liveness applies, which getEdges filters). Cycle-terminating
      // via the visited set (the recursive SQL terminates via UNION dedup).
      if (src === dst) return true;
      const visited = new Set<number>([src]);
      let frontier = [src];
      while (frontier.length > 0) {
        const next: number[] = [];
        for (const current of frontier) {
          const edgeOpts: { src?: number; dst?: number; rel?: EdgeRel } = {};
          if (opts?.rel !== undefined) edgeOpts.rel = opts.rel;
          if (direction === 'out') edgeOpts.src = current; else edgeOpts.dst = current;
          const edges = await this.getEdges(edgeOpts);
          for (const e of edges) {
            const nid = direction === 'out' ? e.dst : e.src;
            if (nid === dst) return true;
            if (!visited.has(nid)) { visited.add(nid); next.push(nid); }
          }
        }
        frontier = next;
      }
      return false;
    }
    const relFilter = opts?.rel ? `AND rel = '${opts.rel.replace(/'/g, "''")}'` : '';
    let sql: string;
    if (direction === 'out') {
      sql = `WITH RECURSIVE path(rowid) AS (
        SELECT ? AS rowid UNION SELECT e.dst FROM edge e JOIN path p ON e.src = p.rowid
        WHERE e.t_invalid IS NULL ${relFilter}) SELECT 1 FROM path WHERE rowid = ? LIMIT 1`;
    } else {
      sql = `WITH RECURSIVE path(rowid) AS (
        SELECT ? AS rowid UNION SELECT e.src FROM edge e JOIN path p ON e.dst = p.rowid
        WHERE e.t_invalid IS NULL ${relFilter}) SELECT 1 FROM path WHERE rowid = ? LIMIT 1`;
    }
    const row = await this.adapter.executeGet<{ 1: number }>(sql, [src, dst]);
    return row !== null;
  }

  async getSubgraph(
    rootId: number, opts?: { rel?: EdgeRel; depth?: number; direction?: 'out' | 'in' | 'both' },
  ): Promise<{ nodes: NodeRecord[]; edges: EdgeRecord[] }> {
    if (!this.supportsRecursiveCte) return this.getSubgraphIterative(rootId, opts);
    const direction = opts?.direction ?? 'both';
    const maxDepth = opts?.depth ?? -1;
    const relFilter = opts?.rel ? `AND e.rel = '${opts.rel.replace(/'/g, "''")}'` : '';
    if (direction === 'both') {
      const outSub = await this.getSubgraph(rootId, { ...opts, direction: 'out' });
      const inSub = await this.getSubgraph(rootId, { ...opts, direction: 'in' });
      const seen = new Set(outSub.nodes.map((n) => n.id));
      for (const n of inSub.nodes) { if (!seen.has(n.id)) { seen.add(n.id); outSub.nodes.push(n); } }
      const edgeSeen = new Set(outSub.edges.map((e) => `${e.src}:${e.dst}:${e.rel}`));
      for (const e of inSub.edges) {
        const key = `${e.src}:${e.dst}:${e.rel}`;
        if (!edgeSeen.has(key)) { edgeSeen.add(key); outSub.edges.push(e); }
      }
      return { nodes: outSub.nodes, edges: outSub.edges };
    }
    const joinCol = direction === 'out' ? 'e.dst' : 'e.src';
    const srcCol = direction === 'out' ? 'e.src' : 'e.dst';
    let nodeSql: string; let params: unknown[];
    if (maxDepth >= 0) {
      nodeSql = `WITH RECURSIVE sub(rowid, depth) AS (
        SELECT ?, 0 UNION SELECT ${joinCol}, s.depth + 1 FROM edge e JOIN sub s ON ${srcCol} = s.rowid
        WHERE e.t_invalid IS NULL ${relFilter} AND s.depth < ?)
        SELECT DISTINCT n.* FROM node n JOIN sub s ON n.rowid = s.rowid`;
      params = [rootId, maxDepth];
    } else {
      nodeSql = `WITH RECURSIVE sub(rowid) AS (
        SELECT ? UNION SELECT ${joinCol} FROM edge e JOIN sub s ON ${srcCol} = s.rowid
        WHERE e.t_invalid IS NULL ${relFilter})
        SELECT DISTINCT n.* FROM node n JOIN sub s ON n.rowid = s.rowid`;
      params = [rootId];
    }
    const { rows: nodeRows } = await this.adapter.executeAll<DbNodeRow>(nodeSql, params);
    const nodes = nodeRows.map(rowToNodeRecord);
    if (nodes.length === 0) return { nodes: [], edges: [] };
    const nodeIds = nodes.map((n) => n.id);
    const { rows: edgeRows } = await this.adapter.executeAll<DbEdgeRow>(
      `SELECT * FROM edge WHERE src IN (${nodeIds.map(() => '?').join(',')})
       AND dst IN (${nodeIds.map(() => '?').join(',')}) AND t_invalid IS NULL`,
      [...nodeIds, ...nodeIds],
    );
    return { nodes, edges: edgeRows.map(rowToEdgeRecord) };
  }

  /**
   * Iterative fallback for {@link getSubgraph} — level-by-level BFS from
   * rootId (level 0 = the root), visited set for cycle termination (the
   * recursive `sub` CTE terminates via UNION dedup). `maxDepth >= 0` stops at
   * depth === maxDepth (mirroring the recursive term's `s.depth < maxDepth`);
   * `-1` walks unbounded. direction 'both' runs out and in and merges by id
   * / src:dst:rel key — byte-for-byte the recursive 'both' branch.
   *
   * Deliberately NO node-liveness filter: the recursive `sub` CTE never joins
   * `node`, so an invalidated node behind a live edge IS part of the subgraph
   * — the parity tests pin this quirk on both paths. Edges use the SAME
   * non-recursive query as the recursive path, verbatim (src IN + dst IN +
   * t_invalid IS NULL).
   */
  private async getSubgraphIterative(
    rootId: number, opts?: { rel?: EdgeRel; depth?: number; direction?: 'out' | 'in' | 'both' },
  ): Promise<{ nodes: NodeRecord[]; edges: EdgeRecord[] }> {
    const direction = opts?.direction ?? 'both';
    const maxDepth = opts?.depth ?? -1;
    if (direction === 'both') {
      const outSub = await this.getSubgraphIterative(rootId, { ...opts, direction: 'out' });
      const inSub = await this.getSubgraphIterative(rootId, { ...opts, direction: 'in' });
      const seen = new Set(outSub.nodes.map((n) => n.id));
      for (const n of inSub.nodes) { if (!seen.has(n.id)) { seen.add(n.id); outSub.nodes.push(n); } }
      const edgeSeen = new Set(outSub.edges.map((e) => `${e.src}:${e.dst}:${e.rel}`));
      for (const e of inSub.edges) {
        const key = `${e.src}:${e.dst}:${e.rel}`;
        if (!edgeSeen.has(key)) { edgeSeen.add(key); outSub.edges.push(e); }
      }
      return { nodes: outSub.nodes, edges: outSub.edges };
    }
    const visited = new Set<number>([rootId]);
    let level = [rootId];
    let depth = 0;
    while (level.length > 0 && (maxDepth < 0 || depth < maxDepth)) {
      depth += 1;
      const next: number[] = [];
      for (const current of level) {
        const edgeOpts: { src?: number; dst?: number; rel?: EdgeRel } = {};
        if (opts?.rel !== undefined) edgeOpts.rel = opts.rel;
        if (direction === 'out') edgeOpts.src = current; else edgeOpts.dst = current;
        const edges = await this.getEdges(edgeOpts);
        for (const e of edges) {
          const nid = direction === 'out' ? e.dst : e.src;
          if (!visited.has(nid)) { visited.add(nid); next.push(nid); }
        }
      }
      level = next;
    }
    const nodeIds = [...visited];
    let nodes: NodeRecord[] = [];
    if (nodeIds.length > 0) {
      const { rows: nodeRows } = await this.adapter.executeAll<DbNodeRow>(
        `SELECT n.* FROM node n WHERE n.rowid IN (${nodeIds.map(() => '?').join(',')})`,
        nodeIds,
      );
      nodes = nodeRows.map(rowToNodeRecord);
    }
    if (nodes.length === 0) return { nodes: [], edges: [] };
    const { rows: edgeRows } = await this.adapter.executeAll<DbEdgeRow>(
      `SELECT * FROM edge WHERE src IN (${nodeIds.map(() => '?').join(',')})
       AND dst IN (${nodeIds.map(() => '?').join(',')}) AND t_invalid IS NULL`,
      [...nodeIds, ...nodeIds],
    );
    return { nodes, edges: edgeRows.map(rowToEdgeRecord) };
  }
}

export function createGraphBackend(adapter: StoreAdapter, opts?: GraphBackendOpts): GraphBackend {
  const backend = new StoreGraphBackend(adapter, opts);
  // (BL-508) Eager: run the foreign-engine guard + engine-identity read now —
  // the "open result" carries the identity, and a marker mismatch must refuse
  // at open, not on the first graph op. Cached on the instance afterwards.
  void backend.engineIdentity;
  return backend;
}
