---
'@adhd/sox-embedding-provider': patch
---

The embedding host records its whole lifecycle, and retirement can no longer
end before it finishes (17a83623).

The host writes `embedding_provider.embed_host.spawned` (build id, protocol,
host instance id, spawner pid/service/entry, denied env keys, Node ABI),
`listening`, `model.init{trigger}`, `reap.armed`, `reap.cancelled`,
`reap.fired` and `exit` to its own `embed-host` jsonl. Retirement now holds
the event loop open until it exits deliberately: previously, closing the
listener released the last ref'd handle, so the process could drain and exit
mid-retire, before the private pool was terminated and before `exit` was
logged. The lifecycle is verified against a packed artifact (the real publish
closure installed outside the workspace), and the package's test target now
builds the package first.
