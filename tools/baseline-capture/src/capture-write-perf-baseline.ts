/**
 * Capture write-perf baseline (RS-0).
 *
 * Promoted from the loose `scripts/capture-write-perf-baseline.mjs` into this typed,
 * nx-graph-aware `baseline-capture` project (BL-164) — same remediation pattern BL-160
 * used to promote `scripts/reembed-memory.mjs` into `libs/memory-core/src/reembed.ts`.
 *
 * CONTRACTS §K: p50/p99 of 100 sequential memory_write calls on the pre-change build.
 * Uses a temporary disposable database (NEVER touches the live store).
 *
 * IMPORTANT: `libs/memory-core/src/soak/metrics-exporter.ts` (`compareToBudget`) reads
 * the baseline JSON this writes (`_shared/baselines/write-perf.json`) and expects the
 * exact shape `{ measurements: { p50_ms, p99_ms, ... } }` — preserved verbatim below.
 *
 * Usage (unchanged from the original script's invocation surface):
 *   node tools/baseline-capture/dist/capture-write-perf-baseline.js
 *   npx nx run baseline-capture:capture-write-perf-baseline
 */

import { unlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, memoryWrite, warmupEmbed } from '@adhd/sox-memory-core';
import type { SqliteAdapter } from '@adhd/sox-store-adapter';

// ── Public types ──────────────────────────────────────────────────────────────

export interface CaptureWritePerfBaselineOptions {
  /** Directory the temp db + baseline JSON are written into. Default: `<repo root>/
   *  docs/plan/runtime-productionization/_shared/baselines` (resolved from
   *  process.cwd(), matching the original script's cwd-relative behavior when
   *  invoked from the repo root). */
  baselineDir?: string;
  /** Number of sequential memory_write calls to time. Default: 100. */
  iterations?: number;
  /** Structured logger. Defaults to console.log. */
  log?: (...args: unknown[]) => void;
}

export interface WritePerfMeasurements {
  count: number;
  p50_ms: number;
  p99_ms: number;
  mean_ms: number;
  min_ms: number;
  max_ms: number;
}

export interface WritePerfBaseline {
  _meta: {
    description: string;
    captured_at: string;
    temp_db: string;
    build: string;
    method: string;
    units: string;
  };
  measurements: WritePerfMeasurements;
  all_latencies_ms: number[];
}

export interface CaptureWritePerfBaselineResult {
  tempDbPath: string;
  baselineJsonPath: string;
  baseline: WritePerfBaseline;
}

// ── Pure helpers (unit-testable without touching any db) ─────────────────────

/** Nearest-rank percentile over an already-sorted-ascending latency array. */
export function percentile(sortedLatencies: number[], p: number): number {
  const total = sortedLatencies.length;
  if (total === 0) return 0;
  const idx = Math.ceil((p * total) / 100) - 1;
  const clamped = Math.max(0, Math.min(idx, total - 1));
  return sortedLatencies[clamped] as number;
}

/** Compute p50/p99/mean/min/max from a raw (unsorted) latency array. Pure. */
export function computeWritePerfMeasurements(latenciesMs: number[]): {
  measurements: WritePerfMeasurements;
  sortedLatencies: number[];
} {
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const total = sorted.length;
  const mean = total === 0 ? 0 : sorted.reduce((s, v) => s + v, 0) / total;

  return {
    sortedLatencies: sorted,
    measurements: {
      count: total,
      p50_ms: Math.round(percentile(sorted, 50) * 100) / 100,
      p99_ms: Math.round(percentile(sorted, 99) * 100) / 100,
      mean_ms: Math.round(mean * 100) / 100,
      min_ms: Math.round((sorted[0] ?? 0) * 100) / 100,
      max_ms: Math.round((sorted[total - 1] ?? 0) * 100) / 100,
    },
  };
}

/** Build the baseline JSON object (exact shape preserved from the original script). */
export function buildWritePerfBaseline(params: {
  latenciesMs: number[];
  build?: string;
}): WritePerfBaseline {
  const { latenciesMs, build } = params;
  const { measurements, sortedLatencies } = computeWritePerfMeasurements(latenciesMs);
  return {
    _meta: {
      description: 'Pre-migration write-perf baseline captured by RS-0.',
      captured_at: new Date().toISOString(),
      temp_db: 'write-perf-temp.db (disposable, committed for reproducibility)',
      build: build ?? 'pre-change (memory-core current, before any context 02 migration)',
      method: '100 sequential memory_write calls to a fresh disposable SQLite store',
      units: 'milliseconds',
    },
    measurements,
    all_latencies_ms: sortedLatencies.map((v) => Math.round(v * 100) / 100),
  };
}

// ── Orchestration (integration entry point) ───────────────────────────────────

/**
 * Warm up the embedding provider, create a disposable SQLite store, run `iterations`
 * sequential `memory_write` calls timing each, compute p50/p99, and write a baseline
 * JSON. NEVER touches the live store — always a fresh temp db.
 */
export async function captureWritePerfBaseline(
  opts: CaptureWritePerfBaselineOptions = {},
): Promise<CaptureWritePerfBaselineResult> {
  const {
    baselineDir = join(process.cwd(), 'docs/plan/runtime-productionization/_shared/baselines'),
    iterations = 100,
    log = (...args: unknown[]) => console.log(...args),
  } = opts;

  const tempDbPath = join(baselineDir, 'write-perf-temp.db');
  const baselineJsonPath = join(baselineDir, 'write-perf.json');

  // ── Cleanup any previous temp db ────────────────────────────────────────────
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(tempDbPath + suffix);
    } catch {
      /* ok — nothing to clean up */
    }
  }

  mkdirSync(baselineDir, { recursive: true });

  // ── Step 1: Warm up embed ────────────────────────────────────────────────────
  log('Step 1: Warming up embed...');
  try {
    await warmupEmbed();
    log('  Embed warm.');
  } catch (e) {
    // [BL-250] There is no hash fallback — createEmbeddingProvider() throws rather than downgrade.
    // A warmup failure here means embeddings are UNAVAILABLE, not degraded.
    log('  Warmup FAILED — embeddings unavailable (no fallback exists):', e instanceof Error ? e.message : String(e));
  }

  // ── Step 2: Create disposable DB ─────────────────────────────────────────────
  log('Step 2: Creating disposable DB...');
  const adapter = await openDb(tempDbPath);
  const db = (adapter as SqliteAdapter).unwrap();
  log('  DB created.');

  // ── Step 3: Run N sequential writes, measuring each ──────────────────────────
  log(`Step 3: Running ${iterations} sequential memory_write calls...`);
  const latenciesMs: number[] = [];

  try {
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      await memoryWrite(db, {
        content: `Baseline write-perf test episode ${i}. This is a synthetic content payload for timing measurement. The quick brown fox jumps over the lazy dog.`,
        tags: ['baseline', 'write-perf', `test-${i % 10}`],
        source: 'import',
        project_path: '/tmp/baseline-capture-write-perf',
      });
      const elapsed = performance.now() - start;
      latenciesMs.push(elapsed);

      if (i > 0 && i % 20 === 0) {
        log(`  Progress: ${i}/${iterations} written (last: ${elapsed.toFixed(1)}ms)`);
      }
    }
  } finally {
    // ── Step 5: Cleanup ─────────────────────────────────────────────────────────
    log('Step 5: Cleaning up...');
    await adapter.close();
  }

  // ── Step 4: Compute p50 / p99 ────────────────────────────────────────────────
  log('Step 4: Computing percentiles...');
  const baseline = buildWritePerfBaseline({ latenciesMs });
  log(`  p50:  ${baseline.measurements.p50_ms.toFixed(2)}ms`);
  log(`  p99:  ${baseline.measurements.p99_ms.toFixed(2)}ms`);
  log(`  mean: ${baseline.measurements.mean_ms.toFixed(2)}ms`);
  log(`  min:  ${baseline.measurements.min_ms.toFixed(2)}ms`);
  log(`  max:  ${baseline.measurements.max_ms.toFixed(2)}ms`);

  // Keep the temp DB for verification if needed — the .gitignore excludes it.

  // ── Step 6: Write baseline JSON ──────────────────────────────────────────────
  log('Step 6: Writing baseline JSON...');
  writeFileSync(baselineJsonPath, JSON.stringify(baseline, null, 2) + '\n');
  log(`  Written to: ${baselineJsonPath}`);
  log('Done. Write-perf baseline captured successfully.');

  return { tempDbPath, baselineJsonPath, baseline };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

/* c8 ignore start -- exercised via direct node invocation, not unit tests */
if (require.main === module) {
  captureWritePerfBaseline().catch((err: unknown) => {
    console.error('[capture-write-perf-baseline] FAILED:', err instanceof Error ? err.stack ?? err.message : err);
    process.exitCode = 1;
  });
}
/* c8 ignore stop */
