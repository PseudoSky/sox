/**
 * Storage error taxonomy — CONTRACTS §B (BL-124).
 *
 * Every storage-layer failure surfaced by any memory_* tool must use this shape.
 * A raw driver exception (SqliteError, ENOENT, …) reaching a caller is a defect.
 */
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
 */
export function wrapDbError(err: unknown): StorageError {
  // Already a StorageError — pass through
  if (isStorageError(err)) return err as StorageError;

  // SqliteError from better-sqlite3
  if (isSqliteError(err)) {
    const sqlCode = (err as { code: string }).code;
    const msg = (err as { message: string }).message || String(err);

    switch (sqlCode) {
      case 'SQLITE_BUSY':
      case 'SQLITE_LOCKED':
        return { code: 'E_BUSY', message: msg, retryable: true, retry_after_ms: 250 };
      case 'SQLITE_IOERR':
        return { code: 'E_IO', message: msg, retryable: false };
      case 'SQLITE_NOTFOUND':
        return { code: 'E_NOT_FOUND', message: msg, retryable: false };
      case 'SQLITE_CONSTRAINT':
        return { code: 'E_DEDUP', message: msg, retryable: false, details: {} };
      default:
        return { code: 'E_IO', message: msg, retryable: false };
    }
  }

  // System errors (ENOENT, EACCES, …)
  if (err && typeof err === 'object' && 'code' in err) {
    const sysCode = (err as { code: string }).code;
    const msg = String((err as Record<string, unknown>).message ?? err);
    if (sysCode === 'ENOENT' || sysCode === 'EACCES' || sysCode === 'EPERM') {
      return { code: 'E_IO', message: `${sysCode}: ${msg}`, retryable: false };
    }
  }

  // Unknown — wrap generically
  const msg = err instanceof Error ? err.message : String(err ?? 'unknown error');
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
