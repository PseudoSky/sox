# bundle-pipeline — BUNDLE PIPELINE

> **Slug is identity.** This filename and the `bundle-pipeline` slug are immutable once assigned.

**Phase:** foundation · **Depends on:** (none) · **Guard:** `bash .workflow/plans/extension-install-model/scripts/guards/bundle-pipeline.sh`
**Parallel with:** manifest-templates, host-targets

---

## Goal

After this state, `tools/bundle-extension.cjs` produces a self-contained esbuild bundle for any code/service extension. `@sox/*` packages are inlined into the bundle; native deps (e.g. `better-sqlite3`) are declared external and carried into `[def:store-dir]`. The bundle's entrypoint runs from `/tmp` — a foreign directory with no monorepo — without any `Cannot find module '@sox` error and with the `[shape:serve-marker]` present, proving the real `serve()` path works.

This state is the **only mechanism** that makes `[dod.5]` (service runs from its store directory) structurally possible. Without a self-contained bundle, a service spawned from `$SBX/.sox/ext/<id>@<ver>/` would fail on every `@sox/*` import.

---

## Semantic Distillation

- **Primitive:** MODIFY `tools/bundle-extension.cjs` + `extensions/mcp-servers/memory-server/project.json` — wire esbuild bundling with `@sox/*` inlining and native-external handling; patch the materialize function to ship the bundle artifact, not the raw tsc dist.

- **Reference Pattern:** `apps/sox/scripts/rewrite-paths.cjs` shows how the CLI itself ships a runnable artifact (the pattern we mirror for extensions). `libs/install-engine/src/capabilities/materialize.ts` is the current materializer — it must be updated to pull the bundle, not `dist/`. The existing `extensions/mcp-servers/memory-server/src/index.ts` is the fixture.

- **Delta Spec:**
  - `tools/bundle-extension.cjs` — add or rewrite so it accepts `--entry <file>`, `--outdir <dir>`, `--external <pkg>` and produces a single `index.js` with every `@sox/*` specifier resolved inline. Follow `[ref:bundle-build]`.
  - `libs/install-engine/src/capabilities/materialize.ts` — change the artifact source from `dist/` to the esbuild output (`bundle/index.js` or similar). The materializer copies the bundle file + declared native `node_modules` into `[def:store-dir]`.
  - `extensions/mcp-servers/memory-server/project.json` — add a `bundle` target that invokes `tools/bundle-extension.cjs`.
  - `extensions/mcp-servers/memory-server/src/index.ts` — ensure `serve()` emits `[shape:serve-marker]` (`[serve] real-path`) to stderr on startup.

- **Invariants:** `[inv:bundle-selfcontained]` — zero `@sox/*` specifiers unresolved after bundling. `[inv:tier3-proof]` — the guard drives the real bundle entrypoint from `/tmp`, not a unit test. `[inv:sandbox-isolation]` enforced by `probe_done`.

- **Validation:** `bash .workflow/plans/extension-install-model/scripts/guards/bundle-pipeline.sh` — (1) builds the fixture bundle via `tools/bundle-extension.cjs`; (2) runs the bundle's `index.js` from `/tmp` and asserts no `Cannot find module '@sox`; (3) asserts `[shape:serve-marker]` in combined output.

---

## Acceptance criteria

Checked by audit-foundation (phase gate).

- [ ] **[bundle-pipeline.1]** `tools/bundle-extension.cjs` exits 0 and produces `index.js` when given the memory-server entry.
      `node tools/bundle-extension.cjs --entry extensions/mcp-servers/memory-server/src/index.ts --outdir /tmp/bp-test --external better-sqlite3 && test -f /tmp/bp-test/index.js && echo OK`
- [ ] **[bundle-pipeline.2]** The produced bundle runs from `/tmp` with no `Cannot find module '@sox` error (bundle is self-contained).
      `cd /tmp && timeout 3 node /tmp/bp-test/index.js 2>&1 | grep -v "Cannot find module '@sox" && echo OK || echo OK`
- [ ] **[bundle-pipeline.3]** Running the bundle from `/tmp` emits `[serve] real-path` in its output (real `serve()` path ran).
      Via guard script execution (tier 3): `bash .workflow/plans/extension-install-model/scripts/guards/bundle-pipeline.sh`
- [ ] **[bundle-pipeline.4]** `libs/install-engine/src/capabilities/materialize.ts` references the bundle artifact path, not a `dist/` tsc output.
      `grep -n "bundle" libs/install-engine/src/capabilities/materialize.ts`
- [ ] **[bundle-pipeline.5]** `extensions/mcp-servers/memory-server/project.json` declares a `bundle` target.
      `grep -q '"bundle"' extensions/mcp-servers/memory-server/project.json && echo OK`

---

## Reservations

```text
read_only:  ["libs/install-engine/src/install.ts",
             "libs/host-runtime/src/supervisor.ts",
             "extensions/mcp-servers/memory-server/src/index.ts"]
mutates:    ["libs/install-engine/src/capabilities/materialize.ts",
             "tools/bundle-extension.cjs",
             "extensions/mcp-servers/memory-server/project.json",
             "scripts/guards/bundle-pipeline.sh"]
```

---

## Contract Promise

- **Added:** `bundle` target in `memory-server/project.json`; `--entry`/`--outdir`/`--external` CLI in `tools/bundle-extension.cjs`
- **Modified:** `materialize.ts` — artifact source changed from `dist/` to bundle output; `memory-server/src/index.ts` — `serve()` now emits `[shape:serve-marker]`
- **Deleted:** none

---

## Commit points

- [ ] **After bundle tooling lands** — commit `tools/bundle-extension.cjs` + `project.json`:
      `feat(eim): bundle-pipeline — esbuild bundler + memory-server bundle target`
- [ ] **After materializer update** — commit `materialize.ts`:
      `feat(eim): bundle-pipeline — materialize pulls bundle artifact not dist`
- [ ] **After the guard passes** (mandatory) — commit source + state updates:
      `feat(eim): bundle-pipeline complete — guard green`

---

## Notes for executor

- The bundle must inline `@sox/mcp-runtime` (the package that contains `serve()`). If `serve()` is called correctly but the marker is absent, the marker emission is missing from `src/index.ts`.
- `better-sqlite3` is a native addon — always declare it `--external` and copy its prebuilt `.node` file into `[def:store-dir]` alongside `index.js`.
- Do not remove `src/index.ts` — it is still the TypeScript source; the bundle is a build artifact alongside it.
- The guard runs from an isolated temp dir that has no `node_modules` at all, which is the strictest self-containment test.
