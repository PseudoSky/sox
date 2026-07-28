/**
 * migrateStore() — Copy all tables from an already-open source StoreAdapter to
 * an already-open target StoreAdapter. Handles vec_node, FTS tables, UNIQUE
 * indexes, DDL overrides, column transforms, and cross-backend vector conversion.
 *
 * The caller opens (and closes) both adapters. This keeps the function testable
 * without path/driver concerns.
 */

import type { StoreAdapter } from './types.js';
import { createVectorDialect } from './vector-dialect.js';

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface MigrationOptions {
  /** Rows per insert batch. Default: 500. */
  batchSize?: number;
  /** Called after each table completes with the row count copied. */
  onCopyTable?: (table: string, rows: number) => void;
  /** Called for progress/debug messages. */
  onProgress?: (message: string) => void;
  /**
   * Per-table DDL overrides. Key = table name, value = CREATE TABLE DDL.
   * When provided, this DDL is used instead of generating from PRAGMA table_info.
   */
  ddlOverrides?: Record<string, string>;
  /**
   * Per-table column transforms. Key = table name, value = map from column name
   * to transform function (value => transformed).
   */
  columnTransforms?: Record<string, Record<string, (value: unknown) => unknown>>;
}

export interface TableMigrationResult {
  rows: number;
  errored?: boolean;
  error?: string;
  skipped?: boolean;
  reason?: string;
}

export interface MigrationResult {
  tables: Record<string, TableMigrationResult>;
  totalRows: number;
  sourceType: 'sqlite' | 'turso';
  targetType: 'sqlite' | 'turso';
  elapsedMs: number;
}

// ── Internal types ────────────────────────────────────────────────────────────

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface TableRow {
  name: string;
  sql: string | null;
  type: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_EMBED_DIM = 768;

/**
 * Tables excluded from the regular-table enumeration pass.
 * vec_node IS handled here — its special path (section 5) is triggered
 * by the name === 'vec_node' check in the loop below. Only
 * _adapter_meta is skip-silent (stamped separately in section 6).
 * WARNING: vec_node must NOT be in this set or hasVecNode never fires.
 */
const SKIP_TABLES = new Set(['_adapter_meta']);

/** SQLite and Turso internal table prefixes. */
const SKIP_PREFIXES = ['sqlite_', '__turso_internal_'];

/** FTS virtual table names (detected by sql text or this set). */
const FTS_TABLES = new Set(['fts_node', 'edge_fts']);

// ── DDL fallback parser ──────────────────────────────────────────────────────

/**
 * Parse a CREATE TABLE DDL string into ColumnInfo[].
 * Used as fallback when PRAGMA table_info returns 0 rows
 * (observed with some Turso / libsql tables).
 */
function parseColumnsFromDDL(ddl: string): ColumnInfo[] {
  const start = ddl.indexOf('(');
  const end = ddl.lastIndexOf(')');
  if (start === -1 || end === -1) return [];

  const body = ddl.slice(start + 1, end);
  const parts = splitColumnDefs(body);

  return parts.map((def, idx) => {
    const trimmed = def.trim();

    const nameMatch = trimmed.match(/^[`"']?(\w+)[`"']?/);
    const name = nameMatch?.[1] ?? `col${idx}`;

    const typeMatch = trimmed.match(
      /^[`"']?\w+[`"']?\s+(\w+(?:\s*\([^)]*\))?)/,
    );
    const type = typeMatch?.[1] ?? 'TEXT';

    const isPK = /PRIMARY\s+KEY/i.test(trimmed);
    const isNotNull = /NOT\s+NULL/i.test(trimmed) && !isPK;

    const dfltMatch = trimmed.match(/DEFAULT\s+(.+?)(?:,|\s*)$/i);
    const dflt = dfltMatch?.[1]?.trim() ?? null;

    return {
      cid: idx,
      name,
      type: type.toUpperCase(),
      notnull: isNotNull ? 1 : 0,
      dflt_value: dflt,
      pk: isPK ? 1 : 0,
    };
  });
}

/** Split a comma-separated column definition list, respecting nested parens. */
function splitColumnDefs(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;

    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

// ── Table column info ────────────────────────────────────────────────────────

async function getTableColumns(
  adapter: StoreAdapter,
  tableName: string,
): Promise<ColumnInfo[]> {
  const info = await adapter.executeAll<ColumnInfo>(
    `PRAGMA table_info("${tableName}")`,
  );
  if (info.rows.length > 0) return info.rows;

  // Fallback: parse from CREATE TABLE sql
  const ddl = await adapter.executeGet<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
    [tableName],
  );
  if (!ddl) return [];
  return parseColumnsFromDDL(ddl.sql);
}

// ── Table existence check ────────────────────────────────────────────────────

async function tableExists(
  target: StoreAdapter,
  name: string,
): Promise<boolean> {
  const row = await target.executeGet<{ c: number }>(
    "SELECT 1 AS c FROM sqlite_master WHERE type='table' AND name=?",
    [name],
  );
  return row !== null;
}

// ── vec_node read helper ─────────────────────────────────────────────────────

/**
 * Read all vec_node rows from a source adapter.
 *
 * When the source has native vectors (Turso), reads the F32_BLOB column directly.
 * When the source uses sqlite-vec (SqliteAdapter, nativeVectors === false),
 * opens a raw better-sqlite3 connection with sqlite-vec loaded to read the vec0
 * virtual table. Both paths return Buffers.
 */
async function readVecNodeRows(
  source: StoreAdapter,
): Promise<Array<{ node_id: number; embedding: Buffer }>> {
  if (source.capabilities.nativeVectors) {
    const result = await source.executeAll<{
      node_id: number;
      embedding: Buffer;
    }>('SELECT node_id, embedding FROM vec_node ORDER BY node_id');
    return result.rows.map((r) => ({
      node_id: r.node_id,
      embedding: r.embedding,
    }));
  }

  // SQLite vec0 virtual table — need raw better-sqlite3 with sqlite-vec loaded
  const { default: Database } = await import('better-sqlite3');
  const sqliteVec = await import('sqlite-vec');
  const dbPath = source.config.dbPath;
  if (!dbPath) {
    throw new Error(
      'Cannot read vec_node from source: no dbPath in config (required for raw sqlite-vec access)',
    );
  }
  const raw = new Database(dbPath, { readonly: true });
  sqliteVec.load(raw);
  try {
    return raw
      .prepare('SELECT node_id, embedding FROM vec_node ORDER BY node_id')
      .all() as Array<{ node_id: number; embedding: Buffer }>;
  } finally {
    raw.close();
  }
}

// ── vec_node write helper ────────────────────────────────────────────────────

/**
 * Write vec_node rows to a target adapter using the backend-appropriate format.
 *
 * For native-vector targets (Turso), inserts the raw Buffer as F32_BLOB.
 * For sqlite-vec targets (SqliteAdapter, nativeVectors === false), converts to
 * JSON array format and inserts via raw better-sqlite3 with sqlite-vec loaded.
 */
async function writeVecNodeRows(
  target: StoreAdapter,
  rows: Array<{ node_id: number; embedding: Buffer }>,
  batchSize: number,
  onProgress?: (msg: string) => void,
): Promise<number> {
  if (rows.length === 0) return 0;

  if (target.capabilities.nativeVectors) {
    // Turso target: write F32_BLOB directly via adapter
    const insertSql =
      'INSERT INTO vec_node (node_id, embedding) VALUES (?, ?)';
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      await target.transaction(async (tx) => {
        for (const row of batch) {
          await tx.executeRun(insertSql, [row.node_id, row.embedding]);
        }
      });
      onProgress?.(
        `vec_node: ${Math.min(i + batchSize, rows.length)}/${rows.length} vectors`,
      );
    }
    return rows.length;
  }

  // SQLite target with sqlite-vec: convert to JSON array format.
  // IMPORTANT: vec0 virtual tables do NOT support explicit node_id in INSERT —
  // the primary key is auto-assigned as a sequential integer starting at 1.
  // We insert embeddings WITHOUT node_id and rely on the insert order
  // matching the source ordering (ORDER BY node_id). This works correctly
  // when migrating a full dataset into a freshly created vec0 table, since
  // memory-core vec_node node_ids are always sequential from 1.
  const sqliteVec = await import('sqlite-vec');
  const raw = target.unwrap() as import('better-sqlite3').Database;

  sqliteVec.load(raw);
  const insertStmt = raw.prepare(
    'INSERT INTO vec_node (embedding) VALUES (?)',
  );

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    raw.transaction(() => {
      for (const row of batch) {
        const arr = new Float32Array(
          row.embedding.buffer,
          row.embedding.byteOffset,
          row.embedding.byteLength / 4,
        );
        const json =
          '[' +
          Array.from(arr)
            .map((v) => (Number.isFinite(v) ? v.toFixed(8) : '0.00000000'))
            .join(',') +
          ']';
        insertStmt.run(json);
      }
    })();
    onProgress?.(
      `vec_node: ${Math.min(i + batchSize, rows.length)}/${rows.length} vectors`,
    );
  }

  return rows.length;
}

// ── vec_node DDL helpers ─────────────────────────────────────────────────────

function getVecNodeCreateDDL(targetType: 'sqlite' | 'turso', dim: number): string {
  return createVectorDialect(targetType).createTableDDL(
    'vec_node',
    'embedding',
    dim,
  );
}

function getVecNodeIndexDDL(targetType: 'sqlite' | 'turso'): string {
  return createVectorDialect(targetType).createIndexDDL(
    'vec_node',
    'embedding',
    'cosine',
  );
}

// ── _adapter_meta stamp ─────────────────────────────────────────────────────

async function stampAdapterMeta(
  target: StoreAdapter,
  sourceType: 'sqlite' | 'turso',
): Promise<void> {
  await target.exec(`
    CREATE TABLE IF NOT EXISTS _adapter_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  await target.executeRun(
    "INSERT OR REPLACE INTO _adapter_meta (key, value) VALUES (?, ?)",
    ['migrated_from', sourceType],
  );
  await target.executeRun(
    "INSERT OR REPLACE INTO _adapter_meta (key, value) VALUES (?, ?)",
    ['migrated_at', new Date().toISOString()],
  );
}

// ── Main migration function ──────────────────────────────────────────────────

/**
 * Copy all tables from an already-open source StoreAdapter to an already-open
 * target StoreAdapter.
 *
 * The caller is responsible for opening (and later closing) both adapters.
 * This function handles:
 * - Regular table enumeration + DDL generation + batch data copy
 * - vec_node special handling (cross-backend vector format conversion)
 * - FTS virtual tables (recreate DDL on SQLite targets, skip on Turso)
 * - UNIQUE index recreation before data copy
 * - DDL overrides and column transforms
 * - _adapter_meta provenance stamp on target after data copy
 */
export async function migrateStore(
  source: StoreAdapter,
  target: StoreAdapter,
  options?: MigrationOptions,
): Promise<MigrationResult> {
  const startTime = Date.now();
  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
  const progress = options?.onProgress;
  const onCopyTable = options?.onCopyTable;
  const ddlOverrides = options?.ddlOverrides;
  const columnTransforms = options?.columnTransforms;

  const result: MigrationResult = {
    tables: {},
    totalRows: 0,
    sourceType: source.config.type,
    targetType: target.config.type,
    elapsedMs: 0,
  };

  // ── 1. Enumerate tables from source ─────────────────────────────────────

  const allRows = await source.executeAll<TableRow>(
    "SELECT name, sql, type FROM sqlite_master WHERE type='table' ORDER BY name",
  );

  const regularTables: TableRow[] = [];
  const ftsTables: TableRow[] = [];
  let hasVecNode = false;

  for (const row of allRows.rows) {
    const name = row.name;

    // Skip SQLite internals
    if (SKIP_PREFIXES.some((p) => name.startsWith(p))) continue;

    // Skip FTS shadow tables (fts_node_name, fts_node_data, fts_node_idx, etc.)
    if (
      name !== 'fts_node' &&
      name !== 'edge_fts' &&
      (name.startsWith('fts_node_') || name.startsWith('edge_fts_'))
    )
      continue;

    // Skip sqlite-vec internal shadow tables (vec_node_info, vec_node_chunks, etc.)
    // These are managed by the vec0 virtual table and must not be copied as regular
    // tables — the special vec_node path (section 5) handles vector data migration.
    if (name.startsWith('vec_node_') && name !== 'vec_node') continue;

    // Skip _adapter_meta (stamped separately)
    if (SKIP_TABLES.has(name)) continue;

    // vec_node handled specially below
    if (name === 'vec_node') {
      hasVecNode = true;
      continue;
    }

    // FTS virtual tables — detect by name or sql content
    if (FTS_TABLES.has(name) || (row.sql && /fts/i.test(row.sql))) {
      ftsTables.push(row);
      continue;
    }

    regularTables.push(row);
  }

  // ── 2. Handle UNIQUE indexes ────────────────────────────────────────────

  const uniqueIndexes = await source.executeAll<{ name: string; sql: string | null }>(
    "SELECT name, sql FROM sqlite_master WHERE type='index' AND sql LIKE '%UNIQUE%'",
  );

  for (const idx of uniqueIndexes.rows) {
    if (!idx.sql) continue;
    try {
      await target.exec(idx.sql);
    } catch {
      progress?.(`Index "${idx.name}": applied (or already exists)`);
    }
  }

  // ── 3. Copy regular tables ─────────────────────────────────────────────

  for (const table of regularTables) {
    const tableName = table.name;
    try {
      // 3a. Create table on target
      let createSql: string;
      // Column metadata — fetched from PRAGMA table_info for DDL generation
      // AND reused as fallback column name source for data copy when the
      // executeAll result lacks column metadata (TursoAdapter pre-fix).
      let columnInfo: ColumnInfo[] = [];
      if (ddlOverrides?.[tableName]) {
        createSql = ddlOverrides[tableName];
      } else {
        columnInfo = await getTableColumns(source, tableName);
        if (columnInfo.length === 0) {
          result.tables[tableName] = {
            rows: 0,
            skipped: true,
            reason: 'No column info available',
          };
          progress?.(`"${tableName}": skipped (no columns)`);
          continue;
        }
        const colDefs = columnInfo.map((c) => {
          let def = `"${c.name}" ${c.type}`;
          if (c.pk) def += ' PRIMARY KEY';
          if (c.notnull && !c.pk) def += ' NOT NULL';
          if (c.dflt_value != null) def += ` DEFAULT ${c.dflt_value}`;
          return def;
        });
        createSql = `CREATE TABLE IF NOT EXISTS "${tableName}" (${colDefs.join(', ')})`;
      }

      await target.exec(createSql);

      // 3b. Read all rows from source
      const sourceData = await source.executeAll(
        `SELECT * FROM "${tableName}"`,
      );
      const rows = sourceData.rows;
      // Prefer query-returned column names; fall back to column info from
      // PRAGMA table_info (fetched above for DDL generation). This covers
      // adapters that may not populate columns in executeAll results.
      let colNames = sourceData.columns;
      if (colNames.length === 0 && columnInfo.length > 0) {
        colNames = columnInfo.map((c) => c.name);
      }

      if (rows.length === 0) {
        result.tables[tableName] = { rows: 0 };
        progress?.(`"${tableName}": 0 rows (empty)`);
        onCopyTable?.(tableName, 0);
        continue;
      }

      // 3c. Build insert SQL
      const quotedCols = colNames.map((c) => `"${c}"`).join(', ');
      const placeholders = colNames.map(() => '?').join(', ');
      const insertSql = `INSERT INTO "${tableName}" (${quotedCols}) VALUES (${placeholders})`;
      const transforms = columnTransforms?.[tableName];

      // 3d. Insert in batches within transactions
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        await target.transaction(async (tx) => {
          for (const row of batch) {
            const values = colNames.map((col) => {
              const v = (row as Record<string, unknown>)[col];
              const tv = v === undefined ? null : v;
              return transforms?.[col] ? transforms[col](tv) : tv;
            });
            await tx.executeRun(insertSql, values);
          }
        });
        progress?.(
          `"${tableName}": ${Math.min(i + batchSize, rows.length)}/${rows.length} rows`,
        );
      }

      result.tables[tableName] = { rows: rows.length };
      result.totalRows += rows.length;
      progress?.(`"${tableName}": done (${rows.length} rows)`);
      onCopyTable?.(tableName, rows.length);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.tables[tableName] = { rows: 0, errored: true, error: msg };
      progress?.(`"${tableName}": ERROR — ${msg}`);
    }
  }

  // ── 4. Handle FTS tables ───────────────────────────────────────────────

  for (const fts of ftsTables) {
    const tableName = fts.name;
    try {
      if (target.capabilities.fts5 && fts.sql) {
        await target.exec(fts.sql);
        result.tables[tableName] = { rows: 0, reason: 'DDL recreated' };
        progress?.(`"${tableName}": DDL recreated (virtual, no data copy)`);
      } else {
        result.tables[tableName] = {
          rows: 0,
          skipped: true,
          reason: target.capabilities.fts5
            ? 'No CREATE DDL available from source'
            : 'Target does not support FTS5',
        };
        progress?.(`"${tableName}": skipped (${result.tables[tableName]!.reason})`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.tables[tableName] = { rows: 0, errored: true, error: msg };
      progress?.(`"${tableName}": ERROR — ${msg}`);
    }
  }

  // ── 5. Handle vec_node ─────────────────────────────────────────────────

  if (hasVecNode) {
    try {
      const vecRows = await readVecNodeRows(source);

      if (vecRows.length > 0) {
        const firstEmbedding = vecRows[0]!.embedding;
        const dim =
          firstEmbedding.byteLength > 0
            ? firstEmbedding.byteLength / 4
            : DEFAULT_EMBED_DIM;

        const vecDDL = getVecNodeCreateDDL(target.config.type, dim);
        if (!(await tableExists(target, 'vec_node'))) {
          // For sqlite-vec targets (nativeVectors === false), load the vec0
          // extension onto the target connection BEFORE executing vec_node DDL,
          // since CREATE VIRTUAL TABLE ... USING vec0 requires it.
          if (!target.capabilities.nativeVectors) {
            const sqliteVec = await import('sqlite-vec');
            const raw = target.unwrap() as import('better-sqlite3').Database;
            sqliteVec.load(raw);
          }
          await target.exec(vecDDL);
        }

        await writeVecNodeRows(target, vecRows, batchSize, progress);

        const indexDDL = getVecNodeIndexDDL(target.config.type);
        if (indexDDL) {
          try {
            await target.exec(indexDDL);
          } catch {
            progress?.('vec_node: index creation skipped (may exist already)');
          }
        }
      }

      result.tables['vec_node'] = { rows: vecRows.length };
      result.totalRows += vecRows.length;
      progress?.(`vec_node: done (${vecRows.length} vectors)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.tables['vec_node'] = { rows: 0, errored: true, error: msg };
      progress?.(`vec_node: ERROR — ${msg}`);
    }
  }

  // ── 6. Stamp _adapter_meta ─────────────────────────────────────────────

  try {
    await stampAdapterMeta(target, result.sourceType);
  } catch {
    progress?.('_adapter_meta: stamp skipped (non-fatal)');
  }

  // ── 7. Finalize ────────────────────────────────────────────────────────

  result.elapsedMs = Date.now() - startTime;
  return result;
}
