# sox-memory — Phased Resumable Build Plan (Deliverable 4)

**Companion to** [`design.md`](./design.md). MVP-first. Every milestone has a **deterministic
acceptance check** (a command that exits 0/1 — no human judgment). Phases are resumable: each begins
by asserting the prior phase's acceptance check still passes (red→green guard), so an executor can
resume mid-plan after a cold start.

**State machine:** `initialized → P0 → P1(MVP) → P2 → P3 → P4 → P5 → complete`.
Skipping forbidden. Each phase updates `status.md`.

Conventions: `$ROOT=/Users/nix/dev/ai/sox-ecosystem`. Extensions scaffolded via
`node scripts/new-extension.ts <type> <id>`. All acceptance checks runnable from `$ROOT`.

---

## Phase 0 — Install the memory bundle into the ecosystem skeleton

**Goal:** the four extensions exist, scaffolded by the ecosystem's own generator, pass
`validate-manifests.ts`, resolve through the install client into a lockfile, and load as stubs. This
phase proves the *packaging* contract before any memory logic exists.

**Steps**
1. `node scripts/new-extension.ts mcp-server memory-server` · `agent memory-organizer` ·
   `hook memory-flush` · `command memory-cli` (generator writes conformant `extension.json` +
   `package.json` + `src/index.ts`/`prompt.md` + `CHANGELOG.md`).
2. Edit each `extension.json` to the manifests in design §1.1 (descriptions, `requires`,
   `dependencies`, `order`, `capabilities`, `tags`). Keep `version` 0.1.0 and **package.json-synced**.
3. `memory-flush/src/index.ts`: `export const event = "SessionEnd"`, stub `handler`.
4. Add a project-scope `.extensions/extensions.json` with the bundle `install[]` + `config{}`
   (design §1.2). Create `bundle.fragment.json` at repo root for reuse.
5. `pnpm changeset` for the initial 0.1.0 set.

**Acceptance check (deterministic)**
```bash
pnpm tsx scripts/validate-manifests.ts            # 9 invariants, exit 0
pnpm tsx scripts/build-index.ts && node -e "j=require('./registry/index.json'); \
  ids=j.map(x=>x.id); req=['memory-server','memory-organizer','memory-flush','memory-cli']; \
  process.exit(req.every(i=>ids.includes(i))?0:1)"
pnpm tsx scripts/install.ts --scope project       # writes .extensions/extensions.lock
node -e "l=require('./.extensions/extensions.lock'); k=Object.keys(l.resolved); \
  process.exit(['memory-server@','memory-organizer@','memory-flush@','memory-cli@'] \
  .every(p=>k.some(x=>x.startsWith(p)))?0:1)"
```
**Green =** all four manifests valid, registry-indexed, resolved into the lockfile with sha256
checksums. **No memory behavior yet** — this is the inaugural proof that the ecosystem can package a
real tenant.

---

## Phase 1 — MVP: single-project store + hybrid recall <50 ms (one `.db`)

**Goal:** the smallest end-to-end useful system — `memory init` makes one project `.db`;
`memory_write` ingests; `memory_recall` returns hybrid (vec+BM25+graph depth-1) results <50 ms at
10K rows. **In-process write, no daemon, no LLM** (importance defaults to 1.0; deterministic NER only).

**Steps** (~520 LOC, design §3 MVP subset)
1. `memory-server`: schema/migrations/pragmas (design §2.2 minus `promotion_queue`), `better-sqlite3`
   + `sqlite-vec` load, FTS5 setup, embedding wrapper (`fastembed` nomic-768).
2. `memory_write` (synchronous insert + embed + FTS index, SHA-256 dedup) and `memory_recall`
   (vec KNN ⊕ BM25 ⊕ temporal → RRF k=60 → recency/importance rerank → assemble; graph depth-1).
3. `memory-cli`: `memory init --scope project` (creates `.memory/project.db`, pins embed model).

**Acceptance check**
```bash
node dist/memory-cli init --scope project --path ./.tmp-mvp        # creates .memory/project.db
node tools/seed.js ./.tmp-mvp/.memory/project.db 10000             # deterministic 10k fixture
node tools/bench-recall.js ./.tmp-mvp/.memory/project.db --n 200   # 200 queries
  # asserts: p95 latency < 50ms  AND  provider_call_count == 0  AND  top-1 hit-rate on labeled set ≥ 0.9
  # exit 0 only if all three hold
```
**Green =** invariants **R1** (<50 ms, zero LLM read) + **R2** (one `.db`, idempotent init) hold.

---

## Phase 2 — Daemon + organizer (the only LLM locus) + bi-temporal writes

**Goal:** move writes behind `memoryd`; episodic extraction (relations, importance 1–10,
contradiction) runs as batched LLM via `memory-organizer` through the ecosystem provider; bi-temporal
invalidation works; `memory_invalidate` + `memory-flush` hook live.

**Steps**
1. `memoryd` singleton (advisory lock), `organizer_queue` drain, hybrid IPC (table + socket doorbell,
   1000 ms fallback poll), priority queue, 7-step loop, decay/reindex.
2. `memory-organizer` agent: batched provider calls (structured_output) for triples + importance +
   contradiction + reflection (Σimportance ≥ 150). Entity link 0.95/0.7–0.95 bands.
3. `memory_write` → enqueue + nudge (no longer synchronous-LLM). `memory_invalidate` closes
   `t_invalid`, writes `SUPERSEDES`. `memory-flush` handler: persist session state, enqueue episodes,
   nudge consolidate.

**Acceptance check**
```bash
node tools/test-organize.js     # writes a contradicting fact pair; waits for daemon drain
  # asserts: (a) exactly the organizer made provider calls (read path counter still 0)
  #          (b) old claim has t_invalid set, both rows present (no delete)
  #          (c) memory_recall returns new claim; memory_recall{as_of:past} returns old claim
node tools/test-daemon-crash.js # kill -9 daemon mid-batch, restart
  # asserts: queue resumes from MAX(seq WHERE done_at IS NULL); no lost/dup writes  → exit 0
```
**Green =** invariants **R3** (LLM only in organizer) + **R5** (bi-temporal, as_of) + IPC durability.

---

## Phase 3 — Multi-scope stores + cross-scope RRF federation

**Goal:** user + org stores; `memory_recall` federates with scope-weighted RRF union; `agent_id`
boost; cross-store content-hash dedup; org store resolved from `extends` baseline.

**Steps**
1. `memory init --scope user|org`; registry at `~/.memory/registry.json`; discovery walk cwd→home
   intersected with installed+enabled scopes.
2. Federation: parallel WAL fan-out, per-store hybrid, scope-weighted RRF (1.0/0.6/0.4, agent ×1.25),
   union + supersede-override, graph expansion project-store-only.

**Acceptance check**
```bash
node tools/test-federation.js   # seeds project+user+org with overlapping + scope-unique facts
  # asserts: (a) all scopes surface (union, not override)
  #          (b) project-scope dup outranks user/org dup; agent_id match boosted
  #          (c) supersede edge suppresses targeted broader-scope node
  #          (d) p95 federated recall (3 stores × 50k) < 50ms, zero LLM   → exit 0
```
**Green =** scope model conforms to ecosystem (org/user/project/local), no 5th scope invented.

---

## Phase 4 — Scope promotion + graphify import + communities

**Goal:** `promotion_queue` + `memory promote` approval flow; version-defensive graphify import;
community detection + `memory_get_community` + `memory_search_entities`.

**Steps**
1. Daemon logs promotion candidates (config policy 3-occurrence/60-day, tunable); `memory promote`
   interactive approve/reject; org-baseline `auto_approve` path.
2. `memory import --graphify`: `SUPPORTED_GRAPHIFY_SHAPES` guard, fail-loud on unknown fields,
   fixture per shape.
3. Leiden/label-prop community build (deterministic) + LLM summary (organizer); `memory_get_community`,
   `memory_search_entities` tools.

**Acceptance check**
```bash
node tools/test-promotion.js    # 3 sightings over simulated 60d → candidate; approve → applied to user scope; reject → no-op
node tools/test-graphify.js     # imports a good fixture (loads) AND a mutated-schema fixture (refuses, non-zero, no partial write)
node tools/test-communities.js  # entity→community resolves; get_community returns summary  → exit 0
```
**Green =** Gap-C workaround functional; Gap-Graphify version-defensive; 7th/6th tools live.

---

## Phase 5 — Conformance hardening, publish, scale-switch criterion

**Goal:** full `validate-manifests` + provider-capability checks under `strict_capabilities`;
Changesets publish 0.1.0 → registry; DiskANN switch criterion wired as config + a load test that
proves the trigger.

**Steps**
1. Re-run all prior acceptance checks (full regression / resumability proof).
2. `strict_capabilities:true` install against a capability-insufficient provider → hard-block asserted;
   default provider → pass.
3. Wire `config.db_engine` switch; load test to >50K and assert the engine-switch advisory fires at
   p95>35 ms; libSQL migration path documented + smoke-tested.
4. `pnpm changeset version && publish` (dry-run in CI); lockfile checksums verified.

**Acceptance check**
```bash
pnpm tsx scripts/validate-manifests.ts                                   # exit 0
node tools/test-strict-caps.js                                           # hard-block asserted
node tools/bench-scale.js --to 60000                                     # asserts switch-advisory fires; post-switch p95<50ms
pnpm changeset status --since=main && pnpm -r build                      # publishable, package.json-synced
```
**Green =** invariant **R4** (ships via ecosystem install/lockfile/Changesets only) + G1 scale trigger
proven. **state → complete.**

---

## Resumability & ownership

- **File ownership:** `memory-server/**` owns schema, recall, daemon, federation; `memory-organizer/**`
  owns the LLM step; `memory-flush/**` the hook; `memory-cli/**` the CLI + import + promote. No file is
  written by two extensions.
- **Resume guard:** each phase's first action re-runs the prior phase's acceptance check; on red, the
  executor repairs forward (never silently skips).
- **Deferred / out of scope for 0.1.0:** libSQL migration *execution* (criterion wired, switch is a
  follow-on), DuckDB analytics, hypergraph edges, RL/agent retrieval operators. All logged, not silently
  dropped.
