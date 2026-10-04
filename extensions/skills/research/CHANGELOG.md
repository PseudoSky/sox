# Changelog

## 0.3.0

- **New P8 `root-distillation` playbook** (`references/playbooks/P8-root-distillation.md`) — landscape
  research for the "what is still unsolved in X, and *why* it resists engineering" question class,
  distinct from decision research and evaluation. It enumerates a domain's open problems, derives each
  one's **root complexity** (the structural reason it resists engineering) and **research space** (the
  body of work attacking it), and states each one's **residual gap** (a concrete "SOTA does not solve
  X" — where build-vs-buy lives). A synthesis collapses N problems into K root classes along a
  **mandatory named axis**, and every item carries a confidence label with HIGH requiring triangulation
  (an all-HIGH run is a failure signal). Recorded to memory under `pattern:open-problem` +
  `root-complexity` + `research-space` + `residual-gap` + `domain/<name>` tags rather than
  `agent:approved`/`agent:blocked`.
- **New optional `mode` input** (SKILL.md): `mode: root-distillation` shapes the run as an open-problem
  landscape distillation and routes to P8; absent, routing falls back to P1–P7 as before. The Phase-5
  memory-tag clause is now mode-dependent, and under P8 the output contract replaces the
  `## Build-vs-integrate` section with the P8 per-item table + synthesis + recommendation.
- **Routing:** added the `root-distillation` / open-problem-landscape answer category to
  `references/routing-table.md` (→ P8) with a precedence rule — the mode is reachable only via
  `mode: root-distillation`, overrides the domain's primary playbook, and never fires for decision/eval
  questions.
- **Verifier:** widened `scripts/verify-research-run.mjs` accepted routing ids `/^P[1-7]$/` → `/^P[1-8]$/`.
- No process change; version `0.2.1` → `0.3.0`.

## 0.2.1

- Covered the `business-analyst` source agent, which had no home in the skill (excluded from the
  original 32-agent corpus as internal-analysis-oriented — `researchers-digest.md`). Home chosen:
  **P7 `general-synthesis`** — its design/analysis catch-all is the only playbook whose answer
  categories (`design-artifact`, `enumeration`, `pattern-recommendation`, `explanation`) fit
  requirements/process artifacts, and a new playbook would have required a 17th domain plus a
  `P1..P7` verifier change. Added `business-analyst` to routing-table §4's P7 row and one process-merge
  bullet to `P7-general-synthesis.md` (requirements traceability, business-rule capture, current-vs-to-be
  gap analysis, testable acceptance criteria, process maps). §4 header de-numbered ("the 32 aggregated
  research agents" → "the aggregated research source agents") since the source is a later addition.
- No process change; version `0.2.0` → `0.2.1`.

## 0.2.0

- Renamed the skill to `research` (`research-playbooks` → `research`): manifest id/title, package name
  `@adhd/sox-extension-research`, version `0.2.0`.
- Adopted the v5 process: **domain-neutral core + pluggable domain layer** (routing-table + 7 playbooks
  over 16 domains); **expansion-first** (fan a question out across every domain it touches); **memory-first
  resolution** that answers outright when memory fully knows the fact; `memory (degraded)` handling;
  optional **`domain_narrowing`** input; real tool provenance (`manifest.tool_use.calls[]`) with verifier
  checks 9–10 (search_terms ≥ 3× research questions; every http citation must match a recorded
  non-failed call).
- Verification: hardened verifier PASS on every iteration; v5 controls 8/8; runtime within threshold
  (v5 1.14× tool / 0.82× wall / 0.95× cost vs the v1 baseline).
- Blind head-to-head vs the current `researcher` agent (10 questions across 10 domains, two independent
  blind judges): verdict **SAME** — no material quality difference (if anything the `researcher` scored
  marginally higher). The skill is shipped on **demonstrated soundness** (runs end-to-end, passes its
  verifier, within runtime threshold), **not** on a proven-superiority claim.
- Measured delta across iterations: structural-gap proxy v1 8 → v2 6 → v3 4 → v4 5 → v5 8 (never ≤2 —
  a noisy doc-shape proxy, not a quality signal).

## 0.1.0 — draft

- Initial draft. Core process extracted from `extensions/agents/researcher/agent.md` (v0.1.5).
- Added: 7-playbook router covering 16 corpus domains; structured sub-researcher prompt;
  memory resolution loop (<=2 regenerations per question); hardened verification
  (`scripts/verify-research-run.mjs`) over disk + memory read-back + tool manifest.
- Derived from the 553-question corpus (`questions.json`) and 32-agent aggregation
  (`researchers.json`) in `.opencode/artifacts/research-skill/`.
