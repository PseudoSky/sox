---
"@adhd/sox-memory-core": patch
---

`memoryRecall()` no longer pads results with null-content entity/community/session/generic nodes
(BUG-MEMORY-003).

Previously two of the four SQL candidate-admission points had no `node.kind` predicate: the temporal
channel (`recall.ts` §1a) and the depth-1 graph-expansion neighbor fetch (`recall.ts` §1b, which runs
on every default-parameter call since `DEFAULT_DEPTH = 1` and every tagged episode has a live
`MENTIONS` edge to its own tag-created entity nodes). Every live node in the store — not just
episodes — was therefore eligible to be returned, and entity/community/session/generic nodes carry
no readable `content`, so callers silently received `content: null` rows counted against `limit` and
`token_budget`.

`memoryRecall()` now defaults to `kind = 'episode'` at all four candidate-admission SQL statements
(temporal, vec KNN, FTS — both SQLite-shadow-table and Turso branches — and the graph-expansion
neighbor fetch).

Additive: `RecallParams.filters` accepts an optional `kinds: string[]` key (e.g.
`filters: { kinds: ['episode', 'entity'] }`) for callers who explicitly want non-episode nodes back.
Unrecognized kind strings simply match nothing — no validation error, same trust level as `tags`/
`topic`. This is a bug fix, not a new capability being widened — the previous unfiltered behavior was
defective, and the `filters.kinds` opt-in exists to make the fix non-breaking for the (structurally
impossible, since those channels never populated non-episode rows) case of a caller who somehow
depended on it.
