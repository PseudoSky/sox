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
 * BL-313: when `foreign_keys = ON` (this store always runs with it on — see
 * PRAGMAS), `ALTER TABLE x RENAME TO x_old` auto-rewrites every OTHER table's
 * FK definitions that referenced `x` to instead reference `x_old` — a real
 * SQLite behavior, not a bug on its own. The danger is `DROP TABLE x_old`:
 * SQLite treats dropping a table as deleting all its rows for the purpose of
 * `ON DELETE CASCADE` enforcement, so any table whose FK now dangles at
 * `x_old` gets ALL ITS ROWS SILENTLY CASCADE-DELETED — even a brand new,
 * unrelated, freshly-created same-named table sitting elsewhere, as long as
 * ITS OWN old incarnation (also renamed to `<name>_old`) still points at the
 * table being dropped. Reproduced live 2026-07-18: rebuilding `node` (CHECK
 * constraint upgrade) renames `node`→`node_old`; `edge`'s FK auto-rewrites to
 * `REFERENCES "node_old"(...) ON DELETE CASCADE`; dropping `node_old` at the
 * end of the node rebuild cascade-deleted all 40,930 rows of a live `edge`
 * table that hadn't even been touched yet — no exception, no warning, just a
 * silently emptied table.
 *
 * Fix: pass `{ skipDrop: true }` when rebuilding MULTIPLE tables that
 * reference each other via FK (e.g. node + edge) in the same migration pass.
 * The caller performs every table's rename→create→copy step first (all old
 * tables still present, so no FK dangles at a to-be-dropped table yet), THEN
 * drops every `<name>_old` only after all new tables are fully populated —
 * by that point any resulting cascade only empties tables already scheduled
 * for deletion. See `SqliteGraphBackend.ensureCheckConstraints()` for the
 * caller-side sequencing this fix depends on.
 *
 * @param db          Database handle
 * @param tableName   Table to rebuild (e.g., 'node', 'edge', 'organizer_queue')
 * @param newDDL      Full CREATE TABLE statement with the updated constraints
 * @param columnMap   Map of old column names to new column names (for renames)
 *                    or an array of column names (if no renames)
 * @param opts.skipDrop  Leave `<tableName>_old` in place instead of dropping it.
 *                       The caller is responsible for dropping it later, after
 *                       every FK-related table's rebuild has completed its
 *                       copy step. Defaults to false (drop immediately, the
 *                       original single-table-safe behavior).
 */
export function rebuildTable(
  db: Database.Database,
  tableName: string,
  newDDL: string,
  columnMap: string[] | Record<string, string>,
  opts?: { skipDrop?: boolean },
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

    if (!opts?.skipDrop) {
      db.exec(`DROP TABLE ${tableName}_old`);
    }
  })();
}
