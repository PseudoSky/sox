# sox-memory — Agent Graph Memory as the First Ecosystem Tenant (v2: native primitives)

**Status:** design locked · **Date:** 2026-06-07 (v2 re-plan) · **Parent:** [`sox-ecosystem`](../sox-ecosystem/architecture-v2.md)
**Scope:** the inaugural workload that proves the ecosystem primitives. Packaged, scoped, versioned,
and installed **entirely** through the ecosystem contract. No parallel models, **no workarounds** —
the five gaps this tenant surfaced (G-A..G-E) are now BUILT in sox-ecosystem v2 and this design
consumes the native primitive for each.

This document is the architecture (Deliverables 1–3 + Gap Report). The phased, resumable build plan
(Deliverable 4) is in [`migration.md`](./migration.md). The prior workaround-based version is preserved
verbatim at [`design.v1.md`](./design.v1.md) — do not edit that file.

---

## Delta from v1 (workaround → native)

sox-ecosystem v2 (`../sox-ecosystem/architecture-v2.md`, **§10 conformance: COMPLETE, 131 tests,
0 failures**) closed every gap v1 worked around. The five swaps:

| # | Gap | v1 workaround (now deleted) | v2 native primitive (now used) | Source on disk |
|---|---|---|---|---|
| 1 | **G-B bundle** | hand-rolled `bundle.fragment.json` + `memory bundle --print` helper; 4-member re-listing | a real **`bundle`-type extension** `sox-memory-bundle` with `members:[…4]`; install expands post-cascade, one atomic line, one version | `architecture-v2.md` §G-B + §10; `schemas/extension/v1.json` (`bundle` in enum, `members`); `scripts/install.ts` post-cascade expansion |
| 2 | **G-A lifecycle** | lazy-spawned `memoryd` + self-managed OS advisory lock at `~/.memory/memoryd.lock` | **`lifecycle:{ background:true, singleton:true, health:{…}, stop_timeout_ms }`** on `memory-server`; **host** owns start/stop/health/singleton | `architecture-v2.md` §G-A + §10; `schemas/extension/v1.json` (`lifecycle` block); host supervisor sub-contract |
| 3 | **G-C promotion** | fully bespoke `promotion_queue` + `memory promote` + ad-hoc approver | keep `promotion_queue` as an **internal** detail BUT wire approvals to the host **`ScopePromotionProposed`** event + **`config.promotion`** convention; adopt per-identity-not-a-5th-scope rule | `architecture-v2.md` §G-C; `docs/scope-promotion.md` |
| 4 | **G-D runtime** | Python→Node port carried as a *risk/surprise* | declare **`runtime:"node"`** on provider-touching extensions; the port is now a **stated contract**, lint-enforced | `architecture-v2.md` §G-D + §10; `schemas/extension/v1.json` (`runtime`); `scripts/validate-manifests.ts` |
| 5 | **G-E requires** | redundant double-declaration of `requires` on server + organizer, flagged as "slightly redundant" | keep **per-extension `requires`** (each is standalone-installable); drop the *intent* to dedupe — rely on the v2 **advisory `warn`** | `architecture-v2.md` §G-E + §10; `scripts/validate-manifests.ts` advisory |

**Net LOC effect.** v1 memory build ≈ **1,780 LOC** (§3). The native swaps remove
self-managed daemon supervision/advisory-lock/lazy-spawn (~80, §2.4), the bundle helper + fragment
assembly (~40, §1.2), and bespoke promotion approver plumbing (~40, §2.5) while adding only manifest
declarations (`bundle` members ~5, `lifecycle`/`runtime` fields ~0 code). **New total ≈ 1,620 LOC**
(≈ **−160**, ≈ −9%). The reduction is real but modest: the heavy lifting (recall pipeline, organizer
LLM step, federation, schema) is unchanged because those were never workarounds.

**Still needs a tenant-side mechanism (v2 did NOT fully cover):**
- **G-C policy/queue body.** v2 gives the *event + convention*, not the queue. sox-memory still owns
  the `promotion_queue` table, the 3-occurrence/60-day candidate detection, and the `memory promote`
  review UX — it now *fires* `proposePromotion(...)` and *binds* a hook instead of inventing the
  signalling. `config.promotion` is **convention, not schema-validated** (`architecture-v2.md` §G-C
  trade-off), so a typo is caught at `memory promote` time, not install.
- **Host supervisor is a contract, not a built script.** `architecture-v2.md` §G-A states the
  supervisor sub-contract (start/stop/health/singleton) but notes *"no `scripts/host*.ts` exists on
  disk"* — the loader is a host responsibility. `Conjecture:` until a host runtime ships the
  supervisor, sox-memory in a CI/dev harness may still need a thin shim to exercise `lifecycle`
  semantics; this is test scaffolding, not a product workaround. Flagged in P2.

---

## 0. The contract this tenant conforms to (read-only inputs, treated as FIXED)

From `schemas/extension/v1.json` (v2: **7 types incl. `bundle`**, plus `lifecycle`, `runtime`,
`members` fields), `schemas/extensions-config/v1.json`, `schemas/lockfile/v1.json`,
`scripts/{cascade,install,provider-capabilities,validate-manifests,new-extension,build-index}.ts`,
`docs/scope-promotion.md`, `registry/index.json`, `.changeset/`, `assets/model_capabilities.json`,
and the v2 design `../sox-ecosystem/architecture-v2.md`:

| Primitive | Contract (verbatim, not redesigned) |
|---|---|
| Extension types | `agent · skill · mcp-server · prompt · hook · command · bundle` (closed enum, v2 6→7; `architecture-v2.md` §G-B) |
| Manifest required | `$schema, id, version, type, title, description, compatibility.host, license`; `entrypoint` required for all behavioral types (everything except `prompt` and `bundle`) |
| `id` | `^[a-z][a-z0-9-]*$`, immutable, primary registry key, **must not end in `-<type>`** |
| `version` | semver, **MUST equal package.json** (CI-enforced), Changesets-driven |
| `lifecycle` (v2) | optional `{background, singleton, health{type,endpoint,interval_ms,timeout_ms}, stop_timeout_ms}`; only for `type ∈ {mcp-server, agent}`; host owns supervision (`architecture-v2.md` §G-A) |
| `runtime` (v2) | optional `enum: node\|stdio-any`, default `node`; `stdio-any` MUST NOT declare provider `requires` (`architecture-v2.md` §G-D) |
| `members` (v2) | required iff `type=="bundle"`; `[{id, version}]`; bundle forbids `entrypoint` (`architecture-v2.md` §G-B) |
| Capability decl | `requires:{tool_calling?, structured_output?, min_context_tokens?}` — checked at install against the configured provider; per-extension, v2 emits a `warn` on redundant double-declare (`architecture-v2.md` §G-E) |
| Scope cascade | **four** scopes, widest→narrowest: `org → user → project → local`. Objects deep-merge; **arrays replace (not concat)**; `enabled:false` at narrower scope force-suppresses. **Bundle expansion runs post-cascade** in `install.ts` (`architecture-v2.md` §G-B) |
| Provider abstraction | `providers.<name>.{base_url, api_key}`; `api_key` is `${ENV}` or `ollama` only; resolved by `provider-capabilities.ts` → `{ok, warnings}`; `strict_capabilities` flips warn→hard-block |
| Install/lock | flat `install[]` per scope; lockfile keys `<id>@<semver>` → `{source, checksum(sha256), resolved_at}`; bundle id resolves to its members; `extends` org baseline pinned `{url, sha256, resolved_at}` |
| Scope-promotion (v2) | generic host event **`ScopePromotionProposed`** + `proposePromotion(from,to,items)` host API + `config.promotion` convention + approval-locus rule + per-identity-not-a-5th-scope rule (`docs/scope-promotion.md`) |
| CI invariants | immutable id · type==dir · version-sync · unique id · ≤1 per id per scope · shadow-copy block · secret-in-config block · (v2) bundle/lifecycle/runtime checks in `validate-manifests.ts` |

**No contract gaps remain for this tenant.** The three v1-blocking gaps (G-A daemon lifecycle,
G-B bundle, G-C scope-promotion) and the two minor ones (G-D runtime, G-E requires) are all CLOSED —
see §8, which is now a *resolution* report, not an *open-gap* report.

---

## 1. The memory subsystem expressed as ecosystem extensions (the bundle)

The subsystem is **four behavioral extensions + one `bundle` packaging extension** + one host-supervised
binary they share. Every box below is an ecosystem primitive; nothing invents a parallel mechanism.

```
                ┌──────────── sox-memory-bundle (type: bundle, members:[4]) ────────────┐
 host           │  expands post-cascade in install.ts → the four extensions below       │
   │            ├───────────────────────────────────────────────────────────────────────┤
   │ supervises │  memory-server   (mcp-server, runtime:node, lifecycle{background,singleton,health}) │
   │ (lifecycle)│  memory-organizer (agent, runtime:node)     ← the ONLY LLM caller       │
   │            │  memory-flush     (hook, SessionEnd, order:100)                          │
   │            │  memory-cli       (command)   ← init/import/promote                       │
   │            │        │ all depend on ▼                                                 │
   │ start/stop ├──▶ memoryd (host-SUPERVISED writer, shipped inside memory-server)        │
   │ health     │        host holds the singleton lock (no more OS advisory lock)          │
   └────────────┴────────────────────────────────────────────────────────────────────────┘
        provider abstraction (ecosystem, TS)  ▲ organizer's batched LLM calls only
        ScopePromotionProposed host event     ▲ memory-cli binds for promotion approvals
        install/lockfile/registry/Changesets ── version & ship all five independently
```

### 1.1 The four behavioral extensions and their manifests

**(a) `memory-server` — `mcp-server`** (keystone; owns DB + host-supervised daemon + hot read path)
```jsonc
{
  "$schema": "https://your-registry/schemas/extension/v1.json",
  "id": "memory-server",
  "version": "0.1.0",
  "type": "mcp-server",
  "title": "Agent Memory Server",
  "description": "7 memory_* tools over a single-file SQLite graph store: hybrid recall (<50ms, zero LLM), write-enqueue, session state, communities, invalidation.",
  "compatibility": { "host": ">=1.0.0 <2.0.0" },
  "entrypoint": "dist/index.js",          // stdio JSON-RPC; tools/list + tools/call
  "license": "MIT",
  "runtime": "node",                      // v2 G-D: provider-touching ⇒ node (now a stated contract)
  "requires": { "structured_output": true, "min_context_tokens": 8192 },
  "lifecycle": {                          // v2 G-A: host owns the memoryd writer's lifetime
    "background": true,                   // keep the writer alive across calls (supervised)
    "singleton": true,                    // host holds the per-scope lock (replaces OS advisory lock)
    "health": { "type": "socket", "endpoint": "~/.memory/memoryd.sock", "interval_ms": 5000, "timeout_ms": 2000 },
    "stop_timeout_ms": 5000               // SIGTERM grace before SIGKILL
  },
  "capabilities": ["memory.read", "memory.write", "memory.session"],
  "tags": ["memory", "rag", "graph", "sqlite"]
}
```
`requires.structured_output` is declared **here** (the keystone the installer evaluates).
`lifecycle.singleton:true` means the **host** holds the per-`(id,scope)` lock — the v1 OS advisory
lock at `~/.memory/memoryd.lock` is **deleted**; the host guarantees one supervised `memoryd`
(`architecture-v2.md` §G-A "the OS-lock workaround … becomes a host guarantee"). The socket health
endpoint reuses the doorbell socket the daemon already opens (§2.4), so health probing costs nothing new.

**(b) `memory-organizer` — `agent`** (the single home of every LLM call)
```jsonc
{
  "id": "memory-organizer", "version": "0.1.0", "type": "agent",
  "title": "Memory Organizer", "entrypoint": "dist/index.js",
  "description": "Deterministic-first organize loop's LLM step: batched relation extraction, importance scoring, contradiction detection, reflection synthesis. Invoked by memoryd; never on the read path.",
  "compatibility": { "host": ">=1.0.0 <2.0.0" }, "license": "MIT",
  "runtime": "node",                      // v2 G-D: provider-touching ⇒ node
  "requires": { "structured_output": true, "min_context_tokens": 16384 },
  "dependencies": [{ "id": "memory-server", "version": "^0.1.0" }],
  "capabilities": ["memory.organize"], "tags": ["memory", "organizer"]
}
```
Keeps its own `requires` (it is independently installable and provider-calling). Because it deep-equals
neither member's block exactly (16K vs 8K ctx), the v2 G-E redundancy advisory does **not** fire here;
the double-declaration we worried about in v1 is now simply correct per-extension truth
(`architecture-v2.md` §G-E rule 1 + 3).

**(c) `memory-flush` — `hook`** (binds session-end + the promotion approval event)
```jsonc
{
  "id": "memory-flush", "version": "0.1.0", "type": "hook",
  "title": "Memory Session Flush", "entrypoint": "dist/index.js",
  "description": "On SessionEnd: persists working memory, enqueues episodes, nudges memoryd. Also binds ScopePromotionProposed to run the promotion approval/policy step.",
  "compatibility": { "host": ">=1.0.0 <2.0.0" }, "license": "MIT",
  "runtime": "node",
  "order": 100,                              // ascending; ties by id
  "dependencies": [{ "id": "memory-server", "version": "^0.1.0" }],
  "tags": ["memory", "lifecycle"]
}
// src/index.ts exports: handler(ctx); `export const events = ["SessionEnd", "ScopePromotionProposed"]`
```
`memory-flush` is deterministic (no provider) so it declares no `requires`. It now binds **two** host
events: the existing `SessionEnd`, and the v2 `ScopePromotionProposed` (`docs/scope-promotion.md`),
which is where promotion approvals are mediated (§2.5) instead of bespoke plumbing.

**(d) `memory-cli` — `command`** (deterministic; no LLM, no provider)
```jsonc
{
  "id": "memory-cli", "version": "0.1.0", "type": "command",
  "title": "Memory CLI", "entrypoint": "dist/index.js",
  "description": "memory init|import|status|list|promote — store lifecycle, graphify import, scope-promotion approval. Deterministic.",
  "compatibility": { "host": ">=1.0.0 <2.0.0" }, "license": "MIT",
  "runtime": "node",
  "dependencies": [{ "id": "memory-server", "version": "^0.1.0" }],
  "tags": ["memory", "cli"]
}
```
The v1 `memory bundle --print` helper is **removed** — bundling is now the ecosystem's job (§1.2).

### 1.2 The `bundle` extension (native — replaces the hand-rolled fragment)

The ecosystem now has a first-class **`bundle` type** (`architecture-v2.md` §G-B, §10; built in
`schemas/extension/v1.json`, `scripts/install.ts`, `scripts/validate-manifests.ts`,
`scripts/build-index.ts`; example tree `extensions/bundles/sox-memory-bundle/`). We ship one:

**`sox-memory-bundle` — `bundle`** (`extensions/bundles/sox-memory-bundle/extension.json`)
```jsonc
{
  "$schema": "https://your-registry/schemas/extension/v1.json",
  "id": "sox-memory-bundle",
  "version": "0.1.0",
  "type": "bundle",
  "title": "sox-memory (graph memory subsystem)",
  "description": "The four memory extensions as one independently-versioned product.",
  "compatibility": { "host": ">=1.0.0 <2.0.0" }, "license": "MIT",
  "members": [
    { "id": "memory-server",    "version": "^0.1.0" },
    { "id": "memory-organizer", "version": "^0.1.0" },
    { "id": "memory-flush",     "version": "^0.1.0" },
    { "id": "memory-cli",       "version": "^0.1.0" }
  ]
  // NO entrypoint (a bundle has no runtime; schema allOf forbids it); footprint = extension.json + package.json (+README)
}
```

A consumer's **project**-scope `.extensions/extensions.json` becomes **one atomic line**:
```jsonc
{
  "install": [ { "id": "sox-memory-bundle", "version": "^0.1.0" } ],
  "config": {
    "memory-server":    { "db_engine": "sqlite-vec", "recall_ceiling_ms": 50, "embed_model": "nomic-embed-text-v1.5" },
    "memory-organizer": { "batch_max": 50, "reflection_importance_trigger": 150 },
    "memory-cli":       { "promotion": { "auto_approve": false, "min_occurrences": 3, "min_age_days": 60, "approver_scope": "user" } }
  }
}
```
`install.ts` runs the org→user→project→local cascade on the **single bundle id**, then **expands it
post-cascade** (`architecture-v2.md` §G-B; `install.ts` `buildInstallList` after resolution) into the
four members, each resolved against the registry with its own sha256 lockfile entry. Consequences,
all native:
- **Atomic add, one version, one line** — the v1 array-replace re-listing pain is gone; the
  `bundle.fragment.json` and `memory bundle --print` helper are **deleted**.
- **Arrays-replace invariant untouched** (cascade sees one entry until expansion) — supply-chain
  determinism preserved (`architecture-v2.md` §G-B rationale).
- **Member override still possible**: list a member id explicitly at a narrower scope with a pinned
  version or `enabled:false`; explicit entries win over bundle-expanded ones.

`config.promotion` lives on `memory-cli` per the v2 `config.promotion` convention
(`docs/scope-promotion.md`); `approver_scope` is new vs v1 and names the to-scope owner (§2.5).

### 1.3 Declared provider/capability requirements (per-extension, v2 G-E)

Only `memory-server` (`structured_output`, 8K ctx) and `memory-organizer` (`structured_output`, 16K
ctx) declare `requires`. `memory-flush` and `memory-cli` are deterministic and declare nothing. The
**bundle declares no `requires`** (it has no runtime — `architecture-v2.md` §G-B/§G-E rule 2). At
install, `provider-capabilities.ts` checks the **union** of the installed members' `requires` (max
ctx, OR of booleans — `architecture-v2.md` §G-E rule 4) against the configured provider; mismatch
warns (default) or hard-blocks under `strict_capabilities`. We **keep** the per-extension declarations
(each member is standalone-installable); v2's redundancy advisory is a `warn`, never a blocker, and
does not fire here because the two blocks differ (8K vs 16K).

---

## 2. Concrete subsystem design

### 2.1 Stores ↔ ecosystem scopes (ONE scope model)

The research proposed four memory scopes with weights; the ecosystem's scope model is
`org → user → project → local`. We **map onto the ecosystem scopes** and do **not** invent an "agent"
scope — and v2 now **states this as an ecosystem rule** (`docs/scope-promotion.md`,
`architecture-v2.md` §G-C "per-identity (agent/user) data partitioning is a tenant concern, not an
install scope"):

| Memory store | Ecosystem scope | `.db` location | RRF weight (default, tunable) |
|---|---|---|---|
| project store | **project** | `<project-root>/.memory/project.db` | 1.0 |
| user/global store | **user** | `~/.memory/user.db` | 0.6 |
| org store | **org** | resolved from `extends` baseline → `<org-root>/.memory/org.db` | 0.4 |
| (ephemeral) | **local** | `.memory/local.db` (gitignored, optional) | 1.0, never published |

**"Agent scope" is not an install scope** — it is an in-store partition. Every node carries
`agent_id`; agent-specific recall is a **filter/boost** (`agent_boost`, default ×1.25 when `agent_id`
matches the caller), applied inside scope-weighted RRF. v2 makes this the *blessed* pattern, not a
tenant improvisation. One `.db` file per scope. Discovery walks cwd → home collecting `.memory/*.db`,
intersected with the scopes the host has actually installed/enabled.

### 2.2 SQLite schema (DDL — single file per scope)

Unchanged from v1 except in **role**: `promotion_queue` is now an **internal implementation detail**
behind the host `ScopePromotionProposed` event (§2.5), not a bespoke mechanism. Unified `node` table
with a `kind` discriminator, bi-temporal `edge` table, sqlite-vec + FTS5 virtual tables, durable
`organizer_queue`, `promotion_queue`, and `memory_scope` metadata.

```sql
-- ── pragmas (every connection) ─────────────────────────────────────────────
PRAGMA journal_mode = WAL;        PRAGMA busy_timeout = 5000;
PRAGMA synchronous  = NORMAL;     PRAGMA foreign_keys = ON;
PRAGMA cache_size   = -64000;     -- 64 MB page cache

-- ── scope metadata (one row) ───────────────────────────────────────────────
CREATE TABLE memory_scope (
  scope        TEXT PRIMARY KEY CHECK (scope IN ('project','user','org','local')),
  scope_id     TEXT NOT NULL,                       -- UUID, stable
  embed_model  TEXT NOT NULL,                       -- PINNED; re-embed on change only
  embed_dim    INTEGER NOT NULL,                    -- 768 (nomic) | 384 (MiniLM)
  schema_ver   INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL
);

-- ── nodes (Episode/Entity/Claim/Community/Session unified) ──────────────────
CREATE TABLE node (
  rowid        INTEGER PRIMARY KEY,                 -- vec0/FTS5 join key
  uid          TEXT UNIQUE NOT NULL,                -- public id (ULID)
  kind         TEXT NOT NULL CHECK (kind IN ('episode','entity','claim','community','session')),
  content      TEXT, name TEXT, summary TEXT,
  agent_id     TEXT,                                -- partition (NOT a scope)
  session_id   TEXT,
  source       TEXT CHECK (source IN ('message','tool_output','observation','document','reflection','import')),
  importance   REAL DEFAULT 1.0,                    -- 1..10, LLM-scored once at write
  confidence   REAL,                                -- claims: 0..1
  content_hash TEXT,                                -- SHA-256(normalized) — dedup
  level        INTEGER,                             -- community: 0=coarsest
  resume_state TEXT,                                -- session: JSON working memory
  t_created    TEXT NOT NULL, t_occurred TEXT,
  t_valid      TEXT,  t_invalid TEXT,               -- NULL invalid = current
  last_access  TEXT,  access_count INTEGER DEFAULT 0
);
CREATE INDEX ix_node_kind       ON node(kind);
CREATE INDEX ix_node_hash       ON node(content_hash);
CREATE INDEX ix_node_agent      ON node(agent_id);
CREATE INDEX ix_node_session    ON node(session_id);
CREATE INDEX ix_node_validity   ON node(t_invalid) WHERE t_invalid IS NULL;
CREATE INDEX ix_node_importance ON node(importance);

-- ── edges (bi-temporal: 4 timestamps; invalidate-not-delete) ────────────────
CREATE TABLE edge (
  rowid     INTEGER PRIMARY KEY,
  src       INTEGER NOT NULL REFERENCES node(rowid) ON DELETE CASCADE,
  dst       INTEGER NOT NULL REFERENCES node(rowid) ON DELETE CASCADE,
  rel       TEXT NOT NULL CHECK (rel IN
              ('MENTIONS','SUPPORTS','RELATES_TO','SUPERSEDES','DERIVED_FROM','MEMBER_OF','PART_OF','SAME_AS')),
  weight     REAL DEFAULT 1.0, confidence REAL,
  origin     TEXT CHECK (origin IN ('extracted','inferred','user_asserted')),
  t_created  TEXT NOT NULL, t_expired TEXT,
  t_valid    TEXT,          t_invalid TEXT,
  meta       TEXT
);
CREATE INDEX ix_edge_src  ON edge(src, rel) WHERE t_expired IS NULL;
CREATE INDEX ix_edge_dst  ON edge(dst, rel) WHERE t_expired IS NULL;
CREATE INDEX ix_edge_live ON edge(t_invalid) WHERE t_invalid IS NULL;

CREATE VIRTUAL TABLE vec_node USING vec0(node_id INTEGER PRIMARY KEY, embedding FLOAT[768]);
CREATE VIRTUAL TABLE fts_node USING fts5(content, name, summary,
  content='node', content_rowid='rowid', tokenize='unicode61');

-- ── durable organizer work queue (crash-safe source of truth) ───────────────
CREATE TABLE organizer_queue (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  op         TEXT NOT NULL CHECK (op IN ('ingest','extract','link','consolidate','decay','reindex')),
  payload    TEXT NOT NULL,
  priority   INTEGER NOT NULL DEFAULT 100,
  enqueued   TEXT NOT NULL, claimed_at TEXT, done_at TEXT,
  attempts   INTEGER DEFAULT 0
);
CREATE INDEX ix_q_open ON organizer_queue(done_at, priority, seq) WHERE done_at IS NULL;

-- ── scope-promotion candidates (INTERNAL detail; surfaced via the host
--    ScopePromotionProposed event — docs/scope-promotion.md, §2.5) ───────────
CREATE TABLE promotion_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  node_uid      TEXT NOT NULL, from_scope TEXT NOT NULL, to_scope TEXT NOT NULL,
  occurrences   INTEGER NOT NULL, first_seen TEXT NOT NULL, age_days INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','proposed','approved','rejected','applied')),
  decided_by    TEXT, decided_at TEXT
);
```
DDL note (changed): `promotion_queue.status` gains a `'proposed'` value marking rows for which the
daemon has fired `proposePromotion(...)` and is awaiting the host event's hook decision (§2.5).

### 2.3 The 7 MCP tool contracts

Unchanged from v1. Wire: stdio JSON-RPC (`tools/list`, `tools/call`). **Read tools make zero LLM and
zero provider calls.**

| # | Tool | Params | Returns | Errors |
|---|---|---|---|---|
| 1 | `memory_write` | `{content, session_id?, t_occurred?, agent_id?, source?, metadata?}` | `{episode_uid}` (enqueues organize; never blocks on LLM) | `E_SCOPE_RO`, `E_DEDUP`, `E_QUEUE_FULL` |
| 2 | `memory_recall` | `{query, scopes?=[project,user,org], agent_id?, filters?, as_of?, token_budget?=4000, depth?=2}` | `{results:[{uid, content, score, t_valid, scope, provenance[]}]}` | `E_NO_STORE`, `E_BAD_FILTER` |
| 3 | `memory_search_entities` | `{query, entity_type?, limit?=10}` | `{entities:[…]}` | `E_NO_STORE` |
| 4 | `memory_get_session_state` | `{session_id}` | `{state}` or `null` | `E_NOT_FOUND` |
| 5 | `memory_save_session_state` | `{session_id, state}` | `{ok:true}` | `E_SCOPE_RO`, `E_TOO_LARGE` |
| 6 | `memory_get_community` | `{entity_uid, level?=0}` | `{community:{…}}` | `E_NOT_FOUND` |
| 7 | `memory_invalidate` | `{claim_uid, reason, t_transition?, replacement_uid?}` | `{ok:true, supersedes_edge_uid?}` | `E_NOT_FOUND`, `E_SCOPE_RO` |

`memory_recall` hot path (deterministic, <50 ms): query-embed → parallel {vec0 KNN, FTS5 BM25,
temporal filter} → graph expand depth ≤2 over live edges (recursive CTE) → RRF (k=60) fuse →
recency×importance×relevance rerank (decay 0.995/h) → MMR diversity → assemble within `token_budget`.
`as_of` swaps "live edges" for a point-in-time predicate on `(t_valid ≤ as_of < t_invalid)`.

### 2.4 Daemon model (`memoryd`, host-SUPERVISED — v2 G-A native)

One **singleton** writer daemon for all stores, shipped as a binary inside `memory-server`. **The host
owns its lifecycle** via the `lifecycle` manifest block (§1.1) — this is the v2 native primitive
replacing the v1 lazy-spawn + OS advisory-lock workaround (`architecture-v2.md` §G-A):

- **Host-owned start/stop/singleton.** The host spawns `memory-server`'s entrypoint once
  (`lifecycle.background:true`), keeps it supervised, and holds the per-`(id,scope)` singleton lock
  (`lifecycle.singleton:true`). The v1 self-managed lock at `~/.memory/memoryd.lock` and the lazy
  first-launch spawn are **deleted** (~80 LOC removed). On host shutdown / `enabled:false` / version
  change, the host sends SIGTERM, waits `stop_timeout_ms` (5000), then SIGKILL.
- **Host-owned health.** The host probes `lifecycle.health` (`type:"socket"`,
  `endpoint:~/.memory/memoryd.sock`) every 5000 ms; on `timeout_ms` (2000) misses past the host's
  restart policy it restarts with backoff. Health is **advisory to the host, never on the read path**
  (`architecture-v2.md` §G-A) — `memory_recall` still opens DBs read-only WAL and the supervisor
  governs only the writer.
- **Internal design kept.** The daemon's **internals are unchanged**: it is still the **sole writer**;
  MCP servers open each `.db` read-only WAL for recall; `memory_write` = `INSERT INTO
  organizer_queue` (sub-ms under WAL) + a socket nudge.
- **IPC = hybrid (unchanged, locked):** durable `organizer_queue` table (authoritative; daemon resumes
  from `MAX(seq WHERE done_at IS NULL)`) **plus** a Unix-domain-socket doorbell at
  `~/.memory/memoryd.sock`. The same socket now doubles as the `lifecycle.health` endpoint — no extra
  FD. Wake latency ≈ 0.1 ms; durability is table-backed; fallback poll every 1000 ms.
- **Loop (deterministic-first, 7 steps):** ingest → extract → link → consolidate → decay → reindex,
  batched ≤50 nodes/cycle. Priority queue maps project→0, agent-tagged→1, user/global→2.
- **LLM step delegated to `memory-organizer`** (the agent), invoked only when a batch needs semantic
  judgment. **2–4 batched LLM calls per cycle, via the ecosystem provider abstraction — the ONLY LLM
  calls in the whole subsystem.** Off the read path.

`Conjecture:` since `architecture-v2.md` §G-A notes the host supervisor is a *contract*, not a built
`scripts/host*.ts`, a dev/CI harness may need a thin supervisor shim to exercise these `lifecycle`
semantics locally. That shim is test scaffolding (P2), not a product workaround, and disappears under
a conformant host runtime.

### 2.5 Scope promotion (v2 G-C native — internal queue, host event + convention)

The promotion *mechanism* is now the ecosystem's, the *policy/queue* stays sox-memory's
(`docs/scope-promotion.md`, `architecture-v2.md` §G-C):

1. **Candidate detection (tenant).** The daemon logs candidates to `promotion_queue` using the
   `config.promotion` policy (`min_occurrences:3`, `min_age_days:60`, tunable per scope via the
   cascade `config` block). It **never auto-mutates scope**.
2. **Propose via the host API (native).** When a candidate qualifies, the daemon calls the host's
   **`proposePromotion(from_scope, to_scope, items)`** API and marks the row `status='proposed'`.
   The host fires the generic **`ScopePromotionProposed`** lifecycle event with payload
   `{extension_id, from_scope, to_scope, items, proposed_at}`.
3. **Approve via a bound hook (native).** `memory-flush` binds `ScopePromotionProposed` (§1.1c) and
   runs the approval/policy step: it surfaces the candidate to `memory promote` (interactive
   approve/reject by the **to-scope owner** — the approval-locus rule: project→user needs the *user*
   owner; project→org needs the *org-baseline* owner) **or**, if an org `extends` baseline set
   `config.promotion.auto_approve:true`, auto-approves low-risk promotions.
4. **Apply (tenant).** On approval the tenant copies the node into the wider scope's `.db`, writing a
   `SUPERSEDES`/`SAME_AS` edge as needed, obeying scope RO rules. Row → `status='applied'`.

What changed vs v1: the **signalling** (queue → reviewer) is no longer bespoke — sox-memory binds one
*generic* event instead of inventing a private notification path, so the next tenant reuses the event
(`architecture-v2.md` §G-C). What stays sox-memory's: the `promotion_queue` table, the 3/60 detection
heuristic, and the `memory promote` review UX. `config.promotion` is **convention, not schema** — a
typo surfaces at `memory promote` time, not install (accepted trade-off, `architecture-v2.md` §G-C).

### 2.6 `memory init` / `memory import` CLI

`memory init [--scope project|user|org] [--path DIR]` → creates `.memory/`, the `.db` with full
schema, pins `embed_model`+`embed_dim`, writes `~/.memory/registry.json` entry. Default `--scope
project`, MVP target. `memory import --graphify <graph.json>` → version-defensive bridge (§4 G4).
`memory status|list` introspect; `memory promote` surfaces `ScopePromotionProposed` candidates for
to-scope-owner approval (§2.5). The v1 `memory bundle --print` helper is **removed** (§1.2).

### 2.7 Cross-scope RRF federation

Unchanged from v1. `memory_recall` fans out parallel WAL reads across installed+enabled stores,
runs each store's local hybrid pipeline, then **scope-weighted RRF union (not override)**:
`score(m) = scope_weight(m.scope) · Σ 1/(k + rank_r(m))`, k=60, weights project 1.0 / user 0.6 /
org 0.4, `agent_id` match ×1.25. Union with one override: a node carrying `SUPERSEDES`→`SAME_AS` to a
broader-scope uid suppresses that target. Content-hash dedup across stores. 3 stores × 50K ≈ 10–30 ms.
Graph expansion runs project store only.

---

## 3. Build-vs-reuse, locked & reconciled (v2: −160 LOC vs v1)

The runtime port is no longer a risk — **G-D makes Node/TS a stated contract** (`runtime:"node"` on
provider-touching extensions, lint-enforced; `architecture-v2.md` §G-D). The subsystem is implemented
in Node/TypeScript, reusing npm equivalents. The native swaps shrink three line items:

| Component | Decision | Reuse (npm) | Build LOC (TS) | Δ vs v1 |
|---|---|---|---|---|
| DB engine | reuse | `better-sqlite3` | 0 | — |
| Vector index | reuse | `sqlite-vec` | ~40 | — |
| BM25/FTS5 | reuse | SQLite FTS5 | 0 | — |
| Embedding runtime | reuse | `fastembed`/`onnxruntime-node` | ~60 | — |
| Schema + migrations + pragmas | build | — | ~120 | — |
| Hot-path recall (vec+BM25+temporal+CTE+RRF+MMR+assemble) | build | — | ~250 | — |
| MCP server (stdio JSON-RPC + 7 handlers) | reuse+build | MCP TS SDK | ~280 | — |
| Write enqueue + organizer_queue | build | — | ~70 | — |
| `memoryd` daemon (loop, socket+poll, scheduler, decay, reindex) | build | `node:net` | **~370** | **−80** (host owns supervision/lock/lazy-spawn — §2.4) |
| Organizer LLM step (extract/link/consolidate via provider) | build | ecosystem provider | ~300 | — |
| Deterministic NER + dedup (spaCy substitute) | build | `wink-nlp` | ~120 | — |
| Cross-scope federation | build | — | ~150 | — |
| `memory-cli` (init/import/status/list/promote) | build | host command + ScopePromotionProposed | **~140** | **−40** (no `bundle --print` helper; promotion signalling is the host event — §2.5) |
| Graphify import bridge (version-defensive) | reuse+build | Graphify (external) | ~120 | — |
| Config/policy loader | reuse+build | host cascade `config{}` + `config.promotion` convention | ~30 | — |
| Bundle packaging | **reuse (native bundle type)** | `scripts/install.ts` expansion | **~5** | **−40** (manifest only; was `bundle.fragment.json` + assembly) |
| **Memory build total** | | | **≈ 1,620 LOC** | **−160 (−9%)** |

**MVP subset ≈ 520 LOC** (unchanged — schema 120 + embed 60 + recall 250 [depth-1] + 2 tools 60 +
CLI-init 30); the −160 lands in P0 (bundle), P2 (daemon supervision), and P4 (promotion). This sits
**on top of** the ecosystem's reused tooling (install client incl. v2 bundle expansion, cascade,
provider-capabilities, validate-manifests incl. v2 checks, registry, Changesets), which memory
**consumes, does not rebuild**.

**Reuse verdicts:** SQLite/sqlite-vec/FTS5 = reuse. Graphify = partial reuse (static corpus YES,
episodic streaming NO; init-time import bridge only). MCP SDK, embedding runtime, NER = reuse. Daemon
internals, organizer, federation, hot path, schema = build. **Bundle/lifecycle/promotion-signalling =
now REUSED from the ecosystem (v2), not built.**

---

## 4. Open gaps — RESOLVED (decided, not deferred)

**G1 — DB at scale.** Default **sqlite-vec brute-force** per store. **Switch to libSQL DiskANN when,
per store, vector rows > 50,000 OR measured p95 recall > 35 ms** (50 ms hard ceiling, end-to-end incl.
local query embedding, zero LLM). Engine is a per-store `config.db_engine`.

**G2 — Daemon IPC.** **Hybrid: durable `organizer_queue` table (authoritative) + Unix-socket
doorbell.** Wake ≈ 0.1 ms; durability table-backed; 1000 ms fallback poll. The socket now also serves
as the `lifecycle.health` endpoint (§2.4) — no extra FD.

**G3 — Scope promotion.** Tenant policy (`config.promotion` 3-occurrence/60-day, tunable) +
`promotion_queue` candidate log, wired to the host **`ScopePromotionProposed`** event +
`proposePromotion(...)` API, approved by the **to-scope owner** via `memory promote` (or org-baseline
auto). The data-migration concept the v1 install model lacked is now a v2 ecosystem primitive (§2.5,
`docs/scope-promotion.md`).

**G4 — Graphify import bridge, version-defensive.** Treat `graph.json` as untrusted: shape fingerprint
header → validate against `SUPPORTED_GRAPHIFY_SHAPES` → defensive field access → **fail loud** on
unknown/missing fields (never silently partial-import). Conformance fixture per supported shape.
Init-time/batch only.

**G5 — Episodic extraction & the single LLM locus.** Deterministic NER (`wink-nlp`) + normalization +
SHA-256 dedup → batched LLM (ecosystem provider, structured_output) for triples + importance +
contradiction + reflection (Σimportance ≥ 150) → local embeddings (`fastembed`, nomic-768). Entity
link: exact/normalized → cosine >0.95 auto-merge → 0.7–0.95 LLM disambiguation. **Every LLM call lives
in `memory-organizer`, batched 2–4/cycle, never on read.**

---

## 5. Risks (runtime port now RESOLVED, not a surprise)

- **R-port (RESOLVED).** v1 carried "Python→Node conformance port" as a risk. v2 G-D makes Node/TS a
  **stated, lint-enforced contract** (`runtime:"node"` on provider-touching extensions;
  `architecture-v2.md` §G-D, §10). The port is budgeted up front (the ~80 LOC NER substitution,
  already in §3), not discovered late. Status: **closed**.
- **R-supervisor (residual).** `Conjecture:` the host supervisor is a contract, not a shipped script
  (`architecture-v2.md` §G-A). Until a conformant host runtime exists, lifecycle semantics are
  exercised via a CI shim (P2). Low risk; isolated to test scaffolding.
- **R-promotion-policy (residual, accepted).** `config.promotion` is convention, not schema-validated;
  a typo surfaces at `memory promote` time, not install (`architecture-v2.md` §G-C trade-off).
  Mitigated by a `memory promote` config-validation step (P4).
- **R-scale (managed).** Brute-force vec degrades past ~50K rows; the G1 switch criterion + load test
  (P5) fire the advisory before the 50 ms ceiling is breached.

---

## 6. Acceptance-relevant invariants (carried into the phase plan)

- **R1** recall p95 < 50 ms incl. query embedding, zero LLM/provider calls on read (read-path
  provider-call counter == 0).
- **R2** one `.db` file per scope; `memory init` idempotent; embed model pinned & enforced.
- **R3** every memory LLM call originates in `memory-organizer` via the ecosystem provider abstraction
  (no provider import outside organizer).
- **R4** the **`sox-memory-bundle`** installs via the ecosystem install client (post-cascade
  expansion) + lockfile only; `validate-manifests.ts` passes (incl. v2 bundle/lifecycle/runtime
  checks); versions Changesets-driven & package.json-synced.
- **R5** bi-temporal: invalidation closes prior `t_invalid`, never deletes; `as_of` reproduces history.
- **R6 (v2)** `memory-server`'s `lifecycle` block is host-supervised (singleton held by host, health
  probed); no OS advisory lock remains. Promotion flows through `ScopePromotionProposed`.

---

## 8. DELIVERABLE 5 — gaps CLOSED by sox-ecosystem v2 (native primitive per gap)

sox-memory was the **first tenant** and surfaced five gaps. **All five are now built and verified** in
sox-ecosystem v2 (`../sox-ecosystem/architecture-v2.md` **§10: COMPLETE, 131 tests, 0 failures**). This
section is the *resolution* report: what the gap was, and the native primitive sox-memory now consumes.

### Conformance — what the contract already covered cleanly ✅ (unchanged from v1)
- The four behavioral pieces map onto existing types (mcp-server, agent, hook, command).
- The provider abstraction absorbs episodic-extraction LLM calls with zero parallel config.
- Changesets + install client + lockfile + registry version and ship independently.
- Scope cascade `config{}` deep-merge homes tunable memory policy.
- CI invariants apply unchanged.

### G-A — long-running daemon lifecycle → **`lifecycle{}` block (host-supervised)**
- **Was:** `memoryd` shipped inside `memory-server`, **lazily spawned**, singleton via an **OS
  advisory lock** at `~/.memory/memoryd.lock`; the MCP server's lifetime stood in for the daemon's.
- **Now:** `memory-server` declares `lifecycle:{background:true, singleton:true, health:{type:socket,
  endpoint:~/.memory/memoryd.sock, …}, stop_timeout_ms:5000}`. The **host** owns start/stop/health and
  holds the per-`(id,scope)` singleton lock. The OS advisory lock and lazy-spawn supervision are
  **deleted** (~80 LOC). *Built in:* `schemas/extension/v1.json` (`lifecycle` block + `allOf`
  type-guard), `scripts/validate-manifests.ts` (lifecycle⇒type∈{mcp-server,agent}; socket health⇒
  endpoint). *Tests:* `P8 G-A service lifecycle block`, `G-A: mcp-server with lifecycle.background:true
  validates`. *Residual:* the host supervisor is a contract, not a shipped script — CI shim only (§2.4).
  (`architecture-v2.md` §G-A, §10.)

### G-B — bundle / meta-package → **`bundle` extension type (post-cascade expansion)**
- **Was:** a documented `bundle.fragment.json` + a `memory bundle --print` helper; flat `install[]`
  forced re-listing four members under array-replace.
- **Now:** a real **`sox-memory-bundle`** of `type:"bundle"` with `members:[…4]`; `install.ts` expands
  it **post-cascade** into four lockfile entries. Consumer install is **one atomic line, one version**;
  arrays-replace is untouched; members stay independently published and overridable. The fragment +
  helper are **deleted** (~40 LOC). *Built in:* `schemas/extension/v1.json` (`bundle` in enum +
  `members` + `allOf`), `scripts/install.ts` (expansion + cycle guard), `scripts/validate-manifests.ts`
  (bundle checks), `scripts/build-index.ts` (scans `bundles/`); example
  `extensions/bundles/sox-memory-bundle/`. *Tests:* `P9 G-B bundle expansion`, `G-B: installing
  sox-memory-bundle resolves to exactly 4 member extensions`. (`architecture-v2.md` §G-B, §10.)

### G-C — scope-promotion (content narrow→wide) → **`ScopePromotionProposed` event + `config.promotion`**
- **Was:** a fully bespoke `promotion_queue` + `memory promote` + ad-hoc approver, with no ecosystem
  acknowledgement of cross-scope data movement.
- **Now:** the cascade still ignores content movement (data-plane vs control-plane stays clean); the
  ecosystem provides a **generic host event `ScopePromotionProposed`** + a `proposePromotion(...)` API
  + a documented **`config.promotion`** convention + the **approval-locus** rule (to-scope owner) + the
  **per-identity-not-a-5th-scope** rule. sox-memory keeps `promotion_queue`/detection/UX **internal**
  and binds the generic event instead of inventing signalling (§2.5). *Built in:*
  `docs/scope-promotion.md`. *Tests:* `G-C: ScopePromotionProposed event is defined`. *Residual:*
  policy is convention, not schema-validated (accepted). (`architecture-v2.md` §G-C, §10.)

### G-D — implicit runtime-language mandate → **`runtime` field (Node-required-if-provider-touching)**
- **Was:** `entrypoint:"dist/index.js"` + TS provider layer **implicitly** mandated Node; the memory
  research assumed Python and the port was carried as a *risk/surprise*.
- **Now:** `memory-server`/`memory-organizer` declare **`runtime:"node"`**; the schema + lint enforce
  that any provider-touching extension is Node (a `stdio-any` extension may not declare provider
  `requires`). The Python→Node port is a **stated contract**, budgeted in §3, no longer a risk (§5
  R-port closed). *Built in:* `schemas/extension/v1.json` (`runtime` enum + `allOf`),
  `scripts/validate-manifests.ts` (friendly diagnostic), `scripts/new-extension.ts` (defaults
  `runtime:"node"`). *Tests:* `P7 G-D runtime-language contract`, `G-D: runtime:stdio-any + provider
  requires is rejected`. (`architecture-v2.md` §G-D, §10.)

### G-E — capability-declaration granularity → **per-extension `requires` + redundancy advisory**
- **Was:** `requires` declared on **both** `memory-server` and `memory-organizer`, flagged "slightly
  redundant"; v1 wanted guidance on whether to aggregate at a keystone.
- **Now:** the rule is **per-extension `requires`** (each member must be correct when installed
  standalone — protects independent versioning); a bundle declares none; the installer checks the
  **union**. v2 adds a `validate-manifests.ts` **advisory `warn`** when an extension's `requires`
  deep-equals a dependency's. We **keep both declarations** and drop the v1 intent to dedupe; the
  advisory does not even fire here (8K vs 16K ctx differ). *Built in:* `scripts/validate-manifests.ts`
  (advisory, severity warn). *Tests:* `P10 G-E requires-granularity advisory`, `G-E:
  requires-redundancy advisory`. (`architecture-v2.md` §G-E, §10.)

**Net:** the inaugural tenant's five friction points are all closed by **additive** v2 features
(`architecture-v2.md` §7 confirms only G-B deliberately bends an invariant — the enum 6→7 — everything
else is strictly additive). sox-memory consumes the native primitive for each, dropping ~160 LOC of
workaround. The only residuals are (a) the host supervisor being a contract not a script, and (b)
promotion policy being convention not schema — both explicitly accepted in v2's own trade-off sections.
