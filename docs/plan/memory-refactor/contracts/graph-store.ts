/**
 * graph-store.ts — public contract for @adhd/sox-graph-store.
 *
 * Package path: libs/data/graph/graph-store/
 * Execution context: w2b-graph-store
 * Published: public@0.x (ADR-0006, promoted for external demand SYS-1/2/5)
 *
 * Key invariants this contract encodes:
 *   [def:connection-seam]  — every function takes an injected Database; NO `new Database()`
 *                            here, NO sqlite-vec load (vector-store's concern).
 *   data/vectors ↛ data/graph — this package does NOT import @adhd/sox-vector-store.
 *                            Confirmed by [w2b.5] acceptance check.
 *   Records are never deleted — invalidation sets t_invalid; DELETE is never issued.
 *   BL-27 migration — organizer_queue CHECK constraint rebuild travels with applyGraphSchema.
 *
 * Resolves demo stubs: U1, U2, U3, U5, U6, U7, U8 (U4 was never written in UNRESOLVED.md).
 * See CONTRACTS.md §Stub-resolution table.
 *
 * Schema note: the ASSIGNED_TO edge rel is used by the MCP surface (memory_link) but is
 * absent from the current schema.ts DDL CHECK constraint. The graph-store extraction MUST
 * add ASSIGNED_TO to the EdgeRel enum and to the DDL CHECK to prevent a constraint error
 * on memory_link calls. Flagged in CONTRACTS.md §Escalations.
 */

import type { InjectedDb } from './types.js';

// ── Enumerations ───────────────────────────────────────────────────────────────

/**
 * All relationship types supported by the edge table.
 * Grounded in schema.ts line 58-59 plus ASSIGNED_TO from the MCP surface.
 *
 * Implementation note: ASSIGNED_TO is not in the current DDL CHECK constraint but IS
 * in the memory_link MCP tool's enum. applyGraphSchema MUST include it in the DDL
 * to satisfy [inv:tool-contract-stable]. See CONTRACTS.md §Escalations.
 */
export type EdgeRel =
  | 'MENTIONS'
  | 'SUPPORTS'
  | 'RELATES_TO'
  | 'SUPERSEDES'
  | 'DERIVED_FROM'
  | 'MEMBER_OF'
  | 'PART_OF'
  | 'SAME_AS'
  | 'ASSIGNED_TO';

/** Kind values for the node.kind column. */
export type NodeKind = 'episode' | 'entity' | 'claim' | 'community' | 'session';

/** Source values for node.source. */
export type NodeSource =
  | 'message'
  | 'tool_output'
  | 'observation'
  | 'document'
  | 'reflection'
  | 'import';

// ── Node I/O types ─────────────────────────────────────────────────────────────

/**
 * Input to insertNode.
 * content is required; all other fields are optional.
 *
 * Resolves U1 — insertNode input shape.
 */
export interface NodeInput {
  content: string;
  /** Default: 'episode'. */
  kind?: NodeKind;
  name?: string;
  summary?: string;
  topic?: string;
  /** JSON-serialisable tags array. */
  tags?: string[];
  source?: NodeSource;
  /** Default: 1.0. */
  importance?: number;
  agent_id?: string;
  session_id?: string;
  /** Caller-supplied metadata; persisted as JSON in node.meta. */
  meta?: Record<string, unknown>;
  t_occurred?: string;
  t_valid?: string;
  /** Project root path (enrichment column; null until enriched). */
  project_path?: string;
}

/**
 * Fully-migrated node row returned by query functions.
 * Represents the post-migration shape (base schema + migrateAddColumn columns).
 * JSON fields (tags, meta, enrich_ver) are raw strings — parse with JSON.parse.
 *
 * Grounded in NodeV1 from libs/memory-enrich/src/types.ts.
 */
export interface NodeRow {
  rowid: number;
  uid: string;
  kind: NodeKind;
  name: string | null;
  content: string | null;
  summary: string | null;
  content_hash: string | null;
  importance: number;
  access_count: number;
  agent_id: string | null;
  session_id: string | null;
  source: string | null;
  t_created: string;
  t_occurred: string | null;
  t_valid: string | null;
  t_invalid: string | null;
  last_access: string | null;
  resume_state: string | null;
  level: number | null;
  /** JSON string[]; parse with JSON.parse. Null for pre-enrichment rows. */
  tags: string | null;
  topic: string | null;
  project_path: string | null;
  /** JSON Record<string, unknown>; parse with JSON.parse. */
  meta: string | null;
  /** JSON EnrichmentProvenance; parse with JSON.parse. Null for pre-enrichment rows. */
  enrich_ver: string | null;
}

/**
 * Result of insertNode: newly-created or pre-existing (content-hash dedup) row.
 *
 * Resolves U1 — return type including existed flag and uid generation.
 */
export interface InsertNodeResult {
  uid: string;
  /** SHA-256 hex of the content (content_hash column). */
  contentHash: string;
  /**
   * True when a live node with the same contentHash already existed.
   * In that case, no INSERT was issued and the returned uid is the existing node's uid.
   * [inv:space] / R5: dedup is a no-op, never a delete.
   */
  existed: boolean;
  rowid: number;
}

// ── Edge I/O types ─────────────────────────────────────────────────────────────

/**
 * Input to addEdge.
 *
 * Resolves U3 — addEdge input shape.
 */
export interface EdgeInput {
  /** UID of the source node. Must exist in the node table. */
  srcUid: string;
  /** UID of the destination node. Must exist in the node table. */
  dstUid: string;
  rel: EdgeRel;
  /** Edge weight. Default 1.0. */
  weight?: number;
  /** Optional metadata; persisted as JSON in edge.meta. */
  meta?: Record<string, unknown>;
}

// ── Query option types ─────────────────────────────────────────────────────────

/**
 * Options for getNeighbors.
 *
 * Resolves U5 — option shape and direction semantics.
 */
export interface GetNeighborsOpts {
  /** Filter by one or more edge types. Omit to include all rel types. */
  rel?: EdgeRel | EdgeRel[];
  /** 'out' = edges where src=uid, 'in' = edges where dst=uid, 'both' = either. Default: 'both'. */
  direction?: 'out' | 'in' | 'both';
  /** When true, include edges with t_invalid IS NOT NULL. Default: false (live edges only). */
  includingInvalidated?: boolean;
}

/**
 * Options for queryAt (point-in-time snapshot).
 *
 * Resolves U6 — option shape; includingInvalidated default confirmed as false.
 */
export interface QueryAtOpts {
  /**
   * ISO timestamp for point-in-time query.
   * Returns nodes where t_valid <= asOf OR t_valid IS NULL, AND
   *   (t_invalid > asOf OR t_invalid IS NULL) [unless includingInvalidated].
   * Default: now.
   */
  asOf?: string;
  /** When false (default), filter out nodes with t_invalid IS NOT NULL. */
  includingInvalidated?: boolean;
  /** Filter by topic. */
  topic?: string;
  /** Filter by node kind. */
  kind?: NodeKind;
  /** Maximum number of rows. Default: no limit. */
  limit?: number;
}

// ── FTS result ─────────────────────────────────────────────────────────────────

/**
 * A single FTS5 search result row.
 *
 * Resolves U7 — return shape and rank sign convention.
 */
export interface FtsResult {
  uid: string;
  name: string | null;
  /**
   * BM25 rank from FTS5. Follows the FTS5 convention: negative numbers where
   * MORE NEGATIVE = better match. Callers should sort ascending (most-negative first)
   * to get results ranked best-first.
   *
   * Example: rank -5.2 is a better match than rank -1.1.
   */
  rank: number;
}

// ── Supersession chain ─────────────────────────────────────────────────────────

/**
 * A single entry in a supersession chain.
 *
 * Resolves U8 — chain shape; ordering; supersedes/supersededBy field names.
 */
export interface SupersessionEntry {
  uid: string;
  name: string | null;
  content: string | null;
  t_created: string;
  t_invalid: string | null;
  /**
   * UID of the node this entry explicitly supersedes (the older record in the chain).
   * Corresponds to the dst of a SUPERSEDES edge where this entry is the src.
   * Absent for the oldest node in the chain.
   */
  supersedes?: string;
  /**
   * UID of the node that supersedes this entry (the newer record in the chain).
   * Corresponds to the src of a SUPERSEDES edge where this entry is the dst.
   * Absent for the most-recent node in the chain.
   */
  supersededBy?: string;
}

// ── Schema constants ───────────────────────────────────────────────────────────

/**
 * SQLite pragmas exported for the composer to apply before applyGraphSchema.
 * Grounded in schema.ts PRAGMAS: WAL, busy_timeout=5000, synchronous=NORMAL,
 * foreign_keys=ON, cache_size=-64000.
 *
 * The composer applies these immediately after `new Database(path)`:
 *   db.exec(PRAGMAS);
 *   applyGraphSchema(db);
 *   applyVecSchema(db, { dim, modelId });
 */
export declare const PRAGMAS: string;

// ── Schema DDL ─────────────────────────────────────────────────────────────────

/**
 * Apply the full graph DDL to an injected Database. Idempotent (IF NOT EXISTS everywhere).
 *
 * Creates: node, edge (with all indices), fts_node, organizer_queue, promotion_queue.
 * Applies: FTS_TRIGGERS (insert/update/delete sync).
 * Runs: all idempotent migrateAddColumn calls (topic, project_path, tags, enrich_ver,
 *       meta, etc.) and the BL-27 organizer_queue CHECK-constraint rebuild.
 *
 * Does NOT: open the database, load sqlite-vec, or apply pragmas.
 * Those are the composer's responsibility ([def:connection-seam]).
 *
 * The vec_node virtual table is NOT created here — that is vector-store's scope (w2c).
 * [w2b.5]: no vec_node DDL and no @adhd/sox-vector-store import may appear in this package.
 *
 * @param db Better-sqlite3 Database, already open and pragmatized by the composer.
 */
export declare function applyGraphSchema(db: InjectedDb): void;

// ── Node helpers ───────────────────────────────────────────────────────────────

/**
 * Insert a node with content-hash deduplication.
 *
 * If a live node with the same SHA-256 content hash already exists (R5), returns
 * that node's uid with existed:true — no INSERT is issued.
 *
 * UID generation: ULID (monotonicFactory from the 'ulid' package), millisecond-
 * precision, lexicographically sortable, globally unique across stores.
 * Grounded in write.ts:24 `import { monotonicFactory } from 'ulid'`.
 *
 * FTS5 sync: insertNode triggers fts_node_ai (INSERT trigger) automatically.
 *
 * Resolves U1 — signature, return type, existed semantics, UID scheme.
 *
 * @param db    Injected Database.
 * @param input Node fields. content is required; all others are optional.
 */
export declare function insertNode(db: InjectedDb, input: NodeInput): InsertNodeResult;

/**
 * Soft-delete: set t_invalid to now in ISO format. Never issues DELETE.
 *
 * After invalidation, queryAt with includingInvalidated:false (default) will not
 * return this node. The row remains permanently in the database for audit purposes.
 *
 * FTS5 sync: invalidateNode triggers fts_node_ad (DELETE trigger) automatically.
 *
 * Resolves U2 — sets t_invalid; never DELETE; preserves the row.
 *
 * @param db  Injected Database.
 * @param uid UID of the node to invalidate.
 */
export declare function invalidateNode(db: InjectedDb, uid: string): void;

// ── Edge helpers ───────────────────────────────────────────────────────────────

/**
 * Insert a directed edge between two existing nodes.
 *
 * @throws {Error} if srcUid or dstUid does not exist in the node table.
 *
 * Resolves U3 — signature, rel enum (EdgeRel union), weight and meta fields.
 *
 * @param db    Injected Database.
 * @param input Edge fields. srcUid, dstUid, and rel are required.
 */
export declare function addEdge(db: InjectedDb, input: EdgeInput): void;

// ── Query helpers ──────────────────────────────────────────────────────────────

/**
 * Return nodes reachable from uid via live edges, optionally filtered.
 *
 * Resolves U5 — signature, opts shape, direction semantics.
 *
 * @param db   Injected Database.
 * @param uid  Anchor node UID.
 * @param opts Filter options.
 */
export declare function getNeighbors(
  db: InjectedDb,
  uid: string,
  opts?: GetNeighborsOpts,
): NodeRow[];

/**
 * Point-in-time snapshot query.
 * Returns all nodes valid at asOf (default: now), filtered by the given opts.
 * No rows are ever hard-deleted, so this accurately reflects historical state.
 *
 * Resolves U6 — signature, asOf, includingInvalidated default (false).
 *
 * @param db   Injected Database.
 * @param opts Query options.
 */
export declare function queryAt(db: InjectedDb, opts?: QueryAtOpts): NodeRow[];

/**
 * Full-text search over node content, name, and summary via FTS5 BM25.
 *
 * Uses the fts_node virtual table kept in lockstep with node by FTS_TRIGGERS.
 * Results are ordered by BM25 rank ascending (most-negative = best match first).
 *
 * Resolves U7 — signature, return shape, rank sign convention confirmed.
 *
 * @param db    Injected Database.
 * @param query FTS5 query string (supports operators: AND, OR, NOT, phrase, prefix*).
 * @param opts  Optional limit. Default: 20.
 */
export declare function ftsSearch(
  db: InjectedDb,
  query: string,
  opts?: { limit?: number },
): FtsResult[];

/**
 * Follow the SUPERSEDES edge chain anchored at uid.
 *
 * Returns all nodes in the chain ordered OLDEST-FIRST. The anchor node may be at
 * any position in the chain; the function walks in both directions.
 *
 * Fields supersedes/supersededBy on each entry form a doubly-linked list over the chain.
 *
 * Resolves U8 — signature, ordering (oldest-first), field names (supersedes/supersededBy).
 *
 * @param db  Injected Database.
 * @param uid UID of any node in the chain.
 */
export declare function supersessionChain(db: InjectedDb, uid: string): SupersessionEntry[];
