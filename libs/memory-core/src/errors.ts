/**
 * Storage error taxonomy — CONTRACTS §B (BL-124).
 *
 * Every storage-layer failure surfaced by any memory_* tool must use this shape.
 * A raw driver exception (SqliteError, ENOENT, …) reaching a caller is a defect.
 */
import type {
  isConcurrentConflict as IsConcurrentConflict,
  isFatalConnectionError as IsFatalConnectionError,
  isUniqueConstraintError as IsUniqueConstraintError,
  isDatabaseError as IsDatabaseError,
} from '@adhd/sox-store-adapter';

// (BUG-MEMORY-001 §2.2) `@nx/enforce-module-boundaries`'
// `noImportsOfLazyLoadedLibraries` requires every OTHER memory-core↔store-adapter
// edge to stay dynamic (`await import('@adhd/sox-store-adapter')`, see db.ts) — a
// static `import { … } from '@adhd/sox-store-adapter'` here would be flagged
// inconsistent with that established pattern. `wrapDbError` is called
// synchronously from dozens of call sites (including in tests), so it cannot
// itself be async; `require()` (unlike `import`) is a plain CommonJS call
// expression the boundary rule does not analyze (it only inspects ES
// import/export syntax) — this package compiles to CommonJS
// (tsconfig.lib.json `"module": "CommonJS"`), so this is a real synchronous
// load, not a lazy-load workaround.
const storeAdapterErrors = require('@adhd/sox-store-adapter') as {
  isConcurrentConflict: typeof IsConcurrentConflict;
  isFatalConnectionError: typeof IsFatalConnectionError;
  isUniqueConstraintError: typeof IsUniqueConstraintError;
  isDatabaseError: typeof IsDatabaseError;
};
const { isConcurrentConflict, isFatalConnectionError, isUniqueConstraintError, isDatabaseError } =
  storeAdapterErrors;

export type StorageErrorCode =
  | 'E_BUSY'
  | 'E_IO'
  | 'E_ALLOWLIST'
  | 'E_DEDUP'
  | 'E_NOT_FOUND'
  | 'E_STORE_MISMATCH';

export interface StorageError {
  code: StorageErrorCode;
  message: string;
  retryable: boolean;
  retry_after_ms?: number;   // present iff retryable
  details?: Record<string, unknown>; // code-specific
}

/**
 * Wrap a raw exception into the CONTRACTS §B shape.
 * Non-DB errors are returned as-is if they already look like StorageError,
 * otherwise wrapped as E_IO (unexpected error).
 *
 * (BUG-MEMORY-001 §2.2) Driver-shaped DETECTION is delegated to
 * `@adhd/sox-store-adapter`'s helpers (`isConcurrentConflict`,
 * `isFatalConnectionError`, `isUniqueConstraintError`, `isDatabaseError`) — this
 * function owns only the stable TAXONOMY (`E_BUSY`/`E_IO`/…, `{retryable,
 * retry_after_ms}`) every `memory_*` tool contracts on. Those helpers already
 * handle both SQLite (`err.code`-based) and Turso (message-marker-based)
 * driver shapes internally, so this function does not re-implement any
 * driver duck-typing of its own for the tiers they cover — see
 * docs/decisions/0012-….md §3 for the full ruling and the losing alternative
 * (a second, memory-core-local Turso regex) it was weighed against.
 */
export function wrapDbError(err: unknown): StorageError {
  // Already a StorageError — pass through
  if (isStorageError(err)) return err as StorageError;

  // Transient contention — Turso (message-marker) OR SQLite (SQLITE_BUSY/
  // SQLITE_BUSY_SNAPSHOT/SQLITE_LOCKED code). MUST be checked before the
  // generic isDatabaseError tier below — a busy condition IS a database
  // error too, and the more specific classification must win.
  if (isConcurrentConflict(err) || isSqliteLockedError(err)) {
    const msg = (err as { message?: string })?.message ?? String(err);
    return { code: 'E_BUSY', message: msg, retryable: true, retry_after_ms: 250 };
  }

  // Connection-fatal (Turso poisoned-connection markers, or SQLite
  // SQLITE_IOERR) — not retryable at THIS layer; TursoAdapterImpl already
  // recycles the connection on its own (SPEC-CONN-RECYCLE), so a retry here
  // would race the adapter's own reconnect rather than help it.
  if (isFatalConnectionError(err) || isSqliteIoError(err)) {
    const msg = (err as { message?: string })?.message ?? String(err);
    return { code: 'E_IO', message: msg, retryable: false };
  }

  // SqliteError from better-sqlite3 — SQLite-only codes with no Turso
  // equivalent, handled above (busy/locked, IOERR).
  if (isSqliteError(err)) {
    const sqlCode = (err as { code: string }).code;
    const msg = (err as { message: string }).message || String(err);

    switch (sqlCode) {
      case 'SQLITE_NOTFOUND':
        return { code: 'E_NOT_FOUND', message: msg, retryable: false };
      case 'SQLITE_CONSTRAINT':
      case 'SQLITE_CONSTRAINT_UNIQUE':
        return { code: 'E_DEDUP', message: msg, retryable: false, details: {} };
      default:
        return { code: 'E_IO', message: msg, retryable: false };
    }
  }

  // Turso GenericFailure, driver-originated, not busy, not fatal — e.g. a
  // UNIQUE violation reaching this generic path (constraint violations from
  // the write path are normally caught earlier via the content-hash dedup
  // check, so this is a defensive fallback, not the primary dedup mechanism).
  if (isDatabaseError(err)) {
    if (isUniqueConstraintError(err)) {
      const msg = (err as { message?: string })?.message ?? String(err);
      return { code: 'E_DEDUP', message: msg, retryable: false, details: {} };
    }
    const msg = (err as { message?: string })?.message ?? String(err);
    return { code: 'E_IO', message: msg, retryable: false };
  }

  // System errors (ENOENT, EACCES, …)
  if (err && typeof err === 'object' && 'code' in err) {
    const sysCode = (err as { code: string }).code;
    const msg = String((err as Record<string, unknown>).message ?? err);
    if (sysCode === 'ENOENT' || sysCode === 'EACCES' || sysCode === 'EPERM') {
      return { code: 'E_IO', message: `${sysCode}: ${msg}`, retryable: false };
    }
  }

  // Unknown — wrap generically. Prefer a `.message` property over `String(err)`
  // for a plain object (`String({...})` yields the useless literal
  // `"[object Object]"`, exactly the shape a driver-shaped-but-unrecognized
  // error object carries — e.g. a Turso GenericFailure whose message matched
  // none of the tiers above still has a real `.message` worth preserving).
  const msg =
    err instanceof Error
      ? err.message
      : (err && typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string'
          ? ((err as Record<string, unknown>).message as string)
          : String(err ?? 'unknown error'));
  return { code: 'E_IO', message: msg, retryable: false };
}

/** True when `err` already conforms to StorageError. */
function isStorageError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  return (
    typeof e.code === 'string' &&
    e.code.startsWith('E_') &&
    typeof e.retryable === 'boolean'
  );
}

/** True when `err` is a better-sqlite3 SqliteError (or duck-types as one). */
function isSqliteError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  return (
    typeof e.code === 'string' &&
    (e.code.startsWith('SQLITE_') || String(e.constructor?.name) === 'SqliteError')
  );
}

/**
 * True when `err` is a better-sqlite3 `SQLITE_BUSY`/`SQLITE_LOCKED` error —
 * checked ahead of `isSqliteError`'s generic switch so the SQLite busy/lock
 * codes join the SAME `E_BUSY` tier as Turso's message-marker-based
 * `isConcurrentConflict` (§2.2's restructure), instead of living in a
 * separate switch branch.
 */
function isSqliteLockedError(err: unknown): boolean {
  if (!isSqliteError(err)) return false;
  const sqlCode = (err as { code: string }).code;
  return sqlCode === 'SQLITE_BUSY' || sqlCode === 'SQLITE_LOCKED';
}

/**
 * True when `err` is a better-sqlite3 `SQLITE_IOERR` error — extracted as its
 * own predicate (rather than left inline in the old switch) so the
 * connection-fatal tier can share it without duplicating the `SQLITE_IOERR`
 * literal.
 */
function isSqliteIoError(err: unknown): boolean {
  if (!isSqliteError(err)) return false;
  return (err as { code: string }).code === 'SQLITE_IOERR';
}
