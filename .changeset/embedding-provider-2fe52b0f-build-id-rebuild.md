---
'@adhd/sox-embedding-provider': patch
---

Fix (2fe52b0f): `computeEmbedHostBuildId()` no longer trusts a per-process
memo forever. Services here run straight out of a `dist/` rebuilt in place, so
a long-lived spawner process can outlive many rebuilds of the host it spawns —
the "a new build is a new process" assumption behind the old memo was false.
Every call now re-checks a cheap stat fingerprint (name/size/mtimeMs/ino per
file) and only re-hashes file bytes when it changed, so a rebuilt host is
detected without recreating the client. As a backstop, `FunneledFastembedClient`
now recognises the host's exit-3 "build id mismatch" failure, forces one full
rehash, and retries once before counting the ensure as failed and tripping the
circuit breaker — previously it retried the same stale id forever and stayed
down until the consumer process was restarted. `computeEmbedHostBuildId()` also
now throws a typed `TransientEmbeddingError` (rather than an untyped ENOENT)
when the host directory vanishes mid-rebuild-swap.

Also replaces two untraced empty `catch {}` blocks (`funnelClient.ts`'s
`resetHost`, `embedHostConfig.ts`'s `resolveEmbedHostMainPath`) with traced
`@adhd/sox-telemetry` warnings, and updates two stale doc comments that still
described the pre-ADR-0022 "debounced, ref-counted teardown" / "debounced
self-reap" lifecycle — the host's actual lifecycle is a work-driven retire
(`W` after its last completed work; connections are not counted).
