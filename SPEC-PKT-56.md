# SPEC — PKT-56 / BL-422: a commit can land on a disposable worktree branch and be reachable from nowhere else

Architect: this document. Implementer: build exactly this, raise nothing as a judgement call —
every decision below is ruled. Reviewer: verify against this document, not against BL-422's prose
(BL-422 deliberately lists options without choosing; this spec is the chosen design).

## 0. Sources read for this spec

- `mcp__backlog__backlog_get_item(BL-422)` — full body, citations 1–4.
- `/Users/nix/dev/ai/sox-ecosystem/tools/commit-mine.mjs:1–293` (full file) — mechanism, existing
  detached-HEAD refusal at line 245/134.
- `/Users/nix/dev/ai/sox-ecosystem/tools/unstage-orphans.mjs:1–135` (full file) — sibling tool,
  report/--apply/--force convention this spec reuses.
- `/Users/nix/dev/ai/sox-ecosystem/tools/guards-manifest.mjs:1–142` (full file) — Tier1/Tier2
  guard registration contract.
- `/Users/nix/dev/ai/sox-ecosystem/tools/run-guards.mjs:1–357` (full file) — how guards are
  invoked, filtered, and exit-coded.
- `/Users/nix/dev/ai/sox-ecosystem/.husky/pre-commit:1–35` (full file) — the only hook that
  actually runs (BL-359: husky package/`prepare` script do not exist; installed via
  `tools/install-git-hooks.mjs`).
- `/Users/nix/dev/ai/sox-ecosystem/.github/workflows/ci.yml:1–120` — confirms `guards-tier1` runs
  unfiltered (`--all`) on every CI push (line 90), and that CI has **no linked worktrees**
  (`actions/checkout` fetches a single ref).
- `/Users/nix/dev/ai/sox-ecosystem/.gitignore:63–64` — `.worktrees/` is gitignored, confirming the
  above: linked worktrees are a local-machine-only condition, invisible to CI.
- `/Users/nix/dev/ai/sox-ecosystem/tools/test-bl409-pathspec-commit.mjs:1–60` and
  `tools/test-bl465-commit-mine-index-resync.mjs:1–199` (full files) — the scratch-repo /
  `SAFE_GIT_ENV` / `report()`-harness test convention every `test-bl*.mjs` guard follows
  (BL-479's `GIT_DIR`/`GIT_INDEX_FILE`/`GIT_WORK_TREE`/`GIT_COMMON_DIR` stripping is mandatory —
  its absence corrupted the real repo's index once already).
- `/Users/nix/dev/ai/sox-ecosystem/tools/check-amend-shared-index.mjs:1–39` (header + contract) —
  the pattern for a small, single-purpose, hook-invoked `tools/*.mjs` guard.
- `git worktree list` in the current checkout (run 2026-08-07): 24 linked worktrees under
  `.worktrees/`, all on branches named `<type>/<slug>` matching their directory basename, except
  `.worktrees/cf-test` and `.worktrees/rf-test`, both **detached HEAD** — live proof that the
  detached-worktree case (§3.3) is not hypothetical.
- `/Users/nix/dev/ai/sox-ecosystem/.claude/worktrees/` — present but contains only `.DS_Store`,
  confirming the `worktree-agent-<id>` / `.claude/worktrees/` naming scheme BL-422's incident used
  is **not** this repo's own tooling; it belongs to an external dispatch harness this repo's
  scripts have no visibility into (see Decision 1).
- Searched `tools/`, `scripts/`, `.husky/` for any existing agent-identity primitive
  (`AGENT_ID`, `CLAUDE_AGENT`, `agentId`, session id) — **none exists**. This is load-bearing for
  Decision 1.

## 1. Root cause

BL-422's own citations establish the mechanism precisely: `af45f77` and `e275039` were made with
every existing safeguard followed (explicit pathspec, empty shared index, watched red→green,
disjoint files) and still landed on `worktree-agent-a54e5171a1615a001` and nowhere else, because an
external harness moved the committing agent's working directory into a worktree it had not chosen,
between commits, without telling it. `git log -1` (what the agent checked) answers "does a commit
exist at HEAD"; it does not answer "which branch is HEAD" — and in a multi-worktree checkout those
are different questions.

**Nothing in this repo's own tooling asks the second question, at any layer, for any commit path.**
Concretely:

- `.husky/pre-commit` (`/Users/nix/dev/ai/sox-ecosystem/.husky/pre-commit:1–35`) runs
  `check-amend-shared-index.mjs`, `plan-status.mjs --check`, `run-guards.mjs --tier1`, and
  `nx affected --target=lint` — none of them read `git rev-parse --abbrev-ref HEAD` or compare it
  to anything.
- `tools/commit-mine.mjs` refuses a **detached** HEAD (`tools/commit-mine.mjs:134`,
  `tools/commit-mine.mjs:245`) but performs no check at all on which **named** branch HEAD
  currently is — a named branch belonging to a different packet is accepted identically to the
  caller's own.
- There is no per-worktree ownership record anywhere in the repo (no marker file, no manifest, no
  env var) that could tell a script "this worktree/branch belongs to agent/packet X" versus "the
  caller believes itself to be packet Y."

So the defect is not narrowly "commit-mine.mjs is missing a check" (BL-422's own fix-sketch (b)
suggests that, but does not mandate it — the item explicitly lists options without choosing). The
defect is structural: **the repo has no signal, anywhere, of "which branch does this commit belong
on," and no sweep that later reconciles a commit that landed on the wrong one.** 24 linked
worktrees exist right now, unswept, each one a candidate for exactly BL-422's failure if discarded.

## 2. The change, file by file

### 2.1 NEW `tools/sweep-worktree-branches.mjs` (the fix)

A read-only, git-plumbing-only script. Never writes a ref, never touches the working tree, never
runs `git checkout`/`worktree remove`/`worktree prune`. Two things it must detect, over every
**linked** worktree (i.e. every entry from `git worktree list --porcelain` other than the main
worktree — the main checkout is never swept; it is not disposable and is not the failure this
targets):

**Category A — branch-orphaned commits.** For a linked worktree whose HEAD is a named branch `B`:

```
otherRefs = (git for-each-ref --format='%(refname)' refs/heads/ refs/remotes/) minus refs/heads/<B>
orphans   = git rev-list <B> --not <otherRefs...>
```

`orphans` is exactly "commits reachable from `B` and from no other local or remote-tracking ref" —
the literal condition BL-422's title names ("reachable from nowhere else"), computed the same way
BL-422's own citation 1 diagnosed it (`git branch -a --contains <sha>`), just inverted into a scan
over every worktree instead of one known SHA.

**Category B — detached-HEAD worktrees.** For a linked worktree whose HEAD is detached (this repo
has two today: `.worktrees/cf-test`, `.worktrees/rf-test`), every commit reachable from that HEAD
and unreachable from **any** ref anywhere is strictly worse than Category A — no branch name points
at it at all, only that worktree's own `.git/worktrees/<name>/HEAD` file and its reflog, both of
which are pruned by ordinary `git worktree remove` / `git gc`:

```
orphans = git rev-list <HEAD-sha-of-that-worktree> --not --all
```

(`--all` here correctly includes every `refs/heads/*` and `refs/remotes/*` — for a detached
worktree there is no self-branch to exclude, unlike Category A.)

**Output contract:**

- Always print exactly one summary line to stderr, even when clean:
  `sweep-worktree-branches: <N> worktree(s) checked, <M> orphaned commit(s) across <K> branch(es)/worktree(s) [BL-422].`
  This line must print unconditionally (not gated on `--json`) — its presence is how the reviewer
  and any future auditor confirm the tool actually ran, per the BL-466 lesson quoted in the task
  ("16 guards written and never run"): a silent tool is indistinguishable from an unwired one.
- When `M > 0`, print one block per affected worktree: worktree path, branch name (or
  `(detached HEAD)`), commit count, and each commit as `<short-sha> <subject>` (from
  `git log --oneline`). Follow the existing `unstage-orphans.mjs` idiom exactly (`out()` helper,
  `--json` machine-readable mode emitting `{ worktrees: [...], summary: {...} }`).
- Flags, mirroring `unstage-orphans.mjs`'s existing vocabulary so operators don't have to learn a
  second CLI shape: `--json` (machine-readable), `--strict` (see Decision 3 — makes the exit code
  reflect findings; **absent by default**).
- **Exit code contract:** `0` in default (report) mode regardless of findings — see Decision 2/3.
  `1` under `--strict` if `M > 0`. Any internal crash (a git plumbing command failing for a reason
  other than "no commits" — e.g. corrupt worktree metadata) must be caught and reported as a
  per-worktree error line, not allowed to throw past `main()`; the overall exit code for a crash in
  one worktree's check must still be `0` in default mode (a script that can black out an entire
  commit because of one malformed worktree entry recreates BL-466's own failure shape one level up).
  Only `--strict` promotes both "findings" and "a worktree that could not be checked" to exit `1`.

### 2.2 NEW `tools/test-bl422-orphan-worktree-sweep.mjs` (the red→green pin)

Follow `tools/test-bl465-commit-mine-index-resync.mjs:1–199` and
`tools/test-bl409-pathspec-commit.mjs:1–60` verbatim as templates: `execFileSync`/`spawnSync` only,
`SAFE_GIT_ENV` stripping `GIT_DIR`/`GIT_INDEX_FILE`/`GIT_WORK_TREE`/`GIT_COMMON_DIR` (BL-479 — do
not skip this; its absence is what corrupted the real repo's index the one time a fixture omitted
it), scratch repos under `fs.mkdtempSync(path.join(os.tmpdir(), 'bl422-<label>-'))`, a
`report(name, ok, detail)` PASS/FAIL harness, `process.exit(failed === 0 ? 0 : 1)`.

Required arms (§4 gives the exact assertions):

1. **Core / red baseline.** Build a scratch repo: `main` with one commit, then
   `git worktree add ../wt -b feat/orphan-slug main`, commit once more **inside that linked
   worktree only**. Assert the underlying git condition BL-422 describes actually holds
   (`git branch -a --contains <sha>` lists exactly one branch) — this IS the red arm: it proves
   today's raw git state is silent/undetected, matching BL-422's own words ("the commit succeeds
   silently and is reachable from nowhere else"). Then run `sweep-worktree-branches.mjs` and assert
   it reports that exact SHA under that exact branch/worktree, count 1.
2. **Clean / no false positive.** Same scratch repo shape, but merge (or fast-forward) the
   worktree branch's commit into `main` before running the sweep. Assert the sweep reports `0`
   orphans for that worktree.
3. **Detached-HEAD arm.** `git worktree add --detach ../wtd <sha>`, then commit once more inside
   it. Assert the sweep reports it under Category B (`(detached HEAD)`), and that a Category-A run
   naming a fabricated branch name for it would NOT be how it's reported (i.e. detached worktrees
   are never misreported as a named-branch orphan).
4. **Multi-worktree, cross-reachable — no false positive.** Two linked worktrees, `wt1` and `wt2`,
   both branched from `main`. Cherry-pick `wt1`'s new commit onto `wt2`'s branch too (same content,
   different SHA is fine — or literally merge `wt1` into `wt2`, either establishes "reachable from
   a second ref"). Assert `wt1`'s original commit, now ALSO reachable via `wt2`, is **not** reported
   (proves the algorithm checks reachability from *any* other ref, not just `main`).
5. **`--strict` exit code.** Rerun arm 1's fixture with `--strict`: assert exit code `1`. Rerun
   without `--strict`: assert exit code `0` **even though the same orphan is present and reported**
   — this is the single assertion that pins the whole "report, don't refuse" ruling (Decision 2); if
   this assertion is ever changed to require nonzero without `--strict`, that is a deliberate
   reversal of Decision 2, not a bug fix, and must not happen inside this packet.
6. **Read-only / no mutation.** Snapshot `git worktree list --porcelain` and every branch's SHA
   before and after a sweep run over a fixture containing an orphan; assert byte-identical. No ref
   moved, no worktree removed, no file in any worktree's working tree touched.

### 2.3 EDIT `tools/guards-manifest.mjs`

Add one entry to the Tier 1 array (alphabetical/numeric position after `bl409`, before `bl435`, to
keep the existing ordering-by-id convention):

```js
{
  id: 'bl422',
  tier: 1,
  script: 'test-bl422-orphan-worktree-sweep.mjs',
  watch: ['tools/sweep-worktree-branches.mjs'],
},
```

This is hermetic (scratch `mkdtempSync` repos only, no prebuilt `dist/`, no real esbuild build) —
Tier 1 is correct per the manifest's own tier definition
(`tools/guards-manifest.mjs:6–8`). Do not set `needsBuild` or `driverArgs` (neither applies) or
`isolable: false` (the script resolves paths the same way `test-bl465-*` does — via
`import.meta.url`, not via `git rev-parse --git-common-dir` — so it IS isolable, unlike bl231).

`TIER1_COUNT`/`TIER2_COUNT` (`tools/guards-manifest.mjs:140–141`) are derived by `.filter().length`
— do not hand-edit any count.

### 2.4 EDIT `.husky/pre-commit`

Add one unconditional line, in the same style as the existing `check-amend-shared-index.mjs`
invocation, positioned **after** `run-guards.mjs --tier1` and **before** the final
`nx affected --target=lint` line:

```sh
# BL-422 — report (never block) commits on a linked worktree branch, or a detached worktree HEAD,
# that are reachable from no other ref. Local-machine-only condition: `.worktrees/` is gitignored
# (`.gitignore:63-64`), so CI never has linked worktrees to sweep — this line is the only place the
# check can run, and it must run on every local commit, not just ones that touch this tool
# (drift can orphan a commit made from ANY worktree, not just one that edited this script).
node tools/sweep-worktree-branches.mjs
```

This call is **unconditional** — not gated by the guards-manifest `watch` filter the way
`run-guards.mjs --tier1` is. The manifest/Tier1 registration in §2.3 exists to test the sweep
script's *logic* hermetically on every relevant change (drift protection for the tool itself,
matching the existing convention of every other `test-bl*.mjs`); it is a second, independent
invocation from the one that actually protects the developer's `.worktrees/` tree on every commit.
Both call sites are required — see Decision 4.

Because `.husky/pre-commit` runs under `set -e` (`.husky/pre-commit:11`), the sweep script's own
default-mode contract of "always exit 0 unless `--strict`" (§2.1) is what keeps this line
non-blocking — **do not** wrap the call in `|| true`; that would also silently swallow a genuine
crash in the script, and the whole point of §2.1's internal catch-and-report-not-throw contract is
that `|| true` is never needed.

### 2.5 Out of bounds — do not touch, and why

- **`tools/commit-mine.mjs`** — despite BL-422's own fix-sketch (b) naming it "the natural home,"
  it is explicitly **not** touched by this packet. See Decision 1. It was read in full
  (`tools/commit-mine.mjs:1–293`) specifically to confirm it has no ownership/identity check to
  extend and to confirm its existing detached-HEAD refusal (line 134, 245) is unrelated machinery
  (it refuses when `HEAD` has no branch at all, not when the branch is the wrong one) that this
  packet must not disturb.
- **`tools/unstage-orphans.mjs`** — a different concern (stale shared-*index* entries, BL-463), not
  branch reachability. Do not merge the two tools or add sweep logic into this file; they must stay
  independently testable and independently understandable, matching this repo's existing
  one-tool-one-incident convention (`commit-mine.mjs` for BL-409/457/465, `unstage-orphans.mjs` for
  BL-463, `check-amend-shared-index.mjs` for BL-457 detection — never one file accreting unrelated
  checks).
- **`tools/run-guards.mjs`** — its existing Tier1/Tier2/`--all`/`--isolate-worktree` machinery
  already covers a hermetic new guard with zero code changes; do not add BL-422-specific branches
  to this file.
- **`tools/plan-status.mjs`, `tools/check-amend-shared-index.mjs`, `tools/check-suite-tree-state.mjs`**
  — unrelated guards; do not touch.
- **Any `PKT-51` file** — PKT-51 is "not dispatched" per the task but also permits "a guard script
  under `tools/`." If, by the time this packet lands, PKT-51 has already added a
  `tools/*.mjs` file whose name collides or whose purpose overlaps what §2.1 specifies, STOP and
  escalate rather than silently merging or renaming around it — that adjudication is an architect
  decision, not an implementer one.

## 3. Every decision, ruled

### Decision 1 — Sweep (report), not a refuse-guard, as the primary mechanism

**Ruling: build the sweep (§2.1–§2.4). Do not build a refuse-guard in `commit-mine.mjs` or
anywhere else in this packet.**

Why the refuse alternative loses, specifically:

1. **No identity primitive exists to refuse against.** BL-422's incident branch name
   (`worktree-agent-a54e5171a1615a001`, under `.claude/worktrees/`) belongs to an external dispatch
   harness. `.claude/worktrees/` in this checkout holds nothing but `.DS_Store` — that harness's
   naming scheme is not this repo's own convention. This repo's own convention (used by the very
   dispatch protocol running this packet) is `.worktrees/<slug>` with branch `<type>/<slug>`,
   created explicitly by an architect/dispatcher per packet. There is no env var, marker file, or
   any other in-repo signal recording "which agent/packet owns this worktree" (confirmed by search
   — §0). A refuse-guard needs exactly that signal to distinguish "wrong agent, wrong packet"
   (must refuse) from "different agent, same packet, later pipeline stage" (must allow) — and the
   *only* candidate signal available without inventing new cross-process plumbing is the branch
   name itself, which is precisely the thing the agent in BL-422 already trusted blindly.
2. **This very dispatch protocol legitimately shares one worktree/branch across multiple, distinct
   agent invocations.** This task's own prompt is stage 1 of
   architect → implementer → reviewer → implementer → reviewer, all committing to the same
   `feat/pkt56-orphan-branch-guard` branch in the same worktree. A hard refuse keyed on "does this
   commit's author differ from the branch's creator" would block that sanctioned pattern outright —
   the task's own framing calls this out ("worktree commits are the sanctioned isolation mechanism
   here... refusing outright would break the normal path").
3. **A refuse-guard is only as strong as its opt-in.** The only workable refuse design considered
   (a `--expect-branch <name>` flag on `commit-mine.mjs`, refusing when it disagrees with
   `git rev-parse --abbrev-ref HEAD`) depends on the calling agent remembering to pass it — and
   only when calling `commit-mine.mjs` specifically. Plain `git commit <path>` (this repo's
   *documented default* — CLAUDE.md: "Commit with an explicit pathspec instead... Prefer this over
   npm/yarn" analog for commits) never touches `commit-mine.mjs` at all and would sail past any
   guard placed only there. An opt-in check that's silently skippable, covering only one of several
   commit paths, is exactly the BL-466 failure mode this task explicitly warns against ("16 guards
   had been written and never run").
4. **A refuse-guard is purely prospective.** It does nothing for the 24 worktrees that exist right
   now, unswept, today — the sweep is the only mechanism that reconciles present exposure, not just
   future commits.
5. **The sweep is trivially and durably wired**, for free, by this repo's own existing
   infrastructure (§2.3/§2.4): one manifest entry gets it exercised by `guards-tier1` on every local
   pre-commit *and* every CI push (`ci.yml:90`, unfiltered); one `.husky/pre-commit` line gets the
   real `.worktrees/` tree checked on every local commit, which is the only place it can run at all
   (CI has no linked worktrees — `.gitignore:63-64`, confirmed).

The task explicitly permits this choice ("...or that a sweep reports it as orphaned" is one of the
two named acceptable acceptance shapes) — this is not a workaround, it is the ruled design.

### Decision 2 — Sweep is non-blocking by default; `--strict` is opt-in, never wired into the hook

**Ruling: `tools/sweep-worktree-branches.mjs` exits `0` in its default invocation regardless of
findings. `.husky/pre-commit` calls it with no flags — every commit gets the report, no commit is
ever blocked by it.**

Why "blocking by default" loses: the sweep's entire value is that it requires no cooperation and
runs unconditionally; making it block would mean every commit made from a worktree with a
pre-existing (unrelated, already-known, already-being-worked) orphan elsewhere in `.worktrees/`
becomes uncommittable until that unrelated worktree is cleaned up — a global veto keyed on
per-machine housekeeping state that has nothing to do with the commit being made. That is a
availability regression with no matching safety gain (the orphan already existed before this
commit; refusing this commit does not un-orphan it). `--strict` exists for a human or a future CI
step that wants a hard gate on demand, but is never invoked by the hook itself.

### Decision 3 — Detached-HEAD worktrees are swept too (Category B), not just named-branch ones

**Ruling: §2.1 Category B is required, not optional.** BL-422's title and body speak only of
"a commit... on a disposable worktree branch," but this checkout has two live detached-HEAD
worktrees (`cf-test`, `rf-test`) today, and a detached HEAD is **strictly more exposed** than a
named branch: nothing but that one worktree's private HEAD file and its reflog references those
commits at all — no `git branch --contains` scan, however thorough, will ever find them, because
there is no branch. Scoping the sweep to Category A only and ignoring Category B would leave the
worse of the two failure modes completely uncovered, in this exact repo, right now.

### Decision 4 — Two separate invocations (manifest-tested + hook-invoked), not one

**Ruling: keep the Tier 1 manifest registration (§2.3, hermetic scratch-repo test of the script's
logic) and the unconditional `.husky/pre-commit` line (§2.4, real sweep of this machine's actual
`.worktrees/`) as two distinct call sites, per §2.1's own note.** Collapsing them — e.g. only
registering the guard and relying on `run-guards.mjs --tier1`'s filtered mode to eventually invoke
it — loses real-tree coverage on every commit that doesn't happen to touch
`tools/sweep-worktree-branches.mjs` (which is nearly all of them; drift can orphan a commit made
from any worktree regardless of what that commit touches). Collapsing the other way — only the hook
line, no manifest entry — loses CI-side regression coverage of the *script's own logic* (the
guard-tier1 CI step is unfiltered/`--all`, so it is the thing that would catch a future edit
breaking the sweep's detection logic, the same drift-safety-net role every other Tier 1 guard
plays).

### Decision 5 — Reachability reference set is `refs/heads/*` + `refs/remotes/*`, not just `main`

**Ruling: "reachable from nowhere else" means unreachable from *any* other local branch or
remote-tracking branch, not merely unreachable from `main`.** A commit cherry-picked or merged into
`wip/turso-live-metrics` or any other in-flight feature branch is not at risk of the BL-422 failure
mode (deleting one worktree's branch does not lose it) even though it is not on `main` — reporting
it as an orphan would be a false positive matching the exact shape §2.2 arm 4 pins against. Tags are
deliberately excluded from the reference set: nothing in this repo's workflow tags
work-in-progress commits, so including `refs/tags/*` would add scan cost for a category that cannot
occur here; if that changes, extending the `for-each-ref` pattern to include `refs/tags/` is a
one-line follow-up, not a redesign.

## 4. Acceptance criteria (each names BL-422; each states its red arm)

**AC-1 (core detection).** `node tools/test-bl422-orphan-worktree-sweep.mjs` arm 1 passes: a commit
made only inside a linked worktree, on a named branch, unreachable from any other ref, is reported
by `sweep-worktree-branches.mjs` with the correct branch name, worktree path, and SHA.
*Red arm:* before `tools/sweep-worktree-branches.mjs` exists (or with its Category A logic
disabled/stubbed to always return empty), the assertion "the sweep reports this SHA" fails —
nothing in the repo currently reports it, which is BL-422's own stated status quo ("the commit
succeeds silently and is reachable from nowhere else").

**AC-2 (no false positive on the clean case).** Arm 2 passes: once the worktree's commit is merged
into `main`, the sweep reports zero orphans for that worktree. *Red arm:* a naive implementation
that reports every commit on every linked-worktree branch unconditionally (ignoring reachability
from other refs) fails this arm by reporting a merged commit as still orphaned.

**AC-3 (detached-HEAD coverage).** Arm 3 passes: a commit made in a `--detach` worktree is reported
under Category B. *Red arm:* an implementation that only checks Category A (named branches) reports
zero findings for this fixture even though the commit is, in fact, unreachable from every ref in the
repo — the worse of BL-422's two failure shapes, silently uncovered.

**AC-4 (cross-worktree reachability, no false positive).** Arm 4 passes: a commit reachable from a
*second* worktree's branch (not `main`) is not reported. *Red arm:* an implementation that computes
reachability against `main` alone (Decision 5's rejected alternative) reports a false positive here.

**AC-5 (non-blocking by default, pinning Decision 2).** Arm 5 passes: the same fixture as AC-1,
without `--strict`, exits `0`; with `--strict`, exits `1`. *Red arm:* either (a) default mode exits
non-zero (would make `.husky/pre-commit` block ordinary commits on unrelated worktree housekeeping,
reversing Decision 2), or (b) `--strict` mode exits `0` despite a reported orphan (would make
`--strict` meaningless) — either failure trips this AC.

**AC-6 (read-only, pinning the "never destroy data" risk in §5).** Arm 6 passes: `git worktree list
--porcelain` output and every branch's SHA are byte-identical before and after a sweep run over a
fixture with a live orphan. *Red arm:* any implementation that calls `git worktree prune`,
`git worktree remove`, `git checkout`, `git branch -d`, or writes to any ref as part of detection
(rather than pure `rev-list`/`for-each-ref`/`log` reads) fails this arm — this is the assertion that
would catch a "helpful" implementer deciding to auto-clean instead of only reporting.

**AC-7 (wiring, pinning Decision 4 — do not become BL-466's failure shape).**
Two independent, observable facts, both required:
   (a) `tools/guards-manifest.mjs` contains a `bl422` entry and
       `node tools/run-guards.mjs --tier1 --all` (the unfiltered CI invocation,
       `.github/workflows/ci.yml:90`) reports `[PASS] bl422` in its output.
   (b) `.husky/pre-commit` contains the unconditional
       `node tools/sweep-worktree-branches.mjs` line, and running it directly
       (`node tools/sweep-worktree-branches.mjs`) against the real, current `.worktrees/` tree in
       `/Users/nix/dev/ai/sox-ecosystem` (the main checkout, not this spec's own worktree) emits
       the summary line and exits `0`.
*Red arm:* today, neither exists — `grep -c bl422 tools/guards-manifest.mjs` is `0` and
`grep -c sweep-worktree-branches .husky/pre-commit` is `0`. Post-fix, both are `≥1`, and (b)'s live
run must actually execute (not merely be present as dead text) — this is the direct antidote to
BL-466 ("16 guards had been written and never run"): an AC that only checks the line exists, without
also running it once and observing real output, would repeat that exact failure.

## 5. Risks

- **Nothing in this design writes a ref, deletes a branch, or removes a worktree** — §2.1's
  contract is read-only by construction, and AC-6 pins it. This is the correct posture per
  Decision 2/3: the tool's job is to make the existing 24-worktree exposure *visible*, not to act on
  it unilaterally (auto-merging or auto-deleting an orphan branch is a judgement call about which
  branch is "correct" that no script should make).
- **The one real hazard is in the test suite (§2.2), not the shipped tool**: every scratch repo must
  be built with `SAFE_GIT_ENV` (stripped `GIT_DIR`/`GIT_INDEX_FILE`/`GIT_WORK_TREE`/
  `GIT_COMMON_DIR`), exactly as `tools/test-bl409-pathspec-commit.mjs:34-38` and
  `tools/test-bl465-commit-mine-index-resync.mjs:49-53` already do, and exactly as their comments
  explain: BL-479 already turned an inherited `GIT_INDEX_FILE` into a corrupted real-repo index once
  via a scratch fixture. Do not write this test suite without that stripping — copy it verbatim from
  either existing file.
- **Do not build (`npx nx build ...`) anything for this packet.** Every file touched
  (`tools/sweep-worktree-branches.mjs`, `tools/test-bl422-orphan-worktree-sweep.mjs`,
  `tools/guards-manifest.mjs`, `.husky/pre-commit`) is a plain Node/`.mjs`/shell script, none is an
  nx-buildable project, none ships a `dist/` artifact. §6's gate is `node`/`nx run-commands` only —
  there is no `rm -rf dist/` hazard here (BL-235) because there is no `dist/` in this packet's blast
  radius. Confirm this remains true if the implementer's approach changes: if any file under this
  packet ever needs compiling, stop and treat that as a scope change requiring architect sign-off.
- **`.husky/pre-commit` is a shared, hand-edited file other in-flight packets may also be touching.**
  Edit it with `Edit`, not a full rewrite, and commit it by explicit pathspec
  (`git commit .husky/pre-commit tools/... -m "..."`), never `git add -A`. Re-run
  `node tools/install-git-hooks.mjs` after editing so the installed copy under `.git/hooks/pre-commit`
  picks up the change (per the file's own header comment) before relying on it locally.
- **Do not run the sweep's hook-mode invocation against the *shared main checkout's* real
  `.worktrees/` as a "test"** during development inside this spec's own worktree
  (`/Users/nix/dev/ai/sox-ecosystem/.worktrees/pkt56-orphan-branch-guard`) if it would need to
  inspect other agents' live, in-flight worktrees — it's read-only so this is safe from a data-loss
  perspective, but do it from the **main checkout path**
  (`/Users/nix/dev/ai/sox-ecosystem`, not this worktree) as AC-7(b) specifies, since a worktree does
  not necessarily see the full `git worktree list` the same way (it does, actually — worktree
  metadata is shared via the common `.git` dir — but running it from the canonical root keeps the
  verification unambiguous and matches how the hook will actually invoke it in practice).

## 6. The gate

None of the four touched files is nx-buildable (§5). The gate is therefore direct `node`
invocation plus the one nx target that already wires Tier 1 guards, run from
`/Users/nix/dev/ai/sox-ecosystem/.worktrees/pkt56-orphan-branch-guard`:

1. `node tools/test-bl422-orphan-worktree-sweep.mjs` — must print `All BL-422 assertions passed.`
   and exit `0`. Run it once with the fix absent/stubbed to confirm AC-1's red arm actually fails
   first (BL-225 — a marker records a verified outcome, not an intention).
2. `node tools/run-guards.mjs --tier1 --all` — must include `[PASS] bl422` in its output (AC-7a),
   with `0` overall failures among the guards this touches.
3. `npx nx run sox-ecosystem:guards-tier1` — the exact target CI runs
   (`.github/workflows/ci.yml:90`), from the packet's own worktree; confirms the manifest wiring
   works through the nx target, not just the raw script.
4. `node tools/sweep-worktree-branches.mjs` run once from the **main checkout**
   (`/Users/nix/dev/ai/sox-ecosystem`, per §5's note) — confirms AC-7b's live-run requirement
   against the real, current 24-worktree state. Report the output verbatim in the completion report;
   do not summarize it away — if it reports real orphans in the live repo, that is itself a finding
   to hand back, not noise to suppress.
5. `npx nx affected -t lint --base=main --head=HEAD` (or `npx nx run-many -t lint` if `affected`
   has no meaningful base in this worktree) — the repo's own lint gate; none of the touched files
   are TypeScript so this is expected to be a no-op, but run it to confirm nothing else drifted.
6. `node tools/check-suite-tree-state.mjs --project sox-ecosystem` is **not applicable** — this
   packet has no vitest/nx `test` target and touches no project with one; do not invent one. Do not
   run `npx nx test <anything>` for this packet — there is nothing to test through nx, and doing so
   would rebuild unrelated `dist/` artifacts for no reason (BL-456), a self-inflicted risk this
   packet has no need to take.
7. Commit by explicit pathspec, in this worktree:
   `git commit tools/sweep-worktree-branches.mjs tools/test-bl422-orphan-worktree-sweep.mjs tools/guards-manifest.mjs .husky/pre-commit -m "feat(scripts): sweep .worktrees/ for commits reachable from nowhere else (BL-422)"`
   (exact subject at implementer's discretion within the conventional-commit scope list; `scripts`
   is the correct scope per CLAUDE.md's enumerated list). Never amend, never `git add -A`.
