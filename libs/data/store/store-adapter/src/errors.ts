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

  /**
   * (BL-508) The engine the store's marker claims, when the refusal came from
   * the engine-identity guard rather than the BL-329 schema probe. Always
   * `'turso'` for this class (it is the "store is Turso-owned" error) — kept
   * as a field so callers can report the detected engine verbatim.
   */
  public readonly detectedEngine: 'turso' | null;

  constructor(
    public readonly dbPath: string,
    /** The raw driver error (the opaque `malformed database schema
     *  (__turso_internal_...)` SqliteError) — deliberately kept OFF this
     *  error's `.message` (BL-329 requires the opaque text not reach the
     *  caller by default) but preserved here for a caller that explicitly
     *  wants to inspect the underlying driver failure. `null` when the
     *  refusal came from the (BL-508) engine-marker guard — there is no
     *  driver error in that case. */
    public readonly cause: unknown,
    opts?: { detectedEngine?: 'turso'; guidance?: string },
  ) {
    const detected = opts?.detectedEngine ?? null;
    const markerNote =
      detected !== null
        ? ` The store's engine marker (PRAGMA application_id = 0x534F5854 'SOXT') identifies it as ` +
          `Turso-owned, so better-sqlite3 refused to open it BEFORE touching the schema or WAL.`
        : ` better-sqlite3 cannot parse Turso's internal FTS directory objects (__turso_internal_fts_dir_*).`;
    const guidance =
      opts?.guidance ??
      'Open it with createTursoAdapter()/TursoAdapterImpl (or STORE_ADAPTER=turso) — route through the Turso adapter / memory server instead.';
    super(
      `[BL-329/BL-508] "${dbPath}" is a Turso-native store (it carries a Tantivy-backed FTS index). ` +
        `This is not a corrupt store; better-sqlite3 cannot open it.${markerNote} ${guidance}`,
    );
    this.name = 'ETursoNativeStore';
    this.detectedEngine = detected;
  }
}

/**
 * (BL-508) Thrown when the Turso adapter opens a store whose engine marker
 * identifies it as SQLite-owned — the mirror image of {@link ETursoNativeStore}.
 *
 * A single foreign-engine client opening a store owned by the other engine is
 * the exact class of accident that destroys WAL coordination state: Turso and
 * better-sqlite3 coordinate their shared WAL through different sidecar
 * conventions (`-tshm` vs `-shm`), so a cross-engine open can leave the store
 * permanently unopenable. The store's own marker (`PRAGMA application_id =
 * 0x534F5853 'SOXS'`) makes the mismatch detectable BEFORE any write lands.
 *
 * Unmarked legacy stores are NOT refused — they are the pre-marker population
 * and stay openable (backfilled on next sox open). Only an explicitly
 * SQLite-owned marker refuses. A deliberate migration can pass
 * `allowForeignEngine: true` to `TursoAdapterImpl.connect()` (the factory's
 * `migrateOnAdapterChange` path does exactly that).
 */
export class ESqliteNativeStore extends Error {
  public readonly code = 'E_SQLITE_NATIVE_STORE';

  constructor(
    public readonly dbPath: string,
    /** The detected engine of the store — always `'sqlite'` for this class. */
    public readonly detectedEngine: 'sqlite',
    opts?: { guidance?: string },
  ) {
    const guidance =
      opts?.guidance ??
      'The store is SQLite-owned: open it with createSqliteAdapter()/SqliteAdapterImpl (or STORE_ADAPTER=sqlite). ' +
        'To migrate it to Turso deliberately, use migrateOnAdapterChange or pass allowForeignEngine: true.';
    super(
      `[BL-508] "${dbPath}" is a SQLite-owned store (engine marker PRAGMA application_id = 0x534F5853 'SOXS') ` +
        `— the Turso adapter refused to open it so it cannot destroy the SQLite WAL coordination state. ` +
        `This is not a corrupt store. ${guidance}`,
    );
    this.name = 'ESqliteNativeStore';
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
const CODE_GENERIC_FAILURE = 'GenericFailure';

// ── Turso message-marker helpers (BUG-ERRORS-TS-CODE-HELPERS-NEVER-MATCH-TURSO-001) ──
//
// Turso's driver (@tursodatabase/database@0.7.1) emits `code: 'GenericFailure'` on
// EVERY error it raises — the code-keyed helpers below carry zero discriminating
// information for this driver (same empirical finding `isFatalConnectionError`'s
// doc comment already records). These message-marker predicates extend that same,
// already-proven technique (match driver TEXT, never `err.code`) to busy/lock and
// constraint detection, following `isFatalConnectionError`'s precedent exactly.

/**
 * True if the message carries Turso's lock/busy-contention marker. Matches the
 * literal text observed in the BUG-MEMORY-001 incident report ("database is
 * locked", no phase prefix) AND the phase-prefixed form other Turso runtime
 * errors are known to carry (`step failed: Runtime error: …`, per
 * errors.spec.ts's captured UNIQUE-violation) — deliberately NOT anchored to
 * a phase prefix, since the incident's own raw text had none.
 */
function isBusyOrLockedMessage(message: string): boolean {
  return /database (is|table is) locked/i.test(message) || /database is busy/i.test(message);
}

/** True if the message carries Turso's UNIQUE-constraint runtime-error marker. */
function isTursoUniqueConstraintMessage(message: string): boolean {
  return /Runtime error:\s*UNIQUE constraint failed/i.test(message);
}

/** True if the message carries Turso's FOREIGN KEY-constraint runtime-error marker. */
function isTursoForeignKeyMessage(message: string): boolean {
  return /Runtime error:\s*FOREIGN KEY constraint failed/i.test(message);
}

/**
 * True if the message carries Turso's own phase-prefix convention
 * (`prepare failed:` / `step failed:` / `reset failed:`) — the driver's own
 * admission that a failure is driver-originated at all, confirmed real at
 * `bl399-autolink-scope-meta-swallow.spec.ts:12` and
 * `stats-bl343-row-resilience.spec.ts:11`.
 */
function isTursoPhasePrefixedMessage(message: string): boolean {
  return /^(prepare|step|reset) failed:/i.test(message);
}

// ── Public helpers ───────────────────────────────────────────────────────

/**
 * True if the error represents a concurrent conflict (MVCC conflict OR SQLITE_BUSY),
 * OR a Turso `GenericFailure` whose message carries the driver's lock/busy text
 * marker (see {@link isBusyOrLockedMessage}). Strict widening over the code-based
 * check only — every previously-`true` case stays `true`.
 *
 * Matches:
 * - `SQLITE_BUSY` — writer slot contention (both adapters)
 * - `SQLITE_BUSY_SNAPSHOT` — MVCC snapshot conflict (TursoAdapter with BEGIN CONCURRENT)
 * - Turso `GenericFailure` with a lock/busy message marker
 */
export function isConcurrentConflict(err: unknown): boolean {
  if (!isErrorWithCode(err)) return false;
  if (err.code === CODE_SQLITE_BUSY || err.code === CODE_SQLITE_BUSY_SNAPSHOT) return true;
  return isBusyOrLockedMessage(err.message);
}

/**
 * True if the error is specifically `SQLITE_BUSY` (writer slot contention), OR a
 * Turso `GenericFailure` whose message carries the driver's lock/busy text marker.
 *
 * Does NOT match `SQLITE_BUSY_SNAPSHOT` — use {@link isConcurrentConflict} for the
 * broader check that includes MVCC conflicts. The message-based branch does not
 * carry that distinction either way — Turso's lock message doesn't disambiguate
 * snapshot vs plain busy at the text level, so it is OR'd into both functions
 * identically; there is no textual way to tell them apart that the driver gives us.
 */
export function isBusyError(err: unknown): boolean {
  if (!isErrorWithCode(err)) return false;
  if (err.code === CODE_SQLITE_BUSY) return true;
  return isBusyOrLockedMessage(err.message);
}

/**
 * True if the error is a UNIQUE constraint violation (`SQLITE_CONSTRAINT_UNIQUE`),
 * OR a Turso `GenericFailure` whose message carries the driver's UNIQUE-constraint
 * runtime-error marker.
 */
export function isUniqueConstraintError(err: unknown): boolean {
  if (!isErrorWithCode(err)) return false;
  if (err.code === CODE_SQLITE_CONSTRAINT_UNIQUE) return true;
  return isTursoUniqueConstraintMessage(err.message);
}

/**
 * True if the error is a FOREIGN KEY constraint violation (`SQLITE_CONSTRAINT_FOREIGNKEY`),
 * OR a Turso `GenericFailure` whose message carries the driver's FOREIGN KEY-constraint
 * runtime-error marker.
 */
export function isForeignKeyError(err: unknown): boolean {
  if (!isErrorWithCode(err)) return false;
  if (err.code === CODE_SQLITE_CONSTRAINT_FOREIGNKEY) return true;
  return isTursoForeignKeyMessage(err.message);
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
 * Widened to also match a Turso `GenericFailure` whose message carries the
 * driver's own phase-prefix convention (`prepare failed:`/`step failed:`/
 * `reset failed:`) — the honest "is this driver-originated at all" signal, not a
 * guess. This is the most permissive check — it returns `true` for any object
 * shaped like a database error, regardless of the specific error code.
 */
export function isDatabaseError(err: unknown): boolean {
  if (!isErrorWithCode(err)) return false;
  if (err.code.startsWith('SQLITE_')) return true;
  return err.code === CODE_GENERIC_FAILURE && isTursoPhasePrefixedMessage(err.message);
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

/**
 * (BL-512 follow-on) True if `err` is the Turso driver's open-handshake race
 * refusal — a sibling process that is mid-open (or holding) the store without
 * experimental multiprocess WAL while this process opens WITH it:
 *
 *   Locking error: Failed opening database '<path>'. Database is already open
 *   without experimental multiprocess WAL in another process
 *
 * Empirically (2026-08-12, @tursodatabase/database 0.7.1, raw-driver control
 * under barrier-synced maximal contention) this is the driver's OWN transient
 * open-handshake race, NOT a persistent holder and NOT the adapter: the engine
 * (`reject_live_legacy_wal_for_multiprocess_open`) transiently classifies an
 * IN-PROGRESS multiprocess open of the same file as a legacy opener and
 * refuses the connect. It is a hard error (not busy), so the driver's busy
 * timeout does NOT absorb it — bounded retry at the connect layer is the only
 * lever (see `TursoAdapterImpl.connect()`'s `openOnce`).
 *
 * This is a SCALPEL, never a net: it matches ONLY this one message marker.
 * `isBusyError`/`isConcurrentConflict` deliberately do NOT match this class —
 * the refusal text carries neither "locked" nor "busy" — and a retry loop keyed
 * on them would not absorb it, which is what this predicate exists to fix.
 *
 * Matches by message TEXT, following the `isFatalConnectionError` precedent —
 * `@tursodatabase/database@0.7.1` emits `code: 'GenericFailure'` on every
 * error, so `err.code` carries zero discriminating information here.
 */
export function isAlreadyOpenWithoutMultiprocessWal(err: unknown): boolean {
  if (!isErrorWithCode(err)) return false;
  return /already open without experimental multiprocess WAL/i.test(err.message);
}
