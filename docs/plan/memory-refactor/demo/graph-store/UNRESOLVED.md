# UNRESOLVED — @adhd/sox-graph-store Demo

Interfaces this demo had to guess, and scope gaps found while authoring.
Resolve each before treating the corresponding DEMO.md step as authoritative.

The only grounded API is `applyGraphSchema(db)` (confirmed by `docs/plan/memory-refactor/scripts/pack-smoke.mjs` §graph-store). All other helper function signatures are inferred from `docs/plan/memory-refactor/contexts/w2b-graph-store.md` ("content-hash insert", "invalidate-sets-t_invalid", "supersession edges" helpers) and `docs/plan/memory-refactor/USE_CASES.md` (UC-GRA-1..5). Confirm via `nx test graph-store` passing and runtime API inspection once `w2b-graph-store` execution completes.

## Unresolved interfaces

| ID | Guessed interface | Used in | Basis | What would confirm it |
|---|---|---|---|---|
| U1 | `insertNode(db, { name: string, content: string, topic?: string, tags?: string[] }): { uid: string, contentHash: string, existed: boolean }` | beats 2.1, 2.2, 2.3, 5.2, resilience 5.2 | w2b-graph-store.md "content-hash insert" helper; UC-GRA-2 no-op semantics; `existed` flag inferred from "re-ingest is a no-op" contract | `nx test graph-store` + exported API inspection at runtime; confirm `existed` field name |
| U2 | `invalidateNode(db, uid: string): void` — sets `t_invalid` to current ISO timestamp, never issues DELETE | beat 4.2 | w2b-graph-store.md "invalidate-sets-t_invalid" helper; acceptance [w2b.4] | `nx test graph-store` [w2b.4]; confirm function name and signature |
| U3 | `addEdge(db, { srcUid: string, dstUid: string, rel: 'REQUIRES' \| 'SUPERSEDES' \| 'DERIVED_FROM' \| 'RELATES_TO', weight?: number }): void` | beats 3.1, §4 climax | w2b-graph-store.md "supersession edges" helper; UC-GRA-3 typed edges | `nx test graph-store` + edge table inspection; confirm rel enum values and field names |
| U5 | `getNeighbors(db, uid: string, opts?: { rel?: string, direction?: 'out' \| 'in' \| 'both' }): NodeRow[]` — returns nodes connected by the given edge type | beat 3.2 | UC-GRA-3 ("traverses neighbors at depth"); inferred from graph-store read surface | `nx test graph-store`; confirm option shape and direction semantics |
| U6 | `queryAt(db, opts?: { asOf?: string, includingInvalidated?: boolean, topic?: string }): NodeRow[]` — returns nodes valid at `asOf` (default: now); when `includingInvalidated: false` (default), filters `t_invalid IS NULL` | beats 4.3, §4 climax | UC-GRA-1 ("queries point-in-time state; nothing is ever deleted"); inferred from point-in-time contract | `nx test graph-store`; confirm option names; confirm `includingInvalidated` default |
| U7 | `ftsSearch(db, query: string, opts?: { limit?: number }): { uid: string, name: string, rank: number }[]` — FTS5 BM25 search over node content/name/topic | beats 5.1, 5.2 | UC-GRA-4 ("FTS5 keyword search kept automatically in lockstep"); acceptance [w2b.3] | `nx test graph-store` [w2b.3]; confirm return shape and rank sign convention |
| U8 | `supersessionChain(db, uid: string): { uid: string, name: string, content: string, supersededBy?: string, supersedes?: string }[]` — ordered chain from oldest to newest, following SUPERSEDES edges | §4 climax | UC-GRA-5 ("follow supersession chains — what superseded X / what X superseded"); w2b-graph-store.md "supersession edges" | `nx test graph-store`; confirm ordering (oldest-first vs newest-first); confirm field names `supersededBy`/`supersedes` |

## Scope gaps & open questions

1. **Package not yet built.** `@adhd/sox-graph-store` is an acceptance contract at the time of authoring. The `w2b-graph-store` state in `docs/plan/memory-refactor/dag.json` defines the extraction task. All beats in DEMO.md are the acceptance targets for that extraction.

2. **Idempotency of `applyGraphSchema` proven by spec, not pack-smoke.** The pack-smoke (`scripts/pack-smoke.mjs`) only asserts the `node` table is created; it does not call `applyGraphSchema` twice. Idempotency is grounded by acceptance criterion [w2b.2] in `contexts/w2b-graph-store.md` but must be verified by `nx test graph-store`.

3. **UID generation scheme.** The `uid` field type and generation strategy (UUID v4, ULID, or other) is not specified in available context. The demo treats it as an opaque non-empty string. Confirm by inspecting the extracted source once `w2b-graph-store` executes.

4. **Edge invalidation semantics.** Whether `invalidateNode` also marks its outgoing/incoming edges as invalid is not specified. The demo assumes edges persist independently (the `edge` table has no `t_invalid` column referenced in context). Confirm via schema inspection.
