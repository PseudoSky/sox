---
'@adhd/sox-memory-core': patch
'@adhd/sox-hybrid-search': patch
'@adhd/sox-semantic': patch
'@adhd/sox-claim-verification': patch
'@adhd/sox-extension-memory-server': patch
'@adhd/sox-extension-memory-cli': patch
'@adhd/sox-extension-memory-flush': patch
'@adhd/sox-baseline-capture': patch
---

Rebuilt against `@adhd/sox-embedding-provider` 0.6.0 and
`@adhd/sox-service-proxy` 0.4.4 (ADR-0022: the embedding host retires on work,
keys on a content build id, owns its model init, and never inherits a
service's identity env).

The `workspace:^` ranges on embedding-provider do not admit a minor bump, so
every direct and transitive dependent is republished here explicitly. The
memory-server, memory-cli and memory-flush bundles inline the new embedding
host sidecar, so their published artifacts carry the fix. No source change in
these packages.
