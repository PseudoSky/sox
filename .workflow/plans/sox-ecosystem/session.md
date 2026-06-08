---
slug: sox-ecosystem
opened: 2026-06-07T20:46:37Z
---

# Session transcript — sox-ecosystem

## 2026-06-07T20:46:37Z

**User request gist:** Turn the agreed `extension-ecosystem-design` research designs into a
concrete, buildable, resumable implementation plan for a greenfield LLM extension ecosystem
repo. Deliver: repo architecture + 3 schemas (extension.json, scoped extensions.json,
per-scope lockfile), locked build-vs-reuse with exact tools/versions, phased resumable plan
with deterministic acceptance checks mapped to MVP use cases, and interface contracts for the
install client, cascade-merge resolver, registry index builder, scaffold generator, and dedup
lint. Resolve 5 open gaps (MCPB vs npm; hook ordering; registry HTTP server; org `extends`
hash pin; capability warn-vs-block). Constraints: bias to reuse, ~1010 LOC budget, 4 files/unit.

**Memory check:** confirmed all 11 findings present in
`~/.claude/plugins/workflow/memory/research/extension-ecosystem-design/`. Read the two
load-bearing ones (reference-architecture, build-vs-reuse) in full + topic INDEX.

**A4 overlap gate:** no existing `.workflow/plans/` — clean. No slug collision, no overlap.
Slug derived: `sox-ecosystem`.

**Decision:** greenfield → no live analyzer/optimizer possible. Seeded `analysis.md` +
`suggestions.md` as cited distillations of the agreed research; advanced state to `suggested`.
Dispatching `workflow:workflow-planner` to produce `migration.md`.

**Planner return:** wrote `migration.md` (7 phases P0–P6; 4 deliverable sections + 5 gap
resolutions). Core glue 730 LOC, ~1010 incl. optional modules. State advanced suggested → planned
(linter also stamped `canonical_roi: qualitative-only`). All 5 gaps resolved, no suggestions.md overrides.

## 2026-06-07 (rename + index)

**User correction:** folder misnamed — renamed slug `llm-extension-ecosystem` → `sox-ecosystem`.
Moved the plan dir; rewrote slug refs in status.md, session.md, and the 15 absolute paths inside
migration.md's resumable phase steps; preserved `extension-ecosystem-design` research-topic refs.
Slug-stability rule waived — engagement is fresh (planned, not executing), so the rename is low-risk.

**INDEX rebuild:** relevancy tool could not run (`.workflow/` is under `$HOME`, outside a git repo →
no repo root). Fell back to `qual` per protocol; `canonical_roi: qualitative-only` already set.

## 2026-06-07 (location fix)

**Bug found:** the store was created under `$HOME` (`/Users/nix/.workflow`) because the first `mkdir`
ran before the shell cwd settled into the repo, while content-`Write`s used a hardcoded `$HOME` prefix.
The repo (`/Users/nix/dev/ai/sox-memory`) had only empty scaffold dirs under the old slug.
**Fix:** consolidated everything into the repo at `.workflow/`, removed the stale empty dir + the `$HOME`
copy, converted migration.md's phase-step paths to repo-relative. Relevancy still `qual` — repo has no
commits (`git log` empty), and ROI is qualitative-only anyway.

## 2026-06-07 (live analyze → optimize)

**User:** "dispatch the other agents" → chose analyzer + optimizer (informed of the greenfield caveat).
Archived architect seeds as `analysis.seed.md` / `suggestions.seed.md`; reset state `planned → initialized`
to satisfy specialist preconditions (full history preserved).
**workflow-analyzer (live):** inventoried inherited agentic config (37 agents, 19 plugins/4 enabled, 9
global hooks, `sox` MCP). Found the live `plugin.json`/scope system ALIGNS with the target (working
prototype) and 6 DIVERGENCES (monolithic versioning, identity/dedup, scaffold, distribution, manifest
lint, hook order). Its `analysis.md` write was permission-blocked (`.workflow/` not in settings
Write-allowlist) → architect persisted the verbatim artifact. State → analyzed.
**workflow-optimizer:** ranked suggestions against the live analysis; writes succeeded; set
`provisional_roi: high`; flagged one research gap (no finding covers an LLM eval harness). State → suggested.

## 2026-06-07 (repo rename + replan)

**User:** rename repo folder + sed `sox-memory`→`sox-ecosystem`, then dispatch planner.
Replaced the string in INDEX.md / analysis.md / suggestions.md (6 occurrences, incl. abs path prefixes),
then `mv /Users/nix/dev/ai/sox-memory → /Users/nix/dev/ai/sox-ecosystem` (harness cwd gracefully fell
back to parent; git intact). Backed up v1 plan → `migration.v1.md`.
**workflow-planner (v2):** reconciled the research-only v1 plan against the live analysis + optimizer
ranks. Reframed as *partly a migration* of the existing plugin stack; phase count 7 → 8 (added **P5.5**,
a `workflow-researcher`-gated eval-harness spike; P6 hard-gated on it). LOC unchanged (730 / ~1010).
No v1 overrides — live findings only strengthened the existing calls. State → planned.
Updated the stale greenfield provenance note in status.md to reflect the live runs. INDEX rebuilt.

## 2026-06-07 (finish the research — P5.5 gate)

**User:** "finish the research" → mapped to the single open research gate (P5.5 eval-harness), the one
dependency the optimizer flagged. Memory check confirmed the gap: `verification-granularity/` and
`plan-metrics/` are adjacent but none cover a CI eval-harness for extension behavior.
**workflow-researcher (dispatched, domain-neutral, anti-skew):** wrote
`extension-ecosystem-design/eval-harness-for-llm-extensions.md` (15.5 KB, 11 sources incl. lost-in-the-middle
arXiv 2307.03172 + LLM-judge 2310.08491), cross-referencing the verification-granularity LLM-judge findings.
Recommendation: 3-layer cheapest-first pyramid — static gates + deterministic golden assertions gate every
PR; 5–10% LLM-judge sample as merge gate; full judge sweep nightly (drift detector, not a blocker).
Non-determinism via response caching + temp=0 + ±5% tolerance + 3× quorum. Reuse: promptfoo (PR), DeepEval
(Python), Braintrust (nightly, optional).
**Architect bookkeeping:** wrote research dispatch log `.workflow/logs/architect/research.json`
(drift_assessment: none); marked P5.5 gate CLEARED in status.md Blockers (resolved); INDEX risk line updated.
Engagement state unchanged (`planned`) — research landing satisfies a phase prerequisite, not a state move.
