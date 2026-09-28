/**
 * bl-e7716825-shutdown-once-guard.spec.ts — BL-e7716825.
 *
 * `handleDirectStdioShutdown` (index.ts) is the DIRECT-STDIO MODE shutdown
 * handler registered on both `process.on('SIGTERM', ...)` and
 * `process.on('SIGINT', ...)`. It must be idempotent: a repeated signal
 * (tsx's `relaySignalToChild` re-sends SIGTERM 30ms after forwarding it if
 * the child has not yet reported, launchd/a process-group kill can also
 * deliver a signal twice, and Node fires every registered listener for a
 * signal) must never re-run the pre-restart `autoBackup()` (a VACUUM INTO)
 * a second time, and must never let a second invocation race ahead of the
 * first's in-flight backup.
 *
 * This suite calls `handleDirectStdioShutdown` directly (unit level, no
 * process spawn — mirrors `bl472-shutdown-drain.spec.ts`'s approach to
 * `backend.ts`'s sibling `coordinatedShutdown` guard) with an injected
 * `runAutoBackup` mock and an injected `exit` mock, so no real process ever
 * exits and no real store is ever touched.
 *
 * RED→GREEN PROCEDURE ACTUALLY PERFORMED (BL-225):
 *   With the `_directShutdownInFlight !== null` early-return removed from
 *   `handleDirectStdioShutdown` (reverted to always starting a fresh
 *   execution per call — the pre-fix shape), all 4 specs in this file
 *   FAILED: "two signals in quick succession run autoBackup exactly once"
 *   failed at the `mockRunAutoBackup` call-count assertion (2 calls, not 1);
 *   "the second call awaits/joins the first" timed out at 30s (the second
 *   call created its OWN in-flight backup promise and overwrote the shared
 *   `releaseBackup` closure, so the first call's release never ran); "an
 *   unconfigured store... still only exits once" failed on `exit` being
 *   called 2 times, not 1; and "a later signal after a completed shutdown"
 *   failed on `mockRunAutoBackup` being called 2 times, not 1. Restoring the
 *   guard (this file's actual `index.ts` state) turns all 4 GREEN. See the
 *   handback report for the quoted npx nx test output of both arms.
 *
 * Gate: npx nx test memory-server -- --run bl-e7716825-shutdown-once-guard.spec
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetDirectShutdownStateForTest, handleDirectStdioShutdown } from './index.js';

describe('BL-e7716825 — handleDirectStdioShutdown is idempotent under a repeated signal', () => {
  beforeEach(() => {
    __resetDirectShutdownStateForTest();
  });

  afterEach(() => {
    __resetDirectShutdownStateForTest();
  });

  it('[BL-e7716825] two signals in quick succession run autoBackup exactly once', async () => {
    let releaseBackup!: () => void;
    const mockRunAutoBackup = vi.fn(
      () =>
        new Promise<{ path: string; size: number; skipped: boolean; pruned: string[] }>((resolve) => {
          releaseBackup = () => resolve({ path: '/scratch/backup.db', size: 123, skipped: false, pruned: [] });
        }),
    );
    const exit = vi.fn((_code: number): never => undefined as never);

    // Fire two signals "in quick succession" — before the first has resolved
    // its in-flight autoBackup — exactly the tsx relaySignalToChild /
    // launchd double-delivery scenario this guard exists for.
    const p1 = handleDirectStdioShutdown('SIGTERM', '/scratch/db.sqlite', mockRunAutoBackup, exit);
    const p2 = handleDirectStdioShutdown('SIGINT', '/scratch/db.sqlite', mockRunAutoBackup, exit);

    // Give both calls a chance to enter the guard before releasing the
    // in-flight backup — proves the SECOND call did not start its own
    // autoBackup while the first was still pending.
    await Promise.resolve();
    await Promise.resolve();
    expect(mockRunAutoBackup).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    releaseBackup();
    await Promise.all([p1, p2]);

    expect(mockRunAutoBackup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('[BL-e7716825] the second call awaits/joins the first instead of returning early', async () => {
    let releaseBackup!: () => void;
    const order: string[] = [];
    const mockRunAutoBackup = vi.fn(
      () =>
        new Promise<{ path: string; size: number; skipped: boolean; pruned: string[] }>((resolve) => {
          releaseBackup = () => {
            order.push('backup-resolved');
            resolve({ path: '/scratch/backup.db', size: 1, skipped: false, pruned: [] });
          };
        }),
    );
    const exit = vi.fn((_code: number): never => {
      order.push('exit');
      return undefined as never;
    });

    const p1 = handleDirectStdioShutdown('SIGTERM', '/scratch/db.sqlite', mockRunAutoBackup, exit);
    await Promise.resolve();
    const p2 = handleDirectStdioShutdown('SIGTERM', '/scratch/db.sqlite', mockRunAutoBackup, exit);

    let p2Resolved = false;
    void p2.then(() => {
      p2Resolved = true;
    });

    // p2 must not resolve before the shared in-flight backup does.
    await Promise.resolve();
    await Promise.resolve();
    expect(p2Resolved).toBe(false);

    releaseBackup();
    await Promise.all([p1, p2]);

    expect(p2Resolved).toBe(true);
    expect(order).toEqual(['backup-resolved', 'exit']);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('[BL-e7716825] an unconfigured store (dbPathForBackup null) still only exits once across two signals', async () => {
    const mockRunAutoBackup = vi.fn();
    const exit = vi.fn((_code: number): never => undefined as never);

    const p1 = handleDirectStdioShutdown('SIGTERM', null, mockRunAutoBackup, exit);
    const p2 = handleDirectStdioShutdown('SIGINT', null, mockRunAutoBackup, exit);
    await Promise.all([p1, p2]);

    expect(mockRunAutoBackup).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('[BL-e7716825] a later signal after a completed shutdown still resolves without re-running autoBackup', async () => {
    const mockRunAutoBackup = vi.fn(async () => ({ path: '/scratch/backup.db', size: 5, skipped: false, pruned: [] }));
    const exit = vi.fn((_code: number): never => undefined as never);

    await handleDirectStdioShutdown('SIGTERM', '/scratch/db.sqlite', mockRunAutoBackup, exit);
    expect(mockRunAutoBackup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);

    // A THIRD signal after the first shutdown already finished (e.g. a
    // stray reaper SIGKILL-adjacent SIGTERM) must still be a no-op join of
    // the already-settled promise, never a fresh autoBackup.
    await handleDirectStdioShutdown('SIGTERM', '/scratch/db.sqlite', mockRunAutoBackup, exit);
    expect(mockRunAutoBackup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
