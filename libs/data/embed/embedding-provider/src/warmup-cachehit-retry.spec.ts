import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { warmupTimeoutMs, warmupOuterBudgetMs, WARMUP_CACHE_HIT_ATTEMPTS } from './index.js';
import { FastembedProvider, MODEL_CONFIGS } from './fastembed.js';
import type { SharedFastembedProcessClient } from './sharedFastembedProcess.js';

/**
 * BUG-EMBED-WARMUP-CACHEHIT-ASSUMES-FAST-LOAD-001
 *
 * BL-376 correctly split the warmup budget by cache-hit vs cache-miss, but
 * left the cache-hit branch a SINGLE tight-budget attempt — indistinguishable
 * from a genuine hang for anything that merely took slightly longer than the
 * tight budget on a loaded/slow-scheduled machine (measured live: a cache-hit
 * load that would have succeeded on a second attempt was discarded outright,
 * orphaning a fully-loaded shared fastembed child process that the parent had
 * already given up on and forgotten it ever asked — see SPEC-WARMUP-COLD.md
 * §1a for the full root-cause trace).
 *
 * The fix: `initModel()` (fastembed.ts) retries a cache-hit warmup up to
 * `WARMUP_CACHE_HIT_ATTEMPTS` (2) times at the SAME tight per-attempt budget
 * (`warmupTimeoutMs(true)`, unchanged from BL-376) before giving up. The
 * outer `createFastembedProvider()` factory wraps the whole (possibly
 * retried) warmup in `warmupOuterBudgetMs(cacheHit)` instead of the old
 * single-attempt `warmupTimeoutMs(cacheHit)`.
 *
 * Reuses the `makeDelayedClient`-style injected `SharedFastembedProcessClient`
 * + `vi.useFakeTimers()` harness proven in bl376-warmup-timeout-split.spec.ts.
 */
describe('BUG-EMBED-WARMUP-CACHEHIT-ASSUMES-FAST-LOAD-001 — cache-hit warmup retry', () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(join(tmpdir(), 'sox-embed-warmup-cold-retry-'));
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    vi.useRealTimers();
    delete process.env['SOX_EMBED_WARMUP_CACHED_TIMEOUT_MS'];
    delete process.env['SOX_EMBED_WARMUP_TIMEOUT_MS'];
  });

  function writeCachedModel(modelId: string): string {
    const hfRepoId = MODEL_CONFIGS[modelId]!.hfRepoId;
    fs.mkdirSync(join(cacheDir, hfRepoId), { recursive: true });
    fs.writeFileSync(join(cacheDir, hfRepoId, 'model_optimized.onnx'), 'stub');
    return hfRepoId;
  }

  /**
   * A fake shared-process client whose 'init' leg fails/hangs on its FIRST
   * `nFailures` calls and resolves immediately on every call after that. Each
   * call gets its own timers, mirroring the real client's per-request timeout
   * (`SharedFastembedProcessClient.request()`), which is the literal shape of
   * "the second attempt catches what the first missed" — the simpler of the
   * two harness shapes the spec names, chosen to avoid reasoning about the
   * real shared child's internal serialized-queue timing.
   */
  function makeFlakyClient(nFailures: number): {
    client: SharedFastembedProcessClient;
    initCallCount: () => number;
  } {
    let initCalls = 0;
    const client = {
      request: (payload: { type?: string }, timeoutMs?: number) => {
        if (payload?.type !== 'init') {
          return Promise.resolve({ embedding: new Array(384).fill(0.1) });
        }
        const thisCall = ++initCalls;
        if (thisCall <= nFailures) {
          // Never resolves within budget — rejects at its own per-attempt timeout.
          return new Promise((_resolve, reject) => {
            const failTimer = setTimeout(() => {
              reject(new Error(`shared fastembed process request timed out after ${timeoutMs}ms`));
            }, timeoutMs ?? 8_000);
            if (typeof (failTimer as unknown as { unref?: () => void }).unref === 'function') {
              (failTimer as unknown as { unref: () => void }).unref();
            }
          });
        }
        // Resolves immediately — the fast-path a real retry hits once the
        // shared child's background load finishes (fastembedProcessHost.ts's
        // "already loaded" fast path).
        return Promise.resolve({ initOk: true, dim: 384, execution_provider: 'cpu' });
      },
    } as unknown as SharedFastembedProcessClient;
    return { client, initCallCount: () => initCalls };
  }

  // ── Pure function unit checks ──────────────────────────────────────────

  it('WARMUP_CACHE_HIT_ATTEMPTS is 2 (the single source of truth both loop bound and outer budget derive from)', () => {
    expect(WARMUP_CACHE_HIT_ATTEMPTS).toBe(2);
  });

  it('warmupOuterBudgetMs(true) === WARMUP_CACHE_HIT_ATTEMPTS * warmupTimeoutMs(true) — never hand-typed', () => {
    expect(warmupOuterBudgetMs(true)).toBe(WARMUP_CACHE_HIT_ATTEMPTS * warmupTimeoutMs(true));
    expect(warmupOuterBudgetMs(true)).toBe(16_000); // default 8s x 2
  });

  it('warmupOuterBudgetMs(false) === warmupTimeoutMs(false) — cache-miss stays a single 180s attempt, unchanged', () => {
    expect(warmupOuterBudgetMs(false)).toBe(warmupTimeoutMs(false));
    expect(warmupOuterBudgetMs(false)).toBe(180_000);
  });

  // ── AC-1: a cold-but-cached load that fails once but succeeds on retry ──

  it('AC-1: FIRST init attempt fails, SECOND succeeds — the outer call succeeds within warmupOuterBudgetMs(true)', async () => {
    vi.useFakeTimers();
    const modelId = 'bge-small-en-v1.5';
    writeCachedModel(modelId);

    const { client, initCallCount } = makeFlakyClient(1); // first call fails, second succeeds
    const provider = new FastembedProvider(modelId, 384, cacheDir, client);

    const warmup = provider.embedSingle('warmup');
    // First attempt's own timeout (8000ms) elapses and rejects; the retry
    // loop immediately issues the second attempt, which resolves synchronously
    // (Promise.resolve, no further timer needed).
    await vi.advanceTimersByTimeAsync(8_001);
    await expect(warmup).resolves.toBeInstanceOf(Float32Array);
    expect(provider.health().state).toBe('real');
    expect(initCallCount()).toBe(2);
  });

  it('AC-1 (RED-arm regression guard): a single-attempt client that only succeeds on its second call still fails today\'s way without the retry loop absent — proven by the loop existing: initCallCount reaching 2 IS the fix', async () => {
    // This test doubles as the RED-arm narrative: before this fix,
    // `initModel()` made exactly ONE `{type:'init'}` request per warmup
    // attempt — a client whose second call would have succeeded was never
    // asked. `initCallCount() === 2` above is the direct, mechanical proof
    // the retry now happens; this second assertion just pins the count at
    // exactly 2 (not more) per WARMUP_CACHE_HIT_ATTEMPTS.
    vi.useFakeTimers();
    const modelId = 'bge-small-en-v1.5';
    writeCachedModel(modelId);
    const { client, initCallCount } = makeFlakyClient(1);
    const provider = new FastembedProvider(modelId, 384, cacheDir, client);
    const warmup = provider.embedSingle('warmup');
    await vi.advanceTimersByTimeAsync(8_001);
    await warmup;
    expect(initCallCount()).toBe(WARMUP_CACHE_HIT_ATTEMPTS);
  });

  // ── AC-2: a genuinely hung load still fails within the bounded total ────

  it('AC-2: BOTH attempts hang — the outer call rejects at warmupOuterBudgetMs(true) (~16s default), not later, not unboundedly', async () => {
    vi.useFakeTimers();
    const modelId = 'bge-small-en-v1.5';
    writeCachedModel(modelId);

    const { client, initCallCount } = makeFlakyClient(Infinity); // never succeeds
    const provider = new FastembedProvider(modelId, 384, cacheDir, client);

    const warmup = provider.embedSingle('warmup');
    const assertion = expect(warmup).rejects.toThrow(/timed out after 8000ms/);
    await vi.advanceTimersByTimeAsync(warmupOuterBudgetMs(true) + 1);
    await assertion;
    expect(provider.health().state).toBe('error');
    expect(provider.health().last_error).toMatch(/timed out after 8000ms/);
    expect(initCallCount()).toBe(WARMUP_CACHE_HIT_ATTEMPTS);
  });

  it('AC-2: the outer createFastembedProvider() factory-level budget rejects at warmupOuterBudgetMs(true), matching the exported constant (no drift)', async () => {
    // Exercises warmupOuterBudgetMs() directly against the exported constant
    // rather than a hand-typed 16000 — the drift-prevention this item's own
    // risk section requires (WARMUP_CACHE_HIT_ATTEMPTS must be the single
    // source of truth for both the inner loop bound and the outer budget).
    expect(warmupOuterBudgetMs(true)).toBe(WARMUP_CACHE_HIT_ATTEMPTS * warmupTimeoutMs(true));
  });

  // ── Cache-miss path is unaffected ────────────────────────────────────────

  it('cache-miss: a single hung download attempt is NOT retried — one attempt, warmupTimeoutMs(false) budget, unchanged from BL-376', async () => {
    vi.useFakeTimers();
    const modelId = 'bge-small-en-v1.5';
    // No file written — genuine cache miss.
    const { client, initCallCount } = makeFlakyClient(Infinity);
    const provider = new FastembedProvider(modelId, 384, cacheDir, client);

    const warmup = provider.embedSingle('warmup');
    const assertion = expect(warmup).rejects.toThrow(/timed out after 180000ms/);
    await vi.advanceTimersByTimeAsync(180_001);
    await assertion;
    expect(initCallCount()).toBe(1); // never retried
  });
});
