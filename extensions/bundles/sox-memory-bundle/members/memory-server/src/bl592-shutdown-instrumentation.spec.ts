/**
 * bl592-shutdown-instrumentation.spec.ts — BL-592 / docs/spec/service-lifecycle.md
 * §8.1a part C.
 *
 * Proves two things about `coordinatedShutdown` that did NOT hold before this
 * fix (mirrors `backend-shutdown.spec.ts`/`bl472-shutdown-drain.spec.ts`'s own
 * `vi.mock('@adhd/sox-memory-core', ...)` + `vi.hoisted(...)` harness):
 *
 *   1. EVERY step logs a monotonic `t+Nms: step <k> <name> started/finished`
 *      line to stderr — RED against pre-fix code, which logged NOTHING per
 *      step (only the top-level "shutting down" / safety-net-fired lines).
 *      This is the direct fix for BUG-018's own "Not determined by this
 *      design pass" gap: a real stall could not be attributed to an exact
 *      step from the logs alone.
 *   2. Step 1 (`terminateEmbedWorkers`) is now bounded by its OWN
 *      `SHUTDOWN_EMBED_TERMINATE_TIMEOUT_MS` race, symmetric with step 0's
 *      pre-existing 750ms race — RED against pre-fix code, where step 1 was a
 *      bare unbounded `await` with no per-step backstop: a
 *      `terminateEmbedWorkers` that never resolves used to leave the whole
 *      sequence dependent on the single whole-sequence safety net; now the
 *      sequence continues past step 1 on its own bounded timeout.
 *   3. When a step DOES genuinely hang past the whole-sequence safety net
 *      (closeAllAdapters mocked to hang forever — this step remains
 *      deliberately unbounded per the design, §8.1a part C only added a race
 *      to step 1), the log shows that step's "started" line WITHOUT a
 *      matching "finished" line at the moment the safety net fires — proving
 *      the logging genuinely attributes an in-flight stall to the right step,
 *      not just decorating a sequence that always completes.
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

vi.mock('./index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./index.js')>();
  return {
    ...actual,
    waitForDrainSettled: mockWaitForDrainSettled,
  };
});

import {
  coordinatedShutdown,
  __resetShutdownStateForTest,
  SHUTDOWN_EMBED_TERMINATE_TIMEOUT_MS,
  SHUTDOWN_SAFETY_NET_MS,
} from './backend.js';

describe('BL-592 §8.1a part C — coordinatedShutdown per-step instrumentation', () => {
  let stderrLines: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrLines = [];
    writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrLines.push(String(chunk));
      return true;
    });
    mockCloseAllAdapters.mockReset();
    mockTerminateEmbedWorkers.mockReset();
    mockAutoBackup.mockReset();
    mockWriteQueueCloseAllForShutdown.mockReset();
    mockFlushPendingEmbeds.mockReset();
    mockWaitForDrainSettled.mockReset();
    __resetShutdownStateForTest();

    mockFlushPendingEmbeds.mockResolvedValue(undefined);
    mockWaitForDrainSettled.mockResolvedValue(undefined);
    mockTerminateEmbedWorkers.mockResolvedValue(undefined);
    mockCloseAllAdapters.mockResolvedValue(undefined);
    mockWriteQueueCloseAllForShutdown.mockResolvedValue(undefined);
    mockAutoBackup.mockResolvedValue({ path: '', size: 0, skipped: true });
  });

  afterEach(() => {
    writeSpy.mockRestore();
    vi.useRealTimers();
  });

  it('RED (pre-fix: zero per-step log lines existed) — logs a started/finished line naming every step', async () => {
    const exit = vi.fn((_code: number): never => undefined as never);
    const handleClose = vi.fn(async () => undefined);

    await coordinatedShutdown(
      'SIGTERM',
      () => ({ socketPath: '/fake', close: handleClose }),
      null,
      exit,
    );

    const joined = stderrLines.join('');
    for (const step of ['0', '1', '2', '2b', '3', '4']) {
      expect(joined).toMatch(new RegExp(`step ${step} .* started`));
      expect(joined).toMatch(new RegExp(`step ${step} .* finished`));
    }
    expect(joined).toMatch(/step 1 terminateEmbedWorkers started/);
    expect(joined).toMatch(/step 1 terminateEmbedWorkers finished/);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('RED (pre-fix: terminateEmbedWorkers was a bare unbounded await — a hang here blocked the entire sequence indefinitely, dependent only on the whole-sequence safety net) — step 1 is bounded by its OWN timeout and the sequence proceeds past it', async () => {
    vi.useFakeTimers();
    mockTerminateEmbedWorkers.mockImplementation(() => new Promise(() => {})); // never resolves

    const exit = vi.fn((_code: number): never => undefined as never);
    const handleClose = vi.fn(async () => undefined);

    const p = coordinatedShutdown(
      'SIGTERM',
      () => ({ socketPath: '/fake', close: handleClose }),
      null,
      exit,
    );

    // Step 1's own race fires at SHUTDOWN_EMBED_TERMINATE_TIMEOUT_MS — well
    // short of the whole-sequence safety net.
    await vi.advanceTimersByTimeAsync(SHUTDOWN_EMBED_TERMINATE_TIMEOUT_MS + 20);
    await p;

    expect(exit).toHaveBeenCalledWith(0);
    // closeAllAdapters (step 2) ran — proof the sequence did NOT stay stuck on
    // step 1 for the full SHUTDOWN_SAFETY_NET_MS.
    expect(mockCloseAllAdapters).toHaveBeenCalledTimes(1);
    const joined = stderrLines.join('');
    expect(joined).toMatch(/step 1 terminateEmbedWorkers started/);
    expect(joined).toMatch(/terminateEmbedWorkers exceeded \d+ms/);
    expect(joined).toMatch(/step 1 terminateEmbedWorkers finished/);
  });

  it('a step that genuinely hangs past the whole-sequence safety net logs "started" WITHOUT "finished" for that step at the moment the net fires (attributable to closeAllAdapters, step 2)', async () => {
    vi.useFakeTimers();
    mockCloseAllAdapters.mockImplementation(() => new Promise(() => {})); // never resolves

    const exit = vi.fn((_code: number): never => undefined as never);
    const handleClose = vi.fn(async () => undefined);

    void coordinatedShutdown(
      'SIGTERM',
      () => ({ socketPath: '/fake', close: handleClose }),
      null,
      exit,
    );

    await vi.advanceTimersByTimeAsync(SHUTDOWN_SAFETY_NET_MS + 20);

    expect(exit).toHaveBeenCalledWith(0);
    const joined = stderrLines.join('');
    // Step 1 fully completed (bounded, fast).
    expect(joined).toMatch(/step 1 terminateEmbedWorkers finished/);
    // Step 2 started but the safety net fired before it could finish.
    expect(joined).toMatch(/step 2 closeAllAdapters started/);
    expect(joined).not.toMatch(/step 2 closeAllAdapters finished/);
    expect(joined).toMatch(/exceeded \d+ms safety net/);
  });
});
