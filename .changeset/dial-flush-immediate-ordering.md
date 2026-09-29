---
'@adhd/sox-service-proxy': patch
---

Fix an infinite-hang defect in the outbound dial queue and the ordering hazard
introduced while fixing it (BL-6b4ff2b8).

`dial.ts`'s drain loop checked `socket.writable` only once per invocation; that
flag flips synchronously on `socket.destroy()`, before the async `'close'`
event, so a socket destroyed mid-drain left the loop spinning the CPU forever
against a queue it could never empty. The queue itself is now a two-stack
`Deque<T>` (O(1) amortized push/shift, replacing the O(N²) array-splice queue),
drained in `maxItemsPerTick`-sized chunks (default 100) with a `setImmediate`
yield between chunks, and the writable check is re-evaluated on every loop
iteration and every reschedule guard.

Chunked draining opened a narrow send-during-yield-window: a `send()` call
landing between chunks could take the fast path and write directly to the
socket, overtaking messages still waiting in the queue from an earlier chunk.
Closed by a `flushImmediate` in-flight-drain flag: `send()`'s fast path is now
`socket && socket.writable && !flushImmediate` — while a drain is between
chunks, every `send()` queues behind it instead of racing it.

Tests (red→green, each naming BL-6b4ff2b8): `dial-flush-writable-check.bl-6b4ff2b8.spec.ts`,
`dial-flush-yields.bl-6b4ff2b8.spec.ts`, `dial-flush-ordering.bl-6b4ff2b8.spec.ts`.
