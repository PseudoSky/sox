---
'@adhd/sox-embedding-provider': patch
---

The embedding host no longer inherits its spawner's identity env (6660076e).

The host was spawned with the spawner's whole environment, including
`SOX_SERVICE_ID`, so service teardown (`findOrphansByServiceId`) and the
OS-truth process scan treated the shared host as memory-server's own process
and reaped it with memory-server. `buildEmbedHostEnv()` now builds the host env
from an allowlist (`PATH HOME USER LOGNAME LANG LC_ALL LC_CTYPE TZ TMPDIR
XDG_CACHE_HOME`, the proxy/CA variables a cold model download needs, `NODE_*`,
`SOX_*`) and denies `SOX_SERVICE_ID`, `SOX_TELEMETRY_INIT`, `SOX_CONFIG_*`,
`SOX_PERM_*`, `SOX_PROXY_*` and `SOX_EMBED_HOST_*`. Every denied key is logged
by name (`embedding_provider.funnel.env_denied`) and passed to the host as
provenance argv. Spawner provenance uses single `--flag=value` argv elements so
a spawner's entrypoint is never a token the identity reaper matches.
