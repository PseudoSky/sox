# Shared context — Memory subsystem decomposition + agent-optimized workspace

> **Single source of truth for definitions.** Every work-state context references
> entries here by name instead of restating them. Change a definition once, here.
> Companion strategic brief: `docs/plan/memory-refactor/SCOPE.md`.
> Layout/standards spec: `docs/plan/memory-refactor/NX-GENERATOR-HANDOFF.md`.

---

## Glossary

Reference as **[def:term]** from any context file.

- **[def:area-group]** — the two-level workspace taxonomy
  `libs/<area>/<group>/<package>/`. **areas:** `platform` · `data` · `shared`.
  **groups:** `platform/{contract,distribution,host,runtime,protocol,authoring,devtools}`,
  `data/{embed,inference(reserved),vectors,graph,store(reserved),search,analysis,ingest}`,
  `shared/{codec}`. Each package carries nx tags `area:<a>` + `group:<g>` (+ `type:lib`)
  and `sox:{area,group,concerns,invariants,entrypoints}` metadata ([shape:sox-metadata]).
  The generator that *creates* packages in this layout is built by a **separate team**
  (`NX-GENERATOR-HANDOFF.md`); this plan **consumes** it (or the scaffold script) and
  migrates existing code into the taxonomy.
- **[def:data-package]** — the six reusable primitives carved out of
  `memory-core`/`memory-enrich`, each independently versioned, no "memory" in its name:
  `embedding-provider`(data/embed) · `vector-store`(data/vectors) · `graph-store`(data/graph)
  · `hybrid-search`(data/search) · `analysis`(data/analysis) · `ingest`(data/ingest).
  Skeletons are pre-created by `scripts/scaffold-data-packages.mjs`; this plan **populates**
  them, it does not re-scaffold.
- **[def:space-invariant]** — `modelId`+`dim` define the vector space. A vector whose
  `dim`/`modelId` ≠ the column's is **rejected** by `vector-store`; models cannot mix in
  one space; a model switch is a **re-embed migration** ([def:reembed-core]), never a
  hot-swap. This is the hardest invariant in the plan and is encoded as a machine check
  (`p0-baseline`) and enforced in code (`w2c-vector-store`).
- **[def:loud-fail]** — the embedding resolver **THROWS** if the configured real provider
  cannot load; there is **no silent hash downgrade**. The deterministic/hash provider is a
  first-class, explicitly-selected provider — never an implicit fallback. (Carries the
  quickfix's BL-89 "fail loud, not silent" repair into `embedding-provider`.)
- **[def:degrade-to-bm25]** — *read-path* survivability, distinct from [def:loud-fail]:
  `hybrid-search` MUST still return a BM25/FTS-ranked result when vectors are unavailable.
  Degrading **retrieval ranking** under missing vectors is required; silently degrading
  **write-time embedding** to hash is forbidden ([def:loud-fail]).
- **[def:connection-seam]** — the [decision-C] resolution. The **composer** ([def:domain-composer])
  owns the SQLite connection: `openDb(path)` opens the file, loads `sqlite-vec`, applies
  pragmas, expands `~` at the sink (BL-41 `expandDbPath`), then calls
  `graph-store.applyGraphSchema(db)` + `vector-store.applyVecSchema(db,{dim,modelId})`.
  `graph-store` and `vector-store` each accept an **injected `Database`** and run their own
  DDL on it — **neither imports the other** (`data/vectors ↛ data/graph`). `vector-store`
  additionally exports a convenience `openVectorStore(path,{dim})` (open + vec-load only) so
  a 3rd party can use it **standalone** without the composer. No `data/store` package is
  created (the `store` group stays reserved).
- **[def:reembed-core]** — the **single** model-migration walk, living in `vector-store`
  (it owns the [def:space-invariant] + per-record `modelId`): find every record whose stored
  `modelId` ≠ the active provider's, re-embed via `embedding-provider`, rewrite the `vec_node`
  rows, update `embed_model`. It **absorbs/generalizes** the quickfix's
  `scripts/reembed-memory.mjs` (do NOT duplicate it). Exposed BOTH as a daemon op
  (`memory-daemon`) AND a thin script wrapper — one core, two entry points.
- **[def:domain-composer]** — the slim `memory-core` that **remains** after extraction
  ([def:facade-then-dissolve]). Keeps the `memory-core` name (a rename is a breaking npm +
  registry/lockfile/consumer churn for marginal benefit — efficiency wins). Holds the
  genuinely-unique domain glue: session-state, scope/promotion policy, db-composition
  (`openDb`, [def:connection-seam]), and the `memory_*` tool-surface composition. Composes
  `data/*`. Tagged `type:lib` with **NO `area:` tag** → the area depConstraints do not
  constrain it, so it may compose `data/*` freely (a data primitive importing it, by
  contrast, fails the positive `area:data` allowlist — desirable). `memory-enrich`
  **dissolves** entirely into `analysis` + `ingest`.
- **[def:facade-then-dissolve]** — the strangler-fig migration in `w2e`: (1) make
  `memory-core`/`memory-enrich` **re-export** from the new `data/*` packages (zero consumer
  change → a green checkpoint that proves the extraction is behavior-identical); (2) **flip**
  the four bundle members (`memory-server`, `memory-daemon`, `memory-cli`, `memory-flush`)
  to import `data/*` directly; (3) **delete** the dead facade re-exports, leaving only the
  slim [def:domain-composer]. Each step is independently green.
- **[def:tool-contract]** — the external **19-tool `memory_*` MCP surface (v1.1.0)** exposed
  by `memory-server`. Its tool names + input/output shapes are the public contract; keeping
  it **byte-unchanged** across the entire plan is the extraction's headline acceptance
  ([inv:tool-contract-stable]).
- **[def:routing-index]** — the agent decision-routing layer (SCOPE Part C): a **generated**
  `map.json` + `INDEX.md` (root + per-area), harvested from the nx graph + per-package
  `sox:{…}` metadata, behind a **drift gate** (never hand-maintained — mirror-drift is a
  proven failure here). Plus hierarchical authored `CLAUDE.md` (root→area→group), a hand-
  curated `ROUTER.md` (intent→scope), and a soft sox-memory advisory layer that is
  **advisory only, never gating, and must not depend on embedding health**.
- **[def:quickfix]** — the front-loaded `docs/plan/memory-embedding-quickfix/SCOPE.md`
  engagement that repairs the *running* system (ships `fastembed`/`onnxruntime-node` in the
  published bundle, makes failure loud, re-embeds the live store). It produced
  `scripts/reembed-memory.mjs`. This plan **assumes the quickfix lands first and extracts
  its changes cleanly** — it does NOT redo BL-87/89/86.
- **[def:audit-runner]** — `scripts/audit_memrefactor.py` in this plan dir. A phase-scoped
  checklist runner (`--phase baseline|layout|extraction|routing|final`); each `--phase`
  runs its checks plus all prior phases; exits with the failure count. Read-only — fixes
  happen in source, never by weakening a check ([def:audit-runner] mirrors `audit_c6.py`).

---

## Cross-cutting invariants

Contracts every state must preserve. A state's context lists only its *additional*
invariants and references these by ID.

- **[inv:quickfix-landed]** `p0-baseline` cannot be *entered* until [def:quickfix] is merged
  to `main` AND the live **user-scope** `memory-server` reports `embed_on_hash_fallback:false`
  + `embed_model:"bge-base-en-v1.5"`. NB the quickfix is currently in a half-state: the live
  `~/.memory` store was re-embedded to the real model, but the user-scope **server** is still
  hash because delivering the native `fastembed` dep needs an **owner-gated npm republish**
  (pending with the user). The P0 gate is correct; it is simply blocked on that republish.
- **[inv:space]** [def:space-invariant] holds everywhere: write-path embeds carry the active
  `modelId`; `vector-store` rejects a mismatched vector; a model switch routes through
  [def:reembed-core]. Check: the `p0-baseline` machine check + `w2c` unit tests + the final
  reality audit.
- **[inv:tool-contract-stable]** [def:tool-contract] is unchanged by every state. Check: a
  snapshot of the 19 tool names + JSON-schema shapes captured at `p0-baseline` and re-asserted
  at `audit-extraction` and `audit-final`.
- **[inv:loud-fail]** [def:loud-fail] holds: no code path silently downgrades write-time
  embedding to hash; the hash/deterministic provider is selected only by explicit config.
  Read-path [def:degrade-to-bm25] is the *only* sanctioned degradation, and only for ranking.
- **[inv:boundary]** [def:area-group] boundaries are lint-enforced: `data→data|shared`,
  `platform→platform|shared`, `shared→shared`. A synthetic `data→platform` import MUST fail
  `nx lint` — the [ref:handoff] §7.3 acceptance test.
- **[inv:registry-current]** every code-type extension/bundle-member that ships a `dist` is
  checksummed in `registry/index.json`. After any artifact change run
  `npx nx run registry:sync-index`; `check-registry-sync` must stay green. **Never** hand-edit
  `registry/index.json`; **never** `git add -A`/`.`/`--all` — stage by explicit path.
  `build-index.ts` ↔ `check-registry-sync.ts` are a **byte-mirror pair (BL-33)**: if a state
  adds a scanned dir/type, edit BOTH identically.
- **[inv:no-regress]** No state red-bars anything currently green. Baseline captured at
  `p0-baseline`: `nx run-many -t build,lint,test` green and `nx run host-runtime:test-e2e`
  passes with **zero orphans** (the BL-31 global-`pgrep` check — mind **BL-63**: a live local
  `memory-server` proxy session on the dev box shows as a false leaked-orphan; reconcile
  against that known baseline, do not chase a phantom).
- **[inv:nx-targets]** Build/lint/test/typecheck through **nx targets only**, never bare
  `tsc`/`vitest`/`eslint`. Before any memory test, `npx nx build memory-core && npx nx build
  memory-server` first (BL-4 stale-`dist` — a vitest pass against stale `dist` proves
  nothing; [ref:bl4-stale-dist]). Prove runtime behavior against built `dist`.
- **[inv:name-decoupled]** A package's published name `@adhd/sox-<pkg>` is **decoupled from
  its folder path** (it is the registry/content-address key). A move/relocation MUST NOT
  change the published name ([ref:handoff] §2).
- **[inv:reality]** Acceptance is verified against **real built artifacts + the live MCP
  surface**, never a self-reported log or a vitest run alone. The final audit spawns the real
  built `memory-server` and exercises the 19 tools + a cosine-sanity probe.
- **[inv:lifecycle-spec]** Any touch to service/daemon lifecycle (`memory-daemon`,
  supervisor, the `reembed` daemon op wiring) conforms to `docs/spec/service-lifecycle.md`
  §13 invariants; cite the section relied on. No state rewrites host-runtime lifecycle.
- **[inv:carry-fixes]** Fixes embedded in the extracted code travel with it unchanged:
  `expandDbPath`/`expandTilde` BL-41 sink parity ([ref:guard-before-sink]), the BL-11 process-
  boundary note (openDb + real `embed()` must not share a thread — keep the worker seam), the
  BL-27 organizer_queue CHECK migration, the BL-86 hash-degeneracy repair (now the
  deterministic provider).

---

## Shared fixtures and sample data

- **[fix:cosine-sanity]** two unrelated strings → cosine **~0** under the real model (NOT
  **~0.97–0.998** as the degenerate hash produces). The canonical "is the real model
  actually on?" probe; used by `p0-baseline` and `audit-final`.
- **[fix:synthetic-boundary]** a throwaway `import '@adhd/sox-<a-platform-pkg>'` added to a
  `data/*` package to prove `nx lint` FAILS, then removed. The [inv:boundary] / [ref:handoff]
  §7.3 acceptance test; `audit-layout` runs it in a sandboxed copy so it never lands.
- **[fix:memory-db]** a temp **copy** of `~/.memory/memory.db` (never the live file) for
  exercising [def:reembed-core] dry-run + idempotence in `w2c`/`audit-final`.
- **[fix:tool-snapshot]** the captured list of the 19 `memory_*` tool names + their JSON
  input schemas (from a live `tools/list` against the built server), stored under the plan
  dir at `p0-baseline`; the diff target for [inv:tool-contract-stable].

---

## Type and config shapes

```text
[shape:sox-metadata]   (package.json, every data/* + tagged lib — NX-GENERATOR-HANDOFF §2)
  "sox": {
    "area": "data", "group": "vectors",
    "concerns":   ["vec0 persistence", "kNN/cosine", "space invariant", "per-record modelId"],
    "invariants": ["modelId+dim define the space — reject a mismatched vector",
                   "a model switch is a re-embed migration, never a hot-swap"],
    "entrypoints":["dist/index.js"]
  }
  nx tags: ["type:lib", "area:data", "group:vectors"]

[shape:embedding-provider-api]   (data/embed — SCOPE Part D)
  interface EmbeddingProvider {
    readonly providerId: string; readonly modelId: string;
    readonly dim: number;        readonly isDeterministic: boolean;
    embed(text: string): Promise<Float32Array>;
    embedBatch(texts: string[], opts?: {batchSize?: number}): AsyncGenerator<Float32Array>; // default 256
    queryEmbed?(text: string): Promise<Float32Array>;   // optional query-optimized
  }
  function resolveProvider(config): EmbeddingProvider   // THROWS if real provider can't load ([def:loud-fail])
  // startup Map cache for hot/topic embeddings; deterministic provider is first-class, explicit-only.

[shape:vector-store-api]   (data/vectors — [def:connection-seam] + [def:space-invariant])
  function applyVecSchema(db: Database, opts: {dim: number, modelId: string}): void;
  function upsertVector(db, nodeId: number, vec: Float32Array, meta: {modelId: string}): void; // rejects dim/modelId≠column
  function knn(db, query: Float32Array, k: number, filter?): {nodeId:number, score:number}[];   // brute-force seam (no ANN now)
  function openVectorStore(path: string, opts: {dim:number}): Database;                          // standalone-reuse opener
  function reembed(db, opts: {active: EmbeddingProvider, dryRun?: boolean}): ReembedResult;       // [def:reembed-core]

[shape:depconstraints]   (eslint.config.js — inserted BEFORE the '*' catch-all, both ts + js blocks)
  { sourceTag: 'area:data',     onlyDependOnLibsWithTags: ['area:data','area:shared'] },
  { sourceTag: 'area:platform', onlyDependOnLibsWithTags: ['area:platform','area:shared'] },
  { sourceTag: 'area:shared',   onlyDependOnLibsWithTags: ['area:shared'] },
  // existing type:* constraints + the permissive { '*': ['*'] } catch-all are retained.
```

```text
[ref:handoff]  docs/plan/memory-refactor/NX-GENERATOR-HANDOFF.md — §2 born-conformance,
   §3 boundary depConstraints, §5 routing-index metadata, §7 acceptance.
[ref:guard-before-sink]  the permission guard runs before openDb; expandTilde (memory-server)
   must stay byte-identical to expandDbPath (memory-core/db.ts) so allowlist + open agree.
[ref:bl4-stale-dist]  nx build memory-core && nx build memory-server BEFORE any memory test.
[ref:no-cross-extension-reachin]  C7 — no ../dist reach-in; route through @adhd/sox-* scope.
[ref:scaffold]  scripts/scaffold-data-packages.mjs — pre-creates the 6 data/* skeletons.
```
</invoke>
