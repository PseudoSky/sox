# Memory CLI

> Deterministic shell-style administration for the sox-memory graph store — init, status, list, export, and pipeline health, with zero LLM calls.

## Overview

`@adhd/sox-extension-memory-cli` provides the lifecycle and maintenance commands for a sox-memory store: create a scope, inspect health, browse recent memories, export to markdown, re-embed after a model change, back up, compact, and drive the enrichment pipeline's control plane. Every subcommand is deterministic and produces predictable, scriptable output.

All subcommands operate against SQLite-compatible `.db` files in `.memory/<scope>.db` under the cwd (`project`/`local` scopes) or `~/.memory/<scope>.db` (`user`/`org` scopes). Paths can be overridden with `--db`/`--path`.

```bash
pnpm add @adhd/sox-extension-memory-cli
```

## Quick start

The package's entrypoint exports `runCli`, an async function that takes the same argv it would parse from a shell — this is exactly how its own test suite drives it:

> **No type declarations ship with this package.** It is built as an executable bundle, so
> `dist/` contains no `.d.ts` and `package.json` declares no `types` field. The examples below
> are JavaScript. Importing it from TypeScript under `noImplicitAny` raises
> `TS7016: Could not find a declaration file for module` — add your own ambient declaration, or
> drive the package through its command line / MCP interface, which is its intended seam.

```js
import { runCli } from '@adhd/sox-extension-memory-cli';

await runCli(['init', '--scope', 'project']);   // create .memory/project.db + schema
await runCli(['status']);                        // print scope, node count, embedding model
await runCli(['list']);                           // list recent live nodes
```

It also runs as a standalone Node script — the same file self-invokes when run directly:

```bash
node node_modules/@adhd/sox-extension-memory-cli/dist/index.js status
```

### As a host-installed command extension

```bash
soxe install memory-cli --host=opencode --scope=project
```

`memory-cli` is a `type: command` extension: the host activates it and registers `runCli` under the command verb `memory-cli` (the extension's id) inside the host's in-process command registry — it is invoked by the host/agent, not exposed as a new global shell binary by installing the npm package alone. `memory-server` must already be installed; this package's schema/store code comes from `@adhd/sox-memory-core`, which `memory-server` also depends on.

Do not use this CLI on the read/write hot path — it opens and closes the database on every invocation, which is fine for administration but too slow for an agent's recall/write loop. Use the `memory_write`/`memory_recall` MCP tools (`memory-server`) instead.

## Subcommands

| Command | Flags | Description |
| --- | --- | --- |
| `init` | `--scope <s>` `--path <dir>` | Create `.memory/<scope>.db`, initialise schema, update the registry. |
| `status` | `--path <dir>` | Print scope, node count, embedding model, and path for every discovered store. |
| `list` | `--path <dir>` | List the 20 most recent live nodes across every store under a directory. |
| `registry` | — | Show `~/.memory/registry.json` with a per-scope existence check. |
| `export` | `--scope <s>` `--base-path <p>` `--dir <path>` `--db <path>` | Export live episodes to a markdown mirror. |
| `reembed` | `--db <path>` `--dry-run` `--force` `--no-backup` `--limit <n>` | Re-embed a store with the current embedding model. |
| `backup` | `--db <src>` `--dest <dst>` (or positional `<src> <dst>`) | `VACUUM INTO` a backup file; both paths must be inside `~/.memory/**`. |
| `compact` | `--db <path>` `--no-optimize` (or positional `<path>`) | `PRAGMA optimize` + `ANALYZE` + WAL checkpoint. |
| `pipeline` | `<status\|drain\|reset\|resume>` `--db <path>` `--dry-run` `--limit <n>` | Read/drive the enrichment + embed pipeline's health ledger, verdict, and poison-row table. |
| `help` | — | Print the usage summary above (also the default with no command). |

## Scope → default store path

| Scope | Default path |
| --- | --- |
| `project` | `<cwd>/.memory/project.db` |
| `local` | `<cwd>/.memory/local.db` |
| `user` | `~/.memory/user.db` |
| `org` | `~/.memory/org.db` |

## Constraints

- Deterministic: zero LLM calls in every subcommand.
- `init` is idempotent — safe to run multiple times against an existing store.
- Store open, schema init, and embedding come from `@adhd/sox-memory-core` (`openDb`, `initScope`, `reembedStore`) — the same module `memory-server` uses, so both packages read/write an identical schema.

## Gotchas

- **`init --scope <s>` silently overwrites a single global registry slot per scope name.** `~/.memory/registry.json` has exactly one entry per scope name (`project`, `user`, `org`, `local`, or any named `store`) machine-wide — it is *not* keyed by directory. Running `memory-cli init --scope project` in project A, then again later in unrelated project B, overwrites project A's registry entry with project B's path; project A's `.memory/project.db` file itself is untouched, but `registry` / `--store` lookups for `project` now resolve to B. If you work across multiple projects, register each store's real path under its own name (`init --scope local` or a named `store`) rather than relying on the shared `project`/`user`/`org` slots, or always pass `--path`/`--db`/`db_path` explicitly instead of a bare scope/store name.

## Usage

```bash
soxe install memory-cli
# or install the full subsystem:
soxe install sox-memory-bundle
```

```js
import { runCli } from '@adhd/sox-extension-memory-cli';

await runCli(['init', '--scope', 'project']);
await runCli(['status']);
await runCli(['list']);
await runCli(['registry']);
```

## License

MIT
