# USE_CASES — memory-refactor `data/*` packages

Companion to `SCOPE.md`. Five use cases per package being built. Each is tagged **[standalone]**
(a 3rd party `npm i`s and uses it on its own — the refactor's reuse thesis, and what `audit-final`'s
`pack-smoke.mjs` proves) or **[compose]** (the memory domain composes it internally). Use-case IDs are
traceable into the per-state contexts and the standalone-consumption acceptance.

---

## `@adhd/sox-embedding-provider` (area:data / group:embed)
*text → vector; config-driven model resolution; deterministic variant as a first-class provider; loud-fail.*

- **UC-EMB-1 [standalone]** — A RAG app batch-embeds a document corpus for indexing via the batch API (`string[]` → async generator, batchSize 256), fully in-process — no per-call network, no provider bill.
- **UC-EMB-2 [standalone]** — A CI/test suite needs reproducible vectors with zero model download, so it selects the **deterministic** provider; the same text always yields the same vector across machines.
- **UC-EMB-3 [standalone]** — A team swaps the embedding model (bge-base → a larger model) purely via config; the resolver instantiates the new provider and advertises the new `{modelId, dim}` — no caller code change.
- **UC-EMB-4 [compose]** — The memory server requires embeddings to be **real or fail loudly**: with `backend:real` the resolver throws a diagnosable error on warmup failure (the BL-87/89 guard) instead of silently degrading to hash.
- **UC-EMB-5 [standalone]** — A latency-sensitive service uses the query-optimized single-embed path plus a startup Map cache for hot/topic embeddings, cutting repeated-query embedding overhead.

## `@adhd/sox-vector-store` (area:data / group:vectors)
*vec0 persistence + kNN/cosine; enforces the embedding space invariant; per-record modelId; pluggable similarity backend.*

- **UC-VEC-1 [standalone]** — A desktop app adds semantic search over <50K items using one SQLite file (`openVectorStore` on its own connection) — no external vector DB; brute-force kNN is sub-millisecond.
- **UC-VEC-2 [standalone]** — An app changes embedding models and the store **refuses to mix spaces** — it rejects vectors whose `dim`/`modelId` ≠ the column and signals a re-embed migration, preventing silent similarity corruption.
- **UC-VEC-3 [standalone]** — A scaling product swaps the similarity backend (brute-force → quantized → usearch/HNSW) through the pluggable seam with no change to its query code.
- **UC-VEC-4 [compose]** — A store-health audit lists records by `modelId` provenance to find vectors embedded under a stale/hash model and targets them for re-embed (closes the BL-88/BL-92 untrusted-scope-tag gap).
- **UC-VEC-5 [standalone]** — A 3rd party uses vector-store **with its own embeddings** (any 768-dim source) and its own injected SQLite handle — proving zero dependency on graph-store or the memory domain.

## `@adhd/sox-graph-store` (area:data / group:graph)
*bi-temporal nodes + edges; content-hash dedup; FTS sync; supersession chains.*

- **UC-GRA-1 [standalone]** — An audit-tracked app stores records with bi-temporal validity (`t_valid`/`t_invalid`) and queries point-in-time state; nothing is ever deleted.
- **UC-GRA-2 [standalone]** — An ingestion pipeline writes idempotently — `content-hash` dedup means re-ingesting the same content is a no-op, not a duplicate.
- **UC-GRA-3 [standalone]** — A relationship app stores typed edges (`RELATES_TO`/`SUPERSEDES`/`DERIVED_FROM`) and traverses neighbors at depth.
- **UC-GRA-4 [standalone]** — An app gets FTS5 keyword search kept automatically in lockstep with the node table via the sync triggers — no manual index maintenance.
- **UC-GRA-5 [compose]** — The memory domain follows supersession chains (what superseded X / what X superseded) to render provenance and "is-current" status.

## `@adhd/sox-hybrid-search` (area:data / group:search)
*vec + BM25 + temporal fusion ranker; normalize-before-combine; multiplicative boosting; degrade-to-BM25.*

- **UC-SRCH-1 [standalone]** — A RAG retriever fuses vector similarity + keyword BM25 + recency into one ranked list with **normalized** scores, avoiding meaningless raw weighted sums across incompatible ranges.
- **UC-SRCH-2 [standalone]** — A multi-field search boosts `title` > `tags` > `body` via **multiplicative** field weights (`bm25(col_weights)` collapses N per-field queries to 1), so a boost is proportional, not scale-blind.
- **UC-SRCH-3 [compose]** — Memory recall **stays functional when embeddings are down** — it degrades to BM25/FTS automatically (the degraded-embedding survivability rule).
- **UC-SRCH-4 [standalone]** — A relevance-tuning workflow turns on opt-in `explain` to see the per-field score breakdown for a result, then adjusts weights.
- **UC-SRCH-5 [standalone]** — A batch workload runs N queries sharing one filter (evaluated once) and gets a `matched_queries` cross-query-dedup signal that lifts items hit by multiple queries.

## `@adhd/sox-analysis` (area:data / group:analysis)
*batch derivation over a corpus: clustering, near-duplicate detection, importance/link scoring.*

- **UC-ANA-1 [standalone]** — A content app clusters a corpus into topic communities (embedding-based) to power navigation and "related" sections.
- **UC-ANA-2 [standalone]** — A dedup pipeline finds near-duplicate items above a cosine threshold to merge or flag them.
- **UC-ANA-3 [standalone]** — A ranking system scores item importance via graph centrality/link-score to prioritize what surfaces first.
- **UC-ANA-4 [compose]** — The memory daemon batch-derives `RELATES_TO` auto-links across the store during enrichment.
- **UC-ANA-5 [standalone]** — A knowledge-base health report computes cluster quality + coverage stats over the corpus (records the `modelId` the similarities were computed under).

## `@adhd/sox-ingest` (area:data / group:ingest)
*write-path single-item transforms: content-hash, extractive summary, deterministic tagging, chunk/normalize.*

- **UC-ING-1 [standalone]** — A document pipeline chunks long content at sentence boundaries before storage so each chunk fits an embedding/window budget.
- **UC-ING-2 [standalone]** — A writer generates a deterministic extractive summary per item (zero-LLM, byte-reproducible) for display + recall.
- **UC-ING-3 [standalone]** — A tagging system derives concept tags + a topic from raw content deterministically, with no provider call.
- **UC-ING-4 [compose]** — A write hook computes the `content-hash` to short-circuit exact-duplicate writes (the dedup-at-write path feeding graph-store).
- **UC-ING-5 [standalone]** — An ingestion service normalizes + PII-redacts content on the write path before it is ever persisted.

---

## Coverage notes
- **Reuse thesis:** 22 of 30 use cases are **[standalone]** — a 3rd party consuming the package via `npm i` with no in-workspace deps. These are exactly what `scripts/pack-smoke.mjs` (`[audit-final.5]`) must affirmatively prove (esp. UC-EMB-1/2, UC-VEC-1/5 — the native-dep-resolves-from-tarball BL-87 guard).
- **Composition:** the 8 **[compose]** cases are how the slim `memory-core` domain wires the packages back into the `memory_*` tool surface — verified unchanged by `[inv:tool-contract-stable]`.
- **Invariant traceability:** UC-VEC-2 ↔ `[inv:space]`; UC-EMB-4 ↔ `[inv:loud-fail]`; UC-SRCH-3 ↔ `[inv:degrade-to-bm25]`; UC-VEC-4 ↔ BL-88/BL-92 provenance.

---

## System-level use cases — external products composing the packages

The use cases above are *per-package* (one package's API). These are *whole external systems* a 3rd party
would build by composing the **public** packages (`embedding-provider` = E, `vector-store` = V,
`hybrid-search` = H) — the reuse thesis at product scale. Each notes any **private-package pull** (graph-store
= G, analysis = A, ingest = I), because a real external consumer wanting a private package is the **evidence
that should revisit the ADR-0006 public/private split** (graph-store/analysis are the recurring asks).

- **SYS-1 — Prompt-segment catalog + on-the-fly task SP composition.** Catalog reusable LLM prompt segments;
  search the corpus for task-context matching; compose/compile optimized system prompts per task.
  **Uses E+V+H** (embed segments + task → hybrid-rank candidates under a token budget). **Pulls G** (versioned
  segments, `REQUIRES`/`SUPERSEDES` composition edges, content-hash dedup) **+ A** (near-dup so two redundant
  segments aren't composed into one SP). Compose/compile/optimize is the consumer's own engine — the packages
  are the retrieve-and-rank layer.
- **SYS-2 — Local-first "second brain" notes search.** Offline semantic + keyword search over personal notes.
  **E+V+H.** **Pulls G** (backlinks + note versions).
- **SYS-3 — "Ask your repo" code search.** Index symbols/docstrings; answer intent queries.
  **E+V+H** — hybrid is essential here (exact identifier match via BM25 + intent via vectors; neither alone works).
- **SYS-4 — Embedded RAG support/FAQ bot.** Ships *inside* an app, no vector-DB server, no embedding API bill.
  **E+V+H.** Leans on **degrade-to-BM25** so the bot stays useful if the embedder is unavailable.
- **SYS-5 — Long-term memory for a 3rd-party agent framework.** Episodic recall by similarity for someone
  else's agent stack. **E+V+H. Pulls G** (episode relations/supersession) **+ A** (theme clustering) — i.e. a
  consumer literally rebuilding a memory system from the primitives (the strongest reuse validation).
- **SYS-6 — Ingest-time dedup (CMS / support-ticket / CRM-lead).** Flag near-duplicate incoming content.
  **E+V + heavy A** (near-dup is the product). Strongest signal that **analysis wants to be public**.
- **SYS-7 — Observability: semantic log/error clustering.** Group error messages/traces into incident families.
  **E+V + A** (clustering). Another analysis pull.
- **SYS-8 — "Related items" recommendations.** "Similar products" / "related articles" via nearest-neighbour.
  **E+V** only — lightweight, no ranking-fusion needed; proves the packages work *minimally*, not just maximally.
- **SYS-9 — Air-gapped / privacy-sensitive RAG (healthcare, legal, defense).** The **no-API + no-egress +
  offline + deterministic** constraints ARE the product. **E** (local, no egress; multilingual-e5 model for
  non-English corpora — exercises the multi-model design) **+V+H**. This is the use case the whole constraint
  set exists for.
- **SYS-10 — Prompt/model-output eval & drift harness.** Embed outputs, detect regression via cosine drift,
  snapshot-test in CI. **E (deterministic provider — byte-stable, no download in CI) + V + A** (drift
  clustering). Showcases the deterministic provider as a first-class consumer need, not just a test shim.

### What these reveal
- **All 10 use E+V; 7 use H** — the public three are the correct, sufficient *retrieval* backbone. None needs
  the packages to *compose/compile/optimize/rerank* — that's always the consumer's domain (and reranking
  would be the still-empty `inference` group).
- **5 of 10 pull a PRIVATE package** (G: SYS-1/2/5; A: SYS-1/5/6/7/10). graph-store and analysis are the
  recurring external asks → **concrete demand to reconsider their private status (ADR-0006 / F1)** — log it as
  evidence rather than discovering it after they're locked private.
