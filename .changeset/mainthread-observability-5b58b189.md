---
'@adhd/sox-telemetry': patch
'@adhd/sox-extension-memory-server': patch
---

Main-thread observability for memory-server. Every Turso step runs
synchronously on the Node main thread, so a slow step froze the whole server
with nothing in telemetry (diagnosable only via `sample <pid>`). memory-server
now starts a `MainThreadMonitor` at boot: `mainthread.lag` per interval
(event-loop delay p50/p99/max/mean + CPU% + RSS), `mainthread.blocked{duration_ms}`
after any block ≥ 1 s, and an off-thread worker that writes
`mainthread.stalled{blocked_for_ms}` straight to fd 2 WHILE a stall is still
live. `@adhd/sox-telemetry`'s `metrics.snapshot` now always carries a `process`
block (RSS, heap, CPU user/system ms, uptime) and any registered `sections`
(new `registerSnapshotSection`); memory-server registers `mainthread`. (5b58b189)
