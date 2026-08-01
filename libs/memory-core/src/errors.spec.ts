/**
 * errors.spec.ts — Storage error taxonomy tests (WP-2, BL-124).
 *
 * Acceptance:
 *   - forced-lock test: hold an EXCLUSIVE transaction from a second connection,
 *     then write through the queue → E_BUSY (wrapped SqliteError).
 *   - No SqliteError string reaches a caller (all wrapped to CONTRACTS §B).
 *   - Negative control: lock released → write succeeds.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { WriteQueue } from './write-queue.js';
import { wrapDbError } from './errors.js';
import type { StorageError } from './errors.js';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'err-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('Storage error taxonomy — CONTRACTS §B (WP-2)', () => {
  let cleanup: () => void;
  let dbPath: string;

  beforeEach(async () => {
    const t = tmpDir();
    cleanup = t.cleanup;
    dbPath = path.join(t.dir, 'test.db');
    await WriteQueue.clearInstances();
    WriteQueue.setBypass(false);
  });

  afterEach(async () => {
    await WriteQueue.clearInstances();
    cleanup();
  });

  /**
   * Combined positive + negative control in one test:
   *   1. Hold EXCLUSIVE lock → write fails with E_BUSY (wrapped)
   *   2. Release lock → same write succeeds
   *
   * This avoids state leakage across separate tests and proves both the
   * wrapped-error path AND the success path on the same queue instance.
   */
  it('forced-lock → E_BUSY (wrapped); unlock → success', async () => {
    const queue = await WriteQueue.forPath(dbPath);
    const blocker = new Database(dbPath);
    let blockerClosed = false;

    try {
      // ── Part 1: EXCLUSIVE lock held → write yields E_BUSY ──────────
      blocker.exec('BEGIN EXCLUSIVE');

      const locked = await queue
        .enqueue('locked-write', async (tx) => {
          await tx.executeRun(
            'INSERT INTO node (uid, kind, content, t_created) VALUES (?,?,?,?)',
            ['lock-test', 'episode', 'locked', new Date().toISOString()],
          );
          return 'inserted';
        })
        .then(
          (v) => ({ ok: true as const, value: v }),
          (err) => ({ ok: false as const, error: err as StorageError }),
        );

      expect(locked.ok).toBe(false);
      if (locked.ok) throw new Error('expected the locked write to fail with E_BUSY');
      expect(locked.error.code).toBe('E_BUSY');
      expect(locked.error.retryable).toBe(true);
      expect(locked.error.retry_after_ms).toBe(250);

      // Verify NO raw SqliteError/SQLITE_BUSY string leaked into the tool surface
      const errJson = JSON.stringify(locked.error);
      expect(errJson).not.toContain('SqliteError');
      expect(errJson).not.toContain('SQLITE_BUSY');

      // Release the lock
      blocker.exec('ROLLBACK');
      blocker.close();
      blockerClosed = true;
    } finally {
      if (!blockerClosed) {
        try { blocker.exec('ROLLBACK'); } catch { /* ignore */ }
        blocker.close();
      }
    }

    // ── Part 2: Lock released → write succeeds ──────────────────────
    const unlocked = await queue
      .enqueue('unlocked-write', async (tx) => {
        await tx.executeRun(
          'INSERT INTO node (uid, kind, content, t_created) VALUES (?,?,?,?)',
          ['unlock-test', 'episode', 'unlocked', new Date().toISOString()],
        );
        return 'ok';
      })
      .then(
        (v) => ({ ok: true as const, value: v }),
        (err) => ({ ok: false as const, error: err as StorageError }),
      );

    expect(unlocked.ok).toBe(true);
    if (!unlocked.ok) throw new Error('expected the unlocked write to succeed');
    expect(unlocked.value).toBe('ok');
  });

  /**
   * Negative control: fresh queue, no lock → write succeeds immediately.
   */
  it('negative control: no lock → write succeeds', async () => {
    const { dir: otherDir, cleanup: otherCleanup } = tmpDir();
    try {
      const otherDb = path.join(otherDir, 'other.db');
      const queue = await WriteQueue.forPath(otherDb);

      const val = await queue.enqueue('free-write', async (tx) => {
        await tx.executeRun(
          'INSERT INTO node (uid, kind, content, t_created) VALUES (?,?,?,?)',
          ['free-test', 'episode', 'free', new Date().toISOString()],
        );
        return 'ok';
      });
      expect(val).toBe('ok');
    } finally {
      await WriteQueue.clearInstances();
      otherCleanup();
    }
  });

  /**
   * wrapDbError directly: verify known SqliteError codes map correctly.
   */
  it('wrapDbError maps SQLITE_BUSY → E_BUSY', () => {
    const sqlErr = new (class extends Error {
      code = 'SQLITE_BUSY';
      constructor() {
        super('database is locked');
      }
    })();
    const wrapped: StorageError = wrapDbError(sqlErr);
    expect(wrapped.code).toBe('E_BUSY');
    expect(wrapped.retryable).toBe(true);
    expect(wrapped.retry_after_ms).toBe(250);
  });

  it('wrapDbError maps SQLITE_IOERR → E_IO', () => {
    const sqlErr = new (class extends Error {
      code = 'SQLITE_IOERR';
      constructor() {
        super('disk I/O error');
      }
    })();
    const wrapped = wrapDbError(sqlErr);
    expect(wrapped.code).toBe('E_IO');
    expect(wrapped.retryable).toBe(false);
  });

  it('wrapDbError maps SQLITE_CONSTRAINT → E_DEDUP', () => {
    const sqlErr = new (class extends Error {
      code = 'SQLITE_CONSTRAINT';
      constructor() {
        super('UNIQUE constraint failed');
      }
    })();
    const wrapped = wrapDbError(sqlErr);
    expect(wrapped.code).toBe('E_DEDUP');
    expect(wrapped.retryable).toBe(false);
  });

  it('wrapDbError passes through existing StorageError', () => {
    const existing: StorageError = {
      code: 'E_BUSY',
      message: 'queue full',
      retryable: true,
      retry_after_ms: 250,
    };
    const wrapped = wrapDbError(existing);
    expect(wrapped).toBe(existing);
  });

  it('wrapDbError wraps unknown errors as E_IO', () => {
    const wrapped = wrapDbError('string error');
    expect(wrapped.code).toBe('E_IO');
    expect(wrapped.retryable).toBe(false);
  });
});
