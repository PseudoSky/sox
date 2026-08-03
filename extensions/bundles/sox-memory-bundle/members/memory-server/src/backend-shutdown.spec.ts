/**
 * backend-shutdown.spec.ts — BL-405: the memory-server backend ignores
 * SIGTERM and is SIGKILLed on every restart.
 *
 * Root cause (see `coordinatedShutdown`'s doc comment in backend.ts): TWO
 * independent `process.on('SIGTERM', ...)` listeners raced to call
 * `process.exit()` — this module's own (which called `closeAllAdapters()`
 * WITHOUT awaiting it) and a second, unrelated one in `index.ts` (a full
 * VACUUM INTO pre-restart backup). Whichever finished first killed the
 * process and aborted the other's in-flight work, so the real WAL checkpoint
 * routinely never completed despite a "shutting down" log line implying a
 * clean exit. Verified empirically outside this suite (disposable backend,
 * real UDS socket, 30 real `memory_write` calls generating a 3.2MB WAL,
 * SIGTERM sent immediately after): the process exited in well under a
 * second and the WAL file was byte-identical afterward.
 *
 * This suite proves the SEQUENCED replacement (`coordinatedShutdown`) at the
 * unit level: the shared embed workers are torn down before the DB adapters,
 * the DB close is actually AWAITED before exit, the process only ever exits
 * once even if SIGTERM and SIGINT both fire, and a hung pre-restart backup
 * cannot block the exit past its own bounded timeout.
 *
 * Before this fix, the OLD `shutdown()` in backend.ts called
 * `closeAllAdapters()` without `await`, so a slow-resolving closeAllAdapters
 * mock would NOT delay `handle.close()`/exit at all — the "close awaited
 * before exit" assertion below is the one that would have failed red against
 * the pre-fix code (order recorded: handle.close/exit BEFORE closeAllAdapters
 * settles). See BL-405 in BACKLOG.md for the full write-up and the live
 * reaper evidence (`survived SIGTERM after 5000ms → SIGKILL`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCloseAllAdapters, mockTerminateEmbedWorkers, mockAutoBackup, mockWriteQueueCloseAllForShutdown } =
  vi.hoisted(() => ({
    mockCloseAllAdapters: vi.fn<() => Promise<void>>(),
    mockTerminateEmbedWorkers: vi.fn<() => Promise<void>>(),
    mockAutoBackup: vi.fn<() => Promise<{ path: string; size: number; skipped: boolean }>>(),
    mockWriteQueueCloseAllForShutdown: vi.fn<() => Promise<void>>(),
  }));

vi.mock('@adhd/sox-memory-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@adhd/sox-memory-core')>();
  // WriteQueue has a private constructor, so it cannot be subclassed to
  // override just one static method — proxy it instead, forwarding every
  // property except `closeAllForShutdown` to the real class. This keeps
  // these pure-ordering unit tests isolated from the REAL `WriteQueue`
  // singleton map (`WriteQueue.instances`), which is process-global and, in
  // a single-forked test worker, could otherwise carry real entries left
  // over from an unrelated spec file that ran earlier in the same worker.
  const WriteQueueProxy = new Proxy(actual.WriteQueue, {
    get(target, prop, receiver) {
      if (prop === 'closeAllForShutdown') return mockWriteQueueCloseAllForShutdown;
      return Reflect.get(target, prop, receiver);
    },
  });
  return {
    ...actual,
    closeAllAdapters: mockCloseAllAdapters,
    terminateEmbedWorkers: mockTerminateEmbedWorkers,
    autoBackup: mockAutoBackup,
    WriteQueue: WriteQueueProxy,
  };
});

// vi.mock() calls are hoisted above imports by vitest's transform, so this
// static import sees the mocked @adhd/sox-memory-core bindings.
import {
  coordinatedShutdown,
  __resetShutdownStateForTest,
  SHUTDOWN_BACKUP_TIMEOUT_MS,
  SHUTDOWN_SAFETY_NET_MS,
} from './backend.js';

describe('BL-405 — coordinatedShutdown', () => {
  const events: string[] = [];

  beforeEach(() => {
    events.length = 0;
    mockCloseAllAdapters.mockReset();
    mockTerminateEmbedWorkers.mockReset();
    mockAutoBackup.mockReset();
    mockWriteQueueCloseAllForShutdown.mockReset();
    __resetShutdownStateForTest();

    mockTerminateEmbedWorkers.mockImplementation(async () => {
      events.push('terminateEmbedWorkers');
    });
    mockCloseAllAdapters.mockImplementation(async () => {
      events.push('closeAllAdapters');
    });
    mockWriteQueueCloseAllForShutdown.mockImplementation(async () => {
      events.push('writeQueueCloseAllForShutdown');
    });
    mockAutoBackup.mockImplementation(async () => {
      events.push('autoBackup');
      return { path: '', size: 0, skipped: true };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sequences shared-worker teardown BEFORE the DB checkpoint, and AWAITS the checkpoint before closing the handle/exiting (the pre-fix race)', async () => {
    // A slow-resolving closeAllAdapters must genuinely delay handle.close()
    // and exit() — this is exactly the assertion the pre-fix code (which
    // called closeAllAdapters() without await) would FAIL: it recorded
    // handle.close/exit before closeAllAdapters ever settled.
    let releaseClose!: () => void;
    mockCloseAllAdapters.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseClose = () => {
            events.push('closeAllAdapters');
            resolve();
          };
        }),
    );

    const handleClose = vi.fn(async () => {
      events.push('handle.close');
    });
    const exit = vi.fn((_code: number): never => {
      events.push('exit');
      return undefined as never;
    });

    const p = coordinatedShutdown(
      'SIGTERM',
      () => ({ socketPath: '/fake', close: handleClose }),
      '/fake/db/path.db',
      exit,
    );

    // Let the microtask queue drain so terminateEmbedWorkers has a chance to
    // run — closeAllAdapters is deliberately stuck.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual(['terminateEmbedWorkers']);
    expect(handleClose).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    releaseClose();
    await p;

    expect(events).toEqual([
      'terminateEmbedWorkers',
      'closeAllAdapters',
      'writeQueueCloseAllForShutdown',
      'autoBackup',
      'handle.close',
      'exit',
    ]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('is idempotent — SIGTERM and SIGINT firing together run the teardown exactly once', async () => {
    const exit = vi.fn((_code: number): never => undefined as never);
    const handleClose = vi.fn(async () => undefined);
    const getHandle = () => ({ socketPath: '/fake', close: handleClose });

    await Promise.all([
      coordinatedShutdown('SIGTERM', getHandle, '/fake/db/path.db', exit),
      coordinatedShutdown('SIGINT', getHandle, '/fake/db/path.db', exit),
    ]);

    expect(mockTerminateEmbedWorkers).toHaveBeenCalledTimes(1);
    expect(mockCloseAllAdapters).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('a null dbPathForBackup SKIPS the backup entirely — never guesses ~/.memory/memory.db (found while writing this suite)', async () => {
    // Discovered live: `runBackend()` used to call `resolveDbPath(undefined)`
    // unconditionally, which falls back to the REAL `~/.memory/memory.db`
    // when SOX_CONFIG_DB_PATH isn't set — exactly the case for a bare/test
    // spawn. A stray SIGTERM reaching such a backend (e.g. a leaked
    // process.on() listener from an earlier test in the same vitest worker)
    // then opened a real readonly connection to the LIVE production store
    // as a pure side effect of running `nx test` — observed as
    // `store.integrity.repair_failed db_path: /Users/nix/.memory/memory.db`
    // in this suite's own test output before this guard was added.
    // `runBackend()` now passes `null` unless SOX_CONFIG_DB_PATH was
    // explicitly set; `coordinatedShutdown` must skip the backup step for
    // `null` rather than falling back to any default.
    const exit = vi.fn((_code: number): never => undefined as never);
    const handleClose = vi.fn(async () => undefined);

    await coordinatedShutdown(
      'SIGTERM',
      () => ({ socketPath: '/fake', close: handleClose }),
      null,
      exit,
    );

    expect(mockAutoBackup).not.toHaveBeenCalled();
    expect(mockTerminateEmbedWorkers).toHaveBeenCalledTimes(1);
    expect(mockCloseAllAdapters).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('a hung pre-restart backup never blocks exit past its own bounded timeout — the checkpoint already ran', async () => {
    vi.useFakeTimers();

    // autoBackup that never resolves — simulates a VACUUM INTO on a large
    // store that outruns the whole restart's share of the reaper grace.
    mockAutoBackup.mockImplementation(() => new Promise(() => {}));

    const exit = vi.fn((_code: number): never => undefined as never);
    const handleClose = vi.fn(async () => undefined);

    const p = coordinatedShutdown(
      'SIGTERM',
      () => ({ socketPath: '/fake', close: handleClose }),
      '/fake/db/path.db',
      exit,
    );

    // closeAllAdapters (the real, required checkpoint) must have already
    // completed before the backup's own timeout is what's gating anything.
    await vi.advanceTimersByTimeAsync(0);
    expect(mockCloseAllAdapters).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    // Advance past the backup's own bounded timeout (well short of the
    // overall safety net) — shutdown must proceed without ever awaiting the
    // hung autoBackup() call.
    await vi.advanceTimersByTimeAsync(SHUTDOWN_BACKUP_TIMEOUT_MS + 10);
    await p;

    expect(handleClose).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    // Sanity: the backup timeout is comfortably inside the overall safety
    // net, which is itself comfortably inside the reaper's 5000ms grace.
    expect(SHUTDOWN_BACKUP_TIMEOUT_MS).toBeLessThan(SHUTDOWN_SAFETY_NET_MS);
    expect(SHUTDOWN_SAFETY_NET_MS).toBeLessThan(5000);
  });

  it('a total teardown hang is force-exited by the safety net, strictly inside the reaper 5000ms grace', async () => {
    vi.useFakeTimers();

    // Everything hangs — even the "required" checkpoint step.
    mockTerminateEmbedWorkers.mockImplementation(() => new Promise(() => {}));
    mockCloseAllAdapters.mockImplementation(() => new Promise(() => {}));

    const exit = vi.fn((_code: number): never => undefined as never);
    const handleClose = vi.fn(async () => undefined);

    // Deliberately NOT awaited: terminateEmbedWorkers() never resolves, so
    // the coordinatedShutdown() promise itself never settles — exactly like
    // production, where `exit()` really terminates the process and nothing
    // downstream of it runs. The safety net (a separate, unref'd timer) is
    // what fires `exit()` here; that's the only thing under test.
    void coordinatedShutdown(
      'SIGTERM',
      () => ({ socketPath: '/fake', close: handleClose }),
      '/fake/db/path.db',
      exit,
    );

    await vi.advanceTimersByTimeAsync(SHUTDOWN_SAFETY_NET_MS - 10);
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20);

    expect(exit).toHaveBeenCalledWith(0);
    expect(SHUTDOWN_SAFETY_NET_MS).toBeLessThan(5000);
  });
});
