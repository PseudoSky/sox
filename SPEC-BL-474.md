# SPEC-BL-474 — bound the enrich-heal backstop's wait on `_bgSlot`, and stop scheduling the drain in processes that opt out

Status: implemented and architect-verified. No open questions were raised — every ruling in §3
(D1–D7) mapped directly onto the shipped code; architect re-read both commits against this spec
line-by-line and confirms no deviation.
Worktree: `/Users/nix/dev/ai/sox-ecosystem/.worktrees/bl474-bgslot-contention`, branch `feat/bl474-bgslot-contention`.
Stage: architect review complete. Commits: `f4832b23` (HealResult.skipped, memory-core),
`7557b6d2` (withBackgroundSlotOrSkip + call-site + scheduling gate + tests, extensions). Next
stage: ship (registry sync / merge), owner's call — this task's scope did not ask for a deploy.

## Architect verification note (post-implementation)

Read both commits' diffs in full against this spec (`git show f4832b23`, `git show 7557b6d2`)
rather than trusting the implementer's report at face value:

- `HealResult.skipped?: boolean` (`libs/memory-core/src/embed-pipeline.ts:149-153`) — additive,
  exact doc comment as specified in §2.
- `withBackgroundSlotOrSkip` (`index.ts:2624-2651`) and its `_withBackgroundSlotOrSkipForTest`
  export — matches §2 verbatim, including the D7 race-window comment.
- `runEnrichPassOnDb`'s heal step (`index.ts:2286-2304`) — matches §2 verbatim, including the
  `scanned:0, healed:0, exists:0, gone:0, failed:0, disabled:false, time_budget_exceeded:false,
  skipped:true` skip-result shape.
- `heal_skipped` threaded additively through the return type and both log payloads
  (`index.ts:2358`, `:2369`, `:2424`) — matches §2 item 3.
- `scheduleNextDrain()`'s `SOX_DISABLE_EMBED_HEAL` gate (`index.ts:2833-2846`) — matches §2 item 4
  and D4 (reuses the seam, no new env var).
- `drain-wake.spec.ts`'s corrected test — matches D6 exactly: `backgroundSlotHolder()).toBe('drain')`
  kept (still true), the wait-vs-skip mechanism re-asserted via `runEnrichPassOnDb`'s
  `heal_skipped`/`healed` fields called directly (not through the void-returning guarded wrapper),
  raced against a 500ms timer per D7's ordering discipline (`waitFor(() => gated.calls >= 1, …)`
  before the try-acquire). One spot-check worth recording: the test calls
  `const adapter = await getDb(dbPath)` (no `.unwrap()`) and passes `adapter` straight to
  `runEnrichPassOnDb(adapter, dbPath)` — this is correct, not a bug, because `getDb`
  (`libs/memory-core/src/db.ts:905`) returns `Promise<StoreAdapter>` directly, and
  `runEnrichPassOnDb` wants a `StoreAdapter` (`index.ts:2229`); `.unwrap()` (used elsewhere in the
  same file for raw `Database.Database` access, `libs/data/store/store-adapter/src/types.ts`) is
  the wrong shape here and rightly wasn't used.
- `bl474-bgslot-priority.spec.ts` — new file, one-file-per-BL-id convention followed, AC-1/AC-2/AC-4
  each present with the RED→GREEN procedure documented in its header comment matching the
  implementer's report.

No ruling in this spec needed to change. The implementer's claim of zero open questions and zero
gaps stands verified, not merely trusted.

## 1. Root cause (my own reading, file:line cited)

`extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts`:

- `_bgSlot` / `_bgSlotHolder` (`:2557-2558`) and `withBackgroundSlot()` (`:2570-2590`) implement a
  **strict FIFO promise-chain mutex**: `withBackgroundSlot(holder, fn)` snapshots the current tail
  (`prev = _bgSlot`), installs its own unresolved promise as the new tail, `await`s `prev`, then runs
  `fn`. There is no bound on how long `fn` may run while holding the slot, and no way for a second
  caller to observe "busy" and act on it — the only operation offered is **wait until free**.
- Two, and only two, call sites reach it in production:
  - `runDrainPassGuarded()` → `withBackgroundSlot('drain', () => runDrainPass())` (`:2716`), the
    always-on background chain armed unconditionally by `scheduleNextDrain()` at module import
    (`:2910`, timer body `:2774-2777`).
  - `runEnrichPassOnDb()`'s heal step → `withBackgroundSlot('enrich-heal', () =>
    healMissingVectors(adapter, wq, { limit: drainBatchLimit() }))` (`:2273-2275`), reached by
    every `memory_write`-driven enrichment tick (`runPeriodicEnrichPassGuarded` →
    `runPeriodicEnrichPass` → `runEnrichPassOnDb`, and directly by tests).
- Both sides call the **same function** (`healMissingVectors`, `libs/memory-core/src/embed-pipeline.ts:645`)
  over the **same query** (`NOT EXISTS (SELECT 1 FROM vec_node v WHERE v.node_id = n.rowid)`,
  `embed-pipeline.ts:691-701`), bounded per call by `embedHealTimeBudgetMs()` — **240,000ms by
  default** (`embed-pipeline.ts:197,704,714`), not the 30s I might have assumed from the drain's own
  re-arm floor. The drain's *re-arm interval* (`DEFAULT_DRAIN_FLOOR_MS`, `index.ts:2033`) bounds how
  **often** a pass starts; it does not bound how **long** one pass may hold `_bgSlot` once started.
  BL-474's own diagnosis measured a live hold of **~12.5s**, well inside that 240s ceiling — i.e. the
  system is currently working exactly as designed, and the design's ceiling on one side's hold is two
  orders of magnitude larger than any latency budget the other side (a write-triggered enrich tick)
  can be given.
- `healMissingVectors`'s own applies are idempotent by construction: `applyEmbedding` reports
  `exists`/`gone` outcomes distinctly from `healed` (`embed-pipeline.ts` `HealResult`, `:136-149`),
  because a row that already has a `vec_node` entry by the time the embed lands is a no-op, not a
  conflict. **The exclusion between `'drain'` and `'enrich-heal'` is therefore a *duplicate-work*
  guard, not a data-safety guard** — running the same scan twice concurrently wastes embed calls, it
  does not corrupt state. This matters directly for the ruling in §3.

Net: the always-on drain chain, once started, can legitimately occupy `_bgSlot` for a duration sized
to a 500-ish-row-equivalent-cost ceiling (240s, though `DEFAULT_DRAIN_BATCH` is 64 rows so the
practical ceiling is far lower in steady state — but not bounded *by construction* to anything
smaller than 240s), and every enrich-heal call — which is on the path of every ordinary write's
enrichment tick — pays whatever is left of that hold with **zero priority, zero preemption, and no
alternative but to wait**.

## 2. The change, file by file

### `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts` — the fix

1. **New function, next to `withBackgroundSlot` (after `:2590`, before `backgroundSlotHolder`):**

   ```ts
   /**
    * Try to acquire the background slot; if it is already held, return
    * immediately with `{ acquired: false }` instead of joining the FIFO queue.
    * (BL-474.) Unlike `withBackgroundSlot`, a busy slot is not an error and is
    * not waited on — the caller decides what "could not acquire" means for it.
    *
    * Correctness note: this only inspects `_bgSlotHolder`, which is non-null
    * only while `fn` is actually running inside `withBackgroundSlot`. There is
    * a single-microtask window between a competing `withBackgroundSlot` call
    * installing its promise as the new `_bgSlot` tail and that call setting
    * `_bgSlotHolder` (index.ts:2571-2583) during which this function would
    * still see `null` and proceed to acquire via the normal path below — in
    * that rare case it degrades to the old blocking behaviour for one hold,
    * never to an incorrect double-acquire. Both known callers accept this.
    */
   async function withBackgroundSlotOrSkip<T>(
     holder: string,
     fn: () => Promise<T>,
   ): Promise<{ acquired: true; result: T } | { acquired: false }> {
     if (_bgSlotHolder !== null) {
       return { acquired: false };
     }
     const result = await withBackgroundSlot(holder, fn);
     return { acquired: true, result };
   }

   /** Test seam. */
   export { withBackgroundSlotOrSkip as _withBackgroundSlotOrSkipForTest };
   ```

   Export it under the `_..ForTest` naming convention already used elsewhere in this file (e.g.
   `_setEmbedProviderForTest` in memory-core) so it's clearly a seam, not public API.

2. **`runEnrichPassOnDb`'s heal step (`:2271-2275`)** changes from a blocking acquire to the bounded
   try-acquire, with a skip result folded into the existing `HealResult` shape rather than a new
   return type:

   ```ts
   const wq = await WriteQueue.forPath(dbPath);
   const acquireHealSlot = opts.acquireHealSlot ?? true;
   const heal = acquireHealSlot
     ? await (async (): Promise<HealResult> => {
         const attempt = await withBackgroundSlotOrSkip('enrich-heal', () =>
           healMissingVectors(adapter, wq, { limit: drainBatchLimit() }),
         );
         if (attempt.acquired) return attempt.result;
         // BL-474: the drain chain holds the slot — it is actively doing the
         // SAME heal work this backstop exists to catch, so skipping here
         // loses nothing (the drain's own pass will finish it) and costs
         // nothing (this backstop is not this tick's only path to a healed
         // vector; the next tick, or the drain's own re-arm, retries).
         return {
           scanned: 0, healed: 0, exists: 0, gone: 0, failed: 0,
           disabled: false, time_budget_exceeded: false, skipped: true,
         };
       })()
     : await healMissingVectors(adapter, wq, { limit: drainBatchLimit() });
   ```

   Update the doc comment at `:2254-2270` (the block explaining why the slot is still needed) to
   state the new contract: the slot still excludes concurrent heal scans, but the enrich side now
   *yields* instead of *waiting* — add one paragraph, do not delete the existing BL-346/BL-348
   history, this codebase's convention (see e.g. `:249-266` in `drain-wake.spec.ts`) is to layer
   corrections onto existing comments with a dated marker, not silently rewrite them.

3. **`runEnrichPassOnDb`'s return type and both `log.info`/`log.error` calls (`:2232-2239`,
   `:2298-2329`, `:2335-2341`, `:2388-2395`)** — add one additive field, `heal_skipped`, threaded from
   `heal.skipped ?? false`:
   - Return type: `heal_skipped: boolean` alongside the existing `healed`/`heal_failed`.
   - `enrich.pass.finish` log payload: add `embed_heal_skipped: heal.skipped ?? false` next to the
     existing `embed_heal_disabled: heal.disabled` line (`:2328`).
   - `enrich.pass.failed` log payload: same addition next to `embed_healed: heal.healed` (`:2338`).
   - Final return object (`:2388-2395`): add `heal_skipped: heal.skipped ?? false`.

   This is additive-only (HF-3 rule, already the house convention per this file's own comments at
   `:2311` and the memory-server `CLAUDE.md`'s `memory_stats`/`memory_write` sections) — no existing
   field changes shape or meaning.

4. **`scheduleNextDrain()` (`:2769-2779`)** — gate the *first* arm on the same env var that already
   disables heal work at execution time, so a process that has `SOX_DISABLE_EMBED_HEAL=1` set at
   import time never arms the timer at all, instead of arming it, running one no-op pass, discovering
   `heal.disabled`, and only then setting `_drainDisabled = true` (`:2717-2718`) to stop rescheduling.
   Do **not** invent a new env var — `SOX_DISABLE_EMBED_HEAL` is already documented as "negative-control
   seam — never set in prod" (`libs/memory-core/src/embed-pipeline.ts:628`), and this file's own
   comments at `:1408` warn against exactly the duplicated-flag pattern a new var would repeat
   (BL-344's lesson, cited by name in this file already).

   ```ts
   function scheduleNextDrain(): void {
     if (_drainDisabled) return;
     if (process.env['SOX_DISABLE_EMBED_HEAL'] === '1') {
       _drainDisabled = true;
       return;
     }
     if (_drainNextTimer !== null) clearTimeout(_drainNextTimer);
     const delay = nextDrainDelayMs();
     _drainDirty = false;
     _drainNextTimer = setTimeout(() => {
       _drainNextTimer = null;
       void runDrainPassGuarded().finally(scheduleNextDrain);
     }, delay);
     if (typeof _drainNextTimer.unref === 'function') _drainNextTimer.unref();
   }
   ```

   This is a pure optimization with the exact same end state as today (`_drainDisabled = true`,
   drain chain dead) reached without the wasted first no-op pass — it changes no observable behaviour
   for any process that does not set this var, and it is the "(c)" companion the item asked for: any
   test file (or short-lived process) that sets `process.env.SOX_DISABLE_EMBED_HEAL = '1'` **before**
   importing `index.ts` now deterministically gets zero background drain activity, closing the
   `clustering-e2e.test.ts` step-3 race at its scheduling root rather than by widening its timeout.

### `libs/memory-core/src/embed-pipeline.ts` — one additive field

`HealResult` (`:136-149`) gains one optional field:

```ts
export interface HealResult {
  scanned: number;
  healed: number;
  exists: number;
  gone: number;
  failed: number;
  disabled: boolean;
  time_budget_exceeded: boolean;
  /** (BL-474) True when the caller could not acquire `_bgSlot` and skipped the
   *  scan entirely rather than waiting for it — see index.ts's
   *  withBackgroundSlotOrSkip. Always false/absent for a result that actually
   *  ran a scan (including scanned:0 — "ran and found nothing" is distinct
   *  from "did not run"). */
  skipped?: boolean;
}
```

`healMissingVectors`/`_healMissingVectorsPass` themselves are **out of scope and must not change** —
they never set `skipped`; only `index.ts`'s new wrapper constructs a `HealResult` with it, for the
one case where the function was never called.

### Files that must NOT change, and why

- `libs/memory-core/src/write-queue.ts` — the Turso/SQLite adapter's serialization flags
  (`needsWriteSerialization`, `concurrentTransactions`) are unrelated to `_bgSlot` and are explicitly
  banned from this task by the dispatch brief. `_bgSlot` is a memory-server-local mutex over two
  in-process background loops; it has no relationship to WriteQueue's per-store write serialization.
- `libs/memory-core/src/enrich-isolation.ts`, `enrich-process-host.ts` — the isolated cluster child
  process (BL-348) never touches `_bgSlot` today and must not start. Nothing in this spec changes
  clustering's isolation boundary.
- `extensions/bundles/sox-memory-bundle/members/memory-server/src/backend.ts:269-298`
  (`coordinatedShutdown` step 0, BL-472's `waitForDrainSettled()` consumer) — unaffected by this
  change. `waitForDrainSettled()` still resolves off `_drainInFlightPromise`, which this spec does not
  touch; the enrich-heal side's new skip path cannot make a drain pass run longer (if anything, an
  enrich-heal call that used to occupy the slot for its own bounded duration now never does, which
  can only shorten, never lengthen, any given drain hold). Do not add any new wait to shutdown.
- `healMissingVectors`/`_healMissingVectorsPass` bodies (`embed-pipeline.ts:645-`) — the scan query,
  the per-row loop, and `embedHealTimeBudgetMs()`/`embedHealTimeoutMs()` are unchanged. This spec
  does not touch the drain's own hold-duration ceiling; it removes the requirement that anyone else
  wait for it.
- `runDrainPass()` / `runDrainPassGuarded()` (`:2654-2751`) — the drain side keeps its existing
  blocking `withBackgroundSlot('drain', …)` acquisition unchanged. It is never made to skip. Only the
  enrich-heal side becomes non-blocking; the drain remains the authoritative, unconditional healer.

## 3. Every decision, ruled

**D1 — Which of (a) priority/preemption, (b) decouple, (c) opt-out-scheduling do we implement?**
Ruling: **(a) reframed as yield, plus (c) as a companion.** Not preemption in the literal sense (we
never abort a running drain pass) and not (b) as literally written (we do not give the two scans
disjoint row windows). The chosen shape is a *non-blocking try-acquire*: enrich-heal asks once,
and if the slot is busy it yields to whichever pass already holds it rather than queuing.

*Why full (b) — disjoint scan windows — loses:* it requires either partitioning the `NOT EXISTS
vec_node` row set (e.g. by `rowid % 2`) or handing out non-overlapping `LIMIT`/`OFFSET` cursors
between two independently-scheduled loops. Both add real correctness surface (a partition scheme has
to stay correct as rows are inserted and healed between scans; an offset cursor has to stay correct
across restarts) to eliminate a mutex whose only cost, per §1, is *duplicate work*, not *corruption*.
That is not a good trade for the risk introduced, and BL-346's rationale (as the comments in this
file state it, `:2544-2547`) is exactly "two concurrent scans over the same window" being wasteful,
not unsafe — so the win from (b) is smaller than it looks, and this task's time budget does not cover
validating a new partition scheme's correctness under concurrent insert/heal.

*Why literal preemption (aborting a running drain pass mid-flight) loses:* `healMissingVectors`
awaits real embed calls through an isolated worker queue (`embed-pipeline.ts` `_healMissingVectorsPass`
loop, `:709-`); there is no safe cancellation point mid-embed without either leaking the worker call or
introducing a new abort-signal plumbed through `embedSingle` and the isolated-process boundary — a
materially larger change than this item's scope, for a benefit (bounding the *drain's* hold) that (a)
already achieves indirectly by bounding what the *other side* has to wait for it.

*Why (c) alone loses, per the item's own framing, restated because it's worth restating: it fixes the
test, not the write path.* It is included anyway, because it is cheap, zero-risk (§ risk section),
and it independently closes the flakiness the item's own symptom (`clustering-e2e.test.ts` step 3)
exhibited — but it is explicitly not the AC-bearing fix.

**D2 — Does yielding (skip) ever lose real healing work?** Ruling: **no, by the argument in §1.**
Every yield happens exactly when the drain is *actively running the same scan* — the backlog is
being drained *right now* by the party that won the race, not abandoned. Enrich-heal is documented
in this file as "a BACKSTOP, not the drain… usually returns nothing" (`:2247-2249`) precisely because
the dedicated drain loop is expected to keep the backlog at zero in the common case. A skip merely
declines to duplicate work already in flight; the next enrich tick (5 minutes later, or sooner via
`wakeDrain`-driven re-arms of the *drain* itself) retries, and the drain's own floor re-arm (30s) is
far tighter than the enrich interval regardless.

**D3 — Does the drain ever need to yield to enrich-heal (the reverse direction)?** Ruling: **no
change to the drain side.** BL-474's measured defect and acceptance criteria are one-directional
(drain blocking enrich-heal). The drain is the primary, unconditional healer — it must never skip.
Making it skip in favor of the backstop would invert the priority the rest of this file already
documents (`:2247-2249`) and is not asked for by the item.

**D4 — New env var for the scheduling opt-out, or reuse `SOX_DISABLE_EMBED_HEAL`?** Ruling: **reuse.**
Argued in §2.4 above; a new var repeats the exact duplicated-policy pattern this file's own comments
warn about (`:1408`, citing BL-344).

**D5 — Where does the "acquired vs skipped" result surface?** Ruling: **as an additive field on the
existing `HealResult`/`runEnrichPassOnDb` return shape (`heal.skipped` / `heal_skipped`), not a new
return type or thrown signal.** Every other outcome of a heal attempt (healed count, failed count,
disabled, time-budget-exceeded) is already reported this way; a skip is one more outcome in the same
family, and every existing caller that destructures specific fields off `HealResult` keeps compiling
unchanged since the field is optional.

**D6 — `drain-wake.spec.ts`'s existing assertion at `:286` (`expect(backgroundSlotHolder()).toBe('drain')`
inside `'the background slot excludes the two heal scans…'`) will read as contradicted by this
change — does it get weakened?** Ruling: **no — it gets corrected, and BL-225 applies: watch it fail
first.** That assertion is still true after the fix (the slot holder genuinely is still `'drain'` —
enrich-heal never takes it). What changes is a fact the test's *setup* currently assumes but never
asserts: that `runPeriodicEnrichPassGuarded()`'s promise does not resolve until `gated.release()` is
called (line `288`), which was true only because enrich-heal used to block on the same gate
transitively through the slot. After the fix it is no longer true — the enrich tick's heal step
returns (skipped) almost immediately, and the tick's overall completion is now gated only by its
*isolated cluster pass*, which is unrelated to `gated`. **This is exactly the kind of test whose
premise the fix invalidates, not a guard being weakened to hide a regression** — the guard it exists
to protect (heal-vs-heal exclusion: two heals never run concurrently) is still enforced and still
tested; only the *mechanism* (wait vs skip) changed, and BL-346's actual safety property (no
concurrent double-scan) holds either way, per §1. Required test edit, spelled out in §4 AC-3.

**D7 — Does the single-microtask acquisition race documented in `withBackgroundSlotOrSkip`'s own
comment need closing?** Ruling: **no, ship with the documented small race.** The window is one
microtask between `_bgSlot` reassignment and `_bgSlotHolder` assignment inside the *existing*,
unmodified `withBackgroundSlot` (`:2571-2583`) — closing it would mean either merging the two
functions' internals (real risk to the well-tested existing mutex, out of proportion to the benefit)
or adding a second flag that must stay in lockstep with `_bgSlotHolder`, reintroducing the
duplicated-state hazard D4 explicitly rejected. The failure mode if it fires is bounded and safe: one
extra blocking wait, identical to today's *only* behavior — never an incorrect concurrent double-run.
Acceptance tests must be written to make the drain's holder-assignment happen-before enrich-heal's
attempt (wait for `backgroundSlotHolder() === 'drain'` before invoking the try-acquire), which is
already this file's existing test idiom (`drain-wake.spec.ts:275-277`) and makes the race
unobservable in the suite by construction — it is a true theoretical residual, not a test gap.

## 4. Acceptance criteria (must name BL-474), each with its RED arm

**AC-1 (unit-level, the core claim).** A concurrent `withBackgroundSlotOrSkip('enrich-heal', fn)`
call, made *after* `backgroundSlotHolder()` is observed to already be `'drain'` (i.e. after the race
window in D7 has definitely closed for this call), returns `{ acquired: false }` **within single-digit
milliseconds**, regardless of how long the drain's held `fn` takes to resolve (assert against a drain
hold of at least 2000ms via a gated provider, and assert the `withBackgroundSlotOrSkip` call resolves
in under, say, 200ms — two orders of magnitude less than the hold it's racing).
*RED arm:* before this function exists, the import itself fails to compile/typecheck (no such export)
— the same accepted RED shape as BL-472's `waitForDrainSettled` test (`drain-wake.spec.ts:319-325`).
Additionally, prove the *behavioral* RED, not just the compile RED: temporarily point the same test at
`withBackgroundSlot` (the pre-existing blocking primitive) instead, and observe it does NOT resolve
until `gated.release()` is called — i.e. it blocks for the full ~2000ms+ hold, not under 200ms. Watch
this fail, then watch `withBackgroundSlotOrSkip` pass, both actually run (BL-225).

**AC-2 (integration-level, names BL-474 directly).** `runEnrichPassOnDb(adapter, dbPath)`, called
while a `runDrainPassGuarded()` pass provably holds `_bgSlot` (again gated on
`backgroundSlotHolder() === 'drain'` before invoking), returns a result with `heal_skipped: true` and
`healed: 0`, and the **heal step's own contribution to the call's wall-clock time is bounded** —
assert this by comparing elapsed time against the same call made with no concurrent drain (a fast
baseline) plus a fixed slack budget (e.g. baseline + 300ms), not against an absolute constant, since
the isolated cluster child process's own duration is legitimately variable and unrelated to this fix.
*RED arm:* with the heal step still calling blocking `withBackgroundSlot('enrich-heal', …)` (i.e. the
fix reverted), the same call takes at least as long as the drain's held gate (assert elapsed >= the
gate hold duration, e.g. >= 2000ms) and `heal_skipped` is `undefined`/absent — watch this actually
fail against pre-fix code, then pass against the fix.

**AC-3 (regression, the existing test corrected per D6).**
`drain-wake.spec.ts`'s `'the background slot excludes the two heal scans…'` test (`:267-293`) is
updated: keep the `expect(backgroundSlotHolder()).toBe('drain')` assertion at (old) line 286 — it is
still true — but stop awaiting `enrich` before `gated.release()` (the old code, `:288-291`, released
the gate and then awaited both `drain` and `enrich` in sequence; under the fix `enrich` no longer
depends on the gate at all, so keep the ordering but add an explicit assertion that `enrich` resolves
*before* `gated.release()` is called — race `enrich` against a short timer the way
`waitForDrainSettled`'s own test does, `drain-wake.spec.ts:329-332`). Add
`expect(heal_skipped-equivalent).toBe(true)` if `runPeriodicEnrichPassGuarded()`'s return shape allows
it, otherwise call `runEnrichPassOnDb` directly in this test (as AC-2 does) so the structured result
is inspectable — prefer this over threading a new return value through the `void`-returning guarded
wrapper. Retitle the test to say what it now proves: heal-vs-heal exclusion still holds, but via
yield, not wait.
*RED arm:* run this rewritten test against the reverted (pre-fix) heal step — it fails because
`enrich` does not resolve before the gate opens (deadlocked on `gated.release()`, same shape as
today's passing behavior, but now asserted as a failure).

**AC-4 (companion, scheduling opt-out).** With `process.env.SOX_DISABLE_EMBED_HEAL = '1'` set before
`index.ts` is imported (module-load-order-sensitive — use `vi.resetModules()` + dynamic `import()` in
the test, the same pattern any test that needs to control module-load-time behavior in this file must
use), assert `isDrainPassInFlight()` never becomes `true` and `getDrainPassCount()` stays `0` across a
window at least as long as `DEFAULT_DRAIN_FLOOR_MS` would have required for a first pass (i.e. don't
just check immediately after import — wait past where the old unconditional timer would have fired,
using a short overridden `SOX_EMBED_DRAIN_FLOOR_MS` so the test doesn't actually wait 30s).
*RED arm:* before the `scheduleNextDrain()` gate exists, the timer arms anyway and
`getDrainPassCount()` becomes `>= 1` within the shortened floor window — watch this fail on pre-fix
code (with the env var set, which pre-fix code ignores entirely for scheduling purposes), then pass
post-fix.

New spec file: `extensions/bundles/sox-memory-bundle/members/memory-server/src/bl474-bgslot-priority.spec.ts`
for AC-1, AC-2, AC-4 (module-reset tests, per BL-474's own naming convention — see
`bl472-shutdown-drain.spec.ts`, `bl413-enrich-stall-escalation.spec.ts`, `bl328-calibration-observability.spec.ts`
as the precedent for one file per BL-id doing integration-level proof). AC-3 is an in-place edit to
the existing `drain-wake.spec.ts`.

## 5. Risks

- **No data-loss / no dist-artifact risk from this change itself** — it is pure application logic in
  `memory-server/src/index.ts` and `memory-core/src/embed-pipeline.ts`'s type declaration, no schema,
  no migration, no destructive `nx build`. The real risk in this task is process, not code:
  - **Never run a diagnostic `nx build`** on `memory-server`/`memory-core` (BL-235) — it deletes
    `dist/` before knowing the rebuild succeeds. Read the source to check for errors; only build once
    the implementer is confident and ready to ship.
  - **`nx test` rebuilds upstream dists from whatever is on disk** (BL-456) — since this change spans
    both `memory-core` (the `HealResult` type) and `memory-server` (the mutex + call sites), a test
    run of `memory-server` will rebuild `memory-core`'s `dist/` from the edited source. That is
    expected and fine as long as no *other* agent's uncommitted `memory-core` edits are on disk at the
    same time — run `node tools/check-suite-tree-state.mjs --project memory-server` immediately before
    trusting any suite result, exactly as the dispatch brief requires, and report its output verbatim.
  - **Never touch `~/.memory/*`** — every test in this spec uses `tmpStorePath()` /
    `fs.mkdtempSync`-style fixtures, matching the existing pattern in `drain-wake.spec.ts` and
    `async-embed.spec.ts`. Do not add a test that opens the real store.
- **Shutdown interaction (BL-472).** Argued closed in §2's "must NOT change" list — `waitForDrainSettled()`
  and `SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS` are untouched, and the enrich-heal side can only ever hold
  `_bgSlot` for less time post-fix (zero, when skipped) than pre-fix, never more. Still: after
  implementing, re-run `bl472-shutdown-drain.spec.ts` unmodified and confirm it is still green — that
  is the live regression check for this risk, not just an argument.
- **The D7 residual race** is small and bounded (§3), but the implementer must not attempt to "fix" it
  by adding a second boolean flag or merging `withBackgroundSlot`/`withBackgroundSlotOrSkip`'s
  internals under time pressure — that trade was explicitly ruled against. If a future review wants it
  closed, it is copy for a new backlog item, not scope creep here.
- **`HealResult.skipped` being optional** means any code that JSON-serializes a `HealResult` and
  compares object shape exactly (e.g. a snapshot test) could see a new key appear only in the skipped
  case. Grep the suite for any such exact-shape comparison before merging (`grep -rn "toEqual({" extensions/bundles/sox-memory-bundle/members/memory-server/src libs/memory-core/src` scoped to files touching `HealResult`/`healMissingVectors`) and update any that would break — expected to be none, since existing tests already assert the pre-BL-474 fields individually (`embed-pipeline-metrics.spec.ts`'s pattern), but verify, don't assume.

## 6. The gate — exactly which nx targets to run, and in what order

1. `node tools/check-suite-tree-state.mjs --project memory-server` — **before** any test run, to
   establish attribution, and again immediately before the final reported result.
2. `npx nx typecheck memory-core` and `npx nx typecheck memory-server` — the `HealResult.skipped`
   field and the new `withBackgroundSlotOrSkip` function must typecheck clean. Do **not** skip this
   (per this repo's `⛔ AGENT SEQUENCE` — bundled projects strip types on build without checking them).
3. `npx nx lint memory-core` and `npx nx lint memory-server`.
4. `npx nx test memory-server -- --run drain-wake.spec.ts` — scoped run first, to watch AC-3's red
   arm and green arm in isolation without paying for the whole suite each iteration.
5. `npx nx test memory-server -- --run bl474-bgslot-priority.spec.ts` — same, for AC-1/AC-2/AC-4.
6. `npx nx test memory-server -- --run bl472-shutdown-drain.spec.ts` — the regression check named in
   §5.
7. Full scoped suite once the above are green: `npx nx test memory-server`.
8. `npx nx test memory-core` (the `HealResult` type lives here; run its suite too even though no
   behavior in this package changes, since the type changed).
9. Do **not** run `npx nx build memory-server`/`memory-core` as a diagnostic step (BL-235). Only build
   if and when this ships toward a registry sync, and only after every test above is green — and even
   then, that is a decision for after this task's stated scope (this item does not ask for a deploy).
10. **No `--skip-nx-cache`.** Plain `npx nx test <project>` / `npx nx test <project> -- <file>` only,
    per the dispatch brief's non-negotiable house rules.

Report every suite result paired with its `check-suite-tree-state.mjs` output, per BL-456.
