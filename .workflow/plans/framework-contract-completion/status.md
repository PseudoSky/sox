---
slug: framework-contract-completion
state: complete
created: 2026-06-08
last_event: 2026-06-08T22:16:00Z
canonical_roi: qualitative-only
provisional_roi: critical
parent: sox-ecosystem
---

# Engagement: framework-contract-completion

Complete the framework contracts the guideline set (`docs/guidelines/*.md`) proved are missing. The
ecosystem is contracted up to `install` and uncontracted from `install` onward: the build/output-
generation contract is Absent for every process type, and the activation/consumption seam is Absent
for all runtime types. Tenant defects are symptoms — this engagement fixes the framework so they
become unrepresentable.

## Objective
Define and implement the framework's missing contracts, concentrated in the build → activation →
consumption → eventing seam: (1) a framework-owned build/output-generation subsystem so no extension
hand-maintains `dist/`; (2) a host runtime (loader + supervisor + per-type dispatch/registrar + event
bus) that turns `installed` into `running`; (3) per-type manifest/interface contracts the guideline
docs specify (event-binding, invocation protocol, handler interfaces, parameter/template declarations,
config schema, resource/permission, member-existence + version-conflict policy for bundles); (4)
validation gates so the new contracts are enforced, not advisory.

## Topics
build/output-generation contract · host runtime (loader/supervisor/registrar/event-bus) · per-type
seam contracts · manifest self-description (events/invocation/params) · handler interface contracts ·
config schema · resource permissions · bundle composition contracts · conformance enforcement

## State transitions
- 2026-06-08T18:00:00Z initialized — workflow-architect
- 2026-06-08T18:30:00Z analyzed — workflow-analyzer (consolidated cross-type framework-contract-gap baseline)
- 2026-06-08T19:15:00Z suggested — workflow-optimizer (ranked framework-contract remediations)
- 2026-06-08T20:30:00Z planned — workflow-planner (phased framework-contract migration)
- 2026-06-08T19:10:45Z executing — phase PA complete (executor: typescript-pro)
- 2026-06-08T19:17:30Z executing — phase PC complete (executor: typescript-pro)
- 2026-06-08T19:25:00Z executing — phase PB complete (executor: typescript-pro)
- 2026-06-08T20:10:00Z executing — phase P0 complete (executor: typescript-pro)
- 2026-06-08T20:20:00Z executing — phase P1 complete (executor: typescript-pro)
- 2026-06-08T20:35:00Z executing — phase P2 complete (executor: typescript-pro)
- 2026-06-08T21:10:00Z executing — phase P3 complete (executor: typescript-pro)
- 2026-06-08T21:35:00Z executing — phase P4 complete (executor: typescript-pro)
- 2026-06-08T22:10:00Z executing — phase P5 complete (executor: typescript-pro)
- 2026-06-08T22:16:00Z complete — phase P6 complete (executor: typescript-pro); engagement complete (all 10 phases green)

## Inputs (already produced this session)
- `docs/guidelines/*.md` (7 per-type contract docs + `_TEMPLATE.md` + `README.md` synthesis) — the target.
- `docs/architecture-audit.md` — independent audit of current state (the gap).
- `docs/engine-defects-found.md` — DEFECT-1 (HookLoader abort-on-throw) carry-forward.

## Related plans
- `consumer-interface-standard` (complete) — fronted the engine with a CLI + docs/conformance; this
  engagement builds the runtime BELOW that CLI.
- `sox-memory` (complete) — the first tenant whose runtime needs this seam to actually run.

## Blockers (active)
- (none)

## Blockers (resolved)
- (none)
