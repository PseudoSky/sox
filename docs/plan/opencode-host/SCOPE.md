# OpenCode Host — Scope & Implementation Plan

## Decision

Add `opencode` as a third host module in the sox-ecosystem install engine, alongside `claude` and `codex`. The capability system, manifest schema, lockfile, ledger, and CLI are already host-agnostic. Only ~17 lines of engine change (Surface optional `mcpConfig`) plus a new ~150-line host module are needed.

## Why

OpenCode (opencode-ai, v1.17.11, ~1.6M weekly npm downloads) is the dominant open-source CLI agent. Claude Code and Codex are already supported. Adding opencode triples the addressable surface with near-zero engine changes.

## Assessment

### Host-agnostic pieces (zero changes needed)

| Layer | Reason |
|---|---|
| `soxe install <id> --host=opencode` | Host name is a CLI parameter — just needs registration |
| fetch / resolve / checksum / verify | Content-addressed (ADR-0003), host-independent |
| `file-drop` capability | Hash-diff copy to any path |
| `config-merge` capability | Set key-path value in any JSON/TOML |
| `array-merge` capability | Append to arrays in any JSON |
| `materialize` capability | Place built code at store path |
| `bin-link` capability | Link executable on PATH |
| Lockfile + provenance ledger | Scope-aware, host-independent |
| Uninstall / rollback | Pure function of ledger (LIFO reverse) |

### Scope path mapping

| soxe scope | opencode path | Writable? |
|---|---|---|
| `project` | `<projectRoot>/opencode.json` | yes |
| `project` | `<projectRoot>/.opencode/` | yes (file-drop dir) |
| `user` | `~/.config/opencode/opencode.json` | yes |
| `user` | `~/.config/opencode/` | yes (file-drop dir) |
| `local` | `<projectRoot>/.opencode/` | yes |
| `org` | `./.well-known/opencode/` | no (remote, read-only) |

### Surface matrix: soxe extension type → opencode surface

| soxe type | opencode equivalent | Capability | Target |
|---|---|---|---|
| `agent` | Agent | `config-merge` | `opencode.json` → `agent.{id}` |
| `agent` | Agent | `file-drop` | `.opencode/agents/{id}.md` |
| `skill` | Skill | `file-drop` | `.opencode/skills/{id}/SKILL.md` |
| `mcp-server` | MCP server | `config-merge` | `opencode.json` → `mcp.{id}` |
| `command` | Custom command | `config-merge` | `opencode.json` → `command.{id}` |
| `hook` | Plugin | `array-merge` | `opencode.json` → `plugin` |
| `prompt` | Agent (subagent) | `config-merge` | `opencode.json` → `agent.{id}` |
| `service` | Plugin or MCP | `config-merge` or `array-merge` | Depends on transport |
| `bundle` | (engine expands) | Per-member above | Per-member |

### MCP format translation

```jsonc
// Claude (.mcp.json) — current soxe output
{ "mcpServers": {
    "memory-server": {
      "command": "npx",
      "args": ["-y", "@adhd/sox-memory-server"]
    }
  }
}

// OpenCode (opencode.json) — new host output
{ "mcp": {
    "memory-server": {
      "type": "local",
      "command": ["npx", "-y", "@adhd/sox-memory-server"]
    }
  }
}
```

### What the install engine will NOT bring over (and why it's fine)

| soxe feature | Verdict | OpenCode handles it |
|---|---|---|
| **lifecycle** (background, singleton, health, stop_timeout_ms) | COUPLED to soxe host-runtime `ProcessSupervisor` | MCP servers launched on-demand per transport; no daemon supervisor |
| **permissions.fs / permissions.network** | COUPLED to sox `SOX_PERM_*` env protocol | opencode manages its own sandbox at tool-call boundaries |
| **config_schema** / `x-sox-prompt` | SEPARABLE (install-time only, no runtime dep) | opencode has no interactive install wizard; values go into opencode.json directly |
| **provider-capabilities** | SEPARABLE (static table lookup, pure function) | opencode model selection is the user's responsibility at config time |
| **ledger.json / ownership.json** | SEPARABLE (filesystem bookkeeping, node builtins only) | opencode has no de-provisioning; user edits opencode.json manually |
| **MCP runtime / service proxy** | SEPARABLE (dependency-free leaf libs) | opencode launches MCP servers directly via the `command` array |

### Catalog: all installable extensions, scope behavior

| ID | Type | Hosts declared | opencode-compatible? | Notes |
|---|---|---|---|---|
| `memory-org` | agent | `claude` | Yes | `file-drop` → `.opencode/agents/org-agent.md` or `config-merge` to `opencode.json` |
| `test-runner` | agent | `claude` | Yes | same as above |
| `sox-ingest` | skill | `claude` | Yes | `file-drop` → `.opencode/skills/sox-ingest/SKILL.md` |
| `forbidden-access` | skill | _(default)_ | Yes | `file-drop` → `.opencode/skills/forbidden-access/SKILL.md` |
| `demo-creator` | skill | `claude` | Yes | `file-drop` → `.opencode/skills/demo-creator/SKILL.md` |
| `dep-injector` | skill | `claude` | Yes | `file-drop` → `.opencode/skills/dep-injector/SKILL.md` |
| `di-codex` | skill | `codex` | Yes | cross-host — needs `hosts: ["opencode"]` added to manifest |
| `dep-inject` | command | `claude` | Yes | `config-merge` → `opencode.json` `command.dep-inject` — requires `node` runtime available |
| `tokenguard` | service | _(none)_ | Partial | Http-based, no agent host dependency. Could be wired as MCP proxy. `background/singleton/permissions` not portable. |
| `sox-memory-bundle` | bundle | _(expands)_ | See members | Bundle expansion is host-agnostic |
| `memory-daemon` | service | _(none)_ | No | Unix-socket daemon, tightly coupled to soxe supervisor. Not installable standalone. |
| `memory-server` | mcp-server | _(none)_ | Yes | Stdio MCP server. Format adapter needed. `permissions.fs` not portable — opencode sandboxes at tool level. |
| `memory-flush` | hook | _(none)_ | Partial | Hook triggered by `SessionEnd`. opencode has plugin event hooks — could map. Needs npm package format. |
| `memory-cli` | command | _(none)_ | Yes | `config-merge` → `opencode.json` `command.memory-cli`. `node` runtime. |
| `memory-usage` | skill | `claude` | Yes | `file-drop` → `.opencode/skills/memory-usage/SKILL.md` |

### Which extension manifests need updating

Only extensions that declare `install.hosts: ["claude"]` or `["codex"]` without including `"opencode"`:

- `memory-org`, `test-runner`, `sox-ingest`, `demo-creator`, `dep-injector`, `dep-inject`, `memory-usage` — add `"opencode"` to their `hosts` array
- `di-codex` — add `"opencode"` (already targets codex, works identically)
- `forbidden-access` — omit `hosts` (already default, no change needed)

## Engine Changes Required (Found During Audit)

The `declarativeInstall()` engine in `libs/install-engine/src/install.ts` currently hard-codes Claude-format MCP config auto-derivation at lines 1552–1574:

```ts
// Hardcoded claude format — line 1554
resolvedKeyPath = `mcpServers.${descriptor.ext}`;

// Hardcoded claude format — line 1573
resolvedValue = { type: 'stdio', command: cliBin, args: ['serve', descriptor.ext] };
```

For opencode, the equivalent is:

```ts
// opencode format
keyPath = `mcp.${descriptor.ext}`;
value = { type: 'local', command: [cliBin, 'serve', descriptor.ext] };
```

The `[dod.2]` denial check (line 1461) blocks stdio MCP placement into `.mcp.json` — is safe for opencode because opencode MCP config lives in `opencode.json` (different filename, check won't fire).

### Approach: Optional `mcpConfig` on Surface

Extend the `Surface` type in `libs/host-registry/src/internal.ts` with an optional `mcpConfig` builder:

```ts
interface Surface {
  capability: CapabilityId;
  format?: 'json' | 'toml';
  paths: Partial<Record<HostScope, string>>;
  mcpConfig?: {
    keyPath: (extId: string) => string;
    value: (profile: string, cliBin: string, extId: string) => unknown;
  };
}
```

The opencode host module defines it; `declarativeInstall()` checks `surface.mcpConfig` before falling back to the default claude format. All host-specific logic stays in the host module — zero engine coupling to opencode.

### Files changed in engine (+host module)

| File | Change | Lines |
|---|---|---|
| `libs/host-registry/src/internal.ts` | Add `mcpConfig?` to `Surface` | +4 |
| `libs/install-engine/src/install.ts` | Check `surface.mcpConfig` before hardcoded defaults | +10 |
| `libs/host-registry/src/opencode.ts` | New ~150-line host module with `mcpConfig` | +150 |
| `libs/host-registry/src/opencode.spec.ts` | Test detect, paths, surfaces, MCP format | +80 |
| `libs/host-registry/src/index.ts` | Register `opencode` | +2 |
| `libs/manifest/src/index.ts` | Add `"opencode"` to hosts enum (3 places) | +3 |

Total engine changes: **~17 lines** (internal.ts + install.ts). Everything else is the host module itself.

## Implementation Plan

### Wave 0: Engine + host module

| Step | File | Description |
|---|---|---|
| 0.1 | `libs/host-registry/src/internal.ts` | Add optional `mcpConfig` to `Surface` type |
| 0.2 | `libs/host-registry/src/opencode.ts` | New host module: `detect()`, `scopePaths()`, `surfaces{}` with `mcpConfig` |
| 0.3 | `libs/host-registry/src/index.ts` | Register `opencode` in `REGISTERED_HOSTS` |
| 0.4 | `libs/manifest/src/index.ts` | Add `"opencode"` to hosts union type, `knownHosts` Set, JSON schema enum |
| 0.5 | `libs/install-engine/src/install.ts` | Check `surface.mcpConfig` before default MCP format (guard with `if (surface.mcpConfig)` above the auto-derivation block) |
| 0.6 | `libs/host-registry/src/opencode.spec.ts` | Test detect, scope paths, surfaces, MCP format translation, `mcpConfig` builder output |

### Wave 1: Manifest host updates

| Step | File | Description |
|---|---|---|
| 1.1 | `extensions/agents/org-agent/extension.json` | `hosts: ["claude", "opencode"]` |
| 1.2 | `extensions/agents/test-agent/extension.json` | `"opencode"` added |
| 1.3 | `extensions/skills/sox-ingest/extension.json` | `"opencode"` added |
| 1.4 | `extensions/skills/demo-creator/extension.json` | `"opencode"` added |
| 1.5 | `extensions/skills/dep-injector/extension.json` | `"opencode"` added |
| 1.6 | `extensions/skills/di-codex-skill/extension.json` | `"opencode"` added |
| 1.7 | `extensions/commands/di-command/extension.json` | `"opencode"` added |
| 1.8 | `extensions/bundles/sox-memory-bundle/members/memory-usage/extension.json` | `"opencode"` added |

### Wave 2: Skill + agent file-drop

| Step | Description |
|---|---|
| 2.1 | Build all 8 extensions |
| 2.2 | `soxe install <skill-id> --host=opencode --scope=project` for each skill | Verify SKILL.md lands in `.opencode/skills/{id}/` |
| 2.3 | `soxe install memory-org --host=opencode --scope=project` | Verify agent lands in `.opencode/agents/org-agent.md` |
| 2.4 | `soxe install <skill-id> --host=opencode --scope=user` for each skill | Verify `~/.config/opencode/skills/{id}/` populated |

### Wave 3: MCP server integration

| Step | Description |
|---|---|
| 3.1 | Update `memory-server` manifest | Add `"sse"` to `install.serves`: `["stdio", "sse"]`, add `sse` profile with `transport: "sse"` |
| 3.2 | Update `tokenguard` manifest | Add `install: { type: "service", serves: ["http"], profiles: { http: { transport: "http" } } }` (already declared, verify) |
| 3.3 | `soxe install memory-server --host=opencode --profile=stdio --scope=project` | Verify `opencode.json` gets `mcp.memory-server: { type: "local", command: ["soxe", "serve", "memory-server"] }` |
| 3.4 | `soxe install memory-server --host=opencode --profile=sse --scope=user` | Verify `~/.config/opencode/opencode.json` gets `mcp.memory-server: { type: "remote", url: "http://localhost:3099/mcp" }` |
| 3.5 | Verify opencode picks up the MCP server (local profile) | Start opencode, confirm `memory-server` appears in MCP tool list |
| 3.6 | Post-install lifecycle pairing test | Install with `--profile=sse`, verify the CLI output guides: "memory-server has lifecycle.background. Run `soxe service enable memory-server` to keep it running across sessions" |

### Wave 4: Service pairing — `soxe service enable` + opencode

| Step | Description |
|---|---|
| 4.1 | `soxe config set memory-server port 3099 --scope=user` | Set the HTTP port via config cascade |
| 4.2 | `soxe service enable memory-server --scope=user` | Generate + load OS unit (launchd plist/systemd) with config env baked in; verify on `soxe service status` |
| 4.3 | `soxe install memory-server --host=opencode --profile=sse --scope=user` | Should detect that the service is already enabled, note the running port, write matching remote URL |
| 4.4 | opencode connects to running service | `memory_ping` succeeds — confirms remote MCP path works end-to-end |
| 4.5 | `soxe service disable memory-server` | Verify OS unit unloaded, survivor process reaped; opencode entry in `opencode.json` unaffected |
| 4.6 | Re-install after disable | `soxe install memory-server --host=opencode --profile=sse --scope=user` should warn: "service not running — run `soxe service enable memory-server` to start it" |
| 4.7 | Config change triggers restart | `soxe config set memory-server port 3098 --scope=user` while daemon is running on port 3099 → verify daemon restarted on 3098, `soxe service status` shows new port live |
| 4.8 | Install upgrade triggers restart | `soxe install memory-server --host=opencode --profile=sse --scope=user` (after code change) → verify daemon restarted with new entrypoint checksum, old process reaped |
| 4.9 | `--no-restart` opt-out | `soxe config set memory-server port 3099 --scope=user --no-restart` → config written, daemon unchanged, logged: "config saved, no restart (--no-restart)" |
| 4.10 | Entrypoint unchanged skip | Upgrade that only changes opencode host config → daemon NOT restarted (entrypoint checksum unchanged), logged: "entrypoint unchanged — no restart needed" |

### Wave 5: Cross-host + uninstall

| Step | Description |
|---|---|
| 5.1 | `soxe install memory-org --host=claude --host=opencode --scope=project` | Verify agent appears in BOTH `.claude/agents/` AND `.opencode/agents/` |
| 5.2 | Uninstall via `soxe uninstall memory-org --host=opencode --scope=project` | Verify opencode entry removed, claude entry survives |
| 5.3 | Full uninstall round-trip for mcp-server | Verify ledger reversal removes `opencode.json` MCP key cleanly; `soxe service disable` must be run separately for daemon cleanup |

### Wave 6: Docs + routing

| Step | Description |
|---|---|
| 6.1 | Update `ROUTER.md` | Add opencode host routing entry |
| 6.2 | Update `AGENTS.md` | Add opencode install notes |
| 6.3 | Add `.mcp.json` → `opencode.json` migration guide at `docs/plan/opencode-host/MIGRATION.md` | For users migrating from claude to opencode |

## Recommended Improvements (Concurrent Work)

### A. Upgrade mcp-runtime SSE transport (deprecation cleanup)

The `@modelcontextprotocol/sdk` marks `SSEServerTransport` as deprecated. Replace it with `StreamableHTTPServerTransport` which handles both SSE streaming AND direct HTTP POST responses with session management. This gives us `soxe serve --transport=http` for free since the codegen is the same transport.

| File | Change | Lines |
|---|---|---|
| `libs/mcp-runtime/src/transport.ts` | Replace `SSEServerTransport` w/ `StreamableHTTPServerTransport`; rename `connectSse` → `connectStreamableHttp`; add `'http'` to `TransportMode` | ~40 repl/refactor |
| `libs/mcp-runtime/src/serve.ts` | Use new transport name; add `'http'` branch (same impl, different CLI flag) | ~5 |
| `libs/mcp-runtime/src/index.ts` | Update `serves` to `['stdio', 'sse', 'http']` | +1 |
| `libs/mcp-runtime/src/conformance.spec.ts` | Add HTTP conformance path | +20 |

**No new dependencies.** `StreamableHTTPServerTransport` and `@hono/node-server` are transitive deps of the SDK.

**Why this matters for opencode:** The remote MCP profile (`type: "remote", url: "http://localhost:3099/mcp"`) requires a running HTTP server. After this upgrade, `soxe serve --transport=http` produces exactly that.

### B. Extend install engine to detect service-running state

When `declarativeInstall()` processes an mcp-server with a remote profile (sse/http), it should check if the extension has `lifecycle.background` and, if so, detect whether the service is currently running (via socket probe or OS unit status). The install output should:

- **Service running** → "memory-server detected running on port 3099. Wrote remote MCP config."
- **Service not running** → "memory-server requires a running service. Run: `soxe service enable memory-server`"
- **No lifecycle.background** → No message (opencode spawns it per-session)

| File | Change | Lines |
|---|---|---|
| `libs/install-engine/src/install.ts` | After writing `config-merge`, probe service state if profile is sse/http | +20 |
| `libs/host-registry/src/internal.ts` | Add optional `postInstallHint?: string` to surface for host-specific guidance | +1 |

### C. Add `install.serves: ["sse"]` to memory-server manifest

Currently `memory-server` declares only `serves: ["stdio"]`. Adding `"sse"` enables the remote profile. The mcp-runtime's `serve()` already supports `--transport=sse` (and `--transport=http` after improvement A):

```jsonc
// memory-server extension.json, install block
"install": {
  "type": "mcp-server",
  "serves": ["stdio", "sse"],
  "profiles": {
    "stdio": { "transport": "stdio" },
    "sse":    { "transport": "sse" }
  }
}
```

### D. Doctor command for cross-host config drift

The `config_schema` / `x-sox-prompt` system captures install-time config but has no runtime validation across hosts. A `soxe config doctor [ext]` command that reads an extension's `config_schema`, compares against cascade-resolved config, and flags:

- Missing required keys
- Values outside schema range (port out of range, non-absolute path)
- Inconsistencies between hosts (different port in claude config vs opencode config)

This is separable from the host work — uses existing ledger + config cascade — and is useful regardless of which hosts are installed.

### E. Auto-restart daemons on config change and install/upgrade

Currently `soxe config set` writes config but the running OS unit keeps stale env vars until a manual `soxe service disable` + `soxe service enable`. `soxe install` with a new artifact leaves the running daemon on old code. This improvement adds ownership-index-aware restart logic to both `cmdConfigSet` and `declarativeInstall()`.

| File | Change | Lines |
|---|---|---|
| `apps/sox/src/main.ts` `cmdConfigSet()` | After writing config, query ownership index for running OS units. If running, call content-addressed `enableOsUnit()` then reload via `launchctl bootout`+`bootstrap`. Emit restart reason. | +40 |
| `libs/install-engine/src/install.ts` `declarativeInstall()` | After placing files, query ownership index for running OS units. If running AND entrypoint checksum changed, reload unit. | +30 |
| `libs/host-runtime/src/os-unit.ts` | Add `restartOsUnit()` — unload+reload with liveness verification and restart-loop guard (3 crashes in 60s → revert to last-known-good spec from ownership index). | +50 |
| `apps/sox/src/main.ts` | Add `--no-restart` flag to `cmdConfigSet` and `cmdInstall`. Add `--dry-run` to `cmdConfigSet` to preview restarts. | +15 |
| Test: config-change restart | Set port, verify daemon restarted on new port within health interval. | +15 |
| Test: install-upgrade restart | Upgrade extension, verify daemon restarted with new checksum, old daemon reaped. | +15 |
| Test: `--no-restart` opt-out | Config change with `--no-restart` → config written, daemon unchanged. | +10 |
| Test: restart loop guard | Broken config → <3 crashes in 60s → revert to last-known-good, survivor process runs on old config. | +15 |
| Test: entrypoint unchanged skip | Upgrade that only changes host config → daemon NOT restarted (entrypoint checksum same). | +10 |

**Why this matters for opencode:** After `soxe install memory-server --host=opencode --profile=sse --scope=user` upgrades the server, opencode's remote MCP URL should immediately connect to the NEW code, not the stale running daemon. Without auto-restart, the user must manually cycle the service — which they'll forget every time.

## Service Pairing Design

### Two operating modes for MCP servers in opencode

| Mode | Profile | opencode config | Server lifecycle | User command |
|---|---|---|---|---|
| **Per-session** (default) | `stdio` | `{ type: "local", command: ["soxe", "serve", "memory-server"] }` | opencode spawns → proxy shim auto-manages backend via `ensureBackend()` → dies when opencode exits | `soxe install` only (no service management needed) |
| **Persistent daemon** | `sse` / `http` | `{ type: "remote", url: "http://localhost:3099/mcp" }` | `soxe service enable memory-server` → launchd/systemd keeps it alive across sessions/reboots | `soxe install` + `soxe service enable` |

### Per-session flow (stdio)

```
opencode starts session
  → spawns ["soxe", "serve", "memory-server"]
    → proxy front-shim over stdio (serves initialize, tools/list from cache)
    → ensureBackend() — singleton-guarded detached backend on UDS
    → proxies tools/call to backend over UDS
  → opencode exits
    → shim pipe closes
    → backend survives (detached, unref'd)
    → next opencode session reuses same backend
```

Service commands: **none needed**. The proxy auto-manages the backend.

### Persistent daemon flow (http)

```
soxe config set memory-server port 3099
soxe service enable memory-server
  → generates LaunchAgent plist / systemd unit
  → loads it → HTTP server starts on port 3099
  → KeepAlive + ThrottleInterval → auto-restart on crash

soxe install memory-server --host=opencode --profile=sse --scope=user
  → writes: { mcp: { memory-server: { type: "remote", url: "http://localhost:3099/mcp" } } }
  → post-install: detects port 3099 live → "service running — wrote remote MCP config"

opencode connects → HTTP POST to /mcp → tools/call works

soxe service disable memory-server
  → unloads unit → kills process → opencode entry in opencode.json unchanged
  → user must run `soxe install` again to switch to stdio profile, or re-enable the service

soxe service status memory-server
  → shows: file exists? loaded? live pid? owner scope?
```

### What `soxe install` does NOT do

- Does NOT auto-start services — `lifecycle.background` is consumed by the soxe host runtime/OS supervisor, not by the install engine
- Does NOT inspect `lifecycle.background` to prompt for `soxe service enable` (improvement B adds this)
- Does NOT generate OS units — that's `soxe service enable`
- Does NOT reconcile config between hosts — if you install to both claude AND opencode with different ports, that's a config drift the doctor command (improvement D) would catch

### Config consistency guarantee

Both `soxe serve` (per-session) and `soxe service enable` (persistent daemon) read the same config cascade via `buildExtConfigEnv()`. A `soxe config set memory-server port 3099 --scope=user` is picked up identically by both paths. The content-addressed OS unit is only regenerated when config changes — no manual re-enable needed (unless the unit isn't loaded yet).

### Auto-restart on config change

When `soxe config set` changes a value that affects a running daemon, the OS unit is regenerated and the daemon is restarted so the change takes effect immediately. This avoids the footgun of a config change silently not applying until the next reboot or manual restart.

```
soxe config set memory-server port 3099 --scope=user
  → cascade resolver: writes `config.memory-server.port = 3099` to extensions.json
  → queries ownership index: is memory-server running as an OS unit?
  → if YES:
      → regenerate unit plist with new EnvironmentVariables (content-addressed, idempotent if already current)
      → unload old unit + verified-stop survivor ([inv:unload-then-reap])
      → load new unit → daemon restarts on port 3099
      → logged: "memory-server restarted — config change (port: 3098 → 3099)"
  → if NO:
      → config written, no restart triggered
      → logged: "memory-server not running — config saved, will apply on next enable"

soxe config set memory-daemon db_path /new/path/memory.db --scope=user
  → same flow: ownership index check → restart if running → idempotent unit regen
```

**Opt-out:** `--no-restart` flag skips the reload but still writes config. `--dry-run` shows what WOULD be restarted without touching anything.

### Auto-restart on install/upgrade

When `soxe install` or `soxe upgrade` replaces an extension's files that are backing a running daemon, the daemon is restarted so it picks up the new code. The content-addressed OS unit handles the restart idempotently — if the entrypoint checksum didn't change (e.g., only host config was written), no restart occurs.

```
soxe install memory-server --host=opencode --profile=sse --scope=user
  → fetches new artifact, checksum-verifies, places files
  → writes opencode MCP config
  → queries ownership index: is memory-server running as an OS unit?
  → if YES AND entrypoint checksum changed:
      → unload + reload unit ([inv:unload-then-reap] to prevent double-spawn)
      → logged: "memory-server restarted — upgrade (c8f70c0 → d4e2a1f)"
  → if YES AND entrypoint unchanged:
      → logged: "memory-server running, entrypoint unchanged — no restart needed"
  → if NO:
      → logged: "memory-server not running — install complete. Run `soxe service enable memory-server` to start"

soxe uninstall memory-server --host=opencode --scope=user
  → removes opencode MCP config (ledger reversal)
  → queries ownership index: is memory-server running as an OS unit?
  → if YES:
      → logged: "memory-server daemon still running (OS unit not removed). Run `soxe service disable memory-server` to stop it"
  → does NOT auto-stop the daemon — uninstall only reverses install-time placements, not OS-supervisor state
```

**Bundle upgrades** (e.g., `sox-memory-bundle`): expansion walks all members, applies restart flow to each member individually. If 3 of 5 members are running, only those 3 are restarted. Members with unchanged entrypoints are skipped.

### Sanity gate: restart loop prevention

A **consecutive-restart guard** prevents the supervisor from restart-flapping if a config change produces a broken unit that crashes on boot:

1. After reload, the supervisor monitors the unit for `lifetime.health.interval_ms` (default 30s).
2. If the unit crashes within the interval and `lifecycle.singleton: true` triggers a supervisor respawn, the supervisor records the crash.
3. If crashes exceed 3 within 60 seconds, the unit is reverted to the last-known-good spec (content-addressed, previous hash stored in ownership index).
4. User is notified: "memory-server crashed 3 times after config change — reverted to last-known-good. Edit config and try again."

### Extensions that do NOT need service management

| Extension | Why |
|---|---|
| Agents (`memory-org`, `test-runner`) | Declarative — no runtime process. opencode loads the SKILL.md/markdown directly. |
| Skills (all 5) | Same — `file-drop` to `.opencode/skills/`. No process. |
| Commands (`dep-inject`, `memory-cli`) | opencode invokes on-demand — no daemon lifecycle. |
| `memory-flush` (hook) | Event-driven via opencode plugin system. Future concern. |

Only `mcp-server` and `service` types with transports beyond stdio need `soxe service` pairing.

## Per-Extension Install Verification Matrix

| ID | Type | Scope=project | Scope=user | Template applied |
|---|---|---|---|---|
| `memory-org` | agent | `.opencode/agents/org-agent.md` | `~/.config/opencode/agents/org-agent.md` | YAML frontmatter + prompt |
| `test-runner` | agent | `.opencode/agents/test-agent.md` | `~/.config/opencode/agents/test-agent.md` | YAML frontmatter + prompt |
| `sox-ingest` | skill | `.opencode/skills/sox-ingest/SKILL.md` | `~/.config/opencode/skills/sox-ingest/SKILL.md` | Raw SKILL.md |
| `forbidden-access` | skill | `.opencode/skills/forbidden-access/SKILL.md` | `~/.config/opencode/skills/forbidden-access/SKILL.md` | Raw SKILL.md |
| `demo-creator` | skill | `.opencode/skills/demo-creator/SKILL.md` | `~/.config/opencode/skills/demo-creator/SKILL.md` | Raw SKILL.md |
| `dep-injector` | skill | `.opencode/skills/dep-injector/SKILL.md` | `~/.config/opencode/skills/dep-injector/SKILL.md` | Raw SKILL.md |
| `di-codex` | skill | `.opencode/skills/di-codex/SKILL.md` | `~/.config/opencode/skills/di-codex/SKILL.md` | Raw SKILL.md |
| `dep-inject` | command | `opencode.json` `command.dep-inject` | `~/.config/opencode/opencode.json` `command.dep-inject` | `{ description, invoke }` |
| `memory-usage` | skill | `.opencode/skills/memory-usage/SKILL.md` | `~/.config/opencode/skills/memory-usage/SKILL.md` | Raw SKILL.md |
| `memory-server` | mcp-server | `opencode.json` `mcp.memory-server` | `~/.config/opencode/opencode.json` `mcp.memory-server` | `{ type: "local", command: [...] }` via `mcpConfig` |
| `memory-cli` | command | `opencode.json` `command.memory-cli` | `~/.config/opencode/opencode.json` `command.memory-cli` | `{ description, invoke }` |

## What This Does NOT Cover

- **Service daemon lifecycle** (`tokenguard`, `memory-daemon`) — these require the sox `ProcessSupervisor` or OS supervisor. opencode has no equivalent. Users run `soxe service enable <ext>` separately for daemons. The install engine will not auto-start daemons but will detect their state and guide the user.
- **Plugin npm packaging** — opencode plugins are TypeScript modules. soxe hooks would need to be repackaged as npm packages with `@opencode-ai/plugin` types. This is a future concern for hook-type extensions.
- **OAuth / DCRM MCP servers** — opencode supports Dynamic Client Registration (RFC 7591) for remote MCP. soxe currently only supports stdio/socket/http without OAuth. Remote MCP w/ OAuth is out of scope but the raw HTTP transport (improvement A) lays the foundation.
- **`config_schema` interactive prompts** — opencode has no interactive install wizard. soxe config values are set via `soxe config set` or written directly to the config-merge value. The doctor command (improvement D) would surface missing config.
- **Agent mode/permissions** — opencode agents have `mode: "subagent"`, model, permission, etc. The soxe manifest doesn't declare these; defaults would be hardcoded (`mode: "subagent"`, `permission: { edit: "deny" }` for declarative agents).
- **Auto-port discovery / allocation** — when installing with `--profile=sse`, the port is hardcoded or comes from config. There's no automatic free-port allocation. The user configures the port and both `soxe service enable` and the opencode MCP entry reference the same value.

## Effort

| Workstream | Effort |
|---|---|
| Host module + engine changes (Wave 0) | ~4h |
| Manifest updates + smoke tests (Waves 1-3) | ~3h |
| Service pairing tests (Wave 4) | ~3h |
| Cross-host + uninstall (Wave 5) | ~2h |
| Docs + migration guide (Wave 6) | ~2h |
| Improvement A: HTTP transport upgrade | ~2h |
| Improvement B: service-running detection | ~1h |
| Improvement C: manifest serves update | 5 min |
| Improvement D: doctor command (deferrable) | ~3h |
| Improvement E: auto-restart on config/upgrade | ~4h |
| **Total (all waves + all improvements)** | **~24h (~3 days)** |
| **Core waves only (0-6)** | **~14h (~2 days)** |
