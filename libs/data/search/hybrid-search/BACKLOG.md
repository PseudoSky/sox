# Backlog — `@adhd/sox-hybrid-search`

Package-local backlog. Items cross-reference the root [`/BACKLOG.md`](../../../../BACKLOG.md) BL-IDs.
This is a public data-layer package (the retrieve + fuse + rerank layer of the RAG substrate). The
vec+BM25+RRF fusion path is real and consumed live by `memory-core/recall.ts`. The **cross-encoder
reranker sub-path is not**.

---

### BL-116 — HIGH: cross-encoder worker uses a token-overlap heuristic, not a real ONNX model

`src/crossEncoderWorker.ts` `computeRerankScores()` scores by token overlap, NOT a real cross-encoder
ONNX model. So `createCrossEncoder()` advertises reranking but returns lexical-overlap scores — a
correctness gap: results are not semantically reranked. Either wire a real cross-encoder ONNX model
(via the shared embed/worker host) or rename + document it as a lexical reranker so callers aren't
misled. Root: BL-116.

### BL-166 — HIGH: the cross-encoder is BUILT BUT UNWIRED, and its worker path won't resolve in a bundle

`createCrossEncoder`/`CrossEncoderImpl` are exported + tested but the **only caller is their own
spec** — `memory-core/recall.ts` never reranks with the cross-encoder (it reranks by temporal
recency×importance only). So the whole cross-encoder path is dead in the live system. Compounding it,
`cross-encoder.ts` `resolveWorkerPath()` hard-codes `../../../../embed/embedding-provider/dist/
embedWorker.js` relative to `import.meta.url` — which will NOT resolve inside a bundled/CJS deployment
(same failure class as BL-155/BL-157). **Decide (owner):** wire a real cross-encoder into recall behind
a flag (making BL-116's real-ONNX fix worthwhile), or remove the cross-encoder path. Root: BL-166, BL-157.

---

### Notes (resolved / positive)

- **HF-3 (root BL-132):** `fuseWithBreakdown()` + an additive per-result `score_breakdown` (vec / bm25 /
  temporal contributions summing to the fused score, per-query min-max normalized) now make recall
  scores legible across dissimilar queries. The existing `score` field is byte-compatible.
- **Lint regression fixed:** `cross-encoder.ts`'s static import of embedding-provider error classes
  (needed as values) tripped `@nx/enforce-module-boundaries` after the RS-1/RS-2 embed migration
  (commit `3360f8b`); resolved with a documented line-scoped disable (require.resolve resolves a path,
  it does not lazy-load — a false positive).
