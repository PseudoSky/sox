---
'@adhd/sox-memory-core': patch
'@adhd/sox-extension-memory-server': patch
---

Fixes `memory_recall`'s `score_breakdown` fabricating a non-zero contribution
for a channel (vec/bm25/temporal) that never actually contributed to a
result. `minMaxNorm()`'s degenerate-range branch collapsed ANY constant
per-channel array to `1.0`, including an all-zero array (the vec channel
skipped for the whole recall — embed timeout/circuit breaker open — or a
single candidate that never matched a given channel). It now distinguishes a
genuine non-zero tie (still collapses to `1.0`) from a channel that
contributed nothing (`0`), so `score_breakdown[channel] === 0` whenever that
channel is absent from `provenance`. Ranking (`score`, sort order) is
unchanged — it is driven by raw RRF magnitudes, never by the normalised
breakdown values. (f2237d6d)
