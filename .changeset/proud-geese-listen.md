---
'@adhd/sox-graph-store': minor
---

Add `NodeFilter.isSuperseded`, so a consumer can exclude superseded rows from a read.

`is_superseded` is an axis INDEPENDENT of `t_invalid`. `supersede()` mints a new node, points
a `SUPERSEDES` edge at the old one and sets `is_superseded = 1`, but deliberately leaves
`t_invalid` NULL — so the superseded row is still "live" by `liveOnly`, which was the only
predicate `NodeFilter` could express. A consumer listing current records therefore kept
getting the superseded row back alongside its replacement: one content edit turned one logical
record into two rows carrying the same name, permanently, and every further edit added another.

Filtering those rows out above the store is not an equivalent workaround, which is why the
predicate is pushed down rather than left to callers. `countNodes`/`countNodesFts` are computed
in SQL and never see a caller's post-filter, so the reported total stays inflated regardless;
and keyset paging fetches `limit + 1` and slices, so dropping rows after the fetch yields short
pages and breaks the page-size invariant.

The clause is emitted by the shared `buildNodeFilterClause`, so it applies uniformly to
`queryNodes`, `searchNodes`, `countNodes`, `countBy` and `countNodesFts`. It matches on
`is_superseded IS NOT 1` rather than `= 0`, because the column is nullable in the shipped DDL
and a row written before it existed carries NULL — such a row has not been superseded and must
be kept.

**This is additive and opt-in, exactly as `isStale` is: omit the field and no clause is
emitted, so existing behaviour — including every supersession-chain reader — is unchanged.**
Pass `{ liveOnly: true, isSuperseded: false }` to select only current rows.
