---
slug: consumer-interface-standard
state: complete
created: 2026-06-08
last_event: 2026-06-08T12:06:00Z
canonical_roi: qualitative-only
provisional_roi: critical
parent: sox-ecosystem
---

# Engagement: consumer-interface-standard

Close the interface/affordance gap the sox-ecosystem build left open. The substrate (schema +
cascade + install engine + bundle + event model) is proven for one tenant, but the consumer-facing
layer was never in the plan's coordinate system: no host CLI, no docs/READMEs, no LLM guidance, no
per-extension conformance to any DX standard. This engagement (1) documents what the build actually
covered, and (2) designs the ideal consumer interface for the full extension lifecycle across all
install scopes — to be enforced via repo tooling + contracts.

## Objective
Define and enforce a consumer-interface standard for the ecosystem: ship installs across global /
user / project scopes for the full extension lifecycle — creation, search, install, configure, usage
— with every extension made to conform through the schema, scaffolder, linter, and CI.

## Topics
consumer interface · multi-scope install (global/user/project) · extension lifecycle CLI ·
self-description / docs contract · DX conformance enforcement · scaffolding/templating · LLM guidance

## State transitions
- 2026-06-08T06:19:06Z initialized — workflow-architect
- 2026-06-08T07:42:00Z analyzed — workflow-analyzer (coverage map: built substrate vs. absent affordance layer)
- 2026-06-08T08:15:00Z suggested — workflow-optimizer (ranked gap-closure suggestions vs. ideal consumer interface)
- 2026-06-08T09:05:00Z planned — workflow-planner (phased consumer-interface migration)
- 2026-06-08T10:00:00Z executing — phase P0 complete (executor: typescript-pro)
- 2026-06-08T10:45:00Z executing — phase P7 complete (executor: typescript-pro)
- 2026-06-08T11:00:00Z executing — phase P1 complete (executor: typescript-pro)
- 2026-06-08T14:00:00Z executing — phase P2 complete (executor: typescript-pro)
- 2026-06-08T15:00:00Z executing — phase P3 complete (executor: typescript-pro)
- 2026-06-08T16:00:00Z executing — phase P4 complete (executor: typescript-pro)
- 2026-06-08T17:00:00Z executing — phase P5 complete (executor: typescript-pro)
- 2026-06-08T12:06:00Z complete — phase P6 complete (executor: typescript-pro); engagement complete (P0–P7 all green)

## Inputs dispatched
- workflow-analyzer (attached) — coverage map of what the build covered + the affordance gaps.
- workflow-researcher (global memory) — ideal consumer interface for multi-scope extension lifecycle
  + conformance enforcement; builds on existing topics `extension-ecosystem-design`,
  `plugin-manifest-formats`, `plugin-taxonomies`, `policy-enforcement`.

## Blockers (active)
- KNOWN-DEFECT: HookLoader.fire() aborts hook chain on first throwing hook (see docs/engine-defects-found.md DEFECT-1); follow-on engagement needed for fireIsolated() variant

## Blockers (resolved)
- (none)
