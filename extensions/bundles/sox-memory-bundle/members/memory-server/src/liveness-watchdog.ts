/**
 * liveness-watchdog.ts — BUG-MEMORYSERVER-WEDGES-SILENTLY-NO-SELF-RECOVERY-001.
 *
 * The incident's second finding: the wedged process "sat blocked at 0% CPU
 * indefinitely. There is no watchdog, no operation deadline, and no liveness
 * self-check that would have noticed 'I have not completed a request in N
 * minutes' and reconnected or exited for launchd to restart." A service
 * that cannot serve should die, not linger — `soxe service enable` runs this
 * process under a supervisor precisely so a non-zero exit gets it restarted
 * automatically ([inv:singleton] / [inv:list-never-lies] in
 * docs/spec/service-lifecycle.md are unaffected: this is a normal supervised
 * exit, not a bypass of the singleton/reaper machinery).
 *
 * SAFETY (the "critical caution" from the incident): exiting on a false
 * positive is a self-inflicted outage. The trigger condition is deliberately
 * conjunctive — BOTH "at least one request is currently pending" AND "no
 * request has completed within the threshold" must hold. An idle server
 * (zero pending requests, however long since the last one) NEVER trips this,
 * by construction: `pending === 0` short-circuits `checkOnce()` before the
 * elapsed-time comparison is even evaluated.
 *
 * The default threshold (5 minutes) is set with real margin above the
 * largest per-operation-class deadline `operation-guard.ts` can produce
 * (`write` class, 150s default) plus the watchdog's own poll interval (30s
 * default) — under the deadlines now enforced there, an outstanding request
 * should ALWAYS resolve (success, typed timeout error, or crash) well inside
 * 5 minutes. If the watchdog ever fires with the deadlines in place, that is
 * itself a real finding: either a deadline was misconfigured, or a request
 * completed its await but got stuck in genuinely uninstrumented, non-store
 * synchronous work (e.g. spinning the event loop) — a class of hang the
 * deadlines cannot see, which is exactly what the watchdog exists to catch
 * as the last line of defense.
 */

import { log } from '@adhd/sox-memory-core';

export const WATCHDOG_THRESHOLD_ENV = 'SOX_MEMORY_SERVER_WATCHDOG_THRESHOLD_MS';
export const WATCHDOG_INTERVAL_ENV = 'SOX_MEMORY_SERVER_WATCHDOG_INTERVAL_MS';

const DEFAULT_WATCHDOG_THRESHOLD_MS = 5 * 60_000; // 5 minutes
const DEFAULT_WATCHDOG_INTERVAL_MS = 30_000; // 30 seconds

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function watchdogThresholdMs(): number {
  return readPositiveIntEnv(WATCHDOG_THRESHOLD_ENV, DEFAULT_WATCHDOG_THRESHOLD_MS);
}

export function watchdogIntervalMs(): number {
  return readPositiveIntEnv(WATCHDOG_INTERVAL_ENV, DEFAULT_WATCHDOG_INTERVAL_MS);
}

/** Injectable clock/exit for deterministic testing — no fake timers, no
 *  real process.exit() escaping a test run. */
export interface LivenessWatchdogDeps {
  now?: () => number;
  /** Called when the watchdog decides the process must die. Defaults to
   *  `process.exit`. Tests inject a spy instead. */
  exit?: (code: number) => void;
}

export interface LivenessWatchdogOptions {
  thresholdMs?: number;
  deps?: LivenessWatchdogDeps;
}

/**
 * Tracks in-flight MCP tool calls and, on a periodic tick, exits the process
 * non-zero if the server has requests pending but has not completed ANY
 * request (success or failure — completion is the liveness signal, not
 * success) within `thresholdMs`.
 */
export class LivenessWatchdog {
  private pending = 0;
  private lastCompletionAt: number;
  private readonly thresholdMs: number;
  private readonly now: () => number;
  private readonly exit: (code: number) => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private tripped = false;

  constructor(opts: LivenessWatchdogOptions = {}) {
    this.thresholdMs = opts.thresholdMs ?? watchdogThresholdMs();
    this.now = opts.deps?.now ?? (() => Date.now());
    this.exit = opts.deps?.exit ?? ((code: number) => process.exit(code));
    this.lastCompletionAt = this.now();
  }

  /** Call at the start of every request. Returns an idempotent end-callback
   *  — call it exactly once when the request settles (success OR failure;
   *  a completed error response is still proof the server is alive). */
  beginRequest(opName: string): () => void {
    this.pending += 1;
    let ended = false;
    return (): void => {
      if (ended) return;
      ended = true;
      this.pending = Math.max(0, this.pending - 1);
      this.lastCompletionAt = this.now();
      void opName; // retained for future per-op liveness breakdowns; unused today
    };
  }

  getPendingCount(): number {
    return this.pending;
  }

  getLastCompletionAt(): number {
    return this.lastCompletionAt;
  }

  /**
   * Pure decision, exposed so tests can assert the conjunctive condition
   * directly without waiting on real timers.
   */
  isWedged(): boolean {
    return this.pending > 0 && this.now() - this.lastCompletionAt > this.thresholdMs;
  }

  /** Run one check. If wedged, logs loudly and exits (unless already
   *  tripped once — avoids a log/exit storm if `exit` is a test spy that
   *  doesn't actually terminate the process). Returns whether it was
   *  wedged, for tests. */
  checkOnce(): boolean {
    if (!this.isWedged()) return false;
    if (this.tripped) return true;
    this.tripped = true;

    const elapsedMs = this.now() - this.lastCompletionAt;
    const fields = {
      pending_requests: this.pending,
      elapsed_since_last_completion_ms: elapsedMs,
      threshold_ms: this.thresholdMs,
    };
    // LOUD on purpose (BUG-MEMORYSERVER-WEDGES-SILENTLY-NO-SELF-RECOVERY-001's
    // core complaint was silence): durable structured log AND raw stderr, so
    // the signal survives even if the telemetry sink itself is degraded.
    log.error('server.liveness.wedged', fields);
    process.stderr.write(
      `[memory-server] FATAL: liveness watchdog tripped — ${this.pending} request(s) pending, ` +
        `${elapsedMs}ms since the last request completed (threshold ${this.thresholdMs}ms). ` +
        'A service that cannot serve should die, not linger — exiting non-zero for the ' +
        'supervisor to restart (BUG-MEMORYSERVER-WEDGES-SILENTLY-NO-SELF-RECOVERY-001).\n',
    );
    this.exit(1);
    return true;
  }

  /** Start the periodic tick. `unref()`d so it never keeps the process
   *  alive on its own — the same convention every other background timer
   *  in this file already follows. */
  start(intervalMs: number = watchdogIntervalMs()): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkOnce(), intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

/** Process-wide singleton — the one watchdog instance every request path
 *  (direct-stdio's `registeredTools` AND backend mode's `handleBackendRequest`
 *  → `handleToolCall`) reports to, since both funnel through the single
 *  `handleToolCall` choke point. */
export const serverLivenessWatchdog = new LivenessWatchdog();
