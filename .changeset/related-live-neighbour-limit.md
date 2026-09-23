---
'@adhd/sox-memory-core': patch
---

Fix `memoryGetRelated` letting invalidated neighbours consume `limit` slots, returning short lists.

Out-edges and in-edges were each `.slice(0, limit)`-ed from the raw `getEdges()`
result, and `t_invalid IS NULL` was applied to the neighbour *nodes* only
afterward. The defect was the ORDER of those operations, not their absence —
edge-level validity was always applied (`getEdges` prepends it) and node-level
validity was applied too, just after the truncation. An invalidated neighbour
falling inside the limit window therefore consumed a slot and was then dropped,
so callers silently received fewer than `limit` neighbours while live ones that
would have filled those slots sat just past the cut. This is the same pathology
fixed in `memoryGetEntityEpisodes`.

The two slices are replaced by one bidirectional `UNION ALL` — out-edges keyed
on `e.src`, in-edges on `e.dst` — filtering `e.t_invalid IS NULL AND
n.t_invalid IS NULL` in the same statement that binds `LIMIT`.

Observable contract changes for callers of `memory_related`:

- **`edges`** is now short only when the neighbourhood is genuinely exhausted.
- **`invalidated_count`** is a new additive response field: live edges (both
  directions, after the `rel` filter) whose neighbour node has been
  invalidated. Deliberately NOT bounded by `limit` and not a paging denominator
  — this function has no `total` and no `offset` — so it is a neighbourhood
  diagnostic only. Declared OPTIONAL on the exported `RelatedResult`, matching
  `EntityEpisodesResult`: the type is re-exported from the package root, and a
  REQUIRED property would break any external site constructing the literal, so
  it would not qualify for PUBLISHING.md's patch-for-additive-API exception on
  a patch bump. Always populated in practice, including on `E_NOT_FOUND`.
- **Ordering** is now explicitly `outbound-then-inbound, edge-creation order`
  rather than whatever an unordered `SELECT * FROM edge` happened to yield. No
  importance ranking is imposed: unlike `memory_entity_episodes`, this tool
  documents no ranking contract, so adding one would be an unrequested change.
- `limit` is coerced and clamped before binding: a non-integer no longer throws
  a SQLite datatype mismatch, and `limit: -1` no longer reaches SQL as
  `LIMIT -1` ("no limit"), which would have returned the entire neighbourhood.

`UNION ALL` (not `UNION`) and the absence of any `n.kind` predicate are both
deliberate preservations of existing behaviour: a reciprocal A→B/B→A pair is
two entries, and a `MENTIONS` edge to an entity node is still returned.
