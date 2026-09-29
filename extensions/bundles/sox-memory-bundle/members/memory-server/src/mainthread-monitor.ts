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
 *   4. KILL PATH (BL-d509dbe6) — the same off-thread watcher SIGKILLs this
 *      process once the main thread has not run for `killAfterMs`. The
 *      pending-request watchdog (liveness-watchdog.ts) is a `setInterval` ON
 *      the main thread, so it cannot fire during the very stall it exists for:
 *      in the incident a 21-minute `PRAGMA integrity_check` step held the
 *      thread and nothing in-process could end it. The watcher writes a raw
 *      line to fd 2 (the pending-request watchdog's pattern — the durable log
 *      sink runs on the blocked thread) and calls
 *      `process.kill(process.pid, 'SIGKILL')`, which a parked main thread
 *      cannot delay. The supervisor restarts the process; the store's
 *      deep-verify obligation (store-adapter deep-verify.ts) guarantees the
 *      restart does not re-run the stall inline.
 *
 * Clock: the heartbeat is `process.hrtime` milliseconds (monotonic, shared by
 * every thread, and on macOS not advancing across system sleep), never
 * `Date.now()` — a wall-clock age would read a closed laptop lid as a blocked
 * main thread and SIGKILL a healthy server on wake. A watcher that itself
 * overslept its poll by seconds (the whole process was stopped — SIGSTOP, a
 * debugger) measures ages from its own wake, not across the suspension.
 *
 * Everything is `unref()`'d: the monitor never keeps a finished process alive.
 * The pending-request liveness watchdog stays in place for the wedge it
 * catches (requests pending, none completing, loop still turning).
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
  /**
   * (BL-d509dbe6) Main-thread silence, ms, after which the off-thread watcher
   * SIGKILLs this process. Typed tuning (ADR-0013 D3): an integer in
   * [{@link MIN_MAINTHREAD_KILL_AFTER_MS}, {@link MAX_MAINTHREAD_KILL_AFTER_MS}];
   * anything else throws. Default {@link resolveMainThreadKillAfterMs} (the
   * `mainthread_kill_after_ms` config key, else
   * {@link DEFAULT_MAINTHREAD_KILL_AFTER_MS}).
   */
  killAfterMs?: number;
}

/**
 * Default main-thread silence before the off-thread SIGKILL: 5 minutes — the
 * same budget as the pending-request watchdog's threshold. The longest
 * legitimate main-thread holds on record are the synchronous Turso steps of a
 * `fast` open (~1 s on the 105 MB store) and ONNX model load (seconds); the
 * incident's hold was 21+ minutes. NOT measured: `VACUUM INTO` + its inline
 * deep check in the pre-restart `autoBackup` on the 417 MB store — that path
 * runs after the store queues are closed, so a kill there loses no writes and
 * re-arms nothing, but tune this key if backups are observed near the bound.
 */
export const DEFAULT_MAINTHREAD_KILL_AFTER_MS = 5 * 60_000;
export const MIN_MAINTHREAD_KILL_AFTER_MS = 1_000;
export const MAX_MAINTHREAD_KILL_AFTER_MS = 60 * 60_000;
/** Config-cascade env key carrying `mainthread_kill_after_ms` (ADR-0013 D5). */
export const MAINTHREAD_KILL_AFTER_CONFIG_ENV = 'SOX_CONFIG_MAINTHREAD_KILL_AFTER_MS';

function assertKillAfterMs(value: number, source: string): number {
  if (
    !Number.isInteger(value) ||
    value < MIN_MAINTHREAD_KILL_AFTER_MS ||
    value > MAX_MAINTHREAD_KILL_AFTER_MS
  ) {
    throw new Error(
      `${source}: mainthread kill-after must be an integer number of milliseconds in ` +
        `[${MIN_MAINTHREAD_KILL_AFTER_MS}, ${MAX_MAINTHREAD_KILL_AFTER_MS}]; got ${JSON.stringify(value)}. ` +
        `There is no value that disables the off-thread watchdog (ADR-0013).`,
    );
  }
  return value;
}

/**
 * Resolve the kill threshold from the config cascade. A present value that is
 * not a base-10 integer, or is out of range, THROWS — a misconfigured watchdog
 * must fail the boot loudly, never fall back silently (ADR-0013 D3).
 */
export function resolveMainThreadKillAfterMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MAINTHREAD_KILL_AFTER_CONFIG_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAINTHREAD_KILL_AFTER_MS;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(
      `${MAINTHREAD_KILL_AFTER_CONFIG_ENV}=${JSON.stringify(raw)} is not an integer number of milliseconds ` +
        `(config key mainthread_kill_after_ms).`,
    );
  }
  return assertKillAfterMs(Number.parseInt(raw.trim(), 10), MAINTHREAD_KILL_AFTER_CONFIG_ENV);
}

/** Monotonic milliseconds — the heartbeat clock shared with the watcher. */
function monoNowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
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
const opBuf = workerData.opBuf ? new Uint8Array(workerData.opBuf) : null;
function currentOp() {
  if (!opBuf) return null;
  const len = opBuf[0];
  if (!len) return null;
  try { return Buffer.from(opBuf.buffer, opBuf.byteOffset + 1, len).toString('utf8'); } catch { return null; }
}
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const nowMs = () => Number(process.hrtime.bigint() / 1000000n);
const POLL_MS = 250;
const SUSPEND_SLACK_MS = 2000;
const threshold = workerData.stallThresholdMs;
const killAfter = workerData.killAfterMs;
let nextReportAt = threshold;
let reportedForBeat = -1;
let lastWake = nowMs();
let suspendedFloor = 0;
function report(event, fields) {
  parentPort?.postMessage({ event, ...fields });
}
for (;;) {
  Atomics.wait(sleeper, 0, 0, POLL_MS);
  const now = nowMs();
  // This thread overslept by seconds: the whole process was stopped, not just
  // the main thread. Measure from this wake, never across the suspension.
  if (now - lastWake > POLL_MS + SUSPEND_SLACK_MS) suspendedFloor = now;
  lastWake = now;
  if (hb[1] === 1) break; // stop flag
  const beat = hb[0];
  if (beat === 0) continue;
  const age = now - Math.max(beat, suspendedFloor);
  if (beat !== reportedForBeat) { nextReportAt = threshold; }
  if (age >= nextReportAt) {
    reportedForBeat = beat;
    nextReportAt = nextReportAt * 2;
    try {
      fs.writeSync(2, JSON.stringify({
        ts: new Date().toISOString(), level: 'error', event: 'mainthread.stalled',
        pid: workerData.pid, blocked_for_ms: age, current_op: currentOp(),
        detail: 'the main thread has not run for blocked_for_ms — a synchronous step (e.g. a Turso driver step) is holding it; reported off-thread while the stall is live. current_op names the MCP tool dispatch in flight when the stall began, if any was recorded.',
      }) + '\\n');
    } catch (e) {
      // fd 2 is closed (or the write itself failed) — the ONE other channel this
      // worker has is postMessage, which the main thread drains once the stall
      // ends and it can run again.
      report('mainthread.watcher_write_failed', { error: e instanceof Error ? e.message : String(e), blocked_for_ms: age });
    }
  }
  if (typeof killAfter === 'number' && age >= killAfter) {
    // BL-d509dbe6: the main thread cannot run the pending-request watchdog,
    // a signal handler, or a timer. End the process from here.
    try {
      fs.writeSync(2, JSON.stringify({
        ts: new Date().toISOString(), level: 'fatal', event: 'mainthread.watchdog_kill',
        pid: workerData.pid, blocked_for_ms: age, kill_after_ms: killAfter, current_op: currentOp(),
      }) + '\\n' +
        '[memory-server] FATAL: main thread blocked for ' + age + 'ms (kill_after_ms ' + killAfter + ') — ' +
        'the off-thread watchdog is SIGKILLing pid ' + workerData.pid + ' for the supervisor to restart. ' +
        'A service that cannot serve should die, not linger (BL-d509dbe6).\\n');
    } catch (e) {
      report('mainthread.watchdog_kill_write_failed', { error: e instanceof Error ? e.message : String(e), blocked_for_ms: age });
    } finally {
      process.kill(process.pid, 'SIGKILL');
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
  private readonly killAfterMs: number;

  private histogram: IntervalHistogram | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private summaryTimer: ReturnType<typeof setInterval> | null = null;
  private watcher: Worker | null = null;
  private heartbeat: Float64Array | null = null;
  /** (mainthread-op-attribution) Shared byte buffer: [0]=len, [1..len]=UTF-8 label of the MCP tool currently dispatching on the main thread, or len=0 for none. Read by the off-thread watcher so a stall event can name what was running. */
  private opLabel: Uint8Array | null = null;
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
    this.killAfterMs =
      opts.killAfterMs !== undefined
        ? assertKillAfterMs(opts.killAfterMs, 'MainThreadMonitorOptions.killAfterMs')
        : resolveMainThreadKillAfterMs();
  }

  /** The resolved kill threshold (reported in the `mainthread` snapshot section). */
  get killAfter(): number {
    return this.killAfterMs;
  }

  /**
   * (per-call DB-op tracing, nesting) LIFO stack of in-flight operation
   * labels — frame 0 is always the tool-level label set by {@link setOp};
   * a DB-level {@link pushOp} call nests a more specific label on top
   * without clobbering it, and {@link popOp} unwinds back to whatever was
   * running before. Only {@link pushOp}/{@link popOp} touch frames above 0 —
   * {@link setOp}/{@link clearOp} (the tool-level call sites) are unchanged
   * and always reset the whole stack.
   */
  private opStack: string[] = [];

  /** Write `label` (or clear, for `label === null`) into the shared byte
   *  buffer the off-thread watcher reads — the actual wire format, shared by
   *  every one of `setOp`/`pushOp`/`popOp`/`clearOp`. */
  private _writeLabel(label: string | null): void {
    if (this.opLabel === null) return;
    if (label === null) {
      this.opLabel[0] = 0;
      return;
    }
    const bytes = Buffer.from(label, 'utf8').subarray(0, 31);
    this.opLabel.fill(0);
    this.opLabel[0] = bytes.length;
    this.opLabel.set(bytes, 1);
  }

  /**
   * (mainthread-op-attribution) Record the name of the operation about to run
   * synchronously on the main thread, so a live `mainthread.stalled` event can
   * name it instead of guessing. Call at the start of any request dispatch;
   * pair with {@link clearOp} in a `finally`. A label longer than 31 UTF-8
   * bytes is truncated, never thrown on.
   *
   * Tool-level baseline: resets the whole nesting stack to a single frame
   * (this label). Does NOT nest under a `pushOp` call — those are a
   * separate, DB-op-level concern (see {@link pushOp}).
   */
  setOp(label: string): void {
    this.opStack = [label];
    this._writeLabel(label);
  }

  /** Clear the current-operation label (no operation in flight). Also resets
   *  the nesting stack — call sites pair this with {@link setOp} in a
   *  `finally`, so any DB-op frame left dangling by an unbalanced
   *  `pushOp`/`popOp` is discarded along with the tool-level frame. */
  clearOp(): void {
    this.opStack = [];
    this._writeLabel(null);
  }

  /**
   * (per-call DB-op tracing, nesting) Nest a more specific, DB-operation-level
   * label on top of whatever tool-level label {@link setOp} already recorded
   * — the watcher reports the most specific in-flight op. Pair with
   * {@link popOp} in a `finally`. Never call `clearOp`/`setOp` from this
   * layer — those belong exclusively to the tool-dispatch call sites and
   * would clobber (or extend past) the tool-level baseline.
   */
  pushOp(label: string): void {
    this.opStack.push(label);
    this._writeLabel(label);
  }

  /** Pop the most specific DB-operation-level label pushed by {@link pushOp},
   *  restoring whatever was running before it (typically the tool-level
   *  label) — or clearing the buffer entirely if the stack is now empty
   *  (an unbalanced `popOp` called with no matching `pushOp`/`setOp`). */
  popOp(): void {
    this.opStack.pop();
    const top = this.opStack.length > 0 ? this.opStack[this.opStack.length - 1] : undefined;
    this._writeLabel(top ?? null);
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
        this.heartbeat[0] = monoNowMs();
        // (mainthread-op-attribution) 32 bytes: [0]=label length, [1..31]=UTF-8 label.
        // Plain writes, no Atomics — same tolerance as the heartbeat: a torn read
        // during the rare concurrent write just yields a stale or empty label, never
        // a crash, and this is diagnostic-only.
        const opBuf = new SharedArrayBuffer(32);
        this.opLabel = new Uint8Array(opBuf);
        this.watcher = new Worker(MAINTHREAD_WATCHER_SOURCE, {
          eval: true,
          workerData: {
            sab,
            opBuf,
            stallThresholdMs: this.stallThresholdMs,
            killAfterMs: this.killAfterMs,
            pid: process.pid,
          },
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
        this.opLabel = null;
        // error, not warn: without the watcher there is NO kill path for a
        // main-thread stall (BL-d509dbe6).
        log.error('mainthread.watcher_unavailable', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    this.tickTimer = setInterval(() => this.tick(), this.tickMs);
    this.tickTimer.unref();
    this.summaryTimer = setInterval(() => this.emitSummary(), this.intervalMs);
    this.summaryTimer.unref();
    this.unregisterSection = registerSnapshotSection('mainthread', () => ({
      ...(this.last ?? {}),
      threshold_ms: this.blockedThresholdMs,
      kill_after_ms: this.killAfterMs,
    }));
  }

  /** Drift ticker body — public for deterministic tests. */
  tick(nowMs: number = Date.now()): void {
    const drift = nowMs - this.lastTickAt - this.tickMs;
    this.lastTickAt = nowMs;
    if (this.heartbeat !== null) this.heartbeat[0] = monoNowMs();
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
    this.opLabel = null;
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
