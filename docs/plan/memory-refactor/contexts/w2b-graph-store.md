# w2b-graph-store — Extract data/graph/graph-store

> **Slug is identity.** `w2b-graph-store` is immutable.

**Phase:** extraction · **Depends on:** `audit-layout` · **Guard:** `nx build graph-store && nx test graph-store`
**Parallel with:** `w2a-embedding-provider` (disjoint source files).

---

## Goal

Carve the bi-temporal graph substrate out of `memory-core` into
`@adhd/sox-graph-store` ([def:data-package], data/graph): nodes + edges +
`t_valid/t_invalid` + content-hash dedup + FTS5 sync triggers + the idempotent
migrations. It operates on an **injected `Database`** ([def:connection-seam]) — it does
**not** own `openDb` and does **not** import `vector-store` (so `data/vectors ↛
data/graph` holds and graph-store is reusable standalone).

This carve and `w2c-vector-store` both split `schema.ts`/`db.ts`; graph-store goes first
(it takes the node/edge/FTS DDL; vector-store then takes only the `vec_node` virtual
table), so the two never edit the same lines concurrently.

---

## Semantic Distillation

- **Primitive:** EXTRACT the graph DDL + FTS triggers + migrations into the data/graph
  package as `applyGraphSchema(db)` + node/edge helpers.
- **Reference Pattern:** `libs/memory-core/src/schema.ts` (the `node`/`edge` tables +
  indices, `fts_node`, `organizer_queue`, `promotion_queue`, `FTS_TRIGGERS`) and
  `libs/memory-core/src/db.ts` (the DDL application + `migrateAddColumn` + the BL-27
  `organizer_queue` CHECK-constraint rebuild + `expandDbPath`). The `vec_node` virtual
  table (`schema.ts:71`) is the ONLY part that does NOT come here — it goes to w2c.
- **Delta Spec:**
  - `schema.ts` (in the package) — the graph half of the DDL: `node`, `edge`, their
    indices, `fts_node`, `organizer_queue`, `promotion_queue`, `FTS_TRIGGERS`. Export
    `GRAPH_DDL`, `FTS_TRIGGERS`, `PRAGMAS` (pragmas are shared infra; keep a copy here or
    accept them — see Notes).
  - `graph-store.ts` — `applyGraphSchema(db: Database): void` (runs DDL + triggers +
    `migrateAddColumn` calls + the BL-27 migration, all idempotent), plus the node/edge
    read/write helpers currently living in `db.ts`/`write.ts`'s graph portions
    (content-hash insert, invalidate-sets-t_invalid, supersession edges).
  - **Injected connection:** every function takes `db: Database`. NO `new Database(...)`
    here, NO `sqlite-vec` load (that is the composer/vector-store concern). NO import of
    `@adhd/sox-vector-store`.
  - Records are **never deleted** — invalidation sets `t_invalid` (audit-preserving
    invariant per the scaffold metadata).
- **Invariants added:** [inv:carry-fixes] (BL-27 migration, BL-41 — but `expandDbPath`
  belongs to the composer's `openDb`, see Notes), [inv:nx-targets], [inv:name-decoupled],
  [inv:boundary] (no vector-store import).
- **Validation:** `nx test graph-store` — spec applies the schema to an in-memory
  better-sqlite3 db, inserts a node, asserts FTS sync + content-hash dedup + invalidation
  sets `t_invalid`.

---

## Acceptance criteria

Checked by `audit-extraction`.

- [ ] **[w2b.1]** `@adhd/sox-graph-store` builds; exports `applyGraphSchema` + node/edge
      helpers from `dist/index.js`.
- [ ] **[w2b.2]** `applyGraphSchema(db)` on a fresh in-memory db creates `node`, `edge`,
      `fts_node`, `organizer_queue`, `promotion_queue` and is idempotent (second call is a
      no-op). (vitest.)
- [ ] **[w2b.3]** FTS sync: inserting a node populates `fts_node`; updating re-syncs;
      deleting removes. (vitest — exercises `FTS_TRIGGERS`.)
- [ ] **[w2b.4]** Invalidation preserves the row (sets `t_invalid`, never `DELETE`). (vitest.)
- [ ] **[w2b.5]** graph-store does NOT import `@adhd/sox-vector-store` and contains no
      `vec0`/`vec_node` DDL. [inv:boundary] / [def:connection-seam]
      `node -e "const s=require('fs').readFileSync('libs/data/graph/graph-store/dist/index.js','utf8'); if(/vec_node|sox-vector-store/.test(s))process.exit(1)"`
- [ ] **[w2b.6]** The BL-27 `organizer_queue` CHECK migration travels intact (a pre-'enrich'
      table is rebuilt). (vitest reproducing the stale-constraint case.)

---

## Reservations

```text
read_only:  ["libs/memory-core/src/schema.ts", "libs/memory-core/src/db.ts",
             "libs/memory-core/src/write.ts"]
mutates:    ["libs/data/graph/graph-store/src/**"]
```

> NB: copies/transforms graph logic into the new package; does NOT delete from
> `memory-core` yet (that is `w2e-domain-rewire`).

---

## Notes for executor

- **Pragmas + the file open** are the composer's job ([def:connection-seam]): `openDb`
  (staying in `memory-core`) does `new Database` + `sqliteVec.load` + pragmas + the BL-41
  `expandDbPath` sink, THEN calls `applyGraphSchema(db)` + `applyVecSchema(db)`. Export
  `PRAGMAS` from here for the composer to apply, but do NOT open the file here.
- Keep the `vec_node` line out entirely — if it sneaks in, [w2b.5] fails and the
  `data/vectors ↛ data/graph` boundary is moot.
- Budget: 1-2 sessions.
