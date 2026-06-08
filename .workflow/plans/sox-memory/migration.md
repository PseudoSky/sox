# Migration plan: sox-memory on sox-ecosystem v2 native primitives

**Companion to** [`design.md`](./design.md). MVP-first. Every phase has a **deterministic acceptance
check** (a command that exits 0/1 — no human judgment) and a **standalone executor prompt** (a fresh
agent can run it cold). Phases are resumable: each begins by asserting the prior phase's acceptance
check still passes (red→green guard). The prior workaround-based plan is preserved at
[`migration.v1.md`](./migration.v1.md) — do not edit it.

**What changed from v1.** sox-ecosystem v2 (`../sox-ecosystem/architecture-v2.md` §10: COMPLETE, 131
tests) built the five primitives sox-memory v1 hand-rolled. The phases that built workarounds now
**consume** native primitives and **shrink**:
- **P0** installs a real **`bundle`** instead of scaffolding a `bundle.fragment.json` + `memory bundle
  --print` helper (**−40 LOC**).
- **P2** declares a **`lifecycle{}`** block instead of building lazy-spawn + OS advisory-lock singleton
  supervision (**−80 LOC**).
- **P4** wires promotion through the host **`ScopePromotionProposed`** event + `config.promotion`
  convention instead of bespoke signalling (**−40 LOC**).

**Net LOC vs v1 ≈ 1,780 → ≈ 1,620 (−160, −9%).** Heavy line items (recall, organizer, federation,
schema) are unchanged.

**State machine:** `initialized → P0 → P1(MVP) → P2 → P3 → P4 → P5 → complete`. Skipping forbidden.
**Phases:** 6 (P0–P5), unchanged in count; three are smaller.
**Current status:** planned (v2 re-plan; not started).

Conventions: `$ROOT=/Users/nix/dev/ai/sox-ecosystem`. Extensions scaffolded via
`node scripts/new-extension.ts <type> <id>` (v2 defaults `runtime:"node"`). All acceptance checks
runnable from `$ROOT`.

---

## Phase 0 — Install the memory **bundle** (native `bundle` type)

**Phase ID:** P0
**Phase goal:** the four behavioral extensions + one `sox-memory-bundle` exist, scaffolded by the
ecosystem generator, pass `validate-manifests.ts` (incl. v2 bundle/lifecycle/runtime checks), and the
bundle resolves through `install.ts` **post-cascade expansion** into a four-member lockfile.
**Inputs:** `design.md` §1.1–§1.3 (manifests + bundle); `../sox-ecosystem/architecture-v2.md` §G-B,
§G-A, §G-D; built `schemas/extension/v1.json`, `scripts/{install,validate-manifests,build-index,new-extension}.ts`.
**Outputs:** `extensions/{mcp-servers/memory-server, agents/memory-organizer, hooks/memory-flush,
commands/memory-cli}/extension.json` (+ package.json + stub entrypoint); `extensions/bundles/
sox-memory-bundle/{extension.json, package.json}`; a project-scope `.extensions/extensions.json` whose
`install[]` is the **single** `sox-memory-bundle` entry; `.changeset/` for the 0.1.0 set;
`.extensions/extensions.lock`.
**Verification:** the acceptance check below exits 0.

**Acceptance check (deterministic)**
```bash
cd "$ROOT"
pnpm tsx scripts/validate-manifests.ts            # passes incl. v2 bundle/lifecycle/runtime checks, exit 0
pnpm tsx scripts/build-index.ts && node -e "j=require('./registry/index.json'); \
  ids=j.map(x=>x.id); req=['sox-memory-bundle','memory-server','memory-organizer','memory-flush','memory-cli']; \
  process.exit(req.every(i=>ids.includes(i))?0:1)"
pnpm tsx scripts/install.ts --scope project       # writes .extensions/extensions.lock
# the SINGLE bundle entry must expand to exactly the 4 members in the lockfile:
node -e "l=require('./.extensions/extensions.lock'); k=Object.keys(l.resolved); \
  m=['memory-server@','memory-organizer@','memory-flush@','memory-cli@']; \
  process.exit(m.every(p=>k.some(x=>x.startsWith(p)))?0:1)"
```
**Green =** the bundle is registry-indexed and **expands post-cascade** into four checksummed lockfile
entries from one install line. No memory behavior yet — this proves native bundle packaging.

**Phase prompt:**

> You are a TypeScript build engineer onboarding to the `sox-ecosystem` monorepo at
> `/Users/nix/dev/ai/sox-ecosystem` (`$ROOT`). The ecosystem is a pnpm monorepo whose contract is
> embodied in `schemas/extension/v1.json` and `scripts/*.ts`. It was upgraded to **v2**, which added a
> `bundle` extension type, a `lifecycle` manifest block, and a `runtime` field (see
> `.workflow/plans/sox-ecosystem/architecture-v2.md` §G-A/§G-B/§G-D and its §10 conformance note —
> 131 tests green). You are installing the first tenant, **sox-memory**, packaged natively.
>
> Your task: scaffold five extensions and install them as one bundle. (1) Run
> `node scripts/new-extension.ts mcp-server memory-server`, `agent memory-organizer`,
> `hook memory-flush`, `command memory-cli`, and `bundle sox-memory-bundle`. (2) Edit each
> `extension.json` to exactly match `.workflow/plans/sox-memory/design.md` §1.1 (behavioral
> extensions: include `runtime:"node"`; `memory-server` includes the `lifecycle` block from §1.1a) and
> §1.2 (the `sox-memory-bundle` `members` array of the four ids — **no `entrypoint` on the bundle**).
> Keep every `version` at `0.1.0` and **synced to its package.json**. (3) For each behavioral
> extension write a minimal stub entrypoint (`memory-flush/src/index.ts` must
> `export const events = ["SessionEnd","ScopePromotionProposed"]` + a stub `handler`). (4) Create a
> project-scope `.extensions/extensions.json` whose `install[]` is the **single** entry
> `{ "id":"sox-memory-bundle", "version":"^0.1.0" }` plus the `config{}` block from §1.2. (5) Run
> `pnpm changeset` for the initial 0.1.0 set. Do NOT implement any memory logic — stubs only.
>
> Skills/tools you need: pnpm, tsx, Node, JSON/JSONC editing, reading JSON-Schema.
> Files to read first: `.workflow/plans/sox-memory/design.md` §1.1–§1.3; `schemas/extension/v1.json`;
> `scripts/new-extension.ts`, `scripts/install.ts`, `scripts/validate-manifests.ts`,
> `scripts/build-index.ts`; the example `extensions/bundles/sox-memory-bundle/` if it already exists.
> Success criteria: the Phase 0 acceptance check above exits 0 — the bundle expands post-cascade into
> exactly the four members in `.extensions/extensions.lock`.
> Hard constraints: do NOT hand-roll a `bundle.fragment.json` or any `memory bundle --print` helper
> (v1 workarounds — forbidden; use the native `bundle` type). Do NOT add an `entrypoint` to the bundle.
> Do NOT re-list bundle members in the consumer `install[]` (the single bundle id must expand). Do NOT
> modify `cascade.ts`, `install.ts`, or any schema — they are fixed v2 contract.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/sox-memory/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P0 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`.

---

## Phase 1 — MVP: single-project store + hybrid recall <50 ms (one `.db`)

**Phase ID:** P1
**Phase goal:** the smallest end-to-end useful system — `memory init` makes one project `.db`;
`memory_write` ingests; `memory_recall` returns hybrid (vec+BM25+graph depth-1) results <50 ms at 10K
rows. In-process write, no daemon, no LLM (importance defaults 1.0; deterministic NER only).
**Inputs:** P0 outputs (green); `design.md` §2.2 (schema minus `promotion_queue` for now), §2.3
(tools 1–2), §3 (MVP subset ≈520 LOC).
**Outputs:** `memory-server/src` schema/migrations/pragmas, `sqlite-vec` + FTS5 wiring, embedding
wrapper, `memory_write` + `memory_recall`; `memory-cli init`; `tools/seed.js`, `tools/bench-recall.js`.
**Verification:** acceptance check exits 0 (p95 < 50 ms AND zero provider calls AND top-1 ≥ 0.9).

**Acceptance check**
```bash
cd "$ROOT"
pnpm tsx scripts/validate-manifests.ts                              # P0 guard still green
node dist/memory-cli init --scope project --path ./.tmp-mvp         # creates .memory/project.db
node tools/seed.js ./.tmp-mvp/.memory/project.db 10000              # deterministic 10k fixture
node tools/bench-recall.js ./.tmp-mvp/.memory/project.db --n 200    # 200 queries
  # asserts: p95 latency < 50ms  AND  provider_call_count == 0  AND  top-1 hit-rate ≥ 0.9 → exit 0
```
**Green =** invariants **R1** (<50 ms, zero LLM read) + **R2** (one `.db`, idempotent init) hold.

**Phase prompt:**

> You are a TypeScript systems engineer in the `sox-ecosystem` monorepo (`$ROOT =
> /Users/nix/dev/ai/sox-ecosystem`). The memory tenant's five extensions are already scaffolded and
> install as a bundle (Phase 0). You are building the MVP read/write core inside `memory-server`.
>
> Your task: implement, in `extensions/mcp-servers/memory-server/src`, (1) the SQLite schema from
> `.workflow/plans/sox-memory/design.md` §2.2 **minus** the `promotion_queue` table (deferred to P4),
> with the exact pragmas, `node`/`edge` tables, `vec_node` (sqlite-vec, dim from `memory_scope`), and
> `fts_node` (FTS5); load `better-sqlite3` + `sqlite-vec`; add a local embedding wrapper
> (`fastembed`/onnxruntime, nomic-embed-768). (2) `memory_write` — synchronous insert + embed + FTS
> index + SHA-256 dedup, returning `{episode_uid}`. (3) `memory_recall` — the deterministic hot path
> from §2.3: query-embed → parallel {vec0 KNN, FTS5 BM25, temporal} → graph depth-1 → RRF (k=60) →
> recency×importance rerank → assemble within `token_budget`. (4) In `memory-cli`,
> `memory init --scope project` creating `.memory/project.db` with the full schema and a pinned embed
> model. Also write `tools/seed.js` (deterministic 10k fixture) and `tools/bench-recall.js` (200
> queries; asserts p95<50ms, provider-call-count==0, top-1≥0.9).
>
> Skills/tools you need: TypeScript, `better-sqlite3`, `sqlite-vec`, SQLite FTS5, `fastembed`/
> `onnxruntime-node`, the MCP TS SDK stdio JSON-RPC pattern (`tools/list`+`tools/call`).
> Files to read first: `design.md` §2.2, §2.3 (tools 1–2), §3; the existing `hello-server` example for
> the stdio JSON-RPC contract; the `memory-server` manifest from P0.
> Success criteria: the Phase 1 acceptance check exits 0.
> Hard constraints: ZERO provider/LLM calls on the read path (a read-path provider-call counter MUST
> remain 0 — invariant R1). One `.db` per scope; `memory init` idempotent; embed model pinned (R2). Do
> NOT add the daemon or organizer yet (those are P2). Do not modify ecosystem `scripts/` or schemas.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/sox-memory/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P1 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`.

---

## Phase 2 — Daemon (host-SUPERVISED via `lifecycle`) + organizer + bi-temporal writes

**Phase ID:** P2
**Phase goal:** writes move behind `memoryd`; the daemon is **host-supervised** through the
`memory-server` `lifecycle` block (no self-managed lock, no lazy-spawn); episodic extraction runs as
batched LLM via `memory-organizer`; bi-temporal invalidation works; `memory_invalidate` +
`memory-flush` SessionEnd handler live.
**Inputs:** P1 (green); `design.md` §2.4 (host-supervised daemon), §2.5 (flush hook), §1.1a
(`lifecycle` block); `../sox-ecosystem/architecture-v2.md` §G-A (supervision/singleton/health
contract).
**Outputs:** `memoryd` internals (loop, hybrid IPC, scheduler, decay/reindex) **without** self-lock /
lazy-spawn supervision; `memory-organizer` batched provider calls; `memory_write` → enqueue+nudge;
`memory_invalidate`; `memory-flush` SessionEnd handler; `tools/test-organize.js`,
`tools/test-daemon-crash.js`, and a thin **CI supervisor shim** that exercises the `lifecycle` contract
(start/stop/health/singleton) locally.
**Verification:** acceptance check exits 0.

**Acceptance check**
```bash
cd "$ROOT"
node dist/memory-cli init --scope project --path ./.tmp-p2        # P1 guard
node tools/test-organize.js
  # asserts: (a) ONLY the organizer made provider calls (read-path counter still 0)
  #          (b) old claim has t_invalid set, both rows present (no delete)
  #          (c) memory_recall returns new claim; memory_recall{as_of:past} returns old claim
node tools/test-daemon-crash.js   # SIGKILL the supervised daemon mid-batch; host restarts it
  # asserts: (a) queue resumes from MAX(seq WHERE done_at IS NULL); no lost/dup writes
  #          (b) the HOST (shim) re-established the singleton — no second memoryd, no OS lock file
  #          (c) no ~/.memory/memoryd.lock advisory-lock file is ever created → exit 0
```
**Green =** invariants **R3** (LLM only in organizer) + **R5** (bi-temporal) + **R6** (host-supervised
`lifecycle`, no OS advisory lock).

**Phase prompt:**

> You are a Node concurrency/systems engineer in the `sox-ecosystem` monorepo (`$ROOT =
> /Users/nix/dev/ai/sox-ecosystem`). The memory MVP (single `.db`, hybrid recall, in-process write) is
> done (Phase 1). You are moving writes behind a daemon and adding the LLM organize step — but the
> daemon's **lifecycle is owned by the host**, not self-managed.
>
> Context you need cold: sox-ecosystem v2 added a `lifecycle` manifest block
> (`.workflow/plans/sox-ecosystem/architecture-v2.md` §G-A). `memory-server`'s manifest declares
> `lifecycle:{background:true, singleton:true, health:{type:socket, endpoint:~/.memory/memoryd.sock,…},
> stop_timeout_ms:5000}`. This means the **host** spawns the writer once, keeps it supervised, holds
> the per-(id,scope) singleton lock, and probes health. The v1 design self-managed an OS advisory lock
> at `~/.memory/memoryd.lock` and lazy-spawned the daemon — **both are deleted**; do not reintroduce
> them. Per §G-A the host supervisor is a contract, not a shipped script, so you also write a thin CI
> shim that performs start/stop/health/singleton to exercise the contract in tests.
>
> Your task: (1) Implement `memoryd` **internals** per `.workflow/plans/sox-memory/design.md` §2.4:
> the durable `organizer_queue` drain (resume from `MAX(seq WHERE done_at IS NULL)`), the hybrid IPC
> (authoritative table + Unix-socket doorbell at `~/.memory/memoryd.sock`, 1000ms fallback poll), the
> 7-step deterministic-first loop, priority queue, decay/reindex — but **omit** any self-lock or
> lazy-spawn/self-restart code (the host owns that). (2) Make the doorbell socket double as the
> `lifecycle.health` socket endpoint. (3) Implement `memory-organizer`: batched provider calls
> (structured_output) for relation triples + importance(1–10) + contradiction + reflection
> (Σimportance≥150); entity link 0.95/0.7–0.95 bands. (4) Change `memory_write` to enqueue+nudge (no
> longer synchronous LLM). Implement `memory_invalidate` (closes `t_invalid`, writes `SUPERSEDES`).
> (5) `memory-flush` SessionEnd handler: persist session state, enqueue episodes, nudge. (6) Write the
> CI supervisor shim + `tools/test-organize.js` and `tools/test-daemon-crash.js`.
>
> Skills/tools you need: `node:net` (Unix sockets), process signals (SIGTERM/SIGKILL), SQLite WAL,
> the ecosystem provider abstraction (TS), structured-output prompting.
> Files to read first: `design.md` §2.4, §2.5, §1.1a; `architecture-v2.md` §G-A
> (supervision/singleton/health/stop contract).
> Success criteria: the Phase 2 acceptance check exits 0.
> Hard constraints: NO OS advisory lock file (`~/.memory/memoryd.lock`) may ever be created — the host
> shim holds the singleton (R6). NO lazy-spawn / self-restart in the daemon. EVERY LLM/provider call
> must originate in `memory-organizer` (R3); the read path's provider-call counter stays 0. Never
> delete a superseded row — invalidate via `t_invalid` (R5). Do not modify ecosystem `scripts/` or
> schemas.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/sox-memory/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P2 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`.

---

## Phase 3 — Multi-scope stores + cross-scope RRF federation

**Phase ID:** P3
**Phase goal:** user + org stores; `memory_recall` federates with scope-weighted RRF union; `agent_id`
boost; cross-store content-hash dedup; org store resolved from the `extends` baseline.
**Inputs:** P2 (green); `design.md` §2.1 (scope map; agent_id-not-a-5th-scope), §2.7 (federation).
**Outputs:** `memory init --scope user|org`; `~/.memory/registry.json`; discovery walk; parallel WAL
fan-out federation with scope-weighted RRF; `tools/test-federation.js`.
**Verification:** acceptance check exits 0.

**Acceptance check**
```bash
cd "$ROOT"
node tools/test-federation.js   # seeds project+user+org with overlapping + scope-unique facts
  # asserts: (a) all scopes surface (union, not override)
  #          (b) project dup outranks user/org dup; agent_id match boosted ×1.25
  #          (c) supersede edge suppresses targeted broader-scope node
  #          (d) p95 federated recall (3 stores × 50k) < 50ms, zero LLM   → exit 0
```
**Green =** scope model conforms to the ecosystem (org/user/project/local), no 5th scope invented; the
"agent" dimension is an in-store `agent_id` filter (per `docs/scope-promotion.md` rule).

**Phase prompt:**

> You are a TypeScript retrieval engineer in the `sox-ecosystem` monorepo (`$ROOT =
> /Users/nix/dev/ai/sox-ecosystem`). The single-scope memory daemon + organizer are done (Phase 2).
> You are adding multi-scope stores and cross-scope federated recall.
>
> Context: the ecosystem has exactly four install scopes — `org/user/project/local`. The memory
> research's "agent" scope is **NOT** a 5th scope; it is an in-store `agent_id` partition (a
> filter/boost), and v2 states this as an ecosystem rule (`docs/scope-promotion.md`; reflected in
> `.workflow/plans/sox-memory/design.md` §2.1). Do not invent a 5th scope.
>
> Your task: (1) Extend `memory-cli` with `memory init --scope user|org`, write/maintain
> `~/.memory/registry.json`, and a discovery walk (cwd→home collecting `.memory/*.db`) intersected with
> the scopes the host has installed+enabled. (2) Resolve the org store from the `extends` baseline.
> (3) Implement federation in `memory-server` per `design.md` §2.7: parallel WAL fan-out, per-store
> hybrid pipeline, scope-weighted RRF union (`score = scope_weight · Σ 1/(k+rank)`, k=60, weights
> project 1.0 / user 0.6 / org 0.4), `agent_id` match ×1.25 boost, cross-store content-hash dedup,
> `SUPERSEDES`→`SAME_AS` override exception, graph expansion project-store-only. (4) Write
> `tools/test-federation.js`.
>
> Skills/tools you need: SQLite WAL read-only connections, parallel async fan-out, RRF, ULID/content
> hashing.
> Files to read first: `design.md` §2.1, §2.7; `docs/scope-promotion.md` (per-identity rule).
> Success criteria: the Phase 3 acceptance check exits 0 — all scopes surface as a union, project
> outranks, agent boost applies, supersede suppresses, p95<50ms over 3×50k, zero LLM.
> Hard constraints: do NOT create a 5th scope; `agent_id` is a filter within a scope. Federated recall
> stays zero-LLM and under 50 ms (R1). Reads are read-only WAL; the daemon remains sole writer. Do not
> modify ecosystem `scripts/` or schemas.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/sox-memory/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P3 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`.

---

## Phase 4 — Scope promotion (host `ScopePromotionProposed`) + graphify import + communities

**Phase ID:** P4
**Phase goal:** the `promotion_queue` candidate log + `proposePromotion(...)` → host
`ScopePromotionProposed` → `memory-flush`-bound approval (to-scope owner via `memory promote`);
version-defensive graphify import; community detection + `memory_get_community` +
`memory_search_entities`.
**Inputs:** P3 (green); `design.md` §2.5 (promotion via native event), §2.2 (`promotion_queue`), §4
(G4 graphify, G5 communities); `docs/scope-promotion.md` (`ScopePromotionProposed`, `proposePromotion`,
`config.promotion`, approval-locus, per-identity rule).
**Outputs:** `promotion_queue` table + daemon candidate detection (3/60 policy from `config.promotion`)
+ `proposePromotion(...)` call; `memory-flush` `ScopePromotionProposed` binding + approval step;
`memory promote` review UX (incl. a `config.promotion` validation step); `memory import --graphify`
with `SUPPORTED_GRAPHIFY_SHAPES`; Leiden/label-prop communities + LLM summary + 2 tools;
`tools/test-promotion.js`, `tools/test-graphify.js`, `tools/test-communities.js`.
**Verification:** acceptance check exits 0.

**Acceptance check**
```bash
cd "$ROOT"
node tools/test-promotion.js
  # asserts: (a) 3 sightings over simulated 60d → promotion_queue candidate, status='proposed'
  #          (b) the daemon called the host proposePromotion(...) → ScopePromotionProposed fired
  #          (c) memory-flush's bound handler ran; to-scope-owner approve → applied to user scope; reject → no-op
  #          (d) NO bespoke notification path exists outside the host event   → exit 0
node tools/test-graphify.js     # good fixture loads; mutated-schema fixture refuses (non-zero, no partial write)
node tools/test-communities.js  # entity→community resolves; get_community returns summary  → exit 0
```
**Green =** promotion flows through the native `ScopePromotionProposed` event (G-C resolved, not
bespoke); graphify is version-defensive (G4); communities + 2 tools live (G5).

**Phase prompt:**

> You are a TypeScript engineer in the `sox-ecosystem` monorepo (`$ROOT =
> /Users/nix/dev/ai/sox-ecosystem`). Multi-scope federated memory is done (Phase 3). You are adding
> scope promotion, graphify import, and communities — and promotion must use the ecosystem's **native**
> primitive, not a bespoke mechanism.
>
> Context you need cold: sox-ecosystem v2 provides a generic host lifecycle event
> **`ScopePromotionProposed`** and a host API **`proposePromotion(from_scope, to_scope, items)`**, plus
> a documented **`config.promotion`** convention and an approval-locus rule (the **to-scope owner**
> approves; project→user needs the user owner). See `docs/scope-promotion.md` and
> `.workflow/plans/sox-memory/design.md` §2.5. The tenant keeps the `promotion_queue` table and the
> `memory promote` UX **internal**, but the signalling is the host event — do NOT invent a private
> notification path.
>
> Your task: (1) Add the `promotion_queue` table (`design.md` §2.2, with the `'proposed'` status) and
> daemon candidate detection driven by `config.promotion` (`min_occurrences:3`, `min_age_days:60`,
> tunable). (2) When a candidate qualifies, call the host `proposePromotion(...)` and set
> `status='proposed'`. (3) Bind `ScopePromotionProposed` in `memory-flush` to run the approval step;
> implement `memory promote` (interactive approve/reject by the to-scope owner, plus org-baseline
> `auto_approve` path) and a `config.promotion` validation step (catch typos at promote time). On
> approval, copy the node to the wider scope's `.db` with the right `SUPERSEDES`/`SAME_AS` edge,
> obeying scope-RO rules; set `status='applied'`. (4) `memory import --graphify`: version-defensive
> bridge per §4/G4 — shape fingerprint, `SUPPORTED_GRAPHIFY_SHAPES` guard, fail-loud on unknown fields,
> a fixture per supported shape. (5) Deterministic Leiden/label-prop community build + LLM summary (in
> the organizer) + `memory_get_community` and `memory_search_entities` tools. (6) Write the three test
> tools.
>
> Skills/tools you need: host hook-event binding, community detection (Leiden/label-prop), the
> organizer's provider abstraction for summaries, defensive JSON parsing.
> Files to read first: `design.md` §2.5, §2.2, §4; `docs/scope-promotion.md`.
> Success criteria: the Phase 4 acceptance check exits 0.
> Hard constraints: promotion signalling MUST go through `proposePromotion(...)` →
> `ScopePromotionProposed`; NO bespoke notification path may exist outside the host event. Graphify
> NEVER partial-imports on an unknown shape — fail loud, non-zero, no partial write. Community summary
> LLM calls live in the organizer only (R3). Do not modify ecosystem `scripts/` or schemas.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/sox-memory/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P4 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`.

---

## Phase 5 — Conformance hardening, publish, scale-switch criterion

**Phase ID:** P5
**Phase goal:** full `validate-manifests` (incl. v2 bundle/lifecycle/runtime/requires-advisory) +
provider-capability checks under `strict_capabilities`; Changesets publish 0.1.0; the libSQL DiskANN
switch criterion wired as `config.db_engine` + a load test that proves the trigger.
**Inputs:** P0–P4 (all green); `design.md` §4 (G1 scale), §6 (R1–R6); `../sox-ecosystem/
architecture-v2.md` §10 (the v2 checks the tenant must pass).
**Outputs:** full regression pass; `strict_capabilities` hard-block test; `config.db_engine` switch +
`tools/bench-scale.js`; a publishable Changesets release (dry-run in CI).
**Verification:** acceptance check exits 0; on success **set `state: complete`**.

**Acceptance check**
```bash
cd "$ROOT"
pnpm tsx scripts/validate-manifests.ts                                   # incl. v2 checks, exit 0
node tools/test-strict-caps.js                                           # strict_capabilities hard-block asserted
node tools/bench-scale.js --to 60000                                     # asserts switch-advisory fires at p95>35ms; post-switch p95<50ms
pnpm changeset status --since=main && pnpm -r build                      # publishable, package.json-synced
```
**Green =** invariant **R4** (ships via ecosystem install/lockfile/Changesets; bundle expands; v2
manifest checks pass) + **G1** scale trigger proven. **state → complete.**

**Phase prompt:**

> You are a release/conformance engineer in the `sox-ecosystem` monorepo (`$ROOT =
> /Users/nix/dev/ai/sox-ecosystem`). All memory behavior (P0–P4) is built. You are hardening
> conformance, proving the scale-switch criterion, and shipping 0.1.0. This is the FINAL phase.
>
> Your task: (1) Re-run every prior acceptance check (full regression / resumability proof). (2) Add
> `tools/test-strict-caps.js`: install under `strict_capabilities:true` against a capability-insufficient
> provider and assert a hard-block; against the default provider assert pass. (3) Wire the
> `config.db_engine` switch (`sqlite-vec` ↔ libSQL DiskANN) per `.workflow/plans/sox-memory/design.md`
> §4/G1, and write `tools/bench-scale.js` that loads a store past 50,000 rows and asserts the
> engine-switch advisory fires at p95>35ms with post-switch p95<50ms; document the libSQL migration
> path. (4) Confirm `validate-manifests.ts` passes including the v2 bundle/lifecycle/runtime checks and
> the G-E requires advisory (it should NOT error). (5) `pnpm changeset version && publish` as a CI
> dry-run; verify lockfile checksums and package.json version sync.
>
> Skills/tools you need: pnpm, Changesets, the ecosystem `install.ts`/`provider-capabilities.ts`
> contract, SQLite/libSQL, load testing.
> Files to read first: `design.md` §4 (G1), §6 (R1–R6); `architecture-v2.md` §10; `scripts/install.ts`,
> `scripts/provider-capabilities.ts`, `scripts/validate-manifests.ts`.
> Success criteria: the Phase 5 acceptance check exits 0.
> Hard constraints: ship ONLY via the ecosystem install client + lockfile + Changesets (R4) — no
> parallel packaging. The `sox-memory-bundle` must still expand to four members. Do not modify
> ecosystem `scripts/` or schemas. This is the final phase: set `state: complete` (NOT `executing`).
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/sox-memory/status.md` under `## State transitions`:
> `<ISO timestamp> complete — phase P5 complete (executor: <your role>)`
> Update frontmatter: `state: complete`, `last_event: <ISO timestamp>`. *(Final phase: `complete`,
> not `executing`.)*

---

## Resumability & ownership

- **File ownership:** `memory-server/**` owns schema, recall, daemon internals, federation;
  `memory-organizer/**` owns the LLM step; `memory-flush/**` the hooks (SessionEnd +
  ScopePromotionProposed); `memory-cli/**` the CLI + import + promote;
  `extensions/bundles/sox-memory-bundle/**` is manifest-only. No file is written by two extensions.
- **Resume guard:** each phase's first action re-runs the prior phase's acceptance check; on red, the
  executor repairs forward (never silently skips).
- **What v2 removed from the build:** the `bundle.fragment.json` + `memory bundle --print` helper (P0),
  the OS advisory-lock singleton + lazy-spawn supervision (P2), and bespoke promotion signalling (P4).
  These are now ecosystem primitives — do not reintroduce them.
- **Residuals (not workarounds):** (a) the host supervisor is a contract, not a shipped script
  (`architecture-v2.md` §G-A) → a thin CI supervisor shim in P2; (b) `config.promotion` is convention,
  not schema-validated (`architecture-v2.md` §G-C) → a validation step in `memory promote` (P4).
- **Deferred / out of scope for 0.1.0:** libSQL migration *execution* (criterion wired, switch is a
  follow-on), DuckDB analytics, hypergraph edges, RL/agent retrieval operators. Logged, not dropped.

---

## Changelog

- **2026-06-07** — v2 re-plan. Rewrote P0 (native `bundle` type replaces fragment+helper, −40 LOC),
  P2 (`lifecycle{}` host supervision replaces OS-lock+lazy-spawn, −80 LOC), P4 (host
  `ScopePromotionProposed` event replaces bespoke signalling, −40 LOC). New total ≈1,620 LOC vs v1
  ≈1,780 (−160, −9%). Phase count unchanged at 6. Added standalone executor prompts + mandatory
  status-update steps to every phase. Prior plan preserved at `migration.v1.md`.
