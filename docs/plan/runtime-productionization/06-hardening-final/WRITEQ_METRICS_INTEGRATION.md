# WriteQueue metrics → memory_ping integration (completed handoff, 2026-07-04)

> ## ⚠️ HISTORICAL HANDOFF — APPLIED. NOT A CURRENT REFERENCE.
>
> **Written 2026-07-04; its patch landed long ago.** This file is retained as the record of that
> handoff, not as a description of the surface today. It is *not* "ready-to-apply" and has not
> been since. Since it was written, `WriteQueueMetrics` changed at least three times (BL-394,
> BL-445, and the throughput field), and PKT-64/PKT-65 both reshaped this surface without
> updating this document — which is how it came to publish, as unconditional current fact, the
> exact claim BL-394 was opened to remove (BL-458).
>
> **Source of truth for the metrics shape is the type:**
> `libs/memory-core/src/write-queue.ts` → `export interface WriteQueueMetrics`.
> For the live values, call `memory_ping`. Do not quote the shape from this file.

> Produced by the write-path observability worktree agent (2026-07-04 saturation
> incident). The worktree fence forbade editing
> `extensions/bundles/sox-memory-bundle/members/memory-server/**`, so this file
> carries the exact integration patch for the INTEGRATOR to apply at merge —
> after the concurrent live-incident agent finishes its work in
> `memory-server/src/index.ts`.

## What memory-core now provides (already merged with this branch)

`libs/memory-core/src/write-queue.ts` exports:

- `WriteQueue.metricsForPath(dbPath): WriteQueueMetrics | null` — static, pure,
  read-only snapshot for the queue keyed by the resolved store path. Returns
  `null` when no queue instance exists yet (no write has gone through this
  process for that store). Zero side effects — safe in a ping handler.
- `queue.getMetrics(): WriteQueueMetrics` — instance form.
- `WriteQueueMetrics` type (exported from `@adhd/sox-memory-core`).

**Snapshot shape: read it from the type, not from here.** The literal that used to sit in this
spot is deleted rather than updated (BL-458). It published `"queue_max_size": 100` and
`"deadline_guard_enabled": true` as unconditional — exactly the claim BL-394 was filed against
and its fix (`59ced94`) removed — and it predated three further changes to the type. A published
literal of a shape that keeps moving is a standing staleness generator; the only durable citation
is the declaration itself:

**`libs/memory-core/src/write-queue.ts` → `export interface WriteQueueMetrics`.** Every field
carries a doc comment naming the backlog item that shaped it. Two of them must be read *before*
any other field is interpreted:

- **`mode: 'fifo' | 'bypass'`** (BL-445) — which execution path produced the snapshot. On
  `'bypass'` (Turso, or `SOX_DISABLE_WRITE_QUEUE=1`) **there is no queue**, and every
  queue-shaped field is `null` rather than a zero indistinguishable from a healthy idle queue.
- **`admission_control: 'active' | 'inactive — adapter handles concurrency natively'`** (BL-394)
  — whether the size cap and deadline guard can fire *at all*. On the bypass path neither is
  reachable, so `counters.rejections_busy_*` reading `0` is evidence the incrementing code
  cannot run, not evidence of a healthy queue.

Consequently `queue_depth`, `queue_max_size`, `queue_high_watermark`, `saturated` and
`deadline_budget_ms` are all `number | null` / `boolean | null`, and `deadline_guard_enabled` is
`false` on the bypass path regardless of `SOX_WRITEQ_NO_DEADLINE`. `throughput_writes_per_sec`
(write tasks completed in the last rolling 60s) also post-dates this document.

## The patch (memory-server `src/index.ts`, `memory_ping` handler)

`WriteQueue` is ALREADY imported from `@adhd/sox-memory-core` at the top of
`index.ts` — no import change needed.

In the `memory_ping` store block (the `storeBlock = { ... }` literal, currently
ending with `enrichment: enrichmentHealth,`), add ONE field:

```ts
        storeBlock = {
          name: storeName,
          path: resolvedPath,
          fingerprint: `sha256:${sha256Fingerprint}`,
          wal_bytes: walBytes,
          last_checkpoint_at: null,
          enrichment_watermark: enrichmentWatermark,
          queue_depth: queueDepth,
          // Additive (HF-3 rule): never rename/remove the fields above.
          queue_oldest_pending_at: queueOldestPendingAt,
          queue_last_done_at: queueLastDoneAt,
          enrichment: enrichmentHealth,
          // Write-path observability (2026-07-04 saturation incident):
          // rolling write-latency percentiles, depth/watermark, deadline
          // budget, and rejection counters from the in-process WriteQueue.
          // null until the first write creates the queue for this store.
          write_queue: WriteQueue.metricsForPath(resolvedPath),   // ← ADD
        };
```

That single `write_queue:` line (plus the comment) is the entire patch.
It is ADDITIVE (HF-3 rule — no existing field renamed/removed), and `null`
before the first write, which is honest: no queue instance ⇒ no write-path
activity in this process yet.

### Key-matching note (why `resolvedPath` is correct)

`WriteQueue.instances` is keyed by the exact string passed to
`WriteQueue.forPath(...)`. Every write-path callsite in `handleToolCall` calls
`WriteQueue.forPath(dbPath)` with the same resolved/tilde-expanded path that
the ping handler computes as `resolvedPath` (both flow through
`resolveStoreOrDbPath` → `expandTilde(resolveDbPath(...))`). So the lookup key
matches by construction.

### Optional follow-up (integrator's discretion)

`memory_stats` could carry the same block. `memoryGetStats` (memory-core
`stats.ts`) receives a `db` connection, not the resolved path string, so the
cleanest route is to add `write_queue: WriteQueue.metricsForPath(dbPath)` in
the memory-server `case 'memory_stats':` arm (it has `dbPath` in scope) rather
than plumbing the path into `memoryGetStats`. Not required for the incident
fix — ping is the designated health surface.

## Verification after applying

1. `npx nx build memory-server` (or bundle build sequence) — then the standard
   AGENT SEQUENCE (lint, build, `registry:sync-index`, commit, `upgrade --all`).
2. Live: call `memory_ping` → expect `store.write_queue: null` on a fresh
   process, then a populated block after one `memory_write`, with
   `counters.tasks_completed >= 1`.
3. Saturation logs land in `soxe logs memory-server` (stderr):
   `[memory-core writeq] REJECT E_BUSY(deadline) ...`,
   `[memory-core writeq] SATURATION ...`, `[memory-core writeq] SLOW task ...`.

## Env-var surface (documented here for the runbook)

| Var | Default | Effect |
|---|---|---|
| `SOX_WRITEQ_DEADLINE_MS` | `20000` | Deadline budget for time-based admission control. Read at queue creation. Chosen safely under typical 30–60s MCP client timeouts. |
| `SOX_WRITEQ_NO_DEADLINE` | unset | `=1` disables TIME-based rejection only (kill-switch for debugging). Size cap unaffected. Read per-enqueue. |
