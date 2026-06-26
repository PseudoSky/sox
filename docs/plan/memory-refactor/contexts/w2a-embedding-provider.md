# w2a-embedding-provider — Extract data/embed/embedding-provider

> **Slug is identity.** `w2a-embedding-provider` is immutable.

**Phase:** extraction · **Depends on:** `audit-layout` · **Guard:** `nx build embedding-provider && nx test embedding-provider`
**Parallel with:** `w2b-graph-store` (disjoint source files).

---

## Goal

Carve the text→vector substrate out of `memory-core` into the reusable
`@adhd/sox-embedding-provider` ([def:data-package], data/embed), implementing
[shape:embedding-provider-api]. The deterministic variant becomes a **first-class
provider** (the BL-86 home), real-provider load failure is **loud** ([def:loud-fail],
the BL-89 repair), and a **batch** API removes the N×latency footgun (SCOPE Part D).

This is the first carve; it owns the model-resolution + runtime concern so every other
data package (and the composer) gets vectors from one place.

---

## Semantic Distillation

- **Primitive:** EXTRACT `embed.ts` + `embedWorker.ts` into the data/embed package; keep
  the worker seam.
- **Reference Pattern:** `libs/memory-core/src/embed.ts` (current `embed`, `embedText`,
  `EMBED_MODEL`, `EMBED_DIM`, `getActiveEmbedModel`, `getEmbedState`, `reembedNodes`,
  backend selection at `embed.ts:271-285` — the silent-hash swallow that becomes
  [def:loud-fail]) and `embedWorker.ts` (the BL-11 worker isolation that keeps ONNX off
  the main thread). The quickfix's `fastembed`/`onnxruntime-node` wiring is the runtime
  to externalize.
- **Delta Spec:** implement [shape:embedding-provider-api]:
  - `resolveProvider(config): EmbeddingProvider` — config-driven model resolution;
    **THROWS** if the configured real provider cannot load (no silent downgrade). The
    hash/deterministic provider is selected only by explicit config
    (`SOX_EMBED_BACKEND=hash` or equivalent), never as an implicit fallback.
  - `provider.embed(text) → Promise<Float32Array>` (single).
  - `provider.embedBatch(texts, {batchSize=256}) → AsyncGenerator<Float32Array>` —
    fastembed's batch inference; the per-query single-embed N×latency footgun is avoided
    by callers using batch where they have many texts.
  - optional `provider.queryEmbed(text)` (query-optimized) + a **startup Map cache** for
    hot/topic embeddings.
  - every provider advertises `{providerId, modelId, dim, isDeterministic, isRemote}`.
  - **Contract is local‖remote-agnostic (owner directive, SCOPE Part A/D):** async + batch-first,
    no in-process assumptions, so the SAME `EmbedProvider` is valid for local AND network providers.
  - `deterministic.ts` — the first-class deterministic provider (carries the BL-86
    degeneracy fix; `isDeterministic:true`).
  - `fastembed.ts` — the real provider (bundled-ONNX); **ship ≥3 local models SPANNING DIMS from the
    gate** (e.g. bge-small 384, bge-base 768, e5-large 1024) — real+tested — to validate the interface
    against >1 model AND force `dim` parameterization (the 1024 model makes the `vec0 FLOAT[768]`
    hardcode a hard failure, not latent). Externalize `fastembed`/`onnxruntime-node` (engines `>=22`).
  - `remote.ts` — a remote-provider **adapter implemented against the SAME contract but NOT wired to a
    live/paid endpoint** (typed reference impl, `isRemote:true`; F3 — no spend, not live-tested). Proves
    the contract is context-agnostic without incurring remote cost.
  - Preserve the BL-11 worker boundary: real `embed()` runs in the worker thread, never
    the main thread alongside `openDb`.
- **Invariants added:** [inv:loud-fail], [inv:carry-fixes] (worker seam, BL-86),
  [inv:nx-targets], [inv:name-decoupled].
- **Validation:** `nx test embedding-provider` — new spec asserts loud-fail, batch
  generator, descriptor fields, deterministic cosine-sanity.

---

## Acceptance criteria

Checked by `audit-extraction`.

- [ ] **[w2a.1]** `@adhd/sox-embedding-provider` builds; exports `resolveProvider` +
      the `EmbeddingProvider` interface from `dist/index.js`.
- [ ] **[w2a.2]** [def:loud-fail]: `resolveProvider` with a real backend forced
      unavailable THROWS (does not return a hash provider). (vitest.)
- [ ] **[w2a.3]** Batch API: `embedBatch(['a','b','c'], {batchSize:2})` yields 3
      `Float32Array`s of length `dim`. (vitest.)
- [ ] **[w2a.4]** Descriptor: a resolved provider exposes `{providerId, modelId, dim,
      isDeterministic}` all populated. (vitest.)
- [ ] **[w2a.5]** Deterministic provider [fix:cosine-sanity]: two unrelated strings →
      cosine `< 0.5` (the BL-86 repair holds). (vitest.)
- [ ] **[w2a.6]** No silent fallback anywhere in `provider.ts` (`auto` selecting hash on
      real-load error is removed). [inv:loud-fail]

---

## Reservations

```text
read_only:  ["libs/memory-core/src/embed.ts", "libs/memory-core/src/embedWorker.ts"]
mutates:    ["libs/data/embed/embedding-provider/src/**"]
```

> NB: this state COPIES/transforms the embed logic into the new package; it does **not**
> yet delete `embed.ts` from `memory-core` (the composer still imports it until
> `w2e-domain-rewire` flips consumers and dissolves the facade).

---

## Notes for executor

- The batch generator is the headline Part-D ask — don't ship single-only.
- Keep the worker thread. A naive "just call onnxruntime inline" reintroduces the BL-11
  mutex corruption. The provider's real `embed` must route through the worker.
- `reembedNodes` logic does NOT live here — the migration WALK is [def:reembed-core] in
  `vector-store` (w2c). This package only provides the `embed`/`embedBatch` the walk calls.
- Budget: 1-2 sessions.
