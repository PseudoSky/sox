/**
 * soak/metrics-exporter.ts — HF-2 metrics serializer + SLO comparison helper.
 *
 * TWO RESPONSIBILITIES:
 *
 *   1. exportMetrics()  — serialize a SoakMetrics run artifact to JSON.
 *      Emitted shape is self-describing; all keys are stable for tooling.
 *
 *   2. compareToBudget() — read _shared/baselines/write-perf.json and
 *      compute a pass/fail verdict against a CALLER-SUPPLIED budget.
 *
 *      ⚠ INTEGRATOR NOTE — THRESHOLDS ARE NOT HARDCODED:
 *      The BudgetParams values are intentionally left as explicit parameters
 *      with no default values that carry SLO meaning. The integrator selects
 *      final production thresholds by examining _shared/baselines/write-perf.json
 *      and the first real soak run artifact, then wires those numbers into the
 *      CI gate. Do NOT hardcode final production thresholds in this file.
 *
 *      See: docs/plan/runtime-productionization/06-hardening-final/SHARDS.md
 *      ("HF-2 threshold selection is integrator-retained").
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SoakMetrics } from './soak-runner.js';

// ── Exported metrics JSON shape ────────────────────────────────────────────────

/**
 * The serialized form of a soak run artifact.
 * Written to disk by exportMetrics(); read back by comparison helpers.
 *
 * Histogram arrays are OMITTED from the output by default (they can be very
 * large for long soak runs). Set includeHistograms=true to include them.
 */
export interface SoakMetricsArtifact {
  /** Schema version for future migrations. */
  _schema: 1;
  /** HF shard that produced this artifact. */
  _shard: 'HF-2';
  /** ISO timestamp when the artifact was written (may differ from run_completed_at). */
  written_at: string;

  run_started_at: string;
  run_completed_at: string;
  elapsed_ms: number;

  profile: {
    writers: number;
    ops_per_writer: number;
    total_ops: number;
    max_queue_size: number | undefined;
    payload_bytes: number | undefined;
  };

  degraded_run: boolean;
  injected_delay_ms: number;

  writes: {
    committed: number;
    failed: number;
    failure_rate: number;
  };

  latency_ms: {
    p50: number;
    p99: number;
    mean: number;
    min: number;
    max: number;
    /** Only present when includeHistograms=true */
    histogram?: number[];
  };

  lock_wait_ms: {
    p50: number;
    p99: number;
  };

  txn_duration_ms: {
    p50: number;
    p99: number;
  };

  queue_depth: {
    peak: number;
    mean: number;
    /** Only present when includeHistograms=true */
    samples?: Array<{ at_ms: number; depth: number }>;
  };

  wal: {
    checkpoint_age_ms: number | null;
    bytes_final: number;
  };

  store_path: string;
}

// ── Export ─────────────────────────────────────────────────────────────────────

/**
 * Serialize soak metrics to a JSON artifact.
 *
 * @param metrics           - The SoakMetrics from runSoak().
 * @param outputPath        - File path to write. Directory is created if missing.
 * @param includeHistograms - Include raw latency arrays (large; off by default).
 * @returns                 The artifact object (also written to outputPath).
 */
export function exportMetrics(
  metrics: SoakMetrics,
  outputPath: string,
  includeHistograms = false,
): SoakMetricsArtifact {
  const totalOps = metrics.profile.writers * metrics.profile.opsPerWriter;
  const failureRate = totalOps > 0 ? metrics.ops_failed / totalOps : 0;

  const artifact: SoakMetricsArtifact = {
    _schema: 1,
    _shard: 'HF-2',
    written_at: new Date().toISOString(),

    run_started_at: metrics.run_started_at,
    run_completed_at: metrics.run_completed_at,
    elapsed_ms: metrics.elapsed_ms,

    profile: {
      writers: metrics.profile.writers,
      ops_per_writer: metrics.profile.opsPerWriter,
      total_ops: totalOps,
      max_queue_size: metrics.profile.maxQueueSize,
      payload_bytes: metrics.profile.payloadBytes,
    },

    degraded_run: metrics.degraded_run,
    injected_delay_ms: metrics.injected_delay_ms,

    writes: {
      committed: metrics.ops_committed,
      failed: metrics.ops_failed,
      failure_rate: failureRate,
    },

    latency_ms: {
      p50: metrics.write_p50_ms,
      p99: metrics.write_p99_ms,
      mean: metrics.write_mean_ms,
      min: metrics.write_min_ms,
      max: metrics.write_max_ms,
      ...(includeHistograms ? { histogram: metrics.write_latencies_ms } : {}),
    },

    lock_wait_ms: {
      p50: metrics.lock_wait_p50_ms,
      p99: metrics.lock_wait_p99_ms,
    },

    txn_duration_ms: {
      p50: metrics.txn_duration_p50_ms,
      p99: metrics.txn_duration_p99_ms,
    },

    queue_depth: {
      peak: metrics.queue_depth_peak,
      mean: metrics.queue_depth_mean,
      ...(includeHistograms ? { samples: metrics.queue_depth_samples } : {}),
    },

    wal: {
      checkpoint_age_ms: metrics.checkpoint_age_ms,
      bytes_final: metrics.wal_bytes_final,
    },

    store_path: metrics.store_path,
  };

  const dir = path.dirname(outputPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(artifact, null, 2) + '\n', 'utf8');

  return artifact;
}

// ── Budget + comparison ────────────────────────────────────────────────────────

/**
 * SLO budget thresholds for a soak run comparison.
 *
 * ⚠ INTEGRATOR: select these values from the baseline + observed soak runs.
 *   This interface MUST NOT carry default values with SLO semantics.
 *   All fields are required — the integrator supplies every number explicitly.
 *
 * Typical derivation from _shared/baselines/write-perf.json:
 *   budget.max_write_p50_ms  ≈ baseline.p50_ms  × multiplier   (e.g. ×2 or ×3)
 *   budget.max_write_p99_ms  ≈ baseline.p99_ms  × multiplier
 *   budget.max_failure_rate  = 0 (zero tolerance for queue overflows in a soak)
 */
export interface BudgetParams {
  /**
   * Maximum acceptable write p50 latency (ms).
   * INTEGRATOR: derive from _shared/baselines/write-perf.json measurements.p50_ms.
   * TODO: set final production value.
   */
  max_write_p50_ms: number;

  /**
   * Maximum acceptable write p99 latency (ms).
   * INTEGRATOR: derive from _shared/baselines/write-perf.json measurements.p99_ms.
   * TODO: set final production value.
   */
  max_write_p99_ms: number;

  /**
   * Maximum acceptable lock-wait p99 (ms).
   * INTEGRATOR: tune from observed soak runs.
   * TODO: set final production value.
   */
  max_lock_wait_p99_ms: number;

  /**
   * Maximum acceptable failure rate (0–1).
   * 0 = zero tolerance for any committed op failure.
   * INTEGRATOR: typically 0 for a clean soak; allow small headroom if queue
   * overflow is possible at high concurrency.
   */
  max_failure_rate: number;
}

export interface BudgetViolation {
  field: string;
  budget: number;
  actual: number;
  message: string;
}

export interface ComparisonResult {
  passed: boolean;
  violations: BudgetViolation[];
  /** Summary of what was checked. */
  summary: string;
  /** The baseline that was read (for audit trails). */
  baseline_p50_ms: number;
  baseline_p99_ms: number;
}

/**
 * Read the baseline file and compute pass/fail against the supplied budget.
 *
 * @param metrics       - The SoakMetrics (or SoakMetricsArtifact) from this run.
 * @param budget        - The SLO thresholds (INTEGRATOR-supplied).
 * @param baselinePath  - Path to _shared/baselines/write-perf.json.
 *                        Defaults to the canonical location relative to this file.
 * @returns             ComparisonResult with pass/fail verdict and all violations.
 */
export function compareToBudget(
  metrics: Pick<SoakMetrics, 'write_p50_ms' | 'write_p99_ms' | 'lock_wait_p99_ms' | 'ops_committed' | 'ops_failed'>,
  budget: BudgetParams,
  baselinePath?: string,
): ComparisonResult {
  // Resolve baseline path (canonical relative to this file's location)
  const resolvedBaseline = baselinePath ?? path.resolve(
    __dirname,  // CJS lib build (module: CommonJS) — import.meta is unavailable here
    '..', '..', '..', '..',  // {src,dist}/soak → memory-core → libs → repo root
    'docs', 'plan', 'runtime-productionization', '_shared', 'baselines', 'write-perf.json',
  );

  let baselineP50 = 0;
  let baselineP99 = 0;

  try {
    const raw = fs.readFileSync(resolvedBaseline, 'utf8');
    const baseline = JSON.parse(raw) as {
      measurements: { p50_ms: number; p99_ms: number };
    };
    baselineP50 = baseline.measurements.p50_ms;
    baselineP99 = baseline.measurements.p99_ms;
  } catch (err) {
    // If the baseline file is missing, we still run the check — just note it
    console.error(
      `[soak/metrics-exporter] WARNING: could not read baseline from ${resolvedBaseline}: ${err}`,
    );
  }

  const violations: BudgetViolation[] = [];
  const totalOps = metrics.ops_committed + metrics.ops_failed;
  const failureRate = totalOps > 0 ? metrics.ops_failed / totalOps : 0;

  // Check p50 write latency
  if (metrics.write_p50_ms > budget.max_write_p50_ms) {
    violations.push({
      field: 'write_p50_ms',
      budget: budget.max_write_p50_ms,
      actual: metrics.write_p50_ms,
      message: `write p50 ${metrics.write_p50_ms.toFixed(1)}ms exceeds budget ${budget.max_write_p50_ms}ms`,
    });
  }

  // Check p99 write latency
  if (metrics.write_p99_ms > budget.max_write_p99_ms) {
    violations.push({
      field: 'write_p99_ms',
      budget: budget.max_write_p99_ms,
      actual: metrics.write_p99_ms,
      message: `write p99 ${metrics.write_p99_ms.toFixed(1)}ms exceeds budget ${budget.max_write_p99_ms}ms`,
    });
  }

  // Check lock-wait p99
  if (metrics.lock_wait_p99_ms > budget.max_lock_wait_p99_ms) {
    violations.push({
      field: 'lock_wait_p99_ms',
      budget: budget.max_lock_wait_p99_ms,
      actual: metrics.lock_wait_p99_ms,
      message: `lock-wait p99 ${metrics.lock_wait_p99_ms.toFixed(1)}ms exceeds budget ${budget.max_lock_wait_p99_ms}ms`,
    });
  }

  // Check failure rate
  if (failureRate > budget.max_failure_rate) {
    violations.push({
      field: 'failure_rate',
      budget: budget.max_failure_rate,
      actual: failureRate,
      message: `failure rate ${(failureRate * 100).toFixed(2)}% exceeds budget ${(budget.max_failure_rate * 100).toFixed(2)}%`,
    });
  }

  const passed = violations.length === 0;
  const summary = passed
    ? `PASS: all ${violations.length === 0 ? '4' : ''} SLO gates met (write p50=${metrics.write_p50_ms.toFixed(1)}ms, p99=${metrics.write_p99_ms.toFixed(1)}ms, lock-wait p99=${metrics.lock_wait_p99_ms.toFixed(1)}ms, failures=${metrics.ops_failed})`
    : `FAIL: ${violations.length} SLO violation(s): ${violations.map((v) => v.message).join('; ')}`;

  return {
    passed,
    violations,
    summary,
    baseline_p50_ms: baselineP50,
    baseline_p99_ms: baselineP99,
  };
}
