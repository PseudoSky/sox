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
 */
import { describe, it, expect, vi } from 'vitest';
import { log } from '@adhd/sox-memory-core';
import { LivenessWatchdog } from './liveness-watchdog.js';

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
    const errorSpy = vi.spyOn(log, 'error');
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

  it('multiple in-flight requests: only fully draining resets liveness; one straggler still trips it', () => {
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
    watchdog.beginRequest('memory_ping');
    expect(watchdog.getLastCompletionAt()).toBe(100);
  });

  it('3428f943 AC2: a request pending > threshold with no completion trips once with exit(1) and reason liveness_watchdog', () => {
    const errorSpy = vi.spyOn(log, 'error');
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
    const hardExit = await import('./hard-exit.js');
    const spy = vi.spyOn(hardExit, 'forceExit').mockImplementation((() => undefined) as never);
    let clock = 0;
    const wd = new LivenessWatchdog({ thresholdMs: 10, deps: { now: () => clock } });
    wd.beginRequest('x');
    clock = 11;
    wd.checkOnce();
    expect(spy).toHaveBeenCalledWith(1, 'liveness_watchdog');
    spy.mockRestore();
  });

  it('3428f943 AC3: a completion restarts the clock for requests still pending (completion = liveness); the straggler trips threshold after the last completion, not never', () => {
    // Chosen semantics: staleness = now - max(lastCompletionAt, oldestPendingBeganAt).
    const { watchdog, exit, advance } = makeWatchdog(1_000);
    watchdog.beginRequest('old_straggler'); // t=0, never ends
    advance(800);
    const endB = watchdog.beginRequest('b'); // t=800
    advance(100);
    endB(); // completion at t=900 resets the clock
    advance(1_000); // t=1900: exactly threshold since completion, straggler pending 1900ms
    expect(watchdog.checkOnce()).toBe(false);
    advance(1); // t=1901: > threshold since last completion
    expect(watchdog.checkOnce()).toBe(true);
    expect(exit).toHaveBeenCalledTimes(1);
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
    const errorSpy = vi.spyOn(log, 'error');
    errorSpy.mockClear();
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
    stderr.mockRestore();
  });
});
