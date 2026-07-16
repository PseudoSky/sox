// @adhd/sox-graph-store — Bi-temporal graph store over SQLite
import Database from 'better-sqlite3';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { rebuildTable } from './rebuild-table.js';
export { rebuildTable }; // re-export for consumers (memory-core, etc.)

// GRAPH_DDL / FTS_DDL / FTS_TRIGGERS are kept exported for backward-compat with
// consumers (memory-core/schema.ts) that compose them into their own DDL strings.
// The Drizzle migration handles table creation via drizzle/migrations/ at startup;
// these raw DDL strings are still valid for idempotent (IF NOT EXISTS) composition.

// ─── Schema DDL ───────────────────────────────────────────────────────────────

export const PRAGMAS: string[] = [
  'PRAGMA journal_mode = WAL;',
  'PRAGMA busy_timeout = 5000;',
  'PRAGMA synchronous = NORMAL;',
  'PRAGMA foreign_keys = ON;',
  'PRAGMA cache_size = -64000;',
];

export const GRAPH_DDL = `
CREATE TABLE IF NOT EXISTS node (
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
);

CREATE TABLE IF NOT EXISTS edge (
  rowid     INTEGER PRIMARY KEY,
  src       INTEGER NOT NULL REFERENCES node(rowid) ON DELETE CASCADE,
  dst       INTEGER NOT NULL REFERENCES node(rowid) ON DELETE CASCADE,
  rel       TEXT NOT NULL CHECK (rel IN ('MENTIONS','SUPPORTS','RELATES_TO','SUPERSEDES','DERIVED_FROM','MEMBER_OF','PART_OF','SAME_AS','ASSIGNED_TO','DEPENDS_ON')),
  weight    REAL DEFAULT 1.0,
  confidence REAL,
  origin    TEXT CHECK (origin IN ('extracted','inferred','user_asserted')),
  meta      TEXT,
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

// ─── Table rebuild helpers for CHECK constraint upgrades ─────────────────────

// The canonical node table DDL (without IF NOT EXISTS) for table rebuilds.
// See also: drizzle/schema.ts (migration management) and graph-store.spec.ts V1_* (test helpers).
const NODE_TABLE_DDL = `CREATE TABLE node (
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

const EDGE_TABLE_DDL = `CREATE TABLE edge (
  rowid     INTEGER PRIMARY KEY,
  src       INTEGER NOT NULL REFERENCES node(rowid) ON DELETE CASCADE,
  dst       INTEGER NOT NULL REFERENCES node(rowid) ON DELETE CASCADE,
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

const NODE_COLUMNS = [
  'rowid', 'uid', 'kind', 'content', 'name', 'summary', 'topic', 'tags',
  'importance', 'confidence', 'content_hash', 'namespace', 'meta', 'agent_id',
  'session_id', 'source', 'project_path', 'level', 'resume_state', 't_occurred',
  't_expires', 't_created', 't_valid', 't_invalid', 'is_superseded',
  'access_count', 'last_access', 't_updated',
];

const EDGE_COLUMNS = [
  'rowid', 'src', 'dst', 'rel', 'weight', 'confidence', 'origin', 'meta',
  't_created', 't_expired', 't_valid', 't_invalid',
];

const NODE_INDEX_DDLS = [
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

const EDGE_INDEX_DDLS = [
  `CREATE INDEX IF NOT EXISTS ix_edge_src        ON edge(src, rel) WHERE t_expired IS NULL`,
  `CREATE INDEX IF NOT EXISTS ix_edge_dst        ON edge(dst, rel) WHERE t_expired IS NULL`,
  `CREATE INDEX IF NOT EXISTS ix_edge_live       ON edge(t_invalid) WHERE t_invalid IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ix_edge_unique ON edge(src, dst, rel)`,
];

// ─── Error taxonomy ───────────────────────────────────────────────────────────

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

// ─── Shared types ─────────────────────────────────────────────────────────────

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
  | 'DEPENDS_ON';

export type Confidence = 'confirmed' | 'unverified' | 'disputed' | 'deprecated';

export interface NodeMeta {
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
  topic?: string | string[];
  tags?: string[];
  tagsMatchAll?: boolean;
  importanceMin?: number;
  confidence?: Confidence | Confidence[];
  tCreatedAfter?: string;
  tCreatedBefore?: string;
  validAt?: string;
  isStale?: boolean;
  namespace?: string;
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

  applySchema(): void;

  writeNode(content: string, meta: NodeMeta): number;
  supersede(oldId: number, newContent: string, meta: NodeMeta): number;
  invalidate(nodeId: number, reason?: string): void;
  touch(nodeId: number, meta: Partial<NodeMeta>): void;
  writeNodeBatch(nodes: Array<{ content: string; meta: NodeMeta }>): number[];
  writeGraph(
    nodes: Array<{ content: string; meta: NodeMeta }>,
    edges: Array<{ srcIdx: number; dstIdx: number; rel: EdgeRel; meta?: EdgeMeta }>,
  ): number[];

  getNode(id: number): NodeRecord | null;
  queryNodes(filter?: NodeFilter): NodeRecord[];
  searchNodes(
    query: string,
    opts?: { limit?: number; filter?: NodeFilter },
  ): Array<NodeRecord & { score: number }>;
  countNodes(filter?: NodeFilter): number;
  getSupersessionChain(nodeId: number): NodeRecord[];

  writeEdge(src: number, dst: number, rel: EdgeRel, meta?: EdgeMeta): void;

  getEdges(opts: { src?: number; dst?: number; rel?: EdgeRel }): EdgeRecord[];
  getNeighbors(
    nodeId: number,
    opts?: { rel?: EdgeRel; depth?: number; direction?: 'in' | 'out' | 'both' },
  ): NodeRecord[];
  getNeighborsWithEdges(
    nodeId: number,
    opts?: { rel?: EdgeRel; depth?: number; direction?: 'in' | 'out' | 'both' },
  ): Array<{ node: NodeRecord; edge: EdgeRecord }>;

  isReachable(
    src: number,
    dst: number,
    opts?: { rel?: EdgeRel; direction?: 'out' | 'in' },
  ): boolean;
  getSubgraph(
    rootId: number,
    opts?: { rel?: EdgeRel; depth?: number; direction?: 'out' | 'in' | 'both' },
  ): { nodes: NodeRecord[]; edges: EdgeRecord[] };
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Filter clause builder ────────────────────────────────────────────────────

interface FilterClause {
  where: string;
  params: unknown[];
}

function buildNodeFilterClause(
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

// ─── SqliteGraphBackend ───────────────────────────────────────────────────────

export class SqliteGraphBackend implements GraphBackend {
  readonly capabilities: GraphBackendCapabilities = {
    bitemporal: true,
    fullTextSearch: true,
    metadataFilter: true,
  };

  private db: Database.Database;
  private schemaApplied = false;

  constructor(db: Database.Database) {
    this.db = db;
    this.applySchema();
  }

  // ── Schema ────────────────────────────────────────────────────────────────

  applySchema(): void {
    if (this.schemaApplied) return;

    for (const pragma of PRAGMAS) {
      this.db.exec(pragma);
    }

    // Run Drizzle migrations — creates node + edge tables (with IF NOT EXISTS
    // for idempotency), all indexes, and CHECK constraints. Uses the
    // __drizzle_migrations table for version tracking (replaces old _schema_version).
    const drizzleDb = drizzle(this.db);
    const migrationsFolder = fileURLToPath(new URL('../drizzle/migrations', import.meta.url));
    migrate(drizzleDb, { migrationsFolder });

    // Drizzle cannot express FTS5 virtual tables or triggers.
    // These are applied every startup (CREATE IF NOT EXISTS / triggers are idempotent).
    this.db.exec(FTS_DDL);
    this.db.exec(FTS_TRIGGERS);

    // Rebuild FTS index from existing rows (content='node' external mode).
    // Rows inserted before FTS triggers existed must be registered in the FTS
    // index; otherwise the first UPDATE trigger fails with SQLITE_CORRUPT_VTAB
    // because content='node' mode detects the row in the content table but not
    // in the FTS index. Safe on fresh DBs (no rows → no-op).
    this.db.exec(
      `INSERT INTO fts_node(rowid, content, name, summary)
       SELECT rowid, content, name, summary FROM node`,
    );

    // Ensure CHECK constraints are up-to-date on pre-existing stores.
    // Drizzle's CREATE TABLE IF NOT EXISTS is a no-op on existing tables,
    // so old CHECK constraints (without 'generic', without 'DEPENDS_ON')
    // from earlier versions must be upgraded explicitly.
    this.ensureCheckConstraints();

    this.schemaApplied = true;
  }

  /**
   * Upgrade CHECK constraints on pre-existing tables that were created by an
   * earlier version of graph-store before Drizzle migration management was in
   * place. Uses the rename→create→copy→drop→rename dance (rebuildTable) since
   * SQLite does not support ALTER TABLE CHECK constraint changes.
   *
   * Also adds any canonical columns that may be missing from pre-Drizzle stores
   * (e.g. level, resume_state on node; t_expired on edge, added in the old v2
   * migration). Safe to call on fresh stores — checks exit early when columns
   * exist and constraints already include the expected values.
   */
  private ensureCheckConstraints(): void {
    // Step 1: Ensure all canonical columns exist on pre-existing stores.
    // The old v1 schema (before custom migrations) was missing level, resume_state
    // on node and t_expired on edge. These must be present before any table rebuild
    // so the INSERT…SELECT copy in rebuildTable doesn't fail with "no such column".
    this.addColumnIfMissing('node', 'level', 'INTEGER');
    this.addColumnIfMissing('node', 'resume_state', 'TEXT');
    this.addColumnIfMissing('edge', 't_expired', 'TEXT');

    // Step 2: Node kind CHECK must include 'generic' (upgraded from old v3).
    const nodeRow = this.db
      .prepare<[], { sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='node'`,
      )
      .get();
    if (nodeRow && !nodeRow.sql.includes("'generic'")) {
      this.db.transaction(() => {
        rebuildTable(this.db, 'node', NODE_TABLE_DDL, NODE_COLUMNS);
        for (const ddl of NODE_INDEX_DDLS) this.db.exec(ddl);
        // Recreate FTS triggers + rebuild FTS index after table rebuild
        this.db.exec(FTS_TRIGGERS);
        this.db.exec(
          `INSERT INTO fts_node(rowid, content, name, summary)
           SELECT rowid, content, name, summary FROM node`,
        );
      })();
    }

    // Step 3: Edge rel CHECK must include 'DEPENDS_ON' (upgraded from old v4).
    const edgeRow = this.db
      .prepare<[], { sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='edge'`,
      )
      .get();
    if (edgeRow && !edgeRow.sql.includes("'DEPENDS_ON'")) {
      this.db.transaction(() => {
        rebuildTable(this.db, 'edge', EDGE_TABLE_DDL, EDGE_COLUMNS);
        for (const ddl of EDGE_INDEX_DDLS) this.db.exec(ddl);
      })();
    }
  }

  /** Add a column if it does not already exist (idempotent). */
  private addColumnIfMissing(table: string, column: string, type: string): void {
    const cols = this.db
      .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => c.name);
    if (!cols.includes(column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  // ── Node writes ───────────────────────────────────────────────────────────

  writeNode(content: string, meta: NodeMeta): number {
    const hash = hashContent(content);
    const existing = this.db
      .prepare<[string], { rowid: number }>('SELECT rowid FROM node WHERE content_hash = ?')
      .get(hash);
    if (existing) return existing.rowid;

    const uid = generateUid();
    const now = nowISO();
    const tOccurred = meta.tOccurred ?? now;
    const tagsJson = meta.tags && meta.tags.length > 0 ? JSON.stringify(meta.tags) : null;
    const metaJson = meta.metadata !== undefined ? JSON.stringify(meta.metadata) : null;

    const result = this.db
      .prepare<
        unknown[],
        { rowid: number }
      >(
        `INSERT INTO node (uid, kind, content, name, summary, topic, tags, importance,
          confidence, content_hash, namespace, meta, agent_id, session_id, source,
          project_path, t_occurred, t_expires, t_created, t_valid)
         VALUES (?, 'episode', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING rowid`,
      )
      .get(
        uid,
        content,
        meta.name ?? null,
        meta.summary ?? null,
        meta.topic ?? null,
        tagsJson,
        meta.importance ?? 1.0,
        meta.confidence ?? null,
        hash,
        meta.namespace ?? 'global',
        metaJson,
        meta.agentId ?? null,
        meta.sessionId ?? null,
        meta.source ?? null,
        meta.projectPath ?? null,
        tOccurred,
        meta.tExpires ?? null,
        now,
        now,
      );

    if (!result) throw new Error('Insert failed: no rowid returned');
    return result.rowid;
  }

  supersede(oldId: number, newContent: string, meta: NodeMeta): number {
    const oldNode = this.db
      .prepare<[number], DbNodeRow>('SELECT * FROM node WHERE rowid = ?')
      .get(oldId);
    if (!oldNode) {
      throw new NodeNotFoundError(`Node not found: ${oldId}`, oldId);
    }
    if (oldNode.t_invalid !== null) {
      throw new BitemporalConflictError(
        `Node ${oldId} is already invalidated`,
        oldId,
      );
    }

    return this.db.transaction(() => {
      const newId = this.writeNode(newContent, meta);

      this.db
        .prepare(`UPDATE node SET is_superseded = 1 WHERE rowid = ?`)
        .run(oldId);

      this.writeEdge(newId, oldId, 'SUPERSEDES', {
        metadata: {
          reason: `superseded by node ${newId}`,
          supersededAt: nowISO(),
        },
      });

      return newId;
    })() as number;
  }

  invalidate(nodeId: number, reason?: string): void {
    const node = this.db
      .prepare<[number], { rowid: number }>('SELECT rowid FROM node WHERE rowid = ?')
      .get(nodeId);
    if (!node) {
      throw new NodeNotFoundError(`Node not found: ${nodeId}`, nodeId);
    }

    const now = nowISO();
    const existingMeta = this.db
      .prepare<[number], { meta: string | null }>('SELECT meta FROM node WHERE rowid = ?')
      .get(nodeId);

    let metaObj: Record<string, unknown> = parseJson(existingMeta?.meta ?? null, {});
    if (reason) {
      metaObj = { ...metaObj, invalidatedReason: reason, invalidatedAt: now };
    } else {
      metaObj = { ...metaObj, invalidatedAt: now };
    }

    this.db
      .prepare(`UPDATE node SET t_invalid = ?, meta = ? WHERE rowid = ?`)
      .run(now, JSON.stringify(metaObj), nodeId);
  }

  touch(nodeId: number, meta: Partial<NodeMeta>): void {
    const node = this.db
      .prepare<[number], DbNodeRow>('SELECT * FROM node WHERE rowid = ?')
      .get(nodeId);

    if (!node || node.t_invalid !== null) {
      throw new NodeNotFoundError(
        `Node not found or invalidated: ${nodeId}`,
        nodeId,
      );
    }

    const now = nowISO();
    const updates: string[] = [];
    const params: unknown[] = [];

    if (meta.name !== undefined) {
      updates.push('name = ?');
      params.push(meta.name);
    }
    if (meta.summary !== undefined) {
      updates.push('summary = ?');
      params.push(meta.summary);
    }
    if (meta.topic !== undefined) {
      updates.push('topic = ?');
      params.push(meta.topic);
    }
    if (meta.tags !== undefined) {
      updates.push('tags = ?');
      params.push(meta.tags.length > 0 ? JSON.stringify(meta.tags) : null);
    }
    if (meta.importance !== undefined) {
      updates.push('importance = ?');
      params.push(meta.importance);
    }
    if (meta.confidence !== undefined) {
      updates.push('confidence = ?');
      params.push(meta.confidence);
    }
    if (meta.tExpires !== undefined) {
      updates.push('t_expires = ?');
      params.push(meta.tExpires);
    }
    if (meta.metadata !== undefined) {
      updates.push('meta = ?');
      params.push(JSON.stringify(meta.metadata));
    }
    updates.push('t_updated = ?');
    params.push(now);

    if (updates.length > 0) {
      this.db
        .prepare(`UPDATE node SET ${updates.join(', ')} WHERE rowid = ?`)
        .run(...params, nodeId);
    }
  }

  writeNodeBatch(nodes: Array<{ content: string; meta: NodeMeta }>): number[] {
    return this.db.transaction(() => {
      return nodes.map((n) => this.writeNode(n.content, n.meta));
    })() as number[];
  }

  writeGraph(
    nodes: Array<{ content: string; meta: NodeMeta }>,
    edges: Array<{ srcIdx: number; dstIdx: number; rel: EdgeRel; meta?: EdgeMeta }>,
  ): number[] {
    return this.db.transaction(() => {
      const nodeIds = nodes.map((n) => this.writeNode(n.content, n.meta));

      for (const edge of edges) {
        if (edge.srcIdx < 0 || edge.srcIdx >= nodeIds.length) {
          throw new ConstraintError(`Invalid srcIdx: ${edge.srcIdx}`);
        }
        if (edge.dstIdx < 0 || edge.dstIdx >= nodeIds.length) {
          throw new ConstraintError(`Invalid dstIdx: ${edge.dstIdx}`);
        }
        const srcId = nodeIds[edge.srcIdx];
        const dstId = nodeIds[edge.dstIdx];
        if (srcId === undefined || dstId === undefined) {
          throw new ConstraintError('Node ID resolution failed');
        }
        this.writeEdgeInternal(srcId, dstId, edge.rel, edge.meta);
      }

      return nodeIds;
    })() as number[];
  }

  // ── Node reads ────────────────────────────────────────────────────────────

  getNode(id: number): NodeRecord | null {
    const row = this.db
      .prepare<[number], DbNodeRow>('SELECT * FROM node WHERE rowid = ?')
      .get(id);
    return row ? rowToNodeRecord(row) : null;
  }

  queryNodes(filter?: NodeFilter): NodeRecord[] {
    const { where, params } = buildNodeFilterClause(filter, true, 'n');
    const order = buildOrderClause(filter, 'n');
    let limitClause = '';
    const limitParams: unknown[] = [];

    if (filter?.limit !== undefined) {
      limitClause = 'LIMIT ?';
      limitParams.push(filter.limit);
      if (filter.offset !== undefined) {
        limitClause += ' OFFSET ?';
        limitParams.push(filter.offset);
      }
    }

    const sql = `SELECT n.* FROM node n ${where} ${order} ${limitClause}`;
    const rows = this.db
      .prepare<unknown[], DbNodeRow>(sql)
      .all(...params, ...limitParams);
    return rows.map(rowToNodeRecord);
  }

  searchNodes(
    query: string,
    opts?: { limit?: number; filter?: NodeFilter },
  ): Array<NodeRecord & { score: number }> {
    const ftsQuery = query.replace(/"/g, '""');
    const limit = opts?.limit ?? 50;

    const nodeFilter = buildNodeFilterClause(opts?.filter, true, 'n');
    const nodeWhere = nodeFilter.where ? `AND ${nodeFilter.where.replace(/^WHERE /, '')}` : '';

    const sql = `
      SELECT n.*, -fts_node.rank AS score
      FROM fts_node
      JOIN node n ON fts_node.rowid = n.rowid
      WHERE fts_node MATCH ? ${nodeWhere}
      ORDER BY score DESC
      LIMIT ?
    `;

    const rows = this.db
      .prepare<unknown[], DbNodeRow & { score: number }>(sql)
      .all(ftsQuery, ...nodeFilter.params, limit);

    return rows.map((r: DbNodeRow & { score: number }) => ({ ...rowToNodeRecord(r as unknown as DbNodeRow), score: r.score }));
  }

  countNodes(filter?: NodeFilter): number {
    const { where, params } = buildNodeFilterClause(filter, true, 'n');
    const sql = `SELECT COUNT(*) as cnt FROM node n ${where}`;
    const row = this.db
      .prepare<unknown[], { cnt: number }>(sql)
      .get(...params);
    return row?.cnt ?? 0;
  }

  getSupersessionChain(nodeId: number): NodeRecord[] {
    const sql = `
      WITH RECURSIVE
      connected(rowid) AS (
        SELECT ? AS rowid
        UNION
        SELECT e.src FROM edge e JOIN connected c ON e.dst = c.rowid WHERE e.rel = 'SUPERSEDES'
        UNION
        SELECT e.dst FROM edge e JOIN connected c ON e.src = c.rowid WHERE e.rel = 'SUPERSEDES'
      ),
      head(rowid) AS (
        SELECT c.rowid FROM connected c
        WHERE NOT EXISTS (SELECT 1 FROM edge WHERE rel = 'SUPERSEDES' AND src = c.rowid)
        LIMIT 1
      ),
      chain(rowid, depth) AS (
        SELECT h.rowid, 0 FROM head h
        UNION
        SELECT e.src, ch.depth + 1
        FROM edge e JOIN chain ch ON e.dst = ch.rowid
        WHERE e.rel = 'SUPERSEDES'
      )
      SELECT n.* FROM node n JOIN chain ch ON n.rowid = ch.rowid ORDER BY ch.depth
    `;
    const rows = this.db
      .prepare<[number], DbNodeRow>(sql)
      .all(nodeId);
    return rows.map(rowToNodeRecord);
  }

  // ── Edge writes ───────────────────────────────────────────────────────────

  writeEdge(src: number, dst: number, rel: EdgeRel, meta?: EdgeMeta): void {
    this.writeEdgeInternal(src, dst, rel, meta);
  }

  private writeEdgeInternal(
    src: number,
    dst: number,
    rel: EdgeRel,
    meta?: EdgeMeta,
  ): void {
    try {
      const now = nowISO();
      const metaJson = meta?.metadata !== undefined ? JSON.stringify(meta.metadata) : null;

      this.db
        .prepare(
          `INSERT INTO edge (src, dst, rel, weight, origin, meta, t_created, t_valid)
           VALUES (?, ?, ?, ?, 'user_asserted', ?, ?, ?)
           ON CONFLICT(src, dst, rel) DO UPDATE SET
             meta = excluded.meta,
             weight = excluded.weight,
             t_invalid = NULL,
             t_valid = excluded.t_valid`,
        )
        .run(src, dst, rel, meta?.weight ?? 1.0, metaJson, now, now);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('CHECK constraint failed')) {
        throw new ConstraintError(err.message);
      }
      if (err instanceof Error && err.message.includes('FOREIGN KEY constraint failed')) {
        throw new ConstraintError(err.message);
      }
      throw err;
    }
  }

  // ── Edge reads ────────────────────────────────────────────────────────────

  getEdges(opts: { src?: number; dst?: number; rel?: EdgeRel }): EdgeRecord[] {
    const clauses: string[] = ['t_invalid IS NULL'];
    const params: unknown[] = [];

    if (opts.src !== undefined) {
      clauses.push('src = ?');
      params.push(opts.src);
    }
    if (opts.dst !== undefined) {
      clauses.push('dst = ?');
      params.push(opts.dst);
    }
    if (opts.rel !== undefined) {
      clauses.push('rel = ?');
      params.push(opts.rel);
    }

    const sql = `SELECT * FROM edge WHERE ${clauses.join(' AND ')}`;
    const rows = this.db
      .prepare<unknown[], DbEdgeRow>(sql)
      .all(...params);
    return rows.map(rowToEdgeRecord);
  }

  getNeighbors(
    nodeId: number,
    opts?: { rel?: EdgeRel; depth?: number; direction?: 'in' | 'out' | 'both' },
  ): NodeRecord[] {
    const direction = opts?.direction ?? 'out';
    const depth = opts?.depth ?? 1;

    if (depth <= 0) return [];

    if (depth === 1) {
      return this.getNeighborsDepth1(nodeId, opts?.rel, direction);
    }

    return this.getNeighborsRecursive(nodeId, opts?.rel, depth, direction);
  }

  private getNeighborsDepth1(
    nodeId: number,
    rel?: EdgeRel,
    direction: 'in' | 'out' | 'both' = 'out',
  ): NodeRecord[] {
    if (direction === 'both') {
      const outgoing = this.getNeighborsDepth1(nodeId, rel, 'out');
      const incoming = this.getNeighborsDepth1(nodeId, rel, 'in');
      const seen = new Set(outgoing.map((n) => n.id));
      for (const n of incoming) {
        if (!seen.has(n.id)) {
          seen.add(n.id);
          outgoing.push(n);
        }
      }
      return outgoing;
    }

    const clauses: string[] = ['e.t_invalid IS NULL', 'n.t_invalid IS NULL'];
    const params: unknown[] = [];

    if (direction === 'out') {
      clauses.push('e.src = ?');
    } else {
      clauses.push('e.dst = ?');
    }
    params.push(nodeId);

    if (rel) {
      clauses.push('e.rel = ?');
      params.push(rel);
    }

    const joinCol = direction === 'out' ? 'e.dst' : 'e.src';
    const sql = `
      SELECT DISTINCT n.* FROM node n
      JOIN edge e ON n.rowid = ${joinCol}
      WHERE ${clauses.join(' AND ')}
    `;

    const rows = this.db
      .prepare<unknown[], DbNodeRow>(sql)
      .all(...params);
    return rows.map(rowToNodeRecord);
  }

  private getNeighborsRecursive(
    nodeId: number,
    rel: EdgeRel | undefined,
    depth: number,
    direction: 'in' | 'out' | 'both',
  ): NodeRecord[] {
    const relFilter = rel ? `AND rel = '${rel.replace(/'/g, "''")}'` : '';

    if (direction === 'both') {
      const out = this.getNeighborsRecursive(nodeId, rel, depth, 'out');
      const inNodes = this.getNeighborsRecursive(nodeId, rel, depth, 'in');
      const seen = new Set(out.map((n) => n.id));
      for (const n of inNodes) {
        if (!seen.has(n.id)) {
          seen.add(n.id);
          out.push(n);
        }
      }
      return out;
    }

    const joinCol = direction === 'out' ? 'e.dst' : 'e.src';
    const sql = `
      WITH RECURSIVE
      neighbors(rowid) AS (
        SELECT ?
        UNION
        SELECT ${joinCol}
        FROM edge e JOIN neighbors n ON e.${direction === 'out' ? 'src' : 'dst'} = n.rowid
        WHERE e.t_invalid IS NULL ${relFilter}
        LIMIT ?
      )
      SELECT DISTINCT n.* FROM node n
      JOIN neighbors nb ON n.rowid = nb.rowid
      WHERE n.t_invalid IS NULL
    `;

    const rows = this.db
      .prepare<unknown[], DbNodeRow>(sql)
      .all(nodeId, depth * 100);
    return rows
      .map(rowToNodeRecord)
      .filter((n) => n.id !== nodeId);
  }

  getNeighborsWithEdges(
    nodeId: number,
    opts?: { rel?: EdgeRel; depth?: number; direction?: 'in' | 'out' | 'both' },
  ): Array<{ node: NodeRecord; edge: EdgeRecord }> {
    const direction = opts?.direction ?? 'out';
    const depth = opts?.depth ?? 1;

    if (depth <= 0) return [];
    if (depth > 1) {
      const neighbors = this.getNeighbors(nodeId, opts);
      const result: Array<{ node: NodeRecord; edge: EdgeRecord }> = [];
      for (const node of neighbors) {
        const edgeOpts: { src?: number; dst?: number; rel?: EdgeRel } = {};
        if (opts?.rel !== undefined) edgeOpts.rel = opts.rel;
        if (direction === 'in') {
          edgeOpts.src = node.id;
          edgeOpts.dst = nodeId;
        } else {
          edgeOpts.src = nodeId;
          edgeOpts.dst = node.id;
        }
        const edges = this.getEdges(edgeOpts);
        for (const edge of edges) {
          result.push({ node, edge });
        }
      }
      return result;
    }

    if (direction === 'both') {
      const outgoing = this.getNeighborsWithEdges(nodeId, { ...opts, direction: 'out' });
      const incoming = this.getNeighborsWithEdges(nodeId, { ...opts, direction: 'in' });
      const seen = new Map<string, number>();
      const result: Array<{ node: NodeRecord; edge: EdgeRecord }> = [];
      for (const item of outgoing) {
        const key = `${item.edge.src}:${item.edge.dst}:${item.edge.rel}`;
        if (!seen.has(key)) {
          seen.set(key, result.length);
          result.push(item);
        }
      }
      for (const item of incoming) {
        const key = `${item.edge.src}:${item.edge.dst}:${item.edge.rel}`;
        if (!seen.has(key)) {
          seen.set(key, result.length);
          result.push(item);
        }
      }
      return result;
    }

    const clauses: string[] = ['e.t_invalid IS NULL', 'n.t_invalid IS NULL'];
    const params: unknown[] = [];

    if (direction === 'out') {
      clauses.push('e.src = ?');
    } else {
      clauses.push('e.dst = ?');
    }
    params.push(nodeId);

    if (opts?.rel) {
      clauses.push('e.rel = ?');
      params.push(opts.rel);
    }

    const joinCol = direction === 'out' ? 'e.dst' : 'e.src';
    const sql = `
      SELECT n.*, e.rowid AS e_rowid, e.src AS e_src, e.dst AS e_dst, e.rel AS e_rel,
             e.weight AS e_weight, e.t_created AS e_t_created, e.meta AS e_meta
      FROM node n
      JOIN edge e ON n.rowid = ${joinCol}
      WHERE ${clauses.join(' AND ')}
    `;

    interface NeighborRow extends DbNodeRow {
      e_rowid: number;
      e_src: number;
      e_dst: number;
      e_rel: string;
      e_weight: number | null;
      e_t_created: string;
      e_meta: string | null;
    }

    const rows = this.db
      .prepare<unknown[], NeighborRow>(sql)
      .all(...params);

    return rows.map((r: NeighborRow): { node: NodeRecord; edge: EdgeRecord } => {
      const edgeRec: EdgeRecord = {
        src: r.e_src,
        dst: r.e_dst,
        rel: r.e_rel as EdgeRel,
        tCreated: r.e_t_created,
      };
      if (r.e_weight != null) edgeRec.weight = r.e_weight;
      const edgeMeta = parseJsonOptional(r.e_meta);
      if (edgeMeta !== undefined) edgeRec.metadata = edgeMeta;
      return {
        node: rowToNodeRecord(r as unknown as DbNodeRow),
        edge: edgeRec,
      };
    });
  }

  // ── Graph traversal ───────────────────────────────────────────────────────

  isReachable(
    src: number,
    dst: number,
    opts?: { rel?: EdgeRel; direction?: 'out' | 'in' },
  ): boolean {
    const direction = opts?.direction ?? 'out';
    const relFilter = opts?.rel ? `AND rel = '${opts.rel.replace(/'/g, "''")}'` : '';

    let sql: string;
    if (direction === 'out') {
      sql = `
        WITH RECURSIVE path(rowid) AS (
          SELECT ? AS rowid
          UNION
          SELECT e.dst FROM edge e JOIN path p ON e.src = p.rowid
          WHERE e.t_invalid IS NULL ${relFilter}
        )
        SELECT 1 FROM path WHERE rowid = ? LIMIT 1
      `;
    } else {
      sql = `
        WITH RECURSIVE path(rowid) AS (
          SELECT ? AS rowid
          UNION
          SELECT e.src FROM edge e JOIN path p ON e.dst = p.rowid
          WHERE e.t_invalid IS NULL ${relFilter}
        )
        SELECT 1 FROM path WHERE rowid = ? LIMIT 1
      `;
    }

    const row = this.db
      .prepare<[number, number], { 1: number }>(sql)
      .get(src, dst);
    return row !== undefined;
  }

  getSubgraph(
    rootId: number,
    opts?: { rel?: EdgeRel; depth?: number; direction?: 'out' | 'in' | 'both' },
  ): { nodes: NodeRecord[]; edges: EdgeRecord[] } {
    const direction = opts?.direction ?? 'both';
    const maxDepth = opts?.depth ?? -1;
    const relFilter = opts?.rel ? `AND e.rel = '${opts.rel.replace(/'/g, "''")}'` : '';

    if (direction === 'both') {
      const outSub = this.getSubgraph(rootId, { ...opts, direction: 'out' });
      const inSub = this.getSubgraph(rootId, { ...opts, direction: 'in' });
      const seen = new Set(outSub.nodes.map((n) => n.id));
      for (const n of inSub.nodes) {
        if (!seen.has(n.id)) {
          seen.add(n.id);
          outSub.nodes.push(n);
        }
      }
      const edgeSeen = new Set(outSub.edges.map((e) => `${e.src}:${e.dst}:${e.rel}`));
      for (const e of inSub.edges) {
        const key = `${e.src}:${e.dst}:${e.rel}`;
        if (!edgeSeen.has(key)) {
          edgeSeen.add(key);
          outSub.edges.push(e);
        }
      }
      return { nodes: outSub.nodes, edges: outSub.edges };
    }

    const joinCol = direction === 'out' ? 'e.dst' : 'e.src';
    const srcCol = direction === 'out' ? 'e.src' : 'e.dst';

    let nodeSql: string;
    let params: unknown[];

    if (maxDepth >= 0) {
      nodeSql = `
        WITH RECURSIVE
        sub(rowid, depth) AS (
          SELECT ?, 0
          UNION
          SELECT ${joinCol}, s.depth + 1
          FROM edge e JOIN sub s ON ${srcCol} = s.rowid
          WHERE e.t_invalid IS NULL ${relFilter} AND s.depth < ?
        )
        SELECT DISTINCT n.* FROM node n JOIN sub s ON n.rowid = s.rowid
      `;
      params = [rootId, maxDepth];
    } else {
      nodeSql = `
        WITH RECURSIVE
        sub(rowid) AS (
          SELECT ?
          UNION
          SELECT ${joinCol}
          FROM edge e JOIN sub s ON ${srcCol} = s.rowid
          WHERE e.t_invalid IS NULL ${relFilter}
        )
        SELECT DISTINCT n.* FROM node n JOIN sub s ON n.rowid = s.rowid
      `;
      params = [rootId];
    }

    const nodeRows = this.db
      .prepare<unknown[], DbNodeRow>(nodeSql)
      .all(...params);
    const nodes = nodeRows.map(rowToNodeRecord);

    if (nodes.length === 0) {
      return { nodes: [], edges: [] };
    }

    const nodeIds = nodes.map((n: NodeRecord) => n.id);
    const edgeRows = this.db
      .prepare<unknown[], DbEdgeRow>(
        `SELECT * FROM edge
         WHERE src IN (${nodeIds.map(() => '?').join(',')})
           AND dst IN (${nodeIds.map(() => '?').join(',')})
           AND t_invalid IS NULL`,
      )
      .all(...nodeIds, ...nodeIds);

    const edges = edgeRows.map(rowToEdgeRecord);

    return { nodes, edges };
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createGraphBackend(db: Database.Database): GraphBackend {
  return new SqliteGraphBackend(db);
}
