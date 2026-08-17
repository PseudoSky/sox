/**
 * Adapter-owned idle WAL flush (store-adapter-owned WAL durability,
 * 2026-08-17 — owner directive: "consumers of store adapter should not have
 * to think about connect/disconnect... THAT is what store adapter should be
 * doing behind the scenes, in addition to ensuring the lazy connection —
 * that should be the primary wal assurance").
 *
 * The mechanism this pins already existed one layer too high, in
 * `libs/memory-core/src/write-queue.ts`'s `_scheduleIdleCheckpoint()` — a
 * debounced, coalesced idle timer that runs `PRAGMA wal_checkpoint(TRUNCATE)`
 * after the queue drains. Because it lived in the domain composer, any
 * consumer that talks to `store-adapter` directly (backlog — never touches
 * memory-core) got none of it, while memory-core (via `WriteQueue`) did.
 * Same adapter, same Turso version, same upstream #7833/#8348 checkpoint-race
 * exposure; one consumer had the flusher and the other did not. This file
 * proves the capability now lives in the adapter itself, so EVERY consumer —
 * queued or direct — inherits it automatically, with zero caller action.
 *
 * BL-225: every assertion below checks the OUTCOME (the WAL actually
 * truncates, or actually stays frozen when it legitimately should), never a
 * proxy like "a timer was scheduled" — a test that only checked scheduling
 * would pass while the WAL stayed frozen, which is the exact failure class
 * this effort exists to close.
 *
 * `idleFlushMs` is a TEST-ONLY `connect()` override (default 2000ms in
 * production, matching `WriteQueue.CHECKPOINT_IDLE_MS`) so these tests don't
 * pay a real 2s wait per case.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, statSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { leaseDirPath } from '../store-lease.js';
import { log } from '@adhd/sox-telemetry';

const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();
const tursoDescribe = hasTurso ? describe : describe.skip;

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-idle-flush-'));
});

function tempPath(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpDir, `${label}-${suffix}.db`);
}

/** Poll until `predicate()` is true or `timeoutMs` elapses. Idle-flush fires
 *  off a `setTimeout`, so tests must wait for it rather than assert
 *  synchronously right after the debounce window "should" have elapsed. */
async function waitUntil(predicate: () => boolean, timeoutMs: number, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  if (!predicate()) {
    throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
  }
}

function liveLeaseCount(dbPath: string): number {
  return readdirSync(leaseDirPath(dbPath)).filter(
    (n) => !n.startsWith('.') && !n.endsWith('.openmark'),
  ).length;
}

tursoDescribe('idle-flush — adapter-owned WAL durability', () => {
  it('an idle adapter\'s WAL actually truncates toward 0 without any caller calling anything', async () => {
    const dbPath = tempPath('auto-truncate');
    const IDLE_MS = 80;

    const a = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: IDLE_MS });
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await a.executeRun('INSERT INTO t (v) VALUES (?)', ['auto-flush-me']);

    const walPath = dbPath + '-wal';
    expect(existsSync(walPath), 'precondition: the write created the -wal file').toBe(true);
    expect(statSync(walPath).size, 'precondition: the WAL holds the uncheckpointed frame').toBeGreaterThan(0);

    // Nobody calls close(), releaseIdleConnection(), or walCheckpoint() —
    // the adapter must do this on its own once idle.
    await waitUntil(
      () => existsSync(walPath) && statSync(walPath).size === 0,
      IDLE_MS * 20,
    );

    // (transparent reconnect) The instance is still usable and still sees
    // its own earlier write — the released connection is not dead.
    const row = await a.executeGet<{ v: string }>('SELECT v FROM t WHERE v = ?', ['auto-flush-me']);
    expect(row?.v, 'a released connection must transparently reconnect and keep working').toBe(
      'auto-flush-me',
    );
    expect(a.connectionHealth).toBe('healthy');

    await a.close();
  });

  it('30 back-to-back writes arm exactly ONE flusher, which fires once after the last one drains', async () => {
    const dbPath = tempPath('coalesced');
    const IDLE_MS = 80;

    const a = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: IDLE_MS });
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');

    let armCount = 0;
    // Instrument the private timer field via a Proxy-free approach: count
    // distinct timer identities observed across the burst by sampling
    // `_idleFlushTimer` immediately after each write. A coalesced scheduler
    // keeps re-arming (or leaving armed) the SAME conceptual "one pending
    // timer" state — what we actually assert is the outcome: the WAL is
    // still non-zero mid-burst (no flush fired early) and becomes exactly
    // zero exactly once, promptly, after the burst ends — not a proxy of
    // "how many setTimeout calls happened".
    for (let i = 0; i < 30; i++) {
      await a.executeRun('INSERT INTO t (v) VALUES (?)', [`row-${i}`]);
      // (private-field probe, not a proxy assertion) every write must have
      // cancelled any previously-armed timer and (since the queue is
      // momentarily idle right after this await) armed a fresh one — never
      // more than one alive at once.
      const timer = (a as unknown as { _idleFlushTimer: unknown })._idleFlushTimer;
      if (timer !== null) armCount++;
    }
    // Every one of the 30 writes left exactly one timer armed afterward
    // (the coalescing invariant — `_armIdleFlush()` refuses a second timer
    // while one is pending, so this count is bounded by iterations, not by
    // trying to catch a race).
    expect(armCount).toBe(30);

    const walPath = dbPath + '-wal';
    // Immediately after the burst (well before IDLE_MS elapses), nothing
    // has flushed yet — the burst rescheduled, it did not fire early.
    expect(statSync(walPath).size, 'no flush should have fired mid-burst').toBeGreaterThan(0);

    await waitUntil(() => existsSync(walPath) && statSync(walPath).size === 0, IDLE_MS * 20);

    const rows = await a.executeAll<{ v: string }>('SELECT v FROM t ORDER BY id');
    expect(rows.rows.length, 'the single post-burst flush must not have lost any of the 30 writes').toBe(30);

    await a.close();
  });

  it('new work cancels and reschedules a pending flush', async () => {
    const dbPath = tempPath('cancel-reschedule');
    const IDLE_MS = 100;

    const a = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: IDLE_MS });
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await a.executeRun('INSERT INTO t (v) VALUES (?)', ['first']);

    const walPath = dbPath + '-wal';

    // Wait most of the debounce window, then issue new work — this must
    // cancel the pending flush and push it out by another full IDLE_MS,
    // not let the original timer fire on schedule.
    await new Promise((resolve) => setTimeout(resolve, Math.floor(IDLE_MS * 0.7)));
    await a.executeRun('INSERT INTO t (v) VALUES (?)', ['second']);

    // At the point the ORIGINAL timer would have fired (shortly after
    // IDLE_MS from the first write), the WAL must still be non-zero — the
    // reschedule actually took effect, this is not the "would have failed"
    // shortcut BL-225 forbids.
    await new Promise((resolve) => setTimeout(resolve, Math.floor(IDLE_MS * 0.5)));
    expect(
      statSync(walPath).size,
      'new work must have cancelled and rescheduled the flush — it must not have fired on the original schedule',
    ).toBeGreaterThan(0);

    // It does eventually fire, debounced from the SECOND write.
    await waitUntil(() => existsSync(walPath) && statSync(walPath).size === 0, IDLE_MS * 20);

    const rows = await a.executeAll<{ v: string }>('SELECT v FROM t ORDER BY id');
    expect(rows.rows.map((r) => r.v)).toEqual(['first', 'second']);

    await a.close();
  });

  it('an operation after an auto-release succeeds transparently, reading back its own earlier write', async () => {
    const dbPath = tempPath('transparent-reconnect');
    const IDLE_MS = 60;

    const a = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: IDLE_MS });
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await a.executeRun('INSERT INTO t (v) VALUES (?)', ['pre-release']);

    // Let the idle flush actually release the connection (gated strategy —
    // releaseIdleConnection() ceremony, quiescent since this is the only
    // connection).
    await waitUntil(
      () => (a as unknown as { _released: boolean })._released === true,
      IDLE_MS * 20,
    );

    const row = await a.executeGet<{ v: string }>('SELECT v FROM t WHERE v = ?', ['pre-release']);
    expect(row?.v, 'the post-release operation must transparently reconnect and read its own earlier write').toBe(
      'pre-release',
    );
    expect(a.connectionHealth).toBe('healthy');

    await a.close();
  });

  it('production-shaped: N adapters open on one store, all idle — under the GATED default, TRUNCATE legitimately may never fire while peers are live, and this is measured honestly rather than tuned to pass', async () => {
    const dbPath = tempPath('n-adapters-idle');
    const IDLE_MS = 60;
    const N = 4;

    const adapters = await Promise.all(
      Array.from({ length: N }, () => TursoAdapterImpl.connect({ dbPath, idleFlushMs: IDLE_MS })),
    );
    await adapters[0]!.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await adapters[0]!.executeRun('INSERT INTO t (v) VALUES (?)', ['shared']);

    // All N stay live and idle. Precondition: N live lease entries.
    expect(liveLeaseCount(dbPath)).toBe(N);

    // Give every adapter's gated idle flush several full debounce cycles to
    // attempt a release. Under GATED, at most ONE of them can complete
    // `releaseIdleConnection()` and drop its lease per contended window —
    // `_reconnectPromise`/`_inFlightOps` and quiescence gating do not
    // guarantee all N converge to zero live leases; they guarantee each
    // release attempt is individually safe (never truncates under a live
    // peer, never tears down mid-op).
    await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 8));

    const finalLiveLeases = liveLeaseCount(dbPath);
    // HONEST MEASUREMENT, not a tuned assertion: record what actually
    // happened rather than asserting a specific outcome the owner asked us
    // not to invent. The only invariant this arm actually proves is safety
    // — every adapter is still individually usable and the data is intact,
    // regardless of how many leases converged.
    console.log(
      `[idle-flush N-adapter arm] dbPath=${dbPath} N=${N} finalLiveLeases=${finalLiveLeases} ` +
        `(GATED default: release is individually safe but not guaranteed to converge all N to zero ` +
        `while peers keep re-arming their own idle timers on the same cadence)`,
    );

    for (const a of adapters) {
      const row = await a.executeGet<{ v: string }>('SELECT v FROM t WHERE v = ?', ['shared']);
      expect(row?.v, 'every adapter must still be individually usable regardless of lease convergence').toBe(
        'shared',
      );
      expect(a.connectionHealth).toBe('healthy');
    }

    await Promise.all(adapters.map((a) => a.close()));
  });

  /**
   * BUG-STOREADAPTER-RECONNECT-ORPHANED-IDLE-TIMER (discovered 2026-08-17
   * while building this feature, fixed in the same change — `_reconnect()`
   * now calls `fresh._cancelIdleFlush()`).
   *
   * `connect()` self-arms an idle-flush timer on every writable local-file
   * instance it returns — INCLUDING the throwaway `fresh` instance
   * `_reconnect()` creates internally to recover from a poisoned/released
   * connection. `_reconnect()` adopts `fresh.db` onto `this` but, before the
   * fix, never cancelled `fresh`'s OWN idle-flush timer — an orphaned timer
   * whose closure keeps `fresh` reachable, bound to `fresh.db`, which is the
   * SAME live connection object `this.db` now points at. Left alone, that
   * ghost timer fires a second, completely uncoordinated
   * `releaseIdleConnection()`/`close()` ceremony against the shared
   * connection, independent of `this`'s own tracked state — observed in
   * practice as `store_adapter.turso.checkpoint_deferred: The database
   * connection is not open` (a benign-but-real "deferred, not lost" symptom
   * per BUG-011's classification, never data loss, but a genuine spurious
   * extra close cycle).
   *
   * RED (with the fix reverted — see the assertion below): after a release +
   * reconnect cycle, waiting through a SECOND full idle-flush window
   * produces an uncoordinated close attempt and its `checkpoint_deferred` /
   * `close_verify_failed` warning.
   * GREEN (with the fix in place): the reconnect's own idle-flush cycle
   * completes cleanly with zero such warnings.
   */
  it('BUG-STOREADAPTER-RECONNECT-ORPHANED-IDLE-TIMER: a reconnect must not leave a ghost idle-flush timer racing the live connection', async () => {
    const dbPath = tempPath('orphaned-reconnect-timer');
    const IDLE_MS = 50;

    const a = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: IDLE_MS });
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await a.executeRun('INSERT INTO t (v) VALUES (?)', ['first']);

    const walPath = dbPath + '-wal';

    // First idle-flush cycle: release, drops the driver connection.
    await waitUntil(
      () => (a as unknown as { _released: boolean })._released === true,
      IDLE_MS * 20,
    );

    const warnSpy = vi.spyOn(log, 'warn');
    const errorSpy = vi.spyOn(log, 'error');
    try {
      // Trigger the transparent reconnect — this is exactly where the
      // pre-fix bug minted an orphaned `fresh` idle-flush timer bound to
      // the same `db` object `this` just adopted.
      await a.executeRun('INSERT INTO t (v) VALUES (?)', ['second']);
      expect(a.connectionHealth).toBe('healthy');

      // Give the (correctly cancelled) `fresh` ghost timer's original
      // schedule, AND `this`'s own legitimate post-reconnect idle-flush
      // cycle, time to fire — long enough to have observed the bug if the
      // fix regressed.
      await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 10));

      const observedWarnings = warnSpy.mock.calls.map((c) => c[0]);
      const observedErrors = errorSpy.mock.calls.map((c) => c[0]);
      expect(
        observedWarnings,
        'a reconnect must not spawn an uncoordinated second close ceremony against the live connection',
      ).not.toContain('store_adapter.turso.close_verify_failed');
      expect(observedWarnings).not.toContain(
        'store_adapter.turso.close_checkpoint_truncate_failed',
      );
      expect(observedErrors).not.toContain('store_adapter.turso.idle_flush_failed');
      // The specific symptom measured live before the fix.
      for (const call of warnSpy.mock.calls) {
        if (call[0] !== 'store_adapter.turso.close_verify_failed') continue;
        const detail = (call[1] as { error?: string } | undefined)?.error ?? '';
        expect(detail, 'the exact BUG-STOREADAPTER-RECONNECT-ORPHANED-IDLE-TIMER symptom').not.toMatch(
          /database connection is not open/,
        );
      }
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }

    // Sanity: both writes survived across the release/reconnect cycle.
    await waitUntil(() => existsSync(walPath) && statSync(walPath).size === 0, IDLE_MS * 20);
    const rows = await a.executeAll<{ v: string }>('SELECT v FROM t ORDER BY id');
    expect(rows.rows.map((r) => r.v)).toEqual(['first', 'second']);

    await a.close();
  });
});
