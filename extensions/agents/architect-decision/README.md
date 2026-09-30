# architect-decision

> One-shot architecture decision agent (deepseek-flash, hard 4-turn cap). Dispatched SOLELY to answer one question — never implements, never produces a spec, never engages beyond the verdict. Reads the repo's ADR catalog (docs/decisions/) and refuses any request that violates an ADR; hard-rejects steering/biased questions with structured advice; when information is insufficient returns exactly what is missing for a real decision; when the question deserves a full architecture engagement, escalates to architect.

## Overview

Declarative agent definition migrated into a born-conformant sox-ecosystem extension. The
entrypoint `architect-decision.md` is prose only — the host header (model, mode, temperature,
`steps`, permission map) is generated at install time from `agent` + `render` in `extension.json`.

## Model

`render.opencode.model` pins **`deepseek/deepseek-flash`**. The pre-migration hand-placed file
pinned the pro tier (~3x the flash output rate) for an agent whose whole job is one bounded
verdict — the cheap tier is the correct one.

## Hosts

**opencode only.** This agent's entire security envelope lives in opencode's `permission` map: a
read-only `bash` allowlist (`git log --oneline *`, `git remote *`, `ls *`, `cat *`, `*: deny`) and
explicit `task`/`question`/`todowrite`/`edit` denies — the one-shot guarantee depends on those, since
"`task` is not in your tools" is what stops it dispatching the `architect` it is meant to escalate to.
The declarative claude renderer maps only `edit`/`write` denies to `disallowedTools`; it has no way to
express a bash command allowlist or a `task` deny, so a claude install would silently grant full Bash
and Task. There is no faithful claude equivalent, so no claude render is declared and `install.hosts`
lists only opencode.

## Source

Migrated from `/Users/nix/.config/opencode/agents/architect-decision.md` (body preserved verbatim).
That origin file was a hand-placed, unmanaged definition — never in `extensions/`, the agent-mcp
catalog, or any lockfile/ownership record. After this extension was installed and verified, the
origin was removed so exactly one live definition remains (backup, if taken, is beside it as
`architect-decision.md.pre-ingest.bak`).

## Usage

```bash
soxe install architect-decision --host opencode --scope user
```

## License

MIT
