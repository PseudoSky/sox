# CONSUMER INTERFACES — Memory Enrichment Discovery and Use
<!-- companion to SPEC.md + DESIGN.md; input to API designer for CONTRACTS.md -->

**Status:** architect-authored, ready for API design phase
**Author:** architect-reviewer (agent)
**Date:** 2026-06-22
**Prereqs:** SPEC.md (problem / goals), DESIGN.md (algorithm decisions, schema)

---

## CI0. Purpose of this document

This document describes **what consumers need and why** — the use cases, the
operations they imply, and the abstract discovery affordances a caller should be able
to rely on. It does **not** define wire contracts, function signatures, or JSON schemas;
that is the API designer's job in `CONTRACTS.md`.

The audience is the API designer and the implementation team. Each section answers:

- Who is the consumer?
- What do they want to accomplish?
- What abstract operations enable it?
- What inputs and filters make sense?
- What outputs and discovery affordances are needed?
- Why does this use case matter to the enrichment goals?

---

## CI1. Use case index

| # | Use case | Primary consumer | Enrichment fields used |
|---|----------|-----------------|----------------------|
| UC1 | Provenance-scoped recall | Agent, human | `project_path` |
| UC2 | Topic discovery and browsing | Human, tool | `topic`, `MEMBER_OF` |
| UC3 | Entity and relationship navigation | Agent, human | `MENTIONS`, `RELATES_TO`, `SUPERSEDES` |
| UC4 | Auditable markdown mirror | Export tool, human reviewer | all structured fields |
| UC5 | Cross-project and cross-agent knowledge reuse | Agent | `project_path`, `topic`, embeddings |
| UC6 | Curation — merge, promote, tag | Human operator | all writable fields |
| UC7 | Importance-ranked feed | Agent, dashboard | `importance`, `t_created`, `topic` |
| UC8 | Temporal history of a claim | Agent, auditor | `t_valid`, `t_invalid`, `SUPERSEDES` |
| UC9 | Near-duplicate management | Agent, operator | `SAME_AS`, `content_hash` |
| UC10 | Enrichment health and introspection | Operator, CI | `enrich_ver`, cluster stats |

---

## CI2. UC1 — Provenance-scoped recall

### Consumer

An agent working on project `/Users/nix/dev/ai/foo` wants to recall episodes written
while working in that project context, not from other projects. Alternately, a human
asks "what did I learn about authentication in the sox-ecosystem project?"

### Problem without enrichment

Today `memory_recall` has no `project_path` filter (`recall.ts:26–37`). All episodes
from all agents in a scope are returned together. An agent working in 5 projects
simultaneously gets noise from all of them.

### Operations needed

**Filtered recall:**

- Input: query (semantic text), plus optional `project_path` filter (exact match or
  prefix match for monorepos with sub-paths).
- Filter semantics: `project_path = ?` (exact) OR `project_path LIKE '?/%'` (subtree).
- Scope: applies within a single store or across federated stores.
- Output: ranked episodes, each carrying `project_path` in the result for transparency.

**Project listing:**

- Input: none (or scope filter).
- Output: list of distinct `project_path` values present in the store, with episode
  counts and the most recent episode timestamp per path.
- Purpose: lets a caller discover which projects have written memory before issuing
  a filtered recall.

### Discovery affordances

- `list_projects` operation: returns `[{ project_path, episode_count, last_written }]`
  sorted by `last_written` descending.
- The result of a filtered recall includes `project_path` on each result item so the
  caller can see which project each memory came from (useful in cross-project queries).

### Why this matters

Provenance scoping is what makes per-project memory meaningful. Without it, the user-
scoped memory store becomes a undifferentiated blob. With it, an agent can answer
"what did we learn in this project" as a first-class query.

---

## CI3. UC2 — Topic discovery and browsing

### Consumer

A human user or a browsing tool wants to understand the structure of their memory:
"what topics does my memory contain?", "how many episodes are about authentication?",
"show me all the authentication episodes in importance order."

### Problem without enrichment

Today, topics exist only as a `[<topic>]` text prefix convention in `content`. The DB
cannot group by topic; the export has to regex-parse `content` (fragile,
`export.ts:93`). There is no queryable topic column and no `MEMBER_OF` community
structure.

### Operations needed

**Topic listing:**

- Input: none (or `project_path` filter, `scope` filter).
- Output: `[{ topic, episode_count, avg_importance, last_written, has_community }]`
  sorted by `episode_count` descending (or by `avg_importance`).
- `has_community` indicates whether the topic is backed by an embedding-derived cluster
  (E6) vs. only by the `[<topic>]` prefix convention.

**Topic drill-down (browse a topic):**

- Input: `topic` string (exact match).
- Output: episodes in that topic sorted by `importance` descending, `t_created`
  descending. Include `uid`, `summary` (or first 80 chars of `content`), `importance`,
  `t_created`, `project_path`, `tags`.
- Pagination: `limit` + `offset` or cursor.

**Community membership (graph view):**

- Input: `community_uid`.
- Output: the community node (label, centroid quality metrics) + its member episodes
  (same fields as topic drill-down).
- Purpose: the embedding-derived community view may differ from the text-prefix topic
  grouping. Both are useful; the API should expose both.

**Topic search:**

- Input: partial topic name string.
- Output: topics whose name matches (prefix or substring), with episode counts.

### Discovery affordances

- `list_topics` returns the full topic vocabulary with counts — a pre-flight call
  before a topic-filtered recall.
- Each topic drill-down result includes the `community_uid` when a cluster backs the
  topic, enabling navigation to the graph view.
- The `has_community` flag on `list_topics` tells the consumer whether the topic has
  structural backing (useful for trust calibration — a purely prefix-derived topic is
  weaker than a cluster-backed one).

### Why this matters

Topic browsing turns the memory store from a retrieval-only system into a knowledge
base that can be explored. It is also the primary driver of the auditable mirror (UC4):
the export is organized by topic because topics are the natural human-scale grouping.

---

## CI4. UC3 — Entity and relationship navigation

### Consumer

An agent that has recalled an episode wants to know: "what else mentions this entity?",
"what is this claim derived from?", "has this claim been superseded?". A human auditor
wants to trace the provenance of a belief through the graph.

### Problem without enrichment

Entities are written as nodes (`kind='entity'`) with `MENTIONS` edges, but there is
no API to ask "what mentions entity X?" without knowing the entity's internal rowid.
`SUPERSEDES` edges exist in the schema but no tool exposes them. `DERIVED_FROM` is in
the schema but never auto-emitted.

### Operations needed

**Entity lookup by name:**

- Input: entity name string (exact or case-insensitive).
- Output: entity node(s) matching the name: `uid`, `name`, `summary`, `t_created`.
- Purpose: translate human-readable entity names to graph handles.

**Episodes mentioning an entity:**

- Input: entity `uid` (or name, resolved first).
- Output: episodes with a `MENTIONS` edge to that entity. Fields: `uid`, `summary`,
  `topic`, `project_path`, `importance`, `t_created`.
- Sorted by `importance` descending.

**Related episodes (graph traversal):**

- Input: episode `uid`, optional `rel` filter (e.g. only `RELATES_TO`, or all).
- Output: neighbor episodes within depth=1, each with the edge relation type + weight.
- Purpose: "show me what else is related to this episode" — the enrichment-derived
  graph connections.

**Supersession chain:**

- Input: episode `uid`.
- Output: the chain of `SUPERSEDES` edges: `[{ superseded_by, t_invalid, reason }]`.
  Both directions: "what does this supersede?" and "is this superseded by something?"
- Purpose: lets a consumer understand the belief lifecycle of a claim.

**Entity list:**

- Input: none (or `project_path` / `topic` filter).
- Output: `[{ uid, name, mention_count, first_seen, last_seen }]` sorted by
  `mention_count` descending.
- Discovery affordance: explore the entity vocabulary without knowing entity UIDs.

### Discovery affordances

- `list_entities` with `mention_count` makes the most-discussed entities in a
  project/topic immediately visible.
- Entity search (substring) for navigating to an entity by approximate name.
- Each episode result in UC2 should include its `tags` array (entity names) for
  quick entity-to-episode navigation without a graph traversal.

### Why this matters

Entity and relationship navigation is what makes the graph structure useful beyond
raw recall. It enables exploratory browsing ("what do I know about project-X's
auth system?") and auditability ("this claim was superseded by this other claim on
date Y").

---

## CI5. UC4 — Auditable markdown mirror

### Consumer

A human reviewer (or a CI gate) reading the memory export as git-diffable markdown.
The export tool (`export.ts`) reads the DB and renders `topics/<slug>/<uid>.md` files.

### Problem without enrichment

The export currently reads `topic` from a fragile regex on `content` (`export.ts:93`),
renders `summary` as null (the column is never populated today), omits tags and
project provenance from frontmatter, and entity names in the frontmatter are UIDs
(`collectMentionedEntities` returns `uid` not `name`, `export.ts:142–153`).

### What the export needs from enrichment

After enrichment lands, the export should read:

- `node.topic` (the durable, queryable topic column — no regex needed).
- `node.summary` (populated by E2 client summary or E10 extractive fallback).
- `node.tags` (the raw tag list, rendered as YAML frontmatter array).
- `node.project_path` (rendered as frontmatter `project` field).
- Entity names: join `MENTIONS` edges to `node.name` (already supported structurally,
  but currently the export returns UIDs; it should return names per BL-22).

### Operations needed

These are **internal** to the export function — not new consumer-facing tools. But the
API designer should ensure the DB query interface supports them efficiently:

**Episode with all enrichment fields:**

- A single read query that returns `uid`, `content`, `name`, `summary`, `topic`,
  `tags`, `project_path`, `importance`, `t_created`, `agent_id`, `session_id` per live
  episode node.
- Plus joins: entity names from `MENTIONS`, `SUPERSEDES` targets, `DERIVED_FROM`
  parents.

**Auto-refresh trigger:**

- The export should be triggerable after each write (or on a periodic basis). The
  `memory-cli` and `memory-server` should expose an explicit `export` operation
  (currently `export.ts` is called programmatically but not exposed as a tool).
- BL-21: auto-refresh on write is a desired property. The implementation option:
  the daemon batch pass triggers an export run after each clustering cycle.

### Discovery affordances

The export's `INDEX.md` already lists topics with counts. After enrichment:

- Add `project_path` breakdown per topic in the top-level `INDEX.md`.
- Add an `ENTITIES.md` index listing the top-N entities across all topics.

### Why this matters

The markdown mirror is the primary human interface to the memory store. If it reads
stale or unstructured data, the entire enrichment effort has no visible output for
human reviewers.

---

## CI6. UC5 — Cross-project and cross-agent knowledge reuse

### Consumer

An agent starting work on a new project wants to find relevant memory regardless of
which project or agent originally wrote it. Example: "what do we know about JWT
authentication, from any project?" or "find all observations from any agent about
TypeScript module resolution."

### Problem without enrichment

Federated recall (`federatedRecall`, `recall.ts:504`) already crosses scopes, but
there is no way to express "from any project" vs. "from this project" or to filter
by topic/entity across the federation. The `project_path` column doesn't exist yet.

### Operations needed

**Cross-project topic query:**

- Input: `topic` string (or embedding query), optional `exclude_project_path` to
  exclude the current project (to find what was learned *elsewhere*).
- Output: ranked episodes across all stores with `project_path` in each result.
- The federation already applies `SCOPE_WEIGHTS`; this adds a topic pre-filter before
  the RRF fusion.

**Agent-agnostic recall:**

- Input: query + scope list; no `agent_id` filter.
- Output: all matching episodes regardless of `agent_id`, with `agent_id` + `project_path`
  in the result for attribution.
- This is already possible with `federatedRecall` without `agent_id` filter; the
  enrichment adds `project_path` to the result payload so the consumer can do its own
  attribution.

**Shared entity exploration:**

- Input: entity name; no project filter.
- Output: all episodes mentioning that entity across all accessible stores, with
  `project_path` per result.
- Enables "what do we collectively know about X?"

### Discovery affordances

- `list_projects` (from UC1) doubles as a cross-project discovery tool when called
  against the federated layer.
- A federated `list_entities` (entity names + mention counts across all stores) would
  surface the globally most-discussed concepts. This is a Phase 2 feature; mark as TODO
  in the API design.

### Why this matters

The value of a user-scoped or org-scoped memory store is that knowledge from one
project context is available when needed in another. Without project_path filtering,
cross-project queries suffer from noise; with it, the consumer can deliberately
include or exclude specific project contexts.

---

## CI7. UC6 — Curation: merge, promote, tag, re-cluster

### Consumer

A human operator (or a maintenance CLI command) who wants to:

- Merge two near-duplicate episodes manually.
- Promote an episode's importance.
- Add or correct tags on an existing episode.
- Force a re-cluster pass.
- Override a community label.

### Problem without enrichment

Today there is no curation surface. The only mutation operations are `memory_write`
(new episodes) and `memory_invalidate` (supersede/close a claim, `write.ts:179`).

### Operations needed

**Tag an existing episode:**

- Input: `uid`, `tags[]` to add.
- Output: updated `node.tags`, new entity nodes + `MENTIONS` edges for any new tags.
- Semantics: additive (append to existing tags, deduplicated).

**Correct or set topic:**

- Input: `uid`, `topic` string.
- Output: `node.topic` updated; `MEMBER_OF` edge to the matching community updated
  (or a new ad-hoc community created if no embedding cluster covers this topic).
- This is a user-override of the cluster-derived topic. It should be respected by the
  export and by topic-filtered recall.

**Promote or demote importance:**

- Input: `uid`, `importance` (1–10 float).
- Output: `node.importance` overridden. The enrichment batch pass should not overwrite
  a user-set importance (add a `importance_locked BOOLEAN` flag or a convention:
  if `enrich_ver` contains `"user_override": true`, skip the automatic recalculation).

**Merge near-duplicates:**

- Input: `uid_keep`, `uid_drop`.
- Output: invalidate `uid_drop` (`t_invalid` set), create `SAME_AS` edge from
  `uid_keep → uid_drop`. All edges formerly pointing to `uid_drop` are NOT rewritten
  (bi-temporal: the history is preserved). Future recall suppresses `uid_drop` via
  `SUPERSEDES`/`SAME_AS` suppression.

**Force re-cluster:**

- Input: none (or `project_path` filter).
- Output: enqueues a full re-cluster op in `organizer_queue`. Returns immediately;
  cluster results available after the next daemon batch pass.

### Discovery affordances

- The curation operations expose a **diff surface**: "what would change if I merged
  these two episodes?" — a dry-run mode that returns the proposed changes without
  committing them.
- `list_near_duplicates`: return pairs `[{ uid_a, uid_b, cosine_sim }]` for pairs
  above a configurable threshold. Enables human-driven deduplication.

### Why this matters

Automated enrichment will make mistakes (wrong cluster assignment, missed topic).
Curation is the safety valve that lets the human correct the automated pipeline without
destroying history.

---

## CI8. UC7 — Importance-ranked feed

### Consumer

An agent at session start that wants "the top N most important things I know about
this project / topic" — a knowledge briefing. A dashboard rendering a summary of
the memory store.

### Problem without enrichment

`importance` defaults to `1.0` for all episodes (`write.ts:62`). The LLM organizer was
supposed to assign real values but (a) it is async, (b) it is LLM-dependent. After
enrichment, the deterministic importance blend (DESIGN.md D2, E7) produces meaningful
scores.

### Operations needed

**Ranked feed:**

- Input: optional `topic` filter, optional `project_path` filter, optional `tags`
  filter (any-match), `limit` (default 10).
- Sort: `importance` descending, then `t_created` descending for ties.
- Output: episodes with `uid`, `summary` (or first 80 chars of content), `topic`,
  `tags`, `importance`, `t_created`, `project_path`.

**Topic summary card:**

- Input: `topic` string.
- Output: the single highest-importance episode in that topic (the "representative
  memory"), plus metadata (episode count, avg importance, last written).
- Purpose: a quick "headline" view of what the topic contains.

### Discovery affordances

- The ranked feed is the default output of a zero-query recall: "give me the most
  important things" without a semantic search query. This is a degenerate case of
  `memory_recall` with no `query` text — which currently requires a query string.
  The API should support `query: null` or an empty query that falls back to
  importance-ranked listing.

### Why this matters

Agents at session start benefit from a knowledge briefing. Today this is not possible
because importance scores are uniformly `1.0`. The deterministic blend makes this
meaningful.

---

## CI9. UC8 — Temporal history of a claim

### Consumer

An auditor or agent that wants to understand how a belief evolved: "what was known
about X as of date Y?", "when was this claim superseded and by what?"

### Problem without enrichment

The `t_valid`/`t_invalid` bi-temporal system already exists (`schema.ts:39`).
`memoryRecall` supports `as_of` (`recall.ts:28`). But there is no operation to
traverse the `SUPERSEDES` chain of a specific claim, and the `SUPERSEDES` edges
created by `memoryInvalidate` (`write.ts:210`) lack a `reason` field in the consumer
API surface (it's buried in `edge.meta`).

### Operations needed

**Point-in-time recall:**

- Input: query, `as_of` ISO timestamp.
- Output: episodes valid at that timestamp (already supported; surface this affordance
  more prominently in the API).

**Supersession chain for a uid:**

- Input: `uid`.
- Output: `{ uid, t_created, t_invalid, superseded_by: { uid, t_created, reason }? }`.
  Follows the chain until `superseded_by` is null (current canonical version).
- Inverse: "what does this uid supersede?" (the uid's `SUPERSEDES` edges pointing to
  older claims).

**Claim history summary:**

- Input: `uid` (any point in the supersession chain).
- Output: the full chain from oldest to newest, with timestamps and reasons.
  e.g.: `[v1 (2025-01-01, superseded 2025-02-15 reason="updated") → v2 (2025-02-15, current)]`.

### Discovery affordances

Each episode result from any recall operation should include:

- `is_superseded: boolean` (has a `SUPERSEDES` edge pointing to it).
- `supersedes_uid: string | null` (the uid this episode supersedes, if any).
These allow the consumer to immediately know if a result is current or historical.

### Why this matters

The bi-temporal model is the most distinctive feature of the memory graph. Without a
consumer-facing way to navigate supersession chains, the model is unused by callers.
Surfacing it enables genuine auditability.

---

## CI10. UC9 — Near-duplicate management

### Consumer

An agent or operator that wants to see which episodes are nearly identical (E8:
`SAME_AS` edges), and manage deduplication. Also relevant to the curate flow (UC6).

### Operations needed

**List near-duplicate pairs:**

- Input: optional `topic` or `project_path` filter, `threshold` (default `0.95` real,
  `0.98` hash).
- Output: `[{ uid_a, uid_b, cosine_sim, content_a_preview, content_b_preview }]`.
- These are pairs connected by `SAME_AS` edges or pairs above threshold not yet
  linked (pre-dedup proposals).

**Dedup status of a uid:**

- Input: `uid`.
- Output: `{ is_canonical: boolean, duplicate_of: uid | null, duplicates: uid[] }`.
  `is_canonical` = true if `t_invalid IS NULL` (the surviving copy).
  `duplicate_of` = the canonical uid if this node was invalidated as a duplicate.
  `duplicates` = uids invalidated because they are duplicates of this uid.

### Discovery affordances

The `list_near_duplicates` operation feeds directly into the curation UI (UC6 merge
operation). It should be sortable by `cosine_sim` descending (highest similarity first
— most obvious merges first).

### Why this matters

On high-velocity write workloads (agents writing observations rapidly), near-duplicates
accumulate. Without a management surface, the store degrades in quality: recall returns
redundant episodes, importance scoring is diluted.

---

## CI11. UC10 — Enrichment health and introspection

### Consumer

An operator or CI gate that wants to know: "is the enrichment pipeline healthy?",
"what fraction of nodes have been enriched?", "are there stale clusters from a previous
model version?"

### Operations needed

**Enrichment coverage report:**

- Input: none (or `project_path` filter).
- Output:

  ```
  {
    total_episodes: N,
    with_topic: N,
    with_summary: N,
    with_tags: N,
    with_project_path: N,
    with_community: N,
    legacy_episodes: N,   // enrich_ver IS NULL or "legacy"
    current_enrich_ver: "v1.0.0",
    cluster_count: N,
    largest_cluster_size: N,
    mean_intra_cluster_sim: 0.87,
    embed_model: "bge-base-en-v1.5"
  }
  ```

**Cluster quality stats:**

- Input: none.
- Output: per-cluster `{ community_uid, label, member_count, mean_intra_sim, centroid_uid }`.

**Stale-enrichment detection:**

- Output: episodes where `enrich_ver` records an older pass version than the current
  `@adhd/sox-memory-enrich` version. These are candidates for re-enrichment.

**Re-enrich trigger:**

- Input: optional `uids[]` (specific episodes) or none (all stale).
- Output: enqueues re-enrichment ops. Returns `{ enqueued: N }`.

### Discovery affordances

The enrichment coverage report is the primary health dashboard. It should be available
as a `memory-cli stats` subcommand and as an MCP tool `memory_stats`.

### Why this matters

Enrichment is a background pipeline. Without an introspection surface, operators cannot
tell if it is working, if it ran on all episodes, or if a model change left vectors
stale. Health introspection closes the observability gap.

---

## CI12. Cross-cutting interface concerns

### CI12.1 Filters composition

All query operations should support a consistent filter object:

```
{
  project_path?: string | { prefix: string },
  topic?: string | string[],
  tags?: string[],           // any-match by default; AND-match opt-in
  agent_id?: string,
  as_of?: ISO string,
  importance_min?: number,
  t_created_after?: ISO string,
  t_created_before?: ISO string
}
```

The API designer should decide which of these are supported in Phase 1 vs. deferred.
Minimum set for Phase 1: `project_path` (exact), `topic` (exact), `tags` (any-match).

### CI12.2 Pagination

All list operations (topics, entities, projects, episodes) must support:

- `limit` (max results per page, default 20, max 200).
- `offset` or cursor-based pagination (cursor preferred for stable ordering).

### CI12.3 Result fields

Every episode result from any operation should carry a **consistent minimum field set:**

```
{
  uid: string,
  content: string | null,
  summary: string | null,
  topic: string | null,
  tags: string[],
  project_path: string | null,
  importance: number,
  t_created: string,
  agent_id: string | null,
  is_superseded: boolean,
  supersedes_uid: string | null,
  community_uid: string | null
}
```

This avoids N+1 fetches for consumers that need all these fields.

### CI12.4 Write-path extensions

The `memory_write` tool should accept the full enrichment-aware parameter set so
consumers can assert structured fields at write time rather than waiting for the
batch pass:

```
{
  content: string,                          // required
  summary?: string,                         // E2
  name?: string,                            // E2 title
  topic?: string,                           // E5 override
  tags?: string[],                          // E4
  metadata?: Record<string, unknown>,       // E3
  project_path?: string,                    // E1 override (auto-detected if omitted)
  derived_from_uid?: string,                // E9 DERIVED_FROM explicit
  t_occurred?: string,
  session_id?: string,
  agent_id?: string,
  source?: ...
}
```

### CI12.5 MCP tool vs. library API

The MCP tools (`memory_write`, `memory_recall`, and new discovery tools) are the
external interface used by agents via the Claude `.mcp.json` config. The `@adhd/sox-memory-enrich`
package API is the **internal** interface used by `memory-core`, `memory-daemon`, and
`memory-cli`. The API designer should specify both layers; they need not have identical
signatures.

### CI12.6 Scope vs. store semantics

Each store is a SQLite file for one `(scope, scope_id)` pair. In the current design:

- A `project` store is scoped to the current project directory.
- A `user` store is scoped to the user's home directory.

`project_path` (the column) records the caller's repo root, which is finer-grained
than the store's scope. A user store may contain episodes from multiple projects
(if the user writes memory outside of project scope). The API must clearly distinguish:

- **Store scope** (which `.db` file): controls federation, privacy.
- **`project_path` column** (within a store): controls provenance filtering.

---

## CI13. Use-case priority for Phase 1

The API designer should sequence contract design in this order:

| Priority | Use case | Reason |
|----------|----------|--------|
| P1 | UC4 (auditable mirror) | Directly visible output; unblocks human review |
| P1 | UC1 (provenance-scoped recall) | Highest-frequency agent use case |
| P1 | UC7 (importance-ranked feed) | Session start briefing; depends on E7 landing |
| P2 | UC2 (topic discovery) | Requires clustering (E6) to be meaningful |
| P2 | UC3 (entity navigation) | Requires E9 auto-links to be complete |
| P2 | UC6 (curation) | Depends on all enrichment fields being populated |
| P3 | UC5 (cross-project reuse) | Depends on federated-layer extensions |
| P3 | UC8 (temporal history) | Schema already supports it; API surfacing only |
| P3 | UC9 (near-dup management) | Operational; not a hot path |
| P3 | UC10 (health introspection) | Operational; important but not agent-facing |
