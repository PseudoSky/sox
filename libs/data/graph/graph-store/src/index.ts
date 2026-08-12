// @adhd/sox-graph-store — Bi-temporal graph store over StoreAdapter
import { createFTSDialect, createTursoAdapter, deleteSchemaRowsViaBetterSqlite3 } from '@adhd/sox-store-adapter';
import { assertStoreEngineSync, getEngineIdentitySync } from '@adhd/sox-store-adapter';
import type { EngineIdentity, StoreAdapter, TursoAdapter } from '@adhd/sox-store-adapter';
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
CREATE UNIQUE INDEX IF NOT EXISTS ix_edge_unique ON edge(src, dst, rel);
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
CREATE UNIQUE INDEX IF NOT EXISTS "ix_edge_unique" ON "edge" ("src", "dst", "rel");
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
];

export const EDGE_INDEX_DDLS = [
  `CREATE INDEX IF NOT EXISTS ix_edge_src        ON edge(src, rel) WHERE t_expired IS NULL`,
  `CREATE INDEX IF NOT EXISTS ix_edge_dst        ON edge(dst, rel) WHERE t_expired IS NULL`,
  `CREATE INDEX IF NOT EXISTS ix_edge_live       ON edge(t_invalid) WHERE t_invalid IS NULL`,
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
  metadata?: Record<string, unknown>;
  orderBy?: 'importance' | 'tCreated' | 'tValid' | 'name';
  orderDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface GraphBackendCapabilities {
  bitemporal: boolean;
  fullTextSearch: boolean;
  metadataFilter: boolean;
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

  writeNode(content: string, meta: NodeMeta): Promise<number>;
  supersede(oldId: number, newContent: string, meta: NodeMeta): Promise<number>;
  invalidate(nodeId: number, reason?: string): Promise<void>;
  touch(nodeId: number, meta: Partial<NodeMeta>): Promise<void>;
  writeNodeBatch(nodes: Array<{ content: string; meta: NodeMeta }>): Promise<number[]>;
  writeGraph(
    nodes: Array<{ content: string; meta: NodeMeta }>,
    edges: Array<{ srcIdx: number; dstIdx: number; rel: EdgeRel; meta?: EdgeMeta }>,
  ): Promise<number[]>;

  getNode(id: number): Promise<NodeRecord | null>;
  queryNodes(filter?: NodeFilter): Promise<NodeRecord[]>;
  searchNodes(
    query: string,
    opts?: { limit?: number; offset?: number; filter?: NodeFilter },
  ): Promise<Array<NodeRecord & { score: number }>>;
  countNodes(filter?: NodeFilter): Promise<number>;
  countNodesFts(query: string, filter?: NodeFilter): Promise<number>;
  getSupersessionChain(nodeId: number): Promise<NodeRecord[]>;

  writeEdge(src: number, dst: number, rel: EdgeRel, meta?: EdgeMeta): Promise<void>;

  getEdges(opts: { src?: number; dst?: number; rel?: EdgeRel }): Promise<EdgeRecord[]>;
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
}

/**
 * The default TypePolicy every SqliteGraphBackend gets when no typePolicy is supplied. This is
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
};

/** Options accepted by createGraphBackend() / the SqliteGraphBackend constructor. */
export interface GraphBackendOpts {
  /** Injected type-vocabulary policy. Defaults to DEFAULT_TYPE_POLICY (today's six kinds, ten rels). */
  typePolicy?: TypePolicy;
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

export interface FilterClause {
  where: string;
  params: unknown[];
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

    if (filter.metadata !== undefined) {
      for (const [key, value] of Object.entries(filter.metadata)) {
        clauses.push(`json_extract(${alias}meta, ?) = ?`);
        params.push(`$.${key}`, value);
      }
    }
  }

  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function buildOrderClause(filter: NodeFilter | undefined, tableAlias: string): string {
  if (!filter?.orderBy) return '';
  const alias = tableAlias ? `${tableAlias}.` : '';
  const col = (() => {
    switch (filter.orderBy) {
      case 'importance': return `${alias}importance`;
      case 'tCreated': return `${alias}t_created`;
      case 'tValid': return `${alias}t_valid`;
      case 'name': return `${alias}name`;
      default: return '';
    }
  })();
  if (!col) return '';
  const dir = filter.orderDir ??
    (filter.orderBy === 'importance' ? 'DESC' : filter.orderBy === 'name' ? 'ASC' : 'DESC');
  return `ORDER BY ${col} ${dir}`;
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
 * BL-507 — detects the Drizzle-era explicit-rowid FK form on `edge`.
 *
 * Pre-graph-store stores (the live backlog.db is one) were generated by
 * drizzle-orm with `REFERENCES node(rowid)` — the parent's `rowid` alias named
 * explicitly as the FK target column. Verified against the real Turso engine
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

export class SqliteGraphBackend implements GraphBackend {
  readonly capabilities: GraphBackendCapabilities;

  private adapter: StoreAdapter;
  private schemaApplied = false;
  private typePolicy: TypePolicy;
  /**
   * Whether the underlying engine accepts `WITH RECURSIVE` at prepare. True on
   * SQLite and Turso Database Rust >= 0.8.0; FALSE on Turso 0.7.x (probed
   * once at connect by store-adapter, see `AdapterCapabilities.recursiveCte`).
   * When false, the five recursive-graph methods below switch to iterative
   * BFS fallbacks that produce the same results (empirically pinned by the
   * "recursive-cte fallback parity" tests). External adapters that omit the
   * capability default to true — only Turso 0.7.x sets it false.
   */
  private supportsRecursiveCte: boolean;

  /** (BL-508) Cached engine identity — see the `engineIdentity` getter. */
  private _engineIdentity: EngineIdentity | null | undefined;

  constructor(adapter: StoreAdapter, opts?: GraphBackendOpts) {
    this.adapter = adapter;
    this.typePolicy = opts?.typePolicy ?? DEFAULT_TYPE_POLICY;
    // BUG-SOXGRAPH-001: fullTextSearch DERIVES from the adapter's fts
    // capability instead of being hardcoded true — an adapter reporting
    // fts:false must not advertise an FTS surface that would then throw.
    this.capabilities = {
      bitemporal: true,
      fullTextSearch: adapter.capabilities.fts,
      metadataFilter: true,
    };
    this.supportsRecursiveCte = adapter.capabilities.recursiveCte ?? true;
    this._engineIdentity = undefined;
  }

  /**
   * (BL-508) The backing store's engine identity (marker row), computed once
   * per adapter instance and cached. The foreign-engine guard runs on the
   * FIRST access: a turso-owned store with a SQLite marker FAILS CLOSED here
   * (typed `ESqliteNativeStore`) — defense-in-depth under the turso adapter's
   * own connect-time refusal, for direct-adapter consumers. Access cost is
   * per-connection, never per-op (adapter handles are long-lived — memory-core
   * caches them in `getDb`).
   */
  get engineIdentity(): EngineIdentity | null {
    if (this._engineIdentity !== undefined) return this._engineIdentity;
    const dbPath = this.adapter.config.dbPath;
    if (!dbPath) {
      this._engineIdentity = null;
      return null;
    }
    if (this.adapter.config.type === 'turso') {
      // Fail-closed on a marker mismatch (unmarked legacy stays allowed).
      assertStoreEngineSync(dbPath, 'turso');
    }
    this._engineIdentity = getEngineIdentitySync(dbPath);
    return this._engineIdentity;
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
    // BL-507: the Drizzle-era `REFERENCES node(rowid)` explicit-column FK form
    // breaks every write on TURSO when foreign_keys=ON (verified against the
    // real engine; the live backlog.db carries this shape). Rebuild `edge` with
    // the canonical implicit form — same rebuild machinery as the enum-check
    // normalization below — so a legacy store self-heals at open (ADR-0007).
    // Gated on the engine: stock SQLite resolves `rowid` as the INTEGER
    // PRIMARY KEY alias, so a sqlite store carrying the form is fine and must
    // keep its identity byte-identical (BL-448 AC-3 — applySchema never churns
    // a store that is not broken).
    const edgeNeedsRebuild =
      (!!edgeRow && hasEnumCheckConstraint(edgeRow.sql, 'rel') && !edgeRow.sql.includes("'DEPENDS_ON'")) ||
      (!!edgeRow && this.adapter.config.type === 'turso' && hasExplicitRowidForeignKey(edgeRow.sql));

    if (nodeNeedsRebuild || edgeNeedsRebuild) {
      // (BL-506) The rebuild below ALTER-RENAMEs a NEW `edge` sqlite_master row
      // to a rowid after every existing row. On a Drizzle-era store the dead
      // fts5 residue rows sit mid-catalog; a rebuilt row landing after them
      // would never register (BL-508's silent catalog abort — the live
      // outage). Drop the residue FIRST.
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
   * Drizzle-era stores (the live backlog.db is one) carry the SQLite-era FTS5
   * stack (`fts_node` virtual table + 4 shadow tables + 3 content-sync
   * triggers) at `sqlite_master` rows after `node`/`edge`. graph-store's FTS
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
        log.error('graph_store.heal.fts5_residue_drop_failed', {
          db_path: dbPath,
          error: repair.failed,
        });
      }
    };

    // Same-instance reconnect around the out-of-band drop (BL-508: a
    // better-sqlite3 write must never run while the turso connection holds
    // the file) — the caller's adapter handle stays valid.
    const recyclable = this.adapter as TursoAdapter & {
      withConnectionClosedForRepair?: <T>(fn: () => Promise<T>) => Promise<T>;
    };
    if (typeof recyclable.withConnectionClosedForRepair === 'function') {
      await recyclable.withConnectionClosedForRepair(drop);
      return;
    }

    // Fallback for a foreign turso adapter that lacks the same-instance
    // repair hook: close, drop, and recreate the adapter. The caller's own
    // handle goes stale only in this synthetic case — every real turso
    // adapter (`TursoAdapterImpl`) implements the hook.
    await this.adapter.close();
    try {
      await drop();
    } finally {
      this.adapter = await createTursoAdapter({
        ...(cfg.url !== undefined ? { url: cfg.url } : {}),
        dbPath,
        ...(cfg.authToken !== undefined ? { authToken: cfg.authToken } : {}),
        ...(cfg.readonly === true ? { readonly: true } : {}),
        ...(cfg.allowFtsInReadonly === true ? { allowFtsInReadonly: true } : {}),
        ...(cfg.experimental !== undefined ? { experimental: cfg.experimental } : {}),
      });
    }
  }

  private async addColumnIfMissing(table: string, column: string, type: string): Promise<void> {
    const cols = (await this.adapter.executeAll<{ name: string }>(`PRAGMA table_info(${table})`))
      .rows.map((c) => c.name);
    if (!cols.includes(column)) {
      await this.adapter.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  async writeNode(content: string, meta: NodeMeta): Promise<number> {
    const kind = meta.kind ?? 'episode';
    this.typePolicy.validateKind(kind);

    const hash = hashContent(content);
    const existing = await this.adapter.executeGet<{ rowid: number }>(
      'SELECT rowid FROM node WHERE content_hash = ?', [hash],
    );
    if (existing) return existing.rowid;

    const uid = generateUid();
    const now = nowISO();
    const tOccurred = meta.tOccurred ?? now;
    const tagsJson = meta.tags && meta.tags.length > 0 ? JSON.stringify(meta.tags) : null;
    const metaJson = meta.metadata !== undefined ? JSON.stringify(meta.metadata) : null;

    const result = await this.adapter.executeGet<{ rowid: number }>(
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
    return result.rowid;
  }

  async supersede(oldId: number, newContent: string, meta: NodeMeta): Promise<number> {
    const oldNode = await this.adapter.executeGet<DbNodeRow>('SELECT * FROM node WHERE rowid = ?', [oldId]);
    if (!oldNode) {
      throw new NodeNotFoundError(`Node not found: ${oldId}`, oldId);
    }
    if (oldNode.t_invalid !== null) {
      throw new BitemporalConflictError(`Node ${oldId} is already invalidated`, oldId);
    }

    return this.adapter.transaction(async (_tx) => {
      const newId = await this.writeNode(newContent, meta);
      await this.adapter.executeRun(`UPDATE node SET is_superseded = 1 WHERE rowid = ?`, [oldId]);
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
    }
  }

  async writeNodeBatch(nodes: Array<{ content: string; meta: NodeMeta }>): Promise<number[]> {
    return this.adapter.transaction(async (_tx) => {
      const ids: number[] = [];
      for (const n of nodes) ids.push(await this.writeNode(n.content, n.meta));
      return ids;
    });
  }

  async writeGraph(
    nodes: Array<{ content: string; meta: NodeMeta }>,
    edges: Array<{ srcIdx: number; dstIdx: number; rel: EdgeRel; meta?: EdgeMeta }>,
  ): Promise<number[]> {
    return this.adapter.transaction(async (_tx) => {
      const nodeIds: number[] = [];
      for (const n of nodes) nodeIds.push(await this.writeNode(n.content, n.meta));
      for (const edge of edges) {
        if (edge.srcIdx < 0 || edge.srcIdx >= nodeIds.length)
          throw new ConstraintError(`Invalid srcIdx: ${edge.srcIdx}`);
        if (edge.dstIdx < 0 || edge.dstIdx >= nodeIds.length)
          throw new ConstraintError(`Invalid dstIdx: ${edge.dstIdx}`);
        const srcId = nodeIds[edge.srcIdx];
        const dstId = nodeIds[edge.dstIdx];
        if (srcId === undefined || dstId === undefined)
          throw new ConstraintError('Node ID resolution failed');
        await this.writeEdgeInternal(srcId, dstId, edge.rel, edge.meta);
      }
      return nodeIds;
    });
  }

  async getNode(id: number): Promise<NodeRecord | null> {
    const row = await this.adapter.executeGet<DbNodeRow>('SELECT * FROM node WHERE rowid = ?', [id]);
    return row ? rowToNodeRecord(row) : null;
  }

  async queryNodes(filter?: NodeFilter): Promise<NodeRecord[]> {
    const { where, params } = buildNodeFilterClause(filter, true, 'n');
    const order = buildOrderClause(filter, 'n');
    let limitClause = '';
    const limitParams: unknown[] = [];
    if (filter?.limit !== undefined) {
      limitClause = 'LIMIT ?';
      limitParams.push(filter.limit);
      if (filter.offset !== undefined) { limitClause += ' OFFSET ?'; limitParams.push(filter.offset); }
    }
    const sql = `SELECT n.* FROM node n ${where} ${order} ${limitClause}`;
    const { rows } = await this.adapter.executeAll<DbNodeRow>(sql, [...params, ...limitParams]);
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
    const nodeFilter = buildNodeFilterClause(opts?.filter, true, 'n');
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
    const { where, params } = buildNodeFilterClause(filter, true, 'n');
    const row = await this.adapter.executeGet<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM node n ${where}`, params);
    return row?.cnt ?? 0;
  }

  async countNodesFts(query: string, filter?: NodeFilter): Promise<number> {
    // BUG-SOXGRAPH-001: capability guard — fts:false → 0, never throw.
    if (!this.capabilities.fullTextSearch) return 0;
    const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return 0;
    const nodeFilter = buildNodeFilterClause(filter, true, 'n');
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

  private async writeEdgeInternal(src: number, dst: number, rel: EdgeRel, meta?: EdgeMeta): Promise<void> {
    this.typePolicy.validateRel(rel);
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

  async getEdges(opts: { src?: number; dst?: number; rel?: EdgeRel }): Promise<EdgeRecord[]> {
    const clauses: string[] = ['t_invalid IS NULL'];
    const params: unknown[] = [];
    if (opts.src !== undefined) { clauses.push('src = ?'); params.push(opts.src); }
    if (opts.dst !== undefined) { clauses.push('dst = ?'); params.push(opts.dst); }
    if (opts.rel !== undefined) { clauses.push('rel = ?'); params.push(opts.rel); }
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
  const backend = new SqliteGraphBackend(adapter, opts);
  // (BL-508) Eager: run the foreign-engine guard + engine-identity read now —
  // the "open result" carries the identity, and a marker mismatch must refuse
  // at open, not on the first graph op. Cached on the instance afterwards.
  void backend.engineIdentity;
  return backend;
}
