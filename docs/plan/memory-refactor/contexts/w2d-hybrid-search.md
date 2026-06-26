# w2d-hybrid-search — Extract data/search/hybrid-search

> **Slug is identity.** `w2d-hybrid-search` is immutable.

**Phase:** extraction · **Depends on:** `w2c-vector-store` · **Guard:** `nx build hybrid-search && nx test hybrid-search`
**Parallel with:** `w2d-ingest`, `w2d-analysis`.

---

## Goal

Extract the vec+BM25+temporal-decay fusion ranker into `@adhd/sox-hybrid-search`
([def:data-package], data/search) — generic IR, no domain coupling. This is its design
spec, richer than "the recall ranker": it honors the SCOPE Part D research findings and
**must [def:degrade-to-bm25]** when vectors are unavailable.

---

## Semantic Distillation

- **Primitive:** EXTRACT the fusion ranker from `recall.ts`; leave federation/registry in
  the composer.
- **Reference Pattern:** `libs/memory-core/src/recall.ts` (`memoryRecall` — the
  vec+BM25+temporal fusion; `SCOPE_WEIGHTS`; the FTS query path). `federatedRecall`,
  `getFederationConnection`, `discoverStores`, `readRegistry`/`writeRegistry` are DOMAIN
  concerns (multi-store federation) — they stay in the composer, NOT here.
- **Delta Spec (honor SCOPE Part D):**
  - **Normalize before combining** — min_max / L2 / z_score selectable; never combine raw
    scores of different scales.
  - **Multiplicative** field boosting (never additive): defaults topic 2.0 / tags 1.5 /
    name 1.2 / summary 1.0 / content 1.0.
  - **FTS5 `bm25(col_weights)`** with a rank config — collapse N per-field BM25 queries to
    1; two-phase FTS5→exact-rescore to avoid O(rows×batch×fields) scans; RRF / max-score
    normalization to avoid full-scan stats.
  - **Opt-in `explain`** only (per-field breakdown OFF by default).
  - **Implicit topic boost** — score query vs topic names, lift matching topics (Weaviate
    named-vector pattern).
  - **[def:degrade-to-bm25]** — when vectors are unavailable/empty, return a BM25/FTS-only
    ranked result (still functional). This is the read-path survivability rule and is a
    hard acceptance.
  - **(experimental)** cross-query dedup via a `matched_queries` count — mark experimental
    (no production system does this; it is a differentiator, not a guarantee).
  - `hybrid-search` imports `@adhd/sox-vector-store` (knn) + `@adhd/sox-graph-store` (FTS);
    both data→data.
- **Invariants added:** [inv:degrade] ([def:degrade-to-bm25]), [inv:nx-targets],
  [inv:name-decoupled], [inv:boundary].
- **Validation:** `nx test hybrid-search` — normalization, multiplicative boost, degrade-
  to-BM25 with vectors off, opt-in explain shape.

---

## Acceptance criteria

Checked by `audit-extraction`.

- [ ] **[w2d-hs.1]** `@adhd/sox-hybrid-search` builds; exports the ranker
      (`search`/`hybridRecall`) from `dist/index.js`.
- [ ] **[w2d-hs.2]** Normalize-before-combine: scores from different fields are normalized
      before fusion (a scale-mismatch fixture ranks correctly). (vitest.)
- [ ] **[w2d-hs.3]** Multiplicative field boosting (topic 2.0 etc.) — a topic-matching
      doc outranks an otherwise-equal non-topic doc by the boost factor, not an additive
      offset. (vitest.)
- [ ] **[w2d-hs.4]** [def:degrade-to-bm25]: with vectors unavailable, `search` still
      returns a BM25/FTS-ranked, non-empty result for a matching query. [inv:degrade] (vitest.)
- [ ] **[w2d-hs.5]** `explain` is OFF by default; opt-in returns per-field breakdown. (vitest.)
- [ ] **[w2d-hs.6]** `bm25(col_weights)` is used (single ranked FTS query, not N per-field
      queries). (code inspection + vitest.)
- [ ] **[w2d-hs.7]** Federation helpers are NOT in this package (they stay in the
      composer). [inv:boundary]

---

## Reservations

```text
read_only:  ["libs/memory-core/src/recall.ts"]
mutates:    ["libs/data/search/hybrid-search/src/**"]
```

---

## Notes for executor

- The line is **ranking vs federation**: single-store fusion ranking is hybrid-search;
  cross-store federation + the store registry is the domain composer's. Don't drag
  `discoverStores`/`getFederationConnection` in here.
- [def:degrade-to-bm25] is the most-likely-missed acceptance — write that test first.
- Phase-0 scale only (SCOPE Part D): pure-JS FTS5 + sqlite-vec, <50K. Leave seams for
  usearch/simsimd (Phase 1+), build none of it.
- **Packaging (ADR-0006, revised 2026-06-26): hybrid-search is PUBLIC; `graph-store` + `vector-store`
  are now also PUBLIC.** So this package **depends on `@adhd/sox-graph-store` + `@adhd/sox-vector-store`
  as normal public deps — it does NOT bundle them** (the earlier bundle-the-private-store plan is moot now
  they're public). Externalize native deps; ship a bundled `.d.ts`. Take the live `Database` **via DI**
  (composer-owned, decision C) — unchanged. `check-publishable`: the `@adhd` deps it declares must all be
  PUBLIC (no private `@adhd` runtime dep).
- Budget: 1-2 sessions.
