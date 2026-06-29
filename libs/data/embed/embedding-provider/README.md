# @adhd/sox-embedding-provider

Pluggable text→vector embedding provider — generic EmbeddingProvider interface, config-driven model resolution, async batch-first API (AsyncIterable), symmetric + asymmetric encoding via role param. Default: fastembed (local ONNX, >=3 model dims proven). Loud-fail: createEmbeddingProvider() throws ResolutionError if config is invalid or model cannot load — no silent hash downgrade.

- **area:** data · **group:** embed · **publish:** PUBLIC (`private: false`, publish owner-gated)
- **engines:** Node >=22
- **concerns:** text→vector (EmbeddingProvider interface), config-driven model resolution (createEmbeddingProvider factory), async batch embed (AsyncIterable<Float32Array>), asymmetric encoding via role param (document | query), warmUp cache for hot/topic texts, loud-fail ResolutionError at factory time (never mid-call), three-tier error taxonomy (Transient / Permanent / Resolution), deterministic hash provider as first-class alternative

## Invariants

- createEmbeddingProvider() THROWS ResolutionError synchronously or as a rejection if the config is invalid or the model/runtime cannot load — never silently downgrades to hash
- every provider advertises { modelId, dimensions, isRemote, isDeterministic, providerUri? } via metadata — callers never hardcode dims
- embedBatch() returns AsyncIterable<Float32Array> — callers receive first result before last batch finishes (critical for sequential local inference)
- warmUp() is a no-op when isDeterministic === false
- TransientEmbeddingError → caller may retry; PermanentEmbeddingError → caller must not retry; ResolutionError → factory-time only, never thrown mid-call

## Interface spec

See [COMPILED_INTERFACES.md](../../../../docs/plan/memory-refactor/COMPILED_INTERFACES.md) for the authoritative interface contract. `src/index.ts` is a compileable ambient-declaration skeleton;
implementation is extracted from `libs/memory-core` / `libs/memory-enrich` by the memory-refactor plan.
