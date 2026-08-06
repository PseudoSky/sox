# SPEC-BL-466 — wire the 17 `tools/test-bl*.mjs` regression guards to real runners

Architect: this document. Worktree: `.worktrees/bl466-wire-guards`, branch `feat/bl466-wire-guards`.
Implementer/reviewer work only in this worktree until merge.

## 0. Scope conflict — flagged, not resolved unilaterally

`BACKLOG.md:3065-3124` (`### BL-466`) currently carries an **"Owner ruling 2026-08-05"** stating
verbatim: *"the harness itself is deferred to a dedicated test-automation spec, outside the current
plan. Form (runner vs. vitest port) and wiring points (nx target / CI / hook) are that spec's to
decide and are NOT settled here. What this item now carries is the survey."* [BACKLOG.md:3067-3070]

The dispatch that produced this SPEC explicitly commissions the wiring (tiers, nx targets, hook,
CI) that sentence defers. I am treating the dispatch as a later, more specific instruction that
supersedes the deferral — but this is a real conflict in the source-of-truth document, not a
judgement call I'm entitled to make silently per this repo's own disclosure rules. **The
implementer's first commit must update `BACKLOG.md:3067-3070`** to remove the "deferred" language
and replace it with a pointer to this SPEC and the resulting `feat/bl466-wire-guards` commits, so
the backlog stops asserting a decision that the same branch's history contradicts. Do not silently
leave both statements standing.

The backlog text also says "thirteen guards" and "measured status of all thirteen" — four guards
postdate that survey (`bl416`, `bl446`, `bl454` were added after; `bl469` is named only in passing
as "related"). This SPEC surveys all **17** files present on disk today (§2), superseding the
13-guard survey.

## 1. Root cause

`grep -rn "tools/test-bl" package.json tools/*.mjs .github/workflows/*.yml .husky/*` returns
**zero matches** — verified again in this worktree, same as the citation in
`BACKLOG.md:3072-3075`. `.husky/pre-commit` (read in full,
`.worktrees/bl466-wire-guards/.husky/pre-commit:1-33`) invokes exactly four checks —
`check-amend-shared-index.mjs`, `check-bl-id-integrity.mjs`, conditionally `plan-status.mjs
--check`, and `nx affected --target=lint` — none of them a `test-bl*` script. `project.json:1-41`
(root nx project `sox-ecosystem`) defines three targets (`routing:build-index`,
`routing:check-drift`, `test`); none references `tools/test-bl`. `.github/workflows/ci.yml:1-80`
runs `nx affected -t build,lint,typecheck` and (per its own header comment) `test`; none invokes a
`test-bl*` script directly. So every one of the 17 scripts is authored, run once by the agent who
wrote it, and never touched by any automated trigger again — the exact drift `test-bl313` suffered
for seven days (`BACKLOG.md:3078-3086`, independently re-confirmed by that item's own citations).

## 2. Guard survey and tier assignment (all 17, measured 2026-08-06 in this worktree)

Every guard was read in full and, where safe, executed. Runtime is `real` from `/usr/bin/time -p`,
single run, this worktree, cold (no nx cache warm for anything it touches).

| id | file | tier | runtime | exit | why |
|---|---|---|---|---|---|
| bl222 | `test-bl222-verify-native-abi.mjs` | **1** | 0.34s | 0 | spawns `verify-native-abi.mjs`; reads native `node_modules` ABI metadata only, no `dist/`, no repo writes |
| bl407 | `test-bl407-preflight-scoping.mjs` | **1** | 1.26s | 0 | `fs.mkdtempSync` scratch git repo, self-contained |
| bl409 | `test-bl409-pathspec-commit.mjs` | **1** | 0.19s | 0 | scratch git repo via mkdtemp |
| bl416 | `test-bl416-shared-registry-lock.mjs` | **1** | 0.49s | 0 | mkdtemp "main" + mkdtemp "worktree" dirs, both synthetic, spawns `ALLOCATE` script against them only |
| bl435 | `test-bl435-unguarded-prose.mjs` | **1** | 0.07s | 0 | imports a module in-process; one `spawnSync` of `plan-status.mjs --check`, which is read-only against whatever checkout it runs in |
| bl446 | `test-bl446-arg-validation.mjs` | **1** | 0.98s | 0 | mkdtemp scratch dir, `execFileSync`/`spawnSync` of a tool against it |
| bl454 | `test-bl454-annotation-dedupe.mjs` | **1** | 0.33s | 0 | mkdtemp scratch dir, spawns `check-backlog-markers.mjs`-family tool against it |
| bl456 | `test-bl456-suite-tree-state.mjs` | **1** | 2.71s | 0 | mkdtemp scratch dir; spawns `check-suite-tree-state.mjs --project memory-server --json`, which shells `git status --porcelain` — read-only, no build invoked |
| bl457 | `test-bl457-amend-shared-index.mjs` | **1** | 1.16s | 0 | mkdtemp scratch git repos; exercises `commit-mine.mjs --amend-message` against synthetic commits only |
| bl463 | `test-bl463-unstage-orphans.mjs` | **1** | 0.93s | 0 | mkdtemp scratch git repo |
| bl464 | `test-bl464-duplicate-status-stamp.mjs` | **1** | 0.03s | 0 | pure in-process `import()` of `stampPackets`, no child process at all |
| bl465 | `test-bl465-commit-mine-index-resync.mjs` | **1** | 0.86s | 0 | mkdtemp scratch git repos |
| bl469 | `test-bl469-skip-not-pass.mjs` | **1** | 0.11s | 0 | mkdtemp fixture dir, spawns bl266 against it only |
| bl214 | `test-bl214-bundle-extension-tsconfig.mjs` | **2** | 0.14s (fails without prebuilt deps) | **1 in this worktree** | `ROOT` is `import.meta.url`-relative (`test-bl214…mjs:38`) — genuinely worktree-isolable — but arm [2] esbuild-bundles the real `extensions/services/tokenguard` entry, which `import`s `@adhd/sox-tokenguard-core`; that lib has no built `dist/` in a fresh worktree, so esbuild fails with `Cannot read file: .../libs/tokenguard-core/dist/index.js`. Requires `nx build tokenguard-core` first. |
| bl231 | `test-bl231-cjs-boundary.mjs` | **2, non-isolable** | 0.05s | 0 (passed — see note) | `REPO_ROOT` is computed from `git rev-parse --git-common-dir` then `..` (`test-bl231…mjs:49-53`) — for a linked worktree, `--git-common-dir` resolves to the **main checkout's** `.git`, so `REPO_ROOT` is **always the main checkout**, never the worktree it's invoked from. It read `/Users/nix/dev/ai/sox-ecosystem/libs/memory-core/dist/index.js` etc. even when run from this worktree. It is read-only (no `execSync`/`spawnSync` that mutates), so this is safe, but it cannot be isolated by worktree by construction, and it deliberately `FAIL`s loud (not skip) if the shared dist is absent — see §5 ruling. |
| bl266 | `test-bl266-bundle-invariants.mjs` | **2, parameterized** | n/a (exits 2, usage) | 2 | requires `--outdir --externals`; only actually builds anything if additionally given `--build-cmd`/`--source`/`--rebuild-cmd`. Caller-controlled paths, no hardcoded root — isolable, but needs an explicit driver script to supply real args. |
| bl313 | `test-bl313-graph-store-migrations-asset.mjs` | **2** | not re-run here (mirrors bl214's shape) | — | `ROOT` is `import.meta.url`-relative (`test-bl313…mjs:52`) — isolable. `bundle-extension.cjs` stages into `fs.mkdtempSync` output and swaps by rename, leaving the target intact on failure (`tools/bundle-extension.cjs:359-367,503-512,517-533`, per `BACKLOG.md:3106-3109`) — confirmed non-destructive to any real `dist/`. Requires the memory-server extension's own build inputs to be assembled first. |

**13 Tier 1, 4 Tier 2** (bl214, bl231, bl266, bl313). None of the 17 was found to be
unclassifiable — no guard defaults to Tier 2 "because unsure"; every Tier 2 assignment above has a
specific, cited reason (needs a prebuilt `dist/`, or invokes a real esbuild build).

**Guards I could not confidently mark hermetic-forever**: bl222 depends on `node_modules` being
present and ABI-rebuilt (via the repo's own `postinstall: pnpm rebuild better-sqlite3 sqlite-vec`,
`package.json:9`) — true after any `pnpm install`, which the pre-commit hook's caller is assumed to
have already run to be committing at all. This is a soft dependency, not a `dist/` dependency, and
I'm ruling it Tier 1 on that basis — flagged here per the instruction to say which ones I was
unsure about.

## 3. The change, file by file

### New files

- **`tools/guards-manifest.mjs`** — single source of truth, one entry per guard:
  ```js
  export const GUARDS = [
    {
      id: 'bl222', tier: 1, script: 'test-bl222-verify-native-abi.mjs',
      watch: ['tools/verify-native-abi.mjs', 'package.json'],
    },
    // ...13 tier-1 entries, watch globs per guard (see §3.1 for the full per-guard watch list)
    {
      id: 'bl214', tier: 2, script: 'test-bl214-bundle-extension-tsconfig.mjs',
      needsBuild: ['tokenguard-core'],
    },
    {
      id: 'bl231', tier: 2, isolable: false, script: 'test-bl231-cjs-boundary.mjs',
      needsBuild: ['memory-core', 'ingest'], // built in the MAIN checkout only, never a worktree
    },
    {
      id: 'bl266', tier: 2, script: 'test-bl266-bundle-invariants.mjs',
      needsBuild: ['memory-server'], driverArgs: true, // run-guards.mjs supplies --outdir/--build-cmd/--source
    },
    {
      id: 'bl313', tier: 2, script: 'test-bl313-graph-store-migrations-asset.mjs',
      needsBuild: ['memory-server'],
    },
  ];
  ```
  `isolable: false` on bl231 is load-bearing — the runner (§3.2) must special-case it: never route
  it through the isolated-worktree path, run it in place against whatever checkout invoked it.

- **`tools/run-guards.mjs`** — the runner. Contract:
  - `--tier1` — run all Tier 1 guards. Default mode is **filtered**: compute
    `git diff --cached --name-only` (pre-commit context) or `--base`/`--head` (CI context, passed
    as flags) and run only guards whose `watch` globs intersect the diff, **plus every guard whose
    own script file changed** (a guard editing itself always runs). `--all` disables filtering and
    runs the full Tier 1 set unconditionally — this is what CI's periodic full pass and any manual
    invocation use.
  - `--tier2` — run all Tier 2 guards. `--isolate-worktree` (required outside CI, see §3.2)
    creates `.worktrees/guards-tier2-<pid>-<iso8601>`, runs the minimal `nx build <dep>` for each
    guard's `needsBuild` list **inside that worktree**, runs each isolable guard from there, tears
    the worktree down on exit (`git worktree remove --force` — safe because it's a throwaway branch
    this process created, never a branch with pre-existing commits) unless `--keep` is passed for
    postmortem. `bl231` (`isolable:false`) is always run against the invoking checkout directly,
    never inside the created worktree, and its runtime the runner does not treat as
    worktree-covered — report it as `RAN (shared-checkout, read-only)` distinctly in the summary so
    "isolated" is never claimed for a guard that structurally cannot be.
  - **Tri-state reporting, matching the bl266/bl469 convention already in the repo**
    (`tools/test-bl469-skip-not-pass.mjs:34-36`): every guard result is `PASS`, `FAIL`, or `SKIP`.
    `SKIP` means the runner did not execute the guard's process at all (e.g. filtered out, or a
    Tier 2 guard whose `needsBuild` step itself failed before the guard could run — that is a
    runner-level `SKIP` of the guard, distinct from the build failure which is reported separately
    and also fails the run). A guard process that ran and exited non-zero is `FAIL`, never `SKIP`.
  - Exit code: non-zero if any `FAIL`. Non-zero if any `SKIP` **unless** `--allow-skip` is passed
    (mirrors bl266's own flag, `tools/test-bl469-skip-not-pass.mjs:104-118`). `--tier1` in the
    pre-commit hook is invoked **without** `--allow-skip` for guards whose watch-glob matched — a
    matched-but-unrun guard must block the commit, not silently pass. Filtered-out (non-matched)
    guards are not even attempted and are not counted as `SKIP` — they are `NOT_APPLICABLE`, a
    fourth, non-blocking bucket, printed but never gating. This distinction (matched-but-didn't-run
    vs never-in-scope) is what makes the filter safe: BL-469's contract is that a scoped-in guard
    can never silently read as passing.
  - Output: one line per guard, `[PASS|FAIL|SKIP|N/A] bl<id> — <detail> (<ms>ms)`, plus a summary
    line `N/M guards ran, P passed, F failed, S skipped, A not-applicable` — never a line that can
    be misread as "ALL PASS" when anything was skipped (the exact BL-469 assertion,
    `tools/test-bl469-skip-not-pass.mjs:79-90` — the new runner's summary format must pass the same
    shape of check; the implementer adds a `test-bl466-runner-tristate.mjs` guard, see §4).

### Modified files

- **`.husky/pre-commit`** — append, after the existing `plan-status.mjs --check` block and before
  `nx affected --target=lint`:
  ```sh
  # BL-466 — Tier 1 regression guards (tools/test-bl*.mjs), filtered to guards whose
  # watched files are in this commit's staged diff. See tools/guards-manifest.mjs.
  node tools/run-guards.mjs --tier1
  ```
  Placed before the `nx affected` lint line so a guard failure is reported before the slower lint
  step runs (fail fast). **Do not** add `--tier2` here — Tier 2 is never wired to the hook (§0 of
  the dispatch, restated: Tier 2 needs isolation the hook's synchronous, in-checkout context cannot
  give it).

- **`project.json`** (root, `sox-ecosystem`) — add two `nx:run-commands` targets, `cache: false`
  (guard results must never be nx-cached — a cached `PASS` from stale source is exactly the failure
  mode this item exists to close):
  ```json
  "guards-tier1": {
    "executor": "nx:run-commands",
    "options": { "command": "node tools/run-guards.mjs --tier1 --all", "cwd": "." },
    "cache": false
  },
  "guards-tier2": {
    "executor": "nx:run-commands",
    "options": { "command": "node tools/run-guards.mjs --tier2", "cwd": "." },
    "cache": false
  }
  ```
  `guards-tier1` here always uses `--all` (the nx target is the "run everything, no filtering" path
  used by CI's full pass and by any agent auditing the whole set by hand; the pre-commit hook calls
  `run-guards.mjs` directly with its own filtered default, not through this target, so the two
  entry points don't fight over what "the nx target" means).

- **`.github/workflows/ci.yml`** — two new steps:
  1. After the existing `Build (nx affected)` step (so CI's own runner has fresh `dist/` for
     whatever it decides to build), add:
     ```yaml
     - name: Guards — tier 1 (full, unfiltered)
       run: pnpm exec nx run sox-ecosystem:guards-tier1
     ```
     This is CI's answer to the "drift missed by the local diff filter" gap (§3.2 note): a
     dependency changing under a guard's feet without the guard's own watch-glob matching — exactly
     the bl313 shape (`@tursodatabase/database` and `adapter-meta.ts` both changed, neither
     under `tools/test-bl313…`'s own watch list) — is caught here because CI runs the full set on
     every push regardless of what triggered it.
  2. After that:
     ```yaml
     - name: Guards — tier 2 (dist-dependent)
       run: node tools/run-guards.mjs --tier2
     ```
     **No `--isolate-worktree` flag in CI.** A GitHub Actions runner is already a disposable,
     single-job checkout — the isolation the flag exists for (concurrent agents in the shared dev
     checkout, BL-235/BL-456) doesn't apply. Building `tokenguard-core`/`memory-core`/`ingest`/
     `memory-server` directly in CI's own checkout at this point is the already-affected set from
     step 1 in the common case, or a fast incremental nx build otherwise — no destructive risk
     because there is no other agent's `dist/` to destroy.

### Explicitly out of bounds — do not touch

- **`.husky/pre-commit`'s existing four steps** (`check-amend-shared-index.mjs`,
  `check-bl-id-integrity.mjs`, `plan-status.mjs --check`, `nx affected --target=lint`) — working,
  in scope for a different set of BL items, and any reordering beyond "guards run before lint"
  risks the amend/index-divergence protections BL-457 depends on.
- **Any of the 17 guard scripts' own assertions.** Read them, wire them, do not edit their pass/fail
  logic. If a guard is found failing for a real reason (§5), report it — do not loosen it to get a
  green wiring pass (house rule, restated because it is the single most likely shortcut here).
- **`tools/bundle-extension.cjs`** — verified non-destructive by citation already in `BACKLOG.md`
  (§2 table); no changes needed or wanted for this item.
- **`nx.json`'s `targetDefaults.test.dependsOn`** — BL-456's fix belongs to a different item; do not
  touch it while making `run-guards.mjs`, which is why the runner is a hand-rolled script invoked
  by `nx:run-commands`, not a vitest suite under the `test` target (see Decision 1).

## 4. Every decision, ruled

**Decision 1 — hand-rolled runner (`tools/run-guards.mjs`) vs. porting the 17 scripts to vitest.**
**Ruled: hand-rolled.** A vitest port would put these under the `test` target, and
`nx.json`'s `targetDefaults.test.dependsOn = ["^build"]` (the exact mechanism BL-456 documents)
means every `nx test` invocation would rebuild upstream `dist/` as a side effect of merely running
the guards — reintroducing the shared-checkout build hazard this item exists to keep out of the
loop. The alternative also loses on tri-state reporting: vitest's pass/fail/skip semantics
(`it.skip`) do not distinguish "the runner chose not to run this because it was filtered" from "the
test itself decided to skip an assertion" (BL-167's exact failure shape) without extra plumbing
that a plain script gets for free by construction.

**Decision 2 — Tier 1 pre-commit trigger: full run every commit vs. diff-filtered.**
**Ruled: diff-filtered locally, full-unfiltered in CI.** Measured sequential Tier 1 runtime is
9.46s (§2 table sum) — more than "a few seconds," and the task instructions require a narrower
trigger past that bar. Filtering by `git diff --cached --name-only` against each guard's declared
`watch` globs (§3, `guards-manifest.mjs`) keeps the common commit fast (most commits touch 0-2 of
the 13 watched surfaces). The bl313 lesson (a guard rotted because the thing that broke it — an
externals list drift in a sibling package — was invisible to any commit-local diff) is handled by
the CI full pass (§3, new `ci.yml` step), which runs on every push regardless of the diff, so a
locally-filtered-out drift is caught within one push cycle instead of never. The losing alternative
— run the full 9.46s set on every commit, unconditionally — was rejected only because the task
explicitly asks for a narrower trigger past this threshold, not because 9.46s is intrinsically
unacceptable; if the implementer measures the *actual* wired runtime materially higher (subprocess
startup overhead can compound), running fully in the hook is still the safer fallback and should be
chosen over further-clever filtering.

**Decision 3 — Tier 2 isolation mechanism: isolated worktree (as directed) vs. running in place.**
**Ruled: isolated worktree for local/manual invocation, in-place for CI** (§3, `ci.yml` new step).
The dispatch's directive to isolate Tier 2 in a worktree is correct for the case it's protecting
against — a human or agent running Tier 2 by hand in the shared dev checkout, where an `nx build`
side-effect could destroy another agent's live `dist/` (BL-235). It does not apply to CI, which is
already a disposable single-job checkout with no concurrent agents to damage; forcing worktree
isolation there would just add `git worktree add` overhead for zero safety benefit. Both paths are
documented and both exist — this isn't a substitution, it's using the mechanism where its actual
risk (concurrent-agent destruction) is present, and skipping it where that risk structurally cannot
occur.

**Decision 4 — bl231's non-isolability: build a worktree-local dist and patch the script vs. accept
it cannot be isolated.** **Ruled: accept it, run in place, never claim isolation for it.** bl231's
`REPO_ROOT` is deliberately anchored to the shared checkout via `git rev-parse --git-common-dir`
(`test-bl231…mjs:49-53`) — patching that to accept a worktree-local root would change what the
guard *verifies* (it exists to catch drift in the real, shipped `dist/`, not a throwaway
worktree's), which is exactly the "weaken a guard to make it wirable" trap the dispatch explicitly
forbids. Since the guard is read-only (no `execSync`/`spawnSync` that writes), running it in the
shared checkout carries none of BL-235's destructive risk — the risk BL-235 names is specific to
`rm -rf`-then-rebuild `nx build` targets, and bl231 invokes neither. It is wired into CI's Tier 2
step (which always runs in-place) and is explicitly excluded from the local `--isolate-worktree`
runner path.

**Decision 5 — what "prebuilt artifact missing" means for bl214/bl231/bl313 in Tier 2.**
**Ruled: the runner builds the declared `needsBuild` deps itself before invoking the guard; a
build failure there is reported as that dep's own `FAIL`, and every guard depending on it is `SKIP`
(not silently omitted)** — this is the concrete instance of the tri-state contract in §3. The
losing alternative, "guard fails loud with its existing missing-artifact error and the runner just
propagates that as the guard's FAIL," was rejected because it conflates two different failures (the
guard's own assertion vs. an environment precondition) under one signal, making triage slower for
no benefit — `run-guards.mjs` already has to shell out to `nx build` for other reasons (Decision 3),
so distinguishing them costs nothing extra.

**Decision 6 — bl266's driver args.** **Ruled: `run-guards.mjs` supplies a fixed,
documented invocation** — `--outdir <isolated-or-CI dist scratch> --externals <derived from
memory-server's project.json> --build-cmd "node tools/bundle-extension.cjs ..." --source
extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts --rebuild-cmd "..."` —
mirroring exactly what `BACKLOG.md:3094-3096` already describes as the guard's own "pass,
parameterized" contract. This closes BL-469's finding too: with these flags supplied, arms (c)/(d)/(e)
run for real instead of printing `[SKIP]`, so wiring bl266 through Tier 2 is also implicitly the
fix that makes BL-469's own guard (`test-bl469-skip-not-pass.mjs`) exercise the *positive* case
(all 5 verified) in addition to the negative case it already covers (3/5 skipped when unparameterized).
Do not add this positive-case assertion to `test-bl469…mjs` itself as part of this item — that
guard's scope is the skip-vs-pass contract, not bl266's own invariants; a new, separate assertion
belongs in a `test-bl266` self-check if anyone wants it, out of scope here.

**Decision 7 — the `BACKLOG.md` owner-ruling conflict (§0).** **Ruled: this SPEC proceeds, and the
implementer updates the conflicting text in the same PR** rather than either (a) silently ignoring
the deferral, which would leave two authoritative-reading statements contradicting each other in
the source of truth, or (b) refusing to spec the work and bouncing back to the dispatcher, which
the "you are the escalation point, rule on each decision" instruction for this task exists
precisely to avoid for exactly this kind of resolvable tension. The losing alternative — leave
`BACKLOG.md:3067-3070` as-is after wiring everything it says is undecided — is rejected because it
is the same "artifact looks healthy while the thing that would object isn't running" pattern
`BACKLOG.md:3137` (BL-467, filed the same day) calls out about a different guard; leaving stale
deferral language next to done work is that pattern applied to prose instead of code.

## 5. Acceptance criteria (each names a BL-id, each has a stated RED arm)

1. **BL-466-a — survey completeness.** All 17 guards under `tools/test-bl*.mjs` appear in
   `tools/guards-manifest.mjs` with a tier. RED: `node -e "..."` script comparing
   `fs.readdirSync('tools').filter(f=>/^test-bl.*\.mjs$/.test(f))` against
   `GUARDS.map(g=>g.script)` — before the manifest exists, this comparison is undefined/errors;
   after, it must report zero missing and zero extra.

2. **BL-466-b — Tier 1 wired to a real trigger, runtime quoted.** `node tools/run-guards.mjs
   --tier1 --all` runs all 13 Tier 1 guards and reports `13/13 guards ran, 13 passed, 0 failed, 0
   skipped`. RED: before `run-guards.mjs` exists, this command does not exist (`ENOENT` / no such
   file). Quote the measured wall time in the PR description (§2's 9.46s is the sequential
   per-script floor; report the runner's actual wall time, which will differ due to Node startup
   overhead per spawn).

3. **BL-466-c — pre-commit invokes Tier 1 and blocks on failure.** Stage a change to
   `tools/verify-native-abi.mjs` (bl222's watched file) that breaks it (e.g. `process.exit(1)`
   unconditionally), attempt `git commit`. RED (pre-fix): commit succeeds — no `run-guards.mjs` line
   in `.husky/pre-commit` today, verified by the grep in §1. GREEN (post-fix): commit is rejected,
   pre-commit output shows `[FAIL] bl222`. Then revert the break and confirm the commit succeeds.

4. **BL-466-d — filtering does not silently drop a matched guard.** With bl222's watched file
   staged, run `node tools/run-guards.mjs --tier1` (no `--all`) and confirm bl222 is in the `PASS`
   or `FAIL` bucket, never `N/A`. A guard whose watch files are *not* staged (e.g. bl464, watching
   `tools/stamp-packets.mjs`, with nothing staged) must appear as `N/A`, not `SKIP` — `N/A` is
   non-blocking, `SKIP` is blocking. RED: before the `watch`/diff-matching logic exists, there is no
   distinction to test against.

5. **BL-466-e — Tier 2 isolates in a worktree; shared `dist/` provably untouched.** Run `node
   tools/run-guards.mjs --tier2 --isolate-worktree` from the main checkout. Before running, record
   `stat -f %m` (mtime) of `libs/memory-core/dist/index.js`, `libs/data/ingest/ingest/dist/core.js`,
   and any `tokenguard-core`/`memory-server` dist artifacts that exist in the main checkout. After
   the run completes, re-`stat` all of them — **every mtime must be byte-identical to before**, and
   `git worktree list` must show no leftover `guards-tier2-*` worktree (auto-removed unless `--keep`
   was passed). RED: there is no `--isolate-worktree` flag today; the command errors.

6. **BL-466-f — bl231 runs in place, is never routed through the isolated worktree, and this is
   observable.** Run `node tools/run-guards.mjs --tier2 --isolate-worktree` and grep its output for
   the bl231 line: it must read `RAN (shared-checkout, read-only)`, not `RAN (isolated)`. RED: no
   such distinction exists before `guards-manifest.mjs`'s `isolable: false` flag and the runner's
   handling of it are implemented — nothing prevents a naive implementation from silently routing
   bl231 through the worktree path, where (per §2's finding) it would still read the **main**
   checkout's dist via `git rev-parse --git-common-dir`, giving a false impression of isolation.

7. **BL-466-g — tri-state distinguishes skip from pass (extends BL-469's contract to the new
   runner).** Add `tools/test-bl466-runner-tristate.mjs`: spawn `run-guards.mjs --tier1` with a
   contrived manifest fixture containing one guard whose script always exits 0, one that always
   exits 1, and one filtered out by an unmatched `watch` glob (nothing staged that matches it).
   Assert the summary line names exactly 1 passed, 1 failed, 1 not-applicable, and — critically —
   never contains a phrase claiming "all guards passed" or equivalent. RED: before `run-guards.mjs`
   exists this spawns nothing and errors; a naive first implementation that reports `N/A` guards as
   `PASS` (the literal BL-469/BL-167 failure shape) must make this test fail, not the absence of the
   file.

8. **BL-466-h — CI runs both tiers, full-unfiltered for Tier 1.** `.github/workflows/ci.yml` diff
   shows both new steps (§3). RED: `grep -c "guards-tier1\|run-guards.mjs" .github/workflows/ci.yml`
   returns 0 today (verified alongside §1's grep — same command family, extended to the workflow
   file, which the original `BACKLOG.md:3073` grep already covered and found empty).

9. **BL-466-i — a guard deliberately broken makes the wired runner go red, watched.** Pick any
   already-passing Tier 1 guard (e.g. bl464, the fastest at 0.03s), introduce a one-line assertion
   flip so it fails, run `node tools/run-guards.mjs --tier1 --all`, observe `FAIL`, observe
   pre-commit reject a commit that stages bl464's watched file, then revert. This is the literal
   "Red arm: with a guard deliberately broken, the wired runner goes red. Watch it." acceptance line
   from the dispatch — record the before/after output in the PR, do not just assert it happened.

10. **BL-466-j — BACKLOG.md's owner-ruling text is corrected, not left contradicting the shipped
    wiring.** `BACKLOG.md:3067-3070`'s "deferred... NOT settled here" language is replaced with a
    statement pointing at this SPEC and the merged commits. RED: today that paragraph asserts the
    decision is undecided while (post-fix) `project.json`, `.husky/pre-commit`, and `ci.yml` prove
    otherwise — the diff is the RED/GREEN pair, there's no process to run.

## 6. Risks and sequencing

- **Highest risk: Tier 2's `needsBuild` step runs `nx build <dep>` somewhere.** Per BL-235, this is
  destructive if it targets the shared checkout's `dist/`. Sequencing requirement: `run-guards.mjs`
  must create the worktree and `cd` into it (or pass `--cwd`) **before** invoking any `nx build`,
  for every dep except bl231's (which never builds — it only reads). Verify this holds by AC-e
  (§5) before merging; do not trust code review alone, run it.
- **Second risk: `nx build` inside a freshly-created worktree still touches the shared
  `node_modules`/pnpm store** (the store is shared by design, per this repo's pnpm policy) — that is
  fine, the store is content-addressed and additive, but confirm the worktree's own `pnpm install`
  step (already required by the dispatch's worktree bootstrap) completes before any `nx build` runs
  inside it, or the build will fail for an unrelated reason and be misreported as a guard problem.
- **Third risk: pre-commit hook latency.** If `--tier1`'s filtered runtime regularly exceeds ~2-3s
  in practice (subprocess spawn overhead, not accounted for in the raw-script sum), that is a
  legitimate reason to tighten the watch-glob granularity further — not to drop guards from the
  hook. Report the measured number; do not silently widen `N/A` to make it look fast.
- **No risk of data loss to `~/.memory/*`** — none of the 17 guards touch a real memory store; all
  either read source/dist read-only or operate on `fs.mkdtempSync` scratch directories. Confirmed
  by the `grep`/read pass in §2; no guard imports `memory-core`'s live-store path helpers.
- **Ordering for the implementer:** (1) `guards-manifest.mjs` + `run-guards.mjs` Tier 1 only, get
  AC-a/b/d/g green. (2) `.husky/pre-commit` wiring, get AC-c green. (3) Tier 2 + worktree isolation,
  get AC-e/f green — do this in the worktree, per the dispatch's own constraint, never in the shared
  checkout, to avoid becoming the third incident BL-235 warns about. (4) `ci.yml`, get AC-h green.
  (5) AC-i (red-arm demonstration) last, as the final proof, then revert the deliberate break. (6)
  `BACKLOG.md` correction (AC-j) in the same PR, not a follow-up.

## 7. The gate — nx targets the implementer must run before handing off to review

```
npx nx run sox-ecosystem:guards-tier1          # after step (1)/(2) above
npx nx run sox-ecosystem:guards-tier2          # after step (3), from this worktree only
npx nx lint <any touched project>              # if run-guards.mjs or guards-manifest.mjs
                                                # end up inside an existing project rather than
                                                # bare tools/ scripts — they don't have to; tools/
                                                # is not an nx project today and does not need to
                                                # become one for this item
node tools/check-suite-tree-state.mjs --project memory-server --require-clean
                                                # quote this alongside any `nx test` run this item
                                                # happens to trigger incidentally (it shouldn't —
                                                # nothing here should call `nx test`)
```
Do **not** run `npx nx build <project>` speculatively "to see if it works" per BL-235 — the only
builds this item requires are the `needsBuild` ones invoked *by* `run-guards.mjs --tier2
--isolate-worktree`, which are isolated by construction once AC-e is green. If you need to build a
dep to debug Tier 2 outside that path, do it in a throwaway worktree you create yourself, never in
`.worktrees/bl466-wire-guards` (this spec's own worktree — treat its `dist/`, if any appears, as
disposable, but don't gratuitously churn it either) and never in the main checkout.
