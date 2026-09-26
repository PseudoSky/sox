---
'@adhd/sox-memory-core': patch
'@adhd/sox-extension-memory-server': patch
---

`memory_recall`'s query-embed budget is now cold-start aware. With the embedding
funnel's host exiting after 60 s idle, the first recall after any idle period
paid a host respawn + model load against a flat 3 s budget, always timed out,
opened the vec breaker and served BM25-only. A cold path (no successful embed
yet in this process, or none within `EMBED_HOST_IDLE_EXIT_MS`) now gets
`RECALL_EMBED_TIMEOUT_COLD_MS` (12 s, from embed-host telemetry: cold p95 3.4 s /
max 12.2 s host-side plus spawn); a warm recall keeps the 3 s read budget. The
explicit `SOX_RECALL_EMBED_TIMEOUT_MS` override still governs both. New exports:
`recallEmbedTimeoutMsFor`, `getLastEmbedSuccessAtMs`. (819a416b)
