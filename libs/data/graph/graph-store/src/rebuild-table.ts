/**
 * General-purpose SQLite table rebuild helper (rename→create→copy→drop→rename dance).
 *
 * Extracted from the deleted `migrations.ts` — the custom migration runner was
 * replaced by Drizzle ORM's `migrate()` for versioned migrations, but the
 * `rebuildTable()` utility is still needed by downstream consumers (e.g.
 * memory-core) for ad-hoc CHECK constraint migrations that Drizzle can't
 * express natively for SQLite.
 *
 * @adhd/sox-graph-store — public API. See ADR-0008.
 */
import Database from 'better-sqlite3';

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
