# Backlog — `@adhd/sox-hybrid-search`

Package-local backlog. Items cross-reference the root [`/BACKLOG.md`](../../../../BACKLOG.md) BL-IDs.
This is a public data-layer package (the retrieve + fuse + rerank layer of the RAG substrate). The
vec+BM25+RRF fusion path is real and consumed live by `libs/memory-core/src/recall.ts`. The **cross-encoder
reranker sub-path is not**.

---

### BL-116 — HIGH [TRIAGE]: cross-encoder worker uses a token-overlap heuristic, not a real ONNX model

`libs/data/search/hybrid-search/src/crossEncoderWorker.ts` `computeRerankScores()` scores by token overlap, NOT a real cross-encoder
ONNX model. So `createCrossEncoder()` advertises reranking but returns lexical-overlap scores — a
correctness gap: results are not semantically reranked. Either wire a real cross-encoder ONNX model
(via the shared embed/worker host) or rename + document it as a lexical reranker so callers aren't
misled. Root: BL-116.

**Triage context:** BL-116 and BL-166 are coupled — there's no point fixing the ONNX model (BL-116)
until the wire-in-or-remove decision (BL-166) is made. The current token-overlap heuristic is a
placeholder stub; a real cross-encoder needs:
- An ONNX model file (MiniCheck/flan-t5-large, ~500MB)
- worker-thread model loading via `onnxruntime-node` (same infrastructure as embedding-provider)
- latency budget: cross-encoder inference is ~50-200ms per query-candidate pair, so reranking
  top-20 candidates adds ~1-4s to recall latency
- integration into `libs/memory-core/src/recall.ts` behind a feature flag

This is a substantial feature, not a quick fix. The token-overlap stub is harmless (no caller uses it).

### BL-166 — HIGH [TRIAGE]: the cross-encoder is BUILT BUT UNWIRED, and its worker path won't resolve in a bundle — **RESOLVED (2026-07-10)** — VERIFIED consumed externally by `/Users/nix/dev/ai/agent-source` (declared as a `file:` dep in its `package.json`; 16 import sites across the three packages). The in-repo grep found zero importers because live objects cross the boundary via DI per ADR-0006 — production code imports the *type* and the composition root constructs it. See root BACKLOG BL-166.

`createCrossEncoder`/`CrossEncoderImpl` are exported + tested but the **only caller is their own
spec** — `libs/memory-core/src/recall.ts` never reranks with the cross-encoder (it reranks by temporal
recency×importance only). So the whole cross-encoder path is dead in the live system. Compounding it,
`libs/data/search/hybrid-search/src/cross-encoder.ts` `resolveWorkerPath()` hard-codes `../../../../embed/embedding-provider/dist/
embedWorker.js` relative to `import.meta.url` — which will NOT resolve inside a bundled/CJS deployment
(same failure class as BL-155/BL-157). **Decide (owner):** wire a real cross-encoder into recall behind
a flag (making BL-116's real-ONNX fix worthwhile), or remove the cross-encoder path. Root: BL-166, BL-157.

**Triage context:** Cross-encoder is the most expensive orphan to wire in — it needs BL-116's real
ONNX model first, plus the bundler worker-path fix (BL-157 pattern), plus integration into recall
with a latency budget. The vec+BM25 fusion path already produces good results. Options:
- **(A) Wire in** — make cross-encoder a real semantic reranker behind a `use_cross_encoder` flag
  in recall. High effort (~1 week), high value for precision-sensitive recall.
- **(B) Remove** — deprecate `createCrossEncoder()` / `CrossEncoderImpl`, leave as no-op stubs
  or delete. Low effort. The public API surface is affected — this is a public package.
- **(C) Keep as-is with doc note** — document that the cross-encoder path is an experimental stub
  (not wired into recall, token-overlap only). Zero effort. Doesn't violate the "fix/remove"
  directive if the owner explicitly accepts "experimental/stub" status.

---

### Notes (resolved / positive)

- **HF-3 (root BL-132):** `fuseWithBreakdown()` + an additive per-result `score_breakdown` (vec / bm25 /
  temporal contributions summing to the fused score, per-query min-max normalized) now make recall
  scores legible across dissimilar queries. The existing `score` field is byte-compatible.
- **Lint regression fixed:** `libs/data/search/hybrid-search/src/cross-encoder.ts`'s static import of `libs/data/embed/embedding-provider` error classes
  (needed as values) tripped `@nx/enforce-module-boundaries` after the RS-1/RS-2 embed migration
  (commit `3360f8b`); resolved with a documented line-scoped disable (require.resolve resolves a path,
  it does not lazy-load — a false positive).
