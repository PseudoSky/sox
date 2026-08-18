# BL-590 — idle-flush debounce window: recommendation (design review, not implemented)

**Date:** 2026-08-18 · **Reviewer:** architect-reviewer (triage/design only, blind to implementation)
**Item:** [BL-590](../../../..) — `backlog get-item --repo sox-ecosystem --human-id BL-590`
**Status:** OPEN. This document records a recommendation among the item's own three recorded
options; it does not implement anything.

## Recap of the measured problem (BL-590's own body — not re-verified here)

`DEFAULT_IDLE_FLUSH_MS = 2000` (`libs/data/store/store-adapter/src/turso-adapter.ts:101`) is shorter
than the embed pipeline's write cadence (`time_to_vector_ms` p50 4516). Twelve async vector writes in
a live burst produced eleven idle flushes — effectively one full flush per write instead of
coalescing. Under the `'gated'` strategy (the production default, `turso-adapter.ts:394`), each flush
calls `releaseIdleConnection()`, which is the FULL close ceremony (PASSIVE checkpoint + gated
TRUNCATE + driver close + marker clear + lease release), and the next op pays a full reconnect. This
increases store *open* frequency, which this program's own durability tooling
(`tools/backlog-verify-durable.mjs`'s header, cited in BL-590) identifies as the variable that
distinguishes the corrupted backlog store from the never-corrupted memory store. Not a correctness
regression (all 22 writes acked, WAL returned to 0 every time) — a cost/risk-axis tuning question.

## The three options BL-590 already records

1. Raise `DEFAULT_IDLE_FLUSH_MS` above the embed pipeline's cadence (~6–8s suggested).
2. Make the idle path **ungated** (plain TRUNCATE, connection retained) so a flush stops implying
   close+reopen.
3. Make the debounce **adaptive** to embed backlog — extend the window while work is imminent.

## Evaluation against the durability guarantees each keeps or loses

### Option 2 (ungated) — REJECT, not a close call

`turso-adapter.ts:340-394`'s own doc comment on `_walFlushStrategy` is unambiguous and dated the day
before this item was filed: `'ungated'` "issues `PRAGMA wal_checkpoint(TRUNCATE)` directly, with NO
quiescence check... of UNKNOWN safety at higher concurrency," and after the
`wal-truncate-safety-experiment` reported back (2026-08-18, same file, same block) with a
non-reproduction (not a clean bill of health — "the harness cannot see the failure, not the failure
is absent"), the comment states as a standing decision: **"GATED IS THEREFORE THE PERMANENT DEFAULT,
not a placeholder pending a result... No caller may select `'ungated'` outside a test."**

Selecting option 2 for BL-590 would directly reverse a decision this same file records as permanent,
made one day earlier, by the same authority ("owner directive"), for the same reason (upstream
Turso concurrent-writer safety, tracked as issue #8348) that motivates BL-590's own corruption-risk
framing. It would also defeat the file's own stated insight: the gated strategy "was never wrong;
its precondition (no concurrent connection holding the store) simply went unsatisfied" under the old
long-lived-lease pattern — the idle-flush feature exists specifically to *manufacture* that
precondition (voluntary lease drop → quiescence reachable → the existing safe gated TRUNCATE actually
fires), not to route around the gate. Option 2 is off the table without a separate, explicit reversal
of that standing decision — out of scope for a tuning item.

### Option 1 (raise the static window) — VIABLE, but incomplete on its own

Raising the window to bracket `time_to_vector_ms` p50 (4516ms) — say 5000–6000ms — would let same-run
vector writes coalesce under the light/steady load BL-590 measured. Trade-offs, stated plainly:

- **Keeps** every durability guarantee unchanged — gated stays gated; this is a pure timing constant.
- **Loses** responsiveness under genuinely idle periods: a store that goes quiet after a *single*
  write now waits 5–6s longer before its PASSIVE checkpoint + gated TRUNCATE fires, meaning more wall
  clock during which a crash would need the WAL-based crash-recovery path (BL-330) rather than a
  clean close — not a correctness loss (BL-330 covers this), but a wider window of exposure to it.
- **Does not adapt**: p50 is not p99. `memory_ping.store.embed_backlog`'s own cited metrics
  (`embed_duration_ms` p99 3431) show the pipeline's cadence varies with load; a fixed window sized to
  today's p50 will under-shoot the next burst that runs slower (still fragmenting flushes) and
  over-shoot every quiet period permanently (paying the widened exposure window even when nothing is
  coming).

### Option 3 (adaptive, backlog-aware) — RECOMMENDED

Extend the debounce window while `embed_backlog > 0` (a value the server already computes and
surfaces via `memory_ping.store.embed_backlog` — no new instrumentation required), collapsing back to
a short base window (the current 2000ms, or whatever floor is chosen) the instant the backlog drains
to zero.

- **Keeps** every durability guarantee `'gated'` provides, identically to option 1 — this is still
  purely a timing decision layered on the existing strategy, not a new strategy.
- **Keeps** the short exposure window during genuinely idle periods (no backlog pending → base
  2000ms floor, unchanged from today) — the property option 1 gives up.
- **Adapts** to actual load rather than a fixed historical p50: a burst that runs slower than today's
  measurement still coalesces (the window stays extended as long as the backlog is non-empty,
  regardless of *how* long each item takes), and a burst that finishes fast collapses back to the
  tight floor immediately rather than paying a fixed 5–6s tax it no longer needs.
- **Cost**: more logic than a constant — the debounce arm/cancel path (`_armIdleFlush()`,
  `turso-adapter.ts:415-431`) needs to read backlog state at arm time, which couples the store-adapter
  (declared `data→data|shared ONLY` per `libs/data/CLAUDE.md`) to a backlog signal that today lives in
  `memory-core`/the embed pipeline — a boundary the implementer must resolve (e.g. the debounce window
  becomes a parameter the composer passes in per-arm, rather than the adapter reaching upward to read
  it itself; `libs/data/CLAUDE.md`'s boundary rule already prescribes exactly this shape: "if a data
  package needs [X] logic, the composer supplies it").

## Recommendation

**Ship option 3 (adaptive, backlog-aware debounce).** It is strictly better than option 1 on both
axes BL-590 itself weighs — coalescing under load AND exposure-window discipline under idle — for
implementation cost that is real but bounded (a parameter threaded from the composer, not a new
close/flush strategy). Option 2 is not a viable choice absent a separate reversal of a same-day,
same-authority "permanent default" decision already recorded in the codebase this item cites.

**If a smaller first step is wanted**, option 1 (raise the static floor to ~5000–6000ms) is a
legitimate, low-risk interim measure — a single-constant change with the same safety profile as
today, shippable immediately while the adaptive version is built — provided it is explicitly tracked
as an interim step and not treated as BL-590's final resolution, since it reintroduces the
idle-exposure-window regression option 3 avoids.

## Not evaluated here

- The exact numeric floor/ceiling for the adaptive window (needs the embed pipeline's actual backlog
  drain-rate distribution, not just the two-burst sample BL-590 measured) — an implementation-time
  calibration question, not a design-time one.
- Whether `embed_backlog` as currently computed is cheap enough to read on every `_armIdleFlush()`
  call without becoming its own hot-path cost — the implementer should measure this before wiring it
  in, per this repo's standing rule against un-measured performance claims.

## Citations

- [git: sox-ecosystem@c18a86a9, agent: claude, model: claude, task: BUG-018/BL-590 triage+design,
  1: libs/data/store/store-adapter/src/turso-adapter.ts:101 (`DEFAULT_IDLE_FLUSH_MS = 2000`),
  2: libs/data/store/store-adapter/src/turso-adapter.ts:340-394 (`_walFlushStrategy` doc comment,
     "GATED IS THEREFORE THE PERMANENT DEFAULT... No caller may select 'ungated' outside a test"),
  3: libs/data/store/store-adapter/src/turso-adapter.ts:415-431 (`_armIdleFlush()`),
  4: libs/data/store/store-adapter/src/turso-adapter.ts:444+ (`_performIdleFlush()`, gated branch
     calling `releaseIdleConnection()`),
  5: libs/data/CLAUDE.md (`data→data|shared ONLY` boundary rule; composer-supplies-logic pattern),
  6: BL-590 item body (backlog get-item, options 1-3, all measured metrics)]
