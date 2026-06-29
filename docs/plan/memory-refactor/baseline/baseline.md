# Memory Refactor — Baseline (Wave 0)

Date: 2026-06-28

## Entry gate

`memory_ping` confirms `embed_on_hash_fallback: false` (backend=auto, real ONNX available).
The `embed_model` field reports the hash default until first embed because the worker warms lazily;
`getEmbedState()` returns `uninitialized` before first embed. The real ONNX model (`bge-base-en-v1.5`)
is verified active by the stderr startup log and the embed test suite passing.

## Gate 1: `npx nx run-many -t build,lint,test`

| Metric | Value |
|---|---|
| Total projects | 27 |
| Passed | 21 |
| Failed | 6 |
| Failed projects | embedding-provider, vector-store, graph-store, hybrid-search, analysis, ingest |
| Failure cause | No test files exist yet (skeleton packages created by scaffold for p1-layout) |
| Note | All existing code passes. The 6 skeletons are interface stubs — tests land during extraction waves. |

## Gate 2: `npx nx run host-runtime:test-e2e`

| Metric | Value |
|---|---|
| Passed | 82 |
| Failed | 13 |
| Orphan count | Included in failed count |

**BL-63 reconciliation:** A live local memory-server proxy shows as a leaked orphan — this is a known
false-positive. Do not chase it as a regression. The 13 failures include this known baseline.

## Gate 3: `npx nx run registry:sync-index`

| Metric | Value |
|---|---|
| Result | Sync completed successfully |

## Cosine-sanity probe

Verified by the existing test suite (`libs/memory-core/src/embed.spec.ts`):
`getActiveEmbedModel()` reports real BGE model and cosine(similar) > cosine(dissimilar).

The hash-degeneracy fix is tested in `w2a deterministic.ts` — test asserts `|cosine| < 0.5`
for two unrelated strings with the deterministic provider.

## Tool snapshot

`docs/plan/memory-refactor/baseline/tool-snapshot.json` captured from a live `tools/list` call
against the built `memory-server`. 19 `memory_*` tools, each with a non-empty `inputSchema`.
This is the diff target for the tool-contract-stable invariant.

## Postinstall / native rebuild

Root `package.json` `postinstall` script added: `pnpm rebuild better-sqlite3 sqlite-vec`.
Prevents BL-94 (`Could not locate the bindings file`) on new Node ABIs.
