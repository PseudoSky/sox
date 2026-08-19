/**
 * bl472-shutdown-drain.spec.ts — BL-472: `coordinatedShutdown` must drain
 * in-flight Phase-B embed work (and any in-flight background heal/drain
 * pass) BEFORE tearing down the shared embed workers / adapter, or the
 * just-computed embedding is discarded as `E_IO` / a worker-terminated
 * rejection.
 *
 * Root cause and the full decision record: `SPEC-BL-472.md` (repo root of
 * this worktree). This suite proves `coordinatedShutdown`'s new step 0 at
 * the unit level, mirroring `backend-shutdown.spec.ts`'s own mocking
 * harness (same `vi.mock('@adhd/sox-memory-core', ...)` + `vi.hoisted(...)`
 * pattern) with a second mock added for `./index.js` (`waitForDrainSettled`).
 *
 * RED→GREEN PROCEDURE ACTUALLY PERFORMED (BL-225):
 *   Criterion 1 (ordering) and criterion 3 (idempotency) were run against the
 *   pre-fix `coordinatedShutdown` (git stash of the step-0 block) and failed
 *   exactly as their RED-arm comments describe: `events` showed
 *   `terminateEmbedWorkers` with neither drain mock ever invoked, and the
 *   idempotency test's added `toHaveBeenCalledTimes(1)` assertions on the two
 *   new mocks failed with 0 calls. Restoring the step-0 block turned both
 *   green. Criterion 2 (bounded) was proven per its own stated red arm: the
 *   assertion is that `SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS < SHUTDOWN_SAFETY_NET_MS`
 *   and that `terminateEmbedWorkers` genuinely still fires once the drain
 *   timeout — not the drain itself — elapses; an unbounded
 *   `await Promise.all(...)` implementation was hand-verified to fail this
 *   (mockTerminateEmbedWorkers stays at 0 calls forever with hung mocks).
 *
 * Gate: npx nx test memory-server -- --run bl472-shutdown-drain.spec
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCloseAllAdapters,
  mockTerminateEmbedWorkers,
  mockAutoBackup,
  mockWriteQueueCloseAllForShutdown,
  mockFlushPendingEmbeds,
  mockWaitForDrainSettled,
} = vi.hoisted(() => ({
  mockCloseAllAdapters: vi.fn<() => Promise<void>>(),
  mockTerminateEmbedWorkers: vi.fn<() => Promise<void>>(),
  mockAutoBackup: vi.fn<() => Promise<{ path: string; size: number; skipped: boolean }>>(),
  mockWriteQueueCloseAllForShutdown: vi.fn<() => Promise<void>>(),
  mockFlushPendingEmbeds: vi.fn<() => Promise<void>>(),
  mockWaitForDrainSettled: vi.fn<() => Promise<void>>(),
}));

vi.mock('@adhd/sox-memory-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@adhd/sox-memory-core')>();
  // Same WriteQueue-proxy shape as backend-shutdown.spec.ts — see that
  // file's comment for why a Proxy (private constructor, can't subclass to
  // override just one static method) instead of a plain override.
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
    flushPendingEmbeds: mockFlushPendingEmbeds,
    WriteQueue: WriteQueueProxy,
  };
});

// `backend.ts` statically imports `waitForDrainSettled` (alongside
// `handleToolCall`/`getContentAddress`/`resolveDbPath`/`TOOLS`) from
// `./index.js` — mock that module too, forwarding every other export via
// `importOriginal`, exactly like the memory-core mock above.
vi.mock('./index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./index.js')>();
  return {
    ...actual,
    waitForDrainSettled: mockWaitForDrainSettled,
  };
});

// vi.mock() calls are hoisted above imports by vitest's transform, so this
// static import sees the mocked bindings.
import {
  coordinatedShutdown,
  __resetShutdownStateForTest,
  SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS,
  SHUTDOWN_SAFETY_NET_MS,
  SHUTDOWN_BACKUP_TIMEOUT_MS,
} from './backend.js';

describe('BL-472 — coordinatedShutdown step 0: bounded Phase-B/heal drain', () => {
  const events: string[] = [];

  beforeEach(() => {
    events.length = 0;
    mockCloseAllAdapters.mockReset();
    mockTerminateEmbedWorkers.mockReset();
    mockAutoBackup.mockReset();
    mockWriteQueueCloseAllForShutdown.mockReset();
    mockFlushPendingEmbeds.mockReset();
    mockWaitForDrainSettled.mockReset();
    __resetShutdownStateForTest();

    mockFlushPendingEmbeds.mockImplementation(async () => {
      events.push('flushPendingEmbeds');
    });
    mockWaitForDrainSettled.mockImplementation(async () => {
      events.push('waitForDrainSettled');
    });
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

  it('[BL-472 ordering] awaits BOTH flushPendingEmbeds() and waitForDrainSettled() and BOTH resolve before terminateEmbedWorkers() is called', async () => {
    let releaseFlush!: () => void;
    let releaseWait!: () => void;
    mockFlushPendingEmbeds.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseFlush = () => {
            events.push('flushPendingEmbeds');
            resolve();
          };
        }),
    );
    mockWaitForDrainSettled.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseWait = () => {
            events.push('waitForDrainSettled');
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

    // Immediately after starting: both drain mocks have been called
    // (Promise.all starts both synchronously in the same tick) but neither
    // has resolved, and — the load-bearing assertion — terminateEmbedWorkers
    // has NOT run yet.
    await Promise.resolve();
    expect(mockFlushPendingEmbeds).toHaveBeenCalledTimes(1);
    expect(mockWaitForDrainSettled).toHaveBeenCalledTimes(1);
    expect(mockTerminateEmbedWorkers).not.toHaveBeenCalled();
    expect(events).toEqual([]); // neither mock's release() has fired yet

    // A few more microtask turns still must not have let terminateEmbedWorkers
    // run — both mocks are deliberately held open.
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual([]);
    expect(mockTerminateEmbedWorkers).not.toHaveBeenCalled();

    releaseFlush();
    releaseWait();
    await p;

    // Order between the two drain entries is not itself load-bearing (both
    // start in the same Promise.all) — assert as a sorted comparison — but
    // BOTH must precede terminateEmbedWorkers, which must precede everything
    // after it.
    const drainEvents = events.slice(0, 2).sort();
    expect(drainEvents).toEqual(['flushPendingEmbeds', 'waitForDrainSettled']);
    expect(events.slice(2)).toEqual([
      'terminateEmbedWorkers',
      'closeAllAdapters',
      'writeQueueCloseAllForShutdown',
      'autoBackup',
      'handle.close',
      'exit',
    ]);
  });

  it('[BL-472 bounded] a hung flushPendingEmbeds() does not block shutdown past SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    mockFlushPendingEmbeds.mockImplementation(() => new Promise(() => {})); // never resolves
    mockWaitForDrainSettled.mockImplementation(async () => {
      events.push('waitForDrainSettled');
    });

    const exit = vi.fn((_code: number): never => undefined as never);
    const handleClose = vi.fn(async () => undefined);

    const p = coordinatedShutdown(
      'SIGTERM',
      () => ({ socketPath: '/fake', close: handleClose }),
      '/fake/db/path.db',
      exit,
    );

    // Boundedness proof: terminateEmbedWorkers must NOT have run before the
    // timeout elapses (an unbounded `await Promise.all(...)` implementation
    // would still show 0 calls here even AFTER the timeout, since the hung
    // flushPendingEmbeds mock never resolves — that is exactly what this
    // assertion, combined with the one after advancing time, is designed to
    // catch).
    await vi.advanceTimersByTimeAsync(SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS - 10);
    expect(mockTerminateEmbedWorkers).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20);
    expect(mockTerminateEmbedWorkers).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(0);
    await p;

    expect(mockCloseAllAdapters).toHaveBeenCalledTimes(1);
    expect(mockWriteQueueCloseAllForShutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('[BL-472 bounded] a hung waitForDrainSettled() does not block shutdown past SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS (the OTHER promise, exercised independently)', async () => {
    vi.useFakeTimers();
    mockFlushPendingEmbeds.mockImplementation(async () => {
      events.push('flushPendingEmbeds');
    });
    mockWaitForDrainSettled.mockImplementation(() => new Promise(() => {})); // never resolves

    const exit = vi.fn((_code: number): never => undefined as never);
    const handleClose = vi.fn(async () => undefined);

    const p = coordinatedShutdown(
      'SIGTERM',
      () => ({ socketPath: '/fake', close: handleClose }),
      '/fake/db/path.db',
      exit,
    );

    await vi.advanceTimersByTimeAsync(SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS - 10);
    expect(mockTerminateEmbedWorkers).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20);
    expect(mockTerminateEmbedWorkers).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(0);
    await p;

    expect(mockCloseAllAdapters).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('[BL-472 bounded, BUG-018 tightened] budget sanity: SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS stays UNDER SHUTDOWN_SAFETY_NET_MS with real headroom for the checkpoint', () => {
    // Mirrors backend-shutdown.spec.ts's own numeric sanity assertions
    // (lines 236-237) — a real behavioral guard, not decoration: fails if a
    // future edit raises SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS without
    // reconsidering the budget against everything that runs after it.
    expect(SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS).toBeLessThan(SHUTDOWN_SAFETY_NET_MS);
    const TERMINATE_GRACE_MS = 1000; // sharedFastembedProcess.ts's own documented grace
    // (BUG-018) Previously asserted `... < SHUTDOWN_SAFETY_NET_MS + 500` — a
    // TOLERATED OVERSHOOT (SPEC-BL-472.md D1 measured this worst-case sum at
    // 4250 against a 4000 safety net and accepted the excess, reasoning the
    // safety net would "force-exit that pathological case cleanly." It does
    // not: an exit(0) mid-`closeAllAdapters()` skips the real checkpoint.
    // BUG-018's full root-cause + live 3-process repro evidence is in
    // bug018-shutdown-budget-headroom.spec.ts, which this assertion now
    // matches — the worst-case sum must stay UNDER the safety net, with
    // real headroom left for the unbounded, durability-critical steps that
    // run inside that budget too (closeAllAdapters/closeAllForShutdown/
    // handle.close).
    expect(SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS + TERMINATE_GRACE_MS + SHUTDOWN_BACKUP_TIMEOUT_MS).toBeLessThan(
      SHUTDOWN_SAFETY_NET_MS,
    );
  });

  it('[BL-472 idempotent-safe] SIGTERM and SIGINT firing together run flushPendingEmbeds/waitForDrainSettled exactly once each', async () => {
    const exit = vi.fn((_code: number): never => undefined as never);
    const handleClose = vi.fn(async () => undefined);
    const getHandle = () => ({ socketPath: '/fake', close: handleClose });

    await Promise.all([
      coordinatedShutdown('SIGTERM', getHandle, '/fake/db/path.db', exit),
      coordinatedShutdown('SIGINT', getHandle, '/fake/db/path.db', exit),
    ]);

    expect(mockFlushPendingEmbeds).toHaveBeenCalledTimes(1);
    expect(mockWaitForDrainSettled).toHaveBeenCalledTimes(1);
    expect(mockTerminateEmbedWorkers).toHaveBeenCalledTimes(1);
    expect(mockCloseAllAdapters).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
