/**
 * backup.spec.ts — HF-4 / BL-133: VACUUM INTO backup + integrity verification.
 *
 * Coverage:
 *   1. backupStore produces an openable copy with integrity_check = 'ok'.
 *   2. Backup taken UNDER concurrent write load — copy is consistent.
 *   3. Destination outside ~/.memory/** → E_ALLOWLIST (no file created).
 *   4. Source outside ~/.memory/** → E_ALLOWLIST.
 *   5. Non-existent source → E_IO.
 *   6. Destination already exists → E_IO (no overwrite).
 *   7. isPathInMemoryAllowlist correctly identifies in/out-of-allowlist paths.
 *   8. isBackupStoreError utility correctly identifies errors vs results.
 *
 * Backup-under-load test (#2):
 *   A concurrent batch of writes (via memoryWrite) runs in parallel with the
 *   VACUUM INTO. The backup copy must open and pass integrity_check regardless
 *   of what writes were in-flight. This validates the SQLite page-level
 *   consistency guarantee.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { openDb } from './db.js';
import { WriteQueue } from './write-queue.js';
import {
  autoBackup,
  backupStore,
  isBackupStoreError,
  isPathInMemoryAllowlist,
  memoryAllowlistRoot,
} from './backup.js';
import { _resetEmbedSingleton } from './embed.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sox-backup-test-'));
}

function removeTempDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

let tmpDirs: string[] = [];

// For tests that need a path inside ~/.memory, we temporarily symlink or
// create directories there. We keep a cleanup list.
let memoryDirsCreated: string[] = [];

beforeEach(async () => {
  _resetEmbedSingleton();
  await WriteQueue.clearInstances();
});

afterEach(async () => {
  _resetEmbedSingleton();
  await WriteQueue.clearInstances();
  for (const d of tmpDirs) removeTempDir(d);
  tmpDirs = [];
  for (const d of memoryDirsCreated) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  memoryDirsCreated = [];
});

/**
 * Create a temp DB inside ~/.memory/sox-backup-test-<rnd>/ so the allowlist
 * check passes. Returns the db path; the dir is registered for cleanup.
 */
function freshDbInsideAllowlist(): { db: Database.Database; dbPath: string; dir: string } {
  const memRoot = os.homedir();
  const testDir = path.join(memRoot, '.memory', `sox-backup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(testDir, { recursive: true });
  memoryDirsCreated.push(testDir);
  const dbPath = path.join(testDir, 'test.db');
  const db = await openDb(dbPath);
  return { db, dbPath, dir: testDir };
}

function destPathInsideAllowlist(suffix = ''): string {
  const testDir = memoryDirsCreated[0] ?? path.join(os.homedir(), '.memory', `sox-backup-test-dest-${Date.now()}`);
  if (!memoryDirsCreated.includes(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
    memoryDirsCreated.push(testDir);
  }
  return path.join(testDir, `backup${suffix}.db`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('isPathInMemoryAllowlist', () => {
  it('accepts paths inside ~/.memory/', () => {
    const home = os.homedir();
    expect(isPathInMemoryAllowlist(path.join(home, '.memory', 'x.db'))).toBe(true);
    expect(isPathInMemoryAllowlist(path.join(home, '.memory', 'sub', 'y.db'))).toBe(true);
  });

  it('accepts ~/ prefixed paths inside ~/.memory/', () => {
    expect(isPathInMemoryAllowlist('~/.memory/x.db')).toBe(true);
    expect(isPathInMemoryAllowlist('~/.memory/sub/y.db')).toBe(true);
  });

  it('rejects paths outside ~/.memory/', () => {
    expect(isPathInMemoryAllowlist('/tmp/x.db')).toBe(false);
    expect(isPathInMemoryAllowlist(os.homedir())).toBe(false);
    expect(isPathInMemoryAllowlist(path.join(os.homedir(), 'Documents', 'x.db'))).toBe(false);
  });

  it('rejects path traversal attempts', () => {
    // ../../etc/passwd resolves to /etc/passwd which is outside ~/.memory/
    const traversal = path.join(os.homedir(), '.memory', '..', '..', 'etc', 'passwd');
    expect(isPathInMemoryAllowlist(traversal)).toBe(false);
  });
});

describe('backupStore — allowlist enforcement', () => {
  it('returns E_ALLOWLIST when destination is outside ~/.memory/**', async () => {
    const { db, dbPath } = freshDbInsideAllowlist();
    const badDest = path.join(os.tmpdir(), 'evil-backup.db');

    const result = await backupStore(dbPath, badDest, { log: () => undefined });

    expect(isBackupStoreError(result)).toBe(true);
    expect((result as { code: string }).code).toBe('E_ALLOWLIST');
    // No file should have been created.
    expect(fs.existsSync(badDest)).toBe(false);

    db.close();
  });

  it('returns E_ALLOWLIST when source is outside ~/.memory/**', async () => {
    const dir = makeTempDir();
    tmpDirs.push(dir);
    const srcPath = path.join(dir, 'outside.db');
    const db = await openDb(srcPath);
    db.close();

    const destPath = destPathInsideAllowlist('-outside-src');
    const result = await backupStore(srcPath, destPath, { log: () => undefined });

    expect(isBackupStoreError(result)).toBe(true);
    expect((result as { code: string }).code).toBe('E_ALLOWLIST');
    expect(fs.existsSync(destPath)).toBe(false);
  });

  it('returns E_IO when source does not exist', async () => {
    const src = path.join(os.homedir(), '.memory', `sox-noexist-${Date.now()}.db`);
    const dest = destPathInsideAllowlist('-noexist');

    const result = await backupStore(src, dest, { log: () => undefined });
    expect(isBackupStoreError(result)).toBe(true);
    expect((result as { code: string }).code).toBe('E_IO');
    expect((result as { message: string }).message).toContain('not found');
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('returns E_IO when destination already exists', async () => {
    const { db, dbPath } = freshDbInsideAllowlist();
    const dest = destPathInsideAllowlist('-exists');
    // Pre-create the destination.
    fs.writeFileSync(dest, 'existing');

    const result = await backupStore(dbPath, dest, { log: () => undefined });
    expect(isBackupStoreError(result)).toBe(true);
    expect((result as { code: string }).code).toBe('E_IO');
    expect((result as { message: string }).message).toContain('already exists');
    // Original dest content untouched.
    expect(fs.readFileSync(dest, 'utf8')).toBe('existing');

    db.close();
  });
});

describe('backupStore — successful backup', () => {
  it('produces an openable, integrity-clean copy of the source DB', async () => {
    const { db, dbPath } = freshDbInsideAllowlist();
    // Insert some real data.
    db.prepare(`INSERT INTO node (uid, kind, content, t_created, t_valid)
                VALUES ('test-uid-1', 'episode', 'hello world', datetime('now'), datetime('now'))`).run();
    db.close();

    const dest = destPathInsideAllowlist('-clean');
    const result = await backupStore(dbPath, dest, { log: () => undefined });

    expect(isBackupStoreError(result)).toBe(false);
    const ok = result as import('./backup.js').BackupStoreResult;
    expect(ok.integrityCheck).toBe('ok');
    expect(ok.sourcePath).toBe(path.resolve(dbPath));
    expect(ok.destPath).toBe(path.resolve(dest));
    expect(typeof ok.startedAt).toBe('string');
    expect(typeof ok.completedAt).toBe('string');

    // Verify the backup file actually exists and is openable.
    expect(fs.existsSync(dest)).toBe(true);
    const backupDb = new Database(dest, { readonly: true });
    sqliteVec.load(backupDb);
    const row = backupDb.prepare('SELECT content FROM node WHERE uid = ?').get('test-uid-1') as
      { content: string } | undefined;
    expect(row?.content).toBe('hello world');
    backupDb.close();
  });

  it('backup taken UNDER concurrent write load is consistent (integrity_check = ok)', async () => {
    /**
     * This test exercises the "backup under load" requirement from HF-4:
     * VACUUM INTO is run while concurrent writes are in flight on the source DB.
     * The resulting backup must pass integrity_check — proving that VACUUM INTO
     * provides a consistent snapshot even with concurrent WAL activity.
     *
     * We use direct SQLite transactions (no embed) to avoid ONNX warmup overhead,
     * keeping the test fast and deterministic.
     */
    const { db, dbPath } = freshDbInsideAllowlist();
    db.close();

    const dest = destPathInsideAllowlist('-under-load');

    // Perform writes directly at the SQLite level (no embed needed) using
    // INSERT transactions to simulate concurrent WAL activity.
    const writerDb = new Database(dbPath);
    sqliteVec.load(writerDb);
    writerDb.exec('PRAGMA journal_mode = WAL;');
    writerDb.exec('PRAGMA busy_timeout = 3000;');

    try {
      // Write 50 rows in rapid succession to generate WAL activity.
      const insertStmt = writerDb.prepare(
        `INSERT INTO node (uid, kind, content, t_created, t_valid)
         VALUES (?, 'episode', ?, datetime('now'), datetime('now'))`,
      );

      // Start a batch of writes in the background (non-awaited).
      const writePromises: Promise<void>[] = [];
      for (let i = 0; i < 50; i++) {
        writePromises.push(
          new Promise<void>((resolve) => {
            setImmediate(() => {
              try {
                insertStmt.run(`uid-load-${i}-${Date.now()}`, `concurrent content ${i}`);
              } catch { /* ignore dedup/constraint errors */ }
              resolve();
            });
          }),
        );
      }

      // Run backup concurrently with writes.
      const backupResult = await backupStore(dbPath, dest, { log: () => undefined });

      // Wait for all writes to complete.
      await Promise.allSettled(writePromises);

      // The backup must be integrity-clean.
      expect(isBackupStoreError(backupResult)).toBe(false);
      const ok = backupResult as import('./backup.js').BackupStoreResult;
      expect(ok.integrityCheck).toBe('ok');

      // The backup must be openable and integrity-clean.
      expect(fs.existsSync(dest)).toBe(true);
      let backupDb: Database.Database | null = null;
      try {
        backupDb = new Database(dest, { readonly: true });
        sqliteVec.load(backupDb);
        const check = backupDb.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
        const issues = check.filter((r) => r.integrity_check !== 'ok');
        expect(issues).toHaveLength(0);
      } finally {
        try { backupDb?.close(); } catch { /* ignore */ }
      }
    } finally {
      try { writerDb.close(); } catch { /* ignore */ }
      await WriteQueue.clearInstances();
    }
  }, 60_000); // 60s timeout — allows for sqlite-vec load time under load
});

describe('isBackupStoreError', () => {
  it('identifies BackupStoreError from BackupStoreResult', () => {
    expect(isBackupStoreError({ code: 'E_IO', message: 'x', retryable: false })).toBe(true);
    expect(
      isBackupStoreError({
        sourcePath: '/a',
        destPath: '/b',
        startedAt: '',
        completedAt: '',
        integrityCheck: 'ok',
      }),
    ).toBe(false);
  });
});

// ── autoBackup ──────────────────────────────────────────────────────────────────

describe('autoBackup', () => {
  let testDir: string;
  let dbPath: string;
  let backupDir: string;
  // Saved env var origins for restore.
  const envKeys = ['SOX_AUTO_BACKUP_ENABLED', 'SOX_AUTO_BACKUP_DIR'] as const;
  const savedEnv: Partial<Record<string, string | undefined>> = {};

  beforeEach(async () => {
    // Save current env state.
    for (const k of envKeys) savedEnv[k] = process.env[k];
    // Unset so defaults apply within tests.
    delete process.env.SOX_AUTO_BACKUP_ENABLED;

    // Create a source DB directly inside ~/.memory/ (allowlist) using
    // better-sqlite3 directly (not openDb which returns StoreAdapter).
    const memRoot = os.homedir();
    testDir = path.join(
      memRoot, '.memory',
      `sox-backup-test-auto-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(testDir, { recursive: true });
    memoryDirsCreated.push(testDir);

    dbPath = path.join(testDir, 'test.db');
    const db = new Database(dbPath);
    sqliteVec.load(db);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS node (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL DEFAULT 'episode',
        content TEXT,
        summary TEXT,
        topic TEXT,
        tags TEXT,
        project_path TEXT,
        name TEXT,
        t_created TEXT NOT NULL,
        t_valid TEXT NOT NULL,
        t_invalid TEXT,
        importance REAL DEFAULT 0,
        agent_id TEXT,
        enrich_ver INTEGER,
        meta TEXT DEFAULT '{}'
      )
    `);
    db.prepare(
      `INSERT INTO node (uid, kind, content, t_created, t_valid)
       VALUES ('auto-test-1', 'episode', 'auto backup test data', datetime('now'), datetime('now'))`,
    ).run();
    db.close();

    // Set backup dir to a subdirectory of the test dir (also inside ~/.memory/).
    backupDir = path.join(testDir, 'auto-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    process.env.SOX_AUTO_BACKUP_DIR = backupDir;
  });

  afterEach(async () => {
    // Restore env vars.
    for (const k of envKeys) {
      if (savedEnv[k] !== undefined) {
        process.env[k] = savedEnv[k]!;
      } else {
        delete process.env[k];
      }
    }
    // Cleanup of memoryDirsCreated and tmpDirs is handled by the top-level
    // afterEach which runs after this one.
  });

  it('creates a timestamped backup file at the expected path', async () => {
    const result = await autoBackup(dbPath, { log: () => undefined });

    expect(result.skipped).toBe(false);
    expect(result.path).toBeTruthy();
    // Path must be inside the configured backup dir.
    expect(result.path).toContain(backupDir);
    // Filename must follow the timestamped pattern: memory-YYYY-MM-DDTHH-mm-ss.mmm.db
    expect(path.basename(result.path)).toMatch(/^memory-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}\.db$/);
    expect(result.size).toBeGreaterThan(0);
    expect(fs.existsSync(result.path)).toBe(true);
  });

  it('backup file contains the same data as the original', async () => {
    const result = await autoBackup(dbPath, { log: () => undefined });
    expect(result.skipped).toBe(false);
    expect(fs.existsSync(result.path)).toBe(true);

    // Open the backup and verify its content.
    const backupDb = new Database(result.path, { readonly: true });
    try {
      sqliteVec.load(backupDb);

      // Verify integrity.
      const integrityRows = backupDb
        .prepare<[], { integrity_check: string }>('PRAGMA integrity_check')
        .all();
      const issues = integrityRows.filter((r) => r.integrity_check !== 'ok');
      expect(issues).toHaveLength(0);

      // Verify the row we inserted is present.
      const row = backupDb
        .prepare<[string], { content: string }>('SELECT content FROM node WHERE uid = ?')
        .get('auto-test-1') as { content: string } | undefined;
      expect(row?.content).toBe('auto backup test data');

      // Row count matches the source.
      const srcDb = new Database(dbPath, { readonly: true });
      try {
        const srcCount = (srcDb.prepare('SELECT COUNT(*) AS c FROM node').get() as { c: number }).c;
        const bakCount = (backupDb.prepare('SELECT COUNT(*) AS c FROM node').get() as { c: number }).c;
        expect(bakCount).toBe(srcCount);
      } finally {
        srcDb.close();
      }
    } finally {
      backupDb.close();
    }
  });

  it('skips backup when SOX_AUTO_BACKUP_ENABLED=false', async () => {
    process.env.SOX_AUTO_BACKUP_ENABLED = 'false';

    const result = await autoBackup(dbPath, { log: () => undefined });

    expect(result.skipped).toBe(true);
    expect(result.path).toBe('');
    expect(result.size).toBe(0);

    // No .db files should have been created in the backup dir.
    const files = fs.readdirSync(backupDir).filter((f) => f.endsWith('.db'));
    expect(files).toHaveLength(0);
  });

  it('skips backup when SOX_AUTO_BACKUP_ENABLED=0', async () => {
    process.env.SOX_AUTO_BACKUP_ENABLED = '0';

    const result = await autoBackup(dbPath, { log: () => undefined });

    expect(result.skipped).toBe(true);
    expect(result.path).toBe('');
  });

  it('skips backup when source has not changed (idempotent)', async () => {
    // First call — creates the backup.
    const first = await autoBackup(dbPath, { log: () => undefined });
    expect(first.skipped).toBe(false);
    expect(first.path).toBeTruthy();

    // Second call — source mtime hasn't changed — should skip.
    const second = await autoBackup(dbPath, { log: () => undefined });
    expect(second.skipped).toBe(true);
    expect(second.path).toBe('');

    // Only one backup file should exist.
    const files = fs.readdirSync(backupDir).filter((f) => f.endsWith('.db'));
    expect(files).toHaveLength(1);
  });

  it('creates a new backup when source has changed after a previous backup', async () => {
    // First backup.
    const first = await autoBackup(dbPath, { log: () => undefined });
    expect(first.skipped).toBe(false);

    // Modify the source with data that goes through WAL (the main .db file's
    // mtime may not change). Force mtime to advance by re-writing the file.
    const writer = new Database(dbPath);
    sqliteVec.load(writer);
    writer.exec('PRAGMA journal_mode = WAL;');
    writer.prepare(
      `INSERT INTO node (uid, kind, content, t_created, t_valid)
       VALUES ('auto-test-2', 'episode', 'more data', datetime('now'), datetime('now'))`,
    ).run();
    writer.close();
    // Rewrite the file to guarantee mtime change regardless of WAL.
    const content = fs.readFileSync(dbPath);
    fs.writeFileSync(dbPath, content);

    // Second backup — source has changed, should create new backup.
    const second = await autoBackup(dbPath, { log: () => undefined });
    expect(second.skipped).toBe(false);
    expect(second.path).not.toBe(first.path);

    // Two backup files should exist.
    const files = fs.readdirSync(backupDir).filter((f) => f.endsWith('.db'));
    expect(files).toHaveLength(2);
  });

  it('skips backup when source does not exist', async () => {
    const result = await autoBackup('/nonexistent/path/db.db', { log: () => undefined });
    expect(result.skipped).toBe(true);
    expect(result.path).toBe('');
  });
});
