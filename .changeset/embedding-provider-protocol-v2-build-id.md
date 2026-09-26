---
'@adhd/sox-embedding-provider': minor
---

Embedding host protocol v2: requests carry the model identity, the host owns
its model init, and the host key includes a content build id (ADR-0022;
dc73d9b6, 2fe52b0f).

- Every `init`/`embed`/`embedBatch` request the funnel client forwards now
  carries `{model, cacheDir}`. The host loads its own model (eagerly at startup
  and on demand, memoized, re-armed after `embedding.reset`), so a host that
  never saw a client's `init` — a successor the dial layer replays to, or a
  pool a peer just reset — still serves the request. A request naming a
  different model or cache dir is refused `-32602` and surfaces as
  `PermanentEmbeddingError`.
- The singleton key is now
  `embedding-host:v2:<buildId>:<model>:<ep>:<cacheDirDigest>`. `buildId`
  (`computeEmbedHostBuildId`) digests the host module bytes, the Node ABI and
  the arch, so two builds on one machine get two hosts and a consumer never
  dials a foreign build. A host started with a build id that is not its own
  exits 3.
- The host takes its identity from argv (`encodeEmbedHostArgs` /
  `parseEmbedHostArgs`), not env. `EMBED_HOST_IDLE_GRACE_ENV` is removed;
  `resolveEmbedHostIdleGraceMs()` no longer reads `SOX_EMBED_HOST_IDLE_GRACE_MS`.
  `embedHostSingletonKey()` takes a fourth `buildId` argument.
- `embedding.health` reports `protocol`, `buildId`, `hostInstanceId` and
  `modelLoaded`.
