# project — the project's capability bindings

Agents are authored against **capability names** (`backlog`, `memory`, `code-intel`), never
against a concrete tool. Which tool satisfies a capability is a property of the **project**, not
of the agent: the same agent body runs here (backlog = this repo's backlog tool) and in a project
where that capability is Jira.

Three layers, one home each:

| layer | what it is | where it lives |
|---|---|---|
| capability contract | what `backlog` / `memory` / `code-intel` mean | the agent body |
| binding | which tool satisfies it **in this project** | the `## Capabilities` section of the project's `AGENTS.md` / `CLAUDE.md` |
| usage surface | the verbs and calling convention | a lazily-loaded skill, named by the binding |

An agent body never names a tool; the binding never lives in an agent body; the verbs never live
in the binding.

## Playbooks

- **`setup.md`** — write or refresh this project's `## Capabilities` binding section. Load it when
  onboarding a project, adding a capability, or changing which tool satisfies one.

## Hard rules

- The binding lives in the project instruction file and nowhere else — never in an agent body,
  never in a separate config artifact.
- An unbound capability is unavailable: surface it and stop. Never substitute a different tool and
  never invent a surface.
