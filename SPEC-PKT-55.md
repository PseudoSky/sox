# SPEC — PKT-55 (BL-202): suite-count variance is inadmissible evidence

Architect stage output. Implementer: read this whole document before touching anything. Every
decision below has been ruled on — if you hit a fork this document doesn't cover, that is a bug in
this spec; escalate rather than guessing.

## 0. What I actually found vs. what the packet described

The packet brief for this task ("three runs of the same config returned 109/95/91 failures,
`statement has been finalized`, `cannot start a transaction within a transaction`") does not match
the content of the `BL-202` node currently in the backlog graph, which I read directly via
`backlog_get_item(repo: "sox-ecosystem", humanId: "BL-202")`. That node's title and body describe a
**different, narrower** symptom: `export.spec.ts:149` (per-topic INDEX ordering) and
`concurrency-harness.spec.ts` failing **once each**, under concurrent-suite CPU load, and its own
triage conclusion is **"NOT REPRODUCIBLE — ~30+ runs across serial/parallel/24-27-busy-loop CPU
oversubstription produced zero failures. Do not fix until it reproduces."** The `109/95/91` figures
and the two specific SQLite error strings do not appear anywhere in the stored `BL-202` node.

I am not able to reconcile this without more information than either document contains, so I
investigated empirically rather than assuming either description is authoritative, and I am
reporting exactly what I measured. This is not deflection — see §1 for a root cause I verified
directly, with a fix, that is squarely in the "same config, different result" class the packet
describes, plus honest negative evidence for the specific error strings named in the packet brief.

## 1. Root cause (VERIFIED — I reproduced this twice, fixed it, and reproduced the fix)

**`libs/memory-core/project.json:31-42`** declares a `test` target with no `dependsOn`. It inherits
the workspace default at **`nx.json:30-39`**: `"dependsOn": ["^build"]` — build the project's
*dependencies*, never the project's *own* build. `memory-core` has no `test.dependsOn` override, so
`npx nx test memory-core` (without `--skip-nx-cache`, exactly the house-rule-mandated invocation)
**never rebuilds `libs/memory-core/dist`.**

**`libs/memory-core/src/telemetry-crash-durability.spec.ts:46`** resolves
`join(__dirname, '..', 'dist', 'telemetry.js')` and **`:64`/`:123`** `execFileSync` a child process
that `require()`s that exact path — the ONE spec file in this project whose test bodies depend on
its own compiled `dist/` output existing and being current, the same shape as the `sox:test` defect
fixed in commit `9ac235d3` (`apps/sox/src/bl218-registry-resolved.spec.ts` execing
`dist/apps/sox/main.js`, same missing-`dependsOn` root cause, same "isolated runs come back green,
which is why 15 reproduction attempts missed it" signature).

**Empirical reproduction**, in this worktree (`/Users/nix/dev/ai/sox-ecosystem/.worktrees/pkt55-suite-variance`, a fresh worktree off `main` where `libs/memory-core/dist` had never been built):

| Run | Command | `libs/memory-core/dist` state | Result |
|---|---|---|---|
| 1 | `npx nx test memory-core -- --reporter=json --outputFile=run1.json` | absent | **5 failed**, all in `telemetry-crash-durability.spec.ts` (`expected +0 to be 100/1000/10000`, `Command failed: … graceful-child.cjs … dist/telemetry.js`) |
| 2 | same command, different `--outputFile` (cache-bust, no `--skip-nx-cache`) | still absent | **5 failed** — identical set |
| — | `npx nx build memory-core` | now present | (this is the manual workaround; NOT the fix — see §3) |
| 3–6 (`full4`–`full6`) | same test command, dist present | present | **0 failed**, 589 total, 8 skipped, all four runs identical |

Same config (`npx nx test memory-core`), same source tree, same machine — **5 failures or 0
failures, purely as a function of incidental nx-cache/build state at invocation time.** That is
"the variance, not the count" in miniature: a config whose result depends on invocation history
rather than on the code under test is not admissible evidence, independent of whether the specific
failure count ever hits 109/95/91.

**Why this generalizes to the packet's 109/95/91 claim without my having reproduced it directly:**
in this program's actual operating environment — a shared checkout with multiple concurrent agents,
explicitly what `CLAUDE.md`'s BL-456 section describes — whether `memory-core/dist` is fresh, stale,
absent, or **mid-write by a concurrent `nx build memory-core` from another agent** at the exact
moment `nx test memory-core` starts is not controlled by "the config" at all. `atomic-tsc` stages to
a temp dir and renames (per `CLAUDE.md`'s BL-235 section); a `require()` racing that rename gets
`ENOENT` or a half-written module, either of which surfaces as unrelated-looking runtime errors from
whatever spec happens to be executing at that instant in this single-worker, `fileParallelism`-on
suite (`libs/memory-core/vitest.config.ts:31` — `pool: 'forks', maxWorkers: 1, minWorkers: 1`, but
`fileParallelism` is NOT set to false, so multiple spec files' async bodies interleave within that
one process). That is a plausible mechanism for run-to-run count variance with no code change
between runs — exactly the reported symptom shape — even though the specific manifestation I could
force (deterministic 5-test dist-require failure) is not itself SQLite-flavored.

## 2. Negative evidence (honest, not deflection)

I ran the full `memory-core` suite **4 additional times** post-fix (`full4.json`–`full6.json` plus
the original post-build run) and the two named files **6 more times in isolation**
(`export.spec.ts` + `concurrency-harness.spec.ts` together, 6 iterations) — **10 combined runs, 0
occurrences** of `statement has been finalized` or `cannot start a transaction within a transaction`,
and 0 occurrences of the INDEX-ordering assertion failure the stored `BL-202` node actually
describes. This matches `BL-202`'s own prior triage (~30+ runs, zero reproductions) rather than the
packet's 109/95/91 claim. I attempted no CPU-load injection during these runs — a background
busy-loop command was blocked by the sandbox's action classifier, so "under concurrent-suite CPU
load" (both `BL-202`'s own stated reproduction condition and my best guess at what produced
109/95/91) is **untested by me**. This is the gap the implementer must close — see §4 criterion B2.

I did **not** find a shared cross-file store-opening fixture. Contrary to the packet's "plus
whatever shared fixture opens the store per-suite," both `export.spec.ts` (`makeTempDir()` at
`libs/memory-core/src/export.spec.ts:27-35`, called fresh per-`it()`) and
`concurrency-harness.spec.ts` (`tmpDir()` at `libs/memory-core/src/concurrency-harness.spec.ts:27-30`,
also per-`it()` via `beforeEach`) each mint their own unique `mkdtempSync` directory per test, and
neither imports a common fixture module — I grepped
`libs/memory-core/src/*fixture*`, `*test-util*`, `*test-helper*` and found nothing. The only
genuinely shared, module-level, cross-file state in this suite is the embed provider singleton
installed once in `libs/memory-core/vitest.setup.ts:20` (`_setEmbedProviderForTest`), which
`embed.spec.ts` (lines ~108-115) temporarily swaps to `null` — but that block is gated behind
`SOX_EMBED_BACKEND === 'real'` / `SOX_RUN_EMBED_DOWNLOAD_TESTS` (`embed.spec.ts:17`), neither of
which is set in any run I performed (all runs showed the same 8 skipped tests), so it cannot explain
variance under the default config this packet is scoped to.

## 3. The change, file by file

### `libs/memory-core/project.json` — IN SCOPE, change required

Add `dependsOn` to the `test` target (mirrors `apps/sox/project.json`'s fix in `9ac235d3` exactly):

```json
"test": {
  "executor": "nx:run-commands",
  "options": {
    "command": "vitest run --config libs/memory-core/vitest.config.ts",
    "cwd": "."
  },
  "cache": true,
  "dependsOn": [
    "build",
    "^build"
  ],
  "inputs": [
    "default",
    "^production"
  ]
},
```

This file is `libs/memory-core/project.json` — it is **not** under `libs/memory-core/src/`, so it is
outside both (a) the scope fence's "non-test source under `libs/memory-core/src/`" boundary that
would require stopping, and (b) PKT-18's `curate.ts` conflict zone. It is nx build-graph
configuration, not implementation source. **Ruling: in scope, make this change.**

### `libs/memory-core/src/bl202-test-target-depends-on-own-build.spec.ts` — NEW file, in scope

A new `*.spec.ts` file (explicitly permitted by the scope fence) that pins the fix so a future
edit to `project.json` can't silently regress it. See §4 Criterion A for the exact assertion.

### Files to READ but NOT MODIFY, and why

- **`libs/memory-core/src/export.spec.ts`** — named in the packet, but I found no defect in it (each
  test opens its own isolated `mkdtempSync` DB, closes it in a `finally`, no shared state). Per
  BL-225 (no RESOLVED without a witnessed RED), I am not authorized to invent hardening changes to a
  file with no observed failure — that risks the BL-167 pattern in reverse (a "fix" for a bug that
  was never shown to exist). **Ruling: do not touch unless/until §4 Criterion B2 (load-based
  reproduction) actually reproduces a failure inside this file; if it does, that failure's specifics
  determine the edit, and this spec does not pre-guess it.**
- **`libs/memory-core/src/concurrency-harness.spec.ts`** — same ruling, same reasoning. Its
  `beforeEach`/`afterEach` already call `WriteQueue.clearInstances()` (line 62, 76), which itself
  calls `_cancelCheckpoint()` before closing (`write-queue.ts:451-459`), so the one dangling-timer
  hazard I checked for (an uncancelled WAL-checkpoint `setTimeout` outliving test teardown and firing
  into a later, unrelated test) is already closed off in this file.
- **`libs/memory-core/src/curate.ts`** — PKT-18's file. Do not open with edit intent, do not modify
  under any circumstance in this packet.
- **`nx.json`** — the global `test.dependsOn: ["^build"]` default is correct and shared by every
  project; changing it globally would be the wrong fix (losing alternative — see §4 below).

## 4. Every decision, ruled

**D1 — Fix at the project level (`memory-core/project.json`) vs. the global level (`nx.json`
`targetDefaults.test`).**
**Ruling: project level.** `nx.json`'s `targetDefaults.test.dependsOn: ["^build"]` is correct for
the *majority* of projects, whose specs never touch their own compiled output — adding `"build"` to
every project's test target globally would make every `nx test <project>` pay a build cost even for
projects with zero dist-spawning specs, and — per the BL-235 destructive-build warning — increases
the number of `rm -rf dist` operations that run merely to execute a test. The precedent commit
(`9ac235d3`) made exactly this same call for `apps/sox`, per-project. Losing alternative (global
fix) rejected: broader blast radius, more destructive-build exposure, no upside — the handful of
projects that need it (so far: `sox`, and now `memory-core`) can each declare it.

**D2 — Read `project.json` directly in the regression test vs. shelling out to `npx nx show project
memory-core --json`.**
**Ruling: read `project.json` directly with `node:fs` + `JSON.parse`.** Losing alternative (`nx
show`) rejected for three reasons: (1) it spawns an nx CLI subprocess inside every suite run, adding
latency and a dependency on the nx daemon's own health — ironic for a test whose entire point is
"don't let build-graph plumbing state leak into test results"; (2) `nx show project --json` resolves
`targetDefaults` merges, which is MORE than this test needs to assert (it should pin the literal
config we just wrote, not re-derive nx's merge semantics); (3) it is slower and adds a genuine
flake surface (subprocess spawn under contention) to a test whose entire purpose is proving something
is NOT flaky.

**D3 — Whether to modify `export.spec.ts` / `concurrency-harness.spec.ts` preemptively (BL-202 fix
sketch option (c): "proactively harden... ~30 min, best-effort without knowing the root cause").**
**Ruling: do not, unless §4 Criterion B2 reproduces something concrete.** BL-225 requires a
witnessed RED before a fix is credited; "hardening" a passing test based on a hypothesis is
indistinguishable from decoration and cannot be defended if reviewed. If B2 reproduces a failure,
the implementer edits based on what B2 actually shows, not based on advance guesswork in this spec.

**D4 — Whether to treat the packet's 109/95/91 claim as ground truth requiring me to keep hunting
for the exact SQLite error strings, vs. reporting the mismatch and the verified defect I did find.**
**Ruling: report the mismatch (§0), fix and prove the verified defect (§1, §3, §4-A), and hand the
implementer an explicit, bounded reproduction task for the unverified part (§4-B) rather than
fabricate a narrative that I found something I did not find.** This is the "Fix It First" /
"Zero Deflection" instruction applied honestly: I own and fix the regression I found; I do not
claim to have fixed a bug I never observed.

**D5 — Whether "0 failures across N runs" alone is sufficient proof of D1's fix, given the packet's
explicit "a single green run is not evidence... the defect is variance."**
**Ruling: not sufficient by count alone — require identical *test identity sets* across all N runs
(`comm -13` empty both directions on sorted full test names, not just `numFailedTests === 0`), per
§4 Criterion A3/B1. A suite that silently drops or skips a different test each run while reporting
`numFailedTests: 0` would pass a count-only check and still be exhibiting exactly the variance this
packet exists to kill.**

## 5. Acceptance criteria (each names BL-202, each has a stated RED arm)

### Criterion A — the verified fix (REQUIRED, must pass before anything else matters)

**A1. RED arm (witness before committing the `project.json` fix):**
In a **separate, throwaway clone or worktree** where `libs/memory-core/dist` has never been built
(do NOT `rm -rf` the existing `dist` in this worktree — that is the BL-235-banned destructive
diagnostic build against a *working* artifact; a fresh worktree/clone starts genuinely dist-less
with nothing to destroy):
```
git worktree add /tmp/pkt55-red-witness -b throwaway/pkt55-red main
cd /tmp/pkt55-red-witness && pnpm install
npx nx test memory-core -- --reporter=json --outputFile=/tmp/red.json
```
Expected: `numFailedTests: 5`, all five full names under
`telemetry-crash-durability.spec.ts`, matching the messages in §1's table. Remove the throwaway
worktree after (`git worktree remove /tmp/pkt55-red-witness`).

**A2. GREEN arm:** apply the `project.json` change from §3, repeat the exact same throwaway-worktree
sequence (fresh clone including the fix, `libs/memory-core/dist` absent at start). Expected:
`npx nx test memory-core -- --reporter=json --outputFile=/tmp/green.json` reports `numFailedTests: 0`,
`numTotalTests: 589`, `numPendingTests: 8` — same totals as this spec's `full4`–`full6` runs — with
`libs/memory-core/dist/telemetry.js` present afterward (nx built it as a dependency of `test`).

**A3. Regression test (new file, `bl202-test-target-depends-on-own-build.spec.ts`):** reads
`libs/memory-core/project.json`, `JSON.parse`s it, and asserts
`json.targets.test.dependsOn` is an array containing both `"build"` and `"^build"`. RED arm: run it
against the pre-fix file content (`git show HEAD:libs/memory-core/project.json` before this
packet's commit) — fails, since `dependsOn` is absent from `test`. GREEN arm: run it against the
committed fix — passes. This is the fast, always-on guard; A1/A2 are the one-time empirical proof
that the config change actually has the runtime effect claimed.

### Criterion B — the packet's specific claim (bounded investigation, not a blocking gate)

**B1. Repeatability harness (REQUIRED evidence, run in THIS worktree post-fix, dist warm is fine —
this is about test-identity stability, not the dist-cache defect A1/A2 already cover):**
```bash
for i in 1 2 3 4 5; do
  npx nx test memory-core -- --reporter=json --outputFile=/tmp/pkt55-rep-$i.json
  node -e "
    const r = require('/tmp/pkt55-rep-$i.json');
    const names = [];
    for (const f of r.testResults) for (const a of f.assertionResults) names.push(a.fullName);
    names.sort();
    require('fs').writeFileSync('/tmp/pkt55-names-$i.txt', names.join('\n'));
    console.log('run $i', r.numFailedTests, 'failed of', r.numTotalTests);
  "
  node tools/check-suite-tree-state.mjs --project memory-core
done
for i in 1 2 3 4; do j=$((i+1)); comm -13 /tmp/pkt55-names-$i.txt /tmp/pkt55-names-$j.txt; comm -13 /tmp/pkt55-names-$j.txt /tmp/pkt55-names-$i.txt; done
```
Expected and REQUIRED to pass this packet: all five runs `numFailedTests: 0`, every `comm -13` in
both directions empty, every tree-state check `CLEAN`. Quote the raw output (all five run summaries,
all eight `comm` invocations, all five tree-state lines) in the completion report — do not
summarize as "ran fine."

**B2. Load-based reproduction attempt (best-effort, REQUIRED attempt, not a required reproduction):**
Since a synthetic background CPU-load command was blocked by the sandbox in my session, the
implementer must attempt reproduction under genuine build-graph contention instead — the mechanism
§1 actually proposes — by running `memory-core`'s test concurrently with a real build of the same
project from a second process:
```bash
npx nx build memory-core &            # background: real, legitimate build (not destructive — see BL-235 note: this is fine because it's a normal build, not a diagnostic build against an artifact you need to keep, and it targets the SAME artifact the fix's own dependsOn now serializes against, so run this ONLY against the pre-fix project.json to test the failure mode, not post-fix)
npx nx test memory-core -- --reporter=json --outputFile=/tmp/pkt55-contend.json
wait
```
Report whatever this produces, honestly, whether it reproduces the SQLite error strings, produces a
different failure, or produces nothing. **If it reproduces `statement has been finalized` or
`cannot start a transaction within a transaction`, STOP before writing any fix** — that is new
information this spec does not have, changes the file-by-file plan in §3, and must go back to an
architect rather than being patched ad hoc. If it reproduces nothing (matching my own 10 runs and
`BL-202`'s prior ~30 runs), report that plainly as the outcome — it is not a failure of this packet,
it is the honest state of the evidence.

### What "done" means for this packet

Criterion A (all three sub-parts) is the required, gating deliverable — it is a real, witnessed,
BL-225-compliant RED→GREEN fix for a defect that produces "same config, different result," which is
this packet's stated meta-problem. Criterion B is required *evidence-gathering*, not a required
reproduction — do not mark BL-202 `RESOLVED` for the SQLite-error-string symptom unless B2 actually
produces a witnessed RED for it. If B1/B2 come back clean (as my own 10 runs did), the honest BL-202
disposition is: **partial** — the dependsOn class of variance is fixed and proven; the specific
statement-finalized/transaction-nesting symptom remains unreproduced and should stay open with this
packet's evidence attached via `backlog_append_note`, not closed. State this plainly in the
completion report per this program's "no fabricated green" standard — do not present a partial
outcome as a full fix.

## 6. Risks

- **BL-235 (destructive build):** A1's RED-arm witness and B2's load-contention build both spawn
  real `nx build`/`nx test` invocations. Both are scoped to run in **throwaway worktrees or against
  artifacts with nothing to lose** (A1: a fresh worktree with no prior `dist`; B2: explicitly noted
  to run against `git worktree`'s own tree, not this shared worktree's *needed* dist, and only
  meaningfully run pre-fix since post-fix the two commands would just serialize correctly). Do not
  run either against `/Users/nix/dev/ai/sox-ecosystem` (the shared main checkout) or against a
  worktree another live agent depends on.
- **No `~/.memory/*` risk:** nothing in this packet touches a real store; every DB in every spec
  under discussion is `mkdtempSync`-scoped and cleaned up in a `finally`.
- **Scope-fence risk (`curate.ts`):** none of this packet's changes touch `libs/memory-core/src/curate.ts`
  or any other file PKT-18 owns. Confirmed by `git status` in this worktree before starting (clean)
  and by every file this spec names.
- **Commit hygiene:** commit `libs/memory-core/project.json` and the new
  `bl202-test-target-depends-on-own-build.spec.ts` file by explicit pathspec, in this worktree
  (`.worktrees/pkt55-suite-variance`), on branch `feat/pkt55-suite-variance`. Do not touch
  `.nx/`, `dist/`, or any `*.js`/`*.d.ts` under `src/`.

## 7. The gate — exactly which nx targets to run, in order

1. `node tools/check-suite-tree-state.mjs --project memory-core` — before touching anything, confirm
   clean (it was clean when I started: 9 dependency projects, no uncommitted changes).
2. Make the `project.json` edit (§3) and add the new spec file (§3/§4-A3).
3. `npx nx test memory-core -- --reporter=json --outputFile=<unique path>` — run in THIS worktree,
   confirm `bl202-test-target-depends-on-own-build.spec.ts` passes and the full suite is still
   589/0-failed/8-skipped (dist is already warm here, so this alone does not exercise A1/A2's
   empirical claim — that requires the separate throwaway worktree per §5).
4. Perform §5 Criterion A1 (throwaway worktree, pre-fix content, expect 5 failures) and A2 (same
   throwaway worktree, post-fix content, expect 0 failures). Remove the throwaway worktree when done.
5. Perform §5 Criterion B1 (5x repeatability in this worktree) and B2 (contention attempt, pre-fix
   project.json content, in a throwaway location — do not leave the pre-fix content committed
   anywhere).
6. `npx nx lint memory-core` and `npx nx typecheck memory-core` — both must stay green; the new spec
   file is plain TS using only `node:fs`/`node:path`/vitest, no new dependencies.
7. `npx nx build memory-core` is **not** part of this gate as a standalone step — do not run it bare
   against this worktree's dist (BL-235); it is only exercised indirectly via `nx test`'s new
   `dependsOn` in steps 3–5.
8. Do **not** run `npx nx run-many -t build,lint,test,typecheck` from this packet — that is
   whole-repo and out of this packet's blast radius; scope the gate to `memory-core` as listed above.
9. Commit by explicit pathspec:
   `git commit libs/memory-core/project.json libs/memory-core/src/bl202-test-target-depends-on-own-build.spec.ts -m "fix(memory-core): test target depends on own build (BL-202)"`
   If the plain pathspec commit is blocked by a pre-commit hook (`plan-status.mjs --check`) that is
   `STALE` on files this packet never touched (e.g. contended shared docs another agent owns), do not
   regenerate or force-touch those files to unblock yourself — use `tools/commit-mine.mjs` to commit
   this packet's two files directly, after independently confirming `node
   tools/check-backlog-markers.mjs` and this packet's own gate (step 6) are clean. Observed and
   ruled correct in the PKT-55 implementation run (2026-08-04): the hook was stale on
   `docs/reporting/memory/PLAN.md`/`STATE.md`, `commit-mine.mjs` was used, and no shared file was
   touched or discarded.
10. Update the `BL-202` backlog node via `backlog_append_note` (or `backlog_transition_status` to a
    partial-resolution status if the tool schema supports one — check `mcp__backlog__backlog_resolve_item`'s
    `status` enum before choosing) with the evidence from Criterion A and B, worded per §5's "What
    'done' means" — do not mark fully `RESOLVED`/`FIXED` unless B2 also produced a witnessed RED→GREEN
    for the SQLite-error-string symptom.
