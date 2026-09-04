# @adhd/sox-cli

The `soxe` command-line interface for the soxe LLM-extension ecosystem — scaffold, validate,
search, install, run, and supervise extensions (agents, skills, MCP servers, hooks, commands,
bundles, and background services) across four install scopes (`org` / `user` / `project` /
`local`). Ships as a single self-contained binary — every `@adhd/sox-*` dependency is bundled in,
so a global install has zero runtime dependencies to resolve.

```bash
npm install -g @adhd/sox-cli
```

## Quick start

```bash
soxe --version
# 1.2.0

soxe search memory
# lists every registry extension whose id/description matches "memory"

soxe install sox-memory-bundle --scope user
# resolves the bundle, expands it to its member extensions, and installs each
# at the right surface for its type (skills file-drop, MCP servers config-merge, etc.)

soxe list
# shows what's installed and, for process-backed extensions, whether it's running

soxe --help
# full command reference (also below)
```

`soxe install <id|bundle> --scope <org|user|project|local>` is the one command most consumers
need — a **bundle** resolves to its full member set and routes each member to wherever its type
belongs; native dependencies pulled in along the way go through a real `npm install` into a
per-extension content store so the platform binary resolves correctly.

## Command reference

Every flag accepts both `--flag=value` and `--flag value`.

### Authoring

```
soxe init <type> <id>   Scaffold a new extension
                         id: lowercase, kebab-case, must not end in the type name
                         Types: agent | skill | mcp-server | hook | command | bundle | service
                         Flags: --out=<dir>       write into <dir>/<id>/ (default: cwd)
                                --bundle=<name>   scaffold into a bundle's members/ dir
                                --title=<str>  --description=<str>
                                --author=<str>  --keywords=<k1,k2>
                                --events=<E1,E2>  (hook: PreToolUse, PostToolUse, SessionEnd, ...)
                                --runtime=<runtime>  (node | shell | python | declarative)
                                --transport=<t>  --transports=<t1,t2>  (stdio | sse | http)
```

```bash
soxe init skill my-helper --title "My Helper" --description "Use this when the user needs help with X"
```

### Validation

```
soxe validate [path]    Validate extension.json at path (default: ./extension.json)
```

```bash
soxe validate ./my-helper
```

Exit codes: `0` manifest is valid · `1` manifest is invalid (errors printed to stdout) ·
`2` file not found or parse error.

### Registry / search

```
soxe search <query>     Search the extension registry
                         Flags: --type=<type>  --json
```

```bash
soxe search memory --type mcp-server
soxe search --json          # every registry entry, machine-readable
```

### Extension management

```
soxe install <id|bundle>   Install extension by id (or expand a bundle) at scope
                           Flags: --scope=<scope>  --host=<hosts>  --frozen-lockfile  --update
                                  --no-restart  --profile=<p>  --version=<semver>  --dry-run
soxe update                Update installed extensions
                           Flags: --scope=<scope>
soxe upgrade <ext-id>      Re-install stale consumers across all scopes/projects
                           Flags: --all (required)
                                  --force  also reconcile user-scope MCP servers into
                                           every known project .mcp.json
                                  --host=<host>  host for the --force reconcile (default: claude)
soxe uninstall             Remove an extension
                           Flags: --id=<ext-id>  --scope=<scope>
soxe enable                Enable a disabled extension
                           Flags: --id=<ext-id>  --scope=<scope>
soxe disable               Disable an extension
                           Flags: --id=<ext-id>  --scope=<scope>
```

```bash
soxe install my-helper --scope user
soxe install tokenguard --host=claude,codex --scope project
soxe uninstall --id my-helper --scope user
```

`--dry-run` on `install` takes the declarative path (skill/agent/hook/bundle): it plans and prints
the would-be install targets without writing anything.

### Config

```
soxe config get   <ext> <key>         Get a cascade-resolved config value
soxe config set   <ext> <key> <val>   Persist a value to scope config (default: user)
soxe config list  <ext>               Show all keys with cascade origin per key
soxe config unset <ext> <key>         Remove a key from a scope config
soxe config check <ext>               Validate config against extension's config_schema
                     Flags: --scope=<scope>  --no-restart  --dry-run
```

```bash
soxe config set tokenguard proxyPort 8787
soxe config get tokenguard proxyPort
soxe config list tokenguard
```

Config lives in `extensions.json` under the `config` block, cascade-resolved narrowest-scope-wins
(`local` > `project` > `user` > `org`). Sensitive values should be env refs (`${VAR_NAME}`) rather
than literal secrets.

### Runtime

```
soxe start [<ext-id>]   Start the host runtime (or a specific extension)
                         Flags: --scope=<scope>  --root=<root>  --id=<ext-id>
soxe stop [<ext-id>]    Stop the runtime or a single extension
                         Flags: --scope=<scope>  --id=<ext-id>
soxe serve <ext-id>     Launch an MCP server with live cascade config (for .mcp.json)
                         Flags: --scope=<scope>  --root=<dir>
soxe exec <ext-id> <tool>  Call a tool on a running extension
                         Flags: --scope=<scope>  --id=<ext-id>  --tool=<tool>  --args='<json>'
```

```bash
soxe start                                  # start every installed process extension
soxe stop my-helper
soxe exec tokenguard status --args='{}'
```

### OS-supervisor control (reboot persistence)

```
soxe service enable  <ext> [-s <scope>]   Generate + load an OS unit (launchd/systemd)
soxe service disable <ext> [-s <scope>]   Unload + remove the unit; reap any survivor
soxe service restart <ext> [-s <scope>]   Deploy the on-disk bundle to the RUNNING process
soxe service update   <ext> [-s <scope>]   Reconcile config/node-path drift, verified
soxe service status   <ext> [-s <scope>]   Show the unit state reconciled with sox
soxe service list                          All sox-owned OS units across scopes

Flags: --scope=<scope>  --dry-run  --unit-dir=<dir>
       --supervisor=<launchd|systemd>  --node-path=<path>  --allow-volatile-node
```

```bash
soxe service enable tokenguard --scope user     # survives reboot via launchd/systemd
soxe service status tokenguard
```

### Observability

```
soxe list                List activated extensions
                          Flags: -s/--scope=<scope>  --all  --global  --json
soxe details <id>        Show details for an extension
                          Flags: --id=<ext-id>  --scope=<scope>
soxe status [<ext-id>]   Show live health for all running extensions
                          Flags: --id=<ext-id>  --project=<path>  --scope=<scope>
                                 --lines=<n>  --json
                          Exit: 0=healthy 1=degraded 2=dead
soxe doctor [<ext-id>]   Diagnose and repair soxe state (stray processes, orphans)
                          Flags: --id=<ext-id>  --fix (reap strays)  --scope=<scope>
                                 --old-match  use the old path-based matching (for comparison)
                                 --reconcile [--dry-run]          safe idempotent heal pass
                                 --install-tick [--interval <sec>]  schedule periodic
                                   reconcile under launchd/systemd (default 300s)
                                 --remove-tick                    reverse --install-tick
soxe logs <ext-id>       Tail or follow extension log output
                          Flags: --id=<ext-id>  --scope=<scope>  --lines=<n>  --follow  --history
                                 --json  --stream=<label> (process|backend|os-out|os-err|serve)
soxe ps                  Show merged process snapshot (supervisor + OS-units + locks)
                          Flags: --scope=<scope>  --json
soxe follow [<ext-id>]   Merged, prefixed, colorized live tail
                          Flags: --id=<ext-id>  --scope=<scope>  --lines=<n>
```

```bash
soxe list --json
```

```json
[
  {
    "id": "memory-server",
    "key": "memory-server",
    "version": "",
    "scope": "user",
    "running": true,
    "source": "/Users/you/extensions/bundles/sox-memory-bundle/members/memory-server/dist/index.js",
    "pid": 69207
  }
]
```

(This is real captured `soxe list --json` output — not a fabricated sample — with the machine-specific absolute path abbreviated to `/Users/you/...`. `source`, `pid`, and `version` reflect whatever is actually installed and running on your own machine.)

```bash
soxe status --json          # health for every running extension; exit code doubles as a signal
soxe doctor --fix            # reap stray/orphaned processes left behind by a crash
soxe logs tokenguard --follow --lines=100
```

### Migration

```
soxe migrate-home   Relocate soxe data to the .adhd/sox-ecosystem layout
                     Flags: --old-home  --old-config  --old-sandbox  --new-home  --dry-run
```

## Scopes, hosts, types

```
Scopes:  org | user | project | local  (narrower overrides wider)
Hosts:   claude | codex | opencode
Types:   agent | skill | mcp-server | hook | command | bundle | service
```

An extension resolves at the narrowest scope that has it installed: `local` beats `project` beats
`user` beats `org`. `--host` targets which host surface (`claude`/`codex`/`opencode`) an install or
config-sync operation applies to.

## Golden path for authoring an extension

```bash
# 1. scaffold (born-conformant; writes into the current directory)
soxe init skill my-helper --title "My Helper" --description "Use this when…"

# 2. validate the manifest + entrypoint
soxe validate ./my-helper

# 3. install at a scope
soxe install my-helper --scope user

# 4. run — declarative content (skill/agent/hook/bundle) is now discoverable by the host;
#    process types (mcp-server/service/command) start:
soxe start
```

`command`, `mcp-server`, and `service` types are code extensions and need a build step between
scaffold and validate (an esbuild bundle) — `skill`, `agent`, `hook`, and `bundle` are declarative
and need none.
