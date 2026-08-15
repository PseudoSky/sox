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
