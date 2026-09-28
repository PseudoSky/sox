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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  pruneRotatedBackups,
} from './backup.js';
import { _resetEmbedSingleton } from './embed.js';

// (BL-85a62f57) A mutable, per-test override for `fs.renameSync`, used only
// by the two "finalize wiring" tests below. `vi.spyOn(fs, 'renameSync')` is
// not viable here: backup.ts imports fs via `import * as fs from 'node:fs'`,
// an ESM namespace object vitest reports as non-configurable ("Module
// namespace is not configurable in ESM"), and the CJS-interop default-export
// object is a SEPARATE instance under vitest's module graph, so mutating it
// does not reach backup.ts's own binding. `vi.mock('node:fs', ...)` rewrites
// every consumer's binding (including backup.ts's) through one shared
// module record, so it is the only reliable interception point. All other
// exports pass through to the real implementation unchanged — every other
// test in this file (and every other fs call backup.ts itself makes) is
// unaffected as long as `renameSyncOverride.current` is left `undefined`.
const { renameSyncOverride, realRenameSyncRef } = vi.hoisted(() => ({
  renameSyncOverride: { current: undefined as ((...args: unknown[]) => unknown) | undefined },
  // Populated with the UNMOCKED `renameSync` by the factory below so a test
  // override can call through to the real implementation without recursing
  // back into this same mocked binding (which would call the override again).
  realRenameSyncRef: { current: undefined as ((...args: unknown[]) => unknown) | undefined },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  realRenameSyncRef.current = actual.renameSync as (...args: unknown[]) => unknown;
  return {
    ...actual,
    default: actual,
    renameSync: (...args: unknown[]) => {
      if (renameSyncOverride.current) return renameSyncOverride.current(...args);
      return (actual.renameSync as (...a: unknown[]) => unknown)(...args);
    },
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Mirrors backup.ts's private `ROTATED_BACKUP_RE` — kept in sync manually
 * since the module intentionally does not export its internal naming regex. */
const ROTATED_BACKUP_PATTERN = /^memory-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}\.db$/;

/** Mirrors backup.ts's private `ROTATED_BACKUP_TMP_RE` — kept in sync
 * manually for the same reason as {@link ROTATED_BACKUP_PATTERN}. */
const ROTATED_BACKUP_TMP_PATTERN = /^memory-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}\.db\.\d+\.tmp$/;

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

  // ── BackupConfig.retentionCount enforcement (task #16, finding 5) ─────────
  //
  // Pre-fix, `retentionCount` (config.ts, default 24) was a typed, documented
  // field that nothing ever read — `rg -n "prune|readdirSync|unlinkSync"
  // backup.ts` found only single-file cleanup on FAILED backup attempts, never
  // retention enforcement of successful ones (ADR-0014 Finding 7). This block
  // is the RED->GREEN proof that rotated backups are now bounded.

  it('retentionCount=2: a 5th successful backup leaves exactly 2 rotated files on disk, the 3 oldest pruned', async () => {
    let lastResult: Awaited<ReturnType<typeof autoBackup>> | undefined;
    for (let i = 0; i < 5; i++) {
      lastResult = await autoBackup(dbPath, { log: () => undefined, retentionCount: 2 });
      expect(lastResult.skipped).toBe(false);
      // Force the source's mtime forward so the next iteration's idempotency
      // check doesn't skip it (mirrors the existing "creates a new backup
      // when source has changed" test's technique).
      const content = fs.readFileSync(dbPath);
      fs.writeFileSync(dbPath, content);
    }

    const files = fs.readdirSync(backupDir).filter((f) => /^memory-.*\.db$/.test(f));
    expect(files).toHaveLength(2);
    // The survivor set must include the just-created (newest) backup — never
    // itself pruned out in favor of something older.
    expect(files).toContain(path.basename(lastResult!.path));
    // Across the whole run, exactly 3 of the 5 created backups must have
    // been deleted (5 created - 2 kept = 3 pruned, matching retentionCount=2).
    expect(5 - files.length).toBe(3);
  });

  it('retentionCount=0 is honored literally (keep zero) and reported, not a silent crash/no-op', async () => {
    // A `0` config value must not fall through `?? default` to 24 (the
    // `??` operator only substitutes on null/undefined, never on 0 — this
    // pins that contract) and must not throw or negative-index.
    const first = await autoBackup(dbPath, { log: () => undefined, retentionCount: 0 });
    expect(first.skipped).toBe(false);
    // The backup that was just created is itself the one entry over a
    // zero-count floor, so it is pruned immediately after being verified —
    // reported in `pruned`, never silently vanished.
    expect(first.pruned).toEqual([first.path]);
    expect(fs.existsSync(first.path)).toBe(false);
  });

  it('unrelated files in the backup dir are never touched by retention pruning', async () => {
    fs.writeFileSync(path.join(backupDir, 'not-a-rotated-backup.txt'), 'keep me');
    fs.writeFileSync(path.join(backupDir, 'memory-not-a-real-timestamp.db'), 'keep me too');

    for (let i = 0; i < 3; i++) {
      await autoBackup(dbPath, { log: () => undefined, retentionCount: 1 });
      const content = fs.readFileSync(dbPath);
      fs.writeFileSync(dbPath, content);
    }

    expect(fs.existsSync(path.join(backupDir, 'not-a-rotated-backup.txt'))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, 'memory-not-a-real-timestamp.db'))).toBe(true);
  });

  // ── BL-85a62f57: interrupted/partial backups never look like real ones ────
  //
  // `handleDirectStdioShutdown` (memory-server/src/index.ts) can abandon an
  // in-flight `autoBackup()` at `SHUTDOWN_BACKUP_TIMEOUT_MS` and force-exit
  // the process. Pre-fix, `autoBackup` wrote `VACUUM INTO` directly to the
  // real `memory-<ts>.db` name, so a process kill mid-write left a
  // PARTIAL/corrupt file that matched `ROTATED_BACKUP_RE` — indistinguishable
  // from a real, complete, integrity-verified backup to anything that lists
  // the backup dir (retention pruning, an operator restoring from backups).
  // These pin: (1) the leftover a killed run leaves behind never matches the
  // real-backup name shape, (2) it is cleaned up, not silently accumulated,
  // on the next backup call by a DEAD writer — without ever touching a real
  // rotated backup that happens to sit alongside it, and (3) a `.tmp` file
  // whose writer pid is still ALIVE is left alone (the backup dir is shared
  // across sources, so a concurrent live writer's in-progress file must
  // never be swept out from under it).

  // A pid essentially guaranteed not to exist on any real system (max
  // 32-bit signed int + 1 headroom is well past any real pid space) — used
  // to construct a "dead writer" leftover deterministically, without
  // spawning and killing a real child process.
  const DEAD_PID = 2147483646;

  it('[BL-85a62f57] a leftover partial-write temp file from a DEAD writer is swept on the next call and never appears as a rotated backup', async () => {
    // Simulate exactly what a process kill mid-`VACUUM INTO` leaves behind:
    // a `.<pid>.tmp`-suffixed file, partially written, with no
    // corresponding rename ever having happened, whose writer pid no
    // longer exists.
    const staleTmpName = `memory-2020-01-01T00-00-00.000.db.${DEAD_PID}.tmp`;
    const staleTmp = path.join(backupDir, staleTmpName);
    fs.writeFileSync(staleTmp, 'partial VACUUM INTO bytes — process was killed mid-write');

    // Sanity on the naming contract itself: the leftover must NOT match the
    // real rotated-backup pattern that retention/listing code anchors on.
    expect(ROTATED_BACKUP_PATTERN.test(staleTmpName)).toBe(false);

    // A real backup call must both succeed AND sweep the stale partial away
    // — it must never be left to accumulate or be mistaken for a restorable
    // backup.
    const result = await autoBackup(dbPath, { log: () => undefined });
    expect(result.skipped).toBe(false);
    expect(fs.existsSync(staleTmp)).toBe(false);

    const files = fs.readdirSync(backupDir);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);

    const rotated = files.filter((f) => ROTATED_BACKUP_PATTERN.test(f));
    expect(rotated).toHaveLength(1);
    expect(rotated[0]).toBe(path.basename(result.path));
  });

  it('[BL-85a62f57] sweeping a leftover temp file from a dead writer never deletes a real, already-complete rotated backup', async () => {
    // A genuine prior backup (complete, correctly named) coexisting with a
    // stale partial from a separate killed run — the sweep must be
    // name-anchored precisely enough to leave the real one alone.
    const first = await autoBackup(dbPath, { log: () => undefined });
    expect(first.skipped).toBe(false);

    const staleTmp = path.join(backupDir, `memory-2020-01-01T00-00-00.000.db.${DEAD_PID}.tmp`);
    fs.writeFileSync(staleTmp, 'partial bytes');

    // Force mtime forward so the second call is not skipped as a no-op.
    const content = fs.readFileSync(dbPath);
    fs.writeFileSync(dbPath, content);

    const second = await autoBackup(dbPath, { log: () => undefined });
    expect(second.skipped).toBe(false);

    expect(fs.existsSync(staleTmp)).toBe(false); // swept
    expect(fs.existsSync(first.path)).toBe(true); // real backup untouched
    expect(fs.existsSync(second.path)).toBe(true);
  });

  it('[BL-85a62f57] a `.tmp` file whose writer pid is still ALIVE is never swept — a concurrent live backup is not destroyed', async () => {
    // The backup dir is shared across sources (both user and dev-scope
    // stores default to the same `~/.memory/backups`), so a second live
    // process's own in-flight `VACUUM INTO` output can legitimately be
    // sitting here when this call's sweep runs. Use this test process's
    // OWN pid — guaranteed alive for the duration of the test — to stand
    // in for that concurrent live writer.
    const livePid = process.pid;
    const liveTmp = path.join(backupDir, `memory-2020-01-01T00-00-00.000.db.${livePid}.tmp`);
    fs.writeFileSync(liveTmp, 'a concurrent process is still mid-VACUUM-INTO on this file');

    const result = await autoBackup(dbPath, { log: () => undefined });
    expect(result.skipped).toBe(false);

    // Must survive — sweeping it would have destroyed a live concurrent
    // backup.
    expect(fs.existsSync(liveTmp)).toBe(true);
    expect(fs.readFileSync(liveTmp, 'utf8')).toBe(
      'a concurrent process is still mid-VACUUM-INTO on this file',
    );
  });

  it('[BL-85a62f57] a successful backup leaves no `.tmp` file behind — only the final rotated-backup name', async () => {
    const result = await autoBackup(dbPath, { log: () => undefined });
    expect(result.skipped).toBe(false);

    const files = fs.readdirSync(backupDir);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(fs.existsSync(`${result.path}.tmp`)).toBe(false);
    expect(path.basename(result.path)).toMatch(ROTATED_BACKUP_PATTERN);
  });

  // ── BL-85a62f57: the disclosed gap — pin the temp-then-rename WIRING ──────
  //
  // Every test above proves the OUTCOME on the happy path (no `.tmp` left
  // behind) and on the sweep. None of them would catch a regression that
  // reverts the temp-write-then-rename mechanism itself while leaving the
  // sweep in place — i.e. `backupStore()` called with the FINAL
  // `memory-<ts>.db` name directly, no `fs.renameSync` finalize step. On the
  // happy path that regression is invisible (`sweepStaleBackupTempFiles`
  // still runs and finds nothing to sweep, and the direct write still
  // produces a correctly-named file) — it only bites when a shutdown (or any
  // other cause) kills the process mid-`VACUUM INTO`, which is exactly the
  // unbounded-backup scenario `handleDirectStdioShutdown`'s bound exists to
  // cap the damage of. These two tests pin the invariant directly instead of
  // only through its happy-path side effect:
  //   (1) `fs.renameSync` is actually invoked, from a `.tmp`-pattern name to
  //       the real rotated-backup name — the wiring a revert would remove.
  //   (2) when that finalize step fails, NO file matching the real
  //       rotated-backup name pattern exists afterward — the invariant a
  //       revert to a direct final-name write would violate on any
  //       mid/post-write failure, including a process kill.

  it('[BL-85a62f57] autoBackup finalizes via an explicit rename from a `.tmp`-pattern name to the real rotated-backup name — reverting to a direct final-name write removes this call entirely', async () => {
    const calls: unknown[][] = [];
    renameSyncOverride.current = (...args: unknown[]) => {
      calls.push(args);
      return realRenameSyncRef.current!(...args);
    };
    try {
      const result = await autoBackup(dbPath, { log: () => undefined });
      expect(result.skipped).toBe(false);

      // The rename call is the load-bearing evidence: a regression that
      // writes VACUUM INTO straight to the final name never calls
      // fs.renameSync at all, so this assertion is what actually fails RED
      // under that regression (not just an absence-of-.tmp check, which a
      // direct-write regression would trivially also satisfy). The store
      // adapter's own WAL/shm housekeeping also calls renameSync as a side
      // effect of the underlying VACUUM INTO (e.g. renaming a stale `-tshm`
      // sidecar) — that call is unrelated to autoBackup's own finalize step,
      // so we isolate the finalize rename by matching on its destination
      // name rather than assuming it is the only renameSync call observed.
      const finalizeCalls = calls.filter(([, toArg]) =>
        ROTATED_BACKUP_PATTERN.test(path.basename(String(toArg))),
      );
      expect(finalizeCalls).toHaveLength(1);
      const [fromArg, toArg] = finalizeCalls[0]!;
      const fromName = path.basename(String(fromArg));
      const toName = path.basename(String(toArg));
      expect(fromName).toMatch(ROTATED_BACKUP_TMP_PATTERN);
      expect(toName).toMatch(ROTATED_BACKUP_PATTERN);
      expect(toArg).toBe(result.path);
    } finally {
      renameSyncOverride.current = undefined;
    }
  });

  it('[BL-85a62f57] when the finalize rename fails, no file matching the real rotated-backup name exists afterward — the VACUUM INTO output stays under its `.tmp` name (and is cleaned up), never observable as a corrupt "real" backup', async () => {
    renameSyncOverride.current = () => {
      throw new Error('simulated ENOSPC mid-finalize');
    };
    try {
      const result = await autoBackup(dbPath, { log: () => undefined });
      expect(result.skipped).toBe(true);

      // The load-bearing assertion: after a failure at finalize time, NOTHING
      // in the backup dir matches the real rotated-backup name pattern. A
      // regression that writes VACUUM INTO directly to the final name would
      // leave a corrupt-but-real-named file behind right here — the exact
      // failure mode BL-85a62f57 exists to prevent.
      const files = fs.readdirSync(backupDir);
      expect(files.some((f) => ROTATED_BACKUP_PATTERN.test(f))).toBe(false);

      // The current implementation also best-effort cleans up its own .tmp
      // on a finalize failure (it can't in a real process-kill, which is why
      // sweepStaleBackupTempFiles exists as the backstop — covered above);
      // when cleanup itself succeeds, nothing should remain at all.
      expect(files.some((f) => ROTATED_BACKUP_TMP_PATTERN.test(f))).toBe(false);
    } finally {
      renameSyncOverride.current = undefined;
    }
  });
});

describe('pruneRotatedBackups', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-prune-test-'));
    tmpDirs.push(dir);
  });

  function touchBackup(iso: string): void {
    const name = `memory-${iso}.db`;
    fs.writeFileSync(path.join(dir, name), 'x');
  }

  it('keeps the N most recent, deletes the rest, oldest-first', () => {
    touchBackup('2026-08-01T00-00-00.000');
    touchBackup('2026-08-02T00-00-00.000');
    touchBackup('2026-08-03T00-00-00.000');
    touchBackup('2026-08-04T00-00-00.000');

    const deleted = pruneRotatedBackups(dir, 2);

    expect(deleted).toEqual([
      path.join(dir, 'memory-2026-08-01T00-00-00.000.db'),
      path.join(dir, 'memory-2026-08-02T00-00-00.000.db'),
    ]);
    const remaining = fs.readdirSync(dir).sort();
    expect(remaining).toEqual([
      'memory-2026-08-03T00-00-00.000.db',
      'memory-2026-08-04T00-00-00.000.db',
    ]);
  });

  it('does nothing when the count floor is not exceeded', () => {
    touchBackup('2026-08-01T00-00-00.000');
    touchBackup('2026-08-02T00-00-00.000');
    const deleted = pruneRotatedBackups(dir, 5);
    expect(deleted).toEqual([]);
    expect(fs.readdirSync(dir)).toHaveLength(2);
  });

  it('ignores files that do not match the anchored rotated-backup name shape', () => {
    touchBackup('2026-08-01T00-00-00.000');
    fs.writeFileSync(path.join(dir, 'memory-backup-final-v2.db'), 'x');
    fs.writeFileSync(path.join(dir, 'README.md'), 'x');
    const deleted = pruneRotatedBackups(dir, 0);
    expect(deleted).toEqual([path.join(dir, 'memory-2026-08-01T00-00-00.000.db')]);
    const remaining = fs.readdirSync(dir).sort();
    expect(remaining).toEqual(['README.md', 'memory-backup-final-v2.db']);
  });

  it('never throws on a non-existent directory', () => {
    expect(() => pruneRotatedBackups(path.join(dir, 'does-not-exist'), 3)).not.toThrow();
    expect(pruneRotatedBackups(path.join(dir, 'does-not-exist'), 3)).toEqual([]);
  });
});
