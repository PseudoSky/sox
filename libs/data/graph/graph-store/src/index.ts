// @adhd/sox-graph-store — Bi-temporal graph store over StoreAdapter
import { createFTSDialect, resolveExistingFtsIndexName, canonicalFtsIndexName } from '@adhd/sox-store-adapter';
import type { FTSDialect, StoreAdapter } from '@adhd/sox-store-adapter';
import * as crypto from 'node:crypto';
import { rebuildTable } from './rebuild-table.js';
export { rebuildTable };

export const PRAGMAS: string[] = [
  'PRAGMA journal_mode = WAL;',
  'PRAGMA busy_timeout = 5000;',
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
  } catch {
    return fallback;
  }
}

function parseJsonOptional(val: string | null): Record<string, unknown> | undefined {
  if (val === null || val === undefined) return undefined;
  try {
    return JSON.parse(val) as Record<string, unknown>;
  } catch {
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

export class SqliteGraphBackend implements GraphBackend {
  readonly capabilities: GraphBackendCapabilities = {
    bitemporal: true,
    fullTextSearch: true,
    metadataFilter: true,
  };

  private adapter: StoreAdapter;
  private schemaApplied = false;
  private typePolicy: TypePolicy;

  constructor(adapter: StoreAdapter, opts?: GraphBackendOpts) {
    this.adapter = adapter;
    this.typePolicy = opts?.typePolicy ?? DEFAULT_TYPE_POLICY;
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
   * FTS schema creation — dialect-driven, NEVER unconditional.
   *
   * Before this, applySchema() ran `FTS_DDL` (`CREATE VIRTUAL TABLE … USING
   * fts5`) + `FTS_TRIGGERS` + a backfill `INSERT INTO fts_node` on EVERY
   * open, regardless of adapter. A Turso adapter (`capabilities.fts5 ===
   * false`) rejects fts5 DDL outright (`Parse error: no such module: fts5` —
   * the reported "graph import is failing because fts5 is missing"), so any
   * graph-store consumer that opened on Turso crashed at applySchema(). The
   * store's own dialect (store-adapter's FTSDialect) decides what "create
   * FTS" means per backend: the fts5 virtual table + triggers on SQLite, a
   * Tantivy `CREATE INDEX … USING fts` on Turso, nothing on an adapter that
   * reports no FTS capability. The backfill INSERT only applies to the fts5
   * shadow table — Turso's Tantivy index is maintained by the engine and has
   * no row-insert surface.
   */
  private async applyFtsSchema(): Promise<void> {
    const dialect = createFTSDialect(this.adapter.config.type);
    if (!dialect.supported || !this.adapter.capabilities.fts) return;
    // (BL-461, BL-498 review) Ask whether the TABLE already has an FTS index,
    // not whether one particular NAME is free — the same guard memory-core's
    // openDb() uses (db.ts:603-622). Turso has no `ALTER INDEX … RENAME`, so
    // the orphan guard's rebuild (store-adapter's fts-orphan-guard.ts)
    // necessarily leaves a repaired index under a different name —
    // `idx_fts_node__r1`. `CREATE INDEX IF NOT EXISTS idx_fts_node` would then
    // find its own name free and build a SECOND full-text index over the same
    // columns: measured to coexist and answer queries correctly, so the only
    // symptom is permanently doubled write and storage cost, silently.
    // Resolve the actual index; if one exists under a non-canonical name,
    // ADOPT it (skip creation) so a duplicate is never built. The lookup
    // returns null on SQLite (fts5's virtual-table name is load-bearing), so
    // the FTS5 path below is untouched.
    const existingFtsIndex = await resolveExistingFtsIndexName(this.adapter, 'node');
    if (existingFtsIndex !== null && existingFtsIndex !== canonicalFtsIndexName('node')) {
      return; // adopted — the table already carries a healthy FTS index
    }
    const ftsColumns = ['content', 'name', 'summary'];
    for (const stmt of dialect.createIndexDDL(
      'node',
      ftsColumns,
      { content: 1.0, name: 1.0, summary: 1.0 },
      [FTS_DDL, FTS_TRIGGERS],
    )) {
      try {
        await this.adapter.exec(stmt);
      } catch (err) {
        if (err instanceof Error && /already exists/i.test(err.message)) continue;
        throw err;
      }
    }
    if (this.adapter.capabilities.fts5) {
      await this.adapter.exec(
        `INSERT INTO fts_node(rowid, content, name, summary)
         SELECT rowid, content, name, summary FROM node`,
      );
    }
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
    const edgeNeedsRebuild =
      !!edgeRow && hasEnumCheckConstraint(edgeRow.sql, 'rel') && !edgeRow.sql.includes("'DEPENDS_ON'");

    if (nodeNeedsRebuild || edgeNeedsRebuild) {
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
    if (!this.capabilities.fullTextSearch) return [];
    const dialect = createFTSDialect(this.adapter.config.type);
    const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return [];
    const ftsQuery = dialect.buildMatchQuery(tokens);
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset;
    const nodeFilter = buildNodeFilterClause(opts?.filter, true, 'n');
    const nodeWhere = nodeFilter.where ? `AND ${nodeFilter.where.replace(/^WHERE /, '')}` : '';
    let limitClause = 'LIMIT ?';
    const limitParams: unknown[] = [limit];
    if (offset !== undefined) { limitClause += ' OFFSET ?'; limitParams.push(offset); }

    const { sql, params } = this.buildFtsSearchSql(dialect, ftsQuery, nodeWhere);
    const { rows } = await this.adapter.executeAll<DbNodeRow & { score: number }>(
      `${sql} ${limitClause}`, [...params, ...nodeFilter.params, ...limitParams],
    );
    return rows.map((r) => ({ ...rowToNodeRecord(r as unknown as DbNodeRow), score: r.score }));
  }

  /**
   * FTS search SQL — dialect-shaped (the same `supportsShadowTable` split
   * memory-core's recall.ts uses): SQLite FTS5 keeps a separate `fts_node`
   * shadow table joined back to `node` (score is the negated `rank` column),
   * Turso's Tantivy index lives directly on `node` (`fts_match`/`fts_score`,
   * each binding its own query param). Never branches on `adapter.config.type`.
   */
  private buildFtsSearchSql(
    dialect: FTSDialect,
    ftsQuery: string,
    nodeWhere: string,
  ): { sql: string; params: unknown[] } {
    const ftsColumns = ['content', 'name', 'summary'];
    const { sql: matchSql } = dialect.matchClause(ftsColumns, '?');
    const scoreExpr = dialect.scoreClause(ftsColumns, '?');
    if (dialect.supportsShadowTable) {
      return {
        sql: `SELECT n.*, -${scoreExpr} AS score
              FROM fts_node JOIN node n ON fts_node.rowid = n.rowid
              WHERE ${matchSql} ${nodeWhere}
              ORDER BY score DESC`,
        params: [ftsQuery],
      };
    }
    return {
      sql: `SELECT n.*, ${scoreExpr} AS score
            FROM node n
            WHERE ${matchSql} ${nodeWhere}
            ORDER BY score DESC`,
      params: [ftsQuery, ftsQuery],
    };
  }

  async countNodes(filter?: NodeFilter): Promise<number> {
    const { where, params } = buildNodeFilterClause(filter, true, 'n');
    const row = await this.adapter.executeGet<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM node n ${where}`, params);
    return row?.cnt ?? 0;
  }

  async countNodesFts(query: string, filter?: NodeFilter): Promise<number> {
    if (!this.capabilities.fullTextSearch) return 0;
    const dialect = createFTSDialect(this.adapter.config.type);
    const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return 0;
    const ftsQuery = dialect.buildMatchQuery(tokens);
    const nodeFilter = buildNodeFilterClause(filter, true, 'n');
    const nodeWhere = nodeFilter.where ? `AND ${nodeFilter.where.replace(/^WHERE /, '')}` : '';
    const ftsColumns = ['content', 'name', 'summary'];
    const { sql: matchSql } = dialect.matchClause(ftsColumns, '?');
    if (dialect.supportsShadowTable) {
      const sql = `SELECT COUNT(*) as cnt FROM fts_node JOIN node n ON fts_node.rowid = n.rowid WHERE ${matchSql} ${nodeWhere}`;
      const row = await this.adapter.executeGet<{ cnt: number }>(sql, [ftsQuery, ...nodeFilter.params]);
      return row?.cnt ?? 0;
    }
    const sql = `SELECT COUNT(*) as cnt FROM node n WHERE ${matchSql} ${nodeWhere}`;
    const row = await this.adapter.executeGet<{ cnt: number }>(sql, [ftsQuery, ...nodeFilter.params]);
    return row?.cnt ?? 0;
  }

  async getSupersessionChain(nodeId: number): Promise<NodeRecord[]> {
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
      SELECT n.* FROM node n JOIN chain ch ON n.rowid = ch.rowid ORDER BY ch.depth
    `;
    const { rows } = await this.adapter.executeAll<DbNodeRow>(sql, [nodeId]);
    return rows.map(rowToNodeRecord);
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
    const relFilter = rel ? `AND rel = '${rel.replace(/'/g, "''")}'` : '';
    if (direction === 'both') {
      const out = await this.getNeighborsRecursive(nodeId, rel, depth, 'out');
      const inNodes = await this.getNeighborsRecursive(nodeId, rel, depth, 'in');
      const seen = new Set(out.map((n) => n.id));
      for (const n of inNodes) { if (!seen.has(n.id)) { seen.add(n.id); out.push(n); } }
      return out;
    }
    const joinCol = direction === 'out' ? 'e.dst' : 'e.src';
    const { rows } = await this.adapter.executeAll<DbNodeRow>(
      `WITH RECURSIVE neighbors(rowid) AS (
        SELECT ? UNION SELECT ${joinCol} FROM edge e JOIN neighbors n ON e.${direction === 'out' ? 'src' : 'dst'} = n.rowid
        WHERE e.t_invalid IS NULL ${relFilter} LIMIT ?
      )
      SELECT DISTINCT n.* FROM node n JOIN neighbors nb ON n.rowid = nb.rowid WHERE n.t_invalid IS NULL`,
      [nodeId, depth * 100],
    );
    return rows.map(rowToNodeRecord).filter((n) => n.id !== nodeId);
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
}

export function createGraphBackend(adapter: StoreAdapter, opts?: GraphBackendOpts): GraphBackend {
  return new SqliteGraphBackend(adapter, opts);
}
