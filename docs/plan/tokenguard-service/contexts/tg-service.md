# tg-service — TOKENGUARD_SERVICE

> **Slug is identity.** Immutable.

**Phase:** service · **Depends on:** audit-framework, audit-core · **Guard:** `python3 docs/plan/tokenguard-service/scripts/guard_tg_service.py`

---

## Goal

After this state, `tokenguard` exists as a born-conformant **`service`-type extension** (transport `http`) that runs the generalized pseudonymizing proxy on top of `@sox/tokenguard-core`, is **provider-agnostic** via a pluggable adapter (default-provider + generic passthrough), is configured **only** through the standardized config system, enforces its declared permissions at the resource sink, and keeps a **live, continuously-persisted** token map. This is the convergence point — it needs both the framework primitive (`service`+`http`) and the engine (`tokenguard-core`).

---

## Semantic Distillation

- **Primitive:** CREATE `extensions/services/tokenguard/*` — the proxy service.
- **Reference Pattern:** `scripts/tokenguard/proxy.py` (Config resolution, the HTTP handler, capture/audit, port walk + `port.txt`, `Accept-Encoding: identity`, leak self-check); `extensions/mcp-servers/memory-server/` for the born-conformant extension shape, the `config_schema` system (**[ref:config-schema]**), and the C6 guard (**[ref:c6-policy-guard]**).
- **Delta Spec:**
  - Born-conformant fileset via `sox init service tokenguard` then filled in: `extension.json` (`type:service`, `transports:['http']`, `[shape:http-health]` lifecycle, `config_schema`, `permissions` for the capture dir + upstream host), `package.json` (`@sox/extension-tokenguard`, dep `@sox/tokenguard-core` — **[ref:c7-no-reach-in]**), `project.json` (build/test/bundle targets like memory-server), `tsconfig.json`.
  - `src/config.ts` — resolve config from `SOX_CONFIG_*` only (**[ref:config-schema]**, **[inv:standard-config]**): port, upstream, capture-policy (**[def:capture-policy]**), provider, seeds, never-list, detector toggles, map path.
  - `src/proxy.ts` — the port-holding HTTP server: walk port..+9, write the actual bound port to **`storePath/port.txt`** (the path the supervisor's `http-get` probe reads — **not** the capture dir) **only after the server is listening**, expose `/_tokenguard/health` (for `http-get`), tokenize outbound request-scoped regions via the engine, force `Accept-Encoding: identity`, capture/audit per policy, leak self-check + audit event, detokenize inbound via the adapter. SIGTERM closes the server cleanly (**[ref:supervisor-stop]**).
  - `project.json` includes a `bundle` target (esbuild, mirroring memory-server) so the service materializes self-contained at install time even where workspace `node_modules` is absent; `@sox/tokenguard-core` is inlined, native/optional deps marked external.
  - `src/adapters/anthropic.ts` + `src/adapters/generic.ts` implementing **[shape:provider-adapter]** — anthropic: request scoping + SSE reassembly + thinking passthrough; generic: plain JSON passthrough + whole-body reversal.
  - `src/index.ts` — the service entrypoint: read config, enforce permissions at the sink (**[ref:c6-policy-guard]**), build the Mapper from seeds + map file, start the proxy, persist the map continuously.
  - `demo/proxy-roundtrip.sh` — starts tokenguard via `./bin/sox`, points a client at it with a seeded real + **[fix:mock-upstream]**, sends a request, and asserts the upstream saw only placeholders (`LEAKS 0`) and the client got the real value back exactly (`ROUNDTRIP OK`). Also writes the four founder-facing artifacts (prompt, outbound diff, raw reply, inbound diff) under `demo/out/`.
- **Invariants:** **[inv:wire-guarantee]**, **[inv:bijective-roundtrip]**, **[inv:standard-config]**, **[inv:c7-no-reach-in]**, **[ref:c6-policy-guard]**, **[ref:host-keyed-target]**.
- **Validation:** the guard installs+starts the service, health-checks it over http, runs the round-trip, and stops it clean.

---

## Acceptance criteria

- [ ] **[tg-service.1]** the extension is `type:service` transport http and born-conformant. `grep -n "\"service\"\|http" extensions/services/tokenguard/extension.json`
- [ ] **[tg-service.2]** the service consumes the engine via the package scope (no reach-in). `grep -n "@sox/tokenguard-core" extensions/services/tokenguard/package.json`
- [ ] **[tg-service.3]** config flows only through `SOX_CONFIG_*` (no bespoke reader). `grep -n "SOX_CONFIG_" extensions/services/tokenguard/src/config.ts`
- [ ] **[tg-service.4]** both provider adapters exist and implement the adapter seam. `test -f extensions/services/tokenguard/src/adapters/anthropic.ts && test -f extensions/services/tokenguard/src/adapters/generic.ts`
- [ ] **[tg-service.5]** permissions are enforced at the resource sink before the side effect. `grep -n "SOX_POLICY_\|policy" extensions/services/tokenguard/src/index.ts`
- [ ] **[tg-service.6]** the demo harness asserts the round-trip + zero leaks. `grep -n "ROUNDTRIP OK\|LEAKS 0" extensions/services/tokenguard/demo/proxy-roundtrip.sh`
- [ ] **[tg-service.7]** `project.json` has a `bundle` target (self-contained materialization). `grep -n "bundle" extensions/services/tokenguard/project.json`
- [ ] **[tg-service.8]** the proxy writes the actual bound port to `storePath/port.txt` after listening. `grep -n "port.txt\|storePath\|listen" extensions/services/tokenguard/src/proxy.ts`

---

## Reservations

```text
read_only:  ["libs/tokenguard-core/src/index.ts",
             "extensions/mcp-servers/memory-server/extension.json",
             "extensions/mcp-servers/memory-server/src/index.ts",
             "scripts/tokenguard/proxy.py"]
mutates:    ["extensions/services/tokenguard/extension.json",
             "extensions/services/tokenguard/package.json",
             "extensions/services/tokenguard/project.json",
             "extensions/services/tokenguard/tsconfig.json",
             "extensions/services/tokenguard/src/index.ts",
             "extensions/services/tokenguard/src/proxy.ts",
             "extensions/services/tokenguard/src/config.ts",
             "extensions/services/tokenguard/src/adapters/anthropic.ts",
             "extensions/services/tokenguard/src/adapters/generic.ts",
             "extensions/services/tokenguard/demo/proxy-roundtrip.sh",
             "extensions/services/tokenguard/vitest.config.ts",
             "extensions/services/tokenguard/test/smoke.spec.ts"]
```

---

## Contract Promise

- **Added:** the `tokenguard` service extension + its proxy, config, adapters, and demo harness.
- **Modified:** none outside the extension dir.
- **Deleted:** none.

---

## Commit points

- [ ] **After the service builds + validates** — `feat(tokenguard-service): tg-service — generalized pseudonymizing proxy as a service extension`
- [ ] **After the guard passes** (mandatory) — `feat(tokenguard-service): tg-service complete — install/start/health/round-trip green`

---

## Notes for executor

- The proxy must enforce permissions **before** opening the capture dir or the upstream socket (the C6 contract) — reading `SOX_POLICY_*` exactly like memory-server's vendored guard. An undeclared capture path must be denied with no file created.
- `port.txt` must be written only after the server is actually listening, to avoid the race the supervisor's `http-get` probe would otherwise hit.
- Keep the engine pure: all `process.env`/`fs`/`net` lives in the service layer, never in `@sox/tokenguard-core`.
- The demo harness is the founder-facing acceptance surface — its four artifacts (prompt, outbound diff, raw reply, inbound diff) are reused by `audit-final`/`[dod.9]`. Make them real files under `demo/out/`.
