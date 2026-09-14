---
'@adhd/sox-hybrid-search': patch
---

Let `StoreSearchBackend` consume the async `TursoVectorBackend`.

`TursoVectorBackend` (turso-native, in-process, reusing the caller's own `StoreAdapter`)
implements `AsyncVectorBackend`, but `StoreSearchBackend` typed its collaborator as the
synchronous `VectorBackend` and called `listSpaces()`/`knn()` without awaiting. So the async
backend was structurally unusable with hybrid search, and any consumer wanting vector search
was pushed onto `SqliteVectorBackend` (sqlite-vec/vec0) — which itself throws when handed a
Turso adapter, leaving no working combination for a Turso-backed store.

The field and constructor now accept `VectorBackend | AsyncVectorBackend`, and the four
vector call sites are awaited. Awaiting a synchronous value is a no-op, so the sqlite-vec and
LanceDB paths are unchanged.
