# w2d-ingest — Extract data/ingest/ingest

> **Slug is identity.** `w2d-ingest` is immutable.

**Phase:** extraction · **Depends on:** `w2b-graph-store` · **Guard:** `nx build ingest && nx test ingest`
**Parallel with:** `w2d-analysis`, `w2d-hybrid-search`.

---

## Goal

Extract the **write-path single-item transforms** into `@adhd/sox-ingest`
([def:data-package], data/ingest): content-hash, extractive summary, deterministic
tagging/topic (and the future chunk/normalize/redact seam). Deterministic, zero-LLM,
byte-reproducible. Depends only on graph types, so it runs in parallel with the
vector-dependent w2d states.

---

## Semantic Distillation

- **Primitive:** EXTRACT the per-item transforms from `memory-enrich`'s write-path.
- **Reference Pattern:** `libs/memory-enrich/src/extractive.ts` (extractive summary),
  the deterministic tagging/topic + content-hash portions of
  `libs/memory-enrich/src/enrich.ts` (`enrichOnWrite`). The CROSS-item batch pass
  (`batch.ts`/`runBatchEnrich`) does NOT come here — it goes to `w2d-analysis`.
- **Delta Spec:**
  - `contentHash(content)` — the deterministic dedup hash used at write time.
  - `extractiveSummary(text, opts?)` — moved from `extractive.ts`.
  - `deterministicTags(content)` / `deriveTopic(...)` — the zero-LLM tagging/topic logic
    extracted from the write-path of `enrich.ts`.
  - A `chunk/normalize/redact` seam (interface stubs only — future, per the scaffold
    invariant "future chunk/normalize"); do not implement chunking now.
  - No vector or cluster dependency; `ingest` imports at most graph types / shared.
- **Invariants added:** byte-reproducible determinism, [inv:nx-targets],
  [inv:name-decoupled], [inv:boundary].
- **Validation:** `nx test ingest` — same input → identical hash/summary/tags across runs.

---

## Acceptance criteria

Checked by `audit-extraction`.

- [ ] **[w2d-ingest.1]** `@adhd/sox-ingest` builds; exports `contentHash`,
      `extractiveSummary`, the deterministic tagging/topic functions from `dist/index.js`.
- [ ] **[w2d-ingest.2]** Determinism: identical input yields byte-identical
      hash/summary/tags across two runs. (vitest.)
- [ ] **[w2d-ingest.3]** `ingest` imports neither `@adhd/sox-vector-store` nor
      `@adhd/sox-analysis` (write-path only). [inv:boundary]
- [ ] **[w2d-ingest.4]** Extractive summary parity with the legacy `extractive.ts` on a
      fixture set. (vitest snapshot.)

---

## Reservations

```text
read_only:  ["libs/memory-enrich/src/extractive.ts", "libs/memory-enrich/src/enrich.ts"]
mutates:    ["libs/data/ingest/ingest/src/**"]
```

---

## Notes for executor

- The split line between `ingest` and `analysis` is **per-item vs corpus**: anything that
  needs only THIS item is ingest; anything that needs OTHER items (cluster, near-dup,
  importance link-score, auto-link) is analysis.
- `enrichOnWrite` as an orchestrator stays in the composer (`w2e`); it will call
  `ingest.*` + `analysis.*`. This state extracts the leaf transforms, not the orchestrator.
- Budget: 1 session.
