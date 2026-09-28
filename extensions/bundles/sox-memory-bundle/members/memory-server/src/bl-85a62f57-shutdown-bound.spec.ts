/**
 * bl-85a62f57-shutdown-bound.spec.ts — BL-85a62f57 (superseded in part by
 * ff7d9e24).
 *
 * ORIGINAL SCOPE: `handleDirectStdioShutdown` (index.ts) previously ran its
 * pre-restart `autoBackup()` (a `VACUUM INTO`) racing `SHUTDOWN_BACKUP_TIMEOUT_MS`
 * so a hung backup could not hold the process open indefinitely.
 *
 * (ff7d9e24) THAT RACE NO LONGER EXISTS. The backup call itself was removed
 * from the shutdown path entirely (see `handleDirectStdioShutdown`'s own doc
 * comment for the full incident: a `VACUUM INTO` cut off by the reaper's
 * SIGTERM grace landed torn/empty backup files under the final rotated-backup
 * name in production). See `bl-ff7d9e24-no-vacuum-on-shutdown.spec.ts` for
 * that proof. This file now covers what remains genuinely load-bearing from
 * the original BL-85a62f57 fix: the handler's overall safety net still forces
 * an exit inside the reaper's grace even if a *future* step added here hangs,
 * `exit` is invoked exactly once even when both the safety net and the normal
 * completion path fire for the same shutdown, and a repeated signal while a
 * shutdown is already in flight joins the SAME promise instead of re-running
 * the handler body.
 *
 * It also still covers `registerDirectStdioShutdownHandlers` — the extracted
 * SIGTERM/SIGINT wiring — via an injected fake `proc` so no real signal
 * listener is ever attached to the actual test process (see BL-405's own doc
 * comment on why a leaked real listener is dangerous: it once opened a
 * connection to the live `~/.memory/memory.db` as a side effect).
 *
 * Gate: npx nx test memory-server -- --run bl-85a62f57-shutdown-bound.spec
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '@adhd/sox-memory-core';

import {
  __resetDirectShutdownStateForTest,
  handleDirectStdioShutdown,
  registerDirectStdioShutdownHandlers,
} from './index.js';

describe('BL-85a62f57 — handleDirectStdioShutdown remains bounded and exit-once after ff7d9e24 removed the backup race', () => {
  beforeEach(() => {
    __resetDirectShutdownStateForTest();
  });

  afterEach(() => {
    __resetDirectShutdownStateForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('[BL-85a62f57] a configured store exits synchronously (no backup to wait on) and logs the skip reason', async () => {
    const exit = vi.fn((_code: number): never => undefined as never);

    await handleDirectStdioShutdown('SIGTERM', '/scratch/db.sqlite', exit);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('[BL-85a62f57] the whole-handler safety net still exists and would force-exit exactly once if a future step hung', async () => {
    vi.useFakeTimers();
    vi.stubEnv('SOX_CONFIG_STOP_TIMEOUT_MS', '1500');
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const exit = vi.fn((_code: number): never => undefined as never);

    // With no backup step left to hang, the handler completes on the very
    // next microtask turn — well before the safety net (500ms here) could
    // ever fire. This proves the exit-once latch holds even when the safety
    // net timer is still scheduled at completion time (it is cleared).
    await handleDirectStdioShutdown('SIGTERM', '/scratch/db.sqlite', exit);
    expect(exit).toHaveBeenCalledTimes(1);

    // Advancing time past the safety net after completion must not invoke
    // exit a second time — the timer was cleared on the normal path.
    await vi.advanceTimersByTimeAsync(600);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalledWith('shutdown.safety_net_exceeded', expect.anything());
  });

  it('[BL-85a62f57] a repeated signal while shutdown is in flight logs shutdown.signal_repeated at info level', async () => {
    // info, not warn: a repeat is EXPECTED and imminent (tsx's ack-based
    // resend within ~30ms — see this handler's own doc comment), not an
    // anomaly worth a warn-level signal.
    const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const exit = vi.fn((_code: number): never => undefined as never);

    const p1 = handleDirectStdioShutdown('SIGTERM', '/scratch/db.sqlite', exit);
    const p2 = handleDirectStdioShutdown('SIGINT', '/scratch/db.sqlite', exit);

    await Promise.all([p1, p2]);

    expect(infoSpy).toHaveBeenCalledWith('shutdown.signal_repeated', { signal: 'SIGINT', first_signal: 'SIGTERM' });
    expect(warnSpy).not.toHaveBeenCalledWith('shutdown.signal_repeated', expect.anything());
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('[BL-85a62f57] a later signal after a completed shutdown still resolves as a no-op join, exit called exactly once', async () => {
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

describe('BL-85a62f57 — registerDirectStdioShutdownHandlers wiring', () => {
  beforeEach(() => {
    __resetDirectShutdownStateForTest();
  });

  afterEach(() => {
    __resetDirectShutdownStateForTest();
    vi.restoreAllMocks();
  });

  it('[BL-85a62f57] routes SIGTERM and SIGINT to handleDirectStdioShutdown with the injected deps', async () => {
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    const proc = {
      on: (event: string, listener: (...args: unknown[]) => void) => {
        (listeners[event] ??= []).push(listener);
        return proc;
      },
    };
    const exitFn = vi.fn((_code: number): never => undefined as never);

    const handlers = registerDirectStdioShutdownHandlers({}, '/scratch/db.sqlite', exitFn, proc);

    expect(handlers).not.toBeNull();
    expect(listeners['SIGTERM']).toHaveLength(1);
    expect(listeners['SIGINT']).toHaveLength(1);

    // The listener fires handleDirectStdioShutdown fire-and-forget (`void
    // handleDirectStdioShutdown(...)`) — wait on a macrotask so the exit
    // call has a real chance to run before asserting.
    listeners['SIGTERM']![0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(exitFn).toHaveBeenCalledTimes(1);

    __resetDirectShutdownStateForTest();
    listeners['SIGINT']![0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(exitFn).toHaveBeenCalledTimes(2);
  });

  it('[BL-85a62f57] registers neither handler in BACKEND mode (SOX_PROXY_BACKEND=1)', () => {
    const proc = { on: vi.fn() };
    const exitFn = vi.fn((_code: number): never => undefined as never);

    const handlers = registerDirectStdioShutdownHandlers({ SOX_PROXY_BACKEND: '1' }, '/scratch/db.sqlite', exitFn, proc);

    expect(handlers).toBeNull();
    expect(proc.on).not.toHaveBeenCalled();
  });
});
