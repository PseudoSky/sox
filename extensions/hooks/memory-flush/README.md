# Memory Session Flush

> Use this when you need session memory durably persisted at conversation end and scope promotions reviewed at policy boundaries.

## Overview

`memory-flush` binds two host lifecycle events and handles each deterministically (zero LLM calls):

**SessionEnd** — when a conversation closes, the hook:
1. Saves the session's working-memory state (upserts a `session` node in the graph store — invalidates the previous entry, inserts a new one).
2. Enqueues any pending episode items into `organizer_queue` so `memoryd` can process them asynchronously.
3. Nudges `memoryd` via its Unix socket doorbell (`~/.memory/memoryd.sock`). If the daemon is not running the nudge is silently discarded — the queue is durable on disk and will be processed at next startup.

**ScopePromotionProposed** — when a tenant proposes promoting memory items from a narrower scope (e.g. `project`) to a wider one (e.g. `user`), the hook runs the configured promotion-approval policy. If approved, it copies the node to the destination scope's DB with a `SAME_AS` edge and marks the promotion `applied`. If rejected or no approver is configured, the row stays `proposed` in the promotion queue.

`order: 100` — fires near the start of the hook chain (ascending order).

## When to use

- Install this hook whenever you install `memory-server` and want session continuity — without it, working memory is lost when the conversation ends.
- Install it when you need scope-promotion approval (e.g. policy-gated promotion from project to org memory).

Do NOT install this hook without `memory-server` — it depends on the graph store schema being present at `db_path`.

## Lifecycle events bound

| Event                      | Behaviour                                                   |
| -------------------------- | ----------------------------------------------------------- |
| `SessionEnd`               | Persist working memory, enqueue episodes, nudge memoryd     |
| `ScopePromotionProposed`   | Run promotion approval policy; copy nodes if approved       |

## Execution order

`order: 100` — ascending; ties broken by id.

## Constraints

- Deterministic: zero LLM calls in both handlers.
- Side effects (DB writes, queue inserts) are scoped to the provided `db_path`.
- Nudge to memoryd is fire-and-forget (non-blocking, errors silently ignored).

## Configuration

The promotion approver is injected via `setPromotionApprover(fn)` from the host or the `memory-cli promote` flow. Without an approver, `ScopePromotionProposed` is logged and deferred.

## Usage

```bash
sox install memory-flush
# or install the full subsystem:
sox install sox-memory-bundle
```

## License

MIT
