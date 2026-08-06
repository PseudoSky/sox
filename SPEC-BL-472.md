# SPEC — BL-472: bound-drain in-flight Phase-B embeds before shutdown closes the adapter

Worktree: `/Users/nix/dev/ai/sox-ecosystem/.worktrees/bl472-shutdown-drain`
Branch: `feat/bl472-shutdown-drain`
Stage: architect (this doc) → implementer → reviewer → implementer → reviewer

## 1. Root cause (file:line citations personally opened)

`memory_write`'s async-default path enqueues Phase A, then fires Phase B off the queue slot as
fire-and-forget via `schedulePhaseBAndWake` — `void schedulePendingEmbeds(wq, pendings, opts)`,
never awaited (`extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts:2822-2838`).
`schedulePendingEmbeds` (`libs/memory-core/src/embed-pipeline.ts:520-601`) computes the embedding via
`embed()` (line 559, off-slot, worker-thread ONNX) and then, still inside the same untracked async
run, calls `wq.enqueue('embed_apply:...', ...)` (line 565) to insert `vec_node`.

`libs/memory-core/src/embed-pipeline.ts:486-504` already tracks every such in-flight run in a
module-level `inFlight` Set and exposes `flushPendingEmbeds()` — "resolve when every currently-
scheduled Phase-B pipeline has settled. Used by tests ... and available to shutdown paths"
(line 497-498, doc comment). It is not currently called by any shutdown path — six memory-core/
memory-server spec files call it manually before their own `WriteQueue.clearInstances()`
(confirmed: `libs/memory-core/src/embed-provenance.spec.ts:132`,
`libs/memory-core/src/embed-pipeline-metrics.spec.ts:127`,
`extensions/bundles/sox-memory-bundle/members/memory-server/src/async-embed.spec.ts:93,99,131,174,197,309,400`,
`extensions/bundles/sox-memory-bundle/members/memory-server/src/bl348-stage-isolation.spec.ts:112,144,170,214`),
proving the seam is correct and already load-bearing — just never wired into production shutdown.

Production shutdown is `coordinatedShutdown` in
`extensions/bundles/sox-memory-bundle/members/memory-server/src/backend.ts:223-320`. Its sequence,
as it stands today:

1. `terminateEmbedWorkers()` (line 261) — `libs/memory-core/src/embed.ts:425-430` calls
   `.terminate()` on both the shared fastembed child process and the shared ONNX worker.
2. `closeAllAdapters()` (line 270).
3. `WriteQueue.closeAllForShutdown()` (line 282) —
   `libs/memory-core/src/write-queue.ts:502-539` — checkpoints and closes every `WriteQueue`'s
   dedicated write connection unconditionally (no drain first, no knowledge that Phase-B work may
   still be running against it).
4. best-effort backup, then close + exit.

None of these four steps ever calls `flushPendingEmbeds()`. This produces **two independent, real
failure modes** for any Phase-B pass still in flight when SIGTERM/SIGINT lands — both confirmed by
reading the code that would run, not inferred:

- **Adapter-close race (step 3):** if `schedulePendingEmbeds`'s `wq.enqueue(...)` call
  (`embed-pipeline.ts:565`) hasn't resolved yet when `closeAllForShutdown()` closes `q.adapter`
  (`write-queue.ts:530-537`), the enqueue throws against a closed connection —
  `{"code":"E_IO","message":"The database connection is not open"}`, exactly the string BL-472
  reports. The embedding (ONNX cost already paid) is discarded.
- **Worker-teardown race (step 1, distinct from the above and NOT mentioned as fixed by anything in
  BL-405):** `SharedFastembedProcessClient.terminate()`
  (`libs/data/embed/embedding-provider/src/sharedFastembedProcess.ts:333-341`) rejects every
  pending in-flight call with `Error('shared fastembed process terminated')` — `for (const { reject }
  of this.pending.values()) { reject(...) }` (lines 337-339) — read directly. If a Phase-B `embed()`
  call (`embed-pipeline.ts:559`) is still awaiting a response from the shared process when step 1
  runs, it is rejected there, before the adapter is even touched. `sharedOnnxWorker.ts`'s `terminate()`
  does the equivalent for the ONNX-worker backend. This means draining only in front of step 3 is
  insufficient — the drain must precede step 1, the very first thing `coordinatedShutdown` does today.

This is the reason BL-405's own precedent (cancel the WP-5 checkpoint timer before closing) is
necessary-but-not-sufficient prior art for this fix: BL-405 protects the adapter-close side only. A
correct BL-472 fix has to sit in front of *both* races, i.e. in front of step 1, not spliced in
between steps 1 and 3.

`WriteQueue.clearInstances()` (`write-queue.ts:451-459`) has the identical unconditional-close
shape, but it is **test-teardown only** — its own doc comment says so explicitly ("Ensures each test
gets a fresh queue" / the `closeAllForShutdown` doc comment at line 488 contrasts it: "no checkpoint,
no error surfacing — a fresh-queue reset, not a durability guarantee"). It is never called from any
production code path (confirmed: `grep -rn "WriteQueue.clearInstances" extensions/ libs/memory-core/src/*.ts`
outside `.spec.ts` files returns nothing). See Decision D3.

## 2. The change, file by file

Two production files change. BL-472's own citation names TWO independent fire-and-forget seams that
race shutdown — `schedulePendingEmbeds` (tracked by `embed-pipeline.ts`'s `inFlight`/`flushPendingEmbeds`)
**and** the debounced `wakeDrain('write')` → `runDrainPassGuarded()` heal-shaped pass
(`index.ts:2684-2723`, **not** tracked by `inFlight` at all — confirmed by reading: `grep -n "track("
libs/memory-core/src/embed-pipeline.ts` returns exactly one call site, inside
`schedulePendingEmbeds`, line 600; `runDrainPassGuarded`'s own `healMissingVectors` call at
`index.ts:2655` is a completely separate function in a completely separate module with its own
reentrancy flag, `_drainInFlight`, currently exposed only as a boolean via
`isDrainPassInFlight()`, not as an awaitable). A fix that drains only the first seam leaves the
second exactly as exposed as BL-472 found it — so both must be covered.

### `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts` — expose the drain pass as awaitable

`runDrainPassGuarded()` (lines 2684-2723) already has the reentrancy invariant this needs (only one
pass in flight at a time, tracked by `_drainInFlight`) — it is just never exposed as a `Promise` a
caller outside the function can wait on. Add a module-level promise handle and a new exported wait
function, changing `runDrainPassGuarded` from an `async function` to a plain function that
constructs and returns the same promise it always returned (same external contract: `Promise<void>`,
never throws, resolves once the pass — success or internal catch — has fully settled):

```ts
/** (BL-472) The currently in-flight drain pass, or null. Lets shutdown await
 *  the SAME pass `isDrainPassInFlight()` reports as a boolean, without
 *  polling. Cleared in the pass's own .finally(), same lifetime as
 *  `_drainInFlight`. */
let _drainInFlightPromise: Promise<void> | null = null;

/** (BL-472) Resolve when the currently in-flight drain pass (if any) settles.
 *  Resolves immediately if none is running. Never throws — mirrors
 *  runDrainPassGuarded's own never-throws contract. Available to shutdown
 *  paths; see backend.ts coordinatedShutdown step 0. */
export function waitForDrainSettled(): Promise<void> {
  return _drainInFlightPromise ?? Promise.resolve();
}

export function runDrainPassGuarded(): Promise<void> {
  if (_drainInFlight) {
    _drainDirty = true;
    _drainWakesCoalesced++;
    return Promise.resolve();
  }
  _drainInFlight = true;
  const seq = ++_drainSeq;
  const startedAt = Date.now();
  const p = (async () => {
    try {
      // ...existing try body, UNCHANGED, lines 2694-2719 verbatim...
    } finally {
      _drainInFlight = false;
    }
  })();
  _drainInFlightPromise = p;
  void p.finally(() => {
    if (_drainInFlightPromise === p) _drainInFlightPromise = null;
  });
  return p;
}
```

This is a mechanical refactor of the function's shape (async-function-body → manually-constructed
promise), not a behavior change — every existing caller (`void
runDrainPassGuarded().finally(scheduleNextDrain)` at lines 2748/2798, and every direct call in
`drain-wake.spec.ts`/`bl328-calibration-observability.spec.ts`/`bl348-stage-isolation.spec.ts`) sees
the identical `Promise<void>` contract. Do not otherwise touch the function's try/catch/finally
bodies, `_drainInFlight` semantics, `_drainDirty` coalescing, or `scheduleNextDrain`/`wakeDrain` — see
"Files that MUST NOT change" below for `wakeDrain` specifically.

### `extensions/bundles/sox-memory-bundle/members/memory-server/src/backend.ts` — the drain call site

- Add `flushPendingEmbeds` to the existing `@adhd/sox-memory-core` import (currently line 33:
  `import { autoBackup, closeAllAdapters, terminateEmbedWorkers, WriteQueue } from '@adhd/sox-memory-core';`).
- Add `waitForDrainSettled` to the existing `./index.js` import (currently line 34:
  `import { getContentAddress, handleToolCall, resolveDbPath, TOOLS } from './index.js';`).
- Add a new exported constant, alongside `SHUTDOWN_SAFETY_NET_MS` /
  `SHUTDOWN_BACKUP_TIMEOUT_MS` (near line 158-165):

  ```ts
  // (BL-472) Bounded best-effort drain for in-flight Phase-B embed work AND any
  // in-flight background heal/drain pass, before shutdown tears down the
  // shared embed workers / adapter. See Decision D1 for the budget
  // derivation. Deliberately smaller than SHUTDOWN_BACKUP_TIMEOUT_MS: this
  // step runs FIRST, before every other shutdown step, so a generous budget
  // here starves everything after it of the SHUTDOWN_SAFETY_NET_MS envelope.
  export const SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS = 750;
  ```

- Insert a new **step 0**, immediately before the existing step 1 (`terminateEmbedWorkers()`, current
  line 258-264) — i.e. the very first thing `coordinatedShutdown` does after the `_shuttingDown`
  guard, the "shutting down" stderr line, and arming the safety-net timer:

  ```ts
  // 0. (BL-472) Best-effort, BOUNDED drain of BOTH in-flight fire-and-forget
  //    seams schedulePhaseBAndWake can leave running: the Phase-B embed pass
  //    itself (flushPendingEmbeds, embed-pipeline.ts's `inFlight` set) and the
  //    debounced wakeDrain('write') heal-shaped background pass
  //    (waitForDrainSettled, index.ts's `_drainInFlightPromise`) — these are
  //    TWO SEPARATE tracking mechanisms in two separate modules; neither
  //    covers the other. Must run BEFORE step 1: `schedulePendingEmbeds`'s
  //    embed() call depends on the shared fastembed/ONNX worker
  //    terminateEmbedWorkers() is about to kill, and both seams' follow-up
  //    wq.enqueue() calls depend on the adapter closeAllAdapters()/
  //    closeAllForShutdown() are about to close. Draining first gives
  //    in-flight work — already paid for in CPU/ONNX time — a real chance to
  //    land instead of being discarded as E_IO or a worker-terminated
  //    rejection. Bounded so a slow/stuck pass cannot itself blow
  //    SHUTDOWN_SAFETY_NET_MS.
  try {
    const timedOut = await Promise.race([
      Promise.all([flushPendingEmbeds(), waitForDrainSettled()]).then(() => false),
      new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(true), SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS);
        if (typeof t.unref === 'function') t.unref();
      }),
    ]);
    if (timedOut) {
      process.stderr.write(
        `[memory-server backend] Phase-B/heal-drain exceeded ${SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS}ms — ` +
        `proceeding with shutdown; any embedding still in flight is discarded and will be ` +
        `recovered by the next process's healMissingVectors() pass (BL-472)\n`,
      );
    }
  } catch (err) {
    process.stderr.write(`[memory-server backend] Phase-B/heal-drain failed: ${err}\n`);
  }
  ```

  Note this does **not** touch `terminateEmbedWorkers()`, `closeAllAdapters()`,
  `WriteQueue.closeAllForShutdown()`, or the backup step — they are renumbered in comments only
  (step 1 stays step 1, etc. — do not renumber the doc comment's step list at the top of the
  function; just prepend a "0." entry describing the new first step, matching the style already used
  for "2b").

### Files that MUST NOT change, and why

- **`libs/memory-core/src/embed-pipeline.ts`** — `flushPendingEmbeds()` (lines 500-504) is already
  exactly the seam needed: unbounded, idempotent, safe to call with zero in-flight work. The
  boundedness belongs at the *caller* (shutdown has a hard deadline; the six existing test callers
  correctly want an unbounded, deterministic drain and must keep getting one). Adding a timeout
  parameter here would change a widely-used, currently-simple test seam for a single production
  caller's need — do it with `Promise.race` in `backend.ts` instead, per Decision D1.
- **`libs/memory-core/src/write-queue.ts`** — `closeAllForShutdown()` and `clearInstances()` stay
  unconditional closers. See Decision D3: the drain is layered in *front of* the whole
  `coordinatedShutdown` sequence, not spliced into `WriteQueue`'s own close methods. `write-queue.ts`
  cannot import `embed-pipeline.ts` without first checking for a cycle
  (`embed-pipeline.ts:73` already does `import type { WriteQueue } from './write-queue.js'`) — routing
  the fix through `write-queue.ts` would require breaking that existing direction of dependency for
  no benefit, since `backend.ts` already imports both and is one layer up from both, exactly where
  the BL-472 filer's own note says the fix belongs ("the drain has to happen one layer up, in
  backend.ts's coordinatedShutdown").
- **`extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts`** —
  `schedulePhaseBAndWake` (lines 2822-2838) and `wakeDrain` (lines 2779-2802) stay fire-and-forget and
  otherwise unchanged — including the debounce, coalescing, and BL-154 safety argument in `wakeDrain`'s
  doc comment. Making either awaited would reintroduce the exact per-write latency regression the
  two-phase write was built to eliminate (`embed-pipeline.ts:1-9`, the 2026-07-04 incident) or, for
  `wakeDrain`, would violate property (b) in its own doc comment (lines 2764-2767: "THIS FUNCTION
  NEVER RUNS WORK. It only arms a timer" — that is what makes it safe to call from anywhere). The ONLY
  change in this file is making `runDrainPassGuarded`'s already-existing promise awaitable from
  outside — everything upstream of it (what triggers a pass, when, how often) is untouched. Do not
  touch `scheduleNextDrain`, `nextDrainDelayMs`, or the `DEFAULT_DRAIN_WAKE_DEBOUNCE_MS`
  constant/env override.
- **`WriteQueue.clearInstances()`** (`write-queue.ts:451-459`) — left unchanged. It is test-only,
  every test that cares about a clean Phase-B drain before resetting instances already calls
  `flushPendingEmbeds()` explicitly first (six files, cited above), and no production code path calls
  it. Changing its behavior is out of scope and orthogonal to the production data-loss bug BL-472
  reports. Do not "fix" it as a drive-by — that would touch a widely shared test-teardown helper used
  by every memory-core spec file for a bug that does not reach it.

## 3. Every decision, ruled

**D1 — Where does the bound live, and what is its value?**
Ruling: a local `Promise.race([flushPendingEmbeds(), timeout])` inside `coordinatedShutdown`, budget
`SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS = 750`.
- *Losing alternative: add a `timeoutMs` param to `flushPendingEmbeds()` itself.* Loses because it
  forces every one of the six existing test call sites to reason about a timeout they don't want
  (tests need deterministic, unbounded drain for assertions to be meaningful) and because
  `embed-pipeline.ts` has no concept of `SHUTDOWN_SAFETY_NET_MS` — that constant lives in
  `backend.ts` and importing it backward would invert the module layering BL-472's own filer
  described.
  *Losing alternative: no bound, `await Promise.all([flushPendingEmbeds(), waitForDrainSettled()])`
  directly.* This is the exact hazard the task brief calls out — a 240s `healMissingVectors()` pass
  (bounded by `SOX_EMBED_HEAL_TIME_BUDGET_MS`, `embed-pipeline.ts:193-200`) awaited via
  `waitForDrainSettled()` (see D2) could keep `coordinatedShutdown` stuck on step 0 for up to four
  minutes: the safety-net `setTimeout` still fires and force-exits at 4000ms regardless, but every
  step behind an unbounded drain (adapter close, WAL checkpoint, backup) would then never run at all,
  turning a data-loss-avoidance fix into a WAL-corruption risk — strictly worse than the bug it fixes.
  *Value 750ms, not e.g. 2000ms or 100ms:* `embed-pipeline.ts:5-8`'s own doc comment documents ONNX
  embed latency as "~50-100ms warm, ~0.75s+ under CPU contention" for a single item — 750ms covers
  that documented worst case for the common single-in-flight-write shutdown race with margin, while
  leaving comfortable room ahead of it: `SHUTDOWN_BACKUP_TIMEOUT_MS` (2500) + typical
  `terminateEmbedWorkers`/`closeAllAdapters`/`closeAllForShutdown` cost must still fit under
  `SHUTDOWN_SAFETY_NET_MS` (4000) for a normal shutdown to finish gracefully rather than being force-
  exited by the safety net. 750 + up-to-1000 (`TERMINATE_GRACE_MS` in
  `sharedFastembedProcess.ts:363`) + up-to-2500 (backup) already sums to 4250, i.e. *tighter* than
  4000 in the worst theoretical case — which is fine, because the safety net exists precisely to
  force-exit exactly that pathological case cleanly (`exit(0)`, not a crash), and 750ms is small
  enough that the overwhelmingly common case (0 or 1 in-flight embeds, warm model) finishes in single-
  digit milliseconds, not anywhere near the budget. A larger value (2000ms) would make the
  pathological-overlap case routinely hit the safety net instead of rarely; a smaller value (100ms)
  would frequently discard the exact "just-computed embedding" case BL-472 exists to save, since even
  the WARM case can hit 100ms.
- *Losing alternative: size the budget dynamically off `inFlight.size` at call time.* Rejected as
  needless complexity for a best-effort mitigation — the task brief and the backlog item both frame
  this as "one bounded-race away from being clean," not a durability guarantee, and a fixed constant
  is trivially testable with fake timers (see acceptance criteria) where a dynamic one is not.

**D2 — Does the drain also have to bound the debounced `wakeDrain('write')`/heal pass BL-472 mentions?**
Ruling: **yes, and it needs real code, not just a citation** — verified by reading, not assumed.
`grep -n "track(" libs/memory-core/src/embed-pipeline.ts` returns exactly **one** call site (line
600, inside `schedulePendingEmbeds`). `healMissingVectors`/`_healMissingVectorsPass`
(`embed-pipeline.ts:645-704`+) is never passed through `track()` and therefore never appears in
`inFlight` — `flushPendingEmbeds()` cannot see it, full stop. Its caller,
`runDrainPassGuarded()` (`index.ts:2684-2723`), is a *second, independent* fire-and-forget entry
point (`void runDrainPassGuarded().finally(scheduleNextDrain)`, lines 2748/2798) with its own
reentrancy flag `_drainInFlight`, currently exposed only as the boolean `isDrainPassInFlight()` — no
existing seam lets a caller *await* the in-flight pass. This is exactly the second mechanism BL-472's
citation names ("or the debounced heal-shaped drain") and it is not covered for free by anything
`flushPendingEmbeds()` does.
  - *Losing alternative: route `healMissingVectors`'s applies through `embed-pipeline.ts`'s existing
    `track()`, so `flushPendingEmbeds()` covers both.* Loses because `track()`/`inFlight` tracks
    individual `wq.enqueue` apply promises one at a time as they're issued from inside a `for` loop
    already in progress (`schedulePendingEmbeds`'s `run` IIFE, lines 542-598) — retrofitting the same
    shape onto `_healMissingVectorsPass`'s scan-then-apply-many loop changes a heavily-commented,
    reentrancy-guarded function (`_drainNoProgress` backoff, BL-339 kill-switch, BL-434 trace-id
    plumbing) for a caller (shutdown) that only needs "is a pass currently running, and when does it
    finish" — a coarser question `runDrainPassGuarded`'s own existing reentrancy flag already answers
    with less blast radius.
  - *Chosen alternative: expose `runDrainPassGuarded`'s own promise as an awaitable
    (`waitForDrainSettled()`, see §2 index.ts changes) and race it alongside `flushPendingEmbeds()`
    in backend.ts's step 0.* Minimal, uses the reentrancy machinery `runDrainPassGuarded` already has,
    and does not touch `embed-pipeline.ts`'s already-widely-relied-on `track()`/`inFlight` contract
    that six spec files depend on for their own explicit pre-`clearInstances()` flush.
  - Note what this does NOT need to solve: a *newly arriving* wake — `wakeDrain()` called after step 0
    has already started racing — is not covered, and does not need to be. `wakeDrain`'s debounce timer
    is `unref()`'d (`index.ts:2800`) so it cannot itself delay `exit()`, and by the time it could fire
    (250ms+ after the write that triggered it) `terminateEmbedWorkers()`/adapter-close have very likely
    already run — that write's vector is deferred to the NEXT process's heal pass exactly as
    `embed-pipeline.ts:48-56`'s documented FAILURE/RETRY contract already promises. Step 0 only needs
    to drain what is *already running*, not preempt everything that could ever be scheduled — an
    unbounded "wait for the drain to go permanently idle" would defeat the whole point of D1's bound.

**D3 — Fix `coordinatedShutdown` only, or also `WriteQueue.clearInstances()`?**
Ruling: `coordinatedShutdown` only. See §2 "Files that MUST NOT change" for the full reasoning —
`clearInstances()` is test-only, never reached in production, and every test that needs a clean
drain-then-reset already calls `flushPendingEmbeds()` explicitly first. Splicing a drain into
`clearInstances()` would require `write-queue.ts` to import `embed-pipeline.ts`, which would create a
cycle with `embed-pipeline.ts`'s existing `import type { WriteQueue } from './write-queue.js'`
(line 73) — a real architectural cost for zero production benefit.

**D4 — Where in the step sequence does the drain go: before step 1, or between steps 1 and 2?**
Ruling: before step 1 (the very first action `coordinatedShutdown` takes, ahead of even
`terminateEmbedWorkers()`). See §1's "worker-teardown race" — `SharedFastembedProcessClient.terminate()`
actively rejects in-flight calls (`sharedFastembedProcess.ts:337-339`), so an in-flight `embed()` call
cannot survive step 1 regardless of what happens to the adapter afterward. Placing the drain between
steps 1 and 2 would still leave every in-flight Phase-B embed rejected by the worker teardown before
the drain ever got a chance to wait for it — it would look like a fix and pass a same-day smoke test
(worker-teardown races are lower-probability than adapter-close races in that class of test) while
leaving half the bug live. This is exactly the "getting the budget/sequencing wrong is a real defect"
warning in the task brief.

**D5 — Log the timeout, or stay silent?**
Ruling: log on timeout (stderr, matching the existing style of every other step's failure log in
`coordinatedShutdown`, e.g. lines 249-253, 271-272, 283-284, 302-306). A timed-out drain is the exact
"unnecessary log noise on every graceful restart under write load" the backlog item itself already
accepts as the residual cost of the bounded design — but the *event* (budget exceeded, work
discarded, will self-heal) must remain observable, per the repo's BL-399 "a failure this consequential
must not vanish" pattern already codified in `closeAllForShutdown`'s own doc comment (write-queue.ts:495-497).
Do not log on the non-timeout path — a `flushPendingEmbeds()` that resolves with `inFlight.size === 0`
immediately (the overwhelming common case, no write in flight) must not add a log line to every single
graceful shutdown.

## 4. Acceptance criteria (each names a BL-id, each has a stated RED arm)

Criteria 1-4 live in
`extensions/bundles/sox-memory-bundle/members/memory-server/src/bl472-shutdown-drain.spec.ts` (new
file — model its mocking harness directly on the existing sibling `backend-shutdown.spec.ts` in the
same directory, which already mocks `closeAllAdapters`/`terminateEmbedWorkers`/`autoBackup`/
`WriteQueue.closeAllForShutdown` via `vi.mock('@adhd/sox-memory-core', ...)` + `vi.hoisted(...)`; add
`flushPendingEmbeds` to that same `@adhd/sox-memory-core` mock map, AND mock `waitForDrainSettled`
from `./index.js` the same way — `backend.ts` already statically imports `handleToolCall` etc. from
`./index.js`, so add a second `vi.mock('./index.js', ...)` alongside the existing
`vi.mock('@adhd/sox-memory-core', ...)`, forwarding every other export via `importOriginal` exactly
like the `WriteQueueProxy` pattern at lines 41-63 does for the memory-core mock).

1. **[BL-472 ordering]** `coordinatedShutdown` awaits BOTH `flushPendingEmbeds()` and
   `waitForDrainSettled()` and both resolve BEFORE `terminateEmbedWorkers()` is called.
   - RED arm: on the pre-fix code (no step 0), mocked `flushPendingEmbeds`/`waitForDrainSettled` that
     resolve only after an external `release()` is called would never be awaited at all —
     `terminateEmbedWorkers` fires immediately, with the mocks' resolution having no effect on
     ordering. Assert (mirroring `backend-shutdown.spec.ts:104-157`'s pattern): with both mocks held
     open, `events` must equal `[]` (nothing has run yet) immediately after starting
     `coordinatedShutdown(...)`, then equal `['flushPendingEmbeds', 'waitForDrainSettled']` (order
     between these two is not itself load-bearing — assert as a Set/sorted comparison if the
     implementation races them via `Promise.all`, since both start synchronously in the same tick)
     after a microtask flush and BEFORE `release()`, and `mockTerminateEmbedWorkers` must have zero
     calls at that point. This fails red on unfixed code because `terminateEmbedWorkers` would already
     be in `events` with neither drain entry present (the mocks are simply never invoked).

2. **[BL-472 bounded]** `flushPendingEmbeds`/`waitForDrainSettled` mocks that never resolve do not
   block shutdown past `SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS`, and `terminateEmbedWorkers`/
   `closeAllAdapters`/`closeAllForShutdown`/`exit` all still run. Test this with EACH of the two mocks
   hung independently (two sub-cases) — a bug that races only one of the two promises correctly and
   awaits the other unboundedly must be caught by whichever sub-case exercises the unbounded one.
   - RED arm: this criterion has no pre-fix equivalent to fail against gracefully — on unfixed code,
     since neither function is ever called, this test would trivially "pass" for the wrong reason
     (nothing ever awaits the hung mock). Therefore this criterion's red arm is proven differently:
     assert it FAILS if the implementation uses an unbounded `await Promise.all([flushPendingEmbeds(),
     waitForDrainSettled()])` instead of the `Promise.race`-with-timeout shape — with
     `vi.useFakeTimers()`, advance time by `SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS + 10` and assert
     `mockTerminateEmbedWorkers` HAS now been called; an unbounded-await implementation fails this
     specific assertion because `terminateEmbedWorkers` would still show zero calls at that point
     (proves boundedness, not mere presence). Additionally assert
     `SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS < SHUTDOWN_SAFETY_NET_MS` and
     `SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS + 1000 /* TERMINATE_GRACE_MS */ + SHUTDOWN_BACKUP_TIMEOUT_MS`
     stays within a documented margin of `SHUTDOWN_SAFETY_NET_MS` (a numeric sanity assertion,
     mirroring `backend-shutdown.spec.ts:236-237`) — this is a real behavioral guard, not decoration:
     it fails if a future edit raises the constant without reconsidering the budget.

3. **[BL-472 idempotent-safe]** The new step does not break `coordinatedShutdown`'s existing
   idempotency guarantee (`backend-shutdown.spec.ts:159-172`'s test) — SIGTERM and SIGINT firing
   together still run `flushPendingEmbeds`/`waitForDrainSettled` (and every subsequent step) exactly
   once each.
   - RED arm: extend the existing "is idempotent" test to also assert `mockFlushPendingEmbeds` and
     `mockWaitForDrainSettled` were each called exactly once. This is red only if the implementer's
     step 0 is placed outside the `_shuttingDown` guard (e.g. accidentally before the `if
     (_shuttingDown) return;` check) — a plausible mis-placement given step 0 is now the very first
     line of real work in the function; the guard sits above it and must stay above it.

4. **[BL-472 drain-pass seam, real component]** `runDrainPassGuarded()`'s promise is genuinely
   awaitable from outside via `waitForDrainSettled()` — proves the `index.ts` refactor didn't just
   change the function's shape but actually preserved/exposed the right promise.
   - New/extended case in `drain-wake.spec.ts` (the existing home for `runDrainPassGuarded`/
     `isDrainPassInFlight` coverage — do not create a second file for this, extend the existing one
     per its own "RED→GREEN PROCEDURE ACTUALLY PERFORMED" convention at the top of the file). Use a
     `DeterministicTestProvider` subclass whose `embedSingle` blocks on a controllable deferred (same
     shape as criterion 5 below) so `runDrainPassGuarded()`'s underlying `healMissingVectors` call
     stays in flight on demand. Call `runDrainPassGuarded()` (not awaited), assert
     `isDrainPassInFlight()` is `true`, call `waitForDrainSettled()` and assert it has NOT resolved yet
     (race it against a short `setTimeout` via `Promise.race`), release the deferred, assert
     `waitForDrainSettled()` NOW resolves, and assert `isDrainPassInFlight()` is `false` again
     afterward.
   - RED arm: on pre-fix code, `waitForDrainSettled` does not exist at all — this is a compile-time
     RED (the test file fails to build/typecheck), which is an acceptable and common RED-arm shape for
     an added-API criterion (equivalent in spirit to the other criteria's runtime RED, just caught one
     stage earlier); confirm it by trying to import `waitForDrainSettled` from `./index.js` before
     writing the implementation and observing the typecheck failure, then implement and re-run.

5. **[BL-472 end-to-end, real components]** A genuine in-flight Phase-B embed, delayed past the point
   where shutdown starts, still lands its `vec_node` row instead of failing with `E_IO`.
   - New file `libs/memory-core/src/bl472-embed-drain-e2e.spec.ts` (memory-core, not memory-server —
     this proves the underlying `flushPendingEmbeds()`/adapter-close race directly against a real
     `WriteQueue` + real SQLite adapter, without needing to spin up the memory-server backend
     process). Use a `SlowProvider extends DeterministicTestProvider` (same subclassing pattern as
     `FailingProvider` in `embed-pipeline-metrics.spec.ts:54-58`) whose `embedSingle` awaits an
     externally-controlled deferred before resolving, registered via `_setEmbedProviderForTest`
     (`libs/memory-core/src/embed.ts:111`, already exported from the package barrel at
     `libs/memory-core/src/index.ts:146`). Sequence: call `memoryWritePhaseA`, call
     `schedulePendingEmbeds` (fire-and-forget, exactly as `schedulePhaseBAndWake` does), THEN — while
     the deferred is still unresolved, simulating shutdown landing mid-embed — run the SAME
     `Promise.race([flushPendingEmbeds(), timeout])` shape step 0 uses, THEN resolve the deferred,
     THEN await the race, THEN call `q.adapter.close()` (mirroring what `closeAllForShutdown` does
     next). Assert: no `E_IO` was thrown anywhere in the sequence, and a direct `SELECT` against
     `vec_node` for the written row (on a connection opened before the close) returns exactly one
     row.
   - RED arm: run the identical sequence WITHOUT the drain step (call `q.adapter.close()` immediately
     after scheduling Phase B, before resolving the deferred) — this must reproduce the literal
     `E_IO: database connection is not open` error text from the backlog citation, caught via the
     `schedulePendingEmbeds` failure path (`out.failed` becomes 1, or the enqueue rejects visibly if
     the test calls the pipeline pieces directly rather than through the never-throws wrapper — choose
     whichever reproduces the exact string for the assertion). This RED-arm run IS the reproduction
     the backlog item's Phase-B stderr excerpt describes; keep it as a `.skip`-free, always-run test
     (not a demonstration script) so a future regression re-trips it.

## 5. Risks

- **Data/dist risk:** none of this touches build artifacts, migrations, or `dist/`. No `nx build` is
  required for verification — only `nx test`. Do not run `nx build memory-server` or `nx build
  memory-core` during this work; there is no reason to and it is destructive per BL-235.
- **Live-store risk:** none of the new/edited tests open `~/.memory/**`. `bl405-checkpoint-real.spec.ts`
  and `backend-shutdown.spec.ts` (the two models for this work) both use `os.tmpdir()`-scoped
  throwaway paths or mocks exclusively — follow the same pattern; never pass `dbPathForBackup` as
  anything but an explicit tmp path or `null` in tests (see `backend.ts:226-241`'s own doc comment on
  why a guessed path is dangerous).
- **Shared global state risk:** `embed-pipeline.ts`'s `inFlight` Set and `write-queue.ts`'s
  `WriteQueue.instances` map are both process-global. The new `bl472-embed-drain-e2e.spec.ts` test
  MUST call `WriteQueue.clearInstances()` in `afterEach` (same as every existing memory-core spec) and
  must not leave a dangling `SlowProvider` registered — call `_setEmbedProviderForTest(null)` in
  `afterEach` unconditionally, even if the test body throws, or every spec file that runs afterward in
  the same worker silently inherits a fake, possibly-hung embed provider. This is the single most
  likely way this change could destabilize the wider suite if done carelessly — model the
  `beforeEach`/`afterEach` teardown pairing exactly on `embed-pipeline-metrics.spec.ts`'s existing
  pattern (`WriteQueue.clearInstances()` + `flushPendingEmbeds()` ordering already proven there).
- **Real regression, not just the new tests, could go red:** `bl405-checkpoint-real.spec.ts` and
  `backend-shutdown.spec.ts` both assert exact event orderings / exact call sequences. Re-run BOTH of
  those files (not just the new one) after the change — `backend-shutdown.spec.ts`'s
  `'sequences shared-worker teardown BEFORE the DB checkpoint...'` test's `events` array assertion
  (line 148-155) will need `'flushPendingEmbeds'` and `'waitForDrainSettled'` entries prepended, and
  its `mockCloseAllAdapters`-delay-based test needs both new mocks added and initialized/reset in
  `beforeEach` (line 77-98) alongside the existing four. `drain-wake.spec.ts` must also be re-run —
  it calls `runDrainPassGuarded()` directly and asserts on its return value/timing in several places;
  the async-function-body → manual-promise-construction refactor in §2 must not change any of those
  observable timings (it is designed not to — assert this by running the file unchanged, not by
  editing its assertions). If the implementer edits `backend-shutdown.spec.ts` or `drain-wake.spec.ts`
  existing assertions to make them pass without a principled reason tied to this spec, that is the
  BL-167 pattern the house rules ban — every edit to those files must be traceable to "step 0 now
  exists and is observable in `events`" or "runDrainPassGuarded's promise is now also stored/exposed,"
  nothing else.
- **`index.ts` refactor risk:** `runDrainPassGuarded` is a heavily-relied-on function (three spec
  files call it directly, per §1's citations, plus two production call sites at lines 2748/2798).
  Changing it from an `async function` to a manually-constructed-promise function is mechanical but
  is exactly the kind of change that's easy to get subtly wrong (e.g. forgetting the `finally` that
  clears `_drainInFlight`, which would wedge every future drain pass behind `_drainInFlight === true`
  forever — a far worse regression than BL-472 itself). Run `drain-wake.spec.ts` and
  `bl328-calibration-observability.spec.ts` and `bl348-stage-isolation.spec.ts` (all three existing
  callers) and confirm they pass UNCHANGED, not just that the new test passes.

## 6. The gate — exact nx targets

Run, in this order, from `/Users/nix/dev/ai/sox-ecosystem/.worktrees/bl472-shutdown-drain`:

```bash
npx nx test memory-core -- --run bl472-embed-drain-e2e.spec
npx nx test memory-core -- --run embed-pipeline-metrics.spec   # regression: shared inFlight/track() seam untouched
npx nx test memory-server -- --run bl472-shutdown-drain.spec
npx nx test memory-server -- --run backend-shutdown.spec       # regression: existing ordering assertions
npx nx test memory-server -- --run bl405-checkpoint-real.spec  # regression: real-WAL checkpoint path untouched
npx nx test memory-server -- --run drain-wake.spec             # regression: runDrainPassGuarded reshape untouched
npx nx test memory-server -- --run bl328-calibration-observability.spec  # regression: another runDrainPassGuarded caller
npx nx test memory-server -- --run bl348-stage-isolation.spec  # regression: another runDrainPassGuarded/flushPendingEmbeds caller
npx nx typecheck memory-core
npx nx typecheck memory-server
npx nx lint memory-core
npx nx lint memory-server
node tools/check-suite-tree-state.mjs --project memory-core
node tools/check-suite-tree-state.mjs --project memory-server
```

Do not pass `--skip-nx-cache`. Do not run `npx nx build memory-core` or `npx nx build memory-server`
at any point in this work — nothing in this spec requires a build, and `nx build` is destructive
(BL-235). Quote the `check-suite-tree-state.mjs` output verbatim alongside every test result reported
back — a green suite without it is not evidence per the house rules.

Full whole-project sweep before handing to review (still no build):

```bash
npx nx run-many -t lint,test,typecheck -p memory-core,memory-server
```

## Acceptance summary for the implementer

You will touch exactly two production files — `backend.ts` (the new step 0 + constant) and `index.ts`
(the `runDrainPassGuarded`/`waitForDrainSettled` reshape, §2) — and add exactly two new spec files
(`bl472-shutdown-drain.spec.ts` in memory-server, `bl472-embed-drain-e2e.spec.ts` in memory-core),
plus extend two existing spec files (`backend-shutdown.spec.ts`'s ordering array/mocks, and
`drain-wake.spec.ts`'s new `waitForDrainSettled` case — both per the Risks section and criterion 4).
If you find yourself wanting to touch `embed-pipeline.ts`, `write-queue.ts`, `wakeDrain`,
`scheduleNextDrain`, `nextDrainDelayMs`, or `index.ts`'s `schedulePhaseBAndWake`, stop and re-read
§2/§3 — those are out of bounds by ruling, not by oversight. Decision D2 already resolved the
"does the heal-shaped drain need draining too" question as yes, in scope, via
`waitForDrainSettled()` — this is not a follow-up item, it is part of BL-472 as scoped in this spec.
