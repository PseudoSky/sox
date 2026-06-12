---
slug: framework-contract-completion
artifact: analysis
author: workflow-analyzer (consolidation)
captured_by: workflow-architect
date: 2026-06-08
---

> **Provenance:** consolidated by `workflow-analyzer` from the existing guideline set + audit; the
> analyzer could not write the file (subagent write constraint), so the architect persisted it. The
> 12×7 matrix below is assembled from the per-type Layer-4 verdicts the per-type subagents produced.
> Full per-type detail and evidence live in `docs/guidelines/<type>.md`; the cross-type narrative is
> in `docs/guidelines/README.md`; current-state evidence is in `docs/architecture-audit.md`.

# Analysis: cross-type framework-contract-gap baseline

Grades the **framework's** contracts, never a tenant. Principle: tenant correctness is downstream of
contract clarity. Legend: **D** Defined · **I** Implicit · **DU** Declared-unimplemented · **A** Absent
· **N/A** not applicable to the type.

## The consolidated contract-clarity matrix (12 Layer-4 transitions × 7 types)

| # | Transition | mcp | hook | agent | skill | prompt | command | bundle |
|---|---|---|---|---|---|---|---|---|
| 1 | intent → manifest | D¹ | D¹ | D¹ | D¹ | D¹ | D¹ | D¹ |
| 2 | manifest → catalog record | I | I | I | I | I | I | I |
| 3 | manifest+pkg → lockfile | D² | D² | D² | D² | **D** | D² | D(mbr)/A(bundle id) |
| 4 | source → **build artifacts** | **A** | **A** | **A** | **A** | **N/A** | **A** | **N/A** |
| 5 | author → type runtime contract | A | A | A | A | A | A | A |
| 6 | source → interface descriptors | A | A | A | A | A | A | I |
| 7 | artifact+version → published pkg | D² | D² | D² | D² | **D** | D² | D |
| 8 | install → activated runtime | DU | A | A | A | A | A | D(mech)/A(sem) |
| 9 | runtime → delivered to consumer | A | A | A | A | A | A | N/A |
| 10 | scope config → applied config | cascade D / cfg-schema A | ″ | ″ | ″ | ″ | ″ | members D / bundle N/A |
| 11 | requires → gate decision | D | D | D | D | D | D | members D / bundle N/A |
| 12 | event/lifecycle signal → reaction | DU | A+defect | A | A | A | A | N/A |

¹ shape only — validation does not assert entrypoint resolvability, declared-tool/event/verb validity, or member existence.
² nominally Defined but **blocked by row 4** — the lockfile pins, and release publishes, an artifact that was never generated.

## Universal holes (true across the type set)

- **Build/output-generation (#4): Absent for all five process types** (mcp, hook, agent, skill,
  command); N/A only for the two non-process types (prompt, bundle). The single most universal hole,
  and the linchpin — it silently nullifies the otherwise-Defined rows #3 and #7. Diagnostic: any
  hand-maintained `dist/` in the repo.
- **Activation + consumption seam (#8/#9): Absent for all five runtime types.** No host runtime turns
  `installed` into `running`. mcp #8 is DU (worse-feeling than A — the `lifecycle{}` shape exists, so
  the gap looks governed).
- **Type runtime contract (#5): Absent for every type** — the manifest declares no transport, event
  binding, invocation protocol, run interface, parameter set, verb, or member-existence guarantee.
- **Per-extension config schema (#10): Absent** for all — config cascades but is unvalidated.
- **Resource/permission contract: Absent** for all — nothing declares or bounds fs/network/socket access.

## Per-type deviations

- **prompt** — row 4 is **N/A** (the `prompt.md` source *is* the distributable). Consequently rows
  #3 and #7 are **genuinely** Defined, not nominally — the only type for which the distribution
  contracts are trustworthy. Its seam is parameter-declaration, template-syntax, load, and inject.
- **bundle** — the "spine contracted / seam not" thesis **does not cleanly reproduce**. A bundle has
  no build and no runtime; it is consumed at **install time** via expansion. Its real holes are
  install-time composition contracts: member-existence validation (#5), version-conflict resolution
  policy with operator-visible signal (#6, currently first-seen dedup pinned as behavior), and
  bundle-provenance in the lockfile (#3 — the bundle id is erased after expansion, so there is no
  "remove all members of this bundle" basis).

## Empirical evidence of the causal thesis (already-visible divergence)

Each Absent contract has *already* produced divergence between the mere one-or-two existing tenants of
its type — the thesis is observed, not predicted:

- hook event binding: `export const event` (audit-hook) vs `export const events` (memory-flush); and
  `HookContext` re-declared independently in each hook.
- agent invocation: `tools[]`+`execute` callbacks (echo-agent) vs `organizeItems()` (memory-organizer).
- command handler: `run(input)` (status-command) vs `runCli(argv)` (memory-cli).

## Dependency / severity ordering (handed to the optimizer)

1. **Build/output-generation (#4, all process types)** — prerequisite for everything runtime; makes
   hand-maintained `dist/` unnecessary and converts #3/#7 from nominal to real.
2. **Manifest self-description fields (#5 per type: events / verb / invocation / run / parameters) +
   handler & interface contracts (#6)** — prerequisites for static discovery and for any dispatcher.
3. **DEFECT-1 fix (`fireIsolated()`)** — sub-dependency of hook host integration.
4. **Host runtime: loader + supervisor (#8, all runtime types)** — requires #4 + #5/#6.
5. **Host runtime: per-type dispatcher / registrar / renderer (#9)** — requires #8.
6. **Event bus / lifecycle signals (#12)** — requires the host runtime.

Parallel / order-independent: bundle composition contracts (#5/#6 for bundle), per-extension config
schema (#10, all types), resource/permission declarations (all types).
