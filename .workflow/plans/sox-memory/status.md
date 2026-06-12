---
slug: sox-memory
state: complete
created: 2026-06-07
last_event: 2026-06-08T07:45:00Z
canonical_roi: high (first-tenant proof; v2 swaps drop ~160 LOC of workaround, −9%)
parent: sox-ecosystem
---

# Engagement: sox-memory

First tenant of the sox-ecosystem. Agent graph-memory subsystem expressed entirely as ecosystem
extensions (mcp-server + agent + hook + command), conformant to the fixed ecosystem contract.

## State transitions
- 2026-06-07 initialized — workflow-architect
- 2026-06-07 analyzed — design synthesized from agent-graph-memory research (18 findings) + ecosystem contract (schemas + scripts)
- 2026-06-07 suggested — build-vs-reuse locked; 5 open gaps resolved
- 2026-06-07 planned — 6-phase resumable build plan (P0 install bundle → P5 publish), each with a deterministic acceptance check
- 2026-06-07 planned — workflow-planner (v2 re-plan: workarounds → native ecosystem primitives)
- 2026-06-07T23:03:00Z executing — phase P0 complete (executor: typescript-pro)
- 2026-06-08T04:25:00Z executing — phase P1 complete (executor: typescript-pro)
- 2026-06-08T04:46:32Z executing — phase P2 complete (executor: typescript-pro)
- 2026-06-08T05:15:00Z executing — phase P3 complete (executor: typescript-pro)
- 2026-06-08T05:30:00Z executing — phase P4 complete (executor: typescript-pro)
- 2026-06-08T07:45:00Z complete — phase P5 complete (executor: typescript-pro)

## Deliverables
- design.md — extensions/manifests/bundle, SQLite DDL, 7 MCP tool contracts, daemon model, federation, build-vs-reuse, gap resolutions, conformance+gap report (§8)
- migration.md — phased resumable build plan with deterministic acceptance checks

## Locked decisions
- DB: sqlite-vec brute-force default; libSQL DiskANN switch when per-store rows >50K OR p95 recall >35ms (50ms hard ceiling, incl. query embed, zero LLM read)
- IPC: hybrid durable organizer_queue table (authoritative) + Unix-socket doorbell + 1000ms fallback poll
- Scope promotion: config policy (3-occurrence/60-day, tunable), promotion_queue + `memory promote`, scope-owner approval (or org-baseline auto)
- Graphify import: version-defensive, fail-loud on unknown shape
- LLM locus: every call in memory-organizer, via ecosystem provider abstraction, batched 2-4/cycle, never on read
- Runtime: Node/TypeScript (conformance port from research's Python; ~1780 LOC build)

## Ecosystem gaps surfaced (feedback, not workarounds)
- G-A no service/daemon lifecycle type · G-B no bundle primitive · G-C no scope-promotion concept · G-D implicit runtime-language mandate · G-E capability-decl granularity

## Blockers (active)
- (none)

## Blockers (resolved)
- Ecosystem plan path was a placeholder; resolved by locating sox-ecosystem repo (contract embodied in schemas/ + scripts/).
- sox-memory working dir deleted; engagement re-homed inside sox-ecosystem as its first tenant.
