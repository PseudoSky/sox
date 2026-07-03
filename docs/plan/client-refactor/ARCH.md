# Client Refactor — Architecture Addendum

> **Status:** Complete · **Authored:** 2026-07-02 · **Resolved:** 2026-07-02
>
> All 5 segments S1–S5 implemented, reviewed, and merged.
> See commit `0ff4d81` for the full change set.
>
> Extends BL-112 (memory-core stale duplicates) with the full refactoring of the
> newly extracted `client/` layer and the raw-SQL gap between memory-server and
> the `libs/data/` packages.

---

## 1. Motivation

The memory-server's `handleToolCall` function grew to ~1100 lines of inline SQL and
domain logic. The `client/` directory at `extensions/bundles/sox-memory-bundle/members/memory-server/src/client/`
was extracted to factor this into one-file-per-tool with named exports and inputSchema
consts — but 12 of the 18 tool files still contain raw SQL that duplicates what either
`@adhd/sox-memory-core` or `@adhd/sox-graph-store` already provide.

## 2. Target architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    memory-server (MCP)                       │
│  handleToolCall → imports client functions, wraps results   │
│  as MCP ToolResult, applies policy enforcement               │
├─────────────────────────────────────────────────────────────┤
│                     client/ (thin pass-through)              │
│  validates args, calls memory-core, returns plain objects    │
│  NO raw SQL, NO MCP references                               │
├─────────────────────────────────────────────────────────────┤
│                   @adhd/sox-memory-core                       │
│  domain logic: write, recall, update, cluster, embed         │
│  imports from data/ packages for storage primitives           │
│  imports from graph-store for edge operations                 │
├──────────────────┬──────────────────┬────────────────────────┤
│ @adhd/sox-       │ @adhd/sox-       │ @adhd/sox-            │
│ graph-store      │ vector-store     │ analysis / ingest /   │
│ (edge CRUD)      │ (vector search)  │ embedding-provider    │
│                  │                  │ (primitives)          │
└──────────────────┴──────────────────┴────────────────────────┘
```

## 3. Refactoring batches

### Batch A — BL-112: Stale memory-core duplicates → `libs/data/` imports

Swap memory-core's local copies for imports from the canonical data packages.
**No behavior change, no new tests needed** — existing tests continue to pass.

| memory-core file | Replace with | Priority |
|---|---|---|
| `extractive.ts` | `ingest().summary` from `@adhd/sox-ingest` | 1 |
| `importance.ts` | `scoreImportance()` from `@adhd/sox-analysis` | 2 |
| `neardup.ts` | `detectNearDupPairs()` from `@adhd/sox-analysis` | 3 |
| `cluster.ts` | `cluster()`, `clusterStore()` from `@adhd/sox-analysis` | 4 |
| `autolink.ts` | `setOverlapMatrix()` from `@adhd/sox-analysis` (partial) | 5 |
| `embed.ts` | Thin wrapper around `createEmbeddingProvider()` — keep | — |

**Each file:** delete the local `.ts` file, update `index.ts` re-export to import from
`@adhd/sox-*`, run `nx test memory-core` to confirm no regressions.

### Batch B — client SQL → memory-core + graph-store

Three groups:

#### B1. Replace raw SQL with existing memory-core function (no new code)

| client file | Current | Replace with |
|---|---|---|
| `search-entities.ts` | raw SQL LIKE | `memorySearchEntities()` from `libs/memory-core/src/extensions.ts` |
| `get-community.ts` | raw SQL MEMBER_OF join | `memoryGetCommunity()` from `libs/memory-core/src/extensions.ts` |
| `invalidate.ts` | raw SQL txn | `memoryInvalidate()` from `libs/memory-core/src/write.ts` |

**Each file:** delete all body code, replace with a thin wrapper that calls the
memory-core function, maps args, and returns the shape the client expects (plain
object, not MCP ToolResult).

#### B2. Add new functions to memory-core using graph-store

| client file | New memory-core function | Uses graph-store for |
|---|---|---|
| `link.ts` | `memoryLinkNode()` | `getEdges()` dupe check + raw INSERT |
| `related.ts` | `memoryGetRelated()` | `getEdges({src?, dst?, rel?})` |
| `entity-episodes.ts` | `memoryGetEntityEpisodes()` | `getEdges({dst, rel:'MENTIONS'})` |
| `list-entities.ts` | `memoryListEntities()` | `getEdges({rel:'MENTIONS'})` |
| `near-duplicates.ts` | `memoryGetNearDuplicates()` | `getEdges({rel:'SAME_AS'})` |
| `supersession-chain.ts` | `memoryGetSupersessionChain()` | `getEdges({rel:'SUPERSEDES'})` BFS |
| `get-session-state.ts` | `memoryGetSessionState()` | `graph-backend.getNode()` |
| `save-session-state.ts` | `memorySaveSessionState()` | `graph-backend.getNode()` + txn |

**Each file:** extract the SQL into `libs/memory-core/src/` as a new file (e.g.,
`link.ts`, `related.ts`, `session.ts`) with an exported async function. The
function takes `(db, args)` and returns a plain object. Use
`createGraphBackend(db).getEdges({src, dst, rel})` for all edge queries instead
of raw SQL. The client file then becomes a thin import-and-call wrapper.

#### B3. Add domain-specific queries to memory-core (no graph-store needed)

| client file | New memory-core function | Type |
|---|---|---|
| `topics.ts` | `memoryListTopics()` | SQL aggregate (GROUP BY topic) |
| `list-projects.ts` | `memoryListProjects()` | SQL aggregate (COUNT DISTINCT project_path) |
| `curate.ts` | `memoryCurate()` | Dispatcher to existing cluster functions |
| `stats.ts` | `memoryGetStats()` | Composes `clusterStats()` + `getEmbedHealth()` |

#### B4. Client shared helpers → memory-core

| `db.ts` helper | New home in memory-core | Refactor via |
|---|---|---|
| `isSuperseded()` | `libs/memory-core/src/recall.ts` (already exists inline) | Make exported, import from client |
| `supersedesUidForRowid()` | `libs/memory-core/src/recall.ts` (already exists inline) | Make exported, import from client |
| `communityUidForRowid()` | `libs/memory-core/src/recall.ts` (already exists inline) | Make exported, import from client |
| `rowidsToUids()` | `libs/memory-core/src/recall.ts` (already exists inline) | Make exported, import from client |
| `parseTags()` | `libs/memory-core/src/recall.ts` (already exists inline) | Make exported, import from client |
| `getDb()` | `libs/memory-core/src/db.ts` (connection cache) | Already in `openDb`, add caching layer |

## 4. File change summary

### Files to delete from memory-core (Batch A)

```
libs/memory-core/src/extractive.ts    → replaced by @adhd/sox-ingest
libs/memory-core/src/importance.ts    → replaced by @adhd/sox-analysis
libs/memory-core/src/neardup.ts       → replaced by @adhd/sox-analysis
libs/memory-core/src/autolink.ts      → replaced by @adhd/sox-analysis (partial)
```

### Files to create in memory-core (Batch B2 + B3)

```
libs/memory-core/src/link.ts          → memoryLinkNode()
libs/memory-core/src/related.ts       → memoryGetRelated()
libs/memory-core/src/entity-episodes.ts → memoryGetEntityEpisodes()
libs/memory-core/src/list-entities.ts  → memoryListEntities()
libs/memory-core/src/near-duplicates.ts → memoryGetNearDuplicates()
libs/memory-core/src/supersession-chain.ts → memoryGetSupersessionChain()
libs/memory-core/src/session.ts       → memoryGetSessionState() + memorySaveSessionState()
libs/memory-core/src/topics.ts        → memoryListTopics()
libs/memory-core/src/projects.ts      → memoryListProjects()
libs/memory-core/src/curate.ts        → memoryCurate()
libs/memory-core/src/stats.ts         → memoryGetStats()
```

### Files to simplify in client/ (Batch B1–B4)

All 18 client files become thin wrappers: validate args, call the memory-core
function, return the result. ~20 lines each instead of ~100.

### Files remaining in client/ (unchanged)

```
client/ping.ts       → calls getContentAddress() + embed health (server identity)
client/db.ts         → 6 helpers move to core; getDb moves to core/db.ts
```

`client/db.ts` can be deleted entirely when all helpers are migrated.

## 5. Dependency graph

```
Batch A  (no deps)            → extractive, importance, neardup, autolink
Batch B1 (no deps)            → searchEntities, getCommunity, invalidate
Batch B2 (depends on graph-store) → link, related, entityEpisodes, listEntities,
                                    nearDuplicates, supersessionChain, session
Batch B3 (no deps)            → topics, projects, curate, stats
Batch B4 (depends on B2/B3)   → db.ts helpers migrate
```

Batches A and B1 are independent and can run in parallel. B2 depends on the
graph-store API but can start immediately (graph-store already exists). B3 is
independent. B4 depends on B2/B3.

## 6. Test strategy

- **Batch A:** `nx test memory-core` must pass before and after each swap (existing
  tests cover the same behavior through the memory-core path).
- **Batch B1:** `nx test memory-server` + `nx test memory-core` must pass. No new
  tests needed — the existing tool invocations exercise the same code path.
- **Batch B2/B3:** Add `describe` blocks to the memory-core test suite for each new
  function. At minimum: one happy-path test with a seeded in-memory database.
- **Integration:** `node scripts/smoke-test.mjs --extension memory-server` must pass
  after each batch (the MCP tools are exercised via the proxy).

## 7. Completion criteria

1. `nx test memory-core` — 160+ passed, 0 failed
2. `nx test memory-server` — 84+ passed, 0 failed
3. `node scripts/smoke-test.mjs` — 16+ passed, 0 failed
4. `grep -r "SELECT.*FROM.*edge\|INSERT INTO edge" extensions/bundles/sox-memory-bundle/members/memory-server/src/client/` — 0 matches
5. All 12 client SQL functions are either calling a memory-core function or have
   been promoted into memory-core
6. `libs/memory-core/src/extractive.ts`, `importance.ts`, `neardup.ts`, `autolink.ts`
   no longer exist
