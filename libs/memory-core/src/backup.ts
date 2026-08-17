/**
 * backup.ts — VACUUM INTO backup (HF-4, BL-133).
 *
 * `backupStore(dbPath, destPath)`:
 *   Opens the source DB via the store's OWN backend (`createStoreAdapter` —
 *   sqlite or turso, whichever `STORE_ADAPTER`/the store's config says) and
 *   delegates the actual `VACUUM INTO <destPath>` to that adapter's
 *   `backupTo()` (BL-385). This module never hardcodes a driver, casts to a
 *   narrowed adapter type, or `unwrap()`s a raw handle — each adapter owns
 *   the mechanics of vacuuming itself (sqlite-vec loading for SqliteAdapter,
 *   experimental-flag handling for TursoAdapter). VACUUM INTO creates a
 *   fully compacted, single-file copy with no WAL/shm sidecar — the result
 *   is always in rollback journal mode and consistent even when taken under
 *   concurrent write load (SQLite serialises it at the page level).
 *
 * Path allowlist:
 *   destPath must be inside `~/.memory/**`. This is the same allowlist enforced
 *   by the memory-server permission guard. Paths outside the allowlist are refused
 *   with E_ALLOWLIST before any file is created.
 *
 * Integrity verification:
 *   After the VACUUM INTO, the adapter re-opens the backup and runs its own
 *   integrity probe (`verifyStoreIntegrity`'s `pragma_integrity_check`, which
 *   already filters the known permanent Turso FTS false positive). Any
 *   non-"ok" result causes the backup file to be deleted and an E_IO error is
 *   returned, naming the backend so an operator does not chase corruption
 *   that isn't there (BL-385).
 *
 * Follow-up (noted, NOT wired here):
 *   A `memory_backup` MCP tool is a natural follow-up. Wiring it in memory-server
 *   is an integration step outside this shard's scope fence (S4 covers memory-core +
 *   memory-cli only). See BL-FOLLOW-backup-mcp-tool in discovered notes.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StorageError } from './errors.js';
import { expandDbPath } from './db.js';
import { resolveBackupConfig } from './config.js';
import type { BackupIntegrityReport, StoreAdapter } from '@adhd/sox-store-adapter';
import { log as tlog } from './telemetry.js';

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
  /**
   * Result of the post-backup integrity verification: 'ok' on success.
   *
   * **Prefer {@link integrityReport}.** This string collapses "verified
   * clean" and "not verified at all" onto the same value (BL-449) and is kept
   * only for compatibility with existing callers.
   */
  integrityCheck: string;
  /**
   * (BL-341, BL-449) The structured verdict from the backup copy's
   * verification run: `status` distinguishes `verified` / `damaged` /
   * `unverified`, `capped` reports whether the backend truncated its own
   * output, and `probesRun` says what the copy was actually checked against.
   *
   * Absent only when `skipIntegrityCheck` was set — nothing was checked, so
   * there is no verdict.
   */
  integrityReport?: BackupIntegrityReport;
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

  // Open the source via the store's OWN backend (BL-385) — sqlite or turso,
  // never hardcoded — and let that adapter own the VACUUM INTO mechanics.
  // readonly:true prevents schema mutations but does NOT block VACUUM INTO,
  // which only writes to destPath, never to the source file.
  let srcAdapter: StoreAdapter | null = null;
  let backend = (process.env.STORE_ADAPTER || 'turso').toLowerCase();
  try {
    const { createStoreAdapter } = await import('@adhd/sox-store-adapter');
    srcAdapter = await createStoreAdapter({ dbPath: resolvedSrc, readonly: true });
    backend = srcAdapter.config.type;

    if (typeof srcAdapter.backupTo !== 'function') {
      return {
        code: 'E_IO',
        message: `Backup failed on ${backend} backend: this adapter does not implement backupTo()`,
        retryable: false,
      };
    }

    log(`[backup] running VACUUM INTO via ${backend} adapter...`);
    const result = await srcAdapter.backupTo(resolvedDst, { skipIntegrityCheck });
    log(`[backup] VACUUM INTO complete`);

    // (BL-449) The reject rule is UNCHANGED — a backup is destroyed only when a
    // probe actually found the copy damaged. What changed is how much can now
    // be found: the copy is checked by every deep probe instead of one pragma
    // that cannot read an FTS index, so a dead `idx_fts_node` lands here rather
    // than sailing through as 'ok'.
    //
    // `unverified` deliberately does NOT delete the backup. Nothing was found
    // broken; something merely could not be checked (a store too small to yield
    // an FTS sentinel row, or an `integrity_check` truncated at its message cap
    // by filterable noise). Failing there would make small and noisy stores
    // permanently unbackupable, which is the non-convergence trap BL-360
    // documents. It is reported instead — loudly, in the log and in the
    // returned `integrityReport` — so it can never be mistaken for verified.
    const verdict = result.integrityReport;
    const damaged =
      verdict !== undefined ? verdict.status === 'damaged' : result.integrityCheck !== 'ok';
    if (!skipIntegrityCheck && damaged) {
      // Integrity failed — delete the corrupt backup and return E_IO, naming
      // the backend so an operator does not chase corruption on a healthy
      // store just because a different driver misread it (BL-385).
      try { fs.unlinkSync(resolvedDst); } catch (err) {
        tlog.debug('backup.cleanup_corrupt_file_failed', { path: resolvedDst, error: err instanceof Error ? err.message : String(err) });
      }
      return {
        code: 'E_IO',
        message: `Backup integrity check failed on ${backend} backend: ${result.integrityCheck}. Backup file deleted.`,
        retryable: false,
        details: {
          integrity_check: result.integrityCheck,
          backend,
          ...(verdict === undefined
            ? {}
            : {
                integrity_status: verdict.status,
                integrity_capped: verdict.capped,
                integrity_unknown_count: verdict.unknownCount,
                integrity_damaged_count: verdict.damagedCount,
                integrity_probes_run: verdict.probesRun,
              }),
        },
      };
    }
    log(
      `[backup] integrity: ${verdict?.status ?? result.integrityCheck}` +
        (verdict === undefined
          ? ''
          : ` (probes: ${verdict.probesRun.join(', ')}${verdict.capped ? '; output capped' : ''})`),
    );
    if (verdict?.status === 'unverified') {
      // Never let this pass silently: the backup is KEPT, so the only thing
      // standing between an operator and a false sense of safety is this line
      // and the `integrityReport` on the returned result.
      log(
        `[backup] WARNING: this backup is NOT verified — ${verdict.unknownCount} probe(s) could ` +
          `not establish anything` +
          (verdict.capped ? ', and integrity_check output was truncated at its message cap' : '') +
          `: ${verdict.findings
            .filter((f) => f.status === 'unknown')
            .map((f) => `${f.object}: ${f.detail}`)
            .join('; ')}`,
      );
    }

    const completedAt = new Date().toISOString();
    const out: BackupStoreResult = {
      sourcePath: resolvedSrc,
      destPath: resolvedDst,
      startedAt,
      completedAt,
      integrityCheck: result.integrityCheck,
    };
    if (verdict !== undefined) out.integrityReport = verdict;
    return out;
  } catch (err) {
    // Clean up a partial dest file if it was created.
    try { if (fs.existsSync(resolvedDst)) fs.unlinkSync(resolvedDst); } catch (cleanupErr) {
      tlog.debug('backup.cleanup_partial_file_failed', { path: resolvedDst, error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) });
    }
    return {
      code: 'E_IO',
      message: `Backup failed on ${backend} backend: ${err instanceof Error ? err.message : String(err)}`,
      retryable: false,
    };
  } finally {
    try { await srcAdapter?.close(); } catch (err) {
      tlog.debug('backup.adapter_close_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }
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
  /**
   * (`BackupConfig.retentionCount` enforcement) Absolute paths of rotated
   * backups deleted by this call's post-backup prune, oldest-first. Empty
   * when the backup was skipped, pruning failed (best-effort — never fatal),
   * or the count floor was not yet exceeded.
   */
  pruned: string[];
}

export interface AutoBackupOptions extends BackupStoreOptions {
  /**
   * Override `resolveBackupConfig().retentionCount` for this call. Test-only
   * seam (D3-legal numeric tuning, ADR-0013) — production callers should let
   * this resolve from typed config.
   */
  retentionCount?: number;
}

// ── Rotated-backup retention (`BackupConfig.retentionCount` enforcement) ────

/**
 * Anchored on the exact `memory-<ISO date/time, dashed>.db` shape `autoBackup`
 * generates (see `backupName` below) — never a bare `.db` substring match, so
 * an unrelated file dropped into the backup dir by a human is never swept.
 * The `\.\d{3}\.db$` suffix is the millisecond component that guarantees
 * lexicographic sort order equals chronological order.
 */
const ROTATED_BACKUP_RE = /^memory-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}\.db$/;

/**
 * Enforce `BackupConfig.retentionCount`: keep the `retentionCount` most
 * recent rotated backups in `backupDir`, delete the rest.
 *
 * Idiom matched from `sox-telemetry`'s `sink.ts:_pruneOldFiles()` (ADR-0014
 * Finding 6) — anchored regex, lexicographic sort (ISO timestamps sort
 * chronologically), count-cap shift-and-unlink loop — invoked synchronously
 * inline right after a new backup is created, not on a schedule.
 *
 * Best-effort and never throws: a single file that fails to delete (already
 * removed, permission error) is logged and skipped; the loop continues so one
 * bad entry cannot block reclaiming the rest. Returns the list of paths
 * actually deleted (oldest-first) so callers can report/verify what happened.
 */
export function pruneRotatedBackups(
  backupDir: string,
  retentionCount: number,
  log: (...args: unknown[]) => void = () => undefined,
): string[] {
  const deleted: string[] = [];
  if (!Number.isFinite(retentionCount) || retentionCount < 0) return deleted;
  let files: string[];
  try {
    files = fs
      .readdirSync(backupDir)
      .filter((f) => ROTATED_BACKUP_RE.test(f))
      .sort(); // ISO-timestamped names sort lexicographically == chronologically
  } catch (err) {
    log(`[auto-backup] prune: cannot read backup dir ${backupDir}: ${err}`);
    return deleted;
  }
  while (files.length > retentionCount) {
    const oldestName = files.shift();
    if (!oldestName) break;
    const oldestPath = path.join(backupDir, oldestName);
    try {
      fs.unlinkSync(oldestPath);
      deleted.push(oldestPath);
    } catch (err) {
      // Best-effort: already removed (ENOENT) or transient fs error. The next
      // prune run will retry naturally since the stale entry stays in the
      // directory listing; never fatal to the backup that just succeeded.
      log(`[auto-backup] prune: failed to delete ${oldestPath}: ${err}`);
    }
  }
  return deleted;
}

/**
 * Pre-restart auto-backup: create a timestamped VACUUM INTO backup of the
 * memory database when the process is about to restart or shut down.
 *
 * ALWAYS ON: `SOX_AUTO_BACKUP_ENABLED` was an anti-feature (an env var whose
 * only job was to disable a core safety function; ADR-0013) and is gone —
 * auto-backup runs on every restart, and `BackupConfig.enabled` is the typed
 * literal `true` (report-only, unrepresentable as false; see config.ts).
 * Only the destination is configurable, resolved via {@link resolveBackupConfig}:
 *   - typed `config.backup.dir` seam (future platform config-cascade) →
 *   - `SOX_AUTO_BACKUP_DIR` (host-injected config, KEPT per ADR-0013 D5) →
 *   - `~/.memory/backups` (default).
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
 * @param opts    Optional AutoBackupOptions (e.g. `log`, `skipIntegrityCheck`,
 *                test-only `retentionCount` override).
 */
export async function autoBackup(
  dbPath?: string,
  opts?: AutoBackupOptions,
): Promise<AutoBackupResult> {
  const log = opts?.log ?? (() => undefined);

  // 1. Resolve source path.
  const resolvedSrc = path.resolve(expandDbPath(dbPath ?? '~/.memory/memory.db'));

  // 2. Source must exist.
  if (!fs.existsSync(resolvedSrc)) {
    log(`[auto-backup] source not found: ${resolvedSrc}`);
    return { path: '', size: 0, skipped: true, pruned: [] };
  }

  // 3. Allowlist guard.
  if (!isPathInMemoryAllowlist(resolvedSrc)) {
    log(`[auto-backup] source outside ~/.memory/** allowlist: ${resolvedSrc}`);
    return { path: '', size: 0, skipped: true, pruned: [] };
  }

  // 4. Resolve backup directory through the typed config (ADR-0013 D2/D5).
  const backupDir = resolveBackupConfig().dir;

  // 5. Ensure backup directory exists.
  try {
    fs.mkdirSync(backupDir, { recursive: true });
  } catch (err) {
    log(`[auto-backup] cannot create backup directory ${backupDir}: ${err}`);
    return { path: '', size: 0, skipped: true, pruned: [] };
  }

  // 6. Idempotency: compare source mtime against the last-backup marker.
  let srcStat: fs.Stats;
  try {
    srcStat = fs.statSync(resolvedSrc);
  } catch (err) {
    log(`[auto-backup] cannot stat source: ${err}`);
    return { path: '', size: 0, skipped: true, pruned: [] };
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
    return { path: '', size: 0, skipped: true, pruned: [] };
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
    return { path: '', size: 0, skipped: true, pruned: [] };
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

  // 12. Enforce BackupConfig.retentionCount — prune rotated backups beyond
  //     the configured count floor now that the new one is safely on disk.
  //     Runs AFTER the new backup is written (never before — pruning must
  //     never race a not-yet-durable backup out of existence) and is
  //     best-effort: pruneRotatedBackups() never throws, so a prune failure
  //     cannot turn a successful backup into a reported failure.
  const retentionCount = opts?.retentionCount ?? resolveBackupConfig().retentionCount;
  const pruned = pruneRotatedBackups(backupDir, retentionCount, log);

  log(`[auto-backup] completed: ${destPath} (${size} bytes)` +
    (pruned.length > 0 ? `; pruned ${pruned.length} rotated backup(s)` : ''));
  return { path: destPath, size, skipped: false, pruned };
}
