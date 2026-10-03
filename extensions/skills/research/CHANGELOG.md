# Changelog

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
