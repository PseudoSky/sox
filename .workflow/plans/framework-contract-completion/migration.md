# Migration plan: complete & enforce the framework's missing runtime contracts

**Engagement:** `framework-contract-completion`. Grounds:
[`analysis.md`](./analysis.md) (12×7 contract-clarity matrix + prerequisite ordering),
[`suggestions.md`](./suggestions.md) (ranked items 1–7 + critical path), the per-type
"runtime contract the framework still owes" sections in `docs/guidelines/<type>.md`,
`docs/architecture-audit.md` (current-state gaps), and `docs/engine-defects-found.md` (DEFECT-1).
Every phase has a **deterministic acceptance check** (commands that exit 0 — no human judgment;
`$?` captured directly, never piped), a **Green =** line, and a **standalone executor prompt** a
fresh agent can run cold. Phases are **resumable**: each begins by re-running the prior phase's
acceptance check before doing new work.

Conventions: `$ROOT=/Users/nix/dev/ai/sox-ecosystem`. `pnpm` is on PATH or at
`/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`. All checks runnable from `$ROOT`. The manifest
file for each extension is `extension.json` (NOT `manifest.json`). Status file for completion steps:
`.workflow/plans/framework-contract-completion/status.md`.

---

## Intro

- **Goal:** Implement and enforce the framework contracts the guideline set proved Absent, concentrated
  in the build → activation → consumption → eventing seam, so an installed extension of ANY type
  actually runs/consumes and tenants can no longer diverge silently. Concretely: (1) a framework-owned
  build subsystem so no extension hand-maintains `dist/`; (2) per-type manifest self-description +
  interface contracts; (3) a host runtime (loader + supervisor + per-type dispatcher/registrar/
  renderer) that turns `installed` into `running`, integrating BELOW the complete `bin/sox` CLI;
  (4) an event bus including the DEFECT-1 `fireIsolated()` fix; plus per-extension config schema,
  resource/permission declarations, and bundle composition contracts — all enforced by validation
  gates, not advisory.
- **ROI:** **Qualitative-only (canonical).** This is the framework's most consequential gap: today the
  ecosystem "produces configuration only" (audit Gap C1) and zero behavioral extensions are executable
  (analysis row #4 Absent for all 5 process types). Measurable sub-metrics where available: executable
  behavioral extensions 0 → 9 (build subsystem, P0); runtime types reachable from `installed` 0 → 5
  (host runtime, P4); matrix rows #3/#7 converted from nominal (footnote ²) to real for 5 of 7 types;
  config blocks validated against schema 0 → 11 (PB); 3 already-observed divergence classes
  (`event`/`events`, `tools[]`/`organizeItems`, `run`/`runCli`) eliminated (P2/P3). No
  throughput/latency metric applies — provisional `critical` severity is downgraded to canonical
  `qualitative-only` per the optimizer's honest-metric standard.
- **Phases:** 10 (P0–P6 critical chain + PA/PB/PC parallel track).
- **Critical path:** `P0 (build, linchpin) → P1 (retire hand-maintained dist) → P2 (manifest
  self-description optional-first) → P3 (flip required + retrofit 11) → P4 (host loader+supervisor #8)
  → P5 (dispatcher/registrar/renderer #9) → P6 (event bus #12)`.
- **Parallel tracks (schedule from day one):** **PA** DEFECT-1 `fireIsolated()` fix (pure engine, no
  host dep); **PB** per-extension config schema + resource/permission declaration; **PC** bundle
  composition contracts. PB's *enforcement* half and P6's event-bus consumption of PA both wait for the
  host runtime — see Resumability & ownership.
- **Current status:** planned (not started).

**State machine:** `suggested → planned → P0 → … → P6 / PA / PB / PC → complete`. The parallel track
(PA/PB/PC) may run concurrently with the P0–P6 chain. The engagement is **not complete until all ten
phases are green**; whichever phase finishes last performs the `state: complete` transition (see
Resumability & ownership).

---

## Phase 0 — Framework-owned build subsystem + entrypoint-reachability gate `[CRITICAL · linchpin]`

**Phase ID:** P0
**Phase goal:** make each process-type package's `dist/index.js` GENERATED (not hand-authored) by a
per-package `tsconfig` compiled via `pnpm -r build`, wire that build into CI after `typecheck`, and add
an entrypoint-reachability validation gate so every manifest's resolved `entrypoint` is asserted to
exist post-build. This is row #4 (`source → build artifacts`, Absent for all 5 process types) becoming
**Defined**, and it converts nominal rows #3/#7 to real.
**Inputs:** suggestions item 1; analysis row #4 + footnote ²; `docs/architecture-audit.md` Gaps
D1/D3/F4 + recs #1/#7; `docs/cli-build-decision.md` (which deliberately chose hand-maintained mirrors —
this phase REVERSES that decision for extension packages; note the supersession in writing).
**Outputs:** a per-package `tsconfig.json` (or a workspace `tsconfig.packages.json` with project
references) compiling each `src/index.ts` to that package's own `dist/index.js` (the exact path its
`entrypoint` resolves to); `pnpm -r build` added to the CI validate workflow after `pnpm typecheck`;
an entrypoint-reachability gate in `scripts/validate-manifests.ts` (+ tests in
`scripts/validate-manifests.test.ts`) that, for every manifest declaring an `entrypoint`, asserts the
resolved built path exists; a supersession note appended to `docs/cli-build-decision.md`.
**Acceptance check (deterministic)**
```bash
cd "$ROOT"
# 1. workspace build succeeds for all packages (capture $? directly — never pipe):
pnpm -r build >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# 2. every process-type package now emits a GENERATED dist/index.js:
for d in extensions/mcp-servers/* extensions/hooks/* extensions/agents/* extensions/skills/* extensions/commands/*; do
  [ -f "$d/src/index.ts" ] || continue
  test -f "$d/dist/index.js"; rc=$?; [ $rc -eq 0 ] || exit 1
done
# 3. entrypoint-reachability gate is wired and passes on the freshly-built repo:
pnpm -s validate-manifests >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# 4. supersession recorded:
grep -q -i "supersed" docs/cli-build-decision.md; rc=$?; [ $rc -eq 0 ] || exit 1
# 5. full suite green:
pnpm -s test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
exit 0
```
**Green =** every process-type package compiles to a generated `dist/index.js`, the validator fails any
manifest whose `entrypoint` does not resolve post-build, CI builds before validating, and the full test
suite is green. No extension hand-maintains its build output anymore.

**Phase prompt:**

> You are a TypeScript build engineer onboarding cold to the `sox-ecosystem` pnpm monorepo at
> `/Users/nix/dev/ai/sox-ecosystem` (`$ROOT`; `pnpm` on PATH or at
> `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`). The ecosystem is a 7-type LLM-extension
> ecosystem (mcp / hook / agent / skill / command / prompt / bundle). Its proven engine lives in
> `scripts/*.ts` (`install.ts`, `cascade.ts`, `validate-manifests.ts`, `build-index.ts`) and is
> validated by a large vitest suite (`pnpm test`). The operator surface `bin/sox` is complete (a prior
> engagement); you integrate BELOW it and must NOT fork or break it.
>
> THE CONTRACT GAP YOU ARE CLOSING (the linchpin of this whole engagement): there is **no
> framework-owned build**. `source → build artifacts` is Absent for every process type (analysis row
> #4). Today the runtime `dist/*.js` files (e.g. `dist/memory-lib.js`, `dist/memory-cli.js`) are
> **hand-maintained ESM mirrors** of `src/` — `docs/cli-build-decision.md` deliberately chose that
> "Discipline B". **This phase reverses that decision for the extension packages**: each process-type
> package's `dist/index.js` must become COMPILER OUTPUT, not hand-authored. You must record the
> supersession in `docs/cli-build-decision.md` (append a dated "Superseded for extension packages by
> framework-contract-completion P0" note — do not delete the original).
>
> Your task: (1) Add a per-package `tsconfig.json` (or a workspace `tsconfig.packages.json` using
> TypeScript project references) so `pnpm -r build` compiles each package's `src/index.ts` to that same
> package's `dist/index.js` — the EXACT path the manifest's `entrypoint` field resolves to. Make the
> output deterministic and uniform across every process-type package under `extensions/mcp-servers/*`,
> `extensions/hooks/*`, `extensions/agents/*`, `extensions/skills/*`, `extensions/commands/*`. (2) Add
> `pnpm -r build` to the CI validate workflow AFTER `pnpm typecheck`. (3) Add an
> **entrypoint-reachability gate** to `scripts/validate-manifests.ts`: for every manifest
> (`extension.json`) that declares an `entrypoint`, assert the resolved built path exists; add tests
> for it in `scripts/validate-manifests.test.ts` (both a passing case and a failing case). Do NOT yet
> delete the hand-maintained `dist/*.js` mirrors or repoint their importers — that is Phase P1, which
> is sequenced separately to avoid breaking the `memory-flush` hook's runtime import of
> `../../../dist/memory-lib.js`.
>
> Skills/tools you need: pnpm workspaces, TypeScript `tsc` / project references, JSON Schema/AJV
> familiarity (the validator uses AJV), Node ESM, vitest.
> Files to read first: `$ROOT/.workflow/plans/framework-contract-completion/suggestions.md` (item 1)
> and `analysis.md` (row #4 + footnote ²); `docs/architecture-audit.md` (Gaps D1/D3/F4, recs #1/#7);
> `docs/cli-build-decision.md`; root `package.json` + any `tsconfig*.json`; `scripts/validate-manifests.ts`;
> one extension `extension.json` (e.g. `extensions/mcp-servers/memory-server/extension.json`) to see
> the `entrypoint` field shape.
> Success criteria: the Phase 0 acceptance check above exits 0.
> Hard constraints: do NOT delete or repoint the hand-maintained `dist/*.js` mirrors in this phase
> (P1 owns that, sequenced to protect `extensions/hooks/memory-flush/src/index.ts:262`). Do NOT fork
> `bin/sox` or the engine scripts — extend, do not duplicate. In every acceptance check capture `$?`
> directly; NEVER pipe a command whose exit code you are testing. `pnpm test` must stay green.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/framework-contract-completion/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P0 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`. *On the final phase, set
> `state: complete` instead of `executing`.*

---

## Phase 1 — Retire the hand-maintained `dist/` mirrors + repoint importers `[CRITICAL]`

**Phase ID:** P1
**Phase goal:** now that P0 makes `dist/index.js` generated, REMOVE the hand-maintained `dist/*.js`
mirrors (`dist/memory-lib.js`, `dist/memory-cli.js`, `dist/memoryd.js`) and repoint every test/tool/
extension that imported them at built output, eliminating the dual-`dist` ambiguity for good. This
closes audit Gap D3 (hand-maintained `dist/`) and the precondition half of Gap A4 (the
`memory-flush` cross-package relative import).
**Inputs:** P0 (green); suggestions item 1 "Retire the hand-maintained `dist/*.js` mirrors";
`docs/architecture-audit.md` Gaps A4/D3 + the install-client source-resolution note (install.ts lines
311–317); `docs/cli-build-decision.md` (now carrying P0's supersession note).
**Outputs:** the hand-maintained `dist/memory-lib.js`, `dist/memory-cli.js`, `dist/memoryd.js` removed
(or replaced by built output); every importer repointed — notably
`extensions/hooks/memory-flush/src/index.ts:262` (`import('../../../dist/memory-lib.js')`) and any
tests/tools that import `dist/*.js`; `bin/sox` still functioning over the engine.
**Acceptance check (deterministic)**
```bash
cd "$ROOT"
pnpm -r build >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1     # P0 guard
# no source file imports a hand-maintained dist mirror anymore (search returns no matches → grep exit 1):
grep -rn "dist/memory-lib.js\|dist/memory-cli.js\|dist/memoryd.js" extensions scripts tools >/dev/null 2>&1; rc=$?; [ $rc -ne 0 ] || exit 1
# bin/sox still runs over the engine:
node bin/sox --help >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
node bin/sox validate >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# entrypoint gate still passes and full suite green after the repoint:
pnpm -s validate-manifests >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
pnpm -s test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
exit 0
```
**Green =** no source imports a hand-maintained mirror, the mirrors are gone, every importer resolves to
built output, `bin/sox` works, and the full suite plus the entrypoint gate are green.

**Phase prompt:**

> You are a TypeScript engineer in the `sox-ecosystem` monorepo (`$ROOT =
> /Users/nix/dev/ai/sox-ecosystem`; pnpm on PATH or at
> `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`). Phase P0 just made each extension package's
> `dist/index.js` GENERATED by `pnpm -r build` and added an entrypoint-reachability gate. Re-run the
> P0 acceptance check first; if it fails, fix or escalate before proceeding.
>
> Context you need cold: this repo historically had **hand-maintained ESM mirrors** at
> `dist/memory-lib.js`, `dist/memory-cli.js`, and `dist/memoryd.js` — manually-authored JS that tools,
> tests, and one extension import directly. With P0's real build in place those mirrors are now
> redundant and dangerous (a second, divergent `dist` notion). One importer is runtime-critical:
> `extensions/hooks/memory-flush/src/index.ts` line 262 does
> `await import('../../../dist/memory-lib.js' as string)` (audit Gap A4) — this WILL break at runtime
> if the mirror disappears without a repoint.
>
> Your task: (1) Find every reference to `dist/memory-lib.js`, `dist/memory-cli.js`, `dist/memoryd.js`
> across `extensions/`, `scripts/`, `tools/`, and tests. (2) Repoint each importer at the appropriate
> BUILT output (the package's compiled `dist/index.js` or a built lib path), preferring a stable
> package-relative or workspace-resolved import over a deep `../../../dist/*.js` relative path. (3)
> Remove the hand-maintained mirror files. (4) Confirm `bin/sox` still drives the engine and the
> install client's source-resolution logic (install.ts lines 311–317) is unaffected — if a build-output
> path change touches it, retest install. Do NOT change engine behavior; this is a mechanical repoint +
> deletion.
>
> Skills/tools you need: ripgrep/grep, Node ESM resolution, pnpm workspaces, vitest.
> Files to read first: `extensions/hooks/memory-flush/src/index.ts` (around line 262);
> `docs/architecture-audit.md` (Gaps A4/D3); `docs/cli-build-decision.md` (P0's supersession note);
> `scripts/install.ts` lines 311–317; `$ROOT/.workflow/plans/framework-contract-completion/suggestions.md`
> item 1.
> Success criteria: the Phase 1 acceptance check above exits 0.
> Hard constraints: do NOT leave any source importing a hand-maintained mirror. Do NOT alter engine
> semantics. Capture `$?` directly in checks; NEVER pipe a command whose exit code you test. `pnpm test`
> stays green.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/framework-contract-completion/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P1 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`. *On the final phase, set
> `state: complete` instead of `executing`.*

---

## Phase 2 — Per-type manifest self-description + interface contracts (optional-first) `[CRITICAL]`

**Phase ID:** P2
**Phase goal:** add, to `schemas/extension/v1.json` and `scripts/validate-manifests.ts`, the per-type
self-description fields the guideline docs specify — hook `events: []` with a **closed enum** of valid
host event names; agent/command invocation protocol + handler interface; skill run/IO interface; prompt
parameter set + template-syntax; mcp transport + tool descriptors; bundle member-existence guarantee —
shipped **OPTIONAL-FIRST** (validator WARNS on absent/unknown, exits 0). This is rows #5/#6 specified
but not yet enforced; P3 flips them required.
**Inputs:** P1 (green); suggestions item 3; analysis rows #5/#6 + footnote ¹ + per-type notes;
`docs/guidelines/<type>.md` "runtime contract the framework still owes" sections; audit Gaps A1/F1/F2 +
recs #3/#5. The closed event enum MUST be seeded from CURRENT usage so no in-use event is rejected.
**Outputs:** new optional self-description fields in `schemas/extension/v1.json` (per type);
`scripts/validate-manifests.ts` updated to validate them as WARN-level when present and warn (not error)
when absent; the closed host-event enum seeded from existing hook usage (audit the two existing hooks);
`dependencies` enforcement wired into the install client (Gap F2 — field exists, no consumer); tests in
`scripts/validate-manifests.test.ts` asserting warn-not-error posture. NO manifest retrofit yet.
**Acceptance check (deterministic)**
```bash
cd "$ROOT"
pnpm -r build >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1     # P0/P1 guard
# optional-first: the 11 un-retrofitted manifests still pass (warnings only, exit 0):
pnpm -s validate-manifests >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# schema now declares the self-description surface (e.g. an events vocabulary):
grep -q -i "events\|invocation\|self.\?descr\|tool" schemas/extension/v1.json; rc=$?; [ $rc -eq 0 ] || exit 1
# the closed event enum exists and contains every event the current hooks declare:
node bin/sox validate >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# new validator tests pass within the full suite:
pnpm -s test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
exit 0
```
**Green =** the schema declares per-type self-description fields, the validator treats them as
optional warnings, the closed event enum already covers all in-use events, `dependencies` is enforced,
and all 11 existing (un-retrofitted) manifests still pass with exit 0.

**Phase prompt:**

> You are a schema/validation engineer in the `sox-ecosystem` monorepo (`$ROOT =
> /Users/nix/dev/ai/sox-ecosystem`; pnpm on PATH or at
> `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`). Phases P0–P1 landed a real build and retired the
> hand-maintained `dist/` mirrors. Re-run the P1 acceptance check first; if it fails, fix or escalate.
>
> THE CONTRACT GAP YOU ARE CLOSING: manifests today validate "shape only" — validation does NOT assert
> declared-event/tool/verb validity or a runtime interface (analysis footnote ¹; rows #5 `author → type
> runtime contract` and #6 `source → interface descriptors`, both Absent). This has ALREADY produced
> divergence between the few existing tenants: hook `export const event` (audit-hook) vs `events`
> (memory-flush); agent `tools[]`+`execute` (echo-agent) vs `organizeItems()` (memory-organizer);
> command `run(input)` (status-command) vs `runCli(argv)` (memory-cli). You will add the per-type
> self-description fields that let a host discover capability WITHOUT executing code.
>
> CRITICAL ROLLOUT DISCIPLINE (same warnings→retrofit→strict pattern the consumer-interface engagement
> used): ship every new field **OPTIONAL-FIRST**. The validator WARNS when a self-description field is
> absent or unknown, and still EXITS 0. Do NOT make any field required and do NOT retrofit the 11
> existing manifests in this phase — Phase P3 flips fields to required AND retrofits, gated on a green
> retrofit. A closed event enum that omits an in-use event name would reject a valid hook, so SEED the
> enum from current usage: read every existing hook's declared events first.
>
> Your task, per type, add the self-description field its guideline doc specifies to
> `schemas/extension/v1.json` (optional) and validate it WARN-level in `scripts/validate-manifests.ts`:
> hook → `events: []` array constrained by a **closed enum** seeded from current hook usage (audit rec
> #3, Gap F1); agent/command → invocation protocol + handler interface descriptor (resolves
> `tools[]` vs `organizeItems`, `run` vs `runCli`); skill → run/IO interface (`run(input)` signature);
> prompt → parameter set + template-syntax descriptor; mcp → transport + tool descriptors; bundle →
> member-existence guarantee (note: bundle row #6 is Implicit not Absent — coordinate with phase PC).
> Also wire `dependencies` enforcement into the install client (Gap F2: the field exists but has no
> consumer). Add tests to `scripts/validate-manifests.test.ts` asserting the warn-not-error posture.
>
> Skills/tools you need: JSON Schema (draft used by `schemas/extension/v1.json`), AJV, TypeScript,
> vitest.
> Files to read first: `schemas/extension/v1.json`; `scripts/validate-manifests.ts` +
> `scripts/validate-manifests.test.ts`; each `docs/guidelines/<type>.md` "owes" section;
> `docs/architecture-audit.md` (Gaps A1/F1/F2, recs #3/#5); the two existing hook `extension.json`
> files and their `src/index.ts` to seed the event enum; `analysis.md` rows #5/#6 + footnote ¹;
> `suggestions.md` item 3.
> Success criteria: the Phase 2 acceptance check above exits 0.
> Hard constraints: every new field is OPTIONAL (warn-only) in this phase — do NOT make anything
> required and do NOT edit the 11 manifests' field set (P3 owns the retrofit). The event enum must
> already contain every event any existing hook declares. Capture `$?` directly; NEVER pipe a command
> whose exit code you test. `pnpm test` stays green.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/framework-contract-completion/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P2 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`. *On the final phase, set
> `state: complete` instead of `executing`.*

---

## Phase 3 — Retrofit the 11 manifests + flip self-description to required `[CRITICAL · 11-manifest retrofit]`

**Phase ID:** P3
**Phase goal:** retrofit all 11 existing `extension.json` manifests with the self-description fields
P2 added, then flip those fields from optional (warn) to REQUIRED (error) in
`scripts/validate-manifests.ts`, so rows #5/#6 become **Defined** (specified AND enforced). The flip is
gated on a green retrofit.
**Inputs:** P2 (green); suggestions item 3 "flip to required once the 11 are retrofitted"; analysis
rows #5/#6; the 11 manifest paths (see Resumability & ownership); `docs/guidelines/<type>.md` per-type
field specs.
**Outputs:** all 11 manifests carrying their type's self-description fields (hook events, agent/command
invocation + handler interface, skill run interface, prompt parameters, mcp transport/tools, bundle
member-existence); `scripts/validate-manifests.ts` flipping the per-type self-description fields to
error-level; `scripts/validate-manifests.test.ts` updated so the "missing self-description" case now
asserts an ERROR; the existing extensions' code reconciled to their now-declared interface where the
declaration formalizes a divergence (e.g. align hook `event`/`events`).
**Acceptance check (deterministic)**
```bash
cd "$ROOT"
pnpm -r build >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1     # build guard
# strict self-description is now enforced and all 11 retrofitted manifests pass:
pnpm -s validate-manifests >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
node bin/sox validate >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# enforcement is real: a manifest stripped of its self-description must now FAIL.
cp extensions/hooks/memory-flush/extension.json /tmp/fcc-p3-backup.json
node -e "const f='extensions/hooks/memory-flush/extension.json';const m=require('fs').readFileSync(f,'utf8');const o=JSON.parse(m);delete o.events;require('fs').writeFileSync(f,JSON.stringify(o,null,2));"
pnpm -s validate-manifests >/dev/null 2>&1; rc=$?
cp /tmp/fcc-p3-backup.json extensions/hooks/memory-flush/extension.json   # restore
[ $rc -ne 0 ] || exit 1
# restored repo is green again:
pnpm -s validate-manifests >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
pnpm -s test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
exit 0
```
**Green =** all 11 manifests carry their self-description fields, the validator now ERRORS (not warns)
on a missing field, stripping a field reproducibly fails validation, and after restore the full suite
is green.

**Phase prompt:**

> You are a framework-conformance engineer in the `sox-ecosystem` monorepo (`$ROOT =
> /Users/nix/dev/ai/sox-ecosystem`; pnpm on PATH or at
> `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`). Phase P2 added per-type self-description fields
> to `schemas/extension/v1.json` and the validator as OPTIONAL (warn-only). Re-run the P2 acceptance
> check first; if it fails, fix or escalate.
>
> Your task is the retrofit-then-enforce step: (1) Add the type-appropriate self-description fields to
> ALL 11 existing manifests (`extension.json`), per each `docs/guidelines/<type>.md` spec. The 11
> manifests are: `extensions/bundles/sox-memory-bundle`, `extensions/commands/memory-cli`,
> `extensions/commands/status-command`, `extensions/hooks/memory-flush`, `extensions/hooks/audit-hook`,
> `extensions/agents/memory-organizer`, `extensions/agents/echo-agent`,
> `extensions/mcp-servers/memory-server`, `extensions/mcp-servers/hello-server`,
> `extensions/prompts/greeting-prompt`, `extensions/skills/hello-world`. (2) Where the declaration
> formalizes an already-observed divergence, reconcile the extension's CODE to the declared interface
> (e.g. the hook `event` vs `events` split). (3) Once all 11 validate clean with the fields present,
> FLIP the per-type self-description fields from warn to ERROR in `scripts/validate-manifests.ts`, and
> update `scripts/validate-manifests.test.ts` so the missing-field case asserts an error. Do this flip
> ONLY after the retrofit is green — a premature flip breaks CI for in-flight extensions.
>
> Skills/tools you need: JSON editing, AJV/JSON Schema, TypeScript, vitest.
> Files to read first: `schemas/extension/v1.json` (the P2 fields); `scripts/validate-manifests.ts` +
> `.test.ts`; each `docs/guidelines/<type>.md` field spec; the 11 manifests listed above; `analysis.md`
> rows #5/#6; `suggestions.md` item 3.
> Success criteria: the Phase 3 acceptance check above exits 0.
> Hard constraints: flip to required ONLY after the retrofit is green. Do NOT loosen any pre-existing
> validation. Capture `$?` directly; NEVER pipe a command whose exit code you test. `pnpm test` stays
> green after the temporary strip-and-restore proof.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/framework-contract-completion/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P3 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`. *On the final phase, set
> `state: complete` instead of `executing`.*

---

## Phase 4 — Host runtime: unified loader + supervisor (#8) `[CRITICAL]`

**Phase ID:** P4
**Phase goal:** build a NEW host-runtime subsystem — a unified loader + process supervisor with per-type
adapters — that reads the lockfile `bin/sox install` produces, resolves each entry's BUILT `entrypoint`,
and activates it via the right adapter, turning `installed` into `running`. This is row #8
(`install → activated runtime`, Absent for hook/agent/skill/command, DU for mcp) becoming **Defined**.
Promote the CI shim `tools/supervisor-shim.js` to product code as the supervisor's reference core.
**Inputs:** P3 (green — interface descriptors exist for static dispatch); suggestions item 2; analysis
row #8 + ordering step 4; audit Gaps C1/A5/A7/C4/C5 + recs #2/#6; `tools/supervisor-shim.js` (currently
labeled TEST SCAFFOLDING — must become product code); the `lifecycle{}` block already in the schema.
**Outputs:** a new host-runtime module (e.g. `scripts/host/` or `extensions/.../host`) containing a
lockfile-reading loader, a process supervisor honoring `lifecycle{}` (`background`, `singleton`,
`stop_timeout_ms`, health probe) built from a PRODUCTIZED `tools/supervisor-shim.js`, and per-type
adapters (start with mcp spawn+stdio and hook register-into-HookLoader — the two types with existing
tenants — then agent/skill in-process invoke, command verb registration); resolution of the socket
convention (Gap A5: `~/.memory/memoryd.sock` tilde is not a Node path); lockfile hygiene so stale
uninstall entries (Gap C5) are not loaded; integration so `bin/sox` install's lockfile is the loader's
input. Tests for the loader + supervisor.
**Acceptance check (deterministic)**
```bash
cd "$ROOT"
pnpm -r build >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1     # build guard
pnpm -s validate-manifests >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1   # P3 guard
# the supervisor is now product code, not test scaffolding:
grep -q -i "TEST SCAFFOLDING" tools/supervisor-shim.js >/dev/null 2>&1; rc=$?; [ $rc -ne 0 ] || exit 1
# the host runtime module exists and exposes a loader entry the suite exercises:
test -d scripts/host -o -f scripts/host-runtime.ts; rc=$?; [ $rc -eq 0 ] || exit 1
# loader + supervisor + adapter tests pass within the full suite:
pnpm -s test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# bin/sox unaffected:
node bin/sox --help >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
exit 0
```
**Green =** a host-runtime subsystem reads the lockfile, resolves built entrypoints, and activates at
least the mcp and hook adapters via a productized supervisor; the supervisor is no longer labeled test
scaffolding; lockfile hygiene drops stale entries; and the full suite (incl. new loader/supervisor
tests) is green. `bin/sox` is unchanged.

**Phase prompt:**

> You are a Node runtime/systems engineer in the `sox-ecosystem` monorepo (`$ROOT =
> /Users/nix/dev/ai/sox-ecosystem`; pnpm on PATH or at
> `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`). Phases P0–P3 gave you: real built artifacts
> (`pnpm -r build`), an entrypoint-reachability gate, and ENFORCED per-type manifest self-description
> (so you can dispatch by reading manifests WITHOUT executing extension code). Re-run the P3 acceptance
> check first; if it fails, fix or escalate.
>
> THE CONTRACT GAP YOU ARE CLOSING (audit's "single most consequential finding", Gap C1): there is NO
> host runtime that turns `installed` into `running`. The ecosystem "produces configuration only".
> Build this as a NEW SUBSYSTEM, not an incremental edit. It integrates BELOW the complete `bin/sox`
> CLI: `bin/sox install` already produces the lockfile — your loader is its missing runtime callee.
> WRAP, do not fork, `bin/sox` and the engine (`install.ts`, `cascade.ts`).
>
> Best-practice (from research memory cited in suggestions item 2): use ONE unified loader + supervisor
> with per-TYPE ADAPTERS, not N independent loaders. The supervisor must honor the `lifecycle{}` block
> already in the schema (`background`, `singleton`, `stop_timeout_ms`, health probe). The CI shim
> `tools/supervisor-shim.js` (currently labeled "TEST SCAFFOLDING") is your supervisor's reference core
> — PROMOTE it to product code; do not leave it as test scaffolding.
>
> Your task: (1) Create a host-runtime module (`scripts/host/` or `scripts/host-runtime.ts`) with a
> loader that reads the lockfile, resolves each entry's BUILT `entrypoint`, and hands it to the right
> per-type adapter. (2) Productize `tools/supervisor-shim.js` into the supervisor core. (3) Implement
> per-type adapters, STAGED: start with mcp (spawn + stdio) and hook (register into the existing
> HookLoader) — the two types with real tenants — then agent/skill (in-process invoke) and command
> (verb registration that integrates with `bin/sox`). (4) Fix lockfile hygiene so a `sox uninstall`
> that leaves a stale lock entry (Gap C5) does NOT get naively loaded. (5) Resolve the socket-endpoint
> convention (Gap A5: `~/.memory/memoryd.sock` — the tilde is not a Node-resolvable path) as part of
> the health-probe contract. Add loader + supervisor + adapter tests. Scope discipline: staging the
> adapters is mandatory; do not attempt all five in one pass without mcp+hook landing first.
>
> Skills/tools you need: Node child_process/IPC, ESM dynamic import, process supervision, the existing
> HookLoader (`scripts/hook-loader.ts`), MCP stdio (see `extensions/mcp-servers/memory-server/src/index.ts`).
> Files to read first: `tools/supervisor-shim.js`; `tools/host-event-shim.js`;
> `docs/architecture-audit.md` (Gaps C1/A5/A7/C4/C5, recs #2/#6); `scripts/install.ts` (lockfile shape);
> `scripts/hook-loader.ts`; `analysis.md` row #8; `suggestions.md` item 2.
> Success criteria: the Phase 4 acceptance check above exits 0.
> Hard constraints: do NOT fork `bin/sox` or the engine — integrate below them. The loader reads BUILT
> entrypoints (never `.ts` source — that depends on P0). Capture `$?` directly; NEVER pipe a command
> whose exit code you test. `pnpm test` stays green.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/framework-contract-completion/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P4 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`. *On the final phase, set
> `state: complete` instead of `executing`.*

---

## Phase 5 — Host runtime: per-type dispatcher / registrar / renderer (#9) `[CRITICAL]`

**Phase ID:** P5
**Phase goal:** on top of P4's supervisor, add the per-type DELIVERY layer that takes a running runtime
and delivers it to its consumer — an mcp registrar (host-side client exposing discovered tools into the
agent surface), a command dispatcher (verb→handler wired into `bin/sox`), and agent/skill invoker +
prompt renderer. This is row #9 (`runtime → delivered to consumer`, Absent for all 5 runtime types)
becoming **Defined**.
**Inputs:** P4 (green); suggestions item 4; analysis row #9 + ordering step 5; audit Gaps C2/C3/C6/F5;
the existing MCP transport (`extensions/mcp-servers/memory-server/src/index.ts` lines 324–366); the
stubbed `bin/sox` verbs (`update`/`search`/`enable`/`disable`).
**Outputs:** an mcp registrar (host-side MCP client discovering tools from spawned servers and exposing
them into the agent surface — closes Gap C2); a command dispatcher wiring verb→handler into `bin/sox`
(which can also realize the stubbed `update`/`search`/`enable`/`disable` — Gaps C3/C6); an agent/skill
invoker and a prompt renderer; tests for each delivery path.
**Acceptance check (deterministic)**
```bash
cd "$ROOT"
pnpm -r build >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1     # build guard
grep -q -i "TEST SCAFFOLDING" tools/supervisor-shim.js >/dev/null 2>&1; rc=$?; [ $rc -ne 0 ] || exit 1   # P4 guard
# a previously-stubbed verb now does real work (exits 0 instead of stub error):
node bin/sox list >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
node bin/sox enable --help >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# the registrar/dispatcher/renderer tests pass within the full suite:
pnpm -s test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
exit 0
```
**Green =** the host delivers each runtime type to its consumer — mcp tools reachable from the agent
surface, command verbs dispatched through `bin/sox` (stubs realized), agent/skill/prompt output
delivered — and the full suite (incl. delivery-path tests) is green.

**Phase prompt:**

> You are a Node runtime engineer in the `sox-ecosystem` monorepo (`$ROOT =
> /Users/nix/dev/ai/sox-ecosystem`; pnpm on PATH or at
> `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`). Phase P4 built the host-runtime loader +
> supervisor with mcp/hook (and staged agent/skill/command) adapters that turn `installed` into
> `running`. Re-run the P4 acceptance check first; if it fails, fix or escalate.
>
> THE CONTRACT GAP YOU ARE CLOSING (audit Gap C2, CRITICAL): a running runtime is not yet DELIVERED to
> its consumer. row #9 (`runtime → delivered to consumer`) is Absent for all 5 runtime types. You add
> the per-type delivery layer ON TOP of P4's supervisor.
>
> Your task: (1) mcp REGISTRAR — a host-side MCP client that discovers tools from the servers P4 spawns
> and exposes them into the agent's surface (closes Gap C2; the server-side stdio transport already
> exists at `extensions/mcp-servers/memory-server/src/index.ts` lines 324–366 — you build the missing
> CLIENT counterpart). (2) command DISPATCHER — verb→handler dispatch wired into the existing `bin/sox`
> verb surface; this also lets the stubbed `update`/`search`/`enable`/`disable` verbs become real
> (audit Gaps C3/C6). (3) agent/skill INVOKER + prompt RENDERER delivering their output to the consumer.
> WRAP `bin/sox`; do not fork it. SECURITY: the MCP registrar must not expose the unsandboxed
> caller-supplied `db_path` (Gap F5) to multiple clients without the resource/permission contract from
> phase PB — coordinate; if PB has not landed, gate the registrar behind a conservative default.
>
> Skills/tools you need: MCP client protocol, Node IPC/stdio, the existing `bin/sox` verb dispatch,
> vitest.
> Files to read first: `extensions/mcp-servers/memory-server/src/index.ts` (lines 324–366);
> `docs/architecture-audit.md` (Gaps C2/C3/C6/F5); the P4 host-runtime module; `bin/sox` verb table;
> `analysis.md` row #9; `suggestions.md` item 4.
> Success criteria: the Phase 5 acceptance check above exits 0.
> Hard constraints: do NOT fork `bin/sox`. Do NOT expose the unsandboxed `db_path` via the registrar
> without PB's permission contract. Capture `$?` directly; NEVER pipe a command whose exit code you
> test. `pnpm test` stays green.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/framework-contract-completion/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P5 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`. *On the final phase, set
> `state: complete` instead of `executing`.*

---

## Phase 6 — Host event bus + lifecycle signals (#12), consuming `fireIsolated()` `[CRITICAL]`

**Phase ID:** P6
**Phase goal:** build the host event bus on top of the host runtime — a registry of the closed event
vocabulary (P2's enum) that fires lifecycle signals through `fireIsolated()` (delivered by parallel
phase PA) and lets mcp/agent/skill/command react. This is row #12 (`event/lifecycle signal → reaction`,
A+defect for hook, DU for mcp, Absent for agent/skill/command) becoming **Defined**, and it promotes
`tools/host-event-shim.js` from test scaffolding to product code.
**Inputs:** P5 (green) AND PA (green — `fireIsolated()` must exist); suggestions item 5 (event-bus
half); analysis row #12 + ordering step 6; audit Gap A2 + rec #11 + §6; `tools/host-event-shim.js`
(currently "Absent — test scaffolding only"); P2's closed event enum.
**Outputs:** a host event-bus module wiring the closed event vocabulary to lifecycle dispatch via
`fireIsolated()`; `tools/host-event-shim.js` promoted to product code as the bus's reference core;
mcp/agent/skill/command able to register reactions (converting mcp #12 from DU to Defined); tests for
the bus, including a multi-hook test proving one throwing hook does NOT suppress the others.
**Acceptance check (deterministic)**
```bash
cd "$ROOT"
pnpm -r build >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1     # build guard
node bin/sox list >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1   # P5 guard
# PA dependency present: fireIsolated exists in the engine:
grep -q "fireIsolated" scripts/hook-loader.ts >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# the event-bus shim is now product code, not test scaffolding:
grep -q -i "test scaffolding\|scaffolding only" tools/host-event-shim.js >/dev/null 2>&1; rc=$?; [ $rc -ne 0 ] || exit 1
# the event-bus tests (incl. throwing-hook-does-not-suppress-others) pass within the full suite:
pnpm -s test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
exit 0
```
**Green =** the host event bus fires lifecycle signals through `fireIsolated()` so a throwing hook no
longer suppresses downstream reactions; mcp/agent/skill/command can react; the event-bus shim is
product code; and the full suite (incl. the isolation test) is green.

**Phase prompt:**

> You are a Node runtime engineer in the `sox-ecosystem` monorepo (`$ROOT =
> /Users/nix/dev/ai/sox-ecosystem`; pnpm on PATH or at
> `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`). The host runtime now ACTIVATES (P4) and DELIVERS
> (P5) extensions, and the parallel phase PA has added `fireIsolated()` to `scripts/hook-loader.ts`
> (continue-on-throw, per-hook error collection). Re-run the P5 acceptance check first AND confirm
> `grep -q "fireIsolated" scripts/hook-loader.ts` exits 0 (PA dependency) before proceeding; if either
> fails, fix or escalate.
>
> THE CONTRACT GAP YOU ARE CLOSING: row #12 (`event/lifecycle signal → reaction`) is A+defect for hook,
> DU for mcp, Absent for agent/skill/command. There is no host event bus — `tools/host-event-shim.js`
> is "test scaffolding only" (audit §6). You build the real bus and PROMOTE that shim to product code.
>
> Your task: (1) Build a host event-bus module on top of the host runtime: a registry of the CLOSED
> event vocabulary (the enum P2 added to the schema) that fires lifecycle signals through
> `fireIsolated()` — NOT the legacy `fire()` (which aborts the chain on the first throw; keep `fire()`
> for back-compat but make `fireIsolated()` the bus's dispatch call site). (2) Let mcp/agent/skill/
> command register reactions to lifecycle events (this converts mcp #12 from Declared-unimplemented to
> Defined). (3) Promote `tools/host-event-shim.js` from test scaffolding to product code as the bus's
> reference core. (4) Add tests including a multi-hook event where ONE hook throws and the others MUST
> still run (the DEFECT-1 behavior PA fixed, now exercised through the bus).
>
> Skills/tools you need: Node event dispatch, the HookLoader API (`scripts/hook-loader.ts`,
> `fireIsolated()`), the P4 host-runtime module, vitest.
> Files to read first: `scripts/hook-loader.ts` (the PA `fireIsolated()` method);
> `tools/host-event-shim.js`; `docs/engine-defects-found.md` (DEFECT-1); `docs/architecture-audit.md`
> (Gap A2, rec #11, §6); the P2 closed event enum in `schemas/extension/v1.json`; `analysis.md` row
> #12; `suggestions.md` item 5.
> Success criteria: the Phase 6 acceptance check above exits 0.
> Hard constraints: dispatch through `fireIsolated()`, never the abort-on-throw `fire()`. Do NOT remove
> `fire()` (back-compat). Capture `$?` directly; NEVER pipe a command whose exit code you test.
> `pnpm test` stays green.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/framework-contract-completion/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P6 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>` *(or `state: complete` if this
> is the last phase to finish — see Resumability & ownership)*.

---

## Phase A — DEFECT-1 `fireIsolated()` fix (pure engine) `[PARALLEL — no host dependency]`

**Phase ID:** PA
**Phase goal:** implement `fireIsolated()` in `scripts/hook-loader.ts` exactly as specified in
`docs/engine-defects-found.md` (continue-on-throw, collect `{id, error}` per hook), keep `fire()` for
back-compat, and update the two pinned KNOWN-DEFECT tests in `scripts/hook-isolation.test.ts` to assert
the new ISOLATED behavior. This is pure engine code with NO host dependency — it can land on day one in
parallel with P0; phase P6 consumes it.
**Inputs:** suggestions item 5 (the `5a` independent half); `docs/engine-defects-found.md` (DEFECT-1
fix spec, verbatim); analysis row #12 (`A+defect`); audit Gap A2 + rec #11; the two pinned tests in
`scripts/hook-isolation.test.ts`.
**Outputs:** `fireIsolated()` added to `scripts/hook-loader.ts` per the defect doc's signature
(`Promise<Array<{ id: string; error: unknown } | undefined>>`, continue past throws); `fire()`
unchanged; the two `// KNOWN-DEFECT` tests in `scripts/hook-isolation.test.ts` rewritten to assert that
hooks after a throwing hook DO execute.
**Acceptance check (deterministic)**
```bash
cd "$ROOT"
# the new method exists:
grep -q "fireIsolated" scripts/hook-loader.ts >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# legacy fire() retained for back-compat:
grep -q "fire(" scripts/hook-loader.ts >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# the pinned tests no longer assert the defect (the KNOWN-DEFECT marker is gone from the isolation test):
grep -q -i "KNOWN-DEFECT" scripts/hook-isolation.test.ts >/dev/null 2>&1; rc=$?; [ $rc -ne 0 ] || exit 1
# full suite green with the rewritten isolation tests:
pnpm -s test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
exit 0
```
**Green =** `fireIsolated()` exists and continues past a throwing hook, `fire()` is unchanged, the two
formerly-pinned KNOWN-DEFECT tests now assert isolated behavior (and no longer carry the marker), and
the full suite is green.

**Phase prompt:**

> You are an engine engineer in the `sox-ecosystem` monorepo (`$ROOT =
> /Users/nix/dev/ai/sox-ecosystem`; pnpm on PATH or at
> `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`). This phase is INDEPENDENT — it has no dependency
> on any other phase and can run on day one. It is pure engine code.
>
> THE DEFECT YOU ARE FIXING (DEFECT-1, audit Gap A2, MEDIUM — silent data loss): `HookLoader.fire()`
> in `scripts/hook-loader.ts` (around lines 109–116) iterates hooks with `for...of` + `await`; if one
> hook throws, the loop exits and EVERY later hook is silently skipped. `docs/engine-defects-found.md`
> specifies the fix VERBATIM: add a `fireIsolated()` variant that continues past a throwing hook and
> returns a per-hook result array `Promise<Array<{ id: string; error: unknown } | undefined>>`. Two
> tests in `scripts/hook-isolation.test.ts` are currently PINNED with `// KNOWN-DEFECT` and assert the
> buggy abort-on-throw behavior so the suite stays green.
>
> Your task: (1) Implement `fireIsolated()` in `scripts/hook-loader.ts` exactly as the defect doc
> specifies (continue-on-throw, collect `{id, error}` per failing hook, `undefined` per success). (2)
> KEEP the existing `fire()` semantics unchanged for backward compatibility (the defect doc explicitly
> recommends this). (3) Rewrite the two `KNOWN-DEFECT` tests in `scripts/hook-isolation.test.ts` to
> assert the NEW isolated behavior (hooks after a throwing hook DO run) and remove the `KNOWN-DEFECT`
> markers. Do NOT change `fire()`'s behavior.
>
> Skills/tools you need: TypeScript, async iteration semantics, vitest.
> Files to read first: `docs/engine-defects-found.md` (the full DEFECT-1 spec + recommended fix code);
> `scripts/hook-loader.ts`; `scripts/hook-isolation.test.ts`; `suggestions.md` item 5 (the
> independent `5a` half).
> Success criteria: the Phase A acceptance check above exits 0.
> Hard constraints: do NOT alter `fire()` semantics — add `fireIsolated()` alongside it. Capture `$?`
> directly; NEVER pipe a command whose exit code you test. `pnpm test` stays green.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/framework-contract-completion/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase PA complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>` *(or `state: complete` if this
> is the last phase to finish — see Resumability & ownership)*.

---

## Phase B — Per-extension config schema + resource/permission declaration `[PARALLEL · 11-manifest retrofit]`

**Phase ID:** PB
**Phase goal:** let each manifest declare a JSON Schema for its `config` block (validated against
scope-resolved config at install time) and a resource/permission declaration block (fs/network/socket
scopes); add both DECLARATIONS optional-first then retrofit the 11 manifests. The config-schema half
makes row #10 Defined; the permission half is declared here and ENFORCED by the host runtime (P4/P5).
**Inputs:** suggestions item 6; analysis row #10 + "parallel/order-independent" note + "Resource/
permission contract: Absent" universal hole; audit Gaps F3/F5/A6 + rec #10; the existing AJV machinery
(reused, not rebuilt); `extensions-config/v1.json` (currently accepts any object).
**Outputs:** a per-manifest `config`-schema declaration field in `schemas/extension/v1.json`; install-
time validation of scope-resolved config against the declared schema (closes Gap F3); a resource/
permission declaration block (fs/network/socket) in the schema; the 11 manifests retrofitted with
config schema + permission declarations where applicable; validator tests. NOTE: the permission
ENFORCEMENT (the host honoring declared bounds, e.g. sandboxing `db_path`, Gap F5) is performed by
P4/P5 — this phase ships the DECLARATION; coordinate so it does not sit Declared-unimplemented.
**Acceptance check (deterministic)**
```bash
cd "$ROOT"
# schema now declares a config-schema surface and a resource/permission block:
grep -q -i "config.\?schema\|permission\|resource" schemas/extension/v1.json; rc=$?; [ $rc -eq 0 ] || exit 1
# validator validates config against the declared schema and the 11 manifests pass:
pnpm -s validate-manifests >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
node bin/sox validate >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# enforcement is real: an extension whose config violates its declared schema must FAIL validation
# (test fixture lives in the validator test suite):
pnpm -s test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
exit 0
```
**Green =** each manifest can declare a config JSON Schema + a resource/permission block, scope-resolved
config is validated against the declared schema (a violating config fails), all 11 manifests are
retrofitted and pass, and the full suite is green.

**Phase prompt:**

> You are a schema/validation engineer in the `sox-ecosystem` monorepo (`$ROOT =
> /Users/nix/dev/ai/sox-ecosystem`; pnpm on PATH or at
> `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`). This phase is on the PARALLEL track — the
> analysis lists config schema + resource/permission as order-independent of the runtime chain. It does
> NOT block P0–P6 and can start early. Re-run `pnpm -s validate-manifests` first to confirm a clean
> baseline before you change the schema.
>
> THE CONTRACT GAPS YOU ARE CLOSING: row #10 (`scope config → applied config`) has cascade Defined but
> CONFIG-SCHEMA Absent — config cascades but is never validated; and "Resource/permission contract:
> Absent for all" — nothing declares or bounds fs/network/socket access (audit Gaps F3/F5/A6).
> `extensions-config/v1.json` currently accepts any object.
>
> Best-practice (suggestions item 6): REUSE the existing AJV + JSON Schema machinery already in the
> repo (used for manifests) — do not build a new validator. Let each manifest declare a JSON Schema for
> its `config` block; validate the scope-resolved config against it at install time. Add a resource/
> permission declaration block (fs/network/socket scopes). Follow the same optional-first → retrofit
> discipline used elsewhere in this engagement.
>
> Your task: (1) Add a per-manifest `config`-schema declaration field and a resource/permission block
> to `schemas/extension/v1.json` (optional-first). (2) Validate scope-resolved config against the
> declared schema at install time (closes Gap F3). (3) Retrofit the 11 manifests with config schema +
> permission declarations where applicable (the 11 paths: `extensions/bundles/sox-memory-bundle`,
> `extensions/commands/{memory-cli,status-command}`, `extensions/hooks/{memory-flush,audit-hook}`,
> `extensions/agents/{memory-organizer,echo-agent}`,
> `extensions/mcp-servers/{memory-server,hello-server}`, `extensions/prompts/greeting-prompt`,
> `extensions/skills/hello-world`). (4) Add a validator test with a fixture whose config VIOLATES its
> declared schema, asserting it fails. IMPORTANT: the permission ENFORCEMENT (host sandboxing the
> declared bounds, e.g. the unsandboxed `db_path` of Gap F5) is performed by the host runtime
> (P4/P5) — you ship the DECLARATION here; leave a clear note so P4/P5 wire the enforcement and it does
> not sit Declared-unimplemented.
>
> Skills/tools you need: JSON Schema, AJV, TypeScript, vitest.
> Files to read first: `schemas/extension/v1.json`; `extensions-config/v1.json` (or wherever config is
> schema'd); `scripts/validate-manifests.ts` + `.test.ts`; `scripts/install.ts` (config cascade/apply);
> `docs/architecture-audit.md` (Gaps F3/F5/A6, rec #10); `analysis.md` row #10; `suggestions.md` item 6.
> Success criteria: the Phase B acceptance check above exits 0.
> Hard constraints: REUSE AJV — do not add a new schema validator. Coordinate the permission
> enforcement hand-off with P4/P5. Capture `$?` directly; NEVER pipe a command whose exit code you
> test. `pnpm test` stays green.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/framework-contract-completion/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase PB complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>` *(or `state: complete` if this
> is the last phase to finish — see Resumability & ownership)*.

---

## Phase C — Bundle composition contracts: member-existence, version-conflict policy, provenance `[PARALLEL]`

**Phase ID:** PC
**Phase goal:** close the bundle-specific holes the analysis isolates — member-existence validation
(#5), version-conflict resolution policy with an OPERATOR-VISIBLE signal (#6, replacing silent
first-seen dedup), and bundle provenance in the lockfile (#3, so the bundle id is no longer erased
after expansion). Parallel track, scoped to bundle — no all-11-manifest schema change.
**Inputs:** suggestions item 7; analysis per-type deviation (bundle) + row #3 `D(mbr)/A(bundle id)`;
audit Gap A3 (silent first-seen dedup, MEDIUM); `scripts/install.ts` `expandBundles()` (lines 709–794);
the pinned collision tests in `scripts/bundle-collision.test.ts` (lines 120–163).
**Outputs:** member-existence validation in the validator (every bundle member id must resolve — row #5
bundle → Defined); `expandBundles()` replacing silent first-seen dedup with an explicit policy that
emits an operator-visible warning/error on conflicting member version specs (closes Gap A3, warn-first
then error mirroring the optional-first discipline); bundle provenance recorded per expanded member in
the lockfile (row #3 bundle-id → Defined); the two pinned collision tests in
`scripts/bundle-collision.test.ts` updated from "silent dedup" to "operator-visible conflict signal".
**Acceptance check (deterministic)**
```bash
cd "$ROOT"
# baseline validation passes:
pnpm -s validate-manifests >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
node bin/sox validate >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# the silent-dedup behavior is no longer pinned (the collision test no longer asserts silent first-seen):
grep -q -i "first-seen\|silent" scripts/bundle-collision.test.ts >/dev/null 2>&1; rc=$?
# (informational — not a gate; the real gate is the suite asserting the new operator-visible behavior)
# member-existence + provenance + conflict-signal tests pass within the full suite:
pnpm -s test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
exit 0
```
**Green =** the validator rejects a bundle naming a non-existent member, `expandBundles()` emits an
operator-visible signal on a version conflict (no longer silent), the lockfile records each member's
originating bundle id, the collision tests assert the new behavior, and the full suite is green.

**Phase prompt:**

> You are an install-client engineer in the `sox-ecosystem` monorepo (`$ROOT =
> /Users/nix/dev/ai/sox-ecosystem`; pnpm on PATH or at
> `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`). This phase is on the PARALLEL track — the
> analysis lists bundle composition contracts as order-independent of the runtime chain. It does NOT
> block P0–P6. Re-run `pnpm -s validate-manifests` and `pnpm -s test` first for a clean baseline.
>
> THE CONTRACT GAPS YOU ARE CLOSING (the "spine contracted / seam not" thesis does NOT reproduce for
> bundle — a bundle has no build and no runtime; its holes are install-time COMPOSITION): (a)
> member-existence is not validated (#5); (b) version conflicts are resolved by SILENT first-seen dedup
> in `expandBundles()` (audit Gap A3, MEDIUM) — currently PINNED as expected behavior in
> `scripts/bundle-collision.test.ts` lines 120–163; (c) the bundle id is ERASED after expansion, so the
> lockfile has no basis for "remove all members of this bundle" (#3 `A(bundle id)`).
>
> Best-practice (suggestions item 7): conflict detection must be EXPLICIT and OPERATOR-VISIBLE, not
> silent (the OPA precedent refuses overlapping bundles rather than silently picking one); composition
> references validated by id at parse time. Mirror this engagement's optional-first discipline:
> warn-first on conflict, then error.
>
> Your task: (1) MEMBER-EXISTENCE — make the validator assert every bundle member id resolves (row #5
> bundle → Defined). (2) VERSION-CONFLICT POLICY — replace the silent first-seen dedup in
> `scripts/install.ts` `expandBundles()` (lines 709–794) with an explicit policy that emits an
> operator-visible warning/error on conflicting member version specs (closes Gap A3). (3) BUNDLE
> PROVENANCE — record each expanded member's originating bundle id in the lockfile so an operator can
> remove all members of a bundle (row #3 bundle-id → Defined). (4) UPDATE the two pinned collision
> tests in `scripts/bundle-collision.test.ts` (lines 120–163) from "silent first-seen" to the new
> operator-visible-conflict behavior.
>
> Skills/tools you need: TypeScript, the install client internals, vitest.
> Files to read first: `scripts/install.ts` `expandBundles()` (around lines 709–794);
> `scripts/bundle-collision.test.ts` (lines 120–163); `scripts/validate-manifests.ts`;
> `docs/architecture-audit.md` (Gap A3); `analysis.md` (per-type deviation: bundle, + row #3);
> `suggestions.md` item 7.
> Success criteria: the Phase C acceptance check above exits 0.
> Hard constraints: warn-first then error on conflict (do not hard-fail existing installs without a
> warning stage). Scope this to bundle — do NOT change the all-11-manifest schema. Capture `$?`
> directly; NEVER pipe a command whose exit code you test. `pnpm test` stays green.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/framework-contract-completion/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase PC complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>` *(or `state: complete` if this
> is the last phase to finish — see Resumability & ownership)*.

---

## Resumability & ownership

**Resumability.** Every phase prompt begins by RE-RUNNING the prior acceptance check (and, for P6, also
the PA dependency check). A phase whose own acceptance check already exits 0 is complete — do not redo
it. A fresh agent can therefore pick up the engagement at any point by running the acceptance checks in
order and starting work at the first one that fails. All checks are deterministic (exit-code only,
`$?` captured directly, never piped).

**Dependency graph.**
```
PARALLEL (day one):  PA (fireIsolated)        PB (config+permission decl)     PC (bundle composition)
                       │                          │ (permission ENFORCEMENT half → P4/P5)
                       ▼                          ▼
CRITICAL CHAIN:  P0 (build, linchpin) → P1 (retire dist) → P2 (self-descr optional) →
                 P3 (retrofit 11 + flip required) → P4 (loader+supervisor #8) →
                 P5 (dispatcher/registrar/renderer #9) → P6 (event bus #12, consumes PA)
```
- **Critical path:** P0 → P1 → P2 → P3 → P4 → P5 → P6 (7 phases).
- **Parallel track:** PA, PB, PC (schedule from day one). Cross-edges: P6 REQUIRES PA (event bus
  dispatches through `fireIsolated()`); P4/P5 wire the ENFORCEMENT half of PB's permission declaration;
  P5's mcp registrar should gate `db_path` behind PB's permission contract.
- **11-manifest retrofit phases:** **P3** (self-description fields, with the optional→required flip) and
  **PB** (config schema + resource/permission declarations). These two are the blast-radius schema
  phases — they touch all 11 `extension.json` files + `scripts/validate-manifests.ts` + its tests. P2
  is the optional-first schema-addition precursor (no retrofit). PC is bundle-scoped (no all-11 change).

**The 11 manifests** (canonical list for the retrofit phases): `extensions/bundles/sox-memory-bundle`,
`extensions/commands/memory-cli`, `extensions/commands/status-command`, `extensions/hooks/memory-flush`,
`extensions/hooks/audit-hook`, `extensions/agents/memory-organizer`, `extensions/agents/echo-agent`,
`extensions/mcp-servers/memory-server`, `extensions/mcp-servers/hello-server`,
`extensions/prompts/greeting-prompt`, `extensions/skills/hello-world` (manifest file = `extension.json`).

**Completion rule.** The engagement is `complete` only when ALL TEN phases (P0–P6 + PA + PB + PC) are
green. Each phase's executor sets `state: executing` on completion EXCEPT the LAST phase to finish,
which sets `state: complete` instead. Determine "last" by inspecting `## State transitions` in
`status.md`: if appending your line makes all ten phase-complete lines present, you are the last
finisher — set `state: complete`. Only that final executor performs the `complete` transition; no other
phase may.

---

## Changelog

- **2026-06-08** — `workflow-planner` wrote migration.md (canonical_roi=qualitative-only, phases=10:
  P0–P6 critical chain + PA/PB/PC parallel track). Engagement advanced `suggested → planned`.
