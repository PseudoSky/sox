---
"@adhd/sox-store-adapter": patch
---

Re-measure the FTS optimize-leak gate on the unified Turso engine (`@tursodatabase/database` 0.8.2: interleaved 266 vs single 266 pages, leak does not reproduce) and bump `FTS_OPTIMIZE_LEAK_MEASURED_ON` to `0.8.2`. The workspace now resolves one engine version (0.8.2) for every store-adapter consumer (adhd backlog 4b7fd623).
