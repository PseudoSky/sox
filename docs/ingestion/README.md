# Ingestion — porting external extension sources into sox-ecosystem

This folder holds the **hand-off prompts** and the **migration plan** for bringing
existing extension-like code from other repositories into this ecosystem as
born-conformant extensions (each going `init → build → validate → install → run`
with zero manual conformance work, per [`DOD.md`](../../DOD.md)).

There are two kinds of artifact here:

| Artifact | Purpose |
|---|---|
| [`migration-plan.md`](./migration-plan.md) | How to plan and run a **bulk** migration of an external repo's catalog (discovery → pilot → batches → bundles). Start here when ingesting a whole repo. |
| [`prompts/<id>.md`](./prompts/) | A **self-contained hand-off prompt** for one extension. Give it to a coding agent (with filesystem access to both repos) to build that single extension end-to-end. |

## Source catalog (candidates flagged by the founder)

Real source locations earmarked for ingestion. **Deferred by design** — large; survey
before committing a plan. None of these have been read yet unless a prompt exists for them.

| Type | Source | Notes | Prompt |
|---|---|---|---|
| hook | `~/dev/ai/claude-agents/tools/hooks/` | a directory of hooks; `swarm-cost` is one of them | [`swarm-cost`](./prompts/swarm-cost.md) |
| mcp-server | `/Users/nix/dev/node/adhd/packages/ai/agent-mcp` | | — |
| command | `~/dev/ai/sox-protocol/packages/python` · `~/dev/ai/claude-agents/tools/cli` | two sources | — |
| skill | `~/dev/ai/claude-agents/categories/workflow/skills/` | a directory of skills | — |
| agent | `~/dev/ai/claude-agents/categories/00-active/agents/` | a directory of agents | — |
| prompt | *(unresolved)* | founder: "idk what this is" — resolve the `prompt` use case before ingesting | — |

## How to use a hand-off prompt

1. Pick (or generate) the prompt in `prompts/<id>.md`.
2. Hand it to a coding agent that has filesystem access to **both** the source repo and
   `/Users/nix/dev/ai/sox-ecosystem` (branch `feat/nx-migration`).
3. The prompt is self-contained: it makes the agent read ground truth in this repo
   (the per-type guideline, a working reference extension, the manifest schema, the CLI),
   scaffold born-conformant via the generator, declare runtime `permissions`, and
   **reality-verify** the full lifecycle (not just unit tests).

## Conventions for a new prompt (so they stay consistent)

Every `prompts/<id>.md` follows the same skeleton:

1. **Header** — source path, target type, proposed id, status.
2. **Context** — what sox-ecosystem is + where it lives + the working branch.
3. **Task** — port `<source>` into a born-conformant `<type>` extension.
4. **Ground truth first** — the exact in-repo sources the agent must read before coding
   (`DOD.md`, `docs/guidelines/`, a reference extension of the same type, `libs/manifest`,
   `node bin/sox --help`) **and** the source itself.
5. **Scaffold born-conformant** — use the generator (`node bin/sox init <type> <id>`); never
   hand-roll the layout.
6. **Port the logic** — preserve the source's exact behavior, adapted to the type contract.
7. **Declare permissions (C6)** — exact fs/network/socket the source touches; undeclared
   access is denied at runtime.
8. **Reality-verify the lifecycle** — build → validate → install (sandboxed scope) → start →
   observe it run → stop with zero orphans; capture real output, not self-reported logs.
9. **Constraints + Definition of Done.**

The non-negotiable principle in every prompt: **derive the contract from this repo's ground
truth, not from memory; prove done against reality, not tests.**

## Status

- `swarm-cost` — prompt drafted; source not yet read by the prompt author (the prompt makes the
  executing agent read it). Not yet built.
