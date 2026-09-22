# ADR-0020 — The embedding funnel is peer-spawned and self-reaping; no managed service

**Status:** ACCEPTED (2026-09-22).
**Owner:** pseudosky.
**Grounding:** owner directive (verbatim — *"I do not approve a managed service for embedding"*), the
approved `SPEC-EMBEDDING-FUNNEL.md`, and the shipped implementation in
`libs/data/embed/embedding-provider` (`embedHostMain.ts`, `funnelClient.ts`, `embedHostConfig.ts`) +
`libs/service-proxy/src/backend.ts`'s `onClientCountChange` hook.
**Relates to:** ADR-0007 D3 (satisfied; its ordering departed from), ADR-0012 (authoritative — the
host is compute-only), ADR-0013 (typed config, no env toggle), ADR-0004 (socket under the data root),
ADR-0006/0016 (the host crosses as a live object via DI, no duplicated stateful bundle), ADR-0011
(the `entrypoint/backlog` consumer change carried the owner grant), ADR-0015 (a distinct, *proposed*
backlog-store daemon — NOT this).
**Supersedes:** the rejected `SPEC-EMBEDDING-HOST.md` (a launchd-supervised sox-owned embedding-host
service). Nothing in this ADR is supervised.

## Context

`@adhd/sox-embedding-provider` runs ONNX inference in a child **process**
(`fastembedProcessHost.ts`) because fastembed's `onnxruntime-node` cannot share a thread with the
rerank/verify stack. The process-wide accessor `getSharedFastembedProcess()` made that child a
**per-process** singleton — correct within one process, but it forks **N** hosts across N consumer
processes, each holding a resident model.

The cross-process collapse-to-one ("the funnel") was **specified but never wired**:
`docs/spec/backlog/PLUGIN_ARCHITECTURE.md` promised that "`ensureBackend` … many consumer processes
collapse to ONE daemon", and `entrypoint/backlog/RAG-SPEC.md` named an `embedding-remote` plugin that
never existed. The coordination primitive (`ensureBackend()`'s O_EXCL singleton spawn-lock) was
already shipped and race-tested; the lifecycle half — a host-aware accessor and a self-teardown — was
not.

The owner rejected a managed-service fix outright: *"I do not approve a managed service for
embedding."* A supervised daemon (launchd/`KeepAlive`) is not the answer, and neither is an env-var
toggle to switch modes.

## Decision

**The embedding funnel is peer-spawned, unsupervised, and self-reaping. There is no managed service.**

### D1 — Peer-spawned, never supervised

The host is a plain detached Node process (`embedHostMain.ts`), spawned on demand by the **first**
consumer through `ensureBackend()`'s O_EXCL spawn-lock. No launchd/systemd unit, no `KeepAlive`, no
supervisor, no socket activation. The host **outlives its spawner** (`detached: true` + `unref()`)
and is responsible for its own retirement.

### D2 — Self-reaping, on cross-process demand

The host's teardown is **debounced and ref-counted** over two inputs: live UDS client connections
(from `serveBackend`'s `onClientCountChange` hook) **and** its own in-flight `pendingCount`. When
both reach zero it arms an idle grace (`DEFAULT_EMBED_HOST_IDLE_GRACE_MS = 30_000`, ADR-0013 D3
numeric tuning via `SOX_EMBED_HOST_IDLE_GRACE_MS`); a new client or request cancels it. On expiry it
terminates its private pool, closes the listener (unlinking the socket), and exits 0. Its ONNX child
is forked `detached: false`, so it dies with the host — no orphans.

### D3 — Compute-only; it is NOT a store participant (ADR-0012)

The host holds **no store connection**. It forwards `embedding.*` payloads 1:1 to its private pool and
opens no database. It therefore cannot serialize store access and **must never be described as
single-writer or as a store serialization point**; concurrent store writers are unaffected. This is
asserted by teeth (`embed-funnel.spec.ts` runs `lsof` on the live host and requires no store-db
handle).

### D4 — Host selection is typed config, never an env toggle (ADR-0013)

`host: 'shared' | 'private'` is a closed union on `EmbeddingProviderConfig`, default `'shared'`,
applied before the accessor singleton is constructed and reported in `health().host`. `'private'` is
the explicit pre-funnel per-process fork (CI/diagnostics). There is **no** `SOX_EMBED_HOST=…`
variable; env reads are limited to ADR-0013 D3/D5 shapes (a numeric grace, the data-root home, and
path injections for tests).

### D5 — Honest failure, never a silent private re-fork

Under `host: 'shared'`, a failure to bring the host up throws a typed `TransientEmbeddingError`
naming the socket; it never falls back to forking a private host. A silent fallback would defeat the
funnel (each of hundreds of short-lived CLIs/day would quietly become its own ONNX host) — the exact
behaviour this design removes. A per-process circuit breaker bounds a retrying consumer after K
consecutive ensure failures. `terminate()` is a **no-op** for `'shared'`: a consumer must never kill
a host others are using; the heal path (`resetSharedFastembedHost()`) asks the host to reset its
private pool instead.

### D6 — Stable identity; protocol-versioned key

The host's identity is `embedding-host:v<PROTOCOL>:<model>:<ep>:<cacheDirDigest>`, resolved
identically by every consumer, so identical inputs converge on one socket and one host. Open question
4 of the spec ("a running host is an old build") is resolved with an explicit
`EMBED_HOST_PROTOCOL_VERSION` constant rather than the npm package version: the real hazard is an
incompatible `embedding.*` contract, and a version-in-key would spawn a fresh host on every cosmetic
patch bump while breaking funnel reuse across an upgrade window. Bump the constant on any change to
the `embedding.*` method set or payload/response shape.

### D7 — ADR-0007 D3 posture satisfied, ordering departed

D3 decided *"activation posture is configuration, not architecture"* and explicitly named *"the
`ensureBackend` spawn path remains the non-supervised fallback"*. This ADR **implements the
non-supervised posture D3 names** and departs only from D3's **ordering** ("always-on ships first") —
the owner's "no managed service" constraint overrides that ordering for embeddings.

## Consequences

- One ONNX host per `(model, ep, cacheDir)` per machine instead of one per process. The pool's
  adaptive ceiling is computed once machine-wide.
- A consumer's `createEmbeddingProvider()` is **inert** — it loads no model and spawns no host; the
  model loads on the first real `embedSingle`/`embedBatch`. A read-only verb (e.g. `backlog query
  --input '{"view":"projects"}'`) therefore spawns zero hosts. (The factory no longer warms up; a
  model-load failure now surfaces on first use rather than at factory time — still a loud, typed
  throw, never a silent downgrade.)
- The funnel lives entirely inside the provider, so consumers need no call-site change; the backlog
  consumer only bumped its dependency range.
- ADR-0011: the `entrypoint/backlog` change was authorized by an owner grant carried in the dispatch.

## What does NOT change

- ADR-0012's concurrent-writer invariant is untouched and reinforced: this host is compute-only.
- ADR-0013's ban on behavior-switching env vars is upheld (host selection is the typed union).
- ADR-0006/0016: the host is reached as a live object via DI (the accessor); no stateful bundle is
  duplicated.
- ADR-0015 remains a *proposal* for a backlog **store** daemon and is **not** implemented here; do not
  conflate the two.
