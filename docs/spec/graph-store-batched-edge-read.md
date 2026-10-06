# Spec — `@adhd/sox-graph-store`: a bounded, page-keyed edge read (`getEdges({ srcs, dsts, rels })`)

**Status:** Draft for review — spec only, no code written.
**Builds on:** ADR-0012 (Turso multi-process concurrent-write invariant; supersedes ADR-0007/ADR-0015),
`libs/data/graph/graph-store/src/perf-golden.perf-memory-005.spec.ts` (plan-assertion test convention),
`docs/spec/hybrid-search-optional-loadability-spec.md` (this spec's shape).
**Owning repo:** `/Users/nix/dev/ai/sox-ecosystem` (`libs/data/graph/graph-store/**`).
**Consumer repo:** `/Users/nix/dev/node/adhd` (`entrypoint/backlog/**`).
**Tracked as:** adhd backlog `e54afd3f` (the defect); umbrella `2937e652` ("complete the GraphBackend
primitive surface", `spec: undefined`); same edge-batching class `7816dc8b` (memory `list_entities` N+1)
and `b04e4397` (getNeighbors planner — *different* root cause, see §7).
**Repo convention check:** this repo has **no package-local spec convention** — specs live at
`docs/spec/*.md` (see `docs/spec/` listing). This file is placed there, not next to the store.

---

## 1. Problem

The N+1 fix `b1f35e35` (`assembleIssueCards` → `buildPageReadBatch`,
`entrypoint/backlog/src/query/card.ts:876-1005`) removed per-item round trips by fetching each needed
relation with a **single `graph.getEdges({ rel })`** and filtering the rows in memory by the page's node ids
(`card.ts:921-930`). That genuinely bounds the **round-trip count** — but it moved the **row/byte cost** from
`O(page × per-node degree)` to `O(total live edges of each requested relation)`.

Static evidence:

- `getEdgesInTx` emits `SELECT * FROM edge WHERE t_invalid IS NULL AND rel = ?` — **no `ORDER BY`, no `LIMIT`**
  (`libs/data/graph/graph-store/src/index.ts:2707-2727`; the adhd-consumed build is
  `node_modules/@adhd/sox-graph-store/dist/index.js:2056-2082`).
- The only live-edge indexes are `ix_edge_src_live(src, rel)` and `ix_edge_dst_live(dst, rel)`, both
  `WHERE t_invalid IS NULL` (`src/index.ts:163-164`; dist `:147-148`). **Neither leads with `rel`**, so a
  `rel`-only predicate cannot use them and SQLite scans every live edge of that relation.
- `buildPageReadBatch` loops every needed relation and calls `getEdges({ rel })`, materialising all rows before
  filtering by page ids. The default card (`uid/kind/title/status/priority`) issues **four whole-relation
  scans** — `has_kind`/`has_status`/`has_priority`/`authored_by` (`card.ts:886-891`); `auditTrail` scans the
  whole `audits` relation; `related` scans all `relates_to`/`part_of`/`blocks` (`card.ts:895-908`).

**Impact.** A 20-item page on a 10 000-issue store fetches ~40 000 edge rows where the pre-fix indexed
`getEdges({ src })` read ~100. `card.ts:105` ("cost is independent of page size") is true but obscures that
cost is now **O(store), not O(page)**; the commit benchmark (N=100/250, small store) cannot surface this
because relation cardinality ≈ page size there — **there is no large-store/small-page benchmark.**

**The durable fix is a primitive, not a cache.** `GraphBackend` today exposes no multi-`src` batch read
(`getEdges({ src?, dst?, rel? })` only, `src/index.ts:805,886`; `dist/index.d.ts:322-327,422-427`), which is
why relation-wide reads were chosen. Adding a page-keyed `srcs`/`dsts` read lets the same round-trip bound be
achieved with a **row bound of `O(page × per-node degree)`**.

---

## 2. Goal / Non-goal

**Goal.** A single store-layer primitive — `getEdges({ srcs?, dsts?, rels? })` — that returns exactly the
live edges incident to a supplied page of node ids, using the existing `ix_edge_src_live` / `ix_edge_dst_live`
indexes, so both **round-trips AND rows** are `O(page)`, not `O(relation cardinality)`. It must be a drop-in
replacement for the two shapes `buildPageReadBatch` actually needs (all outgoing of a page; the needed
incoming of a page).

**Non-goal.**

- **No public CLI behaviour change.** The `backlog` CLI's output is byte-for-byte unchanged; only the store
  call shape underneath changes.
- **No new `rel`-leading index.** `getEdges({ rel })` alone stays an O(relation) scan — the hot path stops
  issuing that shape (§3.5). A `rel`-leading index would add write amplification on every edge write for a
  query shape the consumer no longer uses.
- **Not a fix for `b04e4397`** (recursive `getNeighbors` planner picks `ix_node_validity` over the rowid PK) —
  a distinct planner root cause (§7).
- No caching layer; no schema migration beyond indexes already present.

---

## 3. API contract

### 3.1 Signature (additive, optional fields — non-breaking)

```ts
interface IEdgeQuery {
  src?: number;                 // existing
  dst?: number;                 // existing
  rel?: EdgeRel;                // existing
  metadata?: Record<string, MetadataFilterValue>; // existing (FEAT-024)
  srcs?: readonly number[];     // NEW — batch OUT-keys
  dsts?: readonly number[];     // NEW — batch IN-keys
  rels?: readonly EdgeRel[];    // NEW — relation narrowing (ANDed)
}
getEdges(opts: IEdgeQuery): Promise<EdgeRecord[]>;
```

The singular `src`/`dst`/`rel` and the plural `srcs`/`dsts`/`rels` are **mutually exclusive per axis**:
passing `src` **and** `srcs` (or `dst` **and** `dsts`, or `rel` **and** `rels`) throws `ConstraintError`
(`src/index.ts:519`). This keeps the single-key path byte-for-byte unchanged (AC-6) and prevents an ambiguous
"union or intersect?" reading.

### 3.2 Query semantics

- Predicate is exactly the existing live-edge predicate: **`t_invalid IS NULL`** for every form. `t_expired`
  is *not* part of it (the index comments at `src/index.ts:147-153` establish that live-edge queries filter
  `t_invalid`, and that is what the current single-key reads do).
- `srcs` only → `WHERE src IN (…) AND t_invalid IS NULL`.
- `dsts` only → `WHERE dst IN (…) AND t_invalid IS NULL`.
- `srcs` **and** `dsts` → **intersection** (`src IN (…) AND dst IN (…) AND t_invalid IS NULL`), matching the
  existing internal pattern used by `getSubgraph` (`src/index.ts:2989-2990`, `:3056-3057`; dist `:2392`,
  `:2466`). Directional edge sets are obtained by supplying **one** list.
- `rels` provided → each present direction gains `AND rel IN (…)`. Omitting `rels` returns all live rels for
  the key set (bounded by per-node degree).
- `metadata` composes with any form (unchanged semantics).
- Empty arrays: `srcs: []` or `dsts: []` (or `rels: []`) short-circuit to `[]` **without executing SQL** —
  never an `IN ()` parse error (precedent: `src/bug-032-empty-ids-filter.spec.ts`).

### 3.3 Ordering guarantee — **pinned, contractual** (this is the load-bearing clause)

- `srcs` form returns rows ordered **`(src, rel, rowid)` ascending**.
- `dsts` form returns rows ordered **`(dst, rel, rowid)` ascending**.
- Both-lists (intersection) form: order unspecified (the consumer never uses it; §3.2).

This reproduces **exactly** the per-key order the existing indexed single-key reads yield — `getEdges({src})`
scans `ix_edge_src_live(src, rel)` giving `(rel, rowid)` within the src; likewise `(rel, rowid)` within dst for
`getEdges({dst})`. It is the invariant `buildPageReadBatch` depends on to preserve output byte-for-byte, and
that `resolveRelated`'s **first-seen-wins** dedup depends on (`card.ts:305-340` — dedup is by node id,
first-seen wins, so the row order *is* the output order). Implementation must make this planner-independent:
emit an explicit `ORDER BY src, rel, rowid` (resp. `dst, rel, rowid`). The sort is over
`O(page × degree)` rows, i.e. inside the new bound.

> **Flagged inconsistency (open question Q3).** `card.ts:303`'s prose lists the dedup order as
> `relates_to`, `part_of`, `blocks`, but the `(src, rel)` index orders those tags alphabetically. The spec
> pins the **ground truth** ("byte-identical to the current per-node path"), not either prose order; AC-3 is a
> differential test, so it holds regardless. Verify against the assembler tests.

### 3.4 Indexes it must use

`srcs` → `ix_edge_src_live`; `dsts` → `ix_edge_dst_live` (both `(key, rel) WHERE t_invalid IS NULL`). A plan
assertion (SEARCH via the expected index, never `SCAN edge`) is an acceptance criterion (AC-2), mirroring
`perf-golden.perf-memory-005.spec.ts`'s "plan assertion over wall-clock" doctrine.

### 3.5 Large `srcs` — chunking & parameter limits

The adapter is driver-agnostic (Turso default `multiprocess-wal`, `better-sqlite3` fallback —
`README.md:5-7`), whose SQL-variable ceilings differ. The implementation:

1. sorts + de-duplicates the id list ascending (preserves the §3.3 global order),
2. splits it into ascending chunks of a documented `EDGE_READ_CHUNK` (default **500**),
3. runs one indexed query per chunk, concatenates results in chunk order.

Deterministic chunks ⇒ concatenation equals one unchunked read (AC-8). Confirm the exact driver bound before
fixing the constant.

---

## 4. Acceptance criteria (binary, stable ids)

- **AC-1 — large-store/small-page row bound (headline).** On a seeded store with a single relation of
  **≥ 10 000 live edges**, for pages of **1 and 20** items: `getEdges({srcs: page})` returns exactly the edges
  whose `src ∈ page`; assert the **returned row count** and an **adapter-level fetched-row count** (wrap
  `adapter.executeAll` to count `rows.length`). Binary: for a 1-item page with per-node degree 1,
  `rows_new < rows_old / 100`, where `rows_old` is `getEdges({ rel })`'s count on the same store. This is the
  regression `e54afd3f` describes — assert **rows**, not only round-trips.
- **AC-2 — index plan, no scan.** `EXPLAIN QUERY PLAN` for the `srcs` query contains
  `SEARCH … USING INDEX ix_edge_src_live`; for `dsts`, `USING INDEX ix_edge_dst_live`; neither is `SCAN edge`.
- **AC-3 — ordering determinism / differential equality.** For every page in the corpus, the `srcs` result is
  deep-equal to `concat(getEdges({ src: x }) for x of page)` (resp. `dsts` vs `getEdges({ dst: x })`), row
  for row. This is the §3.3 guarantee and the `related` first-seen-wins invariant, proven not assumed.
- **AC-4 — bi-temporal correctness.** Only `t_invalid IS NULL` edges are returned; an edge invalidated via
  `invalidateEdge` is absent from a subsequent `getEdgesInTx` read **inside the same transaction** (tx-scoped
  visibility preserved, as the current `getEdgesInTx` provides).
- **AC-5 — concurrency (ADR-0012).** The primitive adds **no lock and no write path**; it is a plain snapshot
  `SELECT` on the caller's adapter/tx handle. Under the Turso multi-process writer model
  (`docs/decisions/0012-*.md`), a concurrent invalidating writer is either fully visible or not (snapshot
  isolation), never a torn row; the read introduces no new `E_BUSY`-class failure.
- **AC-6 — back-compat.** `getEdges({src})`/`{dst}`/`{rel}`/`{}` and `getEdges({...metadata})` return
  byte-for-byte unchanged rows and order; `graph-store.spec.ts`, `feat-024-surface.spec.ts`, and
  `perf-golden.perf-memory-005.spec.ts` pass unmodified.
- **AC-7 — empty / missing lists.** `srcs: []` / `dsts: []` / `rels: []` return `[]` with zero SQL executed.
- **AC-8 — parameter chunking.** A `srcs` list of 5 000 ids on a store small enough to read unchunked returns
  the identical set and order; no "too many SQL variables" error.

**Consumer ACs (adhd side, §6):**

- **AC-C1.** `buildPageReadBatch` issues `getEdges({ srcs: pageIds })` for outgoing and
  `getEdges({ dsts: pageIds, rels: neededIncoming })` for incoming — **zero** `getEdges({ rel })` calls on the
  hot path. Placement switches to `getEdges({ dsts, rel: 'owns_component' | 'owns_project' })`.
- **AC-C2.** `backlog query`/`get` output is byte-for-byte unchanged: the existing assembler/card test suites
  pass unmodified.
- **AC-C3.** AC-1's large-store/small-page benchmark is driven **through the real `backlog query` path**,
  proving the row bound end-to-end, not only at the store unit.

---

## 5. Tests

**Benchmark harness** — `libs/data/graph/graph-store/src/batched-edge-read.perf.spec.ts` (mirrors
`perf-golden.perf-memory-005.spec.ts`): seed ≥ 10 000 unrelated edges + a small page in **one batched
transaction** (per-row `writeEdge` would dominate its own wall time and prove nothing). Assert AC-1 (returned
+ adapter-level row counts), AC-2 (plan), AC-3 (differential), AC-8 (chunk boundary).

**Differential equality** — a property-style test over a mixed corpus: for arbitrary page subsets and
`rels`, `srcs`/`dsts` output ≡ concatenated single-key reads (AC-3), and the invalidated-edge case (AC-4).

**Negative control (mandatory).** (a) Revert the predicate to the pre-fix shape and assert AC-1 **fails**
(rows explode to relation cardinality) — proves the benchmark can detect the regression. (b) Run the new path
with the `srcs` clause dropped (whole-scan) and assert AC-2 fails (`SCAN edge`). A green test that stays green
when the bug is reintroduced proves nothing.

**Concurrency proof** — two processes against one Turso multiprocess-wal store: reader result is always a
consistent snapshot across a concurrent invalidate (AC-5). Deterministic (reopen/await), no `sleep`.

---

## 6. Consumer note — how `buildPageReadBatch` switches

`entrypoint/backlog/src/query/card.ts:876-1005` becomes:

1. Compute `outRels`/`inRels` as today (`:884-908`) only to decide *whether* each direction is needed.
2. Replace the per-rel loop (`:921-930`) with:
   - `outgoing = await graph.getEdges({ srcs: issueIds })` — all outgoing for the page, bounded by degree;
   - `incoming = await graph.getEdges({ dsts: issueIds, rels: [...inRels] })`.
   Group by `e.src` / `e.dst` into `outgoingBySrc` / `incomingByDst` — the append order is already the §3.3
   order, so the maps are byte-identical to today (AC-3, AC-C2).
3. Placement (`:963-987`): replace `getEdges({ rel: 'owns_component' })` / `{ rel: 'owns_project' }` with
   `getEdges({ dsts: targets, rel: 'owns_component' })` / `{ dsts: compIds, rel: 'owns_project' })`.
4. No change to `related`/`blockers`/`similar`/`blocksOut`/`partOf`/`auditTrail` resolvers — they read the
   same maps and the same order (`card.ts:262-497`). The fast path (no edge fields) still issues zero calls.

The `resolve.ts` read helpers (`getOutgoingEdges`/`getIncomingEdges`, `:392,400`) may also migrate, but the
card path is the one this defect owns and the one AC-C3 measures.

---

## 7. Cross-repo plan

| # | Repo | Artifact | Gate |
|---|------|----------|------|
| 1 | sox-ecosystem | `getEdges({ srcs,dsts,rels })` in `libs/data/graph/graph-store/src/index.ts` + generated `index.d.ts` + perf spec + CHANGELOG minor bump | AC-1..AC-8 green; `nx build graph-store` + `verify-dist-load` |
| 2 | sox-ecosystem | publish the bumped `@adhd/sox-graph-store` | — |
| 3 | adhd | bump `@adhd/sox-graph-store` dep; switch `buildPageReadBatch` (§6) | AC-C1/C2/C3 green; assembler suite unmodified |
| 4 | adhd | consumer-level benchmark through real `query` | AC-C3 |

**Folds into `2937e652`?** Yes — this is precisely its "§B Read primitives" extension (a multi-key batch
read). Do **not** silently edit an umbrella item; file this as a child via `relate(..., 'part_of', 2937e652)`
(the dispatcher/backlog-operator owns graph writes). This spec can serve as that child's spec, and the same
primitive unblocks `7816dc8b` (memory `list_entities` N+1: 4 238 per-entity `getEdges` → one `srcs` read).
`b04e4397` is **out of scope** — its root cause is the recursive planner picking `ix_node_validity`, fixed at
the query/index level, not by this primitive.

---

## 8. Risks / open questions

- **Q1 — `src IN (…)` plan stability.** Does the planner reliably choose `SEARCH USING ix_edge_src_live (src=?)`
  for an `IN` list *and* yield per-src order, on **both** Turso and `better-sqlite3`? Mitigated by the explicit
  `ORDER BY` (§3.3); confirm the plan on both drivers (AC-2), not one.
- **Q2 — exact driver variable ceiling.** Turso vs `better-sqlite3` differ; confirm before fixing
  `EDGE_READ_CHUNK` (default 500). A chunk too large is a hard error, not a perf cliff.
- **Q3 — `related` first-seen order (see §3.3 flag).** The prose at `card.ts:303` and the `(src, rel)` index
  order disagree. AC-3 pins the differential ground truth; decide whether the prose or the behaviour is
  canonical before hard-coding any order in a non-differential test.
- **Q4 — high-degree legitimate reads.** `audits`/`has_note` for a page with many events are still
  `O(page × per-issue degree)` — correct and intended (the field was requested), but call it out so it is not
  mistaken for a residual regression.
- **R1 — no new index (non-goal).** Write-path cost is unchanged; the read win is purely from using the
  existing `(key, rel)` indexes with a key set instead of a `rel` predicate.
