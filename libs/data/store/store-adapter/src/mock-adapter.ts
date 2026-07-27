import type {
  StoreAdapter,
  AdapterTransaction,
  AdapterConfig,
  AdapterCapabilities,
  RunResult,
  AllResult,
  TransactionOptions,
} from './types.js';

// ── Simple SQL parser (string-split / regex, no full SQL dialect) ──────────

/**
 * Minimal SQL parser that extracts table names, INSERT column lists,
 * and basic WHERE clauses. Does NOT parse JOIN, subqueries, or complex grammar —
 * just enough for the MockAdapter to route rows to the correct table.
 */
class SimpleSqlParser {
  private static readonly TABLE_PATTERNS: RegExp[] = [
    /^\s*SELECT\s+.*?\s+FROM\s+[`"']?(\w+)[`"']?/i,
    /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+[`"']?(\w+)[`"']?/i,
    /^\s*UPDATE\s+[`"']?(\w+)[`"']?/i,
    /^\s*DELETE\s+FROM\s+[`"']?(\w+)[`"']?/i,
    /^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)[`"']?/i,
    /^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[`"']?(\w+)[`"']?/i,
    /^\s*ALTER\s+TABLE\s+[`"']?(\w+)[`"']?/i,
  ];

  /** Extract the primary table name from a SQL statement. Returns null on failure. */
  extractTableName(sql: string): string | null {
    const trimmed = sql.trim();
    for (const pattern of SimpleSqlParser.TABLE_PATTERNS) {
      const match = trimmed.match(pattern);
      if (match) return match[1] ?? null;
    }
    return null;
  }

  /**
   * Extract column names from an INSERT column-list clause.
   * e.g. `INSERT INTO users (name, email) VALUES (?, ?)` → `["name", "email"]`
   * Returns null if no parenthesised column list is found.
   */
  extractInsertColumns(sql: string): string[] | null {
    const trimmed = sql.trim();
    // Match INSERT INTO <table> (<cols>) ...
    const match = trimmed.match(
      /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(?:\w+)\s*\(([^)]+)\)/i,
    );
    if (match && match[1] !== undefined) {
      return match[1]
        .split(',')
        .map((c) => c.trim().replace(/[`"']/g, ''));
    }
    return null;
  }

  /**
   * Extract a simple WHERE clause of the form `WHERE column = ?` or `WHERE column = value`.
   * Returns { column, value } if matched, null otherwise.
   * For `?` placeholders, `value` is undefined (caller substitutes from args).
   * For literal values (numbers or quoted strings), `value` is the parsed value.
   */
  extractWhereClause(sql: string): { column: string; value: unknown } | null {
    const trimmed = sql.trim();
    // Match "WHERE column = ?" or "WHERE column = value"
    const match = trimmed.match(/WHERE\s+[`"']?(\w+)[`"']?\s*=\s*(\?|'[^']*'|\d+)/i);
    if (!match || match[1] === undefined || match[2] === undefined) return null;

    const column = match[1];
    const valuePart = match[2];

    if (valuePart === '?') {
      return { column, value: undefined };
    }

    if (valuePart.startsWith("'")) {
      return { column, value: valuePart.slice(1, -1) };
    }

    return { column, value: Number(valuePart) };
  }

  /** True if the statement starts with INSERT. */
  isInsert(sql: string): boolean {
    return /^\s*INSERT\s/i.test(sql.trim());
  }

  /** True if the statement starts with SELECT. */
  isSelect(sql: string): boolean {
    return /^\s*SELECT\s/i.test(sql.trim());
  }

  /** True if the statement starts with UPDATE. */
  isUpdate(sql: string): boolean {
    return /^\s*UPDATE\s/i.test(sql.trim());
  }

  /** True if the statement starts with DELETE. */
  isDelete(sql: string): boolean {
    return /^\s*DELETE\s/i.test(sql.trim());
  }

  /** True if the statement starts with CREATE TABLE. */
  isCreateTable(sql: string): boolean {
    return /^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\s/i.test(sql.trim());
  }

  /** True if the statement starts with DROP TABLE. */
  isDropTable(sql: string): boolean {
    return /^\s*DROP\s+TABLE\s/i.test(sql.trim());
  }
}

// ── MockTransaction (internal) ──────────────────────────────────────────────

class MockTransactionImpl implements AdapterTransaction {
  private readonly adapter: MockAdapter;

  constructor(adapter: MockAdapter) {
    this.adapter = adapter;
  }

  async executeGet<T = Record<string, unknown>>(
    sql: string,
    args?: unknown[],
  ): Promise<T | null> {
    return this.adapter.executeGet(sql, args);
  }

  async executeAll<T = Record<string, unknown>>(
    sql: string,
    args?: unknown[],
  ): Promise<AllResult<T>> {
    return this.adapter.executeAll(sql, args);
  }

  async executeRun(sql: string, args?: unknown[]): Promise<RunResult> {
    return this.adapter.executeRun(sql, args);
  }

  async exec(sql: string): Promise<void> {
    return this.adapter.exec(sql);
  }
}

// ── MockAdapter ─────────────────────────────────────────────────────────────

/**
 * In-memory MockAdapter implementing `StoreAdapter` for testing.
 *
 * - Stores rows in a `Map<string, Record<string, unknown>[]>` — one array per table.
 * - Uses a simple regex-based SQL parser to extract table names and basic WHERE clauses.
 * - `unwrap()` exposes the internal Map for direct test assertions.
 *
 * @example
 * ```ts
 * const adapter = new MockAdapter();
 * await adapter.executeRun("INSERT INTO users (name) VALUES (?)", ["Alice"]);
 * const row = await adapter.executeGet("SELECT * FROM users");
 * expect(row).toEqual({ name: "Alice" });
 *
 * // Direct assertion via unwrap:
 * const data = adapter.unwrap();
 * expect(data.get("users")).toHaveLength(1);
 * ```
 */
export class MockAdapter implements StoreAdapter {
  readonly config: Readonly<AdapterConfig>;
  readonly capabilities: Readonly<AdapterCapabilities>;

  private data = new Map<string, Record<string, unknown>[]>();
  private pragmas = new Map<string, unknown>();
  private lastRowid = 0;
  private closed = false;
  private parser = new SimpleSqlParser();

  constructor() {
    this.config = {
      type: 'sqlite',
    };
    this.capabilities = {
      multiprocessWrite: false,
      nativeVectors: false,
      concurrentTransactions: false,
    };
  }

  // ── State guard ────────────────────────────────────────────────────────

  private guardOpen(): void {
    if (this.closed) {
      throw new Error('MockAdapter is closed');
    }
  }

  // ── Escape hatch ──────────────────────────────────────────────────────

  /**
   * Returns the internal `Map<tableName, rows[]>` for direct test assertions.
   * Calling this breaks portability — test-only.
   */
  unwrap(): Map<string, Record<string, unknown>[]> {
    return this.data;
  }

  // ── Query methods ──────────────────────────────────────────────────────

  async executeGet<T = Record<string, unknown>>(
    sql: string,
    args?: unknown[],
  ): Promise<T | null> {
    this.guardOpen();
    const tableName = this.parser.extractTableName(sql);
    if (!tableName) return null;
    const rows = this.data.get(tableName);
    if (!rows || rows.length === 0) return null;

    // Try WHERE clause filtering
    const where = this.parser.extractWhereClause(sql);
    if (where) {
      const whereValue = where.value !== undefined ? where.value : (args && args.length > 0 ? args[0] : undefined);
      if (whereValue !== undefined) {
        const match = rows.find((r) => r[where.column] === whereValue);
        return (match as T | null) ?? null;
      }
    }

    return rows[0] as T;
  }

  async executeAll<T = Record<string, unknown>>(
    sql: string,
    args?: unknown[],
  ): Promise<AllResult<T>> {
    this.guardOpen();
    const tableName = this.parser.extractTableName(sql);
    const allRows = tableName ? (this.data.get(tableName) ?? []) : [];

    // Try WHERE clause filtering
    let rows = allRows;
    const where = this.parser.extractWhereClause(sql);
    if (where) {
      const whereValue = where.value !== undefined ? where.value : (args && args.length > 0 ? args[0] : undefined);
      if (whereValue !== undefined) {
        rows = allRows.filter((r) => r[where.column] === whereValue);
      }
    }

    const first = rows[0];
    const columns = first !== undefined ? Object.keys(first) : [];
    return { columns, rows: rows as T[] };
  }

  async executeRun(sql: string, args?: unknown[]): Promise<RunResult> {
    this.guardOpen();
    const tableName = this.parser.extractTableName(sql);
    if (!tableName) return { rowsAffected: 0, lastInsertRowid: this.lastRowid };

    if (this.parser.isInsert(sql)) {
      return this.handleInsert(tableName, sql, args ?? []);
    }

    if (this.parser.isUpdate(sql)) {
      return this.handleUpdate(tableName, sql, args ?? []);
    }

    if (this.parser.isDelete(sql)) {
      return this.handleDelete(tableName, sql, args ?? []);
    }

    return { rowsAffected: 0, lastInsertRowid: this.lastRowid };
  }

  // ── DDL / multi-statement ──────────────────────────────────────────────

  async exec(sql: string): Promise<void> {
    this.guardOpen();
    // Handle multiple statements separated by semicolons
    const stmts = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
    for (const stmt of stmts) {
      const tableName = this.parser.extractTableName(stmt);
      if (!tableName) continue;

      if (this.parser.isCreateTable(stmt)) {
        if (!this.data.has(tableName)) {
          this.data.set(tableName, []);
        }
      } else if (this.parser.isDropTable(stmt)) {
        this.data.delete(tableName);
      }
    }
  }

  // ── PRAGMAs ────────────────────────────────────────────────────────────

  async pragmaSet(
    key: string,
    value: string | number | boolean,
  ): Promise<void> {
    this.guardOpen();
    const converted = typeof value === 'boolean' ? (value ? 1 : 0) : value;
    this.pragmas.set(key, converted);
  }

  async pragmaGet<T = unknown>(key: string): Promise<T> {
    this.guardOpen();
    return this.pragmas.get(key) as T;
  }

  // ── Transaction ────────────────────────────────────────────────────────

  async transaction<T>(
    fn: (tx: AdapterTransaction) => T | Promise<T>,
    _opts?: TransactionOptions,
  ): Promise<T> {
    this.guardOpen();
    // All modes accepted — mock supports deferred/immediate/exclusive/concurrent
    const snapshot = this.takeSnapshot();
    const tx = new MockTransactionImpl(this);

    try {
      const result = await fn(tx);
      return result;
    } catch (err) {
      this.restoreSnapshot(snapshot);
      throw err;
    }
  }

  // ── Batch ──────────────────────────────────────────────────────────────

  async executeMany(
    stmts: { sql: string; args?: unknown[] }[],
  ): Promise<RunResult[]> {
    this.guardOpen();
    const results: RunResult[] = [];
    for (const { sql, args } of stmts) {
      const result = await this.executeRun(sql, args);
      results.push(result);
    }
    return results;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async close(): Promise<void> {
    this.closed = true;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private handleInsert(
    tableName: string,
    sql: string,
    args: unknown[],
  ): RunResult {
    this.lastRowid++;
    const columns = this.parser.extractInsertColumns(sql);
    const row: Record<string, unknown> = {};

    if (columns) {
      columns.forEach((col, i) => {
        row[col] = i < args.length ? args[i] : null;
      });
    } else {
      // No column list → use positional keys
      args.forEach((val, i) => {
        row[`col${i + 1}`] = val;
      });
    }

    // Check UNIQUE constraint — look for duplicate values
    const rows = this.data.get(tableName);
    if (rows && columns) {
      const uniqueCols: string[] = [];
      for (const col of columns) {
        const lowerSql = sql.toLowerCase();
        if (lowerSql.includes(`${col.toLowerCase()} text unique`) ||
            lowerSql.includes(`${col.toLowerCase()} integer unique`)) {
          uniqueCols.push(col);
        }
      }
      for (const col of uniqueCols) {
        const val = row[col];
        const dup = rows.find((r) => r[col] === val);
        if (dup !== undefined) {
          const err = Object.assign(new Error(`UNIQUE constraint failed: ${tableName}.${col}`), {
            code: 'SQLITE_CONSTRAINT_UNIQUE',
          });
          throw err;
        }
      }
    }

    if (rows) {
      rows.push(row);
    } else {
      this.data.set(tableName, [row]);
    }

    return { rowsAffected: 1, lastInsertRowid: this.lastRowid };
  }

  private handleUpdate(
    tableName: string,
    sql: string,
    args: unknown[],
  ): RunResult {
    const rows = this.data.get(tableName);
    if (!rows || rows.length === 0) return { rowsAffected: 0, lastInsertRowid: this.lastRowid };

    // Parse SET clause: UPDATE users SET name = ? / 'X' WHERE id = ? / 1
    const setMatch = sql.match(/SET\s+(\w+)\s*=\s*(\?|'[^']*'|\d+)/i);
    if (!setMatch || setMatch[1] === undefined || setMatch[2] === undefined) {
      return { rowsAffected: 0, lastInsertRowid: this.lastRowid };
    }

    const setColumn = setMatch[1];
    let setValue: unknown;

    if (setMatch[2] === '?') {
      setValue = args.length > 0 ? args[0] : null;
    } else {
      const valStr = setMatch[2];
      setValue = valStr.startsWith("'") ? valStr.slice(1, -1) : Number(valStr);
    }

    const where = this.parser.extractWhereClause(sql);
    const whereValue = where ? (where.value !== undefined ? where.value : (args.length >= 2 ? args[1] : args[0])) : undefined;

    if (whereValue !== undefined && where) {
      let affected = 0;
      for (const r of rows) {
        if (r[where.column] === whereValue) {
          r[setColumn] = setValue;
          affected++;
        }
      }
      return { rowsAffected: affected, lastInsertRowid: this.lastRowid };
    }

    // No WHERE — update all rows
    for (const r of rows) {
      r[setColumn] = setValue;
    }
    return { rowsAffected: rows.length, lastInsertRowid: this.lastRowid };
  }

  private handleDelete(
    tableName: string,
    sql: string,
    args: unknown[],
  ): RunResult {
    const rows = this.data.get(tableName);
    if (!rows || rows.length === 0) return { rowsAffected: 0, lastInsertRowid: this.lastRowid };

    const where = this.parser.extractWhereClause(sql);
    if (!where) {
      // No WHERE — delete all rows
      const count = rows.length;
      rows.length = 0;
      return { rowsAffected: count, lastInsertRowid: this.lastRowid };
    }

    const whereValue = where.value !== undefined ? where.value : (args && args.length > 0 ? args[0] : undefined);
    if (whereValue === undefined) {
      // Cannot determine where value — delete nothing
      return { rowsAffected: 0, lastInsertRowid: this.lastRowid };
    }

    const remaining = rows.filter((r) => r[where.column] !== whereValue);
    const affected = rows.length - remaining.length;
    this.data.set(tableName, remaining);
    return { rowsAffected: affected, lastInsertRowid: this.lastRowid };
  }

  private takeSnapshot(): Map<string, Record<string, unknown>[]> {
    const snapshot = new Map<string, Record<string, unknown>[]>();
    for (const [table, rows] of this.data) {
      snapshot.set(
        table,
        rows.map((r) => ({ ...r })),
      );
    }
    return snapshot;
  }

  private restoreSnapshot(
    snapshot: Map<string, Record<string, unknown>[]>,
  ): void {
    this.data.clear();
    for (const [table, rows] of snapshot) {
      this.data.set(
        table,
        rows.map((r) => ({ ...r })),
      );
    }
  }
}
