---
fallback_reason: "memory-server MCP tools (memory_write/memory_recall) are not registered in this host's tool list; ping not possible. Findings held here for verbatim memory_write with db_path: /Users/nix/.memory/memory.db"
date: 2026-09-29
slug: skill-frontmatter-validators
topic: tool-catalog
tags: [agent:approved, agent:blocked, skill-frontmatter, linter, spec-compliance]
data_quality: verified
---

# Findings — off-the-shelf validators for Agent Skills (SKILL.md) & agent-definition frontmatter

Canonical spec: Agent Skills open format — https://agentskills.io/specification
(mirrored: anthropics/skills `spec/agent-skills-spec.md`, openagentskills.dev/docs/specification).
No official JSON Schema located — the spec is prose; validators implement it in code.

## 01 — skillcheck (WINNER)

```
content: |
  name: skillcheck
  description: Cross-agent static analyzer for SKILL.md files; validates frontmatter against the agentskills.io specification.
  validates:
    - frontmatter required fields, types, name and description length limits, reserved-word collisions
    - body line/token sizing against agentskills.io progressive-disclosure budgets
    - file references: broken links, escapes outside skill dir, depth limits
    - cross-agent compatibility: Claude Code, VS Code, Codex, Cursor
    - description quality score (0-100)
  spec: Agent Skills (agentskills.io). Does NOT validate Claude Code subagent frontmatter.
  language: Python
  quality_signals:
    version: 1.5.0
    last_update: 2026-08-22 (PyPI upload)
    license: MIT
    python: ">=3.10"
    repository: https://github.com/moonrunnerkc/skillcheck
  metrics_source:
    version/license/date: "https://pypi.org/pypi/skillcheck/json"
  invocation: "uvx skillcheck extensions/skills  (or: pip install skillcheck && skillcheck extensions/skills)"
  ci: "GitHub Action: uses: moonrunnerkc/skillcheck@v1 ; pre-commit hook id: skillcheck ; exit 1 on errors, --strict escalates warnings"
  data_quality: verified
  tags: [agent:approved, skill-frontmatter, linter, spec-compliance, python]
  summary: skilcheck is a production/stable (1.5.0, MIT) static analyzer for SKILL.md that parses frontmatter strictly and validates it against the Agent Skills spec. Chosen for maturity + native CI (GH Action + pre-commit).
```

## 02 — skillscheck (runner-up)

```
content: |
  name: skillscheck
  description: Linter for agent skill definitions; validates skill dirs against agentskills.io spec and 8 agent platforms.
  validates:
    - frontmatter presence and syntax; required name/description; naming rules (lowercase, no leading/trailing/consecutive hyphens); directory-name consistency
    - allowed-tools; body/token budgets; secret leaks (AWS/GitHub/private keys/.env); broken links; unclosed code fences
    - agent adapters: Claude Code (plugin.json/marketplace.json), Codex, Copilot, Cursor, Gemini, Roo, Swival, Windsurf
  spec: Agent Skills (agentskills.io). Explicitly checks frontmatter SYNTAX (the exact silent-drop failure class).
  language: Python
  quality_signals:
    version: 0.9.7
    last_update: 2026-08-20 (PyPI upload)
    license: MIT
    python: ">=3.11"
    repository: https://github.com/swival/skillscheck
    author: Frank Denis (jedisct1); also ships the "Agent Skill Lint" VS Code extension
  metrics_source:
    version/license/date: "https://pypi.org/pypi/skillscheck/json"
  invocation: "uvx skillscheck extensions/skills --strict  (--format json for CI; exit 1 on errors)"
  data_quality: verified
  tags: [agent:approved, skill-frontmatter, linter, spec-compliance, multi-agent, python]
  summary: skillscheck (MIT, 0.9.7, Beta) explicitly validates frontmatter syntax plus 8 agent adapters and secret leaks; zero-install via uvx. Strongest functional fit but still 0.x.
```

## 03 — cclint (Claude Code agent-definition half)

```
content: |
  name: "@carlrannaberg/cclint"
  description: Linter for Claude Code project files — agent/subagent definitions, slash commands, settings.json, CLAUDE.md/AGENTS.md.
  validates:
    - agent/subagent frontmatter: required name + description; optional tools/allowed-tools, model, color; naming and filename matching
    - command frontmatter; .claude/settings.json hooks; CLAUDE.md sections
  spec: Claude Code subagent/command rules. Does NOT implement the Agent Skills (SKILL.md) spec.
  language: TypeScript/Node
  quality_signals:
    version: 0.2.10
    last_update: 2025-09-10 (npm registry modified)
    license: MIT
    repository: https://github.com/carlrannaberg/cclint
  metrics_source:
    version/license/date: "npm view @carlrannaberg/cclint version license repository time.modified"
  invocation: "npx @carlrannaberg/cclint   |   npx @carlrannaberg/cclint agents --fail-on warning"
  data_quality: verified
  tags: [agent:approved, claude-code, subagent-frontmatter, linter, typescript]
  summary: cclint validates Claude Code agent/subagent frontmatter (name/description required; tools/model/color rules). It does not read SKILL.md, so it complements — not replaces — a skill linter.
```

## 04 — skills-ref (canonical reference; not for production)

```
content: |
  name: skills-ref
  description: The Agent Skills reference library (validate/read-properties/to-prompt) referenced by the spec itself.
  spec: Agent Skills — this IS the reference implementation.
  quality_signals:
    version: 0.1.1 (PyPI)
    last_update: 2026-01-10 (PyPI upload)
    license: Apache-2.0
    repository: https://github.com/anthropics/agentskills (spec page cites agentskills/agentskills/tree/main/skills-ref)
  notes: upstream README says "intended for demonstration purposes only. It is not meant to be used in production."
  invocation: "skills-ref validate path/to/skill  (PyPI console script also documented as: agentskills validate path/to/skill)"
  data_quality: verified
  tags: [agent:approved, reference-implementation, agent-skills-spec, python]
  summary: skills-ref is the spec's own reference validator (Apache-2.0, alpha). Authoritative for interpreting the spec, but self-declared demonstration-only — use a linter in CI.
```

## 05 — ai-linter (weaker; alpha)

```
content: |
  name: ai-linter
  description: Validation tool for AI skills and agent configs — SKILL.md frontmatter/allowed keys plus AGENTS.md structure.
  validates:
    - SKILL.md: YAML frontmatter with required properties; allowed keys (name, description, license, allowed-tools, metadata, compatibility); <=500 lines; <=5000 tokens; file references
    - AGENTS.md: no frontmatter allowed; size/token limits; file references
  spec: partial Agent Skills (single allowed-key list) + AGENTS.md conventions. No directory-name match check documented.
  language: Python
  quality_signals:
    version: 0.2.0
    last_update: 2026-01-31 (PyPI upload)
    license: MIT
    python: ">=3.10"
    repository: https://github.com/fchastanet/ai-linter
  metrics_source:
    version/license/date: "https://pypi.org/pypi/ai-linter/json"
  invocation: "ai-linter --skills /path/to/skills"
  data_quality: verified
  tags: [agent:blocked, skill-frontmatter, agnets-md, linter, alpha, python]
  summary: ai-linter covers both SKILL.md and AGENTS.md but is Alpha (0.2.0, Jan 2026), single-maintainer, and its README still labels PyPI distribution "coming soon". Not recommended over skillcheck/skillscheck.
```
