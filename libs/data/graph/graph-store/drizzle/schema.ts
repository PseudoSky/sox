/**
 * Drizzle ORM schema for the graph-store.
 *
 * NOTE: This schema is used for migration management ONLY — all runtime queries
 * use raw SQL via better-sqlite3. Drizzle's query builder is NOT used.
 *
 * Generated migration SQL is committed alongside this file.
 * See ADR-0008 for the full rationale.
 */
import { sqliteTable, text, integer, real, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ─── Node table ─────────────────────────────────────────────────────────────────

export const node = sqliteTable(
  'node',
  {
    rowid: integer('rowid').primaryKey(),
    uid: text('uid').unique().notNull(),
    kind: text('kind').notNull(),
    content: text('content'),
    name: text('name'),
    summary: text('summary'),
    topic: text('topic'),
    tags: text('tags'),
    importance: real('importance').default(1.0),
    confidence: real('confidence'),
    contentHash: text('content_hash'),
    namespace: text('namespace').default('global'),
    meta: text('meta'),
    agentId: text('agent_id'),
    sessionId: text('session_id'),
    source: text('source'),
    projectPath: text('project_path'),
    level: integer('level'),
    resumeState: text('resume_state'),
    tOccurred: text('t_occurred'),
    tExpires: text('t_expires'),
    tCreated: text('t_created').notNull(),
    tValid: text('t_valid'),
    tInvalid: text('t_invalid'),
    isSuperseded: integer('is_superseded').default(0),
    accessCount: integer('access_count').default(0),
    lastAccess: text('last_access'),
    tUpdated: text('t_updated'),
  },
  (table) => ({
    // CHECK constraints are applied via generated migration SQL (Drizzle can't
    // express them natively for SQLite).
    ixNodeKind: index('ix_node_kind').on(table.kind),
    ixNodeHash: index('ix_node_hash').on(table.contentHash),
    ixNodeAgent: index('ix_node_agent').on(table.agentId),
    ixNodeSession: index('ix_node_session').on(table.sessionId),
    ixNodeValidity: index('ix_node_validity').on(table.tInvalid).where(sql`${table.tInvalid} IS NULL`),
    ixNodeImportance: index('ix_node_importance').on(table.importance),
    ixNodeTemporal: index('ix_node_temporal').on(table.tInvalid, table.tCreated).where(sql`${table.tInvalid} IS NULL`),
    ixNodeTopic: index('ix_node_topic').on(table.topic).where(sql`${table.topic} IS NOT NULL`),
    ixNodeProject: index('ix_node_project').on(table.projectPath).where(sql`${table.projectPath} IS NOT NULL`),
    ixNodeNamespace: index('ix_node_namespace').on(table.namespace),
    ixNodeExpires: index('ix_node_expires').on(table.tExpires).where(sql`${table.tExpires} IS NOT NULL`),
  }),
);

// ─── Edge table ─────────────────────────────────────────────────────────────────

export const edge = sqliteTable(
  'edge',
  {
    rowid: integer('rowid').primaryKey(),
    src: integer('src').notNull().references(() => node.rowid, { onDelete: 'cascade' }),
    dst: integer('dst').notNull().references(() => node.rowid, { onDelete: 'cascade' }),
    rel: text('rel').notNull(),
    weight: real('weight').default(1.0),
    confidence: real('confidence'),
    origin: text('origin'),
    meta: text('meta'),
    tCreated: text('t_created').notNull(),
    tExpired: text('t_expired'),
    tValid: text('t_valid'),
    tInvalid: text('t_invalid'),
  },
  (table) => ({
    ixEdgeSrc: index('ix_edge_src').on(table.src, table.rel).where(sql`${table.tExpired} IS NULL`),
    ixEdgeDst: index('ix_edge_dst').on(table.dst, table.rel).where(sql`${table.tExpired} IS NULL`),
    ixEdgeLive: index('ix_edge_live').on(table.tInvalid).where(sql`${table.tInvalid} IS NULL`),
    ixEdgeUnique: uniqueIndex('ix_edge_unique').on(table.src, table.dst, table.rel),
  }),
);
