# Changelog

## 1.10.0

- **Status table rebuilt for multi-project runs (3-column, cost row deferred).** The standing table is now `| axis | status | note |` with rows Objective / Plan / Absorbed / Discovered / Dispatches / Blockers — the separate Δ column and the Cost row are gone. Each axis's `status` cell splits **by project**: bold project name, `·`, that project's delta inline (coloured by meaning — green `#1a7f37` good movement, red `#cf222e` bad, amber `#9a6700` flat/zero/unmeasurable), then the project's values. The Cost row is removed solely because no dispatcher-readable surface exposes per-task cost/token telemetry (the capability lives in the scratch repo's metadata tools); it is an interim, **reversible** decision — restore the row with measured cumulative spend + a next-wave projection once those tools are dispatcher-readable. Cost-at-decision-time still governs (rule 21); only its rendering is deferred.
- **Reaching a live dispatch: APPEND vs RESUME, and the never-cold-restart rule (Step 4).** Verified against the opencode substrate: re-invoking an agent with its existing dispatch id is one call with two modes chosen by the target's state — **running → APPEND** (text lands in the live context, the agent is not interrupted, and reads it when it next looks; advisory, no force-stop) and **completed → RESUME** (revived with the whole prior transcript replayed; use only when the follow-up needs the accumulated context). Recovery for a `partial`: send the **full original brief plus an account of what it already achieved** — never cold-restart (a cold re-dispatch discards the partial product; the resume path is the expensive one). No tool the dispatcher holds terminates or queries a running background agent (the runtime's server/SDK can, out-of-band), so a dispatch cannot be cancelled from the agent's own surface — choose ones you will let finish and bound blast radius by scope; a `partial` is reclaimed, never killed. Mirrored in the `dispatch-direct` skill (Step 8 + flow).

## 1.9.2

- **Artifact-level supersession notes.** Rule 5 records that its review trigger supersedes the earlier literal ">=8 changed files" threshold; rule 8 records that cohesion sizing supersedes the earlier "maximize ground per pass" rule. The corrected design shipped in 1.9.1 — these notes make the supersession legible in the rules themselves, not only in the changelog.

## 1.9.1

- **Post-ship research refinements (Q1/Q2/Q3).** Rule 8: size a bucket by **cohesion and separability, never maximal size** — a bigger pass does not help and degrades verification. Rule 5: review type by **changed lines of code** (~200–400 blind threshold); changed-file count (`>=8`) is a coarse secondary proxy. The `dispatch-priority` escalation targets are the full roster, not `product` alone, with the twofold purpose recorded.

## 1.9.0

- **Verbatim carry + HARD-contradiction gate (rule 0).** Every execution brief now carries `user-request (verbatim):` beside `dispatcher-structuring:`, and the structuring is re-checked against the verbatim before dispatch. A **HARD contradiction** — the closed set of four (forbids what the user required, requires what the user forbade, reverses a stated order/priority/constraint, redirects target/scope to something the user did not name) — halts the dispatch for clarification; restating, disambiguating, adding acceptance criteria, choosing among options the user left open, and consistent guardrails never do. New failure mode **contradiction-inflation**.
- **Cohesion Bucketing (rule 8, rewritten).** The per-item shrink framing and the five-item cap are gone. Work is grouped into **Buckets** — one shared done-state, a cohesive write-scope, every change touching a file together; split only when separably dispatchable. Reasons to go smaller: the user's *now/speed* directive, genuine independence, or write-scope serialization.
- **`definition-of-ready` gate after bucketing.** New playbook: four paths (`needs-triage` / `needs-research` / `needs-spec` / `ready`), each verdict citing the observable check that produced it; the filing-boundary subset is its backlog-operator half.
- **`dispatch-priority` playbook.** The dispatcher assesses each Bucket's priority through it and has explicit freedom to escalate, recording the trigger.
- **Immediate cataloguing (Step 1).** Every user-requested item is catalogued at receipt with the user's message verbatim and immutable; corrections append; enrichment never alters the verbatim; a user note carries no citation.
- **Review type by diff size (rule 5).** `>=8` changed files → **blind review** (diff + "Review" only); `<8` → **guided review**; exactly one **full-delta blind review** at plan completion (plan-start sha → finish sha). The HIGH/critical filter is narrow — immediate corrections arising from reviews only.
- **Unintended impacts** section added (brief bloat, dispatcher bottleneck, over-questioning, verbatim rot) with a mitigation each.

## 1.8.0

- **Merge-first delivery loop — the review gate moves off the delivery path (supersedes `19434c31`).** Rule 5 replaced: code merges on its **own gates** (`pnpm test` 0 failures, `tsc --noEmit` exit 0, bundle under budget), the backlog item is `resolve`d on merge, and the review runs from `main` afterwards per ticket against the pinned sha — where the reviewer **runs the suite** instead of judging from reading. A HIGH is no longer a merge blocker: it is bucketed and dispatched as immediate follow-up implementation, still surfaced to the user by severity. Severity semantics are retained (rule 12 clause (a)) for **bucketing** only. Rails encoded in rule 5: every post-merge finding filed AND scheduled; `main`'s gates are a hard rail (a red merged state is an immediate fix, not a follow-up); branch write-scope overlaps declared in briefs up front (rule 24 gained the clause; Step 8 checklist updated). The tradeoff is recorded plainly: `main` will carry defects a pre-merge gate would have caught — the accepted price of a loop that converges. Step 5 renamed `Merge on gates, then review from main`; the playbooks list and the `Review-loop divergence` failure-mode entry (now `Review-gate deadlock`, fix superseded) updated. AC6: the superseded severity-floor approach is named as superseded so it is not resurrected alongside the inverted order.

## 1.7.2

- **Fix: `git add .*` denied the `git add <path>` form that `AGENTS.md` mandates.** As a glob the
  pattern matches any dot-prefixed path, so `git add .changeset/…`, `git add .gitignore`,
  `git add .mcp.json` and `git add .githooks/…` were denied — **9 such denials** measured in the
  opencode transcript store (`~/.local/share/opencode/log/opencode.log`), every one of them the
  sanctioned pathspec form. Replaced with the exact-match `git add .`, which blocks only the
  stage-everything form; any pathspec — including a dot-prefixed one — now passes.

## 1.7.1

- **Prose is budgeted in tokens, not lines or words.** The report rule capped *words* (250),
  which long words defeat; it is now a 400-token budget, which they cannot. Same change on
  the Output-artifact bullet, and briefs inherit it via rule 8.

## 1.7.0

- **Bounded scope, visible cost, honest reporting, portable procedure** — six changes:
  record vs schedule (rule 12: a defect is filed; a correction dispatch needs the blocking
  floor, relevance to the objective, and an owner); cost measured into every run line and
  reported at decision time (16, 21); gate termination and "capped, not converged" (5);
  brief effort ∝ degrees of freedom (8); `opus` gated on a recorded user-approved reason
  (16); a standing status table replacing the per-turn deferral dump (14 + Report format).
- **Rules 22–27, from live failures:** absorb a dirty tree rather than discard it (22);
  `git-manager` owns every git operation (23); concurrent dispatches need disjoint
  write-scopes (24); a release freezes its target so new work cannot keep it from quiescing
  (25); a documented-forbidden or ignored `--dry-run` is a real execution, never a rehearsal
  (26); the backlog is the system of record — resumable from the graph with no handoff
  (11, 27).
- **Portability:** Step 0 no longer assumes Claude-only tools (`ToolSearch`, `Task*`,
  `SendMessage`, `mcp__` prefixes); it probes what the host has, and names task-list
  read-back as the thing that matters.
- 353 → 496 lines. Three fresh-agent runs (an execution test, a structural review, a
  re-verification); every contradiction they found is fixed. `package.json` realigned from
  a stale 1.5.0.

## 1.6.0

- **Routing is roster-aware; the phantom executor table is gone (BUG-DISPATCH-PHANTOM-ROSTER).** Step 2.3 said only "route each leaf to the executor whose description matches", and the loaded `dispatch-direct` playbook's table named 17 of 19 executors that do not exist in the registry (`typescript-pro`, `backend-developer`, `javascript-pro`, `python-pro`, `react-specialist`, `nextjs-developer`, `fullstack-developer`, `refactoring-specialist`, `performance-engineer`, `test-automator`, `qa-expert`, `deployment-engineer`, `devops-engineer`, `database-administrator`, `debugger`, `code-reviewer`, `architect-reviewer`, `product-manager`). Measured on the live dispatcher run `ses_f1bc04916ffemeLCpoBzjoX84x`: ~20 implementation leaves routed to the generic catch-all `general` while `review`/`test`/`debug`/`architect-decision` routed correctly — the verification rows mapped near-identically onto real agents, the implementation rows (`backend`/`typescript`) matched neither phantom row, and the catch-all absorbed the rest. Step 2.3 now states the discipline (**named specialist over catch-all**; `general` a last resort), carries a work-class → executor mapping over the real roster (implement → `backend`/`typescript`; verify → `test`/`review`/`debug`; decision → `architect-decision`; spec → `architect`; restructure → `refactor`; perf → `performance`; backlog → `backlog-operator`; docs → `doc-steward`; git → `git-manager`; priority → `product`; research → `researcher`), and the stop rule (**no match → surface the roster gap; never fall back to `general`**). Hard rule extended; every stale executor name in the body corrected to its registry id (`debugger`→`debug`, `code-reviewer`→`review`, `product-manager`→`product`, `typescript-pro`→`typescript`).
- **A/B (cheapest tier, `deepseek-flash`, 3 runs per arm):** baseline emitted **0/10** resolvable executor names (all phantom); variant emitted **10/10** — and **30/30** over three runs. Runtime not regressed: cost 0.15–0.26× baseline, wall-clock 0.49–0.81×.
- Sibling playbooks de-phantomed alongside: `dispatch-direct` §6 routing table rewritten over the real roster; `dispatch-triage` (`debugger`→`debug`, `architect-reviewer`→`architect`); `dispatch-plan` (`product-manager`→`product`).

## 1.5.0

- **Terminal resolution now requires artifact-class evidence, not a commit ref (4fc3704e-56b0-4363-a1fe-ec8a51826f8b).** New operating rule 18 keys the resolution evidence on what the artifact *requires*: (a) acceptance-criteria proof for every item, (b) published-artifact proof for any publishable package, (c) live-system / deploy proof for any released/deployed service or artifact. A commit/merge ref alone is insufficient for (b)/(c). Step 7 is de-conditionalised — its trigger is the artifact class, never whether a deploy happened to occur this run. Step 5's resolve gate now requires rules 15 + 18 + 20 together; adds the **Merge-as-terminal-evidence** failure mode.
- **A run now has its own definition of done (decda240-0954-4d99-bfc3-6c0e896cc274).** New operating rule 19 derives the run/project DoD from observable assertions (Outcome / Acceptance / Terminal evidence / Disclosure), each a binary pass/fail clause; the close report states whether the run DoD is **MET** and which clause is unmet. Wired into the Step 8 self-critique checklist; adds the **Leaf-complete, outcome-unverified** failure mode.
- **Every executed/resolved item carries acceptance criteria written before the work, or an explicit `none applicable` declaration (e5a790a7-ab24-4e1b-89fe-bef94d9511d5).** New operating rule 20; wired into Step 2 (decompose), Step 3 (brief assembly), and Step 5 (closure verifies the criteria, not just the leaf done-state); adds the **Post-hoc acceptance** failure mode.
- `backlog-operator` upgraded to 0.2.0 alongside: its `resolve` verb now refuses without the artifact-class evidence (returns ESCALATE), so the gate cannot be bypassed through the operator.

## 1.4.3

- **Body restored to the ad-hoc dispatcher; the plan-state-machine body is withdrawn.** 1.4.1 had
  reconciled the plan-state-machine orchestrator body into the IR pattern; that direction is
  reversed. The extension carries the ad-hoc-direction `dispatcher` again (the agent ingested in
  1.4.0) and no longer contains a `docs/plan/<slug>/` execution loop.
- **`plan-orchestrator` removed — no such agent exists.** Every reference is gone from the body,
  the `extension.json` descriptions, the README, and the `dispatch-plan` skill. The dispatcher's
  real division of labour is now stated: **plans are crafted into the backlog** — a plan is an
  `issue` row whose work items attach by a `part_of` edge with their order expressed as `blocks`
  dependencies. `product-manager` prioritizes, `architect` **returns** the structured
  items (it does not touch the backlog), the dispatcher has `backlog-operator` file and link them,
  and it executes from the **ready view**. `plan-builder` is recorded as the author of
  document-based `docs/plan/<slug>/` plans, which are not this agent's plan of record.
- Carries forward the 1.4.1 **minimum-severity review-loop floor** (only findings ≥ HIGH re-open a
  review; sub-HIGH recorded once, non-blocking; hard 2-round cap) and the 1.4.2 **mandatory worktree
  teardown**, both now on the ad-hoc body.
- Adds the repo-agnostic hard rule: no repo-relative path may be assumed — these agents run in any
  repo, so refer to the target repo's conventions and write `<repo>/…`.
- opencode model pinned to `deepseek/deepseek-flash`, the live provider id every other agent
  extension uses.

## 1.4.2

- **Worktree teardown is now mandatory.** Adds a Hard rule — "always tear down every worktree you create; no orphaned worktrees" — requiring isolation worktrees to live under `<repo>/.worktrees/<slug>/`, be recorded in the orchestration ledger, and be removed (`git worktree remove` → `git worktree prune` → `git branch -d` when merged) once their state/wave merges or is abandoned, with a **Step 7 close-time reconciliation** of `git worktree list` against the ledger. A dirty worktree this run did not author is explicitly not ours to remove.
- Adds the **Orphaned worktree** failure mode. Root cause it fixes: the spec previously mentioned `worktree` only for *isolation* (write-conflict prevention) and `$SKILL` resolution — never for cleanup — which is why isolation worktrees accumulated across runs (106 present on this repo).

## 1.4.1

- **Body reconciled from the `wip/dispatcher-0.1.2-transition-discipline` worktree.** The 1.4.0
  full-replace carried the ad-hoc `dispatcher` body; the long-running/live dispatcher is the
  **plan-state-machine** orchestrator (`dag.json`/`state.json`, `orchestrate-plan.js`,
  advance/retry/escalate/halt), so that body is restored — carried forward in the IR pattern
  (prose-only `dispatcher.md` + `render.<host>` from `extension.json`), staying on 1.4.x.
- Carries the 0.1.2 **backlog transition discipline** (Operating rule 6): one deliberate
  vocabulary `open` → `claimed` → `closed`; `toStatus` is an open catalog, never a validated enum.
- **Fixes the infinite blind-review loop.** Operating rule 5 gains a **minimum-severity floor**
  (only findings ≥ HIGH re-open the review; sub-HIGH findings are recorded once, non-blocking,
  never re-reviewed), a discretion clause (may clear a sub-HIGH finding, never elevate one), and a
  **2-round cap** (a still-open blocking finding on round 2 halts to the human). Step 5b and the
  failure-mode catalog record the same floor; adds the "Review-loop divergence" failure mode.

## 1.4.0

- **Full replace.** Prior content (0.1.x) was a mislabeled copy of the `plan-orchestrator` agent
  under the `dispatcher` id/entrypoint. It is discarded entirely — no fields, body text, or journal
  paths carried forward. This extension now carries the actual `dispatcher` agent from the
  `claude-agents` catalog (`categories/dispatch/agents/dispatcher.md`, v1.4.0, commit `6ffe0db1`):
  the orchestration authority that decomposes ad-hoc direction, dispatches `00-active` executors in
  the background, verifies from evidence, review-gates merges, and keeps the Task list and backlog
  graph in sync via `backlog-operator`.
- Converted to the born-conformant `agent`/`render.<host>` IR pattern (matching `researcher`):
  `dispatcher.md` is prose-only (frontmatter stripped), and the per-host header (Claude
  `tools`/`disallowedTools`/`model`, opencode `mode`/`permission`/`model`) is generated by
  `libs/host-registry/src/agent-renderers.ts` at install time from `extension.json`.
  `disallowedTools: Edit, Write, NotebookEdit` has no direct IR field (the renderer does not
  express it for either host) — reproduced functionally via an explicit Claude `tools` allowlist
  that omits them, and an opencode `permission.edit`/`permission.write: deny`.
  `model: opus` has no configured opencode model id on this machine (no `anthropic` provider in
  `opencode.json`); mapped to `deepseek/deepseek-v4-pro`, the strongest tier configured locally.
- Declares `dependencies`: the six dispatch skills (`dispatch-contract`, `dispatch-direct`,
  `dispatch-triage`, `dispatch-plan`, `dispatch-status`, `backlog-intake`), ingested alongside as
  `extensions/skills/<id>/`.
- Records `source`/`source-version` provenance pointing at the `claude-agents` catalog.

## 0.1.1

- Pin the opencode model to the live provider id `deepseek/deepseek-flash` (the retired V4
  Flash id no longer resolves on the `deepseek` provider, so the pinned agent failed at dispatch
  time with "Model not found").

## 0.1.0

- Initial release.
- Migrated the opencode-host `dispatcher` agent definition from
  `~/.config/opencode/agents/dispatcher.md` (adapted from
  `~/dev/ai/claude-agents/categories/workflow/agents/plan-orchestrator.md` v1.4.0) into a
  born-conformant declarative agent extension.
- Multi-host: `install.hosts` = `claude`, `opencode`.
