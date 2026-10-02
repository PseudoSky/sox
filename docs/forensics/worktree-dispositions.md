# Worktree Dispositions — integrate-or-delete decisions

**Base of record:** `main` = `cf3418649dc252cf72a935ab6ac7dbfb557473d8`
(`docs(forensics): assemble worktree inventory from 14 shard fragments`).
**Scope:** the 13 candidates in the disposition brief, plus the `bl466-wire-guards` hazard.
**Method:** read-only. Every ahead-count, conflict-count and blob hash below was produced by a
read-only `git` command (`rev-list --count`, `status --porcelain`, `merge-tree --write-tree`,
`ls-tree`, `ls-files`, `cat-file`, `diff-index --cached`) run by a forensics subagent against
`/Users/nix/dev/ai/sox-ecosystem` and the `.worktrees/*` checkouts. No trial merge, no worktree
removal, no branch deletion, no checkout, no stash, no reset, no clean, no build, no test was run
while producing this document. `registry/index.json` and every `BACKLOG.md` were not touched.
Claims not personally read are marked **(UNVERIFIED)**.

> **This document decides and prescribes. It executes nothing.** Every destructive step in the
> ordered sequence at the end is for `git-manager` to run later. `main` moves; `git-manager` must
> re-run the three re-verification commands (`git rev-list --count main..HEAD`; `git -C <wt> status
> --porcelain`; `git -C <wt> merge-tree --write-tree --name-only main <branch>`) before acting on
> any verdict below, and abort if a tip is no longer an ancestor or a conflict count has grown.

---

## Decisions by verdict

| Verdict | Count | Candidates |
|---|---|---|
| **integrate** (full, incl. in-place commit) | **8** | agmd-constraints, pkt56-orphan-branch-guard, migration-fails-open, sibling-scratch-cache, wt-sr79-substrate, fix-researcher-hitl-prompt, embedding-model-tier-spec, invalidation-reason |
| **integrate-partial** | **1** | bug-memory-006-community-affordance |
| **delete** | **4** | turso-adapter, cf-test, rf-test, recover-stash-typecheck-src |
| **hazard** (clear index → then delete) | **1** | bl466-wire-guards |

Of the 8 integrations, **4 are docs-only** (agmd-constraints AGENTS.md delta; pkt56 SPEC;
migration-fails-open SPEC; embedding-model-tier-spec SPEC) and need **no code review**; **4 ship
code** (sibling-scratch-cache, wt-sr79-substrate, fix-researcher-hitl-prompt, bug-memory-006) and
**must pass review before merge**. invalidation-reason is a commit-in-place of live docs, not a
worktree removal.

---

## THE HAZARD — `bl466-wire-guards` (clear the index, *then* remove)

**Re-verified state (holds against current `main`):**
- HEAD `88a9cee39eae6a8aeca7e9ce380c5bc961905dbc`, branch `feat/bl466-wire-guards`,
  `git rev-list --count main..HEAD` = **0**.
- `git merge-base --is-ancestor 88a9cee3 main` → **rc=0**: the tip is already an ancestor of `main`.
  **Zero unique commits; nothing to integrate.**
- `git ls-files | wc -l` = **21**; `git ls-tree -r HEAD | wc -l` = **1454**;
  `git ls-files` = 21;
  `git diff-index --cached --name-only HEAD | wc -l` = **1433 staged deletions**;
  `git diff --cached --shortstat` = `1433 files changed, 326997 deletions(-)`, **0 insertions**.
- `git status --porcelain | wc -l` = **1555**. 1432 of the deleted-in-index files still exist on
  disk and read as untracked, though byte-identical to HEAD.

**Why this is a repository-wiping trap:** the *index* — not the working tree — holds 1433 staged
deletions. A bare `git commit` in that worktree (or a `git commit -a`, or any `git add`-then-bare-
commit) would materialise a commit deleting 1433 tracked files. `git status` looks alarming; the
working tree is fine; **the index is the trap.** Therefore **"delete the worktree" is not the first
step** — removing a worktree with a poisoned index can also strand the staged state. The staged
deletions must be cleared first, without modifying the working tree.

**The exact safe procedure (nothing here is executed by this document):**

1. **Diagnose, do not commit.** In `HT=.worktrees/bl466-wire-guards` run the repo's own instrument
   read-only:
   ```
   node tools/unstage-orphans.mjs            # report only (no --apply)
   ```
   `tools/unstage-orphans.mjs` (BL-463) is **the right instrument here** — it is purpose-built to
   clear index entries an agent staged but never committed, it derives `divergent` from
   `git diff-index --cached --name-only HEAD` (exactly the 1433 staged deletions a pathspec-less
   commit would commit), and it **never writes the working tree**. It is not a general `git reset`;
   it targets precisely this failure shape.
2. **Read the report before applying.** The tool partitions `divergent` into **`safe`** (staged bytes
   identical to the working tree — clearable) and **`held`** (content that exists *only in the
   index* — reported with its blob sha via `git cat-file blob <sha>`, and **not** cleared by default,
   because clearing it would be real data loss). For `bl466` the 1432 on-disk files are byte-identical
   to HEAD and no path has unique index-only content, so `held` should be empty (or, at most, the 21
   surviving guard paths which are already tracked and match HEAD). **Confirm `held` is empty before
   applying.** If `held` is non-empty, stop and escalate — do **not** reach for `--force`.
3. **Clear the staged deletions** with the teardown-safe form:
   ```
   node tools/unstage-orphans.mjs --apply --min-idle-min 10
   ```
   `--apply` clears only the `safe` set via `git restore --staged -- <targets>`; the working tree is
   never modified. `--min-idle-min 10` is the **teardown-safe** guard: the tool **refuses to act if
   `.git/index` mtime is younger than 10 minutes**, so it cannot race a live agent that is actively
   staging in that worktree. Use `--json` if `git-manager` wants a machine-readable verdict.
   - Note the tool's semantics precisely: it **holds back** any path whose content exists only in
     the index (the `held` set) and reports it rather than clearing it. Its `--apply --force` exists
     to clear that held set too (recoverable from the object DB until gc) — **this document does not
     authorize `--force` for `bl466`**; there is no unique content to force past.
4. **Verify the poison is gone** (still read-only):
   ```
   git -C HT diff-index --cached --name-only HEAD | wc -l     # expect 0
   git -C HT status --porcelain | wc -l                        # expect clean/empty
   git -C HT diff HEAD --shortstat                             # expect empty
   ```
5. **Only now remove.** Since HEAD is an ancestor of `main` and there are zero unique commits:
   ```
   git worktree remove .worktrees/bl466-wire-guards
   git branch -d feat/bl466-wire-guards        # -d, not -D: it is merged
   ```
6. **Never**, at any point in that worktree: a bare `git commit`, `git add -A`/`git add .`, `git
   checkout .`, `git reset --hard`, `git stash`, or `git clean`.

**Backlog note.** The brief pairs this worktree with item `22f4f8ab`, described as "BL-466". That
pairing is **wrong** (see *Triage corrections*): `22f4f8ab` is a DEBT node about `guards-manifest.mjs`
exhaustiveness with **no** `BL-466` id; the real `BL-466` is uid `a93f36fc-5d63-45f1-a242-74e7f08d00cb`
(open, MEDIUM: "BL-named regression guards under tools/test-bl*.mjs are wired to no runner"). Both are
OPEN and neither blocks the removal — the worktree carries no unique content.

---

## Candidate verdicts

### 1. `turso-adapter` — **DELETE** (superseded; lift nothing)

**Re-verified state:** HEAD `f17b6193fc9cc98db94c976ae38a11c327998035` on `feat/turso-adapter`;
`main..HEAD` = **1**; `HEAD..main` = **1536**; working tree dirty (45 modified incl. package.json
stamps, 9 untracked, 0 staged); `main...HEAD` = **81 files, +5655/−4437**; `merge-tree --write-tree
--name-only main HEAD` = **rc=1, 187 conflicted paths** (the inventory said 59 — stale, see
*Triage corrections*), including **add/add on all 12 `libs/data/store/store-adapter/*` files**.

**Reason (one line):** the branch is a pre-0.8 "full store-adapter migration" that `main` has since
independently superseded with its own newer `store-adapter`/`turso-adapter`, and the now-committed
`docs/plan/turso-fts-migration/` plan is a *different subject* that does not need the branch.

**The reasoning, explicitly.** The brief asks whether the branch is superseded by
`docs/plan/turso-fts-migration/` (commit `051d033c`, an ancestor of `main`) or carries something the
plan needs. The plan (README/DESIGN/STATE, read) designs a **one-time Turso FTS 0.7.x→0.8.x format
migration**: 0.8.x opens a 0.7 store but its first FTS read/write errors, so the migration is
`DROP INDEX` + `CREATE INDEX … USING fts`, then a **same-version (0.8→0.8) `VACUUM INTO`**. That is a
*driver-format* migration for the adapter `main` already ships. The `turso-adapter` worktree's commit
`f17b6193` is a **pre-0.8 rewrite of the adapter and all its consumers** (81 files). The plan does not
need it; and 187 conflicted paths — with add/add across the entire `store-adapter` package that `main`
independently built — means integrating it would overwrite/deduplicate `main`'s newer package, not
extend it. **81 files / 187 conflicts for a superseded base is not worth it.**

**Confirmation no unique content is lost.** The branch's committed contribution is the *creation* of
`store-adapter` (README 443, `src/*` ~1.9k lines, `test/contract.test.ts` 796) plus rewrites of
`graph-store`, `memory-core`, etc. — all of which `main` now carries in a newer, independently
authored form (the add/add conflicts are the proof that both sides created the same package).
**Files worth a human glance, not a cherry-pick (all UNVERIFIED as to content):**
- `.worktrees/turso-adapter/libs/data/store/store-adapter/src/turso-adapter.ts` **uncommitted +72**
  and `test/contract.test.ts` **uncommitted +89** — the only deltas not folded into `f17b6193`; a
  reviewer *may* diff these two files against `main` for an idea. **Do not cherry-pick** — they sit on
  a 1536-behind base and cannot be applied cleanly.
- `registry/index.json` (+140 uncommitted) — **never touch** (ADR-0021: committed registry is
  publish-shape; a rebuild here would replace published pins with local hashes).
- The 9 untracked `.opencode/artifacts/{reports,reviews}/*.json` — process artifacts of the
  2026-07-26/27 wave; discard.

**Who acts:** `git-manager` (removal only). No integration dispatch.

---

### 2. `agmd-constraints` — **INTEGRATE** (docs-only; AGENTS.md delta only)

**Re-verified state:** HEAD `2867c8cc19f290493aee0692c365bdedced67f0b` on `docs/agmd-constraints`;
`main..HEAD` = **2**; `main...HEAD` = 3 files, `+24/−4`; `merge-tree` = **rc=1, 2 conflicts, both
generated:** `docs/reporting/memory/PLAN.md` and `STATE.md`. **`AGENTS.md` auto-merges clean.**

**Reason (one line):** `main` enforces commitlint already, but the *documentation* half — two ⛔
constraint sections absent from `main`'s `AGENTS.md` — is unmerged; the conflicting files are
generated churn to be dropped.

**Mechanism:** commit `c6df35d7` (`docs(authoring): add commitlint and --skip-nx-cache agent
constraints`) adds `AGENTS.md` **+20** (insertion-only), two sections: (a) **COMMIT MESSAGES MUST
SATISFY COMMITLINT** (~line 141) — `commitlint.config.js` extends `config-conventional`, enforced by
`.husky/commit-msg`; the scope enum is WARN/advisory; (b) **NEVER PASS `--skip-nx-cache` WITHOUT
APPROVAL** (~line 336) — default-banned, quote `tools/check-suite-tree-state.mjs` evidence. Land the
`AGENTS.md` hunk on **`main`**; **drop** the `PLAN.md`/`STATE.md` churn from `2867c8cc`. **No code
review** (docs-only). **Never** hand-edit generated `PLAN.md`/`STATE.md` (ADR-0011 §4).

**Who acts:** `git-manager` applies the `AGENTS.md` +20 (e.g. cherry-pick `c6df35d7` restricted to
`AGENTS.md`), then removes the worktree and `-d` the branch.

---

### 3. `bug-memory-006-community-affordance` — **INTEGRATE-PARTIAL** (code aligns with the ruling)

**Re-verified state:** HEAD `334819416ddabed438e667dba46896351011c61f`; `main..HEAD` = **6**;
`main...HEAD` = 5 files, **+997/−8** (`SPEC-BUG-MEMORY-006.md` +601; `bug-memory-006-…spec.ts` +312;
`memory-server/src/index.ts` **+84/−8**; `PLAN.md`/`STATE.md` +4/−4 each); `merge-tree` = **rc=1, 3
conflicts** (`PLAN.md`, `STATE.md`, `memory-server/src/index.ts`).

**Reason (one line):** the product ruling does **not** retire this work — it *endorses* it — so
integrate the code (error taxonomy) and the spec, dropping PLAN/STATE churn.

**Reading of the ruling `20b661a2` (uid `20b661a2-f16e-48cc-815b-0771ed0ad045`, imported as
CHORE-MEMORY-001, status OPEN, MEDIUM).** Title: *"PRODUCT RULING: do NOT build entity→community
resolution — the need is real but already served by `memory_entity_episodes`; 'the' community of an
entity is not well-defined … retire the advertised capability."* Decisive sentences, verbatim:

> ## VERDICT: build nothing. Retire the advertised capability.
> **Do not ship a singular answer to a plural question.**

**This does not moot the worktree — it *is* the worktree's brief.** The ruling's recommended shape
item 1 is *"Correct the affordance — the whole fix, and it **belongs to `BUG-MEMORY-006`**"*: make
`entity_uid` episode-only and name `memory_entity_episodes` as the entity path. Its **AC-2** reads:
*"A live `memory_get_community` call with a known entity uid returns an error whose message names the
actual node kind found… (Mechanism is `BUG-MEMORY-006`'s `E_WRONG_KIND`)".* The worktree's `index.ts`
delta is exactly and only that error taxonomy (**+84/−8**: `E_WRONG_KIND`, `E_PENDING_CLUSTER`,
advisory `E_WRONG_ID_SPACE` on the `memory_get_community` miss path) — it **adds no resolution
capability**. So the brief's hypothesis ("delete rather than integrate a capability the product has
ruled against") is **incorrect on the facts**: the product ruled against *building the capability*,
and this branch *removes the false claim of it*, which is AC-1/AC-2 of that very ruling.
(Related resolved triage `acb84de8`, uid `acb84de8-a8a3-4552-867e-4f8b38dcdafa`, status RESOLVED
2026-08-08: "no defect in GC; `E_NOT_FOUND` was correct; it is a doc/error-taxonomy gap" — consistent.)

**Exact subset to integrate:**
- `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts` **+84/−8** — the error
  taxonomy. **Requires conflict resolution**: `main` has diverged at this file (923 behind).
- `…/memory-server/src/bug-memory-006-community-affordance.spec.ts` **+312** (new) — the regression
  spec.
- `SPEC-BUG-MEMORY-006.md` **+601** (new) — keep as the record, but **reconcile**: it predates the
  ruling and (UNVERIFIED) may still present the "accept an entity uid and resolve it" option that
  `20b661a2` rejects. It must be amended to cite `20b661a2` as the authoritative decision.
- **Drop** `PLAN.md`/`STATE.md` (generated; ADR-0011).
- The ruling's item 2 (retire `buildCommunities`/`memoryGetCommunity`) and AC-3 are a **separate**
  follow-up (`BUG-MEMORY-007` sibling `aa836806`, open) — out of this subset's scope.

**Mechanism:** rebase the branch onto `main`; resolve `index.ts` keeping `main`'s structure and
re-applying only the E_WRONG_KIND/E_PENDING_CLUSTER/E_WRONG_ID_SPACE additions; land on **`main`**.
**Needs review before merge** (shipping `index.ts` code). A test naming the fixture from `20b661a2`
AC-2 (a known entity uid) is the red→green pin.

**Who acts:** `implement` (rebase + conflict resolution) → `review` → `git-manager` merges.

---

### 4. `pkt56-orphan-branch-guard` — **INTEGRATE** (docs-only)

**Re-verified state:** HEAD `b6be4d6580bab0e8c3416386f64238c3e651fc06` on
`feat/pkt56-orphan-branch-guard`; `main..HEAD` = **1**; `main...HEAD` = **1 file, +466** (new
`SPEC-PKT-56.md`); `merge-tree` = **rc=0, 0 conflicts**.

**Reason (one line):** the spec is the design for `BL-422`, an OPEN HIGH item with no implementation
in `main` — and the failure it designs against is precisely the failure that produced this triage.

**`BL-422` reading (uid `59c2cd66-ae12-474a-901d-1293a71a9656`, confirmed = `BL-422`, status OPEN,
kind BL, priority HIGH).** *"an agent's commits can land on a disposable worktree branch and be
reachable from nowhere else."* Measured 2026-08-03: commits `af45f77` and `e275039` landed on
`worktree-agent-a54e5171a1615a001` — a *different* agent's disposable branch — **and nowhere else**,
because the harness moved the committing agent's cwd mid-session. Its fix sketch (a)–(d) and
acceptance (a test that names BL-422) are the subject of `SPEC-PKT-56.md`. **No BL-422
implementation exists in `main`** (grep for a PKT-56/BL-422 guard in `main` returns nothing — the
shard-I read confirms `main` has `SPEC-PKT-07/18/22/38/39/55/57-63/74/75/79` but **not 56**).

**The irony, and the action.** The forensic triage that names these 13 candidates exists *because*
commits can strand on disposable worktree branches — the exact failure `BL-422`/`SPEC-PKT-56.md`
designs a sweep against. The right response is to land the spec so the sweep can be implemented, not
to let the spec itself strand.

**Mechanism:** cherry-pick `b6be4d65` (or apply `SPEC-PKT-56.md`) onto **`main`**. **No code review**
(docs-only). Then open a follow-up implementation dispatch (the sweep guard) against `BL-422` and
relate the spec to that item via `backlog-operator`.

**Who acts:** `git-manager` (land the file) then a `backlog-operator` follow-up to relate the spec to
`BL-422`; removal of the worktree + `-d` the branch.

---

### 5. `migration-fails-open` — **INTEGRATE** (docs-only; cross-linked to the Turso plan)

**Re-verified state:** HEAD `944034a99f322af74a3b0711d4c877d2cf461953` on
`feat/migration-fails-open`; `main..HEAD` = **1**; `main...HEAD` = **1 file, +487** (new
`SPEC-MIGRATE-UNSAFE.md`); `merge-tree` = **rc=0, 0 conflicts**.

**Reason (one line):** a real, unfixed migration-safety spec (`BUG-STOREADAPTER-MIGRATE-UNSAFE-001`)
absent from `main`; land it as its own document and point the Turso migration plan at it.

**Decision among the three options.** *Adopt as its own item* — **chosen**, because the fail-open
hazard is about the store-adapter migration path generally, whereas `docs/plan/turso-fts-migration/`
is a specific one-time *driver-format* migration (0.7→0.8 FTS rebuild + same-version `VACUUM INTO`).
Folding a general safety spec inside a plan that is itself "design spec, not authorized to execute"
would bury it; discarding it loses the only record of an un-fixed bug. The spec's 487 lines are
**UNVERIFIED** as to content, but its target (`BUG-STOREADAPTER-MIGRATE-UNSAFE-001`) and absence of
any fail-open fix in `libs/data/store/store-adapter/src` were confirmed read-only.

**Mechanism:** cherry-pick `944034a9` (the single new file) onto **`main`**. **No code review**
(docs-only). `git-manager` adds **one** cross-reference line in
`docs/plan/turso-fts-migration/DESIGN.md` noting that the migration step must not fail open, per
`SPEC-MIGRATE-UNSAFE.md` — so the plan's `DROP INDEX`/`CREATE INDEX`/`VACUUM INTO` sequence inherits
the safety requirement. Relate both to a new `BUG-STOREADAPTER-MIGRATE-UNSAFE-001` via
`backlog-operator` if not already filed.

**Who acts:** `git-manager` (land file + one cross-ref); removal + `-d` the branch.

---

### 6. `cf-test` — **DELETE** (redundant; no unique content)

### 7. `rf-test` — **DELETE** (redundant; no unique content)

**Three-way comparison result — cf-test vs rf-test vs current `main`.** Both worktrees sit on the
**same detached HEAD `6de81319665f4df561ad6b3d841f6d75eeb64846`** (0 ahead, **1531 behind**), clean
except for the 29 package.json stamps plus one uncommitted `libs/memory-core/src/cluster.ts` draft
each.

- **cf-test draft** (`buildClusterResults`): `membersWithVecs = members.filter((r) =>
  rowidToVec.has(r)); if (membersWithVecs.length < 2) continue;` then
  `communityUid(sortedMembers, salt)` / `member_rowids: sortedMembers` over the filtered set.
  Cites a **placeholder `(BL-NNN)`**.
- **rf-test draft**: one explicit loop building `memberVecs[]` + `validMembers[]` keeping only
  rowids that have a vector; `if (validMembers.length < 2) continue;` then
  `communityUid(validMembers, salt)` / `member_rowids: validMembers`. Cites **`BL-259`** and "D1.6".
- **Diff between them: FUNCTIONALLY IDENTICAL.** Both filter the member set to vector-bearing rowids
  *before* computing the community uid and *before* setting `member_rowids`; only the expression
  differs (`map`+`filter` vs a keep-loop). **No behavioural difference.**
- **Current `main`** (`buildClusterResults`, `cluster.ts` ~lines 353–608): `sortedMembers` is
  **unfiltered**; `memberVecs = sortedMembers.map(r => rowidToVec.get(r)!).filter(Boolean)`;
  `member_rowids: sortedMembers` **unfiltered**. So `main` *does* still carry the inconsistency both
  drafts patch. **But `main`'s caller already guarantees the invariant upstream**:
  `computeClusters` builds `candidateRowids = rowids.filter(r => rowidToVec.has(r))` and feeds
  `runClusters` only those, so `rowidToVec.get(r)!` cannot be undefined on the full-pass path.
  **Both drafts are defensive no-ops against current `main`.**

**Reason (one line each):** both are functionally identical no-op hardening of an invariant `main`'s
caller already guarantees, authored against a 1531-behind base that lacks `main`'s entire current
`cluster.ts` (incrementalJoin, calibrateThreshold, cluster-metrics, BL-496/497 content floor); one
cites a placeholder id, the other cites a **deleted** item (`BL-259` — see *Triage corrections*). No
unique content is lost.

**If the hardening is still wanted**, it should be a **fresh** small change against current `main`
citing the real invariant — not a 1531-behind 2-line patch. That is a new dispatch, not this
worktree.

**Who acts:** `git-manager` removes both detached worktrees (no branch to delete — detached). Both
tips are ancestors of `main` (they *are* `main`'s ancestor `6de81319`), so nothing strands.

---

### 8. `sibling-scratch-cache` — **INTEGRATE** (code; needs review)

**Re-verified state:** HEAD `3088dc1b97f7e2840966639a5218c54f6430b3ef` on `fix/sibling-scratch-cache`;
`main..HEAD` = **3**; clean (`status` empty); `main...HEAD` = **23 files, +1949/−29**, all under
`libs/data/search/hybrid-search/*` and `libs/data/verify/claim-verification/*`
(`scratchModelCache.ts`, `vitest.global-scratch.ts`, `requiredModels.ts`, named specs);
`merge-tree` = **rc=0, 0 conflicts**.

**Reason (one line):** a clean, conflict-free, ticketed (`BL-230d1d2a`) scratch-model-cache fix for
the operator-cache-leak family, with no blocker in `main`.

**Ticket reading (`BL-230d1d2a`, uid `230d1d2a-e7be-433b-acfd-79661269c719`, status OPEN, MEDIUM).**
Body: an embedding-provider spec forks `fastembedProcessHost` with `CACHE_DIR` pointing at the
**operator's real model cache** (`~/.cache/sox/models`), so a test can load *or download into* the
operator cache — the same leak class as BL-26291f21, in a different project with its own vitest
harness. Suggested fix: seed a scratch cache (`cp -c` clone) and point `CACHE_DIR` at it. This is
open and wanted. Note the sibling review item `ee424bc9-59bc-4924-975a-448890c68353` ("embed-provider
scratch harness review follow-ups", OPEN, MEDIUM) is the review pass over **branch
`fix/sibling-scratch-cache`** — the merge must resolve those follow-ups.

**Mechanism:** rebase `fix/sibling-scratch-cache` onto **`main`** (0 conflicts expected), land on
`main`. **Needs review before merge** (test-support code), addressing `ee424bc9`.

**Who acts:** `implement` (rebase) → `review` (incl. `ee424bc9` items) → `git-manager` merges.

---

### 9. `wt-sr79-substrate` — **INTEGRATE** (code; needs review)

**Re-verified state:** HEAD `6e619e374c5947375a44ff90e63c4aa3dfc0dabc` on
`feat/sr7-sr9-substrate`; `main..HEAD` = **1**; clean; `main...HEAD` = **14 files, +419/−53**
(`recluster-job.ts`, `curate.ts`, memory-server `index.ts`/README/CLAUDE/extension.json/package.json,
spec, `.changeset/sr7-sr9-substrate.md`, `scripts/check-changeset-surface.{ts,test.ts}`);
`merge-tree` = **rc=1, 3 conflicts**: `.changeset/sr7-sr9-substrate.md` (**modify/delete** — deleted
in `main`, modified in HEAD), and memory-server `extension.json` + `package.json` (**content**).

**Reason (one line):** small, real SR-7/SR-9 substrate work with only three expected conflicts —
resolve the generated surfaces, keep the substrate.

**Mechanism:** rebase onto `main`; resolve the 3 conflicts by keeping `main`'s
`extension.json`/`package.json` generated fields and re-applying the substrate's version/entry
changes; for `.changeset/sr7-sr9-substrate.md`, keep the changeset (re-add it) since SR-7/SR-9 is a
shipping change. Land on **`main`**. **Needs review before merge.**

**Who acts:** `implement` (rebase + conflict resolution) → `review` → `git-manager` merges.

---

### 10. `fix-researcher-hitl-prompt` — **INTEGRATE** (code; needs review)

**Re-verified state:** HEAD `e85d5bca74688dad5649ba9fd133955e8895ac5e` on
`fix/researcher-hitl-prompt`; `main..HEAD` = **1**; clean; `main...HEAD` = **3 files, +165/−6**
(`extensions/agents/researcher/agent.md`, `tools/guards-manifest.mjs`,
`tools/test-9b339298-researcher-hitl-prompt.mjs` +148 new); `merge-tree` = **rc=0, 0 conflicts**.

**Reason (one line):** a conflict-free, self-testing fix (agent prompt + guard registration + its
own regression pin) for the researcher HITL pause-and-resume behaviour.

**Mechanism:** rebase (or cherry-pick `e85d5bca`) onto **`main`**. **Needs review before merge**
(ships a guard-manifest change and an agent prompt). Note `tools/guards-manifest.mjs` is the file the
DEBT `22f4f8ab` is about (unregistered pins) — the review should confirm this new pin is itself
registered and does not widen that gap.

**Who acts:** `implement`/`git-manager` (cherry-pick) → `review` → merge.

---

### 11. `embedding-model-tier-spec` — **INTEGRATE** (docs-only)

**Re-verified state:** HEAD `b15cdc005531633e2c11f9b10695f9ccc28faece` on
`docs/embedding-model-tier-spec`; `main..HEAD` = **5**; clean; `main...HEAD` = **1 file, +1528**
(new `docs/plan/embedding-model-tier/SPEC.md`); `merge-tree` = **rc=0, 0 conflicts**.

**Reason (one line):** a conflict-free, docs-only plan SPEC (owner decisions O1–O6) that does not yet
exist in `main`.

**Mechanism:** cherry-pick the 5 `docs(…)` commits (or the net new file) onto **`main`**. **No code
review** (docs-only). The plan directory does not exist in `main` today (confirmed: only this
worktree has it). Follow-up: the plan's own authorisation/entry-blocking flow is a `plan-builder`
concern, not this disposition.

**Who acts:** `git-manager` (cherry-pick the doc commits), removal + `-d` the branch.

---

### 12. `recover-stash-typecheck-src` — **DELETE** (fully redundant; committing it would regress)

**Re-verified state:** HEAD `86de3108fab702de3f14dbb9412fbc54efe8402d` on
`recover/stash-typecheck-src`; `main..HEAD` = **0** and `git merge-base --is-ancestor` → HEAD is an
**ancestor of `main`**; `main...HEAD` = **empty**; 2 **staged** paths.

**The staged work is not just redundant — part of it is older than `main`:**
- `…/members/memory-server/project.json` staged blob `b1782e8d` **==** `main:b1782e8d` →
  **byte-identical to `main`; zero effect**. `main`'s `typecheck-src` already runs
  `tsc -p …/tsconfig.typecheck.json --noEmit`, with the full `noop → typecheck-tests →
  typecheck-src` layering via `86de3108`/`b1d71619` (shard-N's finding, **confirmed**).
- `tools/test-7ff58364-gate-reaches-typecheck-tests.mjs` staged blob `70071524` **≠** `main`'s
  `e4273d19` → `main`'s version is **newer** (`git diff main` = +73/−177): `main` carries a hardened
  generation (single `nx graph` discovery, `--project` long form, `parsed.errors` check, test-support
  detection, guards-manifest coverage). **Landing the staged copy would regress `main`.**

**Reason (one line):** the staged `project.json` is byte-identical to `main` and the staged guard file
is an older generation than `main`'s — the aim already landed via `6236789a`, so this is fully
redundant and the guard file is a regression if committed.

**Who acts:** `git-manager` clears the two staged entries (the worktree's own index) — the
`unstage-orphans.mjs --apply` form applies here too, or a plain `git restore --staged` in that
worktree — then removes the worktree and `-d` the branch (merged: HEAD is an ancestor). **No content
is lost** (both paths' content exists on `main`).

---

### 13. `invalidation-reason` — **INTEGRATE-IN-PLACE** (live docs in the primary checkout; commit, curate, discard junk)

**Re-verified state:** this is the **primary checkout** (`/Users/nix/dev/ai/sox-ecosystem`) on branch
**`main`** itself; `main..HEAD` = **0**. Dirt: **14 unstaged modified** dispatch-skill files
(`+124/−49`) and **31 tracked-untracked paths**. `diff --cached` = empty. (`merge-tree` against
itself: clean.)

**The 14 modified files are a coherent, uncommitted change — the "merge-first delivery loop":**
`extensions/agents/dispatcher/*` (dispatcher.md 75, extension.json 8, CHANGELOG 4),
`extensions/skills/dispatch-contract/*` (SKILL 30, templates/brief.md 11, CHANGELOG 4),
`dispatch-direct/*` (SKILL 12, extension 2, CHANGELOG 4), `dispatch-plan/*` (SKILL 5, CHANGELOG 4),
`dispatch-triage/*` (SKILL 8, extension 2, CHANGELOG 4). Theme: dispatcher rule 5 rewritten
(merge on own gates → resolve on merge → review from `main` pinned to the merged sha; HIGH bucketed,
not a blocker), new dispatch-contract §1a/§1b + a "Review target" block in `templates/brief.md`,
dispatch-direct Steps 10–11 inverted (+ flow diagram + hard rule), dispatch-plan Step 4,
dispatch-triage flow/Step 7; versions bumped to 1.8.0/1.5.0. **This supersedes the pre-merge review
gate (`19434c31`).** It is **docs-only** → **commit to `main`, no code review.**

**The 31 untracked paths — triage by content, not by the worktree's name (the name is a mismatch:
"invalidation-reason" holds no invalidation-reason work).**
- **Keep & commit** (real work products): `SPEC-EMBEDDING-HOST.md` (190);
  `docs/plan/{ENGAGEMENT-HANDOFF,case-library-storage-model,plan-value-assessment,
  researcher-process-refactor,store-adapter-batch-0.10.0}/*`;
  `docs/reporting/memory/findings/2026-09-29-turso-native-vector-search-viability.md` (98);
  `docs/research/fallback/2026-09-29-*` (2);
  `.opencode/skills/sox-ingest/**` (~1.6k lines incl. tests),
  `.opencode/skills/forbidden-skill/**`, `.opencode/tools/di-command/**` —
  plus `.opencode/artifacts/reports/*.json` (3).
- **Scratch — do not commit, safe to discard:** `.research-trace/` (9 files),
  `.worktree-forensics/shard-{A..N}.md` (14 — the triage inputs, now superseded by the inventory),
  `.mcp.json.bak-20260930T235930`.

**Reason (one line):** the primary checkout holds a coherent, uncommitted docs change and a set of
real-but-untracked work products; commit the change, curate the products, discard only the scratch —
and there is **no worktree to remove** (this *is* `main`).

**Mechanism:** `git-manager` commits the 14 dispatch-skill edits **by explicit pathspec** (never
`-A`); commits the keep-list paths (or, for the `docs/plan/*` dirs, routes them to `plan-builder` if
they are meant to be plan-state-machine dirs); deletes only the scratch set. No branch, no worktree
removal.

**Who acts:** `git-manager` (pathspec commits + scratch removal).

---

## Cross-cutting: `cf-test` vs `rf-test`

**Result: functionally identical no-ops.** Same detached base `6de81319` (1531 behind); both add the
*same* member-filtering invariant to `buildClusterResults` (filter members to vector-bearing rowids
before computing `communityUid`/`member_rowids`) — cf-test as `.filter(rowidToVec.has)` +
`.map(get!)`, rf-test as a keep-loop; no behavioural difference. `main` already guarantees the
invariant in `computeClusters` (it only passes rowids that have vectors), and `main`'s `cluster.ts`
is otherwise an entirely different, far newer file. **Delete both.** If the hardening is desired,
re-do it fresh against `main`; do not lift a 1531-behind 2-line patch.

---

## Triage corrections (the inventory is a prior, not scripture)

1. **Worktree count is 79, not 67.** The `.worktree-forensics` shards and the inventory counted 67;
   `git worktree list --porcelain` returns **79** (main + 78 linked), the extra 8 being ephemeral
   `.claude/worktrees/agent-*` agent worktrees.
2. **`turso-adapter` conflicts are 187, not 59.** `git merge-tree --write-tree --name-only main HEAD`
   returns rc=1 with **187** conflicted paths (12 of them add/add across `store-adapter`).
3. **`turso-adapter` uncommitted non-stamp files: 45 modified, not 16.** (`status --porcelain` = 45
   ` M` + 9 `??`, 0 staged.)
4. **"`22f4f8ab` = BL-466" is wrong.** `22f4f8ab-a682-41bb-8ae2-57e14c41132d` is a **DEBT** node
   about `guards-manifest.mjs` exhaustiveness with **no** humanId. The real `BL-466` is uid
   `a93f36fc-5d63-45f1-a242-74e7f08d00cb` (open, MEDIUM). Neither affects the `bl466-wire-guards`
   worktree's verdict (its tip is an ancestor of `main`; zero unique content).
5. **`bug-memory-006-community-affordance` is NOT mooted by `20b661a2`.** The ruling *endorses* the
   worktree's error-taxonomy fix (it names `E_WRONG_KIND` as its AC-2 mechanism and assigns the fix to
   `BUG-MEMORY-006`). Only the *capability* (entity→community resolution) is retired. Corrected from
   the brief's premise.
6. **`recover-stash-typecheck-src` is fully redundant AND regressive.** Not merely "already complete
   in `main`": the staged `project.json` is byte-identical to `main` (blob `b1782e8d`), and the
   staged guard file is an **older** generation than `main`'s (+73/−177), so committing it would
   regress `main`. Shard-N's "typecheck layering already complete" finding is confirmed.
7. **`BL-259` and `BL-247` no longer resolve.** Both were **soft-deleted 2026-09-27** by
   `opencode:data-hygiene` ("content superseded by CHANGELOG + linked issues"). `BL-259`'s former
   subject was smoke-test launchd collision (not `cluster.ts`), so `rf-test`'s `BL-259` citation is
   stale; `BL-247` was a RESOLVED (2026-07-10) memory-invalidate test-coverage item. Neither can
   anchor new work.
8. **The `invalidation-reason` name is a content mismatch.** The worktree holds no
   invalidation-reason work: it is the primary checkout (`main`) with dispatch-skill doc edits and
   research/plan artifacts.

---

## Ordered execution sequence (`git-manager` — follow top to bottom)

> Precondition for every step: re-run the three re-verification commands for the target worktree and
> abort if the tip is no longer an ancestor (for deletes) or a conflict count has grown. Commit
> **by explicit pathspec** only; never `git add -A`/`.`/`git commit -a`/`--amend`/`--no-verify`/stash/
> reset/clean. `.husky` hooks stay **on**.

**Phase 0 — defuse the hazard first (before any sweep scans worktrees).**
0.1. `bl466-wire-guards`: run `node tools/unstage-orphans.mjs` (report) **in that worktree**; confirm
     `held` is empty. Then `node tools/unstage-orphans.mjs --apply --min-idle-min 10`. Verify
     `git -C .worktrees/bl466-wire-guards diff-index --cached --name-only HEAD` is empty and
     `status --porcelain` is clean. Then `git worktree remove .worktrees/bl466-wire-guards`;
     `git branch -d feat/bl466-wire-guards`. **Never `--force`; never a bare commit in that tree.**

**Phase 1 — docs-only integrations (no code review).**
1.1. `agmd-constraints`: land the `AGENTS.md` **+20** from `c6df35d7` on `main`; drop PLAN/STATE.
     Then remove the worktree + `git branch -d docs/agmd-constraints`.
1.2. `pkt56-orphan-branch-guard`: land `SPEC-PKT-56.md` (`b6be4d65`) on `main`. Follow-up:
     `backlog-operator` relates it to `BL-422`. Then remove + `-d feat/pkt56-orphan-branch-guard`.
1.3. `migration-fails-open`: land `SPEC-MIGRATE-UNSAFE.md` (`944034a9`) on `main`; add one
     cross-reference line in `docs/plan/turso-fts-migration/DESIGN.md`. Then remove +
     `-d feat/migration-fails-open`.
1.4. `embedding-model-tier-spec`: cherry-pick the 5 `docs(…)` commits (net: the new SPEC) on `main`.
     Then remove + `-d docs/embedding-model-tier-spec`.

**Phase 2 — code integrations (review required before merge).**
2.1. `sibling-scratch-cache`: `implement` rebases onto `main` (resolve `ee424bc9` review follow-ups)
     → `review` → `git-manager` merges → remove + `-d fix/sibling-scratch-cache`.
2.2. `fix-researcher-hitl-prompt`: cherry-pick `e85d5bca` onto `main` → `review` (confirm the new
     guard pin is registered, per DEBT `22f4f8ab`) → merge → remove + `-d fix/researcher-hitl-prompt`.
2.3. `wt-sr79-substrate`: `implement` rebases, resolves the 3 conflicts (keep `main`'s generated
     `extension.json`/`package.json`, re-add the changeset) → `review` → merge → remove +
     `-d feat/sr7-sr9-substrate`.
2.4. `bug-memory-006-community-affordance`: `implement` rebases, resolves the `index.ts` conflict
     keeping only the E_WRONG_KIND/E_PENDING_CLUSTER/E_WRONG_ID_SPACE additions, drops PLAN/STATE,
     amends `SPEC-BUG-MEMORY-006.md` to cite `20b661a2` → `review` (test names the AC-2 entity-uid
     fixture) → merge → remove + `-d feat/bug-memory-006-community-affordance`.

**Phase 3 — primary-checkout curation (candidate 13).**
3.1. Commit the 14 dispatch-skill edits by pathspec on `main` (docs-only).
3.2. Commit the keep-list work products (or route `docs/plan/*` to `plan-builder`).
3.3. Delete only the scratch set (`.research-trace/`, `.worktree-forensics/shard-*.md`,
     `.mcp.json.bak-20260930T235930`). **No worktree removal (this is `main`).**

**Phase 4 — verified deletions (no unique content).**
4.1. `turso-adapter`: confirm tip not an ancestor then `git worktree remove .worktrees/turso-adapter`;
     `git branch -D feat/turso-adapter` **only after** a final `merge-tree` confirms nothing was
     merged (it was not — 1 unmerged commit, 187 conflicts; use `-D` with the recorded reason, or keep
     the branch ref if policy prefers). No files lifted.
4.2. `cf-test` (detached at `6de81319`): `git worktree remove .worktrees/cf-test`. No branch.
4.3. `rf-test` (detached at `6de81319`): `git worktree remove .worktrees/rf-test`. No branch.
4.4. `recover-stash-typecheck-src`: clear the 2 staged entries in that worktree, then
     `git worktree remove .worktrees/recover-stash-typecheck-src`; `git branch -d
     recover/stash-typecheck-src` (merged: ancestor of `main`).

**Phase 5 — backlog (do not use git for this).**
5.1. `backlog-operator`: file/relate the follow-ups produced above — the `BL-422` sweep implementation
     (spec landed in 1.2), a `BUG-STOREADAPTER-MIGRATE-UNSAFE-001` link for 1.3, and the
     `20b661a2`-authorised retirement work (its item 2 / AC-3, sibling `aa836806`). Report, never
     invent.

**Do not use git for backlog. Do not run backlog commands from this document — dispatch
`backlog-operator`.**
