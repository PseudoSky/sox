# Changelog

## 0.2.0

- **T18 (0c91e632): auditor persona adopts the repository IMPLEMENTATION.** The single-file equivalence rule and the `docs/TEST-STRATEGY.md` requirement are gone; qa adopts the IMPLEMENTATION the repo binds (`registry.json` > `binding`) and cites the STRATEGY by `path §clause`. With none found it runs the `apply` playbook.
- Body points at the real playbooks: `apply` (adopt), `review` (conformance, `scripts/conformance.mjs testing`), `retention-audit`, `flake-triage`. No `adopt` or `conformance` playbook exists in `workspace-standards` (T14); these two names map to `apply` and `review`.
- New auditor modes: audit (refuses tests whose authorship record names its own dispatch; `authorship-check` field required), confirm (accepts only audit record, parity evidence, test-file diff; declines own-session edits, D19), dispute (decided once, outcome recorded for the risk owner, D21).
- Declares `roles-covered:AU.1-AU.5` and `roles-covered:SO.1-SO.3` (D23).
- Golden set (`eval/`, code-based grader, 3 reps, sonnet, tools disabled): baseline v0.1.1 18/30 (0.60), variant 30/30 (1.00); unmeasured-claim refusals (AC3) 9/9 vs 9/9. The set was tuned once (grader regexes loosened for both arms; confirm mode told to skip the STRATEGY read), so it is a regression guard, not a held-out measure.
- Size: qa.md 9994 -> 11273 bytes (new modes); the strategy section is shorter.

## 0.1.1

- **All three install surfaces declared — claude, opencode, agent-mcp.** `install.hosts` gains `agent-mcp` and `render.agent-mcp` federates the uniform server set (agent, search, memory-server, gitnexus, backlog) into the catalog row, so a task dispatched through agent-mcp has the same tool surface as a native opencode run. `render.opencode` pins its model and `mode: all`.

## 0.1.0

- Initial release. Declarative `qa` agent — owner of a project's quality strategy and the evidence
  that a change works, with one committed test strategy (`docs/TEST-STRATEGY.md`) it adopts or
  creates and keeps in sync.
- Harvested durable principles from the qa-expert and test-automator sources: risk-based test
  planning and the test pyramid, test-case design (equivalence partitioning, boundary values,
  decision tables, state transitions, negative cases), automation architecture (page objects,
  screenplay, stable selectors, condition waits), fixtures and test-data management, flake control
  with justified retries, CI integration, contract/API testing, performance and load testing,
  accessibility testing, regression and release gating, defect reporting with evidence, and
  coverage measured rather than estimated. Product-specific names dropped in favor of the generic
  principle.
- Tool-grounding is enforced as hard refusals: never report a pass, count, or coverage figure not
  observed from a real run; state "coverage not measured" rather than invent a number; and never
  mark a defect fixed without a regression test that fails before the fix.
