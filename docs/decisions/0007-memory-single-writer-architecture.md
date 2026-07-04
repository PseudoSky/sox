# ADR 0007 — Memory platform architecture: single writer, reusable subsystems, remote-first (enterprise target)

- **Status:** PROPOSED v2 — v1 (2026-07-03 morning) carried four provisional ⚖ defaults;
  the owner answered all four the same day and this revision incorporates those answers.
  v1 never shipped, so this revises in place rather than superseding.
- **Drives:** BACKLOG.md BL-118 … BL-149 ("memory-server production hardening: locking &
  topology"). Every entry maps into a phase in §Roadmap.
- **Grounding:** the 2026-07-02/03 lock-contention incident (forensics in BL-118..145)
  plus a source-level seam investigation of libs/memory-core, libs/service-proxy,
  libs/host-runtime, libs/mcp-runtime, libs/data/*, apps/sox, and the sox-memory-bundle
  members (2026-07-03).
- **Owner:** pseudosky.

## Context

On 2026-07-02/03 the memory store (`~/.memory/memory.db`) was served by up to nine
concurrent processes across three uncoordinated spawn paths — launchd KeepAlive units,
shim-spawned proxy backends with a spawn race, and a 10-day-stale legacy daemon — with no
busy handling anywhere: caller-visible `database is locked` errors (BL-118), a daemon
error-log full of `SQLITE_BUSY` loop failures, and an upgrade that emptied
`extensions.lock` while live sockets masked total cold-start breakage for ~15 hours
(BL-141). Separately, the seam investigation found the codebase mid-migration: a clean,
public, generic embedding library and graph/vector backend interfaces already exist and
are consumed elsewhere, while memory's own hot path still runs parallel private
implementations against raw SQL.

Owner constraints for the target state (2026-07-03):
1. The enrichment system will be **reused by non-memory projects** — memory may host it,
   but must not own it; embedding-system enhancements must benefit all consumers.
2. Always-active vs on-demand is a **per-install configuration** via the soxe
   configuration manager, and the service mounts on **all available interfaces** by
   preference.
3. **Remote-first, multi-transport by default**: stdio-only MCPs force full session
   reloads during development (so agents learn to ignore the system), and
   npx/hardcoded-path host configs are an antipattern versus a URL. The system is built
   for more users than one machine.
4. This document is the enterprise-grade design that resolves every logged bug and
   feature while retaining existing package boundaries.

## The invariant

> **At most one process may hold a write connection to a given store, and that process is
> the one activated on the store's socket.** Everything below makes this invariant hold by
> construction, be observable from any client in one call, and fail loudly — never
> silently — when violated.

## Decisions

### D1 — Reusable subsystems: memory hosts, `data/*` owns

The reusable layer already exists; the decision is to **finish the migration onto it and
delete the parallel private implementations** (BL-147 as reframed, BL-149):

- **Embedding** — `@adhd/sox-embedding-provider` is *the* embedding subsystem:
  `EmbeddingProvider` (`embedSingle`, `embedBatch`, `warmUp`, `metadata` with
  model identity), `createEmbeddingProvider({type: 'fastembed'|'hash'|'remote'})`, and a
  transient/permanent/resolution error taxonomy. memory-core migrates
  `write.ts`/`recall.ts`/`update.ts`/`memoryd.ts` off its private `embed.ts` (584 lines,
  own worker, own hash fallback, own `SOX_EMBED_BACKEND` config shape) onto the provider,
  keeping only a thin health/identity adapter for the `memory_ping`/`memory_stats`
  surface (`embed_state`, `last_embed_error`, configured-vs-active model — the BL-144
  false-alarm fix). The **worker-thread ONNX host is extracted once** and shared by its
  three current independent implementations (memory-core `embedWorker.ts`, hybrid-search
  `cross-encoder.ts`, claim-verification `worker.ts`). Provider enhancements — warm-up,
  batch API, health, identity — land in the lib and reach every consumer, per the owner
  constraint.
- **Enrichment math** stays in `@adhd/sox-analysis` (`cluster()`, `detectNearDupPairs()`,
  `scoreImportance()` — already there, already imported by memory-core). The duplicate
  local `computeImportance` reconciles into `scoreImportance` (BL-149).
- **Enrichment orchestration** (the outbox-driven batch pipeline: drain queue → embed →
  near-dup/SAME_AS → cluster/communities → importance, in micro-transactions with
  backoff and dead-letter — BL-126) moves to where its ownership is already claimed:
  `@adhd/sox-analysis` documents itself as owning generic batch-enrichment orchestration.
  It operates over `(GraphBackend, VectorBackend)` + a small outbox/watermark contract —
  **no memory schema knowledge**. The proof this interface approach works is in-repo: six
  memory-core read-path modules already compose over `createGraphBackend()` while the six
  hot-path files (`enrich.ts`, `enrich-batch.ts`, `cluster.ts`, `autolink.ts`,
  `neardup.ts`, `memoryd.ts`) still hand-write SQL — the migration finishes what the
  memory-refactor plan started.
- **memory-core keeps** what is genuinely memory's: schema/DDL, the 19 tool handlers,
  write/recall/update composition, provenance, curate, and the ping health adapter.
  `@adhd/sox-ingest` remains `private:true` by its own declaration; the unused declared
  deps (`embedding-provider`, `ingest`) become real or are removed.

*Consequences:* BL-119/120 (duplicate daemons, unrouted pools) become unreproducible
rather than guarded; both memoryd implementations (memory-core's class and the
server-local copy) are deleted in favor of the analysis-owned orchestrator hosted by the
writer (BL-149); any future project gets enrichment by composing provider + backends +
orchestrator over its own store.

### D2 — Single-writer hosting

The store's writer process hosts the enrichment orchestrator **in-process** (worker
thread for embedding compute, micro-transactions for index writes). Writes go through one
connection behind an in-process write queue with group commit. The `memory-daemon`
extension is deprecated after Phase 2 (bundle major bump); enrichment supervision rides
the writer's supervision. Read connections open `query_only`; WAL readers never block.

### D3 — Activation posture is configuration, not architecture

A new `activation_posture: 'always-on' | 'on-demand'` key in memory-server's
`config_schema`, resolved through the existing `soxe config` cascade
(org → user → project → local, delivered as `SOX_CONFIG_*` at spawn — the same live
mechanism tokenguard uses today), read by `deriveOsUnitSpec()` when generating os-units.
The existing `config set → restartOsUnit` hook makes posture changes take effect without
manual service surgery.

- **always-on** = `RunAtLoad` + `KeepAlive` (levers that exist today) — ships first.
- **on-demand** = socket activation: `Sockets` plist rendering (launchd) / paired
  `.socket` units (systemd) + an inherited-fd variant of `serveBackend()`. Genuinely new
  work (no scaffolding exists) — built in Phase 3, and it structurally eliminates
  bind-stealing for the supervised path because the OS owns the socket.
- The `ensureBackend` spawn path remains the non-supervised fallback (CI, fresh
  installs), hardened per BL-137: probe-connect before spawn AND before bind — **never
  steal a live socket** — readiness handshake instead of the 10s timeout, lock-holder
  liveness checks, backend exit handling.
- Re-enable gates from BL-145 stand: no launchd unit returns before its phase's gates
  pass.

### D4 — Remote-first, all transports, one process

Target: **one writer process, N listeners** — stdio (via the per-session shim), the UDS
proxy backend (0600, local), and streamable HTTP — all bound simultaneously by default,
configurable per install. Today's code picks exactly one mode per process
(`resolveTransportMode`, stdio XOR http/sse) — simultaneous binding is new work on top of
real existing transport code, and the manifest already declares the capability
(`install.serves: ["stdio","sse","http"]` + profiles, schema-validated).

Rationale (owner, recorded as design drivers): remote transports survive server restarts
— the dev live-reload loop that stdio structurally cannot give (a stdio MCP dies with its
process and takes the session's tool availability with it, which trains agents to ignore
the system); host configs become URLs instead of npx/hardcoded-path spawn commands; the
system serves more hosts than one machine's.

Security policy that makes all-transports-on safe by default:
- **Bind address defaults to loopback** (`127.0.0.1`), exactly as the transport code does
  today. Broader binds ("all available interfaces") are a per-install config key —
  explicit, never implicit.
- **Non-loopback binds require bearer auth**: a per-install token minted at install time,
  stored via the config cascade's env-ref pattern, checked by the HTTP transport.
  Loopback + UDS may run tokenless (filesystem/host trust), configurable stricter. No
  auth code exists today (verified) — this is Phase 4 work.
- **Ports are a config key, not an accident**: the current state writes `:3000` URLs into
  host configs while actually binding a random port (BL-148). Fix: per-install port in
  `config_schema` (tokenguard precedent), with host-config URL generation reading the
  same source of truth.

### D5 — Write path hardening

`PRAGMA busy_timeout` (2–5s) + WAL + `synchronous=NORMAL` on every connection. Single
write queue with group commit (BL-118). Structured storage error taxonomy
`E_BUSY/E_IO/E_ALLOWLIST` with `{retryable, retry_after_ms}` — a raw driver exception
reaching a caller is a bug (BL-124). `memory_write_batch` transactional array writes
(BL-125). Idempotency keys (`client_request_id`) formalizing exactly-once retries;
identical-content replay returns the existing uid as success (BL-129). Enrichment
watermark (`last_enriched_seq`) + `memory_flush({await_seq})` for read-your-derived-
writes (BL-127).

### D6 — Store identity and safety

Schema version + writer artifact hash stamped in the store; refuse-or-warn on open
mismatch (BL-121). **Embedding-model identity pins per vector space in
`@adhd/sox-vector-store`**, whose existing space-invariant enforcement (rejects
dimension-mismatched upserts) is the natural home — extended to carry model identity so
a model change is an explicit re-embed migration, never a silent cross-space corpus
(BL-144 residual). Ping distinguishes configured vs active model + init state so a
pre-warm placeholder can never read as a model change. Named-store registry: calls pass
`store:"name"`, results echo resolved path + store fingerprint; raw `db_path` accepted
with a deprecation warning (BL-130). WAL checkpoint `TRUNCATE` on idle, scheduled
compaction, size quotas, `memory_backup` via `VACUUM INTO` (BL-123, BL-133).

### D7 — Topology enforcement and observability

Per-store writer lease held by the activated backend (BL-128) — belt to D3's suspenders.
`memory_ping` returns instance identity (pid, start time, transport, instance id, build
hash) + per-store health (path fingerprint, WAL size, last checkpoint, watermark, queue
depth) so any client verifies the invariant in one call (BL-122, BL-131). Recall scores
become legible (per-query normalization or per-channel contributions) (BL-132).

### D8 — Platform (soxe) lifecycle integrity

Reaping by logical service identity (socket/db ownership or a service-id in argv/env),
an explicit `soxe doctor`/`reap` verb, and a reconciliation pass on `soxe status`
(BL-136). Every kill surface consults os-unit state and unloads before reaping (BL-138);
the stale "never a real launchctl load" comment in os-unit.ts is corrected. Upgrades
write the lockfile atomically, fail loudly on zero resolved members, and gate success on
a cold `soxe serve` spawn test; `soxe status` flags lockfile-empty-but-registry-populated
divergence (BL-141, BL-143). Ownership ledger dedupes entries with a one-time compaction
(BL-142). Unified log keying by logical service id feeds `soxe ps` (registry + os-units +
proxy locks/sockets + an OS-truth ps/lsof pass flagging UNMANAGED/STALE, build hash per
process) and `soxe follow` (merged prefixed live tail — the docker-compose pane)
(BL-139, BL-140).

### D9 — Storage engine: SQLite, with a recorded exit ramp

SQLite remains correct under a single writer at this scale. Exit triggers (BL-135): a
true multi-host or multi-writer requirement, store growth past low-GB with p99 breaches,
or relational/multi-tenant needs → libSQL server mode first (schema-preserving), Postgres
+ pgvector if the trigger is relational. The write-queue/outbox seam from D2/D5 is the
storage-agnostic boundary that keeps this swap contained — and it is the same seam the
reusable orchestrator (D1) programs against.

## Package boundaries (respected and finished)

```
apps/sox ──────────────► install-engine, host-registry, host-runtime, manifest, service-proxy
memory-server (ext) ───► memory-core, mcp-runtime, service-proxy
memory-core ───────────► graph-store, vector-store, hybrid-search, analysis, embedding-provider (D1 makes real)
mcp-runtime ───────────► host-runtime
analysis ──────────────► vector-store, graph-store          (gains: generic outbox orchestrator)
hybrid-search ─────────► embedding-provider, graph-store, vector-store
embedding-provider ────► (leaf; gains: shared ONNX worker host)
service-proxy ─────────► (leaf; gains: inherited-fd serveBackend)
```
No upward or circular edges — unchanged from today. New capability lands in the package
that already owns the concern; memory-core shrinks.

## Roadmap (every BL entry mapped)

| Phase | Contents | Gate to pass |
|---|---|---|
| **0 — Interim (done)** | Incident cleanup; single shim-spawned writer; launchd off; lockfile repaired (BL-144 resolved benign; BL-145 recorded) | `lsof` shows one holder — held ✓ |
| **1 — Write path** | BL-118, 124, 125, 129 + concurrency-harness skeleton (BL-134) | Harness: N real MCP clients + enrichment churn → zero caller-visible lock errors, p99 in budget; **negative control: same harness red on the pre-fix build** |
| **2 — Reusable subsystems** | BL-147 migration: memory off private `embed.ts` onto embedding-provider; shared ONNX worker host; enrich hot path onto Graph/VectorBackend; outbox orchestrator into analysis (BL-126) + watermark (BL-127); both memoryds deleted, daemon deprecated (BL-119/120 by construction; BL-149) | Enrichment parity vs daemon baseline (BL-145's unverified note becomes this gate); zero `SQLITE_BUSY` in an enrichment-backlog soak; a second toy consumer composes provider+backends+orchestrator over a non-memory store |
| **3 — Supervision & identity** | D3: `activation_posture` config key + `deriveOsUnitSpec` branch; always-on re-enable (BL-145 gates); socket-activation build-out (Sockets/.socket rendering + inherited-fd `serveBackend`); BL-137 fallback fixes; BL-128 lease; BL-121 stamping; BL-130 named stores; BL-131/122 ping identity | `kill -9` chaos + reconnect storms: invariant holds, WAL recovers, `integrity_check` clean; posture flips via `soxe config set` alone |
| **4 — Remote-first transport** | D4/BL-146: simultaneous multi-bind (stdio shim + UDS + streamable HTTP); bearer auth for non-loopback; bind-address + port as config keys; host-config URL generation from config truth (fixes BL-148); remote profile becomes the recommended default | A host config containing only a URL survives backend restart + upgrade without session reload (the owner's live-reload requirement, demonstrated); unauthenticated non-loopback bind is impossible by construction |
| **5 — Platform & polish** | BL-136, 138, 139, 140, 141, 142, 143; BL-123, 132, 133; full BL-134 (chaos/soak/SLO gates in CI) | `soxe ps` == OS truth (ps/lsof) under an adversarial stray-process test; upgrade cannot complete with a cold-spawn-broken lockfile |

## Q&A record (owner-resolved 2026-07-03; supersedes v1's ⚖ defaults)

| Fork | v1 ⚖ default | Owner decision | Where it landed |
|---|---|---|---|
| Writer topology | Merged backend | Enrichment must be reusable by non-memory projects; memory may host | D1 (data/* owns, memory hosts), D2 |
| Supervision posture | Socket-activated launchd | Configurable always-on vs on-demand via soxe config manager; all interfaces preferred | D3 (posture = config; socket activation = the on-demand mechanism) |
| Transport | UDS-local only | Remote-first, all transports on by default, per-install configurable — live-reload + no-npx-configs + built-for-others | D4 (+ loopback/bearer safety policy, flagged for owner review) |
| Deliverable | ADR + phased roadmap | Full enterprise design solving all logged items within existing boundaries | This document |

Open for owner review: D4's security defaults (loopback bind default + bearer-required
for non-loopback) were designed in, not asked — loosen or tighten by editing D4 before
Phase 4.
