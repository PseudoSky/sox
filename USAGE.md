# USAGE — sox CLI command surface

The host CLI is `bin/soxe` (run as `node bin/soxe <verb> [flags]`). This document
walks **every command path the install model was designed for**, with the exact
syntax, the observable each command should produce, and an honest status marker.

> **Verify against reality.** Every command below is meant to be run for real
> (real spawn, real filesystem) and checked by its **observable** — a file at a
> host-discovery path, a running process, a denial with the side-effect absent —
> not by a unit test or a library call. That is the bar this doc holds itself to.

## Status legend

- ✅ **works today** — runnable now; observable verified this session.
- ⚠️ **designed, not yet wired end-to-end** — the capability exists at the
  library/unit layer, but the user-facing CLI path is missing or only proven as
  a library call. Running it today will fail or no-op. These are the gaps.

## The model in one line

Extensions install one of two ways:

- **Declarative placement (Role B)** — content types (`agent`, `skill`,
  `command`, `hook`, `rules`) are dropped at the **host's discovery path** for a
  `(host, scope)`. Triggered by `--host`.
- **Process / service (Role A)** — `mcp-server` (and code bundles) either run as
  a supervised process (`install` + `start`) or, by design, install as a
  declarative service via `--profile`.

## Command syntax

```
node bin/soxe <verb> [<id>] [flags]

verbs:   init <type> <id> · validate [<path>] · search [<query>] · install [<id>]
         · start · stop [<id>] · list · details <id> · enable <id> · disable <id>
         · update [<id>] · uninstall <id> · exec <id> …
flags:   --host <claude|codex>      # presence triggers declarative placement
         -s, --scope <project|user|local|org>   (default: project for --host installs)
         --root <dir>               # sandbox: resolve scope paths under <dir>
         --profile <name>           # mcp-server install profile (e.g. sse | stdio | service)
         # both `--flag value` and `--flag=value` parse.
```

`diff` is **library-only** — there is no `sox diff` verb yet (the descriptor diff
is exposed as a function in `@adhd/sox-install-engine`, not on the CLI). ⚠️

Active types: `agent`, `skill`, `mcp-server`, `command`, `hook`, `bundle`.
`prompt` is parked by design. `service` is **not** a type — it is an mcp-server
install profile (a sox-run execution mode).

---

## A — Authoring lifecycle (every active type)

```bash
node bin/soxe init <type> demo-<type>                      # ✅ scaffolds extensions/<typedir>/demo-<type>
./node_modules/.bin/nx build demo-<type>                  # ✅ build is nx, per project
node bin/soxe validate extensions/<typedir>/demo-<type>    # ✅ asserts born-conformant manifest
```

Run for each of: `agent skill mcp-server command hook bundle`.

## B — Declarative placement on **claude** (project + user)

```bash
T=$(mktemp -d)
node bin/soxe install demo-agent   --host claude --scope project --root "$T"   # ✅ → $T/.claude/agents/demo-agent.md
node bin/soxe install demo-agent   --host claude --scope user    --root "$T"   # ✅ → $T/.claude/agents/…
node bin/soxe install demo-skill   --host claude --scope project --root "$T"   # ✅ → $T/.claude/skills/demo-skill/SKILL.md
node bin/soxe install demo-skill   --host claude --scope user    --root "$T"   # ✅
node bin/soxe install demo-command --host claude --scope project --root "$T"   # ✅ → $T/.claude/commands/demo-command.md
node bin/soxe install demo-hook    --host claude --scope project --root "$T"   # ⚠️ hook = file-drop (script) + config-merge (settings.json hooks entry); assert BOTH — the config-merge half is unverified
```

## C — Declarative placement on **codex**

```bash
node bin/soxe install demo-skill --host codex --scope user    --root "$T"   # ✅ → $T/.codex/skills/demo-skill/ (P0.6-verified path)
node bin/soxe install demo-agent --host codex --scope project --root "$T"   # ⚠️ codex AGENTS.md file-drop — registered but not exercised end-to-end
```

## D — mcp-server install **modes** (the dod.2 matrix)

```bash
node bin/soxe install demo-mcp --host claude --scope project --profile sse     --root "$T"   # ⚠️ sse/http → $T/.mcp.json (config-merge, --trust prompt)
node bin/soxe install demo-mcp --host claude --scope user    --profile stdio   --root "$T"   # ⚠️ stdio → $T/.claude.json (user-scope spawn), NOT .mcp.json
node bin/soxe install demo-mcp --host claude --scope project --profile service --root "$T"   # ⚠️ sox service via run-service — UNWIRED: declarativeInstall only dispatches file-drop/config-merge today
```

## E — Process / service runtime lifecycle (supervisor path)

```bash
node bin/soxe install memory-server -s project --root "$T"     # ✅ config-resolver install
node bin/soxe start  -s project --root "$T"                    # ✅ supervisor spawns the process
node bin/soxe list                                             # ✅ shows memory-server RUNNING
node bin/soxe details memory-server                            # ✅ scope / pid / source
node bin/soxe exec   memory-server memory_recall '{"query":"x","db_path":"'"$T"'/m.db"}'   # ✅ tool returns
node bin/soxe disable memory-server -s project                 # ✅ deactivates (process stops)
node bin/soxe enable  memory-server -s project                 # ✅ reactivates
node bin/soxe stop   memory-server                             # ✅ teardown, zero orphans
node bin/soxe uninstall memory-server -s project               # ✅ removed + lockfile updated
```

## F — update + reversal (per declarative path)

```bash
# bump demo-skill version, then:
node bin/soxe update demo-skill -s project                                     # ✅ re-pins / re-installs
node bin/soxe uninstall demo-skill --host claude --scope project --root "$T"   # ⚠️ declarative uninstall by --host: assert files REMOVED + ledger entry reversed (less exercised than install)
```

## G — Negative / enforcement (each MUST be denied, side-effect ABSENT)

```bash
node bin/soxe install demo-mcp --host claude --scope project --profile stdio-into-mcp --root "$T"  # ⚠️ stdio→.mcp.json MUST be denied (exit≠0, no .mcp.json entry) — proven as a lib call, not via the CLI verb
node bin/soxe exec memory-server memory_write '{"content":"x","db_path":"/tmp/evil.db"}'           # ✅ C6: denied + /tmp/evil.db absent on disk
node bin/soxe install demo-mcp  --host codex  --scope project --root "$T"                          # ⚠️ manifest carrying a codex project-forbidden key MUST be denied
node bin/soxe install demo-agent --host claude --scope org --root "$T"                             # ⚠️ org/managed tier → no write (scopePaths('org') is empty); assert nothing placed
```

---

## Gap summary (the ⚠️ paths)

| Path | Gap | Closes |
|------|-----|--------|
| D — mcp-server `sse`/`stdio` modes | install-mode selection via `--profile` not exercised through the CLI verb | `[dod.2]` first half |
| D — mcp-server `service` profile | `run-service` capability never invoked by `declarativeInstall` (file-drop/config-merge only) | `[dod.2]` second half |
| B/G — hook config-merge half | settings.json hooks entry on hook install unverified | hook install completeness |
| G — denials via the CLI verb | stdio-into-.mcp.json, codex-forbidden-key, org/managed no-write proven only as library calls | enforcement reality at the CLI |
| F — declarative uninstall | `--host` uninstall reversal less exercised than install | reversal symmetry |
| `diff` | no `sox diff` verb (library-only) | CLI completeness |

These are the same class of gap that recurred all session: the **capability is
real at the library/unit layer, but the command a user actually types isn't
wired or isn't proven**. The remedy is to run the exact commands above and
assert the observable — tier-3 evidence, not a green unit test.
