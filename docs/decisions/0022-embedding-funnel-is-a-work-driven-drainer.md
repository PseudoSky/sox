# ADR-0022 — The embedding funnel is a work-driven drainer

**Status:** ACCEPTED (2026-09-25).
**Owner:** pseudosky.
**Grounding:** owner directives (verbatim — *"funnel drainer should absolutely work and die"*;
*"why would connections matter to a process whos purpose is to clear a queue"*), the 2026-09-25
embedding outage, and the source evidence cited below.
**Supersedes:** [ADR-0020](./0020-embedding-funnel-peer-spawned-self-reaping.md) **D2** (self-reaping
on cross-process demand) and **D6** (stable identity; protocol-versioned key). ADR-0020 D1, D3, D4,
D5 and its idle-grace typed-config amendment remain in force.
**Relates to:** ADR-0013 (no feature-switch env vars — the keep-warm env knobs are deleted, not
re-homed), ADR-0004 (the socket stays under the data root), ADR-0021 (registry is release-only),
`docs/spec/service-lifecycle.md` §5 (env scrub), `[inv:no-fd-inherit]`.

## TL;DR

The host lives while it has work and dies `W` after its last completed work. Connections, health
probes and keep-warm never keep it alive. Every request carries the model identity and the host owns
its own model init, so any host that answers a path can serve any request routed to it. The singleton
key includes a content build id, so a consumer never dials a host from a foreign build.

## Context

- **D2 ref-counted connections, so the host became immortal.** ADR-0020 D2 armed the reap only when
  live UDS client connections *and* in-flight work both reached zero
  (`embedHostMain.ts:356-362` before this change). memory-server's `:3099` front shim holds a
  permanent UDS connection to the host (the file admitted it at `embedHostMain.ts:134-139`), so the
  connection count never reached zero, the reap never armed, and a keep-warm loop was bolted on to
  paper over the consequences.
- **D6 keyed on the protocol only, so a stale build served production.** The key was
  `embedding-host:v<PROTOCOL>:<model>:<ep>:<cacheDirDigest>` (`embedHostConfig.ts:218-221`). It
  carries no build identity. On 2026-09-25 a worktree build and then a stale 0.5.3 build (published
  before its source changed, with zero host telemetry) each held the production socket in turn, and
  every consumer dialled whichever one answered.
- **Per-connection init is unsound.** `dialBackend` (`libs/service-proxy/src/dial.ts`
  `connect()`/`requeueUnanswered()`) transparently re-dials the same path and replays unanswered
  requests to whatever answers it. It never spawns. Requeued requests fail -32001 after
  `giveUpAfterMs` (10 s). A client's one-time `embedding.init` handshake therefore does not follow
  its requests to a respawned host, which answers "Model not initialized".
- **`embedding.reset` bricked every other client.** It nulled the private pool
  (`sharedFastembedProcess.ts:1727-1737`) and with it `lastInitPayload`, so every other client's next
  embed failed "Model not initialized".
- **Teardown order was inverted.** `teardown()` terminated the pool before `handle.close()`
  (`embedHostMain.ts:336-354`), leaving the listener forwarding into a terminated pool.
- **The listener's close unlinked a successor's socket.** `serveBackend`'s close callback
  unconditionally unlinked the socket path (`libs/service-proxy/src/backend.ts:243-246`). This was
  reproduced on Node 24.11.1: it deletes a successor host's freshly bound socket.
- **The host inherited the spawner's identity.** It was spawned with the spawner's whole env
  (`funnelClient.ts:280-286`), including `SOX_SERVICE_ID`. `findOrphansByServiceId`
  (`libs/host-runtime/src/reaper.ts:532-557`, called from `apps/sox/src/main.ts:6455,6531,7052,8218`)
  and the OS-truth pass (`reaper.ts:792-812`) therefore treated the host as memory-server's process.

## Decision

### 1 — Retirement is driven by work

The reap timer arms when the host's in-flight work is zero **and** its private pool's pending count
is zero. It fires `W` after the last completed real work (`init`, `embed`, `embedBatch`, or the
host's own eager model load). `W` is the typed `idleGraceMs`, default **60 s**
(`DEFAULT_EMBED_HOST_IDLE_GRACE_MS = 60_000`). Connection count is not an input. Health probes,
resets and handshakes are not work. Keep-warm is removed entirely, with its env knobs.

### 2 — Ordered, synchronous retire

In one tick: flip to `retiring`, stop accepting and destroy client sockets (the listener's close
unlinks the socket), then terminate the pool, then exit 0. A request that lands after the flip gets
-32001 "embedding host retiring" without touching the pool. The client retries once through a fresh
ensure. The listener unlinks its socket path only when that path's inode is still the one it bound,
so a successor's socket is never deleted.

### 3 — Requests carry identity; the host owns init

Every `init`/`embed`/`embedBatch` request carries `{model, cacheDir}`. The host loads its own model
idempotently (a memoized `ensureModel`, cleared on failure and on `embedding.reset`) and eagerly at
startup. A request naming a different model or cache dir is rejected -32602 without touching the
pool. A replayed request lands on any live host for its key and is served.

### 4 — The key includes a content build id

`embedding-host:v<PROTOCOL>:<buildId>:<model>:<ep>:<cacheDirDigest>`, where `buildId` is a digest of
the host module bytes (every `.js`/`.cjs`/`.mjs` sibling of the host entrypoint), the Node ABI
(`process.versions.modules`) and `process.arch`. Two builds get two hosts. There is no opt-out. The
host recomputes its own build id at startup and exits 3 if it does not match the one it was spawned
with. `EMBED_HOST_PROTOCOL_VERSION` becomes 2.

### 5 — The host never inherits spawner identity

The host is spawned with an allowlisted env (`PATH HOME USER LOGNAME LANG LC_ALL LC_CTYPE TZ TMPDIR
XDG_CACHE_HOME`, `NODE_*`, `SOX_*`) minus a denylist (`SOX_SERVICE_ID`, `SOX_CONFIG_*`,
`SOX_PERM_*`, `SOX_PROXY_*`, `SOX_TELEMETRY_INIT`, `SOX_EMBED_HOST_*`). Every denied key is logged by
name. Spawner provenance travels as `--flag=value` argv for telemetry only; the `=` form keeps a
spawner's entrypoint path out of the whitespace-bounded tokens the identity reaper matches.
Self-retirement is the host's only lifecycle.

## Consequences

- A permanently connected consumer no longer pins a host. Its next embed after a retire respawns a
  host transparently.
- Two builds on one box run two hosts, for example the memory-server bundled sidecar and the adhd
  npm dist. This is accepted: one host per build.
- A host killed mid-request is replaced. The consumer's re-dial replays the request to the successor,
  which loads the model itself.
- The embed host appears in no service's reap set.

## What does NOT change

`FastembedProvider.ensureReady`'s init latch (`fastembed.ts:236-240,267`), the funnel circuit
breaker, `ensureBackend`, the adaptive pool policy, and `host: 'private'` mode.
