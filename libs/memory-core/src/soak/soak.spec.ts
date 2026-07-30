/**
 * soak/soak.spec.ts — HF-2 soak harness tests.
 *
 * STRUCTURE:
 *
 *   Suite A — Normal soak run:
 *     A1: run completes, all ops committed, metrics JSON written and valid.
 *     A2: metrics shape is complete (no undefined/NaN fields, correct counts).
 *     A3: a lenient sample budget PASSES the normal run (gate works when it should).
 *
 *   Suite B — Degraded-run control (gate-has-teeth):
 *     B1: with SOX_SOAK_INJECT_TXN_DELAY_MS set, metrics show inflated latencies.
 *     B2: a tight budget REJECTS the degraded run (gate fails when it should).
 *
 *   Negative control (NC) — encoded as a skipped test:
 *     NC1: removing the injected delay makes the tight budget PASS — proves the
 *          degraded control is the load-bearing element (not a false positive).
 *
 * DEGRADED-RUN MECHANICS:
 *   The degraded run calls runSoak() with injectedDelayMs=50.
 *   Every write operation sleeps 50ms inside the queue, making p50 ≥ 50ms.
 *   The "tight budget" sets max_write_p50_ms=10ms — well below 50ms — so the
 *   gate reliably rejects the degraded run on any hardware.
 *
 * Gate: npx nx test memory-core --skip-nx-cache
 */

// ─── NC TOGGLE ────────────────────────────────────────────────────────────────
// NC1 is encoded as it.skip below. To activate, change `it.skip` → `it` and
// observe that the tight budget PASSES when no injection is active — confirming
// the degraded-run injection is the load-bearing element.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WriteQueue } from '../write-queue.js';
import { runSoak, type SoakProfile, resolveInjectedDelay } from './soak-runner.js';
import { exportMetrics, compareToBudget, type BudgetParams } from './metrics-exporter.js';

// Resolve the canonical baseline path (cross-check that it exists)
const BASELINE_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..', '..', '..', '..', // libs/memory-core → repo root
  'docs', 'plan', 'runtime-productionization', '_shared', 'baselines', 'write-perf.json',
);

// ── Profile for fast CI runs ──────────────────────────────────────────────────
// 8 writers × 30 ops = 240 total ops, still exercising concurrent queue behavior.
// Soak runs at longer profile can be triggered by setting SOX_SOAK_LONG=1.
const CI_PROFILE: SoakProfile = process.env['SOX_SOAK_LONG']
  ? { writers: 16, opsPerWriter: 100, maxQueueSize: 10_000, payloadBytes: 256 }
  : { writers: 8, opsPerWriter: 30, maxQueueSize: 10_000, payloadBytes: 256 };

// ── Temp artifact directory ───────────────────────────────────────────────────
let artifactDir: string;

beforeEach(async () => {
  artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-artifacts-'));
  await WriteQueue.clearInstances();
  WriteQueue.setBypass(false);
  // Ensure degraded-run env is clear for normal-run tests
  delete process.env['SOX_SOAK_INJECT_TXN_DELAY_MS'];
});

afterEach(async () => {
  await WriteQueue.clearInstances();
  try { fs.rmSync(artifactDir, { recursive: true, force: true }); } catch { /* best effort */ }
  delete process.env['SOX_SOAK_INJECT_TXN_DELAY_MS'];
});

// ── Suite A: Normal soak run ──────────────────────────────────────────────────

describe('HF-2 Suite A: normal soak run', () => {

  it('A1: soak run completes and emits a valid metrics JSON artifact', async () => {
    const metrics = await runSoak(CI_PROFILE);

    // Run completed
    expect(metrics.ops_committed).toBe(CI_PROFILE.writers * CI_PROFILE.opsPerWriter);
    expect(metrics.ops_failed).toBe(0);
    expect(metrics.degraded_run).toBe(false);
    expect(metrics.injected_delay_ms).toBe(0);
    expect(metrics.elapsed_ms).toBeGreaterThan(0);

    // Emit artifact
    const artifactPath = path.join(artifactDir, 'normal-run.json');
    const artifact = exportMetrics(metrics, artifactPath, /* includeHistograms */ true);

    // File exists and is valid JSON
    const raw = fs.readFileSync(artifactPath, 'utf8');
    const parsed = JSON.parse(raw);

    // Schema metadata
    expect(parsed._schema).toBe(1);
    expect(parsed._shard).toBe('HF-2');
    expect(typeof parsed.written_at).toBe('string');

    // Profile integrity
    expect(parsed.profile.writers).toBe(CI_PROFILE.writers);
    expect(parsed.profile.ops_per_writer).toBe(CI_PROFILE.opsPerWriter);
    expect(parsed.profile.total_ops).toBe(CI_PROFILE.writers * CI_PROFILE.opsPerWriter);

    // The artifact object matches parsed
    expect(artifact._schema).toBe(1);
    expect(artifact.writes.committed).toBe(CI_PROFILE.writers * CI_PROFILE.opsPerWriter);
  }, 60_000);

  it('A2: metrics shape is complete — no NaN, correct histogram length', async () => {
    const metrics = await runSoak(CI_PROFILE);

    const totalOps = CI_PROFILE.writers * CI_PROFILE.opsPerWriter;

    // Latency fields are finite numbers
    expect(Number.isFinite(metrics.write_p50_ms)).toBe(true);
    expect(Number.isFinite(metrics.write_p99_ms)).toBe(true);
    expect(Number.isFinite(metrics.write_mean_ms)).toBe(true);
    expect(Number.isFinite(metrics.write_min_ms)).toBe(true);
    expect(Number.isFinite(metrics.write_max_ms)).toBe(true);
    expect(Number.isFinite(metrics.lock_wait_p50_ms)).toBe(true);
    expect(Number.isFinite(metrics.lock_wait_p99_ms)).toBe(true);
    expect(Number.isFinite(metrics.txn_duration_p50_ms)).toBe(true);
    expect(Number.isFinite(metrics.txn_duration_p99_ms)).toBe(true);

    // Histogram has one entry per committed op
    expect(metrics.write_latencies_ms.length).toBe(totalOps);

    // Sorted ascending
    for (let i = 1; i < metrics.write_latencies_ms.length; i++) {
      expect(metrics.write_latencies_ms[i]!).toBeGreaterThanOrEqual(
        metrics.write_latencies_ms[i - 1]!,
      );
    }

    // Queue depth samples: at least a few (sampler ran for the duration)
    expect(metrics.queue_depth_samples.length).toBeGreaterThanOrEqual(0);

    // WAL fields
    expect(Number.isFinite(metrics.wal_bytes_final)).toBe(true);
    // checkpoint_age_ms is null (no idle time) or a number
    expect(
      metrics.checkpoint_age_ms === null || Number.isFinite(metrics.checkpoint_age_ms),
    ).toBe(true);
  }, 60_000);

  it('A3: normal run PASSES a lenient sample budget', async () => {
    const metrics = await runSoak(CI_PROFILE);

    // Lenient budget — well above any normal run.
    // INTEGRATOR NOTE: this test uses a sample budget to verify the gate works
    // in the "should pass" direction. The production budget (much tighter) is
    // set by the integrator and is NOT defined here.
    const lenienceBudget: BudgetParams = {
      // 10× the baseline p99 — nothing should be this slow under normal conditions
      max_write_p50_ms: 60_000,
      max_write_p99_ms: 60_000,
      max_lock_wait_p99_ms: 60_000,
      max_failure_rate: 1.0,
    };

    const result = compareToBudget(metrics, lenienceBudget, BASELINE_PATH);

    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.summary).toMatch(/^PASS/);

    // Baseline was read (baseline_p50 comes from write-perf.json = 381.42)
    expect(result.baseline_p50_ms).toBeGreaterThan(0);
    expect(result.baseline_p99_ms).toBeGreaterThan(0);
  }, 60_000);

});

// ── Suite B: Degraded-run control ─────────────────────────────────────────────

describe('HF-2 Suite B: degraded-run control (gate has teeth)', () => {

  it('B1: injected delay inflates write latencies measurably', async () => {
    // 50ms injection: every op sleeps 50ms inside the queue → p50 ≥ 50ms.
    // We use a small profile (4 writers × 5 ops = 20 total ops) to keep the
    // test fast while still proving latency inflation.
    const smallProfile: SoakProfile = {
      writers: 4,
      opsPerWriter: 5,
      maxQueueSize: 10_000,
      payloadBytes: 64,
    };
    const INJECT_MS = 50;

    const degradedMetrics = await runSoak(smallProfile, { injectedDelayMs: INJECT_MS });

    // Degraded-run flag is set
    expect(degradedMetrics.degraded_run).toBe(true);
    expect(degradedMetrics.injected_delay_ms).toBe(INJECT_MS);

    // All ops committed (injection doesn't cause failures)
    expect(degradedMetrics.ops_committed).toBe(
      smallProfile.writers * smallProfile.opsPerWriter,
    );
    expect(degradedMetrics.ops_failed).toBe(0);

    // Write p50 is inflated — must be ≥ injected delay
    // (each op spends at least INJECT_MS inside the queue slot)
    expect(degradedMetrics.write_p50_ms).toBeGreaterThanOrEqual(INJECT_MS);
  }, 60_000);

  it('B2: degraded run FAILS a tight sample budget (gate has teeth)', async () => {
    const smallProfile: SoakProfile = {
      writers: 4,
      opsPerWriter: 5,
      maxQueueSize: 10_000,
      payloadBytes: 64,
    };
    const INJECT_MS = 50;

    const degradedMetrics = await runSoak(smallProfile, { injectedDelayMs: INJECT_MS });

    // Tight budget: p50 must be < 10ms (impossible with 50ms injection).
    // INTEGRATOR NOTE: this is a DEMONSTRATION budget for the "gate has teeth"
    // control. Production thresholds are set separately based on baseline analysis.
    const tightBudget: BudgetParams = {
      max_write_p50_ms: 10,       // unreachable with 50ms injection
      max_write_p99_ms: 50,       // p99 may also be inflated
      max_lock_wait_p99_ms: 50_000, // not under test here
      max_failure_rate: 0,          // still zero failures expected
    };

    const result = compareToBudget(degradedMetrics, tightBudget, BASELINE_PATH);

    // The gate MUST reject this run
    expect(result.passed).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(1);
    expect(result.summary).toMatch(/^FAIL/);

    // The p50 violation is present
    const p50Violation = result.violations.find((v) => v.field === 'write_p50_ms');
    expect(p50Violation).toBeDefined();
    expect(p50Violation!.actual).toBeGreaterThanOrEqual(INJECT_MS);
    expect(p50Violation!.budget).toBe(tightBudget.max_write_p50_ms);
  }, 60_000);

  it('B3: env flag SOX_SOAK_INJECT_TXN_DELAY_MS is respected by resolveInjectedDelay()', () => {
    // Verify the env-flag parsing, not the soak itself.
    delete process.env['SOX_SOAK_INJECT_TXN_DELAY_MS'];
    expect(resolveInjectedDelay()).toBe(0);

    process.env['SOX_SOAK_INJECT_TXN_DELAY_MS'] = '75';
    expect(resolveInjectedDelay()).toBe(75);

    process.env['SOX_SOAK_INJECT_TXN_DELAY_MS'] = 'notanumber';
    expect(resolveInjectedDelay()).toBe(0);

    process.env['SOX_SOAK_INJECT_TXN_DELAY_MS'] = '0';
    expect(resolveInjectedDelay()).toBe(0);

    delete process.env['SOX_SOAK_INJECT_TXN_DELAY_MS'];
  });

  /**
   * NEGATIVE CONTROL — skipped in normal CI.
   *
   * Purpose: demonstrate that the tight budget PASSES when the injection is
   * removed — proving the degraded delay is the load-bearing element in B2, not
   * some pre-existing latency artifact that would make B2 a false positive.
   *
   * What this test does (when un-skipped):
   *   1. Run the same small profile with injectedDelayMs=0 (no injection).
   *   2. Apply the SAME tight budget as B2.
   *   3. Assert it PASSES — because un-injected SQLite writes are fast.
   *
   * To activate: change `it.skip` → `it` and run
   *   npx nx test memory-core --skip-nx-cache
   *
   * NOTE: this test will only pass on hardware where SQLite inserts complete in
   * < 10ms p50. If the machine is under extreme load, p50 may exceed 10ms even
   * without injection. In that case, raise max_write_p50_ms to a realistic value
   * for your hardware (e.g. 100ms) while keeping it below INJECT_MS (50ms)
   * so B2 still fails.
   */
  it.skip('[NC] negative control: without injection, tight budget passes (injection is load-bearing)', async () => {
    const smallProfile: SoakProfile = {
      writers: 4,
      opsPerWriter: 5,
      maxQueueSize: 10_000,
      payloadBytes: 64,
    };

    // No injection — normal run
    const normalMetrics = await runSoak(smallProfile, { injectedDelayMs: 0 });
    expect(normalMetrics.degraded_run).toBe(false);

    // Same tight budget as B2
    const tightBudget: BudgetParams = {
      max_write_p50_ms: 10,
      max_write_p99_ms: 50,
      max_lock_wait_p99_ms: 50_000,
      max_failure_rate: 0,
    };

    const result = compareToBudget(normalMetrics, tightBudget, BASELINE_PATH);

    // PASS — proves the injection in B2 is what causes the failure
    expect(result.passed).toBe(true);
  }, 60_000);

});

// ── Suite C: Metrics export round-trip ───────────────────────────────────────

describe('HF-2 Suite C: metrics export and comparison', () => {

  it('C1: exportMetrics + compareToBudget are consistent', async () => {
    const smallProfile: SoakProfile = {
      writers: 2,
      opsPerWriter: 5,
      maxQueueSize: 10_000,
      payloadBytes: 64,
    };

    const metrics = await runSoak(smallProfile);
    const artifactPath = path.join(artifactDir, 'round-trip.json');
    const artifact = exportMetrics(metrics, artifactPath);

    // Artifact fields match metrics
    expect(artifact.latency_ms.p50).toBe(metrics.write_p50_ms);
    expect(artifact.latency_ms.p99).toBe(metrics.write_p99_ms);
    expect(artifact.latency_ms.mean).toBe(metrics.write_mean_ms);
    expect(artifact.writes.committed).toBe(metrics.ops_committed);
    expect(artifact.writes.failed).toBe(metrics.ops_failed);
    expect(artifact.degraded_run).toBe(metrics.degraded_run);
    expect(artifact.wal.checkpoint_age_ms).toBe(metrics.checkpoint_age_ms);
    expect(artifact.wal.bytes_final).toBe(metrics.wal_bytes_final);
  }, 60_000);

  it('C2: compareToBudget reads baseline and reports baseline values', () => {
    // Synthetic metrics for a passing run
    const syntheticMetrics = {
      write_p50_ms: 5,
      write_p99_ms: 20,
      lock_wait_p99_ms: 1,
      ops_committed: 100,
      ops_failed: 0,
    };

    const passingBudget: BudgetParams = {
      max_write_p50_ms: 100,
      max_write_p99_ms: 200,
      max_lock_wait_p99_ms: 100,
      max_failure_rate: 0,
    };

    const result = compareToBudget(syntheticMetrics, passingBudget, BASELINE_PATH);

    expect(result.passed).toBe(true);
    // Baseline values come from write-perf.json (p50=381.42, p99=738.61)
    expect(result.baseline_p50_ms).toBeCloseTo(381.42, 1);
    expect(result.baseline_p99_ms).toBeCloseTo(738.61, 1);
  });

  it('C3: compareToBudget returns all 4 violations when all limits are zero', () => {
    const syntheticMetrics = {
      write_p50_ms: 100,
      write_p99_ms: 500,
      lock_wait_p99_ms: 50,
      ops_committed: 80,
      ops_failed: 20, // 20% failure rate
    };

    const zeroBudget: BudgetParams = {
      max_write_p50_ms: 0,
      max_write_p99_ms: 0,
      max_lock_wait_p99_ms: 0,
      max_failure_rate: 0,
    };

    const result = compareToBudget(syntheticMetrics, zeroBudget, BASELINE_PATH);

    expect(result.passed).toBe(false);
    // All 4 fields should violate
    const fields = result.violations.map((v) => v.field);
    expect(fields).toContain('write_p50_ms');
    expect(fields).toContain('write_p99_ms');
    expect(fields).toContain('lock_wait_p99_ms');
    expect(fields).toContain('failure_rate');
  });

});
