/**
 * chaos/disk-full.chaos.spec.ts — HF-1 Chaos Scenario 2
 *
 * SCENARIO: disk-full → structured E_IO.
 *
 * Constrains the database with `PRAGMA max_page_count` to just above its
 * current allocated page count, then issues a write. The write must:
 *   1. Fail with a CONTRACTS §B E_IO-class error (code: 'E_IO').
 *   2. Leave the store integrity-clean (PRAGMA integrity_check == 'ok').
 *   3. Leave no half-written node/vec/fts rows (all-or-nothing).
 *
 * NEGATIVE CONTROL (NC):
 *   Without `max_page_count` enforcement (i.e. if we skip setting the pragma
 *   or set it to a very high value), the write succeeds and no E_IO is raised.
 *   The NC test removes the page-count constraint and asserts the write
 *   SUCCEEDS — proving the guard is the load-bearing element.
 *
 *   NC is encoded as a SKIPPED test below. To activate:
 *   Change `it.skip` → `it` to observe that the disk-full assertion goes RED
 *   (the write succeeds instead of failing with E_IO).
 *
 * Gate: npx nx test memory-core --skip-nx-cache
 */

// ─── NC TOGGLE ────────────────────────────────────────────────────────────────
// The negative control removes the max_page_count constraint.
// With the constraint removed, writes succeed → the E_IO assertion fails (RED).
// To activate: change `it.skip` → `it` in the NC test at the bottom.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { WriteQueue } from '../write-queue.js';
import { _resetAllLeasesForTest } from '../lease.js';
import { wrapDbError } from '../errors.js';

// Helper: create a fresh temp dir for a chaos store (NOT ~/.memory)
function tmpChaosDir(): { dir: string; dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chaos-diskfull-'));
  const dbPath = path.join(dir, 'chaos.db');
  return {
    dir,
    dbPath,
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

/** Open a fresh WAL database, load sqlite-vec, apply mandatory pragmas. */
function openChaosDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  sqliteVec.load(db);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 3000;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

/** Seed a minimal schema and enough rows to consume several pages. */
function seedDb(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS chaos_nodes (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    uid   TEXT UNIQUE NOT NULL,
    data  TEXT NOT NULL
  )`);
  // Insert enough rows to take up space — we need to know where page_count is
  const stmt = db.prepare("INSERT INTO chaos_nodes (uid, data) VALUES (?, ?)");
  for (let i = 0; i < 50; i++) {
    stmt.run(`uid-${i}`, 'A'.repeat(256));
  }
  // Checkpoint to move WAL into main file so page_count is accurate
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

afterEach(async () => {
  await WriteQueue.clearInstances();
  _resetAllLeasesForTest();
});

describe('HF-1 Chaos: disk-full via max_page_count → E_IO structured error + integrity', () => {

  it('write past max_page_count fails with E_IO and store stays integrity-clean', async () => {
    const { dbPath, cleanup } = tmpChaosDir();

    try {
      // ── Phase 1: seed the store ─────────────────────────────────────────
      const db = openChaosDb(dbPath);
      seedDb(db);

      // Read current page_count AFTER seeding + checkpoint
      const pcRow = db.prepare<[], { page_count: number }>('PRAGMA page_count').get();
      const currentPageCount = pcRow!.page_count;
      expect(currentPageCount).toBeGreaterThan(0);

      // Record row count BEFORE the constrained write attempt
      const beforeCountRow = db.prepare<[], { cnt: number }>(
        'SELECT COUNT(*) as cnt FROM chaos_nodes',
      ).get();
      const rowsBefore = beforeCountRow!.cnt;

      // Set max_page_count to current + 2 pages of headroom
      // (2 pages ≈ 8 KiB; a large INSERT needs more than that)
      const maxPages = currentPageCount + 2;
      db.exec(`PRAGMA max_page_count = ${maxPages}`);

      // Verify the constraint is active
      const mpRow = db.prepare<[], { max_page_count: number }>('PRAGMA max_page_count').get();
      expect(mpRow!.max_page_count).toBe(maxPages);

      // ── Phase 2: attempt a large write (must exceed max_page_count) ─────
      // Each row is ~4 KiB; a batch of 100 rows will definitely need new pages
      let caught: unknown = null;
      try {
        db.transaction(() => {
          const ins = db.prepare("INSERT INTO chaos_nodes (uid, data) VALUES (?, ?)");
          for (let i = 0; i < 100; i++) {
            ins.run(`overflow-${i}`, 'B'.repeat(4096));
          }
        })();
      } catch (err) {
        caught = err;
      }

      // ── Step 1: the write MUST fail ─────────────────────────────────────
      expect(caught).not.toBeNull();

      // Step 1a: wrap via errors.ts into CONTRACTS §B shape
      const wrapped = wrapDbError(caught);
      expect(wrapped.code).toBe('E_IO');
      expect(wrapped.retryable).toBe(false);
      expect(typeof wrapped.message).toBe('string');
      expect(wrapped.message.length).toBeGreaterThan(0);

      // ── Step 2: store stays integrity-clean ─────────────────────────────
      // Remove the page count constraint before running integrity_check
      // (otherwise the check itself might fail due to constrained page reads)
      db.exec('PRAGMA max_page_count = 2147483646'); // SQLite max

      const integrityRows = db
        .prepare<[], { integrity_check: string }>('PRAGMA integrity_check')
        .all();
      expect(integrityRows).toHaveLength(1);
      expect(integrityRows[0]?.integrity_check).toBe('ok');

      // ── Step 3: no half-written rows (transaction rolled back) ──────────
      const afterCountRow = db.prepare<[], { cnt: number }>(
        'SELECT COUNT(*) as cnt FROM chaos_nodes',
      ).get();
      const rowsAfter = afterCountRow!.cnt;

      // Row count must equal pre-attempt count (all-or-nothing transaction)
      expect(rowsAfter).toBe(rowsBefore);

      db.close();

    } finally {
      cleanup();
    }
  }, 15_000);

  /**
   * NEGATIVE CONTROL — skipped in normal CI.
   *
   * Purpose: demonstrate that WITHOUT the max_page_count constraint, a large
   * write SUCCEEDS — proving the constraint is the load-bearing guard.
   *
   * What this test does (when un-skipped):
   *   1. Seeds the store (same as the positive test).
   *   2. Does NOT set max_page_count (or sets it very high).
   *   3. Issues the same large write.
   *   4. Asserts the write SUCCEEDS (no error).
   *
   * This goes RED under the positive test's assertion (`expect(caught).not.toBeNull()`),
   * confirming that removing the guard breaks the E_IO guarantee.
   *
   * To activate: change `it.skip` → `it` and run:
   *   npx nx test memory-core --skip-nx-cache
   * Observe: the large write succeeds and no E_IO is raised.
   */
  it.skip('[NC] negative control: without max_page_count, write succeeds (E_IO guard removed)', async () => {
    const { dbPath, cleanup } = tmpChaosDir();

    try {
      const db = openChaosDb(dbPath);
      seedDb(db);

      // NC: deliberately NOT setting max_page_count
      // The DB can grow freely → the large write succeeds
      let caught: unknown = null;
      try {
        db.transaction(() => {
          const ins = db.prepare("INSERT INTO chaos_nodes (uid, data) VALUES (?, ?)");
          for (let i = 0; i < 100; i++) {
            ins.run(`nc-overflow-${i}`, 'B'.repeat(4096));
          }
        })();
      } catch (err) {
        caught = err;
      }

      // NC assertion: no error (write succeeds because no constraint)
      // This is the RED state from the positive test's perspective.
      expect(caught).toBeNull(); // write succeeds → positive test would FAIL here

      db.close();
    } finally {
      cleanup();
    }
  }, 15_000);
});
