# UNRESOLVED — @adhd/sox-vector-store Demo

Interfaces this demo had to guess, and scope gaps found while authoring.
Resolve each before treating the corresponding DEMO.md step as authoritative.

## Unresolved interfaces

| ID | Guessed interface | Used in | Basis | What would confirm it |
|----|-------------------|---------|-------|----------------------|
| U1 | `knn()` result shape beyond `nodeId` — does it include `distance`, `score`, or `similarity` fields? The demo asserts only `hits[0].nodeId` (grounded by pack-smoke.mjs). The `…` in table headers implies additional fields exist but their names are unknown. | §3.2.2, §4 | pack-smoke.mjs checks only `hits[0].nodeId !== 1`; additional fields inferred from typical sqlite-vec result shape | Read `knn()` source or package README when built; update §3.2.2 and §4 👀 Expect blocks if additional fields are present |
| U2 | Raw SQL table name `vec_items` and column name `model_id` used in the provenance audit query (`SELECT model_id, count(*) as count FROM vec_items GROUP BY model_id`) | §3.4.1 | sqlite-vec naming convention; "vec_items" inferred from the vec0 virtual table pattern. `model_id` inferred from SCOPE.md "per-record modelId" | After first build: run `db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()` on an initialized store to discover the real table name; update §3.4.1 column references accordingly |
| U3 | Exact error type and message thrown when the space invariant is violated (dim mismatch in §3.3.1; modelId mismatch in §5.1) | §3.3.1, §5.1 | SCOPE.md Part A "rejects a vector whose dim/modelId ≠ the column's" — a throw is certain; the specific message and whether it is a `TypeError`, `RangeError`, or a custom error class is not specified. The demo asserts only that something throws (`threw === true`). | Read `upsertVector()` source when built; optionally tighten the demo's catch block to assert `e.message.includes(...)` once the message is known |

## Scope gaps & open questions

- **REQ-003 / CAP-007 — Pluggable similarity backend (by design):** SCOPE.md Part D explicitly says "Don't build ANN now. sqlite-vec brute-force is sub-ms at <50K rows." The pluggable backend seam is a design constraint for future swapability — no exercisable API surface exists in Phase 0. No beat covers it, and that is correct per the spec. The gap is expected.

- **Package not yet built:** `@adhd/sox-vector-store` does not exist at authoring time (2026-06-26). Every API in this demo is grounded in `pack-smoke.mjs` (the ground-truth acceptance contract) and `SCOPE.md Part A`. The demo is the acceptance contract for what the package must deliver. All ⟦U#⟧ stubs should be resolved by reading the package source after the first build.

- **`applyVecSchema` idempotency assumed:** Beats §3.2.1, §3.2.2, §3.3.1, and §3.4.1 each call `applyVecSchema` on an existing `notes.db` (created by §3.1.1). The demo assumes this is idempotent — `CREATE TABLE IF NOT EXISTS` / `CREATE VIRTUAL TABLE IF NOT EXISTS` semantics. If `applyVecSchema` throws on a second call to an already-schemaed store, those beats must be updated to omit the repeated call (or the command must be restructured to open a fresh `:memory:` store per beat). Confirm by reading the `applyVecSchema` source.
