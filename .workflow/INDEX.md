---
churn_baseline: 100
relevancy_formula: roi_score / (1 + churn_files / churn_baseline)
exclude_paths: [".workflow/", ".forge/", ".cto/", "docs/", ".claude/", ".gitnexus/"]
roi_scale: { low: 1, med: 2, high: 3, critical: 5 }
---

# Workflow plans — sox-ecosystem

> Relevancy note: `.workflow/` at repo root; commit history exists (P0→P6 + P7→P11). `canonical_roi`
> is `qualitative-only` (greenfield, no baseline), so relevancy stays `qual` by design.
> `provisional_roi` is `high`. One open engagement (`permission-enforcement`, planned — closes the last
> DoD item C6); five complete. The nx migration met the DoD to **22/23**; C6 is now planned. Memory
> semantic depth remains the explicit non-goal / next frontier.

## Open   (sorted by relevancy desc)

| Slug | Objective | State | ROI | Churn | Relevancy | Updated |
|---|---|---|---|---|---|---|
| [permission-enforcement](#permission-enforcement) | Close the last DoD item — runtime enforcement of declared `permissions` (C6) + consolidate the migration's duplicate `scripts/host/` | planned | high (prov) | n/a | qual | 2026-06-12 |

## Closed   (chronological, newest first)

| Slug | Objective | State | ROI | Closed |
|---|---|---|---|---|
| [nx-migration](#nx-migration) | Adopted Nx + self-hosted `sox` as extension #0 — born-conformant authoring (all types) + scaled build; **14 states green, DoD met (architect-verified)** | complete | high (prov) | 2026-06-12 |
| [framework-contract-completion](#framework-contract-completion) | Built the runtime the framework lacked — framework build subsystem + host runtime + enforced per-type contracts; **10 phases green, 256→377 tests** | complete | critical (prov) | 2026-06-08 |
| [consumer-interface-standard](#consumer-interface-standard) | Affordance layer — host CLI + multi-scope lifecycle + self-description contract + DX-conformance CI; **8 phases green, 131→256 tests** | complete | critical (prov) | 2026-06-08 |
| [sox-memory](#sox-memory) | First ecosystem tenant — agent graph-memory subsystem, built on native v2 primitives; **all 6 phases green** | complete | high (prov) | 2026-06-08 |
| [sox-ecosystem](#sox-ecosystem) | LLM-extension ecosystem — v1 built + v2 gap-closure built & verified | complete | high (prov) | 2026-06-07 |

---

## Open engagements (detail)

### permission-enforcement
- **Objective:** Close the final open DoD requirement — **C6: declared `permissions` enforced at runtime, not merely validated** — on the nx foundation (`feat/nx-migration`).
- **Plan** (conforming plan-state-machine; **`gap-check --discover` green, exit 0**): **8 states** — consolidate-legacy → policy-core → *audit-foundation* → {process-boundary ∥ inproc-policy} → mcp-path-guard → *audit-enforcement* → *audit-final* → done.
- **DoD:** positive (declared access works) **AND the required negative check** — undeclared fs/socket access is **blocked, verified against reality** (spawn the real server, attempt a forbidden `db_path`, assert denied + file absent); no regressions. Per-type: **HARD** for spawned types (mcp-server/shell/python — process env-scrub + fs allowlist before the sink), **SOFT** (declare + audit, no OS isolation — declared non-goal) for in-process/declarative. Reviewer = founder.
- **Bonus cleanup:** `consolidate-legacy` removes the **duplicate legacy `scripts/host/`** the nx migration left behind (gitnexus-verified supersession by `libs/host-runtime`) — a migration loose end the DoD audit didn't catch.
- **Execution:** `typescript-pro` executors, resumable hand-off (automatic-dispatch=no). Builds on `feat/nx-migration` (not merged to `main`).
- **Files:** [README](./plans/permission-enforcement/README.md) · [dag.json](./plans/permission-enforcement/dag.json) · [state.json](./plans/permission-enforcement/state.json) · [state-machine](./plans/permission-enforcement/state-machine.md) · [final-review](./plans/permission-enforcement/final-review.md) · [status](./plans/permission-enforcement/status.md) · [session](./plans/permission-enforcement/session.md)

---

## Closed engagements (detail)

### nx-migration
- **Objective:** Adopt Nx for the undifferentiated monorepo/build/generator layer (novel layer stays custom); make `sox` a **literal self-hosted extension #0**; deliver born-conformant authoring + scaled build so many extensions of every type can be added rapidly.
- **Outcome:** **complete (2026-06-12).** All **14 plan-state-machine states** green on branch `feat/nx-migration` (base tag `pre-nx-baseline`); **DoD met to the D5 scope, architect-verified** (final audit exit 0, 344 tests, C7 reach-in zero, `nx build,lint` 13/13). Highlights: nx workspace + module-boundary lint; `libs/manifest` with the contract flexes (entrypoint-optional, runtime node/shell/python/declarative, install-target); `libs/authoring` pure `scaffold()` core (nx-free) + `@sox/nx` thin generators + **born-conformance & byte-identical parity gates**; engine libs ported with **A12 flag-parser fixed** + session fixes carried forward from the baseline tag; `apps/sox` = conformant `command` extension #0; **`libs/memory-core` extracted, cross-extension reach-in eliminated (C7)**; CI on `nx affected` + `nx release --dry-run` + commitlint; per-type docs + `docs/per-type-shapes.md`. type-discovery confirmed the real corpus is declarative/multi-runtime — the flexes already covered it (no schema change).
- **Process notes:** two audit gates initially failed on a *systemic audit-script bug* (absolute `/.tmp-*` from unset `$ROOT` + ids ending in type name) — caught by the architect's **independent** audit runs, fixed as `fix-guard` amendments (assertions preserved). The `ci-release` executor crashed mid-state and was recovered from partial on-disk work.
- **Decision/strategy:** [`docs/decisions/0001-nx-and-self-hosting.md`](../docs/decisions/0001-nx-and-self-hosting.md) · [`docs/plans/nx-self-hosting-migration.md`](../docs/plans/nx-self-hosting-migration.md). **Bar:** `DOD.md`.
- **Out of scope (next frontier):** **C6** runtime permission enforcement; memory semantic depth (embeddings/LLM organizer). All work uncommitted to `main` — lives on `feat/nx-migration`, pending review/merge.
- **Artifacts:** [README](./plans/nx-migration/README.md) · [dag.json](./plans/nx-migration/dag.json) · [state.json](./plans/nx-migration/state.json) · [state-machine](./plans/nx-migration/state-machine.md) · [final-review](./plans/nx-migration/final-review.md) · [status](./plans/nx-migration/status.md) · [session](./plans/nx-migration/session.md) · deprecated: `migration.legacy.md`

### framework-contract-completion
- **Objective:** Implement the framework contracts the per-type guideline set proved missing — the build → activation → consumption → eventing seam — so an installed extension of any type actually runs and tenants can no longer diverge silently.
- **Outcome:** **complete (2026-06-08).** All 10 phases green; **256 → 377 tests.** The framework now owns the runtime it previously lacked. **P0** framework build subsystem (per-package `tsconfig` + `pnpm -r build` emitting every `dist/index.js`) + entrypoint-reachability gate → **P1** retired the hand-maintained `dist/` mirrors and repointed all importers to generated output (closing the #4 linchpin; reverses `docs/cli-build-decision.md`) → **P2/P3** per-type manifest self-description (`events`/`invocation`/`tools`/`parameters`/`run_interface`) added optional-first, all 11 retrofitted with source-accurate content, then enforced (error-severity) → **P4** host runtime (`scripts/host/`: lockfile loader + productized supervisor + per-type adapters) → **P5** consumption side (MCP registrar doing `initialize`+`tools/list` → agent surface; prompt renderer; real `bin/sox` `enable`/`disable`/`search`/`update`; config-schema validation enforced at activation) → **P6** host event bus dispatching via `fireIsolated()`. **Parallel:** PA `fireIsolated()` (**DEFECT-1 resolved**) · PB `config_schema`+`permissions` (11 retrofitted) · PC bundle member-existence + version-conflict signal + lockfile provenance.
- **Capstone proof:** the *built* `extensions/mcp-servers/memory-server/dist/index.js` (framework-generated, not `src` via `tsx`) runs and returns all 7 `memory_*` tools over MCP — the declared entrypoint now resolves to a real artifact AND executes. `installed → running` is closed.
- **Residual (noted, not blocking):** full OS-level runtime sandboxing of `permissions.{fs,network,socket}` is logged/advisory at activation; hard process-boundary isolation deferred to a future phase. All changes uncommitted, pending review.
- **Provenance:** guideline set (`docs/guidelines/*.md`, template-driven) + `docs/architecture-audit.md` → workflow-analyzer (consolidated 12×7 matrix) → workflow-optimizer → workflow-planner (10-phase) → typescript-pro executors (PA/PB/PC parallel, P0→P6 serial with a verified P0→P1 checkpoint).
- **Related plans:** [`consumer-interface-standard`](#consumer-interface-standard) — the CLI front-door this runtime sits beneath; [`sox-memory`](#sox-memory) — first tenant, now actually runnable via the generated build.
- **Artifacts:** [analysis](./plans/framework-contract-completion/analysis.md) · [suggestions](./plans/framework-contract-completion/suggestions.md) · [migration](./plans/framework-contract-completion/migration.md) · [status](./plans/framework-contract-completion/status.md) · [session](./plans/framework-contract-completion/session.md) · target: `docs/guidelines/` · gap: `docs/architecture-audit.md`

### consumer-interface-standard
- **Objective:** Define and enforce a consumer-interface standard — ship installs across global/user/project scopes for the full extension lifecycle (create, search, install, configure, usage), with every extension made to conform through the schema, scaffolder, linter, and CI.
- **Outcome:** **complete (2026-06-08).** All 8 phases green; the ecosystem now has a front door. **P0** src↔dist build decision (hand-maintained mirror, no bundler) + `bin/sox` → **P1** Tier-1 verbs (install/uninstall/list/validate/details) wrapping the proven engine + named scopes (`-s user|project|local`) → **P2** manifest self-description fields (`keywords`/`homepage`/structured `author`/dual-purpose `description`), optional-first so all 11 manifests stayed valid → **P3** scaffolder emits per-type README/SKILL/CLAUDE + `sox init` → **P4** doc-lint (4 DX rules) as warnings → **P5** retrofit all 11 extensions (11 READMEs + 5 type-docs + manifest fields) → **P6** CI flipped to `validate --strict` (fail-closed) + scope-provenance (`list --json`, `details installed-in:`). **P7** (independent) added 22 tests exercising the real 4-scope cascade, bundle-member collision, and hook isolation. **Test suite 131 → 256, all green.**
- **Carry-forward defect:** **DEFECT-1** — `HookLoader.fire()` aborts the hook chain on the first throwing hook (later hooks silently skipped); falsified by a pinned `KNOWN-DEFECT` test in P7, recorded at `docs/engine-defects-found.md`. Needs a follow-on engagement (a `fireIsolated()` variant) — this is the multi-tenant collision risk previously flagged as conjecture, now proven.
- **Provenance:** workflow-analyzer (coverage map) + workflow-researcher (global memory `extension-consumer-interface/`) → workflow-optimizer (ranked suggestions) → workflow-planner (8-phase migration) → typescript-pro executors (P7 parallel, P0→P6 serial). All changes uncommitted, pending review.
- **Related plans:** [`sox-ecosystem`](#sox-ecosystem) — parent (engine now fronted by the CLI); [`sox-memory`](#sox-memory) — its 4 extensions among the 11 retrofitted in P5.
- **Artifacts:** [analysis](./plans/consumer-interface-standard/analysis.md) · [suggestions](./plans/consumer-interface-standard/suggestions.md) · [migration](./plans/consumer-interface-standard/migration.md) · [status](./plans/consumer-interface-standard/status.md) · [session](./plans/consumer-interface-standard/session.md) · research: `~/.claude/plugins/workflow/memory/research/extension-consumer-interface/` · defects: `docs/engine-defects-found.md`

### sox-memory
- **Objective:** The agent graph-memory subsystem as the **first tenant** of sox-ecosystem — packaged, scoped, versioned, installed entirely through the ecosystem's own primitives, consuming the built v2 primitives natively (bundle / lifecycle / promotion event / runtime).
- **Outcome:** **complete (2026-06-08).** All 6 phases built and green; final `state: complete`. P0 bundle install → P1 MVP SQLite store + hybrid recall → P2 host-supervised `memoryd` daemon + organizer LLM-locus + bi-temporal → P3 multi-scope RRF federation (p95 **5.8ms**) → P4 scope promotion via native `ScopePromotionProposed` + version-defensive graphify + communities → P5 conformance hardening + scale-switch + Changesets 0.1.0 dry-run. Full 11-check regression green; `validate-manifests` passes incl. v2 bundle/lifecycle/runtime checks + G-E advisory; G1 scale-switch advisory proven at 60k rows (post-switch p95 ≈7ms).
  - **Resume note:** P2 was interrupted (killed shell); resumed by orchestrator — root-caused a missing node-validity predicate in `recall.ts` graph expansion (invalidated nodes leaked via live `SUPERSEDES` edge), fixed in src + hand-maintained `dist/`. v2 swaps dropped ~160 LOC of workaround (−9%): native `bundle` type (G-B), `lifecycle{}` host supervision (G-A), `ScopePromotionProposed` event (G-C), `runtime:"node"` lint (G-D), `requires` advisory (G-E).
  - **Open follow-ups (not defects, uncommitted):** (1) `dist/*.js` are hand-maintained mirrors of `src/` — no bundler; `pnpm -r build` compiles to a *separate* `dist/extensions/**` tree, so the two must be kept in sync by hand. (2) File-ownership blur: promotion-application logic (`applyPromotion`) is invoked from `memory-flush` though it logically belongs to `memory-cli` (introduced in P4 to avoid circular imports; passes validation). (3) libSQL DiskANN switch is *criterion-wired only* — migration execution is a deliberate post-0.1.0 follow-on. (4) Live npm publish pending a token (proven via dry-run). **All changes are uncommitted, pending user review.**
- **Related plans:** [`sox-ecosystem`](#sox-ecosystem) — parent/contract; v1+v2 built, primitives consumed here.
- **Artifacts:** [design](./plans/sox-memory/design.md) · [migration](./plans/sox-memory/migration.md) · [status](./plans/sox-memory/status.md) · [session](./plans/sox-memory/session.md) · prior: `design.v1.md`, `migration.v1.md`

### sox-ecosystem
- **Objective:** Plan AND build a monorepo hosting independently-versioned LLM-extension types with multi-scope install/cascade, provider abstraction, registry-as-protocol, Changesets versioning, scaffold-first authoring, dedup-lint CI — then close the gaps its first tenant surfaced.
- **Outcome:** **complete (2026-06-07).** **v1:** 8-phase plan executed by a 6-stage parallel workflow → 11 commits, ~2,200 LOC, 69/69 tests; all 5 original gaps resolved; P5.5 eval gate cleared. **v2 gap-closure:** designed in `architecture-v2.md`, executed serial P7→P11 → **131 tests total** (was 110); G-A `lifecycle{}` block, G-B `bundle` type (enum 6→7), G-C `ScopePromotionProposed` event + `config.promotion` + `docs/scope-promotion.md`, G-D `runtime` field + lint, G-E `requires` redundancy advisory. **`cascade.ts` byte-unchanged**; all v1 manifests still validate/install (back-compat held). `VERIFICATION.md` covers both.
  - One open follow-up (not a defect): UC-3 *live* npm publish pending a token (proven via local-server tests). Gap 3 (registry HTTP server) deferred (~5k-entry trigger).
- **Provenance:** live analyzer/optimizer runs (seeds `*.seed.md`); planner v1 (`migration.v1.md`) → v2 (`migration.md` + Section 6) + `architecture-v2.md`.
- **Artifacts:** [migration](./plans/sox-ecosystem/migration.md) · [architecture-v2](./plans/sox-ecosystem/architecture-v2.md) · [analysis](./plans/sox-ecosystem/analysis.md) · [suggestions](./plans/sox-ecosystem/suggestions.md) · [status](./plans/sox-ecosystem/status.md) · [session](./plans/sox-ecosystem/session.md) · [VERIFICATION.md](./VERIFICATION.md)
