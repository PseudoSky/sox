# Changelog

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
