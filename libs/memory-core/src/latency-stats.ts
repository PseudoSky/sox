/**
 * latency-stats.ts — shared latency/percentile helpers.
 *
 * Promoted from soak/soak-runner.ts (HF-2) so the WriteQueue instrumentation
 * (write-path observability) and the soak harness share ONE percentile
 * implementation — DRY, no duplicated math.
 *
 * Consumers:
 *   - soak/soak-runner.ts    — p50/p99/mean over full soak-run sample arrays.
 *   - write-queue.ts         — rolling in-process write-latency metrics via
 *                              LatencyRing (bounded memory, O(1) push).
 */

// ── Scalar helpers ─────────────────────────────────────────────────────────────

/** Compute a percentile (0–1) from a SORTED (ascending) array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    Math.ceil(sorted.length * p) - 1,
    sorted.length - 1,
  );
  return sorted[idx]!;
}

/** Compute mean of an array. Returns 0 for an empty array. */
export function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ── Summary over an unsorted sample set ────────────────────────────────────────

/** Latency distribution summary (ms). All fields 0 when there are no samples. */
export interface LatencySummary {
  p50: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
}

/**
 * Summarize an UNSORTED sample array into {p50, p99, mean, min, max}.
 * Pure: the input array is copied before sorting — never mutated.
 */
export function summarizeLatencies(samples: number[]): LatencySummary {
  if (samples.length === 0) {
    return { p50: 0, p99: 0, mean: 0, min: 0, max: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p99: percentile(sorted, 0.99),
    mean: mean(sorted),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

// ── Bounded rolling sample window ──────────────────────────────────────────────

/**
 * Fixed-capacity ring buffer of latency samples (ms).
 *
 * O(1) push, bounded memory. Once full, new samples overwrite the oldest.
 * Reads (`values()`, `recentMean()`) never mutate state — safe to call from
 * a pure metrics snapshot.
 */
export class LatencyRing {
  private readonly buf: number[];
  private writeIdx = 0;
  private size = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`LatencyRing capacity must be a positive integer (got ${capacity})`);
    }
    this.buf = new Array<number>(capacity);
  }

  /** Number of samples currently held (≤ capacity). */
  get count(): number {
    return this.size;
  }

  /** Record a sample. Overwrites the oldest once the ring is full. */
  push(sampleMs: number): void {
    this.buf[this.writeIdx] = sampleMs;
    this.writeIdx = (this.writeIdx + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  /** Copy of the held samples (unspecified order — fine for distribution stats). */
  values(): number[] {
    return this.buf.slice(0, this.size);
  }

  /**
   * Mean of the most recent `window` samples (or fewer, if less are held).
   * Returns 0 when no samples are held.
   */
  recentMean(window: number): number {
    if (this.size === 0) return 0;
    const n = Math.min(window, this.size);
    let sum = 0;
    // Walk backwards from the newest sample.
    for (let i = 1; i <= n; i++) {
      const idx = (this.writeIdx - i + this.capacity) % this.capacity;
      sum += this.buf[idx]!;
    }
    return sum / n;
  }
}
