# Theme 1 — A Verification Harness We Can Actually Trust

**Status:** research/design only, no production code written.
**Author:** qa-expert agent, 2026-07-31, branch `wip/turso-live-metrics`.
**Why this exists:** a 12-hour incident (BL-319..BL-339) proved the live memory store was
silently broken for weeks while the test suite reported green. This document is ground truth
on how bad that gap is, an audit of every other place a test can lie, and a concrete design +
sequenced plan for the harness that would have caught it.

All commands below were run with `--skip-nx-cache` on `wip/turso-live-metrics` @ `6cee9d3`.
No `nx build` was invoked on `memory-server`; the live `~/.memory/` store was never touched
(every test file inspected below opens tmp-dir databases only).

---

## A. Ground truth — current state, per project

| Project | Test files | Tests | Result |
|---|---|---|---|
| `memory-core` | 37 files (24 failed, 13 passed) | 466 total: **265 failed**, 193 passed, 8 skipped | RED |
| `memory-server` | 17 files (4 failed, 12 passed, 1 skipped) | 178 total: 8 failed, 168 passed, 2 skipped | mostly GREEN |
| `store-adapter` | 8 files, all passed | 240/240 | **fully GREEN** |
| `analysis` (libs/data) | 1 file, 12/47 failed | RED (same root cause as memory-core) |
| `hybrid-search` (libs/data) | 1/3 files failed, 15/82 failed | RED (same root cause) |
| `task-queue`, `vector-store`, `graph-store`, `blob-store`, `ingest`, `source-provider`, `claim-verification` | all files | all passed (46+25+112+66+123+91+14 = 477 tests) | **fully GREEN** |

**Headline: `memory-core` at 57% pass rate is dragging the whole picture down, but it is
almost entirely one root cause, not 265 independent bugs.**

### A.1 — the 265 failures decompose into essentially one bug (BL-325)

```
101  TypeError: adapter.executeGet is not a function
 51  TypeError: db.prepare is not a function
 49  TypeError: adapter.executeAll is not a function
 14  TypeError: queue.enqueue is not a function
 10  TypeError: adapter.executeRun is not a function
  9  TypeError: tx.executeRun is not a function
  8  TypeError: db.close is not a function
  7  TypeError: queue._setDeadlineBudgetForTest is not a function
  4  TypeError: tx.executeAll is not a function
  4  TypeError: ctx.db.prepare is not a function
  3  TypeError: wq.enqueue is not a function
  3  TypeError: queue._setLogSinkForTest is not a function
  2  TypeError: tx.executeGet is not a function
  2  TypeError: queue.walBytes is not a function
  2  TypeError: db1.prepare is not a function
  1  TypeError: queue.walCheckpoint / _setSlowTaskMinMsForTest / _recordLatencySample / adapter.transaction
```

Every one of these is the same shape: `openDb()` and `WriteQueue.forPath()` became async at
some point, and the call site never added `await`, so `db`/`adapter`/`queue`/`tx` is a `Promise`
and every method call on it throws "`X` is not a function". Grepping for the literal pattern
(`= openDb(` or `= WriteQueue.forPath(` with no `await`, inside a `.spec.ts`) finds it in
**19 files**, matching the incident's own count of ~18:

```
libs/memory-core/src/errors.spec.ts
libs/memory-core/src/concurrency-harness.spec.ts
libs/memory-core/src/write.spec.ts
libs/memory-core/src/embed-pipeline-metrics.spec.ts
libs/memory-core/src/write-pipeline.spec.ts
libs/memory-core/src/reembed.spec.ts
libs/memory-core/src/invalidate.spec.ts
libs/memory-core/src/update.spec.ts
libs/memory-core/src/db.spec.ts
libs/memory-core/src/compaction.spec.ts
libs/memory-core/src/export.spec.ts
libs/memory-core/src/recall.spec.ts
libs/memory-core/src/write-queue.spec.ts
libs/memory-core/src/quota.spec.ts
libs/memory-core/src/embed-provenance.spec.ts
libs/memory-core/src/outbox-queue.spec.ts
libs/memory-core/src/write-queue-backpressure.spec.ts
libs/memory-core/src/backup.spec.ts
libs/memory-core/src/chaos/queue-overflow.chaos.spec.ts
```

`analysis.spec.ts`'s 12 failures are the identical family one layer up: `clusterStore`,
`clusterSubset`, and `detectNearDup` in `libs/data/analysis/analysis/src` all fail with
`TypeError: Cannot read properties of undefined (reading 'nativeVectors')` — a consumer
destructuring a field off what is actually an unresolved `openDb()` Promise. `hybrid-search`'s
15 failures share the same signature. **This is not four separate bugs, it's one bug that
propagates through every consumer of the async `openDb`/`WriteQueue.forPath` contract that
skipped the migration.**

This matters for planning: fixing BL-325 is mechanical (add `await`, fix the resulting type
errors that TS would have caught if specs were typechecked — see §C.3), touches ~19 files, and
should collapse the vast majority of the 265 red tests in one pass. It is not 265 units of
triage work.

**Residual noise observed, not a distinct root cause:** ~40 "`Unhandled Rejection` / `failed to
open database ... I/O error (statfs shared WAL coordination path): entity not found`" lines
scattered through `write.spec.ts`, `concurrency-harness.spec.ts`, `cluster-subset.spec.ts`.
These are async cleanup racing against the primary failure cascade (temp dirs get `rm -rf`'d by
one test's `afterEach` while an orphaned unhandled promise from a sibling failure is still
mid-flight trying to open the now-deleted file). They will very likely evaporate once BL-325 is
fixed and the promise chains resolve cleanly; they are not worth triaging as independent
defects, but re-check after the BL-325 fix lands — if any survive, they're a real teardown-order
bug in their own right.

### A.2 — memory-server's 8 failures are NOT the async-drift bug

```
Test Files  4 failed | 12 passed | 1 skipped (17)
     Tests  8 failed | 168 passed | 2 skipped (178)
```

Failing files: `async-embed.spec.ts`, `memory-tools.spec.ts`, `permission-guard.spec.ts`, and
one more. The dominant signature is `Serialized Error: { code: 'SQLITE_READONLY_DBMOVED' }`
inside `_openDbInner`/`openDb`/`getDb` — a genuinely different bug: something is moving/renaming
the DB file (or its WAL/SHM sidecar) out from under an open handle mid-test. All of these tests
use `fs.mkdtempSync(os.tmpdir())`-scoped databases, not the live store, so this is not
environmental contamination from the concurrent live-recovery work happening elsewhere in this
session. **This needs its own triage as a real, separate defect** — likely a file-handle/rename
race in cleanup or in the async-embed backlog-drain path — and should be filed to BACKLOG.md
distinctly from BL-325 rather than assumed to be the same class.

### A.3 — store-adapter (240/240) and 7 of 10 `libs/data/**` packages are clean

`store-adapter`, `task-queue`, `vector-store`, `graph-store`, `blob-store`, `ingest`,
`source-provider`, and `claim-verification` are fully green — 477 tests, zero failures. This is
important context: **the store-adapter abstraction itself (the thing that owns
`executeGet`/`executeAll`/`executeRun`) is solid and well-tested.** The breakage is entirely at
call sites in `memory-core`/`analysis`/`hybrid-search` that didn't keep up with its async
contract — not in the contract's own implementation. That should shape triage priority: fix the
call sites, don't re-litigate the adapter design.

---

## B. Audit — tests that structurally cannot fail

**A test that cannot fail is worse than no test:** it shows up green in every dashboard,
satisfies coverage tooling, and gets cited by reviewers as "already covered" — while asserting
nothing. This audit went looking for every shape of that failure mode, not just the one already
known.

### B.1 — CONFIRMED: the frozen-`skip` pattern (known, but here's the exact scope)

```js
let hasTurso = false;
beforeAll(async () => { hasTurso = await tursoAvailable(); });
it('...', { skip: !hasTurso }, async () => { ... });
```

Vitest evaluates the `{ skip }` options object during synchronous `describe()` collection —
before any `beforeAll` has run — so `hasTurso` is read at its `false` initializer value and the
skip decision is frozen right there. `beforeAll`'s later assignment is never consulted. Confirmed
present in:

- `extensions/bundles/sox-memory-bundle/members/memory-server/recall-parity.test.ts:139`
- `extensions/bundles/sox-memory-bundle/members/memory-server/heal-backend-agnostic.test.ts:150`

Both files' entire Turso-side assertions have **never executed on any run, ever** — this is a
mechanical, provable fact about Vitest's collection order, not a probabilistic environment
issue. Filed as `DEBT-TEST-VITEST-FROZEN-SKIP-TURSO-001` per the team-lead brief; this document
adds the exact line numbers and confirms no other file shares the exact `beforeAll`+`{skip}`
shape (grep for `skip: !` across the repo found only these two plus the correct/reference
implementations below — no other instance of the frozen pattern exists).

**The correct pattern already exists in-repo** — study, don't reinvent:
- `throughput-golden.spec.ts:40-50` — resolves `_hasTurso` via a **synchronous**
  `fs.existsSync()` check against the known Turso driver path at module load time, before any
  `describe()`/`it()` is collected. No promise, no `beforeAll`, no possibility of the race.
- `turso-clean-room.test.ts` header comment (lines 34-58) explicitly documents this exact bug and
  why it exists — worth reading verbatim, it's the best in-repo writeup of the failure mode.
- `clustering-e2e.test.ts` also uses the sync-resolution pattern.

### B.2 — checked and NOT found (i.e., these hygiene problems do not currently exist)

- **`it.todo`** — zero occurrences repo-wide (excluding `node_modules`).
- **`xit`/`xdescribe`** (Vitest-disabled suites) — zero true positives. The initial grep matched
  5 files but every hit was a substring false-positive on `process.exit(...)`, not the `xit(`
  test-disabling API.
- **Empty test bodies** (`it('...', () => {})`) — zero occurrences.
- **`if (false)` dead branches wrapping assertions** — zero occurrences.
- **BL-167-style guard-skips-the-named-case** (a conditional inside `it()` that skips exactly the
  assertion the test's name claims to cover, e.g. the historical `hasChannelSignal` guard) — no
  new instance found. `migration.test.ts:403` has a comment referencing a past `SKIP_TABLES`
  bug but the code there is a regression-test *for* that fix, not a live instance of it.

### B.3 — lower-severity, worth a note but not urgent

- **Empty `catch {}` blocks inside spec files** — 4 occurrences across
  `libs`/`extensions` specs. Each needs individual review: a swallowed error in test *cleanup*
  code (e.g. `try { fs.rmSync(...) } catch {}`) is fine and idiomatic (seen throughout
  `throughput-golden.spec.ts`); a swallowed error around the actual *assertion* under test is a
  test that cannot fail. None of the 4 found were in assertion position — all were in
  `afterEach`/cleanup helpers. No action needed, but flag for anyone adding new specs: `catch {}`
  belongs in teardown only, never around the call being tested.

**Net finding for B: the known frozen-skip bug (2 files) is real and severe, but it is not
symptomatic of a wider pattern in this codebase.** The rest of the suite does not show the
xit/todo/empty-body/dead-branch forms of "cannot fail." That's a genuinely different risk
profile than "265 red tests" suggested at first glance — the volume problem (§A) and the
lying-tests problem (§B) are two separate, mostly disjoint issues here, and the second is much
smaller than feared. Don't let the size of §A make you assume §B is proportionally large; it isn't.

### B.4 — the harness itself needs a permanent guard against B.1 recurring

Because the frozen-skip bug is about *Vitest semantics*, not this codebase's discipline, a new
contributor can reintroduce it tomorrow without knowing better. The harness design in §C includes
a lint rule for this specifically (§C.1).

---

## C. Harness design — what should exist

### C.1 — Structural guard against "cannot fail" tests (do this first, it's cheap)

A repo-local ESLint rule (or a `scripts/audit-test-integrity.mjs` CI check, cheaper to ship
first) that:
1. Flags any `it(...)` / `test(...)` call whose options object contains `skip:` where the
   right-hand side is not a `const`/module-scope value resolved synchronously before the first
   `describe()` — i.e., flags any `skip: <identifier>` where `<identifier>` was last assigned
   inside an `async` function or a `beforeAll`. This directly prevents B.1 from recurring anywhere
   else in the repo, not just in the two known files.
2. Flags `it.todo` and `xit`/`xdescribe` repo-wide with a required justification comment
   (`// TODO-TEST(BL-xxx): reason`) — currently zero hits, keep it that way structurally rather
   than by vigilance.
3. Flags empty `it()` bodies and `catch {}` wrapping an `expect(...)` call directly (not in
   teardown).

This is standalone, ships independent of anything else in this plan, and turns §B from "an audit
someone did once" into "a gate that runs forever."

### C.2 — Cross-backend contract suite, structurally incapable of silently skipping

Requirement: every test that claims to cover both SqliteAdapter and TursoAdapter must prove it
ran against both, every run, in CI output — not "ran against whichever was available." Design:

- **Two Vitest projects, not one file with a runtime branch.** `store-adapter` already models
  this correctly with `contract.test.ts` — a single test module parameterized and instantiated
  twice, once per adapter, via `describe.each` or two explicit `describe()` blocks each importing
  a concrete adapter constructor. Neither branch is conditional; if Turso's native module is
  missing, the Turso `describe()` block's `beforeAll` should **throw**, not skip — a missing
  driver in CI is a CI-environment defect, not a reason to silently pass. (Contrast: local dev
  machines without the Turso native build are a legitimate reason to skip locally — but that
  decision must be made by an env-gated top-level CI job selection, e.g. a nx tag, never inside
  the test file's `skip:` logic.)
- **Concretely:** promote `turso-clean-room.test.ts`'s pattern (fresh DB, schema-creation
  assertions, real write, real recall, real embed-throughput) to the canonical contract suite,
  and retire `recall-parity.test.ts`/`heal-backend-agnostic.test.ts` by rewriting them onto the
  same sync-resolution pattern (or deleting them once their assertions are subsumed —
  `clustering-e2e.test.ts` already duplicates much of what they were trying to cover, correctly).
- **Assertions this suite must carry** (currently proven only in `turso-clean-room.test.ts`,
  should be the permanent minimum bar for "a storage backend is production-ready"):
  1. Schema creation on a fresh file creates every required table/index (`node`, `edge`,
     `vec_node`, `fts_node` + FTS5 shadow tables, `memory_scope`, `sox_store_meta`,
     `organizer_queue`).
  2. A write through the real MCP tool surface (`handleToolCall('memory_write')`, not
     memory-core internals directly) lands a row.
  3. The embedding actually lands in the vector table with the correct byte length for the
     configured dimension.
  4. `memory_recall` WITH and WITHOUT a `query` both complete successfully against a clean store
     (this is the exact reproduction harness for the 2026-07-30 incident's two live failures).
  5. Real embedding throughput using the real provider, not `DeterministicTestProvider` (hash
     provider measures hashing speed, not the ONNX/CoreML path production actually runs).

### C.3 — Typecheck coverage for specs (mechanical, high leverage, currently zero)

Confirmed: both `tsconfig.lib.json` and `tsconfig.typecheck.json` at repo root exclude
`*.spec.ts`/`*.test.ts`. This is exactly why BL-325's `await`-drop went undetected for 18+ files
— TypeScript would reject `db.prepare(...)` on a `Promise<Database>` at compile time, but nothing
ever compiles the specs. Per the existing repo-wide `⛔ AGENT CONSTRAINT — BUILD VIA NX TARGETS`
guidance (typecheck is not optional, and no esbuild-bundled project ever typechecks specs either),
add a separate `typecheck-tests` nx target per project (mirroring the intent already stated in
CLAUDE.md for `typecheck` targets generally) that:
- Includes `**/*.spec.ts`, `**/*.test.ts`.
- Runs `tsc --noEmit` against them with the same `strict`/`noUnusedLocals` settings as the lib
  tsconfig.
- Is added to the whole-repo gate (`nx run-many -t build,lint,test,typecheck,typecheck-tests`)
  but kept as its own target so a spec-only failure doesn't get conflated with a production-code
  typecheck failure in CI triage.

This single target, run once, would have caught essentially all 265 red memory-core tests and
the 27 in analysis/hybrid-search **before any of them ran** — as compile errors, with file:line,
not as 265 separate runtime stack traces to individually triage. This is the highest-leverage,
lowest-effort item in this entire plan.

### C.4 — Crash-recovery test (SIGKILL under write load)

**This requirement is already tracked as BL-338's acceptance criteria** ("a crash-recovery test —
SIGKILL the server under sustained write load, restart, assert zero lost committed writes,
integrity_check clean or auto-repaired, damage/repair visible without human investigation") —
this section is the concrete design for satisfying that acceptance test, not a new requirement.
Does not exist today; `chaos/kill9-recovery.chaos.spec.ts` exists as a **file** but needs
verification of what it currently asserts (it's one of the 24 failing memory-core files, so
either it's failing for the async-drift reason like everything else, or it's failing for real —
this needs first-pass triage to determine which, since it's exactly the test category the recent
crash incident showed we don't have confidence in).

Design for what this test must do, once verified/rebuilt:
1. Spawn `memory-server` (or a minimal harness invoking the same `WriteQueue`/adapter path) as a
   real child process, not an in-process mock — a `kill -9` on an in-process function call proves
   nothing about actual OS-level process death mid-`fsync`.
2. Drive sustained concurrent writes (mirroring `concurrency-harness.spec.ts`'s multi-writer
   pattern, which already exists and is a good model for generating write pressure).
3. At a randomized point after N committed writes, `SIGKILL` the child.
4. Reopen the store and assert:
   - Every write that received a successful response before the kill is present (zero lost
     committed writes — this is the actual SQLite/Turso durability contract under test).
   - `PRAGMA integrity_check` (sqlite) / the equivalent Turso check (see C.5) reports clean, OR
     the store's own auto-repair path (if the roadmap adds one — currently BL-335..BL-338
     document that no automated recovery exists) brings it to a clean state without manual
     intervention.
5. Repeat across multiple kill points (mid-write, mid-WAL-checkpoint, mid-vacuum) — a single
   kill point under-tests this; timing matters enormously for WAL-mode SQLite.

This is a **nightly/heavy-tier** test (spawns a real process, needs to run repeatedly across
timing windows to get coverage) — see §C.6 for tiering.

### C.5 — Integrity assertions usable after any bulk/restore/migration path

`PRAGMA integrity_check` caps at 100 result messages — **a single run understates damage** on a
badly corrupted store (the exact failure mode the incident produced: a store could have 500+
integrity violations and the check would report only the first 100, making it look "less broken"
than it is). `backup.ts` already runs `integrityCheck` after `VACUUM INTO` (lines 59-60, 196-197)
but does not appear to iterate past the cap. Harness requirement:

- Wrap `PRAGMA integrity_check` in a loop: if the result set returns exactly 100 rows (the cap),
  re-run in `PRAGMA integrity_check(N)` chunked mode or use `PRAGMA quick_check` first to
  determine severity class before falling back to exhaustive enumeration, and report a
  **damage-count lower bound with an explicit "capped, more may exist" flag** rather than a
  false "100 issues" number that looks bounded.
- Apply this integrity assertion as a **required post-condition** after: `backup.ts`'s
  VACUUM INTO, any migration path (`store-adapter/src/__tests__/migration.test.ts`,
  `migration-e2e.test.ts` — both currently green and a good model), and the crash-recovery test
  in C.4.
- For Turso specifically: confirm what integrity-check equivalent exists (libsql doesn't
  necessarily expose the same PRAGMA) — this needs a spike, flag explicitly as **open question**,
  don't assume parity with sqlite here.

### C.6 — CI tier placement

| Tier | Contents | Trigger | Rationale |
|---|---|---|---|
| **PR gate (fast)** | `store-adapter` contract suite (both backends, ~1s per the measured run above), `memory-core`/`memory-server` unit specs, `typecheck-tests` (C.3), the test-integrity lint (C.1) | every push | All currently run in seconds; typecheck-tests is pure compile time. |
| **PR gate (medium)** | `clustering-e2e.test.ts`-style real-embedding tests | every push, but as a separate job so a 10-15s/30-episode cost doesn't block fast feedback | Real-embedding tests are the only thing that catches embed-backend regressions like the 25x throughput drop — cannot be skipped, but can run in parallel with the fast tier. |
| **Nightly/heavy** | Crash-recovery (C.4, spawns real processes, needs multiple kill-point iterations), performance baseline gate (C.7, needs stable/quiet machine for reliable numbers), soak tests (`soak.spec.ts` already exists — verify it's not just another async-drift casualty) | nightly cron | Too slow/noisy for per-PR; regressions here are still caught within 24h, which is the entire gap that let the 25x throughput regression go unnoticed indefinitely — nightly closes that gap even without perfect PR-time coverage. |

### C.7 — Performance baseline gate

Nothing currently tracks embed throughput, recall latency, or write throughput as a *gate* — the
25x regression (0.13/sec live vs ~2.1-2.8/sec clean-room) was invisible precisely because no test
asserted a floor. `throughput-golden.spec.ts` already exists and is the right foundation — it
measures `throughput_writes_per_sec` on both adapters with documented conservative thresholds
(0.1 sqlite, 0.5 turso). Extend this pattern, don't invent a new mechanism:

- Add an embed-throughput assertion (embeds/sec against the real provider) parallel to the
  existing write-throughput one — this is the exact metric that regressed 25x and went unnoticed.
- Add a recall-latency assertion (p50/p95 over N queries against a store of realistic size, not
  an empty fresh DB — the incident's corruption was invisible on small test stores).
- Thresholds should be "conservative enough not to flake on CI hardware variance" (as the
  existing file's comments already reason about) but tight enough to catch a 25x-class
  regression — a 2-3x margin, not 20x.
- This is nightly-tier (C.6) since real-embedding runs are ~10-15s/30 episodes and a realistic
  recall-latency measurement needs a non-trivial store size, but the threshold values should be
  visible in a dashboard/log artifact reviewable per-day, not buried in a pass/fail bit.

---

## D. Sequenced plan — 265-red to a trustworthy gate

Ordered by dependency and leverage, not by file count. Effort is rough (solo agent, mechanical
work assumed once root cause is confirmed).

1. **Ship the typecheck-tests target (C.3).** ~2-4h. Zero judgment calls — add the tsconfig
   include, wire the nx target, run it, and you get the BL-325 file list with exact
   file:line:column for every broken call site, superseding the grep-based list in §A.1. This is
   the single highest-leverage step: it turns "265 failing tests, unclear how many root causes"
   into "N compile errors in M files," and gives a Fix-It punch list for step 2 for free.

2. **Fix BL-325 (missing `await` on `openDb`/`WriteQueue.forPath`) across the 19 confirmed
   files, plus `analysis.spec.ts`/`hybrid-search.spec.ts`'s consumers of the same pattern.**
   ~1-2 days. Mechanical: add `await`, let the typechecker from step 1 confirm each fix, re-run
   the specs. This should collapse ~250-260 of the 265 memory-core failures and all 27 in
   analysis/hybrid-search. **Do not fix by loosening types or adding `as any`** — every one of
   these is a genuine bug (the code path really was calling methods on an unresolved Promise in
   production, not just in tests, wherever the same call pattern exists outside spec files —
   audit for that too as part of this step, since a spec catching this only proves the *test*
   awaits correctly, not that production code does).

3. **Triage memory-server's 8 `SQLITE_READONLY_DBMOVED` failures as a separate, real bug (§A.2).**
   ~half day to a day depending on root cause depth. File to BACKLOG.md distinctly from BL-325 —
   do not fold it into the same fix, the error signature and file (`_openDbInner`) are unrelated
   to the await-drift pattern.

4. **Ship the test-integrity lint rule (C.1).** ~half day. Independent of 1-3, can run in
   parallel. Immediately neutralizes recurrence of the frozen-skip bug pattern anywhere in the
   repo, not just the two known files.

5. **Fix/retire the two frozen-skip files (B.1) using the throughput-golden.spec.ts sync-resolve
   pattern**, and use the same pass to promote turso-clean-room.test.ts to the canonical
   cross-backend contract suite (C.2). ~1 day. This is where "has Turso ever actually been
   tested end-to-end" changes from "no, provably, for two dedicated suites" to "yes, and it can't
   silently regress to no again" (enforced by step 4's lint rule).

6. **Verify `kill9-recovery.chaos.spec.ts`, `disk-full.chaos.spec.ts`, `soak.spec.ts` are not
   just more async-drift casualties**, then build out C.4 (real-process SIGKILL harness) and
   C.5 (integrity-check-with-cap-handling) properly. ~2-3 days — this is genuinely new
   engineering, not mechanical cleanup, and needs judgment about kill-point timing and Turso's
   integrity-check equivalent (open question, needs a spike first).

7. **Build the performance baseline gate (C.7)** by extending `throughput-golden.spec.ts` with
   embed-throughput and recall-latency assertions. ~1-2 days once step 6's real-process
   infrastructure exists (recall-latency at realistic scale benefits from the same store-sizing
   groundwork).

8. **Wire CI tiering (C.6)** — fast/medium/nightly job split. ~half day, purely
   plumbing once 1-7 exist; do this last so tiering decisions are based on real measured
   durations rather than guesses.

**What NOT to fix, explicitly:**
- The `catch {}` blocks found in §B.3 — all four are legitimate teardown code, not lying tests.
  Don't touch them; a lint rule requiring justification comments here would just be noise.
- `migration.test.ts:403`'s `SKIP_TABLES` comment — it documents a *past* bug, the current code
  is a regression test that already passes for the right reason. Nothing to change.
- Do not attempt to make `recall-parity.test.ts`/`heal-backend-agnostic.test.ts` pass as-is by
  just fixing the `skip:` logic in place — their Turso-side assertions were never exercised, so
  there's no evidence what they assert is even still correct against the current schema. Rewrite
  them onto `turso-clean-room.test.ts`'s pattern (step 5) rather than patch-and-trust.

---

## Bugs/deferrals discovered during this research

Dedup pass against BACKLOG.md before filing (per repo convention — search by symptom/file, not
title): the memory-server `SQLITE_READONLY_DBMOVED` failures (§A.2) are **already tracked as
BL-324** (same 4 files, same error signature) — not refiled. The crash-recovery test requirement
(§C.4) is **already tracked as BL-338**'s acceptance criteria — §C.4 above is the concrete design
for satisfying it, not a new item. Two genuinely new gaps were found and filed as BL-340/BL-341
(see BACKLOG.md for full citations and acceptance criteria):

- **BL-340** — no `typecheck-tests` nx target exists anywhere in the repo; both
  `tsconfig.lib.json` and `tsconfig.typecheck.json` exclude `*.spec.ts`/`*.test.ts`, which is the
  direct reason BL-325's 18-file `await`-drop shipped undetected (§C.3).
- **BL-341** — `PRAGMA integrity_check`'s 100-message cap is not handled in `backup.ts`'s
  post-VACUUM-INTO verification, and it's unknown whether Turso/libsql exposes an equivalent
  check at all — both need resolving before C.5's integrity-assertion harness can be built for
  both backends (§C.5).
