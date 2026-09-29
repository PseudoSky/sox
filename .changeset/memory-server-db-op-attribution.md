---
'@adhd/sox-extension-memory-server': patch
---

Nests DB-operation-level main-thread-stall attribution inside the existing tool-level attribution.
Wires `@adhd/sox-memory-core`'s new `setDbOpHooks()` to `mainThreadMonitor`'s new `pushOp`/`popOp`
pair, so a live `mainthread.stalled` event names the specific in-flight DB operation
(`executeRun`, `transaction`, `idle_flush`, …) nested inside the MCP tool that dispatched it,
rather than only the tool name.

`mainThreadMonitor` gained a LIFO label stack: `setOp`/`clearOp` (the existing tool-dispatch call
sites — unchanged) always reset the whole stack to a single tool-level frame; the new
`pushOp`/`popOp` nest and unwind a more specific label on top without clobbering it. Before this,
wiring a DB-level hook straight to `clearOp()` — the literal, naively-obvious wiring — would have
erased the tool-level label the instant the first query inside a tool call finished, well before
the tool itself returned; `pushOp`/`popOp` avoid that regression entirely.

Registered once at startup (`setDbOpHooks({ onOpStart: (label) => mainThreadMonitor.pushOp(label),
onOpEnd: () => mainThreadMonitor.popOp() })`, arrow-wrapped since `pushOp`/`popOp` are declared
with method syntax), right after `mainThreadMonitor.start()` and before the first store open.
