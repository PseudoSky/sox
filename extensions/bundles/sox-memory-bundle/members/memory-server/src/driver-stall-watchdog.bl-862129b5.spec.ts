/**
 * driver-stall-watchdog.bl-862129b5.spec.ts — packet TUR-F (plan 862129b5).
 *
 * Red→green for the wiring of the off-thread Turso driver's stall handling into
 * memory-server:
 *
 *   1. `forceExit` — SIGKILLs (never a graceful `process.exit`) when a driver op
 *      is in flight, and calls `process.exit(code)` when the driver is idle.
 *      Deps are injected so the assertions observe the decision without killing
 *      the test runner.
 *   2. `DriverStallWatchdog` — a simulated `oldestOpAgeMs >= killAfterMs` calls
 *      `forceExit(70, 'driver_stall')` EXACTLY once; the half-threshold
 *      escalation logs once and never kills early; an idle driver is a no-op.
 *   3. `memory_ping` — a stalled driver reports `status: 'degraded'`, quickly
 *      (< 250 ms), and issues ZERO store queries (the resolved db path is never
 *      touched — the same `syncBuiltinESMExports()` fs-spy technique BL-412
 *      established, because index.ts reaches `fs` through an ESM binding).
 */

import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TursoDriverStatus } from '@adhd/sox-store-adapter';
import { forceExit, type HardExitDeps } from './hard-exit.js';
import { DRIVER_STALL_EXIT_CODE, DriverStallWatchdog } from './driver-stall-watchdog.js';
import { _setDriverStatusProviderForTest, handleToolCall } from './index.js';

const require = createRequire(__filename);
const fs = require('node:fs') as typeof import('node:fs');

type KillFn = (pid: number, signal: NodeJS.Signals) => void;
type ExitFn = (code: number) => never;
type ForceExitFn = (code: number, reason: string) => never;

/** A full `TursoDriverStatus` with the fields under test overridden. */
function driverStatus(overrides: Partial<TursoDriverStatus> = {}): TursoDriverStatus {
  const base: TursoDriverStatus = {
    state: 'busy',
    inFlight: 1,
    oldestOpLabel: 'all:SELECT 1',
    oldestOpAgeMs: 1_000,
    openConnections: 1,
    workerThreadId: 7,
    exits: 0,
  };
  return Object.assign(base, overrides);
}

describe('862129b5 forceExit — SIGKILL with an in-flight driver op, exit() when idle', () => {
  it('SIGKILLs and never calls the graceful exit when a driver op is in flight', () => {
    const kill = vi.fn();
    const exit = vi.fn((code: number): never => {
      throw new Error(`UNEXPECTED exit(${code})`);
    });
    const writeStderr = vi.fn();
    const deps: HardExitDeps = {
      status: () => driverStatus({ state: 'busy', inFlight: 1, oldestOpAgeMs: 42_000 }),
      kill: kill as unknown as KillFn,
      exit: exit as unknown as ExitFn,
      writeStderr,
    };

    // The injected `kill` returns (it does not really terminate), so `forceExit`
    // reaches its `never` terminator — the throw is the test's signal, not a
    // production path (real SIGKILL ends the process on the line before it).
    expect(() => forceExit(DRIVER_STALL_EXIT_CODE, 'driver_stall', deps)).toThrow(/injected kill/);

    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGKILL');
    expect(exit).not.toHaveBeenCalled();
    expect(writeStderr).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(writeStderr.mock.calls[0]![0])) as Record<string, unknown>;
    expect(payload.event).toBe('hard_exit.forced');
    expect(payload.reason).toBe('driver_stall');
    expect(payload.driver_in_flight).toBe(1);
    expect(payload.driver_oldest_op_age_ms).toBe(42_000);
  });

  it('calls process.exit(code) and never SIGKILLs when the driver is idle', () => {
    const kill = vi.fn();
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit(${code})`);
    });
    const deps: HardExitDeps = {
      status: () => driverStatus({ state: 'idle', inFlight: 0, oldestOpAgeMs: null }),
      kill: kill as unknown as KillFn,
      exit: exit as unknown as ExitFn,
      writeStderr: vi.fn(),
    };

    expect(() => forceExit(0, 'backend_exit', deps)).toThrow(/exit\(0\)/);
    expect(exit).toHaveBeenCalledWith(0);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('862129b5 DriverStallWatchdog', () => {
  it('calls forceExit(70,"driver_stall") EXACTLY once when oldestOpAgeMs >= killAfterMs', () => {
    const forceExitMock = vi.fn((code: number, reason: string): never => {
      throw new Error(`forceExit(${code},${reason})`);
    });
    const watchdog = new DriverStallWatchdog({
      killAfterMs: 1_000,
      intervalMs: 1_000_000,
      deps: {
        status: () => driverStatus({ state: 'stalled', inFlight: 1, oldestOpAgeMs: 1_500 }),
        forceExit: forceExitMock as unknown as ForceExitFn,
        warn: vi.fn(),
      },
    });

    expect(() => watchdog.checkOnce()).toThrow(/forceExit\(70,driver_stall\)/);
    expect(forceExitMock).toHaveBeenCalledTimes(1);
    expect(forceExitMock).toHaveBeenCalledWith(DRIVER_STALL_EXIT_CODE, 'driver_stall');

    // The one-shot latch: further ticks (the interval keeps firing) must not
    // re-invoke the exit.
    watchdog.checkOnce();
    watchdog.checkOnce();
    expect(forceExitMock).toHaveBeenCalledTimes(1);
    watchdog.stop();
  });

  it('logs the half-threshold escalation once and does not kill before killAfterMs', () => {
    const forceExitMock = vi.fn();
    const warn = vi.fn();
    const watchdog = new DriverStallWatchdog({
      killAfterMs: 1_000,
      deps: {
        status: () => driverStatus({ inFlight: 1, oldestOpAgeMs: 600 }),
        forceExit: forceExitMock as unknown as ForceExitFn,
        warn,
      },
    });

    expect(watchdog.checkOnce()).toBe(false);
    expect(watchdog.checkOnce()).toBe(false);
    const events = warn.mock.calls.map((c) => c[0]);
    expect(events.filter((e) => e === 'driver_stall.escalation')).toHaveLength(1);
    expect(forceExitMock).not.toHaveBeenCalled();
    watchdog.stop();
  });

  it('is a no-op while the driver is idle', () => {
    const forceExitMock = vi.fn();
    const watchdog = new DriverStallWatchdog({
      killAfterMs: 1_000,
      deps: {
        status: () => driverStatus({ state: 'idle', inFlight: 0, oldestOpAgeMs: null }),
        forceExit: forceExitMock as unknown as ForceExitFn,
        warn: vi.fn(),
      },
    });

    expect(watchdog.checkOnce()).toBe(false);
    expect(forceExitMock).not.toHaveBeenCalled();
    watchdog.stop();
  });
});

describe('862129b5 memory_ping — a stalled driver degrades the ping with zero store queries', () => {
  const TEST_DIR = path.join(os.tmpdir(), `sox-862129b5-${process.pid}`);

  beforeAll(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup — the tmpdir is disposable */
    }
  });

  afterEach(() => {
    _setDriverStatusProviderForTest(null);
  });

  it('reports status "degraded" within 250 ms and never touches the resolved store path', async () => {
    const dbPath = path.join(TEST_DIR, 'stalled.db');
    _setDriverStatusProviderForTest(() =>
      driverStatus({ state: 'stalled', inFlight: 1, oldestOpLabel: 'run:INSERT ...', oldestOpAgeMs: 47_000 }),
    );

    // Store-touch spy: the resolved db path is probed by `fs.existsSync` and
    // then opened by `getDb` — if the stall short-circuit is missing, one of
    // those touches the path. `syncBuiltinESMExports()` is required because
    // index.ts reaches `fs` through an ESM `import * as fs` binding.
    const touched: string[] = [];
    const originals = {
      existsSync: fs.existsSync,
      readFileSync: fs.readFileSync,
      statSync: fs.statSync,
    };
    for (const name of Object.keys(originals) as Array<keyof typeof originals>) {
      (fs as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
        if (typeof args[0] === 'string') touched.push(args[0]);
        return (originals[name] as (...a: unknown[]) => unknown).apply(fs, args);
      };
    }
    syncBuiltinESMExports();

    const startedAt = Date.now();
    let res: Awaited<ReturnType<typeof handleToolCall>>;
    try {
      res = await handleToolCall('memory_ping', { db_path: dbPath });
    } finally {
      for (const name of Object.keys(originals) as Array<keyof typeof originals>) {
        (fs as unknown as Record<string, unknown>)[name] = originals[name];
      }
      syncBuiltinESMExports();
    }
    const elapsedMs = Date.now() - startedAt;

    expect(res.isError).not.toBe(true);
    expect(elapsedMs).toBeLessThan(250);

    const parsed = JSON.parse((res.content[0] as { text: string }).text) as {
      ok: boolean;
      status: string;
      status_reason: string;
      store: unknown;
      driver: { state: string; in_flight: number; oldest_op_label: string | null; oldest_op_age_ms: number | null };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe('degraded');
    expect(parsed.status_reason).toContain('stalled');
    expect(parsed.driver.state).toBe('stalled');
    expect(parsed.driver.in_flight).toBe(1);
    expect(parsed.driver.oldest_op_label).toBe('run:INSERT ...');
    expect(parsed.store).toBeNull();

    // ZERO store queries: the resolved db path was never passed to the fs probe
    // gate that guards `getDb` — nor was any sibling under TEST_DIR.
    expect(touched).not.toContain(dbPath);
    expect(touched.some((p) => p === dbPath || p.startsWith(TEST_DIR))).toBe(false);
  });
});
