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

## 2026-06-07T (resume) — orchestrator turn

User killed the P2 executor shell mid-implementation. Recovery diagnosis (architect):
- P0/P1 committed (42bff0e); P2 code on disk + compiled, uncommitted; status.md NOT advanced (executor died before mandatory completion step).
- P2 acceptance: test-organize.js fails (true exit 1) at one assertion — current recall returns the INVALIDATED old claim.
- Root cause: recall.ts graph depth-1 expansion. Edge filter (line 234) is correct, so the live SUPERSEDES edge (new→old) is followed; but the expanded-NODE fetch (lines 247-248) lacks a node-validity predicate, so the invalidated neighbor is re-added. Vector (114) + FTS (227) paths already filter; expansion was missed.
- dist/memory-lib.js is a HAND-MAINTAINED pre-compiled mirror (no build script). Fix must land in BOTH src/recall.ts and dist/memory-lib.js.
- test-daemon-crash.js not yet run.

Dispatch: typescript-pro to resume + complete P2 (fix expansion validity filter in both files, run both P2 tests to green, then append P2-complete transition to status.md).

## 2026-06-08T04:46Z — orchestrator: P2 resumed to green
Dispatched typescript-pro (executor). Fix: added node-validity predicate to recall.ts graph-expansion node fetch (was missing; vector+FTS paths already had it). Applied in BOTH src/recall.ts and hand-maintained dist/memory-lib.js. test-organize.js exit 0 (ALL ASSERTIONS PASSED); test-daemon-crash.js exit 0 (15/15 writes recovered, singleton re-established, no ~/.memory/memoryd.lock — R6 held). No second bug. status.md advanced: P2 complete @ 2026-06-08T04:46:32Z. INDEX.md rebuilt (relevancy tool v1.0.3; v1.0.4 has a broken section-matter dep — used 1.0.3). Changes left uncommitted for review. Next: P3 (multi-scope RRF federation).

## 2026-06-08 — orchestrator: loop P3→P5, engagement COMPLETE
Continued the plan to completion, dispatching each phase to typescript-pro serially with resume-guard (re-verify prior acceptance before building).
- P3 (federation): green @ 05:15Z. p95 5.8ms over 3×50k, scope-weighted RRF, agent_id ×1.25 boost, no 5th scope. src+dist synced.
- P4 (promotion/graphify/communities): green @ 05:30Z. Native ScopePromotionProposed via host-event-shim (same pattern as P2 supervisor-shim); no bespoke channel (assertion d). Graphify fail-loud on unknown shape. Communities + 2 tools; LLM summary in organizer only (R3).
- P5 (conformance/publish/scale): green @ 07:45Z → state: COMPLETE. Full 11-check regression green. validate-manifests passes incl v2 checks. G1 scale-switch advisory proven at 60k (post-switch p95 ~7ms). strict_capabilities hard-block verified. Changesets 0.1.0 dry-run (no live publish). pnpm -r build fixed (3 strict-mode src fixes) → compiles to separate dist/extensions tree, doesn't touch hand-maintained dist/memory-lib.js.
Documented drift (not defects): (1) hand-maintained dist vs pnpm build tree must stay in sync; (2) memory-flush invokes applyPromotion (logically memory-cli's); (3) libSQL switch criterion-wired only; (4) live npm publish needs token.
INDEX.md rebuilt: sox-memory moved Open→Closed (newest). No open engagements remain. All changes uncommitted, pending user review.
