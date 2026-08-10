---
"@adhd/sox-graph-store": patch
---

Fix `getSupersessionChain` iterative head-selection divergence on multi-root components (reviewer finding, 0.8.1 patch).

The recursive `head` CTE is `LIMIT 1` over the connected scan, which SQLite produces in BFS discovery order from the seed — the FIRST no-outbound node in that order. The iterative fallback selected the LOWEST-ROWID no-outbound node instead. On a component with two roots — chain v1←v2←v3 plus `writeEdge(v2, v9, 'SUPERSEDES')` — `getSupersessionChain(v9)` returned `[v1, v2, v3]` on the iterative path (Turso Database Rust < 0.8.0, `capabilities.recursiveCte: false`) versus `[v9, v2, v3]` on the recursive SQL path.

- `getSupersessionChainIterative` now discovers `connected` FIFO (BFS), expanding the incoming arm (`e.dst = current`) before the outgoing arm (`e.src = current`) to mirror the CTE's two UNION arms, and selects the head as the first no-outbound node in that discovery order (Set insertion order) instead of rowid-sorting.
- New two-root parity test (v9 case) on both real paths (sqlite recursive SQL + turso iterative fallback) and a forced-fallback variant on sqlite — asserting the same set AND order (`[v9, v2, v3]`) on both paths. Red→green proven: both iterative tests failed with `[v1, v2, v3]` before the fix and pass after.
- The now-refuted "SQLite scans connected in rowid order" comment (and the stale `lowest-rowid` test name) updated to describe BFS-scan-order semantics.
