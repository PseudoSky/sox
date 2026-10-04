# Changelog

## 0.1.1

- **All three install surfaces declared — claude, opencode, agent-mcp.** `install.hosts` gains `agent-mcp` and `render.agent-mcp` federates the uniform server set (agent, search, memory-server, gitnexus, backlog) into the catalog row, so a task dispatched through agent-mcp has the same tool surface as a native opencode run. `render.opencode` pins its model and `mode: all`.

## 0.1.0

- Initial release. Declarative `devops` agent — sole owner of the build, CI/CD, containerization,
  release, deploy, and rollback path from commit to running artifact, with one committed pipeline
  definition (`docs/PIPELINE.md`) it adopts or creates and keeps in sync.
- Harvested durable principles from the build-engineer source: build graphs and monorepo task
  dependencies, CI/CD stages with promotion gates, reproducible/hermetic builds, content-hash
  caching and invalidation, release and versioning automation, deploy and rollback, pipeline
  observability and performance budgets, and CI secrets handling. Product-specific names dropped
  in favor of the generic principle.
- Hard refusals, separation of duties (operator ≠ approver), a reproducibility check, and
  budget-as-a-gate replace the source's softer checklists.
