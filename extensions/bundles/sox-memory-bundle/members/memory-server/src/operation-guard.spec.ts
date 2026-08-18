/**
 * operation-guard.spec.ts — BUG-MEMORYSERVER-WEDGES-SILENTLY-NO-SELF-RECOVERY-001.
 *
 * BL-225 red→green, actually run:
 *
 *   RED  — a store call that never settles (the incident's exact shape:
 *          `openDb()` blocked past 120s, 0% CPU, no error, no return) is
 *          demonstrated first as UNBOUNDED: raced against a short timer with
 *          nothing wrapping it, it is still pending. That is the pre-fix
 *          behaviour — this is what `handleToolCall` did for every store call
 *          before this file existed.
 *   GREEN — the SAME blocked call, wrapped in `withOperationDeadline`, fails
 *          fast with a typed (`StoreOperationTimeoutError`, `code:
 *          'E_STORE_OPERATION_TIMEOUT'`) and traced (`log.error(
 *          'store.operation.timeout', {...})`, asserted via a spy on the
 *          real `@adhd/sox-memory-core` `log` object — the same log module
 *          every other emitter in this codebase uses, not a fake) error.
 *
 * Every deadline/threshold is driven through the real env-var surface
 * (`DEADLINE_ENV`/`SLOW_OP_THRESHOLD_ENV`) with tiny values here — never a
 * hand-rolled constant reimplementing the module's own defaults — so a
 * regression in the env-parsing path itself would also be caught.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { log } from '@adhd/sox-memory-core';
import {
  withOperationDeadline,
  StoreOperationTimeoutError,
  deadlineMsFor,
  slowOpThresholdMs,
  DEADLINE_ENV,
  SLOW_OP_THRESHOLD_ENV,
} from './operation-guard.js';

const ENV_KEYS = [...Object.values(DEADLINE_ENV), SLOW_OP_THRESHOLD_ENV];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  vi.useFakeTimers();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A promise that NEVER settles — the incident's exact failure shape
 *  (`openDb()` blocked indefinitely: not an error, not a resolve, just
 *  gone). This is what a genuinely hung native driver call looks like from
 *  the calling JS's perspective. */
function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {
    /* intentionally never resolves or rejects */
  });
}

describe('deadlineMsFor / slowOpThresholdMs — env surface', () => {
  it('falls back to documented defaults when unset', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(deadlineMsFor('connect')).toBe(30_000);
    expect(deadlineMsFor('read')).toBe(30_000);
    // BL-576: raised from 45_000 to 120_000 — `mutate` is the documented
    // fallback class for any future unclassified tool "in case it embeds"
    // (index.ts's toolOperationClass doc comment), so it must clear the
    // real measured embed max (109089ms) with real margin exactly like
    // `write` does, not just be "generous relative to nominal cost".
    expect(deadlineMsFor('mutate')).toBe(120_000);
    expect(deadlineMsFor('mutate')).toBeGreaterThan(109_089);
    // Sized with real margin above the measured production embed max
    // (109089ms, corroborated 2026-08-17 with a fresh n=3873 pull of the
    // same real telemetry source — see operation-guard.ts's doc comment) —
    // asserted here so a future edit cannot silently shrink it back toward
    // the incident report's explicit warning against a "10s blanket
    // deadline".
    expect(deadlineMsFor('write')).toBe(150_000);
    expect(deadlineMsFor('write')).toBeGreaterThan(109_089);
    expect(slowOpThresholdMs()).toBe(3_000);
  });

  it('honours a per-class env override, re-read per call (not cached)', () => {
    expect(deadlineMsFor('read')).toBe(30_000);
    process.env[DEADLINE_ENV.read] = '77';
    expect(deadlineMsFor('read')).toBe(77);
    delete process.env[DEADLINE_ENV.read];
    expect(deadlineMsFor('read')).toBe(30_000);
  });

  it('ignores a non-positive/garbage override and falls back to the default', () => {
    process.env[DEADLINE_ENV.mutate] = '-5';
    expect(deadlineMsFor('mutate')).toBe(120_000);
    process.env[DEADLINE_ENV.mutate] = 'not-a-number';
    expect(deadlineMsFor('mutate')).toBe(120_000);
  });
});

describe('withOperationDeadline — RED→GREEN on a blocked store call', () => {
  it('RED: an unwrapped hung call is still pending past where a deadline would fire', async () => {
    vi.useRealTimers();
    const raced = await Promise.race([
      neverSettles<string>().then(() => 'resolved' as const),
      new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 25)),
    ]);
    expect(raced).toBe('still-pending');
  });

  it('GREEN: wrapped, the same hung call fails fast with a typed, traced StoreOperationTimeoutError', async () => {
    process.env[DEADLINE_ENV.connect] = '30';
    const errorSpy = vi.spyOn(log, 'error');

    const promise = withOperationDeadline(() => neverSettles<unknown>(), {
      opClass: 'connect',
      opName: 'test.blocked_connect',
      dbPath: '/tmp/bug-memoryserver-wedges-001-test.db',
    });
    // Attach the rejection assertion BEFORE advancing timers so vitest never
    // observes an "unhandled rejection" window.
    const assertion = expect(promise).rejects.toBeInstanceOf(StoreOperationTimeoutError);
    await vi.advanceTimersByTimeAsync(30);
    await assertion;

    // TYPED: the caller can distinguish this from any other failure and
    // read structured fields off it (not just a string message).
    await promise.catch((err: unknown) => {
      expect(err).toBeInstanceOf(StoreOperationTimeoutError);
      const typed = err as StoreOperationTimeoutError;
      expect(typed.code).toBe('E_STORE_OPERATION_TIMEOUT');
      expect(typed.opClass).toBe('connect');
      expect(typed.opName).toBe('test.blocked_connect');
      expect(typed.timeoutMs).toBe(30);
      expect(typed.dbPath).toBe('/tmp/bug-memoryserver-wedges-001-test.db');
    });

    // TRACED: a structured log line was emitted through the SAME `log`
    // object every other memory-core/memory-server emitter uses (trace_id
    // is stamped automatically by `emit()` in memory-core/telemetry.ts —
    // not re-asserted here since that stamping is memory-core's own,
    // already-tested behaviour; what this suite owns is that the call site
    // happened at all, with the right identifying fields).
    expect(errorSpy).toHaveBeenCalledWith('store.operation.timeout', expect.objectContaining({
      op_class: 'connect',
      op_name: 'test.blocked_connect',
      db_path: '/tmp/bug-memoryserver-wedges-001-test.db',
      timeout_ms: 30,
    }));
  });

  it('never fires the deadline for a call that resolves in time', async () => {
    process.env[DEADLINE_ENV.read] = '1000';
    const errorSpy = vi.spyOn(log, 'error');
    const resultPromise = withOperationDeadline(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 'ok';
    }, { opClass: 'read', opName: 'test.fast_read' });
    await vi.advanceTimersByTimeAsync(5);
    expect(await resultPromise).toBe('ok');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('propagates a genuine rejection unchanged (not miscast as a timeout)', async () => {
    process.env[DEADLINE_ENV.mutate] = '1000';
    const boom = new Error('real driver error, not a hang');
    await expect(
      withOperationDeadline(() => Promise.reject(boom), { opClass: 'mutate', opName: 'test.real_error' }),
    ).rejects.toBe(boom);
  });

  it('surfaces connection_health via the extraFields thunk on a timeout log line', async () => {
    process.env[DEADLINE_ENV.connect] = '10';
    const errorSpy = vi.spyOn(log, 'error');
    const promise = withOperationDeadline(() => neverSettles<unknown>(), {
      opClass: 'connect',
      opName: 'test.health_wired',
      extraFields: () => ({ connection_health: 'poisoned' }),
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(StoreOperationTimeoutError);
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(errorSpy).toHaveBeenCalledWith('store.operation.timeout', expect.objectContaining({
      connection_health: 'poisoned',
    }));
  });

  it('logs a slow_still_running warning for an in-flight op past the slow threshold, before it settles', async () => {
    process.env[SLOW_OP_THRESHOLD_ENV] = '10';
    process.env[DEADLINE_ENV.read] = '1000';
    const warnSpy = vi.spyOn(log, 'warn');
    let resolveFn!: (v: string) => void;
    const gate = new Promise<string>((resolve) => { resolveFn = resolve; });
    const promise = withOperationDeadline(() => gate, { opClass: 'read', opName: 'test.slow_op' });

    await vi.advanceTimersByTimeAsync(15);
    expect(warnSpy).toHaveBeenCalledWith('store.operation.slow_still_running', expect.objectContaining({
      op_name: 'test.slow_op',
    }));

    resolveFn('done');
    await vi.advanceTimersByTimeAsync(0);
    expect(await promise).toBe('done');
    expect(warnSpy).toHaveBeenCalledWith('store.operation.slow_finished', expect.objectContaining({
      op_name: 'test.slow_op',
    }));
  });

  it('logs completed_after_timeout when the underlying call eventually resolves post-timeout', async () => {
    process.env[DEADLINE_ENV.connect] = '10';
    const warnSpy = vi.spyOn(log, 'warn');
    let resolveFn!: (v: string) => void;
    const gate = new Promise<string>((resolve) => { resolveFn = resolve; });
    const promise = withOperationDeadline(() => gate, { opClass: 'connect', opName: 'test.recovers_late' });

    const rejectedAssertion = expect(promise).rejects.toBeInstanceOf(StoreOperationTimeoutError);
    await vi.advanceTimersByTimeAsync(10);
    await rejectedAssertion;

    // The underlying (never-cancelled) call finally returns, well after the
    // caller was already told it timed out.
    resolveFn('finally landed');
    await vi.advanceTimersByTimeAsync(0);
    expect(warnSpy).toHaveBeenCalledWith('store.operation.completed_after_timeout', expect.objectContaining({
      op_name: 'test.recovers_late',
    }));
  });
});

/**
 * BL-576 — "prove or refute the right-censoring, then fix it".
 *
 * PRODUCTION-DISTRIBUTION FINDING (not re-run here — this is a unit suite,
 * not a log reader; recorded for the record and re-verifiable from disk):
 * the codebase's real embed-latency percentile source
 * (`fastembed_process.request.finish`'s `response_ms`, read by
 * `tools/scorecard.mjs`, sourced from
 * `~/.adhd/sox-ecosystem/memory-server/logs/memory-server.live-service-*.jsonl`)
 * was re-pulled fresh 2026-08-17: n=3873, p50=985ms p90=5532ms p95=12350ms
 * p99=38283ms max=109089ms. Only 1 of 3873 samples falls in the [43000,
 * 46000]ms band a right-censoring pileup at a ~45s ceiling would produce —
 * the tail continues smoothly out to 109089ms instead. That telemetry point
 * is measured entirely inside `SharedFastembedProcessClient.request()`,
 * which `withOperationDeadline` never cancels — so it is NOT subject to
 * this file's deadline at all, regardless of which `OperationClass` (or
 * historically, `mutate` vs `write`) the enclosing MCP tool call was
 * classified under. Additionally, `toolOperationClass` in `index.ts` has
 * classified every embed-capable tool (`memory_write`, `memory_write_batch`,
 * `memory_update`) as `write` (150s), never `mutate` (formerly 45s), since
 * this file's creation — verified via `git log`/`git show` on the
 * introducing commit (7c68852b). CONCLUSION: the specific "p99≈44s sitting
 * just under a 45s ceiling" hypothesis is REFUTED against real production
 * telemetry — no such pileup exists in the actual measured distribution,
 * and the mechanism that would have caused it does not reach that
 * telemetry point in current code.
 *
 * MECHANISM FINDING (proven below, independent of any production trace):
 * the abstract censoring mechanism IS real — if a consumer times *this
 * function's own caller-facing promise* (rather than reading a completion
 * time recorded deeper inside an un-cancelled `fn()`), every sample whose
 * true latency exceeds the deadline collapses onto a single point mass at
 * the deadline, discarding all of its true spread. This is exactly why the
 * `censored` field exists: it is the guard against a *future* consumer
 * building a percentile off the wrong (guard-boundary) telemetry point and
 * reproducing the artifact this investigation went looking for and did not
 * find in the metric that actually exists today.
 */
describe('BL-576 — right-censoring mechanism (controlled experiment) and fix', () => {
  it('MECHANISM PROOF: naively timing the guard boundary collapses every over-deadline sample onto one point (zero variance) regardless of true latency spread — while the true underlying completion times recorded via completed_after_timeout retain their full spread', async () => {
    process.env[DEADLINE_ENV.mutate] = '50';
    const deadlineMs = 50;
    // True latencies deliberately span BOTH sides of the deadline, with the
    // over-deadline ones spread widely (100..1000ms) — a stand-in for the
    // real embedding-provider tail (sub-second up to 109089ms in production).
    const trueLatencies = [10, 20, 40, 49, 100, 250, 400, 600, 800, 1000];

    const callerObservedElapsedWhenCensored: number[] = [];
    const trueRecoveredElapsedWhenCensored: number[] = [];
    const callerObservedElapsedWhenGenuine: number[] = [];

    for (const trueLatency of trueLatencies) {
      const warnSpy = vi.spyOn(log, 'warn');
      const startedAt = Date.now();
      const promise = withOperationDeadline(
        () => new Promise((resolve) => setTimeout(() => resolve('ok'), trueLatency)),
        { opClass: 'mutate', opName: `test.bl576_latency_${trueLatency}` },
      );
      // Capture the settle time THE MOMENT the guard's own promise settles
      // (not by reading Date.now() after bulk-advancing past it) — the
      // whole point under test is "what does a naive caller observe", and a
      // naive caller times its own await, which resolves at the virtual
      // instant the promise settles, not whenever the test happens to poll
      // the clock afterward.
      let settledAt: number | null = null;
      promise.then(
        () => { settledAt = Date.now(); },
        () => { settledAt = Date.now(); },
      );

      await vi.advanceTimersByTimeAsync(Math.max(trueLatency, deadlineMs));
      expect(settledAt).not.toBeNull();
      const callerObservedElapsed = settledAt! - startedAt;

      if (trueLatency > deadlineMs) {
        callerObservedElapsedWhenCensored.push(callerObservedElapsed);
        // Let the real underlying setTimeout (still running — never
        // cancelled) actually settle, and read its RECOVERED true elapsed
        // off the `completed_after_timeout` log line.
        await vi.advanceTimersByTimeAsync(0);
        const call = warnSpy.mock.calls.find(
          (c: unknown[]) => c[0] === 'store.operation.completed_after_timeout' &&
            (c[1] as Record<string, unknown>)['op_name'] === `test.bl576_latency_${trueLatency}`,
        );
        expect(call).toBeDefined();
        trueRecoveredElapsedWhenCensored.push((call![1] as Record<string, unknown>)['elapsed_ms'] as number);
      } else {
        callerObservedElapsedWhenGenuine.push(callerObservedElapsed);
      }
      vi.restoreAllMocks();
    }

    // THE CENSORING SIGNATURE: every over-deadline sample, no matter how far
    // its true latency ranged (100ms to 1000ms — a 10x spread), collapses
    // onto EXACTLY the same caller-observed value (the deadline itself).
    // Variance across a 10x true-latency spread is exactly zero once
    // observed at the guard boundary.
    expect(new Set(callerObservedElapsedWhenCensored).size).toBe(1);
    expect(callerObservedElapsedWhenCensored[0]).toBe(deadlineMs);
    expect(callerObservedElapsedWhenCensored.every((v) => v === deadlineMs)).toBe(true);

    // THE GROUND TRUTH: the true recovered elapsed times (read off
    // `completed_after_timeout`, which is NOT gated by the deadline) retain
    // their full spread — 100ms through 1000ms, matching what was asked for.
    expect(trueRecoveredElapsedWhenCensored).toEqual([100, 250, 400, 600, 800, 1000]);
    // Real spread survives: max - min is the full 900ms range, not 0.
    expect(Math.max(...trueRecoveredElapsedWhenCensored) - Math.min(...trueRecoveredElapsedWhenCensored)).toBe(900);

    // Genuine (non-timed-out) completions are unaffected and observed
    // accurately at the guard boundary too — the artifact is specific to
    // over-deadline samples, not a general measurement bias.
    expect(callerObservedElapsedWhenGenuine).toEqual([10, 20, 40, 49]);
  });

  it('FIX — abort signal: fn receives an AbortSignal that is aborted at the moment the deadline fires, letting an abort-aware callee stop waiting instead of riding the timeout out', async () => {
    process.env[DEADLINE_ENV.mutate] = '25';
    let observedAbortedAt: number | null = null;
    let receivedSignal: AbortSignal | undefined;

    const promise = withOperationDeadline(
      (signal) =>
        new Promise((_resolve, reject) => {
          receivedSignal = signal;
          signal.addEventListener('abort', () => {
            observedAbortedAt = Date.now();
            reject(signal.reason as Error);
          });
        }),
      { opClass: 'mutate', opName: 'test.bl576_abort_signal' },
    );

    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal!.aborted).toBe(false);

    // Attach the assertion BEFORE advancing timers (same convention as the
    // existing RED->GREEN test above) — awaiting it first would deadlock
    // under fake timers, since nothing ever advances the clock.
    const assertion = expect(promise).rejects.toBeInstanceOf(StoreOperationTimeoutError);
    await vi.advanceTimersByTimeAsync(25);
    await assertion;

    expect(receivedSignal!.aborted).toBe(true);
    expect(observedAbortedAt).not.toBeNull();
    // The abort reason IS the same typed timeout error the caller sees —
    // an abort-aware callee can inspect exactly why it was cancelled.
    expect(receivedSignal!.reason).toBeInstanceOf(StoreOperationTimeoutError);
  });

  it('FIX — backward compatibility: every existing 0-arg call site (() => Promise<T>) keeps working unmodified against the new AbortSignal-accepting signature', async () => {
    process.env[DEADLINE_ENV.read] = '1000';
    // Deliberately typed exactly as every call site in index.ts is today —
    // zero parameters. This must still typecheck and run.
    const zeroArgFn = (): Promise<string> => Promise.resolve('unmodified');
    const result = await withOperationDeadline(zeroArgFn, { opClass: 'read', opName: 'test.bl576_zero_arg' });
    expect(result).toBe('unmodified');
  });

  it('FIX — censored:true is stamped on both the StoreOperationTimeoutError and its store.operation.timeout log line, and is ABSENT (not merely false) from a genuine completed_after_timeout record', async () => {
    process.env[DEADLINE_ENV.mutate] = '15';
    const errorSpy = vi.spyOn(log, 'error');
    const warnSpy = vi.spyOn(log, 'warn');
    let resolveFn!: (v: string) => void;
    const gate = new Promise<string>((resolve) => { resolveFn = resolve; });

    const promise = withOperationDeadline(() => gate, { opClass: 'mutate', opName: 'test.bl576_censored_tag' });
    const rejected = expect(promise).rejects.toBeInstanceOf(StoreOperationTimeoutError);
    await vi.advanceTimersByTimeAsync(15);
    await rejected;

    await promise.catch((err: unknown) => {
      const typed = err as StoreOperationTimeoutError;
      expect(typed.censored).toBe(true);
    });
    expect(errorSpy).toHaveBeenCalledWith(
      'store.operation.timeout',
      expect.objectContaining({ censored: true }),
    );

    resolveFn('finally landed');
    await vi.advanceTimersByTimeAsync(0);
    const completedCall = warnSpy.mock.calls.find((c: unknown[]) => c[0] === 'store.operation.completed_after_timeout');
    expect(completedCall).toBeDefined();
    expect((completedCall![1] as Record<string, unknown>)['censored']).toBeUndefined();
  });

  it('DEFENSE-IN-DEPTH: mutate default (120000ms) clears the real measured production embed max (109089ms) with real margin, unlike the prior 45000ms default', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const MEASURED_PRODUCTION_EMBED_MAX_MS = 109_089;
    expect(deadlineMsFor('mutate')).toBeGreaterThan(MEASURED_PRODUCTION_EMBED_MAX_MS);
    // The OLD default would have failed this exact assertion — this is the
    // red->green: with DEADLINE_ENV.mutate forced to the old 45000 value,
    // the invariant this test protects is violated.
    process.env[DEADLINE_ENV.mutate] = '45000';
    expect(deadlineMsFor('mutate')).toBeLessThan(MEASURED_PRODUCTION_EMBED_MAX_MS);
    delete process.env[DEADLINE_ENV.mutate];
  });
});
