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

/**
 * True if `err` is a Turso driver-level fault that has poisoned the shared
 * connection and requires reconnecting before the NEXT statement runs — as
 * opposed to a statement-local failure (bad SQL, constraint violation, type
 * mismatch) that leaves the connection perfectly usable for the next caller.
 *
 * MUST NOT be based on `err.code` — empirically (2026-08-08, against
 * @tursodatabase/database@0.7.1) EVERY Turso driver error carries
 * `code: 'GenericFailure'`, including UNIQUE constraint violations. `code`
 * carries zero discriminating information for this driver; see the BUG-*
 * item filed against errors.ts's SQLITE_*-prefix helpers (this file's own
 * `isUniqueConstraintError`/`isForeignKeyError`/`isBusyError`/
 * `isDatabaseError`, none of which actually match against a live Turso
 * error) for the same gap.
 *
 * MUST NOT match on "WAL"/"short read"/frame-offset specifics — the fix this
 * guards is required to catch disk pressure, a transient I/O error, or a
 * future driver bug identically, not just the one incident's shape.
 *
 * Turso's own error messages embed a category prefix after the phase verb
 * (`prepare failed:` / `step failed:` / `reset failed:`) — `Parse error:` for
 * statement-shape faults, `Runtime error:` for constraint/type faults at
 * execution, and `I/O error:` for storage/filesystem-layer faults. Matching
 * that THIRD category, and only that category, is the fatal signal: it is
 * the driver's own admission that the failure came from below the SQL layer,
 * not from what was asked of it.
 *
 * See SPEC-CONN-RECYCLE.md §3 for the full ruling and the losing
 * alternatives (code==='GenericFailure', WAL-text matching, SQLITE_*-prefix
 * reuse, default-fatal-on-unknown) each named with why they lose.
 */
export function isFatalConnectionError(err: unknown): boolean {
  if (!isErrorWithCode(err)) return false;
  return /\bI\/O error\b/i.test(err.message) || /database disk image is malformed/i.test(err.message);
}
