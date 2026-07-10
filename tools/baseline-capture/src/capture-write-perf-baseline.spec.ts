/**
 * capture-write-perf-baseline.spec.ts — unit tests for the promoted baseline-capture
 * logic (BL-164).
 *
 * The percentile/measurement math is tested as pure functions. The orchestration
 * (`captureWritePerfBaseline`) is tested against a MOCKED `@adhd/sox-memory-core` —
 * same mocking philosophy as `libs/memory-core/src/reembed.spec.ts` (never loads the
 * real ONNX model in a unit test; this script's whole *purpose* is timing the real
 * embed path, so a real-backend run belongs to its own CLI invocation, not the fast
 * CI-gated unit suite).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// vi.mock() factories are hoisted above all imports/const declarations, so any
// value the factory closes over must itself be declared via vi.hoisted().
const { mockClose, mockOpenDb, mockMemoryWrite, mockWarmupEmbed } = vi.hoisted(() => {
  const mockClose = vi.fn();
  const mockDb = { close: mockClose };
  return {
    mockClose,
    mockOpenDb: vi.fn(() => mockDb),
    mockMemoryWrite: vi.fn(async () => ({ episode_uid: 'fake-uid' })),
    mockWarmupEmbed: vi.fn(async () => ({ ok: true })),
  };
});

vi.mock('@adhd/sox-memory-core', () => ({
  openDb: mockOpenDb,
  memoryWrite: mockMemoryWrite,
  warmupEmbed: mockWarmupEmbed,
}));

import { percentile, computeWritePerfMeasurements, buildWritePerfBaseline } from './capture-write-perf-baseline.js';

// ── Pure helper tests ─────────────────────────────────────────────────────────

describe('percentile', () => {
  it('computes p50/p99 with nearest-rank on a sorted array', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 99)).toBe(99);
    expect(percentile(sorted, 100)).toBe(100);
  });

  it('returns 0 for an empty array', () => {
    expect(percentile([], 50)).toBe(0);
  });

  it('clamps to the last element for p100 on a short array', () => {
    expect(percentile([5, 10, 15], 100)).toBe(15);
  });
});

describe('computeWritePerfMeasurements', () => {
  it('sorts unsorted input before computing percentiles', () => {
    const { measurements, sortedLatencies } = computeWritePerfMeasurements([30, 10, 20]);
    expect(sortedLatencies).toEqual([10, 20, 30]);
    expect(measurements.min_ms).toBe(10);
    expect(measurements.max_ms).toBe(30);
    expect(measurements.mean_ms).toBe(20);
    expect(measurements.count).toBe(3);
  });

  it('handles an empty latency array without throwing', () => {
    const { measurements } = computeWritePerfMeasurements([]);
    expect(measurements).toEqual({ count: 0, p50_ms: 0, p99_ms: 0, mean_ms: 0, min_ms: 0, max_ms: 0 });
  });
});

describe('buildWritePerfBaseline', () => {
  it('produces the exact historical JSON shape consumed by soak/metrics-exporter.ts', () => {
    const baseline = buildWritePerfBaseline({ latenciesMs: [381.42, 200, 738.61] });
    expect(baseline._meta.units).toBe('milliseconds');
    expect(baseline._meta.method).toBe('100 sequential memory_write calls to a fresh disposable SQLite store');
    // measurements.{p50_ms,p99_ms} is the exact contract compareToBudget() reads.
    expect(baseline.measurements).toHaveProperty('p50_ms');
    expect(baseline.measurements).toHaveProperty('p99_ms');
    expect(baseline.all_latencies_ms).toEqual([200, 381.42, 738.61]);
  });
});

// ── captureWritePerfBaseline orchestration (mocked memory-core, no ONNX) ──────

describe('captureWritePerfBaseline', () => {
  const tmpDirs: string[] = [];

  beforeEach(() => {
    mockOpenDb.mockClear();
    mockMemoryWrite.mockClear();
    mockWarmupEmbed.mockClear();
    mockClose.mockClear();
  });

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs N sequential writes, computes percentiles, and writes baseline JSON', async () => {
    const { captureWritePerfBaseline } = await import('./capture-write-perf-baseline.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-capture-write-perf-'));
    tmpDirs.push(dir);

    const result = await captureWritePerfBaseline({
      baselineDir: dir,
      iterations: 5,
      log: () => {
        /* silence in tests */
      },
    });

    expect(mockWarmupEmbed).toHaveBeenCalledTimes(1);
    expect(mockOpenDb).toHaveBeenCalledTimes(1);
    expect(mockMemoryWrite).toHaveBeenCalledTimes(5);
    expect(mockClose).toHaveBeenCalledTimes(1);

    expect(result.baseline.measurements.count).toBe(5);
    expect(fs.existsSync(result.baselineJsonPath)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(result.baselineJsonPath, 'utf8')) as typeof result.baseline;
    expect(parsed.measurements.count).toBe(5);
    expect(parsed.all_latencies_ms).toHaveLength(5);
  });

  it('cleans up any stale temp-db files (main + wal + shm) before running', async () => {
    const { captureWritePerfBaseline } = await import('./capture-write-perf-baseline.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-capture-write-perf-'));
    tmpDirs.push(dir);

    const tempDbPath = path.join(dir, 'write-perf-temp.db');
    fs.writeFileSync(tempDbPath, 'stale');
    fs.writeFileSync(tempDbPath + '-wal', 'stale-wal');
    fs.writeFileSync(tempDbPath + '-shm', 'stale-shm');

    await captureWritePerfBaseline({
      baselineDir: dir,
      iterations: 1,
      log: () => {
        /* silence in tests */
      },
    });

    // The mocked openDb never recreates a real file, so the stale files must be gone.
    expect(fs.existsSync(tempDbPath)).toBe(false);
    expect(fs.existsSync(tempDbPath + '-wal')).toBe(false);
    expect(fs.existsSync(tempDbPath + '-shm')).toBe(false);
  });

  it('propagates a warmupEmbed failure as a logged warning, not a thrown error', async () => {
    mockWarmupEmbed.mockRejectedValueOnce(new Error('no ONNX runtime in this sandbox'));
    const { captureWritePerfBaseline } = await import('./capture-write-perf-baseline.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-capture-write-perf-'));
    tmpDirs.push(dir);

    const logs: unknown[][] = [];
    await expect(
      captureWritePerfBaseline({ baselineDir: dir, iterations: 1, log: (...a) => logs.push(a) }),
    ).resolves.toBeDefined();

    // [BL-250] Assert on the SEMANTICS (a warmup failure is logged, not thrown), not on exact
    // prose. The old assertion pinned the literal string 'Warmup failed'; correcting the message
    // to say embeddings are UNAVAILABLE (there is no hash fallback to degrade to) broke it.
    expect(logs.some((l) => /warmup\s+failed/i.test(String(l[0])))).toBe(true);
    expect(logs.some((l) => /no fallback exists/i.test(String(l[0])))).toBe(true);
  });
});
