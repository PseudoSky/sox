# IMPLEMENTATION — Deterministic Memory Graph Enrichment

**Status:** ready to dispatch
**Bases:** `SPEC.md` (scope), `DESIGN.md` (locked decisions), `CONSUMER-INTERFACES.md` (UC1–UC10),
`CONTRACTS.md` (the `@adhd/sox-memory-enrich` API + v1 MCP tool contracts)

This is the phased build plan. Each phase is independently shippable, has its own gate, and maps to
the contracts and the backlog items this plan now **owns** (see §0). Do phases in order; each phase
must be green (`nx build,lint,test` for touched projects + `pnpm typecheck` + `node bin/soxe validate`

+ `nx run host-runtime:test-e2e` when runtime is touched + `nx run registry:sync-index` after any
registry-checksummed dist change) before the next.

## §0. Backlog items folded into this plan (now tracked HERE, not as loose BACKLOG items)

| BL | What | Phase that resolves it |
|----|------|------------------------|
| **BL-21** | export on-demand, not auto-refreshed | P5 (export integration + SessionEnd trigger) |
| **BL-22** | export frontmatter shows entity uids, not names | P5 (export reads entity names) |
| **BL-23** | `memory_write` drops metadata / no caller project-path | metadata: **DONE** (`9728f6f`); project-path: P1 |
| **BL-24** | tags/topic not first-class; clustering not durable | tags/topic: P1; clustering: P3 |
| (finding) | organizer is LLM-gated, doesn't form communities, degrades silently | **fully removed** in P6 |

When a phase lands, mark the corresponding BL `Resolved` in `BACKLOG.md` citing the phase commit.

## §P1 — Schema & write-path enrichment fields

Add the durable structured fields the contracts require (`CONTRACTS.md` C3.2 `NodeV1`, C2.1
`memory_write`):

+ New `node` columns (idempotent `ALTER TABLE … ADD COLUMN`, guarded — pattern already in `db.ts`
  `migrateAddColumn`): `topic TEXT`, `tags TEXT` (JSON), `project_path TEXT`, `enrich_ver TEXT` (JSON).
  (`meta` already added in `9728f6f`.)
+ `memory_write` accepts + persists `topic`, `tags` (retained as a field **and** kept as
  entity/`MENTIONS`), `project_path` (caller-supplied or `resolveProjectPath()` — `CONTRACTS.md` C1.4),
  building on the `summary`/`metadata` work already merged.
+ **Gate/acceptance:** write with all v1 fields → all persisted + queryable (`json_extract` on
  `meta`/`tags`); migration adds columns to a pre-existing store; existing tests stay green;
  new tests cover each field. *(Resolves BL-23 project-path, BL-24 tags/topic-as-field.)*

## §P2 — `@adhd/sox-memory-enrich` package (deterministic enrichment surface)

Create `libs/memory-enrich/` (`@adhd/sox-memory-enrich`) implementing `CONTRACTS.md` C1: `enrichOnWrite`,
`computeImportance`, `detectNearDup`, `extractiveSummary`, `buildAutoLinks`, `resolveProjectPath`,
plus the version export (`enrich_ver`). All deterministic (no provider), unit-tested for
reproducibility. `memory-core` consumes it on the write path. No LLM, no network.

+ **Gate:** byte-reproducible outputs across runs; `nx build,lint,test memory-enrich,memory-core`.

## §P3 — Embedding clustering → communities

Implement `clusterStore` (`CONTRACTS.md` C1.8) using DESIGN's **cosine-threshold connected-components**
(τ defaults 0.82 real / 0.70 hash; community UID = stable hash of sorted member rowids). Writes
`community` nodes + `MEMBER_OF` edges; derives human-readable labels from centroids; incremental;
`clusterStats` (C1.10) for quality. Runs as a batch pass (`runBatchEnrich`, C1.3) — host TBD in P6.

+ **Gate:** deterministic partition (same DB → same communities/UIDs); `clusterStats` sane on the real
  `~/.memory/memory.db`; topic precedence honors explicit `[<topic>]`/tags over cluster per DESIGN.
  *(Resolves BL-24 clustering.)*

## §P4 — v1 MCP tool surface

Implement the v1 tools (`CONTRACTS.md` C2): `memory_write`/`memory_recall` MODIFIED (topic/project_path
filters + provenance), and NEW `memory_topics`, `memory_list_projects`, `memory_list_entities`,
`memory_entity_episodes`, `memory_related`, `memory_supersession_chain`, `memory_near_duplicates`,
`memory_curate`, `memory_stats`. Bump server version 0.1.0 → 1.0.0; keep backward-compat per contract.

+ **Gate:** each tool matches its contract inputSchema/output; e2e exercises the new write fields +
  a discovery tool; `validate --strict`; registry synced.

## §P5 — Export integration (reads structured data) + auto-refresh — **DONE (2026-06-22)**

Update `libs/memory-core/src/export.ts` to read the **structured** `topic`/`summary`/`project_path`
(not parse `[<topic>]` text) and render entities by **name** (BL-22); add an auto-refresh trigger via
the `memory-flush` SessionEnd hook (gated on `export_enabled`, throttled) (BL-21).

+ **Gate:** export of the real store uses structured topics + entity names + provenance; re-export
  idempotent; SessionEnd triggers a refresh. *(Resolves BL-21, BL-22.)*
+ **Reality-verified (2026-06-22):** `nx run-many -t build lint test --projects=memory-core,memory-flush`
  65/65 green; real-store proof: 3-episode DB exported with structured topic/summary/project_path/tags
  and entity names (not uids) in frontmatter. `tryAutoExport` throttle/gate/failure-isolation verified
  by 14 new tests in `memory-flush/src/index.spec.ts`.

## §P6 — Full removal of `memory-organizer` (mandatory)

Per DESIGN's removal checklist: delete the `memory-organizer` member, the `memory-daemon` provider
config (`provider_url/key/model`) + the `organizeItems` IPC + the LLM branch in `memoryd.ts`; decide
the daemon's fate (repurpose as the deterministic batch-cluster host for P3, or remove); update bundle
`members[]`, description, registry, install-registry, docs, CLAUDE.md.

+ **Acceptance:** `grep -ri memory-organizer` returns only history/changelog; the bundle installs +
  runs with **zero LLM provider configured**; enrichment output is byte-reproducible; full gate green.

## §Sequencing notes

+ P1 → P2 → P3 are the foundation. P4 (tools) depends on P1–P3. P5 depends on P1/P3. P6 last (it removes
  the thing P2/P3 replace — don't remove until the replacement is proven).

+ Keep each phase a separate commit on a branch; gate before advancing; never half-ship a phase.
