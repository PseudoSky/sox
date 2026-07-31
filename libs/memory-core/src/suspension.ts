/**
 * suspension.ts — BL-369: make "the process was not running" a measurable,
 * reportable fact instead of an invisible inflation of every duration.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 * Every `duration_ms` this codebase emits is elapsed time across an operation.
 * When the machine sleeps mid-operation, or the event loop is blocked, that
 * elapsed time is charged to the operation as though it were work. Measured on
 * the live store 2026-07-31: of the 35130 s spanned by embeds longer than 30 s,
 * **31175 s (88.7%) was system sleep** — one "3-hour embed" was 503 s of awake
 * time on a laptop that slept for 2 h 54 m. Against the ≤30 s population it was
 * 1.1%, so the distortion lands precisely on the tail, which is where p90/p99
 * are read. Every high percentile published from this telemetry is inflated by
 * an unknown amount.
 *
 * ── WHY THERE IS NO CLOCK FIX (measured, do not re-litigate) ───────────────
 * The obvious remedy — "use a monotonic clock" — does not work, and was filed
 * as this item's fix sketch before being measured:
 *
 *   - `performance.now()` and `process.hrtime.bigint()` are the SAME clock.
 *     Measured on Node v24.11.1 darwin/arm64: they agree to **0.002 ms** over a
 *     250 ms interval. Both are `uv_hrtime()`. Swapping one for the other is a
 *     literal no-op.
 *   - That clock INCLUDES system sleep on this platform. Decisive test against
 *     data already on disk: pair each `embed.start` with its `embed.finish` and
 *     compare the true wall gap (from the two `ts` fields) against the reported
 *     `duration_ms` — **n=28 long ops, median ratio 1.000**, including the
 *     3-hour span that was 95% asleep. Control: n=3532 short ops, ratio 1.000.
 *     (Note libuv issue #2891 states macOS `uv_hrtime` uses `mach_absolute_time`
 *     / `CLOCK_UPTIME_RAW`, which would EXCLUDE sleep. On Node 24 it
 *     demonstrably does not. The measurement wins.)
 *   - `Date.now()`, `performance.now()`, `hrtime.bigint()` and
 *     `process.uptime()` all include sleep. **No pure-JS clock on macOS gives
 *     sleep-excluded elapsed time.**
 *
 * ── THE MECHANISM ─────────────────────────────────────────────────────────
 * One process-global heartbeat. If a tick lands materially later than
 * scheduled, the process did not run for the excess. The CAUSE is then
 * discriminated by CPU consumed over the same gap:
 *
 *   ~zero CPU  ⇒ SYSTEM SUSPEND  (sleep / SIGSTOP / VM pause)
 *    CPU burnt ⇒ EVENT-LOOP BLOCK (synchronous work starving the loop)
 *
 * Both are real defects and neither is currently visible; they are recorded
 * separately rather than lumped as "slow".
 *
 * ── WHY ANNOTATE, NEVER SUBTRACT ──────────────────────────────────────────
 * `durationOf()` returns the raw elapsed time unchanged, plus `suspended_ms`
 * alongside. A silently-subtracted duration is neither wall time nor compute
 * time, and can no longer be reconciled against the record's own `ts` fields —
 * the reader loses the ability to tell a corrected number from an uncorrected
 * one. Emitting both keeps `duration_ms` meaning exactly what it always meant,
 * makes the artifact visible rather than merely absent, and lets a consumer
 * honestly drop `suspended_ms > 0` samples from a percentile.
 *
 * ── PORTABILITY ───────────────────────────────────────────────────────────
 * Deliberately self-contained: no imports from `telemetry.ts`, no coupling to
 * its log shape, no memory-core types. This is written to be lifted wholesale
 * into BL-351's shared tracing package once it exists (BL-344 blocks it today),
 * so that the substrate and memory-core share ONE convention rather than two.
 */

/** A window during which this process was demonstrably not running. */
export interface SuspensionInterval {
  /** Wall-clock ms (`Date.now()`) at which the process stopped running. */
  startMs: number;
  /** Wall-clock ms at which it resumed. */
  endMs: number;
  /**
   * `suspend` — no CPU consumed across the gap: the machine slept, or the
   * process was SIGSTOPped / the VM paused.
   * `event_loop_block` — CPU WAS consumed: synchronous work starved the loop.
   */
  kind: 'suspend' | 'event_loop_block';
  /** Microseconds of CPU (user+system) consumed across the gap. */
  cpuUs: number;
}

export interface SuspensionAccounting {
  /** Raw elapsed wall time. Never adjusted. */
  duration_ms: number;
  /** Overlap of the measured window with recorded suspensions. */
  suspended_ms: number;
  /** Overlap with recorded event-loop blocks. */
  blocked_ms: number;
}

/** Heartbeat period. */
const TICK_MS = 1000;
/**
 * A tick is "late" past this much drift. Timers are not precise and a loaded
 * machine routinely drifts tens of ms; 750 ms is far above ordinary jitter and
 * far below any suspension worth reporting.
 */
const LATE_SLACK_MS = 750;
/**
 * CPU consumed across a gap, below which the process is judged not to have been
 * running at all. A blocked event loop burns CPU roughly in proportion to the
 * gap; a suspended process burns ~none. 50 ms over a >1.75 s gap is a wide
 * margin either way.
 */
const IDLE_CPU_US = 50_000;
/** Bounded history — suspensions are rare; this is ample and cannot grow. */
const MAX_INTERVALS = 256;

let intervals: SuspensionInterval[] = [];
let timer: NodeJS.Timeout | undefined;
let lastTickMs = 0;
let lastCpu: NodeJS.CpuUsage | undefined;

function record(startMs: number, endMs: number, cpuUs: number): void {
  intervals.push({
    startMs,
    endMs,
    kind: cpuUs < IDLE_CPU_US ? 'suspend' : 'event_loop_block',
    cpuUs,
  });
  if (intervals.length > MAX_INTERVALS) intervals = intervals.slice(-MAX_INTERVALS);
}

/**
 * Evaluate one heartbeat. Exported for tests so the detector can be driven
 * deterministically — a test must never have to actually suspend a process.
 */
export function _observeTick(nowMs: number, cpu: NodeJS.CpuUsage): void {
  if (lastTickMs !== 0 && lastCpu !== undefined) {
    const gap = nowMs - lastTickMs;
    if (gap > TICK_MS + LATE_SLACK_MS) {
      const cpuUs =
        cpu.user - lastCpu.user + (cpu.system - lastCpu.system);
      // The process ran normally up to one tick after the last observation;
      // everything past that is the unaccounted window.
      record(lastTickMs + TICK_MS, nowMs, cpuUs);
    }
  }
  lastTickMs = nowMs;
  lastCpu = cpu;
}

/**
 * Start the heartbeat. Idempotent. The timer is `unref()`'d so it can never
 * hold a process open — the precise failure BL-370 documents, where a handle
 * nobody unref'd kept every embedding consumer alive forever.
 */
export function startSuspensionTracking(): void {
  if (timer !== undefined) return;
  lastTickMs = Date.now();
  lastCpu = process.cpuUsage();
  timer = setInterval(() => {
    _observeTick(Date.now(), process.cpuUsage());
  }, TICK_MS);
  timer.unref();
}

export function stopSuspensionTracking(): void {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
}

/** TEST-ONLY: clear all recorded state. */
export function _resetSuspensionForTest(): void {
  stopSuspensionTracking();
  intervals = [];
  lastTickMs = 0;
  lastCpu = undefined;
}

/** TEST-ONLY: inject a known interval without suspending anything. */
export function _recordIntervalForTest(i: SuspensionInterval): void {
  intervals.push(i);
}

/** Recorded intervals, newest last. Copy — callers cannot mutate the ledger. */
export function suspensionIntervals(): readonly SuspensionInterval[] {
  return [...intervals];
}

/** Overlap of [startMs, endMs] with recorded intervals of each kind. */
export function suspensionBetween(
  startMs: number,
  endMs: number,
): { suspended_ms: number; blocked_ms: number } {
  let suspended = 0;
  let blocked = 0;
  for (const iv of intervals) {
    const lo = Math.max(startMs, iv.startMs);
    const hi = Math.min(endMs, iv.endMs);
    if (hi <= lo) continue;
    if (iv.kind === 'suspend') suspended += hi - lo;
    else blocked += hi - lo;
  }
  return { suspended_ms: Math.round(suspended), blocked_ms: Math.round(blocked) };
}

/**
 * Close out a timed window opened at wall-clock `startMs`.
 *
 * `duration_ms` is the RAW elapsed time — unchanged, and still directly
 * reconcilable against the record's own timestamps. `suspended_ms` and
 * `blocked_ms` say how much of it the process was not actually working.
 */
export function durationOf(startMs: number, nowMs = Date.now()): SuspensionAccounting {
  const { suspended_ms, blocked_ms } = suspensionBetween(startMs, nowMs);
  return { duration_ms: Math.round(nowMs - startMs), suspended_ms, blocked_ms };
}

/**
 * Fields to merge into a log record. Omits the two counters entirely when they
 * are zero, so the common case adds no bytes to the log and a reader can treat
 * their PRESENCE as the signal.
 */
export function suspensionFields(
  a: SuspensionAccounting,
): { suspended_ms?: number; blocked_ms?: number } {
  return {
    ...(a.suspended_ms > 0 ? { suspended_ms: a.suspended_ms } : {}),
    ...(a.blocked_ms > 0 ? { blocked_ms: a.blocked_ms } : {}),
  };
}
