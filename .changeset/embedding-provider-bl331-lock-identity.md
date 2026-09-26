---
'@adhd/sox-embedding-provider': patch
---

The BL-331 "another fastembed host process is ALREADY RUNNING" warning names
only a genuinely competing host (cfe12302).

The check asked only `kill(pid, 0)`, so it warned about a pid reused by an
unrelated process, a zombie, and — most often — a member of the SAME host's
pool after `embedding.reset` started a new pool group. The ONNX child now
probes the lock holder once with `ps` (state, parent, start time) and
classifies it (`classifyLockHolder`: self, dead, zombie, pid_reused,
own_parent, pool_sibling, same_service, competing); only `competing` warns,
and every other non-trivial verdict is logged as
`embedding_provider.fastembed.lock_holder_ignored`. The lock now records the
claimant's `ppid` and `procStartMs`. The parent-side reader
(`detectCompetingFastembedHost`) applies the same classification without an
exec on the request path, using the recorded `ppid`. A failed lock claim is
logged instead of swallowed.
