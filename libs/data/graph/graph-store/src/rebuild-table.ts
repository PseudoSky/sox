import type { StoreAdapter, AdapterTransaction } from '@adhd/sox-store-adapter';

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

export async function rebuildTable(
  adapter: StoreAdapter,
  tableName: string,
  newDDL: string,
  columnMap: string[] | Record<string, string>,
  opts?: { skipDrop?: boolean; tx?: AdapterTransaction },
): Promise<void> {
  const oldCols = (await adapter.executeAll<ColumnInfo>(
    `PRAGMA table_info(${tableName})`,
  )).rows;

  const explicitColumns: string[] = Array.isArray(columnMap)
    ? columnMap
    : Object.keys(columnMap);

  const extraColumnNames = oldCols
    .filter((c) => !explicitColumns.includes(c.name))
    .map((c) => c.name);

  const allColumns: string[] = [...explicitColumns, ...extraColumnNames];

  const selectCols = Array.isArray(columnMap)
    ? allColumns.join(', ')
    : [
        ...Object.entries(columnMap).map(([old, nu]) => `${old} AS ${nu}`),
        ...extraColumnNames,
      ].join(', ');

  const oldColType = new Map(oldCols.map((c) => [c.name, c.type]));

  const doRebuild = async (db: { exec: (sql: string) => Promise<void> }): Promise<void> => {
    await db.exec(`ALTER TABLE ${tableName} RENAME TO ${tableName}_old`);
    await db.exec(newDDL);
    for (const colName of extraColumnNames) {
      const colType = oldColType.get(colName) ?? 'TEXT';
      await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${colType}`);
    }
    await db.exec(
      `INSERT INTO ${tableName} (${allColumns.join(', ')})
       SELECT ${selectCols} FROM ${tableName}_old`,
    );
    if (!opts?.skipDrop) {
      await db.exec(`DROP TABLE ${tableName}_old`);
    }
  };

  if (opts?.tx) {
    await doRebuild(opts.tx);
  } else {
    await adapter.transaction(async (tx) => doRebuild(tx));
  }
}
