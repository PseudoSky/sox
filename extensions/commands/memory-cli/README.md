# Memory CLI

> Use this when you need to manage the sox-memory store from the shell — initialise scopes, inspect store health, browse recent memories, or view the scope registry.

## Overview

`memory-cli` provides a set of deterministic shell subcommands for the sox-memory graph store lifecycle. It makes no LLM calls and produces predictable output suitable for scripting.

All subcommands operate against SQLite `.db` files in `.memory/<scope>.db` under the cwd (for `project`/`local` scopes) or `~/.memory/<scope>.db` (for `user`/`org` scopes). Store paths can be overridden with `--path`.

## When to use

- Run `memory init` once per scope to create the SQLite store, initialise the schema (node/edge/vec tables, FTS5 index, organizer queue), and register the path in `~/.memory/registry.json`.
- Run `memory status` to see which stores exist, how many nodes they contain, and which embedding model they use.
- Run `memory list` to browse the 20 most recent non-invalidated nodes in each store under a directory.
- Run `memory registry` to inspect `~/.memory/registry.json` and check which scope paths exist on disk.

Do NOT use this CLI on the read/write hot path — it opens and closes the database on every invocation, which is fine for administration but too slow for agent loops. Use the `memory_write`/`memory_recall` MCP tools instead.

## Invocation

```
memory <command> [--scope project|user|org|local] [--path DIR]
```

## Subcommands

| Command    | Description                                                        |
| ---------- | ------------------------------------------------------------------ |
| `init`     | Create `.memory/<scope>.db`, initialise schema, update registry   |
| `status`   | Print scope, node count, embedding model, and path for all stores |
| `list`     | List 20 most recent live nodes across all stores in a directory   |
| `registry` | Show `~/.memory/registry.json` with per-scope existence check     |
| `help`     | Print usage summary                                                |

## Flags

| Flag              | Default     | Description                                                  |
| ----------------- | ----------- | ------------------------------------------------------------ |
| `--scope`         | `project`   | Scope: `project`, `user`, `org`, or `local`                  |
| `--path DIR`      | (cwd)       | Override base directory for store resolution                  |

## Scope → default store path

| Scope     | Default path                         |
| --------- | ------------------------------------ |
| `project` | `<cwd>/.memory/project.db`           |
| `local`   | `<cwd>/.memory/local.db`             |
| `user`    | `~/.memory/user.db`                  |
| `org`     | `~/.memory/org.db`                   |

## Constraints

- Deterministic: zero LLM calls.
- `memory init` is idempotent — safe to run multiple times against an existing store.
- Depends on `memory-server` for the shared `db.ts` schema module.

## Usage

```bash
sox install memory-cli
# or install the full subsystem:
sox install sox-memory-bundle

# Initialise a project-scope store:
memory init --scope project

# Check store health:
memory status

# View recent memories:
memory list

# Inspect the registry:
memory registry
```

## License

MIT
