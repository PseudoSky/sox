# s4_5-quiesce-barrier — write-quiesce barrier (memory, optional zero-downtime)

**Phase:** trigger · **Deps:** s4 · **Tier:** hard · **Est:** ~180 R / ~450 W
**Q6 RESOLVED 2026-09-30 — PERMITTED WITH CHANGES** (one-shot architecture ruling). The async,
deadline-bounded, signal-preemptible hold is permitted; the shape below is the only buildable one. The §5.5.2
identity-guarded retry remains the mandatory backstop, and the §5.3 gates / §5.2 fence stay the correctness
boundary.

## Goal

Give memory-server a typed `quiesceForSwap()` on the WriteQueue so the S4 swap can run with writers paused
but the **process alive** — a millisecond pause, not a restart (DESIGN §5.5.1).

## File ownership

- **mutates:** `libs/memory-core/src/write-queue.ts` (add `quiesceForSwap()`), `.../memory-server/src/index.ts`
- **creates:** `libs/memory-core/src/write-queue.quiesce.bl-<newid>.spec.ts`
- **read_only:** `shutdown-margin.ts`, `backend.ts`

## Contract

`WriteQueue.quiesceForSwap(): Promise<() => void>` — gate `enqueue()` **at entry, before the `_bypass ||
_noop` early return** (`write-queue.ts:745`) → stop admitting writes → drain (`_bypassInFlight === 0` **and**
`!_processing && queue.length === 0`) → hold; the returned release resumes admission. No new WAL-checkpoint
mechanism — any flush routes through the adapter's public gated ceremony (DEBT-004 owns checkpointing;
ADR-0012 §1 forbids a raw `PRAGMA wal_checkpoint(TRUNCATE)`). Async, deadline-bounded, cancellable; typed,
explicit, surfaced in health (ADR-0013 D2/D4); one-shot operator semantics only, never env-gated.

## Acceptance criteria

1. A concurrent write during the barrier **blocks** (not fails) and completes on release; no write lost.
2. The swap runs inside the barrier and succeeds with the process alive (no restart, no new pid).
3. **SIGTERM mid-hold aborts, never completes-then-handles.** The sole SIGTERM/SIGINT handler sets the
   barrier's cancelled flag and releases waiters within one event-loop turn; the barrier does not await the
   swap; parked admissions are released or failed fast with retryable `E_BUSY`. Exit within
   `computeShutdownSafetyNetMs()` and before reaper grace, with no SIGKILL escalation.
4. The barrier is not load-bearing: the §5.3 gates and §5.2 identity fence remain the correctness boundary,
   and the §5.5.2 retry is the mandatory backstop.
5. `npx nx test memory-core memory-server` green in an isolated worktree.

## Required tests (SIGTERM-drain contract)

- names the barrier/S4.5 id and is RED→GREEN with the hold neutered.
- with a hold active, SIGTERM ⇒ exit within `computeShutdownSafetyNetMs()` and before reaper grace, **no
  SIGKILL escalation**.
- the hold is aborted by the signal: waiters released within ≤1 event-loop tick.
- the event loop is not synchronously blocked — a `setTimeout(fn,0)` scheduled before the hold fires *while
  the hold is active* (the ff7d9e24-class proof; `bl-ff7d9e24-no-vacuum-on-shutdown.spec.ts`).
- no silent write loss: every write admitted before the hold is durable or rejected retryable `E_BUSY`.
- runs against **both** `STORE_ADAPTER=turso` (bypass/`_noop`) and `sqlite` (FIFO), so a FIFO-only barrier
  goes red.
- budget arithmetic: `holdDeadlineMs` + guaranteed-eaten shutdown steps stays under the safety net with
  headroom (mirror `bug018-shutdown-budget-headroom.spec.ts`).
- negative control: with the barrier disabled, shutdown correctness is unchanged.

## Commit points

- After both specs pass: commit `write-queue.ts` + `index.ts` + spec by **explicit pathspec**.

## Notes

- This barrier is the reason the live build stays useful on a busy store. Absent it, S4 pays the
  identity-guarded retry (rebuild at the next quiesced window).
