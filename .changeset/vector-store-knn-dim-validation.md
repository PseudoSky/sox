---
'@adhd/sox-vector-store': patch
---

fix(vector-store): validate the `knn` query dimension, parity with `upsert`

`upsert()`/`upsertVectors()` have always rejected a vector whose length ≠ `space.dim` with
`SpaceInvariantError` before any I/O. `knn()` did not — a wrong-dimension query vector reached the
driver and surfaced an untyped error (Turso: a `StorageError` wrapping a raw SQL error; LanceDB: a
raw `GenericFailure` from the worker RPC), and on `SqliteVectorBackend` it silently returned
NaN/garbage scores from the brute-force cosine loop. That is an ADR-0012 violation — a raw driver
exception reaching a caller is a bug.

All three backends now check `query.length === space.dim` before issuing a query and reject with
`SpaceInvariantError`, exactly as the write path does. The error gains an optional `source`
discriminant (`'upsert'` — the default, preserving the original 3-arg contract — or `'knn'`) and a
`SpaceInvariantError.forQuery(space, actualDim)` factory; on the `'knn'` path `nodeId` is the new
exported `QUERY_VECTOR_NODE_ID` sentinel (`-1`), because a query vector has no owning node.

Red→green tests ship per backend (`vector-store.spec.ts`, `turso.spec.ts`, `lancedb.spec.ts`), each
asserting the typed error, its `source`, and its `nodeId`; a reverse-applied negative control
confirmed all three go red without the check.
