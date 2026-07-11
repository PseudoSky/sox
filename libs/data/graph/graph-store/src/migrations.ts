/**
 * Ordered schema migration runner for graph-store.
 *
 * The base schema (v1, created by GRAPH_DDL) is applied idempotently by
 * applySchema(). This module provides versioned migrations that evolve the
 * schema non-destructively — adding columns, relaxing CHECK constraints,
 * creating indexes — for stores created by an older version of the DDL.
 *
 * Each migration runs inside its own SQLite transaction. If the migration
 * function throws, the transaction rolls back and the store's _schema_version
 * is NOT updated, leaving it at the previous known-good version.
 *
 * Migrations are ONE-WAY and MUST be additive / backward-compatible.
 * A downgrade path is NOT provided.
 */
import Database from 'better-sqlite3';

// ─── Migration interface ───────────────────────────────────────────────────────

export interface Migration {
  version: number;
  description: string;
  up(db: Database.Database): void;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Check if a column exists in a table via PRAGMA table_info. */
function columnExists(db: Database.Database, table: string, column: string): boolean {
  const cols = db
    .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
  return cols.includes(column);
}

/** Idempotently add a column if it does not already exist. */
function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  type: string,
): void {
  if (!columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

// ─── Rebuild-table helper ──────────────────────────────────────────────────────

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/**
 * Rebuild a table with a new DDL while preserving data.
 * SQLite cannot ALTER TABLE CHECK constraints, so this is the standard
 * rename→create→copy→drop→rename dance. Runs in a transaction (safe to
 * call inside an existing migration transaction — better-sqlite3 uses
 * SAVEPOINT for nested transactions).
 *
 * Automatically detects and preserves any extra columns present in the
 * old table that are not mentioned in `columnMap`. This protects against
 * column loss when downstream consumers (e.g. memory-core) add columns
 * to the canonical graph-store tables via `ALTER TABLE ADD COLUMN`.
 *
 * @param db          Database handle
 * @param tableName   Table to rebuild (e.g., 'node', 'edge', 'organizer_queue')
 * @param newDDL      Full CREATE TABLE statement with the updated constraints
 * @param columnMap   Map of old column names to new column names (for renames)
 *                    or an array of column names (if no renames)
 */
export function rebuildTable(
  db: Database.Database,
  tableName: string,
  newDDL: string,
  columnMap: string[] | Record<string, string>,
): void {
  // Snapshot the old table's column info before renaming it.
  const oldCols: ColumnInfo[] = db
    .prepare<[], ColumnInfo>(`PRAGMA table_info(${tableName})`)
    .all();

  const explicitColumns: string[] = Array.isArray(columnMap)
    ? columnMap
    : Object.keys(columnMap);

  // Detect extra columns present in the old table but not in the columnMap.
  // These are columns added by downstream consumers (e.g. memory-core's
  // enrich_ver, embed_model). They must be preserved verbatim.
  const extraColumnNames = oldCols
    .filter((c) => !explicitColumns.includes(c.name))
    .map((c) => c.name);

  // Build the column lists for the INSERT…SELECT copy.
  const allColumns: string[] = [...explicitColumns, ...extraColumnNames];

  const selectCols = Array.isArray(columnMap)
    ? allColumns.join(', ')
    : [
        ...Object.entries(columnMap).map(([old, nu]) => `${old} AS ${nu}`),
        ...extraColumnNames,
      ].join(', ');

  const oldColType = new Map(oldCols.map((c) => [c.name, c.type]));

  db.transaction(() => {
    db.exec(`ALTER TABLE ${tableName} RENAME TO ${tableName}_old`);

    // Create the new table with the core DDL.
    db.exec(newDDL);

    // Add extra columns from old table to the new table so the INSERT
    // below can write into them.
    for (const colName of extraColumnNames) {
      const colType = oldColType.get(colName) ?? 'TEXT';
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${colType}`);
    }

    // Copy all data — canonical + extra — from the old renamed table.
    db.exec(
      `INSERT INTO ${tableName} (${allColumns.join(', ')})
       SELECT ${selectCols} FROM ${tableName}_old`,
    );

    db.exec(`DROP TABLE ${tableName}_old`);
  })();
}

// ─── FTS helper ────────────────────────────────────────────────────────────────

const FTS_TRIGGER_DDL = `
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

const NODE_INDEX_DDL = [
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

const EDGE_INDEX_DDL = [
  `CREATE INDEX IF NOT EXISTS ix_edge_src        ON edge(src, rel) WHERE t_expired IS NULL`,
  `CREATE INDEX IF NOT EXISTS ix_edge_dst        ON edge(dst, rel) WHERE t_expired IS NULL`,
  `CREATE INDEX IF NOT EXISTS ix_edge_live       ON edge(t_invalid) WHERE t_invalid IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ix_edge_unique ON edge(src, dst, rel)`,
];

function recreateNodeIndexes(db: Database.Database): void {
  for (const ddl of NODE_INDEX_DDL) {
    db.exec(ddl);
  }
}

function recreateFtsTriggersAndIndex(db: Database.Database): void {
  db.exec(FTS_TRIGGER_DDL);
  // Rebuild FTS index from existing rows (content='node' external mode).
  // After a table rebuild the old FTS index is stale because triggers
  // were dropped with the old table. Re-populate.
  db.exec(
    `INSERT INTO fts_node(rowid, content, name, summary)
     SELECT rowid, content, name, summary FROM node`,
  );
}

// ─── Individual migration implementations ──────────────────────────────────────

/**
 * v2: Add missing columns from schema unification + index.
 *
 * Columns added to `node`: level, resume_state
 * Columns added to `edge`: t_expired
 * Index added: ix_edge_unique (was previously applied outside version gate)
 */
function v2Up(db: Database.Database): void {
  addColumnIfMissing(db, 'node', 'level', 'INTEGER');
  addColumnIfMissing(db, 'node', 'resume_state', 'TEXT');
  addColumnIfMissing(db, 'edge', 't_expired', 'TEXT');
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ix_edge_unique ON edge(src, dst, rel)`);
}

/**
 * v3: Relax node.kind CHECK constraint to include 'generic'.
 *
 * Old constraint: CHECK (kind IN ('episode','entity','claim','community','session'))
 * New constraint: CHECK (kind IN ('episode','entity','claim','community','session','generic'))
 *
 * This requires the rebuild-table dance because SQLite cannot ALTER a CHECK constraint.
 */
function v3Up(db: Database.Database): void {
  const row = db
    .prepare<[], { sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='node'`,
    )
    .get();
  if (!row) return;
  // If the constraint already includes 'generic', this migration is a no-op.
  if (row.sql.includes("'generic'")) return;

  const newNodeDDL = `CREATE TABLE node (
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

  const columns = [
    'rowid', 'uid', 'kind', 'content', 'name', 'summary', 'topic', 'tags',
    'importance', 'confidence', 'content_hash', 'namespace', 'meta', 'agent_id',
    'session_id', 'source', 'project_path', 'level', 'resume_state', 't_occurred',
    't_expires', 't_created', 't_valid', 't_invalid', 'is_superseded',
    'access_count', 'last_access', 't_updated',
  ];

  rebuildTable(db, 'node', newNodeDDL, columns);

  // Recreate indexes that were dropped with the old table.
  recreateNodeIndexes(db);

  // Recreate FTS triggers + rebuild FTS index.
  recreateFtsTriggersAndIndex(db);
}

/**
 * v4: Relax edge.rel CHECK constraint to include 'DEPENDS_ON'.
 *
 * Old constraint: CHECK (rel IN ('MENTIONS','SUPPORTS','RELATES_TO','SUPERSEDES',
 *   'DERIVED_FROM','MEMBER_OF','PART_OF','SAME_AS','ASSIGNED_TO'))
 * New constraint: ... + 'DEPENDS_ON'
 */
function v4Up(db: Database.Database): void {
  const row = db
    .prepare<[], { sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='edge'`,
    )
    .get();
  if (!row) return;
  // If the constraint already includes 'DEPENDS_ON', this migration is a no-op.
  if (row.sql.includes("'DEPENDS_ON'")) return;

  const newEdgeDDL = `CREATE TABLE edge (
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

  const columns = [
    'rowid', 'src', 'dst', 'rel', 'weight', 'confidence', 'origin', 'meta',
    't_created', 't_expired', 't_valid', 't_invalid',
  ];

  rebuildTable(db, 'edge', newEdgeDDL, columns);

  // Recreate indexes that were dropped with the old table.
  for (const ddl of EDGE_INDEX_DDL) {
    db.exec(ddl);
  }
}

// ─── Migration registry ────────────────────────────────────────────────────────

export const MIGRATIONS: Migration[] = [
  {
    version: 2,
    description:
      'Add level, resume_state to node; add t_expired to edge; add ix_edge_unique index',
    up: v2Up,
  },
  {
    version: 3,
    description: 'Add generic kind to node.kind CHECK constraint',
    up: v3Up,
  },
  {
    version: 4,
    description: 'Add DEPENDS_ON to edge.rel CHECK constraint',
    up: v4Up,
  },
];

/**
 * Run any pending migrations against the given database.
 *
 * This function:
 * 1. Reads the current _schema_version from the store
 * 2. Iterates MIGRATIONS[] in ascending version order
 * 3. For each migration with version > currentVersion, runs it inside a
 *    transaction, stamping _schema_version on success
 * 4. If a migration throws, the transaction rolls back and the store
 *    remains at its previous version
 *
 * Safe to call multiple times — already-applied migrations are skipped.
 * Thread-safe: SQLite serializes writes via its internal lock.
 */
export function runMigrations(db: Database.Database): void {
  // Ensure the version table exists (it may not on very old stores)
  db.exec(
    `CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER NOT NULL)`,
  );

  const currentRow = db
    .prepare<[], { version: number }>(
      `SELECT version FROM _schema_version ORDER BY version DESC LIMIT 1`,
    )
    .get();
  const currentVersion = currentRow?.version ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      const run = db.transaction(() => {
        migration.up(db);
        db.prepare(`INSERT INTO _schema_version (version) VALUES (?)`).run(
          migration.version,
        );
      });
      run();
    }
  }
}
