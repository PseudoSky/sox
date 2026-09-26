---
"@adhd/sox-embedding-provider": patch
"@adhd/sox-memory-core": patch
"@adhd/sox-extension-memory-server": patch
---

Recall's query-embed budget now follows the embed host, not only this process's last-success stamp (819a416b). `FunneledFastembedClient.warm` is true only while a live host connection has served an init/embed since connecting, and `FastembedProvider.readiness()` reports `{ warm, pending }`. Recall gives the 12 s cold budget when the host is not warm (retired, died, reset, never spawned) or when embeds are already queued ahead of the query (the 2026-09-26 first-recall-after-restart degradation: warm host, query queued behind a write and a heal embed, lost the 3 s race by 212 ms). A single cold-start timeout (no success yet, idle exit, host not warm) no longer opens the vec breaker (two consecutive ones do); a contended timeout still opens it at once, and the timeout guard settles after the poll phase so a reply already delivered during a main-thread stall is not reported as a timeout.
