/**
 * BUG-005 — regression tests for the fastembed init-reply dimension
 * resolution.
 *
 * Root cause: `fastembedProcessHost.ts`'s `loadModel` looked up
 * `listSupportedModels().find((m) => m.model === model)` with the RAW
 * configured model name ('bge-base-en-v1.5'), but fastembed's
 * `listSupportedModels()` returns `model` as the ENUM VALUE
 * ('fast-bge-base-en-v1.5'). The comparison never matched, so the init
 * reply always reported `dim: 0` (embedding math was unaffected — the real
 * model config still loaded). Verified RED through the real forked child
 * path: `{ initOk: true, dim: 0 }` for a successfully-loaded cached model.
 *
 * The fix (`fastembedModels.ts` `resolveModelDim`) matches against the
 * resolved enum constant (MODEL_MAP) first, then falls back to the resolved
 * MODEL_CONFIGS entry (covers custom models like bge-m3 / codexembed-400m
 * that the supported list never contains), and returns 0 only for entirely
 * unknown models — which the child then treats as a loud init error, never
 * a silent dim-0 reply.
 */
import { describe, expect, it } from 'vitest';
import { MODEL_CONFIGS, MODEL_MAP, resolveModelDim } from './fastembedModels.js';

/**
 * The EXACT array `FlagEmbedding.listSupportedModels()` returns at runtime —
 * verified against node_modules/fastembed/lib/esm/fastembed.js:265-300 (the
 * `model` field is the enum VALUE, e.g. 'fast-bge-base-en-v1.5').
 */
const FASTEMBED_SUPPORTED_LIST: Array<{ model: string; dim: number }> = [
  { model: 'fast-bge-small-en', dim: 384 },
  { model: 'fast-bge-small-en-v1.5', dim: 384 },
  { model: 'fast-bge-base-en', dim: 768 },
  { model: 'fast-bge-base-en-v1.5', dim: 768 },
  { model: 'fast-bge-small-zh-v1.5', dim: 512 },
  { model: 'fast-all-MiniLM-L6-v2', dim: 384 },
  { model: 'fast-multilingual-e5-large', dim: 1024 },
] satisfies Array<{ model: string; dim: number }>;

describe('BUG-005 — resolveModelDim (fastembed init-reply dimension)', () => {
  it('documents the original bug: the RAW configured name never matches the enum-value list, so the pre-fix lookup always missed', () => {
    // This is exactly the expression the pre-fix child evaluated. It finds
    // nothing because 'bge-base-en-v1.5' !== 'fast-bge-base-en-v1.5'.
    const info = FASTEMBED_SUPPORTED_LIST.find((m) => m.model === 'bge-base-en-v1.5');
    expect(info).toBeUndefined();
  });

  it('resolves the list-backed models via the enum constant (MODEL_MAP)', () => {
    // 'bge-base-en-v1.5' → MODEL_MAP → 'fast-bge-base-en-v1.5' → list dim 768.
    expect(resolveModelDim('bge-base-en-v1.5', FASTEMBED_SUPPORTED_LIST)).toBe(768);
    expect(resolveModelDim('bge-small-en-v1.5', FASTEMBED_SUPPORTED_LIST)).toBe(384);
    expect(resolveModelDim('multilingual-e5-large', FASTEMBED_SUPPORTED_LIST)).toBe(1024);
  });

  it('falls back to the resolved MODEL_CONFIGS entry for custom models the supported list never contains (bge-m3, codexembed-400m)', () => {
    // bge-m3 → MODEL_MAP → 'BAAI/bge-m3' — not in the supported list; the
    // config entry (dim 1024) is the source of truth.
    expect(resolveModelDim('bge-m3', FASTEMBED_SUPPORTED_LIST)).toBe(1024);
    expect(resolveModelDim('codexembed-400m', FASTEMBED_SUPPORTED_LIST)).toBe(1024);
  });

  it('every configured model resolves to a positive dim (the init-reply assert: dim > 0 or error, never 0)', () => {
    for (const modelId of Object.keys(MODEL_CONFIGS)) {
      const dim = resolveModelDim(modelId, FASTEMBED_SUPPORTED_LIST);
      expect(dim, `model ${modelId}`).toBeGreaterThan(0);
      expect(dim, `model ${modelId}`).toBe(MODEL_CONFIGS[modelId]!.dim);
    }
  });

  it('returns 0 only for an entirely unknown model (which the child turns into a loud init error)', () => {
    expect(resolveModelDim('no-such-model', FASTEMBED_SUPPORTED_LIST)).toBe(0);
  });

  it('MODEL_MAP values match the fastembed enum constants for the list-backed models (the match target)', () => {
    expect(MODEL_MAP['bge-base-en-v1.5']).toBe('fast-bge-base-en-v1.5');
    expect(MODEL_MAP['bge-small-en-v1.5']).toBe('fast-bge-small-en-v1.5');
    expect(MODEL_MAP['multilingual-e5-large']).toBe('fast-multilingual-e5-large');
  });
});
