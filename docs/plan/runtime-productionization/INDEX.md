# runtime-productionization — execution plan index

Implements `docs/decisions/0007-memory-single-writer-architecture.md` (ADR 0007 v2).
Work items are BACKLOG.md BL-118 … BL-149. Each context directory is a complete,
self-contained work order: an agent needs only
**"Read docs/plan/runtime-productionization/<context>/README.md and execute."**

Every context bootstraps from `_shared/` (RULES → CONTRACTS → PROTOCOL) — that is step
1 of every README. Progress is logged in each context's `progress.json` (schema in
PROTOCOL.md); claims without evidence are invalid by definition.

## Contexts and dependency DAG

```
01-write-path ────────────► 02-reusable-subsystems ──► 03(final item: launchd re-enable)
                                                            ▲
03-supervision-activation (plumbing + identity items start immediately)
04-transport-remote      (independent; default-flip is its last item)
05-platform-integrity    (fully independent)
06-hardening-final       (starts only when 01–05 gates are passed)
```

| Context | Owns BL | Packages (scope fence) | Can start |
|---|---|---|---|
| `01-write-path` | 118, 123, 124, 125, 129 (+134 skeleton) | memory-core, memory-server ext (tool wiring + tests) | immediately |
| `02-reusable-subsystems` | 119, 120, 126, 127, 147, 149 | memory-core, memory-server ext, data/* (embedding-provider, analysis, graph/vector-store, hybrid-search), claim-verification (worker swap only), memory-daemon (deprecation) | after 01 gate |
| `03-supervision-activation` | 121, 122, 128, 130, 131, 137, 145(gates) | host-runtime (os-unit), service-proxy, memory-core (identity items), memory-server ext, manifest (config_schema) | plumbing+identity immediately; final re-enable after 02 gate |
| `04-transport-remote` | 146, 148 | mcp-runtime, install-engine, host-registry, memory-server ext (config_schema keys) | immediately |
| `05-platform-integrity` | 136, 138, 139, 140, 141, 142, 143 | apps/sox, host-runtime, install-engine | immediately |
| `06-hardening-final` | 132, 133, 134(full) + closeout | memory-core, hybrid-search (scores), CI config | after all gates |

Parallel-start set: **01 ∥ 03(partial) ∥ 04 ∥ 05** — four agents day one.

## Integrator duties (a fifth role, not a context)

1. Merge order: 01 → (03-plumbing, 04, 05 in any order) → 02 → 03-final → 06.
   Merge only contexts whose `progress.json` gate is `passed`; re-run the gate commands
   from evidence verbatim after each merge (post-merge re-verification is mandatory —
   worktrees hide integration conflicts until merge).
2. Triage every context's `discovered[]` into BACKLOG.md.
3. Own `_shared/CONTRACTS.md` change control: contract-change blockers go to the owner;
   an approved change requires re-checking every context that already implemented the
   old shape.
4. After 06: flip ADR 0007 Status → ACCEPTED, sweep BACKLOG statuses, delete merged
   `runtime-prod/*` branches and worktrees.

## Owner decision points (pre-wired, no mid-flight design)

- BL-145 re-enable is executed by 03 only after 02's parity gate — no early enable.
- D4 security defaults (loopback default, bearer for non-loopback) are implemented as
  contracted; loosening them is an owner edit to CONTRACTS §I before 04's last item.
- `memory-daemon` deprecation (02) is a bundle **major** bump — 02 records the version
  plan in its REPORT.md; the owner publishes, never the agent.
