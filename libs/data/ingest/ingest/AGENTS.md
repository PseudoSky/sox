# CLAUDE.md — data/ingest/ingest

Rules for working in this package (agent-routing layer; keep authoritative + minimal).

## Interface contract

The authoritative interface spec for this package is:
**[docs/plan/memory-refactor/COMPILED_INTERFACES.md](../../../../docs/plan/memory-refactor/COMPILED_INTERFACES.md)**

`src/index.ts` is a compileable skeleton of the interfaces — all types match that spec.
Do not add implementation code to `src/index.ts` directly; implementation lands via the
memory-refactor plan states.

## Invariants (do not violate)

- zero-LLM, zero-I/O, synchronous — ingest() is a pure function, always safe to call in the write path without latency budget concerns
- deterministic + byte-reproducible — same input always produces the same hash, summary, and tags (no random or time-based components)
- PRIVATE — never published to npm; only the memory domain composer may call this package

## Boundaries

- `area:data` may import `area:data` + `area:shared` only — NEVER `area:platform`
  (enforced by nx module-boundary lint).
- Published npm name (`@adhd/sox-ingest`) is decoupled from this folder path —
  never rename the package name on a folder move.

## Build / test

- `npx nx build ingest` · `npx nx test ingest` · `npx nx lint ingest`
- Build via nx targets only — bare `tsc` emits into `src/` and bypasses project graph.
- This is a data-layer library; it is NOT registered in `registry/index.json` —
  skip `npx nx run registry:sync-index` after changes here.

## Publish posture

Currently `private: true`. **Under active decision (BL-165):** the owner chose to CONSOLIDATE this
package into the canonical ingestion layer (route memory-server chunking + write.ts hashing through
it), after which it likely becomes PUBLIC so `memory-core` is cleanly installable for external RAG
reuse. Do not treat "never publish" as settled — see BACKLOG.md.

## ⚠️ STATUS: barely used + capabilities duplicated — consolidation pending (S11)

Today the system uses `ingest()` for ONLY its extractive summary; its chunking / content-hashing /
tag extraction are UNUSED and duplicated by ad-hoc code (memory-server `splitIntoChunks`, write.ts
SHA-256). Before extending, read **[`BACKLOG.md`](./BACKLOG.md)**.

## Backlog

Findings for this package live in **[`BACKLOG.md`](./BACKLOG.md)** — cross-referenced to the root
[`/BACKLOG.md`](../../../../BACKLOG.md) BL-IDs. **Read it before extending this package.**
- **BL-165 (MEDIUM, owner decision: consolidate → S11):** make ingest the canonical ingestion layer;
  delete the duplicate chunker/hasher elsewhere.
- **BL-115 (MEDIUM):** AST chunker uses regex/brace heuristics, not tree-sitter.
- **BL-117 (LOW):** late-chunking flag is a no-op.
