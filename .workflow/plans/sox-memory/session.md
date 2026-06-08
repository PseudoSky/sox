---
slug: sox-memory
opened: 2026-06-07
---

# Session — sox-memory

## 2026-06-07T00:00:00Z

**User request gist:** Design the agent-memory system as the FIRST tenant of the (already-built)
sox-ecosystem. Express every memory piece in ecosystem terms; deliver (1) extensions+manifests+bundle,
(2) SQLite DDL + 7 MCP tool contracts + daemon + init CLI + cross-scope RRF, (3) build-vs-reuse locked
to glue budget, (4) phased resumable build plan (P0 = install bundle), (5) conformance + gap report.
Resolve 5 open gaps. Conform to contract; <50ms recall; zero LLM on read; deterministic-first.

**Input resolution (blocker handled):** ecosystem plan path was a placeholder `<PATH-TO-ECOSYSTEM-PLAN>`,
and the `sox-memory` cwd had been deleted. Located the real ecosystem at `/Users/nix/dev/ai/sox-ecosystem`
— contract is partly *implemented* (schemas/extension|extensions-config|lockfile, scripts/{cascade,
install,provider-capabilities,validate-manifests,new-extension}, registry/index.json, .changeset,
assets/model_capabilities.json) and documented in `.workflow/plans/sox-ecosystem/migration.md`. Re-homed
this engagement inside sox-ecosystem as the first tenant.

**Dispatches (parallel Explore readers):**
- DB/schema cluster (embedded-db-engine, graph-schema, hybrid-retrieval, scoring, bi-temporal) → numbers locked: 50K DiskANN switch, RRF k=60, decay 0.995, reflection Σimportance≥150, 4-timestamp edges.
- Organizer/daemon cluster (daemon-vs-inprocess, continuous-loop, deterministic-first, consolidation, reflection, community) → daemon verdict, deterministic/LLM split, busy_timeout 5000, batch ≤50.
- Init/scope/build-vs-reuse cluster (multi-scope-init, reference-arch, build-vs-reuse-matrix, graphify-verdict/note, taxonomy, INDEX) → ~1700 LOC budget, 7 tools, scope weights, graphify partial-reuse.
- Ecosystem operational contract (scripts + schemas + existing example extensions) → exact manifest fields, 4-scope cascade, install/lockfile behavior, 9 CI invariants, provider-capability mechanics.

**Key reconciliations decided:**
- Research Python stack → Node/TS (provider abstraction is TS; organizer must use it). ~1700 + ~80 NER delta.
- Research 4 memory scopes (project/agent/global/org) → ecosystem org/user/project/local; "agent" becomes in-store `agent_id` partition, not a scope.
- Daemon has no ecosystem type → ships inside memory-server, lazily spawned (Gap G-A surfaced).

**Returns:** design.md + migration.md written; status.md → planned. 5 gaps resolved; 5 ecosystem
gaps surfaced as additive feedback (service type, bundle primitive, scope-promotion, runtime
statement, capability-decl granularity).

**Decisions/cross-links:** related to parent `sox-ecosystem` (tenant-of). Proceeded as a separate
engagement with cross-link rather than merge — the user explicitly framed it as a distinct first-tenant
deliverable building on the fixed ecosystem contract.
