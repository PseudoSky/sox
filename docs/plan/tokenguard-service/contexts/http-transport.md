# http-transport — HTTP_TRANSPORT

> **Slug is identity.** Immutable.

**Phase:** framework · **Depends on:** service-type · **Guard:** `python3 docs/plan/tokenguard-service/scripts/guard_http_transport.py`

---

## Goal

After this state a `service` with `transport: http` **installs, starts, holds a port, is health-probed over HTTP, and stops cleanly with zero orphans** — through the same `run-service`/supervisor machinery that today only serves the implicit stdio service profile. This is the genuinely missing primitive: an `http-get` health probe and http install routing. It exists between `service-type` (the type) and `mcp-as-service` (folding stdio in) because the unified routing built here is what `mcp-as-service` then reuses for stdio.

---

## Semantic Distillation

- **Primitive:** MODIFY `libs/host-runtime/src/supervisor.ts` + `libs/install-engine/src/install.ts` — add an http health probe and http install routing to the unified service model.
- **Reference Pattern:** the socket health probe `probeSocket` + `_probeHealth` (`libs/host-runtime/src/supervisor.ts`), the `profile: 'service'` materialize+register path (`libs/install-engine/src/install.ts` ~L1116-1175), the `run-service` capability (`libs/install-engine/src/capabilities/run-service.ts`), and the `mcp-server` surface in `libs/host-registry/src/claude.ts`. See **[ref:run-service-spec]**, **[ref:supervisor-stop]**.
- **Delta Spec:**
  - Supervisor: add `'http-get'` to `LifecycleHealth.type`; implement it in `_probeHealth` via a stdlib `http.get(endpoint)` with `timeout_ms`, resolving true on a 2xx/expected response. `endpoint` supports `${PORT}` expansion where `${PORT}` is the **actual bound port read from `storePath/port.txt`** (not the configured port — the service may walk to a free port). `_waitForHealth` polls for `port.txt` to appear before the first probe. See **[shape:http-health]**.
  - **Runtime dispatch (BLOCKER):** `libs/host-runtime/src/loader.ts` `dispatchToAdapter()` has a `case 'mcp-server'` and a throwing `default`. Add a `case 'service'` so `sox start` on a `type:service` extension is dispatched (to the run-service/supervisor path), not thrown. Install-time routing alone is insufficient — without this, a service installs but cannot start. Keep the existing `activateMcp` path intact ([inv:no-regress-mcp]).
  - **Config passthrough (required):** at the `run-service` registration site in `install.ts`, `spec.env` is currently `{}`. Inject the cascade-resolved `SOX_CONFIG_*` for the extension's declared config keys (the same transform `loader.ts` `processEntry` applies for mcp-server) so a started service receives its config — **[ref:config-schema]**, **[inv:standard-config]**.
  - Install engine: generalize the `profile: 'service'` block so a `type:service` (or any `transport: http`) install materializes the bundle to the store dir and registers via `run-service` **[ref:run-service-spec]** — preserving the registry entry shape and the single registry **[inv:single-registry]**.
  - **Local discovery (install-blocker):** add `'services'` to the `typeDirs` array in `findLocalExtension` (`libs/install-engine/src/install.ts:920`) so a `type:service` extension at `extensions/services/<id>/` is resolvable by `sox install <id>`. Without it, the service installs nowhere and `tg-service` cannot start. This is the on-disk type-bucket convention (`extensions/<type-plural>/<id>/`) made discoverable for the new bucket.
  - Host registry: add a `service` surface in `buildSurfaces()` routing to the `run-service` capability with scope-keyed store paths (no literal host path beyond the registry base — **[ref:host-keyed-target]**).
  - Confirm the stop path (SIGTERM → `stop_timeout_ms` → SIGKILL) terminates a port-holder and releases the port — **[ref:supervisor-stop]**.
  - Add `tools/tg-plan/check-http-service.sh` — scaffolds a trivial http service, installs+**starts** it via `./bin/sox` (exercising the loader `service` case), asserts `HTTP SERVICE HEALTHY` from the health probe, stops it, asserts `STOPPED CLEAN orphans=0` (no child + port free).
- **Invariants:** **[inv:single-registry]**, **[inv:supervisor-stop]** via **[ref:supervisor-stop]**, **[inv:no-regress-mcp]** (stdio path unchanged here).
- **Validation:** the guard runs an http service through install→health→stop and asserts the markers.

---

## Acceptance criteria

- [ ] **[http-transport.1]** `http-get` is a recognized health type in the supervisor. `grep -n "http-get" libs/host-runtime/src/supervisor.ts`
- [ ] **[http-transport.2]** `_probeHealth` performs an HTTP GET against the endpoint with a timeout (unit test: a live port returns healthy, a dead port returns unhealthy within the timeout).
- [ ] **[http-transport.3]** install routing materializes + registers an http/service install through `run-service`, preserving the registry entry shape. `grep -n "run-service\|runService\|runServiceApply" libs/install-engine/src/install.ts`
- [ ] **[http-transport.4]** a `service` surface exists in host-registry. `grep -n "service" libs/host-registry/src/claude.ts`
- [ ] **[http-transport.5]** `tools/tg-plan/check-http-service.sh` asserts `STOPPED CLEAN orphans=0` after stop. `grep -n "orphans=0" tools/tg-plan/check-http-service.sh`
- [ ] **[http-transport.6]** `loader.ts` `dispatchToAdapter` has a `service` case so a `type:service` extension starts at runtime (not just installs). `grep -n "'service'\|\"service\"" libs/host-runtime/src/loader.ts`
- [ ] **[http-transport.7]** the run-service registration injects `SOX_CONFIG_*` into `spec.env` for declared config keys. `grep -n "SOX_CONFIG_" libs/install-engine/src/install.ts`
- [ ] **[http-transport.8]** `findLocalExtension` `typeDirs` includes `services` so `extensions/services/<id>/` is discoverable. `grep -n "services" libs/install-engine/src/install.ts`

---

## Reservations

```text
read_only:  ["libs/manifest/src/index.ts",
             "extensions/mcp-servers/memory-server/extension.json",
             "tools/supervisor-shim.js",
             "libs/install-engine/src/capabilities/capabilities.spec.ts"]
mutates:    ["libs/host-runtime/src/supervisor.ts",
             "libs/host-runtime/src/loader.ts",
             "libs/install-engine/src/install.ts",
             "libs/install-engine/src/capabilities/run-service.ts",
             "libs/host-registry/src/claude.ts",
             "tools/tg-plan/check-http-service.sh",
             "scripts/install.ts"]
```

---

## Contract Promise

- **Added:** `'http-get'` health type + probe; the `service` case in `loader.ts` `dispatchToAdapter`; `service`/http install routing; host-registry `service` surface; `SOX_CONFIG_*` injection at the run-service site; `tools/tg-plan/check-http-service.sh`.
- **Modified:** `_probeHealth` (signature unchanged; new branch + port-file resolution); `dispatchToAdapter` (new `service` case, mcp-server case intact); the install descriptor routing in `install.ts`; `run-service` capability `env` passthrough.
- **Deleted:** none.

---

## Commit points

- [ ] **After the supervisor + install + registry changes build** — `feat(tokenguard-service): http-transport — http-get health + service install routing`
- [ ] **After the guard passes** (mandatory) — `feat(tokenguard-service): http-transport complete — guard green`

---

## Notes for executor

- **Duplicate `typeDirs` footgun.** `findLocalExtension`'s `typeDirs` array exists in **both** `libs/install-engine/src/install.ts:920` and a legacy copy at `scripts/install.ts:932`. Add `'services'` to the live lib copy; check whether `scripts/install.ts` is still reachable (per C1 the hand-maintained mirrors were retired) and either update it too or confirm it is dead — do not leave a half-updated pair (same class of footgun as the `VALID_TYPES` duplicate).
- **Named magic — `tools/supervisor-shim.js`.** A legacy compatibility wrapper for sox-memory lifecycle tests duplicates `_probeHealth` (socket/memory health only). It is **out of scope** here: http services ride the real `libs/host-runtime` supervisor, and the shim is never on an http-service path. Do **not** add the http branch to the shim. It is reserved `read_only` so you see it; if a future change makes the shim http-aware, that is a separate planner-class amendment.
- The http probe must use the Node stdlib `http`/`https` only — no new dependency; the supervisor is a foundational lib.
- A port-holder that ignores SIGTERM is the classic orphan: ensure the trivial test service installs a SIGTERM handler that closes the server, and verify SIGKILL escalation still fires within `stop_timeout_ms` if it doesn't.
- Keep the existing implicit stdio `profile: 'service'` path working — generalize, don't replace, so `mcp-as-service` can route stdio through the same code.
