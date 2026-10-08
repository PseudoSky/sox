# workspace-standards

> One skill that reviews, runs, and applies every workspace standard (testing first) over the routing and gates foundations.

## Overview

`/workspace-standards <review|run|apply> <target>` loads the target's playbook. A target is a foundation (`routing`, `gates`) or a registered standard (`testing`). The skill ships the registry, the standard contract, the testing standard (roles, role cards, Test-author playbook cards, playbooks, record formats, `apply` templates), the `roles-covered` declaration schema, and the scripts that resolve a verb, review all standards, review routing declarations, and run a standard's conformance specification.

## When to use

When a change needs its test class, rigor, and playbook; when tests are audited or a flake triaged; when a standard is written into a repository; when agents change and role coverage must be re-checked.

## Layout

| Path | Purpose |
|---|---|
| `SKILL.md` | The entry point an agent loads |
| `registry.json` | Foundations and standards with status |
| `CONTRACT.md`, `schemas/` | What a standard provides; `roles-covered` shape |
| `foundations/{routing,gates}/` | Playbooks per verb |
| `standards/testing/` | Declaration, roles, conformance spec, playbooks, cards, formats, templates |
| `scripts/` | `ws.mjs`, `review-all.mjs`, `review-routing.mjs`, `conformance.mjs` (dependency-free) |
| `fixtures/`, `tests/` | Negative controls; `node --test tests/*.test.mjs` |
| `decisions/reuse-decision.md` | The recorded reuse decision for the gate runner and the managed-block writer |

## Runtime

`declarative`: the host reads `SKILL.md`; the scripts need Node 20 or later and nothing installed.

## Verify

```bash
node --test tests/*.test.mjs                         # unit + e2e
node scripts/conformance.mjs testing --strategy <path to STRATEGY.md>
node scripts/review-all.mjs --allow-planned
```

## Install

```bash
soxe install workspace-standards --host claude --scope user
soxe install workspace-standards --host opencode --scope user
```

## License

MIT
