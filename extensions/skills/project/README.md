# project

> Declare this project's capability bindings in `AGENTS.md` / `CLAUDE.md`.

## Overview

Agents are authored against **capability names** (`backlog`, `memory`, `code-intel`), never
against a concrete tool, so the same agent body is portable across projects where the tools
differ. This skill holds the project-side half: its `setup` playbook writes the `## Capabilities`
section that binds each capability to the tool satisfying it in *this* project, plus the
lazily-loaded skill that documents that tool's verbs.

- `SKILL.md` — the capability contract and the layer map (the always-loaded body).
- `setup.md` — the playbook that writes or refreshes the binding section.

## The binding

```markdown
## Capabilities

Concrete bindings for the capability names agents use. Change these per project; agent
bodies never name a tool. An absent row = the capability is unavailable here.

| capability | tool | usage |
|---|---|---|
| backlog    | backlog | `backlog` skill |
| memory     | memory-server | `memory-usage` skill |
| code-intel | gitnexus | `gitnexus-guide` skill |
```

- `capability` — the abstract key an agent body references.
- `tool` — the logical server id (the host prefixes it; bodies never do).
- `usage` — the lazily-loaded skill with the verbs and calling convention.

Absent row → unavailable → surface and stop (never substitute or invent — `b5670d03`). Row with
an empty `tool` → not applicable → proceed (ADR-0017).

## When to use

Onboarding a project; adding a capability; changing which tool satisfies one.

## Runtime

`declarative` — the host reads `SKILL.md` directly. No transform.

## Dependencies

None.

## Source

First-principles, grounded in ADR-0026 and the existing `backlog` skill (the one home of the
command surface).

## Usage

```bash
soxe install project --host claude --scope user
soxe install project --host opencode --scope user
```

## License

MIT
