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

PRIVATE — `private: true`. Never publish this package. Only the memory domain composer may import it.
