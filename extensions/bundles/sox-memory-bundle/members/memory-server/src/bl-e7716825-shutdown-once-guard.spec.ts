/**
 * bl-e7716825-shutdown-once-guard.spec.ts — BL-e7716825 (ff7d9e24 removed the
 * backup call this guard originally protected, but the idempotency guarantee
 * itself remains load-bearing).
 *
 * `handleDirectStdioShutdown` (index.ts) is the DIRECT-STDIO MODE shutdown
 * handler registered on both `process.on('SIGTERM', ...)` and
 * `process.on('SIGINT', ...)`. It must be idempotent: a repeated signal
 * (tsx's `relaySignalToChild` keys off the CHILD'S IPC ACKNOWLEDGEMENT of the
 * signal, not the child exiting — if it hasn't seen that ack ~30ms after
 * relaying the first signal it re-sends the same signal, then escalates to
 * SIGKILL ~60ms after the original relay; launchd/a process-group kill can
 * also deliver a signal twice, and Node fires every registered listener for a
 * signal) must never call `exit` more than once for one logical shutdown.
 *
 * (ff7d9e24) The pre-restart `autoBackup()` call this guard originally
 * protected (preventing two concurrent VACUUM INTOs) was REMOVED from this
 * handler entirely — see `handleDirectStdioShutdown`'s own doc comment and
 * `bl-ff7d9e24-no-vacuum-on-shutdown.spec.ts`. The `_directShutdownInFlight`
 * guard itself is kept: it is still what makes a repeated signal a no-op join
 * instead of a second, redundant run of the handler body (and a second call
 * to `exit`).
 *
 * This suite calls `handleDirectStdioShutdown` directly (unit level, no
 * process spawn) with an injected `exit` mock, so no real process ever exits.
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

  it('[BL-e7716825] two signals in quick succession only exit once', async () => {
    const exit = vi.fn((_code: number): never => undefined as never);

    // Fire two signals "in quick succession" — the tsx relaySignalToChild /
    // launchd double-delivery scenario this guard exists for.
    const p1 = handleDirectStdioShutdown('SIGTERM', '/scratch/db.sqlite', exit);
    const p2 = handleDirectStdioShutdown('SIGINT', '/scratch/db.sqlite', exit);

    await Promise.all([p1, p2]);

    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('[BL-e7716825] the second call joins the first instead of re-running the handler body', async () => {
    const order: string[] = [];
    const exit = vi.fn((_code: number): never => {
      order.push('exit');
      return undefined as never;
    });

    const p1 = handleDirectStdioShutdown('SIGTERM', '/scratch/db.sqlite', exit);
    const p2 = handleDirectStdioShutdown('SIGTERM', '/scratch/db.sqlite', exit);

    await Promise.race([
      Promise.all([p1, p2]),
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('p1/p2 did not settle within 2000ms — join guard likely broken')), 2000);
      }),
    ]);

    expect(order).toEqual(['exit']);
    expect(exit).toHaveBeenCalledTimes(1);
  }, 5000);

  it('[BL-e7716825] an unconfigured store (dbPathForBackup null) still only exits once across two signals', async () => {
    const exit = vi.fn((_code: number): never => undefined as never);

    const p1 = handleDirectStdioShutdown('SIGTERM', null, exit);
    const p2 = handleDirectStdioShutdown('SIGINT', null, exit);
    await Promise.all([p1, p2]);

    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('[BL-e7716825] a later signal after a completed shutdown still resolves without calling exit a second time', async () => {
    const exit = vi.fn((_code: number): never => undefined as never);

    await handleDirectStdioShutdown('SIGTERM', '/scratch/db.sqlite', exit);
    expect(exit).toHaveBeenCalledTimes(1);

    // A THIRD signal after the first shutdown already finished (e.g. a
    // stray reaper SIGKILL-adjacent SIGTERM) must still be a no-op join of
    // the already-settled promise.
    await handleDirectStdioShutdown('SIGTERM', '/scratch/db.sqlite', exit);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
