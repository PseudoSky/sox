/**
 * BUG-019 — the wal-cap backstop's PASSIVE checkpoint FAILS under the exact
 * sustained load it was built to handle, because `_checkWalCapAndFlush()`'s
 * catch branch logged EVERY thrown error from `PRAGMA wal_checkpoint(PASSIVE)`
 * as an unqualified fault (`wal_cap_flush_failed` at `error`), even when the
 * driver's own message text is a recognized busy/lock-contention condition
 * this codebase already knows how to classify.
 *
 * ROOT CAUSE (established from evidence, not inference):
 *
 * 1. Live incident (2026-08-18, deployed memory-server, cited in BUG-019):
 *    six consecutive `wal_cap_flush_failed` trips in ~130ms, each
 *    `error="step failed: Runtime error: database table is locked"`.
 *
 * 2. That EXACT literal — "database table is locked" — is not a novel
 *    string. `isBusyOrLockedMessage()` (errors.ts) has matched it since the
 *    BUG-MEMORY-001 incident (`/database (is|table is) locked/i`), and
 *    `errors.spec.ts` pins it verbatim: `isBusyError({ code:
 *    'GenericFailure', message: 'step failed: database table is locked' })`
 *    is asserted `true`. `withRetry()` (retry.ts) already uses `isBusyError`
 *    to decide a write is safe to retry. `reportFailedPassiveCheckpoint()`
 *    (this file, `close()`) already applies the analogous distinction at
 *    close time: a THROWN PASSIVE-checkpoint error is classified as a
 *    durable `checkpoint_deferred`, not `repair_failed`, unless the WAL is
 *    independently known to be damaged.
 *
 * 3. `_checkWalCapAndFlush()` was the one call site in this file that never
 *    applied that classification — every throw from the PRAGMA, regardless
 *    of what the driver's own text said, logged as `wal_cap_flush_failed`
 *    at `error`. The `DEFAULT_WAL_CAP_BYTES` doc comment's own rationale
 *    for choosing PASSIVE over TRUNCATE ("PASSIVE does not need TRUNCATE's
 *    writer-exclusive lock, so it stays safe exactly when peers are most
 *    likely to be active") is TRUE for the locking half of the claim
 *    (PASSIVE never blocks a peer — proven by `wal-cap.spec.ts`'s "PASSIVE,
 *    never TRUNCATE" test) but was overstated as "safe" full stop: PASSIVE
 *    can still throw a busy/lock condition under real concurrent load
 *    instead of degrading to the graceful `busy:1` result row the code
 *    already anticipated for the ROW-shaped case.
 *
 * 4. This driver (`@tursodatabase/database@0.7.1`) genuinely serializes
 *    every native call on ONE connection instance via an internal
 *    `execLock` (`@tursodatabase/database-common`'s `Database.execLock`),
 *    and empirically (probed against the real driver across seven distinct
 *    concurrency harnesses — concurrent in-process calls on one connection,
 *    multiple same-process connections, an open uncommitted transaction
 *    racing a checkpoint from a second connection, an unfinished reader
 *    statement racing a checkpoint, high-connection-count bursts, and
 *    genuine multi-process children all writing to one file — none of them
 *    reproduced the native throw in this sandboxed environment within a
 *    bounded run). That is consistent with the live incident's own framing:
 *    it is a genuine but narrow production-timing race, not a
 *    deterministically-forceable one from a short test harness. The
 *    classification bug this ticket exists to fix does not depend on
 *    reproducing the native race — the exact error string is already
 *    proven (by the live incident's own log line, quoted verbatim above)
 *    to occur, and is already proven (by `errors.spec.ts`) to be
 *    recognized busy/lock text.
 *
 * So this suite exercises the fix under GENUINE concurrent write load
 * (`Promise.all` of many in-flight `executeRun` calls against one shared
 * adapter connection — never a sequential `for`-loop `await`, which is what
 * every prior `wal-cap.spec.ts` test used and is exactly the coverage gap
 * BUG-019's own text names: "shipped without ever being tested under real
 * concurrency") and deterministically injects the live incident's own
 * error text at the exact call site the checkpoint fires from, so the
 * assertion is pinned to reality rather than to a timing accident.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TursoAdapterImpl } from '../turso-adapter.js';
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
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-wal-cap-bug019-'));
});

function tempPath(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpDir, `${label}-${suffix}.db`);
}

/** The verbatim driver error text from the live BUG-019 incident. */
const LIVE_INCIDENT_ERROR_MESSAGE = 'step failed: Runtime error: database table is locked';

tursoDescribe('BUG-019 — wal-cap PASSIVE checkpoint throw under genuine concurrency', () => {
  it(
    'a busy/lock error thrown by the forced PASSIVE checkpoint, while GENUINE ' +
      'concurrent writers are in flight against the same connection, is logged ' +
      'as wal_cap_flush_busy (warn) — not wal_cap_flush_failed (error) — and ' +
      'every concurrent write still succeeds',
    async () => {
      const dbPath = tempPath('bug019-busy-classification');
      const IDLE_MS = 10_000; // never fires during this test
      const CAP_BYTES = 4_000; // trips almost immediately under concurrent writers

      const a = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: IDLE_MS, walCapBytes: CAP_BYTES });
      await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');

      // Force the FIRST real driver open before patching — TursoAdapterImpl is
      // lazy-connect (DEBT-003), and `this.db` does not exist as the real
      // driver handle until an operation has run through `_ensureHealthy()`.
      await a.executeGet('SELECT 1');

      // Inject the live incident's own error text into the underlying driver
      // call the checkpoint PRAGMA runs through (`this.db.all`, per
      // `executeAll()`), for exactly ONE invocation — the first
      // `PRAGMA wal_checkpoint` call the cap trips. Every other `.all()` call
      // (ordinary SELECTs the concurrent writers do not even issue here, but
      // future callers might) passes through unmodified.
      const realDb = (a as unknown as { db: { all: (sql: string, ...args: unknown[]) => Promise<unknown> } }).db;
      const realAll = realDb.all.bind(realDb);
      let injected = false;
      realDb.all = async (sql: string, ...args: unknown[]) => {
        if (!injected && typeof sql === 'string' && sql.includes('wal_checkpoint')) {
          injected = true;
          const err = new Error(LIVE_INCIDENT_ERROR_MESSAGE) as Error & { code: string };
          err.code = 'GenericFailure';
          throw err;
        }
        return realAll(sql, ...args);
      };

      const warnSpy = vi.spyOn(log, 'warn');
      const errorSpy = vi.spyOn(log, 'error');

      try {
        // GENUINE concurrency: every write is fired and in flight
        // simultaneously via Promise.all, not a sequential `for` loop with an
        // `await` between each — this is the exact coverage gap BUG-019
        // names. The payload size and count comfortably cross CAP_BYTES.
        const WRITERS = 40;
        const payload = 'x'.repeat(300);
        const writes = Array.from({ length: WRITERS }, (_, i) =>
          a.executeRun('INSERT INTO t (v) VALUES (?)', [`${i}-${payload}`]),
        );

        // The invariant under test: a failed forced-flush must NEVER fail a
        // write that already succeeded. Every one of these must resolve.
        await expect(Promise.all(writes)).resolves.toBeDefined();

        expect(injected, 'the injected busy/lock error must actually have fired during the burst').toBe(true);

        // THE FIX: the busy/lock condition is classified as a warn-level
        // busy signal, not an error-level fault.
        const busyWarnings = warnSpy.mock.calls.filter(
          (c) => c[0] === 'store_adapter.turso.wal_cap_flush_busy',
        );
        expect(
          busyWarnings.length,
          'the thrown busy/lock error must be logged as wal_cap_flush_busy (warn) — ' +
            'this is the assertion that FAILS against pre-fix code, which logs every ' +
            'thrown checkpoint error as wal_cap_flush_failed (error) unconditionally',
        ).toBeGreaterThan(0);
        // `db_path` is the CANONICALIZED path (BUG014.T4) — macOS resolves
        // `/tmp` -> `/private/tmp`, so compare on the fields that do not
        // depend on that canonicalization rather than the raw `dbPath`.
        expect(busyWarnings[0]?.[1]).toMatchObject({
          cap_bytes: CAP_BYTES,
          error: LIVE_INCIDENT_ERROR_MESSAGE,
        });
        expect(String(busyWarnings[0]?.[1]?.db_path)).toContain('bug019-busy-classification');

        const faultErrors = errorSpy.mock.calls.filter(
          (c) => c[0] === 'store_adapter.turso.wal_cap_flush_failed',
        );
        expect(
          faultErrors.length,
          'a RECOGNIZED busy/lock condition must not ALSO be logged as an unexpected fault',
        ).toBe(0);
      } finally {
        warnSpy.mockRestore();
        errorSpy.mockRestore();
        realDb.all = realAll;
      }

      // Durability: every row landed despite the injected checkpoint failure.
      const rows = await a.executeAll<{ c: number }>('SELECT count(*) AS c FROM t');
      expect(rows.rows[0]!.c).toBe(40);

      await a.close();
    },
  );

  it(
    'an UNRECOGNIZED thrown checkpoint error (not a busy/lock message) still ' +
      'logs at wal_cap_flush_failed (error) — the narrowing does not silence real faults',
    async () => {
      const dbPath = tempPath('bug019-genuine-fault-still-logged');
      const IDLE_MS = 10_000;
      const CAP_BYTES = 4_000;

      const a = await TursoAdapterImpl.connect({ dbPath, idleFlushMs: IDLE_MS, walCapBytes: CAP_BYTES });
      await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      await a.executeGet('SELECT 1');

      const realDb = (a as unknown as { db: { all: (sql: string, ...args: unknown[]) => Promise<unknown> } }).db;
      const realAll = realDb.all.bind(realDb);
      let injected = false;
      realDb.all = async (sql: string, ...args: unknown[]) => {
        if (!injected && typeof sql === 'string' && sql.includes('wal_checkpoint')) {
          injected = true;
          const err = new Error('step failed: Runtime error: disk I/O error') as Error & { code: string };
          err.code = 'GenericFailure';
          throw err;
        }
        return realAll(sql, ...args);
      };

      const warnSpy = vi.spyOn(log, 'warn');
      const errorSpy = vi.spyOn(log, 'error');
      try {
        const WRITERS = 40;
        const payload = 'x'.repeat(300);
        const writes = Array.from({ length: WRITERS }, (_, i) =>
          a.executeRun('INSERT INTO t (v) VALUES (?)', [`${i}-${payload}`]),
        );
        await expect(Promise.all(writes)).resolves.toBeDefined();
        expect(injected).toBe(true);

        expect(
          errorSpy.mock.calls.filter((c) => c[0] === 'store_adapter.turso.wal_cap_flush_failed').length,
        ).toBeGreaterThan(0);
        expect(
          warnSpy.mock.calls.filter((c) => c[0] === 'store_adapter.turso.wal_cap_flush_busy').length,
        ).toBe(0);
      } finally {
        warnSpy.mockRestore();
        errorSpy.mockRestore();
        realDb.all = realAll;
      }

      await a.close();
    },
  );
});
