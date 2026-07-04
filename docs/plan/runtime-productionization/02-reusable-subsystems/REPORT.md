# Context 02 — reusable subsystems: completion report

**Branch:** `runtime-prod/02-reusable-subsystems`
**Completed:** 2026-07-03
**Orchestrator:** single agent (no subdispatch)

---

## Summary

Migrated memory-core embedding off its private `embed.ts` onto the shared
`@adhd/sox-embedding-provider` (RS-1), and consolidated three ONNX-worker consumers
(embedding-provider, hybrid-search, claim-verification) onto a single canonical
`embedWorker.ts` implementation (RS-2). Two backlog items resolved: BL-147 and BL-149.

---

## Items completed

### RS-0 — Capture enrichment-parity + write-perf baselines (BEFORE any change)

- **Status:** complete
- **Files:** `_shared/baselines/enrichment-parity.json`, `_shared/baselines/write-perf.json`,
  `scripts/capture-enrichment-baseline.mjs`, `scripts/capture-write-perf-baseline.mjs`
- **Evidence:**
  - `node scripts/capture-enrichment-baseline.mjs` → 240 communities, 1597 member_of edges,
    5730 live nodes, 3598 episodes, 178991 edges on snapshot sha256:10ded6fe
  - `node scripts/capture-write-perf-baseline.mjs` → p50=381ms p99=739ms over 100 sequential writes
- **Notes:** Snapshot DB files excluded from repo (51MB); only sha256+counter fingerprints committed.

### RS-1 — Migrate memory off private embed.ts onto embedding-provider + health() (BL-147)

- **Status:** complete
- **Scope:** `libs/memory-core/src/embed.ts`, `libs/memory-core/package.json`
- **Changes:**
  - `embed.ts` rewritten as a thin ping/stats adapter over
    `@adhd/sox-embedding-provider` via `createEmbeddingProvider()`
  - Backend selection via `SOX_EMBED_BACKEND` (auto/real/hash) preserved
  - `providerCallCount` only increments for non-hash (real) backends — fixes
    BL-54 false-hash-fallback (guard on `_resolvedBackend`)
  - Health methods wired: `getEmbedHealth`, `getEmbedState`, `getLastEmbedError`,
    `warmupEmbed`
  - `fastembed` dependency removed from `libs/memory-core/package.json`
- **Tests:** `embed.spec.ts` 19/20 passed, 1 skipped (real model download test);
  recall tests assert `provider_call_count: 0` for hash backend
- **BL-147 flipped** to FIXED in BACKLOG.md

### RS-2 — Shared ONNX worker host; migrate 3 wrappers (BL-149)

- **Status:** complete
- **Scope:**
  - `libs/data/embed/embedding-provider/src/embedWorker.ts` — canonical shared worker
  - `libs/data/embed/embedding-provider/src/deterministic.ts` — refactored for shared protocol
  - `libs/data/embed/embedding-provider/src/fastembed.ts` — refactored for shared protocol
  - `libs/data/embed/embedding-provider/src/remote.ts` — refactored for shared protocol
  - `libs/data/embed/embedding-provider/src/index.ts` — exports updated
  - `libs/data/embed/embedding-provider/src/embedding-provider.spec.ts` — extended coverage
  - `libs/data/search/hybrid-search/src/cross-encoder.ts` — references shared worker
  - `libs/data/search/hybrid-search/src/crossEncoderWorker.ts` — **deleted** (replaced by shared)
  - `libs/data/verify/claim-verification/src/worker.ts` — proxies to shared embedWorker.ts
  - `libs/data/verify/claim-verification/src/verifierWorker.ts` — **deleted** (replaced by shared)
  - `libs/memory-core/src/embedWorker.ts` — **deleted** (replaced by shared in provider)
- **Tests:**
  - `embedding-provider` 33/33 passed
  - `hybrid-search` 56/56 passed
  - `claim-verification` 10/10 passed
- **Verification:** `rg -l "worker" libs/data/ libs/memory-core/` shows exactly one
  worker implementation (`embedding-provider/src/embedWorker.ts`) plus consumers
- **BL-149 flipped** to FIXED in BACKLOG.md

---

## Files changed

| File | Lines | Change |
|------|-------|--------|
| `libs/memory-core/src/embed.ts` | −456 / +41 | Delegates to `@adhd/sox-embedding-provider`; health methods wired; `providerCallCount` guard |
| `libs/memory-core/package.json` | −1 | Removed `fastembed` dependency |
| `libs/data/embed/embedding-provider/src/embedWorker.ts` | +248/−? | Canonical shared ONNX worker (enhanced protocol) |
| `libs/data/embed/embedding-provider/src/deterministic.ts` | +12/−? | Refactored for shared worker protocol |
| `libs/data/embed/embedding-provider/src/fastembed.ts` | +25/−? | Refactored for shared worker protocol |
| `libs/data/embed/embedding-provider/src/remote.ts` | +12/−? | Refactored for shared worker protocol |
| `libs/data/embed/embedding-provider/src/index.ts` | +10 | Exports updated for shared protocol |
| `libs/data/embed/embedding-provider/src/embedding-provider.spec.ts` | +37 | Extended coverage |
| `libs/data/search/hybrid-search/src/cross-encoder.ts` | +67/−? | References shared worker protocol |
| `libs/data/search/hybrid-search/src/crossEncoderWorker.ts` | −135 | Deleted (replaced by shared embedWorker.ts) |
| `libs/data/verify/claim-verification/src/worker.ts` | +101/−? | Consumes shared embedWorker.ts |
| `libs/data/verify/claim-verification/src/verifierWorker.ts` | −140 | Deleted (replaced by shared embedWorker.ts) |
| `libs/memory-core/src/embedWorker.ts` | −74 | Deleted (private worker replaced by shared) |
| `BACKLOG.md` | +31 | BL-147 and BL-149 flipped to FIXED |
| `progress.json` | +46 | RS-1/RS-2 evidence recorded |

**Summary:** 22 files, +697 / −865 lines.

---

## Test results

| Package | Command | Passed | Failed | Skipped |
|---------|---------|--------|--------|---------|
| `@adhd/sox-embedding-provider` | `nx test embedding-provider` | 33 | 0 | 0 |
| `@adhd/sox-hybrid-search` | `nx test hybrid-search` | 56 | 0 | 0 |
| `@adhd/sox-claim-verification` | `nx test claim-verification` | 10 | 0 | 0 |
| `@adhd/sox-memory-core` | `nx test memory-core` | 19 | 0 | 1 |

The single skip in `memory-core` is the real model download test (requires network + model
download; runs only when `SOX_EMBED_BACKEND=real` and model is not yet cached).

---

## Lint / Build

All four affected packages (`memory-core`, `embedding-provider`, `hybrid-search`,
`claim-verification`) pass `nx lint` and `nx build` with zero errors.

---

## BL-147 / BL-149 evidence

### BL-147 — memory-core embed.ts delegates to `@adhd/sox-embedding-provider`

- `embed.ts` uses `createEmbeddingProvider` from `@adhd/sox-embedding-provider`
- `providerCallCount` guard on `_resolvedBackend` prevents false counting of hash fallback
- `warmupEmbed()` establishes worker, `getEmbedHealth()` reflects real backend state
- `fastembed` removed from `memory-core/package.json`

### BL-149 — Single shared ONNX worker host

- **Canonical location:** `libs/data/embed/embedding-provider/src/embedWorker.ts`
- **Deleted duplicates:**
  - `libs/memory-core/src/embedWorker.ts` (74 lines)
  - `libs/data/search/hybrid-search/src/crossEncoderWorker.ts` (135 lines)
  - `libs/data/verify/claim-verification/src/verifierWorker.ts` (140 lines)
- **Migrated consumers:**
  1. `memory-core/src/embed.ts` → embedding-provider (manages worker lifecycle)
  2. `claim-verification/src/worker.ts` → WorkerProxy to embedWorker.ts
  3. `hybrid-search/src/cross-encoder.ts` → references shared worker protocol
- **Verification:** `rg -l "worker" libs/data/ libs/memory-core/` confirms only one
  worker implementation + consumers remain

---

## Issues discovered

None. All tests pass, lint is clean, builds succeed. No new backlog entries needed.

---

## Handoff to RS-3

RS-3 depends on:
- RS-0 baselines (captured in `_shared/baselines/`)
- RS-1 provider contract (`embedding-provider` exports, `health()` interface)
- RS-2 shared worker infrastructure

The enrichment-parity snapshot sha256 (`10ded6fe`) is the anchor for RS-3's
pre/post migration comparison. The `enrich.ts`, `neardup.ts`, `cluster.ts`,
`autolink.ts`, `importance.ts` files already have partial modifications (imports
for provider integration) that RS-3 must build upon when migrating the enrich
hot path to `GraphBackend`/`VectorBackend`.
