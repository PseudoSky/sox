/**
 * hol-pool-sizing.spec.ts — BUG-MEMORY-EMBED-HEAD-OF-LINE-BLOCKING-001,
 * post-review addendum.
 *
 * `resolveFastembedPoolSize()`'s original default (`floor(cpus/2)`, cap 4,
 * memory-blind) was reviewed and found unsafe: measured via `footprint` on
 * REAL forked fastembed children (see the module doc comment in
 * `sharedFastembedProcess.ts` for the full readout), onnxruntime-node
 * HEAP-ALLOCATES the model per process (~265MB physical footprint per child
 * for the production default bge-base-en-v1.5, confirmed as private DIRTY
 * `MALLOC_LARGE`, not a shared/clean mmap'd region) — a naive 4-member
 * default could try to allocate ~800MB more than is actually free on a
 * memory-constrained box, which measured 128MB free at review time on the
 * dev machine this was built on.
 *
 * This suite proves the fix: sizing is now memory-aware (via `os.freemem()`
 * against a configurable per-member budget) AND still capped by CPU count,
 * always taking the smaller of the two — so a memory-constrained box gets a
 * small (possibly 1-member, i.e. exact pre-fix) pool instead of a default
 * that risks OOM.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as os from 'node:os';
import { resolveFastembedPoolSize, estimateAvailableMemMb } from './sharedFastembedProcess.js';

const ENV_KEYS = ['SOX_EMBED_POOL_SIZE', 'SOX_EMBED_POOL_PER_CHILD_MB'] as const;
const savedEnv: Record<string, string | undefined> = {};

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function setEnv(k: (typeof ENV_KEYS)[number], v: string | undefined): void {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

describe('BUG-MEMORY-EMBED-HEAD-OF-LINE-BLOCKING-001 — resolveFastembedPoolSize() is memory-aware, not just CPU-aware', () => {
  it('an explicit SOX_EMBED_POOL_SIZE is honored EXACTLY, bypassing the memory clamp entirely (operator judgement wins)', () => {
    setEnv('SOX_EMBED_POOL_SIZE', '7');
    setEnv('SOX_EMBED_POOL_PER_CHILD_MB', undefined);
    expect(resolveFastembedPoolSize()).toBe(7);
  });

  it('SOX_EMBED_POOL_SIZE=1 recovers the exact pre-fix single-child topology', () => {
    setEnv('SOX_EMBED_POOL_SIZE', '1');
    expect(resolveFastembedPoolSize()).toBe(1);
  });

  it('auto-sizing clamps DOWN to 1 when the (operator-supplied) per-member budget exceeds available memory — the exact shape that would have OOM-risked the reviewed dev box (128MB free, naive default 4)', () => {
    setEnv('SOX_EMBED_POOL_SIZE', undefined);
    // A per-member budget larger than total physical memory forces the
    // memory cap to floor at 1 regardless of CPU count — this is the
    // memory-constrained-box scenario the review flagged.
    const totalMb = os.totalmem() / (1024 * 1024);
    setEnv('SOX_EMBED_POOL_PER_CHILD_MB', String(Math.ceil(totalMb * 2)));
    expect(resolveFastembedPoolSize()).toBe(1);
  });

  it('auto-sizing is NEVER bounded above CPU count, regardless of how large the memory cap computes to (structural invariant — does not assume any particular real os.freemem() value, since that is genuinely machine/moment-dependent: this suite was itself first run on a box with only ~128MB free)', () => {
    setEnv('SOX_EMBED_POOL_SIZE', undefined);
    const cpuCap = Math.max(1, Math.min(4, Math.floor((os.cpus().length || 1) / 2)));
    // A tiny per-member budget (1MB) drives the memory cap as high as
    // real free memory allows — resolveFastembedPoolSize() must still never
    // exceed min(4, floor(cpus/2)), whatever that memory cap turns out to be
    // on whatever box this runs on.
    setEnv('SOX_EMBED_POOL_PER_CHILD_MB', '1');
    expect(resolveFastembedPoolSize()).toBeLessThanOrEqual(cpuCap);
    expect(resolveFastembedPoolSize()).toBeLessThanOrEqual(4);
  });

  it('auto-sizing is monotonic non-increasing in the per-member budget: a SMALLER budget (implying more affordable members) never yields a SMALLER pool than a LARGER budget, at the same moment\'s free memory', () => {
    setEnv('SOX_EMBED_POOL_SIZE', undefined);
    setEnv('SOX_EMBED_POOL_PER_CHILD_MB', '5000');
    const sizeAtLargeBudget = resolveFastembedPoolSize();
    setEnv('SOX_EMBED_POOL_PER_CHILD_MB', '1');
    const sizeAtTinyBudget = resolveFastembedPoolSize();
    expect(sizeAtTinyBudget).toBeGreaterThanOrEqual(sizeAtLargeBudget);
  });

  it('the result is always a positive integer >= 1 (never 0, never negative, never fractional), across a range of per-member budgets', () => {
    setEnv('SOX_EMBED_POOL_SIZE', undefined);
    for (const mb of ['1', '50', '300', '5000', '999999']) {
      setEnv('SOX_EMBED_POOL_PER_CHILD_MB', mb);
      const size = resolveFastembedPoolSize();
      expect(Number.isInteger(size)).toBe(true);
      expect(size).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('BUG-EMBED-POOL-SIZE-DARWIN-FREEMEM-001 — pool auto-sizing uses a real availability estimate, not raw os.freemem() alone', () => {
  it(
    'estimateAvailableMemMb() never reports LESS than raw os.freemem() — the ' +
      'correctness invariant that makes switching resolveFastembedPoolSize() ' +
      'onto it monotonic-safe on every platform, not just the darwin box this ' +
      'was diagnosed on (measured there: os.freemem() ~299MB while free+' +
      'inactive+speculative+purgeable was ~5.4GB+ — see the function doc comment)',
    () => {
      const rawFreeMb = os.freemem() / (1024 * 1024);
      expect(estimateAvailableMemMb()).toBeGreaterThanOrEqual(rawFreeMb);
    },
  );

  it(
    'resolveFastembedPoolSize(getAvailableMemMb) is monotonic non-decreasing ' +
      'in the injected available-memory reading, at a fixed per-member budget ' +
      '— reproduces the exact incident numbers: raw os.freemem() (299MB, ' +
      'measured on the diagnosis box) clamps the pool to 1 (memoryCap = ' +
      'max(1, floor((299-1024)/300)) = max(1, negative) = 1) even though the ' +
      'SAME box, SAME moment, had ~5.4GB of real reclaimable memory once ' +
      'inactive/speculative/purgeable pages are counted — the exact "pool ' +
      'appears to be operating at size 1" symptom this bug report opened with',
    () => {
      setEnv('SOX_EMBED_POOL_SIZE', undefined);
      setEnv('SOX_EMBED_POOL_PER_CHILD_MB', '300');
      const sizeAtRawMacosFreemem = resolveFastembedPoolSize(() => 299);
      const sizeAtRealAvailableEstimate = resolveFastembedPoolSize(() => 5838);
      expect(sizeAtRawMacosFreemem).toBe(1);
      expect(sizeAtRealAvailableEstimate).toBeGreaterThan(sizeAtRawMacosFreemem);
    },
  );

  it(
    'production default resolveFastembedPoolSize() (no injection — the exact ' +
      'call getSharedFastembedProcess() makes) resolves through ' +
      'estimateAvailableMemMb(), not raw os.freemem() — confirmed by ' +
      'requiring the production call to agree with the injected-estimate call ' +
      'and DISAGREE with the injected-raw-freemem call whenever those two ' +
      'differ enough to cross a cap boundary on THIS machine, at the exact ' +
      'default budget',
    () => {
      setEnv('SOX_EMBED_POOL_SIZE', undefined);
      setEnv('SOX_EMBED_POOL_PER_CHILD_MB', undefined);
      const rawFreeMb = os.freemem() / (1024 * 1024);
      const estimatedMb = estimateAvailableMemMb();
      const productionSize = resolveFastembedPoolSize();
      const sizeFromRaw = resolveFastembedPoolSize(() => rawFreeMb);
      const sizeFromEstimate = resolveFastembedPoolSize(() => estimatedMb);
      expect(productionSize).toBe(sizeFromEstimate);
      const cpuCap = Math.max(1, Math.min(4, Math.floor((os.cpus().length || 1) / 2)));
      if (sizeFromRaw < cpuCap && estimatedMb > rawFreeMb) {
        // The exact incident shape: raw freemem under-sizes below what CPU
        // count would otherwise allow, AND the estimate is strictly larger —
        // production must no longer inherit the raw-freemem clamp.
        expect(productionSize).toBeGreaterThan(sizeFromRaw);
      } else {
        // Structurally impossible for this fix to matter on this exact
        // machine right now (already CPU-capped, or freemem/estimate happen
        // to coincide) — still assert the two calls agree, so the branch
        // never silently runs zero assertions (BL-167).
        expect(productionSize).toBe(sizeFromRaw);
      }
    },
  );
});
