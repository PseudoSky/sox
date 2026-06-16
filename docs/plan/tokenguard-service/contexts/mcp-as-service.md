# mcp-as-service — MCP_AS_SERVICE

> **Slug is identity.** Immutable.

**Phase:** framework · **Depends on:** http-transport · **Guard:** `python3 docs/plan/tokenguard-service/scripts/guard_mcp_as_service.py`

---

## Goal

After this state, `mcp-server` is **folded onto the unified service model as `service[transport=stdio]`** — its install/run flows through the same `run-service`/supervisor path the http transport uses, so the framework has one supervised-service model with `transport` as the only difference. Crucially, `mcp-server` **stays a valid type name** (back-compat alias) and `memory-server` **non-regresses**: build/validate/install/start/health/stop **and** the C6 forbidden-write denial all hold. This is the production-quality unification the requester asked for, and the highest-risk state — `memory-server` is load-bearing for C6/A11.

---

## Semantic Distillation

- **Primitive:** MODIFY `libs/install-engine/src/install.ts` + `libs/manifest/src/index.ts` — route `mcp-server` through the unified service model as `transport: stdio`.
- **Reference Pattern:** the just-built unified routing in [http-transport]; the existing stdio `profile: 'service'` materialize path; the `mcp-server` template (`libs/authoring/src/templates/mcp-server/index.ts`); `memory-server`'s manifest + C6 guard (`extensions/mcp-servers/memory-server/`). See **[ref:run-service-spec]**, **[ref:c6-policy-guard]**.
- **Delta Spec:**
  - In `validate()`/manifest: treat `type:mcp-server` as equivalent to `type:service` with `transports:['stdio']` for routing purposes; `mcp-server` remains accepted and its `serves` semantics preserved. No change to existing extension manifests is required.
  - In `install.ts`: route the `mcp-server` install through the unified `run-service` registration path (the stdio branch of the model) instead of a parallel branch — preserving the registry entry shape **[ref:run-service-spec]** and **[inv:single-registry]**.
  - In `mcpServerTemplate`: emit `transports:['stdio']` alongside `serves:['stdio']` so newly-scaffolded mcp-servers are born on the unified model. Keep the rest of the fileset identical.
  - Update `docs/guidelines/mcp-server.md` to state that `mcp-server` is `service[transport=stdio]` and cross-link `docs/guidelines/service.md`.
  - Add `tools/tg-plan/check-memory-nonregress.sh` — installs+starts `memory-server` via `./bin/sox`, pings it (`MEMORY OK`), attempts an out-of-policy write and asserts denial + absent side-effect (`C6 DENY OK`), then stops it.
- **Invariants:** **[inv:no-regress-mcp]** (the whole point), **[inv:single-registry]**, **[inv:standard-config]**, **[ref:c6-policy-guard]**.
- **Validation:** the guard proves memory-server's full lifecycle + C6 denial after the refactor.

---

## Acceptance criteria

- [ ] **[mcp-as-service.1]** `mcp-server` remains a valid type and is documented/handled as `service[transport=stdio]`. `grep -n "stdio" libs/manifest/src/index.ts`
- [ ] **[mcp-as-service.2]** mcp-server install routes through the unified `run-service` path (no parallel registration branch remains). `grep -n "run-service\|runServiceApply" libs/install-engine/src/install.ts`
- [ ] **[mcp-as-service.3]** `mcpServerTemplate` emits `transports` for stdio. `grep -n "transports" libs/authoring/src/templates/mcp-server/index.ts`
- [ ] **[mcp-as-service.4]** `docs/guidelines/mcp-server.md` states the `service[transport=stdio]` relationship. `grep -n "service" docs/guidelines/mcp-server.md`
- [ ] **[mcp-as-service.5]** `tools/tg-plan/check-memory-nonregress.sh` exercises memory-server lifecycle + the C6 denial. `grep -n "C6 DENY OK" tools/tg-plan/check-memory-nonregress.sh`

---

## Reservations

```text
read_only:  ["extensions/mcp-servers/memory-server/extension.json",
             "extensions/mcp-servers/memory-server/src/index.ts",
             "libs/host-runtime/src/supervisor.ts"]
mutates:    ["libs/manifest/src/index.ts",
             "libs/install-engine/src/install.ts",
             "libs/authoring/src/templates/mcp-server/index.ts",
             "docs/guidelines/mcp-server.md",
             "tools/tg-plan/check-memory-nonregress.sh"]
```

---

## Contract Promise

- **Added:** `tools/tg-plan/check-memory-nonregress.sh`; the `service[transport=stdio]` equivalence in the manifest/routing.
- **Modified:** `install.ts` mcp-server routing → unified `run-service`; `mcpServerTemplate` → emits `transports`; `docs/guidelines/mcp-server.md`.
- **Deleted:** any parallel/duplicate stdio registration branch in `install.ts` (folded into the unified path) — confirm no caller of a removed branch remains.

---

## Commit points

- [ ] **After memory-server passes its full lifecycle + C6 under the unified routing** — `feat(tokenguard-service): mcp-as-service — fold mcp-server onto service[stdio], memory-server non-regressed`
- [ ] **After the guard passes** (mandatory) — `feat(tokenguard-service): mcp-as-service complete — guard green`

---

## Notes for executor

- **Do not touch `memory-server`'s extension.json or src.** The refactor lives behind the type, in the framework. If memory-server needs an extension change to keep working, the unification is wrong — stop and rethink.
- This is the state most likely to silently regress C6. Run the existing `audit_c6.py --phase final` plus the new non-regress harness; both must stay green.
- Because `service-type` and `http-transport` already touched `libs/manifest/src/index.ts` and `install.ts`, re-read them before editing — your changes layer on theirs (sequential, same track; no merge protocol).
