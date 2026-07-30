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

import * as sqliteVec from 'sqlite-vec';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StorageError } from './errors.js';
import { expandDbPath } from './db.js';
import type { SqliteAdapter } from '@adhd/sox-store-adapter';

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

  // Open source with WAL mode via SqliteAdapter.
  // Note: VACUUM INTO cannot run on a connection with PRAGMA query_only = ON.
  // We open with { readonly: true } to prevent schema mutations but do NOT set
  // query_only, which allows VACUUM INTO to proceed (it writes only to the dest file).
  let srcRawDb: ReturnType<(SqliteAdapter)['unwrap']> | null = null;
  try {
    const { createSqliteAdapter } = await import('@adhd/sox-store-adapter');
    const srcAdapter = createSqliteAdapter({ dbPath: resolvedSrc, readonly: true }) as SqliteAdapter;
    srcRawDb = srcAdapter.unwrap();
    sqliteVec.load(srcRawDb);
    srcRawDb.exec('PRAGMA journal_mode = WAL;');
    srcRawDb.exec('PRAGMA busy_timeout = 3000;');
    // Do NOT set PRAGMA query_only — VACUUM INTO requires it to be off.

    // VACUUM INTO — creates a compact, fully written copy with no WAL sidecar.
    // SQLite holds a shared lock on all pages during the vacuum, making the copy
    // consistent even when taken concurrently with WAL writers on the source.
    log(`[backup] running VACUUM INTO...`);
    srcRawDb.exec(`VACUUM INTO '${resolvedDst.replace(/'/g, "''")}'`);
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
    try { srcRawDb?.close(); } catch { /* ignore */ }
  }

  // Verify the backup with PRAGMA integrity_check.
  let integrityCheck = 'ok';
  if (!skipIntegrityCheck) {
    let backupRawDb: ReturnType<(SqliteAdapter)['unwrap']> | null = null;
    try {
      const { createSqliteAdapter } = await import('@adhd/sox-store-adapter');
      const backupAdapter = createSqliteAdapter({ dbPath: resolvedDst, readonly: true }) as SqliteAdapter;
      backupRawDb = backupAdapter.unwrap();
      sqliteVec.load(backupRawDb);
      const rows = backupRawDb
        .prepare<[], { integrity_check: string }>('PRAGMA integrity_check')
        .all();
      // integrity_check returns one row per issue; a clean DB returns exactly 'ok'.
      const issues = rows.map((r) => r.integrity_check).filter((s) => s !== 'ok');
      integrityCheck = issues.length === 0 ? 'ok' : issues.join('; ');
    } catch (err) {
      integrityCheck = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      try { backupRawDb?.close(); } catch { /* ignore */ }
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

// ── Auto-backup ─────────────────────────────────────────────────────────────────

export interface AutoBackupResult {
  /** Absolute path to the created backup file, or '' when skipped. */
  path: string;
  /** File size in bytes, or 0 when skipped. */
  size: number;
  /** True when the backup was skipped (disabled, no changes, or error). */
  skipped: boolean;
}

/**
 * Pre-restart auto-backup: create a timestamped VACUUM INTO backup of the
 * memory database when the process is about to restart or shut down.
 *
 * Env control:
 *   - `SOX_AUTO_BACKUP_ENABLED` — set to `'false'` or `'0'` to disable (default: enabled)
 *   - `SOX_AUTO_BACKUP_DIR` — backup directory (default: `~/.memory/backups/`)
 *
 * Idempotency:
 *   Tracks the source DB's mtime in a hidden marker file
 *   (`<backupDir>/.auto-backup-<pathHash>`). If the source has not been
 *   modified since the last successful backup, the call is skipped.
 *
 * This function NEVER throws — all error conditions (missing source, outside
 * allowlist, `backupStore` failure, filesystem errors) return a skipped result
 * instead.
 *
 * @param dbPath  Path to the source DB. Defaults to `~/.memory/memory.db`.
 * @param opts    Optional BackupStoreOptions (e.g. `log`, `skipIntegrityCheck`).
 */
export async function autoBackup(
  dbPath?: string,
  opts?: BackupStoreOptions,
): Promise<AutoBackupResult> {
  const log = opts?.log ?? (() => undefined);

  // 1. Check SOX_AUTO_BACKUP_ENABLED (default: enabled).
  const enabledRaw = process.env.SOX_AUTO_BACKUP_ENABLED;
  if (enabledRaw !== undefined && (enabledRaw === 'false' || enabledRaw === '0' || enabledRaw === '')) {
    log('[auto-backup] disabled via SOX_AUTO_BACKUP_ENABLED');
    return { path: '', size: 0, skipped: true };
  }

  // 2. Resolve source path.
  const resolvedSrc = path.resolve(expandDbPath(dbPath ?? '~/.memory/memory.db'));

  // 3. Source must exist.
  if (!fs.existsSync(resolvedSrc)) {
    log(`[auto-backup] source not found: ${resolvedSrc}`);
    return { path: '', size: 0, skipped: true };
  }

  // 4. Allowlist guard.
  if (!isPathInMemoryAllowlist(resolvedSrc)) {
    log(`[auto-backup] source outside ~/.memory/** allowlist: ${resolvedSrc}`);
    return { path: '', size: 0, skipped: true };
  }

  // 5. Resolve backup directory.
  const backupDirRaw = process.env.SOX_AUTO_BACKUP_DIR;
  const backupDir = backupDirRaw
    ? path.resolve(expandDbPath(backupDirRaw))
    : path.join(os.homedir(), '.memory', 'backups');

  // 6. Ensure backup directory exists.
  try {
    fs.mkdirSync(backupDir, { recursive: true });
  } catch (err) {
    log(`[auto-backup] cannot create backup directory ${backupDir}: ${err}`);
    return { path: '', size: 0, skipped: true };
  }

  // 7. Idempotency: compare source mtime against the last-backup marker.
  let srcStat: fs.Stats;
  try {
    srcStat = fs.statSync(resolvedSrc);
  } catch (err) {
    log(`[auto-backup] cannot stat source: ${err}`);
    return { path: '', size: 0, skipped: true };
  }
  const currentMtime = srcStat.mtimeMs;

  const pathHash = crypto.createHash('sha256').update(resolvedSrc).digest('hex').slice(0, 16);
  const markerPath = path.join(backupDir, `.auto-backup-${pathHash}`);

  let lastMtime = 0;
  try {
    const content = fs.readFileSync(markerPath, 'utf8').trim();
    lastMtime = Number(content);
  } catch {
    /* first backup — no marker yet */
  }

  if (lastMtime > 0 && currentMtime <= lastMtime) {
    log('[auto-backup] source unchanged since last backup — skipping');
    return { path: '', size: 0, skipped: true };
  }

  // 8. Generate timestamped filename with millisecond precision so that
  //    multiple backups within the same second never collide.
  const timestamp = new Date().toISOString()
    .replace(/:/g, '-')       // cross-platform filename safety
    .replace(/Z$/, '');       // remove trailing Z, keep milliseconds
  const backupName = `memory-${timestamp}.db`;
  const destPath = path.join(backupDir, backupName);

  // 9. Run the actual VACUUM INTO backup.
  const result = await backupStore(resolvedSrc, destPath, opts);

  if (isBackupStoreError(result)) {
    log(`[auto-backup] backupStore failed: ${result.message}`);
    return { path: '', size: 0, skipped: true };
  }

  // 10. Update idempotency marker (non-fatal).
  try {
    fs.writeFileSync(markerPath, String(currentMtime));
  } catch { /* non-fatal */ }

  // 11. Read file size (non-fatal — 0 is acceptable).
  let size = 0;
  try {
    size = fs.statSync(destPath).size;
  } catch { /* non-fatal */ }

  log(`[auto-backup] completed: ${destPath} (${size} bytes)`);
  return { path: destPath, size, skipped: false };
}
