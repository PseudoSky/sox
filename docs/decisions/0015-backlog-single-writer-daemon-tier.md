# ADR-0015 — `backlog` needs a single-writer daemon tier; a `serve` startup guard alone breaks the CLI

**Status:** PROPOSED — design only, no code shipped by this document (per explicit owner/team-lead
constraint; production recovery was mid-flight on the live store during authoring — see Context).
**Author:** `backlog-singleton-enforcement` (platform-engineer agent), dispatched by team-lead.
**Relates to:** [`docs/spec/service-lifecycle.md`](../spec/service-lifecycle.md) §5 (`[inv:singleton]`),
§9.5 (M3↔M4 front-shim/service-proxy bridge — the pattern this ADR reuses); [ADR-0007](./0007-memory-single-writer-architecture.md)
D2/D4 (memory's single-writer + remote-first precedent); [ADR-0012](./0012-turso-multiprocess-write-and-driver-agnostic-error-taxonomy.md)
(the Turso multi-process write invariant this ADR must not contradict); [ADR-0011](./0011-backlog-tool-write-destination.md)
(confirms `@adhd/backlog`/`entrypoint/backlog` is the external repo this ADR designs for, edits authorized
by this dispatch specifically, unlike ADR-0011's).
**Does NOT authorize:** any code change, any `backlog` invocation, opening the store (even a scratch
copy), or spawning any server — this document is read-only source study + design, per the standing
constraint in effect for the whole task (recovery of `~/.adhd/backlog/production/data/backlog.db` was
live during authoring).

## Context

### The incident and the premise correction

Two concurrently-running `backlog serve --transport mcp` processes writing the same store were
suspected to have corrupted `~/.adhd/backlog/production/data/backlog.db`, mirroring the upstream Turso
race `tursodatabase/turso#7833`/`#8348`. The task as originally dispatched asked for a supervised
**singleton guard** on `backlog serve`, modeled on `memory-server`'s.

That framing was corrected mid-task by the dispatching team-lead, and independently by this author's
own build-and-test evidence before the correction landed:

- **There is no `backlog` daemon today.** Every `backlog <cmd>` CLI invocation is its own process that
  opens the store directly (`cli.ts`'s `getCtx()` → `openGraphBacklogStore(resolveBacklogDbPath(env),
  ...)`, `entrypoint/backlog/src/cli.ts:277-280`). Every stdio MCP client (one per Claude Code
  session — `.claude.json`'s `backlog` MCP entry: `{"type":"stdio","command":".../backlog","args":
  ["serve","--transport","mcp"]}`) spawns its **own, full** `backlog serve` process
  (`entrypoint/backlog/src/serve.ts` → `startBacklogServer`, `entrypoint/backlog/src/server.ts:451`).
  pid 22905 — the process this task initially investigated as "the shared daemon" — was one client's
  stdio server that had simply outlived its client by ~2.5 days, not a shared daemon anything else
  connected to.
- **A startup guard on `serve` is therefore incoherent as a standalone fix.** Under this topology,
  *every* `backlog serve --transport mcp` invocation is legitimately a **new, independent** instance —
  one per concurrent agent session. This author built exactly that guard
  (`entrypoint/backlog/src/store/serve-lock.ts`, an O_EXCL PID-file lock keyed on the canonical
  `db_path`, mirroring `libs/host-runtime/src/lock.ts:50`'s `acquireStartLock`), proved it red→green
  with a real two-subprocess test, and only on team-lead's second correction recognized that the same
  "GREEN" result — the second of two concurrent `serve --transport mcp` spawns refused — is exactly
  what would happen to **every session after the first** on a machine with multiple concurrent Claude
  Code sessions (an every-day occurrence on this box, not an edge case). That commit was never landed
  and this author has abandoned it in favor of this document — recorded here so the mistake isn't
  silently dropped, per this repo's disclosure norms.

### Why this isn't "writers are unsafe, readers are safe"

Team-lead asked this author to argue, with evidence, whether concurrent *readers* are provably safe and
only concurrent *writers* need serializing — which would permit a much lighter fix than a daemon tier.
**That framing does not hold, and the evidence is already in this repo, not backlog's:**

- [ADR-0012](./0012-turso-multiprocess-write-and-driver-agnostic-error-taxonomy.md) §1 formally states,
  for `memory-server`'s own identical store-adapter/Turso substrate: *"Multiple processes may hold
  concurrent write connections to the same Turso-backed store"* — safe by construction, because Turso's
  own MVCC (`BEGIN CONCURRENT` / optimistic-conflict-and-retry) and connection-poisoning/recycle
  machinery make it so, not a queue. So concurrent **writers** are the *sanctioned* case for this exact
  adapter, not the unsafe one.
- `libs/data/store/store-adapter/src/turso-adapter.ts:492-502` — comment on the connection-open path,
  written specifically about `backlog`: *"multiprocess_wal is ALSO always on, unconditionally — NOT a
  toggle (BL-512 concurrent-write defect). **The backlog store is opened by many short-lived processes
  at once**; multiprocess WAL (`.tshm` coordination) is what lets those coexisting opens share the
  store... There is no opt-out: the `experimental: { multiprocessWal: false }` option was REMOVED from
  the adapter API with this fix."* This is first-party, already-shared-repo evidence that "many
  concurrent short-lived processes opening the backlog store" is a **known, deliberately engineered-for
  topology at the adapter layer**, not an unsupported anti-pattern — the adapter's multiprocess-WAL
  support exists *because of* backlog's usage pattern.
- The recovery agent's independent forensics (`docs/reporting/memory/findings/2026-08-17-backlog-store-recovery.md`
  §"Root cause confirmed") found the corruption's proximate trigger is opening the store with Turso's
  `index_method` experimental flag (required unconditionally for FTS,
  `turso-adapter.ts:481-490`) touching an already-damaged `idx_fts_node` page chain — a **read**-path
  crash surface, not a write-path one. Nothing in that forensics establishes reads-vs-writes as the
  safety boundary either.

**Conclusion: the real variable is *concurrent-open frequency/count against the still-open upstream
Turso race* (`tursodatabase/turso#7833`/`#8348`), not read-vs-write.** `memory-server` never corrupts
under the identical substrate because it sustains **one** long-lived connection per store
(launchd-supervised singleton). `backlog` corrupted because its adapter-sanctioned "many short-lived
processes" design means the store is opened, closed, and re-opened constantly — every CLI command,
every new MCP session — each open/close cycle a fresh roll of the dice against an unfixed upstream bug.
A daemon tier's actual safety contribution is **collapsing open/close frequency to near-zero for the
traffic it serves**, not "serializing writers" in the ADR-0007/pre-0012 sense — that mechanism no longer
applies to this adapter (ADR-0012 §1 explicitly retired it for Turso). This reframing matters because it
means a daemon tier is still the right structural answer, but for a different reason than the original
"single writer" framing assumed, and it means **CLI traffic left un-migrated to the daemon (see Decision
D5) keeps rolling that same die** — the daemon reduces exposure for whatever it actually serves, not for
the whole store, unless CLI traffic is migrated too.

## Decision

### D1 — What `--transport http` does today (confirmed, file:line)

`backlog serve --transport http` is real and already tested, not aspirational:

- `entrypoint/backlog/src/server.ts:507-518` — when `opts.transport` is `'http'` or `'both'`, mounts
  `@adhd/apigen-plugin-api-fastify`'s `apiFastifyPlugin.run()` against the same `pkg`/`operations`
  every transport shares, binding `opts.port ?? 3300` on `opts.host ?? '127.0.0.1'`.
- `entrypoint/backlog/src/server.spec.ts:1-9,74-77` — a live, unflagged (default-running) test spins up
  a real `startBacklogServer({transport:'http', ...})` and drives it with real `fetch()` calls — proven
  live, not a stub.
- **Gap:** there is no client-side HTTP calling code anywhere in this package today (`rg
  'http://|fetch\(|axios'` across `client.ts`/`cli.ts`/`server.ts` returns nothing beyond the HTTP
  *server* mount and its own test). The CLI (`cli.ts`'s `getCtx()`) and every `client.ts` export operate
  directly against an in-process `GraphBacklogStore` handle — there is no "connect to an existing HTTP
  server instead of opening the store" code path to reuse. This is the actual gap D4/D5 below must
  close, not a wiring bug — it has simply never been built.

### D2 — Auto-spawn-then-connect: reuse `@adhd/sox-service-proxy`, do not rebuild it

The team-lead's own framing named the cold-start race as "a genuine singleton problem" that *does*
belong to a startup guard, distinct from the incoherent serve-guard. **That primitive already exists in
this monorepo, is published, race-tested, and ready to consume as-is:**

- `libs/service-proxy/src/ensure-backend.ts` — `ensureBackend({socketPath, singletonKey, command, args,
  env, ...})` (`:288`). Dispositions: `'already-live'` (fast-path probe succeeds, no spawn),
  `'spawned'` (this caller won an O_EXCL spawn lock, spawned detached, waited for a **readiness
  handshake** — not just a TCP accept — `:147` `handshakeBackend`), `'adopted-after-wait'` (another
  caller's spawn was already in flight; this caller waited for its socket), `'failed'` (bounded timeout,
  distinguishing "child died" from "child never bound" — `:405-450`).
- **The exact cold-start race the team-lead flagged — two callers arriving simultaneously must not both
  spawn — is already proven, not just claimed:** `libs/service-proxy/src/ensure-backend.spec.ts:5-17`
  documents (and its suite exercises) "two CONCURRENT `ensureBackend` calls (simulating two sessions'
  shims) result in exactly one spawn," plus live-socket-steal prevention via double-checked-locking
  re-probe (`ensure-backend.ts:341-358`) and stale-lock reclaim by liveness probe + TTL (`:226-264`) —
  the same technique this author's now-abandoned `serve-lock.ts` used independently, this time already
  built, tested, and *correctly scoped* (a spawn-coordination lock, not a "refuse every second
  legitimate caller" lock).
- **This is a real, importable dependency, not an internal-only pattern to copy by hand:**
  `libs/service-proxy/package.json` declares `"name": "@adhd/sox-service-proxy"`, `"publishConfig":
  {"access":"public"}`, dependency-free (node builtins only — `net`, `fs`, `path`, `child_process`,
  `crypto`). `entrypoint/backlog/package.json` already depends on sibling public sox-ecosystem packages
  the same way (`@adhd/sox-store-adapter`, `@adhd/sox-graph-store`, `@adhd/sox-telemetry`) — adding
  `@adhd/sox-service-proxy` is the same shape of dependency, not a new kind of coupling.
- **Production precedent, not just a library:** `memory-server` already runs this exact pattern in
  production (`extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts:928,3311-3465`,
  env-flag-gated `SOX_PROXY_BACKEND=1` selects backend-mode vs. direct-stdio-mode in the SAME
  entrypoint binary) — `docs/spec/service-lifecycle.md` §9.5 documents the full front-shim↔UDS-backend
  design this ADR proposes backlog adopt, **status IMPLEMENTED + FLIPPED TO DEFAULT** (§9.5, header).

**Recommendation:** `backlog serve --transport mcp` becomes a thin **front-shim** (reusing
`libs/service-proxy/src/shim.ts`'s `runFrontShim` + `dial.ts`'s `dialBackend`, or backlog's own
equivalent built the same way if the exact `JsonRpcRequest`/framing shape needs a backlog-specific
adapter — the *coordination primitives* (`ensureBackend`, `probeSocketLive`, `handshakeBackend`) are
protocol-agnostic and reusable regardless), calling `ensureBackend()` before dialing. A new
**backend** entrypoint mode (mirroring memory-server's `SOX_PROXY_BACKEND=1` convention) hosts the real
`BacklogCtx`/store connection and serves JSON-RPC over the resulting UDS.

### D3 — Fallback semantics: fail loud, never silently fall back to direct store access

**Ruling: a client that cannot reach the daemon within the readiness bound MUST fail loudly with an
actionable error naming the socket path and disposition (`ensureBackend`'s own `detail` field already
carries this), never silently reopen the store directly.** A silent fallback to direct access
re-introduces the exact high-open-frequency exposure this whole design exists to reduce — worse, it
would do so invisibly, which is precisely the failure shape ("silent concurrency" per team-lead's own
framing of the original incident) this task was dispatched to eliminate. This mirrors
`docs/spec/service-lifecycle.md` §9.5.5's own failure table: a shim with a dead backend past the
re-dial bound fast-fails pending calls with a structured error (`-32001 backend unavailable`) rather
than degrading silently.

**Explicit escape hatch, not a silent default:** an operator-visible, opt-in config key (e.g.
`ADHD_BACKLOG_NO_DAEMON=1` or an equivalent `backlogEnvironmentSpec` field, matching this package's
existing env-var-driven config cascade — `env.ts`'s `resolveBacklogDbPath` precedent) may force
direct-store mode for diagnostics/CI/degraded scenarios. Its use must be **visible** (logged, or a
distinct exit-message prefix), never inferred from a failed daemon dial.

### D4 — MCP tool binding: `.claude.json` does not need to change; `server.ts`'s internals do

All ~39 `mcp__backlog__*` tools bind via the single stdio entry already confirmed
(`.claude.json`: `{"backlog":{"type":"stdio","command":"/Users/nix/Library/pnpm/backlog","args":
["serve","--transport","mcp"]}}`). Because `serve.ts`/`server.ts` are the layer that decides how to
serve a connected client, **the migration is internal to `startBacklogServer`'s implementation, not a
change to any host config or to the tool surface `mcp__backlog__*` callers see.** Each session's stdio
process becomes a thin shim (cheap to spawn/respawn — no tool implementation, no store connection of
its own) instead of a full server; `ensureBackend` makes the first shim on a given store responsible
for bringing up the one backend, and every subsequent shim (same store, any session) dials it.

**What is NOT decided here (see D5):** whether the CLI's one-shot commands (`backlog list-items`, etc.)
also become daemon-routed. If they do not, they remain outside the exposure-reduction this ADR
delivers — named explicitly so nobody assumes daemon adoption alone caps *all* concurrent-open traffic
against the store.

### D5 — Migration: no flag day; MCP-first, CLI is an explicitly separate, larger, NOT-yet-decided follow-on

**Ruling, modeled on [ADR-0007](./0007-memory-single-writer-architecture.md) D3's "activation posture is
configuration, not architecture" precedent:** ship the backend/shim split behind a default that does
**not** change today's behavior for any existing caller on day one — e.g. `SOX_PROXY_BACKEND`-style
env-gating identical to memory-server's own rollout shape, flipped to default only after live
verification (mirroring `docs/spec/service-lifecycle.md` §14 Slice 1.6's own "M3→M4 DEFAULT FLIP" being
a *separate, later* step from building the mechanism).

- **MCP path (D4) is the natural first migration target:** every `mcp__backlog__*` caller already goes
  through `startBacklogServer`; converting its internals is contained to `server.ts`/`serve.ts` and
  does not touch `cli.ts`'s ~39 direct call sites (`client.ts` exports) at all.
- **CLI path is explicitly a separate, larger decision, NOT ruled by this ADR:** every `client.ts`
  export (`createItem`, `listItems`, etc.) currently takes a `BacklogCtx = {store, env}` and calls
  directly into the in-process `GraphBackend`. Routing the CLI through the same daemon would require
  either (a) making `BacklogCtx` polymorphic — a direct-store implementation and a daemon-RPC-client
  implementation satisfying the same interface, a refactor touching every one of the ~39 exports'
  call sites, or (b) a thinner shim where only `cli.ts`'s dispatch layer redirects to an HTTP/UDS call
  when a daemon is live, falling back per D3 when not (adds the D3 "must fail loud, never silent"
  constraint to every CLI invocation too, which is a materially different UX contract than a persistent
  MCP session has). **Both are real engineering, not a config flip, and this document does not choose
  between them.** Named as the natural Stage 2 of a staged rollout (mirroring ADR-0011's own staged
  cutover pattern for a different backlog-adjacent migration), not committed to here.
- **This must not break current agents (explicit constraint from the dispatch):** the MCP-only Stage 1
  above satisfies this by construction — no `.claude.json` change, no CLI behavior change, and D3's
  fail-loud contract only fires when a daemon is expected to exist (i.e., after the default flips) and
  cannot be reached, exactly the failure mode `docs/spec/service-lifecycle.md` §9.5.5 already treats as
  acceptable (the shim keeps retrying; the client sees clean errors, not corruption).

### A related, independently-discovered defect worth folding into the daemon design (not solved here)

Team-lead independently found, while investigating this incident, that **a crashing `backlog` process
(e.g. the SIGABRT/exit-134 corruption symptom) orphans its store-adapter connection lease** in
`backlog.db.sox-lease.d/`, and nothing currently sweeps it — under the no-daemon topology, every panic
leaves one behind, so the lease directory grows monotonically under precisely the conditions it exists
to guard against. `libs/data/store/store-adapter/src/store-lease.ts:68-103`'s `entryLiveness` already
implements the right *primitive* for this — liveness-probe-on-READ (`process.kill(pid,0)`), not
reliance on the dying process's own cleanup — but per that file's own doc comment (`:157-164`
`storeQuiescence`), the sweep only runs when something actively calls `storeQuiescence()` for a
destructive-operation gate; it is not a standing reaper. A daemon tier's **single, long-lived**
connection would incidentally reduce this exposure for whatever traffic it serves (one lease held for
the daemon's lifetime instead of thousands of per-CLI-invocation leases, each a crash-orphan
opportunity) — but does not eliminate it for un-migrated CLI traffic (D5). Fixing the sweep itself
(a proactive reaper, or invalidating stale leases on every `storeQuiescence()` caller regardless of
whether a destructive op was pending) is a separate, addressable defect and is out of scope for this
ADR; noted here so it isn't lost.

## Consequences

- **Positive:** collapses the store's concurrent-open frequency for MCP traffic (the dominant traffic
  today, given every session spawns a full server) from "one open per session-lifetime-of-a-full-server"
  to "one open, period, per store, shared by every session" — directly reducing exposure to the open
  upstream Turso race without contradicting ADR-0012's sanctioned multi-writer model (this design still
  permits concurrent writers at the daemon; it just minimizes *open/close churn*, which is the actual
  risk factor per this ADR's Context section). Reuses proven, already-shipped, already-public
  infrastructure (`@adhd/sox-service-proxy`) rather than inventing a parallel mechanism for backlog.
- **Negative / cost:** a new backend-mode entrypoint + shim-mode entrypoint split in
  `entrypoint/backlog/src/server.ts`/`serve.ts` (real, non-trivial implementation work, not covered by
  this ADR); a new runtime dependency (`@adhd/sox-service-proxy`) on a different repo's published
  package, which `@adhd/backlog`'s release pipeline must track; CLI traffic remains un-migrated and
  therefore still exposed unless/until a follow-on ADR rules on D5's CLI question.
- **Risk this ADR explicitly does NOT resolve:** the underlying upstream Turso race
  (`tursodatabase/turso#7833`/`#8348`) is still open and unfixed. This design reduces *exposure
  frequency*, it does not eliminate the bug. A daemon that itself never restarts could still, in
  principle, hit the race on ITS one open — the mitigation is probabilistic (fewer rolls of the dice),
  not a proof of safety.

## Alternatives considered

- **Startup guard on `backlog serve` alone (the original dispatch).** **Rejected** — demonstrated
  directly in this task (see Context) to refuse every session after the first under the real, current
  no-daemon topology; would have shipped a regression disguised as a passing red→green test.
- **HTTP-only, no UDS/shim split (point every client at `--transport http` directly).** **Rejected**
  for the MCP path specifically — MCP clients speak stdio by protocol/host-config convention
  (`.claude.json`'s `type: 'stdio'`); an HTTP-only daemon would still require *something* stdio-shaped
  for `.claude.json` to spawn, which is exactly what the front-shim already is. HTTP transport is not
  wasted, though — it is a legitimate. **third path** for non-MCP daemon access (dashboards, other
  tooling) once the backend exists, orthogonal to this decision.
- **Serialize CLI writes with a lock instead of a daemon (a lighter-weight fix).** **Rejected** as the
  primary fix per the Context section's evidence: the corruption risk is concurrent-open *frequency*
  against an adapter that already sanctions concurrent writers (ADR-0012), not writer-vs-writer
  contention a lock would address. A CLI-side lock would slow down CLI commands without touching the
  dominant MCP-session traffic at all.

## The gate (for the follow-on implementation dispatch, not this document)

This ADR ships no code. A follow-on implementer's spec must name, at minimum: real two-and-more-session
red→green proof (N concurrent MCP shim spawns against one store → exactly one backend, N shims all
functional — the inverse of this task's abandoned serve-lock proof); a fail-loud-not-silent test for
the D3 fallback boundary; verification that `.claude.json`'s existing stdio config needs zero changes;
and an explicit decision request back to the owner on D5's CLI-migration question before starting that
half of the work.
