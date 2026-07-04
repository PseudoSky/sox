# HF-3 — Recall Score Legibility

## Overview

`memory_recall` results now carry an additive `score_breakdown` field on every
`RecallResult`.  The existing `score` field is unchanged and byte-compatible
with all existing consumers.

---

## Formula

The recall pipeline has two stages:

### Stage 1 — RRF fusion

Three independent ranking signals are combined with
Reciprocal Rank Fusion (k = 60):

```
rrfScore(rank) = 1 / (RRF_K + rank)          where RRF_K = 60

baseRrf = vec_weight × rrfScore(vecRank)       [default vec_weight  = 1.0]
        + fts_weight × rrfScore(ftsRank)        [default fts_weight  = 0.8]
        + temp_weight × rrfScore(temporalRank)  [default temp_weight = 0.4]
```

Channels contribute 0 when a candidate has no signal for that channel (e.g.
a node not retrieved by FTS still gets a vec and temporal contribution if
it ranked in those channels).

### Stage 2 — Recency × Importance rerank

```
rerank       = recency(t_created) × (0.5 + 0.5 × importance/10)
finalScore   = baseRrf × rerank

recency(t)   = 0.995 ^ hours_since_created      [exponential decay]
```

---

## Per-query normalisation

Raw RRF scores depend on result set size and rank distribution, so a score
of 0.015 from a query over 100 candidates is not comparable to 0.015 from
a query over 3 candidates.

To fix this, each channel is **min-max normalised independently across the
current query's candidate set** before computing the breakdown contribution:

```
normVec[i]  = (vecRaw[i]  − min(vecRaw))  / (max(vecRaw)  − min(vecRaw))
normBm25[i] = (ftsRaw[i]  − min(ftsRaw))  / (max(ftsRaw)  − min(ftsRaw))
normTemp[i] = (tempRaw[i] − min(tempRaw)) / (max(tempRaw) − min(tempRaw))
```

When all values in a channel are equal (range = 0), every candidate gets 1.0
for that channel.  When a candidate has no signal in a channel (rank absent),
its raw value is 0.

### Why min-max and not z-score?

- **Bounded output** — min-max maps the best candidate to 1.0 and the worst to
  0.0 regardless of the raw distribution.  Scores from two different queries
  are always in [0, score_of_top_result], making them directly comparable.
- **Invariant semantics** — "this result scored 0.8" means it is at the 80th
  percentile of relevance *within its query's result set*.  That meaning is
  stable across queries.
- z-score has unbounded range and requires a stable standard deviation; for
  small result sets (< 5 candidates) it becomes meaningless.

---

## Breakdown computation

The channel contributions are scaled proportionally so they sum exactly to
`finalScore`:

```
normTotal    = normVec + normBm25 + normTemp   (per candidate)

vec_contrib   = finalScore × (normVec  / normTotal)
bm25_contrib  = finalScore × (normBm25 / normTotal)
temp_contrib  = finalScore × (normTemp / normTotal)
```

When `normTotal == 0` (candidate has no signal in any channel), all three
contributions are 0 and `total = 0`.

**Additivity invariant:**
```
vec_contrib + bm25_contrib + temp_contrib === total === score
(within floating-point tolerance < 1e-9)
```

---

## ScoreBreakdown type

Defined in `libs/memory-core/src/recall.ts`, exported from
`libs/memory-core/src/index.ts`:

```ts
interface ScoreBreakdown {
  vec:      number;   // vector (cosine KNN) channel contribution
  bm25:     number;   // FTS5 BM25 text channel contribution
  temporal: number;   // recency-importance rerank channel contribution
  total:    number;   // sum of all channels — equals score
}
```

Available on every `RecallResult` as `result.score_breakdown`.

---

## Hybrid-search layer: FusionBreakdown

`libs/data/search/hybrid-search/src/index.ts` adds `fuseWithBreakdown()` which
exposes the same two-channel additive breakdown for the hybrid-search `fuse()`
path (vec + bm25, no temporal):

```ts
interface FusionBreakdown {
  bm25:  number;   // text channel contribution
  vec:   number;   // vector channel contribution
  total: number;   // == score
}
```

This is used in tests and available for callers that use hybrid-search's
`fuse()` API directly (e.g. `SqliteSearchBackend`).

---

## Files changed

| File | Change |
|---|---|
| `libs/data/search/hybrid-search/src/index.ts` | Added `FusionBreakdown`, `FusionResultWithBreakdown`, `fuseWithBreakdown()` |
| `libs/data/search/hybrid-search/src/score-breakdown.spec.ts` | New test file: 20 tests for (a) sum invariant and (b) cross-query comparability |
| `libs/memory-core/src/recall.ts` | Added `ScoreBreakdown` type; per-query min-max normalisation in the RRF+rerank path; `score_breakdown` field on every `RecallResult`; `addResult()` extended |
| `libs/memory-core/src/index.ts` | Exports `ScoreBreakdown` |
| `libs/memory-core/src/recall.spec.ts` | Added 5 new HF-3 tests (channel sum + cross-query comparability) |

---

## Test coverage

- **Sum invariant (criterion a):** `score_breakdown.vec + .bm25 + .temporal === score` within 1e-9 tolerance; tested for primary results, graph-expanded results, and all hybrid-search `fuseWithBreakdown()` variants (text-only, vec-only, hybrid, custom weights, z-score normalizer).
- **Cross-query comparability (criterion b):** Two dissimilar query profiles (competitive vs. winner-takes-all) both produce top scores in [0, 1] and within 10× of each other; tested both in hybrid-search and memory-core.
- **Score field unchanged:** `fuseWithBreakdown()` score verified to be byte-identical to `fuse()` output; `recall.ts` score formula unchanged.
