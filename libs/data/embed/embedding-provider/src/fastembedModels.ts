/**
 * Shared, side-effect-free model-resolution data for the fastembed ONNX
 * provider — imported by BOTH the parent-side `fastembed.ts` (MODEL_CONFIGS)
 * and the CHILD-side `fastembedProcessHost.ts` (MODEL_MAP, resolveModelDim).
 *
 * This module must stay PURE: zero imports at runtime (the only import is a
 * type-only one, erased by esbuild), zero module-scope side effects. It is
 * bundled into the forked child process, which must never transitively load
 * parent-side modules (`sharedFastembedProcess.ts` resolves
 * `fileURLToPath(import.meta.url)` at module scope — BL-155 — and would crash
 * a CJS bundle). That is why MODEL_CONFIGS lives HERE rather than being
 * imported by the child from `./fastembed.js` (which drags in
 * `./sharedFastembedProcess.js` and `./index.js`).
 */

import type { FastEmbedModelConfig } from './index.js';

/**
 * Single source of truth for the configured fastembed ONNX models — moved
 * here from `fastembed.ts` (BUG-005) so the child process host can read the
 * resolved model config (dim) without importing parent-side modules.
 */
export const MODEL_CONFIGS: Record<string, FastEmbedModelConfig> = {
  'bge-small-en-v1.5': {
    modelId: 'bge-small-en-v1.5',
    hfRepoId: 'fast-bge-small-en-v1.5',
    dim: 384,
    maxTokens: 512,
    description: 'BGE Small English v1.5 — lightweight 384-dim embedding, ~33M params',
  },
  'bge-base-en-v1.5': {
    modelId: 'bge-base-en-v1.5',
    hfRepoId: 'fast-bge-base-en-v1.5',
    dim: 768,
    maxTokens: 512,
    description: 'BGE Base English v1.5 — balanced 768-dim embedding, ~110M params',
  },
  'multilingual-e5-large': {
    modelId: 'multilingual-e5-large',
    hfRepoId: 'fast-multilingual-e5-large',
    dim: 1024,
    maxTokens: 512,
    description: 'Multilingual E5 Large — 1024-dim, 100+ languages, ~335M params',
  },
  'bge-m3': {
    modelId: 'bge-m3',
    hfRepoId: 'BAAI/bge-m3',
    dim: 1024,
    maxTokens: 8192,
    description: 'BGE-M3 — 570M params, 8192-token context, 100+ languages, ONNX INT8',
  },
  'codexembed-400m': {
    modelId: 'codexembed-400m',
    hfRepoId: 'microsoft/codexembed-400m',
    dim: 1024,
    maxTokens: 8192,
    description: 'CodeXEmbed-400M — code-only CPU, ~1.6GB RAM, 8192-token context',
  },
};

/**
 * Raw configured model name → fastembed model id passed to
 * `FlagEmbedding.init({ model })`. Distinct from `hfRepoId` (the HuggingFace
 * repo path used for cache layout) — e.g. codexembed-400m maps to
 * 'CodeXEmbed-400M' for fastembed but 'microsoft/codexembed-400m' on disk.
 */
export const MODEL_MAP: Record<string, string> = {
  'bge-small-en-v1.5': 'fast-bge-small-en-v1.5',
  'bge-base-en-v1.5': 'fast-bge-base-en-v1.5',
  'multilingual-e5-large': 'fast-multilingual-e5-large',
  'bge-m3': 'BAAI/bge-m3',
  'codexembed-400m': 'CodeXEmbed-400M',
};

/**
 * Resolve the embedding dimension to report for a configured model.
 *
 * BUG-005: the child host's original lookup compared the RAW configured name
 * ('bge-base-en-v1.5') against the `model` field of
 * `listSupportedModels()` — which carries fastembed's ENUM VALUE
 * ('fast-bge-base-en-v1.5'). The comparison never matched, so the init reply
 * always reported dim 0 (the actual model config still loaded fine).
 *
 * Strategy, in order:
 *   1. Match `listSupportedModels()` against the resolved enum constant
 *      (`MODEL_MAP[model] ?? model`) — the truth from the loaded embedder.
 *   2. Fall back to the resolved `MODEL_CONFIGS[model]` entry — covers
 *      custom models (bge-m3, codexembed-400m) that fastembed's supported
 *      list never contains.
 *   3. Return 0 only when the model is entirely unknown — callers (the
 *      child's init reply) must treat that as an error, never a silent 0.
 *
 * @param model Raw configured model name (MODEL_CONFIGS key).
 * @param supportedModels The embedder's `listSupportedModels()` output.
 */
export function resolveModelDim(
  model: string,
  supportedModels: ReadonlyArray<{ model: string; dim: number }>,
): number {
  const fastModel = MODEL_MAP[model] ?? model;
  const fromList = supportedModels.find((m) => m.model === fastModel);
  if (fromList && fromList.dim > 0) return fromList.dim;
  return MODEL_CONFIGS[model]?.dim ?? 0;
}
