/**
 * bl-ff7d9e24-torn-backup-not-published.spec.ts — ff7d9e24 (half 1 of 2).
 *
 * "Torn backup published to rotated name; shutdown VACUUM INTO needs staging
 * + verification gate" (HIGH). Half 1: backups are staged, verified, then
 * published by atomic rename — a torn or empty copy must never land under a
 * final backup name.
 *
 * PRODUCTION INCIDENT: a shutdown-time `VACUUM INTO` was cut off by the
 * reaper's SIGTERM grace, landing three torn 4 KB `.db` files (0 commit
 * frames — a bare SQLite header with no schema ever written) under the FINAL
 * rotated-backup name. `backupStore()`'s own `pragma_integrity_check`-based
 * verification did NOT catch this: a schema-empty single-page SQLite file is
 * "structurally consistent" — there is nothing inconsistent to find in a
 * file that never got far enough to contain anything. `integrity_check`
 * returns `ok` on it.
 *
 * FIX: `verifyStagedBackupIsNotTorn()` (backup.ts) is a second, independent
 * gate that opens the STAGED (`.tmp`) copy and requires at least one row in
 * `sqlite_master`. `autoBackup()` runs it after `backupStore()` succeeds and
 * BEFORE the atomic rename into the final rotated-backup name; a failure
 * deletes the staged file and reports the backup skipped, never renaming it.
 *
 * This suite reproduces the exact observable signature of the incident (a
 * VACUUM INTO destination with zero schema objects) via the SAME public path
 * a real shutdown-cut-off VACUUM would have produced — an empty-schema
 * SOURCE database yields an empty-schema destination when VACUUM INTO'd,
 * which is byte-for-byte the same "torn" signature (0 rows in
 * `sqlite_master`) a mid-write kill produces. No internal seam or mock is
 * needed to reproduce it.
 *
 * RED->GREEN (BL-225): with `verifyStagedBackupIsNotTorn()`'s call site in
 * `autoBackup()` removed (i.e. skipping straight from `backupStore()` success
 * to the rename), the first two tests below FAIL: the empty-schema backup is
 * renamed into the final rotated-backup name and `result.skipped` is
 * `false`. Restoring the call turns both GREEN. Quoted `npx nx test
 * memory-core -- --run bl-ff7d9e24` output for both arms is in the ff7d9e24
 * backlog resolution citation.
 *
 * Gate: npx nx test memory-core -- --run bl-ff7d9e24-torn-backup-not-published.spec
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { autoBackup, verifyStagedBackupIsNotTorn } from './backup.js';

/** Mirrors backup.ts's private `ROTATED_BACKUP_RE`. */
const ROTATED_BACKUP_PATTERN = /^memory-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}\.db$/;
/** Mirrors backup.ts's private `ROTATED_BACKUP_TMP_RE`. */
const ROTATED_BACKUP_TMP_PATTERN = /^memory-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}\.db\.\d+\.tmp$/;

let memoryDirsCreated: string[] = [];

afterEach(() => {
  for (const d of memoryDirsCreated) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
  memoryDirsCreated = [];
});

function scratchDirInsideAllowlist(label: string): string {
  const dir = path.join(
    os.homedir(), '.memory',
    `sox-ff7d9e24-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  memoryDirsCreated.push(dir);
  return dir;
}

describe('[ff7d9e24] verifyStagedBackupIsNotTorn', () => {
  it('rejects a schema-empty SQLite file (the exact torn-backup signature: 0 rows in sqlite_master)', async () => {
    const dir = scratchDirInsideAllowlist('verify-empty');
    const emptyDb = path.join(dir, 'empty.db');
    const db = new Database(emptyDb);
    db.close(); // valid SQLite header, zero tables — the torn-backup signature.

    const verdict = await verifyStagedBackupIsNotTorn(emptyDb);

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toMatch(/sqlite_master count=0/);
    }
  });

  it('accepts a copy that actually has schema objects', async () => {
    const dir = scratchDirInsideAllowlist('verify-real');
    const realDb = path.join(dir, 'real.db');
    const db = new Database(realDb);
    db.exec('CREATE TABLE t (v TEXT)');
    db.close();

    const verdict = await verifyStagedBackupIsNotTorn(realDb);

    expect(verdict.ok).toBe(true);
  });
});

describe('[ff7d9e24] autoBackup never publishes a torn/empty staged copy under the final rotated-backup name', () => {
  it('an empty-schema source (the same observable signature as a VACUUM INTO cut off mid-write) is never renamed into the final name, and the staged .tmp file is cleaned up', async () => {
    const srcDir = scratchDirInsideAllowlist('src');
    const dbPath = path.join(srcDir, 'test.db');
    // Deliberately empty: no CREATE TABLE at all. VACUUM INTO of this source
    // produces a destination whose sqlite_master is also empty — the same
    // signature a mid-write-killed shutdown VACUUM produced in production.
    const db = new Database(dbPath);
    db.close();

    const backupDir = path.join(srcDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const savedBackupDir = process.env['SOX_AUTO_BACKUP_DIR'];
    process.env['SOX_AUTO_BACKUP_DIR'] = backupDir;
    try {
      const result = await autoBackup(dbPath, { log: () => undefined });

      // The load-bearing assertions: the backup must report skipped, and
      // NOTHING matching the real rotated-backup name pattern may exist in
      // the backup dir — an empty/torn copy must never be observable under
      // the final name.
      expect(result.skipped).toBe(true);
      expect(result.path).toBe('');

      const files = fs.readdirSync(backupDir);
      expect(files.some((f) => ROTATED_BACKUP_PATTERN.test(f))).toBe(false);
      // The staged .tmp copy must also be gone — cleaned up on verification
      // failure, not left for the next sweep to discover.
      expect(files.some((f) => ROTATED_BACKUP_TMP_PATTERN.test(f))).toBe(false);
    } finally {
      if (savedBackupDir !== undefined) process.env['SOX_AUTO_BACKUP_DIR'] = savedBackupDir;
      else delete process.env['SOX_AUTO_BACKUP_DIR'];
    }
  });

  it('a healthy, non-empty source IS published under the final rotated-backup name (contrast case — the gate does not reject good backups)', async () => {
    const srcDir = scratchDirInsideAllowlist('src-healthy');
    const dbPath = path.join(srcDir, 'test.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE t (v TEXT); INSERT INTO t VALUES (\'x\');');
    db.close();

    const backupDir = path.join(srcDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const savedBackupDir = process.env['SOX_AUTO_BACKUP_DIR'];
    process.env['SOX_AUTO_BACKUP_DIR'] = backupDir;
    try {
      const result = await autoBackup(dbPath, { log: () => undefined });

      expect(result.skipped).toBe(false);
      expect(result.path).toBeTruthy();
      expect(fs.existsSync(result.path)).toBe(true);
      expect(ROTATED_BACKUP_PATTERN.test(path.basename(result.path))).toBe(true);
    } finally {
      if (savedBackupDir !== undefined) process.env['SOX_AUTO_BACKUP_DIR'] = savedBackupDir;
      else delete process.env['SOX_AUTO_BACKUP_DIR'];
    }
  });
});
