---
slug: framework-contract-completion
opened: 2026-06-08T18:00:00Z
---

# Session — framework-contract-completion

## 2026-06-08T18:00Z — initialization

Origin: the per-type guideline set (`docs/guidelines/*.md`) — produced by instantiating a shared
5-layer contract template across all seven extension types — established a cross-type framework-gap
spec. Key findings: build/output-generation (#4) Absent for all process types; activation/consumption
seam Absent for all runtime types; prompt & bundle deviate (no build); every absent contract has
already produced tenant divergence. Companion: `docs/architecture-audit.md` (independent audit of
current state).

User directive: turn the guideline set into the backlog — take it through optimizer → planner as the
next engagement.

Architect actions:
- A4: new engagement `framework-contract-completion` (no slug collision; the three prior engagements
  are all closed → no open-engagement overlap gate). Parent: sox-ecosystem.
- Wrote `docs/guidelines/README.md` (index/capstone with the cross-type synthesis).
- Dispatched workflow-analyzer to CONSOLIDATE the 7 guideline docs + architecture-audit.md +
  engine-defects-found.md into a single cross-type framework-contract-gap baseline at
  `<plan_dir>/analysis.md` (consolidation, not re-derivation).

## 2026-06-08 — optimizer + planner: engagement PLANNED
- workflow-analyzer: consolidated analysis.md (12×7 matrix; could not self-write → architect persisted from subagent-produced Layer-4 verdicts + analyzer summary). state→analyzed.
- workflow-optimizer: suggestions.md, state→suggested, provisional_roi critical. 7 ranked items; critical path #4 build → #5/#6 self-description → #8 loader/supervisor → #9 dispatcher/registrar → #12 event bus; parallel: DEFECT-1, config/permission, bundle composition.
- workflow-planner: migration.md, state→planned. 10 phases. Critical chain P0–P6 (P0 build subsystem+entrypoint gate; P1 retire hand-maintained dist; P2 self-description optional-first; P3 retrofit 11 + flip required; P4 host loader+supervisor; P5 dispatcher/registrar/renderer; P6 event bus + fireIsolated). Parallel PA (DEFECT-1), PB (config schema+permissions, 11-manifest), PC (bundle composition). Completion: last finisher of all 10 sets complete. Notable: P1 deliberately reverses the P0 hand-maintained-mirror decision from cli-build-decision.md.
- INDEX.md rebuilt: framework-contract-completion → Open (planned). Index capstone docs/guidelines/README.md written earlier this turn.

## 2026-06-08 — parallel tracks PA/PB/PC complete & green (3/10)
Dispatched PA/PB/PC concurrently (typescript-pro). All green; MERGED state verified by architect (not just per-agent runs, since PB+PC both edited validate-manifests.ts + its test):
- PA: fireIsolated() added, fire() retained, DEFECT-1 RESOLVED (docs/engine-defects-found.md updated), KNOWN-DEFECT tests rewritten.
- PB: schema gains config_schema + permissions (optional-first; all 11 manifests retrofitted); validateConfigAgainstSchema() exported for P4/P5 to wire at install (runtime permission sandboxing is P4/P5's job — do not leave Declared-unimplemented).
- PC: bundle member-existence validation (Check 8), version-conflict warn policy (replaces silent first-seen), bundle provenance (lockfile bundle_id); collision tests rewritten.
- MERGED verification: pnpm test 269 passed (exit 0); validate-manifests OK 11 (exit 0); all three changes present; all three status transitions survived concurrent appends. No collision corruption.
- Engagement state: executing (3/10). Remaining: critical chain P0→P6 (build subsystem → retire hand-maintained dist → self-description → retrofit/enforce → host loader+supervisor → dispatcher/registrar → event bus). P6 consumes PA's fireIsolated; P4/P5 consume PB's permission contract + PC's contracts.

## 2026-06-08 — critical chain P0→P6 complete; engagement COMPLETE (10/10)
Continued serially with a verified P0→P1 checkpoint.
- P0 (275): framework build subsystem — per-package tsconfig (+project refs for memory-cli) + pnpm -r build emits every dist/index.js; entrypoint-reachability gate; CI build step; mirrors left intact. Architect independently verified clean build emits all 9 dist/index.js before allowing P1.
- P1 (275): retired hand-maintained dist mirrors (memory-lib/memory-cli/memoryd), repointed all importers to generated output (new src/lib.ts barrel + src/bin.ts); grep confirms no mirror refs. #4 linchpin CLOSED.
- P2 (291): 6 per-type self-description fields optional-first (events/invocation/tools/parameters/template_engine/run_interface).
- P3 (291): all 11 manifests retrofitted with source-accurate content (memory-server 7 tools verified); checks flipped to error-enforced.
- P4 (329): host runtime scripts/host/ (loader + productized supervisor + 4 adapters); supervisor-shim de-labeled; permissions recorded at activation.
- P5 (354): MCP registrar (initialize+tools/list→agent surface), prompt renderer, real bin/sox enable/disable/search/update, config-schema validation enforced at activation with cascade-resolved config.
- P6 (377): host event bus dispatching via fireIsolated(); host-event-shim productized. LAST FINISHER → state: complete.
- Engagement-close verification (architect, independent): clean pnpm -r build exit 0; 377 tests; validate-manifests OK 11; CAPSTONE — built memory-server dist/index.js answers tools/list with all 7 tools (installed→running closed). All 10 phase lines present; state: complete.
- INDEX.md rebuilt: framework-contract-completion Open→Closed; no open engagements (4 complete); DEFECT-1 marked resolved. All changes uncommitted, pending review.
