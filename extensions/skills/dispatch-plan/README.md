# dispatch-plan

> The dispatcher's playbook for plans — crafted into the backlog, never by default.

## Overview

Used when the user asks for a plan, or when the backlog already holds a plan that covers the
area. Never turns a direct request into a plan on its own. A plan is backlog structure: an `issue`
row with its work items attached by a `part_of` edge and their order expressed as `blocks`
dependencies. `product-manager` prioritizes, `architect` **returns** the structured items
with those edges, and `backlog-operator` files and links them — `dispatcher` never designs the
structure and never touches the graph. Execution is driven by the **ready view**.

## When to use

Loaded when a plan is named or discovered; otherwise `dispatcher` stays in `dispatch-direct`.

## Runtime

`declarative` — the host reads `SKILL.md` directly. No transform.

## Source

Ported verbatim from an external dispatch-agent catalog, v1.4.0.

## Usage

```bash
soxe install dispatch-plan --host claude --scope user
soxe install dispatch-plan --host opencode --scope user
```

## License

MIT
