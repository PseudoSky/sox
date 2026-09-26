---
'@adhd/sox-store-adapter': patch
'@adhd/sox-extension-memory-server': patch
---

Turso FTS (Tantivy) index segments are now bounded. Every committed write that
touches an `USING fts`-indexed table adds a segment and nothing merged them, so
insert cost and `fts_match` latency grew linearly with a store's write history
(prod: 5,001 segments, fts_match 601 ms). The turso adapter now runs
`OPTIMIZE INDEX` on every index-method index at its idle point once
`DEFAULT_FTS_OPTIMIZE_WRITE_THRESHOLD` (256) writes have landed since the last
pass — only when the store is quiescent (a live peer lease skips the pass and
keeps the counter), never on a request path. A fresh process runs one catch-up
pass at its first quiescent idle point (a 14 ms no-op on a merged index).
Telemetry: `fts.optimize.start` / `fts.optimize.finish{index, duration_ms}` /
`fts.optimize.skipped{reason, peer_count}` / `fts.optimize.failed`. New typed
test-only connect option `ftsOptimizeWriteThreshold`; new read-only
`ftsMaintenance` getter. (4cd68c4e)
