# sox-memory — Agent Graph Memory as the First Ecosystem Tenant

**Status:** design locked · **Date:** 2026-06-07 · **Parent:** [`sox-ecosystem`](../sox-ecosystem/migration.md)
**Scope:** the inaugural workload that proves the ecosystem primitives. Packaged, scoped, versioned,
and installed **entirely** through the ecosystem contract. No parallel models.

This document is the architecture (Deliverables 1–3 + Gap Report + open-gap resolutions).
The phased, resumable build plan (Deliverable 4) is in [`migration.md`](./migration.md).

---

## 0. The contract this tenant conforms to (read-only inputs, treated as FIXED)

From `schemas/extension/v1.json`, `schemas/extensions-config/v1.json`, `schemas/lockfile/v1.json`,
`scripts/{cascade,install,provider-capabilities,validate-manifests,new-extension}.ts`,
`registry/index.json`, `.changeset/`, `assets/model_capabilities.json`:

| Primitive | Contract (verbatim, not redesigned) |
|---|---|
| Extension types | `agent · skill · mcp-server · prompt · hook · command` (closed enum) |
| Manifest required | `$schema, id, version, type, title, description, compatibility.host, license`; `entrypoint` required for all behavioral types (everything except `prompt`) |
| `id` | `^[a-z][a-z0-9-]*$`, immutable, primary registry key, **must not end in `-<type>`** |
| `version` | semver, **MUST equal package.json** (CI-enforced), Changesets-driven |
| Capability decl | `requires:{tool_calling?, structured_output?, min_context_tokens?}` — checked at install against the configured provider |
| Scope cascade | **four** scopes, widest→narrowest: `org → user → project → local`. Objects deep-merge; **arrays replace (not concat)**; `enabled:false` at narrower scope force-suppresses |
| Provider abstraction | `providers.<name>.{base_url, api_key}`; `api_key` is `${ENV}` or `ollama` only (literal secret = lint error); user/local scope only; resolved by `provider-capabilities.ts` → `{ok, warnings}`; `strict_capabilities` flips warn→hard-block |
| Install/lock | flat `install[]` per scope; lockfile keys `<id>@<semver>` → `{source, checksum(sha256), resolved_at}`; `extends` org baseline pinned `{url, sha256, resolved_at}`, fail-closed without `--update` |
| CI invariants | immutable id · type==dir · version-sync · unique id · ≤1 per id per scope · shadow-copy block · secret-in-config block |

**Three contract gaps this tenant is the first to hit** — resolved in §8, not worked around silently:
G-A no first-class **long-running service/daemon** lifecycle; G-B no first-class **bundle/meta-package**;
G-C scope cascade has no **scope-promotion** (data migrating narrow→wide) concept.

---

## 1. The memory subsystem expressed as ecosystem extensions (the bundle)

The subsystem is **four extensions** + one host-side binary they share. Every box below is an
ecosystem primitive; nothing invents a parallel mechanism.

```
                          ┌─────────────────── the "sox-memory" bundle ───────────────────┐
 host (>=1.0.0 <2.0.0)    │                                                                │
   │                      │  memory-server      (type: mcp-server)   ← 7 memory_* tools    │
   │  spawns/loads ───────┼─▶ memory-organizer   (type: agent)        ← the ONLY LLM caller │
   │                      │  memory-flush        (type: hook, SessionEnd, order:100)        │
   │                      │  memory-cli          (type: command)      ← init/import/promote │
   │                      │        │ all depend on ▼                                        │
   │                      │  memoryd (host-side infra binary, shipped inside memory-server) │
   └──────────────────────┴────────────────────────────────────────────────────────────────┘
        provider abstraction (ecosystem)  ▲ organizer's batched LLM calls only
        install/lockfile/registry/Changesets ── version & ship all four independently
```

### 1.1 The four extensions and their manifests

All IDs obey `^[a-z][a-z0-9-]*$` and the "must not end in `-<type>`" rule (so the id is *not*
`memory-server` — that ends in a non-type but is fine; the rule only blocks `-agent/-skill/...`.
We use plain `memory-server`, `memory-organizer`, `memory-flush`, `memory-cli`).

**(a) `memory-server` — `mcp-server`** (keystone; owns DB + daemon lifecycle + hot read path)
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
  "requires": { "structured_output": true, "min_context_tokens": 8192 },
  "capabilities": ["memory.read", "memory.write", "memory.session"],
  "tags": ["memory", "rag", "graph", "sqlite"]
}
```
`requires.structured_output` is declared **here** (not on the organizer agent) because the bundle's
capability contract is what the installer checks; the daemon/organizer it spawns are the actual
callers. `tool_calling` is *not* required — extraction uses provider structured output, not tools.

**(b) `memory-organizer` — `agent`** (the single home of every LLM call)
```jsonc
{
  "id": "memory-organizer", "version": "0.1.0", "type": "agent",
  "title": "Memory Organizer", "entrypoint": "dist/index.js",
  "description": "Deterministic-first organize loop's LLM step: batched relation extraction, importance scoring, contradiction detection, reflection synthesis. Invoked by memoryd; never on the read path.",
  "compatibility": { "host": ">=1.0.0 <2.0.0" }, "license": "MIT",
  "requires": { "structured_output": true, "min_context_tokens": 16384 },
  "dependencies": [{ "id": "memory-server", "version": "^0.1.0" }],
  "capabilities": ["memory.organize"], "tags": ["memory", "organizer"]
}
```

**(c) `memory-flush` — `hook`** (binds the session-end lifecycle event)
```jsonc
{
  "id": "memory-flush", "version": "0.1.0", "type": "hook",
  "title": "Memory Session Flush", "entrypoint": "dist/index.js",
  "description": "On SessionEnd: persists working memory, enqueues the session's episodes, and nudges memoryd to consolidate.",
  "compatibility": { "host": ">=1.0.0 <2.0.0" }, "license": "MIT",
  "order": 100,                              // ascending; ties by id (Gap-2 of ecosystem)
  "dependencies": [{ "id": "memory-server", "version": "^0.1.0" }],
  "tags": ["memory", "lifecycle"]
}
// src/index.ts exports: handler(ctx), and `export const event = "SessionEnd"`
```

**(d) `memory-cli` — `command`** (deterministic; no LLM, no provider)
```jsonc
{
  "id": "memory-cli", "version": "0.1.0", "type": "command",
  "title": "Memory CLI", "entrypoint": "dist/index.js",
  "description": "memory init|import|status|list|promote — store lifecycle, graphify import, scope-promotion approval. Deterministic.",
  "compatibility": { "host": ">=1.0.0 <2.0.0" }, "license": "MIT",
  "dependencies": [{ "id": "memory-server", "version": "^0.1.0" }],
  "tags": ["memory", "cli"]
}
```

### 1.2 How they install together as a bundle

The ecosystem has **no bundle primitive** (Gap G-B). The bundle is therefore expressed as a
documented, copy-pasteable `install[]` fragment plus inter-extension `dependencies` (which the
manifest schema *does* support). The keystone is `memory-server`; the other three declare a
`^0.1.0` dependency on it. A consumer adds to their **project**-scope `.extensions/extensions.json`:

```jsonc
{
  "install": [
    { "id": "memory-server",    "version": "^0.1.0" },
    { "id": "memory-organizer", "version": "^0.1.0" },
    { "id": "memory-flush",     "version": "^0.1.0" },
    { "id": "memory-cli",       "version": "^0.1.0" }
  ],
  "config": {
    "memory-server": { "db_engine": "sqlite-vec", "recall_ceiling_ms": 50, "embed_model": "nomic-embed-text-v1.5" },
    "memory-organizer": { "batch_max": 50, "reflection_importance_trigger": 150 },
    "memory-cli": { "promotion": { "auto_approve": false, "min_occurrences": 3, "min_age_days": 60 } }
  }
}
```

Because `install[]` **arrays replace (not concat)** across scopes, an org baseline that ships the
bundle and a project that wants to *add* one extension must re-list the whole array — a real ergonomic
cost flagged in §8 (G-B). We ship `bundle.fragment.json` + a `memory-cli` helper (`memory bundle --print`)
so the fragment is never hand-assembled.

### 1.3 Declared provider/capability requirements (one place)

Only `memory-server` (`structured_output`, 8K ctx) and `memory-organizer` (`structured_output`, 16K
ctx) declare `requires`. `memory-flush` and `memory-cli` are deterministic and declare nothing. At
install, `provider-capabilities.ts` checks these against the configured provider; mismatch warns
(default) or hard-blocks under `strict_capabilities`. **No separate memory provider config exists** —
the organizer reads the ecosystem `providers.<name>` block via the host's provider resolver.

---

## 2. Concrete subsystem design

### 2.1 Stores ↔ ecosystem scopes (ONE scope model)

The research proposed **four memory scopes with weights** (project 1.0 / agent 0.8 / global 0.4 /
org 0.6). The ecosystem's scope model is `org → user → project → local`. We **map onto the
ecosystem scopes** and do **not** invent an "agent" scope:

| Memory store | Ecosystem scope | `.db` location | RRF weight (default, tunable) |
|---|---|---|---|
| project store | **project** | `<project-root>/.memory/project.db` | 1.0 |
| user/global store | **user** | `~/.memory/user.db` | 0.6 |
| org store | **org** | resolved from `extends` baseline → `<org-root>/.memory/org.db` | 0.4 |
| (ephemeral) | **local** | `.memory/local.db` (gitignored, optional) | 1.0, never published |

**"Agent scope" is not an install scope** — it is an in-store partition. Every node carries
`agent_id`; agent-specific recall is a **filter/boost** (`agent_boost`, default ×1.25 when
`agent_id` matches the caller), applied inside scope-weighted RRF. This is the single biggest scope
reconciliation and it keeps the ecosystem's one scope model intact (Gap-resolution §8 G-C-adjacent).

One `.db` file per scope. Discovery walks cwd → home collecting `.memory/*.db`, intersected with the
scopes the host has actually installed/enabled (so federation never reads a scope the cascade disabled).

### 2.2 SQLite schema (DDL — single file per scope)

Unified `node` table with a `kind` discriminator (keeps one rowid space for `vec0` + FTS5),
bi-temporal `edge` table, sqlite-vec + FTS5 virtual tables, durable `organizer_queue`,
`promotion_queue`, and `memory_scope` metadata.

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
  content      TEXT,                                -- episode/claim text
  name         TEXT,                                -- entity/community label
  summary      TEXT,                                -- entity/community LLM summary
  agent_id     TEXT,                                -- partition (NOT a scope)
  session_id   TEXT,
  source       TEXT CHECK (source IN ('message','tool_output','observation','document','reflection','import')),
  importance   REAL DEFAULT 1.0,                    -- 1..10, LLM-scored once at write
  confidence   REAL,                                -- claims: 0..1
  content_hash TEXT,                                -- SHA-256(normalized) — dedup
  level        INTEGER,                             -- community: 0=coarsest
  resume_state TEXT,                                -- session: JSON working memory
  -- bi-temporal (claims/sessions reuse; edges carry the full quad):
  t_created    TEXT NOT NULL,                       -- ingest (txn time)
  t_occurred   TEXT,                                -- event time
  t_valid      TEXT,  t_invalid TEXT,               -- validity window (NULL invalid = current)
  last_access  TEXT,  access_count INTEGER DEFAULT 0
);
CREATE INDEX ix_node_kind        ON node(kind);
CREATE INDEX ix_node_hash        ON node(content_hash);
CREATE INDEX ix_node_agent       ON node(agent_id);
CREATE INDEX ix_node_session     ON node(session_id);
CREATE INDEX ix_node_validity    ON node(t_invalid) WHERE t_invalid IS NULL;  -- "current" fast-path
CREATE INDEX ix_node_importance  ON node(importance);

-- ── edges (bi-temporal: 4 timestamps; invalidate-not-delete) ────────────────
CREATE TABLE edge (
  rowid     INTEGER PRIMARY KEY,
  src       INTEGER NOT NULL REFERENCES node(rowid) ON DELETE CASCADE,
  dst       INTEGER NOT NULL REFERENCES node(rowid) ON DELETE CASCADE,
  rel       TEXT NOT NULL CHECK (rel IN
              ('MENTIONS','SUPPORTS','RELATES_TO','SUPERSEDES','DERIVED_FROM','MEMBER_OF','PART_OF','SAME_AS')),
  weight     REAL DEFAULT 1.0, confidence REAL,
  origin     TEXT CHECK (origin IN ('extracted','inferred','user_asserted')),
  t_created  TEXT NOT NULL, t_expired TEXT,         -- transaction time (NULL expired = live row)
  t_valid    TEXT,          t_invalid TEXT,         -- event time   (NULL invalid = true now)
  meta       TEXT                                   -- JSON: sequence_num, level, centrality, reason
);
CREATE INDEX ix_edge_src  ON edge(src, rel) WHERE t_expired IS NULL;
CREATE INDEX ix_edge_dst  ON edge(dst, rel) WHERE t_expired IS NULL;
CREATE INDEX ix_edge_live ON edge(t_invalid) WHERE t_invalid IS NULL;

-- ── vector index (sqlite-vec brute-force default; dim from memory_scope) ─────
CREATE VIRTUAL TABLE vec_node USING vec0(node_id INTEGER PRIMARY KEY, embedding FLOAT[768]);

-- ── full-text (FTS5, BM25 built-in, external-content over node) ──────────────
CREATE VIRTUAL TABLE fts_node USING fts5(content, name, summary,
  content='node', content_rowid='rowid', tokenize='unicode61');

-- ── durable organizer work queue (crash-safe source of truth) ───────────────
CREATE TABLE organizer_queue (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,     -- daemon resumes from MAX(committed)
  op         TEXT NOT NULL CHECK (op IN ('ingest','extract','link','consolidate','decay','reindex')),
  payload    TEXT NOT NULL,                         -- JSON
  priority   INTEGER NOT NULL DEFAULT 100,          -- project<agent<global mapped to ints
  enqueued   TEXT NOT NULL, claimed_at TEXT, done_at TEXT,
  attempts   INTEGER DEFAULT 0
);
CREATE INDEX ix_q_open ON organizer_queue(done_at, priority, seq) WHERE done_at IS NULL;

-- ── scope-promotion candidates (manual approval; §8 G-C) ────────────────────
CREATE TABLE promotion_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  node_uid      TEXT NOT NULL, from_scope TEXT NOT NULL, to_scope TEXT NOT NULL,
  occurrences   INTEGER NOT NULL,                   -- cross-store sightings
  first_seen    TEXT NOT NULL, age_days INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','applied')),
  decided_by    TEXT, decided_at TEXT
);
```

DDL notes: (1) `vec_node` dim is fixed per file at `memory init` from the pinned embed model —
mixing models is forbidden; a model change is a planned re-embed migration. (2) The two partial
indexes on `t_invalid IS NULL` give the "current facts" hot path without scanning superseded rows.
(3) `kind`-discriminated `node` keeps one `rowid` space so vec0/FTS5 cover all node kinds with no
per-kind shadow tables.

### 2.3 The 7 MCP tool contracts

Wire: stdio JSON-RPC (`tools/list`, `tools/call`) — exactly the `hello-server` contract.
**Read tools make zero LLM and zero provider calls.** Errors use JSON-RPC error objects.

| # | Tool | Params | Returns | Errors |
|---|---|---|---|---|
| 1 | `memory_write` | `{content, session_id?, t_occurred?, agent_id?, source?, metadata?}` | `{episode_uid}` (enqueues organize; never blocks on LLM) | `E_SCOPE_RO`, `E_DEDUP` (returns existing uid), `E_QUEUE_FULL` |
| 2 | `memory_recall` | `{query, scopes?=[project,user,org], agent_id?, filters?, as_of?, token_budget?=4000, depth?=2}` | `{results:[{uid, content, score, t_valid, scope, provenance[]}]}` | `E_NO_STORE`, `E_BAD_FILTER` |
| 3 | `memory_search_entities` | `{query, entity_type?, limit?=10}` | `{entities:[{uid, name, summary, top_claims[]}]}` | `E_NO_STORE` |
| 4 | `memory_get_session_state` | `{session_id}` | `{state}` (the `resume_state` JSON) or `null` | `E_NOT_FOUND` |
| 5 | `memory_save_session_state` | `{session_id, state}` | `{ok:true}` (synchronous local write) | `E_SCOPE_RO`, `E_TOO_LARGE` |
| 6 | `memory_get_community` | `{entity_uid, level?=0}` | `{community:{uid, label, summary, level, member_count}}` | `E_NOT_FOUND` |
| 7 | `memory_invalidate` | `{claim_uid, reason, t_transition?, replacement_uid?}` | `{ok:true, supersedes_edge_uid?}` | `E_NOT_FOUND`, `E_SCOPE_RO` |

`memory_recall` hot path (deterministic, target <50 ms): query-embed (local model ~8 ms) →
parallel {vec0 KNN, FTS5 BM25, temporal filter} → graph expand depth ≤2 over **live edges only**
(recursive CTE) → **RRF (k=60)** fuse → recency×importance×relevance rerank (decay 0.995/h, equal
weights, tunable) → MMR diversity → assemble within `token_budget`. `as_of` swaps "live edges" for a
point-in-time predicate on `(t_valid ≤ as_of < t_invalid)`.

### 2.4 Daemon model (`memoryd`, host-side infra)

One **singleton** daemon for all stores (not per-scope), shipped as a binary inside `memory-server`,
**lazily spawned** by the MCP server on first launch (the ecosystem has no service type — Gap G-A).
Singleton guaranteed by an OS advisory lock on `~/.memory/memoryd.lock`.

- **Sole writer.** MCP servers open each `.db` **read-only (WAL)** for recall; all writes go through
  the daemon, eliminating write contention. MCP `memory_write` = `INSERT INTO organizer_queue` (the
  one durable write MCP does directly, sub-ms under WAL) + a socket nudge.
- **IPC = hybrid, decision locked (§8 / open-gap):** the **durable `organizer_queue` table is the
  source of truth** (crash-safe, daemon resumes from `MAX(seq WHERE done_at IS NULL)`), **plus a Unix
  domain socket `~/.memory/memoryd.sock` as a low-latency doorbell**. Enqueue → 1-byte nudge
  (non-blocking). If the socket is dead, the daemon's fallback poll (every 1000 ms) still drains the
  table. **Latency:** socket-nudge wake ≈ 0.1 ms vs pure-polling adds up to the 1000 ms poll interval;
  durability is identical because the table is authoritative either way. This buys low wake latency
  **and** crash-safety, at the cost of one socket + one timer (~30 LOC). Pure socket = fast but loses
  work on crash; pure polling = durable but 1 s tail latency. Hybrid dominates both.
- **Loop (deterministic-first, 7 steps):** ingest → extract → link → consolidate → decay → reindex,
  batched ≤50 nodes/cycle. Priority queue maps project→0, agent-tagged→1, user/global→2.
- **LLM step is delegated to `memory-organizer`** (the agent extension), invoked only when a batch
  needs semantic judgment (relation extraction, importance 1–10, contradiction detection, reflection
  when Σimportance ≥ 150). **2–4 batched LLM calls per cycle, via the ecosystem provider abstraction —
  the ONLY LLM calls in the whole subsystem.** Restart window 1–2 s; cold start 200–500 ms; both off
  the read path.

### 2.5 `memory init` / `memory import` CLI

`memory init [--scope project|user|org] [--path DIR]` → creates `.memory/`, the `.db` with full
schema, pins `embed_model`+`embed_dim` in `memory_scope`, writes `~/.memory/registry.json` entry.
Default `--scope project`, MVP target.
`memory import --graphify <graph.json>` → version-defensive bridge (§8 G-Graphify) bulk-loads a
Graphify export into the project store. `memory status|list` introspect; `memory promote` surfaces
`promotion_queue` for approval (§8 G-C).

### 2.6 Cross-scope RRF federation

`memory_recall` fans out parallel WAL reads across installed+enabled stores (project/user/org),
runs each store's local hybrid pipeline, then **scope-weighted RRF union (not override)**:
`score(m) = scope_weight(m.scope) · Σ 1/(k + rank_r(m))`, k=60, weights project 1.0 / user 0.6 /
org 0.4, `agent_id` match ×1.25. Union (every scope surfaces; project ranks highest) with one
override exception: a node carrying `SUPERSEDES`→`SAME_AS` to a broader-scope uid suppresses that
target. Content-hash dedup across stores before assembly. Measured budget: 3 stores × 50K ≈ 10–30 ms,
inside the 50 ms ceiling. Graph expansion runs **project store only** (others contribute flat candidates)
to bound latency.

---

## 3. Build-vs-reuse, locked & reconciled to the glue budget

**Conformance reconciliation (critical):** the research costed ~1700 LOC in **Python**
(sentence-transformers, spaCy, aiosqlite, Click/Typer). The ecosystem is a **TypeScript/pnpm**
monorepo (`dist/index.js` entrypoints, TS provider abstraction). Since the **episodic-extraction LLM
calls must go through the ecosystem provider abstraction (TS)**, the organizer must live in-ecosystem
→ **the subsystem is implemented in Node/TypeScript**, reusing npm equivalents. The port is roughly
LOC-neutral (heavy lifting stays in reused libs); the one real delta is substituting spaCy NER with a
Node NER (+~80 LOC). Python's research numbers are **superseded** by the TS column below.

| Component | Decision | Reuse (npm) | Build LOC (TS) |
|---|---|---|---|
| DB engine | **reuse** | `better-sqlite3` (sync, fast) | 0 |
| Vector index | **reuse** | `sqlite-vec` (node binding) | ~40 (load+upsert glue) |
| BM25/FTS5 | **reuse** | SQLite FTS5 built-in | 0 |
| Embedding runtime | **reuse** | `fastembed`/`onnxruntime-node` (nomic-embed 768 / MiniLM 384) | ~60 (wrapper) |
| Schema + migrations + pragmas | **build** | — | ~120 |
| Hot-path recall (vec+BM25+temporal+CTE+RRF+MMR+assemble) | **build** | — | ~250 |
| MCP server (stdio JSON-RPC + 7 handlers) | **reuse+build** | MCP TS SDK | ~280 |
| Write enqueue + organizer_queue | **build** | — | ~70 |
| `memoryd` daemon (loop, socket+poll, scheduler, decay, reindex) | **build** | `node:net`, `node:cluster`-free | ~450 |
| Organizer LLM step (extract/link/consolidate via provider) | **build** | ecosystem provider | ~300 |
| Deterministic NER + dedup (spaCy substitute) | **build** | `wink-nlp` | ~120 |
| Cross-scope federation | **build** | — | ~150 |
| `memory-cli` (init/import/status/list/promote) | **build** | host command contract | ~180 |
| Graphify import bridge (version-defensive) | **reuse+build** | Graphify (external, run separately) | ~120 |
| Config/policy loader | **reuse+build** | host cascade `config{}` | ~30 |
| **Memory build total** | | | **≈ 1,780 LOC** |

= the research's **~1700** + **~80** NER-substitution delta from the TS conformance port. This sits
**on top of** the ecosystem's reused tooling (install client, cascade, provider-capabilities,
validate-manifests, registry, Changesets — the ~1010-LOC ecosystem glue), which memory **consumes,
does not rebuild**. **MVP subset ≈ 520 LOC** (schema 120 + embed 60 + recall 250 [depth-1 only] +
2 tools 60 + CLI-init 30) → single project `.db`, `memory_write`+`memory_recall`, in-process write
(no daemon yet), hybrid recall <50 ms at 10K.

**Reuse verdicts locked:** SQLite/sqlite-vec/FTS5 = reuse. Graphify = **partial reuse** — YES for
static code/doc corpus (71.5× token reduction), **NO** for episodic streaming (no live write path,
`--update` correctness gaps); integrate via init-time import bridge only. MCP SDK, embedding runtime,
NER = reuse. Daemon, organizer, federation, hot path, schema = build.

---

## 4. Open gaps — RESOLVED (decided, not deferred)

**G1 — DB at scale.** Default **sqlite-vec brute-force** per store. **Switch trigger to libSQL
DiskANN when, per store, vector rows > 50,000 OR measured p95 recall > 35 ms** (headroom under the
hard **50 ms** ceiling). Rationale: 768-D brute force holds <50 ms to ~30–50K rows; 35 ms p95 is the
early-warning line. libSQL keeps the single-`.db` model and native `vector_top_k`, so the switch is a
file-format migration, not an architecture change. Engine is a per-store `config.db_engine`. The 50 ms
ceiling is **end-to-end recall incl. local query embedding (~8 ms)**, zero LLM.

**G2 — Daemon IPC.** **Hybrid: durable `organizer_queue` table (authoritative) + Unix-socket
doorbell.** Picked over pure socket (loses work on crash) and pure table-polling (1 s tail latency).
Cost: ~30 LOC, one socket FD, one 1000 ms fallback timer. Wake latency ≈ 0.1 ms; durability =
table-backed. (Full rationale §2.4.)

**G3 — Scope promotion/demotion.** Heuristics become **configurable policy** in the cascade `config`
block: `promotion: { auto_approve:false, min_occurrences:3, min_age_days:60 }` (the "3-store / 60-day"
rules, now tunable per scope). The daemon only **logs candidates** to `promotion_queue`; it never
auto-mutates scope. **Approver:** the project/user owner via `memory promote` (interactive
approve/reject), or — only if an **org `extends` baseline** sets `auto_approve:true` — the daemon may
auto-apply low-risk promotions. Cross-scope writes obey scope RO rules (you can promote *into* a
broader scope only if that scope is writable in the current cascade). This is the data-migration
concept the ecosystem install model lacks — see §8 G-C.

**G4 — Graphify import bridge, version-defensive.** Treat `graph.json` as an **untrusted external
format** (it is an undocumented NetworkX serialization). Bridge: (a) read a `graph.json` `version`/shape
fingerprint header; (b) validate against an internal adapter schema for the **pinned set of supported
shapes**; (c) defensive field access with explicit defaults; (d) on unknown/missing fields **fail
loud** (refuse + report) — never silently partial-import into the store; (e) bridge carries its own
`SUPPORTED_GRAPHIFY_SHAPES` constant and a conformance test fixture per supported shape. Import is
init-time/batch only; the live system owns all writes thereafter.

**G5 — Episodic extraction stack & the single LLM locus.** Pipeline: **deterministic NER (`wink-nlp`,
spaCy substitute)** for high-confidence entity candidates + content normalization + SHA-256 dedup →
**batched LLM (via ecosystem provider, structured_output)** for relation triples + importance (1–10) +
contradiction detection + reflection synthesis → **local embeddings (`fastembed`/onnxruntime,
nomic-embed-768)** for vectors. Entity link: exact/normalized match → cosine >0.95 auto-merge →
0.7–0.95 LLM disambiguation only. **Every LLM call lives in `memory-organizer`, invoked by `memoryd`
during organize, batched 2–4/cycle, never on read.** Embeddings and NER are deterministic and also
off the read path (read uses cached vectors).

---

## 5. Acceptance-relevant invariants (carried into the phase plan)

- **R1** recall p95 < 50 ms incl. query embedding, zero LLM/provider calls on read path (assert via a
  read-path provider-call counter == 0).
- **R2** one `.db` file per scope; `memory init` idempotent; embed model pinned & enforced.
- **R3** every memory LLM call originates in `memory-organizer` and routes through the ecosystem
  provider abstraction (assert: no provider import outside organizer).
- **R4** bundle installs via the ecosystem install client + lockfile only; `validate-manifests.ts`
  passes all 9 invariants; versions Changesets-driven & package.json-synced.
- **R5** bi-temporal: invalidation closes prior `t_invalid`, never deletes; `as_of` queries reproduce
  historical state.

---

*(Deliverable 4 — phased resumable build plan with deterministic acceptance checks — in [`migration.md`](./migration.md).
Deliverable 5 — Ecosystem Conformance + Gap Report — is §8 below, kept here so the feedback to the
ecosystem plan stays with the design rationale.)*

---

## 8. DELIVERABLE 5 — Ecosystem Conformance + Gap Report

Because sox-memory is the **first tenant**, every place the ecosystem contract didn't anticipate a
real workload is surfaced here as **feedback to the ecosystem plan**, not a silent workaround. Each
has: what conforms, the gap, the in-tenant workaround, and the recommended ecosystem change.

### Conformance — what the contract already covers cleanly ✅
- All four memory pieces map onto the **six existing types** with no new type needed for three of
  them (mcp-server, agent, hook, command).
- The **provider abstraction** absorbs episodic-extraction LLM calls with zero parallel config —
  `requires.structured_output` + `providers.<name>` is exactly enough.
- **Changesets + install client + lockfile + registry** version and ship four independently-versioned
  extensions; the `dependencies` field expresses the keystone relationship.
- **Scope cascade** `config{}` deep-merge is the right home for tunable memory policy (promotion
  thresholds, recall ceiling, batch sizes).
- **CI invariants** (immutable id, version-sync, shadow-copy block, secret-in-config) all apply
  unchanged; no memory secret ever leaves `${ENV}`.

### Gaps (feedback to the ecosystem plan)

**G-A — No first-class long-running service / daemon lifecycle.** The organizer needs an
always-on, singleton, host-supervised process. None of the six types models "a background service
with start/stop/health." *Workaround:* `memoryd` ships **inside** `memory-server` and is **lazily
spawned** with an OS advisory-lock singleton; the MCP server's lifecycle stands in for the daemon's.
*Recommend:* add a **`service` type** (or a `lifecycle:{background:true, health:…}` block on
mcp-server) so the host owns supervision/restart/health instead of an extension self-managing a PID.
This is the sharpest gap — likely to recur for any tenant with async/background work.

**G-B — No bundle / meta-package primitive.** Four extensions are one product. The flat `install[]`
+ **array-replace** cascade rule means a consumer can't "add the memory bundle" atomically, and an
org baseline + project add forces re-listing the whole array. *Workaround:* ship `bundle.fragment.json`
+ `memory bundle --print`; use `dependencies` for cohesion. *Recommend:* a **`bundle`/`group`
manifest** (a named set with one version) **or** a cascade `install` merge mode (`append` vs
`replace`) so additive install lists compose. Without this, every multi-extension tenant re-hits the
array-replace ergonomics.

**G-C — No scope-promotion (data migrating narrow→wide).** The cascade governs *config/install*
precedence; it has no concept of **content** maturing from project → user → org scope. *Workaround:*
`promotion_queue` + `memory promote` + a `config.promotion` policy, approver = scope owner (or org
baseline auto). *Recommend:* the ecosystem acknowledge a **scope-promotion / cross-scope data
movement** concept (even just a documented pattern + an approval hook) so tenants don't each invent
one. Also note: the ecosystem's scopes are **org/user/project/local**; the memory research's "agent"
scope had **no install-scope equivalent** — we resolved it as an in-store `agent_id` partition, but
the ecosystem may want to state explicitly that **per-identity (agent/user) data partitioning is a
tenant concern, not a scope**, so future tenants don't reach for a 5th scope.

**G-D — Runtime-language assumption is implicit.** The contract's `entrypoint:"dist/index.js"` +
TS-built provider layer effectively **mandates Node** for anything that calls a provider. The memory
research assumed Python; we ported. *Recommend:* the ecosystem **state the runtime contract
explicitly** (Node/TS for provider-touching extensions; language-agnostic stdio only for
provider-free mcp-servers), so future tenants budget the port up front rather than discovering it.

**G-E (minor) — Capability declaration granularity.** `requires` lives on the *extension* that's
installed, but the *actual* LLM caller (`memoryd`/organizer) is spawned behind `memory-server`. We
declared `requires` on both `memory-server` and `memory-organizer`, which is slightly redundant.
*Recommend:* document whether `requires` should aggregate at the bundle keystone or stay per-extension
when one extension spawns another.

**Net:** the contract holds for a real, non-trivial workload with **zero redesign required to ship** —
the four gaps are all addressable by **additive** ecosystem features (a `service` type, a `bundle`
primitive, a documented promotion pattern, an explicit runtime statement). That is the strongest
possible result for an inaugural tenant: it conforms today and its friction points are a clean,
prioritized backlog for the platform.
