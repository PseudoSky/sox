/**
 * Portable error helpers that duck-type across both SqliteAdapter's SqliteError
 * (from better-sqlite3) and TursoAdapter's driver-native error (LibsqlError from
 * @tursodatabase/database). Consumers MUST use these helpers for portable error
 * handling — no `instanceof` checks against driver classes.
 *
 * There is no base `StoreAdapterError` wrapper class. Errors are left as native
 * driver types; these duck-type checks are the only portable way to inspect them.
 */

// ── ETursoNativeStore (BL-329) ───────────────────────────────────────────

/**
 * (BL-329) Thrown by `SqliteAdapterImpl` when better-sqlite3 cannot open a
 * store because it carries Turso-native FTS objects.
 *
 * Turso's Tantivy-backed FTS index (`CREATE INDEX ... USING fts (...)`) is
 * NOT valid SQLite DDL — SQLite/better-sqlite3 cannot parse it. Opening the
 * *connection* still succeeds (better-sqlite3 doesn't parse the schema at
 * `new Database(path)` time), but the FIRST statement that touches
 * `sqlite_master` — which is effectively any query, since SQLite parses
 * every `CREATE` statement's SQL text to build the in-memory schema before
 * running anything — throws:
 *
 *   SqliteError: malformed database schema (__turso_internal_fts_dir_idx_fts_node_key)
 *     - near "USING": syntax error
 *
 * This is not a corrupt store; it's the wrong driver for the store's
 * content. Naming the internal Tantivy directory object as if it were a
 * generic schema corruption is actively misleading and has cost real
 * debugging time (see `tools/baseline-capture`'s WAL-checkpoint helper,
 * which hit exactly this against the live store). `SqliteAdapterImpl`
 * proactively probes for this at open time (a single cheap
 * `sqlite_master` read) and converts it into this typed, store-path-
 * carrying error instead of letting the opaque driver message propagate
 * from wherever the caller's first real query happens to be.
 *
 * The fix is never "revert to opening as SQLite" — better-sqlite3 is a
 * fallback path; a Turso-native store must be opened with
 * `TursoAdapterImpl`/`createTursoAdapter()` (or `STORE_ADAPTER=turso`)
 * instead.
 */
export class ETursoNativeStore extends Error {
  public readonly code = 'E_TURSO_NATIVE_STORE';

  constructor(
    public readonly dbPath: string,
    /** The raw driver error (the opaque `malformed database schema
     *  (__turso_internal_...)` SqliteError) — deliberately kept OFF this
     *  error's `.message` (BL-329 requires the opaque text not reach the
     *  caller by default) but preserved here for a caller that explicitly
     *  wants to inspect the underlying driver failure. */
    public readonly cause: unknown,
  ) {
    super(
      `[BL-329] "${dbPath}" is a Turso-native store (it carries a Tantivy-backed FTS index) ` +
        `— better-sqlite3 cannot open it. This is not a corrupt store; better-sqlite3 simply ` +
        `cannot parse Turso's internal FTS directory objects (__turso_internal_fts_dir_*). ` +
        `Open it with createTursoAdapter()/TursoAdapterImpl (or STORE_ADAPTER=turso) instead.`,
    );
    this.name = 'ETursoNativeStore';
  }
}

/**
 * True if `err` matches the specific opaque failure `ETursoNativeStore`
 * exists to replace: better-sqlite3's `malformed database schema
 * (__turso_internal_fts_dir_...)`. Exported so callers/tests can recognize
 * the RAW driver symptom without needing to reproduce the regex — used
 * internally by `SqliteAdapterImpl`'s open-time probe.
 */
export function isTursoNativeStoreSchemaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /malformed database schema \(__turso_internal_/i.test(err.message);
}

// ── Internal duck-type guard ─────────────────────────────────────────────

/**
 * True if `err` is a non-null object with a non-empty string `code` and a
 * string `message` — the common shape of both SqliteError and LibsqlError.
 */
function isErrorWithCode(err: unknown): err is { code: string; message: string } {
  if (err === null || err === undefined) return false;
  if (typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  return typeof e.code === 'string' && e.code.length > 0 && typeof e.message === 'string';
}

// ── Error code constants ─────────────────────────────────────────────────

const CODE_SQLITE_BUSY = 'SQLITE_BUSY';
const CODE_SQLITE_BUSY_SNAPSHOT = 'SQLITE_BUSY_SNAPSHOT';
const CODE_SQLITE_CONSTRAINT_UNIQUE = 'SQLITE_CONSTRAINT_UNIQUE';
const CODE_SQLITE_CONSTRAINT_FOREIGNKEY = 'SQLITE_CONSTRAINT_FOREIGNKEY';

// ── Public helpers ───────────────────────────────────────────────────────

/**
 * True if the error represents a concurrent conflict (MVCC conflict OR SQLITE_BUSY).
 *
 * Matches:
 * - `SQLITE_BUSY` — writer slot contention (both adapters)
 * - `SQLITE_BUSY_SNAPSHOT` — MVCC snapshot conflict (TursoAdapter with BEGIN CONCURRENT)
 */
export function isConcurrentConflict(err: unknown): boolean {
  if (!isErrorWithCode(err)) return false;
  return err.code === CODE_SQLITE_BUSY || err.code === CODE_SQLITE_BUSY_SNAPSHOT;
}

/**
 * True if the error is specifically `SQLITE_BUSY` (writer slot contention).
 *
 * Does NOT match `SQLITE_BUSY_SNAPSHOT` — use {@link isConcurrentConflict} for the
 * broader check that includes MVCC conflicts.
 */
export function isBusyError(err: unknown): boolean {
  if (!isErrorWithCode(err)) return false;
  return err.code === CODE_SQLITE_BUSY;
}

/**
 * True if the error is a UNIQUE constraint violation (`SQLITE_CONSTRAINT_UNIQUE`).
 */
export function isUniqueConstraintError(err: unknown): boolean {
  if (!isErrorWithCode(err)) return false;
  return err.code === CODE_SQLITE_CONSTRAINT_UNIQUE;
}

/**
 * True if the error is a FOREIGN KEY constraint violation (`SQLITE_CONSTRAINT_FOREIGNKEY`).
 */
export function isForeignKeyError(err: unknown): boolean {
  if (!isErrorWithCode(err)) return false;
  return err.code === CODE_SQLITE_CONSTRAINT_FOREIGNKEY;
}

/**
 * Returns the SQLite error code string (e.g., `'SQLITE_BUSY'`, `'SQLITE_CONSTRAINT_UNIQUE'`)
 * or `undefined` if the error is not a recognized database error.
 */
export function dbErrorCode(err: unknown): string | undefined {
  if (!isErrorWithCode(err)) return undefined;
  return err.code;
}

/**
 * True if `err` is any recognized database error (SqliteError or LibsqlError).
 *
 * Both driver error types expose a `code` property containing an `SQLITE_*` string.
 * This is the most permissive check — it returns `true` for any object shaped like
 * a database error, regardless of the specific error code.
 */
export function isDatabaseError(err: unknown): boolean {
  if (!isErrorWithCode(err)) return false;
  return err.code.startsWith('SQLITE_');
}
