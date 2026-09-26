---
"@adhd/sox-store-adapter": patch
"@adhd/sox-extension-memory-cli": patch
---

fix(store-adapter): the in-service FTS optimize pass no longer merges an unknown backlog at a fresh process's first idle point (4cd68c4e). The write counter starts at 0, so the idle pass only merges steady-state growth. The one-time backlog merge is the new offline entry point `optimizeFtsIndexes(dbPath)`, exposed as `memory fts-optimize --db <path>`. It refuses while any store-lease peer is live and reports duration per index. The idle pass now skips and logs, never runs unchecked, when the adapter holds no lease. It warns `fts.optimize.starved` once when live peers have kept it skipping past 4× the threshold, and backs off exponentially (capped at 1 h) after a failed pass.
