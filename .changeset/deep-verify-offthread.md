---
'@adhd/sox-store-adapter': minor
'@adhd/sox-memory-core': minor
'@adhd/sox-extension-memory-server': minor
---

Opening a store never blocks on `deep` integrity verification any more, and a
failed clean-shutdown write is no longer read as a crash (BL-fc5ab895).

`@adhd/sox-store-adapter` — `runOpenTimeIntegrity` blocks only on the `fast`
tier. When `deep` is owed (unclean shutdown, `SOX_STORE_VERIFY=deep`, or an
outstanding obligation) it runs `PRAGMA integrity_check` in a background,
non-detached, SIGKILL-able child process (`deep-verify-child.js`, a declared
sidecar) that opens its own `readonly` + `query_only` connection, never repairs,
and reaps itself off-thread if its parent dies or its hard deadline passes. The
bound is typed config (`AdapterConfig.deepVerify.timeoutMs`, default 30 min,
rejected loudly with `EInvalidDeepVerifyConfig`). On timeout/failure the child
is killed, the probe is recorded `unknown`, and a loud event is emitted. The
obligation lives in `_adapter_meta.deep_verify_owed`, separate from any
clean-shutdown signal, and is cleared only by a deep pass that completes `ok`;
the latest attempt is in `_adapter_meta.deep_verify_state`. At most one verifier
runs per store across processes (`.deep-verify.lock` in the lease dir).
Behaviour change: damage found by `deep` is reported but no longer REINDEXed at
open. Both adapters now take their crash signal from the dead-pid per-connection
open marker instead of `_adapter_meta.clean_shutdown`, and no longer write that
flag at close — it was set to '0' by every concurrent open and its close-time
write failed with `database is locked` under a peer's write lock.

`@adhd/sox-memory-core` — `computePingHealthVerdict` accepts `deepVerify` and
reports `degraded` while a deep pass is owed and its last attempt ended
`timed_out`/`failed`/`damaged`/`inconclusive`. `resolveStoreVerifyConfig` carries
the bound from the `deep_verify_timeout_ms` config key into every writable open.

`@adhd/sox-extension-memory-server` — `memory_ping` reports `store.deep_verify`
and degrades on it. The off-thread main-thread watcher now SIGKILLs the process
after `mainthread_kill_after_ms` (default 5 min) of main-thread silence, writing
a raw fd-2 FATAL line first; the heartbeat uses the monotonic clock.
