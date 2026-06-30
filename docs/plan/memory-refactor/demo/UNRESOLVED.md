# UNRESOLVED — soxe memory primitives Demo

Interfaces this demo had to guess, and scope gaps found while authoring. The `data/*` packages are
**not built yet** — this DEMO.md is the acceptance contract for the memory-refactor plan, so every
exact API surface is a target the implementer confirms/pins during extraction (states w2a–w2d). The
plan's `scripts/pack-smoke.mjs` grounds the core call shapes; rows below are where it goes beyond that.
Resolve each before treating the corresponding DEMO.md step as authoritative.

## Unresolved interfaces

| ID  | Guessed interface | Used in | Basis | What would confirm it |
|-----|-------------------|---------|-------|-----------------------|
| U1  | Published package names/versions `@adhd/sox-{embedding-provider,vector-store,graph-store,hybrid-search,analysis,ingest}@0.1.0` | §2.4 | SCOPE Part B (<public@0.x>) — versions inferred, not yet published | the actual first-published versions after w2e/publish |
| U2  | `resolveProvider({backend})` → provider with `.embed(text):Float32Array`, `.modelId`, `.dim` | §1.1, §4 | `pack-smoke.mjs` §embedding-provider (shows `resolveProvider`, `embed`, `dim`, `isDeterministic`); `modelId` field name + exact return type inferred | the w2a embedding-provider public API / its `.d.ts` |
| U3  | Loud-fail: `resolveProvider({backend:'real'})` THROWS when the runtime is unavailable; `SOX_EMBED_FORCE_UNAVAILABLE` env to simulate | §1.3 | `[inv:loud-fail]` (must fail loud, no silent hash) — exact throw + the simulation env var inferred | the w2a loud-fail implementation + its test |
| U4  | Space-invariant rejection: `upsertVector` throws on dim/modelId mismatch with a `dimension mismatch: expected N, got M` style message | §2.2 | `[inv:space]` (reject mismatched vectors) — the exact error text inferred | the w2c vector-store invariant enforcement + its test |
| U5  | `npm ls @adhd/sox-graph-store` shows vector-store does NOT depend on graph-store | §2.3 (Act 2.3) | `[inv:boundary]` + `references.json` (vector-store standalone) — the negative dep assertion inferred | vector-store's published `package.json` dependencies |
| U6  | `computeImportance(...)` signature + return | §3.3 | `pack-smoke.mjs` §analysis (only asserts the export is a function) | the w2d analysis public API / `.d.ts` |
| U7  | Climax composition: `upsertVector(db, id, await p.embed(text), {modelId})` + `knn(db, qvec, k) → [{nodeId}]` end-to-end | §4 | `pack-smoke.mjs` §vector-store (`knn`→`[{nodeId}]`); the embed→store→knn wiring + that `knn` hit shape carries only `nodeId` (score field name unknown) inferred | the w2c/w2d composed API once extracted |
| U8  | `hybrid-search` export named `search` or `hybridRecall`; degrade-to-BM25 returns keyword-ranked results with no vector signal | §5.1 | `pack-smoke.mjs` §hybrid-search (export-exists only) + `[inv:degrade-to-bm25]` — the call signature + degrade behavior inferred | the w2d hybrid-search public API + degrade test |
| U9  | `scripts/reembed-memory.mjs --dry-run` reports stale-`modelId` record count and writes nothing | §5.2 | `references.json` (reembed core) + the shipped `scripts/reembed-memory.mjs` (quickfix) — the dry-run report format inferred | running the script post-extraction against a test store |

## Scope gaps & open questions

- **The packages are not built yet.** This entire DEMO.md is the *acceptance contract* for the
  memory-refactor (states w2a–w2e build the `data/*` packages); it becomes runnable only after the
  plan executes + the packages publish. Until then it defines scope, not a passing run. The plan's
  `[audit-final.5]` / `pack-smoke.mjs` is the automated form of the §2.4/§2.3/§4 standalone proofs.
- **`graph-store` write/query API beyond `applyGraphSchema` is unspecified.** §3.2 only exercises
  schema creation; node-insert / edge-add / bi-temporal-query / supersession-chain surfaces
  (USE_CASES UC-GRA-1/3/5) have no grounded API yet — confirm during w2b before extending the demo
  to a full graph round-trip.
- **No GPU/scale path is demonstrated (intentional).** Per SCOPE Part D the toolkit targets Phase-0
  (pure-JS, <50K rows); ANN/quantization/usearch are explicit non-goals/seams, so this demo proves
  brute-force only — not a gap to fix, a scope boundary to record.
