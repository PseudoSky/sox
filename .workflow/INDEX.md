---
churn_baseline: 100
relevancy_formula: roi_score / (1 + churn_files / churn_baseline)
exclude_paths: [".workflow/", ".forge/", ".cto/", "docs/", ".claude/", ".gitnexus/"]
roi_scale: { low: 1, med: 2, high: 3, critical: 5 }
---

# Workflow plans — sox-ecosystem

> Relevancy note: `.workflow/` is at the repo root (`/Users/nix/dev/ai/sox-ecosystem`). The
> relevancy tool can't compute a churn-decayed score yet — the repo has **no commits**
> (`git log` empty on a fresh `main`). `canonical_roi` is `qualitative-only`; the optimizer set
> `provisional_roi: high`. Shown as `qual`/`high(prov)`. Recompute once commit history exists.

## Open   (sorted by relevancy desc)

| Slug | Objective | State | ROI | Churn | Relevancy | Updated |
|---|---|---|---|---|---|---|
| [sox-ecosystem](#sox-ecosystem) | Buildable plan for an LLM-extension ecosystem (evolving the live SOX plugin stack) | planned | high (prov) | n/a | qual | 2026-06-07 |
| [sox-memory](#sox-memory) | First ecosystem tenant — agent graph-memory subsystem packaged/scoped/versioned entirely as ecosystem extensions | planned | high (prov) | n/a | qual | 2026-06-07 |

## Closed   (chronological, newest first)

| Slug | Objective | State | ROI | Closed |
|---|---|---|---|---|
| _(none)_ | | | | |

---

## Open engagements (detail)

### sox-ecosystem
- **Objective:** Turn the agreed `extension-ecosystem-design` research into a concrete, buildable, resumable plan for a monorepo hosting six independently-versioned LLM-extension types (agent, skill, mcp-server, prompt, hook, command) — now reconciled with the live SOX plugin ecosystem the repo already inherits.
- **Topics:** extension ecosystem, monorepo (pnpm), manifest schema (`extension.json`), multi-scope install + config cascade, provider abstraction (LiteLLM / Vercel AI SDK), registry-as-protocol, independent versioning (Changesets), scaffold-first authoring, dedup lint, plugin→extension migration.
- **Plan summary (v2):** 8-phase resumable build (P0 skeleton → P5 all-six-types → **P5.5 eval-harness research gate** → P6 verification + optional registry server). Reframed as *partly a migration*: the live `plugin.json` + `installed_plugins.json` user/project scope system is treated as a working prototype to evolve, not reinvent. Each phase carries a deterministic acceptance check mapped to MVP use cases UC-1..UC-5, a standalone executor prompt, and a status-update step. Core owned glue **730 LOC**; **~1010 incl.** two optional/deferred modules; eval-harness LOC excluded pending P5.5. (v1 research-only plan archived as `migration.v1.md`.)
- **Live-analysis deltas driving v2 (analysis.md §4):** ALIGNED — plugin-scope system prototypes the cascade; type vocabulary already correct; research-memory hierarchy mirrors registry discovery. DIVERGENT (gaps the build closes, in optimizer rank order) — (1) monolithic plugin versioning → independent Changesets [keystone]; (2) immutable slug `id` + dedup invariants; (3) `validate-manifests.ts` CI lint; (4) scaffold generator; (5) npm+git registry replacing the local-file marketplace; (6) collapse the `sox-active`/`sox-cto-system` 5-agent shadow-copy; (7) declared hook `order`.
- **Complexity:**
  - Full repo dev stop required: NO (greenfield source; nothing live to halt — live SOX cleanup is out-of-scope/advisory)
  - Isolated workspace: YES (this repo)
  - Additive only: MOSTLY (new repo scaffolding; the shadow-copy collapse #6 is the one consolidation, flagged separately)
  - Plan-time deterministic changes: YES (three JSON Schemas + dir tree fixed at plan time)
- **Related plans:** [`sox-memory`](#sox-memory) — first tenant; consumes this plan's contract unchanged and feeds back 5 additive gaps (service type, bundle primitive, scope-promotion, runtime statement, capability-decl granularity).
- **Risks:**
  - MED: `extension.json` ↔ `package.json` version drift (mitigation: pre-publish sync + CI check).
  - MED: supply-chain on remote `source` + org `extends` (mitigation: sha256 pin, fail-closed unless `--update`).
  - ~~MED: eval-harness designed without an evidence base~~ → **RESOLVED 2026-06-07.** The P5.5 research gate is cleared — workflow-researcher landed [`eval-harness-for-llm-extensions.md`](file://~/.claude/plugins/workflow/memory/research/extension-ecosystem-design/eval-harness-for-llm-extensions.md) (3-layer pyramid; promptfoo PR-gate + nightly judge sweep). P6 eval work is now unblocked.
  - LOW: capability false-negatives on long-tail local models (mitigation: advisory-warn default; hard-block opt-in via `strict_capabilities`).
  - LOW: cascade-merge array ambiguity (decision: arrays replace, not concat — documented in the resolver contract).
- **Gap resolutions (locked, unchanged from v1):** (1) npm+registry primary, `.mcpb` optional export; (2) hook order via integer `order` field (default 100), ties by `id`; (3) Terraform two-endpoint server validated but deferred to ~5k-entry trigger; (4) `extends` pinned `{url,sha256,resolved_at}`, fail-closed; (5) capability advisory-warn default, hard-block via `strict_capabilities`.
- **Provenance:** `analysis.md` + `suggestions.md` are **live** workflow-analyzer/optimizer runs (architect seeds preserved as `*.seed.md`); `migration.md` is planner v2 (v1 preserved as `migration.v1.md`).
- **Files:** [analysis](./plans/sox-ecosystem/analysis.md) · [suggestions](./plans/sox-ecosystem/suggestions.md) · [migration](./plans/sox-ecosystem/migration.md) · [status](./plans/sox-ecosystem/status.md) · [session](./plans/sox-ecosystem/session.md) · seeds: [analysis.seed](./plans/sox-ecosystem/analysis.seed.md) · [suggestions.seed](./plans/sox-ecosystem/suggestions.seed.md) · [migration.v1](./plans/sox-ecosystem/migration.v1.md)

### sox-memory
- **Objective:** Design the agent graph-memory subsystem as the **first tenant** of sox-ecosystem — packaged, scoped, versioned, and installed entirely through the ecosystem's own primitives; the first real workload that proves them.
- **Topics:** mcp-server/agent/hook/command extensions, single-file SQLite (sqlite-vec + FTS5) graph store, bi-temporal edges, 7 memory_* MCP tools, organizer daemon (hybrid IPC), cross-scope RRF federation, scope-promotion policy, graphify import bridge, provider-abstraction-only LLM locus, Changesets/install/lockfile packaging.
- **Plan summary:** 6-phase resumable build (P0 install bundle into skeleton → P1 MVP single-project store + hybrid recall <50ms → P2 daemon + organizer LLM locus + bi-temporal → P3 multi-scope RRF federation → P4 promotion + graphify + communities → P5 conformance hardening + publish), each with a deterministic acceptance check. Build ≈1,780 LOC on top of reused ecosystem tooling.
- **Complexity:**
  - Full repo dev stop required: NO (additive tenant on a greenfield ecosystem)
  - Isolated workspace: YES (this repo; `.memory/` stores out-of-tree)
  - Additive only: YES (four new extensions; no ecosystem source changes required to ship)
  - Plan-time deterministic changes: YES (DDL, 7 tool contracts, manifests fixed at plan time)
- **Related plans:** [`sox-ecosystem`](#sox-ecosystem) — parent/contract (tenant-of).
- **Risks:**
  - MED: runtime port — research costed Python; ecosystem mandates Node/TS for provider-touching code (+~80 LOC NER substitution). Resolved (G-D), but a real conformance cost.
  - LOW: sqlite-vec brute-force ceiling at scale (mitigation: libSQL DiskANN switch wired at >50K rows / p95>35ms).
  - LOW: graphify `graph.json` is an undocumented format (mitigation: version-defensive fail-loud bridge).
- **Gap resolutions (locked):** (1) DB scale switch 50K/35ms; (2) IPC hybrid table+socket doorbell; (3) scope-promotion config policy + `memory promote` approval; (4) graphify version-defensive import; (5) single LLM locus in memory-organizer via ecosystem provider.
- **Ecosystem feedback (first-tenant gaps):** G-A service/daemon lifecycle type · G-B bundle/meta-package primitive · G-C scope-promotion (narrow→wide data movement) · G-D explicit runtime-language contract · G-E capability-decl granularity when one extension spawns another.
- **Files:** [design](./plans/sox-memory/design.md) · [migration](./plans/sox-memory/migration.md) · [status](./plans/sox-memory/status.md) · [session](./plans/sox-memory/session.md)

---

## Closed engagements (detail)

_(none)_
