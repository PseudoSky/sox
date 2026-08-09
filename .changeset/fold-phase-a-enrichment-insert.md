---
"@adhd/sox-memory-core": minor
---

Fold Phase-A enrichment into the INSERT, eliminating a redundant FTS-index rewrite (PERF-MEMORY-003).

Before this change `memoryWritePhaseA` INSERTed the node row and then issued a SECOND UPDATE over the
same row to store enrichment columns (topic, project_path, summary, tags, importance, enrich_ver).
Because `summary` and `tags` are covered by `idx_fts_node` — a native Turso FTS index maintained inside
the statement itself, not a trigger — that second write redid FTS maintenance the INSERT had already
completed, costing ~134ms (~56% of Phase A). The enrichment computation itself is pure (~3.7ms) and
reorders freely, so the fold is safe.

- `memoryWritePhaseA` now runs `computeWriteEnrichment()` BEFORE the INSERT and folds its values
  directly into the column list, going from 4→3 SQL calls and 2→1 transactions per write.
- `computeWriteEnrichment()` (new export) is the pure, zero-DB resolver for E1/E2/E4/E5/E7/E10/E12.
  It is the SINGLE SOURCE OF TRUTH: `enrichOnWrite` delegates to it too, so the folded-INSERT path
  and the legacy UPDATE path cannot drift apart.
- `detectAndApplyNearDup()` (new export) is E8 near-dup detection + SAME_AS edge persistence, split
  out of `enrichOnWrite` so the folded-INSERT path can run it post-insert without also paying for the
  now-redundant column UPDATE.
- Measured −50.1% Phase-A wall on a store copy (241ms→120ms p50).
