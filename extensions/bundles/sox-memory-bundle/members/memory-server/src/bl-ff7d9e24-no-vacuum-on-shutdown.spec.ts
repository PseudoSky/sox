/**
 * bl-ff7d9e24-no-vacuum-on-shutdown.spec.ts — ff7d9e24 (half 2 of 2).
 *
 * "Torn backup published to rotated name; shutdown VACUUM INTO needs staging
 * + verification gate" (HIGH). Half 2: there is NO VACUUM in the shutdown
 * path.
 *
 * PRODUCTION INCIDENT: a shutdown-time pre-restart backup ran `autoBackup()`
 * (a `VACUUM INTO`) racing a bounded timeout — but `Promise.race` never
 * cancels the loser, and `SqliteAdapterImpl.backupTo()`'s `VACUUM INTO` is a
 * synchronous better-sqlite3 call that blocks the event loop for its entire
 * duration, so neither that race nor the whole-sequence safety net could
 * even be scheduled until the VACUUM returned. When the reaper's SIGTERM
 * grace expired first, the VACUUM INTO was cut off mid-write, landing torn
 * backup files (see `bl-ff7d9e24-torn-backup-not-published.spec.ts` for half
 * 1's proof of the staging/verify/rename gate this class of failure needs).
 *
 * FIX: neither shutdown sequence calls `autoBackup()` (or `backupStore()`)
 * at all, for any store — `coordinatedShutdown` (backend.ts) and
 * `handleDirectStdioShutdown` (index.ts) unconditionally skip the backup
 * step and log why. This suite proves BOTH shutdown entry points never call
 * `autoBackup`/`backupStore`, even for a fully configured store.
 *
 * RED->GREEN (BL-225): reverting either shutdown function to call
 * `autoBackup()` again turns the corresponding test below RED (the spy
 * records a call). With the fix in place both are GREEN. Quoted `npx nx test
 * memory-server -- --run bl-ff7d9e24` output for both arms is in the
 * ff7d9e24 backlog resolution citation.
 *
 * Gate: npx nx test memory-server -- --run bl-ff7d9e24-no-vacuum-on-shutdown.spec
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAutoBackup, mockCloseAllAdapters, mockTerminateEmbedWorkers, mockWriteQueueCloseAllForShutdown, mockFlushPendingEmbeds, mockWaitForDrainSettled } = vi.hoisted(() => ({
  mockAutoBackup: vi.fn<() => Promise<{ path: string; size: number; skipped: boolean; pruned: string[] }>>(),
  mockCloseAllAdapters: vi.fn<() => Promise<void>>(),
  mockTerminateEmbedWorkers: vi.fn<() => Promise<void>>(),
  mockWriteQueueCloseAllForShutdown: vi.fn<() => Promise<void>>(),
  mockFlushPendingEmbeds: vi.fn<() => Promise<void>>(),
  mockWaitForDrainSettled: vi.fn<() => Promise<void>>(),
}));

vi.mock('@adhd/sox-memory-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@adhd/sox-memory-core')>();
  const WriteQueueProxy = new Proxy(actual.WriteQueue, {
    get(target, prop, receiver) {
      if (prop === 'closeAllForShutdown') return mockWriteQueueCloseAllForShutdown;
      return Reflect.get(target, prop, receiver);
    },
  });
  return {
    ...actual,
    autoBackup: mockAutoBackup,
    closeAllAdapters: mockCloseAllAdapters,
    terminateEmbedWorkers: mockTerminateEmbedWorkers,
    flushPendingEmbeds: mockFlushPendingEmbeds,
    WriteQueue: WriteQueueProxy,
  };
});

vi.mock('./index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./index.js')>();
  return {
    ...actual,
    waitForDrainSettled: mockWaitForDrainSettled,
  };
});

import { coordinatedShutdown, __resetShutdownStateForTest } from './backend.js';
import { __resetDirectShutdownStateForTest, handleDirectStdioShutdown } from './index.js';

describe('[ff7d9e24] coordinatedShutdown (backend.ts) never calls autoBackup — no VACUUM in the shutdown path', () => {
  beforeEach(() => {
    mockAutoBackup.mockReset();
    mockCloseAllAdapters.mockReset();
    mockTerminateEmbedWorkers.mockReset();
    mockWriteQueueCloseAllForShutdown.mockReset();
    mockFlushPendingEmbeds.mockReset();
    mockWaitForDrainSettled.mockReset();
    __resetShutdownStateForTest();

    mockCloseAllAdapters.mockResolvedValue(undefined);
    mockTerminateEmbedWorkers.mockResolvedValue(undefined);
    mockWriteQueueCloseAllForShutdown.mockResolvedValue(undefined);
    mockFlushPendingEmbeds.mockResolvedValue(undefined);
    mockWaitForDrainSettled.mockResolvedValue(undefined);
    // Would hang forever if ever awaited — proves the shutdown sequence
    // neither calls it NOR waits on it, not merely that it "usually" doesn't.
    mockAutoBackup.mockImplementation(() => new Promise(() => {}));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('[ff7d9e24] a fully configured store still never triggers autoBackup, and shutdown completes without waiting on it', async () => {
    const exit = vi.fn((_code: number): never => undefined as never);
    const handleClose = vi.fn(async () => undefined);

    await coordinatedShutdown(
      'SIGTERM',
      () => ({ socketPath: '/fake', close: handleClose }),
      '/scratch/configured/db.sqlite',
      exit,
    );

    expect(mockAutoBackup).not.toHaveBeenCalled();
    expect(mockCloseAllAdapters).toHaveBeenCalledTimes(1);
    expect(handleClose).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('[ff7d9e24] an unconfigured store (null) also never triggers autoBackup', async () => {
    const exit = vi.fn((_code: number): never => undefined as never);
    const handleClose = vi.fn(async () => undefined);

    await coordinatedShutdown(
      'SIGTERM',
      () => ({ socketPath: '/fake', close: handleClose }),
      null,
      exit,
    );

    expect(mockAutoBackup).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe('[ff7d9e24] handleDirectStdioShutdown (index.ts) never touches the store on shutdown — no VACUUM in the shutdown path', () => {
  beforeEach(() => {
    __resetDirectShutdownStateForTest();
  });

  afterEach(() => {
    __resetDirectShutdownStateForTest();
  });

  it('[ff7d9e24] a configured store logs the skip reason and exits without ever opening/backing up the store', async () => {
    const exit = vi.fn((_code: number): never => undefined as never);
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await handleDirectStdioShutdown('SIGTERM', '/scratch/configured/db.sqlite', exit);

      const written = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toMatch(/skipping pre-restart backup for \/scratch\/configured\/db\.sqlite \(ff7d9e24: no VACUUM in shutdown path/);
      expect(written).not.toMatch(/running pre-restart backup/);
      expect(written).not.toMatch(/pre-restart backup saved/);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('[ff7d9e24] an unconfigured store still skips cleanly with the pre-existing message', async () => {
    const exit = vi.fn((_code: number): never => undefined as never);
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await handleDirectStdioShutdown('SIGTERM', null, exit);

      const written = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toMatch(/no store configured \(SOX_CONFIG_DB_PATH unset\) — skipping pre-restart backup/);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      writeSpy.mockRestore();
    }
  });
});
