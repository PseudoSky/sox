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
 *   integrity probe (`verifyStoreIntegrity`'s `pragma_integrity_check`). Any
 *   non-"ok" result causes the backup file to be deleted and an E_IO error is
 *   returned, naming the backend so an operator does not chase corruption
 *   that isn't there (BL-385).
 *
 * Follow-up (noted, NOT wired here):
 *   A `memory_backup` MCP tool is a natural follow-up. Wiring it in memory-server
 *   is an integration step outside this shard's scope fence (S4 covers memory-core +
 *   memory-cli only). See BL-FOLLOW-backup-mcp-tool in discovered notes.
 *
 * Staged, verified, atomically-published backups (ff7d9e24):
 *   `autoBackup()` never writes directly to the final rotated-backup name.
 *   It VACUUM INTOs to a `.<pid>.tmp`-suffixed staging path, runs BOTH
 *   `backupStore()`'s integrity check AND {@link verifyStagedBackupIsNotTorn}
 *   (a torn/schema-empty copy passes `pragma_integrity_check` trivially, so a
 *   second, independent gate is required — see that function's own doc
 *   comment for the production incident this responds to), fsyncs the staged
 *   file, and only THEN renames it into the final name. A failed verification
 *   deletes the staged file and reports the backup skipped — a torn or empty
 *   copy is never observable under the final rotated-backup name. There is
 *   NO VACUUM anywhere in the memory-server shutdown path — `autoBackup()` is
 *   called only from the periodic/idle path, never from `coordinatedShutdown`
 *   or `handleDirectStdioShutdown` (memory-server/src/{backend,index}.ts),
 *   which unconditionally skip the backup step and log why.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StorageError } from './errors.js';
import { expandDbPath, STORE_MODE } from './db.js';
// (per-call DB-op tracing) db.ts's module-level DB-op-tracing hooks — see setDbOpHooks().
// Imported separately (not re-exported alongside expandDbPath/STORE_MODE above) to keep
// this import list's diff minimal against its existing shape.
import { dbOpHooksOpts } from './db.js';
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
    srcAdapter = await createStoreAdapter({ dbPath: resolvedSrc, readonly: true, concurrencyMode: STORE_MODE(), ...dbOpHooksOpts() });
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
 * (ff7d9e24) Verdict from {@link verifyStagedBackupIsNotTorn}.
 */
export type TornBackupVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * (ff7d9e24) Second, independent verification gate on the STAGED (`.tmp`)
 * backup copy, run in addition to `backupStore()`'s own
 * `pragma_integrity_check`-based verdict. That check answers "is this file
 * structurally consistent SQLite" — a torn/empty copy (a `VACUUM INTO` cut
 * off before it wrote any schema) still answers "consistent": a bare,
 * single-page SQLite header with zero tables passes `integrity_check`
 * trivially, because there is nothing inconsistent to find in a file that
 * never got far enough to contain anything. This is the EXACT shape of the
 * three real torn backups this fix responds to: 4 KB `.db` files, 0 commit
 * frames, no schema.
 *
 * This gate answers a different question: "does this copy actually contain
 * the source's data?" — by opening it read-only via the store's own adapter
 * (never a hardcoded driver, mirroring `backupStore()`'s own BL-385 rule) and
 * requiring at least one row in `sqlite_master`. A source store with truly
 * zero tables would fail this too, but `autoBackup()` is only ever pointed at
 * a real memory-server store, which always has a schema before it is ever
 * live enough to be worth backing up — so a zero count here is only ever the
 * torn-copy failure mode, never a legitimate empty source.
 *
 * Never deletes the file itself — the caller (`autoBackup`) owns cleanup so
 * it can also skip the idempotency-marker write and the retention prune on
 * failure, neither of which this function has access to.
 */
export async function verifyStagedBackupIsNotTorn(
  destPath: string,
  opts: { skipIntegrityCheck?: boolean } = {},
): Promise<TornBackupVerdict> {
  if (opts.skipIntegrityCheck) return { ok: true };
  let adapter: StoreAdapter | null = null;
  try {
    const { createStoreAdapter } = await import('@adhd/sox-store-adapter');
    adapter = await createStoreAdapter({ dbPath: destPath, readonly: true, concurrencyMode: STORE_MODE(), ...dbOpHooksOpts() });
    const row = await adapter.executeGet<{ c: number }>('SELECT count(*) AS c FROM sqlite_master');
    const count = Number(row?.c ?? 0);
    if (!Number.isFinite(count) || count <= 0) {
      return {
        ok: false,
        reason: `staged backup copy at ${destPath} has no schema objects (sqlite_master count=${count}) — ` +
          `torn/truncated VACUUM INTO`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `staged backup copy at ${destPath} failed to open/query: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    try { await adapter?.close(); } catch (err) {
      tlog.debug('backup.verify_adapter_close_failed', { path: destPath, error: err instanceof Error ? err.message : String(err) });
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

/** (BL-85a62f57) Suffix `autoBackup` appends to the real backup name (after
 * the writer's own pid) while `VACUUM INTO` is still writing it — see
 * {@link ROTATED_BACKUP_TMP_RE}. */
const BACKUP_TMP_SUFFIX = '.tmp';

/**
 * (BL-85a62f57) The IN-PROGRESS-write name `autoBackup` gives a backup while
 * `backupTo()`'s `VACUUM INTO` is still writing it: `memory-<ts>.db.<pid>.tmp`.
 * Same base shape as {@link ROTATED_BACKUP_RE} plus a `.<pid>.tmp` suffix —
 * that suffix means this NEVER matches `ROTATED_BACKUP_RE` (anchored on
 * `\.db$`), so a VACUUM INTO killed mid-write (e.g.
 * `handleDirectStdioShutdown`'s `SHUTDOWN_BACKUP_TIMEOUT_MS`/safety-net
 * `exitOnce` abandoning it — see `index.ts`'s doc comment) can never be
 * counted by {@link pruneRotatedBackups}'s retention accounting or mistaken
 * for a restorable backup by anything that lists the backup dir.
 * `autoBackup` writes here first and renames to the real `memory-*.db` name
 * only after `backupStore` reports success (VACUUM INTO complete + integrity
 * verified).
 *
 * The PID is embedded (not just a fixed `.tmp` suffix) because the backup
 * DIRECTORY is shared across every source keyed off it — both the user and
 * project-scope stores default to the same `~/.memory/backups` — so two
 * `autoBackup()` calls from two DIFFERENT live processes can have in-flight
 * `.tmp` writes in the same directory at the same time. A sweep that deleted
 * every `.tmp` file unconditionally would race and delete a concurrent,
 * still-writing process's own target file out from under it. Capturing the
 * pid lets the sweep tell "leftover from a process that is dead" (safe to
 * remove) apart from "in flight under a process that is still alive" (must
 * be left alone) — see {@link sweepStaleBackupTempFiles}.
 */
const ROTATED_BACKUP_TMP_RE = /^memory-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}\.db\.(\d+)\.tmp$/;

/**
 * True when no process with this pid currently exists. Uses the standard
 * `kill(pid, 0)` liveness probe (no signal actually sent) — throws `ESRCH`
 * when the pid is dead, `EPERM` when it's alive but owned by another user
 * (still alive, so NOT dead), and succeeds silently when alive and
 * signalable. Only `ESRCH` means "safe to sweep"; any other outcome
 * (including an unexpected error) is treated as "assume alive" — the safe
 * default here is to leave a file alone, never to delete something that
 * might still be in flight.
 */
function isPidDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false; // signalable — alive.
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return true; // no such process — genuinely dead.
    return false; // EPERM (alive, different owner) or anything else: assume alive.
  }
}

/**
 * (BL-85a62f57) Best-effort sweep of leftover `*.db.<pid>.tmp` files from a
 * PREVIOUS `autoBackup` call that was killed mid-`VACUUM INTO` (the exact
 * scenario `handleDirectStdioShutdown`'s bound exists to bound the damage
 * of) — but ONLY when the pid embedded in the filename no longer exists
 * ({@link isPidDead}). A `.tmp` file whose writer is still alive is left
 * completely alone: it may be a concurrent, still-in-flight backup from a
 * different live process sharing this same backup directory (see
 * {@link ROTATED_BACKUP_TMP_RE}'s doc comment for why that is a real,
 * not theoretical, scenario). Never touches anything matching
 * {@link ROTATED_BACKUP_RE} — only the `.tmp`-suffixed in-progress name.
 * Never throws: an unreadable dir, an unparseable pid, or a file that fails
 * to delete (already gone, permission error) is logged and skipped, exactly
 * like {@link pruneRotatedBackups}'s own best-effort contract, since a
 * sweep failure must never turn a successful backup that follows it into a
 * reported failure.
 */
function sweepStaleBackupTempFiles(
  backupDir: string,
  log: (...args: unknown[]) => void = () => undefined,
): void {
  let files: string[];
  try {
    files = fs.readdirSync(backupDir);
  } catch (err) {
    log(`[auto-backup] temp-sweep: cannot read backup dir ${backupDir}: ${err}`);
    return;
  }
  for (const f of files) {
    const m = ROTATED_BACKUP_TMP_RE.exec(f);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isFinite(pid) || !isPidDead(pid)) continue; // alive or unparseable — leave it alone.
    const p = path.join(backupDir, f);
    try {
      fs.unlinkSync(p);
      log(`[auto-backup] temp-sweep: removed stale partial backup from dead pid ${pid}: ${p}`);
    } catch (err) {
      log(`[auto-backup] temp-sweep: failed to delete ${p}: ${err}`);
    }
  }
}

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

  // 5b. (BL-85a62f57) Sweep any `.tmp` leftover from a PREVIOUS call that was
  //     killed mid-VACUUM-INTO before it could rename its result into place
  //     (below). Best-effort, never fatal to this call.
  sweepStaleBackupTempFiles(backupDir, log);

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
  const finalDestPath = path.join(backupDir, backupName);
  // (BL-85a62f57) VACUUM INTO writes under a `.<pid>.tmp`-suffixed name —
  // one that ROTATED_BACKUP_RE deliberately does NOT match — so a shutdown
  // that abandons this call mid-write (`handleDirectStdioShutdown`'s
  // SHUTDOWN_BACKUP_TIMEOUT_MS/safety-net `exitOnce`) never leaves a partial
  // file counted toward retention or mistaken for a restorable backup. The
  // pid identifies THIS writer so a concurrent backup from another live
  // process sharing this backup dir is never swept as if it were stale —
  // see `sweepStaleBackupTempFiles`'s doc comment. Only renamed to the real
  // name below, after `backupStore` reports the VACUUM INTO complete AND
  // integrity-verified.
  const tmpDestPath = `${finalDestPath}.${process.pid}${BACKUP_TMP_SUFFIX}`;

  // 9. Run the actual VACUUM INTO backup against the temp path.
  const result = await backupStore(resolvedSrc, tmpDestPath, opts);

  if (isBackupStoreError(result)) {
    log(`[auto-backup] backupStore failed: ${result.message}`);
    return { path: '', size: 0, skipped: true, pruned: [] };
  }

  // 9a. (ff7d9e24) Second, independent verification gate on the staged copy
  //     — see verifyStagedBackupIsNotTorn's own doc comment for why this is
  //     necessary IN ADDITION TO backupStore()'s pragma_integrity_check-based
  //     verdict: a torn/empty copy (VACUUM INTO cut off before it wrote any
  //     schema) passes integrity_check trivially. A failure here deletes the
  //     tmp file and reports skipped — it is NEVER renamed into the final
  //     rotated-backup name, and neither the idempotency marker nor the
  //     retention prune runs, so a torn copy can never masquerade as this
  //     backup having succeeded.
  const tornVerdict = await verifyStagedBackupIsNotTorn(tmpDestPath, opts);
  if (!tornVerdict.ok) {
    log(`[auto-backup] staged backup failed verification: ${tornVerdict.reason}`);
    tlog.warn('backup.verify_failed', { path: tmpDestPath, reason: tornVerdict.reason });
    try { fs.unlinkSync(tmpDestPath); } catch (cleanupErr) {
      tlog.debug('backup.cleanup_torn_file_failed', {
        path: tmpDestPath,
        error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    }
    return { path: '', size: 0, skipped: true, pruned: [] };
  }

  // 9b. (BL-85a62f57, ff7d9e24) Rename into the real rotated-backup name only
  //     now that BOTH backupStore's integrity check AND the torn-copy
  //     verification above have passed — the file at `finalDestPath` is
  //     never observable in a partial state. `fsyncSync` the staged file
  //     first: without it, a crash between the rename and the next fsync of
  //     the containing directory could still leave an empty/truncated file
  //     visible under the final name after an unclean shutdown of the HOST
  //     machine (not this process) — renameSync alone only guarantees the
  //     directory entry moves atomically, not that the file's own bytes were
  //     durably on disk beforehand. A rename failure (same filesystem, so
  //     practically only a permission error or an extremely unlucky racing
  //     deletion) is treated the same as any other backup failure: the temp
  //     file is cleaned up best-effort and the call reports skipped rather
  //     than risk leaving a leftover `.tmp` the next sweep can't yet explain.
  try {
    const fd = fs.openSync(tmpDestPath, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    // Best-effort durability step — never fatal to the backup: the file is
    // still structurally verified above, and a rename failure (if the fsync
    // itself surfaced a real I/O problem) is caught by the block below.
    tlog.debug('backup.fsync_before_rename_failed', {
      path: tmpDestPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    fs.renameSync(tmpDestPath, finalDestPath);
  } catch (err) {
    log(`[auto-backup] failed to finalize backup (rename ${tmpDestPath} -> ${finalDestPath}): ${err}`);
    try { fs.unlinkSync(tmpDestPath); } catch (cleanupErr) {
      tlog.debug('backup.cleanup_tmp_after_rename_failure_failed', {
        path: tmpDestPath,
        error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    }
    return { path: '', size: 0, skipped: true, pruned: [] };
  }
  const destPath = finalDestPath;

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
