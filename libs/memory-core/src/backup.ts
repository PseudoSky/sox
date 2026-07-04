/**
 * backup.ts — VACUUM INTO backup (HF-4, BL-133).
 *
 * `backupStore(dbPath, destPath)`:
 *   Opens the source DB in read-only WAL mode and runs `VACUUM INTO <destPath>`.
 *   VACUUM INTO creates a fully compacted, single-file copy with no WAL/shm
 *   sidecar — the result is always in rollback journal mode and consistent even
 *   when taken under concurrent write load (SQLite serialises it at the page level).
 *
 * Path allowlist:
 *   destPath must be inside `~/.memory/**`. This is the same allowlist enforced
 *   by the memory-server permission guard. Paths outside the allowlist are refused
 *   with E_ALLOWLIST before any file is created.
 *
 * Integrity verification:
 *   After the VACUUM INTO, the backup is opened and `PRAGMA integrity_check` is
 *   run. Any non-"ok" result causes the backup file to be deleted and an E_IO
 *   error is returned.
 *
 * Follow-up (noted, NOT wired here):
 *   A `memory_backup` MCP tool is a natural follow-up. Wiring it in memory-server
 *   is an integration step outside this shard's scope fence (S4 covers memory-core +
 *   memory-cli only). See BL-FOLLOW-backup-mcp-tool in discovered notes.
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StorageError } from './errors.js';
import { expandDbPath } from './db.js';

// ── Public types ──────────────────────────────────────────────────────────────

export interface BackupStoreOptions {
  /**
   * Structured logger. Defaults to a no-op.
   */
  log?: (...args: unknown[]) => void;
  /**
   * Skip the integrity_check on the backup copy.
   * NOT recommended for production — only for test scenarios.
   * Default: false.
   */
  skipIntegrityCheck?: boolean;
}

export interface BackupStoreResult {
  /** Resolved, absolute source path. */
  sourcePath: string;
  /** Resolved, absolute destination path. */
  destPath: string;
  /** ISO timestamp at start of backup. */
  startedAt: string;
  /** ISO timestamp at completion. */
  completedAt: string;
  /** Result of PRAGMA integrity_check: 'ok' on success. */
  integrityCheck: string;
}

export type BackupStoreError = StorageError & { code: 'E_IO' | 'E_ALLOWLIST' };

// ── Allowlist ─────────────────────────────────────────────────────────────────

/**
 * The canonical allowlist prefix for memory store paths.
 * Both source and destination must be inside `~/.memory/`.
 */
export function memoryAllowlistRoot(): string {
  return path.join(os.homedir(), '.memory');
}

/**
 * True when `absPath` is inside the ~/.memory/** allowlist.
 * Resolves ~ in input before checking.
 */
export function isPathInMemoryAllowlist(p: string): boolean {
  const resolved = path.resolve(expandDbPath(p));
  const root = memoryAllowlistRoot();
  // Must be the root itself or a descendant.
  return resolved === root || resolved.startsWith(root + path.sep);
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Backup `dbPath` to `destPath` using `VACUUM INTO`.
 *
 * The source is opened read-only so this does not require the writer lease.
 * VACUUM INTO is atomic at the SQLite page level: even with concurrent WAL writers
 * on the source, the backup captures a consistent snapshot.
 *
 * After writing, the backup is opened and passed through `PRAGMA integrity_check`.
 * Any integrity failure causes the backup to be deleted and an E_IO is returned.
 *
 * Both `dbPath` and `destPath` must resolve inside `~/.memory/**`. Paths outside
 * this allowlist return E_ALLOWLIST immediately (no file created).
 */
export async function backupStore(
  dbPath: string,
  destPath: string,
  opts: BackupStoreOptions = {},
): Promise<BackupStoreResult | BackupStoreError> {
  const log = opts.log ?? (() => undefined);
  const skipIntegrityCheck = opts.skipIntegrityCheck ?? false;
  const startedAt = new Date().toISOString();

  // Resolve paths.
  const resolvedSrc = path.resolve(expandDbPath(dbPath));
  const resolvedDst = path.resolve(expandDbPath(destPath));

  log(`[backup] source: ${resolvedSrc}`);
  log(`[backup] dest:   ${resolvedDst}`);

  // Allowlist guard — source.
  if (!isPathInMemoryAllowlist(resolvedSrc)) {
    return {
      code: 'E_ALLOWLIST',
      message: `Source path ${resolvedSrc} is outside the ~/.memory/** allowlist`,
      retryable: false,
    };
  }

  // Allowlist guard — destination.
  if (!isPathInMemoryAllowlist(resolvedDst)) {
    return {
      code: 'E_ALLOWLIST',
      message: `Destination path ${resolvedDst} is outside the ~/.memory/** allowlist`,
      retryable: false,
    };
  }

  // Source must exist.
  if (!fs.existsSync(resolvedSrc)) {
    return {
      code: 'E_IO',
      message: `Source DB not found: ${resolvedSrc}`,
      retryable: false,
    };
  }

  // Destination must not already exist (avoid silent overwrites).
  if (fs.existsSync(resolvedDst)) {
    return {
      code: 'E_IO',
      message: `Destination already exists: ${resolvedDst}. Delete it before running backup.`,
      retryable: false,
    };
  }

  // Ensure destination parent directory exists.
  try {
    fs.mkdirSync(path.dirname(resolvedDst), { recursive: true });
  } catch (err) {
    return {
      code: 'E_IO',
      message: `Failed to create destination directory: ${err instanceof Error ? err.message : String(err)}`,
      retryable: false,
    };
  }

  // Open source with WAL mode.
  // Note: VACUUM INTO cannot run on a connection with PRAGMA query_only = ON.
  // We open with { readonly: true } to prevent schema mutations but do NOT set
  // query_only, which allows VACUUM INTO to proceed (it writes only to the dest file).
  let srcDb: Database.Database | null = null;
  try {
    srcDb = new Database(resolvedSrc, { readonly: true });
    sqliteVec.load(srcDb);
    srcDb.exec('PRAGMA journal_mode = WAL;');
    srcDb.exec('PRAGMA busy_timeout = 3000;');
    // Do NOT set PRAGMA query_only — VACUUM INTO requires it to be off.

    // VACUUM INTO — creates a compact, fully written copy with no WAL sidecar.
    // SQLite holds a shared lock on all pages during the vacuum, making the copy
    // consistent even when taken concurrently with WAL writers on the source.
    log(`[backup] running VACUUM INTO...`);
    srcDb.exec(`VACUUM INTO '${resolvedDst.replace(/'/g, "''")}'`);
    log(`[backup] VACUUM INTO complete`);
  } catch (err) {
    // Clean up a partial dest file if it was created.
    try { if (fs.existsSync(resolvedDst)) fs.unlinkSync(resolvedDst); } catch { /* ignore */ }
    return {
      code: 'E_IO',
      message: `VACUUM INTO failed: ${err instanceof Error ? err.message : String(err)}`,
      retryable: false,
    };
  } finally {
    try { srcDb?.close(); } catch { /* ignore */ }
  }

  // Verify the backup with PRAGMA integrity_check.
  let integrityCheck = 'ok';
  if (!skipIntegrityCheck) {
    let backupDb: Database.Database | null = null;
    try {
      backupDb = new Database(resolvedDst, { readonly: true });
      sqliteVec.load(backupDb);
      const rows = backupDb
        .prepare<[], { integrity_check: string }>('PRAGMA integrity_check')
        .all();
      // integrity_check returns one row per issue; a clean DB returns exactly 'ok'.
      const issues = rows.map((r) => r.integrity_check).filter((s) => s !== 'ok');
      integrityCheck = issues.length === 0 ? 'ok' : issues.join('; ');
    } catch (err) {
      integrityCheck = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      try { backupDb?.close(); } catch { /* ignore */ }
    }

    if (integrityCheck !== 'ok') {
      // Integrity failed — delete the corrupt backup and return E_IO.
      try { fs.unlinkSync(resolvedDst); } catch { /* ignore */ }
      return {
        code: 'E_IO',
        message: `Backup integrity check failed: ${integrityCheck}. Backup file deleted.`,
        retryable: false,
        details: { integrity_check: integrityCheck },
      };
    }
    log(`[backup] integrity_check: ok`);
  }

  const completedAt = new Date().toISOString();
  return {
    sourcePath: resolvedSrc,
    destPath: resolvedDst,
    startedAt,
    completedAt,
    integrityCheck,
  };
}

/**
 * True when the result is a BackupStoreError.
 */
export function isBackupStoreError(
  result: BackupStoreResult | BackupStoreError,
): result is BackupStoreError {
  return 'code' in result;
}
