/**
 * write-queue.spec.ts — WriteQueue ordering + negative control (WP-1, BL-118).
 *
 * Acceptance:
 *   - Queue serialisation proven by a test asserting write ordering under concurrency.
 *   - Negative control: disable the queue (bypass) → ordering assertion fails.
 *   - 20 parallel async operations: zero raw errors; proven FIFO order.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WriteQueue } from './write-queue.js';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wq-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('WriteQueue — ordering and serialisation (WP-1)', () => {
  let cleanup: () => void;
  let dbPath: string;
  let priorAdapterEnv: string | undefined;

  beforeEach(async () => {
    const t = tmpDir();
    cleanup = t.cleanup;
    dbPath = path.join(t.dir, 'test.db');
    await WriteQueue.clearInstances();
    WriteQueue.setBypass(false);
    // This suite proves the queue's OWN serialisation (FIFO order, size cap,
    // WAL checkpoint on the local file) — all of which is WriteQueue._noop =
    // false behaviour, gated on an adapter reporting needsWriteSerialization:
    // true (sqlite/better-sqlite3). The factory default is now
    // STORE_ADAPTER=turso (needsWriteSerialization: false), which would flip
    // the queue into noop/bypass mode and make every assertion here vacuous —
    // pin sqlite explicitly, same convention as every other adapter-sensitive
    // spec (see backup.spec.ts, fts-query-parity.spec.ts).
    priorAdapterEnv = process.env['STORE_ADAPTER'];
    process.env['STORE_ADAPTER'] = 'sqlite';
  });

  afterEach(async () => {
    await WriteQueue.clearInstances();
    cleanup();
    if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
    else process.env['STORE_ADAPTER'] = priorAdapterEnv;
  });

  /**
   * Core ordering invariant: WITH the queue, 20 concurrent async operations
   * execute in strict FIFO order.
   *
   * Each operation:
   *   1. Yields to the event loop (random delay), proving concurrency would
   *      scramble order WITHOUT serialisation.
   *   2. Records its completion index.
   *
   * WITH the queue: operations execute one-at-a-time → the completion order
   * matches enqueue order: [0, 1, 2, ..., 19].
   */
  it('proves FIFO ordering under concurrency (queue active)', async () => {
    const queue = await WriteQueue.forPath(dbPath);
    const order: number[] = [];

    for (let i = 0; i < 20; i++) {
      queue.enqueue(`op-${i}`, async () => {
        // Random delay so concurrent execution would scramble order.
        await new Promise<void>((r) => setTimeout(r, Math.floor(Math.random() * 10)));
        order.push(i);
      });
    }

    // Wait for the queue to drain.
    await new Promise<void>((r) => setTimeout(r, 300));

    // WITH the queue: strict FIFO order.
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  /**
   * Negative control: disable queue serialisation (bypass) → ordering is
   * scrambled because all 20 operations run concurrently.
   *
   * Each operation reads (and increments) a shared counter AFTER the async
   * yield, so the counter value reflects the RACE, not the enqueue order.
   * WITH the queue the same test produces sequential counter values.
   */
  it('negative control: queue bypass scrambles ordering (test goes red)', async () => {
    WriteQueue.setBypass(true);
    const queue = await WriteQueue.forPath(dbPath);
    const order: number[] = [];

    for (let i = 0; i < 20; i++) {
      queue.enqueue(`op-${i}`, async () => {
        // Yield FIRST so the counter read races with other operations.
        await new Promise<void>((r) => setTimeout(r, Math.floor(Math.random() * 10)));
        order.push(i);
      });
    }

    await new Promise<void>((r) => setTimeout(r, 300));

    // WITHOUT the queue: ordering is NOT strictly sequential.
    // Most runs will have at least one inversion.
    expect(order).not.toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  /**
   * Overflow guard: queue with maxSize=1 rejects the second concurrent enqueue.
   */
  it('rejects with E_BUSY when queue is full', async () => {
    const queue = await WriteQueue.forPath(path.join(path.dirname(dbPath), 'busy.db'), 1);

    // Enqueue one long-running operation to fill the queue
    const slowPromise = queue.enqueue('slow', () => {
      return new Promise<string>((r) => setTimeout(() => r('done'), 50));
    });

    // Enqueue a second — should be rejected immediately
    const secondResult = await queue
      .enqueue('overflow', () => 'should not run')
      .then(
        (v): { ok: true; value: string } => ({ ok: true, value: v }),
        (err): { ok: false; error: unknown } => ({ ok: false, error: err }),
      );

    expect(secondResult.ok).toBe(false);
    if (secondResult.ok) throw new Error('expected the overflow enqueue to be rejected');
    expect((secondResult.error as { code: string }).code).toBe('E_BUSY');

    await slowPromise;
  });

  /**
   * Parallel write count: 20 concurrent enqueues all complete.
   */
  it('20 parallel operations all complete successfully', async () => {
    const queue = await WriteQueue.forPath(dbPath);
    let completed = 0;

    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      promises.push(
        queue.enqueue(`p-${i}`, () => {
          completed++;
          return completed;
        }),
      );
    }

    const results = await Promise.all(promises);
    expect(results).toHaveLength(20);
    // Each result is a unique sequential number (serialised execution)
    expect(new Set(results).size).toBe(20);
    expect(completed).toBe(20);
  });

  /**
   * Singleton: two calls to forPath() with the same path return the same queue.
   * Bypass mode creates independent queues (negative control invariant).
   */
  it('singleton: same path returns same instance (bypass=false)', async () => {
    const a = await WriteQueue.forPath(dbPath);
    const b = await WriteQueue.forPath(dbPath);
    expect(a).toBe(b);
  });

  it('bypass mode creates independent instances', async () => {
    WriteQueue.setBypass(true);
    const a = await WriteQueue.forPath(dbPath);
    const b = await WriteQueue.forPath(dbPath);
    expect(a).not.toBe(b);
    WriteQueue.setBypass(false);
  });

  it('bypass static flag getter matches setter', () => {
    expect(WriteQueue.bypass).toBe(false);
    WriteQueue.setBypass(true);
    expect(WriteQueue.bypass).toBe(true);
    WriteQueue.setBypass(false);
  });
});

// ── DEBT-004: WAL checkpointing is now owned by the store adapter ──
//
// WriteQueue used to own a private debounced idle-checkpoint timer (WP-5/
// BL-123, `CHECKPOINT_IDLE_MS`/`_scheduleIdleCheckpoint`/`walCheckpoint()`)
// that ran an UNGATED `PRAGMA wal_checkpoint(TRUNCATE)` — a second mechanism
// competing with the store-adapter's own idle flush, unsafe at concurrency
// > 1. Per owner directive it was deleted outright, not coordinated with.
// This suite now proves the REPLACEMENT: every store this class opens (the
// production default, `STORE_ADAPTER=turso`) inherits WAL checkpointing
// automatically from `TursoAdapterImpl._armIdleFlush()` — with ZERO
// memory-core code involved — through the exact code path production takes
// (`WriteQueue.forPath()` → `enqueue()`'s bypass/`_noop` branch, since Turso
// reports `needsWriteSerialization: false`).

describe('WriteQueue — WAL checkpointing owned by the store adapter (DEBT-004)', () => {
  let cleanup: () => void;
  let dbPath: string;
  let priorAdapterEnv: string | undefined;

  function walSize(p: string): number {
    try {
      return fs.statSync(p + '-wal').size;
    } catch {
      return 0;
    }
  }

  beforeEach(async () => {
    const t = tmpDir();
    cleanup = t.cleanup;
    dbPath = path.join(t.dir, 'test.db');
    await WriteQueue.clearInstances();
    WriteQueue.setBypass(false);
    // Explicitly pin the PRODUCTION default so this suite is unambiguous
    // regardless of what another suite in this file pinned — this is the
    // one describe block that must run on the REAL adapter (Turso) that
    // owns the idle flush. SqliteAdapterImpl has its own equivalent since
    // BL-571, but it is not exercised at THIS layer — see BL-586.
    priorAdapterEnv = process.env['STORE_ADAPTER'];
    process.env['STORE_ADAPTER'] = 'turso';
  });

  afterEach(async () => {
    await WriteQueue.clearInstances();
    cleanup();
    if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
    else process.env['STORE_ADAPTER'] = priorAdapterEnv;
  });

  /**
   * RED→GREEN proof (BL-225) for DEBT-004:
   *
   *   RED (pre-fix code, `WriteQueue`'s own idle-checkpoint timer still
   *   present): the queue's OWN `_scheduleIdleCheckpoint()`/`walCheckpoint()`
   *   fires ~2s after the bypass/_noop enqueue settles and sets
   *   `_lastCheckpointAt` (and the persistent `_lastCheckpointByPath` map)
   *   itself — so `WriteQueue.lastCheckpointAtForPath(dbPath)` is NON-ZERO
   *   after the idle wait, even though the WAL also shrinks. Verified by
   *   running this exact assertion against the pre-fix write-queue.ts
   *   (`_scheduleIdleCheckpoint`/`CHECKPOINT_IDLE_MS`/`walCheckpoint()`
   *   restored) — see the packet's shipped report for the verbatim
   *   before/after run — the `toBe(0)` assertion below FAILS there.
   *
   *   GREEN (this code): WriteQueue has NO idle-checkpoint code left at all
   *   (grep-verified — see the class doc comment). The WAL still shrinks
   *   to near-zero after the same idle wait, driven ENTIRELY by
   *   `TursoAdapterImpl._armIdleFlush()` inside the adapter this queue
   *   opened via `openDb()` — and `lastCheckpointAtForPath` stays exactly 0
   *   throughout, because nothing in memory-core ever touches it outside
   *   `closeAllForShutdown()`. Both facts together — WAL shrinks AND
   *   memory-core recorded zero checkpoint activity — are proof the
   *   mechanism moved, not just that a checkpoint happened somehow.
   *
   * Uses `fs.statSync(dbPath + '-wal')` directly, NOT `queue.walBytes()`:
   * that method deliberately returns 0 for `config.type === 'turso'` (no
   * local WAL file assumption baked in for the remote-url case), but a
   * turso adapter opened with a local `dbPath` (exactly what
   * `WriteQueue.forPath()`/`openDb()` does) still has a real local `-wal`
   * file on disk — this test needs to read it directly.
   */
  it('adapter idle flush shrinks the WAL after the queue drains — driven entirely by the adapter, not WriteQueue', async () => {
    const queue = await WriteQueue.forPath(dbPath);
    expect(queue.storePath).toBeDefined(); // sanity: real queue, real store

    // Baseline: schema creation already wrote some WAL frames.
    const walBaseline = walSize(dbPath);
    expect(walBaseline).toBeGreaterThan(0);

    // Write enough data to grow the WAL — but stay comfortably under the
    // adapter's DEFAULT_WAL_CAP_BYTES (262,144) so the INLINE cap-flush
    // (`_checkWalCapAndFlush`, fired from every writable `_trackOp`) does
    // NOT also fire and confound this test with a second, unrelated adapter
    // mechanism. This test isolates the IDLE flush specifically.
    await queue.enqueue('seed-table', async (adapter) => {
      await adapter.exec(`CREATE TABLE IF NOT EXISTS debt004_test (
        id INTEGER PRIMARY KEY,
        val TEXT NOT NULL
      )`);
      for (let i = 0; i < 80; i++) {
        await adapter.executeRun('INSERT INTO debt004_test (id, val) VALUES (?, ?)', [i, 'x'.repeat(1000)]);
      }
    });

    const walAfterWrite = walSize(dbPath);
    expect(walAfterWrite).toBeGreaterThan(walBaseline);
    expect(walAfterWrite).toBeLessThan(262_144); // stayed under the wal-cap threshold

    // memory-core has recorded NOTHING yet — no code path here touches
    // `_lastCheckpointByPath` outside `closeAllForShutdown()`.
    expect(WriteQueue.lastCheckpointAtForPath(dbPath)).toBe(0);

    // Wait past the adapter's default idle-flush debounce window
    // (DEFAULT_IDLE_FLUSH_MS = 2000ms in turso-adapter.ts) plus buffer for
    // the flush's own async close/reconnect ceremony to complete.
    await new Promise<void>((r) => setTimeout(r, 2000 + 1500));

    const walAfterIdle = walSize(dbPath);
    // Near-zero after the adapter's gated TRUNCATE — same "near-zero, not
    // merely smaller" bar bl405-checkpoint-real.spec.ts uses.
    expect(walAfterIdle).toBeLessThan(walAfterWrite * 0.1);
    expect(walAfterIdle).toBeLessThan(20_000);

    // The defining assertion: memory-core's own bookkeeping is STILL
    // untouched. The WAL shrank without WriteQueue ever calling anything —
    // proof the mechanism lives entirely in the adapter now.
    expect(WriteQueue.lastCheckpointAtForPath(dbPath)).toBe(0);

    await queue.drainAndClose();
  }, 15_000);

  /**
   * `walBytes()` on a Turso adapter deliberately reports 0 (no local-file
   * assumption for the generic case) — confirms that contract still holds
   * post-DEBT-004, so the RED→GREEN proof above's use of a direct
   * `fs.statSync` (rather than `queue.walBytes()`) is not incidental.
   */
  it('walBytes() reports 0 for a turso-backed queue (by design, unrelated to checkpoint ownership)', async () => {
    const queue = await WriteQueue.forPath(dbPath);
    expect(queue.walBytes()).toBe(0);
  });

  /**
   * `lastCheckpointAtForPath` still answers 0 for a never-shut-down store
   * (no instance, or an instance that has never gone through
   * `closeAllForShutdown()`), and only becomes non-zero once shutdown's
   * explicit `adapter.close()` flush runs — see `closeAllForShutdown()`'s
   * doc comment for why that is now the ONLY writer of this ledger.
   */
  it('lastCheckpointAtForPath: 0 for unknown path, and only set by closeAllForShutdown()', async () => {
    expect(WriteQueue.lastCheckpointAtForPath('/nonexistent/path.db')).toBe(0);

    await WriteQueue.forPath(dbPath);
    expect(WriteQueue.lastCheckpointAtForPath(dbPath)).toBe(0); // no shutdown yet

    const before = Date.now();
    await WriteQueue.closeAllForShutdown();
    const after = WriteQueue.lastCheckpointAtForPath(dbPath);
    expect(after).toBeGreaterThanOrEqual(before);
    expect(after).toBeLessThanOrEqual(Date.now());
  });
});
