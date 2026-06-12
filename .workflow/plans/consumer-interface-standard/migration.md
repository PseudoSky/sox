# Migration plan: a real, enforced consumer interface for sox-ecosystem

**Engagement:** `consumer-interface-standard`. Grounds:
[`analysis.md`](./analysis.md) (coverage map), [`suggestions.md`](./suggestions.md) (ranked S1–S6),
and the research finding `memory:extension-consumer-interface/consumer-interface-lifecycle-conformance.md`
(the ideal interface). MVP-first. Every phase has a **deterministic acceptance check** (commands that
exit 0 — no human judgment), a **Green =** line, and a **standalone executor prompt** a fresh agent
can run cold. Phases are **resumable**: each begins by re-running the prior phase's acceptance check.

Conventions: `$ROOT=/Users/nix/dev/ai/sox-ecosystem`. `pnpm` is at
`/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm` (use `pnpm` if on PATH, else that absolute path).
All checks runnable from `$ROOT`. Status file for completion steps:
`.workflow/plans/consumer-interface-standard/status.md`.

---

## Intro

- **Goal:** Give the ecosystem a real consumer interface and enforce it: a host CLI (`bin`) exposing
  the lifecycle verbs over the already-built install/cascade/validate/registry engine; a manifest
  self-description contract (optional-first, non-breaking) that `details`/doc-gen consume; a scaffolder
  that emits README/SKILL/CLAUDE + self-description so new extensions are born-conformant; a
  doc-lint / `validate --strict` CI gate (warnings → retrofit → fail-closed); multi-scope install UX
  (`-s user|project|local`) with source provenance; and closure of the unfalsified 4-scope-cascade +
  multi-tenant-collision testing gap. The 11 existing extensions are retrofitted to conform.
- **ROI:** **Qualitative-only** (canonical). The engine value (131 tests, proven cascade/install/
  bundle/validate engine) is currently **unreachable** by any consumer — S1 converts built-but-hidden
  value into a usable surface; that is the single highest-leverage move (suggestions S1: "ROI critical").
  Measurable sub-metrics where available: S6 closes **4 named untested behaviors** (full 4-scope
  cascade, same-event two-extension ordering through a real install, bundle-member first-seen-dedup
  collision, hook error isolation) → moves matrix rows from "Untested/Partial" to "proven"; S4 flip
  makes **11/11 extensions** pass `validate --strict` in CI. No throughput/latency metric applies.
- **Phases:** 8 (P0–P7).
- **Critical path:** `P0 → P1(CLI Tier-1 + scope vocab) → P2(schema fields, optional-first) →
  P3(scaffolder docs) → P4(doc-lint as warnings) → P5(retrofit 11) → P6(flip --strict + scope
  provenance UX)`. **P7 (4-scope/collision test track) is INDEPENDENT** — schedule early/parallel
  with P0–P1; it gates trust in the scope model and may surface latent engine bugs.
- **Current status:** planned (not started).

**State machine:** `suggested → planned → P0 → … → P7 → complete`. P7 may run in parallel with the
P0–P6 chain but the engagement is **not complete until both the chain and P7 are green**; whichever
finishes last performs the `state: complete` transition (see Resumability & ownership).

---

## Phase 0 — Build-substrate decision + `bin` skeleton (no verbs yet)

**Phase ID:** P0
**Phase goal:** resolve the src↔dist build ambiguity that would otherwise compound through every later
phase, and land an inert `bin` entrypoint that dispatches `--help`/`--version` and an unknown-verb
error — wired into the chosen build discipline, with zero behavior change to the engine.
**Inputs:** analysis §3.1 (no `bin`/host CLI); suggestions S1 (Tier-1 wraps proven engine); the
critical project fact that `dist/*.js` are HAND-MAINTAINED ESM mirrors of `src/` consumed directly by
tools/tests, while `pnpm -r build` compiles `src/` to a SEPARATE `dist/extensions/**` + `dist/scripts/**`
tree.
**Outputs:** a short `docs/cli-build-decision.md` (or an ADR block) stating the chosen discipline
(wire a real build for the CLI, OR keep hand-maintained mirrors) and the src↔dist sync rule; a
`bin/` entrypoint (e.g. `bin/sox` or a `bin` field in root `package.json`) that runs and prints
help/version; no new engine behavior.
**Verification:** acceptance check exits 0.

**Acceptance check (deterministic)**
```bash
cd "$ROOT"
test -f docs/cli-build-decision.md; rc=$?; [ $rc -eq 0 ] || exit 1
# bin entrypoint exists, runs, exits 0 on --help and --version (capture $? directly — never pipe):
node bin/sox --help >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
node bin/sox --version >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# unknown verb is a clean non-zero (not a crash/stacktrace path):
node bin/sox bogus-verb >/dev/null 2>&1; rc=$?; [ $rc -ne 0 ] || exit 1
# engine untouched: full test suite still green
pnpm -s test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
exit 0
```
**Green =** an inert host CLI runs, the build discipline is decided in writing, and the 131-test engine
is unchanged. No verb does real work yet — this de-risks the build/sync question before code accretes.

**Phase prompt:**

> You are a TypeScript build engineer onboarding cold to the `sox-ecosystem` pnpm monorepo at
> `/Users/nix/dev/ai/sox-ecosystem` (this is `$ROOT`; `pnpm` is on PATH or at
> `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`). The ecosystem's contract lives in
> `schemas/extension/v1.json` and `scripts/*.ts` (`install.ts`, `cascade.ts`, `validate-manifests.ts`,
> `new-extension.ts`, `build-index.ts`); it is proven by 131 tests. There is **no host CLI and no `bin`
> field anywhere** — a consumer today must hand-edit JSON and run `npx tsx scripts/install.ts`.
>
> CRITICAL build fact you must reconcile (it compounds otherwise): this repo has **no bundler and no
> single build step**. The runtime `dist/*.js` files (e.g. `dist/memory-lib.js`) are **hand-maintained
> ESM mirrors** of `src/`, and tools/tests import from `dist/` directly. SEPARATELY, `pnpm -r build`
> compiles `src/` into a DIFFERENT tree (`dist/extensions/**` + `dist/scripts/**`). These two `dist`
> notions do not agree. Before writing any CLI code you must DECIDE one discipline and write it down:
> either (a) wire a real build so the CLI is compiled and the hand-maintained mirrors are retired/
> reconciled, or (b) keep the hand-maintained-mirror discipline and document the exact src↔dist sync
> rule the CLI must follow. Record the decision and the sync rule in `docs/cli-build-decision.md`.
>
> Your task: (1) Investigate the two build paths above (read root `package.json` scripts, any
> `tsconfig*.json`, and how `dist/*.js` relate to `src/`), then write `docs/cli-build-decision.md` with
> the chosen discipline + src↔dist sync rule. (2) Add a host `bin` entrypoint at `bin/sox` (and/or a
> `bin` field in root `package.json`) that parses argv, prints help on `--help`, prints the version on
> `--version`, and on an unknown verb prints a one-line error and exits non-zero. It must run under the
> discipline you chose (if you chose a build, ensure `node bin/sox` works after build; if hand-mirror,
> keep it directly runnable). Do NOT implement any real verb yet — `install`, `list`, etc. are P1.
>
> Skills/tools you need: Node, pnpm, tsx, TypeScript module/build config, argv parsing.
> Files to read first: root `package.json`, `tsconfig*.json`, `scripts/install.ts` (top), one
> `dist/*.js` mirror vs its `src` counterpart, `suggestions.md` S1 in `$ROOT/.workflow/plans/consumer-interface-standard/`.
> Success criteria: the Phase 0 acceptance check above exits 0.
> Hard constraints: do NOT change any engine behavior — `scripts/*.ts` and `schemas/` are untouched and
> `pnpm test` stays green (131 tests). In acceptance checks, capture `$?` directly — NEVER pipe a
> command whose exit code you are testing (a pipe masks the real exit). The CLI is a thin front door;
> do not fork engine logic in this phase.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/consumer-interface-standard/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P0 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`.

---

## Phase 1 — Host CLI Tier-1 verbs (wrap the proven engine) + scope vocabulary

**Phase ID:** P1
**Phase goal:** the `bin` dispatches the minimal-complete verb subset — `install`, `uninstall`, `list`,
`validate`, `details` — each a thin adapter over the existing engine, and the `-s, --scope
<user|project|local>` vocabulary is decided and accepted by the scope-mutating verbs (rich provenance
output lands in P6). No engine fork.
**Inputs:** P0 (green); suggestions S1 Tier-1 (`install`/`uninstall`/`list`/`validate`/`details` are
pure adapters over `scripts/install.ts`, `scripts/cascade.ts`, `scripts/validate-manifests.ts`,
`registry/index.json`); S5 (decide the named-scope `-s` convention NOW even though provenance display
lands later); finding §1.3, §1.6, §6.1, §6.2.
**Outputs:** verb handlers wrapping (not forking) the four engine modules; `-s` flag parsing on
`install`/`uninstall` (default scope `user`, per finding §6.2); `validate` delegating to
`validate-manifests.ts`; `list` reading the resolved/lock state; `details <id>` rendering
`registry/index.json` + manifest fields; tests for the CLI adapter layer.
**Verification:** acceptance check exits 0.

**Acceptance check**
```bash
cd "$ROOT"
node bin/sox --help >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1   # P0 guard
# validate delegates to the proven validator and passes on the clean repo:
node bin/sox validate >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# list runs and exits 0 (capture $? directly; do not pipe):
node bin/sox list >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# details of a known extension exits 0 and names it; unknown id exits non-zero:
node bin/sox details hello-world >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
node bin/sox details no-such-ext >/dev/null 2>&1; rc=$?; [ $rc -ne 0 ] || exit 1
# the scope flag is accepted on install (dry/help form must not error on the flag itself):
node bin/sox install --help -s user >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# engine still proven:
pnpm -s test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
exit 0
```
**Green =** the five Tier-1 verbs work as adapters over the proven engine, the `-s user|project|local`
vocabulary parses, and the 131 engine tests plus the new CLI tests are green.

**Phase prompt:**

> You are a TypeScript CLI engineer in the `sox-ecosystem` monorepo (`$ROOT =
> /Users/nix/dev/ai/sox-ecosystem`; pnpm on PATH or at
> `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`). An inert `bin/sox` entrypoint and a written
> build discipline (`docs/cli-build-decision.md`) already exist (Phase 0). You are now adding the
> minimal-complete verb subset.
>
> Context you need cold: the install/cascade/validate engine is BUILT and proven (131 tests). Your
> verbs must **WRAP** these modules, never fork them: installing wraps `scripts/install.ts`; validation
> wraps `scripts/validate-manifests.ts`; the catalog is `registry/index.json`; cascade rules live in
> `scripts/cascade.ts`. The engine has exactly four scopes — `org`, `user`, `project`, `local`
> (`install.ts getScopePath()`). The research finding says named scopes beat `-g` and the convergent
> consumer vocabulary is `user|project|local` with default `user` (finding §1.3, §6.2). NOTE one
> engine subtlety: `install.ts` enters `singleScopeOnly` mode when `configPath` is passed
> (`install.ts:417`) — your CLI should drive real multi-scope resolution, not the single-scope test
> path, but do NOT change `install.ts` to do it. Honor whatever build/sync discipline
> `docs/cli-build-decision.md` recorded.
>
> Your task: implement five verbs on `bin/sox`, each a thin adapter: (1) `install [<id>] [-s
> user|project|local]` — invoke the existing install engine for the chosen scope (default `user`);
> (2) `uninstall <id> [-s …]`; (3) `list` — show installed extensions from the resolved/lock state
> (scope+source columns may be stubbed here; rich provenance is P6); (4) `validate [<path>]` — delegate
> to `validate-manifests.ts` and propagate its exit code; (5) `details <id>` — render the manifest +
> `registry/index.json` entry (exit non-zero on unknown id). Add `-s, --scope` parsing on the
> scope-mutating verbs with the `user|project|local` vocabulary and default `user`. Write CLI-layer
> tests. Do NOT implement `update`/`enable`/`disable`/`search` (later/out-of-scope).
>
> Skills/tools you need: Node, TypeScript, argv parsing, the ecosystem's `install.ts`/`cascade.ts`/
> `validate-manifests.ts` APIs, JSON rendering, vitest.
> Files to read first: `scripts/install.ts` (esp. `getScopePath`, the `singleScopeOnly` gate near
> line 417), `scripts/validate-manifests.ts`, `scripts/cascade.ts`, `registry/index.json`,
> `docs/cli-build-decision.md`, `suggestions.md` S1 + S5, the finding §1.3/§1.6/§6.1/§6.2.
> Success criteria: the Phase 1 acceptance check exits 0.
> Hard constraints: WRAP the engine — do NOT modify `scripts/install.ts`, `cascade.ts`, or
> `validate-manifests.ts` semantics, and do NOT fork their logic into the CLI (the engine is proven by
> 131 tests; the CLI is a thin front door). The scope vocabulary is named `user|project|local` (NOT
> `-g`). Default scope `user`. In acceptance checks capture `$?` directly — never pipe a command whose
> exit code you test. `pnpm test` must stay green.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/consumer-interface-standard/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P1 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`.

---

## Phase 2 — Manifest self-description contract (schema fields, OPTIONAL-FIRST)

**Phase ID:** P2
**Phase goal:** `schemas/extension/v1.json` gains the self-description / discovery fields a catalog and
an LLM agent need (`keywords`/`tags`, `author`, `homepage`, `repository`, optional per-component
`description`), **all optional**, so all 11 existing manifests + the 44 validator tests still pass
unchanged; `details` (from P1) renders the new fields when present.
**Inputs:** P1 (green); suggestions S2 (add fields optional-first; non-breaking; validator is the place
for advisory checks); analysis §3.4; finding §3.2, §3.3, §4.1, §6.3, §6.4.
**Outputs:** edited `schemas/extension/v1.json` with new OPTIONAL properties (and, if
`additionalProperties:false` is retained, the new keys declared so existing manifests validate);
`description` documented as dual human+LLM "use this when X" guidance; `bin/sox details` extended to
print the new fields when present; updated/added validator+schema tests proving the 11 manifests still
validate.
**Verification:** acceptance check exits 0.

**Acceptance check**
```bash
cd "$ROOT"
node bin/sox validate >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1   # P1 guard, repo still valid
# the schema declares the new self-description fields (assert presence, no pipe-to-grep exit masking):
node -e "const s=require('./schemas/extension/v1.json').properties; const need=['keywords','author','homepage','repository']; process.exit(need.every(k=>k in s)?0:1)"; rc=$?; [ $rc -eq 0 ] || exit 1
# ALL 11 existing manifests still validate (optional-first = non-breaking):
pnpm tsx scripts/validate-manifests.ts >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# the validator's 44 tests still pass (no required-field breakage):
pnpm -s test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
exit 0
```
**Green =** the schema now carries the self-description contract, every one of the 11 manifests still
validates (fields are optional), and the full test suite (incl. the 44 validator tests) is green.

**Phase prompt:**

> You are a schema/contract engineer in the `sox-ecosystem` monorepo (`$ROOT =
> /Users/nix/dev/ai/sox-ecosystem`; pnpm on PATH or
> `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`). The host CLI with Tier-1 verbs (`install`,
> `uninstall`, `list`, `validate`, `details`) already exists (Phase 1). You are adding a manifest
> self-description contract so `details` and (later) doc-gen have raw material to render.
>
> Context you need cold — this is a BLAST-RADIUS change. `schemas/extension/v1.json` is a CLOSED schema
> (`additionalProperties: false`, required = `$schema,id,version,type,title,description,compatibility,
> license`). There are exactly 11 extensions
> (`extensions/{skills/hello-world, mcp-servers/hello-server, agents/echo-agent, hooks/audit-hook,
> prompts/greeting-prompt, commands/status-command, mcp-servers/memory-server, agents/memory-organizer,
> hooks/memory-flush, commands/memory-cli, bundles/sox-memory-bundle}/extension.json`), all authored
> before any self-description standard. `scripts/validate-manifests.ts` has 44 tests. Because the schema
> is closed, ANY new field you add must be DECLARED in `properties` (so existing manifests still parse),
> and must be **OPTIONAL** (not added to `required`) — otherwise all 11 manifests and the 44 tests
> red-bar. Tightening to required happens later via the `--strict` CI gate, NOT here (finding §6.4
> "start with few required fields"). Long-form prose stays in README/SKILL files — the manifest gets
> identity + one-line guidance + discovery metadata only (finding §4.1 warns against prose-stuffing).
>
> Your task: (1) Add to `schemas/extension/v1.json` as OPTIONAL properties: `keywords` (string[]) and/or
> `tags`, `author` (object `{name, email?}` or string), `homepage` (uri), `repository` (uri/string),
> and an OPTIONAL per-component `description` where behavioral components are declared (finding §3.3 —
> the MCP `tools/list` → `description` model). Update the JSDoc/`description` of the existing top-level
> `description` field to state it is DUAL human + LLM invocation guidance ("use this when X"), not
> marketing copy (finding §3.3, §6.3). (2) Extend `bin/sox details` to print the new fields when
> present (and degrade gracefully when absent). (3) Add/extend tests proving all 11 manifests still
> validate. Do NOT add any new field to `required`. Do NOT retrofit the 11 manifests' content in this
> phase (that is P5).
>
> Skills/tools you need: JSON Schema (draft 2020-12), TypeScript, the validator's test harness, vitest.
> Files to read first: `schemas/extension/v1.json` (esp. `required` line 7 and `additionalProperties`
> line 6), `scripts/validate-manifests.ts`, one example manifest per type, `suggestions.md` S2, the
> finding §3.2/§3.3/§4.1/§6.3/§6.4.
> Success criteria: the Phase 2 acceptance check exits 0.
> Hard constraints: every new field is OPTIONAL (never added to `required`) — the change MUST be
> non-breaking so all 11 manifests + the 44 validator tests stay green. Keep manifest fields to
> identity + one-line guidance + discovery metadata; long-form prose belongs in README/SKILL (P3), not
> the manifest. Do not modify `install.ts`/`cascade.ts`. Capture `$?` directly in checks; never pipe a
> tested exit.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/consumer-interface-standard/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P2 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`.

---

## Phase 3 — Scaffolder generates README / SKILL / CLAUDE + self-description

**Phase ID:** P3
**Phase goal:** `scripts/new-extension.ts` emits type-specific doc stubs (README per extension;
SKILL.md for skills; CLAUDE.md/AGENTS.md guidance) and pre-fills the P2 self-description fields from
prompts/flags (`--description`, `--author`, `--keywords`), so a newly scaffolded extension is
born-conformant; a `bin/sox init`/`new` alias points at it.
**Inputs:** P2 (green — the fields the templates reference must exist first); suggestions S3 (extend the
existing scaffolder; pairs with S1's `init` alias; must land before the CI flip so S4 has conformant
output to validate); finding §1.1, §5.1, §6.4.
**Outputs:** template assets + scaffolder changes emitting README/SKILL/CLAUDE/AGENTS stubs + a
manifest pre-filled with P2 fields; a `bin/sox init <type> <id>` (or `new`) alias wrapping
`new-extension.ts`; a test that scaffolds a throwaway extension and asserts the docs + fields exist and
the result passes `validate-manifests.ts`.
**Verification:** acceptance check exits 0.

**Acceptance check**
```bash
cd "$ROOT"
node bin/sox validate >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1   # P2 guard
# scaffold a throwaway skill non-interactively into a temp area:
TMP="$ROOT/.tmp-scaffold"; rm -rf "$TMP"
node scripts/new-extension.ts skill scaffold-probe --description "use this when probing" --author "QA" --out "$TMP" >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# README + SKILL.md (skill type) are emitted:
test -f "$TMP/scaffold-probe/README.md"; rc=$?; [ $rc -eq 0 ] || exit 1
test -f "$TMP/scaffold-probe/SKILL.md"; rc=$?; [ $rc -eq 0 ] || exit 1
# the generated manifest carries the pre-filled self-description fields:
node -e "const m=require('$TMP/scaffold-probe/extension.json'); process.exit((m.description && (m.keywords||m.author))?0:1)"; rc=$?; [ $rc -eq 0 ] || exit 1
# the scaffolded extension validates against the schema:
pnpm tsx scripts/validate-manifests.ts "$TMP/scaffold-probe" >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
rm -rf "$TMP"
exit 0
```
**Green =** the scaffolder emits type-correct docs + a self-describing manifest that validates, so every
future extension is conformant by default (existing 11 are fixed in P5).

**Phase prompt:**

> You are a developer-tooling engineer in the `sox-ecosystem` monorepo (`$ROOT =
> /Users/nix/dev/ai/sox-ecosystem`; pnpm on PATH or
> `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`). The manifest schema now declares optional
> self-description / discovery fields (Phase 2: `keywords`, `author`, `homepage`, `repository`, plus a
> `description` reframed as "use this when X" guidance). You are upgrading the scaffolder so new
> extensions are born-conformant.
>
> Context you need cold: `scripts/new-extension.ts` already exists and runs interactive +
> non-interactive; today it generates 4 files/extension (3 for bundles) and NO docs — no README, no
> SKILL.md, no CLAUDE.md/AGENTS.md (analysis §1.7, §3.2, §3.3). The finding's "scaffold-first inverts
> the friction" principle (§6.4): if the scaffolder emits conformant docs + manifest by default, new
> extensions cost the author nothing to keep conformant. The doc stubs must be TYPE-SPECIFIC (a skill
> stub ≠ an MCP-server stub ≠ an agent stub — finding §5.4). Honor the build/sync discipline in
> `docs/cli-build-decision.md`.
>
> Your task: (1) Extend `scripts/new-extension.ts` to emit type-specific doc stubs: a `README.md` per
> extension; `SKILL.md` for skills; `CLAUDE.md`/`AGENTS.md` guidance where appropriate. (2) Pre-fill the
> P2 self-description fields in the generated `extension.json` from interactive prompts and
> non-interactive flags (`--description`, `--author`, `--keywords`, and support an `--out <dir>` so it
> can scaffold into a temp directory for tests). (3) Add a `bin/sox init <type> <id>` (or `new`) alias
> that wraps `new-extension.ts` (do not duplicate its logic). (4) Add a test that scaffolds a throwaway
> extension and asserts the docs exist, the manifest carries the fields, and it passes
> `validate-manifests.ts`. Keep generated prose as honest stubs with section headings (P4's doc-lint
> will later check they are non-placeholder) — do not ship lorem-ipsum that passes mere existence.
>
> Skills/tools you need: Node, TypeScript, templating, the existing `new-extension.ts` structure,
> vitest.
> Files to read first: `scripts/new-extension.ts`, `schemas/extension/v1.json` (the P2 fields),
> `docs/cli-build-decision.md`, an existing extension's layout per type, `suggestions.md` S3, the
> finding §1.1/§5.1/§5.4/§6.4.
> Success criteria: the Phase 3 acceptance check exits 0.
> Hard constraints: WRAP `new-extension.ts` from the CLI alias — do not fork the scaffolder. Do NOT
> retrofit the existing 11 extensions here (that is P5). Generated stubs must be type-specific and have
> real section structure (not placeholder filler) so P4's content lint can pass once authored. Do not
> modify `install.ts`/`cascade.ts`/the schema's `required`. Capture `$?` directly in checks; never pipe
> a tested exit.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/consumer-interface-standard/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P3 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`.

---

## Phase 4 — Doc-lint / DX-conformance rules as WARNINGS (fail-open)

**Phase ID:** P4
**Phase goal:** `scripts/validate-manifests.ts` gains advisory conformance rules (non-empty
`description`; present `keywords`; set `author`; README existence + non-placeholder content) that emit
**warnings only** (fail-open, exit 0) in the default mode, and a `--strict` flag exists that would
promote them to errors — but `--strict` is NOT yet wired into CI (that flip is P6, after the retrofit).
**Inputs:** P3 (green — conformant scaffolder output exists to lint against); suggestions S6/doc-lint
(the gate that makes S2/S3 stick; roll out fail-open first, then flip after retrofit); finding §5.1–§5.3
(error-vs-warning table), §5.2 (fail-open-in-dev / fail-closed-in-CI), §6.4.
**Outputs:** advisory rules in `validate-manifests.ts` emitting warnings in default mode and errors
under `--strict`; a `bin/sox validate --strict` path; tests asserting default mode exits 0 WITH
warnings on the (still-unretrofitted) 11, and that `--strict` exits non-zero on them; CI `validate.yml`
unchanged for now (no `--strict` step yet).
**Verification:** acceptance check exits 0.

**Acceptance check**
```bash
cd "$ROOT"
# P3 guard: scaffolder still emits a conformant extension
TMP="$ROOT/.tmp-scaffold"; rm -rf "$TMP"
node scripts/new-extension.ts skill scaffold-probe --description "use this when probing" --author "QA" --out "$TMP" >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
rm -rf "$TMP"
# default (fail-open) validate exits 0 EVEN THOUGH the 11 are not yet retrofitted:
node bin/sox validate >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
pnpm tsx scripts/validate-manifests.ts >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# --strict exits NON-ZERO now (the 11 lack descriptions/keywords/READMEs) — proves the gate has teeth:
node bin/sox validate --strict >/dev/null 2>&1; rc=$?; [ $rc -ne 0 ] || exit 1
# CI workflow does NOT yet run --strict (the flip is P6):
node -e "const fs=require('fs');const y=fs.readFileSync('.github/workflows/validate.yml','utf8');process.exit(y.includes('--strict')?1:0)"; rc=$?; [ $rc -eq 0 ] || exit 1
pnpm -s test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
exit 0
```
**Green =** conformance rules exist and warn (fail-open keeps the repo green), `--strict` provably has
teeth (non-zero on the un-retrofitted 11), and CI is deliberately NOT yet fail-closed.

**Phase prompt:**

> You are a CI/conformance engineer in the `sox-ecosystem` monorepo (`$ROOT =
> /Users/nix/dev/ai/sox-ecosystem`; pnpm on PATH or
> `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`). The schema declares optional self-description
> fields (Phase 2) and the scaffolder emits conformant docs + manifests (Phase 3). You are adding the
> doc-lint / DX-conformance rules — but in FAIL-OPEN posture only. You will NOT flip CI to fail-closed
> (that is Phase 6, and only after the 11 existing extensions are retrofitted in Phase 5 — flipping
> first would red-bar the whole repo).
>
> Context you need cold: today's `scripts/validate-manifests.ts` (729 lines, 44 tests) enforces 8 hard
> checks (schema, id format, type/dir match, version-sync, G-A/B/D/E, dedup, secret-in-config). It does
> NOT check description quality, keyword presence, author, or README existence (analysis §3.5). The
> finding's enforcement posture (§5.2) is **fail-open in dev, fail-closed in CI**: advisory fields
> (`description` empty, `keywords` missing, `author` unset, README missing/placeholder) are WARNINGS in
> default mode and ERRORS only under `--strict` (§5.3). Wrong-type / missing-required stay hard errors
> (already covered). The 11 existing extensions were authored before any DX standard, so they will fail
> `--strict` until Phase 5 retrofits them — that is expected and is WHY this phase stays fail-open.
>
> Your task: (1) Add advisory conformance rules to `validate-manifests.ts`: non-empty `description`;
> present `keywords`; set `author`; README existence + non-placeholder content (more than just file
> existence — reject empty/lorem stubs). (2) In DEFAULT mode these emit warnings and the process exits
> 0 (fail-open). (3) Add a `--strict` flag (and a `bin/sox validate --strict` path) that promotes those
> warnings to errors and exits non-zero. (4) Add tests asserting: default mode exits 0 with warnings on
> the current 11; `--strict` exits non-zero on the current 11; a freshly scaffolded (Phase-3)
> extension passes even `--strict`. (5) Do NOT add a `--strict` step to `.github/workflows/validate.yml`
> — leave CI fail-open this phase.
>
> Skills/tools you need: TypeScript, the validator's existing check/warning architecture, vitest, YAML
> (read-only inspection of the workflow).
> Files to read first: `scripts/validate-manifests.ts`, `.github/workflows/validate.yml`,
> `suggestions.md` S6 (doc-lint), the finding §5.1/§5.2/§5.3/§6.4.
> Success criteria: the Phase 4 acceptance check exits 0.
> Hard constraints: DEFAULT mode is fail-open (exit 0 with warnings) — do NOT make advisory rules hard
> errors in default mode. Do NOT wire `--strict` into CI in this phase (Phase 6 does that, post-retrofit;
> flipping now red-bars the repo). Wrong-type/missing-required stay hard errors. Do not modify
> `install.ts`/`cascade.ts`/the schema `required`. Capture `$?` directly; never pipe a tested exit.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/consumer-interface-standard/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P4 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`.

---

## Phase 5 — Retrofit all 11 existing extensions to conform

**Phase ID:** P5
**Phase goal:** every one of the 11 existing extensions gains the self-description fields (`description`
as "use this when X", `keywords`, `author`) and a non-placeholder README (plus SKILL/CLAUDE where the
type warrants), so all 11 pass `validate --strict` — clearing the path for the P6 fail-closed flip.
**Inputs:** P4 (green — the strict rules define exactly what "conform" means); suggestions S2/S6 blast
radius ("flipping to fail-closed requires retrofitting all 11"); the P3 scaffolder doc templates as the
content model.
**Outputs:** edited `extension.json` for all 11 (optional self-description fields filled) + a README per
extension (+ SKILL.md for skills, CLAUDE.md/AGENTS.md where type-appropriate), all authored (not
placeholder). The 11: `hello-world`, `hello-server`, `echo-agent`, `audit-hook`, `greeting-prompt`,
`status-command`, `memory-server`, `memory-organizer`, `memory-flush`, `memory-cli`, `sox-memory-bundle`.
**Verification:** acceptance check exits 0.

**Acceptance check**
```bash
cd "$ROOT"
node bin/sox validate >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1   # P4 guard (fail-open still green)
# THE retrofit assertion: --strict now passes across ALL 11 (it failed in P4):
node bin/sox validate --strict >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
pnpm tsx scripts/validate-manifests.ts --strict >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# every extension dir has a README:
node -e "const fs=require('fs'),p=require('path');const roots=['extensions/skills/hello-world','extensions/mcp-servers/hello-server','extensions/agents/echo-agent','extensions/hooks/audit-hook','extensions/prompts/greeting-prompt','extensions/commands/status-command','extensions/mcp-servers/memory-server','extensions/agents/memory-organizer','extensions/hooks/memory-flush','extensions/commands/memory-cli','extensions/bundles/sox-memory-bundle'];process.exit(roots.every(r=>fs.existsSync(p.join(r,'README.md')))?0:1)"; rc=$?; [ $rc -eq 0 ] || exit 1
pnpm -s test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
exit 0
```
**Green =** all 11 extensions now satisfy the strict conformance rules (`--strict` exits 0) and each has
a real README — the prerequisite for flipping CI fail-closed in P6.

**Phase prompt:**

> You are a documentation/conformance engineer in the `sox-ecosystem` monorepo (`$ROOT =
> /Users/nix/dev/ai/sox-ecosystem`; pnpm on PATH or
> `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`). The conformance rules exist as warnings, and a
> `validate --strict` mode would error on non-conformant extensions (Phase 4). Today, running
> `validate --strict` FAILS because the 11 existing extensions predate the DX standard. Your job is to
> retrofit all 11 so `--strict` passes.
>
> Context you need cold: there are exactly 11 extensions, at:
> `extensions/skills/hello-world`, `extensions/mcp-servers/hello-server`, `extensions/agents/echo-agent`,
> `extensions/hooks/audit-hook`, `extensions/prompts/greeting-prompt`,
> `extensions/commands/status-command`, `extensions/mcp-servers/memory-server`,
> `extensions/agents/memory-organizer`, `extensions/hooks/memory-flush`,
> `extensions/commands/memory-cli`, `extensions/bundles/sox-memory-bundle`. Each has an `extension.json`.
> The schema fields added in Phase 2 are OPTIONAL; the `--strict` rules from Phase 4 require non-empty
> `description` (written as "use this when X" guidance, not marketing — finding §3.3/§6.3), present
> `keywords`, set `author`, and a non-placeholder README. The Phase-3 scaffolder's doc templates are
> your content model — mirror their structure. Honor `docs/cli-build-decision.md` for any src↔dist sync.
>
> Your task: for EACH of the 11 extensions, (1) fill the optional self-description fields in its
> `extension.json` (`description`, `keywords`, `author`, and `homepage`/`repository` where known); (2)
> author a real `README.md` (not lorem) describing what it is and when to use it; (3) add `SKILL.md` for
> the skill and `CLAUDE.md`/`AGENTS.md` where the type warrants, matching the Phase-3 templates. Write
> accurate, specific content for each — these are real extensions (the memory tenant is end-to-end
> proven; the six examples are reference extensions). Keep every manifest version synced to its
> package.json (existing CI invariant). Do NOT change any extension's behavior or entrypoints — this is
> a docs+metadata retrofit only.
>
> Skills/tools you need: technical writing, JSON editing, reading each extension's source to describe it
> accurately, the validator.
> Files to read first: each of the 11 `extension.json` + its source, the Phase-3 doc templates,
> `scripts/validate-manifests.ts` (the `--strict` rules), `suggestions.md` S2/S6, the finding §3.3/§6.3.
> Success criteria: the Phase 5 acceptance check exits 0 — `validate --strict` passes across all 11 and
> each has a README.
> Hard constraints: docs+metadata only — do NOT change behavior, entrypoints, or versions out of sync
> with package.json. READMEs must be real content (P4's content lint rejects placeholders). Keep all new
> manifest fields optional in the schema (do not promote to `required` — that is the host's choice via
> `--strict`, not a schema change). Do not modify `install.ts`/`cascade.ts`. Capture `$?` directly;
> never pipe a tested exit.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/consumer-interface-standard/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P5 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`.

---

## Phase 6 — Flip `validate --strict` in CI (fail-closed) + scope-provenance UX

**Phase ID:** P6
**Phase goal:** `.github/workflows/validate.yml` runs `validate --strict` as a merge-blocking step (now
safe because all 11 conform), and the multi-scope UX is completed — `list` shows scope + source columns
and `details` shows provenance, answering "which scope did this come from?".
**Inputs:** P5 (green — all 11 pass `--strict`); suggestions S6 (flip after retrofit) + S5 (named-scope
provenance display; `list` must always show scope+source; default-scope parity across
install/update/uninstall to avoid the §2.3 foot-guns); finding §2.1, §2.2, §5.2, §6.2.
**Outputs:** a `validate --strict` step added to `validate.yml`; `bin/sox list` with mandatory
scope+source columns; `bin/sox details <id>` showing source provenance; tests for the provenance output;
CI now fail-closed on conformance.
**Verification:** acceptance check exits 0.

**Acceptance check**
```bash
cd "$ROOT"
node bin/sox validate --strict >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1   # P5 guard: 11 conform
# CI now runs --strict (the deliberate flip):
node -e "const fs=require('fs');const y=fs.readFileSync('.github/workflows/validate.yml','utf8');process.exit(y.includes('--strict')?0:1)"; rc=$?; [ $rc -eq 0 ] || exit 1
# list shows scope + source columns (machine-checkable header/JSON):
node bin/sox list --json >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
node -e "const {execSync}=require('child_process');const out=execSync('node bin/sox list --json',{cwd:process.cwd()}).toString();const j=JSON.parse(out);process.exit((Array.isArray(j)&&(j.length===0||('scope' in j[0] && 'source' in j[0])))?0:1)"; rc=$?; [ $rc -eq 0 ] || exit 1
# details surfaces provenance for a known extension:
node bin/sox details hello-world >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
pnpm -s test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
exit 0
```
**Green =** CI is fail-closed on conformance with all 11 green, and the four-scope model is a usable,
debuggable surface (`list` shows scope+source; `details` shows provenance) — no silent scope shadowing.

**Phase prompt:**

> You are a CLI/CI engineer in the `sox-ecosystem` monorepo (`$ROOT =
> /Users/nix/dev/ai/sox-ecosystem`; pnpm on PATH or
> `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`). The conformance rules exist (`validate --strict`,
> Phase 4) and all 11 extensions now pass `--strict` after retrofit (Phase 5). You are (a) flipping CI
> to fail-closed and (b) completing the multi-scope UX with scope provenance.
>
> Context you need cold: the engine has four scopes — `org`, `user`, `project`, `local` (`install.ts
> getScopePath()`). The CLI's scope vocabulary (`-s user|project|local`, default `user`) was decided in
> Phase 1; this phase makes scope+source VISIBLE. The finding's most common multi-scope debugging
> question is "which scope did this come from?" (§2.2), and the anti-pattern is silent scope shadowing —
> the fix is that `list` ALWAYS shows scope and source (§2.2), and `install`/`update`/`uninstall` share
> a default scope to avoid the §2.3 foot-guns. The conformance flip is only safe NOW because Phase 5
> made all 11 conform; doing it earlier would red-bar CI. Honor `docs/cli-build-decision.md`.
>
> Your task: (1) Add a `validate --strict` step to `.github/workflows/validate.yml` that blocks merge
> on any conformance error (it is now safe — all 11 pass). (2) Make `bin/sox list` ALWAYS show scope +
> source per entry (human columns AND a `--json` form whose objects carry `scope` and `source` keys).
> (3) Make `bin/sox details <id>` show source provenance (which scope/source the extension resolved
> from). (4) Confirm `install`/`uninstall` (and `update` if present) share the same default-scope logic
> (finding §2.3). (5) Add tests for the provenance output. Derive scope/source from the engine's
> resolved/cascade state — do NOT fork the cascade.
>
> Skills/tools you need: Node, TypeScript, the engine's cascade/resolution APIs (`install.ts`,
> `cascade.ts`), GitHub Actions YAML, JSON output, vitest.
> Files to read first: `.github/workflows/validate.yml`, `scripts/install.ts` (`getScopePath`, cascade
> resolution), `scripts/cascade.ts`, `bin/sox` (P1 `list`/`details`), `suggestions.md` S5/S6, the
> finding §2.1/§2.2/§2.3/§5.2/§6.2.
> Success criteria: the Phase 6 acceptance check exits 0.
> Hard constraints: `list` MUST always surface scope + source (no silent shadowing). The CI `--strict`
> flip is safe ONLY because Phase 5 retrofitted all 11 — confirm `validate --strict` is green locally
> before adding the CI step. Read scope/source from the engine's resolution — do NOT modify
> `install.ts`/`cascade.ts` semantics. Capture `$?` directly; never pipe a tested exit.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/consumer-interface-standard/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P6 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`. *If the independent test
> track (P7) is already complete at this point, set `state: complete` instead (see Resumability &
> ownership for the last-finisher rule).*

---

## Phase 7 — Close the 4-scope cascade + multi-tenant collision testing gap (INDEPENDENT)

**Phase ID:** P7
**Phase goal:** prove the four behaviors the current harness leaves unfalsified — full 4-scope
simultaneous cascade (NOT `singleScopeOnly`); two extensions in one scope binding the same lifecycle
event through a real install; bundle-member version conflict across two bundles (`expandBundles()`
first-seen dedup); and hook error isolation — with real integration tests. This track is INDEPENDENT of
the CLI and should run early/parallel with P0–P1.
**Inputs:** suggestions S4 (test-only, independent, run early; gates trust in the scope model S1/S5
expose; may surface latent `expandBundles()` dedup or hook-isolation bugs — flagged as a possible scope
expansion); analysis §2 (the four named unfalsified behaviors; `install.ts:417` `singleScopeOnly`
gate); finding §2.2, §2.3; `scripts/hook-loader.ts:113` ("callers should wrap" — no test).
**Outputs:** a real multi-scope fixture harness exercising default-path org+user+project+local
simultaneously (bypassing `singleScopeOnly`); new tests for: 4-scope cascade, same-event two-extension
ordering through a real install, two-bundle same-member collision, hook error isolation; if a latent
engine bug is found, a written defect note (see hard constraints).
**Verification:** acceptance check exits 0.

**Acceptance check**
```bash
cd "$ROOT"
# the four new test areas must exist and pass (names illustrative; assert files + green run):
node -e "const fs=require('fs');const f=['scripts/install-multiscope.test.ts','scripts/bundle-collision.test.ts','scripts/hook-isolation.test.ts'];process.exit(f.every(x=>fs.existsSync(x))?0:1)"; rc=$?; [ $rc -eq 0 ] || exit 1
# full suite (old 131 + the new integration tests) green:
pnpm -s test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# explicit proof the multi-scope path (not singleScopeOnly) is exercised — the new tests must NOT all set configPath:
node -e "const fs=require('fs');const t=fs.readFileSync('scripts/install-multiscope.test.ts','utf8');process.exit(/4.?scope|org.*user.*project.*local/i.test(t)?0:1)"; rc=$?; [ $rc -eq 0 ] || exit 1
exit 0
```
**Green =** the four previously-unfalsified behaviors are now under real multi-scope integration tests
and the full suite passes — the scope model the CLI exposes is proven, not just claimed.

**Phase prompt:**

> You are a test/integration engineer in the `sox-ecosystem` monorepo (`$ROOT =
> /Users/nix/dev/ai/sox-ecosystem`; pnpm on PATH or
> `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`). This is an INDEPENDENT track — it does not depend
> on the host-CLI phases and can run in parallel with them. Your job is to falsify (with real tests)
> four behaviors the existing 131-test suite leaves unproven.
>
> Context you need cold (all from analysis §2): every existing `install()` test passes `configPath`,
> which trips `singleScopeOnly=true` at `scripts/install.ts:417` — so the REAL multi-scope path
> (org+user+project+local loaded simultaneously from default paths) has NEVER been integration-tested.
> Four specific behaviors are unfalsified: (a) full 4-scope simultaneous cascade; (b) two extensions in
> one scope binding the SAME lifecycle event, ordered through a real install cycle (hook ordering is
> tested only in isolation today); (c) bundle-member version conflict — two bundles listing the same
> member with different ranges; `expandBundles()` (`install.ts` ~709–794) dedups FIRST-SEEN and the
> behavior is unspecified/untested; (d) hook error isolation — `scripts/hook-loader.ts:113` says
> "callers should wrap" but no test exercises it.
>
> Your task: (1) Build a real multi-scope fixture harness that drives org+user+project+local from
> isolated default-style paths WITHOUT setting `configPath` (i.e. exercise the non-`singleScopeOnly`
> path) — use a temp HOME/cwd sandbox so the suite stays hermetic. (2) Write integration tests for the
> four behaviors above. For the bundle-collision case (c), ASSERT the current first-seen-dedup behavior
> explicitly (pin it as the spec) and document it; do not silently change it. (3) For hook error
> isolation (d), assert that one failing hook does not abort the others (or, if it does, pin the actual
> behavior and flag it). (4) If any test reveals the engine behavior is actually WRONG (e.g. first-seen
> dedup is incorrect, or hooks are not isolated), do NOT fix the engine in this engagement — write a
> defect note to `docs/engine-defects-found.md` describing the failing case and pin the test to the
> current (buggy) behavior with a clearly-marked `// KNOWN-DEFECT` comment so the suite stays green and
> the defect is recorded for a follow-on engagement.
>
> Skills/tools you need: vitest, temp-dir/HOME sandboxing, the install/cascade/bundle/hook-loader
> source, fixture authoring.
> Files to read first: `scripts/install.ts` (esp. the `singleScopeOnly` gate near line 417 and
> `expandBundles()` ~709–794), `scripts/cascade.ts`, `scripts/hook-loader.ts` (esp. line 113),
> `scripts/install.test.ts` and `scripts/hook-loader.test.ts` (the existing harness patterns),
> `analysis.md` §2, `suggestions.md` S4, the finding §2.2/§2.3.
> Success criteria: the Phase 7 acceptance check exits 0.
> Hard constraints: TEST-ONLY — do NOT modify `install.ts`, `cascade.ts`, `hook-loader.ts`, the schema,
> or any manifest behavior. If you find a real bug, RECORD it (defect note + `// KNOWN-DEFECT` pinned
> test) rather than fixing it here — a source fix is a separate engagement's scope (suggestions S4 flags
> this as a possible scope expansion). Tests must be hermetic (sandbox HOME/cwd; no machine-global
> writes). The old 131 tests must stay green. Capture `$?` directly; never pipe a tested exit.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/consumer-interface-standard/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P7 complete (executor: <your role>)`
> Update frontmatter: `last_event: <ISO timestamp>`. Set `state: executing` UNLESS the P0–P6 chain is
> already complete, in which case P7 is the last finisher — set `state: complete` (see Resumability &
> ownership).

---

## Resumability & ownership

- **Resume guard:** each phase's first acceptance-check command re-runs the prior phase's core
  assertion (red→green guard). On red, the executor repairs forward — never silently skips.
- **Critical path vs. parallel track:** P0→P1→P2→P3→P4→P5→P6 is the strict dependency chain (each phase
  consumes the prior). **P7 is independent** (test-only; touches no schema/manifest/source) and should
  be scheduled EARLY/parallel — it gates trust in the scope model P1/P6 expose.
- **Last-finisher completion rule:** the engagement is `complete` only when BOTH the P6 chain and P7 are
  green. Whichever of {P6, P7} transitions last sets `state: complete`; the earlier finisher sets/leaves
  `state: executing`. Each phase prompt's completion step encodes this conditional. No phase other than
  the genuine last finisher may set `complete`.
- **File ownership (no file written by two phases):** P0 owns `bin/` skeleton + `docs/cli-build-decision.md`;
  P1–P6 own `bin/sox` verb handlers (additively); P2 owns `schemas/extension/v1.json` (optional fields
  only); P3 owns `scripts/new-extension.ts` + doc templates; P4 owns the validator's advisory rules; P5
  owns the 11 extensions' docs+metadata; P6 owns `.github/workflows/validate.yml` (`--strict` step) +
  `list`/`details` provenance; P7 owns the new multi-scope test files + any `docs/engine-defects-found.md`.
- **Non-breaking discipline (heeded throughout):** schema fields are OPTIONAL-FIRST (P2) so the 11
  manifests + 44 validator tests stay green; the doc-lint lands as WARNINGS (P4) → retrofit (P5) → flip
  fail-closed (P6) so CI never red-bars the repo before the retrofit. The CLI WRAPS the proven engine
  (`install.ts`/`cascade.ts`/`validate-manifests.ts`/`new-extension.ts`/`build-index.ts`) and never
  forks it (131 tests remain the source of truth).
- **Build/sync residual (flagged in P0):** the hand-maintained `dist/*.js` mirrors vs `pnpm -r build`'s
  `dist/extensions|scripts/**` tree are reconciled by the P0 decision; every later CLI/codegen phase
  honors `docs/cli-build-decision.md`.
- **Possible scope expansion (from suggestions S4):** if P7 finds `expandBundles()` first-seen dedup or
  hook isolation is actually wrong, that is a source fix OUTSIDE this engagement — recorded as a defect
  note + pinned test, promoted to a follow-on engagement (and may warrant a `workflow-researcher` run on
  bundle-member version-conflict resolution policy, which the finding does not prescribe).
- **Deliberately out of scope (per suggestions "Filtered out"):** remote registry HTTP API / `search`
  server, Layer-3 LLM-judge eval, second-tenant onboarding automation, and `update`/`enable`/`disable`/
  `prune` verbs beyond the Tier-1 subset. The `-s` vocabulary is forward-compatible with them.

---

## Changelog

- **2026-06-08** — Initial plan. 8 phases (P0–P7). Honors the optimizer's sequencing: S1 (host CLI)
  first (P0 build-decision + P1 Tier-1 verbs + scope vocab); S2 schema fields optional-first (P2) before
  S3 scaffolder docs (P3); doc-lint as warnings (P4) → retrofit all 11 (P5) → flip `--strict` fail-closed
  + scope provenance UX (P6); S6 4-scope/collision test track (P7) independent/parallel. Every phase
  carries a deterministic acceptance check (exit-code only, no pipes on tested exits), a Green= line, a
  standalone executor prompt, and the mandatory status-update step. Canonical ROI set to
  `qualitative-only`.
