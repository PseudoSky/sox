# WriteQueue metrics → memory_ping integration (ready-to-apply)

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

Snapshot shape:

```jsonc
{
  "queue_depth": 0,                 // pending items (excludes in-flight)
  "in_flight": 0,                   // 1 while a task is executing
  "queue_max_size": 100,            // hard size cap
  "queue_high_watermark": 7,        // peak pending depth this process
  "saturated": false,               // hysteresis latch (warn 75% / clear 40%)
  "write_latency_ms": { "p50": 42, "p99": 480, "mean": 61.2, "max": 512 },
  "recent_avg_task_latency_ms": 55, // admission-control estimator input
  "deadline_budget_ms": 20000,      // SOX_WRITEQ_DEADLINE_MS (default 20000)
  "deadline_guard_enabled": true,   // false when SOX_WRITEQ_NO_DEADLINE=1
  "counters": {                     // monotonic per-process
    "tasks_completed": 0,
    "rejections_busy_size": 0,
    "rejections_busy_deadline": 0,
    "slow_tasks": 0
  }
}
```

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
