# mcp-install-modes — MCP INSTALL MODES

> **Slug is identity.** This filename and the `mcp-install-modes` slug are immutable once assigned.

**Phase:** install · **Depends on:** bundle-pipeline, cli-wiring · **Guard:** `bash .workflow/plans/extension-install-model/scripts/guards/mcp-install-modes.sh`

---

## Goal

After this state, `sox install <mcp-id> --profile <sse|stdio|service>` installs an mcp-server in the correct mode: `sse`/`http` → config-merge into `.mcp.json`; `stdio` → merge into `.claude.json`; `service` → materialize the bundle into `[def:store-dir]` + write a supervisor service record. The `run-service` path is wired into the install dispatch (v1 never called it). This satisfies `[dod.4]`.

---

## Semantic Distillation

- **Primitive:** MODIFY `libs/install-engine/src/install.ts` — add mcp-server profile dispatch (rebasing onto declarative-install's output). CREATE/MODIFY `libs/install-engine/src/capabilities/config-merge.ts` and `libs/install-engine/src/capabilities/run-service.ts`.

- **Reference Pattern:** `declarative-install` already landed `install.ts`; this state adds the mcp-server branch. `bundle-pipeline` (already done) provides the materialized bundle. `libs/host-registry` provides the config target paths per `[shape:host-target]`.

- **Delta Spec:**
  - `install.ts` (mcp branch): when `type === 'mcp-server'`, dispatch on `--profile`:
    - `sse` | `http` → `configMerge(targetPath('.mcp.json'), serverEntry)` (config-merge.ts)
    - `stdio`         → `configMerge(targetPath('.claude.json'), serverEntry)` (config-merge.ts)
    - `service`       → `runService(id, bundlePath, opts)` (run-service.ts)
  - `config-merge.ts` — `configMerge(configPath, key, entry)`: reads JSON, upserts the entry under `mcpServers[key]`, writes back. Creates file if absent.
  - `run-service.ts` — `runService(id, bundlePath, opts)`: copies the bundle + native deps into `[def:store-dir]`; writes a supervisor service record at `$SOX_HOME/.sox/registry.json` under `id`.
  - Service record shape: `{ id, version, storePath, command, args, scope, status: 'installed' }`.

- **Invariants:** `[inv:sandbox-isolation]` — all paths must resolve under `$SOX_HOME`. `[inv:tier3-proof]` — guard drives real CLI. Merge: lands AFTER `declarative-install`; `enforcement` lands after this state.

- **Validation:** `bash .workflow/plans/extension-install-model/scripts/guards/mcp-install-modes.sh` — runs each `--profile` mode; asserts `.mcp.json` has entry (sse), `.claude.json` has entry (stdio), store dir + registry entry exist (service).

---

## Acceptance criteria

Checked by audit-install (phase gate).

- [ ] **[mcp-install-modes.1]** `sox install <mcp> --profile sse` writes entry into `$SBX/.mcp.json`.
      Via guard: `bash .workflow/plans/extension-install-model/scripts/guards/mcp-install-modes.sh`
- [ ] **[mcp-install-modes.2]** `sox install <mcp> --profile stdio` writes entry into `$SBX/.claude.json`.
      Via guard.
- [ ] **[mcp-install-modes.3]** `sox install <mcp> --profile service` creates `[def:store-dir]` under `$SBX/.sox/ext/`.
      Via guard.
- [ ] **[mcp-install-modes.4]** `sox install <mcp> --profile service` writes a registry entry at `$SBX/.sox/registry.json`.
      Via guard.
- [ ] **[mcp-install-modes.5]** `run-service.ts` is called from `install.ts` for `--profile service` (not a no-op stub).
      `grep -n "runService\|run-service" libs/install-engine/src/install.ts | grep -q "runService" && echo OK`

---

## Reservations

```text
read_only:  ["libs/host-registry/src/claude.ts",
             "libs/host-registry/src/codex.ts",
             "bin/sox",
             "apps/sox/src/main.ts",
             "libs/install-engine/src/diff.ts",
             "libs/install-engine/src/lifecycle.ts"]
mutates:    ["libs/install-engine/src/install.ts",
             "libs/install-engine/src/capabilities/config-merge.ts",
             "libs/install-engine/src/capabilities/run-service.ts",
             "scripts/guards/mcp-install-modes.sh"]
```

**Merge protocol:** This state rebases onto `declarative-install`'s `install.ts`. `enforcement` rebases onto this state's `install.ts`.

---

## Contract Promise

- **Added:** `config-merge.ts` — `configMerge(path, key, entry)`; `run-service.ts` — `runService(id, bundlePath, opts)`
- **Modified:** `install.ts` — mcp-server profile dispatch wired (sse/stdio/service)

---

## Commit points

- [ ] **After config-merge** — commit `config-merge.ts` + `install.ts` (sse/stdio branch):
      `feat(eim): mcp-install-modes — sse/stdio config-merge profiles`
- [ ] **After run-service + service dispatch** — commit `run-service.ts` + `install.ts` (service branch):
      `feat(eim): mcp-install-modes — service profile materializes bundle + registry`
- [ ] **After the guard passes** (mandatory):
      `feat(eim): mcp-install-modes complete — guard green`

---

## Notes for executor

- The `--profile` flag must be accepted by the CLI (cli-wiring state). If it is not yet parsed, add it to `main.ts` as part of this state (this is safe since cli-wiring landed first and owns `main.ts`; a small rebase is expected).
- `.mcp.json` and `.claude.json` are scoped by `scopeRoot`; never hardcode `~/`.
- The service record in `registry.json` must use the same schema read by the supervisor (`host-runtime/src/supervisor.ts`) — verify the field names match before landing.
