# Turso driver off-thread probes — preserved evidence

Scratch reproduction scripts written by the `architect` (opus) agent and its
delegated `researcher` while producing the implementation spec for moving the
Turso native driver off the memory-server main thread (backlog item
`862129b5`, plan filed 2026-09-29). These are the actual measurements the
spec's "one process-wide driver-worker thread" design decision rests on —
preserved here because they originally lived in a session-scoped scratchpad
(`/private/tmp/claude-*/.../scratchpad/`) that does not survive past the
session that created it.

**Not wired into any build/test target.** Run manually with plain `node` (they
import the Turso driver directly by its `node_modules/.pnpm/...` path, which
is fragile — expect to fix that path if you actually re-run one of these).

## `probe.mjs` — no yield point exists

Hooks `db.io()` (the driver's internal yield point) and counts calls during
200 FTS writes. **Measured: 0 `io()` calls.** This is the evidence that
"yield between steps" (an alternative the spec rejected) has nothing to hook
into on the 0.7.x driver — `ioStep` is a no-op on Node.

## `lag.mjs` — chains of writes block the main thread, not just slow steps

Runs 300 sequential `INSERT`s against an FTS-indexed table, on the main
thread. Paired with a live event-loop-delay check (see the spec's own
measurement: over 300 separately-awaited inline writes, the main loop turned
**once in 4.2s**; with the same driver moved into a `worker_thread` it turned
**262 times**, longest gap 12ms). This is the core "the current design blocks
the event loop" reproduction.

## `rt.mjs` — round-trip cost of a worker-hosted driver call

Measures `parentPort` message round-trip latency for increasingly large
payloads (a bare `SELECT 1`, a row with a 1.5KB blob, 100 rows). Feeds the
spec's measured-facts table (12–48µs small request, 67µs/100 rows, worker
boot ~22.5ms paid once per process) — the basis for concluding the RPC
overhead of a driver-worker seam is negligible relative to the stalls it
fixes.

## `exitprobe.mjs` — exit waits for the current native step

Parks a worker mid-way through a long native operation (deliberately grown to
~8s+ via repeated `INSERT ... SELECT` doubling), then measures how long
`worker.terminate()`/`process.exit()` take to actually resolve while that step
is in flight. This is the evidence behind the spec's requirement that every
force-exit path needs a SIGKILL fallback — a graceful exit is bounded by
whatever native step happens to be running (observed up to 21 minutes for a
large `integrity_check`).

## `researcher-exp/` — the delegated researcher's fuller experiment set

`e1.mjs`–`e7p.mjs`: a broader, incremental probe sequence (own `package.json`,
dependencies not vendored here — reinstall before running) exploring driver
thread-safety, `DATABASE_MANAGER` sharing behavior, and worker-thread
viability, culminating in the confirmation that upstream's core
`Database`/`Connection` is not fully thread-safe and shares one core
`Database` per `(dev, ino)` across threads in a process (`lib.rs:106-107`,
`core/lib.rs@v0.7.2:560-587`) — the finding that ruled out "one worker per
connection" and forced the "one worker per PROCESS" design actually chosen.
