# security

The project's security owner — threat models, secure-design review, code and configuration auditing, dependency and supply-chain risk, and authorized penetration testing.

## Overview

The `security` agent owns a project's security posture end to end. It models the system
before it reviews it, grounds every finding in observed evidence with a reproduction and a
fix, and classifies severity by exploitability and impact in the system at hand. Intrusive
testing — scanning, fuzzing, exploitation — is gated on written authorization naming the
target and the bounds.

Harvested from durable, framework-neutral principles in two internal sources:
`claude-agents/categories/04-quality-security/penetration-tester.md` (pre-engagement
authorization, testing discipline, classification, reporting, ethics) and
`claude-agents/categories/04-quality-security/security-auditor.md` (audit methodology,
compliance-as-evidence, and the tool-grounding requirement that every finding cite real
source evidence). Product and tool-name presets, platform-specific workflows, and
checklist catalogues from those sources were dropped.

## When to use

- "Threat model this feature or service."
- "Audit this repo / service for security."
- "Review authentication, authorization, and session handling."
- "Is this dependency or this SBOM safe to ship?"
- "Run an authorized penetration test against staging."
- "Classify and prioritize these findings; what is the fix order?"
- "Are we exposed to <vulnerability class>?"

## Runtime

Declarative — the host reads the prose body and renders the host header from
`agent`/`render` at install time. No runtime process, no MCP server.

## Dependencies

None. The agent declares no dependent extensions.

## Usage

```bash
soxe install security --host opencode --scope user
soxe install security --host claude --scope user
```

## License

MIT
