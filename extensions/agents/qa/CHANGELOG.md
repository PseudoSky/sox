# Changelog

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
