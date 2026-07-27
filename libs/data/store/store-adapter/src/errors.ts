/**
 * Portable error helpers that duck-type across both SqliteAdapter's SqliteError
 * (from better-sqlite3) and TursoAdapter's driver-native error (LibsqlError from
 * @tursodatabase/database). Consumers MUST use these helpers for portable error
 * handling — no `instanceof` checks against driver classes.
 *
 * There is no base `StoreAdapterError` wrapper class. Errors are left as native
 * driver types; these duck-type checks are the only portable way to inspect them.
 */

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
