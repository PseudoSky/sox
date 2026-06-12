---
slug: permission-enforcement
state: executing
created: 2026-06-12
last_event: 2026-06-12T20:30:00Z
canonical_roi: qualitative-only
parent: sox-ecosystem
---

# Engagement: permission-enforcement

Close the last open DoD requirement: **C6 — declared `permissions` are enforced at runtime, not merely
validated.** Builds on the nx foundation (branch `feat/nx-migration`).

## Inputs (analysis + suggestions)
- `DOD.md` C6 — the bar: "Declared `permissions` are enforced at runtime, not merely validated."
- `docs/architecture-audit-v2.md` — the C6 finding (declared + structurally validated; no runtime sandbox; `db_path` etc. unbounded).
- `libs/host-runtime` — the activation boundary where `permissions` are currently *recorded* but not enforced (loader/supervisor/adapters).
- `libs/manifest` — the `permissions` contract (`fs`/`network`/`socket`) + the per-type install-targets.

## Known hardness / scope to settle in planning
True runtime sandboxing is non-trivial and differs by type: spawned process types (mcp-server, shell hooks, python commands) can be bounded at the process boundary (fs allowlist, socket/network egress, cwd/env); in-process/declarative types (markdown agents/skills) may only get declaration + audit, not hard OS isolation. The plan must scope the enforcement level honestly per type and define what "enforced" means in the final audit (e.g., an extension that touches an undeclared path is denied/blocked).

## State transitions
- 2026-06-12T03:00:00Z initialized — workflow-architect
- 2026-06-12T03:00:00Z suggested — workflow-architect (DOD.md C6 + audit-v2 serve as analysis+suggestions)
- 2026-06-12T04:30:00Z planned — workflow-planner (plan-state-machine, C6 runtime permission enforcement)
- 2026-06-12T05:30:00Z planned — workflow-planner (gap-check fixes: criterion coverage + consolidate-legacy state)
- 2026-06-12T13:30:00Z executing — workflow-architect (orchestrated 8 states serially; typescript-pro executors; every audit gate architect-reality-verified)
- 2026-06-12T20:30:00Z audit-final green (machine half of [dod.5]) — architect-verified. AWAITING FOUNDER APPROVAL (human half) to set state: complete.

## Reality findings the gates caught (the value of running them)
1. nx migration left a DUPLICATE `scripts/host/` runtime → removed (consolidate-legacy).
2. consolidate-legacy guard was narrower than its blast radius: deleting `runtime-cli.ts` broke `bin/sox` + the lifecycle e2e → re-homed the CLI into the canonical lib.
3. latent: `nx run-many -t test` red since the migration (test-less libs) → `passWithNoTests`.
4. audit was environment-dependent (bare `nx` → exit 127) → PATH-pinned `_run`.
5. stale registry checksum (C2 gate) after editing memory-server → regenerated.
6. **Plan premise was wrong: the supervisor `_spawn` was NOT the single spawn point.** FOUR unenforced extension spawn paths existed; the reality driver only tested a direct hand-env spawn. Enforced all four: supervisor `_spawn`, `runtime-cli` exec, `apps/sox` exec; in-proc = SOFT. Upgraded the e2e + audit to prove denial through the REAL `sox exec` path.

## Blockers (active)
- (none — depends on the nx foundation on `feat/nx-migration`)

## Blockers (resolved)
- (none)
