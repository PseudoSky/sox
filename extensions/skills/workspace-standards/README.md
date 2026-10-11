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
| `scripts/` | `ws.mjs`, `review-all.mjs`, `review-routing.mjs`, `conformance.mjs`, `marker-engine.mjs`, `apply-testing.mjs`, `foundations.mjs` (dependency-free) |
| `engine/` | The domain-neutral gate and check engine (`cli.mjs run`, `cli.mjs check`); see `engine/README.md` |
| `fixtures/`, `tests/` | Negative controls; `node --test tests/*.test.mjs` |
| `decisions/reuse-decision.md` | The recorded reuse decision for the gate runner and the managed-block writer |

## Apply routing and apply gates

```
node scripts/foundations.mjs apply routing [--root <repo>] [--dry-run] [--force] [--no-file]
node scripts/foundations.mjs apply gates   [--root <repo>] [--dry-run] [--force] [--no-file]
node scripts/foundations.mjs review routing [--root <repo>]   # read-only drift check, exit 3 on drift
node scripts/foundations.mjs review gates   [--root <repo>]
```

- **Routing** writes `workspace-standards:routing` in `AGENTS.md`: the task-to-agent table (every work class of every routed standard, with the agent that holds its role, by name), the role holders, and the role-resolution capability row. The table states that it wins over the dispatcher's own rows. `docs/standards/roles.md` is composed from every routed standard's `roles.md`. Holders resolve statically from `extensions/agents/*/extension.json` (`roles-covered:<ID>` and `agent.tools`); a role with no eligible agent is `_unbound_`, which the T10 roster guard reports as a warning, not a failure.
- **Gates** writes `workspace-standards:gates`: the gate registry (each standard's gate set, `test-gates` for testing), the stage bindings A to H, and the one runner row, which names the engine (`engine/cli.mjs`). No standard adds a runner.
- **Ownership:** a standard that declares `own: ["routing"]` (or `"gates"`) is skipped by the matching foundation target and reported as skipped; apply testing writes that block itself.
- **Mechanisms it cannot write:** a mechanical gate with no command in the repository's `gates.table.json` gets one backlog item through the backlog CLI, recorded in `workspace-standards:foundations-filed`. Apply testing reads the same ledger, so either order files each gate once.
- **Drift:** a hand edit inside a block is drift for `review routing` or `review gates` (exit 3, diff on stderr). Apply refuses to overwrite it without `--force`.

## Apply testing

```bash
node scripts/apply-testing.mjs --root <repo> [--dry-run] [--check] [--force] [--no-file] [--declaration <file>] [--backlog-project <name>]
```

Writes only the testing-specific repository side: between `workspace-standards:testing` markers in `AGENTS.md` the testing block (at most 12 narrative lines), the `test-routing` capability row, and the class table; and the IMPLEMENTATION skeleton at the binding path (`docs/standards/testing.md`), created once. The binding table lives in a `workspace-standards:testing:hand-maintained` region that is never overwritten, even with `--force`.

- **Routing and gates** are written (`testing-routing` and `testing-gates` blocks, `docs/standards/testing-roles.md`) only when the declaration says `routing: own` and/or `ownership.gates: own`; otherwise the run reports them skipped.
- **Drift:** a managed block that differs from its rendering is reported (exit 3, diff on stderr) and not overwritten without `--force`. `--check` is the read-only form `review testing` runs.
- **Mechanisms it cannot write:** each mechanical gate with no row in the binding table gets one backlog item through `adhd-backlog backlog create`; the item id is recorded in a `workspace-standards:testing-mechanisms` ledger block in the skeleton, so a re-run files nothing twice. `--no-file` skips filing.
- **`--dry-run`** prints the diff and writes and files nothing. A second run on an applied repository changes nothing.
- Exit: 0 clean, 3 drift, 4 a backlog item could not be filed, 64 usage, 65 unreadable input or malformed markers.

`scripts/marker-engine.mjs` is the reusable block writer (`upsertBlock(text, target, body, { force })`, parameterized by target name): replace between one pair, create the pair if absent, report drift. The decision to build it rather than add `markdown-magic` is in `decisions/reuse-decision.md`.

## Runtime

`declarative`: the host reads `SKILL.md`; the scripts need Node 20 or later and nothing installed.

## Verify

```bash
node --test tests/*.test.mjs engine/tests/*.test.mjs   # unit + e2e + apply testing + gate engine
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
