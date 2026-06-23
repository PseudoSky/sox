# SPEC — Deterministic Memory Graph Enrichment

**Status:** draft (authored by orchestrator; to be reviewed/extended by an architect/ML reviewer,
then handed to an API designer for contracts)
**Owner:** sox-memory subsystem (`libs/memory-core`, `sox-memory-bundle`)
**Date:** 2026-06-22

---

## 1. Problem statement

The sox-memory subsystem stores episodes in SQLite (`node`/`edge`/`vec_node`/`fts_node`) and
exposes them via the `memory_*` MCP tools. Auditing the DB vs the exported markdown mirror
surfaced a cluster of gaps that limit its usability for broader use cases:

- **No caller provenance.** `memory_write` accepts a `metadata` param but **silently drops it**
  (it's in the type, never persisted). There is **no record of the caller's project/repo path** —
  only `agent_id`/`session_id`. You cannot ask "what did I learn working on project X" (BL-23).
- **Lossy / unstructured topic & tags.** Agent `tags[]` are converted to `entity` nodes + `MENTIONS`
  edges (the raw list is not retained, no `tags` column). The topic lives **only as text** inside
  `content` (a `[<topic>]` prefix convention); there is no topic/cluster column, so the DB cannot be
  grouped or queried by topic — the export had to *parse it from text* (fragile) (BL-24).
- **No durable clustering.** Every node has a 768-dim **embedding** (`vec_node`, written at write
  time, used by recall's semantic KNN) — but it is **never used for clustering**. The schema supports
  `community` nodes + `MEMBER_OF` edges, yet **0 communities** exist.
- **Clients can't set summary.** The `node` table has `name`/`summary` columns but `memory_write`
  neither accepts nor writes them, so every episode's `summary` is null.
- **The enrichment "brain" is an LLM, non-deterministic, and gated.** The `memory-organizer` (an
  `agent` member) is the only component that extracts entities/relations/importance/contradictions/
  reflections, and it does so via a **structured-output LLM call** to an external provider
  (`MEMORY_PROVIDER_URL/KEY`). When the provider is unset or unreachable it **silently** degrades to a
  stub (`deterministicOrganize`: word-count importance, capitalized-word "entities", no relations, no
  contradictions, no reflections). It **does not form communities at all**. Results are
  non-reproducible, depend on a running daemon + an external model, and there is no signal in the data
  recording whether an episode was organized by the LLM or the stub.

**Net:** provenance is missing, topic/tags are unstructured, clustering is absent despite the
embeddings being present, and the structuring pipeline is LLM-dependent and non-deterministic.

## 2. Goals

1. **Replace the LLM `memory-organizer` with a deterministic, in-process enrichment pipeline.** No
   external provider, no daemon IPC, no LLM. Same-or-better structured output, reproducible, fast,
   free. The pipeline MAY be extracted to a **shared package** (e.g. `@adhd/sox-memory-enrich`) so it is
   reusable by the library, the MCP server, and the CLI.
2. **If enrichment moves in-process / to a shared package, the `memory-organizer` member is FULLY
   removed** — the agent extension, its provider config, the daemon's organizer queue + `organizeItems`
   IPC, and all references (bundle `members[]`, registry, install-registry, docs). No vestige.
3. **Capture the metadata that broadens use cases** — caller provenance (project path), durable tags,
   durable topic/cluster, client-supplied summary, and arbitrary metadata — as first-class,
   queryable, structured fields/edges, set at (or immediately after) write time.
4. **Use the embeddings that already exist** for deterministic semantic clustering → `community`
   nodes + `MEMBER_OF` edges, so topics are real graph structure, not parsed text.
5. **Keep determinism observable** — record enrichment provenance (which pass produced what), so
   nothing degrades silently.

## 3. Non-goals

- LLM-based extraction/summarization (explicitly removed; a future optional LLM *augmentation* pass
  may be reconsidered, but the default and the contract are deterministic).
- Changing the embedding backend (bge-base-768 stays; BL-2).
- Multi-machine/distributed memory.
- OS-kernel sandboxing (out of scope per C6).

## 4. Deterministic enrichments (the substance)

Each is **deterministic** (no provider, reproducible given the same DB state). The architect/ML
reviewer should validate the algorithm choices and add any missing enrichments.

| # | Enrichment | Deterministic approach | Produces |
|---|------------|------------------------|----------|
| E1 | **Caller provenance** | capture project/repo path (cwd → nearest repo root), agent_id, session_id, source at write | new `project_path` field + provenance metadata |
| E2 | **Client summary** | accept + persist `summary` (and optional `name`/title) from the caller | `node.summary` / `node.name` populated |
| E3 | **Arbitrary metadata** | persist caller `metadata` as JSON (new `meta` column) instead of dropping it | `node.meta` (queryable via json_extract) |
| E4 | **Durable tags** | persist the raw `tags[]` as a structured field **and** keep the entity nodes + `MENTIONS` | `node.tags` (JSON) + `MENTIONS` edges |
| E5 | **Durable topic** | derive a topic from (a) explicit `[<topic>]` prefix, (b) tags, (c) the cluster (E6) — store it | `node.topic` + `MEMBER_OF`→ topic/community |
| E6 | **Embedding clustering** | deterministic clustering over `vec_node` (HDBSCAN / agglomerative / k-means / cosine-threshold — reviewer picks); incremental + reproducible (stable seeding/ordering) | `community` nodes + `MEMBER_OF` edges, with a representative label |
| E7 | **Importance scoring** | deterministic signal blend: length, recency, in/out link degree, access_count, tag/topic salience (no LLM) | `node.importance` |
| E8 | **Near-duplicate / supersession** | `content_hash` exact-dup (exists) + embedding cosine ≥ τ for semantic near-dups; explicit `SUPERSEDES` from the client | `SAME_AS` / `SUPERSEDES` edges, `t_invalid` on superseded |
| E9 | **Auto-links** | `DERIVED_FROM` (chunk→parent, exists), `RELATES_TO` (shared-entity co-occurrence above a threshold) | `edge` rows |
| E10 | **Extractive summary** (replaces LLM reflection) | extractive summarization (lead-N sentences / TextRank over the node's own content) when no client summary | `node.summary` fallback |
| E11 | **Maintenance** | recency decay (exists), reindex/re-embed (exists) | updated scores/vectors |
| E12 | **Enrichment provenance** | stamp which pass/version produced each derived field/edge (`origin`, `meta`) | auditability; no silent degradation |

## 5. Architecture

- **In-process enrichment.** Enrichment runs synchronously (or in a fast post-write microtask) inside
  the writing process — no `organizer_queue` round-trip, no daemon, no IPC, no provider. Clustering
  (E6) and maintenance (E11) MAY run as a periodic/triggered batch pass (still deterministic, still
  in-process or in a CLI/daemon-hosted loop) because they are O(corpus).
- **Shared package option.** Extract the pipeline to `@adhd/sox-memory-enrich` consumed by `memory-core`
  (write path), the MCP server, and `memory-cli`. The architect should decide package boundary +
  whether the existing `memory-daemon` is repurposed (as a deterministic batch-cluster host) or also
  removed.
- **Schema changes** (migration, idempotent `ALTER TABLE … ADD COLUMN` guarded by `pragma table_info`):
  `node.meta TEXT`, `node.tags TEXT`, `node.topic TEXT`, `node.project_path TEXT` (or a normalized
  provenance table — reviewer decides). Backfill plan for existing stores.
- **Removal of `memory-organizer`** — see §6.

## 6. Removal of the LLM organizer (mandatory if enrichment is in-process/shared)

When the deterministic pipeline lands, remove **all** of:

- `extensions/bundles/sox-memory-bundle/members/memory-organizer/` (the agent extension).
- the `memory-daemon` provider config (`provider_url/key/model`) and the `organizeItems` IPC + the
  organizer LLM path in `memoryd.ts` (`processIngestBatch` LLM branch); the `organizer_queue`'s
  `ingest` op becomes a deterministic enrichment trigger (or is removed if enrichment is synchronous).
- `sox-memory-bundle` `members[]` entry + description mention; registry entry; install-registry record.
- docs/CLAUDE.md references.
- Re-point anything that imported the organizer.
**Acceptance:** `grep -ri memory-organizer` returns only historical/changelog references; the bundle
installs + runs with zero LLM provider configured; enrichment output is byte-reproducible across runs.

## 7. Broadened use cases (drives the consumer-interface design — for the architect)

The enrichment exists to enable these; the architect should expand and prioritize them:

- **Provenance-scoped recall** — "recall X from project /Users/nix/dev/ai/foo" / "across all projects".
- **Topic discovery & browsing** — list topics/communities with sizes + labels; drill into a topic.
- **Entity & relationship navigation** — what mentions entity E; what supersedes/derives-from what.
- **Auditable mirror** — the BL-20 markdown export reads the *structured* topic/tags/summary/provenance
  (not parsed text), renders entities by name (BL-22), and auto-refreshes (BL-21).
- **Cross-project / cross-agent knowledge reuse** — find related memory regardless of who/where wrote it.
- **Curation** — merge near-dups, promote/demote importance, re-cluster.

## 8. Folded backlog items

This spec subsumes and resolves: **BL-21** (auto-refresh export), **BL-22** (entity names),
**BL-23** (dropped metadata / no project-path provenance), **BL-24** (tags/cluster not structured),
plus the "organizer doesn't form communities / is LLM-gated / silently degrades" findings.

## 9. Acceptance criteria (high level)

1. Memory can be written with: content, **summary**, **tags** (retained), **topic**, **metadata**,
   and **caller project path** — all persisted and queryable.
2. Topics/communities are formed **deterministically from embeddings** (≥0 LLM calls), with stable,
   reproducible output and human-readable labels.
3. `memory-organizer` is **fully removed**; the bundle runs with no provider configured; enrichment is
   byte-reproducible.
4. The markdown export reads structured fields (topic/summary/provenance/entity-names) and stays
   current.
5. Full `build,lint,test`, `validate --strict`, e2e, and registry gates green.

## 10. Deliverables sequence

1. **This SPEC** → reviewed + extended by an architect/ML reviewer, who then authors
   `DESIGN.md` (algorithm choices, schema, removal plan, package boundary) and
   `CONSUMER-INTERFACES.md` (discovery + use-case-driven interface design).
2. **API designer** authors `CONTRACTS.md` (the MCP tool contracts, the `@adhd/sox-memory-enrich` API
   surface, the discovery/query interfaces, schema/types) from the extended spec + consumer interfaces.
3. Implementation plan (phased) follows.
