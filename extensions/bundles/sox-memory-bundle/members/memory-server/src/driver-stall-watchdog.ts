/**
 * driver-stall-watchdog.ts — packet TUR-F (plan 862129b5).
 *
 * TUR-C/D moved the native Turso driver onto an off-thread worker
 * (`turso-driver-host.ts`). A stalled driver op therefore no longer freezes the
 * main thread, which means the off-thread main-thread watcher in
 * `mainthread-monitor.ts` can never see it, and the pending-request liveness
 * watchdog (`liveness-watchdog.ts`) cannot end it either: that watchdog is a
 * main-thread `setInterval` and only fires while a request is pending past its
 * threshold — a driver op can stall with no MCP call routed through it at all.
 *
 * This module is the missing owner. On an interval it reads the driver host's
 * SYNCHRONOUS, zero-worker-touch status snapshot (`getTursoDriverStatus()` never
 * touches the worker and never spawns one) and, once the oldest in-flight
 * driver op is older than `killAfterMs`, force-exits the process so the
 * supervisor restarts it ([inv:singleton] / [inv:list-never-lies] are
 * unaffected: this is a normal supervised exit). The store's WAL is the
 * durability boundary — a wedged native step is not recoverable in-process.
 *
 * POLICY LIVES HERE (memory-server), not in the store-adapter (ADR-0006
 * layering): the adapter only REPORTS the stall (`getTursoDriverStatus`);
 * the decision to die belongs to the policy owner — this module.
 *
 * NO ENV TOGGLES (ADR-0013 D3): tuning is typed config passed to the
 * constructor; the default kill threshold REUSES
 * `DEFAULT_MAINTHREAD_KILL_AFTER_MS` so driver stalls and main-thread stalls
 * share one budget.
 */

import { log } from '@adhd/sox-memory-core';
import { getTursoDriverStatus, type TursoDriverStatus } from '@adhd/sox-store-adapter';
import { DEFAULT_MAINTHREAD_KILL_AFTER_MS } from './mainthread-monitor.js';
import { forceExit } from './hard-exit.js';

/** Exit code used when the driver-stall watchdog ends the process. */
export const DRIVER_STALL_EXIT_CODE = 70;
/** Machine-readable reason paired with {@link DRIVER_STALL_EXIT_CODE}. */
export const DRIVER_STALL_REASON = 'driver_stall';

/** Poll period. Independent of `killAfterMs`; a fast, no-op read while idle. */
const DEFAULT_DRIVER_STALL_INTERVAL_MS = 30_000;

/** Injectable seams — production uses every default below. */
export interface DriverStallWatchdogDeps {
  /** Synchronous driver snapshot. Default: the real host reader (zero worker touch). */
  status?: () => TursoDriverStatus;
  /** Process-exit seam. Default: {@link forceExit} (SIGKILL when a driver op is in flight). */
  forceExit?: (code: number, reason: string) => never;
  /** Structured warning sink. Default: memory-core's `log.warn`. */
  warn?: (event: string, fields: Record<string, unknown>) => void;
}

export interface DriverStallWatchdogOptions {
  /** Poll period, ms. Default {@link DEFAULT_DRIVER_STALL_INTERVAL_MS}. */
  intervalMs?: number;
  /**
   * Oldest in-flight driver-op age, ms, at which the process is force-exited.
   * Default {@link DEFAULT_MAINTHREAD_KILL_AFTER_MS} (the same budget the
   * main-thread kill path uses).
   */
  killAfterMs?: number;
  deps?: DriverStallWatchdogDeps;
}

/**
 * Reads driver status on an interval and force-exits once the oldest in-flight
 * op outlives `killAfterMs`. Escalates once (a warning) at `killAfterMs / 2`.
 */
export class DriverStallWatchdog {
  private readonly intervalMs: number;
  private readonly killAfterMs: number;
  private readonly status: () => TursoDriverStatus;
  private readonly exit: (code: number, reason: string) => never;
  private readonly warn: (event: string, fields: Record<string, unknown>) => void;

  private timer: ReturnType<typeof setInterval> | undefined;
  /** True once the half-threshold escalation has been logged for THIS stall. */
  private escalated = false;
  /** True once the kill path has fired — makes the exit a one-shot. */
  private killed = false;

  constructor(opts: DriverStallWatchdogOptions = {}) {
    this.killAfterMs = opts.killAfterMs ?? DEFAULT_MAINTHREAD_KILL_AFTER_MS;
    this.intervalMs = opts.intervalMs ?? DEFAULT_DRIVER_STALL_INTERVAL_MS;
    this.status = opts.deps?.status ?? ((): TursoDriverStatus => getTursoDriverStatus());
    this.exit = opts.deps?.forceExit ?? ((code: number, reason: string): never => forceExit(code, reason));
    this.warn = opts.deps?.warn ?? ((event: string, fields: Record<string, unknown>): void => log.warn(event, fields));
  }

  /**
   * Run one check. Returns whether the watchdog acted on a live stall. A pure
   * status read (no worker touch); never throws — a status read that fails is
   * logged and treated as "no stall", so the watchdog cannot itself become a
   * new failure mode.
   */
  checkOnce(): boolean {
    let driver: TursoDriverStatus;
    try {
      driver = this.status();
    } catch (err) {
      this.warn('driver_stall.status_read_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }

    const age = driver.oldestOpAgeMs;
    if (driver.inFlight <= 0 || age === null) {
      // Nothing in flight — reset so a later, distinct stall escalates again.
      this.escalated = false;
      return false;
    }

    if (!this.escalated && age >= this.killAfterMs / 2) {
      this.escalated = true;
      this.warn('driver_stall.escalation', {
        oldest_op: driver.oldestOpLabel,
        oldest_op_age_ms: age,
        kill_after_ms: this.killAfterMs,
        detail: 'a Turso driver operation has been in flight past half the kill threshold',
      });
    }

    if (age >= this.killAfterMs) {
      if (!this.killed) {
        this.killed = true;
        this.warn('driver_stall.kill', {
          oldest_op: driver.oldestOpLabel,
          oldest_op_age_ms: age,
          kill_after_ms: this.killAfterMs,
          exit_code: DRIVER_STALL_EXIT_CODE,
          detail:
            'the off-thread Turso driver has not completed its oldest operation within the kill ' +
            'threshold — force-exiting for the supervisor to restart (a wedged native step cannot ' +
            'be recovered in-process).',
        });
        this.exit(DRIVER_STALL_EXIT_CODE, DRIVER_STALL_REASON);
      }
      return true;
    }

    return false;
  }

  /** Start the periodic tick. `unref()`d so it never keeps a process alive on its own. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.checkOnce(); }, this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

/**
 * Build, start, and return the process-wide driver-stall watchdog. Call once at
 * boot; the returned handle is `unref()`d and safe to keep for tests.
 */
export function startDriverStallWatchdog(opts: DriverStallWatchdogOptions = {}): DriverStallWatchdog {
  const watchdog = new DriverStallWatchdog(opts);
  watchdog.start();
  return watchdog;
}
