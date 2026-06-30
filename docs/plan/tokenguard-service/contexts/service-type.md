# service-type — SERVICE_PRIMITIVE

> **Slug is identity.** Immutable. Ordering comes from `dag.json`.

**Phase:** framework · **Depends on:** (none — a root) · **Guard:** `python3 docs/plan/tokenguard-service/scripts/guard_service_type.py`
**Parallel with:** core-engine

---

## Goal

After this state, `service` is a **declarable manifest type** carrying a `transports` array (`stdio|http|sse|socket`), and `soxe init service <id>` scaffolds a **born-conformant** service extension that builds and validates with zero manual edits. This promotes the existing "service is an execution mode" comment into a first-class primitive — the foundation the http transport ([http-transport]) and the mcp-server fold-in ([mcp-as-service]) both build on. It does **not** yet route http or refactor mcp-server; it only makes the type real and scaffoldable.

---

## Semantic Distillation

- **Primitive:** WIRE `libs/manifest/src/index.ts` — add `service` to the type system with a transports vocabulary.
- **Reference Pattern:** the `mcp-server` type plumbing — `VALID_TYPES` (`libs/manifest/src/index.ts` + the duplicate in `scripts/new-extension.ts`), the `Manifest`/`ManifestInstall` unions, `validate()`'s `profiles ⊆ serves` check (`libs/manifest/src/index.ts`), `mcpServerTemplate` + `scaffold()` dispatch (`libs/authoring/src/index.ts`). Mirror it for `service`. See **[ref:born-conformant-template]**, **[ref:host-keyed-target]**.
- **Delta Spec:**
  - Add `'service'` to `VALID_TYPES` in **both** `libs/manifest/src/index.ts` and `scripts/new-extension.ts`, and to the `Manifest.type` + `ManifestInstall.type` unions.
  - **Inline JSON-schema enums (a THIRD type list — do not miss):** `libs/manifest/src/index.ts` carries an inlined JSON schema with closed enums for `type`, `install.type`, `lifecycle.health.type`, and `serves.items`. Add `'service'` to the `type` + `install.type` enums, `'http-get'` to the `health.type` enum, and `'socket'` to the transport/serves enum vocabulary. The comment that says `'service'` is intentionally absent is the marker being overturned.
  - **`processTypes`:** add `'service'` to the `processTypes` set in `libs/manifest/src/index.ts` so the `config_schema` recommendation fires for service extensions (currently it is silently suppressed for unknown types).
  - Add an optional `transports?: Array<'stdio'|'sse'|'http'|'socket'>` field to `ManifestInstall` (the type's transport vocabulary), kept in sync with the existing `serves` (back-compat alias). See **[shape:service-install]**.
  - Generalize `validate()`: the `profiles ⊆ serves` invariant also accepts `transports`; transport values are constrained to the vocabulary; for `type:service`, at least one transport is required.
  - Add `serviceTemplate(opts)` at `libs/authoring/src/templates/service/index.ts` emitting a born-conformant fileset (manifest with `type:service` + `transports` + `[shape:http-health]`-style lifecycle + `config_schema`, `package.json`, `tsconfig.json`, `src/index.ts` stub, `dist/index.js` stub, CHANGELOG, README) and register it in `scaffold()` dispatch + exports in `libs/authoring/src/index.ts`.
  - Add `docs/guidelines/service.md` — the per-type authoring contract (transports, lifecycle/health, supervision, when to use vs mcp-server). Include an explicit operator warning that **concurrent `soxe start` of the same service is a deferred non-goal** (runtime-productionization) — do not start the same service twice simultaneously.
  - Add `tools/tg-plan/check-service-scaffold.sh` — drives `./bin/soxe init service tgprobe` into a temp dir, builds it, runs `./bin/soxe validate`, prints `SCAFFOLD OK` on success / `SCAFFOLD FAIL` otherwise, and cleans up.
- **Invariants:** **[inv:no-regress-mcp]** — do not change `mcp-server` behavior here; `service` is added alongside.
- **Validation:** the guard scaffolds a `service`, builds it, and validates it; exits 0 only when the born-conformant round-trip is clean.

---

## Acceptance criteria

Checked by `audit-framework` as slug-keyed IDs.

- [ ] **[service-type.1]** `service` is registered in `VALID_TYPES` in both `libs/manifest/src/index.ts` and `scripts/new-extension.ts`. `grep -n "service" libs/manifest/src/index.ts scripts/new-extension.ts`
- [ ] **[service-type.2]** `ManifestInstall` declares a `transports` field and the type unions include `'service'`. `grep -n "transports" libs/manifest/src/index.ts`
- [ ] **[service-type.3]** `validate()` constrains transports to `stdio|http|sse|socket` and requires ≥1 for `type:service` (unit test in the manifest project asserts an invalid transport + a transports-less service are rejected).
- [ ] **[service-type.4]** `serviceTemplate` exists and `scaffold()` dispatches `'service'` to it. `grep -n "serviceTemplate" libs/authoring/src/index.ts`
- [ ] **[service-type.5]** `docs/guidelines/service.md` exists and documents the transports + lifecycle contract. `test -f docs/guidelines/service.md`
- [ ] **[service-type.6]** `tools/tg-plan/check-service-scaffold.sh` exists and drives `./bin/soxe init service`. `grep -n "init service" tools/tg-plan/check-service-scaffold.sh`
- [ ] **[service-type.7]** the inline JSON-schema enums + `processTypes` include `service`/`http-get`/`socket`. `grep -nE "http-get|processTypes" libs/manifest/src/index.ts` (and `service` present in the `type`/`install.type` enums)

---

## Reservations

```text
read_only:  ["extensions/mcp-servers/memory-server/extension.json",
             "libs/authoring/src/templates/mcp-server/index.ts",
             "libs/authoring/src/templates/_shared.ts"]
mutates:    ["libs/manifest/src/index.ts",
             "libs/authoring/src/templates/service/index.ts",
             "libs/authoring/src/index.ts",
             "apps/sox/src/main.ts",
             "docs/guidelines/service.md",
             "tools/tg-plan/check-service-scaffold.sh",
             "scripts/new-extension.ts",
             "libs/manifest/src/manifest.spec.ts"]
```

---

## Contract Promise

- **Added:** `service` type + `transports` field (manifest); `serviceTemplate` (authoring); `docs/guidelines/service.md`; `tools/tg-plan/check-service-scaffold.sh`; `soxe init service` routing in `apps/sox/src/main.ts`.
- **Modified:** `validate()` — transports-aware `profiles ⊆ {serves∪transports}`; `scaffold()` dispatch — `service` case.
- **Deleted:** none.

---

## Commit points

- [ ] **After the manifest + authoring + sox-init changes build** — commit `libs/manifest`, `libs/authoring`, `apps/sox` changes: `feat(tokenguard-service): service-type — declarable service primitive + transports`
- [ ] **After the guard passes** (mandatory) — commit source + `state.json`/`dag.json`: `feat(tokenguard-service): service-type complete — guard green`

---

## Notes for executor

- The `VALID_TYPES` duplicate in `scripts/new-extension.ts` is the classic footgun — updating only the manifest one passes unit tests but breaks the script path. Update both.
- Keep `serves` working untouched; `transports` is additive and, for the existing `mcp-server`/`http` cases, mirror `serves`. Do not break the `profiles ⊆ serves` test for current extensions.
- `dist/index.js` in the template must be a runnable stub that errors if executed but lets `soxe validate` pass entrypoint-reachability immediately (mirror `mcpServerTemplate`).
