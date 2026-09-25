---
'@adhd/sox-extension-memory-cli': patch
'@adhd/sox-extension-memory-flush': patch
---

Republishes the memory-cli and memory-flush bundles so their inlined
`@adhd/sox-memory-core`, `@adhd/sox-store-adapter` and
`@adhd/sox-embedding-provider` code matches this release. `dist/index.js`,
the embed and enrich worker sidecars, and the new `embedHostMain.js` sidecar
all differ from the published 0.2.4 / 0.2.2 tarballs. Every invalidation now
records `meta.invalidatedReason`, and the Turso FTS quoted-query fix is
included. These packages have no source changes of their own.
