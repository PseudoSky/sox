/**
 * mainthread-monitor.ts — (5b58b189) main-thread observability for memory-server.
 *
 * THE GAP: every Turso step runs synchronously on the Node main thread (the
 * driver's step loop, `@tursodatabase/database-common/dist/promise.js`), so a
 * slow step — an FTS writer open over thousands of segments, or a plain read
 * blocked in `pread` (seen at 22:02Z) — freezes the whole MCP server. Nothing
 * in telemetry showed it: the process looked alive, SIGTERM handlers could not
 * run, and the only diagnosis was `sample <pid>`. Three signals close it:
 *
 *   1. `mainthread.lag` — every `intervalMs`, the event-loop delay distribution
 *      (perf_hooks `monitorEventLoopDelay`: p50/p99/max/mean) plus process CPU%
 *      and RSS over the interval. Also exposed as the `mainthread` section of
 *      every `metrics.snapshot` line (registerSnapshotSection).
 *   2. `mainthread.blocked{duration_ms}` — a 100 ms drift ticker: when a tick
 *      lands `blockedThresholdMs` or more late, the loop was blocked that long.
 *      Emitted AFTER the block ends (nothing on the main thread can run during).
 *   3. `mainthread.stalled{blocked_for_ms}` — an OFF-THREAD watcher (a
 *      worker_thread reading a SharedArrayBuffer heartbeat the drift ticker
 *      writes) that reports a stall WHILE it is happening, by writing a JSON
 *      line straight to fd 2 with `fs.writeSync` (a worker's `process.stderr`
 *      is proxied through the main thread and would block with it). Re-reported
 *      at doubling intervals while the stall persists.
 *
 * Everything is `unref()`'d: the monitor never keeps a finished process alive.
 * The liveness watchdog (liveness-watchdog.ts) remains the kill-switch; this
 * module only makes the cause visible.
 */
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { log, registerSnapshotSection } from '@adhd/sox-telemetry';

export interface MainThreadMonitorOptions {
  /** Lag-summary period. Default 30 000 ms. */
  intervalMs?: number;
  /** Drift at or above which a `mainthread.blocked` event is emitted. Default 1000 ms. */
  blockedThresholdMs?: number;
  /** Heartbeat age at which the off-thread watcher reports a live stall. Default 5000 ms. */
  stallThresholdMs?: number;
  /** Drift-ticker period. Default 100 ms. */
  tickMs?: number;
  /** Start the off-thread stall watcher. Default true. */
  offThreadWatcher?: boolean;
}

export interface LagSummary {
  interval_ms: number;
  p50_ms: number;
  p99_ms: number;
  max_ms: number;
  mean_ms: number;
  blocked_events: number;
  longest_block_ms: number;
  cpu_pct: number;
  rss_bytes: number;
  heap_used_bytes: number;
}

const NS_PER_MS = 1e6;

/** Source of the off-thread watcher (a worker `eval` string, so the bundled
 *  CJS artifact needs no sidecar file). Reads heartbeat[0] (epoch ms, written
 *  by the main thread) and writes a JSON line to fd 2 on a live stall. */
export const MAINTHREAD_WATCHER_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const hb = new Float64Array(workerData.sab);
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const threshold = workerData.stallThresholdMs;
let nextReportAt = threshold;
let reportedForBeat = -1;
for (;;) {
  Atomics.wait(sleeper, 0, 0, 250);
  const beat = hb[0];
  if (beat === 0) continue;
  if (hb[1] === 1) break; // stop flag
  const age = Date.now() - beat;
  if (beat !== reportedForBeat) { nextReportAt = threshold; }
  if (age >= nextReportAt) {
    reportedForBeat = beat;
    nextReportAt = nextReportAt * 2;
    try {
      fs.writeSync(2, JSON.stringify({
        ts: new Date().toISOString(), level: 'error', event: 'mainthread.stalled',
        pid: workerData.pid, blocked_for_ms: age,
        detail: 'the main thread has not run for blocked_for_ms — a synchronous step (e.g. a Turso driver step) is holding it; reported off-thread while the stall is live',
      }) + '\\n');
    } catch (e) {
      // fd 2 is closed (or the write itself failed) — the ONE other channel this
      // worker has is postMessage, which the main thread drains once the stall
      // ends and it can run again (BL: untraced catch — this must never be silent).
      try {
        parentPort?.postMessage({
          event: 'mainthread.watcher_write_failed',
          error: e instanceof Error ? e.message : String(e),
          blocked_for_ms: age,
        });
      } catch (e2) { /* postMessage itself failed — nothing else can report this */ }
    }
  }
}
`;

export class MainThreadMonitor {
  private readonly intervalMs: number;
  private readonly blockedThresholdMs: number;
  private readonly stallThresholdMs: number;
  private readonly tickMs: number;
  private readonly useWatcher: boolean;

  private histogram: IntervalHistogram | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private summaryTimer: ReturnType<typeof setInterval> | null = null;
  private watcher: Worker | null = null;
  private heartbeat: Float64Array | null = null;
  private unregisterSection: (() => void) | null = null;

  private lastTickAt = 0;
  private intervalStartedAt = 0;
  private cpuAtIntervalStart = process.cpuUsage();
  private blockedEvents = 0;
  private longestBlockMs = 0;
  private last: LagSummary | null = null;

  constructor(opts: MainThreadMonitorOptions = {}) {
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.blockedThresholdMs = opts.blockedThresholdMs ?? 1_000;
    this.stallThresholdMs = opts.stallThresholdMs ?? 5_000;
    this.tickMs = opts.tickMs ?? 100;
    this.useWatcher = opts.offThreadWatcher ?? true;
  }

  start(): void {
    if (this.tickTimer !== null) return;
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
    this.histogram.enable();
    const now = Date.now();
    this.lastTickAt = now;
    this.intervalStartedAt = now;
    this.cpuAtIntervalStart = process.cpuUsage();

    if (this.useWatcher) {
      try {
        const sab = new SharedArrayBuffer(16);
        this.heartbeat = new Float64Array(sab);
        this.heartbeat[0] = now;
        this.watcher = new Worker(MAINTHREAD_WATCHER_SOURCE, {
          eval: true,
          workerData: { sab, stallThresholdMs: this.stallThresholdMs, pid: process.pid },
        });
        this.watcher.unref();
        this.watcher.on('error', (err) => {
          log.warn('mainthread.watcher_failed', { error: err instanceof Error ? err.message : String(err) });
        });
        // The worker's own fd-2 write can fail (fd closed, etc) while the main
        // thread is still blocked and cannot receive anything; postMessage is
        // queued and delivered once the main thread runs again — traced here
        // rather than silently dropped inside the worker's eval string.
        this.watcher.on('message', (msg: { event?: string; error?: string; blocked_for_ms?: number }) => {
          log.warn(msg?.event ?? 'mainthread.watcher_message', {
            error: msg?.error,
            blocked_for_ms: msg?.blocked_for_ms,
          });
        });
      } catch (err) {
        this.watcher = null;
        this.heartbeat = null;
        log.warn('mainthread.watcher_unavailable', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    this.tickTimer = setInterval(() => this.tick(), this.tickMs);
    this.tickTimer.unref();
    this.summaryTimer = setInterval(() => this.emitSummary(), this.intervalMs);
    this.summaryTimer.unref();
    this.unregisterSection = registerSnapshotSection('mainthread', () => ({
      ...(this.last ?? {}),
      threshold_ms: this.blockedThresholdMs,
    }));
  }

  /** Drift ticker body — public for deterministic tests. */
  tick(nowMs: number = Date.now()): void {
    const drift = nowMs - this.lastTickAt - this.tickMs;
    this.lastTickAt = nowMs;
    if (this.heartbeat !== null) this.heartbeat[0] = nowMs;
    if (drift >= this.blockedThresholdMs) {
      this.blockedEvents += 1;
      if (drift > this.longestBlockMs) this.longestBlockMs = drift;
      log.warn('mainthread.blocked', { duration_ms: Math.round(drift), threshold_ms: this.blockedThresholdMs });
    }
  }

  /** Emit `mainthread.lag` for the elapsed interval and reset — public for tests. */
  emitSummary(nowMs: number = Date.now()): LagSummary {
    const h = this.histogram;
    const elapsedMs = Math.max(1, nowMs - this.intervalStartedAt);
    const cpu = process.cpuUsage(this.cpuAtIntervalStart);
    const mem = process.memoryUsage();
    const summary: LagSummary = {
      interval_ms: elapsedMs,
      p50_ms: h ? round2(h.percentile(50) / NS_PER_MS) : 0,
      p99_ms: h ? round2(h.percentile(99) / NS_PER_MS) : 0,
      max_ms: h ? round2(h.max / NS_PER_MS) : 0,
      mean_ms: h && Number.isFinite(h.mean) ? round2(h.mean / NS_PER_MS) : 0,
      blocked_events: this.blockedEvents,
      longest_block_ms: Math.round(this.longestBlockMs),
      cpu_pct: round2(((cpu.user + cpu.system) / 1000 / elapsedMs) * 100),
      rss_bytes: mem.rss,
      heap_used_bytes: mem.heapUsed,
    };
    log.info('mainthread.lag', { ...summary });
    this.last = summary;
    h?.reset();
    this.intervalStartedAt = nowMs;
    this.cpuAtIntervalStart = process.cpuUsage();
    this.blockedEvents = 0;
    this.longestBlockMs = 0;
    return summary;
  }

  get lastSummary(): LagSummary | null {
    return this.last;
  }

  get watcherRunning(): boolean {
    return this.watcher !== null;
  }

  async stop(): Promise<void> {
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    if (this.summaryTimer !== null) clearInterval(this.summaryTimer);
    this.tickTimer = null;
    this.summaryTimer = null;
    this.histogram?.disable();
    this.histogram = null;
    this.unregisterSection?.();
    this.unregisterSection = null;
    if (this.heartbeat !== null) this.heartbeat[1] = 1;
    const w = this.watcher;
    this.watcher = null;
    if (w !== null) await w.terminate();
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The process-wide monitor memory-server starts at boot. */
export const mainThreadMonitor = new MainThreadMonitor();
