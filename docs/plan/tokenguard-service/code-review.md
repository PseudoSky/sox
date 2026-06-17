# Code review — tokenguard-service (orchestrator review, [dod.9] gate)

**Reviewer:** orchestrator (fullstack-developer)
**Date:** 2026-06-16
**Scope:** every project touched by the plan, reviewed before `audit-final`.
**Cross-project gate:** `npx nx run-many -t typecheck,lint,test --projects=tokenguard-core,tokenguard,manifest,authoring,host-runtime,install-engine,host-registry,sox` → **exit 0, all 8 projects green** (verified by the orchestrator, not inferred).

---

## Issues found by this review (and fixed)

The cross-project gate caught **two integration breakages the per-state guards structurally could not** (each executor ran only its own target subset):

1. **`tokenguard-core:lint`** — the ported Vitest specs imported the engine via the package scope `@sox/tokenguard-core`; `@nx/enforce-module-boundaries` requires **relative** imports *within* a project. Fixed: 4 spec files → `from '../src/index'`. Tests still 63/63 green, lint clean. (Owning state: `core-invariants` — files already in its `mutates`; re-edit.)
2. **`tokenguard:test`** — the extension declared a `vitest` test target pointing at a `vitest.config.ts` that never existed (tg-service's proof was the e2e demo, no unit target). Fixed: created `vitest.config.ts` + `test/smoke.spec.ts` with **10 real unit tests** (`resolveConfig` shape/overrides/seed-parsing; `genericAdapter` scope + reverse + exact round-trip). (Owning state: `tg-service` — expand-artifacts amendment.)

Both are recorded as amendments. No assertion was weakened to pass; the fixes are real.

---

## Per-project notes

- **`tokenguard-core`** — pure engine, no IO beyond optional map persist. Bijective round-trip / zero-leak / SSE-reassembly invariants covered by 63 tests incl. labeled `[neg-ctrl]` controls. One intra-package dynamic `require()` (circular-dep break, `mapper`→`tokenize`); contained, not a cross-package reach-in. No WOP vocabulary (negative gate green). **OK.**
- **`tokenguard`** (service) — proxy enforces the wire guarantee (verified live: `vulntarget.internal` → `<HOST_1>`, exact reversal); config flows only via `SOX_CONFIG_*`; C6 sink guard reads `SOX_POLICY_*`. The `ERR_HTTP_HEADERS_SENT` response-ordering bug was found by the guard and fixed (single `writeHead(status, headers)` with recomputed content-length). Self-contained bundle, no native deps. **OK.**
- **`manifest`** — `service` type + `transports` added across all enumeration sites (VALID_TYPES ×2, unions, the 3 inline JSON-schema enums, `processTypes`); `validate()` generalized; 150 tests pass incl. mcp-server non-regression. **OK.**
- **`authoring`** — `serviceTemplate` born-conformant; scaffold dispatch + `sox init service --transport`; mcp-server template emits `transports:['stdio']`. **OK.**
- **`host-runtime`** — `http-get` probe (port.txt-aware, race-fixed), loader `service` dispatch case; SIGTERM→SIGKILL stop verified zero-orphan. mcp-server `activateMcp` path intact. **OK.**
- **`install-engine`** — unified `run-service` routing for service + mcp-server (single registry preserved); `SOX_CONFIG_*` env injection; `typeDirs += services` (lib + live `scripts/install.ts` parity). **OK.**
- **`host-registry`** — `service` surface, no literal host paths ([ref:host-keyed-target]). **OK.**
- **`apps/sox`** — `init service` + `--transport`; CLI logic in `main.ts` (bin/sox shim untouched). **OK.**

## Invariant / reference spot-checks

- **[inv:no-regress-mcp]** — memory-server: 150 manifest + 14 memory-server tests green, C6 forbidden-write denial intact (proven at `audit-framework`). ✔
- **[inv:bijective-roundtrip] / [inv:wire-guarantee]** — proven live (proxy round-trip) + by the engine suite. ✔
- **[ref:c7-no-reach-in]** — no cross-package `../dist` reach-in; the lint fix above enforces relative-within-project. ✔
- **[ref:c6-policy-guard]** — `SOX_POLICY_*` enforced at the sink in `src/index.ts`. ✔

## Known limitation (documented, not a blocker)

Service-store materialization (`bundle/` copy) cannot carry **native deps** (e.g. `better-sqlite3`) — surfaced during `mcp-as-service`. Benign here: `tokenguard` is pure TS and bundles self-contained. Relevant only to future native-dep services; worth a follow-up note on the `service` guideline.

---

## VERDICT: PASS

All 8 touched projects pass `typecheck + lint + test` together (exit 0, verified). The two integration issues the gate surfaced are fixed with real tests, no weakened assertions. Invariants and references spot-checked green. Cleared for `audit-final`.
