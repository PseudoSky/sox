---
'@adhd/sox-memory-core': patch
---

Fix `memoryGetEntityEpisodes` counting invalid episodes in `total` while paginating short pages.

`total` was computed as `edges.length` over the RAW `MENTIONS` edge set with no
validity predicate, and the page was produced by slicing that same raw array
*before* `t_invalid IS NULL` was applied to the episode nodes. Two consequences,
both observed live: `total` overcounted, and pages came back shorter than the
requested `limit` whenever an invalidated episode fell inside the slice
(`total: 3` with 2 episodes; `total: 118` with 99 episodes at an explicit high
limit, so pagination could not explain the gap). Offsets also shifted meaning
between calls as invalidated rows landed in different slices.

`total`, the page, and the new count now read one identical live-filtered
`MENTIONS`→episode join (`e.t_invalid IS NULL AND n.kind = 'episode' AND
n.t_invalid IS NULL`), with `LIMIT`/`OFFSET` bound in SQL rather than applied by
`Array.slice`.

Observable contract changes for callers of `memory_entity_episodes`:

- **`total`** now counts only live episodes, so it matches `episodes.length` on
  an unpaginated call. It previously included invalidated ones.
- **`invalidated_count`** is a new additive response field: live `MENTIONS`
  edges whose episode has been invalidated. Shipping as a patch under
  PUBLISHING.md's patch-for-additive-API exception.
- **Ordering** is now `ORDER BY n.importance DESC, n.rowid ASC`, making the
  tool's documented "ranked by importance" true and pagination stable. Results
  were previously returned in unspecified edge-row order.
- `limit`/`offset` are coerced and clamped before binding: a non-integer or
  out-of-int64-range value no longer throws a SQLite datatype mismatch, and
  `limit: -1` no longer reaches SQL as `LIMIT -1` ("no limit").
