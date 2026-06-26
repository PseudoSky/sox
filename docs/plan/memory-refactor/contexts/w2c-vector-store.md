# w2c-vector-store — Extract data/vectors/vector-store + the re-embed core

> **Slug is identity.** `w2c-vector-store` is immutable.

**Phase:** extraction · **Depends on:** `w2a-embedding-provider`, `w2b-graph-store`
**Guard:** `nx build vector-store && nx test vector-store`

---

## Goal

Carve the vector substrate into `@adhd/sox-vector-store` ([def:data-package],
data/vectors): `vec0` persistence + kNN/cosine, **enforcing the [def:space-invariant]**,
owning **per-record `modelId` provenance** (BL-88), and housing the **single**
[def:reembed-core] migration walk (which **absorbs** `scripts/reembed-memory.mjs`). It
operates on an **injected `Database`** and also ships a standalone `openVectorStore(path)`
([def:connection-seam]). Per SCOPE Part D: **no ANN** — brute-force only, behind a
pluggable similarity-backend seam.

This is the riskiest carve (it depends on both prior extractions) and the home of the
plan's hardest invariant.

---

## Semantic Distillation

- **Primitive:** EXTRACT the `vec_node` table + kNN; IMPLEMENT space-invariant
  enforcement, per-record `modelId`, and the re-embed walk.
- **Reference Pattern:** the `vec_node` virtual table (`schema.ts:71`,
  `vec0(node_id INTEGER PRIMARY KEY, embedding FLOAT[768])`), the vec write/search paths
  in `write.ts`/`recall.ts`, `reembedNodes` in `embed.ts`, and the quickfix's
  `scripts/reembed-memory.mjs` (the migration this generalizes). `memory_scope.embed_model`
  /`embed_dim` is the space the records must match.
- **Delta Spec:** implement [shape:vector-store-api]:
  - `applyVecSchema(db, {dim, modelId})` — creates the `vec0` table at the configured dim
    (parameterized, not hard-coded 768) + a per-record `modelId` provenance column/table
    (BL-88). Idempotent.
  - `upsertVector(db, nodeId, vec, {modelId})` — **rejects** a vector whose
    `length !== dim` OR whose `modelId !==` the column's configured model
    ([def:space-invariant], [inv:space]). Throws a typed error; no partial write.
  - `knn(db, query, k, filter?)` — brute-force cosine over `vec0`; behind a
    `SimilarityBackend` interface so brute-force→quantized→ANN is a swap, not a rewrite
    (SCOPE Part D — implement brute-force ONLY now).
  - `openVectorStore(path, {dim})` — convenience opener (open + `sqlite-vec` load +
    `applyVecSchema`) for **standalone 3rd-party reuse** without the composer.
  - `reembed(db, {active: EmbeddingProvider, dryRun})` — [def:reembed-core]: find every
    record whose stored `modelId !== active.modelId`, re-embed via
    `active.embedBatch(...)`, rewrite the `vec_node` rows, update `embed_model`. Backup-
    first + dry-run + idempotent (absorbs `scripts/reembed-memory.mjs`; the old script
    becomes a thin wrapper in `w2e`). Never deletes; only updates vec rows.
  - `vector-store` imports `@adhd/sox-embedding-provider` (data→data, allowed) but does
    **NOT** import `@adhd/sox-graph-store`.
- **Invariants added:** [inv:space] (enforced in code here), [inv:carry-fixes] (reembed),
  [inv:boundary] (no graph-store import), [inv:nx-targets], [inv:lifecycle-spec] (the
  reembed core's daemon-op wiring lands in w2e but is designed here to be safe).
- **Validation:** `nx test vector-store` — reject-on-mismatch, kNN ordering, reembed
  dry-run idempotence.

---

## Acceptance criteria

Checked by `audit-extraction`.

- [ ] **[w2c.1]** `@adhd/sox-vector-store` builds; exports `applyVecSchema`, `upsertVector`,
      `knn`, `openVectorStore`, `reembed` from `dist/index.js`.
- [ ] **[w2c.2]** [def:space-invariant]: `upsertVector` with a wrong-`dim` vector throws;
      with a wrong-`modelId` throws; a matching vector succeeds. (vitest.)
- [ ] **[w2c.3]** kNN returns the nearest neighbors in descending cosine order for a
      seeded set. (vitest.)
- [ ] **[w2c.4]** Per-record `modelId` is stored and queryable (BL-88). (vitest.)
- [ ] **[w2c.5]** [def:reembed-core]: `reembed(db, {active, dryRun:true})` on a
      [fix:memory-db] copy reports the count of mismatched records WITHOUT writing; a real
      run converts them and is idempotent (a second run is a no-op). Vec rows change,
      `embed_model` updates, nothing is deleted. (vitest + a [fix:memory-db] integration.)
- [ ] **[w2c.6]** vector-store does NOT import `@adhd/sox-graph-store`. [inv:boundary]
      `node -e "const s=require('fs').readFileSync('libs/data/vectors/vector-store/dist/index.js','utf8'); if(/sox-graph-store/.test(s))process.exit(1)"`
- [ ] **[w2c.7]** Similarity backend is pluggable (a `SimilarityBackend` seam exists);
      only the brute-force impl ships (no ANN dep). (code inspection + vitest.)

---

## Reservations

```text
read_only:  ["libs/memory-core/src/schema.ts", "libs/memory-core/src/embed.ts",
             "libs/memory-core/src/write.ts", "libs/memory-core/src/recall.ts",
             "scripts/reembed-memory.mjs"]
mutates:    ["libs/data/vectors/vector-store/src/**"]
```

---

## Notes for executor

- The `vec0` dim MUST be parameterized from the active provider's `dim` — the live store
  is BGE (384 or 768); the hard-coded `FLOAT[768]` in the legacy DDL is a latent bug if
  the model is 384. Drive it from `{dim}`.
- One re-embed core, two entry points: implement it HERE; `w2e` wires the daemon op +
  the thin `scripts/reembed-memory.mjs` wrapper. Do not fork the logic.
- Keep the BL-11 boundary in mind: `reembed` calls the provider's worker-backed
  `embedBatch`; it must not load onnxruntime inline alongside the open db.
- Budget: 2 sessions (the heaviest extraction).
