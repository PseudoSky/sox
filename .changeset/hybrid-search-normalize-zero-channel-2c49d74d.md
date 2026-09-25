---
'@adhd/sox-hybrid-search': minor
'@adhd/sox-memory-core': patch
'@adhd/sox-extension-memory-server': patch
---

**Behaviour change (ranking).** `normalize(scores, 'min_max')` no longer maps a
channel whose every value is `0` to `1.0`. A degenerate (constant) channel now
normalises to `0` when that constant is `0` (the channel supplied no signal) and
to `1.0` only for a genuine non-zero tie — the same rule memory-core adopted in
f2237d6d. `fuse()`, `fuseWithBreakdown()` and `search()` inherit it: e.g.
`A{text 0.2, vec 0}` no longer ties a real winner via a fabricated full-weight
vec contribution. `TOPIC_BOOST_FLOOR` keeps its intended behaviour — an all-zero
result set floors uniformly and is still reordered by topic. (2c49d74d)
