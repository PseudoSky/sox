# Changelog

## 0.1.1

- **All three install surfaces declared — claude, opencode, agent-mcp.** `install.hosts` gains `agent-mcp` and `render.agent-mcp` federates the uniform server set (agent, search, memory-server, gitnexus, backlog) into the catalog row, so a task dispatched through agent-mcp has the same tool surface as a native opencode run. `render.opencode` pins its model and `mode: all`.

## 0.1.0

- Initial release: the `security` agent extension, declaring no dependencies.
- Harvested durable, framework-neutral principles from
  `claude-agents/categories/04-quality-security/penetration-tester.md` and
  `claude-agents/categories/04-quality-security/security-auditor.md` — the authorization
  gate, evidence-backed findings, severity and remediation SLAs, threat modeling, the
  design-principle review, penetration-testing discipline, and compliance-as-evidence.
  Tool-name presets, platform-specific `sox state` workflow, and product checklists were
  dropped.
- Hard refusals and separation of duties encoded as guards: no unauthorized testing, no
  fabricated finding or metric, no weakened control as a fix, no secret in the evidence.
