---
'@adhd/sox-embedding-provider': patch
'@adhd/sox-service-proxy': patch
---

feat(embedding-provider): peer-spawned, self-reaping embedding funnel — N consumer processes share ONE
ONNX host per `(model, execution-provider, cacheDir)`, with no supervised daemon (ADR-0020).

`getSharedFastembedProcess()` is now host-aware. By default (`host: 'shared'`) it returns a
`FunneledFastembedClient` that lazily dials — and, when absent, peer-spawns via `ensureBackend()`'s
O_EXCL singleton spawn-lock — one detached `embedHostMain` process. The host forwards `embedding.*`
payloads to its private pool and **reaps itself**: a debounced, ref-counted teardown keyed on live UDS
client connections (`serveBackend`'s new `onClientCountChange` hook) plus in-flight `pendingCount`
exits the host `IDLE_GRACE_MS` after the last client leaves. It is compute-only (ADR-0012) — no store
connection — and never supervised.

Honest failure: under `host: 'shared'` a failed ensure throws a typed `TransientEmbeddingError` and
forks **zero** hosts; it never silently falls back to a private host. `terminate()` is a no-op for a
shared host; `resetSharedFastembedHost()` is the heal path. Host selection is the typed
`EmbeddingProviderConfig.host` closed union (default `'shared'`, reported in `health().host`), never an
env toggle (ADR-0013).

The eager factory warmup is removed, so `createEmbeddingProvider()` is inert — it loads no model and
spawns no host until the first real embed. A read-only verb therefore spawns zero hosts. The
25–50× Neural-Engine contention claim is reworded to hypothesis framing (it was never proven; the
measured cause of the live slowdown was scheduling QoS).

Teeth (`embed-funnel.spec.ts`): 5 concurrent consumer processes collapse to exactly one host (negative
control: the pre-fix/private path forks 5 — the headline test goes RED against it); debounce-reuse of
the same host pid; rendezvous race; crash + stale-socket recovery; no-silent-re-fork; `lsof` proves the
host holds no store-db handle; provider construction spawns zero hosts.

`@adhd/sox-service-proxy` gains the optional `ServeBackendOptions.onClientCountChange` lifecycle hook
(the live client-connection count on every connect/disconnect). Additive and observational — every
existing caller is unchanged.
