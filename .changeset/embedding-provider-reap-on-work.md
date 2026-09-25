---
'@adhd/sox-embedding-provider': minor
---

The embedding host is a work-driven drainer (ADR-0022; 68a4bf68).

The host retires `idleGraceMs` after its last completed init/embed/embedBatch
once nothing is in flight and its pool has no pending requests. Connection
count is no longer an input, so a permanently connected consumer (the memory
front shim) no longer makes the host immortal, and health probes do not extend
its life. `DEFAULT_EMBED_HOST_IDLE_GRACE_MS` is now 60 000. Retirement is
ordered: the listener closes (in the same tick as the decision) before the
private pool is terminated, and a request that arrives after the flip is
answered `-32001` so the client retries on a successor. SIGTERM/SIGINT retire
the same way. `embedding.health` adds `state`, `lastWorkAgoMs` and
`reapDueInMs`.

Keep-warm is removed with its env knobs (`SOX_EMBED_KEEPWARM_MS`,
`SOX_EMBED_KEEPWARM_ACTIVE_WINDOW_MS`) and its exports from the `./embed-host`
subpath (`resolveEmbedKeepWarmMs`, `shouldSkipKeepWarmTick`,
`nextKeepWarmIntervalMs`, `resolveEmbedKeepWarmActiveWindowMs`,
`KEEPWARM_SLOW_MS`). New exports there: `reapDueInMs`, `EmbedHostState`,
`ERR_HOST_RETIRING`, `ERR_WRONG_MODEL`, `checkRequestIdentity`.
