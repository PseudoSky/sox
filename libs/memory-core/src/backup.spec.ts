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
 *   9. BL-385: backupStore() on a TURSO-backed store (the default backend)
 *      produces a destination file that (a) exists and is non-empty, and
 *      (b) is USABLE — reopens on the real Turso backend with matching row
 *      counts and working FTS. Assertion (b) is the one that matters: a file
 *      that exists but is unopenable would still pass (a). Pre-fix,
 *      backupStore() hardcoded `createSqliteAdapter` + `.unwrap()`, so the
 *      Turso open failed and no destination file was produced at all.
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
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { WriteQueue } from './write-queue.js';
import {
  autoBackup,
  backupStore,
  isBackupStoreError,
  isPathInMemoryAllowlist,
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
async function freshDbInsideAllowlist(): Promise<{ db: StoreAdapter; dbPath: string; dir: string }> {
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
    const { db, dbPath } = await freshDbInsideAllowlist();
    const badDest = path.join(os.tmpdir(), 'evil-backup.db');

    const result = await backupStore(dbPath, badDest, { log: () => undefined });

    expect(isBackupStoreError(result)).toBe(true);
    expect((result as { code: string }).code).toBe('E_ALLOWLIST');
    // No file should have been created.
    expect(fs.existsSync(badDest)).toBe(false);

    await db.close();
  });

  it('returns E_ALLOWLIST when source is outside ~/.memory/**', async () => {
    const dir = makeTempDir();
    tmpDirs.push(dir);
    const srcPath = path.join(dir, 'outside.db');
    const db = await openDb(srcPath);
    await db.close();

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
    const { db, dbPath } = await freshDbInsideAllowlist();
    const dest = destPathInsideAllowlist('-exists');
    // Pre-create the destination.
    fs.writeFileSync(dest, 'existing');

    const result = await backupStore(dbPath, dest, { log: () => undefined });
    expect(isBackupStoreError(result)).toBe(true);
    expect((result as { code: string }).code).toBe('E_IO');
    expect((result as { message: string }).message).toContain('already exists');
    // Original dest content untouched.
    expect(fs.readFileSync(dest, 'utf8')).toBe('existing');

    await db.close();
  });
});

describe('backupStore — successful backup', () => {
  // These two tests write to and read the backup file directly through
  // better-sqlite3 (real WAL writer / raw PRAGMA integrity_check), which is
  // only valid against a SQLite-backed store — force that backend explicitly
  // rather than relying on whatever STORE_ADAPTER defaults to. The Turso
  // backend gets its own dedicated coverage below (BL-385).
  const priorAdapterEnv = process.env['STORE_ADAPTER'];
  beforeEach(() => {
    process.env['STORE_ADAPTER'] = 'sqlite';
  });
  afterEach(() => {
    if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
    else process.env['STORE_ADAPTER'] = priorAdapterEnv;
  });

  it('produces an openable, integrity-clean copy of the source DB', async () => {
    const { db, dbPath } = await freshDbInsideAllowlist();
    // Insert some real data.
    await db.executeRun(`INSERT INTO node (uid, kind, content, t_created, t_valid)
                VALUES ('test-uid-1', 'episode', 'hello world', datetime('now'), datetime('now'))`);
    await db.close();

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
    const { db, dbPath } = await freshDbInsideAllowlist();
    await db.close();

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

// ── BL-385 ────────────────────────────────────────────────────────────────────

describe('backupStore — BL-385 Turso backend', () => {
  let dir: string | undefined;
  const priorAdapterEnv = process.env['STORE_ADAPTER'];

  afterEach(() => {
    if (dir) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dir = undefined;
    if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
    else process.env['STORE_ADAPTER'] = priorAdapterEnv;
  });

  it(
    'produces a destination file that exists, is non-empty, and reopens on Turso ' +
      'with matching row counts and working FTS',
    async () => {
      process.env['STORE_ADAPTER'] = 'turso';

      const testDir = path.join(
        os.homedir(),
        '.memory',
        `sox-backup-test-bl385-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      fs.mkdirSync(testDir, { recursive: true });
      dir = testDir;
      const dbPath = path.join(testDir, 'm.db');

      const adapter = await openDb(dbPath);
      expect(adapter.config.type).toBe('turso');

      const NODES = [
        { uid: 'bl385-1', content: 'The application server experienced high CPU load during peak hours.' },
        { uid: 'bl385-2', content: 'Distributed systems require careful consideration of CAP theorem tradeoffs.' },
        { uid: 'bl385-3', content: 'The new API gateway improved throughput by 40 percent across all services.' },
      ];
      for (const n of NODES) {
        await adapter.executeRun(
          `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid)
           VALUES (?, 'episode', ?, ?, datetime('now'), datetime('now'))`,
          [n.uid, n.content, `hash-${n.uid}`],
        );
      }
      const srcCount = await adapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM node');
      await adapter.close();

      const dest = path.join(testDir, 'backup-bl385.db');
      const result = await backupStore(dbPath, dest, { log: () => undefined });

      expect(isBackupStoreError(result)).toBe(false);
      const ok = result as import('./backup.js').BackupStoreResult;
      expect(ok.integrityCheck).toBe('ok');

      // (a) The destination file exists and is non-empty.
      expect(fs.existsSync(dest)).toBe(true);
      expect(fs.statSync(dest).size).toBeGreaterThan(0);

      // (b) The destination is USABLE — reopen it on the real Turso backend
      // (never better-sqlite3; a Turso store's FTS/vec0 artifacts are not
      // readable through that driver — see BL-385's root-cause writeup) and
      // confirm row counts match the source and FTS still returns hits.
      //
      // Reopened WITHOUT readonly: a readonly Turso connection cannot run
      // fts_match at all (`Error: Resource is read-only` — a genuine, verified,
      // pre-existing Turso engine limitation, reproduced independent of this
      // backup path). Row-count verification does not need this and would
      // pass equally under readonly; using one connection for both keeps the
      // test honest about what actually works on a reopened backup.
      const { createStoreAdapter, createFTSDialect } = await import('@adhd/sox-store-adapter');
      const backupAdapter = await createStoreAdapter({ dbPath: dest });
      try {
        expect(backupAdapter.config.type).toBe('turso');
        const bakCount = await backupAdapter.executeGet<{ c: number }>('SELECT COUNT(*) AS c FROM node');
        expect(bakCount?.c).toBe(srcCount?.c);
        expect(bakCount?.c).toBeGreaterThanOrEqual(NODES.length);

        const ftsDialect = createFTSDialect('turso');
        const { sql: matchSql } = ftsDialect.matchClause(['content', 'name', 'summary'], '?');
        const hits = await backupAdapter.executeAll<{ uid: string }>(
          `SELECT uid FROM node WHERE ${matchSql}`,
          ['CPU load'],
        );
        expect(hits.rows.map((r) => r.uid)).toContain('bl385-1');
      } finally {
        await backupAdapter.close();
      }
    },
    30_000,
  );
});

// ── BL-341 + BL-449 — the backup verdict is structured and refuses to guess ──
//
// `backupStore()` deletes the destination and returns E_IO on a failed check,
// so an operator reasonably reads a returned BackupStoreResult as "this backup
// was verified". Before this suite it could equally mean "one pragma ran and it
// cannot see FTS damage" or "nothing ran at all".

describe('backupStore — BL-341/BL-449 structured integrity verdict', () => {
  const priorAdapterEnv = process.env['STORE_ADAPTER'];
  beforeEach(() => {
    process.env['STORE_ADAPTER'] = 'sqlite';
  });
  afterEach(() => {
    if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
    else process.env['STORE_ADAPTER'] = priorAdapterEnv;
  });

  it('BL-449: a healthy backup carries a `verified` verdict naming the probes it ran', async () => {
    const { db, dbPath } = await freshDbInsideAllowlist();
    // Enough rows, with enough distinct vocabulary, that the FTS probe can pick
    // sentinel tokens and actually validate itself. A near-empty store cannot —
    // see the `unverified` test below, which is that case on purpose.
    for (let i = 0; i < 12; i++) {
      await db.executeRun(
        `INSERT INTO node (uid, kind, content, t_created, t_valid)
           VALUES (?, 'episode', ?, datetime('now'), datetime('now'))`,
        [`bl449-ok-${i}`, `episode ${i} concerning quarterly hippopotamus logistics`],
      );
    }
    await db.close();

    const result = await backupStore(dbPath, destPathInsideAllowlist('-bl449-ok'), {
      log: () => undefined,
    });

    expect(isBackupStoreError(result), JSON.stringify(result)).toBe(false);
    const ok = result as import('./backup.js').BackupStoreResult;
    expect(
      ok.integrityReport?.status,
      JSON.stringify(ok.integrityReport?.findings, null, 2),
    ).toBe('verified');
    expect(ok.integrityReport?.capped).toBe(false);
    expect(ok.integrityReport?.unknownCount).toBe(0);
    // The verdict names what was checked, so "verified" is an auditable claim
    // rather than a word. More than one probe ran — the `only:` narrowing that
    // reduced this to a single pragma is gone.
    expect(ok.integrityReport!.probesRun.length).toBeGreaterThan(1);
    expect(ok.integrityReport?.probesRun).toContain('pragma_integrity_check');
    expect(ok.integrityReport?.probesRun).toContain('fts_index_live');
  });

  it('BL-449: a store too small to sample yields `unverified` — the backup is KEPT, not certified', async () => {
    // Discovered by this packet's own negative control: on a one-row store the
    // FTS probe cannot find a usable sentinel token, so it establishes nothing.
    // Two wrong answers are available and both were rejected — calling it
    // `verified` (the old behaviour, a lie) and deleting the backup (which
    // would leave a brand-new store with no backup at all, the BL-360
    // non-convergence trap). It is kept, and it says it is unverified.
    const { db, dbPath } = await freshDbInsideAllowlist();
    await db.executeRun(`INSERT INTO node (uid, kind, content, t_created, t_valid)
                VALUES ('bl449-tiny-1', 'episode', 'x', datetime('now'), datetime('now'))`);
    await db.close();

    const dest = destPathInsideAllowlist('-bl449-tiny');
    const logged: string[] = [];
    const result = await backupStore(dbPath, dest, { log: (...a) => logged.push(a.join(' ')) });

    expect(isBackupStoreError(result), JSON.stringify(result)).toBe(false);
    const ok = result as import('./backup.js').BackupStoreResult;
    expect(ok.integrityReport?.status).toBe('unverified');
    expect(ok.integrityReport!.unknownCount).toBeGreaterThan(0);
    expect(ok.integrityReport?.damagedCount).toBe(0);
    // The backup survives …
    expect(fs.existsSync(dest)).toBe(true);
    // … and the fact that it is unverified is impossible to miss.
    expect(logged.some((l) => /WARNING: this backup is NOT verified/.test(l))).toBe(true);
  });

  it('BL-449: a backup whose FTS index is dead is REJECTED, not returned as a result', async () => {
    const { db, dbPath } = await freshDbInsideAllowlist();
    for (let i = 0; i < 12; i++) {
      await db.executeRun(
        `INSERT INTO node (uid, kind, content, t_created, t_valid)
           VALUES (?, 'episode', ?, datetime('now'), datetime('now'))`,
        [`bl449-fts-${i}`, `episode ${i} concerning quarterly hippopotamus logistics`],
      );
    }
    // The BL-347 damage shape: the FTS virtual table survives, its content does
    // not. `PRAGMA integrity_check` is green on this file — it is a
    // structurally perfect SQLite database whose keyword search is dead.
    await db.exec(`INSERT INTO fts_node(fts_node) VALUES('delete-all')`);
    await db.close();

    const dest = destPathInsideAllowlist('-bl449-dead-fts');
    const result = await backupStore(dbPath, dest, { log: () => undefined });

    expect(
      isBackupStoreError(result),
      'a backup of a store with a dead FTS index must not be returned as a success: ' +
        JSON.stringify(result),
    ).toBe(true);
    const err = result as { code: string; details?: Record<string, unknown> };
    expect(err.code).toBe('E_IO');
    expect(err.details?.['integrity_status']).toBe('damaged');
    // The rejected copy is deleted, so nobody restores from it later.
    expect(fs.existsSync(dest)).toBe(false);
  });
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
  const envKeys = ['SOX_AUTO_BACKUP_DIR'] as const;
  const savedEnv: Partial<Record<string, string | undefined>> = {};

  beforeEach(async () => {
    // Save current env state.
    for (const k of envKeys) savedEnv[k] = process.env[k];

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

  it('auto-backup ALWAYS runs (ADR-0013) — SOX_AUTO_BACKUP_ENABLED was an anti-feature and is gone; a lingering value must be ignored, not honored', async () => {
    // Even a stale 'false'/'0' left in the environment from before the
    // deletion must NOT suppress the backup: the toggle no longer exists.
    process.env.SOX_AUTO_BACKUP_ENABLED = 'false';

    const result = await autoBackup(dbPath, { log: () => undefined });

    expect(result.skipped).toBe(false);
    expect(result.path).not.toBe('');
    expect(result.size).toBeGreaterThan(0);

    // A real backup file must have been created.
    const files = fs.readdirSync(backupDir).filter((f) => f.endsWith('.db'));
    expect(files.length).toBeGreaterThan(0);
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
