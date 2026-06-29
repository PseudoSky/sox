# @adhd/sox-ingest

Write-path single-item transforms for the memory domain — content-hash (SHA-256), extractive summary (sentence-scoring, zero LLM), deterministic tag extraction, and chunking/normalization. Pure stateless functions; no storage deps. Private: only the memory domain composer calls these before graph-store writes.

- **area:** data · **group:** ingest · **publish:** PRIVATE — not published to npm
- **engines:** Node >=20
- **concerns:** content-hash (SHA-256 of normalized content — used for graph-store dedup), extractive summary (sentence-scoring, summaryMaxSentences, zero LLM), deterministic tag extraction (noun phrases, high-frequency terms, tagMaxCount), chunking (maxChars / overlapChars sliding window), per-chunk contentHash for dedup at the chunk level

## Invariants

- zero-LLM, zero-I/O, synchronous — ingest() is a pure function, always safe to call in the write path without latency budget concerns
- deterministic + byte-reproducible — same input always produces the same hash, summary, and tags (no random or time-based components)
- PRIVATE — never published to npm; only the memory domain composer may call this package

## Interface spec

See [COMPILED_INTERFACES.md](../../../../docs/plan/memory-refactor/COMPILED_INTERFACES.md) for the authoritative interface contract. `src/index.ts` is a compileable ambient-declaration skeleton;
implementation is extracted from `libs/memory-core` / `libs/memory-enrich` by the memory-refactor plan.
