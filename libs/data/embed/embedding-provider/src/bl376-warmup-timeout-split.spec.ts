import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { warmupTimeoutMs, isModelCached } from './index.js';
import { FastembedProvider, MODEL_CONFIGS } from './fastembed.js';
import type { SharedFastembedProcessClient } from './sharedFastembedProcess.js';

/**
 * BL-376 — one warmup timeout budget covered both a cold network download
 * (legitimately slow, ~180s) and a cached local load (should be near-instant).
 * A hung cache-hit load was therefore indistinguishable from a slow download
 * for the full 180s window.
 *
 * The fix splits the budget by cache presence, determined synchronously up
 * front via `isModelCached()` (checks `<cacheDir>/<hfRepoId>/model_optimized.onnx`,
 * the real on-disk layout fastembed uses — verified against a live
 * `~/.cache/sox/models/` tree). No real model is downloaded or loaded here:
 * `FastembedProvider` accepts an injected fake `SharedFastembedProcessClient`
 * that simulates an artificially slow (or hung) init over IPC without
 * forking a real child process.
 */
describe('BL-376 — warmup timeout budget splits by cache-hit vs cache-miss', () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(join(tmpdir(), 'sox-bl376-warmup-'));
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    vi.useRealTimers();
    delete process.env['SOX_EMBED_WARMUP_CACHED_TIMEOUT_MS'];
    delete process.env['SOX_EMBED_WARMUP_TIMEOUT_MS'];
  });

  /**
   * A fake shared-process client. Only the model-init ('type: init') leg —
   * the one BL-376 is about — is artificially delayed: it resolves after
   * `delayMs`, or rejects at `timeoutMs` if that elapses first, exactly like
   * the real IPC client's own in-process timeout. The subsequent 'embed'
   * request (issued by `embedSingle('warmup')` once init resolves) answers
   * immediately with a plausible embedding vector, since that leg is not
   * what this bug is about.
   */
  function makeDelayedClient(delayMs: number): SharedFastembedProcessClient {
    return {
      request: (payload: { type?: string }, timeoutMs?: number) => {
        if (payload?.type !== 'init') {
          return Promise.resolve({ embedding: new Array(384).fill(0.1) });
        }
        return new Promise((resolve, reject) => {
          let settled = false;
          const okTimer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve({ initOk: true, dim: 384, execution_provider: 'cpu' });
          }, delayMs);
          if (typeof (okTimer as unknown as { unref?: () => void }).unref === 'function') {
            (okTimer as unknown as { unref: () => void }).unref();
          }
          if (timeoutMs && timeoutMs > 0) {
            const failTimer = setTimeout(() => {
              if (settled) return;
              settled = true;
              clearTimeout(okTimer);
              reject(new Error(`shared fastembed process request timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            if (typeof (failTimer as unknown as { unref?: () => void }).unref === 'function') {
              (failTimer as unknown as { unref: () => void }).unref();
            }
          }
        });
      },
    } as unknown as SharedFastembedProcessClient;
  }

  // ── Pure function unit checks ──────────────────────────────────────────

  it('warmupTimeoutMs(true) defaults to a single-digit-second budget, distinct from warmupTimeoutMs(false)', () => {
    const cacheHitMs = warmupTimeoutMs(true);
    const cacheMissMs = warmupTimeoutMs(false);
    expect(cacheHitMs).toBeLessThan(10_000);
    expect(cacheMissMs).toBe(180_000);
    expect(cacheHitMs).not.toBe(cacheMissMs);
  });

  it('isModelCached reflects real on-disk presence of model_optimized.onnx', () => {
    const hfRepoId = 'fast-bge-small-en-v1.5';
    expect(isModelCached(cacheDir, hfRepoId)).toBe(false);
    fs.mkdirSync(join(cacheDir, hfRepoId), { recursive: true });
    fs.writeFileSync(join(cacheDir, hfRepoId, 'model_optimized.onnx'), 'stub');
    expect(isModelCached(cacheDir, hfRepoId)).toBe(true);
  });

  // ── End-to-end through FastembedProvider (both halves required) ─────────

  it('CACHE-HIT: warmup fails fast against a hung 15s+ load, well inside the tight budget', async () => {
    vi.useFakeTimers();
    const modelId = 'bge-small-en-v1.5';
    const hfRepoId = MODEL_CONFIGS[modelId]!.hfRepoId;
    // Simulate the model already being on disk.
    fs.mkdirSync(join(cacheDir, hfRepoId), { recursive: true });
    fs.writeFileSync(join(cacheDir, hfRepoId, 'model_optimized.onnx'), 'stub');

    const client = makeDelayedClient(15_000); // injected hang, well past any sane cache-hit budget
    const provider = new FastembedProvider(modelId, 384, cacheDir, client);

    // BUG-EMBED-WARMUP-CACHEHIT-ASSUMES-FAST-LOAD-001: initModel() now retries
    // WARMUP_CACHE_HIT_ATTEMPTS (2) times at the same tight per-attempt budget
    // before giving up — a hung load fails fast/bounded (still nowhere near
    // the old 180s bug this test guards against), just at 2×8000ms=16000ms
    // instead of the single-attempt 8000ms this test asserted pre-fix. The
    // invariant this test protects (bounded fail-fast, not an unbounded or
    // 180s hang) is unchanged; only the bound's magnitude legitimately grew
    // with the retry count.
    const warmup = provider.embedSingle('warmup');
    const assertion = expect(warmup).rejects.toThrow(/timed out after 8000ms/);
    await vi.advanceTimersByTimeAsync(16_001);
    await assertion;
  });

  it('CACHE-MISS: warmup still tolerates a slow (but sub-180s) load that would have tripped the cache-hit budget', async () => {
    vi.useFakeTimers();
    const modelId = 'bge-small-en-v1.5';
    // No file written under cacheDir — genuine cache miss.
    expect(isModelCached(cacheDir, MODEL_CONFIGS[modelId]!.hfRepoId)).toBe(false);

    const client = makeDelayedClient(9_000); // longer than the 8s cache-hit budget, far under 180s
    const provider = new FastembedProvider(modelId, 384, cacheDir, client);

    const warmup = provider.embedSingle('warmup');
    await vi.advanceTimersByTimeAsync(9_001);
    await expect(warmup).resolves.toBeInstanceOf(Float32Array);
  });
});
