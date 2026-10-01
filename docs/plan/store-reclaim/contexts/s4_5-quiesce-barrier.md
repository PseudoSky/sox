# s4_5-quiesce-barrier — write-quiesce barrier (memory, optional zero-downtime)

**Phase:** trigger · **Deps:** s4 · **Tier:** hard · **Est:** ~180 R / ~450 W
**⛔ GATED BY Q6** (service-lifecycle owner sign-off: must not violate `[contract:signal]` /
`SHUTDOWN_SAFETY_NET_MS=4000`, `backend.ts:156`). If refused, this segment is **retired** and s4's
identity-guarded retry mode stands.

## Goal

Give memory-server a typed `quiesceForSwap()` on the WriteQueue so the S4 swap can run with writers paused
but the **process alive** — a millisecond pause, not a restart (DESIGN §5.5.1).

## File ownership

- **mutates:** `libs/memory-core/src/write-queue.ts` (add `quiesceForSwap()`), `.../memory-server/src/index.ts`
- **creates:** `libs/memory-core/src/write-queue.quiesce.bl-<newid>.spec.ts`
- **read_only:** `shutdown-margin.ts`, `backend.ts`

## Contract

`WriteQueue.quiesceForSwap(): Promise<() => void>` — stop admitting writes → drain → checkpoint WAL →
hold; the returned release resumes admission. Typed, explicit, surfaced in health (ADR-0013 D2/D4). One-shot
operator semantics only; never env-gated.

## Acceptance criteria

1. A concurrent write during the barrier **blocks** (not fails) and completes on release; no write lost.
2. The swap runs inside the barrier and succeeds with the process alive (no restart, no new pid).
3. SIGTERM during a held barrier still drains within the `stop_timeout_ms` budget (Q6 check).
4. `npx nx test memory-core memory-server` green in an isolated worktree.

## Commit points

- After both specs pass: commit `write-queue.ts` + `index.ts` + spec by **explicit pathspec**.

## Notes

- This barrier is the reason the live build stays useful on a busy store. Absent it, S4 pays the
  identity-guarded retry (rebuild at the next quiesced window).
