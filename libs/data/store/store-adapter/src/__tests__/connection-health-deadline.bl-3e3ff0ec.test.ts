/**
 * connection-health-deadline.bl-3e3ff0ec.test.ts — packet TUR-H, BL `3e3ff0ec`.
 *
 * ── What 3e3ff0ec mandates (and what it forbids) ───────────────────────────
 * The live wedge that filed 3e3ff0ec had NO rejection: the process sat at ~0%
 * CPU with an in-flight driver call that neither returned nor threw, and the
 * health surface reported 'healthy' the whole time. `connectionHealth`
 * transitions ONLY on a THROWN, fatal error (`isFatalConnectionError`), so an
 * error-triggered state machine is *structurally* incapable of observing a
 * hung connection — there is no deadline trigger. The item's body explicitly
 * forbids resolving it by asserting that memory-server's `operation-guard.ts`
 * deadline covers the case: that deadline is ONE consumer; every other
 * store-adapter consumer stays blind. The fix must land IN the adapter.
 *
 * TUR-D (`fdd2e61b`) folded the deadline half of that: `TursoAdapter` now
 * exposes a synchronous, query-free `driverStatus` getter
 * (`turso-adapter.ts:2026`) forwarding
 * `getTursoDriverStatus(this.config.driverStallAfterMs)` to the process-wide
 * off-thread driver host (`turso-driver-host.ts:770`). The host derives
 * `state === 'stalled'` from the OLDEST in-flight op's age vs the deadline
 * (`turso-driver-host.ts:352`) — a verdict reached WITHOUT any error and
 * WITHOUT cancelling the blocked call (there is no JS primitive to abort a
 * blocked native call; the item documents that honestly). This test proves the
 * mandate at the ADAPTER level, which is exactly what 3e3ff0ec asks for.
 *
 * ── What this test pins (binary) ───────────────────────────────────────────
 *   1. a real long native step is started and deliberately NOT awaited;
 *   2. once its age crosses the adapter's deadline, `adapter.driverStatus.state`
 *      becomes 'stalled' with `oldestOpAgeMs >= driverStallAfterMs`;
 *   3. while stalled the parked promise is STILL PENDING and has NOT rejected —
 *      the state flipped with no error, which is the whole point;
 *   4. the op then settles (resolves, no error) and the state returns to 'idle'.
 *
 * ── Fault injection (no simulated error) ───────────────────────────────────
 * The hung op is a real native step — `SELECT length(hex(zeroblob(N)))`, whose
 * duration is a function of N — not a stubbed rejection. It never throws; it
 * is simply slow on the native side, the same "no return / no error" shape a
 * wedged native call presents. `await`ing the parked promise is the latch
 * release.
 *
 * ── Deadline configuration (and a documented gap) ──────────────────────────
 * `driverStatus` reads `this.config.driverStallAfterMs`. The documented public
 * route is `connect({ driverStallAfterMs })`, but `_buildConfig`
 * (`turso-adapter.ts:3476`) does NOT copy that option onto the config, so a
 * value passed to `connect()` is dropped and the getter falls back to the
 * 5000ms default — measured: `adapter.config.driverStallAfterMs` is
 * `undefined` after `connect({ dbPath, driverStallAfterMs: 50 })`. Filed as
 * backlog item `40ca73a8-f238-4904-b217-54fb9b104d52` (dedupe scan degraded:
 * no-vector-scores). This test therefore also pins the value on
 * the field the production getter actually reads, keeping the deadline small
 * and the park short. Once that option is plumbed the pin below can be deleted
 * and `connect({ driverStallAfterMs })` alone will suffice.
 *
 * ── BL-225 (red→green) ─────────────────────────────────────────────────────
 * RED against the pre-TUR-D tree (`ebb4125b`): `TursoAdapter` had no
 * `driverStatus` member at all — `git log -S 'get driverStatus' --
 * libs/data/store/store-adapter/src/turso-adapter.ts` shows it entered exactly
 * at `fdd2e61b` — so step 2 throws on `undefined.state`. GREEN from `fdd2e61b`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TursoAdapterImpl } from '../turso-adapter.js';

const require = createRequire(import.meta.url);
const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch (err) {
    process.stderr.write(`[connection-health-deadline test] driver unavailable: ${String(err)}\n`);
    return false;
  }
})();
const itTurso = hasTurso ? it : it.skip;

/** The adapter's deadline under test. */
const DRIVER_STALL_AFTER_MS = 50;

/**
 * Big enough that the native `hex(zeroblob(N))` step reliably outlives the
 * 50ms deadline on any machine (measured ~0.5s at this size), yet small enough
 * that the park is short and the test stays sub-second.
 */
const LATCH_ZEROBLOB_BYTES = 64_000_000;

const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

describe('3e3ff0ec — a hung adapter op reaches stalled with no error thrown', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'conn-health-deadline-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  itTurso(
    'driverStatus flips to stalled on the deadline, op still pending and un-rejected, then idle',
    async () => {
      const dbPath = join(dir, 'hung.db');
      // The public route: open the adapter with a small deadline.
      const connectOptions = { dbPath, driverStallAfterMs: DRIVER_STALL_AFTER_MS };
      const adapter = await TursoAdapterImpl.connect(connectOptions);
      try {
        // Force the DEBT-003 deferred open so the driver worker is live before we park.
        await adapter.executeGet('SELECT 1 AS one');

        // Pin the deadline on the field the production getter reads. See the
        // file header: connect()'s option is dropped by _buildConfig today; this
        // makes the deadline the adapter reports equal to the one we asked for.
        (adapter.config as { driverStallAfterMs?: number }).driverStallAfterMs =
          DRIVER_STALL_AFTER_MS;

        // (1) Park a real long native step. Deliberately NOT awaited: the point
        // is a call that has neither returned nor thrown.
        let settled = false;
        let rejected = false;
        let captured: { n: number } | null | undefined;
        const parked = adapter
          .executeGet<{ n: number }>(`SELECT length(hex(zeroblob(${LATCH_ZEROBLOB_BYTES}))) AS n`)
          .then(
            (row) => {
              settled = true;
              captured = row;
            },
            () => {
              settled = true;
              rejected = true;
            },
          );

        // (2) Observe the deadline verdict while the op is in flight.
        let status = adapter.driverStatus;
        const observeDeadline = Date.now() + 5_000;
        while (status.state !== 'stalled' && !settled && Date.now() < observeDeadline) {
          await sleep(5);
          status = adapter.driverStatus;
        }

        expect(status.state).toBe('stalled');
        expect(status.oldestOpAgeMs).toBeGreaterThanOrEqual(DRIVER_STALL_AFTER_MS);
        expect(status.inFlight).toBeGreaterThanOrEqual(1);
        expect(status.oldestOpLabel ?? '').toContain('zeroblob');
        // A live worker really is behind the pending op.
        expect(status.workerThreadId).not.toBeNull();

        // (3) The state flipped with NO error: the parked promise is still pending.
        expect(settled).toBe(false);
        expect(rejected).toBe(false);
        // The error-triggered machine is blind to a hang: nothing threw, so the
        // connection has not gone 'poisoned'. driverStatus is the signal that sees it.
        expect(adapter.connectionHealth).not.toBe('poisoned');

        // (4) Release the latch: the op settles WITHOUT an error and the adapter
        // reports 'idle' again.
        await parked;
        expect(rejected).toBe(false);
        expect(captured?.n).toBe(LATCH_ZEROBLOB_BYTES * 2); // hex => 2 chars per byte
        expect(adapter.driverStatus.state).toBe('idle');
      } finally {
        await adapter.close();
      }
    },
    30_000,
  );
});
