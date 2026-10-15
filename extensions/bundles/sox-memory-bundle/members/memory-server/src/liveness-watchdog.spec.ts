/**
 * liveness-watchdog.spec.ts — BUG-MEMORYSERVER-WEDGES-SILENTLY-NO-SELF-RECOVERY-001.
 *
 * BL-225 red→green, actually run, on the exact conjunctive predicate the
 * incident's "critical caution" demands:
 *
 *   the watchdog MUST exit when BOTH (a) at least one request is pending and
 *   (b) no request has completed within the threshold — and MUST NOT exit
 *   merely because the server has been idle, however long. "Exiting on a
 *   false positive is a self-inflicted outage."
 *
 * `exit` and `now` are injected (no real `process.exit`, no real timers) so
 * this suite can assert BOTH sides of that predicate deterministically
 * without ever risking terminating the test runner.
 *
 * Header (3428f943, repo test-header convention):
 *   Failure modes: (AC1-AC4) idle gap counted as staleness -> healthy server
 *   SIGKILLed; (AC5) post-request cleanup throw skips endLiveness -> permanent
 *   false pending entry -> idle SIGKILL; (AC6) wall-clock default jumps (NTP,
 *   sleep/wake) read as a wedge.
 *   Tier: S (unit; injected now/exit; no real timers, spawn or network).
 *   Fidelity gap: handleToolCall in index.ts is not executed here (import side
 *   effects); it delegates to endLivenessAfter, which is. launchd/SIGKILL are
 *   simulated by the injected exit spy.
 *   Recorded red->green (2026-10-14, bucket watchdog-idle-fix-b2):
 *     command: npx nx test memory-server -- src/liveness-watchdog.spec.ts
 *     RED  (endLivenessAfter without try/finally AND default clock reverted to
 *          Date.now): exit 1, 2 failed | 17 passed -- "AC5 endLiveness runs even
 *          when post-request cleanup throws" (expected 1 to be +0) and "AC6
 *          default clock is monotonic" (expected true to be false).
 *     GREEN (fix restored): exit 0, 19 passed.
 *   Earlier (4a3614fc) AC1-AC4 red evidence: previous executor scratchpad
 *   red.txt/green.txt (pre-idle-fix staleness code), cited by the ticket.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { log } from '@adhd/sox-memory-core';
import { LivenessWatchdog, endLivenessAfter } from './liveness-watchdog.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Silence the trip path's raw stderr write (and keep log.error from emitting). */
function quietTrips() {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return vi.spyOn(log, 'error').mockImplementation(() => undefined);
}

function makeWatchdog(thresholdMs: number, startAt = 0) {
  let clock = startAt;
  const exit = vi.fn();
  const watchdog = new LivenessWatchdog({
    thresholdMs,
    deps: { now: () => clock, exit },
  });
  return {
    watchdog,
    exit,
    advance: (ms: number) => { clock += ms; },
  };
}

describe('LivenessWatchdog — conjunctive wedge predicate', () => {
  it('RED-equivalent: an idle server (zero pending, however long since last completion) NEVER trips, at any elapsed time', () => {
    const { watchdog, exit, advance } = makeWatchdog(1_000);
    // No beginRequest() call at all — server has been idle since construction.
    advance(1_000_000); // absurdly long idle period
    expect(watchdog.isWedged()).toBe(false);
    expect(watchdog.checkOnce()).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });

  it('does not trip while a pending request is still within the threshold', () => {
    const { watchdog, exit, advance } = makeWatchdog(1_000);
    watchdog.beginRequest('memory_write');
    advance(999);
    expect(watchdog.isWedged()).toBe(false);
    expect(watchdog.checkOnce()).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });

  it('GREEN: trips ONLY when pending AND past-threshold both hold — logs loudly and exits non-zero', () => {
    const errorSpy = quietTrips();
    const { watchdog, exit, advance } = makeWatchdog(1_000);
    watchdog.beginRequest('memory_ping'); // pending, never ends — simulates the wedge
    advance(1_001);
    expect(watchdog.isWedged()).toBe(true);
    expect(watchdog.checkOnce()).toBe(true);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith('server.liveness.wedged', expect.objectContaining({
      pending_requests: 1,
      threshold_ms: 1_000,
    }));
  });

  it('a request completing (success OR failure) resets the liveness clock — completion is the signal, not success', () => {
    const { watchdog, exit, advance } = makeWatchdog(1_000);
    const end1 = watchdog.beginRequest('memory_recall');
    advance(900);
    end1(); // "completes" — e.g. even an error response still proves the server answered
    advance(900); // total elapsed since construction: 1800ms > threshold, but only 900ms since last completion
    expect(watchdog.isWedged()).toBe(false);
    expect(watchdog.checkOnce()).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });

  it('multiple in-flight requests: any completion restarts the clock for the rest; a straggler trips once completions stop', () => {
    quietTrips();
    const { watchdog, exit, advance } = makeWatchdog(1_000);
    const end1 = watchdog.beginRequest('memory_write');
    const end2 = watchdog.beginRequest('memory_recall');
    advance(500);
    end1(); // one completes...
    advance(600); // ...but the other has now been pending 1100ms total, 600ms since end1's completion timestamp
    expect(watchdog.getPendingCount()).toBe(1);
    expect(watchdog.isWedged()).toBe(false); // 600ms since last completion, still under 1000ms threshold
    advance(500); // now 1100ms since last completion
    expect(watchdog.isWedged()).toBe(true);
    expect(watchdog.checkOnce()).toBe(true);
    expect(exit).toHaveBeenCalledTimes(1);
    void end2; // never called — the straggler that caused the trip
  });

  it('end-callback is idempotent — calling it twice does not double-decrement pending below zero', () => {
    const { watchdog } = makeWatchdog(1_000);
    const end = watchdog.beginRequest('memory_write');
    end();
    end();
    expect(watchdog.getPendingCount()).toBe(0);
  });

  it('only trips once even if checkOnce is polled repeatedly past the threshold (no exit-storm)', () => {
    quietTrips();
    const { watchdog, exit, advance } = makeWatchdog(1_000);
    watchdog.beginRequest('memory_ping');
    advance(2_000);
    expect(watchdog.checkOnce()).toBe(true);
    expect(watchdog.checkOnce()).toBe(true);
    expect(watchdog.checkOnce()).toBe(true);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

/**
 * Failure mode: after an idle gap longer than the threshold, the first request
 * inherits a stale lastCompletionAt and a healthy server is SIGKILLed on the
 * next tick (3428f943). Tier S (unit, injected clock/exit, no timers).
 * Gap: no real process/launchd; the tick is simulated by calling checkOnce().
 * Cited item: backlog 3428f943-03b2-4db1-b5fc-75beac8f191d, AC1-AC4.
 * Risk map: idle->busy transition (AC1), genuine wedge (AC2), concurrency
 * clock semantics (AC3), trip-log truthfulness (AC4).
 */
describe('LivenessWatchdog — idle gap must not count as staleness (3428f943)', () => {
  it('3428f943 AC1: after an idle gap > threshold, a fresh request does not trip until IT has been pending > threshold', () => {
    quietTrips();
    const { watchdog, exit, advance } = makeWatchdog(1_000);
    advance(10_000); // idle gap 10x threshold, pending === 0
    watchdog.beginRequest('memory_recall'); // e.g. store reopen blocks the main thread
    advance(1);
    expect(watchdog.isWedged()).toBe(false);
    expect(watchdog.checkOnce()).toBe(false);
    advance(998); // pending 999ms
    expect(watchdog.checkOnce()).toBe(false);
    advance(1); // pending exactly threshold: not strictly greater
    expect(watchdog.checkOnce()).toBe(false);
    expect(exit).not.toHaveBeenCalled();
    advance(1); // pending threshold + 1
    expect(watchdog.checkOnce()).toBe(true);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('3428f943 AC1: idle gap after a prior completed request behaves the same (completion then long idle then new request)', () => {
    const { watchdog, exit, advance } = makeWatchdog(1_000);
    watchdog.beginRequest('memory_write')();
    advance(50_000);
    watchdog.beginRequest('memory_recall');
    advance(500);
    expect(watchdog.checkOnce()).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });

  it('3428f943 AC1: getLastCompletionAt is only advanced by real completions, not by a request beginning', () => {
    const { watchdog, advance } = makeWatchdog(1_000, 100);
    advance(5_000);
    const end = watchdog.beginRequest('memory_ping');
    expect(watchdog.getLastCompletionAt()).toBe(100); // begin did not advance it
    advance(7);
    end(); // a real completion does
    expect(watchdog.getLastCompletionAt()).toBe(5_107);
  });

  it('3428f943 AC2: a request pending > threshold with no completion trips once with exit(1) and reason liveness_watchdog', () => {
    const errorSpy = quietTrips();
    const { watchdog, exit, advance } = makeWatchdog(1_000);
    advance(10_000); // idle first, so this also proves AC1 does not weaken AC2
    watchdog.beginRequest('memory_ping');
    advance(1_001);
    expect(watchdog.checkOnce()).toBe(true);
    expect(watchdog.checkOnce()).toBe(true);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith('server.liveness.wedged', expect.objectContaining({ pending_requests: 1 }));
  });

  it('3428f943 AC2: default exit reason is liveness_watchdog', async () => {
    quietTrips();
    const hardExit = await import('./hard-exit.js');
    const spy = vi.spyOn(hardExit, 'forceExit').mockImplementation((() => undefined) as never);
    try {
      let clock = 0;
      const wd = new LivenessWatchdog({ thresholdMs: 10, deps: { now: () => clock } });
      wd.beginRequest('x');
      clock = 11;
      wd.checkOnce();
      expect(spy).toHaveBeenCalledWith(1, 'liveness_watchdog');
    } finally {
      spy.mockRestore();
    }
  });

  it('3428f943 AC3: a completion of a NEWER request does not mask an older one forever once completions stop; draining everything returns to idle (never trips)', () => {
    const { watchdog, exit, advance } = makeWatchdog(1_000);
    const endOld = watchdog.beginRequest('old');
    advance(900);
    watchdog.beginRequest('newer')(); // completes immediately at t=900
    advance(500);
    expect(watchdog.checkOnce()).toBe(false); // old pending 1400ms but only 500ms since completion
    endOld();
    advance(100_000);
    expect(watchdog.getPendingCount()).toBe(0);
    expect(watchdog.checkOnce()).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });

  it('3428f943 AC3: a request begun after a completion is measured from its own begin when that is later than the completion', () => {
    const { watchdog, exit, advance } = makeWatchdog(1_000);
    watchdog.beginRequest('first')(); // completion at t=0
    advance(5_000); // idle
    watchdog.beginRequest('second'); // begin at t=5000 (later than completion)
    advance(1_000);
    expect(watchdog.checkOnce()).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });

  it('3428f943 AC4: the trip log elapsed field reflects time since the oldest pending request began, not the idle gap', () => {
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { watchdog, advance } = makeWatchdog(1_000);
    advance(500_000); // huge idle gap
    watchdog.beginRequest('memory_recall');
    advance(1_234);
    expect(watchdog.checkOnce()).toBe(true);
    const call = errorSpy.mock.calls.find((c) => c[0] === 'server.liveness.wedged');
    expect(call).toBeDefined();
    const fields = call![1] as Record<string, number>;
    expect(fields.elapsed_since_last_completion_ms).toBe(1_234);
    expect(fields.oldest_pending_ms).toBe(1_234);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('1234ms');
    expect(String(stderr.mock.calls[0]?.[0])).not.toContain('501234');
  });
});

/**
 * 3428f943 AC5/AC6 (static-review correction, run dispatch-2026-10-14-a1c4).
 * Failure mode AC5: handleToolCall's finally awaited releaseTransientBackupStores()
 * BEFORE endLiveness(); a rejection skipped endLiveness, leaving a permanent false
 * pending entry that arms an idle SIGKILL. Failure mode AC6: the default clock was
 * wall-clock Date.now(), so an NTP step or sleep/wake jump looked like a wedge.
 * Tier S (unit, injected clock/exit, no timers/spawn/network).
 * Fidelity gap: index.ts's handleToolCall is not imported (module-level side
 * effects); its finally delegates to the unit-tested endLivenessAfter, so the
 * wiring itself is covered only by typecheck/build, not by an executed test.
 * Cited item: backlog 3428f943-03b2-4db1-b5fc-75beac8f191d AC5, AC6.
 */
describe('LivenessWatchdog — cleanup failure and clock source (3428f943)', () => {
  it('3428f943 AC5: endLiveness runs even when post-request cleanup throws (pending returns to 0, no later trip)', async () => {
    const { watchdog, exit, advance } = makeWatchdog(1_000);
    const end = watchdog.beginRequest('memory_write');
    expect(watchdog.getPendingCount()).toBe(1);
    await expect(
      endLivenessAfter(end, async () => {
        throw new Error('releaseTransientBackupStores rejected');
      }),
    ).rejects.toThrow('releaseTransientBackupStores rejected');
    expect(watchdog.getPendingCount()).toBe(0);
    advance(1_000_000);
    expect(watchdog.checkOnce()).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });

  it('3428f943 AC5: endLiveness runs exactly once on the success path, after cleanup completes', async () => {
    const order: string[] = [];
    const end = vi.fn(() => { order.push('end'); });
    await endLivenessAfter(end, async () => { order.push('cleanup'); });
    expect(order).toEqual(['cleanup', 'end']);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('3428f943 AC5: a cleanup that never settles keeps the request pending (hung cleanup is a wedge)', () => {
    const { watchdog, advance } = makeWatchdog(1_000);
    const end = watchdog.beginRequest('memory_write');
    void endLivenessAfter(end, () => new Promise<void>(() => undefined));
    advance(1_001);
    expect(watchdog.getPendingCount()).toBe(1);
    expect(watchdog.isWedged()).toBe(true);
  });

  it('3428f943 AC6: default clock is monotonic — a wall-clock (Date.now) jump does not trip the watchdog', () => {
    const exit = vi.fn();
    const wd = new LivenessWatchdog({ thresholdMs: 60_000, deps: { exit } }); // no injected now
    wd.beginRequest('memory_recall');
    const real = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(real + 3_600_000); // NTP step / wake from sleep: +1h
    expect(wd.checkOnce()).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });
});
