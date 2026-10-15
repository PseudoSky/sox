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
import { forceExit } from './hard-exit.js';

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
   *  {@link forceExit} — SIGKILL when a driver op is in flight, `process.exit`
   *  when idle, so this exit cannot itself be delayed by a blocked native step.
   *  Tests inject a spy instead. */
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
  /** Begin time of every in-flight request, keyed by a monotonic id. A Map
   *  iterates in insertion order, so the first value is always the OLDEST
   *  pending request's begin time. Its size is the pending count. */
  private readonly pendingBeganAt = new Map<number, number>();
  private nextRequestId = 0;
  private lastCompletionAt: number;
  private readonly thresholdMs: number;
  private readonly now: () => number;
  private readonly exit: (code: number) => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private tripped = false;

  constructor(opts: LivenessWatchdogOptions = {}) {
    this.thresholdMs = opts.thresholdMs ?? watchdogThresholdMs();
    this.now = opts.deps?.now ?? (() => Date.now());
    this.exit = opts.deps?.exit ?? ((code: number) => forceExit(code, 'liveness_watchdog'));
    this.lastCompletionAt = this.now();
  }

  /** Call at the start of every request. Returns an idempotent end-callback
   *  — call it exactly once when the request settles (success OR failure;
   *  a completed error response is still proof the server is alive). */
  beginRequest(opName: string): () => void {
    const id = this.nextRequestId++;
    this.pendingBeganAt.set(id, this.now());
    let ended = false;
    return (): void => {
      if (ended) return;
      ended = true;
      this.pendingBeganAt.delete(id);
      this.lastCompletionAt = this.now();
      void opName; // retained for future per-op liveness breakdowns; unused today
    };
  }

  getPendingCount(): number {
    return this.pendingBeganAt.size;
  }

  /** Time of the most recent completion (real completions only — never
   *  advanced by a request merely beginning). */
  getLastCompletionAt(): number {
    return this.lastCompletionAt;
  }

  /** Begin time of the oldest still-pending request, or undefined if idle. */
  private oldestPendingBeganAt(): number | undefined {
    for (const beganAt of this.pendingBeganAt.values()) return beganAt;
    return undefined;
  }

  /**
   * Milliseconds the server has gone without proof of life WHILE it owed a
   * response, or 0 when idle (3428f943).
   *
   * Staleness semantics: the clock starts at the LATER of (a) the last
   * completion and (b) the moment the oldest still-pending request began.
   *   - (b) is the 3428f943 fix: an idle gap (pending === 0) is not
   *     staleness. Without it, the first request after an idle gap longer
   *     than the threshold inherited a stale lastCompletionAt and was
   *     declared wedged on the next tick however briefly it had been pending.
   *   - (a) keeps completion-as-liveness: any completion (success or
   *     failure) restarts the clock for every request still pending, so a
   *     busy-but-progressing server is never killed. A straggler is not
   *     masked forever — once completions stop, it trips `thresholdMs`
   *     after the last one (or after its own begin, whichever is later).
   */
  private stalenessMs(): number {
    const oldest = this.oldestPendingBeganAt();
    if (oldest === undefined) return 0;
    return this.now() - Math.max(this.lastCompletionAt, oldest);
  }

  /**
   * Pure decision, exposed so tests can assert the conjunctive condition
   * directly without waiting on real timers.
   */
  isWedged(): boolean {
    return this.pendingBeganAt.size > 0 && this.stalenessMs() > this.thresholdMs;
  }

  /** Run one check. If wedged, logs loudly and exits (unless already
   *  tripped once — avoids a log/exit storm if `exit` is a test spy that
   *  doesn't actually terminate the process). Returns whether it was
   *  wedged, for tests. */
  checkOnce(): boolean {
    if (!this.isWedged()) return false;
    if (this.tripped) return true;
    this.tripped = true;

    const pending = this.pendingBeganAt.size;
    // Truthful elapsed (3428f943 AC4): measured from the liveness clock
    // (>= the oldest pending request's begin), never the idle gap before it.
    const elapsedMs = this.stalenessMs();
    const oldestPendingMs = this.now() - (this.oldestPendingBeganAt() ?? this.now());
    const fields = {
      pending_requests: pending,
      elapsed_since_last_completion_ms: elapsedMs,
      oldest_pending_ms: oldestPendingMs,
      threshold_ms: this.thresholdMs,
    };
    // LOUD on purpose (BUG-MEMORYSERVER-WEDGES-SILENTLY-NO-SELF-RECOVERY-001's
    // core complaint was silence): durable structured log AND raw stderr, so
    // the signal survives even if the telemetry sink itself is degraded.
    log.error('server.liveness.wedged', fields);
    process.stderr.write(
      `[memory-server] FATAL: liveness watchdog tripped — ${pending} request(s) pending, ` +
        `${elapsedMs}ms without a completion since the oldest request began (threshold ${this.thresholdMs}ms). ` +
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
