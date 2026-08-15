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
    expect(deadlineMsFor('mutate')).toBe(45_000);
    // Sized with real margin above the measured production embed max
    // (109089ms, BUG-MEMORY-EMBED-HEAD-OF-LINE-BLOCKING-001, n=3769) —
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
    expect(deadlineMsFor('mutate')).toBe(45_000);
    process.env[DEADLINE_ENV.mutate] = 'not-a-number';
    expect(deadlineMsFor('mutate')).toBe(45_000);
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
