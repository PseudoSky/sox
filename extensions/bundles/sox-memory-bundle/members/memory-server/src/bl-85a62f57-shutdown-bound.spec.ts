/**
 * bl-85a62f57-shutdown-bound.spec.ts — BL-85a62f57.
 *
 * `handleDirectStdioShutdown` (index.ts) previously ran its pre-restart
 * `autoBackup()` (a VACUUM INTO) with NO time bound at all — a later signal
 * joined the in-flight promise silently (BL-e7716825's guard), but a
 * genuinely hung backup could only be escaped with SIGKILL. This suite
 * proves the fix: the backup races `SHUTDOWN_BACKUP_TIMEOUT_MS`
 * (`./shutdown-margin.js`, shared with backend.ts's `coordinatedShutdown`),
 * the whole handler is bounded by a `computeShutdownSafetyNetMs()` safety
 * net, a repeated signal while shutdown is in flight is logged
 * (`shutdown.signal_repeated`), and `exit` is only ever invoked once even
 * when both bounds fire for the same shutdown.
 *
 * It also covers `registerDirectStdioShutdownHandlers` — the extracted
 * SIGTERM/SIGINT wiring — via an injected fake `proc` so no real signal
 * listener is ever attached to the actual test process (see BL-405's own
 * doc comment on why a leaked real listener is dangerous: it once opened a
 * connection to the live `~/.memory/memory.db` as a side effect).
 *
 * RED→GREEN PROCEDURE (BL-225): run this suite against a git-stashed-back
 * `handleDirectStdioShutdown`/`registerDirectStdioShutdownHandlers` (the
 * pre-fix shape, unbounded backup + no repeated-signal log + no exported
 * registration function) and all specs here fail — either on a timeout
 * that never resolves (unbounded backup), a missing log call assertion, or
 * an import error (`registerDirectStdioShutdownHandlers` does not exist).
 * Restoring this change turns them GREEN. See the handback report for the
 * quoted `npx nx test` output of both arms.
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
import { SHUTDOWN_BACKUP_TIMEOUT_MS } from './shutdown-margin.js';

type BackupResult = { path: string; size: number; skipped: boolean; pruned: string[] };

describe('BL-85a62f57 — handleDirectStdioShutdown is bounded', () => {
  beforeEach(() => {
    __resetDirectShutdownStateForTest();
  });

  afterEach(() => {
    __resetDirectShutdownStateForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('[BL-85a62f57] a hung pre-restart backup is abandoned at SHUTDOWN_BACKUP_TIMEOUT_MS and logs a warning', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    // Never resolves — the pathological case this bound exists for.
    const hungBackup = vi.fn(() => new Promise<BackupResult>(() => {}));
    const exit = vi.fn((_code: number): never => undefined as never);

    const p = handleDirectStdioShutdown('SIGTERM', '/scratch/db.sqlite', hungBackup, exit);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_BACKUP_TIMEOUT_MS + 10);
    await p;

    expect(warnSpy).toHaveBeenCalledWith(
      'shutdown.pre_restart_backup.timeout',
      expect.objectContaining({ signal: 'SIGTERM', db_path: '/scratch/db.sqlite', timeout_ms: SHUTDOWN_BACKUP_TIMEOUT_MS }),
    );
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('[BL-85a62f57] a hung backup that also blows the safety net still exits exactly once (exit-once latch)', async () => {
    vi.useFakeTimers();
    // safetyNetMs = 1500 - 1000 (SOX_SHUTDOWN_SAFETY_MARGIN_MS) = 500ms —
    // strictly LESS than SHUTDOWN_BACKUP_TIMEOUT_MS (900ms), so the safety
    // net fires first, then the backup-timeout race fires ~400ms later for
    // the SAME shutdown: exit must still only be called once.
    vi.stubEnv('SOX_CONFIG_STOP_TIMEOUT_MS', '1500');
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const hungBackup = vi.fn(() => new Promise<BackupResult>(() => {}));
    const exit = vi.fn((_code: number): never => undefined as never);

    const p = handleDirectStdioShutdown('SIGTERM', '/scratch/db.sqlite', hungBackup, exit);

    await vi.advanceTimersByTimeAsync(600);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('shutdown.safety_net_exceeded', expect.objectContaining({ signal: 'SIGTERM' }));

    await vi.advanceTimersByTimeAsync(400); // now past the 900ms backup timeout too
    await p;

    expect(exit).toHaveBeenCalledTimes(1); // still just once — the latch held
    expect(warnSpy).toHaveBeenCalledWith('shutdown.pre_restart_backup.timeout', expect.objectContaining({ signal: 'SIGTERM' }));
  });

  it('[BL-85a62f57] a repeated signal while shutdown is in flight logs shutdown.signal_repeated', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    let releaseBackup!: () => void;
    const mockRunAutoBackup = vi.fn(
      () =>
        new Promise<BackupResult>((resolve) => {
          releaseBackup = () => resolve({ path: '/scratch/backup.db', size: 1, skipped: false, pruned: [] });
        }),
    );
    const exit = vi.fn((_code: number): never => undefined as never);

    const p1 = handleDirectStdioShutdown('SIGTERM', '/scratch/db.sqlite', mockRunAutoBackup, exit);
    await Promise.resolve();
    const p2 = handleDirectStdioShutdown('SIGINT', '/scratch/db.sqlite', mockRunAutoBackup, exit);

    expect(warnSpy).toHaveBeenCalledWith('shutdown.signal_repeated', { signal: 'SIGINT', first_signal: 'SIGTERM' });

    releaseBackup();
    await Promise.all([p1, p2]);
  });

  it('[BL-85a62f57] a rejecting runAutoBackup still exits exactly once, with no unhandled rejection, and a repeated signal joins cleanly', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const boom = new Error('boom');
      const mockRunAutoBackup = vi.fn(async (): Promise<BackupResult> => {
        throw boom;
      });
      const exit = vi.fn((_code: number): never => undefined as never);
      const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => undefined);

      const p1 = handleDirectStdioShutdown('SIGTERM', '/scratch/db.sqlite', mockRunAutoBackup, exit);
      const p2 = handleDirectStdioShutdown('SIGINT', '/scratch/db.sqlite', mockRunAutoBackup, exit);
      await Promise.all([p1, p2]);

      expect(exit).toHaveBeenCalledTimes(1);
      expect(mockRunAutoBackup).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        'shutdown.pre_restart_backup.failed',
        expect.objectContaining({ signal: 'SIGTERM', error: 'boom' }),
      );

      // Let any stray unhandled-rejection microtask surface before asserting.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener('unhandledRejection', unhandled);
    }
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
    const runAutoBackupFn = vi.fn(async (): Promise<BackupResult> => ({ path: '/scratch/backup.db', size: 1, skipped: false, pruned: [] }));
    const exitFn = vi.fn((_code: number): never => undefined as never);

    const handlers = registerDirectStdioShutdownHandlers({}, '/scratch/db.sqlite', runAutoBackupFn, exitFn, proc);

    expect(handlers).not.toBeNull();
    expect(listeners['SIGTERM']).toHaveLength(1);
    expect(listeners['SIGINT']).toHaveLength(1);

    // The listener fires handleDirectStdioShutdown fire-and-forget (`void
    // handleDirectStdioShutdown(...)`) — wait on a macrotask, not just
    // microtasks, so the backup's own `.then()` chain and the exit call
    // both have a real chance to run before asserting.
    listeners['SIGTERM']![0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runAutoBackupFn).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledTimes(1);

    __resetDirectShutdownStateForTest();
    listeners['SIGINT']![0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runAutoBackupFn).toHaveBeenCalledTimes(2);
    expect(exitFn).toHaveBeenCalledTimes(2);
  });

  it('[BL-85a62f57] registers neither handler in BACKEND mode (SOX_PROXY_BACKEND=1)', () => {
    const proc = { on: vi.fn() };
    const runAutoBackupFn = vi.fn(async (): Promise<BackupResult> => ({ path: '/x', size: 1, skipped: false, pruned: [] }));
    const exitFn = vi.fn((_code: number): never => undefined as never);

    const handlers = registerDirectStdioShutdownHandlers({ SOX_PROXY_BACKEND: '1' }, '/scratch/db.sqlite', runAutoBackupFn, exitFn, proc);

    expect(handlers).toBeNull();
    expect(proc.on).not.toHaveBeenCalled();
  });
});
