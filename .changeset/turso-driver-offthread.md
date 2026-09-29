---
'@adhd/sox-store-adapter': minor
'@adhd/sox-extension-memory-server': patch
---

Turso's native driver now runs on a process-wide off-thread worker, so a slow driver step no longer
freezes the Node main thread.

`@adhd/sox-store-adapter` — **public-surface change, hence MINOR (on 0.x).** `TursoAdapter.unwrap()`
now returns a `TursoDriverConnection` (the off-thread connection proxy, async methods), **not** the
native `@tursodatabase/database` `Database`. Callers must `await` its `run`/`get`/`all`/`exec`/
`pragma`/`close`. `unwrap()` remains synchronous and still throws `[DEBT-003]` before the first real
operation has opened the connection.

The driver is loaded in exactly one place — the `turso-driver-worker.js` sidecar (a worker realm) — via
a lazy, non-literal import (ADR-0019), so the native chain is absent from every main-thread module
graph. All main-thread driver calls for a process are served FIFO from one worker held in a
`globalThis` slot keyed on `Symbol.for('@adhd/sox-store-adapter/turso-driver-host')`; a copy of the
package speaking a different protocol version throws `E_TURSO_DRIVER_PROTOCOL_MISMATCH` rather than
spawning a second worker. An unexpected worker exit rejects every pending call with
`E_TURSO_DRIVER_WORKER_EXITED` (recognized by `isFatalConnectionError`, so the existing
reconnect path recovers) and the next open spawns a fresh worker. New public read surface:
`TursoAdapter.driverStatus` and the typed `AdapterConfig.driverStallAfterMs` — a synchronous,
zero-worker-touch snapshot that reports a `'stalled'` driver (deadline verdict) without cancelling it
(a native call cannot be aborted).

**Explicit non-guarantees:** this bounds main-thread blocking, not operation latency; one driver
thread per process serializes all ops on that store; same-process writers still pay the full 5s busy
timeout until upstream 0.8's `STEP_SLEEP` lands (BL `809153d1`); and recall reads still queue behind a
store's writes pending a dedicated read connection (BL `56c72ccb`, deferred).

`@adhd/sox-extension-memory-server` — consumes the new surface: a driver-stall watchdog reads
`getTursoDriverStatus()` on an interval and force-exits the process once the oldest in-flight driver op
exceeds its kill threshold, and `memory_ping` reports the driver status. No consumer-visible behavior
change beyond added telemetry.

> Release note: `registry/index.json` is untouched (ADR-0021) — the registry is written by the release
> flow, not by this change.
