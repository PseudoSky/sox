# USAGE — soxe CLI command surface

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

---

## Scopes — the data/placement split (ADR-0004)

Sox has **four scopes**, cascade-resolved **org → user → project → local**
(narrowest wins). Every scope keeps **two** roots distinct:

- **Data root** — bookkeeping only: the lockfile, the `config` block
  (`extensions.json`), the reversal `ledger.json`, the `ownership.json` inventory,
  and materialized service stores. User scope's data root is
  **`$SOX_ECOSYSTEM_HOME`** (default `~/.adhd/sox-ecosystem/`); project/local use
  **`<repo>/.adhd/sox-ecosystem/`**.
- **Placement root** — where content actually lands so the **host** discovers it:
  the **real** `~/.claude/` (+ `~/.claude.json` for MCP) at user scope, or
  `<repo>/.claude/` (+ `<repo>/.mcp.json`) at project scope. `$SOX_ECOSYSTEM_HOME`
  governs **data only** — it never redirects placement.

| Scope | Data dir | Config file | Lockfile | Host placement base |
|-------|----------|-------------|----------|---------------------|
| **org** | `$SOX_ECOSYSTEM_HOME` | `org.extensions.json` | `org.extensions.lock` | *(none — managed/read-only policy tier; soxe never writes the host)* |
| **user** | `$SOX_ECOSYSTEM_HOME` (`~/.adhd/sox-ecosystem/`) | `extensions.json` | `extensions.lock` | `~/.claude/`, `~/.claude.json` |
| **project** | `<repo>/.adhd/sox-ecosystem/` | `extensions.json` | `extensions.lock` | `<repo>/.claude/`, `<repo>/.mcp.json` |
| **local** | `<repo>/.adhd/sox-ecosystem/` | `extensions.local.json` | `extensions.local.lock` | `<repo>/.claude/settings.local.json` |

Global, user-data-root-only files (one per machine): `install-registry.json`
(every consumer × scope), `supervisors.json`, `run/`.

---

## Install · uninstall · configure at each scope

> Identity is **content-addressed** (ADR-0003): an extension is `id + sha256(artifact)`.
> Installs are **idempotent** — re-running rewrites only when the artifact checksum
> differs — and every placement is recorded in the ownership index + ledger so
> uninstall reverses it **exactly**, leaving foreign host entries byte-clean.

### Install

```bash
# user — this machine, available to every project & agent
node bin/soxe install <id|bundle> --scope user
# project — this repo only (this is the default scope for --host installs)
node bin/soxe install <id|bundle> --scope project
# local — machine-local override for this repo (git-ignored)
node bin/soxe install <id|bundle> --scope local
# org — managed policy tier (writes org.extensions.* data; no host placement)
node bin/soxe install <id|bundle> --scope org
```

- A **bundle** (e.g. `sox-memory-bundle`) installs all its members; each member
  routes to its correct surface — a `skill` is file-dropped to
  `<placement>/skills/`, a stdio `mcp-server` is config-merged into
  `~/.claude.json` (user) or `.mcp.json` (project). See
  `docs/mcp-global-availability.md` for the stdio→`~/.claude.json` rule.
- Re-running install after editing an extension's artifact re-pins the lockfile to
  the new checksum (the C2 drift gate enforces a current registry).
- **`install <id>` reconciles the full scope set** — it does not only install the
  named extension. The engine reads the scope's existing `extensions.json`, adds
  `<id>` (if new), then re-resolves and re-places **every** member already declared
  in that scope. Extensions already at their current checksum are no-op; those whose
  artifact changed are re-pinned. This means running `install demo-creator --scope
  project` may also re-place `memory-usage` and other extensions already recorded in
  the project's `extensions.json`. This is by design (idempotency + integrity), not
  an error.

### Uninstall (fully reversible — ADR-0004 `[inv:reversible-injection]`)

```bash
node bin/soxe uninstall <id> --scope user
node bin/soxe uninstall <id> --scope project
node bin/soxe uninstall <id> --scope local
```

Uninstall consumes the ownership index + ledger to reverse **everything** that
install placed:

- file-drops and materialized service stores are removed;
- config-key / array merges are reversed via the ledger — **foreign keys at the
  same file are preserved byte-clean** (e.g. a third-party MCP server in your
  `~/.claude.json` is untouched);
- for a **user-scope MCP server**, both the global `~/.claude.json` entry **and**
  every propagated project `.mcp.json` entry are removed;
- the lockfile entry, the `extensions.json` install record, and the global
  install-registry record are cleared.

### Configure — `get` / `set` / `list` / `unset` / `check`

Per-extension config lives in the scope's `extensions.json` under the `"config"`
block, **cascade-resolved org → user → project → local (narrowest wins)**, and is
injected into the extension at spawn time as **`SOX_CONFIG_<KEY>`** env vars.

```bash
# set — default write scope is `user`. Values support ~ and ${ENV_VAR} refs.
node bin/soxe config set memory-server db_path '~/.memory/memory.db' --scope user

# get — returns the cascade-resolved value (narrowest scope wins)
node bin/soxe config get memory-server db_path

# list — every key with the scope it resolved from
node bin/soxe config list memory-server

# unset — remove a key from ONE scope (cascade may still resolve it from a wider scope)
node bin/soxe config unset memory-server db_path --scope project

# check — validate the resolved config against the extension's config_schema
node bin/soxe config check memory-server
```

**Per-scope override** — set a machine-wide default at user scope, override it for
one repo at project scope:

```bash
node bin/soxe config set memory-server token_budget 50000 --scope user
node bin/soxe config set memory-server token_budget 8000  --scope project   # this repo
node bin/soxe config get  memory-server token_budget                        # → 8000 (project wins)
node bin/soxe config list memory-server                                     # shows origin per key
```

**Secrets** — never store literal secrets; use an env ref so the value is expanded
from the environment at spawn time (a secret-looking key triggers a warning):

```bash
node bin/soxe config set my-ext api_key '${MY_EXT_API_KEY}' --scope user
```

### Keeping consumers current — `upgrade --all [--force]`

```bash
node bin/soxe upgrade --all              # verify checksum → re-install stale → rolling-restart services
node bin/soxe upgrade <id> --all         # scope the sweep to one extension
node bin/soxe upgrade --all --force      # ALSO reconcile user-scope MCP servers into every project .mcp.json
```

- Walks every install-registry consumer across all scopes; **idempotent** — a
  fully-current system makes **zero** changes (there is no separate `doctor`/`verify`
  command by design). A stale consumer is re-installed and, if it's a running
  supervised service, **rolling-restarted** (verified-stop → dedup-guarded start).
- **`--force`** adds the project-`.mcp.json` reconcile — the durable fix for Claude
  Code #16728, where a project's `.mcp.json` *overrides* (does not inherit)
  user-scope MCP servers. Use it after a **new project** appears, so it inherits the
  user-scope server even though nothing went stale. Discovery is driven off install
  records, so it finds servers the ownership index might not yet list.
- **After merging a change to an installed extension's artifact, run
  `node bin/soxe upgrade --all`** (do not leave the user-scope install stale).

### Relocating the data root — `migrate-home` (ADR-0004)

```bash
node bin/soxe migrate-home --dry-run     # preview every move; write nothing
node bin/soxe migrate-home               # move legacy ~/.sox + ~/.config/extensions → ~/.adhd/sox-ecosystem/
```

Migrated MCP re-placements into `~/.claude.json` are now **tracked** (ownership +
ledger), so a later `uninstall` reverses them like any normal install.

---

## Command syntax

```
node bin/soxe <verb> [<id>] [flags]

verbs:   init <type> <id> · validate [<path>] · search [<query>] · install [<id>]
         · start · stop [<id>] · list · details <id> · enable <id> · disable <id>
         · update [<id>] · upgrade <id> --all · uninstall <id> · exec <id>
         · config <get|set|list|unset|check> <ext> … · migrate-home …
flags:   --host <claude|codex>      # presence triggers declarative placement
         -s, --scope <project|user|local|org>   (default: project for --host installs)
         --root <dir>               # sandbox: resolve scope paths under <dir>
         --profile <name>           # mcp-server install profile (e.g. sse | stdio | service)
         --all                      # (upgrade) operate on every install-registry consumer
         --force                    # (upgrade --all) also reconcile user MCP into project .mcp.json
         # both `--flag value` and `--flag=value` parse.
```

> **`sync-mcp` was removed (2026-06-23).** Its project-`.mcp.json` propagation is now
> folded into `upgrade --all --force` (see *Keeping consumers current* below).

`diff` is **library-only** — there is no `soxe diff` verb yet (the descriptor diff
is exposed as a function in `@adhd/sox-install-engine`, not on the CLI). ⚠️

Active types: `agent`, `skill`, `mcp-server`, `service`, `command`, `hook`, `bundle`.
`prompt` is parked by design. `service` is a first-class type — a long-running process
extension supervised by the soxe host runtime (`soxe start`/`stop`/`list`). It does not
require the MCP wire protocol. See `docs/guidelines/authoring.md §service`.

---

## A — Authoring lifecycle (every active type)

```bash
node bin/soxe init <type> demo-<type>                      # ✅ scaffolds extensions/<typedir>/demo-<type>
./node_modules/.bin/nx build demo-<type>                  # ✅ build is nx, per project
node bin/soxe validate extensions/<typedir>/demo-<type>    # ✅ asserts born-conformant manifest
```

Run for each of: `agent skill mcp-server service command hook bundle`.

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
node bin/soxe install demo-mcp --host claude --scope project --profile service --root "$T"   # ⚠️ soxe service via run-service — UNWIRED: declarativeInstall only dispatches file-drop/config-merge today
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
| `diff` | no `soxe diff` verb (library-only) | CLI completeness |

These are the same class of gap that recurred all session: the **capability is
real at the library/unit layer, but the command a user actually types isn't
wired or isn't proven**. The remedy is to run the exact commands above and
assert the observable — tier-3 evidence, not a green unit test.

---

## Recent updates

**2026-06-23**

- **`sync-mcp` verb removed → folded into `upgrade --all --force`.** The standalone
  verb was redundant surface: the project-`.mcp.json` propagation (#16728) now runs
  as part of the idempotent `upgrade` sweep, reconciling unconditionally across every
  known project even when nothing is stale.
- **`migrate-home` MCP re-placement is now tracked.** Previously it wrote
  `mcpServers.<id>` into `~/.claude.json` with a raw merge — an *untracked* injection
  that was invisible to discovery and irreversible on uninstall. It now records the
  ownership `config-key` + the ledger reversal action (via the new
  `registerUserMcpServer` primitive), identical to a fresh install. A backfill-safe
  `config-merge` path (`recordWhenUnchanged`) records the reversal action even when the
  value is already present.
- **Test isolation (BL-35) fixed at the source.** install-engine specs that drive
  `install()` no longer leak fixture records into the real user install-registry — a
  suite-wide vitest setup sandboxes `$SOX_ECOSYSTEM_HOME`. `knownProjectRoots()` also
  skips `os.tmpdir()` roots so a stray leak can never fan `upgrade --force` out into
  dead `/tmp` project roots.
