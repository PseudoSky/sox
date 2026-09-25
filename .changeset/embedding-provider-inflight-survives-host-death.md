---
'@adhd/sox-embedding-provider': patch
---

An in-flight embed survives the death of its host (2fadb3cd).

The dial layer re-dials the host socket and replays unanswered requests, but
it never spawns a host, so a request whose host died waited out the 10 s
give-up and failed `-32001`. The funnel client now re-ensures a successor as
soon as its connection drops with requests outstanding, retries a host-gone
failure (`-32001` or a transport error) once within the caller's own timeout,
and replaces a dial that has been idle-down (stale give-up clock) before a new
request uses it. New telemetry: `embedding_provider.funnel.reconnected`,
`.retry`, `.reensure_failed`.
