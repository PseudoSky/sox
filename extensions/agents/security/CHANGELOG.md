# Changelog

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
