# Turso native vector search — viability, gain, and the memory-store/vector-user split

**Date:** 2026-09-29 · **Author:** researcher (static audit) · **Status:** finding / advisory

**Subject tickets:**
- FEAT `76ab6cde-bffb-4b13-a38a-165e5beb8ca0` (was `e2758474-…`) — *"Migrate memory bundle vector store to Turso native vector search"* — rewritten to **BLOCKED ON UPSTREAM**.
- Bug `ad031f92-69b2-4127-b1a3-26159ee11e29` — false acceleration claims in `TursoVectorDialect` (the doc symptom of the engine gap).

---

## 1. The finding

The store **is** using Turso's native vector *functions* (`vector_distance_cos`) but **not** a native vector *index*. Every KNN query against the Turso-backed `vec_node` is a **full scan**. This is **not a code oversight to "turn on"** — it is an **engine limitation**: the Rust-rewrite Turso this repo runs does not have the DiskANN vector index, so there is nothing to enable. The plan to "migrate to Turso native vector search" is therefore **not viable today**, its premise is **already obsolete**, and its **gain at current scale is ≈ zero**.

## 2. Evidence

| Claim | Evidence |
|---|---|
| KNN is a full scan | `TursoVectorDialect.topKQuery` → `SELECT … vector_distance_cos(v.embedding, X'…') AS distance FROM "vec_node" v WHERE … ORDER BY distance ASC LIMIT k` (`libs/data/store/store-adapter/src/vector-dialect.ts:285-288`) |
| The "index" is a plain b-tree | `createIndexDDL` → `CREATE INDEX IF NOT EXISTS "idx_<t>_<c>" ON "<t>" ("<c>")` (`vector-dialect.ts:242-244`) — cannot serve `vector_distance_cos` |
| memory-core actually calls it | `libs/memory-core/src/db.ts:985-989` (`createTableDDL('vec_node', …)` + `createIndexDDL('vec_node','embedding','cosine')`) |
| Docs claim otherwise | `vector-dialect.ts:188` ("index created via `libsql_vector_descr()`" — never emitted); `:249-250` ("planner optimises via the vector index"); `turso.ts:316` ("index-accelerated") |
| The intended DDL was the ANN one | `docs/ideas/turso-go-live-gap-analysis.md:641` → `CREATE INDEX … (libsql_vector_idx(col, '…'))` |
| The engine lacks that index | Installed driver `@tursodatabase/database@0.7.1` (latest `0.8.1`); no `libsql_vector_idx`/`vector_top_k`/DiskANN in the package; its README never mentions vectors |
| The ANN index is a libSQL/Cloud feature | turso-docs "AI & Embeddings": `libsql_vector_idx(...)` + `vector_top_k(...)`, DiskANN, documented **for libSQL** |
| Upstream has not ported it to Rust | `tursodatabase/turso#832` *"Vector search with DiskANN"* — **OPEN**, milestone *Backlog*, unassigned, no PRs: *"Port the libSQL native vector search DiskANN C code to Rust and use it."* |

The plan's own assertion — *"Turso Database (Rust rewrite) has … Native vector column type with index"* — is **correct on functions, false on the index**.

## 3. Viability verdict

**Not viable as written.**

1. **Premise obsolete.** The ticket described migrating from a *separate journaled* `sox-vector-store` to Turso. That already happened: `memory-core` stores vectors in the co-located `vec_node` table, and the live server already runs on the Turso adapter. Phases 1–4 are done.
2. **Remaining goal engine-blocked.** The only live goal — an ANN index — depends on DiskANN, which is not in the Rust engine (issue #832, Backlog).

## 4. Gain analysis — ≈ zero at current scale

- Corpus ~5–6k episodes × 768 dims → a full-scan cosine is single-digit-to-tens of ms. ANN cannot meaningfully beat it.
- **ANN is approximate** (DiskANN trades recall for speed) → at small N it *reduces* quality for no speed win. Exact brute force is correct at this size.
- **KNN is not the recall bottleneck.** Warm `bge-base` embed is p50 ≈ 619 ms (open perf item); FTS + RRF + rerank sit alongside.
- Gain is **asymptotic** (O(N) → ~O(log N)); real only past ~10⁵–10⁶ vectors — 1–2 orders of magnitude away.
- The claimed complexity win ("retire sox-vector-store + the journal") is largely already realized (BL-256: memory-core uses its own fixed `vec_node`, not the multi-space store).

**Net:** a near-term migration is **net-negative** — approximation cost + real code/DB churn for no measurable speed gain.

## 5. The unresolved tradeoff (two engines, one name)

| Engine | Writes | ANN index |
|---|---|---|
| `@tursodatabase/database` (Rust rewrite — what this repo runs) | multiprocess / WAL concurrency (the reason for migrating) | **NO** (DiskANN not ported; #832) |
| libSQL (C fork) / Turso Cloud | single-writer, no MVCC | **YES** (DiskANN GA) |

"Turso native vector search" is not one feature; adopting it forces a choice of engine. This is the core confusion the ticket carried.

## 6. How the memory store differs from the other vector users

There are **two distinct vector paths** in the ecosystem, and the memory store is the odd one out.

### The generic path — `@adhd/sox-vector-store` (`VectorBackend`)
Consumers: the **`semantic` facade** (`libs/data/search/semantic`), **`hybrid-search`** (`StoreSearchBackend`), **`analysis`**, and externally **`entrypoint/backlog`** (adhd repo) and **`agent-source`**.

- **Multi-space:** `ensureSpace({modelId, dim})` → one table per model `vec_<modelId>` + a `_vector_spaces` metadata table. Multiple embedding models coexist; a model switch is a new space, not a migration.
- **Abstract `knn(query, space, k, {ids})`** — the caller never writes SQL; the backend picks the dialect.
- **Graph join owned by the caller:** since DEBT-011, `VecFilter` is pure `{ ids }`; the facade/hybrid-search resolve node filters to ids up front, then rejoin (`knn` returns `{id, score}`).
- Interface: `libs/data/vectors/vector-store/src/index.ts:50-68` (`VectorBackend`), `:20-22` (`VecFilter`).

### The memory path — `memory-core` (bypasses the package)
- **Does not import `@adhd/sox-vector-store`** (only mentions it in comments in `reembed.ts`). It is the **only** consumer that does not.
- **Owns a fixed-schema single-space table, `vec_node`** (`libs/memory-core/src/schema.ts`; `recall.ts:586` — *"vec_node stores exactly ONE mean-pooled FLOAT[768]"*). One table, one dimension, one space — no `_vector_spaces`, no `vec_<model>` per model.
- **Drives the dialect directly:** `recall.ts:1070-1071` calls `vectorDialect.topKQuery('vec_node','embedding', queryVec, knnLimit, 'cosine')` and hand-builds the surrounding SQL; `neardup.ts:65-70` calls `topKQuery` and substitutes the `__PLACEHOLDER__` seam itself. It never touches `VectorBackend.knn` or `VecFilter.nodeFilter`.
- **Co-located with the graph, always** — vectors live in the same store as `node`/`edge`, so the dialect's node-join is a same-DB join.
- **A model switch is a physical migration:** because `vec_node` is fixed `FLOAT[768]`, changing model/dim requires a `vec_node` schema migration (`reembed.ts`) — it cannot open a second space.
- It actively **detects and drops** the generic `vec_%` / `_vector_spaces` tables if it finds them (`db.ts:372, 973`).

### Why the split matters here
- **Same engine gap, different blast radius.** memory-core's `vec_node` gets the (useless) b-tree from `createIndexDDL` → full scan. The generic consumers inherit the *same* `TursoVectorDialect`, but on SQLite they use `vec0`, where the virtual table itself **is** the index — so the generic package abstracts over the gap while memory-core is hand-wired to the weaker path.
- **memory-core is the easier ANN adopter** *if* the engine ever ships it: a single fixed table with no multi-space bookkeeping is a smaller surface for `libsql_vector_idx` + `vector_top_k` than the generic backend.
- **The ticket's scope was mis-stated.** "Migrate the memory bundle vector store" is not a `sox-vector-store` change — memory-core doesn't use that package. The change would be local to memory-core's dialect usage.

## 7. Recommendations

1. **FEAT:** keep **open, blocked** on `tursodatabase/turso#832`; do not schedule. (Done — `76ab6cde-…`.)
2. **Bug `ad031f92`:** fix now — the b-tree index does nothing and the docstrings lie; either drop the index or annotate it as a placeholder pending engine support. Independent of the migration.
3. **If ANN is needed sooner:** LanceDB is already wired (real HNSW/IVF-PQ). A driver swap to `@libsql/client` buys DiskANN but costs the MVCC/multiprocess-write property — an explicit architecture decision, not a "migration".
4. **Before any action:** confirm on the newest driver (`@tursodatabase/database@0.8.1`) that `libsql_vector_idx` is still absent — a one-line `EXPLAIN`/`PRAGMA` probe against a store copy — since the engine is moving fast and this finding is a snapshot.

---

## Citations

Static read (no build/run), 2026-09-29:
- `libs/data/store/store-adapter/src/vector-dialect.ts:188, 242-244, 246-288`
- `libs/data/vectors/vector-store/src/turso.ts:316`; `libs/data/vectors/vector-store/src/index.ts:20-68`
- `libs/memory-core/src/db.ts:372, 973, 985-989`; `libs/memory-core/src/recall.ts:586, 1070-1071`; `libs/memory-core/src/neardup.ts:7, 65-70`; `libs/memory-core/src/reembed.ts:56, 234`
- `docs/ideas/turso-go-live-gap-analysis.md:118, 641, 1485`
- Installed `@tursodatabase/database@0.7.1` (latest `0.8.1`); turbodatabase/turso#832 (OPEN, Backlog)
- turso-docs `features/ai-and-embeddings.mdx` (libSQL `libsql_vector_idx` / `vector_top_k` / DiskANN)
