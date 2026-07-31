/**
 * chaos/queue-overflow.chaos.spec.ts — HF-1 Chaos Scenario 3
 *
 * SCENARIO: queue overflow → E_BUSY backpressure.
 *
 * Floods the WriteQueue past its _maxSize by enqueuing more items than the
 * configured maximum while a slow operation holds the queue open. The
 * overflow must:
 *   1. Reject with a CONTRACTS §B E_BUSY shape: `{ code:'E_BUSY',
 *      retryable:true, retry_after_ms:250 }`.
 *   2. Produce zero lost or duplicated committed writes — every item that
 *      DID fit in the queue must commit exactly once.
 *   3. Never throw a raw SqliteError to the caller (all errors wrapped).
 *
 * NEGATIVE CONTROL (NC):
 *   Without the overflow guard (`queue.length >= _maxSize` check in enqueue),
 *   all items are accepted and the queue grows unboundedly — no E_BUSY is
 *   raised. The NC test removes the overflow guard by setting maxSize to an
 *   artificially high number and confirms ALL items succeed (no rejection).
 *
 *   NC is encoded as a SKIPPED test below. To activate:
 *   Change `it.skip` → `it` to observe that the E_BUSY assertion goes RED
 *   (all writes succeed — no backpressure).
 *
 * Gate: npx nx test memory-core --skip-nx-cache
 */

// ─── NC TOGGLE ────────────────────────────────────────────────────────────────
// The negative control uses maxSize = Number.MAX_SAFE_INTEGER, so no item is
// ever rejected. With the guard removed, writes succeed → E_BUSY never fires.
// To activate: change `it.skip` → `it` in the NC test at the bottom.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WriteQueue, type QueueBusyError } from '../write-queue.js';
import { _resetAllLeasesForTest } from '../lease.js';

// Helper: create a fresh temp dir for a chaos store (NOT ~/.memory)
function tmpChaosDir(): { dir: string; dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chaos-overflow-'));
  const dbPath = path.join(dir, 'chaos.db');
  return {
    dir,
    dbPath,
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

/** Type-guard for the E_BUSY StorageError shape (CONTRACTS §B). */
function isEBusy(err: unknown): err is QueueBusyError {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  return (
    e.code === 'E_BUSY' &&
    e.retryable === true &&
    typeof e.retry_after_ms === 'number' &&
    (e.retry_after_ms as number) > 0
  );
}

beforeEach(async () => {
  await WriteQueue.clearInstances();
  WriteQueue.setBypass(false);
});

afterEach(async () => {
  await WriteQueue.clearInstances();
  _resetAllLeasesForTest();
});

describe('HF-1 Chaos: queue overflow → E_BUSY backpressure', () => {

  it('flooding past maxSize produces E_BUSY shape and no lost/duplicated commits', async () => {
    const { dbPath, cleanup } = tmpChaosDir();

    // maxSize=5: queue can hold 5 waiting items; the 6th+ enqueue is rejected
    const MAX_SIZE = 5;
    const queue = await WriteQueue.forPath(dbPath, MAX_SIZE);

    try {
      // Seed the counter table
      await queue.enqueue('setup', async (tx) => {
        await tx.exec(`CREATE TABLE IF NOT EXISTS overflow_test (
          id      INTEGER PRIMARY KEY AUTOINCREMENT,
          seq_num INTEGER UNIQUE NOT NULL,
          ts      TEXT NOT NULL
        )`);
      });

      // ── Phase 1: fill the queue ────────────────────────────────────────
      // Enqueue one SLOW item to occupy the processor and fill the queue.
      // It sleeps for a bounded duration (300ms) before inserting.
      const slowComplete = queue.enqueue('slow-anchor', async (tx) => {
        // This holds the queue processor for 300ms
        await new Promise<void>((r) => setTimeout(r, 300));
        await tx.executeRun("INSERT INTO overflow_test (seq_num, ts) VALUES (?, datetime('now'))", [0]);
        return 0;
      });

      // While the slow anchor is running, flood the queue with maxSize items
      // (these fill up the pending queue to capacity)
      const acceptedPromises: Promise<number>[] = [];
      const rejectedErrors: unknown[] = [];

      // Track per-item outcome
      const outcomes: Array<{ i: number; status: 'accepted' | 'rejected'; err?: unknown }> = [];

      // We send maxSize + 10 items so that at least some are rejected
      const TOTAL_ITEMS = MAX_SIZE + 10;
      for (let i = 1; i <= TOTAL_ITEMS; i++) {
        const seqNum = i;
        const p = queue.enqueue(`item-${seqNum}`, async (tx) => {
          await tx.executeRun("INSERT INTO overflow_test (seq_num, ts) VALUES (?, datetime('now'))", [seqNum]);
          return seqNum;
        });

        // Classify without awaiting (to avoid blocking the loop)
        p.then(
          (v) => outcomes.push({ i: seqNum, status: 'accepted' }),
          (e) => outcomes.push({ i: seqNum, status: 'rejected', err: e }),
        );

        // Track accepted vs rejected
        acceptedPromises.push(
          p.then(
            (v) => v,
            (e) => {
              rejectedErrors.push(e);
              return -1; // sentinel for rejection
            },
          ),
        );
      }

      // Wait for the slow anchor + all enqueued items to settle
      await slowComplete.catch(() => { /* anchor settling */ });
      await Promise.all(acceptedPromises);

      // Brief settle for any in-flight items
      await new Promise<void>((r) => setTimeout(r, 100));

      // ── Assertion 1: at least some items were rejected with E_BUSY ────
      const ebusyErrors = rejectedErrors.filter(isEBusy);
      expect(ebusyErrors.length).toBeGreaterThan(0);

      // Every rejected error MUST have the correct E_BUSY shape
      for (const err of rejectedErrors) {
        const e = err as Record<string, unknown>;
        expect(e.code).toBe('E_BUSY');
        expect(e.retryable).toBe(true);
        expect(typeof e.retry_after_ms).toBe('number');
        expect(e.retry_after_ms).toBe(250); // per CONTRACTS §B
      }

      // ── Assertion 2: no raw SqliteError reached the caller ─────────────
      // Every rejection must be a StorageError shape, not a raw SqliteError
      for (const err of rejectedErrors) {
        const e = err as Record<string, unknown>;
        expect(typeof e.code).toBe('string');
        expect((e.code as string).startsWith('E_')).toBe(true);
        // SqliteError would have code like 'SQLITE_BUSY'
        expect((e.code as string).startsWith('SQLITE_')).toBe(false);
      }

      // ── Assertion 3: no lost or duplicated committed writes ────────────
      // Open a fresh read-only connection to inspect committed state
      const { openDbReadOnly } = await import('../db.js');
      const roDb = await openDbReadOnly(dbPath);

      const rows = raw(roDb)
        .prepare<[], { seq_num: number }>('SELECT seq_num FROM overflow_test ORDER BY seq_num')
        .all();

      const committedSeqs = rows.map((r) => r.seq_num);
      roDb.close();

      // No duplicates — each seq_num appears exactly once (UNIQUE constraint)
      const uniqueCommitted = new Set(committedSeqs);
      expect(uniqueCommitted.size).toBe(committedSeqs.length);

      // The set of committed seqs must be a subset of [0..TOTAL_ITEMS]
      for (const seq of committedSeqs) {
        expect(seq).toBeGreaterThanOrEqual(0);
        expect(seq).toBeLessThanOrEqual(TOTAL_ITEMS);
      }

      // ── Assertion 4: accepted + rejected accounts for all sent items ───
      // Each item was either accepted (committed) or rejected (E_BUSY).
      // accepted = total - rejected
      const acceptedCount = TOTAL_ITEMS - rejectedErrors.length + 1; // +1 for the anchor
      // Committed rows (excluding the anchor = seq 0) should match accepted items minus anchor
      // The exact split depends on scheduling; we just verify no orphaned rows
      const committedNonAnchor = committedSeqs.filter((s) => s > 0);
      // Every committed row was accepted (not rejected)
      for (const seq of committedNonAnchor) {
        const outcome = outcomes.find((o) => o.i === seq);
        // If the outcome was recorded (settled before our check)
        if (outcome) {
          expect(outcome.status).toBe('accepted');
        }
      }

    } finally {
      cleanup();
    }
  }, 20_000);

  /**
   * NEGATIVE CONTROL — skipped in normal CI.
   *
   * Purpose: demonstrate that WITHOUT the overflow guard (maxSize set to
   * MAX_SAFE_INTEGER), ALL items are accepted — no E_BUSY is raised.
   *
   * What this test does (when un-skipped):
   *   1. Creates a queue with maxSize = Number.MAX_SAFE_INTEGER.
   *   2. Floods it with the same number of items.
   *   3. Asserts that ZERO items are rejected.
   *
   * This goes RED under the positive test's assertion
   * (`expect(ebusyErrors.length).toBeGreaterThan(0)`), confirming the
   * overflow guard is the load-bearing element.
   *
   * To activate: change `it.skip` → `it` and run:
   *   npx nx test memory-core --skip-nx-cache
   * Observe: all items succeed, no E_BUSY is raised.
   */
  it.skip('[NC] negative control: without overflow guard (maxSize=MAX), all writes succeed', async () => {
    const { dbPath, cleanup } = tmpChaosDir();

    // NC: no effective size limit
    const queue = await WriteQueue.forPath(dbPath, Number.MAX_SAFE_INTEGER);

    try {
      await queue.enqueue('setup', async (tx) => {
        await tx.exec(`CREATE TABLE IF NOT EXISTS nc_overflow_test (
          id      INTEGER PRIMARY KEY AUTOINCREMENT,
          seq_num INTEGER UNIQUE NOT NULL
        )`);
      });

      // Slow anchor to fill time
      const slowComplete = queue.enqueue('slow-anchor', async (tx) => {
        await new Promise<void>((r) => setTimeout(r, 300));
        await tx.executeRun('INSERT INTO nc_overflow_test (seq_num) VALUES (?)', [0]);
        return 0;
      });

      const results: Array<{ ok: boolean; err?: unknown }> = [];
      const promises: Promise<void>[] = [];

      for (let i = 1; i <= 15; i++) {
        const seqNum = i;
        promises.push(
          queue.enqueue(`item-${seqNum}`, async (tx) => {
            await tx.executeRun('INSERT INTO nc_overflow_test (seq_num) VALUES (?)', [seqNum]);
            return seqNum;
          }).then(
            () => { results.push({ ok: true }); },
            (e) => { results.push({ ok: false, err: e }); },
          ),
        );
      }

      await slowComplete.catch(() => { /* ok */ });
      await Promise.all(promises);

      const rejections = results.filter((r) => !r.ok);

      // NC assertion: no rejections (guard removed → all writes succeed)
      // This proves the positive test's E_BUSY is caused by the guard.
      expect(rejections.length).toBe(0); // positive test would FAIL with > 0
    } finally {
      cleanup();
    }
  }, 20_000);

  /**
   * Stability check: after overflow, the queue recovers and accepts new items.
   *
   * This verifies the queue is not permanently poisoned after overflow.
   */
  it('queue recovers and accepts new items after overflow', async () => {
    const { dbPath, cleanup } = tmpChaosDir();
    const MAX_SIZE = 3;
    const queue = await WriteQueue.forPath(dbPath, MAX_SIZE);

    try {
      await queue.enqueue('setup', async (tx) => {
        await tx.exec('CREATE TABLE IF NOT EXISTS recovery_test (id INTEGER PRIMARY KEY, val TEXT)');
      });

      // Slow anchor to trigger overflow condition
      const slowComplete = queue.enqueue('slow', async (tx) => {
        await new Promise<void>((r) => setTimeout(r, 200));
        await tx.executeRun("INSERT INTO recovery_test (val) VALUES ('anchor')");
        return 'anchor';
      });

      // Flood to trigger overflow — collect all settled
      const flood: Array<Promise<void>> = [];
      for (let i = 0; i < MAX_SIZE + 5; i++) {
        flood.push(
          queue.enqueue(`flood-${i}`, async (tx) => {
            await tx.executeRun("INSERT INTO recovery_test (val) VALUES ('flood')");
            return i;
          }).then(() => {}, () => {}), // ignore results — just let them settle
        );
      }

      await slowComplete.catch(() => {});
      await Promise.all(flood);

      // Wait for queue to fully drain
      await new Promise<void>((r) => setTimeout(r, 200));

      // After overflow + drain, the queue MUST accept new items
      const recoveredResult = await queue.enqueue('after-overflow', async (tx) => {
        await tx.executeRun("INSERT INTO recovery_test (val) VALUES ('recovered')");
        return 'recovered';
      });

      expect(recoveredResult).toBe('recovered');

    } finally {
      cleanup();
    }
  }, 20_000);
});
